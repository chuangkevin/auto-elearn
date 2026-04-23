import { app } from "electron";
import { existsSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS learned_answers (
    question TEXT PRIMARY KEY,
    answer TEXT NOT NULL,
    source TEXT NOT NULL,
    captured_at INTEGER NOT NULL,
    course_id TEXT,
    confidence REAL DEFAULT 1.0
  );`,
  `CREATE TABLE IF NOT EXISTS reflections (
    course_id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    generated_at INTEGER NOT NULL,
    source TEXT NOT NULL  -- 'llm' | 'template' | 'user'
  );`,
  `CREATE TABLE IF NOT EXISTS run_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    courses_done INTEGER DEFAULT 0,
    quizzes_pass INTEGER DEFAULT 0,
    llm_calls INTEGER DEFAULT 0,
    notes TEXT
  );`,
];

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const userDataDir = app.getPath("userData");
  mkdirSync(userDataDir, { recursive: true });
  const dbPath = join(userDataDir, "auto-elearn.db");

  // On first run, seed the 98K questions table from resources/mixed.db
  if (!existsSync(dbPath)) {
    const seed = app.isPackaged
      ? join(process.resourcesPath, "mixed.db")
      : join(__dirname, "../../resources/mixed.db");
    if (existsSync(seed)) {
      copyFileSync(seed, dbPath);
      // eslint-disable-next-line no-console
      console.log(`[db] seeded from ${seed}`);
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[db] seed not found at ${seed}; starting empty`);
    }
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  for (const sql of MIGRATIONS) db.exec(sql);
  _db = db;
  return db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}
