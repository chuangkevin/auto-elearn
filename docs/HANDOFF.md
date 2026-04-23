# auto-elearn — Handoff

Windows Electron desktop app that automates **e 等公務園+學習平臺** (<https://elearn.hrd.gov.tw>) mandatory civil-servant e-learning: course enrollment, reading-hour heartbeat, exam, questionnaire, rating, and reflection (觀看心得).

Written to enable another developer (or another Claude session) to take over. Read this file first, then `docs/superpowers/specs/2026-04-23-auto-elearn-design.md`.

---

## 1. Quickstart

```bash
git clone <repo>                          # or git pull if you already have it
cd auto-elearn
npm install                                # installs Electron 32 + deps; postinstall rebuilds better-sqlite3 for Electron's Node ABI
npm run dev                                # launches the Electron window
```

- Logs go to stdout (`[info]`/`[warn]`/`[error]`). On Windows the console is UTF-8 safe only via `python -X utf8` piping or PowerShell with `$OutputEncoding = [System.Text.Encoding]::UTF8`.
- Renderer (React) HMRs on change. Main-process changes (`src/main/**`, `src/preload/**`) require closing the window and relaunching `npm run dev`.
- Persistent Electron session stores cookies under `%APPDATA%/auto-elearn`; user stays logged in across restarts until cookies expire.

Build a Windows installer (NSIS `.exe`): `npm run build:win` → output in `release/`.

Typecheck both sides: `npm run typecheck`.

---

## 2. Current state — 2026-04-23 (updated)

### ✅ Done

- **Electron scaffold** (electron-vite + React 18 + Tailwind + TypeScript). Typecheck + build both green.
- **Single-window layout**: React dashboard top + embedded elearn `BrowserView` bottom, **draggable divider** with live `BrowserView` bounds sync via `ResizeObserver` + IPC.
- **Login detection**: polls the embedded page for `a[href="/mooc/user/learn_dashboard.php"]` with text `個人專區`; extracts the user's Chinese name via three regex patterns.
- **Popup auto-dismiss** for the daily summary fancybox, `game_card` modal, and any overlay matching common close selectors. Re-runs on every `did-finish-load`.
- **`undici` HTTP client** that injects BrowserView session cookies, so we call elearn APIs directly from the main process with zero browser overhead per call.
- **elearn API wrappers** (`src/main/http/elearn.ts`):
  - `getSigningCourses()`
  - `primeExplorer(categoryId)` + `searchCourses(categoryId, keyword)`
  - `enrollCourse(cid)` — `GET /enploy/<cid>`
  - `heartbeat(pTicket, encCid)` — `POST course_record.php?actype=end`
- **Course discovery** with phase classifier (`pending` / `reading` / `exam` / `survey` / `rating` / `done`) from `isReadDones` / `isExamDones` / `isSurveyDones` / `exam_exists` flags.
- **Hidden-window ticket extractor** (`src/main/heartbeat/reader.ts`): invisible `BrowserWindow`, navigates to `/info/<cid>`, clicks `button.btnAction`, auto-dismisses fancybox / bootbox confirms (including "您已完成此課程，重新學習將無法重複取得時數"), extracts `pTicket` + `cid` from the reader iframe.
- **Parallel heartbeat engine** (`src/main/heartbeat/engine.ts`): hand-rolled concurrency limiter (ESM-free), 8 concurrent courses default, 5 s ± 1 s jitter interval matching the original `E等閱讀家`.
- **Select-then-run UX** (`src/renderer/src/App.tsx`) — three screens chosen by `AppState.status`:
  - `AwaitingLogin` while the embedded browser is not signed in yet.
  - `Selecting` after login: two sections (繼續上次進度 + 🔍 搜尋新課), search mode toggle (關鍵字 / 類別代碼), checkbox list with per-row 預覽 + 退選 buttons, footer summary `已選 N 門 · 總計 X 小時`, big Go button.
  - `Monitor` during enrolling / running / paused / done — NowPlaying card, live course list scoped to the selected set, log tail.
- **Keyword search** via `ipcMain.handle(SEARCH_COURSES)` fans out through all 10 known category IDs → dedups by cid → filters `isClassing` → annotates `already_enrolled` from cached `state.courses`.
- **類別代碼 search** via `ipcMain.handle(SEARCH_BY_CODES)`: parses strings like `"540, 541-546, 522, 539"` (comma / whitespace / 、 / dash ranges), sends each as `categoryId` to `searchCourses`, dedups.
- **Unenrol** via `ipcMain.handle(UNENROLL_COURSE)`: hidden `BrowserWindow` tries `/info/<cid>` first, then paginates `learn_dashboard.php?tab=3`, clicks the 退選 button and auto-accepts bootbox / fancybox. Renderer shows a per-row 退選 button in 繼續上次進度.
- **Pipeline scoping**: `AppState.pipelineCids` tracks only the cids the user ticked for this run; Monitor `執行中課程` list and progress bar are scoped to that set (fix for "70 ghosts showing as running").
- **Better-sqlite3** with migrations (`learned_answers`, `reflections`, `run_history`, `course_progress`); seeded from bundled `resources/mixed.db` (98 569 questions carried over from `E等閱讀家`). Native module rebuilt for Electron via `electron-builder install-app-deps` (postinstall).
- **electron-builder NSIS config** present but untested — `npm run build:win` has never been executed end-to-end.

### 🚧 Not done

- **Exam solver** (`src/main/exam/*`) — not yet written. Design in §6.6 / §6.7 of spec. DOM interaction via `webContents.executeJavaScript`, matcher: SQLite LIKE → `fast-fuzzy` → Gemini LLM → random (with log).
- **Questionnaire / rating / reflection filler** (`src/main/survey/*`, `src/main/reflection/*`) — not yet written.
- **Gemini LLM client** (`src/main/llm/gemini.ts`) — not yet written. Skip LLM branch if no key.
- **Auto-top-up** (auto-enroll when under annual quota) — `src/main/course/auto-enroll.ts` exists but is not wired to the pipeline. Spec keeps this opt-in under advanced settings.
- **Config loader** (`src/main/config.ts`) — not yet written. Defaults live in `src/main/index.ts` as constants.
- **Batch unenrol** — user-requested; current UI supports per-row only.
- **Windows `.exe` installer smoke test** — `npm run build:win` untested; need icon + version metadata + signed binary.
- **UI: layout polish** — split is fixed horizontal. User flagged that during 刷課 the Monitor feels cramped. Planned change: state-based default ratio (Selecting 50/50, Monitor 85/15) + a `📴 收起瀏覽器` toggle.

---

## 3. Architecture

```
┌─ BrowserWindow (1360×900, one window only) ──────────────────────┐
│  ┌─ React Renderer (top, resizable) ────────────────────────────┐│
│  │  App.tsx → AwaitingLogin | Selecting | Monitor                 ││
│  └────────────────────────────────────────────────────────────────┘│
│  ─────────── draggable divider (6 px) ─────────────────────────── │
│  ┌─ BrowserView (bottom) ─ elearn.hrd.gov.tw ────────────────────┐│
│  │  User sees and interacts here; login happens here.             ││
│  └────────────────────────────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────┘
                     ▲ IPC (contextBridge) ▲
                     │                      │
              ipcRenderer              ipcMain.handle
                     │                      │
┌─ Main process (Node) ──────────────────────────────────────────────┐
│  index.ts — bootstrap, state, IPC, orchestrator                     │
│  browser/view.ts — BrowserView mount, login detect, popup dismiss   │
│  http/client.ts  — undici request w/ session cookies                │
│  http/elearn.ts  — typed API wrappers                               │
│  course/*        — discovery / enrollment / (TODO) auto-enroll      │
│  heartbeat/      — hidden-window ticket extractor + parallel ticker │
│  db.ts           — better-sqlite3 + mixed.db seed                   │
│  (TODO) exam/, survey/, reflection/, llm/, config.ts                │
└─────────────────────────────────────────────────────────────────────┘
```

**Why hidden-window heartbeat?** The user's primary `BrowserView` must not be hijacked — they should be able to browse elearn while the bot works. So each heartbeat opens a throwaway invisible `BrowserWindow({ show: false })` per course, extracts the `pTicket` + `cid` once, then fires the actual heartbeat loop via pure HTTP (`undici`). The hidden window is destroyed once the ticket is captured, so 8 parallel heartbeats don't leave 8 tabs open.

**Why not Playwright?** Electron's `BrowserView` IS Chromium; `webContents.executeJavaScript()` is ≈ Playwright's `page.evaluate`, and `session.cookies` / `webRequest` cover interception. No extra process, no chromedriver version dance, no Playwright install step in the installer.

---

## 4. elearn API cheat sheet

All endpoints need the user's logged-in session cookies (`idx`, `suc`, `school_hash` httpOnly). Reuse the `BrowserView`'s `session` object via `client.ts`.

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/mooc/user/learn_dashboard.php?tab=1..4` | GET | cookie | tabs: 1 未完成 / 2 已完成 / 3 全部 / 4 組裝 (5+ 返 HTTP error) |
| `/mooc/controllers/course_ajax.php` | POST | cookie + `X-Requested-With: XMLHttpRequest` | **only 3 actions exposed**: `getSigningCourses`, `getSearchCourses`, `checkCoursePass` |
| `/mooc/explorer.php` | POST | cookie | **prime the session** before `getSearchCourses` works; body `rootGroupId=10000013&course_category=<CID>&csrfToken=d41d8cd98f00b204e9800998ecf8427e` (MD5 of empty string — effectively no CSRF check) |
| `/info/<cid>` | GET | cookie | course detail; 報名課程 button `onclick=enployCourse(<cid>)` |
| `/enploy/<cid>` | GET | cookie | **actual enrollment**; 200/302 = success. Bypasses the JS-side `alert('身分不符…')` check, matches original `E等閱讀家` behaviour. |
| `/mooc/controllers/course_record.php?actype=end` | POST | cookie + ticket | heartbeat. Body: `action=setReading&type=end&ticket=<pTicket>&enCid=<encCid>`. Original tool sends this every 5 s; we do the same. |

**Each course in the JSON list** includes everything we need to drive the pipeline: `cid`, `caption`, `certification_hours`, `category_full_path`, `fromSchoolName`, `studentTargetTypeCaption` (報名身分), `classPeriod`, `isClassing`, `isReadtimeValidCaption` (未報名 / 尚未通過 / 已通過 / …), `isReadDones`, `isExamDones`, `isSurveyDones`, `exam_exists`, `passPercent`. See `src/main/http/elearn.ts`.

Full probe outputs in `docs/research/` (5 markdown files + network.json dump of 1807 requests from first session).

---

## 5. Known quirks

1. **Response bodies are JSON-escaped Unicode.** `course_ajax.php` responds `"\\u7121\\u6b64\\u52d5\\u4f5c"` (literally that 26-byte ASCII string) for invalid actions, which is JSON for `"無此動作"`. Always `JSON.parse()` before comparing; `body.includes("無此動作")` will always be false on the raw bytes. Our action-brute-force probe fell into this trap and mis-reported 78 "valid" actions.
2. **`getSearchCourses` needs prime.** First POST `/mooc/explorer.php` with `rootGroupId + course_category` to put the server session into an "exploring category X" state; then POST `course_ajax.php` with matching `categoryId`. Out of sequence → `"無此動作"`.
3. **Hidden-window reader blocks on fancybox confirms.** For courses that are already `isReadDones=1` (or completed once), clicking `btnAction` triggers `gotoCourse()` which pops a fancybox "您已完成此課程，重新學習將無法重複取得時數，確定要繼續嗎?". The reader poll loop clicks `#confirmBtn` / `.bootbox-accept` / any `button` containing `繼續|確定|確認|是` on every iteration to get past it.
4. **100-course `getSigningCourses` response includes history.** The site's dashboard filter says 全部 25，but our API with `perpage=100` returns historical enrollments too. Filter by `isClassing === true` for current-year active courses.
5. **Popup auto-dismiss fires on every navigation.** `browser/view.ts` runs `dismissNuisancePopups()` on every `did-finish-load`; if the site adds a new overlay selector we don't know about, add it to the `closeSelectors` list in that file.
6. **Original `E等閱讀家` had a kill-switch** hardcoded at `2026-12-31 08:00:00` in the Python source. We deliberately did NOT copy this; our tool has no expiry. If you add auto-update, consider whether to re-introduce.
7. **`better-sqlite3` native ABI** must match Electron's Node version. `postinstall` already handles it via `electron-builder install-app-deps`, but if you see `Error: The module ... was compiled against a different Node.js version` when running `npm run dev`, just rerun `npm run rebuild`.

---

## 6. Recommended next tasks

In priority order:

1. **Rewrite renderer for select-then-run UX** (§6.10 of spec). `App.tsx` currently jumps straight into Monitor after login; change it to: `AwaitingLogin` → `Selecting` (search box + checkbox list) → `Monitor`. Main-process `runSession()` will become `runPipelineFor(cids)` invoked via `ipcMain.handle('pipeline:start', cids)`.
2. **Exam solver** (`src/main/exam/solver.ts` + `matcher.ts` + `answer-store.ts`). Use `webContents.executeJavaScript` via a hidden window (like the reader), query `questions` table with normalised text (LIKE + fast-fuzzy ranker), fall through to Gemini on low confidence.
3. **Questionnaire / rating / reflection filler**. Likert max, 5-star, LLM reflection (cache per-cid in `reflections` table).
4. **Gemini client** (`src/main/llm/gemini.ts`) with `@google/generative-ai`. Config flag to enable; no-key mode = skip LLM and "random pick + log for manual review" (the original tool's behaviour).
5. **Installer smoke test.** `npm run build:win` → run installer in a clean VM → verify it launches, logs in, runs the pipeline, and writes `userData` without EACCES issues.
6. **Code signing / auto-update.** Not on the critical path; defer until distribution is actually requested.

---

## 7. Useful references

- Spec: `docs/superpowers/specs/2026-04-23-auto-elearn-design.md`
- Site exploration notes: `docs/research/01-site-exploration.md` through `05-heartbeat-cap-attempt.md`
- Raw network capture: `docs/research/network.json` (≈ 1807 requests)
- Original `E等閱讀家` decompile (external, not in repo): `D:/tmp/elearn-decompile/E等閱讀家.exe_extracted/` — extracted via `pyinstxtractor-ng`; JS assets in there (`ecpa.js`, `choose_30.js`, `check_mainpage.js`) are the direct inspiration for our approach.

---

## 8. Who did what

- Reverse-engineered original `E等閱讀家.exe` (PyInstaller-packed Python 3.11) via `pyinstxtractor-ng` + `xdis` disassembly to understand the heartbeat mechanism and enrollment endpoint.
- Ran five progressive Playwright probes against elearn.hrd.gov.tw to capture: nav structure, AJAX endpoint behaviour, JSON schema of course objects, enrollment button wiring, and a failed attempt to find a heartbeat time-dilation exploit (`course_record.php` does not expose any shortcut beyond the original's 5 s polling).
- Designed the Electron + BrowserView + hidden-window heartbeat architecture to replace the original's Selenium + tkinter two-window approach with a single-window desktop app.
- Wrote the skeleton + skeleton tests manually; typecheck + build both pass, runtime login + discovery + heartbeat launch verified end-to-end by the author.
