# Exam Answer Recovery

## Purpose

Recover the correct-answer key for an elearn (`elearn.hrd.gov.tw`) course exam **without consuming any new exam attempts**, then auto-pass the course on the next pipeline run.

This capability exists because:

- elearn's bundled `mixed.db` (98,569 rows scraped from 原 E等閱讀家) has stale or wrong answers for many courses — submitting a quiz with those answers caps the score at 60 forever.
- elearn's exam result page (`/learn/exam/view_result.php?{eid}`) does NOT display the correct answer; it shows the user's submitted answer + the score. The "公布答案" button reveals truth but **permanently locks retests**, so it is never clicked programmatically.
- elearn's `viewResult` JS function only navigates a viewer (no server side-effect), so unlimited reads of past attempts are safe.

## Non-Goals

- This capability does **not** read from the "公布答案" page and never touches `set_see_question_result.php`.
- It does **not** scrape "正解" text off the result page (every prior attempt produced false positives — see "Decision: removed result-page parser").

## Pipeline

### 1. `solveExamFromHistory(session, cid)` — runs at chain startup, before the first new exam attempt

1. Open hidden `BrowserWindow` and call `enterLC(cid)` so server-side LC session cookies are set for this course.
2. Navigate the LC's `s_main` frame to `/learn/exam/exam_list.php`. Read the `viewResult('{eid}')` onclick attribute on the 查看結果 div-button to obtain the latest attempt eid.
3. Use `frame.fetch('/learn/exam/view_result.php?{eid}')` (same-origin, same cookies as the LC) to fetch the current attempt page.
4. Parse the HTML with cheerio:
   - `<select><option value="..." title="N">N</option></select>` → list of all past attempt eids.
   - `<tr class="bg03|bg04">` rows → per-question text + 4 options + the user's `checked` radio.
   - Inline `<script>` `var correct_score = '60';` → that attempt's score.
   - Inline `<script>` `var threshold_score = 75;` and `var examTimes = N;` for context.
   - Stable per-question id parsed from `name="ans[WM_ITEM1_..._..._..._{QID}][ANS01]"` for cross-attempt correlation.
5. Iterate every dropdown eid (200ms gentle delay), accumulate `(qid → option-idx, score)` tuples for each attempt.
6. Brute-force solve: enumerate `4^Q` answer-key combinations (≈1M for a 10-Q exam, sub-second). For each combination, predict each attempt's score (`Σ 10 · [user pick == key[q]]`) and compare to observed. Collect all combinations that match every observed score exactly ("perfect-match keys").
7. Per-question consensus: a question is **locked** iff every perfect-match key agrees on that option. Ambiguous questions are left out (they go to brute-force-probe at attempt time).
8. `clearAllLearnedForCourse(cid)` to wipe earlier polluted entries (especially from the now-removed result-page parser); then `saveLearnedAnswer({question, answer, source: "history-solve", confidence: 1.0, courseId})` for each locked question.

### 2. `findBestAnswer(qText, options)` — at exam answering time

Source priority for `learned_answers` lookup (`ORDER BY` source CASE):

```
history-solve  (Layer 0, mathematically derived from N≥1 attempts)
brute          (Layer 1, single score-delta probe)
llm            (Layer 2, Gemini)
result-page    (Layer 3, legacy — not written anymore but old rows may exist)
```

Then `captured_at DESC, confidence DESC`.

Question key normalization (`normalizeQuestion`) MUST strip:

- whitespace, `?`, `？`, `，`, `　`
- exam-page chrome: `^[單複多選]{0,4}配分[:：]?\[\d+(?:\.\d+)?\]` (the qualifier "**單選**" is critical — view_result.php drops it but exam_start.php includes it; mismatch means LIKE never hits)
- leading numbering: `^[第Q]?\d{1,3}[.、題)]?`

After normalize, SQL search uses `WHERE NORM_EXPR(question) LIKE '%{normalizedLookup}%'` so any saved row whose question CONTAINS the lookup text matches.

If `learned_answers` misses, fall through to `mixed.db` (Layer 4, dice similarity ≥ 0.6) → Gemini LLM (Layer 5, optional API key).

### 3. Brute-force probe — runs inside `runExamLoop` for ambiguous questions

Per-attempt state: `bfStates[qid] = { bestOption, tested: Set<optionIdx>, options[] }`. Single-Q score-delta search:

- Each retry, pick one Q with untested options. Build `forcedAnswers` map: every Q at its current `bestOption`, plus the probed Q at the next untested option.
- After submission, compare new score to `runExamLoop.best`:
  - `score > best`: flipped option is correct → `bestOption = probedOption`, `saveLearnedAnswer(source: "brute")`, advance queue.
  - `score < best`: original was correct → keep, advance queue.
  - `score == best`: both options wrong (single-answer MC: at most one is right) → keep current, try next option for SAME Q.
- Terminate when `bfQueueIdx >= bfQueue.length` regardless of `tested.size` — the ↓ branch advances without exhausting all options, so a "totalUntested == 0" guard would never fire (v0.4.14 bug).

`MAX_EXAM_ATTEMPTS = 30`. Worst case for 10-Q exam: 10 Qs × ~3 alt probes = 30 attempts.

## Critical Invariants

- `ELEARN_WINDOW_CONCURRENCY = 1`. Two parallel `BrowserWindow` extractions on the same SPOC subdomain cause the second nav to overwrite server-side LC session state before the first window's SCORM iframe finishes loading; both windows then scrape the same actid. Sequential extraction guarantees correct per-cid actid.
- `clearAllLearnedForCourse(cid)` MUST run inside `solveExamFromHistory` **before** the new saves. history-solve is the most authoritative source we have, so leftover entries from earlier buggy parser versions get blown away rather than competing under same-confidence ORDER BY.
- Never call the result-page text parser to write `learned_answers`. It cannot reliably distinguish "您的答案" UI text from a true correct-answer string. Keep only the one-shot HTML dump to `temp/auto-elearn-result-{cid}.html` for forensic inspection.
- Never click the "公布答案" button. The endpoint `/learn/exam/set_see_question_result.php?{eid}` sets `isReadAnswer=1` per (course, user) and **permanently locks future retests** for that course on that account.

## Diagnostics on Disk

- `app.getPath("temp") + "/auto-elearn-actid-{cid}.json"` — every `extractTicket` dump: chosen actid, full SCORM tree candidate list (text + actid per `a[onclick]`), enCid, href.
- `app.getPath("temp") + "/auto-elearn-result-{cid}.html"` — first result page per process (one-shot).
- `app.getPath("temp") + "/auto-elearn-diag.txt"` — `refreshCourses` per-course server flag + detail snapshot dump (full list, including 已通過 courses that the UI log filters out).

## Versions

| Version | Headline change |
|---------|-----------------|
| v0.4.13 | history-solver introduced — 4^Q brute-force from view_result.php |
| v0.4.14 | normalizeQuestion strips "配分:[N]" + numbering; brute-force terminates on queue end |
| v0.4.15 | lookup ORDER BY source rank; clearAllLearnedForCourse wipes pollution |
| v0.4.16 | normalizeQuestion strips "**單選**配分" qualifier — exam page vs view_result page key alignment |
| v0.4.17 | history-solver auto-triggers in chain; result-page saveLearnedAnswer removed |
| v0.4.18 | ELEARN_WINDOW_CONCURRENCY 2→1; actid candidate dump always-on |
| v0.4.19 | pickBestActid substring-containment boost; UI log shows actid + enCid per heartbeat start |
