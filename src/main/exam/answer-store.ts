import { app } from "electron";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { getDb } from "../db";

/**
 * Source priority — higher number wins. New writes only `INSERT OR REPLACE`
 * if their priority >= the existing row's priority. This stops brute-force
 * probes (priority 1) from clobbering web-prefetch ground truth (priority 10).
 *
 * Keep in sync with the ORDER BY CASE in lookupLearnedAnswer.
 */
const SOURCE_PRIORITY: Record<string, number> = {
  "web-prefetch": 10,
  "history-solve": 8,
  "perfect-attempt": 7,
  llm: 5,
  db: 4,
  fuzzy: 3,
  "result-page": 2,
  brute: 1,
  random: 0,
};

function sourcePriority(s: string): number {
  return SOURCE_PRIORITY[s] ?? 0;
}

/**
 * Answer-store wraps `resources/mixed.db`, the 98,569-row question bank decompiled
 * from 原 E等閱讀家. Schema: single `questions` table with
 *   題目 TEXT, 答案_1 TEXT, 答案_2 TEXT, 答案_3 TEXT, 答案_4 TEXT
 * where 答案_1 is the correct answer and 答案_2..4 are distractors.
 */

export interface DbRow {
  question: string;
  correct: string;
  distractors: string[];
}

let db: Database.Database | null = null;

function locateDb(): string {
  // electron-builder.yml bundles resources/ inside app.asar with
  // `asarUnpack: resources/**/*`, so the on-disk path is
  //   <resources>/app.asar.unpacked/resources/mixed.db
  // better-sqlite3 is a native module — it does NOT go through Electron's
  // asar-aware fs shim, so we MUST point it at the real unpacked file, not at
  // a virtual app.asar/... path. The other entries below are kept as
  // fallbacks for dev and for legacy layouts.
  const candidates = [
    path.join(process.resourcesPath ?? "", "app.asar.unpacked", "resources", "mixed.db"),
    path.join(process.resourcesPath ?? "", "resources", "mixed.db"),
    path.join(app.getAppPath(), "resources", "mixed.db"),
    // dev fallback — running from repo root
    path.resolve(process.cwd(), "resources", "mixed.db"),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  throw new Error(`mixed.db not found in any of: ${candidates.join(", ")}`);
}

function openDb(): Database.Database {
  if (db) return db;
  const file = locateDb();
  db = new Database(file, { readonly: true, fileMustExist: true });
  // `journal_mode = WAL` writes to the DB file header — fatal on a readonly
  // open. Earlier code called this unconditionally; the resulting throw
  // bubbled all the way up through lookupByLike → matcher → solver and
  // landed in result.error as "attempt to write a readonly database",
  // killing exams that would otherwise have worked. WAL is irrelevant for
  // a readonly connection anyway, so just skip it (or wrap if for some
  // reason we want to attempt it on writable DBs in the future).
  return db;
}

/**
 * Normalize question text so we can match through whitespace / punctuation
 * AND elearn-injected chrome (per-question 配分 prefix, leading numbering).
 *
 * Why both: extractQuestions on the exam page reads a row that contains
 * `<td>配分：[10.00]</td><td>1. <p>下列...</p></td>` so its textContent is
 *   "配分：[10.00] 1. 下列..."
 * but extractResultAnswers / history-solver's parser only takes the third
 * `<td>` so it stores
 *   "1. 下列..."
 * Without stripping these prefixes here, save/lookup keys diverge and
 * learned_answers entries written by history-solve are silently invisible
 * at exam time.
 */
export function normalizeQuestion(s: string): string {
  if (!s) return "";
  return s
    .replace(/[ \t\r\n]+/g, "")
    .replace(/　/g, "") // 全形空格
    .replace(/[?？]/g, "")
    .replace(/[，]/g, "")
    // strip elearn's question-row chrome: optional "單選/複選/多選" qualifier
    // followed by "配分：[10.00]" / "配分:[75]" (full-width or ascii colon).
    // Real exam pages render "單選配分：[10.00]"; view_result.php renders
    // just "配分：[10.00]" — the optional [單複多選]{0,4} prefix covers
    // every variant we've seen.
    .replace(/^[單複多選]{0,4}配分[:：]?\[\d+(?:\.\d+)?\]/, "")
    // strip leading question numbering: "1." / "12." / "Q3." / "第3題"
    .replace(/^[第Q]?\d{1,3}[.、題)]?/, "")
    .trim();
}

