import { BrowserWindow, type Session } from "electron";
import { findBestAnswer, type AnswerSource } from "./matcher";
import { saveLearnedAnswer } from "./answer-store";
import {
  wait,
  execJs,
  suppressDialogs,
  enterLC,
  getSysbarLinks,
  clickSysbarLink,
} from "../browser/lc-nav";

export interface SolveResult {
  ok: boolean;
  total: number;
  bySource: Record<AnswerSource, number>;
  passed?: boolean;
  score?: number;
  readExamScore?: number;
  error?: string;
}

interface ExtractedQuestion {
  index: number;
  text: string;
  options: string[];
  /** radio/checkbox name attribute */
  inputName: string;
  /** actual value attributes, parallel to options[] */
  values: string[];
  isMultiple: boolean;
}

const MAX_EXAM_ATTEMPTS = 10;

// ─── Question extraction ──────────────────────────────────────

async function extractQuestions(win: BrowserWindow): Promise<ExtractedQuestion[]> {
  // Poll for questions to appear (exam may need a moment after examBegin())
  for (let i = 0; i < 15; i++) {
    const has = await execJs<boolean>(win, `!!document.querySelector('tr.bg03,tr.bg04')`);
    if (has) break;
    await wait(1000);
  }

  return (
    (await execJs<ExtractedQuestion[]>(
      win,
      `(() => {
        const rows = Array.from(document.querySelectorAll('tr.bg03,tr.bg04'));
        if (!rows.length) return null;
        const out = [];
        rows.forEach((row, index) => {
          const inputs = Array.from(row.querySelectorAll('input[type=radio],input[type=checkbox]'));
          if (!inputs.length) return;

          // Strip option list from clone to get pure question text
          const clone = row.cloneNode(true);
          clone.querySelectorAll('ol,ul').forEach(el => el.remove());
          const text = (clone.textContent || '').trim().replace(/\\s+/g,' ').slice(0,300);

          // Options: prefer <li> text, fallback to label/parent
          const options = [];
          const values = [];
          row.querySelectorAll('li').forEach(li => {
            const c = li.cloneNode(true);
            c.querySelectorAll('input').forEach(el => el.remove());
            options.push((c.textContent||'').trim().replace(/\\s+/g,' ').slice(0,150));
          });
          inputs.forEach(inp => values.push(inp.value));
          if (!options.length) {
            inputs.forEach(inp => {
              const p = inp.closest('label') || inp.parentElement;
              options.push(((p ? p.textContent : '')||'').trim().replace(/\\s+/g,' ').slice(0,150));
            });
          }

          out.push({
            index,
            text,
            options,
            values,
            inputName: inputs[0].name || '',
            isMultiple: inputs[0].type === 'checkbox',
          });
        });
        return out.length ? out : null;
      })()`,
    )) ?? []
  );
}

// ─── Option selection ─────────────────────────────────────────

async function selectOption(
  win: BrowserWindow,
  inputName: string,
  value: string,
): Promise<void> {
  if (!inputName) return;
  const safeN = inputName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const safeV = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await execJs(
    win,
    `(() => {
      const el = document.querySelector('input[name="${safeN}"][value="${safeV}"]');
      if (el) { el.checked = true; el.dispatchEvent(new Event('change',{bubbles:true})); return true; }
      return null;
    })()`,
  );
}

// ─── Submit + score parsing ───────────────────────────────────

async function submitAndParseScore(win: BrowserWindow): Promise<number | null> {
  const clicked = await execJs<boolean>(
    win,
    `(() => {
      const btn = document.querySelector("input[type='submit'][value*='送出答案']")
               || document.querySelector("input[type='submit'][value*='繳卷']")
               || document.querySelector("input[type='submit'][value*='送出']");
      if (btn) { btn.click(); return true; }
      return null;
    })()`,
  );
  if (!clicked) return null;
  await wait(4000);

  return execJs<number>(
    win,
    `(() => {
      const t = document.body ? document.body.innerText : '';
      const m = t.match(/總分\\s*[=＝]\\s*(\\d+)/);
      if (m) return parseInt(m[1]);
      // Fallback: look for standalone score pattern
      const m2 = t.match(/(\\d+)\\s*分/);
      return m2 ? parseInt(m2[1]) : null;
    })()`,
  );
}

// ─── Get exam URL from s_main togo button ────────────────────

async function getExamUrl(win: BrowserWindow): Promise<string | null> {
  // Wait up to 5s for s_main to finish loading
  for (let i = 0; i < 5; i++) {
    const url = await execJs<string>(
      win,
      `(() => {
        const checkFrame = (f) => {
          try {
            const doc = f.document;
            const btn = doc.querySelector('[onclick*="togo("]');
            if (!btn) return null;
            const m = btn.getAttribute('onclick').match(/togo\\('([^']+)'/);
            if (!m) return null;
            const id = m[1];
            const base = f.location.href.replace(/\\/[^\\/]*$/, '/');
            return base + 'exam_start.php?' + id + '+0';
          } catch(e) { return null; }
        };
        // Try s_main by name
        const byName = window.frames['s_main'];
        if (byName) { const u = checkFrame(byName); if (u) return u; }
        // Iterate frames
        for (let i = 0; i < window.frames.length; i++) {
          try {
            if (window.frames[i].name === 's_main') {
              const u = checkFrame(window.frames[i]);
              if (u) return u;
            }
          } catch(e) {}
        }
        // Fallback: frame[1] in 2-frame layout
        if (window.frames.length >= 2) {
          try { const u = checkFrame(window.frames[1]); if (u) return u; } catch(e) {}
        }
        return null;
      })()`,
    );
    if (url) return url;
    await wait(1000);
  }
  return null;
}

