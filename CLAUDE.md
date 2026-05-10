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
- 每門課 heartbeat 完成立刻 fire 自己的 exam→survey chain，不等其他課
- `chainPromises` 收集所有 chain promise，pipeline 最後 `Promise.allSettled` 等全部完成
- skipRead 課（已過閱讀）的 chain 在 pipeline 啟動時立即 fire

### 50% halfway 並行啟動 chain（v0.7.3 起）
- 之前邏輯：heartbeat 跑滿（readSec ≥ requiredSec）才 fire chain → 60 分鐘的課要等整整 60 分鐘才開始考試
- 新邏輯：cumulative 閱讀時數（`t.readSec + elapsedSec`）達 `requiredSec / 2` 時，engine fire 一次 `onHalfway(cid)`，caller 立即啟動 chain，**心跳繼續跑直到 100%**
- chain 流程：`history-solve → solveExam → fillSurvey → 等心跳完成 → 確認 server 通過`
- 為什麼要等心跳完成：server 不會在閱讀 50% 就 flip 通過狀態；chain 在 30 分鐘交完問卷後直接 poll 30 秒只會看到「尚未刷新」，不算數。改成在 chain 末端 `await heartbeatDonePromises.get(cid)`，等 heartbeat 自然結束（讀滿 100% / detail-poll 確認達標）才做最終 30 秒通過 poll
- 雙路徑去重：`startChainOnce(cid, name, awaitHeartbeat)` + `chainStarted: Set<string>`；halfway 路徑帶 `awaitHeartbeat=true`，heartbeat-done 路徑帶 `false`（fallback：很短的課 halfway 沒先 fire）
- skipRead 課直接 `awaitHeartbeat=false`，沒 heartbeat 可等
- error 路徑（no_ticket / 5 連敗）：engine 仍會走到尾端 `opts.onProgress(cid, "done", ...)` → `markHeartbeatDone()` 解鎖任何在等的 chain；只有 ticket 拿不到的 early return 不會 fire chain（這跟舊行為一致）

### Halfway gate 在 engine 怎麼算
- `halfwaySec = t.requiredSec / 2`（注意：不是 `(requiredSec - readSec) / 2`，是絕對值）
- 入 loop 前如果 `t.readSec >= halfwaySec` 直接 fire（避免等一個 interval）
- loop 內每次成功 tick 後檢查 `t.readSec + elapsedSec >= halfwaySec`
- detail-poll 也檢查 `detail.readSec >= halfwaySec`（server 真實時數可能比 local 快）
- `halfwayFired` flag 鎖一次性，loop 不會中斷，繼續跑到 100% 才 break

### Detail-page poll 同步 server 真實閱讀時數
- 每 2 分鐘 (`detailPollIntervalMs`) 抓 `/info/{cid}` 用 cheerio 解 `.majorstatus` 區塊
- 取出 `閱讀時數 / 測驗 / 問卷 / 通過狀態`
- 覆蓋 local card.readSec → UI 跟 server 一致

### 題庫匹配率調校（v0.7.0）
v0.6.9 之前報的 `DB N / fuzzy 0 / random M` 看起來題庫匹配率超低，其實混了兩個問題：
- **lookupByLike 只 prefix LIKE**：3 個 strategy 都從題目開頭抓 substring。命中時 dice 通常 ≥0.85（直接歸 db），沒命中就全砍掉 → fuzzy 永遠 0、random 暴增
- **brute-force 探測階段把每題 stats 標 `random`**：`forcedAnswers` 路徑 hardcode `source = "random"`（solver.ts），導致暴力鎖定的 70-80% 題目全進 random 桶，看起來像在亂猜其實在對

修法：
1. `lookupByLike` 加 mid-window scan（25%/50%/75% 取 8-char window）+ distinctive 4-gram OR fallback（過濾「下列何者/關於下列」這類 generic gram）
2. `matchAgainstDb` floor 0.35→0.25、db/fuzzy 切點 0.85→0.70
3. `AnswerSource` 加 `"brute"`，暴力探測改標 brute；`bySource` 多一格、log 也補上 `LLM` 與 `brute` 兩欄
4. **滿分自動學習**：score === 100 時把所有 picks（除了 random）寫進 `learned_answers`（source=`perfect-attempt`，conf=1.0）—— 第一次刷成功後下次直接命中
5. LLM gate score≥60 改成「考完就存」（conf 0.85），讓 Gemini 答對的題目即使整場沒過也能累積；matcher 的 LLM confidence floor 也從 0.5 降到 0.4
6. answer-store 預設 limit 從 5 加到 8（給 mid-window 多一點候選空間）

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

