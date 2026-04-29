/**
 * IPC channel names + shared types between main & renderer.
 * Keep this file small — if a payload is only needed in one side, put it there.
 */

export type AppStatus =
  | "boot"
  | "setup"         // first run: no credentials saved; show onboarding form
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
  /** main → renderer: prompt the user to save freshly-sniffed credentials */
  CREDS_PROMPT_SAVE: "creds:prompt-save",
  /** renderer → main: user accepted / declined the save-creds prompt */
  CREDS_SAVE_ANSWER: "creds:save-answer",
  /** renderer → main: forget the stored credentials */
  CREDS_FORGET: "creds:forget",
  /** renderer → main: query current saved-credentials state */
  CREDS_STATUS: "creds:status",
  /** renderer → main: manually save credentials without the sniffer flow */
  CREDS_SAVE_MANUAL: "creds:save-manual",
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

export interface CredentialsStatus {
  saved: boolean;
  /** Masked account the user can see ("F*****8271") without exposing the full ID */
  maskedAccount?: string;
  savedAt?: string;
  lastUsedAt?: string;
}

export interface CredsPromptPayload {
  /** Masked account for the UI. Server never receives the plain value back. */
  maskedAccount: string;
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
