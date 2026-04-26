import type { Session } from "electron";
import { elearnRequest } from "./client";

const BASE = "https://elearn.hrd.gov.tw";

export interface Course {
  cid: string;
  caption: string;
  certification_hours: number;
  content?: string;
  category_full_path?: string;
  fromSchoolName?: string;
  studentTargetTypeCaption?: string;
  classPeriod?: string;
  isClassing?: boolean;
  isReadtimeValidCaption?: string;
  isReadDones?: number;
  isExamDones?: number;
  isSurveyDones?: number;
  exam_exists?: string;
  passPercent?: number;
  platform?: string;
  portal_cid?: string;
}

/** JSON returned by course_ajax.php is a list of dicts, each dict keyed by `'<sid><cid>'` → course. */
function flattenCourseList(body: string): Course[] {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: Course[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    for (const v of Object.values(entry as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        const c = v as Record<string, unknown>;
        if (c.cid !== undefined) {
          out.push({
            cid: String(c.cid),
            caption: String(c.caption ?? ""),
            certification_hours: Number(c.certification_hours ?? 0),
            content: typeof c.content === "string" ? c.content : undefined,
            category_full_path:
              typeof c.category_full_path === "string" ? c.category_full_path : undefined,
            fromSchoolName:
              typeof c.fromSchoolName === "string" ? c.fromSchoolName : undefined,
            studentTargetTypeCaption:
              typeof c.studentTargetTypeCaption === "string"
                ? c.studentTargetTypeCaption
                : undefined,
            classPeriod: typeof c.classPeriod === "string" ? c.classPeriod : undefined,
            isClassing: Boolean(c.isClassing),
            isReadtimeValidCaption:
              typeof c.isReadtimeValidCaption === "string"
                ? c.isReadtimeValidCaption
                : undefined,
            isReadDones:
              typeof c.isReadDones === "number"
                ? c.isReadDones
                : typeof c.isReadDones === "string"
                ? Number(c.isReadDones) || 0
                : 0,
            isExamDones:
              typeof c.isExamDones === "number"
                ? c.isExamDones
                : typeof c.isExamDones === "string"
                ? Number(c.isExamDones) || 0
                : 0,
            isSurveyDones:
              typeof c.isSurveyDones === "number"
                ? c.isSurveyDones
                : typeof c.isSurveyDones === "string"
                ? Number(c.isSurveyDones) || 0
                : 0,
            exam_exists:
              typeof c.exam_exists === "string" ? c.exam_exists : String(c.exam_exists ?? "0"),
            passPercent:
              typeof c.passPercent === "number"
                ? c.passPercent
                : typeof c.passPercent === "string"
                ? Number(c.passPercent)
                : undefined,
            platform: typeof c.platform === "string" ? c.platform : undefined,
            portal_cid: typeof c.portal_cid === "string" ? c.portal_cid : undefined,
          });
        }
      }
    }
  }
  return out;
}

/** Our already-signed-up courses with per-phase status. */
export async function getSigningCourses(session: Session): Promise<Course[]> {
  const { text } = await elearnRequest(
    session,
    `${BASE}/mooc/controllers/course_ajax.php?course_type=all&page=0`,
    {
      method: "POST",
      body: {
        action: "getSigningCourses",
        id: "new",
        selectPage: "0",
        perpage: "100",
        "course-type": "all",
        keyword: "",
        is_readtime_valid: "",
        sort_by: "registration_time",
      },
      referer: `${BASE}/mooc/user/learn_dashboard.php?tab=1`,
    },
  );
  return flattenCourseList(text);
}

/**
 * Prime /mooc/explorer.php before searching (server requires referer+session state).
 * rootGroupId=10000013 is the top-level grouping; categoryId narrows within.
 */
export async function primeExplorer(session: Session, categoryId: string): Promise<void> {
  await elearnRequest(session, `${BASE}/mooc/explorer.php`, {
    method: "POST",
    body: {
      rootGroupId: "10000013",
      course_category: categoryId,
      t_i_k_2: "d41d8cd98f00b204e9800998ecf8427e",
      csrfToken: "d41d8cd98f00b204e9800998ecf8427e",
    },
    referer: `${BASE}/mooc/index.php`,
  });
}