## Domain Knowledge — 多帳號架構（v0.8.0+）

### Account = Session + Record + Partition
- v0.8.0 起 multi-account 是唯一模式，**沒有單帳號 fallback**。Picker 上沒帳號 = 空 picker，不會自動進入任何流程。
- 每帳號對應：`AccountSession`（in-memory runtime）+ `AccountRecord`（持久化 metadata）+ 自己的 Electron `partition: persist:elearn-<id>`，cookies / localStorage 互不污染
- `id = sha256(account.toUpperCase())[:12]` deterministic — 換機後同一個 e 等帳號還是同 id
- Storage：`accounts/index.json`（公開 metadata + PIN hash）+ `accounts/<id>.bin`（safeStorage 加密的 raw creds）
- 程式碼：`src/main/account/{storage,manager,pin}.ts`，`AccountSession` 定義在 `manager.ts`

### Pause / Abort 必須是兩個 signal，不要混
- `abortSignal.aborted` = 不可逆終止（pipeline 整個結束）
- `pauseSignal.paused` = 可恢復暫停；chain 跟 heartbeat engine 在 step boundary 用 `awaitNotPaused(s)` 讀
- v0.8.2 之前 `ACTION_PAUSE` 只翻 `state.status="paused"` 但**沒有任何模組讀** → UI 假動作，考試問卷照跑
- 任何新加的長執行流程都要 plumb `pauseSignal`（heartbeat engine 接 `pauseSignal` option；chain 在每個 step 邊界 call `await awaitNotPaused(s)`）

### PIN grace 機制（v0.8.2 起）
- 通過 PIN → `unlocked = true; lastUnlockedAt = Date.now()`
- 切 tab 用 `isWithinPinGrace(s) = unlocked && (now - lastUnlockedAt < 5min)` 判斷要不要重輸
- 手動「🔒 鎖定」按鈕**必須**設 `unlocked = false` **且** `lastUnlockedAt = 0` —— 光 `unlocked = false` 不夠（grace 仍 honor 上次的 timestamp）
- UI 上 `locked` icon 顯示來自 `!isWithinPinGrace(s)`，跟實際是否要 PIN 一致

### Hahow「登入數量上限」auto-click 陷阱（v0.8.4→v0.8.5 教訓）
- Hahow for business 限同帳號 2 裝置同時登入；超過跳 limit 頁
- limit 頁有兩種按鈕：
  - 「登出其他/舊裝置」/ "logout other" = **SAFE**，只踢其他保留我們自己 → 可 auto-click
  - 「繼續」/「使用此裝置」/ "continue" = **UNSAFE**，會踢掉所有其他裝置含**我們自己的 SCORM heartbeat hidden window** → server 砍 reading session → 課程進度直接歸零
- **永遠不要 auto-click UNSAFE 按鈕**。v0.8.4 配 generic「繼續」regex 點下去就是把使用者進度砍掉，緊急 v0.8.5 回滾
- 偵測程式碼：`src/main/browser/view.ts maybeFireHahowLimit`，content-based regex（不靠 URL pattern；hahow URL 可能變但限制頁文字相對穩）

### Hahow chain 並行同時掛在 hahow 撞 limit（v0.8.6 已修）
- chain 並行 `Promise.all([examTask, surveyTask])`（v0.7.3 設計）→ 各自開 hidden window 同時掛在 hahow → hahow 看成 2 裝置
- v0.8.5 之前 `acquireElearnWindowSlot` 只在 `enterLC` 期間 hold，window 載完 LC 後 slot 就 release → 兩個 window 並存掛在 hahow
- v0.8.6 修法：slot ownership 從 `enterLC` 內部上移到 caller — `solveExam` / `fillSurvey` / `setupLcAndFindLatestEid` (history-solver) / `executeScormFinish` 都在 win 建立**前** `acquireElearnWindowSlot`，`finally win.destroy` 後 release。`enterLC` 加 `skipSlotAcquire: true` 選項給已 hold 的 caller 用避免 deadlock。chain 兩 task 因此 serialize，hahow 同時間只看到 1 個 hidden window。

