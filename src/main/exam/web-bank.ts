import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import * as cheerio from "cheerio";
import { saveLearnedAnswer } from "./answer-store";
import { diceSimilarity } from "./matcher";
import { getStorageDir } from "../persist/storage-paths";

/**
 * Tiny in-process concurrency limiter. Drop-in for `p-limit` without the
 * ESM/CJS interop pain — `p-limit@6` is ESM-only and Electron main is
 * CommonJS, which causes ERR_REQUIRE_ESM at startup.
 */
function makeLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= concurrency) return;
    const job = queue.shift();
    if (job) job();
  };
  return <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      };
      if (active < concurrency) run();
      else queue.push(run);
    });
}

const FEED_BASE = "https://www.rodiyer.idv.tw/feeds/posts/default";
// Blogger Atom feeds silently cap max-results at ~25 regardless of what we
// ask for. Asking for 500 returned 25-entry pages (verified 2026-05-05).
// 25 keeps each page small and the request count manageable for a 2056-post
// corpus (≈ 83 page fetches, sequential, fine).
const FEED_PAGE_SIZE = 25;
const MATCH_THRESHOLD = 0.85;
const INDEX_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 15_000;
const ANSWER_MARKER_LINE = /^[✓✔〇●*]+$/;
const NOISE_LINE = /^(?:www\.|http|\(adsbygoogle|rodiyer\.idv\.tw)/i;

interface IndexEntry {
  title: string;
  url: string;
}

export interface ParsedQA {
  question: string;
  answers: string[];
  distractors: string[];
}

export interface PrefetchResult {
  /** 寫入 learned_answers 的題目總數（所有命中課程加總） */
  questionsWritten: number;
  /** Per-course prefetch 成功寫入題目的 cid；用來判斷單一課考前是否仍需等 bulk。 */
  hitCids: string[];
  /** 命中題庫網站且成功 parse 的課程數 */
  coursesHit: number;
  /** index 比對沒過 threshold 的課程數 */
  coursesMiss: number;
  /** index 命中但 fetch / parse 失敗的課程數 */
  coursesFailed: number;
}

export interface WebBankCoverage {
  cid: string;
  status: "hit" | "miss";
  title?: string;
  url?: string;
  similarity?: number;
}

// ── Index loader (cache + paginated fetch) ──────────────────────────────────

function indexCachePath(): string {
  const dir = getStorageDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "web-bank-index.json");
}

