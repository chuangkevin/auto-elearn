import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

/**
 * 把 renderer 端的錯誤都 forward 給 main process，由 main 寫進
 * userData/logs/main-YYYY-MM-DD.log。使用者只要從偽裝記事本右鍵 →「版本」就能
 * 拿到一份完整的檔案傳給開發者，不用再被請去開 DevTools 抓紅字。
 *
 * 防呆：preload 沒掛載（極早期的初始化失敗）時 window.api 可能是 undefined，
 * 所以每次 forward 都用 optional chaining + try/catch，再爛也不會把 renderer
 * 自己的錯誤 handler 搞 crash。
 */
function forwardToMain(level: "info" | "warn" | "error", msg: string): void {
  try {
    window.api?.rendererLog?.(level, msg);
  } catch {
    /* preload 沒上線就放掉 */
  }
}

// 1) console.error 串接 — 包住原本的 console.error，先正常印一份到 DevTools
//    再丟一份給 main。這樣開發者開 DevTools 看得到原始訊息，使用者那邊 main
//    log 也有副本。
{
  const origErr = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    origErr(...args);
    const text = args
      .map((a) => {
        if (a instanceof Error) return a.stack ?? a.message;
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(" ");
    forwardToMain("error", text);
  };
}

// 2) 全域 'error' — 沒被 try/catch 接到的 sync 例外。
window.addEventListener("error", (e) => {
  const stack = (e.error as Error | undefined)?.stack;
  forwardToMain(
    "error",
    `[window.error] ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}` +
      (stack ? `\n${stack}` : ""),
  );
});

// 3) 全域 'unhandledrejection' — 沒 .catch 的 Promise 例外。
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  const text =
    r instanceof Error ? (r.stack ?? r.message) : (() => {
      try {
        return JSON.stringify(r);
      } catch {
        return String(r);
      }
    })();
  forwardToMain("error", `[unhandledrejection] ${text}`);
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