### 背景 tab Chromium throttle（v0.8.8 已修）
- 預設 BrowserView 跟 `show: false` 的 BrowserWindow 都受 Chromium background throttling — bounds 0×0 view 的 setTimeout/setInterval 被降到 1Hz
- 影響：SCORM iframe `manifest.js` callback chain、hidden window polling 全部慢成廢物。多帳號切到別的 tab → 背景 tab heartbeat / chain 卡住
- v0.8.8 修法：所有 `webPreferences` 加 `backgroundThrottling: false`（7 處：`attachElearnView` + `extractTicket` + `executeScormFinish` + `solveExam` + `fillSurvey` + `setupLcAndFindLatestEid` + `unenrollCourse`）
- 之後新加任何 hidden BrowserWindow 都**必須帶這個 flag**，否則多帳號背景跑會卡

### 跨帳號同一堂課必須排他 + 排隊（v0.8.7→v0.8.8）
- 實測同一 cid 被 2 個帳號同時 heartbeat → server SCORM session 互砍，先進場的 readSec 歸零
- 但「多人同時刷課」是核心功能，**不能直接擋**
- v0.8.7 第一版用「跳過 + markHeartbeatDone」做法，等於假裝完成，課程其實沒上 — 立刻 v0.8.8 改成排隊
- v0.8.8 設計：
  - `courseOwners: Map<cid, {accountId, nickname}>` 記持有者
  - `acquireCourseOwnership(cid, s)` 拿到 ok / 失敗回傳被誰佔
  - 拿不到的進 `queued` 陣列，UI 顯示 `card.waitingForOwner` badge「⏸ 等候 XXX 上完」
  - 主批跑完進入排隊 loop，每 15s 重 acquire；持有者完成 heartbeat 立即 `releaseCourseOwnership(cid)`，queued 帳號最多等 15s 接手
  - destroy / done / back 都 `releaseAllCoursesForAccount`
- 教訓：永遠不要用「跳過 + markHeartbeatDone」當「跳過此 cid」訊號，那會被 chain 當成完成。要跳過就用 `card.waitingForOwner` 這類等候標記，不要碰完成相關旗標

### 本地 timer extrapolation 必須 per-account key（v0.8.9）
- Renderer Monitor 元件用 tickInfo Map 推算「上次 server 回 readSec → 之間每秒 +1」的本地計時器
- v0.8.9 之前 key 只用 cid → 多帳號同 cid 切 tab 時對方的 readSec 蓋掉自己的 lastSyncAt → 切回時 timer 倒退 1-2 分鐘
- v0.8.9 修法：tickInfo 提到 module-level，key `${accountId}:${cid}`
- 注意：這純粹 UI 視覺層；main 端 `card.readSec` 是 per-session in-memory state，切 tab 從來沒影響它

### Gemini 額度耗盡不能卡考試（v0.8.10）
- 免費 Gemini key 每日 limit 約 20 reqs；多帳號 × 多課同時跑很容易撞 429
- v0.8.9 之前的問題不在 `generateText` — 它早就會回 null。是在 `solver` 的 strategy 邏輯：看到 fail + `hasGeminiKey()=true` 就 `skipMixedDb=true` 切 LLM 模式，下次重考又打死掉的 Gemini 又拿 random，**brute force probe 永遠不啟動**
- v0.8.10 修法：`gemini.ts` 加 `_quotaExhaustedAt` timestamp
  - 第一次 429 設 `_quotaExhaustedAt = now()` + log 一次明確訊息
  - 1 小時內 `generateText` short-circuit 回 null（不浪費 API timeout）
  - 1 小時後自動清，下次呼叫再試（GCP 一般是 60s 或 daily window，1h 是穩妥的 retry 點）
  - 新 export `isGeminiUsable() = hasGeminiKey() && quota 沒撞`
  - **`matcher.askLlm` 跟 `solver` 策略判斷一定要用 `isGeminiUsable()`，不能用 `hasGeminiKey()`** — 後者撞 quota 後仍回 true，會卡 brute force 不啟動
- UX：Gemini modal 「清除」按鈕跟 picker 「🗑 全域清除」字面太像，使用者會搞混；改成「清掉 Gemini Key」明確標籤 + 標題下加說明「跟帳號 / 偽裝密碼完全無關」

