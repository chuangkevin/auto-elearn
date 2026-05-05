import { BrowserWindow, type Session } from "electron";
import {
  wait,
  execJs,
  suppressDialogs,
  enterLC,
  getSysbarLinks,
  clickSysbarLink,
  awaitWindowOpen,
} from "../browser/lc-nav";
import {
  acquireElearnWindowSlot,
  releaseElearnWindowSlot,
} from "../heartbeat/reader";
import { fetchCourseDetail } from "../http/course-detail";

export interface SurveyResult {
  ok: boolean;
  filled: number;
  submitted: boolean;
  attempts: number;
  /** True only if server-side detail.surveyDone was confirmed === true after
   *  submit, OR pre-check showed it was already done, OR sysbar legitimately
   *  has no 問卷 entry for this course. False when the chain bailed without
   *  proof the server recorded the survey. */
  serverConfirmed: boolean;
  error?: string;
}

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 8_000;

/**
 * Fill and submit the per-course feedback survey.
 *
 * Wraps internal `_fillOnce` in a 3-attempt retry loop. Each attempt creates
 * a fresh hidden BrowserWindow and walks /info/{cid} → 上課去 → sysbar 問卷
 * → togo() popup → radio fill → 繳交.
 *
 * After a client-side submit succeeds, polls `fetchCourseDetail` for up to
 * ~12 s waiting for `surveyDone === true` before declaring success — the bug
 * we're fixing is "client thinks it submitted but server never recorded it".
 *
 * Returns `ok: true` only when:
 *   - server already recorded surveyDone === true (pre-check; nothing to do)
 *   - sysbar legitimately has no 問卷 entry (course has no survey)
 *   - submit succeeded AND server detail confirms surveyDone === true
 *
 * Critically, an empty sysbar (frame failed to load) is now treated as a
 * RETRYABLE error rather than a silent "no survey, ok=true". Previously this
 * caused `card.surveyDone = true` to be set in the caller for every course
 * whose sysbar load got starved by parallel enterLC contention with the exam.
 */
export async function fillSurvey(
  cid: string,
  session: Session,
  opts: { onProgress?: (msg: string) => void; timeoutMs?: number } = {},
): Promise<SurveyResult> {
  const log = opts.onProgress ?? (() => void 0);

  // Pre-check — if server already says surveyDone, skip the whole dance.
  // Avoids the case where heartbeat/server-poll already noticed the survey
  // was previously submitted (e.g. earlier pipeline run) and we're now
  // re-running just to verify.
  try {
    const fresh = await fetchCourseDetail(session, cid);
    if (fresh?.surveyDone === true) {
      log("[問卷] server 已記錄問卷完成，跳過");
      return {
        ok: true,
        filled: 0,
        submitted: true,
        attempts: 0,
        serverConfirmed: true,
      };
    }
  } catch {
    // ignore — proceed with fill
  }

  let lastErr: string | undefined;
  let lastFilled = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    log(`[問卷] 第 ${attempt}/${MAX_ATTEMPTS} 次嘗試開始`);
    const r = await tryFillOnce(cid, session, log);
    lastErr = r.error;
    lastFilled = r.filled || lastFilled;

    if (!r.ok) {
      log(`[問卷] 第 ${attempt} 次失敗：${r.error ?? "unknown"}`);
      if (attempt < MAX_ATTEMPTS) {
        const ms = BACKOFF_BASE_MS * attempt;
        log(`[問卷] ${Math.round(ms / 1000)}s 後重試`);
        await wait(ms);
      }
      continue;
    }

    // tryFillOnce returned ok=true. Two sub-cases:
    //   • noSurveyMenu: sysbar fully loaded with non-empty links and none
    //     matched 問卷 — this course genuinely has no survey. Treat as done.
    //   • else: submit was clicked. Poll server to confirm it stuck.
    if (r.noSurveyMenu) {
      log("[問卷] 確認此課程無問卷選單");
      return {
        ok: true,
        filled: 0,
        submitted: false,
        attempts: attempt,
        serverConfirmed: true,
      };
    }

    // Server-side verification. elearn typically updates /info/{cid} within
    // 1-3 s of survey submit, but the SCORM bridge can be slow under load.
    // Poll up to ~12 s.
    log("[問卷] 已點擊繳交，等待 server 記錄 surveyDone...");
    let serverConfirmed = false;
    await wait(2_000);
    for (let poll = 0; poll < 5; poll++) {
      try {
        const fresh = await fetchCourseDetail(session, cid);
        if (fresh?.surveyDone === true) {
          serverConfirmed = true;
          break;
        }
      } catch {
        // ignore poll error
      }
      await wait(2_500);
    }

    if (serverConfirmed) {
      log(`[問卷] ✅ 第 ${attempt} 次成功 (server 已確認 surveyDone=true)`);
      return {
        ok: true,
        filled: r.filled,
        submitted: true,
        attempts: attempt,
        serverConfirmed: true,
      };
    }

    lastErr = "client 已提交但 server 未記錄為已填";
    log(`[問卷] ⚠ 第 ${attempt} 次：${lastErr}`);
    if (attempt < MAX_ATTEMPTS) {
      const ms = BACKOFF_BASE_MS * attempt;
      log(`[問卷] ${Math.round(ms / 1000)}s 後重試`);
      await wait(ms);
    }
  }

  return {
    ok: false,
    filled: lastFilled,
    submitted: false,
    attempts: MAX_ATTEMPTS,
    serverConfirmed: false,
    error: lastErr ?? "達到最大重試次數",
  };
}

