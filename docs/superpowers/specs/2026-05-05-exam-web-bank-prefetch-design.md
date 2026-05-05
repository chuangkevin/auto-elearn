# Exam Web Bank Prefetch — Design Spec

Date: 2026-05-05  
Target release: v0.8.13  
Scope: replace failing brute-force as primary exam strategy with web-bank prefetch; add multi-select question support throughout the stack.

## Problem

Real-run baseline (account C, 9 exams, 2026-05-05): **0/9 passed** (40 / 70 / 30 / 50 / 40 / 50 / 40 / 20 / 50 vs thresholds 60–75). Brute-force probe is structurally unfit for elearn's exam style:

- **Random question sampling**: each attempt draws different 10-question subsets from a pool. `forcedAnswers` map keyed by normalized question fails to lock other questions, so per-attempt scores swing ±20–40. Brute interprets every score drop as "tried option wrong" and locks the original (also wrong) answer.
- **Multi-select questions**: `extractQuestions` correctly detects `isMultiple` (`solver.ts:206`) but the rest of the pipeline ignores it — `pickedIdx: number` and `selectOption(value: string)` always submit exactly one option. Server marks every multi-select wrong (or partial). Brute sees identical scores across all options of a multi-select, exhausts the queue, never converges.
- **True/false questions**: only 2 options. When brute observes "same score" on opt[0], it tries "next option" — but there is none, so it skips without making a determination. Brute principle (`-10 → original wrong, +10 → tried option right`) cannot disambiguate true/false ties.

A user-supplied resource resolves this: `rodiyer.idv.tw` is a Blogger-hosted question bank with 2056 articles. Each article's title is `【解答】<full course name>` and the body lists `問 ...` followed by options where correct answers are prefixed with `✓`. This gives ground-truth answers for any course on the site, including multi-select.

## Goal

Add a fourth answer source ("web bank") that is consulted **before** the existing 4 layers, write hits into the shared `learned_answers` SQLite cache, and fix the multi-select submission path so multi-✓ answers can actually be used. Keep history-solver, mixed.db lookup, LLM, and brute-force as fallbacks for courses the bank does not cover.

After this change, courses that have a bank entry should pass on the first attempt with score 100. Courses without a bank entry should behave no worse than today.

## Out of scope

- Replacing or rewriting brute-force. It stays as a tail fallback.
- Replacing `history-solver`. Independent path, low hit rate but zero cost when it works.
- Discovering new question-bank sources beyond `rodiyer.idv.tw`.
- Improving brute-force signal robustness (e.g., ignoring `±30+` swings). Out of scope; if web bank covers most graded courses the brute path's accuracy stops mattering.
- UI to let users manually pick / override which question-bank entry to use.

## Architecture

```
runPipelineFor(session, cids)
  ├─ enrol (existing)
  ├─ ┌─────── parallel ───────┐
  │  │ heartbeatBatch (existing)
  │  │ webBankPrefetch (NEW)   ← fire-and-forget; writes learned_answers
  │  └────────────────────────┘
  ├─ halfway → startChainOnce → solveExam
  │     └─ awaits prefetch up to 30s if no halfway phase
  └─ chain finalize (existing)

solveExam (existing path, no new layer in solver itself)
  ├─ history-solver (L1, unchanged)
  ├─ matcher.findBestAnswer (L2-3)
  │     ├─ lookupLearnedAnswer  ← natural hit on web-prefetch rows
  │     ├─ lookupByLike / mixed.db
  │     └─ Gemini LLM
  └─ runExamLoop brute (L4, gated)
```

The web bank does **not** add a new code path inside `solveExam`. It writes high-confidence rows into `learned_answers` before exam time; `findBestAnswer`'s existing first lookup picks them up. This keeps `solveExam` and `runExamLoop` untouched at the integration boundary.

## Components

### `src/main/exam/web-bank.ts` (new, ~200–250 lines)

Public surface:
```ts
export async function prefetchCoursesViaWebBank(
  cids: string[],
  courseNamesByCid: Map<string, string>,
  log: (msg: string) => void,
): Promise<{ hit: number; miss: number; failed: number }>;
```

