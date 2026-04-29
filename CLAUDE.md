# Project Rules

This repository is a GitHub template. When a new project is generated from it, these rules activate immediately so any AI coding assistant follows the same workflow conventions from the first commit.

Edit this file freely to add stack-, domain-, or team-specific rules for your project. Keep the Skill Activation section so the bundled `skills/` and `.github/skills/` stay wired in.

## Global Working Rules

- Read the current code, files, and runtime context before deciding on a change.
- Prefer the smallest correct fix over broad refactors.
- Fix root causes, not only visible symptoms or display-layer effects.
- When the best next step is already clear, execute it instead of asking redundant confirmation.
- Do not send the user through intermediate debugging steps you can perform directly.
- Do not use regex to parse structured formats when explicit parsing or a proper parser is more reliable.
- For new projects, major features, rewrites, or redesigns with unresolved decisions, present a reviewable plan before writing product code.
- Parallelize independent work when it meaningfully reduces turnaround; keep the main thread focused on coordination and synthesis.
- Frame each task clearly with the actual problem, constraints, and expected end state.
- Do not replace user intent with hardcoded fallback values after a failure.
- Retry transient external or AI failures with backoff; when retries are exhausted, surface the real failure.
- Add per-item timeouts to batched external calls so one slow request does not block the whole batch.
- Keep user keywords and search intent unchanged unless the user explicitly asked for transformation.
- Verify behavior in a real runnable environment whenever feasible.
- Do not claim CI, CD, deployment, or runtime success from guesswork; use trustworthy evidence.
- When a code change is complete, treat follow-through as part of the work, not an optional extra.
- Every code change must update memory, update spec, commit, and push unless the user explicitly says not to.
- Prefer commit-first, push-later batching for larger work groups when repeated pushes would only retrigger CI/CD without adding review value.
- If a requirement should govern future implementation, write it into the formal rule sources instead of leaving it only in chat context.
- Avoid magic numbers in implementation; prefer existing enums, or introduce named constants when no enum exists.
- Before commit, confirm AI-generated methods, classes, and files are actually used; remove unused junk instead of committing it.
- Build checks before commit must use the repo's concrete command(s), not vague "validation" language.
- For any non-trivial feature request or requirement, first confirm requirements with the user and define OpenSpec before implementation.
- For major changes, use a brainstorming step before proposal or implementation.

## Skill Activation Rules

Treat the following skill files as active workflow rules for this workspace, even if the host AI environment does not expose them through a built-in skill registry. Apply them automatically by task type:

- Treat `skills/execution-style/SKILL.md` as the default execution behavior for normal implementation work
- Treat `skills/plan-before-build/SKILL.md` as mandatory for new projects, major features, and large redesigns before implementation begins
- Treat `skills/project-stack-standard/SKILL.md` as mandatory when choosing or reviewing app/service stack, backend setup, database choice, or monorepo structure
- Treat `skills/root-cause-debugging/SKILL.md` as mandatory for bug investigation and regressions
- Treat `skills/integration-robustness/SKILL.md` as mandatory for AI calls, external APIs, retries, and batched integrations
- Treat `skills/verification-and-evidence/SKILL.md` as mandatory when reporting runtime, CI, CD, or deployment status
- Treat `skills/agent-design/SKILL.md` as mandatory for multi-agent or tool-enabled agent architecture work
- Treat `skills/completion-checklist/SKILL.md` as mandatory for any code change before reporting completion
- Treat `skills/deployment/SKILL.md` as mandatory for deployment, Docker, reverse-proxy, CI/CD, and release work
- Treat `skills/frontend-design/SKILL.md` as mandatory for frontend creation or redesign work
- Treat `skills/key-pool-standard/SKILL.md` as mandatory for any AI key-pool, quota, or multi-key retry implementation
- Treat `skills/skill-creator/SKILL.md` as the active workflow when creating, improving, or evaluating a skill
- Treat `.github/skills/openspec-explore/SKILL.md` as the active workflow when the user wants exploration without implementation
- Treat `.github/skills/openspec-propose/SKILL.md` as the active workflow when creating a new OpenSpec change
- Treat `.github/skills/openspec-apply-change/SKILL.md` as the active workflow when implementing an OpenSpec change
- Treat `.github/skills/openspec-archive-change/SKILL.md` as the active workflow when archiving a completed OpenSpec change

