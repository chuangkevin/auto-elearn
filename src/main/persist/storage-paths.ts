/**
 * Portable-mode storage paths.
 *
 * v0.7.9 起，所有可寫資料（帳密、SQLite、config.json、run-state.json、
 * .first-run-acked、logs/）改成跟 .exe 同一個資料夾。理由：
 *  - 使用者把 portable .exe 換到別的資料夾或備份整包到 USB 都會把資料一起帶走
 *  - 不再受 %APPDATA% 路徑變動（Windows 帳號重灌、productName 改名）影響
 *  - 想刪資料 = 把那個資料夾 zip 起來；想搬到別台電腦 = 整包搬
 *
 * 路徑解析優先順序：
 *  1. PORTABLE_EXECUTABLE_DIR  — electron-builder portable target 啟動時設置，
 *     是「使用者執行 .exe 的真實位置」（自解壓 7z 暫存目錄會被清，這個才永續）
 *  2. app.isPackaged && process.execPath 的 dirname  — 一般 packaged 安裝模式
 *  3. dev 模式  — 退回 app.getPath("userData")，免得污染專案原始碼資料夾
 *
 * 包成「auto-elearn-data」子資料夾：使用者只看到 .exe 旁邊一個資料夾名稱
 * 直白，不會被誤刪「.first-run-acked」這種隱藏檔。
 */

import { app } from "electron";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const DATA_DIR_NAME = "auto-elearn-data";

let _cachedDir: string | null = null;

export function getStorageDir(): string {
  if (_cachedDir) return _cachedDir;

  let baseDir: string;
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir && existsSync(portableDir)) {
    // electron-builder portable build：使用者實際擺放 .exe 的位置
    baseDir = portableDir;
  } else if (app.isPackaged) {
    // 一般 packaged 安裝模式：.exe 所在資料夾
    baseDir = dirname(process.execPath);
  } else {
    // dev 模式：保留 userData，避免污染 source tree
    baseDir = app.getPath("userData");
  }

  // dev 模式下 baseDir 本身就是 userData，不要再加 auto-elearn-data 子資料夾
  // —— 否則跟 v0.7.8 之前的 dev 環境路徑不一致，舊資料看不到。
  const dir = app.isPackaged ? join(baseDir, DATA_DIR_NAME) : baseDir;

  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    /* 寫不進去就讓 caller 自己處理 — 這裡 throw 會讓整個 app 啟動 crash */
  }

  _cachedDir = dir;
  return dir;
}

/** 強制重新計算（測試用 / migration 完成後可用）。一般情況不需要呼叫。 */
export function _resetStorageDirCache(): void {
  _cachedDir = null;
}

export function storagePath(...parts: string[]): string {
  return join(getStorageDir(), ...parts);
}
