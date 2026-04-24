import { BrowserWindow, type Session } from "electron";
import { matchAgainstDb, pickOptionIndex, type AnswerSource } from "./matcher";

export interface SolveResult {
  ok: boolean;
  total: number;
  bySource: Record<AnswerSource, number>;
  passed?: boolean;
  error?: string;
}

interface ExtractedQuestion {
  index: number;
  text: string;
  options: string[];
  /** The `name` attribute shared by this question's radios/checkboxes */
  inputName: string;
  /** Whether these are checkbox (multi-select) or radio (single-select) */
  isMultiple: boolean;
}

/**
 * Attempt to complete the exam for a single course.
 *
 * Flow:
 *   1. Load /info/<cid> in a hidden window
 *   2. Drill into iframe, click 進行測驗 (which opens exam in another iframe/page)
 *   3. On exam page, click 開始作答
 *   4. Enumerate each `tr.bg03 / tr.bg04` row; extract question + 4 options
 *   5. Lookup answer in DB; fall back to fuzzy; else random
 *   6. Check the matching radio/checkbox
 *   7. Submit via 送出答案
 *   8. Parse pass/fail screen
 */
export async function solveExam(
  cid: string,
  session: Session,
  opts: {
    onProgress?: (msg: string) => void;
    timeoutMs?: number;
  } = {},
): Promise<SolveResult> {
  const { onProgress } = opts;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const result: SolveResult = {
    ok: false,
    total: 0,
    bySource: { db: 0, fuzzy: 0, llm: 0, random: 0 },
  };

  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: {
      session,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Suppress any popups the exam page throws by monkey-patching alert/confirm/prompt
  // once the frame is ready. Electron's WebContents doesn't expose a "dialog" event.
  win.webContents.on("did-frame-finish-load", () => {
    win.webContents
      .executeJavaScript(
        `try { window.alert = () => void 0; window.confirm = () => true; window.prompt = () => ''; } catch(e){}`,
        true,
      )
      .catch(() => void 0);
  });

  const log = (msg: string) => {
    onProgress?.(msg);
  };

  const deadline = Date.now() + timeoutMs;
  function timeLeft() {
    return Math.max(0, deadline - Date.now());
  }

  try {
    // 1. Info page
    await win.loadURL(`https://elearn.hrd.gov.tw/info/${cid}`);
    await settle(win, 800);

    // 2. Click 進行測驗 inside iframe. The site nests the exam in frames; we search all.
    const clickedStart = await executeInAllFrames<{ ok: boolean; where?: string }>(
      win,
      `(() => {
        const tryClick = (el) => { if (el) { el.click(); return true; } return false; };
        let btn = Array.from(DOC.querySelectorAll('div.main-text')).find(el => el.textContent.trim() === '進行測驗');
        if (btn) return { ok: tryClick(btn), where: 'div.main-text' };
        btn = DOC.querySelector('input.cssBtn[value="進行測驗"]');
        if (btn) return { ok: tryClick(btn), where: 'input.cssBtn' };
        btn = Array.from(DOC.querySelectorAll('a')).find(el => el.textContent.trim() === '進行測驗');
        if (btn) return { ok: tryClick(btn), where: 'a' };
        return null;
      })()`,
    );
    if (!clickedStart?.ok) {
      result.error = "找不到「進行測驗」按鈕";
      return result;
    }
    log(`點擊「進行測驗」(${clickedStart.where})`);
    // New tab / iframe navigation — wait for exam form to appear
    await settle(win, 2500);

    // 3. Click 開始作答 (sometimes the exam page shows an intro first)
    await executeInAllFrames(
      win,
      `(() => {
        const btn = DOC.querySelector("input.cssBtn[value='開始作答']")
                 || DOC.querySelector("input[type='submit'][value*='開始作答']")
                 || Array.from(DOC.querySelectorAll('button, a')).find(el => (el.textContent || '').includes('開始作答'));
        if (btn) { btn.click(); return true; }
        return null;
      })()`,
    );
    await settle(win, 2500);

    // 4. Extract questions
    const questions = await extractQuestions(win);
    if (questions.length === 0) {
      result.error = "無法解析題目（tr.bg03/bg04 抓不到內容）";
      return result;
    }
    result.total = questions.length;
    log(`抓到 ${questions.length} 題`);

    // 5-6. Pick answers + fill
    for (const q of questions) {
      if (timeLeft() <= 0) {
        result.error = "exam timeout";
        return result;
      }
      let pickedIdx: number;
      let source: AnswerSource;

      const match = matchAgainstDb(q.text);
      if (match) {
        pickedIdx = pickOptionIndex(match.correctText, q.options);
        source = match.source;
        log(
          `Q${q.index + 1} 命中(${source} conf=${match.confidence.toFixed(2)})：${
            q.options[pickedIdx]?.slice(0, 20) ?? "?"
          }`,
        );
      } else {
        pickedIdx = Math.floor(Math.random() * Math.max(1, q.options.length));
        source = "random";
        log(`Q${q.index + 1} 亂猜：${q.options[pickedIdx]?.slice(0, 20) ?? "?"}`);
      }
      result.bySource[source]++;

      await selectOption(win, q.inputName, pickedIdx + 1);
    }

    // 7. Submit
    log("送出答案...");
    const submitted = await executeInAllFrames<boolean>(
      win,
      `(() => {
        const btn = DOC.querySelector("input[type='submit'][value*='送出答案']")
                 || DOC.querySelector("input[type='submit'][value*='交卷']")
                 || DOC.querySelector("input[type='submit'][value*='送出']");
        if (btn) { btn.click(); return true; }
        return null;
      })()`,
    );
    if (!submitted) {
      result.error = "找不到送出答案按鈕";
      return result;
    }
    await settle(win, 3000);

    // 8. Detect pass. Any visible "及格" / "通過" / score >= 60 signals pass.
    const verdict = await executeInAllFrames<{ passed: boolean; text: string }>(
      win,
      `(() => {
        const t = DOC.body ? DOC.body.innerText : '';
        if (!t) return null;
        const passed = /及格|通過|恭喜.*完成|分數[：: ]?\\s*(100|9\\d|8\\d|7\\d|6\\d)/.test(t);
        return { passed, text: t.slice(0, 200) };
      })()`,
    );
    result.passed = !!verdict?.passed;
    result.ok = true;
    log(`測驗結果：${result.passed ? "通過" : "未過或無法判定"}`);
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

async function extractQuestions(win: BrowserWindow): Promise<ExtractedQuestion[]> {
  return (
    (await executeInAllFrames<ExtractedQuestion[]>(
      win,
      `(() => {
        const rows = Array.from(DOC.querySelectorAll('tr.bg03, tr.bg04'));
        if (rows.length === 0) return null;
        const out = [];
        rows.forEach((row, index) => {
          // Clone the row and strip the <ol> so innerText gives just the question stem
          const clone = row.cloneNode(true);
          clone.querySelectorAll('ol, ul').forEach(el => el.remove());
          const text = (clone.textContent || '').trim();

          const inputs = Array.from(row.querySelectorAll('input[type=radio], input[type=checkbox]'));
          if (inputs.length === 0) return;
          const inputName = inputs[0].name || '';
          const isMultiple = inputs[0].type === 'checkbox';

          // Options: <li> parent text minus the input
          const options = [];
          const lis = row.querySelectorAll('li');
          lis.forEach(li => {
            const liClone = li.cloneNode(true);
            liClone.querySelectorAll('input').forEach(el => el.remove());
            options.push((liClone.textContent || '').trim());
          });
          if (options.length === 0) {
            inputs.forEach(inp => {
              const parent = inp.closest('label') || inp.parentElement;
              const t = parent ? (parent.textContent || '').trim() : '';
              options.push(t);
            });
          }
          out.push({ index, text, options, inputName, isMultiple });
        });
        return out.length ? out : null;
      })()`,
    )) ?? []
  );
}

async function selectOption(win: BrowserWindow, inputName: string, optionValue: number): Promise<void> {
  if (!inputName) return;
  const safeName = inputName.replace(/"/g, '\\"');
  await executeInAllFrames(
    win,
    `(() => {
      const el = DOC.querySelector('input[name="${safeName}"][value="${optionValue}"]');
      if (el) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); return true; }
      return null;
    })()`,
  );
}

function settle(win: BrowserWindow, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const onNav = () => {
      /* reset timer on navigation */
    };
    win.webContents.on("did-navigate", onNav);
    win.webContents.on("did-navigate-in-page", onNav);
    setTimeout(() => {
      win.webContents.removeListener("did-navigate", onNav);
      win.webContents.removeListener("did-navigate-in-page", onNav);
      resolve();
    }, ms);
  });
}

/**
 * Run the given IIFE against the top window and walk same-origin subframes until
 * one returns a truthy value. The caller's script must use `DOC` instead of
 * `document` so we can substitute each frame's document per iteration.
 *
 * Example: `executeInAllFrames(win, "DOC.querySelector('form')?.action")`
 */
async function executeInAllFrames<T>(win: BrowserWindow, bodyUsingDOC: string): Promise<T | null> {
  const wrapped = `(() => {
    const attempt = (DOC) => {
      try { return (${bodyUsingDOC}); } catch (e) { return null; }
    };
    // main document first
    let v = attempt(document);
    if (v) return v;
    // iterate same-origin subframes
    for (let i = 0; i < window.frames.length; i++) {
      try {
        const fdoc = window.frames[i].document;
        v = attempt(fdoc);
        if (v) return v;
      } catch (e) { /* cross-origin — skip */ }
    }
    return null;
  })()`;
  try {
    return (await win.webContents.executeJavaScript(wrapped, true)) as T | null;
  } catch {
    return null;
  }
}
