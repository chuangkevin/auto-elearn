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
                  // Find first real lesson actid from onclick — do NOT read
                  // globalCurrentActivity yet; the player may still be on the
                  // env-check node (I_SCO_99999999_*).
                  let actid = null;
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
                  // Navigate the player to the real lesson so globalCurrentActivity
                  // is set correctly by the time dwell ends.
                  if (actid && typeof frame.goToActivity === 'function') {
                    try { frame.goToActivity(actid); } catch {}
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
                window.dispatchEvent(new Event('focus'));
                window.dispatchEvent(new Event('scroll'));
              } catch (e) {}
            })()`,
            true,
          );
        } catch {
          /* non-fatal — ticket already captured */
        }
        // Dwell: wait for the player to finish navigating to the real lesson,
        // then read globalCurrentActivity which should now reflect the actual node.
        await sleep(20000);
        let finalActid: string | undefined = typeof data.actid === "string" ? data.actid : undefined;
        try {
          const actAfterDwell: unknown = await win.webContents.executeJavaScript(
            `(() => {
              function scan(frame) {
                try {
                  if (frame.pTicket && frame.cid) {
                    const act = typeof frame.globalCurrentActivity === 'string' ? frame.globalCurrentActivity : null;
                    return (act && !/9999999/.test(act)) ? act : null;
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
          );
          if (typeof actAfterDwell === "string" && actAfterDwell) finalActid = actAfterDwell;
        } catch { /* non-fatal — keep onclick actid */ }
        console.log("[TICKET]", JSON.stringify({ pTicket: data.pTicket.slice(0, 8) + "...", actid: finalActid, origin }));
        return { pTicket: data.pTicket, encCid: data.cid, origin, actid: finalActid };
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

/**
 * Open a hidden reader window for `cid`, wait for the SCORM player to
 * initialise, then call LMSSetValue(lesson_status=completed) + LMSFinish()
 * (SCORM 1.2) or the SCORM 2004 equivalents.
 *
 * Returns true if the API was found and the finish calls fired.  Returns
 * false gracefully for video-only courses that have no SCORM API.
 */
export async function executeScormFinish(cid: string, timeoutMs = 45_000): Promise<boolean> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  try {
    await win.loadURL(`https://elearn.hrd.gov.tw/info/${cid}`);
    const buttonReady = await waitFor(win, "!!document.querySelector('button.btnAction')", 10_000);
    if (!buttonReady) return false;

    await win.webContents.executeJavaScript(
      `window.confirm = () => true; window.alert = () => undefined; true;`, true,
    );
    await win.webContents.executeJavaScript(
      `(() => { const b = document.querySelector('button.btnAction'); if (b) b.click(); return !!b; })()`, true,
    );

    // Wait for the SCORM reader frame to appear (same scan as extractTicket).
    const deadline = Date.now() + timeoutMs;
    let readerFound = false;
    while (Date.now() < deadline) {
      try {
        await win.webContents.executeJavaScript(`
          (() => {
            const cbtn = document.getElementById('confirmBtn');
            if (cbtn) cbtn.click();
            document.querySelectorAll('button.bootbox-accept, .modal-footer .btn-primary').forEach(b => {
              try { b.click(); } catch {}
            });
          })()`, true);
      } catch { /* ignore */ }

      const found: boolean = await win.webContents.executeJavaScript(`
        (() => {
          function scan(frame) {
            try { if (frame.pTicket && frame.cid) return true; } catch {}
            try { for (let i = 0; i < frame.frames.length; i++) { if (scan(frame.frames[i])) return true; } } catch {}
            return false;
          }
          return scan(window);
        })()`, true).catch(() => false);

      if (found) { readerFound = true; break; }
      await sleep(500);
    }

    if (!readerFound) return false;

    // Give the SCORM player time to call LMSInitialize before we call LMSFinish.
    await sleep(15_000);

    const finished: boolean = await win.webContents.executeJavaScript(`
      (() => {
        function tryFinish(frame) {
          try {
            if (frame.API && typeof frame.API.LMSSetValue === 'function') {
              frame.API.LMSSetValue('cmi.core.lesson_status', 'completed');
              frame.API.LMSSetValue('cmi.core.score.raw', '100');
              frame.API.LMSSetValue('cmi.core.score.min', '0');
              frame.API.LMSSetValue('cmi.core.score.max', '100');
              frame.API.LMSCommit('');
              frame.API.LMSFinish('');
              return true;
            }
            if (frame.API_1484_11 && typeof frame.API_1484_11.SetValue === 'function') {
              frame.API_1484_11.SetValue('cmi.completion_status', 'completed');
              frame.API_1484_11.SetValue('cmi.success_status', 'passed');
              frame.API_1484_11.SetValue('cmi.score.scaled', '1');
              frame.API_1484_11.Commit('');
              frame.API_1484_11.Terminate('');
              return true;
            }
          } catch {}
          try {
            for (let i = 0; i < frame.frames.length; i++) {
              if (tryFinish(frame.frames[i])) return true;
            }
          } catch {}
          return false;
        }
        return tryFinish(window);
      })()`, true).catch(() => false);

    if (finished) {
      console.log("[SCORM-FINISH]", cid, "LMSFinish called");
      await sleep(3_000);
    }
    return finished;
  } catch {
    return false;
  } finally {
    try { win.destroy(); } catch { /* ignore */ }
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
