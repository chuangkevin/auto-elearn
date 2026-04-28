import { app, BrowserWindow } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fuzzy } from "fast-fuzzy";

/**
 * Pick the lesson actid that best matches the course title. Used when a
 * SCORM tree exposes multiple sibling lessons (shared player), so we can't
 * just take the first one. Falls back to format-preference order if no
 * caption is given or no candidate has a similar-enough text.
 */
function pickBestActid(
  candidates: Array<{ actid: string; text: string }>,
  caption: string | undefined,
): string | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].actid;

  // With a caption, score each candidate's text against the caption.
  // fast-fuzzy `fuzzy()` returns 0-1 (dice/damerau hybrid); handles Chinese
  // well. Strip ornamental marks first so "《人權搜查客》萬秀帶你..." vs
  // "萬秀帶你翻轉「老」議題..." matches strongly on the shared substring.
  if (caption && caption.trim()) {
    const cleanCap = caption.replace(/[《》「」『』 \-—_:：（）()ft\.]/gi, "").toLowerCase();
    const scored = candidates.map((c) => {
      const cleanText = c.text.replace(/[《》「」『』 \-—_:：（）()ft\.]/gi, "").toLowerCase();
      const score = cleanText && cleanCap ? fuzzy(cleanCap, cleanText) : 0;
      return { ...c, score };
    });
    scored.sort((a, b) => b.score - a.score);
    // Take winner if it's at least moderately similar AND clearly leads.
    if (scored[0].score >= 0.4 && (scored.length === 1 || scored[0].score - scored[1].score >= 0.05)) {
      return scored[0].actid;
    }
  }

  // No caption / no clear match: format preference for what actually credits.
  //   • I_SCO_<n>_<n>           — standard SCORM lesson
  //   • ITEM-<id>                — alternative lesson id format
  //   • tree<level>_<...>        — tree-based player. tree1_*_* is real
  //                                content; tree0_* are typically navigation
  //                                wrappers (課程首頁 / 新手上路 / 課程資訊)
  //                                that don't credit reading time.
  // Within tree-based, prefer the deepest path (most specific lesson).
  const ids = candidates.map((c) => c.actid);
  const sco = ids.find((c) => /^I_SCO_\d+_\d+$/.test(c));
  if (sco) return sco;
  const item = ids.find((c) => /^ITEM-/.test(c));
  if (item) return item;
  // Among tree* candidates: prefer tree1_*+ (real content) over tree0_*
  // (nav). Within each level, prefer deeper (more underscore segments).
  const trees = ids.filter((c) => /^tree/.test(c));
  if (trees.length > 0) {
    trees.sort((a, b) => {
      const segs = (s: string) => s.split("_").length;
      // tree1 > tree0
      const lvl = (s: string) => (s.startsWith("tree0_") ? 0 : 1);
      if (lvl(a) !== lvl(b)) return lvl(b) - lvl(a);
      return segs(b) - segs(a);
    });
    return trees[0];
  }
  return ids[0] || null;
}

/**
 * Global concurrency cap for ANY hidden BrowserWindow that hits elearn's
 * `/info/{cid}` → 上課去 → SCORM-frameset flow. Covers BOTH:
 *   • extractTicket (heartbeat startup)
 *   • enterLC      (exam / survey / reflection phases)
 *
 * elearn has a server-side "禁止多重視窗瀏覽" check — if too many hidden
 * windows hit the LC enter flow concurrently, later windows are redirected
 * to /mooc/warning.php and lose access to pTicket / actid / sysbar. That
 * silently breaks heartbeat crediting AND the post-heartbeat chain (sysbar
 * shows up empty, no exam togo button, etc).
 *
 * 2 is empirically safe across multiple SPOC subdomains. The chain's per-
 * course HTTP heartbeats still run at full HEARTBEAT_PARALLEL_MAX — only
 * the BrowserWindow-driven phases need throttling.
 */
export const ELEARN_WINDOW_CONCURRENCY = 2;
let _extractActive = 0;
const _extractWaiters: Array<() => void> = [];