Mirror locations (`.claude/skills/`, `.gemini/skills/`, `.opencode/skills/`, `.github/skills/`) hold the same OpenSpec workflow skills so Claude Code, Gemini CLI, opencode, and GitHub Copilot all see them. The canonical source for general workflow skills lives in `skills/`.

## Persistent Standards

- Every code change must update memory (if applicable), update OpenSpec (if applicable), commit, and push; larger work batches may commit in checkpoints and push once the batch is ready. Rule home: `skills/completion-checklist/SKILL.md`.
- Complex tasks must carry workflow checkpoints in the task list, and major task boundaries must trigger a fresh rule check. Rule home: `skills/execution-style/SKILL.md` and `skills/completion-checklist/SKILL.md`.
- Any requirement that should govern future implementation must be written into the formal rule sources (this file or a skill), not left only in chat context. Rule home: `skills/execution-style/SKILL.md`.
- Any non-trivial feature request should first go through an exploration/confirmation step and be captured in OpenSpec before implementation.
- **Feature 完成必須出 Release**：當一輪功能/修復告一段落（pipeline 可端到端跑過、或修好一個有版號意義的問題），必須執行 `Release 流程` 完整 7 步：bump version → commit + push → `git tag v{版本號}` → `git push --tags` → 確認 GitHub Actions 通過 → 確認 Release 頁面有 zip 檔。**不可只 bump `package.json` 卻不打 tag**——沒有 tag 就沒有 Release，使用者拿不到新版。Rule home: 本檔 `Release 流程` 區塊。

## Domain Knowledge — e等公務園 (elearn.hrd.gov.tw)

### 測驗入口（正確路徑）
- **錯誤做法**：在 `/info/{cid}` 找「進行測驗」按鈕 → 不可靠，此按鈕可能不存在或失效
- **正確做法**：
  1. `/info/{cid}` → 點 `button.btnAction`（上課去）
  2. 等 SCORM Learning Center frameset 載入（同分頁跳轉 OR window.open popup）
  3. 在 `mooc_sysbar` frame 找「測驗/考試」或「閱讀測驗」連結並點擊
  4. 在 `s_main` frame 找 `[onclick*="togo("]` 按鈕，抓取 ID
  5. 導到 `exam_start.php?{id}+0`（相對於 s_main 的 location base）
  6. 呼叫 `examBegin()` → 等 `tr.bg03, tr.bg04` 出現 → 答題 → 提交
- 共用 LC 導航邏輯在 `src/main/browser/lc-nav.ts`（`enterLC`, `getSysbarLinks`, `clickSysbarLink`, `awaitWindowOpen`）

### 閱讀完成判斷
- **不使用** `isReadDones === 1`（server 永遠回傳 0，無用）
- **正確依據**：`isReadtimeValidCaption` 欄位
  - `"已通過"` → 全課已完成，跳過所有動作
  - `"未報名"` → 機關推薦但用戶未點課，不是真正課程

### Heartbeat session.fetch
- 使用 Electron session 的 `session.fetch()` 發心跳請求，自動帶 cookie，**不要用 undici**
- undici 是獨立 HTTP client，不共享 Electron session cookie jar

### setReading 必帶 actid，否則 server 不記時數
- HB-END body 沒帶 `actid` → server 收 `code:1 success` 但 **不會更新 /info/{cid} 閱讀時數欄位**
- actid 來自 SCORM iframe 的 `<a onclick>` link：兩種變體
  - `goToActivity('I_SCO_x_x')` (older / center)
  - `launchActivity(this, 'I_SCO_x_x', 'null')` (newer / per-agency)
- 排除 env-check `I_SCO_99999999_*`
- **多 lesson 共用 SCORM 樹**（人權搜查客系列）→ 用 caption fuzzy 比對選對的 lesson
- **整顆 tree 都是 `tree*` ID** 的 player（如 mohw 聯合國人權）→ 偏好深度更深的（`tree1_X_X` 比 `tree0_X` 真實，後者多半是「課程首頁/新手上路/課程資訊」導覽容器）

### SCORM session 必須真的點到 lesson 才會 active
- 抓到 actid 不夠，要**真實 click 那個 `<a>` 元素**讓 player 自己 launchActivity()
- 沒 click → server 端 reading session 卡在 env-check → 心跳全部丟掉
- 共用 helper: `pickBestActid()` + click-by-onclick-match in `extractTicket`

