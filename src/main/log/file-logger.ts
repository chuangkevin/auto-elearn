import { app } from "electron";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

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

export function getLogsDir(): string {
  if (_logsDir) return _logsDir;
  _logsDir = join(app.getPath("userData"), "logs");
  try {
    if (!existsSync(_logsDir)) mkdirSync(_logsDir, { recursive: true });
  } catch {
    /* 寫不進去就算了，下面 append 也會吃掉 throw */
  }
  return _logsDir;
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
