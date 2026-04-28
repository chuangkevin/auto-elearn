import { lookupByLike, lookupLearnedAnswer, normalizeQuestion, type DbRow } from "./answer-store";
import { generateText, hasGeminiKey } from "../llm/gemini";

export type AnswerSource = "db" | "fuzzy" | "llm" | "random";

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

  const source: AnswerSource = best.sim >= 0.85 ? "db" : "fuzzy";
  return {
    correctText: best.row.correct,
    source,
    confidence: best.sim,
    dbRow: best.row,
  };
}

/**
 * Three-layer async answer lookup: learned_answers → questions DB → Gemini LLM.
 * Returns the best answer with source label and 0-based option index.
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
  opts: { skipMixedDb?: boolean } = {},
): Promise<{ source: AnswerSource; pickedIdx: number; confidence: number }> {
  // Layer 1: learned_answers (highest priority — we observed this correct before)
  const learned = lookupLearnedAnswer(questionText);
  if (learned) {
    return { source: "db", pickedIdx: pickOptionIndex(learned.correct, options), confidence: 1.0 };
  }

  // Layer 2: 98K question bank (exact then fuzzy) — skipped on forced-LLM retries
  if (!opts.skipMixedDb) {
    const dbMatch = matchAgainstDb(questionText);
    if (dbMatch) {
      return {
        source: dbMatch.source,
        pickedIdx: pickOptionIndex(dbMatch.correctText, options),
        confidence: dbMatch.confidence,
      };
    }
  }

  // Layer 3: Gemini LLM fallback
  const llmMatch = await matchWithLlm(questionText, options);
  if (llmMatch) {
    return { source: "llm", pickedIdx: llmMatch.pickedIdx, confidence: llmMatch.confidence };
  }

  // Random guess as last resort
  return {
    source: "random",
    pickedIdx: Math.floor(Math.random() * Math.max(1, options.length)),
    confidence: 0,
  };
}

/**
 * Ask Gemini to pick the correct option. Returns null if no key, request fails,
 * or confidence too low.
 */
export async function matchWithLlm(
  questionText: string,
  options: string[],
): Promise<{ pickedIdx: number; confidence: number } | null> {
  if (!hasGeminiKey() || options.length === 0) return null;
  const optLines = options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join("\n");
  const prompt = `你是台灣公務員訓練題目解題助手。請從以下選項挑出正確答案。
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
    if (confidence < 0.5) return null;
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
