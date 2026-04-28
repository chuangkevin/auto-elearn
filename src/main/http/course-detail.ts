import type { Session } from "electron";
import * as cheerio from "cheerio";
import { app } from "electron";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { elearnRequest } from "./client";

const BASE = "https://elearn.hrd.gov.tw";

export interface CourseDetail {
  /** seconds from 閱讀時數 (e.g. "05:44:17" → 20657). null if not shown. */
  readSec: number | null;
  /** integer score from 測驗. null if 未測驗 / no exam. */
  examScore: number | null;
  /** true if 問卷 shows 已填; false if 未填; null if not present. */
  surveyDone: boolean | null;
  /** true if 通過狀態 = 通過; false for explicit 未通過; null for "--" / blank. */
  passed: boolean | null;
  /** Passing score required by THIS course — parsed from 課程須知
   *  ("課程測驗：60分(含)以上" / "75分(含)以上" / "80 分"). Falls back to
   *  60 if the page omits it. Used by solver to know when to stop retrying. */
  passingScore: number;
  /** raw label-value pairs (debug/forensic). */
  raw: Record<string, string>;
}

let dumpedOnce = false;

/**
 * Extract label→value pairs from the 我的課程狀態 panel.
 *
 * The DOM puts each row under `<div class="majorstatus"> <div>label：value</div> ... </div>`.
 * Scoping to `.majorstatus` avoids false positives from the "課程須知" /
 * prereq area higher up the page that uses the same labels (e.g.
 * "閱讀時數：00:30:00(含)以上" describes the requirement, not progress).
 */
function extractStatusPairs($: cheerio.CheerioAPI): Record<string, string> {
  const labels = ["閱讀時數", "測驗", "問卷", "通過狀態"];
  const out: Record<string, string> = {};

  const panel = $(".majorstatus").first();
  if (panel.length === 0) return out;

  panel.children("div").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (!text) return;
    for (const label of labels) {
      if (out[label] !== undefined) continue;
      if (!text.startsWith(label)) continue;
      // Strip the label, then the following colon (full-width or ASCII).
      const after = text.slice(label.length).replace(/^[:：]\s*/, "").trim();
      out[label] = after;
    }
  });

  return out;
}

function parseHmsToSec(hms: string): number | null {
  // Accept HH:MM:SS or H:MM:SS; reject anything else
  const parts = hms.trim().split(":");
  if (parts.length !== 3) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  const s = Number(parts[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) return null;
  return h * 3600 + m * 60 + s;
}

function parseExamScore(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === "未測驗" || trimmed === "未考") return null;
  // Accept pure-number scores; reject "--" / "N/A" / etc.
  const n = Number(trimmed);
  if (Number.isFinite(n)) return n;
  return null;
}

function parseSurveyDone(raw: string): boolean | null {
  const t = raw.trim();
  if (t === "已填") return true;
  if (t === "未填") return false;
  if (!t || t === "--" || t === "無") return null;
  return null;
}

function parsePassed(raw: string): boolean | null {
  const t = raw.trim();
  if (t === "通過") return true;
  if (t === "未通過" || t === "尚未通過") return false;
  return null; // includes "--", empty
}

/**
 * Fetch /info/{cid} and parse the 我的課程狀態 panel. Returns null on HTTP
 * failure or if no fields could be extracted (page may have changed shape).
 */
export async function fetchCourseDetail(
  session: Session,
  cid: string,
): Promise<CourseDetail | null> {
  const url = `${BASE}/info/${cid}`;
  let res;
  try {
    res = await elearnRequest(session, url, { method: "GET", timeoutMs: 12_000 });
  } catch {
    return null;
  }
  if (res.status !== 200) return null;

  // First-run HTML dump for forensic comparison against rendered page. Writes
  // ONCE per process to avoid filling temp dir; safe to leave shipped.
  if (!dumpedOnce) {
    dumpedOnce = true;
    try {
      writeFileSync(
        join(app.getPath("temp"), `auto-elearn-info-${cid}.html`),
        res.text,
        "utf8",
      );
    } catch {
      /* non-fatal */
    }
  }

  const $ = cheerio.load(res.text);
  const raw = extractStatusPairs($);

  // 課程須知 area lists the passing requirements like:
  //   <li><span>課程測驗：60分(含)以上</span></li>
  //   <li><span>課程測驗：75分(含)以上</span></li>
  //   <li><span>課程測驗：80分以上</span></li>
  // Default to 60 if the page omits it (matches elearn's lowest tier).
  let passingScore = 60;
  const bodyText = $.text();
  const m = bodyText.match(/課程測驗\s*[:：]\s*(\d{1,3})\s*分/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 100) passingScore = n;
  }

  const detail: CourseDetail = {
    readSec: raw["閱讀時數"] ? parseHmsToSec(raw["閱讀時數"]) : null,
    examScore: raw["測驗"] !== undefined ? parseExamScore(raw["測驗"]) : null,
    surveyDone: raw["問卷"] !== undefined ? parseSurveyDone(raw["問卷"]) : null,
    passed: raw["通過狀態"] !== undefined ? parsePassed(raw["通過狀態"]) : null,
    passingScore,
    raw,
  };
  // If absolutely nothing matched, treat as parse failure so caller can fall
  // back to list-endpoint flags.
  if (
    detail.readSec === null &&
    detail.examScore === null &&
    detail.surveyDone === null &&
    detail.passed === null &&
    Object.keys(raw).length === 0
  ) {
    return null;
  }
  return detail;
}
