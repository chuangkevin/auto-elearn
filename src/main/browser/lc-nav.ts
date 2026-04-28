import { BrowserWindow } from "electron";
import { acquireElearnWindowSlot, releaseElearnWindowSlot } from "../heartbeat/reader";

/** ms-level sleep */
export function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run JS in win's top-level document; returns typed result or null on error. */
export async function execJs<T>(win: BrowserWindow, code: string): Promise<T | null> {
  try {
    return (await win.webContents.executeJavaScript(code, true)) as T | null;
  } catch {
    return null;
  }
}

/**
 * Suppress alert/confirm/prompt in all frames of win.
 * Hooks `frame-created` (earliest per-frame point) so the override lands
 * BEFORE SCORM scripts run their alert("...") on parse failure / 更新完畢.
 * Also re-applies on dom-ready and finish-load as a safety net.
 */
export function suppressDialogs(win: BrowserWindow): void {
  const SUPPRESS = `try{window.alert=()=>void 0;window.confirm=()=>true;window.prompt=()=>'';}catch(e){}`;
  win.webContents.on("frame-created", (_event, details) => {
    if (details.frame) details.frame.executeJavaScript(SUPPRESS).catch(() => void 0);
  });
  win.webContents.on("dom-ready", () => {
    win.webContents.executeJavaScript(SUPPRESS, true).catch(() => void 0);
  });
  win.webContents.on("did-frame-finish-load", () => {
    win.webContents.executeJavaScript(SUPPRESS, true).catch(() => void 0);
  });
  win.webContents.on("will-prevent-unload", (e) => e.preventDefault());
}

/**
 * Navigate win to the SCORM Learning Center for the given CID.
 *
 * Flow: /info/{cid} → click button.btnAction ("上課去") →
 *   Case A: page navigates in-tab to center.elearn.hrd.gov.tw frameset
 *   Case B: window.open() fires → we capture URL and loadURL into win
 *
 * Returns true when the LC frameset (≥2 frames) is ready.
 */
export async function enterLC(
  win: BrowserWindow,
  cid: string,
  onLog?: (msg: string) => void,
): Promise<boolean> {
  // Throttle to the global elearn-window slot. Same semaphore as ticket
  // extraction; both flows hit /info/{cid} → 上課去 → LC frameset, and
  // elearn's 多重視窗 guard treats them identically. Without throttling,
  // 6+ parallel chains' enterLC calls all race and most get redirected to
  // /mooc/warning.php with empty sysbar / missing togo button.
  await acquireElearnWindowSlot();
  try {
    return await _enterLCImpl(win, cid, onLog);
  } finally {
    releaseElearnWindowSlot();
  }
}

async function _enterLCImpl(
  win: BrowserWindow,
  cid: string,
  onLog?: (msg: string) => void,
): Promise<boolean> {
  const log = onLog ?? (() => void 0);
  let capturedLcUrl: string | null = null;

  // Must set handler BEFORE navigating so any window.open is caught
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!capturedLcUrl) capturedLcUrl = url;
    return { action: "deny" };
  });

  log(`enterLC: loading /info/${cid}`);
  await win.loadURL(`https://elearn.hrd.gov.tw/info/${cid}`);
  await wait(2500);
  log(`enterLC: post-load url=${win.webContents.getURL()}`);

  // Click launch button
  const clickResult = await execJs<{ found: boolean; tag?: string; text?: string }>(
    win,
    `(() => {
      let b = document.querySelector('button.btnAction');
      let via = 'btnAction';
      if (!b) {
        via = 'text-match';
        b = Array.from(document.querySelectorAll('button,a'))
          .find(el => /上課去|繼續學習|開始學習/.test(el.textContent || ''));
      }
      if (b) {
        const tag = b.tagName + (via === 'btnAction' ? '.btnAction' : '');
        const text = (b.textContent || '').trim().slice(0, 30);
        b.click();
        return { found: true, tag, text };
      }
      return { found: false };
    })()`,
  );
  if (!clickResult || !clickResult.found) {
    log("enterLC: 找不到上課去按鈕");
    return false;
  }
  log(`enterLC: clicked ${clickResult.tag} "${clickResult.text}"`);

  await wait(5000);

  const url = win.webContents.getURL();
  const frameCount = (await execJs<number>(win, `window.frames.length`)) ?? 0;
  log(`enterLC: post-click url=${url} frames=${frameCount} popup=${capturedLcUrl ?? "-"}`);

  // The LC frameset can live on several hosts:
  //   • center.elearn.hrd.gov.tw/mooc/...   (central platform)
  //   • mohw.elearn.hrd.gov.tw/learn/...    (衛福部)
  //   • moe.elearn.hrd.gov.tw/learn/...     (教育部)
  //   • moi.elearn.hrd.gov.tw/learn/...     (內政部)
  //   • <agency>.elearn.hrd.gov.tw/learn/...
  // Per-agency LCs share the elearn.hrd.gov.tw base domain and a multi-frame
  // SCORM layout. Detect by host suffix + frame count rather than hard-coded
  // path prefixes.
  const isLcFrameset = (u: string, frames: number): boolean => {
    if (!u.includes("elearn.hrd.gov.tw")) return false;
    if (frames >= 2) return true;
    return u.includes("/mooc/") || u.includes("/learn/") || u.includes("center.elearn.hrd.gov.tw");
  };

  // Case A: same-tab navigation already landed on an LC frameset
  if (isLcFrameset(url, frameCount)) {
    await wait(1000);
    return true;
  }

  // Case B: popup was captured — load into same win
  if (capturedLcUrl) {
    log(`enterLC: loading popup ${capturedLcUrl}`);
    await win.loadURL(capturedLcUrl);
    await wait(3500);
    return true;
  }

  // Case C: same-tab nav still hasn't happened. Poll for up to 10 more seconds.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await wait(1000);
    if (capturedLcUrl) {
      log(`enterLC: late popup ${capturedLcUrl}`);
      await win.loadURL(capturedLcUrl);
      await wait(3500);
      return true;
    }
    const u = win.webContents.getURL();
    const f = (await execJs<number>(win, `window.frames.length`)) ?? 0;
    if (isLcFrameset(u, f)) {
      log(`enterLC: late same-tab nav ${u} frames=${f}`);
      await wait(1000);
      return true;
    }
  }

  log("enterLC: 等到 timeout 都沒有導到 LC frameset");
  return false;
}