/** Search site-wide inside a category. Call primeExplorer() first. */
export async function searchCourses(
  session: Session,
  categoryId: string,
  keyword = "",
  perpage = 30,
): Promise<Course[]> {
  const { text } = await elearnRequest(session, `${BASE}/mooc/controllers/course_ajax.php`, {
    method: "POST",
    body: {
      action: "getSearchCourses",
      id: "new",
      perpage: String(perpage),
      categoryId,
      fromSchoolId: "",
      keyword,
      pathname: "/mooc/explorer.php",
      mineEnglish: "N",
    },
    referer: `${BASE}/mooc/explorer.php`,
  });
  return flattenCourseList(text);
}

/** Enrol in a course. Returns true if server responded 2xx/3xx. */
export async function enrollCourse(session: Session, cid: string): Promise<{ ok: boolean; status: number }> {
  const { status } = await elearnRequest(session, `${BASE}/enploy/${cid}`, {
    method: "GET",
    referer: `${BASE}/info/${cid}`,
  });
  return { ok: status >= 200 && status < 400, status };
}

/**
 * Announce to the server that we're entering a reading session for this course.
 * Original `ecpa.js` does `targetFrame.location.href = "/mooc/index.php?ticket=...&cid=..."`
 * BEFORE kicking off the 5s heartbeat loop — without this, the heartbeats are
 * accepted (HTTP 200) but the server has no active reading session to credit
 * time to, so 閱讀時數 stays at 0.
 *
 * We fire the same URL as a plain GET. The response sets whatever session-state
 * cookies the server needs; subsequent heartbeats then count.
 */
export async function enterReadingSession(
  session: Session,
  pTicket: string,
  encCid: string,
  origin: string = BASE,
): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `${origin}/mooc/index.php?ticket=${encodeURIComponent(pTicket)}&cid=${encodeURIComponent(encCid)}`;
  const { status, text } = await elearnRequest(session, url, {
    method: "GET",
    referer: `${origin}/mooc/index.php`,
    // Follow redirects: the server may 302 to the actual reader page; undici
    // must follow so the reading-session server state is established.
    maxRedirections: 10,
  });
  return { ok: status === 200, status, body: text };
}

/**
 * Fetch current server time from the SPOC learning path.
 * Used as `bt` in the actype=start request (real browser does the same).
 * Falls back to local UTC+8 if the request fails.
 */
export async function getServerTime(session: Session, origin: string): Promise<string> {
  try {
    const { text } = await elearnRequest(session, `${origin}/learn/path/getServerTime.php`, {
      method: "GET",
      referer: `${origin}/learn/`,
    });
    // JSON: {"server_time":"2026-04-26 14:10:18"} or {"serverTime":"..."}
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const t = j.server_time ?? j.serverTime ?? j.time;
      if (typeof t === "string" && /\d{4}-\d{2}-\d{2}/.test(t)) return t;
    } catch { /* not JSON */ }
    // XML: <root server_time="2026-04-26 14:10:18"/>
    const m = text.match(/server_time="([^"]+)"/);
    if (m) return m[1];
    // Plain text
    const plain = text.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(plain)) return plain;
  } catch { /* fall through */ }
  // Fallback: local time expressed as UTC+8 (Taiwan standard time)
  const utc8 = new Date(Date.now() + 8 * 3_600_000);
  const fallback = utc8.toISOString().replace("T", " ").slice(0, 19);
  console.log("[SERVER-TIME-FALLBACK]", fallback);
  return fallback;
}

/**
 * Explicitly open a server-side reading session (mirrors what manifest.js does
 * 3 seconds after a lesson is clicked: `setReading('start', 0)`).
 * Returns the server's `timediff` value — use it as `bt` in the first heartbeat.
 *
 * `bt` must be a server timestamp (from `getServerTime()`), not "0" — the server
 * uses this to open a timed reading record; passing "0" returns code:1 but credits
 * zero time.
 * `actid` is the SCORM activity ID (`globalCurrentActivity`) from pathtree.php;
 * without it the server cannot link heartbeats to a lesson.
 */
