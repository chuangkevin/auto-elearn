import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getStorageDir } from "../persist/storage-paths";

/**
 * 把 main process 的 log 同步寫到 userData/logs/main-YYYY-MM-DD.log。
 * 偽裝記事本右鍵的「版本」項點下去就會打開這個資料夾，使用者可以把當天的
 * .log 檔丟給開發者除錯。
 *
 * 設計取捨：
 * - appendFileSync 而非 stream — log 量極低（一秒一兩條），同步寫不會卡，
 *   但好處是 process 突然 crash 時也不會掉最後幾行（buffer 還沒 flush）。
 * - 按日期切檔避免單檔無限長。同一天就 append；跨日就換新檔。
 * - 寫不進去（disk full / 權限怪異）就 silent fallback；絕不能讓 logger
 *   自己拋例外把整個 app 拉下來。
 */

let _logsDir: string | null = null;

/**
 * 回傳 userData/logs/ 的絕對路徑，並保證路徑「目前」存在 — 即使快取過後使用者
 * 手動把資料夾刪掉，下次右鍵「版本」→ shell.openPath 也會自己重建一個空資料夾，
 * 不會跳「位置無法使用」的 File Explorer 錯誤對話框（v0.6.7 災情）。
 */
export function getLogsDir(): string {
  if (!_logsDir) {
    // 優先 userData/logs；但 app 還沒 ready 時 getPath 會丟，此時退回 OS 暫存資料夾。
    // 這條路徑對 module-load 階段就 install 的 crash handler 很關鍵 — 那階段
    // app 尚未 ready，但若沒退路，crash handler 自己就會在寫 log 時拋例外，
    // 把原本想記錄的錯誤吃掉。寫一次 userData 後再切回正規路徑。
    let primary: string | null = null;
    try {
      // app ready 後 getStorageDir 會回傳 portable-mode 資料夾；
      // 早期（app 還沒 ready）storage-paths 內部用到 app.getPath / app.isPackaged
      // 也會炸，這條 try/catch 把它擋掉，讓 crash handler 退回 tmpdir。
      primary = join(getStorageDir(), "logs");
    } catch {
      primary = null;
    }
    _logsDir = primary ?? join(tmpdir(), "auto-elearn-logs");
  }
  // 每次呼叫都做一次 existsSync + mkdir：成本是一次 stat，極低；好處是 logger
  // 可以容錯使用者中途刪資料夾。寫不進去（disk full / 權限怪異）就吃掉，後續
  // appendFileSync 也會自己 catch。
  try {
    if (!existsSync(_logsDir)) mkdirSync(_logsDir, { recursive: true });
  } catch {
    /* 寫不進去就放掉，後續 append 也會被 catch */
  }
  return _logsDir;
}

/**
 * app.whenReady 後呼叫一次，把 log 路徑從暫存目錄切到 portable storage dir/logs/。
 * 早期 install 的 crash handler 在 module-load 階段先寫 tmpdir，避免
 * getStorageDir() 在那時段（app 尚未 ready）拋；ready 之後才能用正式路徑。
 */
export function rebindLogsDirToUserData(): void {
  try {
    _logsDir = join(getStorageDir(), "logs");
    if (!existsSync(_logsDir)) mkdirSync(_logsDir, { recursive: true });
  } catch {
    /* 拿不到就維持原狀 */
  }
}

function todayStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function currentLogFile(): string {
  return join(getLogsDir(), `main-${todayStamp()}.log`);
}

function tsIso(): string {
  return new Date().toISOString();
}

export function appendLogLine(
  level: "info" | "warn" | "error",
  msg: string,
  source: "main" | "renderer" = "main",
): void {
  try {
    const line = `[${tsIso()}] [${level}] [${source}] ${msg}\n`;
    appendFileSync(currentLogFile(), line, "utf8");
  } catch {
    /* 沒寫進去就放掉，不該因為 logger 失敗而崩 app */
  }
}

/**
 * 在 process 真的要死之前，把最後遺言寫進 log。
 * 在 main/index.ts 啟動最早的時候 install 一次。
 */
export function installCrashHandlers(maskMsg: (s: string) => string): void {
  process.on("uncaughtException", (err) => {
    const text = err?.stack ?? String(err);
    appendLogLine("error", maskMsg(`[uncaughtException] ${text}`));
  });
  process.on("unhandledRejection", (reason) => {
    const text =
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    appendLogLine("error", maskMsg(`[unhandledRejection] ${text}`));
  });
}
