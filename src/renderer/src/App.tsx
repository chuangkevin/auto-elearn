import { useEffect, useMemo, useRef, useState } from "react";
import type { AppState, CourseCandidate, ViewBounds } from "@shared/ipc";

declare global {
  interface Window {
    api: {
      getState: () => Promise<AppState>;
      onState: (cb: (s: AppState) => void) => () => void;
      setViewBounds: (b: ViewBounds) => void;
      navigateView: (url: string) => void;
      pause: () => void;
      resume: () => void;
      abort: () => void;
      backToSelect: () => void;
      refreshCourses: () => void;
      searchCourses: (keyword: string) => Promise<CourseCandidate[]>;
      searchByCodes: (codes: string[]) => Promise<CourseCandidate[]>;
      startPipeline: (cids: string[]) => void;
      unenrollCourse: (cid: string) => Promise<{ ok: boolean; error?: string }>;
    };
  }
}

/**
 * Parse a free-form code string from the user.
 * Accepts: "540, 541-546, 522, 539" → ["540","541","542","543","544","545","546","522","539"]
 */
function parseCodeList(raw: string): string[] {
  const tokens = raw
    .split(/[\s,、，;；]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const t of tokens) {
    const range = t.match(/^(\d+)[-—~至](\d+)$/);
    if (range) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      if (Number.isFinite(a) && Number.isFinite(b) && b >= a && b - a < 200) {
        for (let i = a; i <= b; i++) out.push(String(i));
        continue;
      }
    }
    if (/^\d+$/.test(t)) out.push(t);
  }
  return Array.from(new Set(out));
}

const DEFAULT_BOTTOM_RATIO = 0.42;
const MIN_BOTTOM = 0.15;
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
        className="overflow-auto"
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
        style={{ height: DIVIDER_PX, cursor: "row-resize", flex: `0 0 ${DIVIDER_PX}px` }}
        title="拖曳調整上下分隔"
      />
      <div
        id="browserview-mount"
        style={{ flex: `1 1 ${bottomRatio * 100}%`, background: "#000", minHeight: 0 }}
      />
    </div>
  );
}

function TopPanel({ state }: { state: AppState }) {
  if (state.status === "boot") return <Centered>啟動中...</Centered>;
  if (state.status === "await_login") return <AwaitingLogin />;
  if (state.status === "selecting") return <Selecting state={state} />;
  return <Monitor state={state} />;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full w-full flex items-center justify-center text-slate-300 px-6">
      {children}
    </div>
  );
}

function AwaitingLogin() {
  return (
    <div className="h-full flex flex-col items-center justify-center text-center space-y-4 px-6 py-8">
      <h1 className="text-2xl font-bold">auto-elearn</h1>
      <p className="text-slate-300 text-lg">
        👉 請在下方瀏覽器登入 e 等公務園
      </p>
      <p className="text-slate-400 text-sm">
        任何登入方式都支援：帳號密碼 / 自然人憑證 / MyData
      </p>
      <div className="w-4 h-4 rounded-full bg-amber-400 animate-pulse" />
    </div>
  );
}

// ── Selecting ────────────────────────────────────────────────
type SearchMode = "keyword" | "codes";

