# auto-elearn — Design Spec

- **Date:** 2026-04-23
- **Status:** Draft (awaiting user review)
- **Target platform:** `https://elearn.hrd.gov.tw` (e 等公務園+學習平臺)

## 1. Purpose

一個比既有 `E等閱讀家` 功能更完整、架構更乾淨的自動刷課工具。核心差異：
- 使用者自行登入（不儲存帳密，不逆向 SSO）
- 動態抓課程清單（不寫死 ID）
- 並行心跳（一次刷 N 門課）
- 測驗 + 問卷 + 評價三者全自動
- 不認識的題目走 LLM fallback 而非亂猜
- 1 秒刷新的即時監視器 UI
- 使用者需要時可隨時接手 Playwright 瀏覽器

## 2. Goals / Non-goals

**Goals**
- 登入 → 所有指派/感興趣課程完成（含閱讀時數、測驗通過、問卷、評價）→ 回報統計
- UI 即時可見「bot 當下在做什麼」
- 暫停 / 接手 / 恢復流暢
- 題庫可自行成長（寫回新答案）

**Non-goals（初版不做）**
- 多帳號批次排程
- 自然人憑證自動登入
- 跨平台（Windows 為主；macOS/Linux best effort）
- 分發（無安裝包 / 無簽章）
- 無人值守雲端部署

## 3. Stack

遵循 `project-stack-standard`：

| 層 | 選擇 |
|---|---|
| Runtime | Node.js 20+ LTS |
| 語言 | TypeScript 5 |
| 後端 | Fastify |
| 瀏覽器自動化 | Playwright (chromium/chrome/edge channel) |
| HTTP client | `undici` (Node built-in fetch) |
| DB | SQLite via `better-sqlite3` |
| 前端 | React + Vite + Tailwind |
| 即時推送 | Server-Sent Events (SSE) |
| 模糊比對 | `fast-fuzzy` 或 `fuse.js` |
| LLM | Gemini via `@kevinsisi/ai-core`（若 HomeProject key-pool-standard 可用）否則 `@google/generative-ai` |
| Config | YAML via `yaml` |
| 打包 | `tsx` dev、`tsc` build；執行以 `node --enable-source-maps dist/server/main.js` 為主，不做 single-binary |

UI 文字：**繁體中文**。

## 4. Monorepo 目錄

```
auto-elearn/
├─ package.json                 # npm workspaces root
├─ packages/
│  ├─ server/
│  │  ├─ src/
│  │  │  ├─ main.ts              # Fastify entry
│  │  │  ├─ config.ts            # 讀 config.yaml
│  │  │  ├─ bus.ts               # EventEmitter → SSE bridge
│  │  │  ├─ state.ts             # 全域執行狀態（機器可觀察）
│  │  │  ├─ browser/
│  │  │  │  ├─ session.ts        # Playwright 啟動 / 偵測登入
│  │  │  │  └─ pause-gate.ts     # asyncio.Event 等價 (promise gate)
│  │  │  ├─ course/
│  │  │  │  ├─ discovery.ts      # 掃 learn_dashboard.php
│  │  │  │  ├─ enrollment.ts     # POST /enploy/<id>
│  │  │  │  └─ types.ts
│  │  │  ├─ heartbeat/
│  │  │  │  ├─ engine.ts         # p-limit(N) 並行控制
│  │  │  │  └─ client.ts         # undici → setReading
│  │  │  ├─ exam/
│  │  │  │  ├─ solver.ts         # Playwright-driven
│  │  │  │  ├─ matcher.ts        # DB → fuzzy → LLM
│  │  │  │  └─ answer-store.ts   # read + write-back
│  │  │  ├─ survey/
│  │  │  │  └─ filler.ts         # 問卷 + 評價
│  │  │  ├─ llm/
│  │  │  │  └─ gemini.ts         # key-pool 相容介面
│  │  │  └─ api/
│  │  │     ├─ state-sse.ts      # GET /api/state (SSE)
│  │  │     └─ actions.ts        # POST /api/action/{pause,resume,abort,focus}
│  │  └─ tsconfig.json
│  └─ client/
│     ├─ src/
│     │  ├─ main.tsx
│     │  ├─ App.tsx              # 監視器主畫面
│     │  ├─ components/
│     │  │  ├─ NowPlaying.tsx    # 目前進行中卡片
│     │  │  ├─ CourseList.tsx    # 所有課程列表
│     │  │  ├─ LogPanel.tsx      # 最近 50 行日誌
│     │  │  └─ ControlBar.tsx    # Pause/Resume/Focus/Abort
│     │  └─ hooks/
│     │     └─ useStateStream.ts # EventSource
│     └─ vite.config.ts
├─ data/
│  └─ mixed.db                   # 搬自 E等閱讀家（98,569 題）
├─ config.yaml                   # 使用者設定
└─ docs/superpowers/specs/
   └─ 2026-04-23-auto-elearn-design.md
```

