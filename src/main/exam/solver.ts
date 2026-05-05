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
import {
  acquireElearnWindowSlot,
  releaseElearnWindowSlot,
} from "../heartbeat/reader";
import { isGeminiUsable } from "../llm/gemini";

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

  // Position-based extraction: walk the row tree depth-first, splitting text
  // nodes into N segments by their position relative to the N inputs.
  // We collect text BOTH before (pre[]) and after (post[]) each input.
  // Some elearn templates put the option label after the input
  // (`<input> 是<input> 否`) and others put it before
  // (`是<input>否<input>`); we pick whichever side has uniformly non-empty
  // segments per option. This replaces the earlier closest-li/closest-label
  // chain which silently returned empty strings on biosafety / HEPA exams.
  const result = await execJs<{
    questions: ExtractedQuestion[];
    diagnostic: string | null;
  }>(
    win,
    `(() => {
      const rows = Array.from(document.querySelectorAll('tr.bg03,tr.bg04'));
      if (!rows.length) return { questions: [], diagnostic: null };
      const norm = (s) => (s || '').replace(/\\s+/g,' ').trim().slice(0,200);
      const questions = [];
      let diagnostic = null;

      rows.forEach((row, index) => {
        const inputs = Array.from(row.querySelectorAll('input[type=radio],input[type=checkbox]'));
        if (!inputs.length) return;

        // Question text: clone row, strip ol/ul/input/script/style → textContent
        const clone = row.cloneNode(true);
        clone.querySelectorAll('ol,ul,input,script,style').forEach(el => el.remove());
        const text = norm(clone.textContent).slice(0,400);

        const values = inputs.map(i => i.value);
        const inputSet = new Set(inputs);
        const N = inputs.length;
        // post[i] = text seen AFTER input[i], before input[i+1] (or end).
        // pre[i]  = text seen BEFORE input[i], after input[i-1] (or row start).
        // For elearn's standard "<input>option-text" markup post is correct.
        // For the rare "option-text<input>" markup pre is correct. Use the
        // one with more non-empty slots; tie → post (which is the elearn
        // default; otherwise pre[0] would always win because it absorbs
        // the row's question text).
        //
        // 是非題 special: option text is two <img> (right.gif / wrong.gif)
        // not text. Detect imgs in each segment and map to 是/否 so DB
        // lookups + log readability survive.
        const post = Array.from({length: N}, () => ({ texts: [], imgs: [] }));
        const pre  = Array.from({length: N}, () => ({ texts: [], imgs: [] }));
        let cursorIdx = -1;

        const walk = (node) => {
          if (node.nodeType === 1) {
            if (inputSet.has(node)) {
              cursorIdx = inputs.indexOf(node);
              return;
            }
            const tag = (node.tagName || '').toUpperCase();
            if (tag === 'SCRIPT' || tag === 'STYLE') return;
            if (tag === 'IMG') {
              const src = (node.getAttribute && node.getAttribute('src')) || '';
              if (cursorIdx === -1) {
                pre[0].imgs.push(src);
              } else {
                if (cursorIdx < N) post[cursorIdx].imgs.push(src);
                if (cursorIdx + 1 < N) pre[cursorIdx + 1].imgs.push(src);
              }
              return; // don't descend into img
            }
            Array.from(node.childNodes).forEach(walk);
          } else if (node.nodeType === 3) {
            const t = (node.textContent || '').trim();
            if (!t) return;
            if (cursorIdx === -1) {
              pre[0].texts.push(t);
            } else {
              if (cursorIdx < N) post[cursorIdx].texts.push(t);
              if (cursorIdx + 1 < N) pre[cursorIdx + 1].texts.push(t);
            }
          }
        };
        walk(row);

        // Map "right" / "wrong" (and 是/否-style) image filenames to text
        // so 是非題 questions get matchable option text.
        const imgToLabel = (imgs) => {
          for (const src of imgs) {
            const s = (src || '').toLowerCase();
            if (s.includes('right') || s.includes('correct') || s.includes('yes') || s.includes('true') || s.includes('o.gif')) return '是';
            if (s.includes('wrong') || s.includes('error')   || s.includes('no')  || s.includes('false') || s.includes('x.gif')) return '否';
          }
          return '';
        };

        const buildOptions = (segs) => segs.map(seg => {
          const t = norm(seg.texts.join(' '));
          if (t) return t;
          const lbl = imgToLabel(seg.imgs);
          if (lbl) return lbl;
          return '';
        });
        const optsPost = buildOptions(post);
        const optsPre  = buildOptions(pre);

        const nonEmpty = (arr) => arr.filter(s => s).length;
        // Default to post. Only switch to pre when pre captures STRICTLY
        // more option slots — otherwise pre[0] would steal row-prefix text
        // (e.g. "單選 配分：[10.00] 1. 從需求者…") and present it as
        // option A, which is what was happening before this rewrite.
        let options = nonEmpty(optsPre) > nonEmpty(optsPost) ? optsPre : optsPost;

        // Dedupe defensively: if every option ended up identical (single
        // ancestor with all options' text concatenated), zero them out.
        // The brute-force solver still works (it submits by value, not by
        // text), and downstream matching won't be fooled by phantom hits.
        if (options.length > 1 && options.every(o => o === options[0]) && options[0].length > 0) {
          options = options.map(() => '');
        }

        // Last-resort 是非 detection: 2 inputs with values that look like
        // T/F or 1/0 → force 是/否 even if no img matched (in case the
        // markup uses some other indicator we didn't catch).
        if (options.length === 2 && options.every(o => !o)) {
          const vSet = new Set(inputs.map(i => (i.value || '').toUpperCase()));
          if (vSet.has('T') && vSet.has('F')) {
            options = inputs.map(i => (i.value || '').toUpperCase() === 'T' ? '是' : '否');
          } else if (vSet.has('1') && vSet.has('0')) {
            options = inputs.map(i => i.value === '1' ? '是' : '否');
          }
        }

        // First row with empty options: dump the row HTML so we can iterate.
        if (!diagnostic && options.some(o => !o)) {
          diagnostic = (row.outerHTML || '').slice(0, 8000);
        }

        questions.push({
          index,
          text,
          options,
          values,
          inputName: inputs[0].name || '',
          isMultiple: inputs[0].type === 'checkbox',
        });
      });

      return { questions: questions.length ? questions : [], diagnostic };
    })()`,
  );

  if (!result) return [];

  // If we got a diagnostic dump, persist it so the user can share it for
  // markup-specific tuning. One file per process to avoid temp-dir spam.
  if (result.diagnostic && !diagnosticDumped) {
    diagnosticDumped = true;
    try {
      const file = join(app.getPath("temp"), `auto-elearn-exam-row.html`);
      writeFileSync(file, result.diagnostic, "utf8");
    } catch {
      /* non-fatal */
    }
  }

  return result.questions ?? [];
}

