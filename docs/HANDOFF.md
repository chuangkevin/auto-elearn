# auto-elearn — Handoff

Windows Electron desktop app that automates **e 等公務園+學習平臺** (<https://elearn.hrd.gov.tw>) mandatory civil-servant e-learning: enrolment, reading-hour heartbeat, exam, questionnaire, rating, 觀看心得, plus eCPA silent auto-login and a Notepad-disguise stealth mode.

Read this first, then `docs/superpowers/specs/2026-04-23-auto-elearn-design.md` for design rationale.

---

## 1. Quickstart

```bash
npm install          # installs Electron 32 + deps; postinstall rebuilds better-sqlite3 for Electron's Node ABI
npm run dev          # launches the Electron window in dev mode
npm run typecheck    # both tsc configs must exit 0 before commit
```

Production build (portable folder; skips the broken NSIS step):

```bash
npm run build
npx electron-builder --win --dir
# → release/win-unpacked/Noteqad.exe (direct-runnable, ~290 MB)
```

NSIS installer: `npm run build:win` — **blocked on Windows by winCodeSign symlink-privilege**; see `docs/BUILD.md` for the three workarounds (enable Windows Developer Mode, run as admin, or just ship the unpacked folder zipped).

- Renderer (React) HMRs on change; main-process changes require a restart.
- User session / creds / config / run-state all live in `%APPDATA%/auto-elearn/` (package.json `name` wins over electron-builder `productName` for this path).

---

## 2. Current state — 2026-04-24 17:00

### ✅ Shipped

**Core pipeline**
- Electron 32 + TypeScript + React 18 + Tailwind scaffold; both tsc configs green; single-instance lock via `app.requestSingleInstanceLock`.
- Login detect + popup auto-dismiss (`src/main/browser/view.ts`).
- `undici` HTTP client reusing BrowserView session cookies (`src/main/http/client.ts`).
- Course discovery + phase classifier (`src/main/course/*`).
- Parallel heartbeat engine (8 concurrent, 5 s ± 1 s jitter) with a hidden-window ticket extractor (`src/main/heartbeat/*`).
- Enrolment via `GET /enploy/<cid>`; batch enrol + unenrol with a staged-confirm dialog in the renderer.
- Keyword search + agency-code search (`src/main/course/agency-code-map.ts` translates 540/522/539/... to real 8-digit categoryIds, since raw pass-through hits a server fallback that returns "latest courses" for every code).

**Exam / survey / reflection**
- Exam solver (`src/main/exam/*`): `resources/mixed.db` (98 569 rows) with SQLite LIKE + Dice-bigram fuzzy matcher → random fallback. Hidden window drives `tr.bg03/bg04` rows, handles 送出答案, parses pass/fail.
- Survey / rating filler (`src/main/survey/filler.ts`): picks `value=1` on Likert, `value=5` on star ratings, 確定繳交.
- Reflection writer (`src/main/reflection/writer.ts`): Gemini-generated 120-180 字 心得 via `src/main/llm/gemini.ts`; falls back to one of 3 template drafts when no `geminiApiKey` in `userData/config.json`.

**Auth (silent-first with two fallbacks)**
- **Primary: POST replay** (`src/main/auth/ecpa-login.ts`) via Electron `net.request` with `useSessionCookies: true`. Replays the exact captured chain — GetUID (plain-text response containing the full ID) → GetApTicketV2 (response body IS the APReqEncodedData hex) → EnterTwoWayLog → EnterApplicationTwoWay → sso_verify.php (302 sso_home → /mooc/index.php). Verifies by checking `idx` + `suc` cookies landed on elearn.hrd.gov.tw. **1–3 seconds, no browser.**
- Fallback 1: hidden-window form drive. Kept for edge cases (aspnet isTrusted blocks the synthesized click in most current eCPA builds, but some sub-agencies may differ).
- Fallback 2: visible pre-fill — navigate the main BrowserView to eCPA clogin with fields filled and the 登入 button highlighted; user clicks once with a real trusted mouse event.
- Credentials sniffer attaches to `session.webRequest` for `ecpa.dgpa.gov.tw/Home/*` to auto-capture account + password on first real login, then prompt the user to save (DPAPI-encrypted in `userData/credentials.bin`).
- Manual 🔑 management modal in the renderer lets the user set / overwrite / clear without going through eCPA once.

**UX / reliability**
- Left/right split with draggable divider; state-aware ratio default (0.6 browser both modes per user request); `📴 收起瀏覽器` toggle docked to the divider edge; `🫥 隱藏` / `🫥 啟用偽裝` chip in bottom-left.
- Monitor's 執行中課程 list now shows per-course `readSec / requiredSec` + progress bar so the user can cross-check with elearn's 我的課程狀態 → 閱讀時數.
- While heartbeating, the BrowserView loads `/info/<currently-ticking cid>` so the user sees activity; follows the first still-running course and switches when it finishes.
- Session watchdog polls `/mooc/user/learn_dashboard.php?tab=1` every 90 s during running; 2 consecutive dead checks → pause → silent re-login → resume.
- Run-state persistence: `userData/run-state.json` snapshots `pipelineCids` + status; on next launch a Resume modal offers to continue.

**Stealth disguise (S task)**
- Shell renders `Noteqad` (fake Windows Notepad: menu bar + status bar + textarea) when `config.json` has `stealthSecret` and the session isn't unlocked.
- Unlock: type secret on textarea's last line + Enter. Wrong flash → `密碼錯誤` in the status bar; after 3 fails it reveals the recovery hint (檔案 > 結束 ×5 to overwrite). IME-aware (isComposing check) so Chinese input method Enter doesn't eat the unlock.
- Re-lock: `Ctrl+Alt+H` or the 🫥 隱藏 chip. Pipeline keeps running underneath — stealth only flips the renderer root.
- OS title bar pinned to `未命名 - 記事本`; `page-title-updated` events suppressed; executable is named `Noteqad.exe`.
- One title bar (fake one removed) — stacking the OS's own was the first visual tell.

**Heartbeat — subdomain fix**
- Many courses are SPOCs hosted on dedicated subdomains (e.g. `mohw.elearn.hrd.gov.tw` for 衛福部). The original ecpa.js got away with a relative fetch; our undici code was hardcoded to the main portal, so server returned 200 but credited 0 time. Extractor now reads `frame.location.href`, returns `origin`, and `heartbeat()` / `enterReadingSession()` target that origin. Confirmed by the server response flipping from silent `code=0` to `{"code":1,"msg":"success","timediff":"..."}` after the fix.

### 🚧 Backlog

- **Pause / 回選課 / 中止 semantic cleanup** (task #24 in_progress) — currently 回選課 aborts the pipeline; user wants it to be a pure UI switch with the run continuing in the background, and 暫停 to actually halt heartbeat not just flip the label.
- **Auto-top-up** — `src/main/course/auto-enroll.ts` exists but isn't wired to the UI.
- **Gemini API-key UI** — no entry form yet; user has to hand-edit `config.json`. Low priority.
- **NSIS installer smoke-test** — portable folder works; installer step fails on winCodeSign unpack without Developer Mode.

---

## 3. Architecture

```
┌─ BrowserWindow (1360×900, single-instance) ────────────────────────┐
│  Shell component — stealth gate                                     │
│    locked   → <Noteqad>                                             │
│    unlocked → <App>                                                 │
│      ┌─ Left: dashboard (React, 40%) ─── Right: BrowserView (60%) ┐ │
│      │  AwaitingLogin | Selecting | Monitor                       │ │
│      └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                     ▲ IPC (contextBridge) ▲
                     │                      │
┌─ Main process (Node / Electron main) ────────────────────────────────┐
│  index.ts         — bootstrap, AppState, IPC, pipeline orchestrator  │
│  browser/view.ts  — BrowserView mount, login detect, popup dismiss   │
│  http/client.ts   — undici w/ session cookies                        │
│  http/elearn.ts   — typed wrappers + heartbeat + enterReadingSession │
│  course/*         — discovery, enrol/unenrol, agency-code-map        │
│  heartbeat/       — hidden-window reader + parallel ticker           │
│  exam/            — answer-store (mixed.db) + matcher + solver       │
│  survey/          — questionnaire filler                             │
│  reflection/      — Gemini-drafted 心得 writer                       │
│  llm/gemini.ts    — v1beta generateText client                       │
│  auth/            — credentials, sniffer, ecpa-login (POST replay),  │
│                     auto-login (hidden window fallback),             │
│                     session-watchdog                                 │
│  stealth/         — Noteqad lock state                               │
│  persist/         — run-state.json for resume                        │
└──────────────────────────────────────────────────────────────────────┘
```

**Why hidden-window heartbeat?** The main BrowserView must stay usable for the user; each heartbeat opens a throwaway invisible `BrowserWindow` per course, extracts pTicket + cid + the iframe's origin (subdomain varies per SPOC), then destroys the window. Subsequent ticks are pure HTTP with the captured info, so 8 parallel heartbeats don't leave 8 tabs open.

**Why not Playwright?** Electron's BrowserView IS Chromium; `executeJavaScript()` ≈ Playwright's `page.evaluate`, and `session.cookies` / `webRequest` cover interception. Bundled Playwright would bloat the installer and add a chromedriver dance.

**Why net.request for auto-login?** Electron's `net.request` with `useSessionCookies: true` writes Set-Cookie responses back into the shared session jar automatically, across all three hosts (elearn + ecpa + sub-agency subdomains). `undici` reads cookies but doesn't write, so a 5-hop eCPA chain would drop session state halfway.

---

## 4. elearn API cheat sheet

All endpoints need the user's logged-in session cookies (`idx`, `suc`, `school_hash` httpOnly, plus `PHPSESSID`). Reuse the BrowserView's `session` object via `client.ts`.

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/mooc/user/learn_dashboard.php?tab=1..4` | GET | cookie | tabs: 1 未完成 / 2 已完成 / 3 全部 / 4 組裝 |
| `/mooc/controllers/course_ajax.php` | POST | cookie + `X-Requested-With: XMLHttpRequest` | `getSigningCourses` / `getSearchCourses` / `checkCoursePass` |
| `/mooc/explorer.php` | POST | cookie | **prime the session** before `getSearchCourses`; body includes `rootGroupId=10000013&course_category=<CID>&csrfToken=d41d8cd98f00b204e9800998ecf8427e` (MD5 of empty string) |
| `/info/<cid>` | GET | cookie | course detail; 報名課程 button `onclick=enployCourse(<cid>)` |
| `/enploy/<cid>` | GET | cookie | **actual enrolment**; 200/302 = success. Bypasses the JS alert('身分不符…') |
| `<iframe-origin>/mooc/index.php?ticket=...&cid=...` | GET | cookie | **announce reading session** before the 5 s heartbeat loop, otherwise server credits zero time. Iframe origin may be `elearn.hrd.gov.tw` OR a sub-agency (e.g. `mohw.elearn.hrd.gov.tw`) |
| `<iframe-origin>/mooc/controllers/course_record.php?actype=end` | POST | cookie | heartbeat. Body: `action=setReading&type=end&ticket=<pTicket>&enCid=<encCid>`. Referer must be the reading page URL. Server response on success: `{"code":1,"msg":"success","timediff":"...","data":"..."}` |

**eCPA auto-login chain** (see `docs/research/ecpa_full.md` for full response bodies):

| Endpoint | Body | Response |
|---|---|---|
| `GET https://elearn.hrd.gov.tw/mooc/index.php` | — | seeds PHPSESSID |
| `GET https://ecpa.dgpa.gov.tw/uIAM/clogin.asp?destid=CrossHRD` | — | 302 → clogin.aspx (seeds ASP.NET_SessionId) |
| `POST https://ecpa.dgpa.gov.tw/Home/GetUID` | `account=<alias>` | plain text body = full ID, e.g. `F130918271` |
| `POST https://ecpa.dgpa.gov.tw/Home/GetApTicketV2` | `account=<full-id>&password=<pwd>&ApID=CrossHRD` | **response body IS the APReqEncodedData hex string** (≥100 chars); `0` / empty = 帳號密碼錯誤 |
| `POST https://ecpa.dgpa.gov.tw/Home/EnterTwoWayLog` | `account=<full-id>&loginType=0&sn=&ticket=&appId=CrossHRD` | `0` = OK |
| `POST https://ecpa.dgpa.gov.tw/Home/EnterApplicationTwoWay` | `appId=CrossHRD` | `0` = OK |
| `POST https://elearn.hrd.gov.tw/sso_verify.php` | `loginType=0&APReqEncodedData=<hex>` | 302 → sso_home.php?ssoid=X → /mooc/index.php, sets `idx` + `suc` |

Verify by presence of `idx` + `suc` cookies on elearn.hrd.gov.tw after the chain — more reliable than grepping the rendered dashboard body.

---

## 5. Known quirks

1. **SPOC subdomains.** The iframe that hosts the reader can live on `mohw.elearn.hrd.gov.tw`, `*.elearn.hrd.gov.tw`, etc. Heartbeats MUST target the iframe's own origin; we capture it in `TicketInfo.origin` via the reader's hidden window. Until 2026-04-24 we hardcoded `elearn.hrd.gov.tw` and wondered why 閱讀時數 refused to move.
2. **`userData` path**: `app.getPath('userData')` uses package.json `name` (`auto-elearn`), NOT the electron-builder `productName` (`Noteqad`). Files live at `%APPDATA%/auto-elearn/`, not `%APPDATA%/Noteqad/`.
3. **JSON-escaped Unicode responses.** `course_ajax.php` responds `"\\u7121\\u6b64\\u52d5\\u4f5c"` literally for invalid actions; JSON-parse before comparing — `body.includes("無此動作")` always returns false on the raw bytes.
4. **`getSearchCourses` needs prime.** POST `/mooc/explorer.php` first or the next call returns `"無此動作"`.
5. **Agency 3-digit codes aren't categoryIds.** 522 ≠ `10027390`; they're a separate 人事行政總處 taxonomy. We ship a translation table in `src/main/course/agency-code-map.ts`.
6. **`getSigningCourses` with `perpage=100` includes history.** Filter by `isClassing === true`.
7. **Hidden-window reader blocks on fancybox confirms** for already-completed courses. We click `#confirmBtn` / `.bootbox-accept` / any `button` containing `繼續|確定|確認|是` on every poll iteration.
8. **aspnet isTrusted** — eCPA's 登入 button ignores `element.click()` synthesized events. That's why the hidden-window auto-login only works sometimes and we default to POST replay now.
9. **better-sqlite3 native ABI** must match Electron's Node version. `postinstall` handles it via `electron-builder install-app-deps`; if you see `Error: ... was compiled against a different Node.js version`, re-run `npm run rebuild`.
10. **Single-instance lock** is necessary: without it every relaunch during testing stacked a new process on top of the old, which looked like "two title bars" and let stale builds handle IPC first.

---

## 6. Recommended next tasks

1. **Task #24 pause/回選課/中止 semantics.** Current 回選課 aborts; should just switch UI. Add `state.returnedToSelect` or similar; keep pipeline alive; make 暫停 actually stop heartbeat (add `pausedSignal` to engine's driveCourse loop).
2. **Full run verification.** Pick a course in 閱讀 phase, run heartbeat for ~15 min, refresh elearn and confirm `閱讀時數` moved the expected amount.
3. **Exam flow end-to-end.** We have the matcher + DOM driver but no live test yet. Once a course has `isExamDones=0 && exam_exists=1`, run the pipeline and see whether 通過 lands.
4. **Gemini key UI.** Add a simple settings modal alongside the 🔑 credentials one so users don't need to hand-edit `config.json`.
5. **NSIS installer unblock.** Either enable Windows Developer Mode on the build box or switch to a different signing tool that doesn't ship macOS dylibs in the cache.

---

## 7. Useful references

- Spec: `docs/superpowers/specs/2026-04-23-auto-elearn-design.md`
- Build notes: `docs/BUILD.md`
- Site exploration notes: `docs/research/01-site-exploration.md` .. `06-category-tree-probe.md`
- Category-tree snapshot: `docs/research/category-tree-snapshot.json`
- Raw network capture: `docs/research/network.json` (~1807 requests)
- eCPA login chain with response bodies: `D:/tmp/elearn-explore/ecpa_full.md` (local, user-machine-only — redacted of credentials)
- Original `E等閱讀家` decompile (external): `D:/tmp/elearn-decompile/E等閱讀家.exe_extracted/`
