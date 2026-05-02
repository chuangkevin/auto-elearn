import { app } from "electron";
import { existsSync, copyFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { getStorageDir } from "./persist/storage-paths";

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

  const storageDir = getStorageDir();
  mkdirSync(storageDir, { recursive: true });
  const dbPath = join(storageDir, "auto-elearn.db");

  // On first run, seed the 98K questions table from resources/mixed.db.
  // Packaged layout (electron-builder.yml asarUnpack: resources/**/*):
  //   <resources>/app.asar.unpacked/resources/mixed.db   ← real on-disk file
  //   <resources>/app.asar/resources/mixed.db            ← virtual (asar-aware fs)
  // Both copyFileSync from inside asar and reading from the unpacked path work
  // here because Electron patches `fs`. We use the unpacked path so the call
  // matches what `answer-store.ts` does for native sqlite (which is NOT
  // asar-aware) and so the codebase only has one packaged-resource convention.
  if (!existsSync(dbPath)) {
    const seed = app.isPackaged
      ? join(process.resourcesPath, "app.asar.unpacked/resources/mixed.db")
      : join(__dirname, "../../resources/mixed.db");
    if (existsSync(seed)) {
      copyFileSync(seed, dbPath);
      // copyFileSync inherits the source's permission bits — packaged
      // resources are commonly read-only, which makes every learned_answers
      // INSERT throw "attempt to write a readonly database". Force the
      // destination to user-writable so the runtime DB is actually mutable.
      try {
        chmodSync(dbPath, 0o644);
      } catch {
        /* non-fatal: chmod isn't strictly required if the seed was already writable */
      }
      // eslint-disable-next-line no-console
      console.log(`[db] seeded from ${seed}`);
    } else {
      // eslint-disable-next-line no-console
      console.warn(`[db] seed not found at ${seed}; starting empty`);
    }
  } else {
    // Existing DB might already be readonly from an earlier broken seed;
    // self-heal so this version's writes work without manual intervention.
    try {
      chmodSync(dbPath, 0o644);
    } catch {
      /* non-fatal */
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