Implementation outline:
1. **Index load**: cache file path is `<storageDir>/web-bank-index.json`, where `storageDir = getStorageDir()` from `src/main/persist/storage-paths.ts` (resolves to portable / packaged / dev `userData` location). Read cache if `mtime > now - 24h`. Otherwise fetch full index from `https://www.rodiyer.idv.tw/feeds/posts/default?max-results=500&start-index=N` paginated until exhausted (~5 calls for 2056 entries). Persist as `[{title, url}]`.
2. **Per-course match**: for each `cid`, normalize the course caption (strip whitespace, full-width spaces, year suffix `-115年`/`-114年度`/etc.), normalize each candidate title (also strip leading `【解答】`, year suffix, whitespace), compute Dice bigram similarity via `fast-fuzzy`. Pick the best title with similarity ≥ 0.85. Below threshold → silent miss.
3. **HTML fetch + parse**: `fetch(url)`, parse with `cheerio`. Text extraction tries selectors **in this order, first non-empty wins**: `.post-body` → `.entry-content` → `article` → `body`. Then split by `^\s*問\s+` (line-start, allowing leading whitespace). Per block: first line = question; subsequent lines starting with one of `✓ ✔ 〇 ● *` are correct answers, others are distractors. Drop blocks with empty question or zero answers.
4. **Persist**: for each `(question, answers[], distractors[])`, call `saveLearnedAnswer({ question, answers, source: "web-prefetch", confidence: 1.0, courseId: cid })`.
5. **Concurrency**: at most 5 parallel HTML fetches (use `p-limit`). Per-fetch timeout 15s.
6. **Failure tolerance**: any single course's fetch / parse failure logs a warning and continues. Total prefetch failure (e.g., DNS down) returns `{ hit: 0, miss: 0, failed: cids.length }` without throwing.

### `src/main/db.ts` — schema migration

Current row stores `answer TEXT`. Migrate to JSON-array semantics **without changing the column type**:
- Old data: plain string like `"選項A"` — runtime treats as `["選項A"]`.
- New writes: `JSON.stringify(["選項A", "選項B"])`.
- No `ALTER TABLE` needed. The column stays `TEXT`; only producer/consumer changes.

Rationale: avoiding `ALTER` keeps the migration zero-risk and self-healing. Read path tries `JSON.parse`; if it succeeds and yields an array, use it; otherwise treat the raw string as a single-element array.

### `src/main/exam/answer-store.ts`

Type changes:
```ts
type LearnedAnswerRecord = {
  question: string;
  answers: string[];      // length 1 for single-select, ≥1 for multi-select
  source: AnswerSource;
  confidence: number;
  capturedAt: number;
};

type SaveAnswerOpts = {
  question: string;
  answers: string[];      // was: answer: string
  source: AnswerSource;
  confidence?: number;
  courseId?: string;
};
```

`AnswerSource` adds `"web-prefetch"`.

`saveLearnedAnswer`:
```ts
const PRIORITY: Record<AnswerSource, number> = {
  "web-prefetch": 10,
  "history-solve": 8,
  "perfect-attempt": 7,
  llm: 5,
  db: 4,
  fuzzy: 3,
  "result-page": 2,  // legacy, kept for backwards compat
  brute: 1,
  random: 0,
};
```

Save logic: read existing row's source priority. If new priority < existing priority → silent skip (don't overwrite high-quality answer with lower-quality probe). Otherwise `INSERT OR REPLACE` with `JSON.stringify(answers)`.

Lookup: `lookupLearnedAnswer(question)` returns `{ answers: string[], source, confidence } | null`. Decode with `JSON.parse` fallback to `[raw]`.

`lookupByLike` (mixed.db) is unchanged — that table only has single-correct columns; multi-select doesn't apply.

### `src/main/exam/matcher.ts`

`findBestAnswer` signature evolves:
```ts
type AnswerPick = {
  pickedIdxs: number[];   // was: pickedIdx: number
  source: AnswerSource;
  confidence: number;
};
```

Single-select callers see `pickedIdxs.length === 1` and use `pickedIdxs[0]`. Multi-select uses the full array.

Logic:
- `lookupLearnedAnswer` returns `answers: string[]`. Map each to its option index by `q.options.indexOf(answer)`. Drop `-1` (unmatched). If any survive, return them as `pickedIdxs`.
- `lookupByLike` (mixed.db) and Gemini LLM return single answers; map to `pickedIdxs: [idx]`.
- Random fallback for multi-select: pick **exactly one** index (current behavior). Picking all is also a guess and may score lower than picking one if the server uses subtractive scoring (correct − incorrect). Without knowing the scoring rule, status-quo is safer; this only affects courses with no bank entry, which were 0/scoring already pre-v0.8.13.

### `src/main/exam/solver.ts`

