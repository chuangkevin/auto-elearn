import type { Session } from "electron";
import { getSigningCourses } from "../http/elearn";
import { fetchCourseDetail, type CourseDetail } from "../http/course-detail";
import { classify, requiredSecondsFor, type Tracked } from "./types";

/** Max parallel /info/{cid} fetches when enriching course state. */
const DETAIL_PARALLEL = 6;

/**
 * Minimal CJS-friendly concurrency limiter (p-limit v6 is ESM-only).
 * Mirrors the helper in heartbeat/engine.ts.
 */
function createLimit(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>((r) => queue.push(r));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}

/**
 * Fetch the user's enrolled courses and classify each one by next phase.
 *
 * For courses where caption is neither "已通過" nor "未報名", we additionally
 * scrape /info/{cid} to learn the true reading-time / exam-score / survey
 * status. The list endpoint's per-phase flags (isReadDones, isExamDones,
 * isSurveyDones) are unreliable — see CLAUDE.md `閱讀完成判斷`.
 */
export async function discover(session: Session): Promise<Tracked[]> {
  const courses = await getSigningCourses(session);
  const limit = createLimit(DETAIL_PARALLEL);

  return Promise.all(
    courses.map((c) =>
      limit(async () => {
        const caption = c.isReadtimeValidCaption ?? "";
        let detail: CourseDetail | null = null;
        // Skip detail fetch for cases the caption already settles —
        // 未報名 means phantom (we'll skip anyway), 已通過 means done.
        if (caption !== "未報名" && caption !== "已通過" && c.isClassing) {
          detail = await fetchCourseDetail(session, c.cid);
        }
        return {
          course: c,
          phase: classify(c, detail),
          readSec: detail?.readSec ?? 0,
          requiredSec: requiredSecondsFor(c),
          detail,
        } as Tracked;
      }),
    ),
  );
}
