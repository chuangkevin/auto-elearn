import { useEffect, useMemo, useRef, useState } from "react";
import Noteqad from "./Noteqad";
import type {
  AppState,
  AutoLoginProgress,
  CourseCandidate,
  CredentialsStatus,
  CredsPromptPayload,
  ResumePrompt,
  StealthState,
  ViewBounds,
} from "@shared/ipc";

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
      getCredsStatus: () => Promise<CredentialsStatus>;
      forgetCredentials: () => void;
      answerCredsPrompt: (save: boolean) => void;
      onCredsPrompt: (cb: (p: CredsPromptPayload) => void) => () => void;
      onAutoLoginProgress: (cb: (p: AutoLoginProgress) => void) => () => void;
      onResumePrompt: (cb: (p: ResumePrompt) => void) => () => void;
      answerResumePrompt: (resume: boolean) => void;
      getStealthStatus: () => Promise<StealthState>;
      stealthUnlock: (secret: string) => Promise<boolean>;
      stealthSetSecret: (secret: string) => Promise<{ ok: boolean; reason?: string }>;
      stealthLock: () => void;
      stealthConfigPath: () => Promise<string>;
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

// Browser view lives on the RIGHT; dashboard/controls on the LEFT.
// Ratio = fraction of width the browser takes.
// Dashboard is column-ish (course list + log), doesn't need to be fat; the live
// elearn page on the right is what the user actually reads.
const SELECTING_BROWSER_RATIO = 0.6; // 40% dashboard / 60% browser while browsing
const RUNNING_BROWSER_RATIO = 0.6;   // keep same — user explicitly liked narrow
const COLLAPSED_BROWSER_PX = 28;     // collapsed "peek" width
const MIN_BROWSER = 0.1;
const MAX_BROWSER = 0.9;
const DIVIDER_PX = 6;

const STATES_THAT_DONT_NEED_BROWSER: Array<string> = [
  "enrolling",
  "running",
  "paused",
  "done",
  "aborted",
];

function useAppState(): AppState | null {
  const [s, setS] = useState<AppState | null>(null);
  useEffect(() => {
    window.api.getState().then(setS);
    const off = window.api.onState(setS);
    return off;
  }, []);
  return s;
}

/**
 * Electron BrowserView paints ABOVE the renderer HTML, so any modal / overlay is
 * occluded by it wherever the view sits. While a modal is open we collapse the
 * view to 0x0 (invisible) and restore on unmount.
 */
function hideBrowserView() {
  window.api.setViewBounds({ x: 0, y: 0, width: 0, height: 0 });
}