export async function startReadingSession(
  session: Session,
  pTicket: string,
  encCid: string,
  origin: string = BASE,
  actid?: string,
  bt?: string,
): Promise<{ ok: boolean; status: number; body: string; timediff: string }> {
  const readerUrl = `${origin}/mooc/index.php?ticket=${encodeURIComponent(pTicket)}&cid=${encodeURIComponent(encCid)}`;
  const body: Record<string, string> = {
    action: "setReading",
    type: "start",
    ticket: pTicket,
    enCid: encCid,
    period: "0",
    bt: bt ?? "0",
  };
  if (actid) body.actid = actid;
  console.log("[HB-START-REQ]", JSON.stringify({ url: `${origin}/mooc/controllers/course_record.php?actype=start`, body }));
  const { status, text } = await elearnRequest(
    session,
    `${origin}/mooc/controllers/course_record.php?actype=start`,
    {
      method: "POST",
      body,
      referer: readerUrl,
      originHeader: origin,
    },
  );
  let timediff = "0";
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.timediff !== undefined) timediff = String(parsed.timediff);
  } catch { /* ignore parse errors */ }
  console.log("[HB-START-RES]", text.slice(0, 300));
  return { ok: status >= 200 && status < 400, status, body: text, timediff };
}

/**
 * Signal reading completion (mirrors the browser's actype=finish call that
 * fires after the SCORM player calls LMSFinish).  The server uses this to
 * flip isReadDones to 1 once accumulated reading time is satisfied.
 */
export async function finishReadingSession(
  session: Session,
  pTicket: string,
  encCid: string,
  origin: string = BASE,
  actid?: string,
  bt = "0",
): Promise<{ ok: boolean; status: number; body: string }> {
  const readerUrl = `${origin}/mooc/index.php?ticket=${encodeURIComponent(pTicket)}&cid=${encodeURIComponent(encCid)}`;
  const body: Record<string, string> = {
    action: "setReading",
    type: "finish",
    ticket: pTicket,
    enCid: encCid,
    period: "0",
    bt,
  };
  if (actid) body.actid = actid;
  console.log("[HB-FINISH-REQ]", JSON.stringify({ url: `${origin}/mooc/controllers/course_record.php?actype=finish`, body }));
  const { status, text } = await elearnRequest(
    session,
    `${origin}/mooc/controllers/course_record.php?actype=finish`,
    { method: "POST", body, referer: readerUrl, originHeader: origin },
  );
  console.log("[HB-FINISH-RES]", text.slice(0, 300));
  return { ok: status >= 200 && status < 400, status, body: text };
}

/**
 * Single heartbeat (setReading/end).
 *
 * CRITICAL: `origin` must be the origin of the reading iframe (e.g.
 * https://mohw.elearn.hrd.gov.tw for 衛福部 SPOC). The original ecpa.js got
 * away with a relative URL because it ran inside the iframe; sending to the
 * main portal `elearn.hrd.gov.tw` when the course is on a sub-domain returns
 * 200 but credits zero time.
 *
 * `periodMs`: milliseconds elapsed since the last heartbeat (or since start).
 *   Pass `opts.intervalMs` — the server uses this to credit reading time.
 * `bt`: the `timediff` value from the most recent server response (start or end).
 *   Initialise from `startReadingSession().timediff` and update after each call.
 */
export async function heartbeat(
  session: Session,
  pTicket: string,
  encCid: string,
  origin: string = BASE,
  periodMs = 300_000,
  bt = "0",
  actid?: string,
): Promise<{ ok: boolean; status: number; body: string; timediff: string }> {
  const readerUrl = `${origin}/mooc/index.php?ticket=${encodeURIComponent(pTicket)}&cid=${encodeURIComponent(encCid)}`;
  const body: Record<string, string> = {
    action: "setReading",
    type: "end",
    ticket: pTicket,
    enCid: encCid,
    period: String(Math.round(periodMs / 1000)),
    bt,
  };
  if (actid) body.actid = actid;
  console.log("[HB-END-REQ]", JSON.stringify({ url: `${origin}/mooc/controllers/course_record.php?actype=end`, body }));
  const { status, text } = await elearnRequest(
    session,
    `${origin}/mooc/controllers/course_record.php?actype=end`,
    {
      method: "POST",
      body,
      // Referer must look like the in-iframe reading page, otherwise the server
      // discards the tick silently (HTTP 200 but no time credited).
      referer: readerUrl,
      originHeader: origin,
    },
  );
  let timediff = bt;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed.timediff !== undefined) timediff = String(parsed.timediff);
  } catch { /* ignore parse errors */ }
  console.log("[HB-END-RES]", text.slice(0, 300));
  return { ok: status >= 200 && status < 400, status, body: text, timediff };
}
