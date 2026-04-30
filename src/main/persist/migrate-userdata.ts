import { app } from "electron";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * v0.5.x → v0.6.x 升級遷移：
 *
 * v0.6.0 把 electron-builder.yml 的 productName 從 auto-elearn 改成 Noteqad。
 * Electron 的 app.getPath("userData") 因此從
 *   %APPDATA%\auto-elearn\
 * 換成
 *   %APPDATA%\Noteqad\
 *
 * 結果：升級的舊使用者打開 v0.6.0 像第一次跑 — 帳密不見、學過的答案不見、
 * 偽裝密碼不見。這個 module 就是負責補洞：啟動最早的階段把舊路徑下我們
 * 在乎的檔複製到新路徑，然後寫一個 .migrated 標記檔避免重複跑。
 *
 * 不直接整顆 oldDir 拷貝是因為 Electron 的 Cache/ GPUCache/ Local Storage/
 * 那些是 session 級檔案，留在舊路徑被新 session rebuild 沒事，硬拷反而可能
 * 把舊版的奇怪 cache 搬過來。所以走白名單。
 */

const FILES_TO_MIGRATE = [
  "credentials.bin",   // 加密過的帳密
  "auto-elearn.db",    // SQLite：學過的答案 + 內建題庫
  "config.json",       // Gemini key + 偽裝密碼
  ".first-run-acked",  // SmartScreen 說明已讀旗標
  "run-state.json",    // 上次未跑完的 pipeline 狀態
] as const;

export interface MigrationResult {
  /** 沒舊路徑或本來就遷移過了 → null */
  ranThisLaunch: boolean;
  oldDir: string;
  newDir: string;
  migrated: string[];
  skippedAlreadyExists: string[];
  failed: Array<{ file: string; reason: string }>;
}

function sentinelPath(newDir: string): string {
  return join(newDir, ".migrated-from-auto-elearn");
}

/**
 * 啟動最早的階段呼叫一次。`app` 必須已經 ready 才能拿到正確的 userData 路徑。
 * 安全冪等：跑兩次第二次什麼事都不做。
 */
export function migrateFromOldUserDataIfNeeded(): MigrationResult {
  const newDir = app.getPath("userData");
  // 同一台機器上 %APPDATA% 共用，舊版的 productName 是 "auto-elearn"，
  // 所以舊資料夾跟新資料夾是 sibling。
  const oldDir = join(dirname(newDir), "auto-elearn");

  const result: MigrationResult = {
    ranThisLaunch: false,
    oldDir,
    newDir,
    migrated: [],
    skippedAlreadyExists: [],
    failed: [],
  };

  // 已經跑過 → 直接 return，不重複工作
  if (existsSync(sentinelPath(newDir))) {
    return result;
  }

  // package.json 的 `name` 仍然是 "auto-elearn"（electron-builder.yml 的 productName
  // 只影響 .exe 檔名 / 視窗 metadata，沒影響 app.getName）。所以 newDir == oldDir，
  // 沒事可遷 — 直接寫 sentinel 結束。
  if (newDir === oldDir) {
    try {
      if (!existsSync(newDir)) mkdirSync(newDir, { recursive: true });
      writeFileSync(
        sentinelPath(newDir),
        JSON.stringify({ at: new Date().toISOString(), reason: "newDir==oldDir" }),
        "utf8",
      );
    } catch {
      /* 寫不進就算了 */
    }
    return result;
  }

  // 沒舊資料夾 → 寫個空 sentinel 表示「我看過了沒東西要遷」，下次省 stat
  if (!existsSync(oldDir)) {
    try {
      if (!existsSync(newDir)) mkdirSync(newDir, { recursive: true });
      writeFileSync(
        sentinelPath(newDir),
        JSON.stringify({ at: new Date().toISOString(), reason: "no old dir" }),
        "utf8",
      );
    } catch {
      /* 寫不進去就算了，下次再來一次也只是 stat 一下 */
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
      // 使用者已經在 v0.6.0 上動過 — 不蓋掉新狀態，避免把使用者剛存的新帳密
      // 蓋成舊的。
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

  // 寫 sentinel 表示「這次完成」。即使有檔案 fail 也照寫 — 真的失敗了重跑也救
  // 不回來，使用者該手動處理；不然每次啟動都重試只會卡更慢。
  try {
    writeFileSync(
      sentinelPath(newDir),
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
    /* 連 sentinel 都寫不出來就放著，下次會重跑 — copyFileSync 已經有檢查
       目標存在會 skip，不會 corrupt 資料 */
  }

  return result;
}
