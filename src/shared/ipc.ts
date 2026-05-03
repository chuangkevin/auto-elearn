/**
 * IPC channel names + shared types between main & renderer.
 * Keep this file small — if a payload is only needed in one side, put it there.
 */

export type AppStatus =
  | "boot"
  | "setup"         // first run / new-account flow: no credentials saved; show onboarding form
  | "await_login"
  | "selecting"     // user browsing + ticking courses, before enrollment
  | "enrolling"    // POSTing /enploy/<cid> for each selected course
  | "running"       // heartbeat / exam / survey pipeline
  | "paused"
  | "done"
  | "aborted";

export type ActionKind =
  | "idle"
  | "enroll"
  | "heartbeat"
  | "exam"
  | "survey";

export interface CourseCard {
  cid: string;
  name: string;
  /**
   * "verifying" = all three phases are credited in the /info detail snapshot
   * but server's 通過狀態 is still "--"; we're polling for the official flip.
   * "done" = server has confirmed 通過. Only "done" should fire the celebratory
   * UI; "verifying" keeps the spinner up so the UI doesn't lie.
   */
  phase:
    | "pending"
    | "enrolled"
    | "reading"
    | "exam"
    | "survey"
    | "verifying"
    | "done";
  readSec: number;
  requiredSec: number;
  examDone: boolean;
  surveyDone: boolean;
  lastPingAt?: number;
}

export interface LogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  msg: string;
}

/**
 * 多帳號 UI 模式（比 active session 的 status 高一層）：
 *  - boot: app 啟動中
 *  - picker: Netflix tile picker；沒 active 帳號
 *  - pin: 使用者剛點 picker 上某個 tile，正在輸入 PIN
 *  - reset_pin: 「忘記 PIN」流程，要先驗證 elearn 密碼
 *  - post_login: 剛登入新帳號，要使用者設暱稱 + PIN
 *  - active: 有 active 帳號，畫面是該帳號的 selecting/running 等等
 */
export type MultiMode =
  | "boot"
  | "picker"
  | "pin"
  | "reset_pin"
  | "post_login"
  | "active";

export interface AccountSummary {
  id: string;
  nickname: string;
  /** "F*****8271"，UI 永遠拿這個顯示；raw account 不過 IPC 邊界 */
  maskedAccount: string;
  /** 是否已經被開成 tab（有自己的 BrowserView + 可以跑 pipeline） */
  isOpen: boolean;
  /** 是否就是當前 active tab（可見的那個） */
  isActive: boolean;
  /** mirror of per-session AppState.status；只有 isOpen=true 時有意義 */
  status?: AppStatus;
  pipelineRunning: boolean;
  /** v0.8.1：tab 是否被使用者鎖定（切 tab 時需要重輸 PIN）。只有 isOpen=true 時有意義。 */
  locked?: boolean;
  /** 進度徽章用 */
  doneCount?: number;
  totalCount?: number;
  lastUsedAt?: string;
}

export interface MultiInfo {
  mode: MultiMode;
  /** 所有已存 record 的帳號，for tile picker（含 isOpen / isActive 旗標） */
  pickerAccounts: AccountSummary[];
  /** picker 中已 open 的子集合（順序 = tab bar 順序） */
  tabs: AccountSummary[];
  activeAccountId: string | null;
  /** mode==="pin"：要驗哪個 tile 的 PIN */
  pinTarget?: { id: string; nickname: string; maskedAccount: string; failedAttempts?: number };
  /** mode==="reset_pin"：忘記 PIN 流程要驗的帳號 + 進入哪一階段 */
  resetPin?: { id: string; nickname: string; stage: "verify" | "set"; failedAttempts?: number };
  /** mode==="post_login"：剛登入完成的新帳號，請求暱稱 + PIN */
  postLogin?: { id: string; suggestedNickname?: string };
}

export interface AppState {
  status: AppStatus;
  pauseReason?: string;
  /** 已登入使用者；name 已經在 main 端隱碼好（保留首字 + ***），renderer 只負責顯示。 */
  user?: { name: string };
  /** 是否第一次執行（用來決定要不要顯示 SmartScreen 說明）。 */
  isFirstRun?: boolean;
  /** BrowserView session health, updated by the login watchdog */
  loginStatus?: "ok" | "relogging" | "failed";
  /** cids the user ticked and asked us to process this run */
  pipelineCids?: string[];
  /** True when the user viewed the Selecting screen while a pipeline is still
   *  running in the background. Lets the UI flip back to the course picker
   *  without tearing down the pipeline. */
  returnedToSelect?: boolean;
  now: {
    courseId?: string;
    courseName?: string;
    action: ActionKind;
    detail?: string;
    currentQuestion?: {
      text: string;
      answer: string;
      source: "db" | "fuzzy" | "llm" | "random";
    };
  };
  courses: CourseCard[];
  logs: LogEntry[];
  /** Stats are scoped to pipelineCids if set, else all of state.courses. */
  stats: {
    done: number;
    total: number;
    quizzes: number;
    llmCalls: number;
    progressPct: number;
  };
  /** 多帳號層的狀態（picker / tabs / 模式）。永遠存在，renderer 第一個 case 看 multi.mode 決定要 render 什麼。 */
  multi: MultiInfo;
}

