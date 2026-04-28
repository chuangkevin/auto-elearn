import { BrowserWindow, type Session } from "electron";
import * as cheerio from "cheerio";
import { saveLearnedAnswer, clearLearnedFromSourceForCourse } from "./answer-store";
import { enterLC, suppressDialogs, execJs } from "../browser/lc-nav";

/**
 * Recover an exam's correct-answer key purely from the user's existing
 * past-attempt records. elearn's `/learn/exam/view_result.php?{eid}` page
 * renders the user's submitted answers (radio `checked`) plus the score
 * (`var correct_score = 'XX'` in inline JS), but DOES NOT expose the
 * correct answers — those are gated behind a "公布答案" button that locks
 * future retakes.
 *
 * With N past attempts each providing (answers, score), we have a
 * constraint-satisfaction problem: find the answer key A* that, when used
 * as ground truth, predicts every observed score correctly. For 10-Q ×
 * 4-option exams, the search space is 4^10 ≈ 1M combinations — under a
 * second to enumerate. For 109 attempts (the user's case) the system is
 * massively over-determined; the unique combination that fits all
 * observations IS the correct key.
 *
 * No exams are submitted by this module. view_result.php is read-only
 * (per its inline `viewResult` JS source — just `window.open(...)`),
 * so calling it any number of times is safe.
 */

interface ExamQuestion {
  /** Stable per-question id parsed from input name, e.g. "361941". Survives
   *  question-order shuffling across attempts. */
  qid: string;
  text: string;
  /** Option texts in declared order, 0-indexed. Display order maps to
   *  HTML radio `value="N"` (1-based) → option idx N-1 here. */
  options: string[];
}

interface PastAttempt {
  attemptNo: number;
  eid: string;
  score: number | null;
  /** Map qid → 0-based option idx the user submitted on this attempt. */
  picks: Map<string, number>;
}

/**
 * Set up the server-side LC session (which exam_list.php / view_result.php
 * both require) by going through the same /info/{cid} → 上課去 dance the
 * normal exam flow uses, then fetch exam_list.php from inside the LC's
 * s_main frame so it has the right referer / cookie context. Returns the
 * latest viewResult eid + the SPOC origin (e.g. nera.elearn.hrd.gov.tw)
 * we're now scoped to.
 */
async function setupLcAndFindLatestEid(
  session: Session,
  cid: string,
  log: (m: string) => void,
): Promise<{ eid: string; spocBase: string; win: BrowserWindow } | null> {
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
    log("enterLC 設定 server session");
    const ok = await enterLC(win, cid, (m) => log(`enterLC: ${m}`));
    if (!ok) {
      win.destroy();
      return null;
    }
    // Now navigate s_main to exam_list.php and read the viewResult eid out.
    const result = await execJs<{ origin: string; eid: string | null; html: string } | null>(
      win,
      `(async () => {
        const f = window.frames['s_main'];
        if (!f) return null;
        f.location.href = '/learn/exam/exam_list.php';
        await new Promise(r => setTimeout(r, 2500));
        const html = (f.document && f.document.documentElement) ? f.document.documentElement.outerHTML : '';
        const m = html.match(/viewResult\\(['"]([^'"]+)['"]\\)/);
        return { origin: f.location.origin, eid: m ? m[1] : null, html: html.slice(0, 4000) };
      })()`,
    );
    if (!result || !result.eid) {
      log("exam_list.php 沒有 viewResult eid（這門課可能還沒送過任何測驗）");
      win.destroy();
      return null;
    }
    log(`找到 eid=${result.eid} (origin=${result.origin})`);
    return { eid: result.eid, spocBase: result.origin, win };
  } catch (e) {
    log(`enterLC 失敗: ${e instanceof Error ? e.message : String(e)}`);
    try { win.destroy(); } catch { /* */ }
    return null;
  }
}

interface ParsedView {
  score: number | null;
  examTimes: number;
  threshold: number | null;
  isReadAnswer: boolean;
  questions: ExamQuestion[];
  picks: Map<string, number>;
  attemptOptions: Array<{ no: number; eid: string }>;
}