## 5. 資料模型

保留既有 `questions` 表相容（不改 schema，用中文欄名）：

```sql
CREATE TABLE questions (
  "題目"  TEXT,
  "答案_1" TEXT,   -- 正解
  "答案_2" TEXT,
  "答案_3" TEXT,
  "答案_4" TEXT
);
CREATE INDEX IF NOT EXISTS idx_questions_clean ON questions("題目");
```

新增表：

```sql
CREATE TABLE learned_answers (
  question      TEXT PRIMARY KEY,
  answer        TEXT NOT NULL,
  source        TEXT NOT NULL,    -- 'exam_result' | 'user_override'
  captured_at   INTEGER NOT NULL,
  course_id     TEXT,
  confidence    REAL DEFAULT 1.0
);

CREATE TABLE run_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  courses_done  INTEGER DEFAULT 0,
  quizzes_pass  INTEGER DEFAULT 0,
  llm_calls     INTEGER DEFAULT 0,
  notes         TEXT
);

CREATE TABLE course_progress (
  course_id     TEXT PRIMARY KEY,
  course_name   TEXT,
  phase         TEXT,           -- 'pending' | 'enrolled' | 'reading' | 'exam' | 'survey' | 'rating' | 'done'
  read_sec      INTEGER DEFAULT 0,
  required_sec  INTEGER DEFAULT 0,
  updated_at    INTEGER
);
```

## 6. 核心元件

### 6.1 Browser Session (`browser/session.ts`)
- Playwright launch：`channel: chrome` > `edge` > `chromium`，`headless: false`（必須可見以便接手）
- 初始導向 `https://elearn.hrd.gov.tw/mooc/index.php`
- 進入 `paused` 狀態等待使用者登入
- Poll 頁面直到 `a[href="/mooc/user/learn_dashboard.php"]` 文字含「個人專區」→ 自動 resume + 進入主流程

### 6.2 Pause Gate (`browser/pause-gate.ts`)
- 一個 Promise-based gate：
  ```ts
  class PauseGate {
    private resolvers: Array<() => void> = [];
    private paused = true;
    pause(reason: string, ctx?: unknown) { this.paused = true; emit('pause', {reason, ctx}); }
    resume() { this.paused = false; this.resolvers.splice(0).forEach(r => r()); emit('resume'); }
    async wait() { if (!this.paused) return; return new Promise<void>(r => this.resolvers.push(r)); }
  }
  ```
- 所有 bot 動作進場先 `await gate.wait()`
- 觸發自動暫停：`[captcha_detected, pin_prompt, element_not_found_retry_exhausted, unknown_alert, llm_low_confidence]`

### 6.3 Course Discovery (`course/discovery.ts`)
- GET `learn_dashboard.php?tab=1`（透過 Playwright context 帶 cookie）
- Parse 分頁 `span.paginate-number-after`
- 每頁掃 `.course-list-block`，依進度條狀態分組：
  - 未開始（`.progress-read` 缺）
  - 閱讀中（`.progress-read` 有但未達應閱讀時數）
  - 已閱讀未測驗／未問卷／未評價
