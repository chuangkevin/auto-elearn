import type { Session } from "electron";
import { enrollCourse } from "../http/elearn";

export interface EnrollResult {
  cid: string;
  ok: boolean;
  status: number;
  errorMsg?: string;
}

/** Enrol a list of course IDs with delay between each (1s), matching original tool. */
export async function enrollMany(
  session: Session,
  cids: string[],
  delayMs = 1000,
): Promise<EnrollResult[]> {
  const out: EnrollResult[] = [];
  for (const cid of cids) {
    try {
      const { ok, status } = await enrollCourse(session, cid);
      out.push({ cid, ok, status });
    } catch (e) {
      out.push({
        cid,
        ok: false,
        status: 0,
        errorMsg: e instanceof Error ? e.message : String(e),
      });
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }
  return out;
}
