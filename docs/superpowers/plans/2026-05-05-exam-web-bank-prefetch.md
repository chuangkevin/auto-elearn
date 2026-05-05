# Exam Web Bank Prefetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a high-priority answer source that prefetches answers from `rodiyer.idv.tw` into the shared `learned_answers` SQLite cache, plus fix the multi-select submission path so multi-✓ answers actually work. Target release v0.8.13.

**Architecture:** Schema stays `answer TEXT` but the runtime treats it as a JSON-array string (`["A","B"]`) with single-string backwards-compat. New `web-bank.ts` module fires in parallel with heartbeat after enrol; chains for already-past-halfway courses await the shared prefetch promise with 30s timeout. Source priority gate in `saveLearnedAnswer` prevents brute/llm from overwriting web-prefetch.

**Tech Stack:** TypeScript / Electron 32 / React 18 / better-sqlite3 / cheerio / fast-fuzzy / p-limit (all already deps in `package.json`)

**Spec:** `docs/superpowers/specs/2026-05-05-exam-web-bank-prefetch-design.md`

**Test conventions:** No unit-test runner exists. Verification is `npm run typecheck` + `npm run dev` runtime checks against real elearn / rodiyer endpoints. Each task has a "Verify" step instead of "run failing test → pass".

---

## Task 1: answer-store.ts — JSON-array runtime semantics

**Files:**
- Modify: `src/main/exam/answer-store.ts:200-292`

Switch `saveLearnedAnswer` to accept `answers: string[]` (stored as `JSON.stringify(answers)`), and `lookupLearnedAnswer` to return `{ answers: string[] }`. Old single-string rows must still read correctly.

- [ ] **Step 1: Update `SaveAnswerOpts` and add `LearnedAnswerRow` shape**

Replace lines 237–243:
```ts
export interface SaveAnswerOpts {
  question: string;
  /** Length 1 for single-select; >=1 for multi-select. */
  answers: string[];
  source: string;
  courseId?: string;
  confidence?: number;
}

export interface LearnedAnswerRow {
  question: string;
  answers: string[];
  source: string;
  confidence: number;
}
```

- [ ] **Step 2: Replace `saveLearnedAnswer` body to JSON-stringify `answers`**

Replace lines 273–292 with:
```ts
export function saveLearnedAnswer(opts: SaveAnswerOpts): void {
  if (!opts.answers || opts.answers.length === 0) return;
  const payload = JSON.stringify(opts.answers);
  try {
    getDb()
      .prepare(
        `INSERT OR REPLACE INTO learned_answers
           (question, answer, source, captured_at, course_id, confidence)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.question,
        payload,
        opts.source,
        Date.now(),
        opts.courseId ?? null,
        opts.confidence ?? 1.0,
      );
  } catch {
    /* non-fatal */
  }
}
```

- [ ] **Step 3: Add a `decodeAnswers` helper that parses JSON or falls back to [raw]**

Add just below `saveLearnedAnswer`:
```ts
/**
 * Decode the `answer` column. v0.8.13+ stores JSON arrays
 * (`["選項A","選項B"]`); legacy rows from earlier versions are plain strings
 * (`"選項A"`). On JSON.parse failure or non-array result, fall back to a
 * single-element array containing the raw text.
 */
export function decodeAnswers(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  return [raw];
}
```

- [ ] **Step 4: Replace `lookupLearnedAnswer` to use `decodeAnswers`**

Replace lines 200–235 with:
```ts
/**
 * Query the writable `learned_answers` table. Returns the highest-priority
 * row for the question, decoded into `answers: string[]` (single-element for
 * single-select, multi for multi-select). Older rows that are plain strings
 * are auto-promoted to single-element arrays via `decodeAnswers`.
 */
export function lookupLearnedAnswer(raw: string): LearnedAnswerRow | null {
  try {
    const d = getDb();
    const norm = normalizeQuestion(raw);
    if (!norm) return null;
    const NORM_EXPR = `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(question,' ',''),'　',''),'?',''),'？',''),'，','')`;
    // Source priority — higher number wins. web-prefetch (10) is ground
    // truth from rodiyer.idv.tw; brute (1) is a score-delta probe that's
    // often wrong on randomly-sampled exams. See spec §"Source priority".
    const row = d
      .prepare(
        `SELECT question, answer, source, confidence FROM learned_answers
         WHERE ${NORM_EXPR} LIKE ?
         ORDER BY
           CASE source
             WHEN 'web-prefetch'    THEN 10
             WHEN 'history-solve'   THEN 8
             WHEN 'perfect-attempt' THEN 7
             WHEN 'llm'             THEN 5
             WHEN 'db'              THEN 4
             WHEN 'fuzzy'           THEN 3
             WHEN 'result-page'     THEN 2
             WHEN 'brute'           THEN 1
             ELSE 0
           END DESC,
           captured_at DESC,
           confidence DESC
         LIMIT 1`,
      )
      .get(`%${norm}%`) as
      | { question: string; answer: string; source: string; confidence: number }
      | undefined;
    if (!row) return null;
    return {
      question: row.question,
      answers: decodeAnswers(row.answer),
      source: row.source,
      confidence: row.confidence ?? 1.0,
    };
  } catch {
    return null;
  }
}
```

Note: this changes the public return type from `DbRow | null` (with `correct: string`) to `LearnedAnswerRow | null` (with `answers: string[]`). Task 3 updates the only consumer (`matcher.ts`).

- [ ] **Step 5: Verify typecheck breaks where expected, then move on**

Run: `npm run typecheck`

Expected: errors in `matcher.ts:118-121` (`learned.correct` and `pickedIdx` no longer exist on the new shape). These are addressed in Task 3. Do NOT silence them yet — they're the breakage marker confirming Task 1 landed.

- [ ] **Step 6: No commit yet** — Task 2 lands the priority gate next, both go in one commit so the schema change is atomic.

---

## Task 2: answer-store.ts — source priority gate in `saveLearnedAnswer`

**Files:**
- Modify: `src/main/exam/answer-store.ts` (the `saveLearnedAnswer` function from Task 1)

Add a priority comparison that prevents low-priority sources (brute, random) from overwriting high-priority sources (web-prefetch, history-solve, perfect-attempt) when the same question key already exists.

- [ ] **Step 1: Add `SOURCE_PRIORITY` map at module scope**

Add near the top of the file (after imports, before `let db: ...`):
```ts
/**
 * Source priority — higher number wins. New writes only `INSERT OR REPLACE`
 * if their priority >= the existing row's priority. This stops brute-force
 * probes (priority 1) from clobbering web-prefetch ground truth (priority 10).
 *
 * Keep in sync with the ORDER BY CASE in lookupLearnedAnswer.
 */
