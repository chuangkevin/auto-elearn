import { BrowserView, BrowserWindow, type WebContents } from "electron";

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
