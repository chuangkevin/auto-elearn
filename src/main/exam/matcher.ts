import { lookupByLike, lookupLearnedAnswer, normalizeQuestion, type DbRow } from "./answer-store";
import { generateText, hasGeminiKey } from "../llm/gemini";

export type AnswerSource = "db" | "fuzzy" | "llm" | "random" | "brute";

export interface MatchResult {
  /** The option text we believe is correct */
  correctText: string;
  /** Which pool we pulled it from */
  source: AnswerSource;
  /** 0-1, 1 = certain */
  confidence: number;
  /** The DB row that matched, if any, for logging */
  dbRow?: DbRow;
}

/**
 * Dice coefficient on bigram sets — cheap and decent for Chinese text.
 * Returns 0..1.
 */
export function diceSimilarity(a: string, b: string): number {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const A = bigrams(a);
  const B = bigrams(b);
  let overlap = 0;
  for (const [g, cA] of A) {
    const cB = B.get(g);
    if (cB) overlap += Math.min(cA, cB);
  }
  const sizeA = Array.from(A.values()).reduce((x, y) => x + y, 0);
  const sizeB = Array.from(B.values()).reduce((x, y) => x + y, 0);
  if (sizeA + sizeB === 0) return 0;
  return (2 * overlap) / (sizeA + sizeB);
}

/**
 * Given the question text, try to find the correct answer in the DB.
 * Returns the best match with a source label + confidence score.
 *
 * Strategy:
 *   1. DB LIKE match — high confidence if question text matches any row closely
 *   2. Fuzzy (Dice bigram) over the LIKE candidates — relax when the raw LIKE
 *      brings back multiple rows (pick the best)
 *   3. Return null to let the caller fall through to LLM / random
 */
export function matchAgainstDb(questionText: string): MatchResult | null {
  const normalized = normalizeQuestion(questionText);
  if (!normalized) return null;

  const candidates = lookupByLike(questionText, 8);
  if (candidates.length === 0) return null;

  // Score each candidate by how closely its question text matches ours.
  let best: { row: DbRow; sim: number } | null = null;
  for (const row of candidates) {
    const sim = diceSimilarity(normalizeQuestion(row.question), normalized);
    if (!best || sim > best.sim) best = { row, sim };
  }
  if (!best) return null;
  // Reject low-similarity hits. With the broadened lookupByLike (mid-window
  // + distinctive-gram OR fallback), we now see more candidates that share
  // domain vocabulary but are genuinely different questions — the floor
  // catches those. 0.25 is the sweet spot empirically: enough to admit
  // paraphrased matches that score 0.30-0.45, strict enough to reject
  // questions that only share a generic stem.
  if (best.sim < 0.25) return null;

  // db: exact / near-exact text match (was 0.85 — but real elearn pages
  // routinely add or trim a leading "下列" / trailing 配分 metadata that
  // drops sim into 0.7x even when DB has the exact same question).
  // fuzzy: 0.25-0.70 — paraphrase / partial overlap; trust the answer but
  // log it under fuzzy so user can see DB recall is engaging.
  const source: AnswerSource = best.sim >= 0.70 ? "db" : "fuzzy";
  return {
    correctText: best.row.correct,
    source,
    confidence: best.sim,
    dbRow: best.row,
  };
}

/**
 * High-confidence cutoff for accepting a DB hit without consulting the LLM.
 * Below this we still keep the DB row as a fallback in case the LLM call
 * fails (no key / quota / network), but we prefer the LLM's pick when it
 * succeeds — the 98K bank ages quickly and a 0.30-0.70 fuzzy match is
 * usually a near-miss on a different question that shares vocabulary.
 */
const LLM_GATE_CONFIDENCE = 0.8;

/**
 * Pipeline: learned_answers → DB (high-conf only) → Gemini LLM → DB (low-conf
 * fallback) → random. Returns the best answer with source label and 0-based
 * option index.
 *
 * `skipMixedDb` skips the read-only 98K bank and goes straight to LLM. The
 * solver flips this on after a retry where mixed.db gave a confidence-1.0
 * wrong answer — staying with the same DB pick would just spin the loop
 * forever. learned_answers is still consulted because it may contain the
 * correct answer we just scraped from the previous attempt's result page.
 */