const SOURCE_PRIORITY: Record<string, number> = {
  "web-prefetch": 10,
  "history-solve": 8,
  "perfect-attempt": 7,
  llm: 5,
  db: 4,
  fuzzy: 3,
  "result-page": 2,
  brute: 1,
  random: 0,
};

function sourcePriority(s: string): number {
  return SOURCE_PRIORITY[s] ?? 0;
}
```

- [ ] **Step 2: Wrap `saveLearnedAnswer` body with priority check**

Replace `saveLearnedAnswer` from Task 1 with:
```ts
export function saveLearnedAnswer(opts: SaveAnswerOpts): void {
  if (!opts.answers || opts.answers.length === 0) return;
  const payload = JSON.stringify(opts.answers);
  try {
    const d = getDb();

    // Priority gate: don't overwrite a higher-priority answer with a
    // lower-priority probe. Equal priority is allowed (re-affirms or
    // updates the answers list, e.g. brute → brute on a different option).
    const existing = d
      .prepare(`SELECT source FROM learned_answers WHERE question = ?`)
      .get(opts.question) as { source: string } | undefined;
    if (existing && sourcePriority(opts.source) < sourcePriority(existing.source)) {
      return;
    }

    d.prepare(
      `INSERT OR REPLACE INTO learned_answers
         (question, answer, source, captured_at, course_id, confidence)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.question,
      payload,
      opts.source,
      Date.now(),
      opts.courseId ?? null,
      opts.confidence ?? 1.0,
    );
  } catch {
    /* non-fatal */
  }
}
```

- [ ] **Step 3: Run typecheck — answer-store.ts itself should compile clean**

Run: `npm run typecheck`

Expected: still failing in matcher.ts/solver.ts but answer-store.ts has no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/main/exam/answer-store.ts
git commit -m "$(cat <<'EOF'
feat(answer-store): JSON-array answers + source priority gate

- saveLearnedAnswer now stores answers as JSON.stringify(string[])
- lookupLearnedAnswer returns { answers: string[], source, confidence }
- decodeAnswers helper handles legacy single-string rows
- SOURCE_PRIORITY gates brute/llm from clobbering web-prefetch/history-solve
- Schema unchanged: answer TEXT remains, only producer/consumer semantics change

Prep work for v0.8.13 web-bank prefetch + multi-select support. matcher.ts
and solver.ts still reference the old shape; they are updated in follow-up
commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: matcher.ts — return `pickedIdxs[]`

**Files:**
- Modify: `src/main/exam/matcher.ts:1-90, 112-158, 210-231`

Change `findBestAnswer` to return `pickedIdxs: number[]` instead of `pickedIdx: number`. learned_answers (which now returns `answers: string[]`) maps multi-element arrays to multiple indices; mixed.db / Gemini still return single answers, mapped to a one-element array.

- [ ] **Step 1: Update `AnswerSource` to include `web-prefetch`**

Replace line 4:
```ts
export type AnswerSource = "db" | "fuzzy" | "llm" | "random" | "brute" | "web-prefetch";
```

- [ ] **Step 2: Add `findBestAnswer`'s new return shape**

Add an exported type just above `findBestAnswer` (at line 111):
```ts
export interface AnswerPick {
  source: AnswerSource;
  /** Index list into the question's options[]. Length 1 for single-select,
   *  >=1 for multi-select. */
  pickedIdxs: number[];
  confidence: number;
}
```

- [ ] **Step 3: Replace `findBestAnswer` to return `AnswerPick`**

Replace lines 112–158 with:
```ts
export async function findBestAnswer(
  questionText: string,
  options: string[],
  opts: { skipMixedDb?: boolean; courseName?: string } = {},
): Promise<AnswerPick> {
  // Layer 1: learned_answers — highest priority. May contain multi-select
  // answers (length >=2) sourced from web-prefetch, or single from any
  // earlier perfect-attempt / brute / llm hit.
  const learned = lookupLearnedAnswer(questionText);
  if (learned) {
    const idxs = learned.answers
      .map((ans) => pickOptionIndex(ans, options))
      .filter((i) => i >= 0);
    // Dedupe: pickOptionIndex's fuzzy fallback can map two different bank
    // answer texts to the same option (rare but possible). Keep first.
    const seen = new Set<number>();
    const dedup = idxs.filter((i) => (seen.has(i) ? false : (seen.add(i), true)));
    if (dedup.length > 0) {
      // Map source: if learned came from web-prefetch tag it as such so
      // the bySource counter in solver shows real provenance. Other sources
      // already use names compatible with AnswerSource.
      const src: AnswerSource =
        learned.source === "web-prefetch" ? "web-prefetch" : "db";
      return { source: src, pickedIdxs: dedup, confidence: learned.confidence };
    }
    // All bank answers failed to map to current exam options (e.g. wording
    // drift). Fall through to mixed.db / LLM as today.
  }

  // Layer 2a: 98K question bank.
  let dbFallback: AnswerPick | null = null;
  if (!opts.skipMixedDb) {
    const dbMatch = matchAgainstDb(questionText);
    if (dbMatch) {
      const pickedIdx = pickOptionIndex(dbMatch.correctText, options);
      if (dbMatch.confidence >= LLM_GATE_CONFIDENCE) {
        return {
          source: dbMatch.source,
          pickedIdxs: [pickedIdx],
          confidence: dbMatch.confidence,
        };
      }
      dbFallback = {
        source: dbMatch.source,
        pickedIdxs: [pickedIdx],
        confidence: dbMatch.confidence,
      };
    }
  }

  // Layer 3: Gemini LLM
  const llmMatch = await matchWithLlm(questionText, options, opts.courseName);
  if (llmMatch) {
    return {
      source: "llm",
      pickedIdxs: [llmMatch.pickedIdx],
      confidence: llmMatch.confidence,
    };
  }

  if (dbFallback) return dbFallback;

  return {
    source: "random",
    pickedIdxs: [Math.floor(Math.random() * Math.max(1, options.length))],
    confidence: 0,
  };
}
```

- [ ] **Step 4: Run typecheck — matcher.ts compiles, solver.ts now broken**

Run: `npm run typecheck`

Expected: matcher.ts clean. solver.ts errors at lines 594-596, 599 (uses `r.pickedIdx`, which no longer exists). Task 4 fixes solver.

- [ ] **Step 5: No commit yet** — Task 4's solver changes pair with this; both commit together.

---

## Task 4: solver.ts — multi-select submission + `pickedIdxs[]` adoption

**Files:**
- Modify: `src/main/exam/solver.ts:235-251, 540-614, 639-651, 864-870`

Change `selectOption` to accept multiple values, route `findBestAnswer`'s `pickedIdxs` through to checkbox check + form submit, and update all `saveLearnedAnswer` call sites to pass `answers: string[]`.

- [ ] **Step 1: Replace `selectOption` to accept `values: string[]`**

Replace lines 235–251 with:
```ts
async function selectOption(
  win: BrowserWindow,
  inputName: string,
  values: string[],
): Promise<void> {
  if (!inputName || values.length === 0) return;
  const safeN = inputName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const safeVals = values
    .map((v) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"'));
  // Submit each value: for radios, only the last sticks (single-select
  // behaviour preserved). For checkboxes, every match is checked.
  await execJs(
    win,
    `(() => {
      const vals = ${JSON.stringify(safeVals)};
      let any = false;
      for (const v of vals) {
        const el = document.querySelector('input[name="${safeN}"][value="' + v + '"]');
        if (el) { el.checked = true; el.dispatchEvent(new Event('change',{bubbles:true})); any = true; }
      }
      return any;
    })()`,
  );
}
```

- [ ] **Step 2: Update the `for (const q of questions)` loop in `runOneAttempt`**

Replace lines 575–614 with:
```ts
  for (const q of questions) {
    let pickedIdxs: number[];
    let source: AnswerSource;
    let confidence: number;

    const forcedKey = normalizeQuestion(q.text);
    const forcedIdx = opts.forcedAnswers?.get(forcedKey);
    if (typeof forcedIdx === "number" && forcedIdx >= 0 && forcedIdx < q.options.length) {
      // Brute-force probe path is single-only (it flips ONE option per round).
      pickedIdxs = [forcedIdx];
      source = "brute";
      confidence = 0;
    } else {
      const r = await findBestAnswer(q.text, q.options, {
        skipMixedDb: opts.skipMixedDb,
        courseName: opts.courseName,
      });
      pickedIdxs = r.pickedIdxs;
      source = r.source;
      confidence = r.confidence;
    }

    // Sanitize pickedIdxs against this exam's option count (defensive — bank
    // could in theory have stale options that no longer exist on the page).
    pickedIdxs = pickedIdxs.filter((i) => i >= 0 && i < q.options.length);
    if (pickedIdxs.length === 0) {
      // Fall back to a random pick rather than skipping the question.
      pickedIdxs = [Math.floor(Math.random() * Math.max(1, q.options.length))];
      source = "random";
      confidence = 0;
    }

    bySource[source]++;
    // picksByIdx tracks the FIRST chosen index per question for brute-force
    // bookkeeping (which only operates on single-select). Multi-select still
    // reports its first answer here; brute won't probe multi-select rows
    // since their answers are already cached as web-prefetch.
    picksByIdx[q.index] = pickedIdxs[0];

    const optsText = pickedIdxs
      .map((i) => q.options[i]?.slice(0, 30) ?? String(i + 1))
      .join(" | ");
    onProgress(
      `  Q${q.index + 1} [${source} ${confidence.toFixed(2)}]${
        pickedIdxs.length > 1 ? ` ×${pickedIdxs.length}` : ""
      } → ${optsText}`,
    );

    for (const idx of pickedIdxs) {
      const answerText = q.options[idx] ?? "";
      if (source === "llm") {
        llmAnswered.push({ question: q.text, answer: answerText });
      }
      if (answerText) {
        allPicks.push({ question: q.text, answer: answerText, source });
      }
    }

    const values = pickedIdxs.map((i) => q.values[i] ?? String(i + 1));
    await selectOption(win, q.inputName, values);
  }
```

- [ ] **Step 3: Update `saveLearnedAnswer` calls inside `runOneAttempt` (the score=100 + LLM persistence branch)**

Replace lines 635–652 with:
```ts
  if (score !== null) {
    if (score === 100) {
      // Group all picks for the same question, then save the multi-answer
      // array. This catches multi-select questions where pickedIdxs covered
      // multiple options.
      const grouped = new Map<string, string[]>();
      const sources = new Map<string, AnswerSource>();
      for (const { question, answer, source: src } of allPicks) {
        if (src === "random") continue;
        const arr = grouped.get(question) ?? [];
        arr.push(answer);
        grouped.set(question, arr);
        // Latest source wins; in practice all picks for a question share
        // a source (either web-prefetch, llm, etc).
        sources.set(question, src);
      }
      for (const [question, answers] of grouped) {
        const src = sources.get(question) ?? "perfect-attempt";
        saveLearnedAnswer({
          question,
          answers,
          source: src === "llm" ? "llm" : "perfect-attempt",
          confidence: src === "llm" ? 0.95 : 1.0,
          courseId: cid,
        });
      }
    } else {
      for (const { question, answer } of llmAnswered) {
        saveLearnedAnswer({
          question,
          answers: [answer],
          source: "llm",
          confidence: 0.85,
          courseId: cid,
        });
      }
    }
  }
```

- [ ] **Step 4: Update the brute-force `saveLearnedAnswer` call**

Replace lines 864–870 with:
```ts
            saveLearnedAnswer({
              question: st.questionText,
              answers: [st.options[probingOption] ?? ""],
              source: "brute",
              confidence: 0.95,
              courseId: cid,
            });
```

- [ ] **Step 5: Run typecheck — should be clean now**

Run: `npm run typecheck`

Expected: PASS (no errors).

- [ ] **Step 6: Commit Task 3 + Task 4 together (matcher + solver atomic change)**

```bash
git add src/main/exam/matcher.ts src/main/exam/solver.ts
git commit -m "$(cat <<'EOF'
feat(exam): multi-select question support end-to-end

- matcher.findBestAnswer returns AnswerPick { pickedIdxs: number[] }
- learned_answers multi-element arrays (web-prefetch source) propagate
  through to multi-checkbox submission
- solver.selectOption accepts string[] of values; for radios only the
  last sticks (preserves single-select behaviour), for checkboxes all
  matching values are checked
- saveLearnedAnswer call sites grouped per-question to write multi-answer
  arrays on score=100 perfect-attempt persistence
- AnswerSource adds "web-prefetch" enum value

This unblocks the v0.8.13 web-bank prefetch (next commit). Without this
change, multi-✓ answers from rodiyer.idv.tw could not be submitted.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: web-bank.ts — new module

**Files:**
- Create: `src/main/exam/web-bank.ts`

The web-bank module: load/refresh index, fuzzy-match course captions to bank titles, fetch+parse hit pages, write into `learned_answers` with `source="web-prefetch"`.

- [ ] **Step 1: Create the file with imports + types**

Create `src/main/exam/web-bank.ts`:
```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import { saveLearnedAnswer } from "./answer-store";
import { diceSimilarity } from "./matcher";
import { getStorageDir } from "../persist/storage-paths";

const FEED_BASE = "https://www.rodiyer.idv.tw/feeds/posts/default";
const FEED_PAGE_SIZE = 500;
const MATCH_THRESHOLD = 0.85;
const INDEX_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const FETCH_CONCURRENCY = 5;
const FETCH_TIMEOUT_MS = 15_000;
const ANSWER_MARKER = /^[✓✔〇●*]\s*(.+)$/;
const QUESTION_MARKER = /^[ \t　]*問\s+/m;

interface IndexEntry {
  title: string;
  url: string;
}

interface ParsedQA {
  question: string;
  answers: string[];
  distractors: string[];
}

export interface PrefetchResult {
  hit: number;
  miss: number;
  failed: number;
}
```

- [ ] **Step 2: Add the index loader (cache + paginated fetch)**

Append to `src/main/exam/web-bank.ts`:
```ts
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
      const link =
        $(el).find('link[rel="alternate"]').attr("href") ||
        $(el).find("link").first().attr("href") ||
        "";
      if (title && link) out.push({ title, url: link });
    });
    if (entries.length < FEED_PAGE_SIZE) break;
  }
  return out;
}