function Selecting({ state }: { state: AppState }) {
  const [mode, setMode] = useState<SearchMode>("keyword");
  const [keyword, setKeyword] = useState("");
  const [codes, setCodes] = useState("");
  const [results, setResults] = useState<CourseCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [onlyAnyone, setOnlyAnyone] = useState(true);
  const [hideEnrolled, setHideEnrolled] = useState(true);
  const [unenrolBusy, setUnenrolBusy] = useState<Set<string>>(new Set());

  // "繼續上次進度" = courses the user is actively processing; exclude both
  // 'done' and 'pending'. The latter are ghost records returned by
  // getSigningCourses where isReadtimeValidCaption="未報名" (agency-assigned
  // future offerings the user hasn't actually registered for yet) — showing
  // those here confuses the user about what's in-progress.
  const IN_PROGRESS_PHASES = new Set([
    "enrolled",
    "reading",
    "exam",
    "survey",
    "rating",
    "reflection",
  ]);
  const pending = useMemo(
    () => state.courses.filter((c) => IN_PROGRESS_PHASES.has(c.phase)),
    [state.courses],
  );

  // Pre-tick unfinished courses on first mount
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    if (pending.length === 0) return;
    didInit.current = true;
    setSelected(new Set(pending.map((c) => c.cid)));
  }, [pending]);

  function togglePendingAll() {
    const allCids = pending.map((c) => c.cid);
    const allChecked = allCids.length > 0 && allCids.every((c) => selected.has(c));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allChecked) allCids.forEach((c) => next.delete(c));
      else allCids.forEach((c) => next.add(c));
      return next;
    });
  }

  const visibleResults = useMemo(() => {
    return results.filter((r) => {
      if (hideEnrolled && r.already_enrolled) return false;
      if (onlyAnyone && r.studentTargetTypeCaption && r.studentTargetTypeCaption !== "任何人")
        return false;
      return true;
    });
  }, [results, onlyAnyone, hideEnrolled]);

  const selectedTotalHours = useMemo(() => {
    let h = 0;
    const sr = new Map(results.map((r) => [r.cid, r]));
    for (const cid of selected) {
      const p = pending.find((c) => c.cid === cid);
      if (p) h += p.requiredSec / 3600;
      else {
        const r = sr.get(cid);
        if (r) h += r.certification_hours;
      }
    }
    return h;
  }, [selected, pending, results]);

  async function doSearch() {
    setSearching(true);
    try {
      if (mode === "codes") {
        const list = parseCodeList(codes);
        if (list.length === 0) {
          setResults([]);
        } else {
          const res = await window.api.searchByCodes(list);
          setResults(res);
        }
      } else {
        const res = await window.api.searchCourses(keyword.trim());
        setResults(res);
      }
    } finally {
      setSearching(false);
    }
  }

  async function unenrol(cid: string) {
    if (unenrolBusy.has(cid)) return;
    setUnenrolBusy((prev) => new Set(prev).add(cid));
    try {
      const res = await window.api.unenrollCourse(cid);
      if (!res.ok) {
        alert(`退選失敗：${res.error ?? "未知原因"}`);
      }
    } finally {
      setUnenrolBusy((prev) => {
        const next = new Set(prev);
        next.delete(cid);
        return next;
      });
    }
  }

  function toggle(cid: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cid)) next.delete(cid);
      else next.add(cid);
      return next;
    });
  }

  function toggleAllVisible() {
    const allCids = visibleResults.map((r) => r.cid);
    const allChecked = allCids.every((c) => selected.has(c));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allChecked) allCids.forEach((c) => next.delete(c));
      else allCids.forEach((c) => next.add(c));
      return next;
    });
  }

  function start() {
    const cids = Array.from(selected);
    if (cids.length === 0) return;
    window.api.startPipeline(cids);
  }

  return (
    <div className="p-6 space-y-6 text-slate-100">
      <header className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase text-slate-400">已登入</div>
          <h1 className="text-xl font-bold">{state.user?.name ?? "使用者"}</h1>
        </div>
        <button
          className="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-sm"
          onClick={() => window.api.refreshCourses()}
          title="重新抓取已報名課程清單"
        >
          🔄 重新掃描
        </button>
      </header>

      {/* Section: 繼續上次進度 */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-slate-300">
            📂 繼續上次進度（已報名但未完成 {pending.length} 門）
          </h2>
          {pending.length > 0 && (
            <button
              className="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-xs"
              onClick={togglePendingAll}
            >
              全選 / 全不選
            </button>
          )}
        </div>
        {pending.length === 0 ? (
          <p className="text-slate-500 text-sm">目前沒有未完成課程</p>
        ) : (
          <div className="space-y-1 max-h-48 overflow-auto bg-slate-900/40 rounded p-2">
            {pending.map((c) => (
              <CourseRow
                key={c.cid}
                cid={c.cid}
                caption={c.name}
                hours={c.requiredSec / 3600}
                meta={phaseLabel(c.phase)}
                checked={selected.has(c.cid)}
                onToggle={() => toggle(c.cid)}
                badge="已報名"
                onUnenroll={() => {
                  if (confirm(`確定要退選：${c.name}?`)) unenrol(c.cid);
                }}
                unenrollBusy={unenrolBusy.has(c.cid)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Section: 搜尋新課 */}
      <section>
        <h2 className="text-sm font-semibold text-slate-300 mb-2">🔍 搜尋新課</h2>
        <div className="flex gap-2 mb-2 items-center">
          <div className="inline-flex rounded border border-slate-700 bg-slate-800 p-0.5 text-xs">
            <button
              className={`px-2 py-1 rounded ${
                mode === "keyword" ? "bg-emerald-600 text-white" : "text-slate-300 hover:bg-slate-700"
              }`}
              onClick={() => setMode("keyword")}
            >
              關鍵字
            </button>
            <button
              className={`px-2 py-1 rounded ${
                mode === "codes" ? "bg-emerald-600 text-white" : "text-slate-300 hover:bg-slate-700"
              }`}
              onClick={() => setMode("codes")}
            >
              類別代碼
            </button>
          </div>
          {mode === "keyword" ? (
            <input
              className="flex-1 px-3 py-2 rounded bg-slate-800 border border-slate-700 focus:outline-none focus:border-emerald-500"
              placeholder="輸入關鍵字（例：資安、AI、個資、性別、人權、環境、國防）"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doSearch()}
            />
          ) : (
            <input
              className="flex-1 px-3 py-2 rounded bg-slate-800 border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono"
              placeholder="輸入代碼：540, 541-546, 522, 539"
              value={codes}
              onChange={(e) => setCodes(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && doSearch()}
            />
          )}
          <button
            className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40"
            onClick={() => doSearch()}
            disabled={searching}
          >
            {searching ? "搜尋中..." : "搜尋"}
          </button>
        </div>
        {mode === "codes" && (
          <div className="text-xs text-slate-400 mb-2">
            支援逗號、空白、破折號範圍（如：540, 541-546）
          </div>
        )}
        <div className="flex items-center gap-4 text-xs text-slate-300 mb-2">
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={onlyAnyone}
              onChange={(e) => setOnlyAnyone(e.target.checked)}
            />
            只顯示「任何人」可報名
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={hideEnrolled}
              onChange={(e) => setHideEnrolled(e.target.checked)}
            />
            隱藏已報名
          </label>
          {visibleResults.length > 0 && (
            <button
              className="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-xs"
              onClick={toggleAllVisible}
            >
              全選 / 全不選（可見 {visibleResults.length}）
            </button>
          )}
        </div>
        {results.length === 0 && !searching && (
          <p className="text-slate-500 text-sm">
            還沒搜尋；可直接按「搜尋」瀏覽所有課程，或輸入關鍵字縮小範圍
          </p>
        )}
        <div className="space-y-1 max-h-72 overflow-auto bg-slate-900/40 rounded p-2">
          {visibleResults.map((r) => (
            <CourseRow
              key={r.cid}
              cid={r.cid}
              caption={r.caption}
              hours={r.certification_hours}
              meta={[
                r.fromSchoolName,
                r.studentTargetTypeCaption,
                r.category_full_path?.split(" > ").slice(-1)[0],
              ]
                .filter(Boolean)
                .join(" · ")}
              checked={selected.has(r.cid)}
              onToggle={() => toggle(r.cid)}
              badge={r.already_enrolled ? "已報名" : undefined}
              onPreview={() =>
                window.api.navigateView(`https://elearn.hrd.gov.tw/info/${r.cid}`)
              }
            />
          ))}
        </div>
      </section>

      {/* Footer bar: summary + start */}
      <footer className="sticky bottom-0 bg-slate-950/90 backdrop-blur-sm py-3 -mx-6 px-6 border-t border-slate-800 flex items-center justify-between">
        <div className="text-sm">
          已選 <span className="font-bold text-emerald-400">{selected.size}</span> 門 ·
          總計{" "}
          <span className="font-bold text-emerald-400">
            {selectedTotalHours.toFixed(1)}
          </span>{" "}
          小時
        </div>
        <button
          className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-semibold"
          disabled={selected.size === 0}
          onClick={start}
        >
          🚀 開始報名並自動刷課 →
        </button>
      </footer>
    </div>
  );
}

function CourseRow({
  cid,
  caption,
  hours,
  meta,
  checked,
  onToggle,
  badge,
  onPreview,
  onUnenroll,
  unenrollBusy,
}: {
  cid: string;
  caption: string;
  hours: number;
  meta?: string;
  checked: boolean;
  onToggle: () => void;
  badge?: string;
  onPreview?: () => void;
  onUnenroll?: () => void;
  unenrollBusy?: boolean;
}) {
  return (
    <label
      className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer ${
        checked ? "bg-emerald-900/30" : "hover:bg-slate-800/60"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="shrink-0"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate">{caption}</span>
          {badge && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-200">
              {badge}
            </span>
          )}
        </div>
        {meta && <div className="text-xs text-slate-400 truncate">{meta}</div>}
      </div>
      <span className="shrink-0 text-sm text-amber-300">{hours} hr</span>
      {onPreview && (
        <button
          className="text-xs text-slate-400 hover:text-emerald-400 px-1"
          onClick={(e) => {
            e.preventDefault();
            onPreview();
          }}
          title="在下方瀏覽器預覽"
        >
          預覽
        </button>
      )}
      {onUnenroll && (
        <button
          className="text-xs text-slate-400 hover:text-red-400 px-1 disabled:opacity-40"
          onClick={(e) => {
            e.preventDefault();
            onUnenroll();
          }}
          disabled={unenrollBusy}
          title="退選這門課"
        >
          {unenrollBusy ? "退選中..." : "退選"}
        </button>
      )}
      <span className="text-[10px] text-slate-600 ml-1">#{cid}</span>
    </label>
  );
}

function phaseLabel(p: string): string {
  switch (p) {
    case "pending":
      return "待報名";
    case "enrolled":
      return "已報名，未開始";
    case "reading":
      return "閱讀中";
    case "exam":
      return "待測驗";
    case "survey":
      return "待問卷";
    case "rating":
      return "待評分";
    case "reflection":
      return "待心得";
    case "done":
      return "已完成";
    default:
      return p;
  }
}

// ── Monitor ──────────────────────────────────────────────────
function Monitor({ state }: { state: AppState }) {
  // Only show the courses the user actually picked for this run.
  const scopeCids = state.pipelineCids
    ? new Set(state.pipelineCids)
    : null;
  const scope = scopeCids
    ? state.courses.filter((c) => scopeCids.has(c.cid))
    : state.courses;
  const running = scope.filter((c) => c.phase !== "done");
  return (
    <div className="p-6 space-y-4 text-slate-100">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-bold">
          {statusLabel(state.status)} · {state.user?.name ?? ""}
        </h1>
        <div className="flex items-center gap-2">
          {state.status === "running" && (
            <button
              className="px-3 py-1 rounded bg-amber-600 hover:bg-amber-500 text-sm"
              onClick={() => window.api.pause()}
            >
              ⏸ 暫停
            </button>
          )}
          {state.status === "paused" && (
            <button
              className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-sm"
              onClick={() => window.api.resume()}
            >
              ▶ 恢復
            </button>
          )}
          <button
            className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-sm"
            onClick={() => window.api.backToSelect()}
            title="停止目前執行並回到選課畫面"
          >
            ↩ 回選課
          </button>
          <button
            className="px-3 py-1 rounded bg-red-700 hover:bg-red-600 text-sm"
            onClick={() => window.api.abort()}
          >
            🛑 結束
          </button>
        </div>
      </header>

      {state.pauseReason && (
        <div className="bg-amber-950/50 border border-amber-700 rounded p-2 text-sm">
          ⚠️ 暫停原因：{state.pauseReason}
        </div>
      )}

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
              A: {state.now.currentQuestion.answer}（{state.now.currentQuestion.source}）
            </div>
          )}
        </div>
      )}

      <section>
        <h2 className="text-sm font-semibold mb-2 text-slate-300">
          📋 執行中課程 ({running.length} / {scope.length} 本次)
        </h2>
        <div className="space-y-1 max-h-48 overflow-auto bg-slate-900/40 rounded p-2">
          {running.map((c) => (
            <div
              key={c.cid}
              className="flex justify-between items-center text-sm px-2 py-1 rounded bg-slate-800/30"
            >
              <span className="truncate">{c.name}</span>
              <span className="text-slate-400 whitespace-nowrap ml-2">
                {phaseLabel(c.phase)}
              </span>
            </div>
          ))}
          {running.length === 0 && (
            <div className="text-slate-500 text-sm">（沒有進行中項目）</div>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold mb-2 text-slate-300">📜 日誌</h2>
        <div className="bg-black/30 rounded p-2 text-xs font-mono max-h-40 overflow-auto space-y-0.5">
          {state.logs.slice(-30).map((l, i) => (
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

function statusLabel(s: AppState["status"]): string {
  switch (s) {
    case "enrolling":
      return "🚀 報名中";
    case "running":
      return "▶️  執行中";
    case "paused":
      return "⏸ 暫停中";
    case "done":
      return "✅ 完成";
    case "aborted":
      return "🛑 已中止";
    default:
      return s;
  }
}