let diagnosticDumped = false;

// ─── Option selection ─────────────────────────────────────────

async function selectOption(
  win: BrowserWindow,
  inputName: string,
  values: string[],
): Promise<void> {
  if (!inputName || values.length === 0) return;
  // safeN: escaped for the surrounding template literal AND the selector
  // attribute string. Order matters — backslash first so we don't escape
  // our own escapes.
  const safeN = inputName
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/`/g, "\\`");
  // values are routed through JSON.stringify which already handles
  // backslash + double-quote escaping correctly. No manual pre-pass:
  // doing both produces double-escaped strings whose [value="..."]
  // selectors don't match the real DOM input value.
  // Submit each value: for radios, only the last sticks (single-select
  // behaviour preserved). For checkboxes, every match is checked.
  await execJs(
    win,
    `(() => {
      const vals = ${JSON.stringify(values)};
      let any = false;
      for (const v of vals) {
        const sel = 'input[name="${safeN}"][value="' + v.replace(/"/g, '\\\\"') + '"]';
        const el = document.querySelector(sel);
        if (el) { el.checked = true; el.dispatchEvent(new Event('change',{bubbles:true})); any = true; }
      }
      return any;
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
  /** AnswerSource per question (parallel to picksByIdx). v0.8.16: lets
   *  runExamLoop seed bfStates without including web-prefetch hits — those
   *  are already ground truth (priority 10) and brute-force probing them
   *  via forcedAnswers overwrites the correct answer with each round's
   *  baseline picksByIdx[0], dropping scores. */
  picksSource: AnswerSource[];
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
    /** Course name forwarded to LLM matcher for domain context. */
    courseName?: string;
  },
): Promise<AttemptResult> {
  await win.loadURL(examUrl);
  await wait(2000);

  // Trigger examBegin() if available
  await execJs(win, `(() => { try { if (typeof examBegin==='function') examBegin(); } catch(e){} })();`);

  const questions = await extractQuestions(win);
  if (questions.length === 0) {
    onProgress(`[${label}] 無法取得題目`);
    return {
      score: null,
      questions: [],
      learned: 0,
      learnedFromResult: [],
      picksByIdx: [],
      picksSource: [],
    };
  }
  onProgress(
    `[${label}] ${questions.length} 題${opts.skipMixedDb ? "（跳過 mixed.db，強制 LLM/learned）" : ""}${opts.forcedAnswers && opts.forcedAnswers.size > 0 ? `（暴力覆蓋 ${opts.forcedAnswers.size} 題）` : ""}`,
  );

  const llmAnswered: Array<{ question: string; answer: string }> = [];
  const allPicks: Array<{ question: string; answer: string; source: AnswerSource }> = [];
  const picksByIdx: number[] = new Array(questions.length).fill(0);
  const picksSource: AnswerSource[] = new Array(questions.length).fill("random");

  for (const q of questions) {
    let pickedIdxs: number[];
    let source: AnswerSource;
    let confidence: number;

    const forcedKey = normalizeQuestion(q.text);
    const forcedIdx = opts.forcedAnswers?.get(forcedKey);
    if (typeof forcedIdx === "number" && forcedIdx >= 0 && forcedIdx < q.options.length) {
      // Brute-force probe path is single-only (it flips ONE option per round).
      pickedIdxs = [forcedIdx];
      source = "brute";
      confidence = 0;
    } else {
      const r = await findBestAnswer(q.text, q.options, {
        skipMixedDb: opts.skipMixedDb,
        courseName: opts.courseName,
      });
      pickedIdxs = r.pickedIdxs;
      source = r.source;
      confidence = r.confidence;
    }

    // Sanitize pickedIdxs against this exam's option count (defensive — bank
    // could in theory have stale options that no longer exist on the page).
    pickedIdxs = pickedIdxs.filter((i) => i >= 0 && i < q.options.length);
    if (pickedIdxs.length === 0) {
      // Fall back to a random pick rather than skipping the question.
      pickedIdxs = [Math.floor(Math.random() * Math.max(1, q.options.length))];
      source = "random";
      confidence = 0;
    }

    bySource[source]++;
    // picksByIdx tracks the FIRST chosen index per question for brute-force
    // bookkeeping (which only operates on single-select). Multi-select still
    // reports its first answer here; brute won't probe multi-select rows
    // since their answers are already cached as web-prefetch.
    picksByIdx[q.index] = pickedIdxs[0];
    picksSource[q.index] = source;

    const optsText = pickedIdxs
      .map((i) => q.options[i]?.slice(0, 30) ?? String(i + 1))
      .join(" | ");
    onProgress(
      `  Q${q.index + 1} [${source} ${confidence.toFixed(2)}]${
        pickedIdxs.length > 1 ? ` ×${pickedIdxs.length}` : ""
      } → ${optsText}`,
    );

    for (const idx of pickedIdxs) {
      const answerText = q.options[idx] ?? "";
      if (source === "llm") {
        llmAnswered.push({ question: q.text, answer: answerText });
      }
      if (answerText) {
        allPicks.push({ question: q.text, answer: answerText, source });
      }
    }

    const values = pickedIdxs.map((i) => q.values[i] ?? String(i + 1));
    await selectOption(win, q.inputName, values);
  }

  const score = await submitAndParseScore(win);
  onProgress(`[${label}] 分數：${score ?? "?"}`);

  // Persistence policy (revised v0.7.0):
  //
  //   • score === 100: every pick is provably correct. Save ALL picks
  //     (even random / brute-force ones) as "perfect-attempt" — this is
  //     the highest-value backfill path: questions the matcher couldn't
  //     handle this round get cached for next time.
  //
  //   • score >= passingScore (and < 100): only save LLM picks. Random
  //     and DB picks at <100 might include wrong answers; we can't tell
  //     which without per-Q score deltas (that's brute-force's job).
  //
  //   • score < passingScore: save LLM picks anyway (was gated at >=60).
  //     The matcher already filters Gemini at confidence>=0.4 — those
  //     answers carry information even if the exam as a whole fell short.
  //     They get re-validated on subsequent attempts via the brute-force
  //     loop so wrong LLM picks do get corrected.
  if (score !== null) {
    if (score === 100) {
      // Group all picks for the same question, then save the multi-answer
      // array. This catches multi-select questions where pickedIdxs covered
      // multiple options.
      const grouped = new Map<string, string[]>();
      const sources = new Map<string, AnswerSource>();
      for (const { question, answer, source: src } of allPicks) {
        if (src === "random") continue;
        const arr = grouped.get(question) ?? [];
        arr.push(answer);
        grouped.set(question, arr);
        // Latest source wins; in practice all picks for a question share
        // a source (either web-prefetch, llm, etc).
        sources.set(question, src);
      }
      for (const [question, answers] of grouped) {
        const src = sources.get(question) ?? "perfect-attempt";
        saveLearnedAnswer({
          question,
          answers,
          source: src === "llm" ? "llm" : "perfect-attempt",
          confidence: src === "llm" ? 0.95 : 1.0,
          courseId: cid,
        });
      }
    } else {
      for (const { question, answer } of llmAnswered) {
        saveLearnedAnswer({
          question,
          answers: [answer],
          source: "llm",
          confidence: 0.85,
          courseId: cid,
        });
      }
    }
  }

  // The result-page parser was the source of repeated learned_answers
  // pollution: even with cross-validation it kept picking the user's
  // submitted answer (or unrelated decoration text) as the "正解",
  // overwriting correct history-solve entries on cid 10046346.
  // Since elearn's view_result.php only reliably shows the user's
  // submission + score (the actual correct answer is gated behind
  // "公布答案" which locks retests), there's no upstream truth to
  // extract — the parser was guessing. Removed entirely. The first
  // result-page HTML is still dumped once per process so future debug
  // sessions have the artefact, but nothing is saved to DB or fed back
  // into bfStates.
  if (score !== null) {
    await dumpResultHtml(win, cid);
  }

  return { score, questions, learned: 0, learnedFromResult: [], picksByIdx, picksSource };
}

// ─── Exam loop (retry until 100 or max attempts) ──────────────

async function runExamLoop(
  win: BrowserWindow,
  cid: string,
  menuPattern: string,
  label: string,
  bySource: Record<AnswerSource, number>,
  onProgress: (msg: string) => void,
  passingScore = 80,
  courseName?: string,
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

    // v0.8.6：caller (solveExam) 已 hold slot，這裡不能再 acquire
    const ok = await enterLC(win, cid, onProgress, { skipSlotAcquire: true });
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

    const { score, learned, learnedFromResult, questions, picksByIdx, picksSource } = await runOneAttempt(
      win,
      cid,
      examUrl,
      `${label} #${attempt}`,
      bySource,
      onProgress,
      { skipMixedDb, passingScore, forcedAnswers, courseName },
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

        // v0.8.13 early-exit guard: if the first attempt got NOTHING from
        // web-prefetch AND the score is severely below passing, brute-force
        // is unlikely to recover. Common cause: bank fuzzy-matched the
        // course title (e.g. "行政中立暨公務倫理") but its question set is
        // a different year's edition than the elearn exam page. Burning
        // 30 attempts of brute on hopeless content blocks all other queued
        // chains (ELEARN_WINDOW_CONCURRENCY=1). Bail early instead.
        const webPrefetchHits = bySource["web-prefetch"] ?? 0;
        const severelyLow = score < passingScore - 30;
        if (webPrefetchHits === 0 && severelyLow) {
          onProgress(
            `[${label}] 提早放棄：web-prefetch 0 命中、score=${score} 距門檻 ${passingScore} > 30 分（題庫疑為異年版本，brute 救不了；釋放 slot）`,
          );
          break;
        }

        bfStates = new Map();
        bfQueue = [];
        let webPrefetchSkipped = 0;
        for (const q of questions) {
          const key = normalizeQuestion(q.text);
          if (!key) continue;
          // v0.8.16: skip seeding bfStates for questions whose first-attempt
          // pick came from web-prefetch (priority 10 ground truth). Brute
          // probing them via forcedAnswers replaces the correct multi-✓
          // submission with picksByIdx[0] (single index), instantly turning
          // a correct answer wrong. By keeping these out of bfStates, they
          // never enter forcedAnswers, so subsequent attempts re-run the
          // matcher → web-prefetch hit again → keep the right answer.
          if (picksSource[q.index] === "web-prefetch") {
            webPrefetchSkipped++;
            continue;
          }
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
        if (webPrefetchSkipped > 0) {
          onProgress(
            `[${label}] 暴力探測準備：跳過 ${webPrefetchSkipped} 題 web-prefetch 題目（已是 ground truth），只 probe 其餘 ${bfQueue.length} 題`,
          );
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
              answers: [st.options[probingOption] ?? ""],
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
      // v0.8.10：用 isGeminiUsable 判斷 — 沒 key OR quota 用完都不切到 LLM 模式，
      // 否則 30 次 attempt 都堵在「呼叫死掉的 LLM 拿 random」。沒 LLM 的時候
      // bfActive 會接手做暴力解題（brute-force probe），solver 還是會收斂。
      if (learned === 0 && isGeminiUsable()) {
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
     *  stops retrying once a score >= passingScore is achieved. Default 80
     *  matches course-detail.ts' conservative fallback for pages where we
     *  couldn't read the threshold. Caller (chain pipeline) usually passes
     *  the parsed per-course value. */
    passingScore?: number;
    /** Course name (caption) — passed to the LLM so it can apply domain
     *  knowledge about that specific course. Adds noticeable accuracy on
     *  topical exams (e.g. 「資訊安全責任分級」 vs. generic 知識題). */
    courseName?: string;
  } = {},
): Promise<SolveResult> {
  const onProgress = opts.onProgress ?? (() => void 0);
  const result: SolveResult = {
    ok: false,
    total: 0,
    bySource: { db: 0, fuzzy: 0, llm: 0, random: 0, brute: 0, "web-prefetch": 0 },
  };

  // v0.8.6：在 win 建立**前**就 hold elearn slot，整個 win lifecycle 都 hold 著
  // 直到 finally win.destroy。這樣 chain 並行 examTask + surveyTask 時不會有兩
  // 個 hidden window 同時掛在 hahow 頁面上 — hahow 看成 2 裝置 → 撞 limit 頁
  // → 我們之中某個會被踢 → 課程進度歸零（v0.8.4/v0.8.5 反覆撞的根因）。
  await acquireElearnWindowSlot();

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
      backgroundThrottling: false, // v0.8.8：背景 hidden window 不被 Chromium throttle
    },
  });
  suppressDialogs(win);

  try {
    // Initial LC entry to discover sysbar items. Retry up to 3× because
    // elearn occasionally drops the 上課去 click on the floor (popup
    // blocker quirk + multi-window guard double-tap) — last-seen pattern is
    // post-click url stays at /info/{cid} with frames=0 even though the
    // click registered. A short backoff lets the multi-window state clear.
    let ok = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      // v0.8.6：caller 已 hold slot，enterLC 不要再 acquire 否則 deadlock
      ok = await enterLC(win, cid, onProgress, { skipSlotAcquire: true });
      if (ok) break;
      if (attempt < 3) {
        onProgress(`solveExam: enterLC 第 ${attempt} 次失敗，等 ${5 + attempt * 3}s 再試`);
        await wait((5 + attempt * 3) * 1000);
      }
    }
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

    const passingScore = opts.passingScore ?? 80;

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
        opts.courseName,
      );
      result.score = score ?? undefined;
      result.total = result.bySource.db + result.bySource.fuzzy + result.bySource.llm + result.bySource.random + result.bySource.brute + result.bySource["web-prefetch"];
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
        opts.courseName,
      );
      result.readExamScore = rScore ?? undefined;
      if (!hasMainExam) {
        result.total = result.bySource.db + result.bySource.fuzzy + result.bySource.llm + result.bySource.random + result.bySource.brute + result.bySource["web-prefetch"];
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
    // v0.8.6：win 完全 destroy 後才 release slot — chain 並行的 surveyTask 才
    // 能進來，hahow 在任一時間點只看到一個 hidden window
    releaseElearnWindowSlot();
  }
}
