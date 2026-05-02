/**
 * v0.7.8 → v0.7.9 升級遷移：把 %APPDATA%/Noteqad/ 下的可寫資料搬到
 * portable storage dir（.exe 旁邊的 auto-elearn-data/）。
 *
 * 為什麼要遷：v0.7.8 之前所有資料寫在 Electron 的 userData，路徑跟著 OS 跑；
 * 使用者把 .exe 換到別的資料夾、備份到 USB、或重灌 Windows，資料都會「不見」。
 * v0.7.9 改成 portable，但已經升級上來的舊使用者要把舊路徑的資料保留下來，
 * 不能讓他覺得「換了版本帳密都沒了」。
 *
 * 邏輯：portable storage dir 沒寫過 sentinel + 舊 userData 有資料 → 複製，
 * 寫 sentinel；以後不再跑。複製失敗的個別檔不算致命，繼續 — sentinel 仍寫，
 * 不然每次啟動都重試只會慢更多。
 */

import { app } from "electron";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getStorageDir } from "./storage-paths";

const FILES_TO_MIGRATE = [
  "credentials.bin",
  "auto-elearn.db",
  "config.json",
  ".first-run-acked",
  "run-state.json",
] as const;

const SENTINEL = ".portable-migrated";

export interface PortableMigrationResult {
  ranThisLaunch: boolean;
  oldDir: string;
  newDir: string;
  migrated: string[];
  skippedAlreadyExists: string[];
  failed: Array<{ file: string; reason: string }>;
}

export function migrateUserDataToPortableIfNeeded(): PortableMigrationResult {
  const newDir = getStorageDir();
  const oldDir = app.getPath("userData");

  const result: PortableMigrationResult = {
    ranThisLaunch: false,
    oldDir,
    newDir,
    migrated: [],
    skippedAlreadyExists: [],
    failed: [],
  };

  // dev / 非 packaged 模式下 newDir === oldDir → 不需要搬
  if (newDir === oldDir) {
    return result;
  }

  const sentinelPath = join(newDir, SENTINEL);
  if (existsSync(sentinelPath)) {
    return result;
  }

  // 沒舊 userData → 寫 sentinel 結束（避免每次啟動都 stat）
  if (!existsSync(oldDir)) {
    try {
      if (!existsSync(newDir)) mkdirSync(newDir, { recursive: true });
      writeFileSync(
        sentinelPath,
        JSON.stringify({ at: new Date().toISOString(), reason: "no old userData" }),
        "utf8",
      );
    } catch {
      /* 寫不進就放著，下次再 stat 一次也只是輕量檢查 */
    }
    return result;
  }

  result.ranThisLaunch = true;

  try {
    if (!existsSync(newDir)) mkdirSync(newDir, { recursive: true });
  } catch (e) {
    result.failed.push({
      file: "(mkdir newDir)",
      reason: e instanceof Error ? e.message : String(e),
    });
    return result;
  }

  for (const name of FILES_TO_MIGRATE) {
    const src = join(oldDir, name);
    const dst = join(newDir, name);
    if (!existsSync(src)) continue;
    if (existsSync(dst)) {
      // 新位置已經有檔（使用者在 portable 模式下已經操作過）→ 不蓋掉
      result.skippedAlreadyExists.push(name);
      continue;
    }
    try {
      copyFileSync(src, dst);
      result.migrated.push(name);
    } catch (e) {
      result.failed.push({
        file: name,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  try {
    writeFileSync(
      sentinelPath,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          migrated: result.migrated,
          skippedAlreadyExists: result.skippedAlreadyExists,
          failed: result.failed,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    /* 連 sentinel 都寫不進去就放著，下次重跑 — copyFileSync 已經有
       「目標存在 skip」的保護，不會 corrupt 資料 */
  }

  return result;
}