`selectOption` signature:
```ts
async function selectOption(
  win: BrowserWindow,
  inputName: string,
  values: string[],   // was: value: string
): Promise<void>;
```

For each value: `el.checked = true` + dispatch `change` event. Browser allows multiple checked checkboxes naturally; for radios it'll just keep the last one (which is identical to current behavior for single-select).

Submission loop in `runExamAttempt`:
```ts
const value = q.values[pickedIdx] ?? String(pickedIdx + 1);
await selectOption(win, q.inputName, value);
```
becomes
```ts
const values = pick.pickedIdxs.map(i => q.values[i] ?? String(i + 1));
await selectOption(win, q.inputName, values);
```

`saveLearnedAnswer` calls in solver pass `answers: q.options[idx] ? [q.options[idx]] : []` for single-select paths and the full text array for multi-select. Brute-force still probes one index at a time but writes single-element `answers: [text]`.

### `src/main/index.ts` (`runPipelineFor`)

Add prefetch fire after enrol, before heartbeat batch:
```ts
// After enrol resolves, before runHbBatch:
const prefetchPromise = prefetchCoursesViaWebBank(
  immediate.map(t => t.course.cid).concat(queued.map(t => t.course.cid)),
  new Map(allCids.map(cid => [cid, courseCaptionFor(cid)])),
  msg => logSession(s, "info", `[題庫] ${msg}`),
);
// Don't await; run in parallel with heartbeat.
```

For the edge case where a course is already past halfway when pipeline starts (account C scenario): chain's first step is to await the **single shared `prefetchPromise`** with a 30s total timeout (not per-course — one prefetch call covers all cids; chain just races it once). If timeout, proceed without web-bank answers — original 4 layers handle it. After the first chain awaits and the prefetch resolves, subsequent chains see the resolved promise and proceed instantly.

### `src/renderer/src/App.tsx` (Monitor screen)

Stepper gets a new badge: `📥 題庫 (N/M)` showing prefetched-count / total-courses. Per-course card shows a small `🌐` icon when its `learned_answers` row was sourced from `web-prefetch` (purely informational).

## Data flow (timeline)

```
T+0      User clicks Start
T+1-5s   enrolMany completes for all needed courses
T+5s     ┌─ heartbeatBatch starts (5min/course cycle)
         └─ prefetchCoursesViaWebBank fires in parallel
T+5-15s    └─ fetch web-bank-index (or load 24h cache)
T+15-25s   └─ fuzzy match + parallel fetch HTML for hits
T+25s      └─ parse, saveLearnedAnswer × N rows × M courses
                ✓ web-prefetch rows now in DB
T+~150s  halfway triggers chain → solveExam
           └─ matcher.findBestAnswer 
                └─ lookupLearnedAnswer hits web-prefetch row
                └─ pickedIdxs = [idx of correct option]
                └─ multi-select: pickedIdxs = [idxA, idxB, idxD]
           └─ submit → score 100 → all picks saved as perfect-attempt
T+ ...    chain finalize, server caption flips 已通過
```

## Source priority table

```
web-prefetch    10   ← from rodiyer.idv.tw, ground truth
history-solve    8   ← derived from past exam attempt scores
perfect-attempt  7   ← all picks confirmed by score=100
llm              5   ← Gemini, gated at confidence ≥ 0.4
db               4   ← mixed.db prefix LIKE hit
fuzzy            3   ← mixed.db distinctive-gram OR hit
result-page      2   ← legacy, no longer written
brute            1   ← score-delta probe, often unreliable
random           0   ← never persisted
```

`saveLearnedAnswer`'s priority gate: `new.priority < existing.priority` → skip. Equal or higher → `INSERT OR REPLACE`.

## Error handling