- **注意**：`learn_dashboard.php` 只列「已報名」的課程。未報名的目標課程由 `config.yaml` 的 `enroll.course_ids` 提供（取代原版 `choose_30.js` 寫死）；使用者可放入必修課 ID 清單，啟動時先跑 `enrollment.ensureEnrolled(config.enroll.course_ids)` 再呼叫 discovery
- 回傳 `Course[]` 結構，phase 用於 heartbeat / exam 排程

### 6.4 Enrollment (`course/enrollment.ts`)
- 針對「未報名」：`POST /enploy/<id>` 用 Playwright 的 requestContext 帶 cookie
- 成功條件：200 或 redirect
- 失敗進日誌但不中斷

### 6.5 Heartbeat Engine (`heartbeat/engine.ts`)
- 用 `p-limit(config.concurrency.heartbeat_parallel)` 控制同時飛幾條
- 每條心跳分兩階段：

  **Phase A（Playwright 前置，每門課只做一次）：**
  1. 開新 Playwright page 進入課程頁
  2. 解 majorstatus 已閱讀時數 / course-goal 應閱讀時數（不用 regex 解 HTML，**用 Playwright `locator` + `textContent`**）
  3. 點 `button.btn.btn-primary.btn-blue.btnAction` 進入閱讀器
  4. 取得 iframe 的 `pTicket` / `cid`（透過 `page.evaluate`）
  5. 從 `context.cookies()` 複製 cookie 給 undici
  6. **關閉 Playwright page**（釋放資源）

  **Phase B（undici 純 HTTP heartbeat loop，可大量並行）：**
  7. 每 `interval_sec ± jitter` 秒 POST 一次 `/mooc/controllers/course_record.php?actype=end`
     body: `action=setReading&type=end&ticket=<pTicket>&enCid=<cid>`
  8. 每次心跳後由 `bus` 推狀態給 dashboard
  9. 累積達到 `required_sec - read_sec` 後停止；標記 `reading done`

好處：8 條並行只佔 1 個 Chromium（Phase A 短暫共用），不會撐出 8 個 tab 耗記憶體。隨機 jitter 4–6 秒避免全同步（降低 rate limit 風險）。

### 6.6 Exam Solver (`exam/solver.ts`)
- 單開 Playwright tab（不走 HTTP，因為題目 DOM 複雜）
- 處理流程：
  1. Accept alert；若 `不在開放時間` → skip
  2. 點 `input.cssBtn[value='開始作答']`
  3. 列舉 `tr.bg03, tr.bg04` → 對每題：
     - 抽 question text（移除 `<ol>` 複製後取 innerText）
     - `matcher.findAnswer(text)` → `{text, confidence, source}`
     - 根據題型選：
       - 是非題：`T`/`F`（對映 `○`/`╳`）
       - 選擇題：題庫 text 與選項 text fuzzy match（rapidfuzz 等價）
       - 信心 < threshold → pause gate 交接
  4. Submit；若出現 `不及格` → 重試（上限 3 次，之後 pause）
  5. 測驗通過後**抓結果頁正解**寫回 `learned_answers`

### 6.7 Answer Matcher (`exam/matcher.ts`)
三段式：
1. **Exact clean match**：標準化（去空白、標點、全形→半形）後 `WHERE 題目 = ?`
2. **DB LIKE + fuzzy**：取清洗後文字 LIKE 查 top 10，再 `fast-fuzzy` 排序，最高分 ≥ 0.88 採用
3. **LLM fallback**：若開啟，把題幹 + 所有選項丟 Gemini，要求回傳「選項編號 + 信心 0-1」，≥ `llm_min_confidence` 採用
4. 皆失敗 → 根據 `on_unknown` 設定：`random_and_log` | `skip` | `pause`