### Cross-domain nav logger（v0.8.1+）
- BrowserView 沒有 URL bar，使用者看不到撞到哪個 host
- `view.ts logCrossDomain` 攔 did-navigate / did-redirect-navigation，非 elearn/ecpa 域名自動 log
- 每 host 第一次出現必 log；後續同 host 命中關鍵字（hahow / nidp / limit / device）也 log
- 用來定位 hahow / 自然人 SSO 等第三方 host 的 URL pattern；新加 third-party 整合時這個 log 是第一手線索

### Heartbeat reauthFn（v0.8.1+）
- 連續 3 次 heartbeat 失敗 → caller 提供的 `reauthFn(cid)` 被呼叫
- caller 應該：靜默 `loginViaEcpa` + `extractTicket` → 回傳新 ticket
- engine 拿到新 ticket 重置 bt，繼續打剩下的時間
- 沒 reauth 的話心跳失敗 5 次直接 break，server 端的 reading session 變成孤兒，下一輪重啟也救不回來

### 加選課程前 isSessionAlive precheck（v0.8.1+）
- 多帳號背景 tab 久了 idx cookie 會過期但 partition 其他 cookies 還在
- 不檢查直接 enrol → server silently 302 到 login → 看似報名 200 OK 實則沒寫成功
- `runPipelineFor` 在 enrol 前 ping 一下 dashboard，沒 idx 就先 `tryAutoLogin`

### Web 題庫 prefetch (v0.8.13+)
v0.8.12 實測 C 帳號 9 門考試 0/9 通過 — brute force 對 elearn 隨機抽題、多選題、是非題結構性無解。引入 `rodiyer.idv.tw`（2056 篇 Blogger 解答頁）做 prefetch：

- enrol 完 fire `prefetchCoursesViaWebBank` 跟 heartbeat 並行
- 索引 `<storageDir>/web-bank-index.json`、24h cache、`MIN_VALID_INDEX_ENTRIES=500` 健全性檢查（pre-fix bug 留下的 150 篇 cache 自動 invalidate）
- RSS feed `?max-results=N&start-index=N` 分頁 — Blogger silent cap 每頁 25，要看 truly empty 才 stop
- fast-fuzzy dice 比對 0.85，title 預處理去 `【解答】` + `-11X年` 後綴
- 命中課用 cheerio 解 HTML，**`.post-body → .entry-content → article → body`** 順序
- parser **line-walking** 不是 same-line：`問\n題目\n✓\n選項`（cheerio.text() 把每個 block-level 元素拆 \n）
- 是非題標 `╳`（false） / `○`（true）→ 寫 learned_answers 前 map 成「否」/「是」匹配 elearn 考試頁 option 文字

#### Multi-select v0.8.13 同時修
v0.8.12 之前 solver 偵測 `isMultiple = inputs[0].type === 'checkbox'` 但 `pickedIdx: number` + `selectOption(value: string)` 都單值送出，server 多選必判錯。修法：
- `learned_answers.answer` 改存 JSON array (`["A","B"]`)，`decodeAnswers` 對舊單字串 row fallback `[raw]`
- `findBestAnswer` 回 `pickedIdxs: number[]`
- `selectOption(values: string[])` 對每個 value 找 input checked + dispatch change
- saveLearnedAnswer call sites 改 `answers: string[]`（含 history-solver、score=100 perfect-attempt 路徑）

#### Source priority gate
saveLearnedAnswer 加守則：新 priority < 既存則 silent skip（normalized LIKE 比對找最高 priority 的既存 row）。優先序：

```
web-prefetch (10) > history-solve (8) > perfect-attempt (7) > llm (5)
> db (4) > fuzzy (3) > result-page (2) > brute (1) > random (0)
```

ORDER BY CASE 在 `lookupLearnedAnswer` 跟 SOURCE_PRIORITY 對齊，DESC（不再用舊版 ASC）。

#### Early-exit guard（v0.8.13 e2e 教訓）
T8 實測：bank 對「**行政中立暨公務倫理**」fuzzy match 1.00 命中（標題完全相同）但**內容是 2026/02 異年版本**，跟 elearn cid=10046536 的 2026 題目集**不重疊**。lookupLearnedAnswer 全 miss → fall through random/db → score 20 → brute 30 場全失敗 → ELEARN_WINDOW_CONCURRENCY=1 卡住其他 8 條 chain 30 分鐘。

修法（`solver.ts runExamLoop` 第一場後）：
```
if (attempt === 1 && bySource["web-prefetch"] === 0 && score < passingScore - 30) break;
```
直接放棄該課（chain 結束、釋放 slot），不浪費 brute attempts。

