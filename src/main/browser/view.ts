import { BrowserView, BrowserWindow, type WebContents } from "electron";

const ECPA_CLOGIN = "https://ecpa.dgpa.gov.tw/uIAM/clogin.asp?destid=CrossHRD";
const ELEARN_HOME_PREFIX = "https://elearn.hrd.gov.tw/mooc/";

/**
 * Drive the eCPA login flow inside the VISIBLE BrowserView so cookies land
 * in the same jar the view already uses — no cookie-isolation issues.
 *
 * Strategy: navigate to clogin.aspx (seeds ASP.NET_SessionId), then run the
 * GetUID → GetApTicketV2 → EnterTwoWayLog → EnterApplicationTwoWay chain as
 * same-origin fetch() calls from inside the page (no forbidden-header / CORS
 * problems, no sendInputEvent focus requirement). Finally POST the ticket to
 * sso_verify.php via a hidden DOM form so the BrowserView follows the redirect
 * chain back to elearn and receives the idx/suc cookies directly.
 */
export function autoLoginInView(
  view: BrowserView,
  creds: { account: string; password: string },
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; error?: string }> {
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return new Promise((resolve) => {
    let settled = false;

    const done = (r: { ok: boolean; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      view.webContents.off("did-navigate", onNav);
      resolve(r);
    };

    const timer = setTimeout(() => done({ ok: false, error: "auto-login timeout" }), timeoutMs);

    const onNav = (_e: unknown, url: string) => {
      if (url.startsWith(ELEARN_HOME_PREFIX)) done({ ok: true });
    };

    view.webContents.on("did-navigate", onNav);

    // Step 1: navigate to clogin.aspx to seed ASP.NET_SessionId in the view's cookie jar.
    view.webContents
      .loadURL(ECPA_CLOGIN)
      .then(() => {
        if (settled) return Promise.resolve(null);
        // Step 2: run the eCPA XHR chain from inside the page (same-origin, cookies auto-included)
        // then submit the ticket to sso_verify.php via a hidden form so the view follows the
        // SSO redirect chain and receives the elearn cookies directly.
        return view.webContents.executeJavaScript(
          `(async () => {
            const post = (url, params) => fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest',
              },
              body: new URLSearchParams(params).toString(),
              credentials: 'include',
            }).then(r => r.text());

            let acc = ${JSON.stringify(creds.account)};
            if (!/^[A-Za-z]\\d{9}$/.test(acc)) {
              const uid = await post('https://ecpa.dgpa.gov.tw/Home/GetUID', { account: acc });
              const t = uid.trim();
              const m = /^[A-Za-z]\\d{9}$/.test(t) ? t : (uid.match(/\\b([A-Za-z]\\d{9})\\b/) || [])[1];
              if (!m) return { ok: false, error: 'GetUID failed: ' + uid.slice(0, 80) };
              acc = m;
            }

            const hex = await post('https://ecpa.dgpa.gov.tw/Home/GetApTicketV2',
              { account: acc, password: ${JSON.stringify(creds.password)}, ApID: 'CrossHRD' });
            if (!/^[0-9A-Fa-f]{100,}$/.test(hex.trim()))
              return { ok: false, error: '帳號或密碼錯誤: ' + hex.slice(0, 80) };

            await post('https://ecpa.dgpa.gov.tw/Home/EnterTwoWayLog',
              { account: acc, loginType: '0', sn: '', ticket: '', appId: 'CrossHRD' });
            await post('https://ecpa.dgpa.gov.tw/Home/EnterApplicationTwoWay',
              { appId: 'CrossHRD' });

            // Submit via a hidden form so the view navigates and picks up elearn cookies.
            const f = document.createElement('form');
            f.method = 'POST';
            f.action = 'https://elearn.hrd.gov.tw/sso_verify.php';
            f.style.display = 'none';
            [['loginType', '0'], ['APReqEncodedData', hex.trim()]].forEach(([k, v]) => {
              const i = document.createElement('input');
              i.type = 'hidden'; i.name = k; i.value = v;
              f.appendChild(i);
            });
            document.body.appendChild(f);
            f.submit();   // BrowserView follows the SSO redirect; did-navigate fires when done
            return { ok: true };
          })()`,
          true,
        );
      })
      .then((result: { ok: boolean; error?: string } | null) => {
        if (settled || result === null) return;
        if (!result.ok) done({ ok: false, error: result.error });
        // result.ok → wait for did-navigate to fire on the elearn mooc/* URL
      })
      .catch((e: unknown) => {
        done({ ok: false, error: e instanceof Error ? e.message : String(e) });
      });
  });
}

/**
 * Mount an elearn-only BrowserView onto the main window.
 * Caller is responsible for setBounds().
 */
export function attachElearnView(win: BrowserWindow, url: string): BrowserView {
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setBrowserView(view);
  view.webContents.loadURL(url);

  // Re-run popup dismiss on every navigation (site shows popup_learn_record modal on dashboard entry)
  view.webContents.on("did-finish-load", () => {
    dismissNuisancePopups(view.webContents).catch(() => void 0);
  });
  return view;
}

/**
 * The elearn site injects a daily-summary modal ("popup_learn_record") and
 * other dialogs that block navigation. Try several heuristics to dismiss them:
 * 1. Click any visible `.fancybox-close-small` / `[class*="close"]` / `[aria-label*="close"]` button
 * 2. Call `game_close()` if defined (the "我知道了" card closer)
 * 3. Remove `.fancybox-container` / high-z-index overlays
 * Repeat a few times over ~3 seconds to catch late-mounted popups.
 */
export async function dismissNuisancePopups(wc: WebContents): Promise<void> {
  const script = `(() => {
    let dismissed = 0;
    // 1. Click close buttons
    const closeSelectors = [
      '.fancybox-close-small',
      '.fancybox-close',
      'button[aria-label*="close" i]',
      'button[aria-label*="關閉"]',
      'a.game_card_btn',
      '.close-btn',
    ];
    for (const sel of closeSelectors) {
      document.querySelectorAll(sel).forEach(el => {
        try { el.click(); dismissed++; } catch {}
      });
    }
    // 2. Known global closers
    try { if (typeof window.game_close === 'function') { window.game_close(); dismissed++; } } catch {}
    try { if (typeof window.$?.fancybox?.close === 'function') { window.$.fancybox.close(true); dismissed++; } } catch {}
    // 3. Nuke stubborn overlays
    const overlays = document.querySelectorAll('.fancybox-container, .fancybox-overlay, .modal-backdrop');
    overlays.forEach(o => { try { o.remove(); dismissed++; } catch {} });
    // Ensure body scroll restored
    document.body.style.overflow = '';
    document.documentElement.style.overflow = '';
    return dismissed;
  })()`;
  for (let i = 0; i < 5; i++) {
    try {
      await wc.executeJavaScript(script, true);
    } catch {
      /* page not ready */
    }
    await new Promise((r) => setTimeout(r, 600));
  }
}

/**
 * Poll the page DOM for the presence of the `個人專區` link.
 * Resolves with the logged-in user's display name when found.
 */
export async function detectLogin(
  wc: WebContents,
  timeoutMs = 30 * 60 * 1000,  // 30 minutes; plenty of time for 自然人憑證 etc.
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const found: { ok: boolean; name: string } = await wc.executeJavaScript(
        `(() => {
          const a = document.querySelector('a[href="/mooc/user/learn_dashboard.php"]');
          const ok = !!a && (a.textContent || '').trim().includes('個人專區');
          if (!ok) return { ok: false, name: '' };
          const bodyText = document.body ? document.body.innerText : '';
          // Try several patterns to find the user's name
          let name = '';
          // Dashboard greeting "Hi 莊哲瑜 您好"
          let m = bodyText.match(/Hi\\s+(\\S+)\\s*您好/);
          if (m) name = m[1];
          // Daily popup "莊哲瑜，今年您已取得..."
          if (!name) {
            m = bodyText.match(/([\\u4e00-\\u9fa5]{2,4})\\s*[,，]\\s*今年您已取得/);
            if (m) name = m[1];
          }
          // Header section showing name next to 平台識別碼
          if (!name) {
            m = bodyText.match(/([\\u4e00-\\u9fa5]{2,4})\\s*平[台臺]識別碼/);
            if (m) name = m[1];
          }
          return { ok: true, name: name || '已登入' };
        })()`,
        true,
      );
      if (found?.ok) return found.name;
    } catch {
      /* page may not have committed yet */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("login detection timed out");
}