### 多重視窗保護 → ELEARN_WINDOW_CONCURRENCY = 1（v0.4.18）
- elearn 有 `/mooc/warning.php`「禁止多重視窗瀏覽課程」server 端檢查
- 2 個 hidden BrowserWindow 同時打 `/info/{cid}` → 上課去 也會撞到 server-side LC session cookie（同一 SPOC 的兩個 cid 第二次 nav 會蓋掉第一次的 SCORM 上下文，兩 window 都 scrape 同一個 actid）
- 全域 semaphore `ELEARN_WINDOW_CONCURRENCY = 1` 嚴格序列化 `extractTicket` + `enterLC`
- 純 HTTP 心跳階段不受此 slot 影響（仍 50 並行）—— 序列化只 cost 5-10s/門啟動延遲

### user-data SQLite 必須 chmod
- `db.ts` 從 `resources/mixed.db` (packaged 唯讀) `copyFileSync` 到 user data → 繼承唯讀 → INSERT 炸 `attempt to write a readonly database`
- 修法：複製後 `chmodSync(dbPath, 0o644)`

### Per-course chain pipeline
- 每門課 heartbeat 完成立刻 fire 自己的 exam→survey→reflection chain，不等其他課
- `chainPromises` 收集所有 chain promise，pipeline 最後 `Promise.allSettled` 等全部完成
- skipRead 課（已過閱讀）的 chain 在 pipeline 啟動時立即 fire

### Detail-page poll 同步 server 真實閱讀時數
- 每 2 分鐘 (`detailPollIntervalMs`) 抓 `/info/{cid}` 用 cheerio 解 `.majorstatus` 區塊
- 取出 `閱讀時數 / 測驗 / 問卷 / 通過狀態`
- 覆蓋 local card.readSec → UI 跟 server 一致

### 答題正解的取得（four-layer，從 v0.4.13 起重排）
**Layer 0 — `history-solver`（最強，零測驗成本）**
- chain 啟動時先呼叫 `solveExamFromHistory(session, cid)`：
  - enterLC 設 server session → fetch `/learn/exam/exam_list.php` 抓 `viewResult({eid})` 最新 eid
  - dropdown 列出全部歷次 attempt → 對每個 eid `frame.fetch /learn/exam/view_result.php?{eid}`
  - cheerio 解析每次的 (per-Q user pick + 該次分數)
  - 4^Q 暴力枚舉（10 題 → 1M 組合，sub-second）找出能解釋所有 attempt 分數的答案組合
  - 取「全部 perfect-match key 都同意」的題鎖定，模糊題跳過
  - `clearAllLearnedForCourse(cid)` 清掉舊污染後寫入 `learned_answers` (source=history-solve)
- 沒歷史紀錄時 silent no-op（"no eid found"），不 cost 任何測驗

**Layer 1 — `learned_answers` SQLite (`source=history-solve > brute > llm > result-page`)**
- `lookupLearnedAnswer` ORDER BY: source CASE → captured_at DESC → confidence DESC
- `normalizeQuestion` 必須 strip:
  - `^[單複多選]{0,4}配分[:：]?\[\d+(?:\.\d+)?\]` (exam page 才有的「**單選**配分:[10.00]」前綴)
  - `^[第Q]?\d{1,3}[.、題)]?` (題號 "1." / "Q3.")
  - 空白 / `?` / `？` / `，` / `　`
- 沒做這 strip → `view_result.php` 抓的「1. 下列...」對不到 exam-page 的「單選配分：[10.00] 1. 下列...」LIKE pattern → 整套白做（v0.4.14 教訓）

**Layer 2 — `resources/mixed.db` 98K 題庫（read-only）**
- 命中時 confidence = dice similarity，常見 0.6-0.85
- 答案常常是錯的（題庫過時 / 別課的答案）—— 靠 Layer 1 覆蓋

**Layer 3 — Gemini LLM**（`gemini-2.5-flash`，要 `thinkingBudget=0`，否則 token 全被 thinking 吃光回空字串）

**Fallback brute-force probe（無 LLM 也能用，純靠 elearn 分數回饋）**
- 在 `runExamLoop` 內單題 score-delta search:每次重考改一題到下個未試選項，固定其他題在當前最佳。
  - 分數 ↑ → 該題新答案對，存 learned_answers (source=brute) 並前進到下一題
  - 分數 ↓ → 原答案對，鎖定，前進
  - 分數 = → 兩個都錯，試該題下個選項
