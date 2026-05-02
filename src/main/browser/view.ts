import { BrowserView, BrowserWindow, type WebContents } from "electron";

// webform/clogin.aspx is required — sso_verify.php checks the Referer and
// rejects tickets originating from uIAM/clogin.asp, redirecting to the login
// page instead of the elearn home. The Naminglogo + showecpa params prime the
// correct session state for the GetApTicketV2 → sso_verify.php chain.
const ECPA_CLOGIN =
  "https://ecpa.dgpa.gov.tw/webform/clogin.aspx" +
  "?returnUrl=https%3A%2F%2Felearn.hrd.gov.tw%2Fsso_verify.php" +
  "&Naminglogo=https%3A%2F%2Fecpa.dgpa.gov.tw%2Fwebform%2Flogo-hrd.png" +
  "&showecpa=Y";
const ELEARN_HOME_PREFIX = "https://elearn.hrd.gov.tw/mooc/";
// sso_verify.php failure redirects to this path — exclude it from success detection
const ELEARN_LOGIN_PATH = "/mooc/user/login";

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
export async function autoLoginInView(
  view: BrowserView,
  creds: { account: string; password: string },
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; error?: string }> {
  const timeoutMs = opts.timeoutMs ?? 60_000;

  // Clear stale ECPA session cookies so a cached SSO session can't cause an
  // instant redirect to elearn (bypassing the login chain) on restart.
  await view.webContents.session
    .clearStorageData({ origin: "https://ecpa.dgpa.gov.tw", storages: ["cookies"] })
    .catch(() => {});

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

    // URL must look like elearn home AND must actually show 個人專區 in DOM.
    // sso_verify.php may redirect to explorer.php (not login page) on ticket
    // rejection — a URL-only check would produce a false positive there.
    const onNav = (_e: unknown, url: string) => {
      if (!url.startsWith(ELEARN_HOME_PREFIX) || url.includes(ELEARN_LOGIN_PATH)) return;
      view.webContents.off("did-navigate", onNav); // prevent re-entry
      view.webContents.once("did-finish-load", async () => {
        if (settled) return;
        try {
          const loggedIn: boolean = await view.webContents.executeJavaScript(
            `(() => {
              const a = document.querySelector('a[href="/mooc/user/learn_dashboard.php"]');
              return !!a && (a.textContent || '').trim().includes('個人專區');
            })()`,
            true,
          );
          if (loggedIn) done({ ok: true });
          else done({ ok: false, error: "sso_verify 重定向到 elearn 但未登入" });
        } catch {
          done({ ok: false, error: "DOM 驗證失敗" });
        }
      });
    };

    // Step 1: navigate to clogin.aspx to seed ASP.NET_SessionId in the view's cookie jar.
    // Register onNav AFTER loadURL resolves so we don't catch the initial redirect chain.
    view.webContents
      .loadURL(ECPA_CLOGIN)
      .then(() => {
        if (settled) return Promise.resolve(null);
        // Only now watch for the elearn redirect — triggered by f.submit() below.
        view.webContents.on("did-navigate", onNav);
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
 * Detect if a navigation URL looks like a logout endpoint.
 * eCPA / elearn 各機關的登出按鈕導去的網址五花八門，但通常網址裡會帶
 * `logout` / `signout` / `wlLogOut` / `Logout.aspx` 之類的字眼。
 *
 * 為什麼要偵測：使用者點 eCPA 的「登出」後，elearn 端有些版型會回 `text/css`
 * 或 `application/javascript` content-type 的回應頁，BrowserView 不會 render
 * 成 HTML，會直接顯示成「raw 原始碼」。我們攔下 logout 網址直接導回 eCPA 登入頁，
 * 配合 saved credentials 自動重登。
 */
function looksLikeLogoutUrl(url: string): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  return (
    lower.includes("logout") ||
    lower.includes("signout") ||
    lower.includes("sign_out") ||
    lower.includes("wllogout") ||
    lower.includes("/clogout") ||
    lower.includes("uiam/logout")
  );
}

/**
 * Some logout responses arrive as `text/css` / `application/javascript` (server
 * mistakenly serves a JS/CSS asset path as the post-logout landing page) and
 * Chromium renders them as plain text — that's the "登出後變原始碼" symptom.
 * Catch via mainFrame.url + a small DOM probe and treat as a logout.
 */
async function isShowingRawSource(wc: WebContents): Promise<boolean> {
  try {
    return await wc.executeJavaScript(
      `(() => {
        // Chromium 對 text/css / text/javascript / text/plain 等非 HTML
        // content-type 會直接以 <pre>...</pre> 把整段原始碼塞進 body。
        // 這時 documentElement 結構是 <html><body><pre>...</pre></body></html>，
        // 沒有任何站台正常會有的 head/link/script 等元素。
        const ct = (document.contentType || '').toLowerCase();
        if (ct && !ct.startsWith('text/html') && !ct.startsWith('application/xhtml')) {
          return true;
        }
        const body = document.body;
        if (!body) return false;
        const onlyPre =
          body.children.length === 1 &&
          body.firstElementChild &&
          body.firstElementChild.tagName === 'PRE';
        return !!onlyPre;
      })()`,
      true,
    );
  } catch {
    return false;
  }
}

/**
 * Tear down a BrowserView attached to a window — symmetric counterpart to
 * `attachElearnView`. Accept any view (current or stale) so callers can rebuild
 * fresh ones for "切換帳號" / 「完全重置」 flows where reusing the cookie jar
 * has caused weird intermediate states (raw-source render, dead handlers).
 */
export function detachElearnView(win: BrowserWindow, view: BrowserView | null): void {
  if (!view) return;
  try {
    win.removeBrowserView(view);
  } catch {
    /* main window 已 destroy / view 已 detach — 沒事 */
  }
  try {
    view.webContents.removeAllListeners();
  } catch {
    /* webContents already destroyed */
  }
  // BrowserView 沒 destroy() — 把 webContents 關掉 GC 自然回收。
  // 用 close() 而非 destroy() 是因為 destroy 在某些 Electron 版本上會 throw。
  try {
    if (!view.webContents.isDestroyed()) {
      view.webContents.close();
    }
  } catch {
    /* 已 destroy */
  }
}

/**
 * 把 view 暫時藏起來（移到視窗外的 0×0 bounds），但保持 attach + listeners + cookies +
 * heartbeat 仍在跑。v0.8.0 多帳號用：tab bar 切換時，非 active 帳號的 view 用這條
 * 而不是 detach，這樣 pipeline 可以繼續在背景跑。
 */
export function hideElearnView(view: BrowserView | null): void {
  if (!view) return;
  try {
    view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  } catch {
    /* view destroyed already — caller mistake but harmless */
  }
}

/**
 * Mount an elearn-only BrowserView onto the main window.
 * Caller is responsible for setBounds().
 *
 * `onLogoutDetected` fires when we detect the user clicked logout on the
 * embedded site (URL pattern OR raw-source response). The caller decides what
 * to do — usually navigate back to eCPA login + trigger auto-login.
 */
export function attachElearnView(
  win: BrowserWindow,
  url: string,
  onLogoutDetected?: (reason: "url" | "raw-source") => void,
  opts: { partition?: string } = {},
): BrowserView {
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 多帳號模式必備：每個帳號各自一條 cookie jar（persist:elearn-<id>），
      // 不同帳號之間不會 cookie 互相污染、auto-login 也不會被另一個帳號的 idx
      // cookie 短路掉。沒帶就用 default session（v0.7.x 行為）。
      ...(opts.partition ? { partition: opts.partition } : {}),
      // Chromium-level kill switch for JS alert/confirm/prompt — much
      // earlier than any frame-created / dom-ready hook because it
      // intercepts at the renderer process level. SCORM player's
      // alert("更新完畢") / alert("Error while parsing the document.")
      // never reaches the user.
      disableDialogs: true,
    },
  });
  // v0.8.0：多帳號用 addBrowserView，每個帳號各自掛一個 view。setBrowserView 會
  // 把現有的 view 全替換掉（單帳號模式合理），但多帳號要的是「全部 attach、靠
  // bounds 控制誰可見」，必須用 add 系列 API。
  win.addBrowserView(view);
  // 預設把 BrowserView 整個靜音 —— 課程影片自動播放會炸出聲音，使用者在公司
  // 上班放著刷課很尷尬。Electron 的 webContents.setAudioMuted 是分頁等級的控制，
  // 不會影響系統音量、不會 mute 整個 app，純粹只 silence elearn 那塊嵌入畫面。
  // 之後若使用者要聽課可加開關，目前先一律靜音。
  view.webContents.setAudioMuted(true);
  view.webContents.loadURL(url);

  // Suppress JS alert / confirm / prompt at the earliest possible point on
  // every frame. elearn fires alert("Error while parsing the document.")
  // and alert("更新完畢") synchronously as SCORM scripts execute — must
  // override window.alert BEFORE those scripts run, otherwise the native
  // Electron dialog pops up titled "auto-elearn".
  // `frame-created` is the earliest per-frame hook and covers iframes too.
  const SUPPRESS = `try{window.alert=()=>void 0;window.confirm=()=>true;window.prompt=()=>'';}catch(e){}`;
  const injectInto = (target: { executeJavaScript: (s: string) => Promise<unknown> }) => {
    target.executeJavaScript(SUPPRESS).catch(() => void 0);
  };
  view.webContents.on("frame-created", (_event, details) => {
    if (details.frame) injectInto(details.frame);
  });
  view.webContents.on("dom-ready", () => injectInto(view.webContents));
  view.webContents.on("did-frame-finish-load", () => injectInto(view.webContents));
  view.webContents.on("will-prevent-unload", (e) => e.preventDefault());

  // Re-run popup dismiss on every navigation (site shows popup_learn_record modal on dashboard entry)
  view.webContents.on("did-finish-load", () => {
    dismissNuisancePopups(view.webContents).catch(() => void 0);
  });

  // Logout detection: fire callback when we see a logout URL OR a non-HTML
  // raw-source response. De-bounced via `lastFiredAt` so we don't spam the
  // caller during the redirect chain that follows logout.
  //
  // 強化版（v0.7.9）：raw-source 命中時除了通知 caller 外，也直接把 view 導
  // 回 eCPA 登入頁。原本「只通知 caller」的問題是 caller 處理 race（auto-login
  // 在跑時直接 return）會留下原始碼畫面 → 使用者看到亂碼一直到下次 navigate。
  // 直接內建一道強制 reload 確保不會有「畫面一直是亂碼」的中間狀態。
  const ECPA_LOGIN_URL = "https://ecpa.dgpa.gov.tw/uIAM/clogin.asp?destid=CrossHRD";
  if (onLogoutDetected) {
    let lastFiredAt = 0;
    const fire = (reason: "url" | "raw-source") => {
      const now = Date.now();
      if (now - lastFiredAt < 5000) return;
      lastFiredAt = now;
      onLogoutDetected(reason);
    };
    view.webContents.on("did-navigate", (_e, navUrl) => {
      if (looksLikeLogoutUrl(navUrl)) fire("url");
    });
    view.webContents.on("did-navigate-in-page", (_e, navUrl) => {
      if (looksLikeLogoutUrl(navUrl)) fire("url");
    });
    view.webContents.on("did-finish-load", () => {
      // 0.4 s grace so the page actually commits + DOM is queryable
      setTimeout(async () => {
        if (await isShowingRawSource(view.webContents)) {
          fire("raw-source");
          // Hard-redirect to eCPA login so the BrowserView never sits on a
          // raw-source page even if caller's logout handler is throttled out.
          try {
            await view.webContents.loadURL(ECPA_LOGIN_URL);
          } catch {
            /* nav races are fine — caller's handler will retry */
          }
        }
      }, 400);
    });
  } else {
    // No caller-side logout handling — still hard-redirect raw-source pages
    // so the user never stares at gibberish.
    view.webContents.on("did-finish-load", () => {
      setTimeout(async () => {
        if (await isShowingRawSource(view.webContents)) {
          try {
            await view.webContents.loadURL(ECPA_LOGIN_URL);
          } catch {
            /* swallow */
          }
        }
      }, 400);
    });
  }
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
