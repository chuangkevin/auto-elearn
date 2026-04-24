import { lookupByLike, normalizeQuestion, type DbRow } from "./answer-store";

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