- 早期終止 guard:`bfQueueIdx >= bfQueue.length` 就 break,不再要求每題每選項都試完（v0.4.14 教訓:tested set 永遠不會滿，無早期終止會無限送題）
- `MAX_EXAM_ATTEMPTS = 30`（容納 worst case：10 Q × 平均 ~2 alt 探測 + buffer）

### 通過門檻：每課用自己的、fallback 80（v0.5.0 起）
- 之前寫死 `Math.max(declared, 80)` 全域強推 80 → 60 分及格的課被推到 80 → 暴力 probe 跑 11 次都過不了，留一堆失敗紀錄看起來很可疑
- 之前把 default 寫 60 → 80 分及格的課做到 60 就停 → 通過狀態永遠 `--`
- 修法：`course-detail.ts` 從 `課程須知` 解 `課程測驗：N分(含)以上`；解失敗 fallback **80**（保守）；solver / classify / examDone 全部直接用 declared，不再 `Math.max(_, 80)`
- 影響：60 分及格的課做到 60 就交問卷；80 分及格的課做到 80 才交；解析失敗的課保守做到 80

### 沒過測驗就 block 問卷（v0.5.0 起）
- 之前邏輯：`if (!passed && !surveyDone)` → 即使 exam res.passed=false 也照交問卷
- 為什麼錯：sever 不會因為交了問卷就 flip 通過（exam 還沒過），交了 = 留下「測驗 50 分 + 鮮交問卷」的指紋特別像 bot
- 修法：chain 維護 `examOK = (passed || res.passed === true || res.total === 0)`；只有 examOK 時才 fillSurvey
- `res.total === 0` 例外：sysbar 沒測驗選單（純閱讀課）→ 不算測驗失敗

### 測驗 row option 文字抓取（v0.5.0 重寫）
elearn 各機關的測驗 row 版型差很多，原本 `closest('label')` / `closest('li')` / parent strip-inputs 在多種版型下會抓空字串或抓到題目文字當選項 A。

**最終做法：position-based walker** in `src/main/exam/solver.ts extractQuestions`：
- 走遍整個 `<tr>` 的 DOM tree，遇到 input 設 cursor，遇到 text 依 cursor 歸到 `pre[cursor+1]` / `post[cursor]`
- 預設用 **post**（input 後文字）；只有 `nonEmpty(pre) > nonEmpty(post)` 才用 pre
  - 不能比 totalLen / 不能比 ≥：因為 pre[0] 永遠包到題目文字，會吃掉選項 A
- 是非題版型 = `<input value="T"><img right.gif>` / `<input value="F"><img wrong.gif>` 沒文字
  - walker 收 img src，src 含 `right/correct/yes/true/o.gif` → "是"，含 `wrong/error/no/false/x.gif` → "否"
  - 兜底：兩 input 文字都空且 value 是 T/F 或 1/0 → 直接 value 推「是」/「否」
- 第一個有空 option 的 row → dump outerHTML 到 `%TEMP%/auto-elearn-exam-row.html`（debug 用）
- option 文字錯了 → matcher `pickOptionIndex` 找不到正解 → 落到 random → 永遠 0 分；這是為什麼一定要修對

### MaxListenersExceededWarning 修法（v0.5.0）
- log 反覆「11 did-stop-loading listeners added」是 cosmetic，不是真 leak
- Electron `webContents.loadURL()` / `executeJavaScript()` 內部加一次性 listener，會 settle 自動清掉，但 in-flight 多 promise 同時掛著就破 default 10
- `suppressDialogs(win)` + reader.ts 的 ticket 視窗各加 `webContents.setMaxListeners(64)` → warning 消失
- 不要試著「只加在某些操作」—— 整個 BrowserWindow 都 raise 才乾淨

### Heartbeat 達標要主動 break（v0.5.0）
- 原本 heartbeat 迴圈只在 `isReadDones === 1`（永遠不會來）或 `caption === "已通過"`（要全課通過才來）才 break
- 結果 server 已經 credit 60/60 分鐘了還繼續 ping，跑滿 maxSec 才退出，浪費時間
- 修法：detail poll 看到 `detail.readSec >= t.requiredSec` 直接 break + 標記 `serverConfirmed=true`（同時跳過 post-finish 等待）
- post-finish wait 從 3 分鐘砍到 30 秒；30 秒內也順便 detail-poll 雙保險

