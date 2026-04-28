import { BrowserWindow, app, type Session } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { findBestAnswer, type AnswerSource } from "./matcher";
import { saveLearnedAnswer, normalizeQuestion } from "./answer-store";
import {
  wait,
  execJs,
  suppressDialogs,
  enterLC,
  getSysbarLinks,
  clickSysbarLink,
} from "../browser/lc-nav";
import { hasGeminiKey } from "../llm/gemini";

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

// Headroom for the brute-force probe: each below-passing attempt without
// result-page truth needs ~1 retry per question to lock in the right option.
// 10-Q exam: 1 baseline + 10 probes (or fewer if we hit passing earlier).
const MAX_EXAM_ATTEMPTS = 30;

/** Per-question brute-force state, persisted across runExamLoop iterations. */
interface QProbeState {
  questionText: string;
  options: string[];
  /** Option idx currently believed to be the best (initial = baseline pick). */
  bestOption: number;
  /** Highest score observed when this Q used bestOption. */
  bestScore: number;
  /** Options already tried for this Q (so we don't repeat). */
  tested: Set<number>;
}

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
        const norm = (s) => (s || '').trim().replace(/\\s+/g,' ').slice(0,200);
        const out = [];
        rows.forEach((row, index) => {
          const inputs = Array.from(row.querySelectorAll('input[type=radio],input[type=checkbox]'));
          if (!inputs.length) return;

          // Strip option list from clone to get pure question text
          const clone = row.cloneNode(true);
          clone.querySelectorAll('ol,ul,input,script,style').forEach(el => el.remove());
          const text = norm(clone.textContent).slice(0,400);

          // Options: each input has its own surrounding text. Walk up ONE
          // level at a time looking for a container that yields non-empty
          // text after we strip out the input itself. Fixes cases where
          // <li> exists but is empty, or where options sit in <td>/<span>
          // siblings of the radio.
          const values = inputs.map(i => i.value);
          const options = inputs.map(inp => {
            // Try ancestors in order of specificity
            const candidates = [
              inp.closest('li'),
              inp.closest('label'),
              inp.parentElement,
              inp.parentElement?.parentElement,
            ].filter(Boolean);
            for (const cand of candidates) {
              const c = cand.cloneNode(true);
              c.querySelectorAll('input').forEach(el => el.remove());
              const t = norm(c.textContent);
              if (t) return t;
            }
            // Last resort: trailing text node directly after the input
            try {
              let n = inp.nextSibling;
              while (n && n.nodeType !== 3 /* TEXT_NODE */ && n.nodeType !== 1) n = n.nextSibling;
              if (n) return norm(n.textContent || (n.nodeType === 1 ? n.textContent : ''));
            } catch (e) {}
            return '';
          });

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
      // Cover every Chinese phrasing elearn uses for the submit button so
      // the exam actually gets graded — missing one variant leaves us
      // staring at the question page reading "0" forever.
      const sels = [
        "input[type='submit'][value*='送出答案']",
        "input[type='submit'][value*='繳卷']",
        "input[type='submit'][value*='繳交']",
        "input[type='submit'][value*='送出']",
        "input[type='submit'][value*='交卷']",
        "input[type='button'][value*='送出']",
        "button[onclick*='submit']",
      ];
      for (const s of sels) {
        const btn = document.querySelector(s);
        if (btn) { btn.click(); return true; }
      }
      return null;
    })()`,
  );
  if (!clicked) return null;

  // Poll for score up to 12 s — submit triggers a navigation/AJAX update
  // and 4 s isn't always enough on slow SPOC subdomains.
  for (let i = 0; i < 12; i++) {
    await wait(1000);
    const score = await execJs<number>(
      win,
      `(() => {
        const t = document.body ? document.body.innerText : '';
        // Patterns observed in the wild — try most-specific first.
        const patterns = [
          /總分\\s*[=＝:：]\\s*(\\d+)/,
          /得分\\s*[=＝:：]\\s*(\\d+)/,
          /成績\\s*[=＝:：]\\s*(\\d+)/,
          /您的分數\\s*[=＝:：]?\\s*(\\d+)/,
          /分數\\s*[=＝:：]\\s*(\\d+)/,
          /\\b(\\d{1,3})\\s*分(?:\\s|$|，|。|！)/,
        ];
        for (const re of patterns) {
          const m = t.match(re);
          if (m) {
            const n = parseInt(m[1], 10);
            if (n >= 0 && n <= 100) return n;
          }
        }
        return null;
      })()`,
    );
    if (typeof score === "number") return score;
  }
  return null;
}

// ─── Result-page parser ───────────────────────────────────────
//
// After 送出答案, elearn shows a graded review page. Different SPOC
// subdomains lay it out differently — so we try multiple patterns and
// also dump raw HTML on first miss so we can iterate.
//
// Returns one entry per question for which we could identify the correct
// answer text (NOT necessarily the user's selected answer — we want the
// truth so saveLearnedAnswer overrides mixed.db's wrong cache).

interface ResultEntry {
  question: string;
  correct: string;
}

let dumpedResultOnce = false;

async function extractResultAnswers(
  win: BrowserWindow,
  askedQuestions: ExtractedQuestion[],
): Promise<ResultEntry[]> {
  // Give the result page a moment to fully render (some courses do an extra
  // AJAX call to fetch correct answers after the score appears).
  await wait(800);

  const raw = await execJs<ResultEntry[]>(
    win,
    `(() => {
      const norm = (s) => (s || '').replace(/\\s+/g,' ').trim();
      const stripPrefix = (s) => norm(s).replace(/^[\\s\\(\\)\\[\\]【】（）．\\.A-Da-d①②③④0-9、，：:]+/, '');
      const out = [];

      // Strategy A: rows that contain explicit "正確答案：X" / "正解：X" markers.
      const allRows = Array.from(document.querySelectorAll('tr,div,li,p'));
      for (const row of allRows) {
        const rowText = norm(row.textContent || '');
        if (!rowText || rowText.length > 600) continue;
        if (!/正(確|解)\\s*答?案?/.test(rowText)) continue;

        const m = rowText.match(/正(?:確|解)\\s*答?案?\\s*[：:＝=]?\\s*([^。\\n]{1,200}?)(?=您的答案|你的答案|您選|答對|答錯|$)/);
        if (!m) continue;
        const correct = stripPrefix(m[1]);
        if (!correct) continue;

        const beforeIdx = rowText.search(/正(確|解)\\s*答?案?/);
        let qPart = rowText.slice(0, beforeIdx);
        qPart = qPart.replace(/您的答案[^。]*/g, '').replace(/你的答案[^。]*/g, '');
        qPart = qPart.replace(/^[第Q]?\\s*\\d+\\s*[.、題)]?\\s*/, '').trim();
        if (qPart.length < 4) continue;
        out.push({ question: qPart.slice(0, 250), correct: correct.slice(0, 250) });
      }
      if (out.length > 0) return out;

      // Strategy B: option list with a class flag indicating correctness
      const flagged = Array.from(
        document.querySelectorAll('[class*="correct"],[class*="right"],[class*="answer-ok"],[class*="ans-ok"]')
      );
      for (const el of flagged) {
        const optText = stripPrefix(el.textContent || '');
        if (!optText) continue;
        const row = el.closest('tr,li.q,div.q,div.question,div[class*="quiz"]') || el.parentElement;
        if (!row) continue;
        const clone = row.cloneNode(true);
        clone.querySelectorAll('input,script,style,ol,ul').forEach(n => n.remove());
        const qText = norm(clone.textContent).slice(0, 250);
        if (qText.length < 4) continue;
        out.push({ question: qText, correct: optText });
      }
      return out;
    })()`,
  );
  if (!raw || raw.length === 0) return [];

  // Validation pass — the page-side parser is permissive (any "正確" hit
  // counts), which means it can lock onto unrelated decoration text and
  // pollute learned_answers with garbage. Each candidate is only kept if
  // both (a) the extracted question text fuzzy-matches one of the actual
  // questions we just asked, AND (b) the extracted "correct" text matches
  // one of that question's options.
  const valid: ResultEntry[] = [];
  for (const cand of raw) {
    const candQNorm = candNormForMatch(cand.question);
    if (!candQNorm) continue;

    let bestMatch: { q: ExtractedQuestion; sim: number } | null = null;
    for (const q of askedQuestions) {
      const qn = candNormForMatch(q.text);
      const sim = candDice(qn, candQNorm);
      if (!bestMatch || sim > bestMatch.sim) bestMatch = { q, sim };
    }
    if (!bestMatch || bestMatch.sim < 0.55) continue;

    // Confirm the extracted "correct" is actually one of this question's options
    const matched = matchOptionText(cand.correct, bestMatch.q.options);
    if (matched === null) continue;

    valid.push({ question: bestMatch.q.text, correct: bestMatch.q.options[matched] });
  }
  return valid;
}

function candNormForMatch(s: string): string {
  return (s || "")
    .replace(/[\s　]+/g, "")
    .replace(/[?？，,。.：:！!（）()\[\]【】《》「」『』]/g, "")
    .replace(/^單選配分.*?\d+\.\s*/, "") // strip "單選配分：[10.00] 1." form-metadata prefix
    .toLowerCase();
}

function candDice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const A = grams(a);
  const B = grams(b);
  let overlap = 0;
  for (const [g, cA] of A) {
    const cB = B.get(g);
    if (cB) overlap += Math.min(cA, cB);
  }
  const sa = Array.from(A.values()).reduce((x, y) => x + y, 0);
  const sb = Array.from(B.values()).reduce((x, y) => x + y, 0);
  if (sa + sb === 0) return 0;
  return (2 * overlap) / (sa + sb);
}

function matchOptionText(target: string, options: string[]): number | null {
  const norm = (s: string) => candNormForMatch(s);
  const t = norm(target);
  if (!t) return null;
  for (let i = 0; i < options.length; i++) {
    if (norm(options[i]) === t) return i;
  }
  for (let i = 0; i < options.length; i++) {
    const o = norm(options[i]);
    if (o.includes(t) || t.includes(o)) return i;
  }
  let best = -1;
  let bestSim = 0;
  for (let i = 0; i < options.length; i++) {
    const sim = candDice(norm(options[i]), t);
    if (sim > bestSim) {
      best = i;
      bestSim = sim;
    }
  }
  return bestSim >= 0.7 ? best : null;
}

async function dumpResultHtml(win: BrowserWindow, cid: string): Promise<void> {
  if (dumpedResultOnce) return;
  dumpedResultOnce = true;
  try {
    const html = await execJs<string>(win, `document.documentElement.outerHTML`);
    if (!html) return;
    const file = join(app.getPath("temp"), `auto-elearn-result-${cid}.html`);
    writeFileSync(file, html, "utf8");
  } catch {
    /* non-fatal */
  }
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

interface AttemptResult {
  score: number | null;
  questions: ExtractedQuestion[];
  learned: number;
  /** Validated result-page answers from this attempt (matched to a question
   *  + one of its options). Used by runExamLoop to lock those Qs into
   *  bfStates so brute-force probing skips them next round. */
  learnedFromResult: ResultEntry[];
  /** Option idx that was actually selected for each question, by question index. */
  picksByIdx: number[];
}

async function runOneAttempt(
  win: BrowserWindow,
  cid: string,
  examUrl: string,
  label: string,
  bySource: Record<AnswerSource, number>,
  onProgress: (msg: string) => void,
  opts: {
    skipMixedDb: boolean;
    passingScore: number;
    /** key = normalised question text → forced option idx (skips matcher). */
    forcedAnswers?: Map<string, number>;
  },
): Promise<AttemptResult> {
  await win.loadURL(examUrl);
  await wait(2000);

  // Trigger examBegin() if available
  await execJs(win, `(() => { try { if (typeof examBegin==='function') examBegin(); } catch(e){} })();`);

  const questions = await extractQuestions(win);
  if (questions.length === 0) {
    onProgress(`[${label}] 無法取得題目`);
    return { score: null, questions: [], learned: 0, learnedFromResult: [], picksByIdx: [] };
  }
  onProgress(
    `[${label}] ${questions.length} 題${opts.skipMixedDb ? "（跳過 mixed.db，強制 LLM/learned）" : ""}${opts.forcedAnswers && opts.forcedAnswers.size > 0 ? `（暴力覆蓋 ${opts.forcedAnswers.size} 題）` : ""}`,
  );

  const llmAnswered: Array<{ question: string; answer: string }> = [];
  const picksByIdx: number[] = new Array(questions.length).fill(0);

  for (const q of questions) {
    let pickedIdx: number;
    let source: AnswerSource;
    let confidence: number;

    const forcedKey = normalizeQuestion(q.text);
    const forcedIdx = opts.forcedAnswers?.get(forcedKey);
    if (typeof forcedIdx === "number" && forcedIdx >= 0 && forcedIdx < q.options.length) {
      pickedIdx = forcedIdx;
      source = "random"; // brute-force probe — bookkept under "random" for stats
      confidence = 0;
    } else {
      const r = await findBestAnswer(q.text, q.options, { skipMixedDb: opts.skipMixedDb });
      pickedIdx = r.pickedIdx;
      source = r.source;
      confidence = r.confidence;
    }

    bySource[source]++;
    picksByIdx[q.index] = pickedIdx;

    const value = q.values[pickedIdx] ?? String(pickedIdx + 1);
    onProgress(`  Q${q.index + 1} [${source} ${confidence.toFixed(2)}] → ${q.options[pickedIdx]?.slice(0, 30) ?? value}`);

    if (source === "llm") {
      llmAnswered.push({ question: q.text, answer: q.options[pickedIdx] ?? "" });
    }

    await selectOption(win, q.inputName, value);
  }

  const score = await submitAndParseScore(win);
  onProgress(`[${label}] 分數：${score ?? "?"}`);

  // Persist LLM answers if exam passed (kept the old 60 floor here — it's
  // about whether the LLM choice was reliable enough to remember, not the
  // course's pass threshold).
  if (score !== null && score >= 60) {
    for (const { question, answer } of llmAnswered) {
      saveLearnedAnswer({ question, answer, source: "llm", confidence: 0.9, courseId: cid });
    }
  }

  // Learn from the result page — this is the key correction loop. If
  // elearn shows correct answers post-submission we save them to
  // learned_answers (writable, higher priority than read-only mixed.db),
  // so the NEXT attempt picks the corrected answer.
  //
  // Validation: extractResultAnswers cross-checks each candidate against
  // the questions we just asked + their options, so a permissive page
  // parser hitting unrelated "正確" decoration text doesn't pollute
  // learned_answers.
  let learned = 0;
  let learnedFromResult: ResultEntry[] = [];
  if (score !== null) {
    // Always dump the first result page once per process so we can verify
    // the parser format off-line — independent of whether parsing
    // succeeded. (Earlier code only dumped on parse failure, which never
    // fired when the parser was over-matching garbage.)
    await dumpResultHtml(win, cid);

    learnedFromResult = await extractResultAnswers(win, questions);
    for (const { question, correct } of learnedFromResult) {
      saveLearnedAnswer({ question, answer: correct, source: "result-page", confidence: 1.0, courseId: cid });
    }
    learned = learnedFromResult.length;
    if (learned > 0) {
      onProgress(`[${label}] 從成績頁學到 ${learned} 題正解（已驗證對應題目+選項）`);
    } else if (score < opts.passingScore) {
      onProgress(`[${label}] 成績頁無可信正解；繼續暴力搜索`);
    }
  }

  return { score, questions, learned, learnedFromResult, picksByIdx };
}

// ─── Exam loop (retry until 100 or max attempts) ──────────────

async function runExamLoop(
  win: BrowserWindow,
  cid: string,
  menuPattern: string,
  label: string,
  bySource: Record<AnswerSource, number>,
  onProgress: (msg: string) => void,
  passingScore = 60,
): Promise<number | null> {
  let best: number | null = null;

  // Brute-force the exam: each navigation hiccup gets a retry rather than
  // aborting the whole loop. Some elearn pages return an empty sysbar / no
  // togo on the first hit but populate it on a refresh; previously we'd
  // give up after one bad attempt and report 0 score forever. Now we burn
  // through the full MAX_EXAM_ATTEMPTS budget unless we already passed.
  let consecutiveSetupFailures = 0;
  // skipMixedDb is flipped to true after a failed attempt that learned 0 from
  // the result page — that means mixed.db is the dead-end (cached wrong
  // answers) and we should try LLM/learned_answers only on the next round.
  // Returns to false once we've learned at least 1 result-page answer (since
  // learned_answers will now override mixed.db's wrong rows naturally).
  let skipMixedDb = false;

  // Brute-force probe state. Initialized after the first scoring attempt.
  // Each entry tracks one question across retries — which option indices have
  // been tried, the highest score observed for each, and the current best.
  // We probe ONE question per retry by flipping its answer to a still-untried
  // option while every other question stays at its current best — the score
  // delta tells us whether the flipped option is better, equal, or worse than
  // the current best for that question. No LLM, no result-page parsing
  // required. Activated only when the result page yields no truth and the
  // user is below passing.
  let bfStates: Map<string, QProbeState> | null = null;
  // Pointer into bfStates iteration; populated lazily.
  let bfQueue: string[] = [];
  let bfQueueIdx = 0;

  const buildForcedAnswers = (): Map<string, number> => {
    const out = new Map<string, number>();
    if (!bfStates) return out;
    for (const [k, st] of bfStates) out.set(k, st.bestOption);
    return out;
  };

  for (let attempt = 1; attempt <= MAX_EXAM_ATTEMPTS; attempt++) {
    if (best !== null && best >= passingScore) break; // good enough to pass

    const ok = await enterLC(win, cid, onProgress);
    if (!ok) {
      onProgress(`enterLC 失敗 (attempt ${attempt})；${attempt < MAX_EXAM_ATTEMPTS ? "稍候重試" : "放棄"}`);
      consecutiveSetupFailures++;
      if (consecutiveSetupFailures >= 3) break; // 3 連續 setup fail 才真的放棄
      await wait(3000);
      continue;
    }

    const links = await getSysbarLinks(win);
    if (!links.some((l) => new RegExp(menuPattern).test(l))) {
      onProgress(`找不到「${menuPattern}」選單 (attempt ${attempt})；${attempt < MAX_EXAM_ATTEMPTS ? "稍候重試" : "放棄"}`);
      consecutiveSetupFailures++;
      if (consecutiveSetupFailures >= 3) break;
      await wait(3000);
      continue;
    }

    const clicked = await clickSysbarLink(win, menuPattern);
    if (!clicked) {
      onProgress(`clickSysbarLink 失敗 (attempt ${attempt})`);
      consecutiveSetupFailures++;
      if (consecutiveSetupFailures >= 3) break;
      await wait(3000);
      continue;
    }

    const examUrl = await getExamUrl(win);
    if (!examUrl) {
      onProgress(`找不到 togo 按鈕 (attempt ${attempt})；${attempt < MAX_EXAM_ATTEMPTS ? "可能 sysbar 還沒載入完，稍候重試" : "放棄"}`);
      consecutiveSetupFailures++;
      if (consecutiveSetupFailures >= 3) break;
      await wait(5000);
      continue;
    }

    // Reaching here means setup succeeded; reset the failure counter.
    consecutiveSetupFailures = 0;

    // Decide which Q (if any) to probe in brute-force mode this iteration.
    // Brute force is the LAST RESORT: only engage when (a) we have a baseline
    // (bfStates seeded), (b) skipMixedDb is off so we don't fight LLM mode,
    // and (c) we've actually fallen below passing already. attempt 1 always
    // runs normal lookups so we have a baseline to seed from.
    const bfActive = bfStates !== null && !skipMixedDb && best !== null && best < passingScore;
    let probingKey: string | null = null;
    let probingOption: number | null = null;
    if (bfActive && bfStates) {
      while (bfQueueIdx < bfQueue.length) {
        const k = bfQueue[bfQueueIdx];
        const st = bfStates.get(k);
        if (!st) {
          bfQueueIdx++;
          continue;
        }
        let next: number | null = null;
        for (let i = 0; i < st.options.length; i++) {
          if (!st.tested.has(i)) {
            next = i;
            break;
          }
        }
        if (next === null) {
          bfQueueIdx++; // exhausted this Q's options; move on
          continue;
        }
        probingKey = k;
        probingOption = next;
        break;
      }
    }

    // Build the forcedAnswers map for this attempt:
    //   - all Qs in bfStates → use their bestOption
    //   - the probing Q (if any) → override with probingOption
    let forcedAnswers: Map<string, number> | undefined;
    if (bfActive) {
      forcedAnswers = buildForcedAnswers();
      if (probingKey !== null && probingOption !== null) {
        forcedAnswers.set(probingKey, probingOption);
        const st = bfStates!.get(probingKey)!;
        onProgress(
          `[${label}] 暴力探測 「${st.questionText.slice(0, 30)}…」 改試 opt[${probingOption}] 「${(st.options[probingOption] ?? "").slice(0, 30)}」`,
        );
      } else if (forcedAnswers.size > 0 && bfQueueIdx >= bfQueue.length) {
        onProgress(`[${label}] 暴力搜索已試完所有題目；保持當前最佳組合`);
      }
    }

    const { score, learned, learnedFromResult, questions, picksByIdx } = await runOneAttempt(
      win,
      cid,
      examUrl,
      `${label} #${attempt}`,
      bySource,
      onProgress,
      { skipMixedDb, passingScore, forcedAnswers },
    );

    // NOTE: do NOT update `best` here yet — the brute-force compare below
    // needs the OLD ceiling to classify the probe as ↑/↓/=. `best` gets
    // promoted inside the ↑ branch (or implicitly by capturing it on the
    // first scoring attempt where bfStates is null).

    // Initialize / update brute-force state from this attempt's results.
    // The decision uses the prior `best` (overall best across all attempts)
    // as the reference, NOT a per-Q stored score — once one Q's flip lifts
    // the ceiling, every subsequent Q's probe must compare to the new
    // ceiling or we'd misclassify "still right" Qs as ambiguous "=".
    if (score !== null) {
      const priorBest = best ?? score;

      if (!bfStates) {
        // First scoring attempt — seed state from each question's pick AND
        // capture the baseline as `best`. Subsequent probes compare
        // against this number until the ↑ branch promotes it.
        best = score;
        bfStates = new Map();
        bfQueue = [];
        for (const q of questions) {
          const key = normalizeQuestion(q.text);
          if (!key) continue;
          const optIdx = picksByIdx[q.index] ?? 0;
          bfStates.set(key, {
            questionText: q.text,
            options: q.options.slice(),
            bestOption: optIdx,
            bestScore: score,
            tested: new Set([optIdx]),
          });
          bfQueue.push(key);
        }
      } else if (probingKey !== null && probingOption !== null) {
        const st = bfStates.get(probingKey);
        if (st) {
          st.tested.add(probingOption);
          if (score > priorBest) {
            // Strictly better than overall best — flipped option is correct.
            st.bestOption = probingOption;
            st.bestScore = score;
            saveLearnedAnswer({
              question: st.questionText,
              answer: st.options[probingOption] ?? "",
              source: "brute",
              confidence: 0.95,
              courseId: cid,
            });
            onProgress(
              `[${label}] ↑ 「${st.questionText.slice(0, 24)}…」 改 opt[${probingOption}] 提分 ${priorBest}→${score}（已存 learned_answers）`,
            );
            best = score;
            bfQueueIdx++;
          } else if (score < priorBest) {
            // Lower than current ceiling — Q was right at its current
            // bestOption; flipping to probingOption broke it.
            onProgress(
              `[${label}] ↓ 「${st.questionText.slice(0, 24)}…」 opt[${probingOption}] 反而降分 (${score} < ${priorBest})；原答對，停試此題`,
            );
            bfQueueIdx++;
          } else {
            // Same as ceiling — both options wrong (single-answer MC: at
            // most one is right). Try the next untested option for this Q.
            onProgress(
              `[${label}] = 「${st.questionText.slice(0, 24)}…」 opt[${probingOption}] 同分 (${score})；繼續試下個選項`,
            );
            // do NOT advance bfQueueIdx — same Q, next option next round
          }
        }
      }
    }

    // Integrate result-page learnings into bfStates: when elearn shows the
    // correct answer post-submission, lock that Q's bestOption to the
    // matched option idx and remove it from the probe queue. This is the
    // free-lunch path — no probe attempts wasted on a Q whose answer the
    // server already gave us.
    if (bfStates && learnedFromResult.length > 0) {
      for (const entry of learnedFromResult) {
        const key = normalizeQuestion(entry.question);
        const st = bfStates.get(key);
        if (!st) continue;
        const optIdx = matchOptionText(entry.correct, st.options);
        if (optIdx === null || optIdx < 0) continue;
        if (st.bestOption === optIdx) continue; // already locked at the right one
        st.bestOption = optIdx;
        st.tested = new Set(st.options.map((_, i) => i)); // mark all options tested → won't be probed again
        // Pop this Q out of the queue if it's the current head, so the next
        // iteration doesn't re-probe a Q the server already settled.
        while (bfQueueIdx < bfQueue.length && bfQueue[bfQueueIdx] === key) bfQueueIdx++;
        onProgress(
          `[${label}] 🎓 結果頁告知正解：「${st.questionText.slice(0, 24)}…」 = opt[${optIdx}] 「${(st.options[optIdx] ?? "").slice(0, 24)}」（已鎖定，跳過暴力探測）`,
        );
      }
    }

    if (best === 100) {
      onProgress(`🎯 100 分！`);
      break;
    }

    // Brute-force budget guard: once we've walked through every Q in the
    // queue (each Q either found a better option via ↑, was confirmed
    // correct via ↓ early-exit, or exhausted its options via repeated =),
    // there is nothing more to probe — keeping the loop alive only burns
    // exam attempts that submit the same locked combo over and over.
    //
    // EARLIER BUG: the guard required `totalUntested === 0`, but the ↓
    // branch advances the queue WITHOUT testing every option (since
    // baseline was right, the other 2-3 alternates aren't worth probing).
    // That left totalUntested > 0 forever and the loop would spin
    // submitting the same answers indefinitely — exactly the symptom the
    // user just hit on cid 10046346 attempts #14-#24.
    if (bfStates && bfQueueIdx >= bfQueue.length) {
      onProgress(`[${label}] 暴力搜索結束：${best ?? 0} 分（已走完佇列）`);
      break;
    }

    // Decide retry strategy for next round:
    //   • Got new correct answers from the result page → keep using mixed.db
    //     (learned_answers now wins for the corrected ones).
    //   • Score below passing AND we learned 0 → mixed.db is the dead-end,
    //     force LLM/learned-only on next attempt (assuming Gemini is
    //     configured; otherwise no-op since LLM falls through to random).
    if (score !== null && score < passingScore) {
      if (learned === 0 && hasGeminiKey()) {
        if (!skipMixedDb) {
          onProgress(`[${label}] 切換策略：下次重考改走 LLM`);
        }
        skipMixedDb = true;
      } else if (learned > 0) {
        // We got fresh truth — go back to normal lookup so newly learned
        // answers can rescue mostly-right attempts.
        skipMixedDb = false;
      }
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
  opts: {
    onProgress?: (msg: string) => void;
    timeoutMs?: number;
    /** Per-course passing threshold (parsed from /info 課程須知). Solver
     *  stops retrying once a score >= passingScore is achieved. Default 60
     *  is the lowest elearn tier; 公務人員10小時 is 75 and a few are 80. */
    passingScore?: number;
  } = {},
): Promise<SolveResult> {
  const onProgress = opts.onProgress ?? (() => void 0);
  const result: SolveResult = {
    ok: false,
    total: 0,
    bySource: { db: 0, fuzzy: 0, llm: 0, random: 0 },
  };

  // disableDialogs kills alert/prompt at Chromium level. confirm() is
  // overridden to return true via JS injection in lc-nav.ts before any
  // click on 上課去 — see enterLC().
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session,
      contextIsolation: true,
      nodeIntegration: false,
      disableDialogs: true,
    },
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

    const passingScore = opts.passingScore ?? 60;

    // ── Main exam ──
    if (hasMainExam) {
      onProgress(`=== 測驗（通過門檻：${passingScore} 分）===`);
      const score = await runExamLoop(
        win,
        cid,
        "測驗|考試",
        "測驗",
        result.bySource,
        onProgress,
        passingScore,
      );
      result.score = score ?? undefined;
      result.total = result.bySource.db + result.bySource.fuzzy + result.bySource.llm + result.bySource.random;
      result.passed = (score ?? 0) >= passingScore;
      result.ok = true;
    }

    // ── Reading exam (閱讀測驗) ──
    if (hasReadExam) {
      onProgress(`=== 閱讀測驗（通過門檻：${passingScore} 分）===`);
      const rScore = await runExamLoop(
        win,
        cid,
        "閱讀",
        "閱讀測驗",
        result.bySource,
        onProgress,
        passingScore,
      );
      result.readExamScore = rScore ?? undefined;
      if (!hasMainExam) {
        result.total = result.bySource.db + result.bySource.fuzzy + result.bySource.llm + result.bySource.random;
        result.score = rScore ?? undefined;
        result.passed = (rScore ?? 0) >= passingScore;
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
