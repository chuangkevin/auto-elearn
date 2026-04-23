import type { Session } from "electron";
import { getSigningCourses } from "../http/elearn";
import { classify, requiredSecondsFor, type Tracked } from "./types";

/** Fetch the user's enrolled courses and classify each one by next phase. */
export async function discover(session: Session): Promise<Tracked[]> {
  const courses = await getSigningCourses(session);
  return courses.map((c) => ({
    course: c,
    phase: classify(c),
    readSec: 0, // unknown from the JSON alone; heartbeat module will fill this after opening the course
    requiredSec: requiredSecondsFor(c),
  }));
}