export async function findBestAnswer(
  questionText: string,
  options: string[],
  opts: { skipMixedDb?: boolean; courseName?: string } = {},
): Promise<{ source: AnswerSource; pickedIdx: number; confidence: number }> {
  // Layer 1: learned_answers (highest priority — we observed this correct before)
  const learned = lookupLearnedAnswer(questionText);
  if (learned) {
    return { source: "db", pickedIdx: pickOptionIndex(learned.correct, options), confidence: 1.0 };
  }

  // Layer 2a: 98K question bank — accept immediately only at high confidence.
  // Below the gate, hold onto the row but try the LLM first since fuzzy
  // 0.25-0.79 matches are frequently the wrong question with overlapping
  // vocabulary (this used to lock answers to bad picks and never let the
  // LLM run, see CLAUDE.md note on v0.7.0).
  let dbFallback: { source: AnswerSource; pickedIdx: number; confidence: number } | null = null;
  if (!opts.skipMixedDb) {
    const dbMatch = matchAgainstDb(questionText);
    if (dbMatch) {
      const pickedIdx = pickOptionIndex(dbMatch.correctText, options);
      if (dbMatch.confidence >= LLM_GATE_CONFIDENCE) {
        return { source: dbMatch.source, pickedIdx, confidence: dbMatch.confidence };
      }
      dbFallback = { source: dbMatch.source, pickedIdx, confidence: dbMatch.confidence };
    }
  }

  // Layer 3: Gemini LLM with course-name context (when available)
  const llmMatch = await matchWithLlm(questionText, options, opts.courseName);
  if (llmMatch) {
    return { source: "llm", pickedIdx: llmMatch.pickedIdx, confidence: llmMatch.confidence };
  }

  // Layer 2b: low-confidence DB fallback — better than coin flip when the
  // LLM is unavailable (no API key) or failed (quota / timeout / parse).
  // Brute-force probe at the runExamLoop level will still correct it if
  // wrong, just like before.
  if (dbFallback) return dbFallback;

  // Random guess as last resort
  return {
    source: "random",
    pickedIdx: Math.floor(Math.random() * Math.max(1, options.length)),
    confidence: 0,
  };
}

/**
 * Ask Gemini to pick the correct option. Returns null if no key, request fails,
 * or confidence too low. `courseName`（若提供）會放進 prompt 當主題提示，讓
 * Gemini 用該課程的領域知識作答 — 這是 v0.7.9 起取代「真的去 web search」
 * 的輕量方案：Gemini 對台灣公務員訓練常見科目（資安、人權、淨零、家庭教育、
 * AI 應用…）的內容掌握度高，給上下文就能顯著拉高命中率，而且不需要
 * Google Search API quota 跟 grounding 配置。
 */
export async function matchWithLlm(
  questionText: string,
  options: string[],
  courseName?: string,
): Promise<{ pickedIdx: number; confidence: number } | null> {
  if (!hasGeminiKey() || options.length === 0) return null;
  const optLines = options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join("\n");
  const courseLine = courseName?.trim()
    ? `\n課程主題：${courseName.trim()}（請依此主題的常識選擇最符合的答案）`
    : "";
  const prompt = `你是台灣公務員訓練題目解題助手。請依該題的領域知識選出正確答案。${courseLine}
題目：${questionText}
選項：
${optLines}
僅回 JSON，格式：{"pick":"A","confidence":0.9} 不要加任何說明或 markdown。`;
  try {
    const raw = await generateText(prompt, { maxOutputTokens: 64, timeoutMs: 12_000 });
    if (!raw) return null;
    const parsed = JSON.parse(raw.replace(/```[a-z]*|```/gi, "").trim()) as {
      pick?: string;
      confidence?: number;
    };
    const letter = (parsed.pick ?? "").toUpperCase();
    const idx = letter.charCodeAt(0) - 65;
    if (idx < 0 || idx >= options.length) return null;
    const confidence = Math.max(0, Math.min(1, parsed.confidence ?? 0.7));
    // 0.4 floor (was 0.5): Gemini self-reports confidence conservatively for
    // multi-step reasoning questions where it's *probably* right but won't
    // claim certainty. Better to take a 0.45-confident pick than fall to
    // pure random; brute-force probe will correct it if wrong.
    if (confidence < 0.4) return null;
    return { pickedIdx: idx, confidence };
  } catch {
    return null;
  }
}

/**
 * Given the correct answer text + the 4 options on the exam page, return the index
 * (0-based) of the option that best matches. Uses exact match first, then Dice.
 */
export function pickOptionIndex(correctText: string, options: string[]): number {
  const normCorrect = correctText.trim();
  // Exact match (trimmed)
  for (let i = 0; i < options.length; i++) {
    if (options[i].trim() === normCorrect) return i;
  }
  // Prefix / contains match
  for (let i = 0; i < options.length; i++) {
    if (options[i].includes(normCorrect) || normCorrect.includes(options[i])) return i;
  }
  // Fuzzy fallback
  let bestIdx = 0;
  let bestSim = -1;
  for (let i = 0; i < options.length; i++) {
    const s = diceSimilarity(options[i], normCorrect);
    if (s > bestSim) {
      bestSim = s;
      bestIdx = i;
    }
  }
  return bestIdx;
}