function indexFresh(path: string): boolean {
  try {
    const stat = statSync(path);
    return Date.now() - stat.mtimeMs < INDEX_TTL_MS;
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the full Atom feed paginated 500 entries at a time. Stops when a page
 * returns fewer than FEED_PAGE_SIZE entries (last page).
 */
async function fetchFullIndex(log: (m: string) => void): Promise<IndexEntry[]> {
  const out: IndexEntry[] = [];
  for (let start = 1; ; start += FEED_PAGE_SIZE) {
    const url = `${FEED_BASE}?max-results=${FEED_PAGE_SIZE}&start-index=${start}`;
    let xml: string;
    try {
      xml = await fetchWithTimeout(url, 30_000);
    } catch (e) {
      log(`索引第 ${start} 頁 fetch 失敗：${(e as Error).message}`);
      break;
    }
    const $ = cheerio.load(xml, { xmlMode: true });
    const entries = $("entry");
    if (entries.length === 0) break;
    entries.each((_, el) => {
      const title = $(el).find("title").first().text().trim();
      // Atom <link rel="alternate" href="..."/>
      const link = $(el).find('link[rel="alternate"]').attr("href") ?? "";
      if (title && link) out.push({ title, url: link });
    });
    // Blogger silently caps page size; only stop on a truly empty page.
    // Sanity safeguard: if we somehow ran 200+ requests, bail.
    if (start > 200 * FEED_PAGE_SIZE) {
      log(`索引分頁達 ${start} 仍未結束，提前停止避免無限迴圈`);
      break;
    }
  }
  return out;
}

// Bank totalResults observed 2026-05-05 was ~2056. A pre-fix bug capped
// pagination at the first page that returned fewer than 500 entries —
// Blogger silently caps page size at 25, so the loop bailed at 150 entries.
// Reject any cached index that's suspiciously short and refetch instead.
const MIN_VALID_INDEX_ENTRIES = 500;
let inFlightIndexLoad: Promise<IndexEntry[]> | null = null;

async function loadIndex(log: (m: string) => void): Promise<IndexEntry[]> {
  const path = indexCachePath();
  if (existsSync(path) && indexFresh(path)) {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as IndexEntry[];
      if (Array.isArray(parsed) && parsed.length >= MIN_VALID_INDEX_ENTRIES) {
        log(`索引從快取載入：${parsed.length} 篇（24h 內有效）`);
        return parsed;
      }
      if (Array.isArray(parsed) && parsed.length > 0) {
        log(`快取索引只 ${parsed.length} 篇（< ${MIN_VALID_INDEX_ENTRIES}），可能是 pre-fix 舊資料；忽略並重抓`);
      }
    } catch {
      /* fall through to refetch */
    }
  }
  if (inFlightIndexLoad) {
    log(`題庫索引已有載入中的請求，重用同一批結果`);
    return inFlightIndexLoad;
  }
  log(`抓取題庫索引...`);
  inFlightIndexLoad = (async () => {
    const entries = await fetchFullIndex(log);
    if (entries.length > 0) {
      try {
        writeFileSync(path, JSON.stringify(entries), "utf8");
        log(`索引已更新：${entries.length} 篇，存於 ${path}`);
      } catch (e) {
        log(`索引寫檔失敗（不影響本次執行）：${(e as Error).message}`);
      }
    }
    return entries;
  })().finally(() => {
    inFlightIndexLoad = null;
  });
  return inFlightIndexLoad;
}

/**
 * v0.8.18: always re-fetch the index (no 24h cache check), persist on
 * success. Used by `bulkPrefetchBankIndex` so each pipeline start can
 * detect newly-published bank pages and incrementally fetch only those.
 */
async function fetchFreshIndex(log: (m: string) => void): Promise<IndexEntry[]> {
  log(`抓取題庫索引（v0.8.18 不靠 24h 快取，每次都重抓 RSS）...`);
  const entries = await fetchFullIndex(log);
  if (entries.length > 0) {
    try {
      writeFileSync(indexCachePath(), JSON.stringify(entries), "utf8");
      log(`索引已更新：${entries.length} 篇`);
    } catch (e) {
      log(`索引寫檔失敗（不影響本次執行）：${(e as Error).message}`);
    }
  }
  return entries;
}

// ── Fuzzy match + title normalization ───────────────────────────────────────

/**
 * Strip cosmetic prefixes/suffixes so that
 *   "【解答】行政院與所屬中央...勤休制度宣導課程-115年"
 * normalises identically to the elearn caption
 *   "行政院與所屬中央...勤休制度宣導課程-115年"
 * after both lose the year-tag/spacing chrome.
 */
function normTitle(s: string): string {
  return s
    .replace(/^【解答】/, "")
    .replace(/^[\s　]+|[\s　]+$/g, "")
    .replace(/[\s　]+/g, "")
    .replace(/-?(11[0-9]|10[0-9])年(度)?$/u, "")
    .trim();
}

function findBestMatch(
  caption: string,
  index: IndexEntry[],
): { entry: IndexEntry; sim: number } | null {
  const target = normTitle(caption);
  if (!target) return null;
  let best: { entry: IndexEntry; sim: number } | null = null;
  for (const entry of index) {
    const sim = diceSimilarity(target, normTitle(entry.title));
    if (!best || sim > best.sim) best = { entry, sim };
  }
  if (!best || best.sim < MATCH_THRESHOLD) return null;
  return best;
}

export async function findWebBankCoverage(
  courses: Array<{ cid: string; caption: string }>,
  log: (m: string) => void,
): Promise<Map<string, WebBankCoverage>> {
  const out = new Map<string, WebBankCoverage>();
  if (courses.length === 0) return out;

  const index = await loadIndex(log);
  if (index.length < MIN_VALID_INDEX_ENTRIES) {
    throw new Error(`題庫索引不足：${index.length} 篇`);
  }
  for (const course of courses) {
    const match = findBestMatch(course.caption, index);
    out.set(
      course.cid,
      match
        ? {
            cid: course.cid,
            status: "hit",
            title: match.entry.title,
            url: match.entry.url,
            similarity: match.sim,
          }
        : { cid: course.cid, status: "miss" },
    );
  }
  return out;
}

// ── HTML parser ─────────────────────────────────────────────────────────────

/**
 * Parse a bank article's HTML into question/answer blocks.
 *
 * Real format observed at rodiyer.idv.tw (2026-04 articles, verified
 * with a debug fetch on 2026-05-05): each token sits on its own line —
 *
 *   問
 *   <question text>
 *   ✓
 *   <correct option text>
 *   <distractor option text>
 *   ✓
 *   <another correct option text>   ← multi-select
 *
 * Earlier assumption (`問 <text>` on the same line, `✓ <text>` on the
 * same line) was wrong — cheerio's text() puts each block-level element
 * on its own line, so the marker and its content end up on separate
 * lines.
 *
 * Algorithm:
 *   - Walk lines linearly. When we hit "問", the next non-empty line is
 *     the question text. Then keep reading lines until the next "問" or
 *     end of text:
 *       - A line matching ANSWER_MARKER_LINE flips a "next line is a
 *         correct answer" flag.
 *       - Otherwise the line is either a distractor (when no marker is
 *         pending) or the answer itself (when a marker is pending).
 *       - NOISE_LINE patterns (ads, footer URLs) are dropped.
 *
 * Selectors tried in order, first non-empty wins:
 *   .post-body → .entry-content → article → body
 */
export function parseQA(html: string): ParsedQA[] {
  const $ = cheerio.load(html);
  let text = "";
  for (const sel of [".post-body", ".entry-content", "article", "body"]) {
    const t = $(sel).first().text();
    if (t && t.trim()) {
      text = t;
      break;
    }
  }
  if (!text) return [];

  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const result: ParsedQA[] = [];

  let i = 0;
  while (i < lines.length) {
    if (lines[i] !== "問") {
      i++;
      continue;
    }
    // Found "問" — the next non-empty line is the question text.
    let j = i + 1;
    while (j < lines.length && !lines[j]) j++;
    if (j >= lines.length) break;
    const question = lines[j];

    const answers: string[] = [];
    const distractors: string[] = [];
    let pendingAnswerMarker = false;
    let k = j + 1;
    for (; k < lines.length; k++) {
      const line = lines[k];
      if (line === "問") break; // start of next question
      if (!line) continue;
      if (NOISE_LINE.test(line)) continue;
      if (ANSWER_MARKER_LINE.test(line)) {
        pendingAnswerMarker = true;
        continue;
      }
      if (pendingAnswerMarker) {
        answers.push(line);
        pendingAnswerMarker = false;
      } else {
        distractors.push(line);
      }
    }
    // True/false questions on rodiyer mark the correct answer with a
    // single ╳ / ○ glyph (verified 2026-05-05 — the bank uses ╳ when the
    // statement is FALSE, ○ when TRUE). The elearn exam page renders
    // its T/F options with the option text "是" / "否", so we map back
    // before persisting; otherwise pickOptionIndex fuzzy-falls-back to
    // index 0 and the answer is wrong half the time.
    const mappedAnswers = answers.map((a) => {
      if (a === "╳") return "否";
      if (a === "○") return "是";
      return a;
    });
    if (question && mappedAnswers.length > 0) {
      result.push({ question, answers: mappedAnswers, distractors });
    }
    i = k;
  }

  return result;
}

let parseDumpDone = false;

async function fetchAndParseCourse(
  url: string,
  log: (m: string) => void,
): Promise<ParsedQA[]> {
  let html: string;
  try {
    html = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
  } catch (e) {
    log(`HTML fetch 失敗 ${url}：${(e as Error).message}`);
    return [];
  }
  const parsed = parseQA(html);
  if (parsed.length === 0 && html.length > 0) {
    // Diagnostic dump on parse failure (one-shot per process).
    if (!parseDumpDone) {
      parseDumpDone = true;
      try {
        const dumpPath = join(app.getPath("temp"), "auto-elearn-web-bank-parse.txt");
        writeFileSync(dumpPath, html.slice(0, 8000), "utf8");
        log(`Parse 0 questions; first 8KB body dumped to ${dumpPath}`);
      } catch {
        /* non-fatal */
      }
    }
  }
  return parsed;
}

// ── Public orchestrator ──────────────────────────────────────────────────────

export async function prefetchCoursesViaWebBank(
  cids: string[],
  courseNamesByCid: Map<string, string>,
  log: (msg: string) => void,
  onCourseHit?: (cid: string) => void,
): Promise<PrefetchResult> {
  if (cids.length === 0) return { questionsWritten: 0, hitCids: [], coursesHit: 0, coursesMiss: 0, coursesFailed: 0 };

  let index: IndexEntry[];
  try {
    index = await loadIndex(log);
  } catch (e) {
    log(`索引載入失敗，跳過題庫 prefetch：${(e as Error).message}`);
    return { questionsWritten: 0, hitCids: [], coursesHit: 0, coursesMiss: 0, coursesFailed: cids.length };
  }
  if (index.length === 0) {
    log(`索引為空，跳過題庫 prefetch`);
    return { questionsWritten: 0, hitCids: [], coursesHit: 0, coursesMiss: 0, coursesFailed: cids.length };
  }

  // Match each course caption to the best bank entry (above threshold).
  const tasks: Array<{ cid: string; caption: string; entry: IndexEntry; sim: number }> = [];
  let missCount = 0;
  for (const cid of cids) {
    const caption = courseNamesByCid.get(cid);
    if (!caption) continue;
    const match = findBestMatch(caption, index);
    if (!match) {
      missCount++;
      continue;
    }
    tasks.push({ cid, caption, entry: match.entry, sim: match.sim });
  }
  log(
    `索引比對完成：${tasks.length} 命中 / ${missCount} miss（共 ${cids.length} 課）` +
      (tasks.length > 0
        ? `；範例：「${tasks[0].caption.slice(0, 20)}」→「${tasks[0].entry.title.slice(0, 20)}」(sim ${tasks[0].sim.toFixed(2)})`
        : ""),
  );

  // v0.8.23: parallel fetch + retry loop. Heartbeat reading phase is
  // 60 min long — plenty of opportunity to keep trying failed pages
  // (rate limit / temporary 5xx / parser miss). Loop until all hit OR
  // max retries OR aborted.
  const limit = makeLimiter(FETCH_CONCURRENCY);
  let hit = 0;
  let failed = 0;
  const succeeded = new Set<string>(); // cid set
  const RETRY_MAX = 6;          // 6 rounds total
  const RETRY_BACKOFF_MS = 45_000; // 45s between rounds

  for (let round = 1; round <= RETRY_MAX; round++) {
    const pending = tasks.filter((t) => !succeeded.has(t.cid));
    if (pending.length === 0) break;
    if (round > 1) {
      log(`per-course retry 第 ${round}/${RETRY_MAX} 輪：剩 ${pending.length} 課，${RETRY_BACKOFF_MS / 1000}s 後重試`);
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    }
    let roundHit = 0;
    let roundFail = 0;
    await Promise.all(
      pending.map((t) =>
        limit(async () => {
          const qas = await fetchAndParseCourse(t.entry.url, log);
          if (qas.length === 0) {
            roundFail++;
            return;
          }
          for (const qa of qas) {
            saveLearnedAnswer({
              question: qa.question,
              answers: qa.answers,
              source: "web-prefetch",
              confidence: 1.0,
              courseId: t.cid,
            });
          }
          hit += qas.length;
          succeeded.add(t.cid);
          onCourseHit?.(t.cid);
          roundHit++;
          log(`✓「${t.caption.slice(0, 20)}」: ${qas.length} 題寫入 learned_answers (round ${round})`);
        }),
      ),
    );
    if (round === 1) failed = roundFail; // initial-round fail count for return
    else if (roundHit > 0) {
      log(`per-course retry 第 ${round} 輪：${roundHit} 課補回成功 / ${roundFail} 仍失敗`);
    }
  }
  // Final fail = courses that never succeeded across all retries.
  failed = tasks.length - succeeded.size;

  const coursesHit = tasks.length - failed;
  log(`題庫 prefetch 完成：${hit} 題寫入 / ${coursesHit} 課成功 / ${failed} 課失敗 / ${missCount} 課無對應`);
  return {
    questionsWritten: hit,
    hitCids: [...succeeded],
    coursesHit,
    coursesMiss: missCount,
    coursesFailed: failed,
  };
}

// ── Bulk prefetch (v0.8.14) ─────────────────────────────────────────────────
//
// Why this exists:
//   Per-course prefetch (above) maps a selected elearn course name → bank
//   article via fuzzy similarity. T8 verification on v0.8.13 found this is
//   prone to "same title, different year" false positives — the bank's
//   "行政中立暨公務倫理" page is a 2026/02 edition, but elearn's current
//   cid 10046536 has a different question set. Per-course prefetch wrote
//   20 unrelated answers; lookupLearnedAnswer found nothing on exam time.
//
// Bulk prefetch sidesteps the title-fuzzy assumption: download every bank
// page over time, parse all ~20K questions, write them all into the shared
// learned_answers cache. lookupLearnedAnswer's existing normalized LIKE
// query then matches the elearn exam page's question text against every
// bank-known question — by content, not by course name.
//
// First run: ~15 min for 2056 pages × 5 concurrency. Persisted as a
// timestamp file `<storageDir>/web-bank-bulk-done.json`. Subsequent runs
// within 24h skip entirely (data already in learned_answers).

const BULK_PROGRESS_LOG_EVERY = 50;           // emit a log line every N pages
// v0.8.15: Bank has ~2056 articles spanning multiple years. Users can only
// see / enrol in current-year + recent courses on elearn (older editions
// are removed once their replacement publishes), so bulk-fetching the full
// archive wastes ~70% of fetches on dead corpus. RSS feed is newest-first,
// so taking the first N entries hits the active year coverage. 500 covers
// roughly the 115 (current) + 114 editions, where actual exam content
// lives. Tunable later if site coverage shifts.
const BULK_RECENT_LIMIT = 500;

function bulkDonePath(): string {
  const dir = getStorageDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "web-bank-bulk-done.json");
}

