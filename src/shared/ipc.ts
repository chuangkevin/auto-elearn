/**
 * IPC channel names + shared types between main & renderer.
 * Keep this file small — if a payload is only needed in one side, put it there.
 */

export type AppStatus =
  | "boot"
  | "await_login"
  | "running"
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
} as const;

export interface ViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
