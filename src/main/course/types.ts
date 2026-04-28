import type { Course } from "../http/elearn";
import type { CourseDetail } from "../http/course-detail";

export type CoursePhase =
  | "pending"        // not enrolled yet
  | "enrolled"       // enrolled, reading not started
  | "reading"        // heartbeat in progress
  | "reading_done"   // reading complete, exam/survey pending
  | "exam"
  | "survey"
  | "verifying"      // all three phases credited; waiting for 通過狀態 flip
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
    // GLOBAL pass-floor 80 — matches the threshold solver uses. A course
    // showing "測驗 60 分 通過狀態:--" should still classify as needing
    // 測驗 (not rating), because 60 < 80 and we want the chain to retake.
    // Use Math.max with the page-declared threshold in case some course
    // demands more than 80.
    const passFloor = Math.max(detail.passingScore ?? 60, 80);
    const examActuallyPassed = detail.examScore !== null && detail.examScore >= passFloor;
    const surveyDone = detail.surveyDone === true;
    const officiallyPassed = detail.passed === true;

    // If server has flipped 通過狀態 to 通過, course is done regardless
    // of any other signal.
    if (officiallyPassed) return "done";

    if (!readingDone && !examActuallyPassed && !surveyDone) return "reading";
    // detail.examScore !== null proves the course HAS an exam — listing's
    // exam_exists is as unreliable as isReadDones (course "我國電動車" v0.4.5
    // bug: listing reported no exam, detail showed 60 分 < 80, classify
    // skipped "exam" branch and returned "rating", lighting ✓ 測驗 falsely).
    const examPresent = hasExam || detail.examScore !== null;
    if (examPresent && !examActuallyPassed) return "exam";
    if (!surveyDone) return "survey";
    // All three phases credited in the snapshot, but officiallyPassed was
    // false above — server hasn't flipped 通過狀態 yet, keep "verifying".
    return "verifying";
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
  return "verifying";
}

export function requiredSecondsFor(c: Course): number {
  return Math.max(0, (c.certification_hours || 0) * 3600);
}
