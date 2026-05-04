import { BrowserWindow, type Session } from "electron";

export interface UnenrollResult {
  ok: boolean;
  error?: string;
}

/**
 * Unenrol a course by driving the site's own 退選 button in a hidden window.
 *
 * Strategy: try the /info/<cid> detail page first (simpler DOM, one course);
 * fall back to the learning dashboard if the detail page doesn't expose the
 * button.
 *
 * v0.8.0：必須帶該帳號的 partition session，不然 hidden window 沒 cookie，
 * 會被 server 踢回登入頁、找不到任何退選按鈕。
 */
export async function unenrollCourse(
  cid: string,
  session?: Session,
  timeoutMs = 25_000,
): Promise<UnenrollResult> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      ...(session ? { session } : {}),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // v0.8.8
    },
  });
  try {
    let clicked = await clickUnenrollOnInfo(win, cid);
    if (!clicked) {
      clicked = await clickUnenrollOnDashboard(win, cid);
    }
    if (!clicked) {
      return { ok: false, error: "找不到退選按鈕（可能已經退選或頁面結構改變）" };
    }

    // After clicking the trigger, the site pops a bootbox / fancybox confirm.
    // Poll and auto-accept for up to 8 seconds.
    const deadline = Date.now() + 8000;
    let accepted = false;
    while (Date.now() < deadline) {
      const n = await win.webContents
        .executeJavaScript(
          `(() => {
            let n = 0;
            const selectors = [
              'button.bootbox-accept',
              '.bootbox .btn-primary',
              '#confirmBtn',
              '.fancybox-inner button',
              '.fancybox-content button',
              '.modal-footer .btn-primary'
            ];
            const tried = new Set();
            for (const sel of selectors) {
              document.querySelectorAll(sel).forEach(b => {
                if (tried.has(b)) return;
                tried.add(b);
                const t = (b.textContent || '').trim();
                if (/^(確定|確認|是|OK|Yes|繼續|退選|同意)$/i.test(t)) {
                  try { b.click(); n++; } catch {}
                }
              });
            }
            return n;
          })()`,
          true,
        )
        .catch(() => 0);
      if ((n as number) > 0) {
        accepted = true;
        break;
      }
      await sleep(250);
    }
    // Give the server a moment to process the unenroll
    await sleep(accepted ? 2000 : 1500);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      win.destroy();
    } catch {
      /* ignore */
    }
  }
}

async function clickUnenrollOnInfo(win: BrowserWindow, cid: string): Promise<boolean> {
  const url = `https://elearn.hrd.gov.tw/info/${cid}`;
  try {
    await win.loadURL(url);
    await suppressDialogs(win);
    const r = await pollAndClick(
      win,
      `(() => {
        const buttons = Array.from(document.querySelectorAll('button, a'));
        const btn = buttons.find(b => (b.textContent || '').trim() === '退選');
        if (!btn) return false;
        try { btn.click(); } catch {}
        return true;
      })()`,
      15000,
    );
    return r === true;
  } catch {
    return false;
  }
}

async function clickUnenrollOnDashboard(win: BrowserWindow, cid: string): Promise<boolean> {
  // Dashboard paginates 6 at a time; iterate pages and look for the row
  // matching our cid. Stop when we run out of pages or hit the cid.
  for (let page = 0; page < 30; page++) {
    const url = `https://elearn.hrd.gov.tw/mooc/user/learn_dashboard.php?tab=3${
      page > 0 ? `&page=${page}` : ""
    }`;
    try {
      await win.loadURL(url);
      await suppressDialogs(win);
      const clicked = await pollAndClick(
        win,
        `(() => {
          const rows = Array.from(document.querySelectorAll('.course-list-block'));
          for (const row of rows) {
            const link = row.querySelector('a[href*="/info/${cid}"], a[href$="/${cid}"]');
            if (!link) continue;
            const buttons = Array.from(row.querySelectorAll('button, a'));
            const btn = buttons.find(b => (b.textContent || '').trim() === '退選');
            if (btn) {
              try { btn.click(); } catch {}
              return true;
            }
            return 'row_found_no_button';
          }
          return false;
        })()`,
        10000,
      );
      if (clicked === true) return true;
      // If we saw any rows but no match, continue to next page
    } catch {
      /* next page */
    }
  }
  return false;
}

async function suppressDialogs(win: BrowserWindow): Promise<void> {
  try {
    await win.webContents.executeJavaScript(
      `(() => {
        window.confirm = () => true;
        window.alert = () => undefined;
        if (window.bootbox) {
          const orig = window.bootbox.confirm;
          window.bootbox.confirm = function (opts) {
            try {
              if (opts && typeof opts.callback === 'function') opts.callback(true);
            } catch {}
            if (typeof orig === 'function') return orig.apply(this, arguments);
          };
        }
        return true;
      })()`,
      true,
    );
  } catch {
    /* ignore */
  }
}

async function pollAndClick(
  win: BrowserWindow,
  script: string,
  timeoutMs: number,
): Promise<boolean | string> {
  const deadline = Date.now() + timeoutMs;
  let sawFallback: string | false = false;
  while (Date.now() < deadline) {
    try {
      const r = await win.webContents.executeJavaScript(script, true);
      if (r === true) return true;
      if (typeof r === "string") sawFallback = r;
    } catch {
      /* page navigating */
    }
    await sleep(400);
  }
  return sawFallback || false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