// ─── Run one exam attempt at examUrl ─────────────────────────

async function runOneAttempt(
  win: BrowserWindow,
  examUrl: string,
  label: string,
  bySource: Record<AnswerSource, number>,
  onProgress: (msg: string) => void,
): Promise<{ score: number | null; questions: ExtractedQuestion[] }> {
  await win.loadURL(examUrl);
  await wait(2000);

  // Trigger examBegin() if available
  await execJs(win, `(() => { try { if (typeof examBegin==='function') examBegin(); } catch(e){} })();`);

  const questions = await extractQuestions(win);
  if (questions.length === 0) {
    onProgress(`[${label}] 無法取得題目`);
    return { score: null, questions: [] };
  }
  onProgress(`[${label}] ${questions.length} 題`);

  const llmAnswered: Array<{ question: string; answer: string }> = [];

  for (const q of questions) {
    const { source, pickedIdx, confidence } = await findBestAnswer(q.text, q.options);
    bySource[source]++;

    const value = q.values[pickedIdx] ?? String(pickedIdx + 1);
    onProgress(`  Q${q.index + 1} [${source} ${confidence.toFixed(2)}] → ${q.options[pickedIdx]?.slice(0, 30) ?? value}`);

    if (source === "llm") {
      llmAnswered.push({ question: q.text, answer: q.options[pickedIdx] ?? "" });
    }

    await selectOption(win, q.inputName, value);
  }

  const score = await submitAndParseScore(win);
  onProgress(`[${label}] 分數：${score ?? "?"}`);

  // Persist LLM answers if exam passed
  if (score !== null && score >= 60) {
    for (const { question, answer } of llmAnswered) {
      saveLearnedAnswer({ question, answer, source: "llm", confidence: 0.9 });
    }
  }

  return { score, questions };
}

// ─── Exam loop (retry until 100 or max attempts) ──────────────

async function runExamLoop(
  win: BrowserWindow,
  cid: string,
  menuPattern: string,
  label: string,
  bySource: Record<AnswerSource, number>,
  onProgress: (msg: string) => void,
): Promise<number | null> {
  let best: number | null = null;

  for (let attempt = 1; attempt <= MAX_EXAM_ATTEMPTS; attempt++) {
    // Re-enter LC for fresh state on each attempt
    const ok = await enterLC(win, cid, onProgress);
    if (!ok) {
      onProgress(`enterLC 失敗 (attempt ${attempt})`);
      break;
    }

    const links = await getSysbarLinks(win);
    if (!links.some((l) => new RegExp(menuPattern).test(l))) {
      onProgress(`找不到「${menuPattern}」選單（links: ${links.join("|")}）`);
      break;
    }

    const clicked = await clickSysbarLink(win, menuPattern);
    if (!clicked) {
      onProgress(`clickSysbarLink 失敗`);
      break;
    }

    const examUrl = await getExamUrl(win);
    if (!examUrl) {
      onProgress(`找不到 togo 按鈕`);
      break;
    }

    const { score } = await runOneAttempt(win, examUrl, `${label} #${attempt}`, bySource, onProgress);

    if (score !== null && (best === null || score > best)) best = score;

    if (best === 100) {
      onProgress(`🎯 100 分！`);
      break;
    }
    if (attempt < MAX_EXAM_ATTEMPTS) {
      onProgress(`第 ${attempt} 次得 ${score ?? "?"}，重考...`);
    }
  }

  return best;
}

// ─── Public API ───────────────────────────────────────────────

export async function solveExam(
  cid: string,
  session: Session,
  opts: { onProgress?: (msg: string) => void; timeoutMs?: number } = {},
): Promise<SolveResult> {
  const onProgress = opts.onProgress ?? (() => void 0);
  const result: SolveResult = {
    ok: false,
    total: 0,
    bySource: { db: 0, fuzzy: 0, llm: 0, random: 0 },
  };

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { session, contextIsolation: true, nodeIntegration: false },
  });
  suppressDialogs(win);

  try {
    // Initial LC entry to discover sysbar items
    const ok = await enterLC(win, cid, onProgress);
    if (!ok) {
      result.error = "無法進入學習中心";
      return result;
    }

    const links = await getSysbarLinks(win);
    onProgress(`sysbar: ${links.join(" | ")}`);

    const hasMainExam = links.some((l) => /測驗|考試/.test(l) && !/閱讀/.test(l));
    const hasReadExam = links.some((l) => /閱讀/.test(l));

    if (!hasMainExam && !hasReadExam) {
      onProgress("sysbar 無測驗選單，略過");
      result.ok = true;
      return result;
    }

    // ── Main exam ──
    if (hasMainExam) {
      onProgress("=== 測驗 ===");
      const score = await runExamLoop(
        win,
        cid,
        "測驗|考試",
        "測驗",
        result.bySource,
        onProgress,
      );
      result.score = score ?? undefined;
      result.total = result.bySource.db + result.bySource.fuzzy + result.bySource.llm + result.bySource.random;
      result.passed = (score ?? 0) >= 60;
      result.ok = true;
    }

    // ── Reading exam (閱讀測驗) ──
    if (hasReadExam) {
      onProgress("=== 閱讀測驗 ===");
      const rScore = await runExamLoop(
        win,
        cid,
        "閱讀",
        "閱讀測驗",
        result.bySource,
        onProgress,
      );
      result.readExamScore = rScore ?? undefined;
      if (!hasMainExam) {
        result.total = result.bySource.db + result.bySource.fuzzy + result.bySource.llm + result.bySource.random;
        result.score = rScore ?? undefined;
        result.passed = (rScore ?? 0) >= 60;
        result.ok = true;
      }
    }

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
