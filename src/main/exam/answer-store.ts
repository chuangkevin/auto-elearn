import { app } from "electron";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { getDb } from "../db";

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
  // In packaged mode electron puts resources/ alongside the app
  // In dev mode we can read from the repo's resources/ directly.
  // electron-builder config copies resources/* to the app's resources folder, which
  // is app.getAppPath() + "../" or process.resourcesPath.
  const candidates = [
    path.join(process.resourcesPath ?? "", "mixed.db"),
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
  db.pragma("journal_mode = WAL");
  return db;
}

/**
 * Normalize question text so we can match through whitespace / punctuation variance.
 * Matches the normalization the original decompile uses:
 *   strip spaces, ideographic space, Q-marks, full-width comma.
 */
export function normalizeQuestion(s: string): string {
  if (!s) return "";
  return s
    .replace(/[ \t\r\n]+/g, "")
    .replace(/　/g, "") // 全形空格
    .replace(/[?？]/g, "")
    .replace(/[，]/g, "")
    // the DB itself was normalized the same way by the LIKE clause in the original tool,
    // so mirror it here to maximize hit rate
    .trim();
}

/**
 * Find candidate rows in the DB whose normalized 題目 matches the normalized query.
 * Returns up to `limit` matches. Uses SQLite LIKE with a normalized middle-string.
 */
export function lookupByLike(raw: string, limit = 5): DbRow[] {
  const d = openDb();
  const norm = normalizeQuestion(raw);
  if (!norm) return [];
  // Drop last char(s) to recover from minor trailing differences — try exact first,
  // then a shorter substring if no hits.
  const strategies = [norm, norm.slice(0, Math.max(6, Math.floor(norm.length * 0.9)))];

  for (const s of strategies) {
    const pat = `%${s}%`;
    const stmt = d.prepare(
      `SELECT 題目 AS question, 答案_1 AS correct, 答案_2 AS d2, 答案_3 AS d3, 答案_4 AS d4
       FROM questions
       WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(題目, ' ', ''), '　', ''), '?', ''), '？', ''), '，', '') LIKE ?
       LIMIT ?`,
    );
    const rows = stmt.all(pat, limit) as Array<{
      question: string;
      correct: string;
      d2: string | null;
      d3: string | null;
      d4: string | null;
    }>;
    if (rows.length > 0) {
      return rows.map((r) => ({
        question: r.question,
        correct: r.correct ?? "",
        distractors: [r.d2, r.d3, r.d4].filter((x): x is string => typeof x === "string"),
      }));
    }
  }
  return [];
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Query the writable `learned_answers` table (in userData/auto-elearn.db).
 * Returns the best match or null. Checked before the read-only `questions` bank.
 */
export function lookupLearnedAnswer(raw: string): DbRow | null {
  try {
    const d = getDb();
    const norm = normalizeQuestion(raw);
    if (!norm) return null;
    const NORM_EXPR = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(question,' ',''),'　',''),'?',''),'？',''),'，','')`;
    const row = d
      .prepare(
        `SELECT question, answer AS correct FROM learned_answers
         WHERE ${NORM_EXPR} LIKE ? ORDER BY confidence DESC LIMIT 1`,
      )
      .get(`%${norm}%`) as { question: string; correct: string } | undefined;
    if (!row) return null;
    return { question: row.question, correct: row.correct, distractors: [] };
  } catch {
    return null;
  }
}

export interface SaveAnswerOpts {
  question: string;
  answer: string;
  source: string;
  courseId?: string;
  confidence?: number;
}

/** Persist a newly learned Q&A pair to the writable DB. */
export function saveLearnedAnswer(opts: SaveAnswerOpts): void {
  try {
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO learned_answers
           (question, answer, source, captured_at, course_id, confidence)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.question,
        opts.answer,
        opts.source,
        Date.now(),
        opts.courseId ?? null,
        opts.confidence ?? 1.0,
      );
  } catch {
    /* non-fatal */
  }
}