- **Index fetch fails** (network down, 5xx): try once, log warning, return zero hits. App continues with original 4 layers.
- **Single course HTML fetch fails / 404**: log warning for that course, others continue.
- **Parse yields zero questions**: log diagnostic dump (first 8KB of body text to `%TEMP%/auto-elearn-web-bank-parse.txt`), skip course.
- **Question text from bank does not match exam page question text**: `lookupLearnedAnswer` simply returns null (the bank's normalized key just doesn't match this attempt's normalized question). Falls through to mixed.db → LLM → brute as today.
- **`q.options.indexOf(answer)` returns -1** (bank answer text differs from exam page wording): drop that answer from `pickedIdxs`. If all dropped → fall through to next layer.
- **Multi-select where bank says 3 ✓ but exam page only renders 2 matching options**: submit the 2 that matched; partial credit better than guess. Server reports actual score; if below passing, brute will probe.

## Backwards compat

- Existing `learned_answers` rows are plain strings. Reader does `JSON.parse(text)` first; on `SyntaxError` returns `[text]`. New writes always use `JSON.stringify(array)`. After one production run, rows are mixed format and both work.
- Old `result-page` source rows: kept readable, never re-written.
- `mixed.db` is read-only and structurally single-answer. No change.

## Testing strategy

This project has no unit-test runner today (no `vitest` / `jest`); all verification is manual against the dev Electron build (consistent with existing CLAUDE.md "Verify behavior in a real runnable environment" rule). Test plan:

- **Parse fixture (manual sanity, ad-hoc Node script)**: before wiring `parseQA` into the pipeline, run a one-off `node` script that imports the function, fetches a known bank page (e.g., the `公務員勤休制度-115年` URL), and prints `{question, answers, distractors}` for visual inspection. Repeat for one multi-select page and one true/false page. Confirm shapes look right. Discard the script.
- **Priority gate sanity (manual SQLite probe)**: after first prefetch run, query `learned_answers` directly (`sqlite3 auto-elearn.db "SELECT source, answer FROM learned_answers WHERE course_id='<cid>' LIMIT 5"`); confirm rows have `source='web-prefetch'` and `answer` is valid JSON array. Then run an exam that triggers brute fallback for a non-bank course; confirm those rows have `source='brute'` and don't overwrite earlier web-prefetch rows.
- **Integration (dev mode end-to-end)**: enrol the known-good course `行政院與所屬中央及地方各機關（構）公務員勤休制度宣導課程-115年` (account C scenario reproducer), confirm prefetch logs `1 hit`, confirm exam scores 100 on first attempt, confirm Monitor stepper shows `📥 題庫 1/N`.
- **Regression (manual)**: enrol a course **not** on rodiyer (any of A account's lab safety courses), confirm prefetch logs `0 hit, N miss`, confirm exam falls through to mixed.db / LLM / brute as today (no behavior change).
- **Multi-select submission verification**: pick a known multi-select course from the bank, run exam, inspect Electron devtools network panel to confirm form submit payload contains multiple checked values for the multi-select question's `inputName`.

Future work (out of scope for v0.8.13): add `vitest` setup so `parseQA`, `normalizeQuestion`, and `saveLearnedAnswer` priority gate get automated tests. Tracked in `docs/research/` if/when tooling lands.

## Migration / Release impact

- `package.json` version bump: `0.8.12` → `0.8.13`.
- Tag `v0.8.13`, push, GitHub Actions builds portable zip, Release page must show only `auto-elearn-0.8.13-win-portable.zip` (project rule, see `release.yml`).
- `CLAUDE.md` updates:
  - Add new section under "Domain Knowledge — e等公務園 (elearn.hrd.gov.tw)" called "Web 題庫 prefetch (v0.8.13+)" describing the rodiyer.idv.tw integration, JSON-array answers schema, source priority table.
  - Add lesson learned: "多選題在 v0.8.13 之前完全沒處理 — solver 偵測 `isMultiple` 但 selectOption 只送一個選項，導致多選必錯。Web bank 上線同時修這個。"
  - Add `web-bank-index.json` to the persistence layout description in the same file.
- Memory updates (`memory/`):
  - New file `reference_web_bank_format.md` recording rodiyer.idv.tw URL pattern, RSS feed pagination, parse format. (Saves repeat re-discovery if the site changes.)
  - Update `reference_exam_threshold.md`: web-prefetch confidence rules; brute now demoted to last-resort.

## Open questions / explicit non-decisions

- **Bank availability**: rodiyer.idv.tw is a third-party Blogger site. If it goes offline, prefetch returns 0 hits; user falls back to current behavior. Out of scope to mirror or self-host.
- **Bank correctness**: spec assumes the site's `✓` markers are accurate. If a row is wrong, it propagates as `confidence=1.0` and a brute probe will not override it (priority gate). Mitigation deferred to "perfect-attempt rewriter": when a real exam scores 100, every pick gets saved as `perfect-attempt` (priority 7) — that path can't override web-prefetch but if web-prefetch is wrong the exam won't score 100 in the first place. Acceptable risk for v0.8.13.
- **Index refresh trigger**: only the 24h-since-mtime check. No "manual refresh" button in v0.8.13. If user wants a fresh index, delete the JSON file. Adding UI is a future enhancement.
