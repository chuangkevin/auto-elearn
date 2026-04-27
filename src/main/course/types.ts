import type { Course } from "../http/elearn";
import type { CourseDetail } from "../http/course-detail";

export type CoursePhase =
  | "pending"        // not enrolled yet
  | "enrolled"       // enrolled, reading not started
  | "reading"        // heartbeat in progress
  | "reading_done"   // reading complete, exam/survey/rating pending
  | "exam"
  | "survey"
  | "rating"
  | "reflection"
  | "done";

export interface Tracked {
  course: Course;
  phase: CoursePhase;
  readSec: number;
  requiredSec: number;
  lastPingAt?: number;
  /** Detail-page snapshot when available; null if fetch/parse failed. */
  detail?: CourseDetail | null;
}

/**
 * Decide the next phase to act on for a course.
 *
 * Source-of-truth priority:
 *   1. caption == "未報名" → pending (phantom, never enrolled)
 *   2. caption == "已通過" → done (everything passed)
 *   3. Detail-page snapshot (if available): authoritative for reading/exam/survey state.
 *      The list endpoint's `isReadDones` is hardcoded to 0 (CLAUDE.md rule) and
 *      `isExamDones`/`isSurveyDones` are also unreliable in the same listing,
 *      so for any in-progress course we MUST scrape /info/{cid} to know
 *      what's actually outstanding.
 *   4. Fall back to passPercent / per-phase flags from the listing if no detail.
 *   5. Default to "reading".
 */
export function classify(c: Course, detail?: CourseDetail | null): CoursePhase {
  const caption = c.isReadtimeValidCaption ?? "";
  if (caption === "未報名") return "pending";
  if (caption === "已通過") return "done";

  const hasExam = c.exam_exists === "1";

  if (detail) {
    const required = requiredSecondsFor(c);
    const readingDone = detail.readSec !== null && detail.readSec >= required;
    const examScored = detail.examScore !== null;
    const surveyDone = detail.surveyDone === true;

    if (!readingDone && !examScored && !surveyDone) return "reading";
    if (hasExam && !examScored) return "exam";
    if (!surveyDone) return "survey";
    return "rating";
  }

  // No detail snapshot — best-effort from listing only. Per CLAUDE.md,
  // isReadDones is forbidden; rely on the other downstream signals.
  const examDone = (c.isExamDones ?? 0) === 1;
  const surveyDone = (c.isSurveyDones ?? 0) === 1;
  const hasGradingProgress = (c.passPercent ?? 0) > 0;
  const pastReading = examDone || surveyDone || hasGradingProgress;
  if (!pastReading) return "reading";
  if (hasExam && !examDone) return "exam";
  if (!surveyDone) return "survey";
  return "rating";
}

export function requiredSecondsFor(c: Course): number {
  return Math.max(0, (c.certification_hours || 0) * 3600);
}