export async function acquireElearnWindowSlot(): Promise<void> {
  if (_extractActive < ELEARN_WINDOW_CONCURRENCY) {
    _extractActive++;
    return;
  }
  await new Promise<void>((resolve) => _extractWaiters.push(resolve));
  _extractActive++;
}

export function releaseElearnWindowSlot(): void {
  _extractActive--;
  const next = _extractWaiters.shift();
  if (next) next();
}

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
  /** Course title from the listing endpoint — used to disambiguate when the
   *  SCORM tree contains multiple sibling lessons sharing the same player.
   *  Without it we fall back to "first non-env-check" which can pick the
   *  wrong lesson and silently send heartbeats that never credit. */
  caption?: string,
): Promise<TicketInfo | null> {
  // Throttle parallel extraction so elearn's 多重視窗 guard doesn't shunt
  // half the batch into /mooc/warning.php. After this slot is released the
  // pure-HTTP heartbeat still runs at full parallelism.
  await acquireElearnWindowSlot();
  try {
    return await _extractTicketImpl(cid, timeoutMs, caption);
  } finally {
    releaseElearnWindowSlot();
  }
}

async function _extractTicketImpl(
  cid: string,
  timeoutMs = 30_000,
  caption?: string,
): Promise<TicketInfo | null> {
  void cid; // referenced inside dump filename below
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Chromium-level alert/confirm/prompt suppression — earlier than any
      // JS hook. SCORM scripts pop "更新完畢" / "Error while parsing the
      // document" synchronously during page load; without this they appear
      // as a native dialog (modal to parent app, even though show:false).
      disableDialogs: true,
    },
  });
  win.webContents.on("will-prevent-unload", (e) => e.preventDefault());

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

      // If elearn redirected us to the multi-window warning page, abort and
      // let the caller retry — usually triggered by too many concurrent
      // extractions despite the slot semaphore.
      const currentUrl = win.webContents.getURL();
      if (currentUrl.includes("/mooc/warning.php")) {
        console.log("[TICKET]", `cid=${cid} blocked by warning.php — needs retry`);
        return null;
      }

      const data = await win.webContents
        .executeJavaScript(
          `(() => {
            function scan(frame) {
              try {
                if (frame.pTicket && frame.cid) {
                  // Capture EVERY candidate lesson (text + actid) so the main
                  // process can pick the one whose text best matches the
                  // course title. SCORM trees on shared players (e.g. 人權搜
                  // 查客 series — multiple cids share one moj/learn frameset)
                  // expose ALL sibling lessons; "first non-env-check" silently
                  // picks the wrong sibling, and server then accepts heartbeats
                  // without ever crediting THIS course's 閱讀時數.
                  const candidates = [];
                  try {
                    const links = Array.from(frame.document.querySelectorAll('a[onclick]'));
                    for (const el of links) {
                      const oc = el.getAttribute('onclick') || '';
                      if (/9999999/.test(oc)) continue;
                      const m = oc.match(/(?:goToActivity|launchActivity)\\([^,]*,?\\s*['"]([^'"]+)['"]/);
                      if (m) {
                        candidates.push({
                          actid: m[1],
                          text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
                        });
                      }
                    }
                  } catch {}
                  // Stash candidates on the return object; pick happens in main.
                  let actid = null;
                  if (candidates.length === 1) actid = candidates[0].actid;
                  // For >1 we let the caller decide; for 0 we leave null.
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
                    candidates,
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
        // If the SCORM tree had multiple candidates, use caption fuzzy match to
        // pick the one for THIS course (not a sibling sharing the same player).
        const initialCandidates = (data as { candidates?: Array<{ actid: string; text: string }> })
          .candidates ?? [];
        if (!data.actid && initialCandidates.length > 0) {
          data.actid = pickBestActid(initialCandidates, caption);
        }
        // CRITICAL: actually CLICK the lesson link in the SCORM tree, don't
        // just call goToActivity programmatically. Three reasons:
        //   1. Different SCORM players use launchActivity vs goToActivity vs
        //      bespoke handlers — clicking the <a> fires whatever the player
        //      registered, no need to hard-code function names.
        //   2. launchActivity needs `this` (the link element) as first arg —
        //      we can't synthesize that from raw JS-call context.
        //   3. Server-side session activation hinges on the player calling
        //      LMSCommit / setReading(start, lessonId). Without that, the
        //      session stays anchored on env-check and our heartbeats credit
        //      0 seconds even with the right actid in the body.
        // We dispatch a real click; the player handles the rest.
        if (data.actid) {
          try {
            await win.webContents.executeJavaScript(
              `(() => {
                function nav(frame) {
                  try {
                    if (frame.pTicket && frame.cid) {
                      const target = ${JSON.stringify(data.actid)};
                      const links = Array.from(frame.document.querySelectorAll('a[onclick]'));
                      for (const a of links) {
                        const oc = a.getAttribute('onclick') || '';
                        if (oc.includes("'" + target + "'") || oc.includes('"' + target + '"')) {
                          a.click();
                          return true;
                        }
                      }
                    }
                  } catch (e) {}
                  try {
                    for (let i = 0; i < frame.frames.length; i++) {
                      if (nav(frame.frames[i])) return true;
                    }
                  } catch (e) {}
                  return false;
                }
                return nav(window);
              })()`,
              true,
            );
          } catch { /* non-fatal */ }
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
        // Dwell + poll for actid. Without actid, setReading(end) returns 200 OK
        // but server won't credit per-lesson 閱讀時數 — every ping is silently
        // dropped from the per-course timer. Try multiple sources, give SCORM
        // player up to 30 s to settle:
        //   1. globalCurrentActivity (after env-check completes)
        //   2. fresh re-scan of <a onclick="goToActivity(...)"> links
        //   3. window.* SCORM API state (currentItem, lastActivity, etc.)
        let finalActid: string | undefined = typeof data.actid === "string" ? data.actid : undefined;
        const actDeadline = Date.now() + 30_000;
        while (Date.now() < actDeadline) {
          await sleep(1500);
          try {
            const candidate: unknown = await win.webContents.executeJavaScript(
              `(() => {
                function scan(frame) {
                  try {
                    if (frame.pTicket && frame.cid) {
                      // Source A: globalCurrentActivity once it's past env-check
                      try {
                        const gca = frame.globalCurrentActivity;
                        if (typeof gca === 'string' && gca && !/9999999/.test(gca)) return gca;
                      } catch (e) {}
                      // Source B: re-scan links and return ALL candidates with
                      // text. Main process scores them against the caption
                      // (via pickBestActid) so a shared SCORM tree picks the
                      // sibling that actually belongs to this course.
                      try {
                        const links = Array.from(frame.document.querySelectorAll('a[onclick]'));
                        const cands = [];
                        for (const el of links) {
                          const oc = el.getAttribute('onclick') || '';
                          if (/9999999/.test(oc)) continue;
                          const m = oc.match(/(?:goToActivity|launchActivity)\\([^,]*,?\\s*['"]([^'"]+)['"]/);
                          if (m) {
                            cands.push({
                              actid: m[1],
                              text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
                            });
                          }
                        }
                        if (cands.length > 0) return { _sourceB: true, candidates: cands };
                      } catch (e) {}
                      // Source C: SCORM player's exposed activity tree (some SPOCs)
                      try {
                        const tree = frame.activityTree || frame.scoTree || frame.scormTree;
                        if (tree && typeof tree.currentActivityId === 'string' && !/9999999/.test(tree.currentActivityId)) {
                          return tree.currentActivityId;
                        }
                      } catch (e) {}
                    }
                  } catch (e) {}
                  try {
                    for (let i = 0; i < frame.frames.length; i++) {
                      const r = scan(frame.frames[i]); if (r) return r;
                    }
                  } catch (e) {}
                  return null;
                }
                return scan(window);
              })()`,
              true,
            );
            if (typeof candidate === "string" && candidate) {
              // globalCurrentActivity (source A) — already a string actid.
              // Trust it: this is what the SCORM player thinks is current.
              finalActid = candidate;
              break;
            }
            if (
              candidate &&
              typeof candidate === "object" &&
              (candidate as { _sourceB?: boolean })._sourceB
            ) {
              // Source B returned candidates — score them against caption.
              const cands = (candidate as { candidates: Array<{ actid: string; text: string }> }).candidates;
              const picked = pickBestActid(cands, caption);
              if (picked) {
                finalActid = picked;
                break;
              }
            }
          } catch { /* keep polling */ }
        }
        console.log(
          "[TICKET]",
          JSON.stringify({
            pTicket: data.pTicket.slice(0, 8) + "...",
            actid: finalActid ?? null,
            origin,
            // Explicit warning so it's loud when actid couldn't be extracted —
            // without actid, server can't credit 閱讀時數 even though every
            // heartbeat returns success.
            warn: finalActid ? undefined : "actid 抓不到，閱讀時數可能不會增加",
          }),
        );

        // Dump when actid extraction failed OR when it landed on a suspicious
        // tree-root node (those credit zero seconds despite returning success).
        // No more origin-based hacks — caption-fuzzy-match handles shared
        // SCORM trees properly.
        const suspiciousActid = !!finalActid && /^tree/.test(finalActid);
        if (!finalActid || suspiciousActid) {
          try {
            const dump: unknown = await win.webContents.executeJavaScript(
              `(() => {
                const out = { frames: [] };
                function walk(frame, depth, path) {
                  if (depth > 4) return;
                  try {
                    const info = {
                      depth,
                      path,
                      url: String(frame.location?.href ?? ""),
                      hasPTicket: typeof frame.pTicket !== 'undefined',
                      hasCid: typeof frame.cid !== 'undefined',
                      pTicket: typeof frame.pTicket !== 'undefined' ? String(frame.pTicket).slice(0, 8) + '...' : null,
                      globalCurrentActivity: typeof frame.globalCurrentActivity !== 'undefined' ? String(frame.globalCurrentActivity) : null,
                      // Common SCORM player globals
                      currentItem: typeof frame.currentItem !== 'undefined' ? String(frame.currentItem) : null,
                      lastActivity: typeof frame.lastActivity !== 'undefined' ? String(frame.lastActivity) : null,
                      activityTree: typeof frame.activityTree !== 'undefined' ? 'present' : null,
                      scoTree: typeof frame.scoTree !== 'undefined' ? 'present' : null,
                      // Snapshot of every <a onclick> that calls anything Activity-related
                      onclickLinks: [],
                      // List all top-level window.* props that look activity-ish
                      activityProps: Object.keys(frame).filter(k => /act|sco|lesson|item|less/i.test(k)).slice(0, 50),
                    };
                    try {
                      const links = Array.from(frame.document.querySelectorAll('a[onclick]'));
                      info.onclickLinks = links
                        .map(a => ({ text: (a.textContent || '').trim().slice(0, 30), onclick: a.getAttribute('onclick') }))
                        .filter(x => /Activity|goTo|sco|item/i.test(x.onclick || ''))
                        .slice(0, 30);
                      info.bodyText = (frame.document.body?.innerText || '').slice(0, 500);
                    } catch (e) { info.error = String(e); }
                    out.frames.push(info);
                    for (let i = 0; i < frame.frames.length; i++) {
                      walk(frame.frames[i], depth + 1, path + '>' + i);
                    }
                  } catch (e) {
                    out.frames.push({ depth, path, error: String(e) });
                  }
                }
                walk(window, 0, '');
                return out;
              })()`,
              true,
            );
            const filename = `auto-elearn-noactid-${cid}.json`;
            writeFileSync(
              join(app.getPath("temp"), filename),
              JSON.stringify(dump, null, 2),
              "utf8",
            );
            console.log("[TICKET]", `actid dump → ${filename}`);
          } catch (e) {
            console.log("[TICKET]", `dump failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }

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
