import { app } from "electron";
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getStorageDir, storagePath } from "../persist/storage-paths";
import { listAccounts } from "../account/storage";

const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_RETENTION_MS = 14 * DAY_MS;
const TEMP_RETENTION_MS = 7 * DAY_MS;
const RUN_STATE_RETENTION_MS = 7 * DAY_MS;

const TEMP_FILE_PATTERNS = [
  /^auto-elearn-info-.*\.html$/i,
  /^auto-elearn-result-.*\.html$/i,
  /^auto-elearn-exam-row\.html$/i,
  /^auto-elearn-actid-.*\.json$/i,
  /^auto-elearn-noactid-.*\.json$/i,
  /^auto-elearn-web-bank-parse\.txt$/i,
  /^auto-elearn-diag-.*\.txt$/i,
];

const DEBUG_HISTORY_DIR = "D:/tmp";
const DEBUG_HISTORY_PATTERN = /^auto-elearn-history-.*$/i;
const ACCOUNT_RUN_FILE_RE = /^([a-f0-9]{12})\.run\.json$/i;

export interface PurgeReport {
  logsDeleted: number;
  tempDeleted: number;
  debugHistoryDeleted: number;
  runStateDeleted: number;
  errors: string[];
}

function deleteIfExists(filePath: string, errors: string[]): boolean {
  try {
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
    return true;
  } catch (e) {
    errors.push(`${filePath}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

function collectOldFiles(
  dir: string,
  matcher: (name: string) => boolean,
  olderThanMs: number,
): string[] {
  if (!existsSync(dir)) return [];
  const cutoff = Date.now() - olderThanMs;
  const out: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!matcher(entry.name)) continue;
      const full = join(dir, entry.name);
      try {
        const stat = statSync(full);
        if (stat.mtimeMs <= cutoff) out.push(full);
      } catch {
        /* skip unreadable entry */
      }
    }
  } catch {
    return [];
  }
  return out;
}

function purgeLogs(errors: string[]): number {
  const logDir = join(getStorageDir(), "logs");
  const files = collectOldFiles(logDir, (name) => /^main-\d{4}-\d{2}-\d{2}\.log$/i.test(name), LOG_RETENTION_MS);
  let deleted = 0;
  for (const file of files) {
    if (deleteIfExists(file, errors)) deleted++;
  }
  return deleted;
}

function purgeTempDumps(errors: string[]): number {
  const tempDir = app.getPath("temp");
  const files = collectOldFiles(
    tempDir,
    (name) => TEMP_FILE_PATTERNS.some((re) => re.test(name)),
    TEMP_RETENTION_MS,
  );
  let deleted = 0;
  for (const file of files) {
    if (deleteIfExists(file, errors)) deleted++;
  }
  return deleted;
}

function purgeDebugHistoryDumps(errors: string[]): number {
  const files = collectOldFiles(DEBUG_HISTORY_DIR, (name) => DEBUG_HISTORY_PATTERN.test(name), TEMP_RETENTION_MS);
  let deleted = 0;
  for (const file of files) {
    if (deleteIfExists(file, errors)) deleted++;
  }
  return deleted;
}

function purgeRunStateFiles(errors: string[]): number {
  const validIds = new Set(listAccounts().map((a) => a.id));
  const accountsDir = storagePath("accounts");
  let deleted = 0;

  if (existsSync(accountsDir)) {
    try {
      for (const entry of readdirSync(accountsDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const m = entry.name.match(ACCOUNT_RUN_FILE_RE);
        if (!m) continue;
        const full = join(accountsDir, entry.name);
        const accountId = m[1].toLowerCase();
        const isOrphan = !validIds.has(accountId);
        let isOld = false;
        try {
          isOld = statSync(full).mtimeMs <= Date.now() - RUN_STATE_RETENTION_MS;
        } catch {
          isOld = false;
        }
        if ((isOrphan || isOld) && deleteIfExists(full, errors)) deleted++;
      }
    } catch (e) {
      errors.push(`${accountsDir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const legacyRunState = storagePath("run-state.json");
  try {
    if (existsSync(legacyRunState)) {
      const isOld = statSync(legacyRunState).mtimeMs <= Date.now() - RUN_STATE_RETENTION_MS;
      if (isOld && deleteIfExists(legacyRunState, errors)) deleted++;
    }
  } catch (e) {
    errors.push(`${legacyRunState}: ${e instanceof Error ? e.message : String(e)}`);
  }

  return deleted;
}

export function runPurge(): PurgeReport {
  const errors: string[] = [];
  return {
    logsDeleted: purgeLogs(errors),
    tempDeleted: purgeTempDumps(errors),
    debugHistoryDeleted: purgeDebugHistoryDumps(errors),
    runStateDeleted: purgeRunStateFiles(errors),
    errors,
  };
}

export function msUntilNextMidnight(now = new Date()): number {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return Math.max(1000, next.getTime() - now.getTime());
}
