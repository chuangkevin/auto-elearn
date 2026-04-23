import { BrowserWindow } from "electron";

export interface TicketInfo {
  pTicket: string;
  encCid: string;
}

/**
 * Open a hidden window, navigate to the course reader, and extract the
 * pTicket + encoded cid from the reader iframe.
 *
 * Fails gracefully (returns null) when the course doesn't expose a reader
 * (身分不符 / 不在開放時間 / already done).
 */
export async function extractTicket(
  cid: string,
  timeoutMs = 30_000,
): Promise<TicketInfo | null> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  try {
    await win.loadURL(`https://elearn.hrd.gov.tw/info/${cid}`);
    const buttonReady = await waitFor(
      win,
      "!!document.querySelector('button.btnAction')",
      10_000,
    );
    if (!buttonReady) return null;

    // Alert-dialog trap: accept() won't work for JS alert from executeJavaScript
    // but since site uses bootbox.confirm/alert we can just suppress confirm()
    await win.webContents.executeJavaScript(
      `window.confirm = () => true; window.alert = () => undefined; true;`,
      true,
    );

    const clicked = await win.webContents.executeJavaScript(
      `(() => {
        const b = document.querySelector('button.btnAction');
        if (!b) return false;
        b.click();
        return true;
      })()`,
      true,
    );
    if (!clicked) return null;

    // Poll for iframe ticket while also dismissing any fancybox / bootbox
    // confirmation dialog ("您已完成此課程...確定要繼續嗎?").
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Try to click any affirmative button that might be blocking
      try {
        await win.webContents.executeJavaScript(
          `(() => {
            const clicks = [];
            // fancybox custom button
            const cbtn = document.getElementById('confirmBtn');
            if (cbtn) { try { cbtn.click(); clicks.push('#confirmBtn'); } catch {} }
            // bootbox modal
            document.querySelectorAll('button.bootbox-accept, .modal-footer .btn-primary').forEach(b => {
              try { b.click(); clicks.push('bootbox'); } catch {}
            });
            // Any fancybox button labelled 繼續/確定
            document.querySelectorAll('.fancybox-inner button, .fancybox-content button').forEach(b => {
              const t = (b.textContent || '').trim();
              if (/^(繼續|確定|確認|是|OK|Yes)/.test(t)) {
                try { b.click(); clicks.push(t); } catch {}
              }
            });
            return clicks;
          })()`,
          true,
        );
      } catch {
        /* ignore */
      }

      const data = await win.webContents
        .executeJavaScript(
          `(() => {
            function scan(frame) {
              try {
                if (frame.pTicket && frame.cid) return { pTicket: String(frame.pTicket), cid: String(frame.cid) };
              } catch {}
              try {
                for (let i = 0; i < frame.frames.length; i++) {
                  const r = scan(frame.frames[i]); if (r) return r;
                }
              } catch {}
              return null;
            }
            return scan(window);
          })()`,
          true,
        )
        .catch(() => null);
      if (data && data.pTicket && data.cid) {
        return { pTicket: data.pTicket, encCid: data.cid };
      }
      await sleep(500);
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      win.destroy();
    } catch {
      /* ignore */
    }
  }
}

async function waitFor(win: BrowserWindow, expr: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await win.webContents.executeJavaScript(expr, true);
      if (ok) return true;
    } catch {
      /* page navigating */
    }
    await sleep(300);
  }
  return false;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}