/**
 * Find candidate rows in the DB whose normalized 題目 matches the normalized query.
 * Returns up to `limit` matches.
 *
 * Strategy progression (each only fires if the previous yielded zero):
 *   1. full normalized text — exact-prefix-style hit
 *   2. 90% prefix — minor trailing differences
 *   3. mid-window scan — three 8-char windows from 25%/50%/75% of the question;
 *      catches paraphrases where the prefix differs but body keywords overlap.
 *      Earlier code only tried the first 12 chars which fails on rewordings
 *      that change the lead-in (e.g. "下列關於X..." vs "X的描述...").
 *   4. distinctive 4-gram OR — last-resort token search. We pull the rarest
 *      4-grams (skipping generic ones like "下列何者") and OR them in a single
 *      LIKE chain. Matcher.matchAgainstDb's dice floor still gates noise out.
 */
const NORM_EXPR = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(題目, ' ', ''), '　', ''), '?', ''), '？', ''), '，', '')`;

/** Same normalization expression for the `learned_answers` table (column: `question`). */
const LEARNED_NORM_EXPR = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(question,' ',''),'　',''),'?',''),'？',''),'，','')`;

const GENERIC_GRAMS = new Set([
  "下列何", "列何者", "何者正", "何者錯", "何者非", "何者為", "下列關",
  "列關於", "關於下", "為下列", "下列敘", "下列描", "下列選", "依據下",
  "請問下", "請選出", "選出下", "正確的", "錯誤的", "為何者", "者正確",
  "者錯誤", "者非為", "下列哪",
]);

function distinctiveGrams(s: string, n = 4, k = 3): string[] {
  if (s.length < n) return [];
  const grams = new Set<string>();
  for (let i = 0; i + n <= s.length; i++) {
    const g = s.slice(i, i + n);
    if (!GENERIC_GRAMS.has(g)) grams.add(g);
  }
  // Spread picks across the question so we don't take 3 adjacent grams.
  const list = Array.from(grams);
  if (list.length <= k) return list;
  const stride = Math.floor(list.length / k);
  return Array.from({ length: k }, (_, i) => list[Math.min(i * stride, list.length - 1)]);
}

export function lookupByLike(raw: string, limit = 8): DbRow[] {
  const d = openDb();
  const norm = normalizeQuestion(raw);
  if (!norm) return [];

  const runQuery = (sql: string, params: unknown[]): DbRow[] => {
    const stmt = d.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      question: string;
      correct: string;
      d2: string | null;
      d3: string | null;
      d4: string | null;
    }>;
    return rows.map((r) => ({
      question: r.question,
      correct: r.correct ?? "",
      distractors: [r.d2, r.d3, r.d4].filter((x): x is string => typeof x === "string"),
    }));
  };

  // Strategies 1-3: single-LIKE prefix/mid windows.
  const singleStrategies: string[] = [];
  singleStrategies.push(norm);
  const ninetyPct = norm.slice(0, Math.max(6, Math.floor(norm.length * 0.9)));
  if (ninetyPct !== norm) singleStrategies.push(ninetyPct);
  if (norm.length >= 16) {
    for (const frac of [0.25, 0.5, 0.75]) {
      const start = Math.min(norm.length - 8, Math.floor(norm.length * frac));
      singleStrategies.push(norm.slice(start, start + 8));
    }
  } else if (norm.length > 8) {
    singleStrategies.push(norm.slice(0, 8));
  }

  for (const s of singleStrategies) {
    if (s.length < 4) continue;
    const rows = runQuery(
      `SELECT 題目 AS question, 答案_1 AS correct, 答案_2 AS d2, 答案_3 AS d3, 答案_4 AS d4
       FROM questions WHERE ${NORM_EXPR} LIKE ? LIMIT ?`,
      [`%${s}%`, limit],
    );
    if (rows.length > 0) return rows;
  }

  // Strategy 4: distinctive-gram OR fallback. Catches paraphrases where no
  // single contiguous window survives but rare phrases do.
  const grams = distinctiveGrams(norm, 4, 3);
  if (grams.length >= 2) {
    const conds = grams.map(() => `${NORM_EXPR} LIKE ?`).join(" OR ");
    const params = [...grams.map((g) => `%${g}%`), limit];
    const rows = runQuery(
      `SELECT 題目 AS question, 答案_1 AS correct, 答案_2 AS d2, 答案_3 AS d3, 答案_4 AS d4
       FROM questions WHERE ${conds} LIMIT ?`,
      params,
    );
    if (rows.length > 0) return rows;
  }

  return [];
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export interface LearnedAnswerRow {
  question: string;
  answers: string[];
  source: string;
  confidence: number;
}

/**
 * Query the writable `learned_answers` table (in userData/auto-elearn.db).
 * Returns the highest-priority row for the question, decoded into
 * `answers: string[]` (single-element for single-select, multi for
 * multi-select). Older rows that are plain strings are auto-promoted to
 * single-element arrays via `decodeAnswers`.
 */