### 6.8 Survey / Rating Filler (`survey/filler.ts`)
從「評量區」側邊欄進入：
- **問卷**：每題預設最高分選項（Likert 1-5 取 5）；文字框填 `default_comment`
- **評價**：5 星 + `rating.comment`
- 可在 `config.yaml` 針對單一 `course_id` 覆寫
- 提交前 dry-run log，避免誤送

### 6.9 LLM Client (`llm/gemini.ts`)
- 介面：
  ```ts
  interface LLMClient {
    answerQuestion(q: string, options?: string[]): Promise<{ pick: string; confidence: number }>;
  }
  ```
- 優先用 `@kevinsisi/ai-core`（HomeProject key pool 規格）；fallback 直接 `@google/generative-ai` + 單 key
- Prompt 模板（中文）：
  ```
  你是台灣公務員訓練題目解題助手。請從以下選項挑出正確答案，並給出 0-1 的信心。
  題目：{question}
  選項：
  A. {opt1}
  B. {opt2}
  C. {opt3}
  D. {opt4}
  僅回 JSON：{"pick":"A|B|C|D","confidence":0.0-1.0,"reason":"..."}
  ```
- 失敗降級：timeout / rate limit / 解析錯誤 → 當成未知；配合 `integration-robustness` 規則的 retry+backoff

### 6.10 Dashboard (`client/src/App.tsx` + `api/state-sse.ts`)
**Server：**
- `GET /api/state` — SSE，每秒（或事件驅動）推一次 `AppState` JSON：
  ```ts
  interface AppState {
    status: 'idle' | 'running' | 'paused' | 'done' | 'aborted';
    pauseReason?: string;
    now: {
      courseId?: string;
      courseName?: string;
      action: 'enroll'|'heartbeat'|'exam'|'survey'|'rating'|'idle';
      detail?: string;    // 第 X/Y 題、已閱讀 MM:SS、etc
      currentQuestion?: { text: string; answer: string; source: 'db'|'fuzzy'|'llm'|'random' };
    };
    courses: Array<{ id, name, phase, readSec, requiredSec, lastPing? }>;
    logs: Array<{ ts: number; level: 'info'|'warn'|'error'; msg: string }>;
    stats: { done: number; quizzes: number; llmCalls: number };
  }
  ```
- `POST /api/action/pause` / `resume` / `abort` / `focus-browser`

**前端：**
- 預設 `http://localhost:8787`
- 三區塊：
  1. **NowPlaying**（上方）— 大卡片，顯示當下課程 + 動作 + 題目 + 答案 + 進度條
  2. **CourseList**（中段）— 所有課程狀態表，每列一門
  3. **LogPanel**（下方）— 最近 50 行日誌，autoscroll
- **ControlBar** fixed bottom：`⏸ Pause` / `▶ Resume` / `🪟 Bring browser to front` / `🛑 Abort`
- 連線斷開顯示 `Disconnected，嘗試重連…`

## 7. 核心流程

### 7.1 Startup
```
1. Load config.yaml
2. Open SQLite (create new tables if missing)
3. Start Fastify on :8787
4. Launch Playwright (visible, persistent context in ./user-data)
5. PauseGate 起始為 paused，reason = '請在瀏覽器登入'
6. Poll 「個人專區」出現 → gate.resume() → 進入 7.2
```

### 7.2 Main Run
```
while not aborted:
  courses = discovery.scan()
  if all done: break
  await enrollment.ensureEnrolled(courses)
  await Promise.all([
    heartbeat.run(courses.readingNeeded, limit=N),
    // 閱讀完成 event 觸發：
    exam.runFor(finishedReading),
    survey.runFor(examPassed),
    rating.runFor(surveyDone),
  ])
stats = write_run_history()
```

### 7.3 User Takeover
```
Trigger:
  - 使用者按 Pause → gate.pause('manual')
  - 自動偵測 → gate.pause(reason)
當 paused：
  - SSE 推 'paused' + reason
  - Dashboard 顯示提示 + Resume 按鈕
  - bot 所有 await gate.wait() 的協程停下
使用者完成手動動作 → Resume → gate.resume()
```

