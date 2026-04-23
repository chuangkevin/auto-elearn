import type { Course } from "../http/elearn";

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
}

export function classify(c: Course): CoursePhase {
  const caption = c.isReadtimeValidCaption ?? "";
  const readDone = (c.isReadDones ?? 0) === 1;
  const examDone = (c.isExamDones ?? 0) === 1;
  const surveyDone = (c.isSurveyDones ?? 0) === 1;
  const hasExam = c.exam_exists === "1";

  if (caption === "未報名") return "pending";
  if (caption === "已通過") return "done";
  if (!readDone) return "reading";  // includes "尚未通過" w/ incomplete reading
  if (hasExam && !examDone) return "exam";
  if (!surveyDone) return "survey";
  return "rating";
}

export function requiredSecondsFor(c: Course): number {
  return Math.max(0, (c.certification_hours || 0) * 3600);
}