#### v0.8.13 已知限制（v0.8.14 已解）
- bank fuzzy match course title ≠ 題目集相同。「同名異年」「同名異版」課程 prefetch 寫進去但對不上題目，整門課 web-prefetch 失效（fall through 到原 4 層）。早退 guard 至少不卡 slot
- ✅ **v0.8.14 解法**：bulk prefetch 全 2056 篇 bank 進 learned_answers（背景 ~15 min、24h cache），lookup 直接靠題目文字 normalized LIKE，繞過課名 fuzzy 假陽性

### Bulk web-bank prefetch (v0.8.14+，v0.8.15 限縮 500)
v0.8.13 的 per-course prefetch 對「同名異年」課失效。v0.8.14 加 `bulkPrefetchBankIndex` 把站抓進 learned_answers：

- 觸發：`runPipelineFor` 啟動時 check `<storageDir>/web-bank-bulk-done.json` mtime；> 24h 或不存在 → fire 背景 task（不 await）
- v0.8.15 起只抓**最新 500 篇**（`BULK_RECENT_LIMIT`），不抓全 2056。RSS feed 是 newest-first，500 篇覆蓋 115 年（當期）+ 114 年大部分 — 使用者真實會考的範圍。舊年份課已從 elearn 下架，bulk 抓進來也用不到
- 並行 5、~3-4 min 處理 500 篇、~5K 題寫入 learned_answers (`source="web-prefetch"`, `courseId=null` 表「來源是 bank、不綁特定課」)
- saveLearnedAnswer priority gate 自動 idempotent — 重跑命中既存 row 直接 skip
- per-course prefetch 保留 — 它 cover 勾選課程比較快（per-fetch < 1s vs bulk 3-4 min）。bulk 是把剩下沒 fuzzy 命中的 active corpus 也塞進來
- 跨帳號自然共享：第一個 user fire 完後，所有帳號考任何 bank 收錄的題目都直接命中

**成本**：第一次 ~3-4 min fetch（背景）+ ~1.5MB JSON 索引 + learned_answers 表多 ~5K 行（SQLite 沒壓力）。穩態 24h cache 重用。

**為什麼不抓全 2056**：站方收錄過去 2-3 年的解答頁，但 elearn 上「我的課程 / 機關推薦」99% 是當年新版 + 部分前一年。舊年份課使用者根本看不到、無法選，bulk 抓進來純浪費頻寬跟 SQLite 空間。

#### p-limit ESM/CJS 衝突（v0.8.13 教訓）
`p-limit@6` 是 ESM-only，Electron main 是 CJS。`require('p-limit')` 直接 `ERR_REQUIRE_ESM`。專案其他模組（heartbeat/engine.ts、course/discovery.ts）早就改成 inline limiter。新模組要寫並行控制**直接寫 6 行 inline semaphore**，不要 import p-limit。typecheck 不會抓到，要實際跑 dev 才會炸。

### v0.8.16 — Brute 不覆蓋 web-prefetch 答案
v0.8.15 實測：partial 命中課（5/10 web-prefetch 命中、baseline 60 vs 門檻 75）brute force 反而把分數拖下來 60→30→50→20→40 來回震盪。

**根因**：runOneAttempt 的 picksByIdx 不分 source，bfStates seeding 時把全 10 題（含 5 個 web-prefetch 命中）都納入 bfQueue，forcedAnswers 強制覆蓋成單一 idx → 多選 multi-✓ submission 被 squash 成單選 → 對的答案變錯。

**修法**：runOneAttempt 回傳 `picksSource: AnswerSource[]`（parallel to picksByIdx）；bfStates seeding 時 skip `picksSource[i] === "web-prefetch"` 的題目，那些不入 bfQueue → 不被 forcedAnswers 蓋寫 → 後續 attempt 自然從 matcher.lookupLearnedAnswer 命中 web-prefetch。

### v0.8.17 — Bulk progress 進入 UI badge
v0.8.13 的 `📥 題庫 N 題 · X/Y 課命中` badge 只顯示 per-course prefetch 數。bulk 在背景跑但 4721 題沒在 badge。修法：AppState 加獨立的 `webBankBulkProgress` field、bulk 函式接 `onProgress` callback、App.tsx 加第二個並排 badge `📚 全量題庫 抓取中 N/M 篇 · K 題`。