### 7.4 Shutdown
- `/api/action/abort` 或全部完成 → 關 Playwright context → 寫 `run_history.ended_at` → Fastify shutdown → 瀏覽器自動跳 done 頁

## 8. Configuration（`config.yaml`）

```yaml
browser:
  channel: chrome         # chrome | msedge | chromium
  user_data_dir: ./user-data
  bring_to_front_on_pause: true

concurrency:
  heartbeat_parallel: 8
  heartbeat_interval_sec: 5
  heartbeat_jitter_sec: 1

answering:
  fuzzy_threshold: 0.88
  on_unknown: pause        # random_and_log | skip | pause
  llm:
    enabled: true
    provider: gemini
    model: gemini-2.5-flash
    min_confidence: 0.7
    timeout_ms: 15000
    max_retries: 3

enroll:
  course_ids: []           # 要自動報名的必修課 ID，取代原版 choose_30.js 寫死清單
                           # 若留空只處理已報名課程

questionnaire:
  default_score: 5
  default_comment: "課程內容豐富，受益良多。"
  overrides: {}            # { "10042905": { score: 4, comment: "..." } }

rating:
  stars: 5
  comment: "課程內容豐富，推薦給同仁。"

dashboard:
  port: 8787
  auto_open: true          # 啟動時開 default browser
  logs_retained: 200
```

## 9. Error Handling & 風險

| 風險 | 偵測 | 處理 |
|---|---|---|
| 心跳 API 改版 | POST 非 2xx | 指數 backoff 重試 3 次 → pause |
| 出現 captcha | `canvas` / `captcha` 字樣在 DOM | 立即 pause，reason=`captcha` |
| 自然人憑證 PIN | Windows modal 無法偵測 | 依賴使用者觀察；登入階段本來就是 paused |
| LLM 超時 | 15s timeout | 降級為未知；進 `on_unknown` 分支 |
| 測驗不及格連 3 次 | 頁面 `不及格` | pause 交給使用者 |
| Playwright 崩潰 | uncaught exception | Fastify 保留，僅 bot 停止；dashboard 顯示錯誤 |
| SQLite 被誤刪 | 啟動檢查 | 若缺 `mixed.db`，提示使用者提供 |

## 10. 測試策略

- **Unit**：`matcher.ts`（題目清洗 / fuzzy 邊界）、`pause-gate.ts`、配置載入、answer-store write-back
- **Integration (mock)**：用 Fastify mock e-learning endpoints，驗 heartbeat engine 並行正確性 + exam flow
- **Manual E2E**：真的跑一輪 14 門課並監看 dashboard；錄影保存
- 不做瀏覽器端 snapshot 測試（DOM 會隨站改版）

## 11. 非目標 / 後續可做

- 多帳號批次（V2）
- 自然人憑證自動登入（不考慮）
- 跨裝置共享 `learned_answers`（P2P 或雲端 opt-in）
- 社群題庫貢獻（風險評估後決定）
- 自動截圖存證（提交訓練紀錄用）

## 12. 驗收條件

- 使用者登入後 bot 接手，不需再手動操作任何步驟（除非被自動 pause）
- 14 門範例課程能全部跑完：閱讀達標 + 測驗 pass + 問卷送出 + 評價送出
- Dashboard 每秒更新，能看到 bot 當下行為（含題目與答案來源）
- 暫停 → 手動操作 → 恢復，不會造成狀態錯亂
- 測驗未知題透過 Gemini 正確率 ≥ 70%（以 20 題 spot check）
- `learned_answers` 至少記錄 10 題自成長樣本

## 13. 後續步驟

1. 使用者審本文件
2. 審過後轉成 OpenSpec change（`openspec/changes/add-auto-elearn/`）
3. 進 writing-plans skill 產 implementation plan
4. 分階段實作：
   - Phase 1：骨架 + 登入接手 + heartbeat + dashboard skeleton
   - Phase 2：exam solver + answer store
   - Phase 3：survey + rating + LLM fallback
   - Phase 4：監視器打磨 + 完成驗收