export const IPC = {
  /** main → renderer: full state push */
  STATE_PUSH: "state:push",
  /** renderer → main: request current state (one-shot) */
  STATE_GET: "state:get",
  /** renderer → main: layout hint so main can position BrowserView bounds */
  VIEW_BOUNDS: "view:bounds",
  /** renderer → main: user controls */
  ACTION_PAUSE: "action:pause",
  ACTION_RESUME: "action:resume",
  ACTION_ABORT: "action:abort",
  ACTION_BACK: "action:back",
  /** renderer → main: keyword search of the elearn catalogue */
  SEARCH_COURSES: "search:courses",
  /** renderer → main: category-code search (codes like 540, 522, 267) */
  SEARCH_BY_CODES: "search:codes",
  /** renderer → main: unenrol a single course */
  UNENROLL_COURSE: "course:unenroll",
  /** renderer → main: enrol `cids` then run pipeline */
  PIPELINE_START: "pipeline:start",
  /** renderer → main: re-scan dashboard so "繼續上次進度" is fresh */
  REFRESH_COURSES: "courses:refresh",
  /** renderer → main: navigate the embedded BrowserView */
  NAVIGATE_VIEW: "view:navigate",
  /** main → renderer: auto-login in progress / result */
  AUTOLOGIN_PROGRESS: "autologin:progress",
  /** main → renderer: previous run exists, offer to resume */
  RESUME_PROMPT: "resume:prompt",
  /** renderer → main: user answered the resume prompt */
  RESUME_ANSWER: "resume:answer",
  /** main → renderer: pipeline was paused because session expired / offline */
  PIPELINE_PAUSED: "pipeline:paused",
  /** renderer → main: get stealth lock state */
  STEALTH_STATUS: "stealth:status",
  /** renderer → main: try to unlock with secret; returns whether it matched */
  STEALTH_UNLOCK: "stealth:unlock",
  /** renderer → main: first-time set secret */
  STEALTH_SET_SECRET: "stealth:set-secret",
  /** renderer → main: re-lock the app (back to Noteqad) */
  STEALTH_LOCK: "stealth:lock",
  /** renderer → main: 徹底清掉密碼，回到 no_secret 狀態（解除偽裝模式） */
  STEALTH_CLEAR_SECRET: "stealth:clear-secret",
  /** renderer → main: absolute path of userData/config.json (for "your password is stored at..." UI) */
  STEALTH_CONFIG_PATH: "stealth:config-path",
  /** dialog → main: get current Gemini API key (masked) */
  GEMINI_KEY_GET: "gemini:key-get",
  /** dialog → main: save or clear Gemini API key */
  GEMINI_KEY_SET: "gemini:key-set",
  /** renderer → main: open the Gemini key dialog. Legacy — kept so older preload
   *  binaries don't blow up; no-op in main now since the dialog is a React modal
   *  owned by the renderer (v0.6.7 — fix multi-monitor "彈窗跑到別的螢幕"). */
  OPEN_GEMINI_DIALOG: "gemini:open-dialog",
  /** main → renderer: tell renderer to show its React Gemini-key modal. Used by
   *  the OS menu「說明 → 設定 Gemini API Key」click handler (which runs in main)
   *  to forward into the renderer-owned modal. */
  GEMINI_DIALOG_REQUEST: "gemini:dialog-request",
  /** renderer → main: list 次類別 under a 主類別 id */
  CATEGORY_CHILDREN: "category:children",
  /** renderer → main: 標記 SmartScreen 說明已讀過，以後不要再顯示 */
  ACK_FIRST_RUN: "first-run:ack",
  /** renderer → main: renderer 端的 console.error / window 錯誤 forward 到 main 的檔案 log */
  RENDERER_LOG: "renderer:log",
  /** renderer → main: 用 shell.openPath 打開 userData/logs/ 資料夾，讓使用者把 .log 給開發者 */
  OPEN_LOGS_FOLDER: "logs:open-folder",
  /** renderer → main: 取得 app.getVersion()，給偽裝記事本右鍵的「版本」項顯示用 */
  APP_VERSION_GET: "app:version-get",

  // ── 多帳號 (v0.8.0) ─────────────────────────────────────────────
  // v0.8.1：新增帳號改成左側表單一次填齊（帳號／密碼／暱稱／PIN），main 用 net.request
  // 靜默呼 eCPA SSO，不再開右側 BrowserView 給使用者填表 → 不用攔 GetApTicketV2、
  // 沒有 post_login 中間態。舊的 ADD_BEGIN / ADD_CANCEL / FINISH_NEW 仍保留以免
  // pre-built preload 呼叫炸掉，但只 renderer 走表單路徑。
  /** renderer → main: 一次提交全部 → 靜默 SSO + 建 session + 寫 record + 存 PIN */
  ACCOUNT_ADD_SUBMIT: "account:add-submit",
  /** renderer → main: 鎖住指定 tab（active 會切到 PIN 輸入；切 tab 會自動鎖前一個） */
  ACCOUNT_LOCK_TAB: "account:lock-tab",
  /** renderer → main: 鎖住目前 active tab（左下「🔒 鎖定」按鈕用） */
  ACCOUNT_LOCK_ACTIVE: "account:lock-active",
  /** renderer → main: picker tile click → 進入 PIN 輸入模式（main 端記下 pinTarget） */
  ACCOUNT_BEGIN_UNLOCK: "account:begin-unlock",
  /** renderer → main: 提交 PIN，正確 → 開 tab + 設成 active；錯 → multi.pinTarget.failedAttempts++ */
  ACCOUNT_VERIFY_PIN: "account:verify-pin",
  /** renderer → main: 取消 PIN 輸入回 picker */
  ACCOUNT_CANCEL_UNLOCK: "account:cancel-unlock",
  /** renderer → main: tab bar 點某 tab → 切 active（前提 isOpen） */
  ACCOUNT_SWITCH_ACTIVE: "account:switch-active",
  /** renderer → main: tab × 鈕 → 停 pipeline + detach view，但保留 record + PIN */
  ACCOUNT_CLOSE_TAB: "account:close-tab",
  /** renderer → main: tab bar 上的「+」/ 切回 picker：setActiveId(null)，其他 tab 繼續跑 */
  ACCOUNT_GO_PICKER: "account:go-picker",
  /** renderer → main: 「+ 新增帳號」tile click：建立 pending session（fresh BrowserView + partition），進入 setup 流程 */
  ACCOUNT_ADD_BEGIN: "account:add-begin",
  /** renderer → main: 取消新增帳號（detach view + 清 in-memory creds） */
  ACCOUNT_ADD_CANCEL: "account:add-cancel",
  /** renderer → main: 新帳號登入完成（已抓到帳密），使用者填好 nickname + PIN，main 寫入 storage */
  ACCOUNT_FINISH_NEW: "account:finish-new",
  /** renderer → main: 改暱稱（picker tile 設定齒輪） */
  ACCOUNT_SET_NICKNAME: "account:set-nickname",
  /** renderer → main: 改 PIN（要先驗舊 PIN） */
  ACCOUNT_SET_PIN: "account:set-pin",
  /** renderer → main: 點「忘記 PIN」→ 進入 reset_pin 模式 */
  ACCOUNT_RESET_PIN_BEGIN: "account:reset-pin-begin",
  /** renderer → main: reset_pin 階段「verify」：使用者輸入 elearn 密碼，main 比對 storage */
  ACCOUNT_RESET_PIN_VERIFY: "account:reset-pin-verify",
  /** renderer → main: reset_pin 階段「set」：使用者輸入新 PIN */
  ACCOUNT_RESET_PIN_COMPLETE: "account:reset-pin-complete",
  /** renderer → main: 取消 reset_pin 流程 */
  ACCOUNT_RESET_PIN_CANCEL: "account:reset-pin-cancel",
  /** renderer → main: 從 picker 移除單一帳號（停 pipeline、detach、清 partition data + creds + record） */
  ACCOUNT_REMOVE: "account:remove",
  /** renderer → main: active 帳號「登出」回到 picker（停 pipeline + detach view，保留 record + PIN） */
  ACCOUNT_LOGOUT_ACTIVE: "account:logout-active",
  /** renderer → main: 全域清除（清掉所有帳號的 record + creds + partition data + pipeline + tabs） */
  ACCOUNTS_CLEAR_ALL: "accounts:clear-all",
} as const;

