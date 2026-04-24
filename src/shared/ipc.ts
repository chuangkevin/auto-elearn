/**
 * IPC channel names + shared types between main & renderer.
 * Keep this file small — if a payload is only needed in one side, put it there.
 */

export type AppStatus =
  | "boot"
  | "await_login"
  | "selecting"     // user browsing + ticking courses, before enrollment
  | "enrolling"    // POSTing /enploy/<cid> for each selected course
  | "running"       // heartbeat / exam / survey / rating / reflection pipeline
  | "paused"
  | "done"
  | "aborted";

export type ActionKind =
  | "idle"
  | "enroll"
  | "heartbeat"
  | "exam"
  | "survey"
  | "rating"
  | "reflection";

export interface CourseCard {
  cid: string;
  name: string;
  phase:
    | "pending"
    | "enrolled"
    | "reading"
    | "exam"
    | "survey"
    | "rating"
    | "reflection"
    | "done";
  readSec: number;
  requiredSec: number;
  examDone: boolean;
  surveyDone: boolean;
  ratingDone: boolean;
  reflectionDone: boolean;
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
  user?: { name: string };
  /** cids the user ticked and asked us to process this run */
  pipelineCids?: string[];
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
  /** main → renderer: auto-login in progress / result */
  AUTOLOGIN_PROGRESS: "autologin:progress",
} as const;

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