/**
 * Return all link texts from the mooc_sysbar frame (up to 8 s retry).
 * Tries frame by name, then by index.
 */
export async function getSysbarLinks(win: BrowserWindow, retryMs = 8000): Promise<string[]> {
  const deadline = Date.now() + retryMs;
  while (true) {
    const links = await execJs<string[]>(
      win,
      `(() => {
        const byName = window.frames['mooc_sysbar'];
        const tryDoc = (doc) => {
          try {
            const ls = Array.from(doc.querySelectorAll('a'))
              .map(a => (a.textContent || '').trim()).filter(Boolean);
            return ls.length ? ls : null;
          } catch(e) { return null; }
        };
        if (byName) { const r = tryDoc(byName.document); if (r) return r; }
        for (let i = 0; i < window.frames.length; i++) {
          try {
            if (window.frames[i].name === 'mooc_sysbar') {
              const r = tryDoc(window.frames[i].document);
              if (r) return r;
            }
          } catch(e) {}
        }
        // Fallback: frame[0] in a 2-frame layout is usually sysbar
        if (window.frames.length >= 2) {
          try { const r = tryDoc(window.frames[0].document); if (r) return r; } catch(e) {}
        }
        return [];
      })()`,
    );
    if (links && links.length > 0) return links;
    if (Date.now() >= deadline) return [];
    await wait(1000);
  }
}

/**
 * Click a link in the mooc_sysbar frame whose text matches `pattern` (regex string).
 * Returns true if found and clicked.
 */
export async function clickSysbarLink(win: BrowserWindow, pattern: string): Promise<boolean> {
  const result = await execJs<boolean>(
    win,
    `(() => {
      const pat = new RegExp(${JSON.stringify(pattern)});
      const tryFrame = (f) => {
        try {
          const a = Array.from(f.document.querySelectorAll('a'))
            .find(a => pat.test(a.textContent || ''));
          if (a) { a.click(); return true; }
        } catch(e) {}
        return false;
      };
      const byName = window.frames['mooc_sysbar'];
      if (byName && tryFrame(byName)) return true;
      for (let i = 0; i < window.frames.length; i++) {
        try {
          if (window.frames[i].name === 'mooc_sysbar' && tryFrame(window.frames[i])) return true;
        } catch(e) {}
      }
      if (window.frames.length >= 2 && tryFrame(window.frames[0])) return true;
      return false;
    })()`,
  );
  if (result) await wait(2500);
  return !!result;
}

/**
 * Set up a one-shot window.open interceptor on win.
 * Returns a promise that resolves to the captured URL (or null on timeout).
 * Call this BEFORE triggering the action that opens the window.
 */
export function awaitWindowOpen(win: BrowserWindow, timeoutMs = 8000): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => {
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      resolve(null);
    }, timeoutMs);

    win.webContents.setWindowOpenHandler(({ url }) => {
      clearTimeout(timer);
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      resolve(url);
      return { action: "deny" };
    });
  });
}