### enterLC 外層 retry（v0.5.0）
- elearn 偶發行為：點「上課去」click event fire 了，但 URL 沒變、frames=0，等於整個 click 沒效（多重視窗 guard 雙擊 / popup blocker quirk）
- `runExamLoop` 內層原本就有 retry，但 `solveExam` / `history-solver` 外層第一道 enterLC 沒 retry → 第一次失敗就放棄 → 「無法進入學習中心」
- 修法：兩處外層 enterLC 都加 3 次 retry，間隔 8s / 11s

### 結果頁正解 parser 永遠不要重啟（v0.4.17 教訓）
- `view_result.php` 不顯示真正的正解 —— 「公布答案」按鈕點下去會打 `set_see_question_result.php?{eid}` 永久鎖重考，不能點
- 任何試圖從成績頁文字 regex 抓「正解」的 parser 都會抓到使用者選的答案 / 不相關 UI 文字 → 灌進 learned_answers 變成假正解
- 已在 v0.4.17 移除 saveLearnedAnswer for source=result-page；只保留第一次的 HTML dump 給 debug

### 問卷入口
- sysbar「問卷」→ s_main 找 `.process-btn.pay.active` 點擊 → 攔截 window.open → 填 radio value='1' → 送出

### 沒有「心得」階段（v0.4.7 起）
- elearn 官方流程只有「閱讀時數 / 測驗 / 問卷」三步
- 早期版本 chain 跑 `心得` 步驟對沒 textarea 的課常態 timeout 噴 `心得失敗`，純粹噪音
- v0.4.7 砍掉 reflection 整個模組；UI stepper 對齊 elearn 三步 + 「等待 server 確認通過…」 sky badge for verifying phase

## Release 流程

**觸發時機（強制）**：每當一輪功能/修復告一段落、`package.json` 有 bump 版號的意圖，就必須走完下列 7 步。**只 bump 版號不打 tag = 未完成的 release**，等同沒做。

1. 確認所有功能正常
2. 更新 `package.json` 版本號
3. commit + push
4. 打 tag：`git tag v{版本號}`
5. push tag：`git push --tags`
6. GitHub Actions 自動 build → zip → 發布到 Release（workflow: `.github/workflows/release.yml`，trigger: `push tags v*`）
7. 確認 Release 頁面有 zip 檔（`auto-elearn-{版本}-win-portable.zip`）

**檢查清單（每次 release 前自查）**：
- [ ] `package.json` `version` 與打算打的 tag 對齊（`v{version}`）
- [ ] 所有 commit 已推到 `origin/main`
- [ ] tag 已推（`git push --tags` 或 `git push origin v{version}`）
- [ ] GitHub Actions 該 tag 的 run 為綠色
- [ ] Release 頁面 zip 檔可下載且解壓出 `.exe`
- [ ] **Release 頁面只能有一個 zip：`auto-elearn-{version}-win-portable.zip`**
      若同時看到 `auto-elearn.zip` / `elevate.zip` 等多餘檔，那是 `release/win-unpacked/auto-elearn.exe`（沒帶 ffmpeg.dll 等附隨 DLL，使用者下載解壓會炸「找不到 ffmpeg.dll」）。
      `release.yml` 已硬寫只 zip `*-win-portable.exe` 並只 upload `*-win-portable.zip`，禁止改回 `-Recurse` 或寬鬆 glob。

### Release 格式

- portable `.exe` 打包成 `.zip`
- zip 裡只有一個 `.exe`
- 使用者解壓雙擊就用

### 注意事項

- 不要在 zip 裡放 `.env` 或任何設定檔
- 帳密在 app 內設定，不需要使用者碰任何檔案
- icon 用記事本（偽裝）

## When To Remove Or Replace Skills

- Remove `skills/frontend-design/` if the project has no frontend.
- Remove `skills/key-pool-standard/` if the project does not use AI API keys.
- Remove `skills/agent-design/` if the project is not building AI agents.
- Keep `skills/execution-style/`, `skills/completion-checklist/`, `skills/plan-before-build/`, `skills/root-cause-debugging/`, `skills/verification-and-evidence/`, and `skills/integration-robustness/` for any project.
- If you delete a skill, also delete its line in the Skill Activation Rules above.