async function loadIndex(log: (m: string) => void): Promise<IndexEntry[]> {
  const path = indexCachePath();
  if (existsSync(path) && indexFresh(path)) {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as IndexEntry[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        log(`索引從快取載入：${parsed.length} 篇（24h 內有效）`);
        return parsed;
      }
    } catch {
      /* fall through to refetch */
    }
  }
  log(`抓取題庫索引...`);
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
}
```

- [ ] **Step 3: Add fuzzy match + title normalization**

Append:
```ts
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
```

- [ ] **Step 4: Add HTML parser**

Append:
```ts
/**
 * Parse a bank article's HTML into question/answer blocks.
 *
 * Format (verified against rodiyer.idv.tw 2026-04 articles):
 *   問 <question text>
 *   ✓ <correct option text>
 *   <distractor option text>
 *   ✓ <correct option text> (multi-select can have multiple)
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

  // Split by line-start "問 " (with optional leading whitespace).
  const blocks = text.split(/(?:^|\n)[ \t　]*問[ \t　]+/);
  const result: ParsedQA[] = [];
  for (const block of blocks) {
    const lines = block
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    const question = lines[0];
    const answers: string[] = [];
    const distractors: string[] = [];
    for (const line of lines.slice(1)) {
      const m = line.match(ANSWER_MARKER);
      if (m) answers.push(m[1].trim());
      else distractors.push(line);
    }
    if (question && answers.length > 0) {
      result.push({ question, answers, distractors });
    }
  }
  return result;
}

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
  if (parsed.length === 0) {
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

let parseDumpDone = false;
```

- [ ] **Step 5: Add public `prefetchCoursesViaWebBank` orchestrator**

Append:
```ts
export async function prefetchCoursesViaWebBank(
  cids: string[],
  courseNamesByCid: Map<string, string>,
  log: (msg: string) => void,
): Promise<PrefetchResult> {
  if (cids.length === 0) return { hit: 0, miss: 0, failed: 0 };

  let index: IndexEntry[];
  try {
    index = await loadIndex(log);
  } catch (e) {
    log(`索引載入失敗，跳過題庫 prefetch：${(e as Error).message}`);
    return { hit: 0, miss: 0, failed: cids.length };
  }
  if (index.length === 0) {
    log(`索引為空，跳過題庫 prefetch`);
    return { hit: 0, miss: 0, failed: cids.length };
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

  // Parallel fetch + parse + persist.
  const limit = pLimit(FETCH_CONCURRENCY);
  let hit = 0;
  let failed = 0;
  await Promise.all(
    tasks.map((t) =>
      limit(async () => {
        const qas = await fetchAndParseCourse(t.entry.url, log);
        if (qas.length === 0) {
          failed++;
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
        log(`✓「${t.caption.slice(0, 20)}」: ${qas.length} 題寫入 learned_answers`);
      }),
    ),
  );

  log(`題庫 prefetch 完成：${hit} 題寫入 / ${tasks.length - failed - (tasks.length - tasks.length + 0)} 課命中 / ${failed} 課抓失敗 / ${missCount} 課無對應頁`);
  return { hit, miss: missCount, failed };
}
```

Note the awkward final-log formula: `tasks.length - failed` is the success-course count (failed includes parse-zero). Simpler form:
```ts
  const successCourses = tasks.length - failed;
  log(`題庫 prefetch 完成：${hit} 題寫入 / ${successCourses} 課成功 / ${failed} 課失敗 / ${missCount} 課無對應`);
```
Use this simpler line in step 5 (replace the awkward formula).

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/exam/web-bank.ts
git commit -m "$(cat <<'EOF'
feat(exam): add web-bank prefetch module

src/main/exam/web-bank.ts — fetches rodiyer.idv.tw Atom feed (paginated),
fuzzy-matches course captions against article titles via Dice similarity
(threshold 0.85), parses 問/✓ blocks from hit pages, writes answers into
learned_answers with source="web-prefetch" confidence=1.0.

Index cached 24h at <storageDir>/web-bank-index.json. Per-fetch concurrency
limited to 5 with 15s timeout. Failure-tolerant: any single course's fetch
or parse failure is logged and skipped, total prefetch returns 0 hits if
network is down without throwing.

Not yet wired into runPipelineFor — that's the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: index.ts — fire prefetch in `runPipelineFor` parallel with heartbeat

**Files:**
- Modify: `src/main/index.ts:60-65 (imports), 1290-1320 (insert prefetch fire), 1318-1340 (await in runFinishChain)`

Fire `prefetchCoursesViaWebBank` after enrol completes, in parallel with the heartbeat batch. Hold the promise so chains for `skipRead` courses can await it before invoking `solveExam`.

- [ ] **Step 1: Add import for web-bank module**

In `src/main/index.ts`, add to existing exam imports near line 62:
```ts
import { solveExam } from "./exam/solver";
import { fillSurvey } from "./survey/filler";
import { prefetchCoursesViaWebBank } from "./exam/web-bank";
```

- [ ] **Step 2: Fire prefetch promise after `acquireCourseOwnership` loop**

Locate the section right after the `for (const t of allNeedReading)` ownership-acquire loop ends (around line 1564 with `if (queued.length > 0) pushState();`). Insert immediately after `if (queued.length > 0) pushState();` and before the next code section:

```ts
  // v0.8.13: fire web-bank prefetch in parallel with heartbeat. Promise is
  // held so per-course chains can await it (especially skipRead courses
  // that go straight to chain without a heartbeat phase).
  const allTracked = [...immediate, ...queued, ...skipRead];
  const courseNamesByCid = new Map<string, string>();
  for (const t of allTracked) courseNamesByCid.set(t.course.cid, t.course.caption ?? "");
  const prefetchCids = allTracked.map((t) => t.course.cid);
  let prefetchPromise: Promise<{ hit: number; miss: number; failed: number }>;
  if (prefetchCids.length > 0) {
    prefetchPromise = prefetchCoursesViaWebBank(
      prefetchCids,
      courseNamesByCid,
      (msg) => logSession(s, "info", `[題庫] ${msg}`),
    ).catch((e) => {
      logSession(s, "warn", `[題庫] prefetch 例外：${(e as Error)?.message ?? e}`);
      return { hit: 0, miss: 0, failed: prefetchCids.length };
    });
  } else {
    prefetchPromise = Promise.resolve({ hit: 0, miss: 0, failed: 0 });
  }
```

(Both `immediate` / `queued` are defined just above this point in the existing code, around line 1547-1563. `skipRead` is defined further up at line 1276-1284.)

- [ ] **Step 3: In `runFinishChain`, await prefetchPromise with 30s timeout before solveExamFromHistory**

Find the existing block at lines 1330-1334:
```ts
      let examOK = passed;
      if (!passed && !s.abortSignal.aborted) {
        try {
          const { solveExamFromHistory } = await import("./exam/history-solver");
          const r = await solveExamFromHistory(session, cid, (m) =>
```

Insert the prefetch await BEFORE the `try { const { solveExamFromHistory } ... }`:

```ts
      let examOK = passed;
      if (!passed && !s.abortSignal.aborted) {
        // v0.8.13: race the shared prefetch promise with a 30s timeout.
        // Fast path (heartbeat-driven chains): prefetch already resolved.
        // Edge path (skipRead courses with no heartbeat): chain hits this
        // before web-bank has finished — wait briefly so learned_answers
        // is populated before solveExam reads it.
        const PREFETCH_TIMEOUT_MS = 30_000;
        await Promise.race([
          prefetchPromise,
          new Promise<void>((resolve) => setTimeout(resolve, PREFETCH_TIMEOUT_MS)),
        ]);

        try {
          const { solveExamFromHistory } = await import("./exam/history-solver");
          const r = await solveExamFromHistory(session, cid, (m) =>
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "$(cat <<'EOF'
feat(pipeline): wire web-bank prefetch into runPipelineFor

After enrol/ownership acquire, fire prefetchCoursesViaWebBank in parallel
with the heartbeat batch (fire-and-forget for the heartbeat path). chain's
runFinishChain awaits the shared prefetch promise with a 30s timeout
before solveExamFromHistory; this covers the edge case where a course is
already past its reading phase when the pipeline starts (account C
scenario where every course landed in chain immediately).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: UI — Monitor `📥 題庫` global badge

**Files:**
- Modify: `src/shared/ipc.ts` (AppState type)
- Modify: `src/main/index.ts` (push prefetch progress into state)
- Modify: `src/renderer/src/App.tsx` (render badge)

Add a small global badge to the Monitor screen showing prefetch progress (`📥 題庫 X/Y` or done state). Per-course `🌐` icons are deferred (spec marks them informational/optional).

- [ ] **Step 1: Add `webBankProgress` field to `AppState` in shared/ipc.ts**

Find the `AppState` (or per-account session state) interface and add:
```ts
webBankProgress?: {
  running: boolean;
  hit: number;
  miss: number;
  failed: number;
  totalCourses: number;
};
```

(Locate the exact interface name — likely `AppState` or `AccountSessionState` — using `grep -n "interface AppState\|courses:\s*Course" src/shared/ipc.ts`.)

- [ ] **Step 2: Push state updates from prefetch in index.ts**

Replace the prefetch fire block from Task 6 Step 2 with progress reporting:
```ts
  if (prefetchCids.length > 0) {
    s.state.webBankProgress = {
      running: true,
      hit: 0,
      miss: 0,
      failed: 0,
      totalCourses: prefetchCids.length,
    };
    pushState();
    prefetchPromise = prefetchCoursesViaWebBank(
      prefetchCids,
      courseNamesByCid,
      (msg) => logSession(s, "info", `[題庫] ${msg}`),
    )
      .then((res) => {
        s.state.webBankProgress = {
          running: false,
          hit: res.hit,
          miss: res.miss,
          failed: res.failed,
          totalCourses: prefetchCids.length,
        };
        pushState();
        return res;
      })
      .catch((e) => {
        logSession(s, "warn", `[題庫] prefetch 例外：${(e as Error)?.message ?? e}`);
        s.state.webBankProgress = {
          running: false,
          hit: 0,
          miss: 0,
          failed: prefetchCids.length,
          totalCourses: prefetchCids.length,
        };
        pushState();
        return { hit: 0, miss: 0, failed: prefetchCids.length };
      });
  } else {
    prefetchPromise = Promise.resolve({ hit: 0, miss: 0, failed: 0 });
  }
```

- [ ] **Step 3: Render the badge in App.tsx Monitor section**

Locate the Monitor screen header — search for `state.now.action === "heartbeat"` or the section that renders the action stepper. Add a sibling element (e.g. just after the header):
```tsx
{state.webBankProgress && (
  <div className="text-xs text-zinc-400 px-3 py-1 bg-zinc-800/50 rounded inline-flex items-center gap-2">
    <span>📥 題庫</span>
    {state.webBankProgress.running ? (
      <span className="text-amber-400">抓取中...</span>
    ) : (
      <span>
        {state.webBankProgress.hit} 題 ·{" "}
        {state.webBankProgress.totalCourses - state.webBankProgress.miss - state.webBankProgress.failed}/
        {state.webBankProgress.totalCourses} 課命中
      </span>
    )}
  </div>
)}
```

(Match the existing tailwind styling — find a similar small chip/badge in the file and copy class structure.)

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc.ts src/main/index.ts src/renderer/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(ui): show web-bank prefetch progress on Monitor screen

Adds a small 📥 題庫 badge at the top of the Monitor that shows
"抓取中..." while prefetch is running, then "<N> 題 · <X>/<Y> 課命中"
once it finishes. Uses a new optional state.webBankProgress field;
silent fallback (no badge) when not running.

Per-course 🌐 source icons deferred — spec marks them informational.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Manual end-to-end verification

**Files:** none modified — this is the runtime verification step before bumping version.

- [ ] **Step 1: Run dev**

```bash
npm run dev
```

Expected: Electron window opens, no errors in console.

- [ ] **Step 2: Test happy path — known-good course (C scenario)**

In the Electron app: log in to account C (the one that ran 9 failures earlier today). Pick the course `行政院與所屬中央及地方各機關（構）公務員勤休制度宣導課程-115年` and click Start.

Expected log lines:
```
[題庫] 抓取題庫索引...
[題庫] 索引已更新：~2056 篇，存於 <path>
[題庫] 索引比對完成：1 命中 / 0 miss / ...
[題庫] ✓「行政院與所屬中央...」: 10 題寫入 learned_answers
[題庫] 題庫 prefetch 完成：10 題寫入 / 1 課成功 / ...
```

Then heartbeat / chain runs. When it hits the exam:
```
[<課名>] [測驗 #1] 10 題
  Q1 [web-prefetch 1.00] → 50
  ...
[<課名>] [測驗 #1] 分數：100
測驗完成 ...：✅ 通過 100 分
```

If score is 100 on attempt #1, this task is done. If score < 100, inspect the log for `Q* [random ...]` or `Q* [db ...]` — that means option-text matching dropped some bank answers; record which questions for follow-up.

- [ ] **Step 3: Test multi-select submission**

Use the same course (it has at least one multi-select question per the bank). Use Electron devtools (Ctrl+Shift+I in dev) → Network tab to inspect the form POST. Filter for `course_record.php` or `exam_submit`. Confirm the submitted payload has multiple values for the multi-select question's name (not just one).

- [ ] **Step 4: Test miss path — non-bank course**

Pick any of A account's lab safety courses (these are not on rodiyer.idv.tw). Confirm log shows:
```
[題庫] 索引比對完成：0 命中 / 1 miss
```
And the exam falls through to mixed.db / LLM / brute-force as before. No regression.

- [ ] **Step 5: Test priority gate**

After Step 2 succeeded, manually run a brute-force scenario on a non-bank course. Then query the DB:
```bash
sqlite3 "<storageDir>/auto-elearn.db" "SELECT source, length(answer), confidence FROM learned_answers ORDER BY captured_at DESC LIMIT 20"
```

Expected: rows have `source IN ('web-prefetch', 'brute', 'perfect-attempt', 'llm')`. Critically: no `web-prefetch` row should have been overwritten by a later `brute` row for the same question. (Hard to verify directly; if Step 2 still scores 100 on a re-run after some brute activity, the gate is working.)

- [ ] **Step 6: No commit yet** — verification only.

---

## Task 9: Version bump + release

**Files:**
- Modify: `package.json` (version)

- [ ] **Step 1: Bump version**

```bash
sed -i 's/"version": "0.8.12"/"version": "0.8.13"/' package.json
grep '"version"' package.json
```

Expected: `"version": "0.8.13"`

- [ ] **Step 2: Final pre-commit checks**

```bash
npm run typecheck
npm run build
```

Expected: both pass clean.

- [ ] **Step 3: Commit, push, tag, push tag**

```bash
git add package.json
git commit -m "$(cat <<'EOF'
chore: bump version to 0.8.13

Release v0.8.13: exam web-bank prefetch + multi-select question support.
Courses present on rodiyer.idv.tw now pass on first exam attempt; multi-✓
answers are submitted correctly across the stack for the first time.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push
git tag v0.8.13
git push --tags
```

- [ ] **Step 4: Verify GitHub Actions release**

Wait for the `release.yml` workflow triggered by `v0.8.13` to finish (typically ~3–5 min on this repo). Visit the GitHub Releases page.

Expected:
- Workflow status: green
- Release `v0.8.13` exists
- Single asset attached: `auto-elearn-0.8.13-win-portable.zip`
- No additional files like `auto-elearn.zip` / `elevate.zip` (project rule from CLAUDE.md "Release 流程")

If the release zip count is wrong, **stop** and inspect `release.yml` — do not delete and re-tag from a different commit until the workflow's zip selection matches `*-win-portable.zip` exactly.

---

## Task 10: CLAUDE.md + memory updates (final commit)

**Files:**
- Modify: `CLAUDE.md`
- Modify: `C:\Users\h1114\.claude\projects\D--Projects--HomeProject-auto-elearn\memory\MEMORY.md` (or the project's `memory/` location)
- Create: `<memory dir>/reference_web_bank_format.md`
- Modify: `<memory dir>/reference_exam_threshold.md`

After release succeeds, document the new mechanism so the next session has full context.

- [ ] **Step 1: Add `Web 題庫 prefetch (v0.8.13+)` section to `CLAUDE.md`**

Insert under the existing "Domain Knowledge — e等公務園" section (after the "沒有「心得」階段" subsection or at end):

```md
### Web 題庫 prefetch (v0.8.13+)

#### 為什麼出現
v0.8.12 實測：C 帳號 9 門考試 0/9 通過 (40/70/30/50/40/50/40/20/50)。Brute force 在隨機抽題、多選題、是非題上完全失效。題庫網站 rodiyer.idv.tw 收 ~2056 篇 elearn 課程解答頁（標題「【解答】<課名>」、內文「問 ... ✓正解」格式），是現成 ground truth 來源。

#### 流程
- enrol 完 → fire `prefetchCoursesViaWebBank` 跟 heartbeat 並行
- 索引：`<storageDir>/web-bank-index.json`，24h cache，從 RSS feed `/feeds/posts/default?max-results=500&start-index=N` 分頁拉
- match：用 fast-fuzzy dice，threshold 0.85，標題/caption 都先去 `【解答】` 跟 `-115年` 後綴
- 命中課程 cheerio parse `問` block + `✓ ✔ 〇 ● *` 開頭行 = 正解，其他 = distractor
- write-through 進 learned_answers，`source="web-prefetch"`, `confidence=1.0`
- skipRead 課（一打開就在考試階段）chain 在 solveExamFromHistory 之前 await 共用 prefetch promise，30s timeout

#### Multi-select 同時修
v0.8.12 之前 solver 偵測到 `isMultiple` 但 selectOption 只送一個選項，多選題必判錯。v0.8.13 把這條鏈改成 multi：
- `learned_answers.answer` 改存 JSON array (`["選項A","選項B"]`)，舊單字串 row 用 decodeAnswers 自動 fallback
- `findBestAnswer` 回 `pickedIdxs: number[]`
- `selectOption(values: string[])` 對 checkbox 全部 check，radio 只有最後一個會 stick

#### Source priority gate
saveLearnedAnswer 加守則：新 source priority 比既存低就 silent skip（不覆蓋）。優先序：
- web-prefetch (10) > history-solve (8) > perfect-attempt (7) > llm (5) > db (4) > fuzzy (3) > result-page (2) > brute (1) > random (0)
這樣 brute 試錯不會覆蓋 web-prefetch 的高 confidence 正解。

#### 失敗 fallback
題庫網站 down / 某課沒命中 / parse 失敗 → silent，learned_answers 不寫入，原 4 層 (history-solver / mixed.db / LLM / brute) 照常跑。
```

- [ ] **Step 2: Add lesson learned about multi-select bug pre-v0.8.13**

In the same CLAUDE.md, near the existing "沒有「心得」階段（v0.4.7 起）" or in a "教訓" section, add:
```md
### v0.8.13 之前多選題完全沒處理
solver 雖然偵測到 `isMultiple = inputs[0].type === 'checkbox'`，但 `pickedIdx: number` 跟 `selectOption(value: string)` 都只送單一選項。Server 多選判錯/部分得分，brute 試試看每個選項都一樣分（因為 baseline 一直都是 0 對），結論「全錯」永遠收不下來。修法在 v0.8.13：matcher 回 `pickedIdxs: number[]`、selectOption 接 `values: string[]`、learned_answers 存 JSON array。
```

- [ ] **Step 3: Add `web-bank-index.json` to persistence layout doc**

In the existing "user-data SQLite 必須 chmod" or persistence section, add a one-liner:
```md
v0.8.13 起 storageDir 多一個檔：`web-bank-index.json` (24h cache 的題庫索引)。
```

- [ ] **Step 4: Create `memory/reference_web_bank_format.md`**

```md
---
name: rodiyer.idv.tw 題庫格式
description: e 等公務園解答題庫網站的 URL pattern、RSS feed 規則、HTML parse 格式 — 重新發現成本高，記住免再 reverse engineer
type: reference
---

站方：https://www.rodiyer.idv.tw（Blogger 架站）

## URL pattern
- 文章：`/YYYY/MM/{slug}.html`，slug 沒有規律（例 `/2026/04/115_86.html`）
- RSS feed：`/feeds/posts/default?max-results=500&start-index=N`
  - 預設 page size 25，可加 `max-results=500` 拉到上限
  - `start-index=1` 開始，每頁回傳 entries 數 < page size 即末頁
  - 全站約 2056 篇（2026-05 觀察）

## 標題格式
- `【解答】<課程全名>`
- 課名常含年份後綴：`-115年` / `-114年度`
- normalize：去 `【解答】` 前綴 + 去年份後綴 + 去空白後做 fuzzy

## 內文格式
DOM 容器嘗試順序（first non-empty wins）：`.post-body` → `.entry-content` → `article` → `body`

```
問 <題目>
✓ <正確選項>
  <錯誤選項>
✓ <另一個正確選項>  ← 多選題會多個 ✓
```

正解標記字元 cover：`✓ (U+2713)` `✔ (U+2714)` `〇` `●` `*`

## 在 auto-elearn 怎麼用
- v0.8.13+ `src/main/exam/web-bank.ts` 整套處理（fetch index → fuzzy match → fetch HTML → parse → write learned_answers）
- 寫進 `learned_answers` `source="web-prefetch"` `confidence=1.0`
- threshold dice 0.85
```

- [ ] **Step 5: Update `memory/reference_exam_threshold.md`**

Append a section:
```md
## v0.8.13 補充
- 答題優先序變了：web-prefetch (10) 是最強來源；brute (1) 降為最後 fallback
- learned_answers 跨帳號自動共享 — 第一個帳號 prefetch 寫入，其他帳號考同 cid 直接命中
- saveLearnedAnswer 有 priority gate：低 priority 不能覆蓋高 priority；確保 brute 不會洗掉 web-prefetch
- 多選題終於有處理：findBestAnswer 回 pickedIdxs[]，selectOption 接 values[]
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
# Memory commits separately (different repo / git-ignored / depending on memory persistence model)
git commit -m "$(cat <<'EOF'
docs(claude.md): document v0.8.13 web-bank prefetch + multi-select fix

- Add "Web 題庫 prefetch (v0.8.13+)" section under elearn domain knowledge
- Add lesson learned: multi-select was completely unhandled pre-v0.8.13
- Note web-bank-index.json in persistence layout

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git push
```

For memory files, write them via the Write tool (per CLAUDE.md auto-memory section). They live outside the repo and don't need git commits.

---

## Self-review

(Performed inline 2026-05-05 after writing the plan.)

**Spec coverage check:**
- ✓ web-bank.ts component → Task 5
- ✓ db.ts schema migration → Task 1 (runtime semantics, no DDL)
- ✓ answer-store.ts type+priority gate → Tasks 1+2
- ✓ matcher.ts pickedIdxs[] → Task 3
- ✓ solver.ts selectOption multi → Task 4
- ✓ index.ts runPipelineFor wire → Task 6
- ✓ App.tsx UI badge → Task 7
- ✓ Data flow / source priority / error handling — implemented across Tasks 1, 2, 5, 6
- ✓ Backwards compat (decodeAnswers fallback) → Task 1
- ✓ Testing strategy — Task 8 (manual e2e mirrors spec test plan)
- ✓ Migration / release impact → Tasks 9+10
- ✓ Open questions are explicit non-decisions; no extra task needed

**Placeholder scan:** all steps have concrete code + commands. No "TBD" / "TODO" / "implement appropriately". Task 7 Step 1 says "locate the exact interface name … using grep" — that's a real one-line discovery action, not a placeholder.

**Type consistency:**
- `SaveAnswerOpts.answers: string[]` matches usage in Task 4 (`answers: [text]`) and Task 5 (`answers: qa.answers`)
- `LearnedAnswerRow.answers: string[]` matches matcher's consumption in Task 3 (`learned.answers.map(...)`)
- `AnswerPick.pickedIdxs: number[]` matches solver consumption in Task 4 (`pick.pickedIdxs.map(i => ...)`)
- `prefetchCoursesViaWebBank` signature in Task 5 matches the call site in Task 6
- `SOURCE_PRIORITY` keys in Task 2 match the `CASE source` ORDER BY in Task 1

**Commit ordering:** schema runtime + priority gate ship together (Tasks 1+2 → one commit). matcher + solver share a commit (Tasks 3+4) since they must change together to compile. web-bank.ts ships standalone (Task 5). Wiring + UI ship as separate commits (Tasks 6, 7) so each is independently revertable. Version bump and CLAUDE.md updates are last (Tasks 9, 10) — release tag points at a complete feature.

No issues found requiring fixes. Plan is ready for execution.
