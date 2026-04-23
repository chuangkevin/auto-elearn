import { BrowserView, BrowserWindow, type WebContents } from "electron";

/**
 * Mount an elearn-only BrowserView onto the main window.
 * Caller is responsible for setBounds().
 */
export function attachElearnView(win: BrowserWindow, url: string): BrowserView {
  const view = new BrowserView({
    webPreferences: {
      // let the site run as a normal user would
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setBrowserView(view);
  view.webContents.loadURL(url);
  return view;
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
          // Try to grab the greeting name from the dashboard page header
          // fallback: scan for 'Hi <name>' pattern
          const bodyText = document.body ? document.body.innerText : '';
          let name = '';
          const m = bodyText.match(/Hi\\s+([^\\s]+)/);
          if (m) name = m[1];
          if (!name) {
            const u = document.querySelector('[class*="user"], .header-text + .header-text');
            if (u) name = (u.textContent || '').trim().split(/\\s+/)[0] || '';
          }
          return { ok: true, name: name || '已登入' };
        })()`,
        true,
      );
      if (found?.ok) return found.name;
    } catch {
      // page may not have committed yet; ignore and retry
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("login detection timed out");
}