/** Hook: hide the BrowserView for the lifetime of this component. */
function useHideBrowserViewWhileMounted() {
  useEffect(() => {
    hideBrowserView();
    return () => {
      // Two pushes — the first fires right away, the second after the modal's
      // exit animation + any flex settlement.
      setTimeout(pushBrowserViewBounds, 0);
      setTimeout(pushBrowserViewBounds, 120);
    };
  }, []);
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

function App() {
  const state = useAppState();
  const leftRef = useRef<HTMLDivElement>(null);
  const [browserRatio, setBrowserRatio] = useState(SELECTING_BROWSER_RATIO);
  const [collapsed, setCollapsed] = useState(false);
  const userAdjustedRatio = useRef(false);
  const prevStatus = useRef<string | null>(null);
  const dragging = useRef(false);

  // Credentials + auto-login UI state
  const [credsPrompt, setCredsPrompt] = useState<CredsPromptPayload | null>(null);
  const [credsStatus, setCredsStatus] = useState<CredentialsStatus | null>(null);
  const [autoLogin, setAutoLogin] = useState<AutoLoginProgress | null>(null);
  const [resumePrompt, setResumePrompt] = useState<ResumePrompt | null>(null);

  useEffect(() => {
    window.api.getCredsStatus().then(setCredsStatus).catch(() => void 0);
    const offPrompt = window.api.onCredsPrompt((p) => setCredsPrompt(p));
    const offAuto = window.api.onAutoLoginProgress((p) => {
      setAutoLogin(p);
      if (p.stage === "success" || p.stage === "failed") {
        // Refresh status; dismiss banner after a short delay
        window.api.getCredsStatus().then(setCredsStatus).catch(() => void 0);
        setTimeout(() => setAutoLogin((prev) => (prev?.stage === p.stage ? null : prev)), 3500);
      }
    });
    const offResume = window.api.onResumePrompt((p) => setResumePrompt(p));
    return () => {
      offPrompt();
      offAuto();
      offResume();
    };
  }, []);

  function answerResume(resume: boolean) {
    window.api.answerResumePrompt(resume);
    setResumePrompt(null);
  }

  // Any App-owned modal open → hide BrowserView so the modal isn't occluded.
  useEffect(() => {
    const anyModal = !!credsPrompt || !!resumePrompt;
    if (anyModal) {
      hideBrowserView();
    } else {
      // After close, wait a tick for layout to settle, then re-push.
      setTimeout(pushBrowserViewBounds, 0);
      setTimeout(pushBrowserViewBounds, 120);
    }
  }, [credsPrompt, resumePrompt]);

  function answerCredsPrompt(save: boolean) {
    window.api.answerCredsPrompt(save);
    setCredsPrompt(null);
    if (save) {
      setTimeout(() => window.api.getCredsStatus().then(setCredsStatus), 250);
    }
  }

  function forgetCreds() {
    if (!confirm("確定要清除已儲存的帳密嗎？之後 session 過期就需要手動登入。")) return;
    window.api.forgetCredentials();
    setCredsStatus({ saved: false });
  }

  // State-aware default: shrink the BrowserView during Monitor, unless the
  // user has explicitly resized the divider this session.
  useEffect(() => {
    if (!state) return;
    const s = state.status;
    if (prevStatus.current !== s) {
      prevStatus.current = s;
      if (!userAdjustedRatio.current) {
        if (STATES_THAT_DONT_NEED_BROWSER.includes(s)) {
          setBrowserRatio(RUNNING_BROWSER_RATIO);
        } else {
          setBrowserRatio(SELECTING_BROWSER_RATIO);
        }
      }
    }
  }, [state]);

  useEffect(() => {
    const ro = new ResizeObserver(() => pushBrowserViewBounds());
    if (leftRef.current) ro.observe(leftRef.current);
    const mount = document.getElementById("browserview-mount");
    if (mount) ro.observe(mount);
    window.addEventListener("resize", pushBrowserViewBounds);
    // Push bounds aggressively right after mount — the built renderer's flex
    // layout settles a few frames later than dev-server HMR does, and if the
    // BrowserView stays at its stale initial bounds it eats clicks on the left.
    [0, 50, 150, 400, 900, 1800].forEach((ms) =>
      setTimeout(pushBrowserViewBounds, ms),
    );
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", pushBrowserViewBounds);
    };
  }, []);

  useEffect(() => {
    pushBrowserViewBounds();
  }, [browserRatio, collapsed]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragging.current) return;
      const w = window.innerWidth;
      // Browser sits on the right; its width = w - clientX
      const r = (w - e.clientX) / w;
      setBrowserRatio(Math.min(MAX_BROWSER, Math.max(MIN_BROWSER, r)));
      userAdjustedRatio.current = true;
      if (collapsed) setCollapsed(false);
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
  }, [collapsed]);

  function toggleCollapse() {
    setCollapsed((c) => {
      if (c) {
        // expanding again — respect current ratio
        return false;
      }
      return true;
    });
  }

  if (!state) {
    return (
      <div className="h-full flex items-center justify-center text-slate-300">
        載入中...
      </div>
    );
  }

  const leftFlex = collapsed ? `1 1 auto` : `1 1 ${(1 - browserRatio) * 100}%`;
  const rightFlex = collapsed
    ? `0 0 ${COLLAPSED_BROWSER_PX}px`
    : `1 1 ${browserRatio * 100}%`;

  return (
    <div className="h-screen flex flex-row relative">
      <div
        ref={leftRef}
        className="overflow-auto"
        style={{ flex: leftFlex, minWidth: 0 }}
      >
        <TopPanel state={state} />
      </div>
      <div
        onMouseDown={(e) => {
          if (collapsed) return;
          e.preventDefault();
          dragging.current = true;
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        className={`${
          collapsed ? "bg-slate-800" : "bg-slate-700 hover:bg-emerald-500"
        } transition-colors flex items-center justify-center text-xs text-slate-400 select-none`}
        style={{
          width: collapsed ? 24 : DIVIDER_PX,
          cursor: collapsed ? "default" : "col-resize",
          flex: `0 0 ${collapsed ? 24 : DIVIDER_PX}px`,
          writingMode: collapsed ? "vertical-rl" : "horizontal-tb",
        }}
        title={collapsed ? "瀏覽器已收起" : "拖曳調整左右分隔"}
      >
        {collapsed && <span>瀏覽器已收起</span>}
      </div>
      <div
        id="browserview-mount"
        style={{
          flex: rightFlex,
          background: "#000",
          minWidth: 0,
        }}
      />
      {/* Collapse toggle — bottom-right of the dashboard column so it never
          overlaps Monitor's 暫停/回選課/中止 buttons at the top, and so the
          BrowserView can't render over it. */}
      <button
        className="absolute bottom-3 z-50 px-2 py-1 rounded bg-slate-800/90 hover:bg-slate-700 text-xs text-slate-200 border border-slate-600 backdrop-blur shadow-lg"
        style={{
          right: collapsed ? COLLAPSED_BROWSER_PX + 12 : `calc(${browserRatio * 100}% + 12px)`,
        }}
        onClick={toggleCollapse}
        title={collapsed ? "重新展開 e 等公務園瀏覽器" : "收起 e 等公務園瀏覽器，Monitor 吃滿畫面"}
      >
        {collapsed ? "🖥 展開瀏覽器" : "📴 收起瀏覽器"}
      </button>

      {/* Auto-login status toast */}
      {autoLogin && (
        <div
          className={`absolute left-1/2 -translate-x-1/2 top-3 z-50 px-4 py-2 rounded text-sm shadow-lg border backdrop-blur ${
            autoLogin.stage === "success"
              ? "bg-emerald-600/90 border-emerald-400 text-white"
              : autoLogin.stage === "failed"
              ? "bg-rose-600/90 border-rose-400 text-white"
              : "bg-slate-800/90 border-slate-600 text-slate-100"
          }`}
        >
          {autoLogin.stage === "start" && "🔐 背景自動登入中..."}
          {autoLogin.stage === "filling" && "🔐 填寫登入表單..."}
          {autoLogin.stage === "submitted" && "🔐 等待驗證..."}
          {autoLogin.stage === "success" && "✅ 自動登入成功"}
          {autoLogin.stage === "failed" && `❌ 自動登入失敗：${autoLogin.error ?? "請手動登入"}`}
        </div>
      )}

      {/* Saved-credentials status chip (bottom-left of top panel) */}
      {credsStatus?.saved && (
        <button
          className="absolute left-3 top-3 z-40 px-2 py-1 rounded bg-slate-800/70 hover:bg-slate-700 text-xs text-emerald-300 border border-slate-600 backdrop-blur"
          onClick={forgetCreds}
          title="點擊清除儲存的帳密"
        >
          🔑 已記憶 {credsStatus.maskedAccount ?? ""}
        </button>
      )}

      {/* Resume-previous-run prompt modal */}
      {resumePrompt && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
          <div className="bg-slate-900 border border-slate-700 rounded-lg max-w-md w-[90vw] p-6 shadow-2xl">
            <h2 className="text-lg font-semibold text-slate-100 mb-2">偵測到上次未完成的進度</h2>
            <p className="text-sm text-slate-300 mb-1">
              上次中斷時間：
              <span className="text-slate-400"> {new Date(resumePrompt.startedAt).toLocaleString()}</span>
            </p>
            <p className="text-sm text-slate-300 mb-4">
              還有 <span className="font-bold text-emerald-300">{resumePrompt.pipelineCids.length}</span>{" "}
              門課在進行中，要繼續嗎？
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm"
                onClick={() => answerResume(false)}
              >
                丟棄
              </button>
              <button
                className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold"
                onClick={() => answerResume(true)}
              >
                繼續上次進度
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save-creds prompt modal */}
      {credsPrompt && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
          <div className="bg-slate-900 border border-slate-700 rounded-lg max-w-md w-[90vw] p-6 shadow-2xl">
            <h2 className="text-lg font-semibold text-slate-100 mb-2">儲存帳密以便自動重登？</h2>
            <p className="text-sm text-slate-300 mb-1">
              偵測到 eCPA 登入成功（帳號 <span className="text-emerald-300">{credsPrompt.maskedAccount}</span>）。
            </p>
            <p className="text-sm text-slate-400 mb-4 leading-relaxed">
              儲存後，session 過期時系統會用此帳密在背景重新登入，不打斷你刷課。
              帳密經 Windows DPAPI 加密後存在 <code>userData</code>，只有你這台電腦的你可以解開。
            </p>
            <div className="flex justify-end gap-2">
              <button
                className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm"
                onClick={() => answerCredsPrompt(false)}
              >
                不要，這次就好
              </button>
              <button
                className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm"
                onClick={() => answerCredsPrompt(true)}
              >
                儲存並啟用自動重登
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Shell() {
  const [stealth, setStealth] = useState<StealthState | "loading">("loading");
  // React-managed setup dialog (Electron renderers return null from window.prompt,
  // so the one-liner prompt() approach silently does nothing).
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupValue, setSetupValue] = useState("");
  const [setupConfirm, setSetupConfirm] = useState("");
  const [setupErr, setSetupErr] = useState<string | null>(null);

  useEffect(() => {
    window.api
      .getStealthStatus()
      .then((s) => setStealth(s))
      .catch(() => setStealth("no_secret"));
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (
        e.ctrlKey &&
        e.altKey &&
        (e.key === "h" || e.key === "H") &&
        stealth === "unlocked"
      ) {
        e.preventDefault();
        window.api.stealthLock();
        setStealth("locked");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stealth]);

  // BrowserView paints above the renderer; while we're showing Noteqad or the
  // loading screen it must be 0x0 or it leaks the real elearn page on top of
  // the fake Notepad.
  useEffect(() => {
    if (stealth === "locked" || stealth === "loading") {
      hideBrowserView();
    }
    // When stealth flips to unlocked/no_secret, App (below) re-mounts and its
    // own useEffect pushes the correct bounds.
  }, [stealth]);

  if (stealth === "loading") {
    return (
      <div className="h-screen flex items-center justify-center text-slate-400 bg-slate-950">
        載入中...
      </div>
    );
  }

  if (stealth === "locked") {
    return (
      <Noteqad
        hasSecret={true}
        onUnlockAttempt={async (s) => {
          const ok = await window.api.stealthUnlock(s);
          if (ok) setStealth("unlocked");
          return ok;
        }}
        // Hidden gesture (File>Exit ×5) is the recovery path when the user forgot
        // their password. Overwriting is fine here — the threat model is "someone
        // behind me looks at my screen", not "someone with filesystem access";
        // the config is plaintext either way.
        onSetSecret={async (s) => {
          const res = await window.api.stealthSetSecret(s);
          if (res.ok) setStealth("unlocked");
          return res;
        }}
      />
    );
  }

  // `no_secret` or `unlocked` → real app renders underneath; overlay a small
  // bottom-right control to lock / enable stealth.
  return (
    <>
      <App />
      {/* Stealth toggle lives in the bottom-LEFT corner (inside dashboard column);
          fixed right/bottom would put it behind the BrowserView which paints on top. */}
      {stealth === "unlocked" && (
        <button
          className="fixed left-3 bottom-3 z-50 px-2 py-1 text-xs rounded bg-slate-800/90 border border-slate-600 text-slate-300 hover:text-rose-300 hover:bg-slate-700 backdrop-blur shadow-lg"
          title="鎖定回 Notepad（Ctrl+Alt+H）"
          onClick={() => {
            window.api.stealthLock();
            setStealth("locked");
          }}
        >
          🫥 隱藏
        </button>
      )}
      {stealth === "no_secret" && (
        <button
          className="fixed left-3 bottom-3 z-50 px-2 py-1 text-xs rounded bg-slate-800/90 border border-slate-600 text-slate-400 hover:text-emerald-300 hover:bg-slate-700 backdrop-blur shadow-lg"
          title="設定偽裝密碼。設定後，下次啟動會先顯示 Notepad，輸入密碼 + Enter 才會進入 app。"
          onClick={() => {
            setSetupValue("");
            setSetupConfirm("");
            setSetupErr(null);
            setSetupOpen(true);
          }}
        >
          🫥 啟用偽裝
        </button>
      )}

      {setupOpen && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60"
          // Mount effect inside a tiny child so we can use our hook
        >
          <StealthSetupCard
            value={setupValue}
            confirmValue={setupConfirm}
            err={setupErr}
            onChangeValue={setSetupValue}
            onChangeConfirm={setSetupConfirm}
            onCancel={() => setSetupOpen(false)}
            onSubmit={async () => {
              if (!setupValue || setupValue.length < 2) {
                setSetupErr("密碼至少 2 個字元");
                return;
              }
              if (setupValue !== setupConfirm) {
                setSetupErr("兩次輸入不一致");
                return;
              }
              const res = await window.api.stealthSetSecret(setupValue);
              if (!res.ok) {
                setSetupErr(res.reason ?? "儲存失敗");
                return;
              }
              setSetupOpen(false);
              setStealth("unlocked");
            }}
          />
        </div>
      )}
    </>
  );
}

function StealthSetupCard({
  value,
  confirmValue,
  err,
  onChangeValue,
  onChangeConfirm,
  onCancel,
  onSubmit,
}: {
  value: string;
  confirmValue: string;
  err: string | null;
  onChangeValue: (v: string) => void;
  onChangeConfirm: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  useHideBrowserViewWhileMounted();
  const [configPath, setConfigPath] = useState<string>("");
  useEffect(() => {
    window.api.stealthConfigPath().then(setConfigPath).catch(() => void 0);
  }, []);
  return (
    <div className="bg-slate-900 border border-slate-700 rounded-lg max-w-md w-[90vw] p-6 shadow-2xl text-slate-100">
      <h2 className="text-lg font-semibold mb-2">🫥 啟用偽裝（Notepad 模式）</h2>
      <p className="text-sm text-slate-400 mb-2 leading-relaxed">
        設定密碼後，下次啟動 app 會先顯示一個 Notepad 畫面。在 textarea 打此密碼 + Enter
        才會進入真正的 app。使用中可按 <code>Ctrl+Alt+H</code> 或 🫥 按鈕隨時再鎖回 Notepad。
      </p>
      <p className="text-sm text-slate-400 mb-2">密碼以明碼存放於：</p>
      <div className="mb-4 font-mono text-[11px] text-slate-200 bg-slate-950 border border-slate-700 rounded px-2 py-1 break-all select-all">
        {configPath || "(路徑載入中…)"}
      </div>
      <input
        className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-700 text-sm mb-2 focus:outline-none focus:border-emerald-500"
        placeholder="輸入密碼"
        type="password"
        value={value}
        onChange={(e) => onChangeValue(e.target.value)}
        autoFocus
      />
      <input
        className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-700 text-sm mb-2 focus:outline-none focus:border-emerald-500"
        placeholder="再輸入一次"
        type="password"
        value={confirmValue}
        onChange={(e) => onChangeConfirm(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onSubmit()}
      />
      {err && <div className="text-xs text-rose-400 mb-2">{err}</div>}
      <div className="flex justify-end gap-2">
        <button
          className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm"
          onClick={onCancel}
        >
          取消
        </button>
        <button
          className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold"
          onClick={onSubmit}
        >
          啟用偽裝
        </button>
      </div>
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
  const [hasSearched, setHasSearched] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [toUnenroll, setToUnenroll] = useState<Set<string>>(new Set());
  const [onlyAnyone, setOnlyAnyone] = useState(true);
  const [hideEnrolled, setHideEnrolled] = useState(true);
  // Batch-apply progress UI
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyProgress, setApplyProgress] = useState<{ done: number; total: number; msg: string } | null>(
    null,
  );

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
    setHasSearched(true);
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

  function toggleUnenroll(cid: string) {
    setToUnenroll((prev) => {
      const next = new Set(prev);
      if (next.has(cid)) next.delete(cid);
      else next.add(cid);
      return next;
    });
    // Unenroll and "keep + process" are mutually exclusive; if staging to drop,
    // remove from the process list too.
    setSelected((prev) => {
      if (!prev.has(cid)) return prev;
      const next = new Set(prev);
      next.delete(cid);
      return next;
    });
  }

  function toggle(cid: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cid)) next.delete(cid);
      else next.add(cid);
      return next;
    });
    // If the user re-ticks a row staged for unenroll, undo the unenroll stage.
    setToUnenroll((prev) => {
      if (!prev.has(cid)) return prev;
      const next = new Set(prev);
      next.delete(cid);
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

  function openConfirm() {
    if (selected.size === 0 && toUnenroll.size === 0) return;
    setConfirmOpen(true);
  }

  async function applyBatch() {
    setConfirmOpen(false);
    setApplying(true);
    try {
      const unenrollList = Array.from(toUnenroll);
      const total = unenrollList.length;
      for (let i = 0; i < unenrollList.length; i++) {
        const cid = unenrollList[i];
        const name = pending.find((p) => p.cid === cid)?.name ?? cid;
        setApplyProgress({ done: i, total, msg: `退選 ${name}` });
        const res = await window.api.unenrollCourse(cid);
        if (!res.ok) {
          alert(`退選失敗：${name}（${res.error ?? "未知原因"}）；已略過，繼續下一門`);
        }
      }
      setApplyProgress(null);
      setToUnenroll(new Set());
      // Pipeline kicks in only if the user also asked to process something
      const cids = Array.from(selected);
      if (cids.length > 0) {
        window.api.startPipeline(cids);
      }
    } finally {
      setApplying(false);
    }
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
                stagedForUnenroll={toUnenroll.has(c.cid)}
                onToggleUnenroll={() => toggleUnenroll(c.cid)}
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
              onChange={(e) => {
                const v = e.target.value;
                // If the user types what looks like an agency code list, flip to
                // codes mode and carry the value over — 540 / 522 / "540,541" etc.
                // only match digits + separators, not free text.
                if (v && /^[\d\s,，、\-–—~至;；]+$/.test(v)) {
                  setMode("codes");
                  setCodes(v);
                  return;
                }
                setKeyword(v);
              }}
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
        {results.length === 0 && !searching && !hasSearched && (
          <p className="text-slate-500 text-sm">
            還沒搜尋；直接按「搜尋」即可瀏覽全部，或先輸入關鍵字 / 代碼縮小範圍。
          </p>
        )}
        {results.length === 0 && !searching && hasSearched && (
          <p className="text-amber-400 text-sm">
            搜尋 0 筆。
            {mode === "keyword" && /^\d+$/.test(keyword.trim())
              ? " 看起來你打的是數字——試試切到右邊「類別代碼」模式？"
              : mode === "codes"
              ? " 代碼可能沒有對應到 elearn 分類；看 log 確認，或換用關鍵字。"
              : " 換個關鍵字試試。"}
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

      {/* Footer bar: summary + confirm */}
      <footer className="sticky bottom-0 bg-slate-950/90 backdrop-blur-sm py-3 -mx-6 px-6 border-t border-slate-800 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm flex items-center gap-4 flex-wrap">
          <span>
            加選 / 處理 <span className="font-bold text-emerald-400">{selected.size}</span> 門
            {" "}· 共{" "}
            <span className="font-bold text-emerald-400">{selectedTotalHours.toFixed(1)}</span>{" "}
            小時
          </span>
          {toUnenroll.size > 0 && (
            <span className="text-rose-400">
              退選 <span className="font-bold">{toUnenroll.size}</span> 門
            </span>
          )}
          {applyProgress && (
            <span className="text-amber-300">
              執行中 {applyProgress.done}/{applyProgress.total}：{applyProgress.msg}
            </span>
          )}
        </div>
        <button
          className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-semibold"
          disabled={(selected.size === 0 && toUnenroll.size === 0) || applying}
          onClick={openConfirm}
        >
          {applying ? "執行中..." : "✅ 確認操作 →"}
        </button>
      </footer>

      {confirmOpen && (
        <ConfirmBatchModal
          onClose={() => setConfirmOpen(false)}
          onConfirm={applyBatch}
          toEnroll={Array.from(selected).map((cid) => {
            const p = pending.find((c) => c.cid === cid);
            if (p) return { cid, name: p.name, hours: p.requiredSec / 3600 };
            const r = results.find((x) => x.cid === cid);
            return {
              cid,
              name: r?.caption ?? cid,
              hours: r?.certification_hours ?? 0,
            };
          })}
          toUnenroll={Array.from(toUnenroll).map((cid) => {
            const p = pending.find((c) => c.cid === cid);
            return { cid, name: p?.name ?? cid };
          })}
        />
      )}
    </div>
  );
}

function ConfirmBatchModal({
  onClose,
  onConfirm,
  toEnroll,
  toUnenroll,
}: {
  onClose: () => void;
  onConfirm: () => void;
  toEnroll: { cid: string; name: string; hours: number }[];
  toUnenroll: { cid: string; name: string }[];
}) {
  useHideBrowserViewWhileMounted();
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60">
      <div className="bg-slate-900 border border-slate-700 rounded-lg max-w-xl w-[90vw] max-h-[80vh] overflow-auto p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-slate-100 mb-4">確認批次操作</h2>

        {toUnenroll.length > 0 && (
          <section className="mb-4">
            <h3 className="text-sm font-semibold text-rose-400 mb-2">
              ❌ 將退選 {toUnenroll.length} 門
            </h3>
            <ul className="text-sm text-slate-300 space-y-1 ml-3">
              {toUnenroll.map((c) => (
                <li key={c.cid} className="truncate">
                  <span className="text-slate-500 mr-1">•</span>
                  {c.name}
                </li>
              ))}
            </ul>
          </section>
        )}

        {toEnroll.length > 0 && (
          <section className="mb-4">
            <h3 className="text-sm font-semibold text-emerald-400 mb-2">
              ✅ 將加選 / 處理 {toEnroll.length} 門（共{" "}
              {toEnroll.reduce((a, c) => a + c.hours, 0).toFixed(1)} 小時）
            </h3>
            <ul className="text-sm text-slate-300 space-y-1 ml-3">
              {toEnroll.map((c) => (
                <li key={c.cid} className="flex justify-between gap-2">
                  <span className="truncate">
                    <span className="text-slate-500 mr-1">•</span>
                    {c.name}
                  </span>
                  <span className="text-amber-300 shrink-0">{c.hours} hr</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="text-xs text-slate-400 mb-4 border-t border-slate-800 pt-3">
          執行順序：先退選 → 再加選（若有新課）→ 再自動刷課。退選會呼叫站方 UI 點擊流程，每門約需 1-3 秒。
        </div>

        <div className="flex justify-end gap-2">
          <button
            className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm"
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold"
            onClick={onConfirm}
          >
            執行
          </button>
        </div>
      </div>
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
  stagedForUnenroll,
  onToggleUnenroll,
}: {
  cid: string;
  caption: string;
  hours: number;
  meta?: string;
  checked: boolean;
  onToggle: () => void;
  badge?: string;
  onPreview?: () => void;
  stagedForUnenroll?: boolean;
  onToggleUnenroll?: () => void;
}) {
  const rowBg = stagedForUnenroll
    ? "bg-rose-900/30 border border-rose-700/60"
    : checked
    ? "bg-emerald-900/30"
    : "hover:bg-slate-800/60";
  return (
    <label
      className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer ${rowBg}`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="shrink-0"
        disabled={stagedForUnenroll}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`truncate ${stagedForUnenroll ? "line-through text-slate-400" : ""}`}>
            {caption}
          </span>
          {badge && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-200">
              {badge}
            </span>
          )}
          {stagedForUnenroll && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-700 text-white">
              待退選
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
            // Stop propagation so the click doesn't bubble into the parent label
            // and re-toggle the checkbox, undoing the user's actual action.
            e.preventDefault();
            e.stopPropagation();
            onPreview();
          }}
          title="在右邊瀏覽器預覽"
        >
          預覽
        </button>
      )}
      {onToggleUnenroll && (
        <button
          className={`text-xs px-1.5 py-0.5 rounded ${
            stagedForUnenroll
              ? "bg-rose-700 text-white hover:bg-rose-600"
              : "text-slate-400 hover:text-rose-400 hover:bg-slate-700/40"
          }`}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggleUnenroll();
          }}
          title={stagedForUnenroll ? "取消退選（保留）" : "標記為待退選（按確認才會真的退）"}
        >
          {stagedForUnenroll ? "↩ 復原" : "🗑 退選"}
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
    <div className="p-6 pb-14 space-y-4 text-slate-100 h-full flex flex-col">
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

      <section className="flex-1 flex flex-col min-h-0">
        <h2 className="text-sm font-semibold mb-2 text-slate-300">📜 日誌</h2>
        <div className="flex-1 bg-black/30 rounded p-2 text-xs font-mono overflow-auto space-y-0.5 min-h-0">
          {state.logs.slice(-200).map((l, i) => (
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
