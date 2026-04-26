import { BrowserWindow } from "electron";

export interface TicketInfo {
  pTicket: string;
  encCid: string;
  /**
   * Origin of the iframe the ticket was scraped from, e.g.
   * "https://mohw.elearn.hrd.gov.tw" for 衛福部 SPOC, plain
   * "https://elearn.hrd.gov.tw" for main-portal courses.
   *
   * CRITICAL: heartbeats must go to THIS origin, not always to the main
   * elearn.hrd.gov.tw — the reading session lives on whichever subdomain
   * hosts the SPOC. The original ecpa.js got away with a relative fetch
   * because it ran inside the iframe; undici from the main process needs
   * an absolute URL.
   */
  origin: string;
  /** SCORM activity ID (globalCurrentActivity) — required by setReading to credit time. */
  actid?: string;
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
                if (frame.pTicket && frame.cid) {
                  let actid = (typeof frame.globalCurrentActivity === 'string' && frame.globalCurrentActivity)
                    ? frame.globalCurrentActivity : null;
                  // 環境檢測 node (I_SCO_99999999_*) is not a real lesson — skip it.
                  // Find the first real lesson from onclick attributes instead.
                  if (!actid || /9999999/.test(actid)) {
                    try {
                      const links = Array.from(frame.document.querySelectorAll('a[onclick]'));
                      for (const el of links) {
                        const oc = el.getAttribute('onclick') || '';
                        if (/goToActivity/.test(oc) && !/9999999/.test(oc)) {
                          const m = oc.match(/goToActivity\\(['"]([^'"]+)['"]\\)/);
                          if (m) { actid = m[1]; break; }
                        }
                      }
                    } catch {}
                  }
                  return {
                    pTicket: String(frame.pTicket),
                    cid: String(frame.cid),
                    href: String(frame.location.href),
                    actid,
                  };
                }
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
      if (data && data.pTicket && data.cid && data.href) {
        let origin = "https://elearn.hrd.gov.tw";
        try {
          origin = new URL(data.href).origin;
        } catch {
          /* fall through to default */
        }
        const actid: string | undefined = typeof data.actid === "string" ? data.actid : undefined;
        // Leave the reader page open for ~20 seconds AFTER finding the ticket
        // so the SPOC's own JS finishes initialising the reading session on
        // the server. Video-based courses (好好用 AI 的 AI Academy / Meta,
        // etc.) need extra time for the player to load + autoplay + send
        // their initial progress pings. 全民 AI 通識課 worked at 8s dwell;
        // 好好用 AI didn't — bumping to 20s to cover slower players.
        //
        // Also proactively try to start video playback and fire any
        // viewport/intersection handlers the tracker might listen for.
        try {
          await win.webContents.executeJavaScript(
            `(() => {
              try {
                const walk = (doc) => {
                  doc.querySelectorAll('video').forEach(v => {
                    try { v.muted = true; v.play && v.play().catch(() => {}); } catch {}
                  });
                  for (let i = 0; i < (doc.defaultView?.frames?.length || 0); i++) {
                    try { walk(doc.defaultView.frames[i].document); } catch {}
                  }
                };
                walk(document);
                // Simulate a scroll + focus so intersection/visibility observers fire.
                window.dispatchEvent(new Event('focus'));
                window.dispatchEvent(new Event('scroll'));
              } catch (e) {}
            })()`,
            true,
          );
        } catch {
          /* non-fatal — ticket already captured */
        }
        console.log("[TICKET]", JSON.stringify({ pTicket: data.pTicket.slice(0, 8) + "...", actid, origin }));
        await sleep(20000);
        return { pTicket: data.pTicket, encCid: data.cid, origin, actid };
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
