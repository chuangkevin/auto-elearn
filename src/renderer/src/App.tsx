import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import Noteqad from "./Noteqad";
import type {
  AccountOpResult,
  AppState,
  AutoLoginProgress,
  CourseCandidate,
  ResumePrompt,
  SearchOptions,
  StealthState,
  ViewBounds,
} from "@shared/ipc";
import { AFFILIATED_SCHOOLS, MAIN_CATEGORIES } from "@shared/elearn-catalog";

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
      searchCourses: (opts: SearchOptions | string) => Promise<CourseCandidate[]>;
      searchByCodes: (codes: string[]) => Promise<CourseCandidate[]>;
      getCategoryChildren: (parentId: string) => Promise<Array<{ id: string; label: string }>>;
      startPipeline: (cids: string[]) => void;
      unenrollCourse: (cid: string) => Promise<{ ok: boolean; error?: string }>;
      onAutoLoginProgress: (cb: (p: AutoLoginProgress) => void) => () => void;
      onResumePrompt: (cb: (p: ResumePrompt) => void) => () => void;
      answerResumePrompt: (resume: boolean) => void;
      getStealthStatus: () => Promise<StealthState>;
      stealthUnlock: (secret: string) => Promise<boolean>;
      stealthSetSecret: (secret: string) => Promise<{ ok: boolean; reason?: string }>;
      stealthLock: () => void;
      stealthClearSecret: () => Promise<{ ok: boolean }>;
      stealthConfigPath: () => Promise<string>;
      openGeminiDialog: () => void;
      onGeminiDialogRequest: (cb: () => void) => () => void;
      getGeminiKey: () => Promise<string>;
      setGeminiKey: (key: string) => Promise<void>;
      ackFirstRun: () => void;
      rendererLog: (level: "info" | "warn" | "error", msg: string) => void;
      openLogsFolder: () => void;
      getAppVersion: () => Promise<string>;
      openExternalUrl: (url: string) => Promise<{ ok: boolean; reason?: string }>;
      // ── 多帳號 (v0.8.0) ──
      beginUnlock: (id: string) => void;
      verifyPin: (id: string, pin: string) => Promise<AccountOpResult>;
      cancelUnlock: () => void;
      switchActiveAccount: (id: string) => void;
      closeTab: (id: string) => Promise<AccountOpResult>;
      goPicker: () => void;
      addAccountBegin: () => Promise<AccountOpResult>;
      addAccountCancel: () => void;
      finishNewAccount: (
        payload: { nickname: string; pin: string },
      ) => Promise<AccountOpResult>;
      addAccountSubmit: (
        payload: { account: string; password: string; nickname: string; pin: string },
      ) => Promise<AccountOpResult>;
      lockTab: (id: string) => Promise<AccountOpResult>;
      lockActive: () => Promise<AccountOpResult>;
      setAccountNickname: (
        payload: { id: string; nickname: string },
      ) => Promise<AccountOpResult>;
      setAccountPin: (
        payload: { id: string; oldPin: string; newPin: string },
      ) => Promise<AccountOpResult>;
      resetPinBegin: (id: string) => void;
      resetPinVerify: (
        payload: { id: string; password: string },
      ) => Promise<AccountOpResult>;
      resetPinComplete: (
        payload: { id: string; newPin: string },
      ) => Promise<AccountOpResult>;
      resetPinCancel: () => void;
      removeAccount: (id: string) => Promise<AccountOpResult>;
      logoutActiveAccount: () => Promise<AccountOpResult>;
      clearAllAccounts: () => Promise<AccountOpResult>;
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
const DIVIDER_PX = 8;

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

// Counter tracks how many modals are currently open.
// pushBrowserViewBounds is a no-op while any modal holds the view hidden.
let _modalDepth = 0;

function hideBrowserView() {
  window.api.setViewBounds({ x: 0, y: 0, width: 0, height: 0 });
}

/** Hide the BrowserView for the lifetime of this component. */
function useHideBrowserViewWhileMounted() {
  useEffect(() => {
    _modalDepth++;
    hideBrowserView();
    return () => {
      _modalDepth--;
      if (_modalDepth === 0) {
        setTimeout(pushBrowserViewBounds, 0);
        setTimeout(pushBrowserViewBounds, 120);
      }
    };
  }, []);
}

function pushBrowserViewBounds() {
  if (_modalDepth > 0) return; // a modal is holding the view hidden
  const viewport = document.getElementById("browserview-mount");
  if (!viewport) return;
  const r = viewport.getBoundingClientRect();
  window.api.setViewBounds({
    x: Math.ceil(r.left),
    y: Math.round(r.top),
    width: Math.floor(r.width),
    height: Math.round(r.height),
  });
}

function App() {
  const state = useAppState();
  const leftRef = useRef<HTMLDivElement>(null);
  const [browserRatio, setBrowserRatio] = useState(SELECTING_BROWSER_RATIO);
  // collapsed: 把右邊瀏覽器收起、只留左邊操作區。
  // leftCollapsed: 把左邊操作區收起、只留右邊瀏覽器（看影片時用）。
  const [collapsed, setCollapsed] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [showFirstRunHelp, setShowFirstRunHelp] = useState(false);
  const userAdjustedRatio = useRef(false);
  const prevStatus = useRef<string | null>(null);
  const dragging = useRef(false);

  const [appCtxMenu, setAppCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");
  useEffect(() => {
    window.api.getAppVersion?.().then(setAppVersion).catch(() => void 0);
  }, []);
  useEffect(() => {
    if (!appCtxMenu) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setAppCtxMenu(null);
    }
    function onClick() {
      setAppCtxMenu(null);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [appCtxMenu]);

  // 第一次啟動時跳出 SmartScreen 說明（main 端會給 isFirstRun 旗標）。
  useEffect(() => {
    if (state?.isFirstRun) setShowFirstRunHelp(true);
  }, [state?.isFirstRun]);

  const [autoLogin, setAutoLogin] = useState<AutoLoginProgress | null>(null);
  const [resumePrompt, setResumePrompt] = useState<ResumePrompt | null>(null);

  useEffect(() => {
    const offAuto = window.api.onAutoLoginProgress((p) => {
      setAutoLogin(p);
      if (p.stage === "success" || p.stage === "failed") {
        setTimeout(
          () => setAutoLogin((prev) => (prev?.stage === p.stage ? null : prev)),
          3500,
        );
      }
    });
    const offResume = window.api.onResumePrompt((p) => setResumePrompt(p));
    return () => {
      offAuto();
      offResume();
    };
  }, []);

  function answerResume(resume: boolean) {
    window.api.answerResumePrompt(resume);
    setResumePrompt(null);
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
    // 必須包含 leftCollapsed —— 收起 / 展開左邊操作區會改變 #browserview-mount
    // 的 flex（leftFlex 變 0 0 28px、rightFlex 變 1 1 auto），對應的 bounds
    // 要重推給 main。光靠 ResizeObserver 在 flex 1 1 auto 邊界 case 不可靠，
    // 不顯式帶 dep 會讓 BrowserView 卡在舊 bounds、原本左半變黑色空白區。
    pushBrowserViewBounds();
    // belt-and-braces：layout 在某些 zoom / DPI 下會多 reflow 一次，
    // 50ms 後再推一次保險。
    const t = setTimeout(pushBrowserViewBounds, 50);
    return () => clearTimeout(t);
  }, [browserRatio, collapsed, leftCollapsed]);

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

  const mode = state.multi.mode;

  // mode = picker / pin / reset_pin / boot：顯示 tile picker（無 BrowserView）
  // v0.8.1：active tab 被鎖定時 multi.mode 也會是 "pin"（PIN target 是 active session
  // 自己）。這個 case 留在 active layout — TabBar 仍可見、PinModal 覆蓋中央區塊，
  // 使用者按取消可從 TabBar 切到別的 tab 而不是被踢回 picker。
  const lockingActiveTab = mode === "pin" && !!state.multi.activeAccountId;
  if (
    !lockingActiveTab &&
    (mode === "boot" || mode === "picker" || mode === "pin" || mode === "reset_pin")
  ) {
    return (
      <PickerLayout
        state={state}
        showFirstRunHelp={showFirstRunHelp}
        onCloseFirstRunHelp={() => {
          setShowFirstRunHelp(false);
          window.api.ackFirstRun();
        }}
      />
    );
  }

  // mode = active / post_login：顯示 tab bar + 主畫面（包含 BrowserView）
  // 三種版面：
  //   leftCollapsed → 左邊縮成窄條、瀏覽器吃滿（看影片用）
  //   collapsed     → 右邊縮成窄條、操作區吃滿（看 log 用）
  //   都關 = 兩邊照 browserRatio 分配
  const leftFlex = leftCollapsed
    ? `0 0 ${COLLAPSED_BROWSER_PX}px`
    : collapsed
      ? `1 1 auto`
      : `1 1 ${(1 - browserRatio) * 100}%`;
  const rightFlex = collapsed
    ? `0 0 ${COLLAPSED_BROWSER_PX}px`
    : leftCollapsed
      ? `1 1 auto`
      : `1 1 ${browserRatio * 100}%`;

  return (
    <div
      className="h-screen flex flex-col relative"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setAppCtxMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <TabBar state={state} />
      <div className="flex-1 flex flex-row relative min-h-0">
        <div
          ref={leftRef}
          className="relative overflow-hidden"
          style={{ flex: leftFlex, minWidth: 0 }}
        >
          {leftCollapsed ? (
            <button
              className="h-full w-full flex items-center justify-center text-xs text-slate-300 bg-slate-800 hover:bg-slate-700"
              onClick={() => setLeftCollapsed(false)}
              title="重新展開操作區"
              style={{ writingMode: "vertical-rl" }}
            >
              操作區已收起，點我展開
            </button>
          ) : (
            // v0.8.2：pb-14（56px）給左下角的偽裝 / Gemini / 收起左邊 floating
            // 按鈕留空間 — 之前內容直接觸底，被那一排按鈕擋住，使用者操作不到
            // Selecting / Monitor 最底下的 row。
            <div className="overflow-auto h-full pb-14">
              <TopPanel state={state} />
            </div>
          )}

          {/* v0.8.2：原本 v0.8.1 在這裡放「🔒 鎖定」絕對定位按鈕，但跟 Shell
           *  層的 fixed 偽裝/Gemini 按鈕同樣 left-3 直接重疊。已搬到 TabBar 右側，
           *  那裡是 tab 級操作的自然位置，也避開了 fixed 元素的螢幕底部擁擠區。 */}

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
              {autoLogin.stage === "start" && "🔐 幫你登入中…"}
              {autoLogin.stage === "filling" && "🔐 正在輸入帳號密碼…"}
              {autoLogin.stage === "submitted" && "🔐 等網站確認中…"}
              {autoLogin.stage === "success" && "✅ 登入成功"}
              {autoLogin.stage === "failed" &&
                `❌ 登入失敗：${autoLogin.error ?? "請自己登入一次"}`}
            </div>
          )}

          {resumePrompt && (
            <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/60">
              <ModalGuard>
                <div className="bg-slate-900 border border-slate-700 rounded-lg max-w-md w-[90%] p-6 shadow-2xl">
                  <h2 className="text-lg font-semibold text-slate-100 mb-2">
                    上次有沒上完的課
                  </h2>
                  <p className="text-sm text-slate-300 mb-1">
                    上次停下來的時間：
                    <span className="text-slate-400">
                      {" "}
                      {new Date(resumePrompt.startedAt).toLocaleString()}
                    </span>
                  </p>
                  <p className="text-sm text-slate-300 mb-4">
                    還有{" "}
                    <span className="font-bold text-emerald-300">
                      {resumePrompt.pipelineCids.length}
                    </span>{" "}
                    門課還沒上完，要不要繼續？
                  </p>
                  <div className="flex justify-end gap-2">
                    <button
                      className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm"
                      onClick={() => answerResume(false)}
                    >
                      不要，重新選
                    </button>
                    <button
                      className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold"
                      onClick={() => answerResume(true)}
                    >
                      繼續上次
                    </button>
                  </div>
                </div>
              </ModalGuard>
            </div>
          )}

          {/* mode === "post_login"：剛新登入，請使用者設定暱稱 + PIN（v0.8.1 後新流程
           *  不會走進這個 mode；保留 render branch 以免舊 main / 跨版本 preload 失靈） */}
          {state.multi.mode === "post_login" && state.multi.postLogin && (
            <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/70">
              <ModalGuard>
                <PostLoginCard accountId={state.multi.postLogin.id} />
              </ModalGuard>
            </div>
          )}

          {/* v0.8.1：active tab 被鎖定 — PinModal 蓋住整個 active layout 中央區，
           *  使用者要重輸 PIN 才能繼續看；TabBar 仍可見可切到別的 tab 逃。 */}
          {state.multi.mode === "pin" && state.multi.pinTarget && (
            <PinModal target={state.multi.pinTarget} />
          )}

          {/* Portal target for ConfirmBatchModal (rendered deep in Selecting tree) */}
          <div id="left-modal-root" />
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

        {!leftCollapsed && (
          <button
            className="absolute bottom-3 z-50 px-2 py-1 rounded bg-slate-800/90 hover:bg-slate-700 text-xs text-slate-200 border border-slate-600 backdrop-blur shadow-lg"
            style={{
              right: collapsed
                ? COLLAPSED_BROWSER_PX + 12
                : `calc(${browserRatio * 100}% + 12px)`,
            }}
            onClick={toggleCollapse}
            title={collapsed ? "重新打開右邊網頁" : "右邊網頁收起來，操作區看得更清楚"}
          >
            {collapsed ? "→ 打開網頁" : "← 收起網頁"}
          </button>
        )}
        {!collapsed && !leftCollapsed && (
          <button
            // v0.8.2：left-44 → left-60，避開 Shell 的 🫥+⚙ flex 容器（左下 ~205px 寬）
            className="absolute bottom-3 left-60 z-50 px-2 py-1 rounded bg-slate-800/90 hover:bg-slate-700 text-xs text-slate-200 border border-slate-600 backdrop-blur shadow-lg"
            onClick={() => setLeftCollapsed(true)}
            title="把左邊操作區收起來，網頁吃滿畫面"
          >
            ← 收起左邊
          </button>
        )}
      </div>

      {showFirstRunHelp && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70">
          <ModalGuard>
            <FirstRunHelpCard
              onClose={() => {
                setShowFirstRunHelp(false);
                window.api.ackFirstRun();
              }}
            />
          </ModalGuard>
        </div>
      )}

      {appCtxMenu && (
        <div
          className="fixed z-[90] min-w-[200px] bg-white border border-[#bfbfbf] shadow-md py-1 select-none"
          style={{
            left: Math.min(appCtxMenu.x, Math.max(0, window.innerWidth - 220)),
            top: Math.min(appCtxMenu.y, Math.max(0, window.innerHeight - 60)),
          }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            className="block w-full text-left px-4 py-1 hover:bg-[#0b65c2] hover:text-white text-[12px] text-black"
            title="點我打開記錄檔資料夾，可以把 .log 檔傳給管理員除錯"
            onClick={() => {
              setAppCtxMenu(null);
              window.api.openLogsFolder?.();
            }}
          >
            版本 {appVersion ? `v${appVersion}` : "（讀取中…）"}
          </button>
        </div>
      )}
    </div>
  );
}