interface AttemptResult {
  ok: boolean;
  filled: number;
  /** Distinguishes "sysbar loaded, no 問卷 link found" (legit) from a generic
   *  ok response. Set only on the former. */
  noSurveyMenu?: boolean;
  error?: string;
}

async function tryFillOnce(
  cid: string,
  session: Session,
  log: (msg: string) => void,
): Promise<AttemptResult> {
  // v0.8.6：hold elearn slot 整個 win lifecycle — 跟 solveExam 競爭時排隊，
  // 確保同時間只有一個 hidden window 掛在 hahow，避免 hahow 看成 2 裝置。
  await acquireElearnWindowSlot({ label: `問卷 cid=${cid}`, log });
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session,
      contextIsolation: true,
      nodeIntegration: false,
      disableDialogs: true,
      backgroundThrottling: false, // v0.8.8
    },
  });
  suppressDialogs(win);

  try {
    log(`[問卷] enterLC...`);
    const lcOk = await enterLC(win, cid, log, { skipSlotAcquire: true });
    if (!lcOk) {
      return { ok: false, filled: 0, error: "無法進入學習中心" };
    }

    // getSysbarLinks already retries up to 12 s (was 8 s) — bumped because
    // under parallel exam+survey contention the sysbar frame can take longer
    // than the 8 s default to render its links.
    log(`[問卷] 讀取 sysbar 連結...`);
    const links = await getSysbarLinks(win, 12_000);
    if (links.length === 0) {
      // Empty sysbar = frame didn't load in time. Used to fall through to
      // "no survey menu" path, silently marking this course as surveyDone in
      // the caller. Now treated as retryable — the next attempt gets a fresh
      // window and a fresh enterLC and usually succeeds.
      return { ok: false, filled: 0, error: "sysbar frame 載入失敗 (空 links)" };
    }
    log(`[問卷] sysbar links: ${links.join(" | ")}`);

    if (!links.some((l) => /問卷/.test(l))) {
      // Sysbar fully loaded with non-empty links and 問卷 is not among them.
      // This course has no survey — propagate a true "done" with no work.
      log(`[問卷] sysbar 無「問卷」連結，此課程無問卷`);
      return { ok: true, filled: 0, noSurveyMenu: true };
    }

    const clicked = await clickSysbarLink(win, "問卷");
    if (!clicked) {
      return {
        ok: false,
        filled: 0,
        error: "點擊 sysbar『問卷』連結失敗",
      };
    }
    await wait(1_500);

    // Check done status in s_main BEFORE clicking the togo button. If the
    // page already says "已填寫/已完成/已繳交" we don't need to (and must
    // not) submit again.
    const isDone = await execJs<boolean>(
      win,
      `(() => {
        for (let i = 0; i < window.frames.length; i++) {
          try {
            const t = window.frames[i].document.body?.innerText || '';
            if (/已填寫|已完成|已繳交/.test(t)) return true;
          } catch(e) {}
        }
        return false;
      })()`,
    );
    if (isDone) {
      log(`[問卷] s_main 顯示已填寫/已完成/已繳交`);
      // Caller will server-verify via fetchCourseDetail before declaring ok.
      return { ok: true, filled: 0 };
    }

    // The survey entry button in s_main opens a popup via togo() / window.open.
    // 12 s timeout (was 6 s) — popups under load can take >6 s to fire.
    const popupUrlPromise = awaitWindowOpen(win, 12_000);

    const clickedTogo = await execJs<boolean>(
      win,
      `(() => {
        for (let i = 0; i < window.frames.length; i++) {
          try {
            const doc = window.frames[i].document;
            const btn = doc.querySelector('.process-btn.pay.active')
                     || doc.querySelector('[onclick*="togo("]');
            if (btn) { btn.click(); return true; }
          } catch(e) {}
        }
        return false;
      })()`,
    );
    if (!clickedTogo) {
      return {
        ok: false,
        filled: 0,
        error: "找不到 .process-btn.pay.active 或 togo() 按鈕",
      };
    }

    const surveyUrl = await popupUrlPromise;
    if (!surveyUrl) {
      return {
        ok: false,
        filled: 0,
        error: "popup window.open 未觸發 (12s timeout)",
      };
    }
    log(`[問卷] popup URL: ${surveyUrl}`);

    try {
      await win.loadURL(surveyUrl);
    } catch (e) {
      return {
        ok: false,
        filled: 0,
        error: `loadURL 失敗: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    await wait(2_500);

    // Fill all radio/checkbox groups — prefer value='1', fallback value='5', else first.
    const filled = await execJs<number>(
      win,
      `(() => {
        const groups = new Map();
        Array.from(document.querySelectorAll('input[type=radio],input[type=checkbox]')).forEach(el => {
          if (!groups.has(el.name)) groups.set(el.name, []);
          groups.get(el.name).push(el);
        });
        let n = 0;
        for (const [, inputs] of groups) {
          const pick = inputs.find(i => i.value === '1') || inputs.find(i => i.value === '5') || inputs[0];
          if (!pick) continue;
          pick.checked = true;
          pick.dispatchEvent(new Event('change', { bubbles: true }));
          n++;
        }
        return n;
      })()`,
    );
    const filledN = filled ?? 0;
    log(`[問卷] 已勾選 ${filledN} 組 radio/checkbox`);
    if (filledN === 0) {
      return {
        ok: false,
        filled: 0,
        error: "頁面找不到任何 radio/checkbox 可勾選",
      };
    }

    // Submit
    const submitted = await execJs<boolean>(
      win,
      `(() => {
        const btn = document.querySelector("input[type='submit'][value*='確定繳交']")
                 || document.querySelector("input[type='submit'][value*='繳交']")
                 || document.querySelector("input[type='submit'][value*='送出']");
        if (btn) { btn.click(); return true; }
        return null;
      })()`,
    );
    if (!submitted) {
      return {
        ok: false,
        filled: filledN,
        error: "找不到繳交按鈕",
      };
    }
    await wait(3_000);
    log(`[問卷] 繳交按鈕已點擊`);
    return { ok: true, filled: filledN };
  } catch (e) {
    return {
      ok: false,
      filled: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    try {
      win.destroy();
    } catch {
      /* already closed */
    }
    releaseElearnWindowSlot(); // v0.8.6
  }
}
