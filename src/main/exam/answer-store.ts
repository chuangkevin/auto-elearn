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
    // strip "配分：[10.00]" / "配分:[75]" from the head (full-width or ascii colon)
    .replace(/^配分[:：]?\[\d+(?:\.\d+)?\]/, "")
    // strip leading question numbering: "1." / "12." / "Q3." / "第3題"
    .replace(/^[第Q]?\d{1,3}[.、題)]?/, "")
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