function FirstRunHelpCard({ onClose }: { onClose: () => void }) {
  return (
    <div className="bg-white text-slate-900 rounded-lg max-w-lg w-[92%] p-6 shadow-2xl">
      <h2 className="text-lg font-semibold mb-3 text-emerald-700">
        👋 歡迎！第一次打開的小提醒
      </h2>
      <p className="text-sm leading-relaxed mb-3">
        Windows 第一次打開可能會跳一個藍色的警告視窗（叫做 SmartScreen）。
        這是因為這個程式不是大公司簽名發行的，<b>不代表有問題</b>，
        照下面的步驟跳過就可以了：
      </p>
      <ol className="text-sm leading-relaxed mb-4 list-decimal pl-5 space-y-1.5">
        <li>看到藍色「Windows 已保護你的電腦」視窗時，<b>不要按關閉</b></li>
        <li>點警告中間的「<b>其他資訊</b>」</li>
        <li>右下角會多出一顆「<b>仍要執行</b>」按鈕，按下去</li>
        <li>程式就會正常打開了，下次再打開不會再跳這個視窗</li>
      </ol>
      <div className="bg-slate-100 border border-slate-200 rounded p-3 text-xs leading-relaxed text-slate-700 mb-4">
        如果不小心按了「關閉」也沒關係，再點兩下程式檔再做一次就好。
      </div>
      <div className="flex justify-end">
        <button
          className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold"
          onClick={onClose}
        >
          我知道了
        </button>
      </div>
    </div>
  );
}

function GeminiInfoCard({
  onClose,
  onOpen,
}: {
  onClose: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="bg-slate-900 border border-slate-700 rounded-lg max-w-md w-[90vw] p-6 shadow-2xl text-slate-100">
      <h2 className="text-lg font-semibold mb-2">⚙ 關於 Gemini 設定</h2>
      <p className="text-sm text-slate-300 leading-relaxed mb-3">
        這個欄位是讓你「選用」是否要接 Google 的 AI 來幫忙答題。
      </p>
      <ul className="text-sm text-slate-300 leading-relaxed mb-3 list-disc pl-5 space-y-1">
        <li>
          <b className="text-emerald-300">沒設定也能用</b>，
          系統會自己用內建題庫和歷史紀錄答題。
        </li>
        <li>有設定的話，遇到題庫沒收錄的題目時，會多一個 AI 後援。</li>
        <li>
          這把鑰匙存在你電腦的設定檔裡，<b>不會傳到網路上</b>。
        </li>
      </ul>
      <p className="text-xs text-slate-400 mb-4 leading-relaxed">
        要設定的話需要去 Google AI Studio 申請一把免費的 API Key
        （搜尋「Gemini API Key」就找得到教學）。
      </p>
      <div className="flex justify-end gap-2">
        <button
          className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm"
          onClick={onClose}
        >
          先不要
        </button>
        <button
          className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold"
          onClick={onOpen}
        >
          打開設定
        </button>
      </div>
    </div>
  );
}

/**
 * Gemini API Key 設定 modal — v0.6.7 從 child BrowserWindow 改成 renderer 內的
 * React component（多螢幕環境下原本會跑到別的 monitor 看起來像「程式黑掉卡住」）。
 *
 * 行為：
 * - 開起來時自動 fetch 既有 key 並填入（`getGeminiKey()`）。
 * - 顯示 / 隱藏切換用 type="password" / "text"。
 * - Enter 送出，Esc 關閉。
 * - 「儲存」呼叫 `setGeminiKey(key.trim())`；「清除」呼叫 `setGeminiKey("")`；
 *   「取消」直接關閉，不寫入。
 * - 視覺風格沿用原本 gemini-key-dialog.html 的 catppuccin 紫色主題，貼到主視窗
 *   裡也不違和。
 */
