import { useEffect, useRef, useState } from "react";
import type { AppState, ViewBounds } from "@shared/ipc";

declare global {
  interface Window {
    api: {
      getState: () => Promise<AppState>;
      onState: (cb: (s: AppState) => void) => () => void;
      setViewBounds: (b: ViewBounds) => void;
      pause: () => void;
      resume: () => void;
      abort: () => void;
    };
  }
}

const DEFAULT_BOTTOM_RATIO = 0.55;
const MIN_BOTTOM = 0.2;
const MAX_BOTTOM = 0.85;
const DIVIDER_PX = 6;

function useAppState(): AppState | null {
  const [s, setS] = useState<AppState | null>(null);
  useEffect(() => {
    window.api.getState().then(setS);
    const off = window.api.onState(setS);
    return off;
  }, []);
  return s;
}

function pushBrowserViewBounds() {
  const viewport = document.getElementById("browserview-mount");
  if (!viewport) return;
  const r = viewport.getBoundingClientRect();
  window.api.setViewBounds({
    x: Math.round(r.left),
    y: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
  });
}

export default function App() {
  const state = useAppState();
  const topRef = useRef<HTMLDivElement>(null);
  const [bottomRatio, setBottomRatio] = useState(DEFAULT_BOTTOM_RATIO);
  const dragging = useRef(false);

  // Sync BrowserView bounds whenever layout changes
  useEffect(() => {
    const ro = new ResizeObserver(() => pushBrowserViewBounds());
    if (topRef.current) ro.observe(topRef.current);
    window.addEventListener("resize", pushBrowserViewBounds);
    setTimeout(pushBrowserViewBounds, 50);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", pushBrowserViewBounds);
    };
  }, []);

  useEffect(() => {
    // Re-push bounds after ratio change
    pushBrowserViewBounds();
  }, [bottomRatio]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragging.current) return;
      const h = window.innerHeight;
      const r = (h - e.clientY) / h;
      setBottomRatio(Math.min(MAX_BOTTOM, Math.max(MIN_BOTTOM, r)));
    }
    function onUp() {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  if (!state) {
    return (
      <div className="h-full flex items-center justify-center text-slate-300">
        載入中...
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col">
      <div
        ref={topRef}
        className="overflow-auto px-6 py-4"
        style={{ flex: `1 1 ${(1 - bottomRatio) * 100}%`, minHeight: 0 }}
      >
        <TopPanel state={state} />
      </div>
      <div
        onMouseDown={() => {
          dragging.current = true;
          document.body.style.cursor = "row-resize";
          document.body.style.userSelect = "none";
        }}
        className="bg-slate-700 hover:bg-emerald-500 transition-colors"
        style={{
          height: DIVIDER_PX,
          cursor: "row-resize",
          flex: `0 0 ${DIVIDER_PX}px`,
        }}
        title="拖動調整上下分隔"
      />
      <div
        id="browserview-mount"
        style={{ flex: `1 1 ${bottomRatio * 100}%`, background: "#000", minHeight: 0 }}
      />
    </div>
  );
}

function TopPanel({ state }: { state: AppState }) {
  if (state.status === "await_login") {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center space-y-4">
        <h1 className="text-2xl font-bold">auto-elearn</h1>
        <p className="text-slate-300">
          👉 請在下方瀏覽器登入 e 等公務園（支援帳密 / 自然人憑證 / MyData 所有方式）
        </p>
        <p className="text-slate-400 text-sm">
          偵測到「個人專區」會自動接手，開始刷課。
        </p>
        <div className="w-4 h-4 rounded-full bg-amber-400 animate-pulse" />
      </div>
    );
  }

  if (state.status === "boot") {
    return <p className="text-slate-400">啟動中...</p>;
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold">
          ✅ {state.user?.name ?? "已登入"}，正在自動刷課
        </h1>
        <button
          className="px-3 py-1 rounded bg-red-600 hover:bg-red-500 text-sm"
          onClick={() => window.api.abort()}
        >
          🛑 停止
        </button>
      </header>

      <div>
        <div className="h-2 bg-slate-800 rounded overflow-hidden">
          <div
            className="h-full bg-emerald-500 transition-all"
            style={{ width: `${state.stats.progressPct}%` }}
          />
        </div>
        <p className="text-xs text-slate-400 mt-1">
          {state.stats.done} / {state.stats.total} 完成 ({state.stats.progressPct}%)
        </p>
      </div>

      {state.now.courseId && (
        <div className="bg-slate-800/50 rounded-lg p-4">
          <div className="text-xs uppercase text-slate-400 mb-1">目前進行中</div>
          <div className="font-semibold">{state.now.courseName}</div>
          <div className="text-sm text-slate-300 mt-1">
            [{state.now.action}] {state.now.detail ?? ""}
          </div>
          {state.now.currentQuestion && (
            <div className="mt-2 text-xs text-slate-400">
              Q: {state.now.currentQuestion.text.slice(0, 80)}
              <br />
              A: {state.now.currentQuestion.answer}（
              {state.now.currentQuestion.source}）
            </div>
          )}
        </div>
      )}

      <section>
        <h2 className="text-sm font-semibold mb-2 text-slate-300">
          📋 所有課程 ({state.courses.length})
        </h2>
        <div className="space-y-1 max-h-32 overflow-auto">
          {state.courses.map((c) => (
            <div
              key={c.cid}
              className="flex justify-between items-center text-sm bg-slate-800/30 px-2 py-1 rounded"
            >
              <span className="truncate">{c.name}</span>
              <span className="text-slate-400 whitespace-nowrap ml-2">
                {c.phase}
              </span>
            </div>
          ))}
          {state.courses.length === 0 && (
            <div className="text-slate-500 text-sm">掃描中...</div>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold mb-2 text-slate-300">📜 日誌</h2>
        <div className="bg-black/30 rounded p-2 text-xs font-mono max-h-32 overflow-auto space-y-0.5">
          {state.logs.slice(-20).map((l, i) => (
            <div
              key={i}
              className={
                l.level === "error"
                  ? "text-red-400"
                  : l.level === "warn"
                  ? "text-amber-400"
                  : "text-slate-300"
              }
            >
              [{new Date(l.ts).toLocaleTimeString()}] {l.msg}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
