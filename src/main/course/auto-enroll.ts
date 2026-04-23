import type { Session } from "electron";
import { primeExplorer, searchCourses, type Course } from "../http/elearn";
import { enrollMany } from "./enrollment";
import { discover } from "./discovery";

const DEFAULT_CATEGORY = "10040389"; // 公務人員 10 小時課程專區

export interface AutoEnrollOptions {
  targetHours: number;
  categories?: string[];
  studentTarget?: string;     // filter by studentTargetTypeCaption
  maxPerRun?: number;
  delayMs?: number;
}

export interface AutoEnrollResult {
  currentCoverageHours: number;
  neededHours: number;
  picked: Course[];
  enrolled: string[];
  failed: string[];
}

/** If the user's enrolled-but-not-failed coverage is below target, enroll more. */
export async function autoEnrollToQuota(
  session: Session,
  opts: AutoEnrollOptions,
): Promise<AutoEnrollResult> {
  const categories = opts.categories?.length ? opts.categories : [DEFAULT_CATEGORY];
  const studentTarget = opts.studentTarget ?? "任何人";
  const maxPerRun = opts.maxPerRun ?? 10;
  const delayMs = opts.delayMs ?? 1000;

  // Current coverage = sum of certification_hours across enrolled, not-expired courses
  const mine = await discover(session);
  const covered = mine
    .filter((m) => m.course.isClassing)
    .reduce((s, m) => s + (m.course.certification_hours || 0), 0);

  const needed = Math.max(0, opts.targetHours - covered);
  if (needed === 0) {
    return {
      currentCoverageHours: covered,
      neededHours: 0,
      picked: [],
      enrolled: [],
      failed: [],
    };
  }

  const already = new Set(mine.map((m) => m.course.cid));

  // Gather candidate pool from categories
  const pool: Course[] = [];
  for (const cat of categories) {
    try {
      await primeExplorer(session, cat);
      const results = await searchCourses(session, cat, "", 50);
      for (const c of results) {
        if (already.has(c.cid)) continue;
        if (!c.isClassing) continue;
        if (studentTarget && c.studentTargetTypeCaption !== studentTarget) continue;
        if ((c.isReadtimeValidCaption ?? "") !== "未報名") continue;
        pool.push(c);
      }
    } catch {
      /* ignore one bad category */
    }
  }

  // Sort: shorter cert_hours first (quick completion)
  pool.sort((a, b) => (a.certification_hours || 0) - (b.certification_hours || 0));

  // Pick until hours covered OR maxPerRun reached
  const picked: Course[] = [];
  let acc = 0;
  for (const c of pool) {
    if (picked.length >= maxPerRun) break;
    if (acc >= needed) break;
    picked.push(c);
    acc += c.certification_hours || 0;
  }

  const results = await enrollMany(
    session,
    picked.map((p) => p.cid),
    delayMs,
  );
  const enrolled = results.filter((r) => r.ok).map((r) => r.cid);
  const failed = results.filter((r) => !r.ok).map((r) => r.cid);

  return {
    currentCoverageHours: covered,
    neededHours: needed,
    picked,
    enrolled,
    failed,
  };
}