/**
 * v0.8.18: snapshot of bank pages already fetched + parsed into
 * learned_answers. Failed pages are NOT in processedUrls, so they get
 * re-tried on the next pipeline start automatically (no 24h wait).
 */
interface BulkSnapshot {
  updatedAt: number;
  /** URLs successfully fetched + parsed + persisted to learned_answers. */
  processedUrls: string[];
  /** Last index.length we observed; informational only. */
  lastIndexSize: number;
}

function readBulkSnapshot(): BulkSnapshot | null {
  try {
    const raw = readFileSync(bulkDonePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<BulkSnapshot>;
    if (Array.isArray(parsed.processedUrls) && parsed.processedUrls.every((u) => typeof u === "string")) {
      return {
        updatedAt: parsed.updatedAt ?? 0,
        processedUrls: parsed.processedUrls,
        lastIndexSize: parsed.lastIndexSize ?? 0,
      };
    }
  } catch {
    /* fall through */
  }
  return null;
}

function writeBulkSnapshot(snapshot: BulkSnapshot, log: (msg: string) => void): void {
  try {
    writeFileSync(bulkDonePath(), JSON.stringify(snapshot), "utf8");
  } catch (e) {
    log(`Bulk snapshot 寫檔失敗（不影響本次結果）：${(e as Error).message}`);
  }
}

export interface BulkPrefetchResult {
  pagesProcessed: number;
  pagesFailed: number;
  questionsWritten: number;
}

export interface BulkProgressUpdate {
  running: boolean;
  pagesProcessed: number;
  pagesTotal: number;
  pagesFailed: number;
  questionsWritten: number;
}

/**
 * v0.8.18: incremental bank prefetch.
 *
 * Each pipeline start:
 *   1. Always re-fetch the RSS index (no 24h cache; ~5s).
 *   2. Read snapshot of URLs we've already parsed into learned_answers.
 *   3. Compute delta = top-BULK_RECENT_LIMIT entries minus processedUrls.
 *      - 0 delta → 題庫已完整覆蓋最新 N 篇，skip.
 *      - N delta → fetch + parse only those, append to processedUrls.
 *   4. Failed pages are NOT added to processedUrls — they retry next time.
 *
 * Replaces the old 24h timestamp-cache. saveLearnedAnswer is still
 * idempotent (priority gate prevents downgrades), so a failed-and-retried
 * page that succeeds this time correctly writes its answers.
 */
export async function bulkPrefetchBankIndex(
  log: (msg: string) => void,
  onProgress?: (p: BulkProgressUpdate) => void,
): Promise<BulkPrefetchResult> {
  const startedAt = Date.now();

  let fullIndex: IndexEntry[];
  try {
    fullIndex = await fetchFreshIndex(log);
  } catch (e) {
    log(`Bulk prefetch 索引載入失敗：${(e as Error).message}`);
    return { pagesProcessed: 0, pagesFailed: 0, questionsWritten: 0 };
  }
  if (fullIndex.length === 0) {
    log(`Bulk prefetch 索引為空，跳過`);
    return { pagesProcessed: 0, pagesFailed: 0, questionsWritten: 0 };
  }

  // Top BULK_RECENT_LIMIT recent entries are the active-edition corpus.
  const candidates = fullIndex.slice(0, BULK_RECENT_LIMIT);

  // Diff against snapshot — only fetch URLs we haven't successfully
  // processed yet. Previous-run failures (parse error, 404, timeout) are
  // not in processedUrls, so they automatically retry now.
  const snapshot = readBulkSnapshot();
  const processedSet = new Set(snapshot?.processedUrls ?? []);
  const delta = candidates.filter((e) => !processedSet.has(e.url));

  if (delta.length === 0) {
    log(
      `題庫完整度檢查：top-${candidates.length} 篇全已處理（snapshot 含 ${processedSet.size} URL），無需增量抓取`,
    );
    onProgress?.({
      running: false,
      pagesProcessed: 0,
      pagesTotal: 0,
      pagesFailed: 0,
      questionsWritten: 0,
    });
    return { pagesProcessed: 0, pagesFailed: 0, questionsWritten: 0 };
  }

  log(
    `Bulk prefetch 開始：${delta.length} 篇增量（snapshot 已有 ${processedSet.size} URL，top-${candidates.length} 候選）` +
      `（並行 ${FETCH_CONCURRENCY}，預估 ~${Math.max(1, Math.ceil(delta.length / 9))} 分鐘）`,
  );

  const limit = makeLimiter(FETCH_CONCURRENCY);
  let processed = 0;
  let failed = 0;
  let questionsWritten = 0;
  const newlyProcessed: string[] = [];

  onProgress?.({
    running: true,
    pagesProcessed: 0,
    pagesTotal: delta.length,
    pagesFailed: 0,
    questionsWritten: 0,
  });

  await Promise.all(
    delta.map((entry) =>
      limit(async () => {
        const qas = await fetchAndParseCourse(entry.url, () => {
          /* swallow per-page parse-fail spam */
        });
        if (qas.length === 0) {
          failed++;
          // Do NOT add entry.url to newlyProcessed — let next start retry.
        } else {
          for (const qa of qas) {
            saveLearnedAnswer({
              question: qa.question,
              answers: qa.answers,
              source: "web-prefetch",
              confidence: 1.0,
            });
            questionsWritten++;
          }
          newlyProcessed.push(entry.url);
        }
        processed++;
        if (processed % BULK_PROGRESS_LOG_EVERY === 0) {
          const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
          log(
            `Bulk prefetch 進度：${processed}/${delta.length} 篇（${questionsWritten} 題寫入，${failed} 失敗，已花 ${elapsedSec}s）`,
          );
          onProgress?.({
            running: true,
            pagesProcessed: processed,
            pagesTotal: delta.length,
            pagesFailed: failed,
            questionsWritten,
          });
        }
      }),
    ),
  );

  // Persist snapshot — append newly successful URLs only.
  for (const url of newlyProcessed) processedSet.add(url);
  writeBulkSnapshot(
    {
      updatedAt: Date.now(),
      processedUrls: [...processedSet],
      lastIndexSize: fullIndex.length,
    },
    log,
  );

  const totalSec = Math.round((Date.now() - startedAt) / 1000);
  log(
    `Bulk prefetch 完成：${processed} 篇處理 / ${failed} 失敗（next-start 自動重試）/ ${questionsWritten} 題寫入（總耗時 ${totalSec}s）；snapshot 累計 ${processedSet.size} URL`,
  );
  onProgress?.({
    running: false,
    pagesProcessed: processed,
    pagesTotal: delta.length,
    pagesFailed: failed,
    questionsWritten,
  });
  return { pagesProcessed: processed, pagesFailed: failed, questionsWritten };
}