function GeminiKeyModal({ onClose }: { onClose: () => void }) {
  const [keyValue, setKeyValue] = useState("");
  const [show, setShow] = useState(false);
  const [status, setStatus] = useState<{ msg: string; color: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 載入既有 key（如果有）。失敗就讓欄位空著，使用者可以重新打。
  useEffect(() => {
    let cancelled = false;
    window.api
      .getGeminiKey()
      .then((k) => {
        if (!cancelled && k) setKeyValue(k);
      })
      .catch(() => void 0);
    // 一進來就 focus 輸入框，使用者直接打
    setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      cancelled = true;
    };
  }, []);

  // Esc 關閉。聽全域 keydown 而不是 input 的，這樣即使 focus 跑出 input 也能 Esc。
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function save() {
    const key = keyValue.trim();
    if (!key) {
      setStatus({ msg: "請輸入 API Key", color: "#f38ba8" });
      return;
    }
    setBusy(true);
    try {
      await window.api.setGeminiKey(key);
      setStatus({ msg: "已儲存 ✓", color: "#a6e3a1" });
      setTimeout(onClose, 700);
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      await window.api.setGeminiKey("");
      setKeyValue("");
      setStatus({ msg: "已清除", color: "#fab387" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="rounded-lg shadow-2xl w-[480px] max-w-[92vw] p-6"
      style={{
        background: "#1e1e2e",
        color: "#cdd6f4",
        fontFamily: "'Microsoft JhengHei', 'Segoe UI', sans-serif",
      }}
    >
      <h3 className="text-sm font-semibold mb-2" style={{ color: "#cba6f7" }}>
        🔑 設定 Gemini API Key
      </h3>
      <p className="text-[11px] mb-4" style={{ color: "#7f849c" }}>
        Gemini 是考試 AI 解題用的（沒設也能用，靠暴力解題）。這裡的設定跟「帳號 / 課程 / 偽裝密碼」完全無關。
      </p>
      <label className="block text-xs mb-1.5" style={{ color: "#a6adc8" }}>
        API Key
      </label>
      <div className="relative">
        <input
          ref={inputRef}
          type={show ? "text" : "password"}
          value={keyValue}
          onChange={(e) => setKeyValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
          placeholder="AIzaSy…"
          autoComplete="off"
          spellCheck={false}
          className="w-full px-2.5 py-2 pr-9 rounded-md outline-none border text-[13px]"
          style={{
            background: "#313244",
            borderColor: "#45475a",
            color: "#cdd6f4",
            fontFamily: "Consolas, monospace",
          }}
        />
        <span
          onClick={() => setShow((s) => !s)}
          title="顯示 / 隱藏"
          className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-sm"
          style={{ color: "#6c7086" }}
        >
          👁
        </span>
      </div>
      <div className="text-[11px] mt-1.5" style={{ color: "#6c7086" }}>
        Key 存在本機 config.json，不上傳。沒設定的話程式會用內建題庫和歷史紀錄答題，仍然能用。
      </div>
      <div className="text-xs mt-2.5 min-h-[18px]" style={{ color: status?.color }}>
        {status?.msg ?? ""}
      </div>
      <div className="flex justify-end gap-2 mt-4">
        <button
          disabled={busy}
          onClick={clear}
          className="px-4 py-1.5 rounded-md text-[13px] disabled:opacity-50"
          style={{ background: "#45475a", color: "#cdd6f4" }}
          title="把這裡的 API Key 清掉（只清 key，不會動到帳號 / 課程 / cookie）"
        >
          清掉 Gemini Key
        </button>
        <button
          disabled={busy}
          onClick={onClose}
          className="px-4 py-1.5 rounded-md text-[13px] border disabled:opacity-50"
          style={{
            background: "#313244",
            borderColor: "#45475a",
            color: "#a6adc8",
          }}
        >
          取消
        </button>
        <button
          disabled={busy}
          onClick={save}
          className="px-4 py-1.5 rounded-md text-[13px] font-semibold disabled:opacity-50"
          style={{ background: "#cba6f7", color: "#1e1e2e" }}
        >
          儲存
        </button>
      </div>
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
  const [showGeminiInfo, setShowGeminiInfo] = useState(false);
  // v0.6.7：Gemini key 改成 renderer 內的 React modal（原本是 child BrowserWindow，
  // 在多螢幕環境會跑到別的 monitor 看起來像「程式黑掉卡住」）。
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  // v0.7.10：偽裝模式設定 modal —— 之前只有「馬上偽裝」按鈕，使用者要關偽裝
  // （清掉密碼讓下次打開直接看到真畫面）找不到入口。modal 提供「馬上偽裝」+
  // 「徹底解除偽裝模式」兩個選項。
  const [showStealthOptions, setShowStealthOptions] = useState(false);

  useEffect(() => {
    window.api
      .getStealthStatus()
      .then((s) => setStealth(s))
      .catch(() => setStealth("no_secret"));
  }, []);

  // OS 選單「說明 → 設定 Gemini API Key」是 main 端發的事件，所以要 IPC subscribe；
  // 偽裝鎖定（locked）時不開（locked UI 是 Noteqad，不該彈設定 modal）。
  useEffect(() => {
    if (stealth !== "unlocked" && stealth !== "no_secret") return;
    const off = window.api.onGeminiDialogRequest?.(() => setShowGeminiKey(true));
    return () => off?.();
  }, [stealth]);

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
      {/* v0.8.2：左下角控制列。原本 🫥 偽裝（fixed left-3）跟 ⚙ Gemini（fixed left-24）
       *  各自定位、按鈕寬度沒對齊，標籤永遠互相壓住。改用單一 flex 容器 + gap-2，
       *  保證視覺上一定不重疊；`fixed` 仍在 BrowserView 之上的 renderer 層。
       *  Stealth toggle lives in bottom-LEFT (not bottom-right) because that side is
       *  inside the dashboard column — fixed right/bottom would put it behind the
       *  BrowserView which paints on top. */}
      <div className="fixed left-3 bottom-3 z-50 flex items-center gap-2">
        {stealth === "unlocked" && (
          <button
            className="px-2 py-1 text-xs rounded bg-slate-800/90 border border-slate-600 text-slate-300 hover:text-rose-300 hover:bg-slate-700 backdrop-blur shadow-lg"
            title="點開可以馬上偽裝成記事本，或者徹底解除偽裝模式（清掉密碼）"
            onClick={() => setShowStealthOptions(true)}
          >
            🫥 偽裝模式…
          </button>
        )}
        {stealth === "no_secret" && (
          <button
            className="px-2 py-1 text-xs rounded bg-slate-800/90 border border-slate-600 text-slate-400 hover:text-emerald-300 hover:bg-slate-700 backdrop-blur shadow-lg"
            title="設一組密碼，下次打開會偽裝成記事本。要在記事本裡輸入這組密碼才會進到真正的程式。"
            onClick={() => {
              setSetupValue("");
              setSetupConfirm("");
              setSetupErr(null);
              setSetupOpen(true);
            }}
          >
            🫥 設一組偽裝密碼
          </button>
        )}
        {/* ⚙ Gemini —— 點開先彈說明，避免使用者誤以為「沒設定不能用」。 */}
        <button
          className="px-2 py-1 text-xs rounded bg-slate-800/90 border border-slate-600 text-slate-400 hover:text-amber-300 hover:bg-slate-700 backdrop-blur shadow-lg"
          title="點我看 Gemini 是什麼，要不要設定（沒設定也能用）"
          onClick={() => setShowGeminiInfo(true)}
        >
          ⚙ Gemini
        </button>
      </div>

      {/* Gemini 說明卡片 — 由 Shell 管理（按鈕在 Shell 層）。
          MUST 用 ModalGuard 包：BrowserView 是 Electron native overlay，
          畫在 renderer 之上；不收掉 BrowserView 的話 modal 右半會被 elearn
          網頁蓋住（v0.6.0 起的隱藏 regression，v0.6.7 補上）。 */}
      {showGeminiInfo && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60">
          <ModalGuard>
            <GeminiInfoCard
              onClose={() => setShowGeminiInfo(false)}
              onOpen={() => {
                // v0.6.7：直接切到 React modal，不再走 IPC 開 BrowserWindow。
                setShowGeminiInfo(false);
                setShowGeminiKey(true);
              }}
            />
          </ModalGuard>
        </div>
      )}

      {/* Gemini API Key 設定 modal — v0.6.7 從 child BrowserWindow 改成 renderer 內
          的 React component，永遠出現在主視窗中央，不會跑到別的 monitor。
          一樣用 ModalGuard 收掉 BrowserView，避免被 elearn 網頁蓋住。 */}
      {showGeminiKey && (
        <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/70">
          <ModalGuard>
            <GeminiKeyModal onClose={() => setShowGeminiKey(false)} />
          </ModalGuard>
        </div>
      )}

      {showStealthOptions && (
        <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/60">
          <ModalGuard>
            <StealthOptionsCard
              onCancel={() => setShowStealthOptions(false)}
              onLockNow={() => {
                window.api.stealthLock();
                setStealth("locked");
                setShowStealthOptions(false);
              }}
              onClearSecret={async () => {
                const res = await window.api.stealthClearSecret();
                if (res.ok) {
                  setStealth("no_secret");
                  setShowStealthOptions(false);
                }
              }}
            />
          </ModalGuard>
        </div>
      )}

      {setupOpen && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60">
          <ModalGuard>
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
          </ModalGuard>
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
  const [configPath, setConfigPath] = useState<string>("");
  useEffect(() => {
    window.api.stealthConfigPath().then(setConfigPath).catch(() => void 0);
  }, []);
  return (
    <div className="bg-slate-900 border border-slate-700 rounded-lg max-w-md w-[90vw] p-6 shadow-2xl text-slate-100">
      <h2 className="text-lg font-semibold mb-2">🫥 設一組偽裝密碼</h2>
      <p className="text-sm text-slate-300 mb-2 leading-relaxed">
        設了之後，下次打開程式會看起來像「記事本」。<br />
        要在那個記事本裡<b>輸入這組密碼 + Enter</b> 才會進到真正的程式。
      </p>
      <p className="text-sm text-slate-300 mb-2 leading-relaxed">
        進到程式後，按左下角 🫥 或 <code>Ctrl+Alt+H</code> 可以馬上再變回記事本。
      </p>
      <p className="text-xs text-slate-500 mb-2">忘記密碼怎麼辦？</p>
      <div className="mb-3 text-xs text-slate-400 leading-relaxed bg-slate-800/50 border border-slate-700 rounded px-2 py-2">
        在記事本最上面那排點「<b>檔案</b>」 → 點最下面那項「<b>結束</b>」，
        選單會收起來，再點一次「<b>檔案</b>」 → 「<b>結束</b>」，
        這樣重複到「結束」被點到第 <b>5</b> 次（15 秒內，畫面右下會看到 <code>1/5、2/5…</code> 計數）就會跳出重設密碼的視窗。
      </div>
      <p className="text-[11px] text-slate-500 mb-1">這組密碼存在這個檔案裡：</p>
      <div className="mb-4 font-mono text-[10px] text-slate-300 bg-slate-950 border border-slate-700 rounded px-2 py-1 break-all select-all">
        {configPath || "(路徑載入中…)"}
      </div>
      <input
        className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-700 text-sm mb-2 focus:outline-none focus:border-emerald-500"
        placeholder="輸入要用的密碼"
        type="password"
        value={value}
        onChange={(e) => onChangeValue(e.target.value)}
        autoFocus
      />
      <input
        className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-700 text-sm mb-2 focus:outline-none focus:border-emerald-500"
        placeholder="再打一次確認"
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
          設定好了
        </button>
      </div>
    </div>
  );
}

/**
 * 已解鎖狀態下，左下角 🫥 按鈕點開的設定卡。
 * 提供兩個動作：
 *  - 馬上偽裝（鎖回 Notepad，密碼還在，下次打開仍是偽裝模式）
 *  - 徹底解除偽裝模式（清掉密碼，下次打開直接看到真畫面）
 *
 * 為什麼要這個 modal：v0.7.10 之前點 🫥 直接 lock，沒地方「關掉偽裝」—— 想關掉
 * 偽裝的使用者只能去翻 config.json，違反「點得到的功能就不該叫使用者改檔案」。
 */
function StealthOptionsCard({
  onCancel,
  onLockNow,
  onClearSecret,
}: {
  onCancel: () => void;
  onLockNow: () => void;
  onClearSecret: () => void;
}) {
  const [confirmingClear, setConfirmingClear] = useState(false);
  return (
    <div className="bg-slate-900 border border-slate-700 rounded-lg max-w-md w-[90vw] p-6 shadow-2xl text-slate-100">
      <h2 className="text-lg font-semibold mb-3">🫥 偽裝模式</h2>
      <p className="text-sm text-slate-300 mb-4 leading-relaxed">
        目前是「<b className="text-emerald-300">已解鎖</b>」狀態。
        要把畫面馬上變回記事本，或者徹底關掉偽裝模式？
      </p>
      <div className="space-y-2 mb-4">
        <button
          className="w-full text-left px-4 py-3 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700"
          onClick={onLockNow}
        >
          <div className="text-sm font-semibold text-slate-100">🫥 馬上偽裝（鎖回記事本）</div>
          <div className="text-xs text-slate-400 mt-0.5">
            畫面立刻變回 Notepad；密碼還在，下次打開仍是偽裝模式。
            （也可以隨時用 <code>Ctrl+Alt+H</code>）
          </div>
        </button>
        <button
          className={`w-full text-left px-4 py-3 rounded border ${
            confirmingClear
              ? "bg-rose-900 hover:bg-rose-800 border-rose-700"
              : "bg-slate-800 hover:bg-slate-700 border-slate-700"
          }`}
          onClick={() => {
            if (confirmingClear) onClearSecret();
            else setConfirmingClear(true);
          }}
        >
          <div className="text-sm font-semibold text-slate-100">
            {confirmingClear ? "⚠ 再點一次確定徹底解除偽裝" : "🚪 徹底解除偽裝模式（清掉密碼）"}
          </div>
          <div className="text-xs text-slate-400 mt-0.5">
            清掉偽裝密碼，<b>下次打開程式直接看到真畫面，不再經過 Notepad</b>。
            想恢復偽裝要重新設一組密碼。
          </div>
        </button>
      </div>
      <div className="flex justify-end">
        <button
          className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm"
          onClick={onCancel}
        >
          取消
        </button>
      </div>
    </div>
  );
}

function TopPanel({ state }: { state: AppState }) {
  if (state.status === "boot") return <Centered>啟動中...</Centered>;
  // v0.8.1：新增帳號流程改成左側 modal，main 不再把 active session 切到 status="setup"。
  // 萬一舊流程殘留進來（preload mismatch），show 一個 fallback 提示，避免空白畫面。
  if (state.status === "setup" || state.status === "await_login")
    return <Centered>準備中… 如果卡在這裡，請從 picker 重新進入</Centered>;
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

// v0.8.1：原本的 NewAccountWaiting（右側 BrowserView 登入 + 左側等候畫面）已淘汰。
// 新增帳號改用 NewAccountFormModal — 左側 modal 一次填齊，main 走 net.request 靜默
// SSO，使用者完全不必碰右邊的 eCPA web 介面。

// Mirrors HEARTBEAT_PARALLEL_MAX in src/main/index.ts. Surfaced in the footer
// so users see "your N selected courses will run X in parallel, rest queued"
// up-front instead of discovering the cap after starting.
const HEARTBEAT_PARALLEL_MAX = 50;

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
  const [onlyAnyone, setOnlyAnyone] = useState(false);
  const [hideEnrolled, setHideEnrolled] = useState(true);
  // Site-style filter dropdowns (mirror elearn front-page widget)
  const [mainCategoryId, setMainCategoryId] = useState("");
  const [subCategoryId, setSubCategoryId] = useState("");
  const [subCategoryOptions, setSubCategoryOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [fromSchoolId, setFromSchoolId] = useState("");
  const [hoursMin, setHoursMin] = useState("");
  const [hoursMax, setHoursMax] = useState("");

  // Cascade: when 主類別 changes, fetch its 次類別 list and clear the current
  // 次類別 selection. Empty 主類別 = "all" → clear sub options too.
  useEffect(() => {
    if (!mainCategoryId) {
      setSubCategoryOptions([]);
      setSubCategoryId("");
      return;
    }
    setSubCategoryId("");
    let cancelled = false;
    window.api
      .getCategoryChildren(mainCategoryId)
      .then((opts) => {
        if (!cancelled) setSubCategoryOptions(opts);
      })
      .catch(() => {
        if (!cancelled) setSubCategoryOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mainCategoryId]);
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
    "verifying",
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

  // v0.8.7：使用者退選某 cid 之後 main 會 refreshCourses → pending 不再包含它，
  // 但 selected 還記著 → 計數「選了 X 堂」仍包含已退課 → 按開始時 main auto-enrol
  // 回去（已被 v0.8.7 recentlyUnenrolled 防呆住，但 UI 數字還是錯）。
  //
  // v0.8.12：之前的 prune effect 把 results 也當成 valid，搜尋切換時 results
  // 換掉了 → 上一輪搜尋勾的新課（不在 pending 但在舊 results）被誤殺。改成只
  // drop「曾經在 pending 但現在不在 pending」的 cid（= 真的退選了），其他選擇
  // 都保留，跟搜尋結果無關。
  const prevPendingCidsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const newPending = new Set(pending.map((c) => c.cid));
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const c of prev) {
        const wasInPending = prevPendingCidsRef.current.has(c);
        const isInPending = newPending.has(c);
        if (wasInPending && !isInPending) {
          changed = true; // 真的被退選了 → drop
          continue;
        }
        next.add(c);
      }
      prevPendingCidsRef.current = newPending;
      return changed ? next : prev;
    });
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
        const minH = hoursMin.trim() === "" ? undefined : Number(hoursMin);
        const maxH = hoursMax.trim() === "" ? undefined : Number(hoursMax);
        const res = await window.api.searchCourses({
          keyword: keyword.trim(),
          mainCategoryId: mainCategoryId || undefined,
          subCategoryId: subCategoryId || undefined,
          fromSchoolId: fromSchoolId || undefined,
          hoursMin: Number.isFinite(minH as number) ? (minH as number) : undefined,
          hoursMax: Number.isFinite(maxH as number) ? (maxH as number) : undefined,
        });
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
          <div className="text-xs uppercase text-slate-400">
            {state.loginStatus === "relogging"
              ? "正在重新登入"
              : state.loginStatus === "failed"
              ? "登入失敗"
              : "已登入"}
          </div>
          <h1 className="text-xl font-bold flex items-center gap-1">
            {/* 不再顯示使用者名稱（連 maskName 的「莊***」也不秀），純粹顯示登入狀態。
                避免旁邊的人從姓氏 + 機關推得出是誰。 */}
            <span>已登入</span>
            {state.loginStatus === "ok" && <span className="text-emerald-400 text-base">✅</span>}
            {state.loginStatus === "relogging" && <span className="text-amber-400 text-base animate-pulse">🔄</span>}
            {state.loginStatus === "failed" && <span className="text-rose-400 text-base">❌</span>}
          </h1>
        </div>
        <button
          className="px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-sm"
          onClick={() => window.api.refreshCourses()}
          title="重新抓最新的課程清單"
        >
          🔄 重新整理
        </button>
      </header>

      {/* 之前還沒上完的課 */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-slate-300">
            📂 之前還沒上完的課（{pending.length} 門）
          </h2>
          {pending.length > 0 && (
            <button
              className="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-xs"
              onClick={togglePendingAll}
            >
              全選 / 全部取消
            </button>
          )}
        </div>
        {pending.length === 0 ? (
          <p className="text-slate-500 text-sm">目前沒有沒上完的課</p>
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

      {/* 找新課來上 */}
      <section>
        <h2 className="text-sm font-semibold text-slate-300 mb-2">🔍 找新課來上</h2>
        <div className="text-xs text-slate-400 mb-2 leading-relaxed">
          選好想上的課之後，最下面有一顆「確認操作」的綠色按鈕，按下去就會自動上課。
        </div>
        <div className="flex gap-2 mb-2 items-center">
          <div className="inline-flex rounded border border-slate-700 bg-slate-800 p-0.5 text-xs">
            <button
              className={`px-2 py-1 rounded ${
                mode === "keyword" ? "bg-emerald-600 text-white" : "text-slate-300 hover:bg-slate-700"
              }`}
              onClick={() => setMode("keyword")}
            >
              用關鍵字找
            </button>
            <button
              className={`px-2 py-1 rounded ${
                mode === "codes" ? "bg-emerald-600 text-white" : "text-slate-300 hover:bg-slate-700"
              }`}
              onClick={() => setMode("codes")}
            >
              用代碼找
            </button>
          </div>
          {mode === "keyword" ? (
            <input
              className="flex-1 px-3 py-2 rounded bg-slate-800 border border-slate-700 focus:outline-none focus:border-emerald-500"
              placeholder="輸入想找的字（例：資安、AI、個資、性別、人權、環境、國防）"
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
            {searching ? "找中…" : "去找"}
          </button>
        </div>
        {mode === "codes" && (
          <div className="text-xs text-slate-400 mb-2">
            可以用逗號、空白、破折號連寫（例：540, 541-546）
          </div>
        )}
        {mode === "keyword" && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2 text-xs">
            <select
              className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700 text-slate-200"
              value={mainCategoryId}
              onChange={(e) => setMainCategoryId(e.target.value)}
              title="大分類"
            >
              <option value="">所有大分類</option>
              {MAIN_CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
            <select
              className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700 text-slate-200 disabled:opacity-50"
              value={subCategoryId}
              onChange={(e) => setSubCategoryId(e.target.value)}
              disabled={!mainCategoryId || subCategoryOptions.length === 0}
              title="小分類"
            >
              <option value="">所有小分類</option>
              {subCategoryOptions.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
            <select
              className="px-2 py-1.5 rounded bg-slate-800 border border-slate-700 text-slate-200"
              value={fromSchoolId}
              onChange={(e) => setFromSchoolId(e.target.value)}
              title="授課單位"
            >
              <option value="">所有授課單位</option>
              {AFFILIATED_SCHOOLS.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
            <div className="flex items-center gap-1">
              <input
                type="number"
                step="0.5"
                min="0"
                max="999"
                className="w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-700 text-slate-200"
                placeholder="最少幾小時"
                value={hoursMin}
                onChange={(e) => setHoursMin(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doSearch()}
              />
              <span className="text-slate-400">~</span>
              <input
                type="number"
                step="0.5"
                min="0"
                max="999"
                className="w-full px-2 py-1.5 rounded bg-slate-800 border border-slate-700 text-slate-200"
                placeholder="最多幾小時"
                value={hoursMax}
                onChange={(e) => setHoursMax(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && doSearch()}
              />
            </div>
          </div>
        )}
        <div className="flex items-center gap-4 text-xs text-slate-300 mb-2">
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={onlyAnyone}
              onChange={(e) => setOnlyAnyone(e.target.checked)}
            />
            只顯示一般人都能報的課
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={hideEnrolled}
              onChange={(e) => setHideEnrolled(e.target.checked)}
            />
            把已經報過的藏起來
          </label>
          {visibleResults.length > 0 && (
            <button
              className="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-xs"
              onClick={toggleAllVisible}
            >
              全選 / 全不選（這頁有 {visibleResults.length} 門）
            </button>
          )}
        </div>
        {results.length === 0 && !searching && !hasSearched && (
          <p className="text-slate-500 text-sm">
            還沒找。直接點「去找」可以看全部的課；想縮小範圍可以先輸入關鍵字。
          </p>
        )}
        {results.length === 0 && !searching && hasSearched && (
          <p className="text-amber-400 text-sm">
            找不到課。
            {mode === "keyword" && /^\d+$/.test(keyword.trim())
              ? " 你輸入的是數字，試試切到「用代碼找」模式？"
              : mode === "codes"
              ? " 這個代碼可能對不到，換個代碼或改用關鍵字。"
              : " 換個關鍵字試試。"}
          </p>
        )}
        {results.length > 0 && visibleResults.length === 0 && !searching && (
          <div className="text-amber-300 text-sm flex items-center gap-3 flex-wrap">
            <span>
              找到 {results.length} 門，但都被「{[
                hideEnrolled ? "藏掉已報名的" : null,
                onlyAnyone ? "只看一般人可報" : null,
              ]
                .filter(Boolean)
                .join("」+「")}」擋掉了。
            </span>
            <button
              className="px-2 py-0.5 rounded bg-amber-600/30 hover:bg-amber-600/50 text-amber-100"
              onClick={() => {
                setHideEnrolled(false);
                setOnlyAnyone(false);
              }}
            >
              全部顯示（{results.length} 門）
            </button>
          </div>
        )}
        {results.length > 0 && visibleResults.length > 0 && visibleResults.length < results.length && !searching && (
          <p className="text-xs text-slate-400">
            這頁顯示 {visibleResults.length} 門，總共找到 {results.length} 門（其他 {results.length - visibleResults.length} 門被篩掉了）
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

      {/* 下方確認區：選完課之後，按下面按鈕開始上課 */}
      {/* v0.7.10：footer 左側留 pl-44 而不是原本的 px-6 ——
          視窗壓窄時，左下角的 fixed 浮動 chip（🔑/🫥/⚙）會蓋住 footer 左邊的
          「選了 X 門」字樣。chip 大概 ~170px 寬（位於 left-3），給 pl-44 (176px)
          就能讓 footer 內容永遠在 chip 右側。flex-wrap 也讓「開始上課」按鈕在
          很窄的時候能掉到下一行不被截掉。 */}
      <footer className="sticky bottom-0 bg-slate-950/90 backdrop-blur-sm py-3 -mx-6 pl-44 pr-6 border-t border-slate-800 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm flex items-center gap-4 flex-wrap">
          <span>
            選了 <span className="font-bold text-emerald-400">{selected.size}</span> 門
            {" "}· 總共{" "}
            <span className="font-bold text-emerald-400">{selectedTotalHours.toFixed(1)}</span>{" "}
            小時
            {" "}· 同時上{" "}
            <span className="font-bold text-emerald-400">{Math.min(selected.size, HEARTBEAT_PARALLEL_MAX)}</span> 門
            {selected.size > HEARTBEAT_PARALLEL_MAX && (
              <span className="text-amber-400">
                {" "}（最多同時 {HEARTBEAT_PARALLEL_MAX} 門，多的會排隊輪流上）
              </span>
            )}
          </span>
          {toUnenroll.size > 0 && (
            <span className="text-rose-400">
              要退掉 <span className="font-bold">{toUnenroll.size}</span> 門
            </span>
          )}
          {applyProgress && (
            <span className="text-amber-300">
              處理中 {applyProgress.done}/{applyProgress.total}：{applyProgress.msg}
            </span>
          )}
        </div>
        <button
          className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-semibold"
          disabled={(selected.size === 0 && toUnenroll.size === 0) || applying}
          onClick={openConfirm}
        >
          {applying ? "處理中…" : "✅ 開始上課 →"}
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

/** Mounts invisibly; hides the BrowserView for its lifetime via the counter guard. */
function ModalGuard({ children }: { children: React.ReactNode }) {
  useHideBrowserViewWhileMounted();
  return <>{children}</>;
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
  const portalRoot = document.getElementById("left-modal-root");
  if (!portalRoot) return null;
  return createPortal(
    <div className="absolute inset-0 z-[60] flex items-center justify-center bg-black/60">
      <ModalGuard>
      <div className="bg-slate-900 border border-slate-700 rounded-lg max-w-xl w-[90%] max-h-[80%] overflow-auto p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-slate-100 mb-4">再確認一下</h2>

        {toUnenroll.length > 0 && (
          <section className="mb-4">
            <h3 className="text-sm font-semibold text-rose-400 mb-2">
              ❌ 要退掉 {toUnenroll.length} 門
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
              ✅ 要上 {toEnroll.length} 門課（總共{" "}
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
          順序：先退掉舊的，再加上新的，然後自動上課。每退一門大概要 1～3 秒。
        </div>

        <div className="flex justify-end gap-2">
          <button
            className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm"
            onClick={onClose}
          >
            再想想
          </button>
          <button
            className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold"
            onClick={onConfirm}
          >
            開始
          </button>
        </div>
      </div>
      </ModalGuard>
    </div>,
    portalRoot,
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
      <span className="shrink-0 text-sm text-amber-300">{hours} 小時</span>
      {onPreview && (
        <button
          className="text-xs text-slate-400 hover:text-emerald-400 px-1"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onPreview();
          }}
          title="在右邊網頁看看這堂課"
        >
          看一下
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
          title={stagedForUnenroll ? "不退了，留著" : "把這堂課退掉（要按下方確認才真的退）"}
        >
          {stagedForUnenroll ? "↩ 不退了" : "🗑 退掉"}
        </button>
      )}
      <span className="text-[10px] text-slate-600 ml-1">#{cid}</span>
    </label>
  );
}

function phaseLabel(p: string): string {
  switch (p) {
    case "pending":
      return "還沒報名";
    case "enrolled":
      return "報好了，還沒開始";
    case "reading":
      return "上課中";
    case "exam":
      return "等著做測驗";
    case "survey":
      return "等著填問卷";
    case "verifying":
      return "等系統確認過關";
    case "done":
      return "已完成";
    default:
      return p;
  }
}

/**
 * v0.8.9：本地 tick info 提到 module-level Map，key 用 `${accountId}:${cid}` 而非
 * 純 cid。多帳號模式下兩個帳號修同一堂課，cid 一樣 — 切 tab 時 useEffect 拿
 * 到 B 的 readSec 就會「以為 A 的 readSec 變了」，把 A 的 lastSyncAt 蓋成現在
 * → A 的 local extrapolation 重置 → 切回 A 時時間從本地累計的「+90」掉回實際
 * c.readSec，使用者看到 timer 倒退 1-2 分鐘。
 *
 * 把 tickInfo 提到 module level 後，兩個帳號彼此互不影響；切 tab 後再回來時
 * useEffect 不會誤判 readSec 變動 → lastSyncAt 不重置 → local extrapolation
 * 連續，timer 自然繼續走。
 */
const _tickInfoByKey = new Map<string, { lastReadSec: number; lastSyncAt: number }>();
function tickKey(accountId: string | null | undefined, cid: string): string {
  return `${accountId ?? "_"}:${cid}`;
}

// ── Monitor ──────────────────────────────────────────────────
function Monitor({ state }: { state: AppState }) {
  const scopeCids = state.pipelineCids ? new Set(state.pipelineCids) : null;
  const scope = scopeCids
    ? state.courses.filter((c) => scopeCids.has(c.cid))
    : state.courses;
  const running = scope.filter((c) => c.phase !== "done");
  const accountId = state.multi.activeAccountId;

  // 每門課的「本地計時器」：每次 server 回來新的 readSec 時對齊一次，
  // 之間用 setInterval(1s) 自己往前算，所以 UI 不會 5 分鐘才動一次。
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => (n + 1) % 1_000_000), 1000);
    return () => clearInterval(id);
  }, []);
  // 同步：每次 state 進來就比對每門課的 readSec，有變更就重設基準
  // v0.8.9：用 module-level _tickInfoByKey + accountId+cid key，切 tab 不互相覆蓋
  useEffect(() => {
    for (const c of scope) {
      const k = tickKey(accountId, c.cid);
      const prev = _tickInfoByKey.get(k);
      if (!prev || prev.lastReadSec !== c.readSec) {
        _tickInfoByKey.set(k, { lastReadSec: c.readSec, lastSyncAt: Date.now() });
      }
    }
    // 註：不再清掉「沒看到的 cid」— 那是另一個帳號的，留著切回去時還能用。
    // module map 會隨帳號 remove / clear-all 慢慢清，目前沒做主動 GC（小 leak）。
  }, [scope, accountId]);

  // Course list / Log 的拖拉分隔條：用百分比 (0.2 ~ 0.8) 紀錄 Course list 佔下半部的比例。
  const [coursePanelRatio, setCoursePanelRatio] = useState(0.6);
  const splitDragging = useRef(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!splitDragging.current) return;
      const box = splitContainerRef.current;
      if (!box) return;
      const r = box.getBoundingClientRect();
      const ratio = (e.clientY - r.top) / r.height;
      setCoursePanelRatio(Math.max(0.2, Math.min(0.8, ratio)));
    }
    function onUp() {
      splitDragging.current = false;
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

  return (
    <div className="p-6 pb-14 space-y-3 text-slate-100 h-full flex flex-col">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-bold flex items-center gap-1">
          {/* 不再顯示使用者名稱，純粹顯示目前 pipeline 階段。 */}
          {statusLabel(state.status)}
          {state.loginStatus === "relogging" && <span className="text-amber-400 animate-pulse">🔄</span>}
          {state.loginStatus === "failed" && <span className="text-rose-400">❌</span>}
        </h1>
        <div className="flex items-center gap-2">
          {state.status === "running" && (
            <button
              className="px-3 py-1 rounded bg-amber-600 hover:bg-amber-500 text-sm"
              onClick={() => window.api.pause()}
            >
              ⏸ 先停一下
            </button>
          )}
          {state.status === "paused" && (
            <button
              className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-sm"
              onClick={() => window.api.resume()}
            >
              ▶ 繼續上
            </button>
          )}
          <button
            className="px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-sm"
            onClick={() => window.api.backToSelect()}
            title="停下來並回到選課畫面"
          >
            ↩ 回去選課
          </button>
          <button
            className="px-3 py-1 rounded bg-red-700 hover:bg-red-600 text-sm"
            onClick={() => window.api.abort()}
          >
            🛑 全部結束
          </button>
        </div>
      </header>

      {/* 上課中提示：明顯告訴使用者「不要動」 */}
      {(state.status === "running" || state.status === "enrolling") && (
        <div className="bg-emerald-950/60 border-2 border-emerald-600 rounded-lg p-3 text-sm text-emerald-100 shadow">
          <div className="font-bold text-base mb-1">🤖 系統正在自動上課中</div>
          <div className="text-emerald-200">
            請不要操作右邊的網頁，也不要登出，<b>讓它自己跑就好</b>。
            可以最小化視窗去做別的事，但<b>不要關掉</b>。
          </div>
        </div>
      )}

      {state.pauseReason && (
        <div className="bg-amber-950/50 border border-amber-700 rounded p-2 text-sm">
          ⚠️ 已暫停：{state.pauseReason === "session_expired" ? "登入逾時，正在重新登入" : "由你按下暫停"}
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
          已完成 {state.stats.done} / {state.stats.total} 門（{state.stats.progressPct}%）
        </p>
      </div>

      {/* v0.8.13: 題庫預抓進度小 badge */}
      {state.webBankProgress && (
        <div className="text-xs text-slate-400 px-3 py-1 bg-slate-800/50 rounded inline-flex items-center gap-2">
          <span>📥 題庫</span>
          {state.webBankProgress.running ? (
            <span className="text-amber-400">抓取中...</span>
          ) : (
            <span>
              {state.webBankProgress.questionsWritten} 題 ·{" "}
              {state.webBankProgress.coursesHit}/
              {state.webBankProgress.coursesTotal} 課命中
            </span>
          )}
        </div>
      )}

      {/* 上下兩塊（課程列表 / 日誌）+ 中間可拖曳分隔條 */}
      <div ref={splitContainerRef} className="flex-1 flex flex-col min-h-0">
        <section
          className="flex flex-col min-h-0"
          style={{ flex: `1 1 ${coursePanelRatio * 100}%` }}
        >
          <h2 className="text-sm font-semibold mb-2 text-slate-300 shrink-0">
            {scope.length === 0
              ? "📋 上課中（0 門）"
              : running.length === 0
              ? `✅ 全部完成（共 ${scope.length} 門）`
              : `📋 上課中（${running.length} 門 / 全部 ${scope.length} 門）`}
          </h2>
          <div className="flex-1 overflow-auto bg-slate-900/40 rounded p-2 space-y-1 min-h-0">
            {running.map((c) => {
              // 本地 timer：把上次同步到的 readSec 加上經過的秒數，給使用者「動起來」的感覺。
              // 注意：halfway 觸發後 phase 會跳到 "exam" / "survey"，但 reading
              // 心跳還在背景跑。tick 必須持續累加，否則倒數計時器會凍結，UI
              // 看起來像 reading 已經停了（其實沒有）。所以條件改成「還沒到
              // 100%」而不是「phase 還在 reading」。
              // v0.8.9：用 accountId+cid key
              const tickInfo = _tickInfoByKey.get(tickKey(accountId, c.cid));
              const stillReading = c.readSec < c.requiredSec;
              const localExtraSec = tickInfo && stillReading
                ? Math.max(0, Math.floor((Date.now() - tickInfo.lastSyncAt) / 1000))
                : 0;
              const displayReadSec = Math.min(
                c.requiredSec,
                Math.max(0, c.readSec + localExtraSec),
              );
              // 1 位小數的百分比 → 60 分鐘的課每秒會跳一格，使用者看得到「動」。
              const pctNum = c.requiredSec > 0
                ? Math.min(100, (displayReadSec / c.requiredSec) * 100)
                : 0;
              const pct = Math.round(pctNum * 10) / 10;
              const doneMin = Math.floor(displayReadSec / 60);
              const doneSec = displayReadSec % 60;
              const totalMin = Math.floor(c.requiredSec / 60);
              // ① 上課: ✓ ONLY when server-credited reading reaches the
              // requirement. The earlier OR-chain treated reading as done the
              // moment phase advanced to "exam"/"survey" via the halfway
              // trigger — that lied to the user about course completion when
              // ~50% of reading time still owed.
              const readingDone = displayReadSec >= c.requiredSec;
              const examDoneFlag = c.examDone || c.phase === "done";
              const surveyDoneFlag = c.surveyDone || c.phase === "done";
              // After halfway, the chain fires exam + survey concurrently
              // while reading keeps accruing in the background — all three
              // steps can be simultaneously "active" (pulsing). chainStarted
              // = phase has moved past plain "reading" / pre-pipeline states.
              const chainStarted =
                c.phase === "exam" ||
                c.phase === "survey" ||
                c.phase === "verifying" ||
                c.phase === "done";
              const stepClass = (done: boolean, active: boolean) =>
                done
                  ? "bg-emerald-600 text-white"
                  : active
                  ? "bg-amber-500 text-white animate-pulse"
                  : "bg-slate-700 text-slate-400";
              // Reading is "active" whenever it isn't done (heartbeat starts
              // the moment the course enters the run). Exam/survey light up
              // once the chain has fired, even if reading hasn't hit 100% yet.
              const readingActive = !readingDone;
              const examActive = !examDoneFlag && (chainStarted || readingDone);
              const surveyActive = !surveyDoneFlag && (chainStarted || readingDone);
              const verifying = c.phase === "verifying";
              const remainingSec = Math.max(0, c.requiredSec - displayReadSec);
              const remainingMin = Math.floor(remainingSec / 60);
              const remainingS = remainingSec % 60;
              return (
                <div
                  key={c.cid}
                  className="text-sm px-2 py-1.5 rounded bg-slate-800/30"
                >
                  <div className="flex justify-between items-baseline gap-2">
                    <span className="truncate flex-1">{c.name}</span>
                    <span className="text-[10px] text-slate-500 whitespace-nowrap">#{c.cid}</span>
                  </div>
                  <div className="flex justify-between items-center gap-2 mt-0.5">
                    <div className="flex-1 h-1.5 bg-slate-900/60 rounded overflow-hidden">
                      <div
                        className="h-full bg-emerald-500 transition-all"
                        style={{ width: `${pctNum}%` }}
                      />
                    </div>
                    <span className="text-[11px] font-mono text-slate-300 whitespace-nowrap">
                      {pct.toFixed(1)}% · 已上 {doneMin}:{String(doneSec).padStart(2, "0")} / 共 {totalMin} 分
                    </span>
                  </div>
                  {/* Countdown stays visible until reading really hits 100%,
                      even after halfway has flipped phase past "reading". */}
                  {!readingDone && (
                    <div className="text-[11px] text-amber-200 mt-0.5 font-mono">
                      ⏱ 還剩 {remainingMin} 分 {String(remainingS).padStart(2, "0")} 秒
                    </div>
                  )}
                  {/* 三步驟：上課 / 測驗 / 問卷 — 各自獨立的 done/active 狀態，
                      halfway 觸發後可以三個同時 active（黃色閃爍）。 */}
                  <div className="flex items-center gap-1 mt-1 text-[10px] flex-wrap">
                    <span className={`px-1.5 py-0.5 rounded ${stepClass(readingDone, readingActive)}`}>
                      {readingDone ? "✓" : "①"} 上課
                    </span>
                    <span className="text-slate-600">›</span>
                    <span className={`px-1.5 py-0.5 rounded ${stepClass(examDoneFlag, examActive)}`}>
                      {examDoneFlag ? "✓" : "②"} 測驗
                    </span>
                    <span className="text-slate-600">›</span>
                    <span className={`px-1.5 py-0.5 rounded ${stepClass(surveyDoneFlag, surveyActive)}`}>
                      {surveyDoneFlag ? "✓" : "③"} 問卷
                    </span>
                    {verifying && (
                      <span className="ml-1 px-1.5 py-0.5 rounded bg-sky-700/40 text-sky-200 animate-pulse">
                        等系統確認過關…
                      </span>
                    )}
                    {/* v0.8.8：跨帳號排隊中 — 別的帳號正在上同一堂課，這個帳號排隊
                     *  等候。每 15s 重試一次取得擁有權。 */}
                    {c.waitingForOwner && (
                      <span className="ml-1 px-1.5 py-0.5 rounded bg-amber-700/40 text-amber-200">
                        ⏸ 等候 {c.waitingForOwner} 上完
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
            {running.length === 0 && (
              <div className="text-slate-500 text-sm">（目前沒有正在上的課）</div>
            )}
          </div>
        </section>

        {/* 拖曳分隔條 */}
        <div
          className="h-1.5 my-2 rounded bg-slate-700 hover:bg-emerald-500 cursor-row-resize shrink-0 select-none"
          onMouseDown={(e) => {
            e.preventDefault();
            splitDragging.current = true;
            document.body.style.cursor = "row-resize";
            document.body.style.userSelect = "none";
          }}
          title="上下拖曳，調整課程列表 / 系統訊息 的高度"
        />

        <section
          className="flex flex-col min-h-0"
          style={{ flex: `1 1 ${(1 - coursePanelRatio) * 100}%` }}
        >
          <h2 className="text-sm font-semibold mb-2 text-slate-300 shrink-0">📜 系統訊息</h2>
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
    </div>
  );
}

function statusLabel(s: AppState["status"]): string {
  switch (s) {
    case "enrolling":
      return "🚀 報名中";
    case "running":
      return "▶️ 上課中";
    case "paused":
      return "⏸ 已暫停";
    case "done":
      return "✅ 全部完成";
    case "aborted":
      return "🛑 已停止";
    default:
      return s;
  }
}

// ── 多帳號 UI（v0.8.0） ────────────────────────────────────────

/**
 * Picker layout：mode === picker / pin / reset_pin / boot 時顯示。
 * BrowserView 在這個 layout 下會被縮成 0×0（PickerLayout 不放
 * #browserview-mount，因此 main 拿不到實 bounds）。
 */
function PickerLayout({
  state,
  showFirstRunHelp,
  onCloseFirstRunHelp,
}: {
  state: AppState;
  showFirstRunHelp: boolean;
  onCloseFirstRunHelp: () => void;
}) {
  // BrowserView 必須縮起來，否則會蓋住 picker
  useHideBrowserViewWhileMounted();
  const { multi } = state;
  return (
    <div className="h-screen w-screen bg-gradient-to-br from-slate-950 to-slate-900 text-slate-100 flex flex-col items-center justify-center px-6 py-10 relative overflow-auto">
      <div className="text-center mb-10">
        <h1 className="text-3xl font-bold mb-2">誰要刷課？</h1>
        <p className="text-sm text-slate-400">
          選一個使用者，輸入 4 位數 PIN 開始；或者「+」新增另一個帳號
        </p>
      </div>

      <PickerTiles state={state} />

      <div className="mt-10 flex gap-3 text-xs text-slate-400">
        {multi.tabs.length > 0 && (
          <button
            className="px-3 py-1.5 rounded border border-slate-700 hover:bg-slate-800 hover:text-slate-200"
            onClick={() => {
              // 找第一個 active=false 但 isOpen=true 的 tab，回到它（其實這條路徑很少踩到）
              const t = multi.tabs[0];
              if (t) window.api.switchActiveAccount(t.id);
            }}
            title="把畫面切回正在背景跑的 tab"
          >
            ↩ 回到背景的 tab
          </button>
        )}
        {multi.pickerAccounts.length > 0 && (
          <button
            className="px-3 py-1.5 rounded border border-rose-900 text-rose-300 hover:bg-rose-950"
            onClick={async () => {
              if (
                !window.confirm(
                  "全域清除：把所有帳號的紀錄、PIN、cookies 全清掉，回到空白 picker。\n\n（如果有正在跑的課會被中止）\n\n確定？",
                )
              )
                return;
              await window.api.clearAllAccounts();
            }}
          >
            🗑 全域清除（清掉所有帳號）
          </button>
        )}
      </div>

      {multi.mode === "pin" && multi.pinTarget && <PinModal target={multi.pinTarget} />}
      {multi.mode === "reset_pin" && multi.resetPin && (
        <ResetPinModal target={multi.resetPin} />
      )}

      {showFirstRunHelp && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70">
          <FirstRunHelpCard onClose={onCloseFirstRunHelp} />
        </div>
      )}
    </div>
  );
}

function PickerTiles({ state }: { state: AppState }) {
  const accounts = state.multi.pickerAccounts;
  return (
    <div className="flex flex-wrap gap-5 justify-center max-w-5xl">
      {accounts.map((a) => (
        <PickerTile key={a.id} account={a} />
      ))}
      <AddAccountTile />
    </div>
  );
}

function PickerTile({ account }: { account: NonNullable<AppState["multi"]["pickerAccounts"][number]> }) {
  const [showSettings, setShowSettings] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [editingNickname, setEditingNickname] = useState(false);
  const [editingPin, setEditingPin] = useState(false);
  const [nicknameValue, setNicknameValue] = useState(account.nickname);
  const [err, setErr] = useState<string | null>(null);

  function startUnlock() {
    if (account.isOpen) {
      // 已經 open 直接 switch
      window.api.switchActiveAccount(account.id);
    } else {
      window.api.beginUnlock(account.id);
    }
  }

  async function saveNickname() {
    const n = nicknameValue.trim();
    if (!n) return setErr("暱稱不能為空");
    const res = await window.api.setAccountNickname({ id: account.id, nickname: n });
    if (!res.ok) return setErr(res.reason ?? "存不起來");
    setEditingNickname(false);
    setErr(null);
  }

  return (
    <div className="relative group">
      <button
        onClick={startUnlock}
        className={`w-44 h-52 rounded-xl border-2 flex flex-col items-center justify-center gap-3 transition ${
          account.isActive
            ? "border-emerald-400 bg-emerald-950/30"
            : account.isOpen
              ? "border-sky-700 bg-slate-800 hover:border-sky-400"
              : "border-slate-700 bg-slate-900 hover:border-emerald-500 hover:bg-slate-800"
        }`}
      >
        <div className="w-20 h-20 rounded-full bg-gradient-to-br from-emerald-500 to-sky-600 flex items-center justify-center text-3xl">
          {account.nickname.slice(0, 1) || "?"}
        </div>
        <div className="text-base font-semibold text-slate-100 truncate w-36 text-center">
          {account.nickname}
        </div>
        <div className="text-xs text-slate-500 font-mono">{account.maskedAccount}</div>
        {account.isOpen && (
          <div className="text-[10px] text-sky-400">
            {account.pipelineRunning
              ? `🟢 跑課中 ${account.doneCount ?? 0}/${account.totalCount ?? 0}`
              : "● 已開啟"}
          </div>
        )}
      </button>
      <button
        className="absolute top-2 right-2 w-7 h-7 rounded-full bg-slate-700/80 hover:bg-slate-600 text-slate-200 text-sm opacity-0 group-hover:opacity-100 transition"
        onClick={(e) => {
          e.stopPropagation();
          setShowSettings(true);
        }}
        title="設定"
      >
        ⚙
      </button>

      {showSettings && (
        <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/70">
          <ModalGuard>
            <div className="bg-slate-900 border border-slate-700 rounded-lg max-w-sm w-[92vw] p-6 shadow-2xl">
              <h2 className="text-lg font-semibold text-slate-100 mb-3">
                ⚙ {account.nickname}
              </h2>
              <p className="text-xs text-slate-500 mb-4 font-mono">{account.maskedAccount}</p>

              <div className="space-y-2 mb-4">
                {editingNickname ? (
                  <div className="flex gap-2">
                    <input
                      autoFocus
                      className="flex-1 px-2 py-1 rounded bg-slate-800 border border-slate-700 text-sm"
                      value={nicknameValue}
                      onChange={(e) => setNicknameValue(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && saveNickname()}
                      placeholder="新暱稱"
                    />
                    <button
                      className="px-3 py-1 rounded bg-emerald-600 text-white text-xs"
                      onClick={saveNickname}
                    >
                      存
                    </button>
                    <button
                      className="px-3 py-1 rounded bg-slate-700 text-slate-300 text-xs"
                      onClick={() => {
                        setEditingNickname(false);
                        setNicknameValue(account.nickname);
                        setErr(null);
                      }}
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <button
                    className="w-full text-left px-3 py-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm"
                    onClick={() => setEditingNickname(true)}
                  >
                    ✏️ 改暱稱
                  </button>
                )}
                <button
                  className="w-full text-left px-3 py-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm"
                  onClick={() => setEditingPin(true)}
                >
                  🔢 改 PIN（要先輸入舊 PIN）
                </button>
                <button
                  className="w-full text-left px-3 py-2 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm"
                  onClick={() => {
                    setShowSettings(false);
                    window.api.resetPinBegin(account.id);
                  }}
                >
                  ❓ 忘記 PIN（用 e 等密碼重設）
                </button>
                <button
                  className={`w-full text-left px-3 py-2 rounded text-sm ${
                    confirmingRemove
                      ? "bg-rose-800 hover:bg-rose-700 text-rose-50"
                      : "bg-slate-800 hover:bg-slate-700 text-rose-300"
                  }`}
                  onClick={async () => {
                    if (!confirmingRemove) {
                      setConfirmingRemove(true);
                      return;
                    }
                    await window.api.removeAccount(account.id);
                    setShowSettings(false);
                  }}
                >
                  {confirmingRemove
                    ? "⚠ 再點一次：徹底移除這個帳號"
                    : "🗑 移除這個帳號"}
                </button>
              </div>

              {err && <div className="text-xs text-rose-400 mb-2">{err}</div>}

              <div className="flex justify-end">
                <button
                  className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm"
                  onClick={() => {
                    setShowSettings(false);
                    setEditingNickname(false);
                    setEditingPin(false);
                    setConfirmingRemove(false);
                    setNicknameValue(account.nickname);
                    setErr(null);
                  }}
                >
                  關閉
                </button>
              </div>
            </div>
          </ModalGuard>
        </div>
      )}

      {editingPin && (
        <ChangePinModal
          accountId={account.id}
          onClose={() => setEditingPin(false)}
        />
      )}
    </div>
  );
}

function AddAccountTile() {
  const [showForm, setShowForm] = useState(false);
  return (
    <>
      <button
        onClick={() => setShowForm(true)}
        className="w-44 h-52 rounded-xl border-2 border-dashed border-slate-600 flex flex-col items-center justify-center gap-2 hover:border-emerald-500 hover:bg-slate-800/50 transition"
        title="新增另一個 e 等公務園帳號"
      >
        <div className="text-5xl text-slate-500">+</div>
        <div className="text-sm text-slate-400">新增帳號</div>
      </button>
      {showForm && <NewAccountFormModal onClose={() => setShowForm(false)} />}
    </>
  );
}

/**
 * v0.8.1：新增帳號表單。一次填齊「e 等帳號 / 密碼 / 暱稱 / PIN」，main 用 net.request
 * 走靜默 SSO，使用者不必碰右邊網頁。
 *
 * v0.7.x ~ v0.8.0：先點 tile → 主程序開 BrowserView → 使用者在右邊 web 登入 →
 * sniffer 攔 GetApTicketV2 → 跳 post_login modal → 補暱稱 + PIN。
 * 問題：右側 web 偶爾會被 hahow / SSO 跨網域擋住、使用者不確定要在哪填、
 *      cancel 路徑很多坑（pendingNewSessionId leak）。改回左側表單最直觀。
 */
function NewAccountFormModal({ onClose }: { onClose: () => void }) {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // v0.8.11：第一次登入要先啟用帳號 — main 回的 result 帶 activationRequired 跟
  // activationUrl；renderer 在錯誤訊息下方多顯示一個「前往啟用帳號」按鈕，點了
  // 用 shell.openExternal 開外部瀏覽器。
  const [activationUrl, setActivationUrl] = useState<string | null>(null);

  const canSubmit =
    account.trim().length >= 2 &&
    password.length >= 1 &&
    nickname.trim().length >= 1 &&
    /^\d{4}$/.test(pin);

  async function submit() {
    if (busy || !canSubmit) return;
    setBusy(true);
    setErr(null);
    setActivationUrl(null);
    try {
      const res = await window.api.addAccountSubmit({
        account: account.trim(),
        password,
        nickname: nickname.trim(),
        pin,
      });
      if (!res.ok) {
        setErr(res.reason ?? "新增失敗");
        if (res.activationRequired) {
          // 抓到的就用，沒抓到 fallback 到 ecpa.dgpa.gov.tw 首頁
          setActivationUrl(res.activationUrl ?? "https://ecpa.dgpa.gov.tw/");
        }
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function openActivation() {
    if (!activationUrl) return;
    const r = await window.api.openExternalUrl(activationUrl);
    if (!r.ok) {
      setErr((prev) =>
        (prev ? prev + "\n" : "") + `打開啟用頁失敗：${r.reason ?? "?"}（請手動到 ecpa.dgpa.gov.tw 找啟用）`,
      );
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80">
      <ModalGuard>
        <div className="bg-slate-900 border border-emerald-700 rounded-lg max-w-md w-[92vw] p-6 shadow-2xl text-slate-100">
          <h2 className="text-xl font-semibold mb-2">新增 e 等公務園帳號</h2>
          <p className="text-sm text-slate-400 mb-4 leading-relaxed">
            填完按「新增」，會直接在背景登入 e 等公務園 — 不用碰右邊的網頁。
          </p>
          <div className="space-y-3">
            <label className="block text-xs text-slate-400">
              e 等公務園 帳號
              <input
                autoFocus
                disabled={busy}
                className="mt-1 w-full px-3 py-2 rounded bg-slate-800 border border-slate-700 focus:outline-none focus:border-emerald-500 text-slate-100 font-mono"
                placeholder="身分證字號 / 別名"
                value={account}
                onChange={(e) => {
                  setAccount(e.target.value);
                  setErr(null);
                }}
                maxLength={20}
              />
            </label>
            <label className="block text-xs text-slate-400">
              密碼
              <input
                type="password"
                disabled={busy}
                className="mt-1 w-full px-3 py-2 rounded bg-slate-800 border border-slate-700 focus:outline-none focus:border-emerald-500 text-slate-100"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setErr(null);
                }}
                maxLength={64}
              />
            </label>
            <label className="block text-xs text-slate-400">
              暱稱（tab 上會顯示這個）
              <input
                disabled={busy}
                className="mt-1 w-full px-3 py-2 rounded bg-slate-800 border border-slate-700 focus:outline-none focus:border-emerald-500 text-slate-100"
                placeholder="例如「公務帳」、「我」"
                value={nickname}
                onChange={(e) => {
                  setNickname(e.target.value);
                  setErr(null);
                }}
                maxLength={20}
              />
            </label>
            <label className="block text-xs text-slate-400">
              4 位數 PIN（每次切到這個帳號要輸入）
              <input
                type="password"
                inputMode="numeric"
                pattern="\d*"
                maxLength={4}
                disabled={busy}
                className="mt-1 w-full text-center text-2xl tracking-[1em] py-3 rounded bg-slate-800 border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono text-slate-100"
                placeholder="••••"
                value={pin}
                onChange={(e) => {
                  setPin(e.target.value.replace(/\D/g, "").slice(0, 4));
                  setErr(null);
                }}
                onKeyDown={(e) => e.key === "Enter" && canSubmit && submit()}
              />
            </label>
          </div>
          {err && (
            <div className="text-rose-400 text-sm mt-3 whitespace-pre-line">{err}</div>
          )}
          {activationUrl && (
            // v0.8.11：第一次登入要先啟用 — 提供一鍵打開啟用頁的按鈕（外部瀏覽
            // 器）。錯誤訊息裡 eCPA 給的「請點選這裡」連結在 modal 裡是純文字
            // 點不到，這個按鈕把它變成可點。
            <div className="mt-3 p-3 rounded bg-amber-950/30 border border-amber-800">
              <p className="text-xs text-amber-200 mb-2">
                eCPA 第一次登入需要先啟用帳號。點下面的按鈕會開外部瀏覽器到啟用頁，
                <strong>啟用完再回來這裡按一次「新增」</strong>。
              </p>
              <button
                onClick={openActivation}
                className="px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold"
              >
                🌐 前往啟用帳號
              </button>
            </div>
          )}
          <div className="flex justify-between items-center mt-5">
            <button
              className="text-xs text-slate-400 hover:text-slate-200 disabled:opacity-50"
              onClick={onClose}
              disabled={busy}
            >
              取消
            </button>
            <button
              className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold disabled:opacity-50"
              onClick={submit}
              disabled={busy || !canSubmit}
            >
              {busy ? "登入中…" : "新增"}
            </button>
          </div>
        </div>
      </ModalGuard>
    </div>
  );
}

function PinModal({
  target,
}: {
  target: NonNullable<AppState["multi"]["pinTarget"]>;
}) {
  // v0.8.12：鎖定狀態下 PinModal 顯示時要把 BrowserView 藏到 0×0；不然視窗
  // resize 觸發 ResizeObserver → pushBrowserViewBounds 把 view 推回正常 bounds
  // → 蓋住 PIN modal。useHideBrowserViewWhileMounted 把 _modalDepth 加 1 讓
  // pushBrowserViewBounds 變 no-op。
  useHideBrowserViewWhileMounted();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  async function submit() {
    if (busy) return;
    if (!/^\d{4}$/.test(pin)) {
      setErr("PIN 必須是 4 位數字");
      return;
    }
    setBusy(true);
    try {
      const res = await window.api.verifyPin(target.id, pin);
      if (!res.ok) {
        setErr(res.reason ?? "PIN 不正確");
        setPin("");
        setTimeout(() => inputRef.current?.focus(), 0);
      }
      // 成功時 main 會 push state，UI 自動轉場
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80">
      <div className="bg-slate-900 border border-slate-700 rounded-lg max-w-sm w-[92vw] p-6 shadow-2xl text-slate-100">
        <h2 className="text-lg font-semibold mb-1">輸入 {target.nickname} 的 PIN</h2>
        <p className="text-xs text-slate-500 mb-4 font-mono">{target.maskedAccount}</p>

        <input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          pattern="\d*"
          maxLength={4}
          className="w-full text-center text-2xl tracking-[1em] py-3 rounded bg-slate-800 border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono"
          placeholder="••••"
          value={pin}
          onChange={(e) => {
            setPin(e.target.value.replace(/\D/g, "").slice(0, 4));
            setErr(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          disabled={busy}
        />
        {err && (
          <div className="text-rose-400 text-sm mt-2">
            {err}
            {target.failedAttempts && target.failedAttempts >= 1
              ? ` (錯 ${target.failedAttempts} 次)`
              : ""}
          </div>
        )}

        <div className="flex justify-between items-center mt-5">
          <button
            className="text-xs text-slate-400 hover:text-slate-200"
            onClick={() => {
              window.api.cancelUnlock();
              window.api.resetPinBegin(target.id);
            }}
          >
            忘記 PIN？
          </button>
          <div className="flex gap-2">
            <button
              className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm"
              onClick={() => window.api.cancelUnlock()}
              disabled={busy}
            >
              取消
            </button>
            <button
              className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold disabled:opacity-50"
              onClick={submit}
              disabled={busy || pin.length !== 4}
            >
              {busy ? "驗證中…" : "解鎖"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ResetPinModal({
  target,
}: {
  target: NonNullable<AppState["multi"]["resetPin"]>;
}) {
  const [password, setPassword] = useState("");
  const [newPin, setNewPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submitVerify() {
    if (busy) return;
    if (!password) {
      setErr("請輸入 e 等公務園的密碼");
      return;
    }
    setBusy(true);
    try {
      const res = await window.api.resetPinVerify({ id: target.id, password });
      if (!res.ok) {
        setErr(res.reason ?? "密碼不對");
      }
    } finally {
      setBusy(false);
    }
  }

  async function submitSet() {
    if (busy) return;
    if (!/^\d{4}$/.test(newPin)) {
      setErr("PIN 必須是 4 位數字");
      return;
    }
    setBusy(true);
    try {
      const res = await window.api.resetPinComplete({ id: target.id, newPin });
      if (!res.ok) setErr(res.reason ?? "存不起來");
      // 成功 main 會 push state 翻回 picker
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80">
      <div className="bg-slate-900 border border-slate-700 rounded-lg max-w-sm w-[92vw] p-6 shadow-2xl text-slate-100">
        <h2 className="text-lg font-semibold mb-1">忘記 PIN：{target.nickname}</h2>
        {target.stage === "verify" ? (
          <>
            <p className="text-xs text-slate-400 mb-3 leading-relaxed">
              請輸入這個帳號的 e 等公務園密碼，驗證通過就可以重設 PIN。
            </p>
            <input
              type="password"
              autoFocus
              className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-700 focus:outline-none focus:border-emerald-500"
              placeholder="e 等公務園密碼"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setErr(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && submitVerify()}
              disabled={busy}
            />
            {err && (
              <div className="text-rose-400 text-sm mt-2">
                {err}
                {target.failedAttempts && target.failedAttempts >= 1
                  ? ` (錯 ${target.failedAttempts} 次)`
                  : ""}
              </div>
            )}
            <div className="flex justify-end gap-2 mt-5">
              <button
                className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm"
                onClick={() => window.api.resetPinCancel()}
                disabled={busy}
              >
                取消
              </button>
              <button
                className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold disabled:opacity-50"
                onClick={submitVerify}
                disabled={busy}
              >
                {busy ? "驗證中…" : "驗證"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-slate-400 mb-3">密碼驗過了，請設定新的 4 位數 PIN。</p>
            <input
              type="password"
              inputMode="numeric"
              pattern="\d*"
              maxLength={4}
              autoFocus
              className="w-full text-center text-2xl tracking-[1em] py-3 rounded bg-slate-800 border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono"
              placeholder="••••"
              value={newPin}
              onChange={(e) => {
                setNewPin(e.target.value.replace(/\D/g, "").slice(0, 4));
                setErr(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && submitSet()}
              disabled={busy}
            />
            {err && <div className="text-rose-400 text-sm mt-2">{err}</div>}
            <div className="flex justify-end gap-2 mt-5">
              <button
                className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm"
                onClick={() => window.api.resetPinCancel()}
                disabled={busy}
              >
                取消
              </button>
              <button
                className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold disabled:opacity-50"
                onClick={submitSet}
                disabled={busy || newPin.length !== 4}
              >
                {busy ? "存中…" : "設定新 PIN"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ChangePinModal({
  accountId,
  onClose,
}: {
  accountId: string;
  onClose: () => void;
}) {
  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    if (!/^\d{4}$/.test(oldPin) || !/^\d{4}$/.test(newPin)) {
      setErr("舊 PIN 跟新 PIN 都要 4 位數字");
      return;
    }
    setBusy(true);
    try {
      const res = await window.api.setAccountPin({ id: accountId, oldPin, newPin });
      if (!res.ok) {
        setErr(res.reason ?? "失敗");
      } else {
        onClose();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/80">
      <div className="bg-slate-900 border border-slate-700 rounded-lg max-w-sm w-[92vw] p-6 shadow-2xl text-slate-100">
        <h2 className="text-lg font-semibold mb-3">改 PIN</h2>
        <input
          type="password"
          inputMode="numeric"
          pattern="\d*"
          maxLength={4}
          autoFocus
          className="w-full mb-2 px-3 py-2 rounded bg-slate-800 border border-slate-700 text-center font-mono tracking-[0.5em]"
          placeholder="舊 PIN"
          value={oldPin}
          onChange={(e) => {
            setOldPin(e.target.value.replace(/\D/g, "").slice(0, 4));
            setErr(null);
          }}
          disabled={busy}
        />
        <input
          type="password"
          inputMode="numeric"
          pattern="\d*"
          maxLength={4}
          className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-700 text-center font-mono tracking-[0.5em]"
          placeholder="新 PIN"
          value={newPin}
          onChange={(e) => {
            setNewPin(e.target.value.replace(/\D/g, "").slice(0, 4));
            setErr(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          disabled={busy}
        />
        {err && <div className="text-rose-400 text-sm mt-2">{err}</div>}
        <div className="flex justify-end gap-2 mt-5">
          <button
            className="px-4 py-2 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button
            className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold disabled:opacity-50"
            onClick={submit}
            disabled={busy}
          >
            {busy ? "存中…" : "存"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PostLoginCard({ accountId }: { accountId: string }) {
  const [nickname, setNickname] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    const n = nickname.trim();
    if (!n) {
      setErr("暱稱不能為空");
      return;
    }
    if (!/^\d{4}$/.test(pin)) {
      setErr("PIN 必須是 4 位數字");
      return;
    }
    setBusy(true);
    try {
      const res = await window.api.finishNewAccount({ nickname: n, pin });
      if (!res.ok) setErr(res.reason ?? "存不起來");
    } finally {
      setBusy(false);
    }
  }

  void accountId; // 沒直接用到 — finishNewAccount 在 main 內部從 pendingNewSessionId 拿

  return (
    <div className="bg-slate-900 border border-emerald-700 rounded-lg max-w-md w-[92vw] p-6 shadow-2xl text-slate-100">
      <h2 className="text-xl font-semibold mb-2">🎉 登入成功！</h2>
      <p className="text-sm text-slate-300 mb-4 leading-relaxed">
        幫這個帳號取一個暱稱（tab 上會顯示這個名稱）
        跟一組 4 位數 PIN（每次切換到這個帳號要輸入）
      </p>
      <div className="space-y-3">
        <input
          autoFocus
          className="w-full px-3 py-2 rounded bg-slate-800 border border-slate-700 focus:outline-none focus:border-emerald-500"
          placeholder="暱稱（例如「公務帳」「我」）"
          value={nickname}
          onChange={(e) => {
            setNickname(e.target.value);
            setErr(null);
          }}
          maxLength={20}
          disabled={busy}
        />
        <input
          type="password"
          inputMode="numeric"
          pattern="\d*"
          maxLength={4}
          className="w-full text-center text-2xl tracking-[1em] py-3 rounded bg-slate-800 border border-slate-700 focus:outline-none focus:border-emerald-500 font-mono"
          placeholder="4 位數 PIN"
          value={pin}
          onChange={(e) => {
            setPin(e.target.value.replace(/\D/g, "").slice(0, 4));
            setErr(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          disabled={busy}
        />
      </div>
      {err && <div className="text-rose-400 text-sm mt-3">{err}</div>}
      <div className="flex justify-between items-center mt-5">
        <button
          className="text-xs text-slate-400 hover:text-rose-300"
          onClick={() => window.api.addAccountCancel()}
          disabled={busy}
        >
          取消新增（丟掉這個登入）
        </button>
        <button
          className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold disabled:opacity-50"
          onClick={submit}
          disabled={busy || !nickname.trim() || pin.length !== 4}
        >
          {busy ? "存中…" : "完成"}
        </button>
      </div>
    </div>
  );
}

function TabBar({ state }: { state: AppState }) {
  const { multi } = state;
  if (multi.tabs.length === 0) return null;
  return (
    <div className="flex items-stretch bg-slate-950 border-b border-slate-800 select-none shrink-0">
      {multi.tabs.map((t) => (
        <Tab key={t.id} tab={t} />
      ))}
      <button
        className="px-3 text-slate-500 hover:text-emerald-300 hover:bg-slate-900 text-sm border-l border-slate-800"
        onClick={() => window.api.goPicker()}
        title="切回 picker，可以選別的帳號 / 新增帳號"
      >
        +
      </button>
      {/* v0.8.2：把 v0.8.1 的「左下 🔒 鎖定」按鈕搬到 tab bar 右側 — 跟左下的偽裝 /
       *  Gemini 重疊不再是問題，而且鎖定本來就是 tab 級操作，放這比較直覺。
       *  只有 active 模式下才顯示（鎖 picker / pin 模式沒意義） */}
      <div className="flex-1" />
      {multi.mode === "active" && multi.activeAccountId && (
        <button
          className="px-3 text-amber-300 hover:text-amber-200 hover:bg-slate-900 text-xs border-l border-slate-800"
          onClick={() => window.api.lockActive()}
          title="鎖定此 tab — 切回時要重輸 PIN（同事走過去看不到課程）。輸入 PIN 後 5 分鐘內切換不需重輸。"
        >
          🔒 鎖定
        </button>
      )}
    </div>
  );
}

function Tab({ tab }: { tab: NonNullable<AppState["multi"]["tabs"][number]> }) {
  const [closing, setClosing] = useState(false);
  return (
    <div
      className={`flex items-center gap-2 px-3 py-1.5 border-r border-slate-800 cursor-pointer ${
        tab.isActive ? "bg-slate-800 text-slate-100" : "text-slate-400 hover:bg-slate-900"
      }`}
      onClick={() => {
        if (!tab.isActive) window.api.switchActiveAccount(tab.id);
      }}
      title={`${tab.nickname}（${tab.maskedAccount}）`}
    >
      <div
        className={`w-2 h-2 rounded-full ${
          tab.pipelineRunning ? "bg-emerald-400 animate-pulse" : tab.isOpen ? "bg-sky-400" : "bg-slate-600"
        }`}
      />
      <span className="text-sm font-medium truncate max-w-[140px]">{tab.nickname}</span>
      {tab.locked && (
        <span className="text-[10px] text-amber-300" title="此 tab 已鎖定 — 切過去要重輸 PIN">
          🔒
        </span>
      )}
      {tab.pipelineRunning && tab.totalCount != null && (
        <span className="text-[10px] text-emerald-300">
          {tab.doneCount ?? 0}/{tab.totalCount}
        </span>
      )}
      <button
        className="ml-1 w-5 h-5 rounded hover:bg-rose-700 hover:text-white text-xs disabled:opacity-50"
        onClick={async (e) => {
          e.stopPropagation();
          if (closing) return;
          if (
            !window.confirm(
              `關閉 ${tab.nickname} 的 tab？\n\n會做：\n• 停掉這個帳號正在跑的 pipeline\n• 把右邊瀏覽器移除\n\n帳號跟 PIN 還會留在 picker，下次可以重新點開。`,
            )
          )
            return;
          setClosing(true);
          try {
            await window.api.closeTab(tab.id);
          } finally {
            setClosing(false);
          }
        }}
        title="關閉這個 tab（停 pipeline、保留帳號）"
      >
        ×
      </button>
    </div>
  );
}