### v0.8.18 — Bulk 改增量 (URL diff)
v0.8.17 用 24h timestamp file 判定要不要重抓：first run 165/500 失敗，那 165 篇要等 24h 才重試 — 但失敗那批可能正是 elearn 抽到的題目，「平白放廢」一整天。

**修法**：`web-bank-bulk-done.json` 改存 `processedUrls: string[]` (只含**成功** parse 過的 URL)。每次 pipeline 啟動：
1. 永遠重抓 RSS index（~5s，無 24h cache）
2. delta = top-500 entries minus processedUrls
3. delta 為空 → log「題庫已完整覆蓋」skip；delta 有內容 → 抓 + parse + 加入 processedUrls
4. 失敗 URL 不入 processedUrls → 下次自動重試

steady state：top-500 全 cached → bulk 一秒內就 skip。

### v0.8.19 — bySource counter 加 web-prefetch + pipeline-end summary
- 「測驗完成 ... DB 0/fuzzy 0/LLM 0/brute 0/random 4」漏列 web-prefetch — display bug，實際 6 題 web-prefetch 命中卻沒顯示。修法把 `題庫 N` 加在最前面
- pipeline 結束時 log `📊 本批 N 門總結：✅ X 過 / ❌ Y 沒過；失敗：<list>`，省去使用者翻看每課 log

### v0.8.28 — 考試前等待題庫實際可用
實測三帳號（2026-05-10）：`aegis99999` 未通過課 8/9 可被 rodiyer top-500 精準命中；`ar8271` 未通過 20 門多為 Hahow/MOOCs/英文/COVID 語言課，rodiyer 課名覆蓋 0/20。結論：web-bank 是「覆蓋公務園常見題庫課」而不是萬能；沒覆蓋且 Gemini key 未設時仍會退回 DB/fuzzy/brute，失敗率高。

本輪也修 pipeline ordering：skipRead（已過閱讀、直接進考試）的 chain 必須在 `prefetchPromise` / `bulkPrefetchPromise` 建立後才啟動。考試前先等 per-course prefetch 最多 30s；如果沒寫入題目，再等 full bulk prefetch 最多 300s，避免「全量題庫正在背景抓，但考試已先用舊 DB/brute 跑完失敗」。

### v0.8.20 — Slot 等候時告訴使用者為什麼
chain log「開始測驗：xxx」之後常常沉默幾分鐘，使用者懷疑 hang。實際是 `acquireElearnWindowSlot` 排隊。

**修法**：`acquireElearnWindowSlot({ label, log })` 簽名加可選 callback。slot 被佔住要等時 fire 一條 log：「⏸ 等候 elearn 視窗排隊：「考試「xxx」」 — 目前由「歷史反推 cid=...」占用（前面還有 N 條也在等）。注意：同帳號或同電腦 2 個視窗同時操作 elearn 會被伺服器擋（多重視窗鎖定 / SCORM 互砍）」。`solveExam`、`solveExamFromHistory`、`fillSurvey` 都 wired 對應 label。

### v0.8.21 — 關閉 / 最小化收進 tray
之前點 X 直接 `app.quit()`。現在：
- `mainWindow.on("close")` preventDefault + hide → 程式還在背景跑，tray icon 留著
- `mainWindow.on("minimize")` preventDefault + hide → taskbar 也不顯示（偽裝模式友善）
- 真退出只能透過 tray 右鍵「結束」（set `isQuittingForReal = true` → app.quit）

### v0.8.22 — BrowserView bounds 跟視窗狀態走
從 tray 還原 / 最大化 / 全螢幕 toggle 時，BrowserView 還用 hide 之前的 bounds，畫面會錯位。修法：`mainWindow` 的 7 個 events (`show / restore / maximize / unmaximize / enter-full-screen / leave-full-screen / resize`) 全部 hook 重 apply lastBounds 到 active session view。idempotent — renderer 之後 push 新值仍會覆蓋。

### v0.8.13~v0.8.22 累積實測戰況
v0.8.12 baseline：C 帳號 9/9 fail；v0.8.22 同樣 9 課 C：6 過（80~100 分）+ 2 早退（題庫無覆蓋）+ 1 brute 卡 70；B 帳號（4 + 後續 AI 課）：100% 全過、多 100 分。**真實命中關鍵看 elearn 那課當下抽題是否落在 bank 收錄子集**（rodiyer 2056 篇 / 我們抓最新 500 / bulk 完成寫入 ~5K 題到 learned_answers）。

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
