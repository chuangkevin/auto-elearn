/**
 * Translation from agency (人事局教育訓練) 3-digit codes → elearn site categoryId(s).
 *
 * The agency uses codes like 540, 522, 539 in their annual training spec. These are
 * NOT the 8-digit `categoryId` the elearn API expects — passing them raw causes
 * `getSearchCourses` to silently fall back to "recent courses" (proved in
 * `docs/research/06-category-tree-probe.md`). We map each agency code to:
 *   - the elearn categoryId representing the same category on the site
 *   - an optional keyword filter to narrow down when the code is a sub-topic
 *
 * categoryId references come from `docs/research/category-tree-snapshot.json` (tree
 * scrape 2026-04-24). When adding new codes, run the probe again to confirm the id.
 */

export interface CodeResolution {
  /** elearn 8-digit categoryId */
  categoryId: string;
  /** Optional keyword to narrow inside that category */
  keyword?: string;
  /** Human-readable label for logging / UI */
  label: string;
}

const ENV_EDU = "10000016"; // 公務人員10小時 > 環境教育專區
const HUMAN_RIGHTS = "10000535"; // 公務人員10小時 > 人權教育專區
const AI_ZONE = "10040389"; // 公務人員10小時 > 人工智慧專區
const INFO_SEC = "10027390"; // 資訊安全課程專區
const GENDER_EQ = "10000594"; // 公務人員10小時 > 性別平等專區

export const AGENCY_CODE_MAP: Record<string, CodeResolution> = {
  // --- 人工智慧 ------------------------------------------------
  "540": { categoryId: AI_ZONE, keyword: "基礎認知", label: "AI 基礎認知" },
  "541": { categoryId: AI_ZONE, keyword: "生成式", label: "生成式人工智慧" },
  "542": { categoryId: AI_ZONE, keyword: "公務應用", label: "AI 公務應用案例" },
  "543": { categoryId: AI_ZONE, keyword: "導入", label: "AI 導入與技術" },
  "544": { categoryId: AI_ZONE, keyword: "產業應用", label: "AI 產業應用案例" },
  "545": { categoryId: AI_ZONE, label: "AI 進階課程" },
  "546": { categoryId: AI_ZONE, label: "AI 進階課程" },

  // --- 環境教育 (267 / 268 / 278 / 336-345) ---------------------
  "267": { categoryId: ENV_EDU, label: "環境教育" },
  "268": { categoryId: ENV_EDU, label: "環境教育" },
  "278": { categoryId: ENV_EDU, label: "環境教育" },
  "336": { categoryId: ENV_EDU, label: "環境教育" },
  "337": { categoryId: ENV_EDU, label: "環境教育" },
  "338": { categoryId: ENV_EDU, label: "環境教育" },
  "339": { categoryId: ENV_EDU, label: "環境教育" },
  "340": { categoryId: ENV_EDU, label: "環境教育" },
  "341": { categoryId: ENV_EDU, label: "環境教育" },
  "342": { categoryId: ENV_EDU, label: "環境教育" },
  "343": { categoryId: ENV_EDU, label: "環境教育" },
  "344": { categoryId: ENV_EDU, label: "環境教育" },
  "345": { categoryId: ENV_EDU, label: "環境教育" },

  // --- 其他 --------------------------------------------------
  "503": { categoryId: HUMAN_RIGHTS, label: "人權教育" },
  "522": { categoryId: INFO_SEC, label: "資訊安全" },
  "539": { categoryId: HUMAN_RIGHTS, keyword: "職場霸凌", label: "職場霸凌" },

  // Gender equality (常見 code 但 spec 沒明確給 — 性別平等 常見用途)
  "512": { categoryId: GENDER_EQ, label: "性別平等" },
};

export interface ResolvedCode {
  input: string;
  resolution: CodeResolution | null;
}

export function resolveAgencyCodes(codes: string[]): ResolvedCode[] {
  return codes.map((code) => ({
    input: code,
    resolution: AGENCY_CODE_MAP[code] ?? null,
  }));
}

/**
 * Group resolved codes by categoryId so we prime the same category once and batch
 * searches across keyword variants. Unknown codes go to a `null` bucket and will be
 * attempted as raw categoryIds as a last resort (with a warning).
 */
export function groupByCategory(
  resolved: ResolvedCode[],
): {
  categoryId: string;
  codes: string[];
  keywords: string[];
  labels: string[];
}[] {
  const groups = new Map<string, { codes: string[]; keywords: Set<string>; labels: Set<string> }>();
  for (const r of resolved) {
    if (!r.resolution) continue;
    const key = r.resolution.categoryId;
    if (!groups.has(key)) groups.set(key, { codes: [], keywords: new Set(), labels: new Set() });
    const g = groups.get(key)!;
    g.codes.push(r.input);
    if (r.resolution.keyword) g.keywords.add(r.resolution.keyword);
    g.labels.add(r.resolution.label);
  }
  return Array.from(groups.entries()).map(([categoryId, g]) => ({
    categoryId,
    codes: g.codes,
    keywords: Array.from(g.keywords),
    labels: Array.from(g.labels),
  }));
}