export function lookupLearnedAnswer(raw: string): LearnedAnswerRow | null {
  try {
    const d = getDb();
    const norm = normalizeQuestion(raw);
    if (!norm) return null;
    // Source priority — higher number wins. web-prefetch (10) is ground
    // truth from rodiyer.idv.tw; brute (1) is a score-delta probe that's
    // often wrong on randomly-sampled exams. See spec §"Source priority".
    const row = d
      .prepare(
        `SELECT question, answer, source, confidence FROM learned_answers
         WHERE ${LEARNED_NORM_EXPR} LIKE ?
         ORDER BY
           CASE source
             WHEN 'web-prefetch'    THEN 10
             WHEN 'history-solve'   THEN 8
             WHEN 'perfect-attempt' THEN 7
             WHEN 'llm'             THEN 5
             WHEN 'db'              THEN 4
             WHEN 'fuzzy'           THEN 3
             WHEN 'result-page'     THEN 2
             WHEN 'brute'           THEN 1
             ELSE 0
           END DESC,
           captured_at DESC,
           confidence DESC
         LIMIT 1`,
      )
      .get(`%${norm}%`) as
      | { question: string; answer: string; source: string; confidence: number }
      | undefined;
    if (!row) return null;
    return {
      question: row.question,
      answers: decodeAnswers(row.answer),
      source: row.source,
      confidence: row.confidence ?? 1.0,
    };
  } catch {
    return null;
  }
}

export interface SaveAnswerOpts {
  question: string;
  /** Length 1 for single-select; >=1 for multi-select. */
  answers: string[];
  source: string;
  courseId?: string;
  confidence?: number;
}

/** Wipe all entries from a specific source+course pair. Used by
 *  history-solve to clear last run's tentative guesses before saving the
 *  new (more confident) consensus picks. */
export function clearLearnedFromSourceForCourse(source: string, courseId: string): void {
  try {
    getDb()
      .prepare(`DELETE FROM learned_answers WHERE source = ? AND course_id = ?`)
      .run(source, courseId);
  } catch {
    /* non-fatal */
  }
}

/** Wipe all entries for a course regardless of source. Used by
 *  history-solve when it's about to overwrite with the most authoritative
 *  data (mathematically derived from past attempts), so leftover buggy
 *  rows from earlier parser versions can't ghost-block the new picks. */
export function clearAllLearnedForCourse(courseId: string): void {
  try {
    getDb()
      .prepare(`DELETE FROM learned_answers WHERE course_id = ?`)
      .run(courseId);
  } catch {
    /* non-fatal */
  }
}

/** Persist a newly learned Q&A pair to the writable DB. */
export function saveLearnedAnswer(opts: SaveAnswerOpts): void {
  if (!opts.answers || opts.answers.length === 0) return;
  const payload = JSON.stringify(opts.answers);
  try {
    const d = getDb();

    // Priority gate: don't overwrite a higher-priority answer with a
    // lower-priority probe. Equal priority is allowed (re-affirms or
    // updates the answers list, e.g. brute → brute on a different option).
    //
    // Match against normalized question (not raw) because callers write
    // raw question strings with different framing prefixes (solver includes
    // "單選配分：[10.00] 1." chrome, history-solver strips it, web-bank
    // has no chrome at all). Without normalization, the gate exact-match
    // would miss rows for the same logical question and let a lower-priority
    // source insert a duplicate alongside the higher-priority one.
    const norm = normalizeQuestion(opts.question);
    const existing = norm
      ? (d
          .prepare(
            `SELECT source FROM learned_answers
             WHERE ${LEARNED_NORM_EXPR} LIKE ?
             ORDER BY
               CASE source
                 WHEN 'web-prefetch'    THEN 10
                 WHEN 'history-solve'   THEN 8
                 WHEN 'perfect-attempt' THEN 7
                 WHEN 'llm'             THEN 5
                 WHEN 'db'              THEN 4
                 WHEN 'fuzzy'           THEN 3
                 WHEN 'result-page'     THEN 2
                 WHEN 'brute'           THEN 1
                 ELSE 0
               END DESC
             LIMIT 1`,
          )
          .get(`%${norm}%`) as { source: string } | undefined)
      : undefined;
    if (existing && sourcePriority(opts.source) < sourcePriority(existing.source)) {
      return;
    }

    d.prepare(
      `INSERT OR REPLACE INTO learned_answers
         (question, answer, source, captured_at, course_id, confidence)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.question,
      payload,
      opts.source,
      Date.now(),
      opts.courseId ?? null,
      opts.confidence ?? 1.0,
    );
  } catch {
    /* non-fatal */
  }
}

/**
 * Decode the `answer` column. v0.8.13+ stores JSON arrays
 * (`["選項A","選項B"]`); legacy rows from earlier versions are plain strings
 * (`"選項A"`). On JSON.parse failure or non-array result, fall back to a
 * single-element array containing the raw text.
 */
export function decodeAnswers(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  return [raw];
}
