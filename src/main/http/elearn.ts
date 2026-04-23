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

/** Single heartbeat (setReading/end). */
export async function heartbeat(
  session: Session,
  pTicket: string,
  encCid: string,
): Promise<{ ok: boolean; status: number }> {
  const { status } = await elearnRequest(
    session,
    `${BASE}/mooc/controllers/course_record.php?actype=end`,
    {
      method: "POST",
      body: {
        action: "setReading",
        type: "end",
        ticket: pTicket,
        enCid: encCid,
      },
      referer: BASE,
    },
  );
  return { ok: status >= 200 && status < 400, status };
}