export interface SearchOptions {
  /** keyword (course name) */
  keyword?: string;
  /** 主類別 id (lifetime_course_category_1st_level). Empty = all. */
  mainCategoryId?: string;
  /** 次類別 id (lifetime_course_category_2nd_level). Empty = all. */
  subCategoryId?: string;
  /** 加盟專區 id (school_from). Empty / "0" = all. */
  fromSchoolId?: string;
  /** Min cert hours. */
  hoursMin?: number;
  /** Max cert hours. */
  hoursMax?: number;
}

export interface AutoLoginProgress {
  stage: "start" | "filling" | "submitted" | "success" | "failed";
  error?: string;
}

export interface ResumePrompt {
  pipelineCids: string[];
  startedAt: string;
  previousStatus: string;
}

/**
 * Stealth mode — the Noteqad.exe disguise.
 * - `no_secret`: first launch or user has wiped the secret; real UI renders directly
 *   (user can set one later via the hidden gesture File>Exit × 5).
 * - `locked`: app boots into fake Notepad; user must type secret + Enter to unlock.
 * - `unlocked`: secret matched this session; real UI visible; can re-lock on demand.
 */
export type StealthState = "no_secret" | "locked" | "unlocked";

export interface CourseCandidate {
  cid: string;
  caption: string;
  certification_hours: number;
  fromSchoolName?: string;
  studentTargetTypeCaption?: string;
  category_full_path?: string;
  classPeriod?: string;
  isClassing: boolean;
  /** true if the user already signed up previously */
  already_enrolled: boolean;
}

export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Generic 多帳號操作回應 */
export interface AccountOpResult {
  ok: boolean;
  reason?: string;
}