function parseViewResult(html: string): ParsedView {
  const $ = cheerio.load(html);

  let score: number | null = null;
  let examTimes = 0;
  let threshold: number | null = null;
  let isReadAnswer = false;
  const scriptText = $("script").map((_, el) => $(el).html() || "").get().join("\n");
  const scoreM = scriptText.match(/var\s+correct_score\s*=\s*['"](\d+)['"]/);
  if (scoreM) score = parseInt(scoreM[1], 10);
  const timesM = scriptText.match(/var\s+examTimes\s*=\s*(\d+)/);
  if (timesM) examTimes = parseInt(timesM[1], 10);
  const thresM = scriptText.match(/var\s+threshold_score\s*=\s*(\d+)/);
  if (thresM) threshold = parseInt(thresM[1], 10);
  const readM = scriptText.match(/var\s+isReadAnswer\s*=\s*['"]?(\d)['"]?/);
  if (readM) isReadAnswer = readM[1] === "1";

  // Past-attempt dropdown — present only on the latest view, but harmless
  // when absent (just empty array).
  const attemptOptions: Array<{ no: number; eid: string }> = [];
  $("select option").each((_, el) => {
    const value = $(el).attr("value") ?? "";
    const titleAttr = $(el).attr("title") ?? "";
    const no = parseInt(titleAttr, 10);
    if (value && Number.isFinite(no) && /\d+\+\d+\+[a-f0-9]+/.test(value)) {
      attemptOptions.push({ no, eid: value });
    }
  });

  // Each question lives in a tr.bg03 / tr.bg04 row; the third <td> holds
  // the question prose + an <ol type="a"> of <li> options. The user's
  // submitted answer is the <input type="radio" checked> within that <ol>.
  const questions: ExamQuestion[] = [];
  const picks = new Map<string, number>();

  $("tr.bg03, tr.bg04").each((_, row) => {
    const $row = $(row);
    const inputs = $row.find('input[type="radio"]');
    if (inputs.length === 0) return;

    const inputName = $(inputs[0]).attr("name") || "";
    // qid sits at the tail of "ans[WM_ITEM1_..._..._..._QID][ANS01]"
    const qidM = inputName.match(/_(\d+)\]\[ANS\d+\]$/);
    if (!qidM) return;
    const qid = qidM[1];

    // The question prose is in the third <td>. Strip the <ol> options out
    // before reading text so we get the bare question.
    const td = $row.find("td").eq(2);
    const tdHtml = td.html() || "";
    const cleanedHtml = tdHtml.replace(/<ol[\s\S]*?<\/ol>/g, "");
    const text = cheerio
      .load(`<div>${cleanedHtml}</div>`)("div")
      .text()
      .replace(/\s+/g, " ")
      .trim();

    // Options + which one is checked (user's submission)
    const options: string[] = [];
    let pickedIdx: number | null = null;
    td.find("ol li").each((idx, li) => {
      const $li = $(li);
      const optClone = $li.clone();
      optClone.find("input,span").remove();
      const optText = optClone.text().replace(/\s+/g, " ").trim();
      options.push(optText);
      const inp = $li.find('input[type="radio"]').first();
      // cheerio: attribs reflect raw HTML; checked="" / checked / no attr
      const hasChecked = inp.length > 0 && inp.attr("checked") !== undefined;
      if (hasChecked) pickedIdx = idx;
    });

    questions.push({ qid, text, options });
    if (pickedIdx !== null) picks.set(qid, pickedIdx);
  });

  return { score, examTimes, threshold, isReadAnswer, questions, picks, attemptOptions };
}

/**
 * Brute-force the answer key. Each combination is a vector
 * (k_q1, k_q2, …, k_qN) where k_qi is the 0-based option idx that we
 * HYPOTHESISE is correct for question qi. For each combination, predict
 * each attempt's score (10 × number of matches) and compare to observed.
 * Return the combination that perfectly explains every observed score.
 *
 * Optimisation: per-question per-option score-correlation pre-filter. If
 * an option is NEVER picked in any high-scoring attempt and the question
 * has been answered consistently, it's a poor candidate — but we still
 * have to enumerate the rest. With 4^10 = 1M combinations and ~100
 * usable attempts, full enumeration is ~1e8 elementary ops, sub-second.
 */
interface SolveResult {
  /** Per-question best guess. -1 if ambiguous (multiple perfect-match keys disagree). */
  perQuestionGuess: number[];
  /** True if Q is locked-in (all perfect-match keys agree). */
  perQuestionLocked: boolean[];
  perfectCount: number;
  bestSumDiff: number;
}

function solve(
  questions: ExamQuestion[],
  attempts: PastAttempt[],
  log: (m: string) => void,
): SolveResult | null {
  const Q = questions.length;
  if (Q === 0) return null;
  const optCounts = questions.map((q) => q.options.length);
  const totalCombos = optCounts.reduce((a, b) => a * b, 1);
  log(
    `solve: Q=${Q}, opts/q=[${optCounts.join(",")}], 搜尋空間=${totalCombos}; usable attempts=${attempts.filter((a) => a.score !== null && a.picks.size === Q).length}/${attempts.length}`,
  );

  const usable = attempts.filter(
    (a) => a.score !== null && a.picks.size === Q && questions.every((q) => a.picks.has(q.qid)),
  );
  if (usable.length === 0) {
    log("solve: 沒有可用的 attempt 紀錄");
    return null;
  }

  const attemptPicks: number[][] = usable.map((a) =>
    questions.map((q) => a.picks.get(q.qid) ?? -1),
  );
  const attemptScores = usable.map((a) => a.score!);
  const perQ = 100 / Q;

  // Track ALL perfect-match keys, not just the first. Then per-Q look at
  // whether all keys agree on the same option — those Qs are locked. The
  // rest are ambiguous and we leave them for brute-force to nail down
  // (no point saving a guess for those, that just pollutes learned_answers).
  const perfectKeys: number[][] = [];
  let bestSumDiff = Infinity;
  let bestSumDiffKey: number[] | null = null;

  const idx = new Array(Q).fill(0);
  let combos = 0;
  while (true) {
    combos++;
    let allMatch = true;
    let sumDiff = 0;
    for (let ai = 0; ai < usable.length; ai++) {
      let matches = 0;
      const ap = attemptPicks[ai];
      for (let qi = 0; qi < Q; qi++) {
        if (ap[qi] === idx[qi]) matches++;
      }
      const predicted = matches * perQ;
      if (predicted !== attemptScores[ai]) allMatch = false;
      sumDiff += Math.abs(predicted - attemptScores[ai]);
    }
    if (allMatch) perfectKeys.push(idx.slice());
    if (sumDiff < bestSumDiff) {
      bestSumDiff = sumDiff;
      bestSumDiffKey = idx.slice();
    }

    let q = Q - 1;
    while (q >= 0) {
      idx[q]++;
      if (idx[q] < optCounts[q]) break;
      idx[q] = 0;
      q--;
    }
    if (q < 0) break;
  }
  log(`solve: 試了 ${combos} 組合；完美匹配=${perfectKeys.length}，最低誤差 sumDiff=${bestSumDiff}`);

  // No perfect — fall back to min-error and treat all as locked guesses.
  if (perfectKeys.length === 0) {
    if (!bestSumDiffKey) return null;
    log(`solve: 無完美解，使用最小誤差 fallback (sumDiff=${bestSumDiff})；當作全部鎖定`);
    return {
      perQuestionGuess: bestSumDiffKey,
      perQuestionLocked: new Array(Q).fill(true),
      perfectCount: 0,
      bestSumDiff,
    };
  }

  // Per-Q consensus: a Q is "locked" iff ALL perfect-match keys agree on
  // the same option for that Q. Otherwise it's ambiguous.
  const perQuestionGuess = new Array(Q).fill(-1);
  const perQuestionLocked = new Array(Q).fill(false);
  for (let qi = 0; qi < Q; qi++) {
    const candidates = new Set(perfectKeys.map((k) => k[qi]));
    if (candidates.size === 1) {
      perQuestionGuess[qi] = perfectKeys[0][qi];
      perQuestionLocked[qi] = true;
    } else {
      perQuestionGuess[qi] = perfectKeys[0][qi]; // best guess from first key
      perQuestionLocked[qi] = false;
    }
  }
  return { perQuestionGuess, perQuestionLocked, perfectCount: perfectKeys.length, bestSumDiff };
}

export async function solveExamFromHistory(
  session: Session,
  cid: string,
  onProgress: (m: string) => void,
): Promise<{ ok: boolean; learned: number; reason?: string }> {
  const log = (m: string) => onProgress(`[history-solve ${cid}] ${m}`);

  log("setup LC session");
  const setup = await setupLcAndFindLatestEid(session, cid, log);
  if (!setup) return { ok: false, learned: 0, reason: "找不到 viewResult eid（尚未送過任何測驗？）" };
  const { win } = setup;
  const latest = setup;
  const cleanup = () => {
    try { win.destroy(); } catch { /* already destroyed */ }
  };

  // Use the BrowserWindow's frame to fetch each view_result page — same
  // origin / cookies / referer as the LC iframe, so server treats it
  // identically to a normal click. Faster than reloading the frame each
  // time because we just call f.fetch() and pull text.
  const fetchView = async (eid: string): Promise<ParsedView | null> => {
    try {
      const html = await execJs<string | null>(
        win,
        `(async () => {
          try {
            const f = window.frames['s_main'];
            if (!f) return null;
            const r = await f.fetch('/learn/exam/view_result.php?' + ${JSON.stringify(eid)}, { credentials: 'include' });
            if (!r.ok) return null;
            return await r.text();
          } catch (e) { return null; }
        })()`,
      );
      if (!html) return null;
      return parseViewResult(html);
    } catch (e) {
      log(`view_result 失敗 eid=${eid}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  const first = await fetchView(latest.eid);
  if (!first) { cleanup(); return { ok: false, learned: 0, reason: "view_result.php 無法取得" }; }
  log(
    `examTimes=${first.examTimes}, dropdown=${first.attemptOptions.length}，題目=${first.questions.length}, 該次得分=${first.score}, 通過門檻=${first.threshold}, 已查看正解=${first.isReadAnswer}`,
  );
  if (first.questions.length === 0) {
    cleanup();
    return { ok: false, learned: 0, reason: "view_result 解析不出題目（頁面格式可能變了）" };
  }
  if (first.isReadAnswer) {
    log("⚠ isReadAnswer=1（之前已點過公布答案，重考被鎖）— 仍嘗試從歷史推斷正解");
  }

  // Collect all attempts. 200ms gentle delay between fetches; user has 109
  // attempts so this is ~22s. Acceptable.
  const attempts: PastAttempt[] = [];
  const firstNo = first.attemptOptions.find((o) => o.eid === latest.eid)?.no ?? 0;
  attempts.push({ attemptNo: firstNo, eid: latest.eid, score: first.score, picks: first.picks });

  let i = 0;
  for (const opt of first.attemptOptions) {
    if (opt.eid === latest.eid) continue;
    i++;
    if (i % 20 === 0) log(`進度 ${i}/${first.attemptOptions.length - 1}`);
    await new Promise((r) => setTimeout(r, 200));
    const p = await fetchView(opt.eid);
    if (!p) continue;
    attempts.push({ attemptNo: opt.no, eid: opt.eid, score: p.score, picks: p.picks });
  }
  log(`已收集 ${attempts.length} 筆 attempt 紀錄`);

  // Solve
  const result = solve(first.questions, attempts, log);
  if (!result) { cleanup(); return { ok: false, learned: 0, reason: "歷史紀錄無法推斷正解" }; }

  // Wipe any prior history-solve guesses for this course so the previous
  // run's pre-consensus picks don't pollute future lookups. Brute-force /
  // result-page entries (other sources) are left untouched.
  clearLearnedFromSourceForCourse("history-solve", cid);

  // Only persist the LOCKED Qs (those where every perfect-match key
  // agrees). Ambiguous Qs are left out so learned_answers stays trustworthy
  // and brute-force-probe can finish the job with very few attempts.
  let saved = 0;
  let ambiguous = 0;
  for (let qi = 0; qi < first.questions.length; qi++) {
    const q = first.questions[qi];
    const optIdx = result.perQuestionGuess[qi];
    if (optIdx < 0 || optIdx >= q.options.length) continue;
    if (!result.perQuestionLocked[qi]) {
      ambiguous++;
      log(`Q${qi + 1} 模糊（多解中此題未一致），跳過不存`);
      continue;
    }
    saveLearnedAnswer({
      question: q.text,
      answer: q.options[optIdx],
      source: "history-solve",
      confidence: 1.0,
      courseId: cid,
    });
    saved++;
    log(`Q${qi + 1} ✓ opt[${optIdx}] 「${q.options[optIdx].slice(0, 40)}」`);
  }

  log(`鎖定 ${saved} 題，模糊 ${ambiguous} 題（共 ${first.questions.length} 題；perfect-match keys=${result.perfectCount}）`);
  cleanup();
  return { ok: true, learned: saved };
}
