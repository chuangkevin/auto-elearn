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

export interface SurveyResult {
  ok: boolean;
  filled: number;
  submitted: boolean;
  error?: string;
}

export async function fillSurvey(
  cid: string,
  session: Session,
  opts: { onProgress?: (msg: string) => void; timeoutMs?: number } = {},
): Promise<SurveyResult> {
  const log = opts.onProgress ?? (() => void 0);
  const result: SurveyResult = { ok: false, filled: 0, submitted: false };

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { session, contextIsolation: true, nodeIntegration: false },
  });
  suppressDialogs(win);

  try {
    const lcOk = await enterLC(win, cid, log);
    if (!lcOk) {
      result.error = "無法進入學習中心";
      return result;
    }

    const links = await getSysbarLinks(win);
    if (!links.some((l) => /問卷/.test(l))) {
      log("無問卷選單，略過");
      result.ok = true;
      return result;
    }

    await clickSysbarLink(win, "問卷");

    // Check done status in s_main before clicking
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
      log("問卷已完成");
      result.ok = true;
      result.submitted = true;
      return result;
    }

    // The survey entry button in s_main opens a popup via togo() / window.open
    const popupUrlPromise = awaitWindowOpen(win, 6000);

    await execJs(
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

    const surveyUrl = await popupUrlPromise;
    if (!surveyUrl) {
      result.error = "找不到問卷入口";
      return result;
    }
    log(`問卷 URL: ${surveyUrl}`);

    await win.loadURL(surveyUrl);
    await wait(2000);

    // Fill all radio/checkbox groups — prefer value='1', fallback value='5', else first
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
    result.filled = filled ?? 0;
    log(`已勾選 ${result.filled} 組`);

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
    result.submitted = !!submitted;
    if (!submitted) {
      result.error = "找不到繳交按鈕";
      return result;
    }
    await wait(2000);
    log("問卷已提交 ✓");
    result.ok = true;
    return result;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    return result;
  } finally {
    try {
      win.destroy();
    } catch {
      /* already closed */
    }
  }
}
