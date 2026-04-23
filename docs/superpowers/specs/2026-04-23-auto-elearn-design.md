# auto-elearn — Design Spec

- **Date:** 2026-04-23
- **Status:** Draft v2（已含站點 API 探勘結果）
- **Target platform:** `https://elearn.hrd.gov.tw` (e 等公務園+學習平臺)
- **探勘輸出:** `D:/tmp/elearn-explore/{report,probe_api,probe_enroll}.md` + `network.json`

## 1. Purpose

一個比既有 `E等閱讀家` 功能更完整、架構更乾淨的自動刷課工具。核心差異：
- 使用者自行登入（不儲存帳密，不逆向 SSO）
- 動態抓課程清單（不寫死 ID）
- 並行心跳（一次刷 N 門課）
- **測驗 + 問卷 + 評價 + 觀看心得**四者全自動
- 不認識的題目走 LLM fallback 而非亂猜
- 心得使用 LLM 依課程內容生成（避免千篇一律罐頭）
- 1 秒刷新的即時監視器 UI
- 使用者需要時可隨時接手 Playwright 瀏覽器
- **智障模式（預設）**：登入後零互動，一路跑到全完成

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

**純 HTTP，不經 DOM**。呼叫站上原生 AJAX endpoint，拿到的 JSON 直接告訴你每門課的狀態：

```
POST /mooc/controllers/course_ajax.php
Headers:
  X-Requested-With: XMLHttpRequest
  Referer: /mooc/user/learn_dashboard.php?tab=1   # 或 /mooc/explorer.php (搜尋時)
Cookie: <session>
Body (form-urlencoded):
  action=getSigningCourses         # 已報名 / 我的課程
  action=getSearchCourses          # 全站搜尋（需先 prime explorer.php）
  action=checkCoursePass           # 單課通過狀態
  id=new
  perpage=50
  categoryId=<分類ID>               # getSearchCourses 專用
  keyword=<關鍵字>
  is_readtime_valid=attending|completed|
  sort_by=registration_time
```

**Response schema**（JSON list of dict，每個 dict key 是 `'<sid><cid>'`、value 是課程物件）：
```json
[
  {
    "'1000110046987'": {
      "cid": 10046987,
      "caption": "AI工具應用教學-AI代理",
      "certification_hours": 1,
      "category_full_path": "政策能力訓練 > 政策宣導訓練 > 人工智慧 > 人工智慧基礎認知",
      "fromSchoolName": "航港e學院",
      "studentTargetTypeCaption": "任何人",
      "classPeriod": "2026-04-01~2026-12-31",
      "isClassing": true,
      "isReadtimeValidCaption": "未報名",
      "isReadDones": 1,
      "isExamDones": 0,
      "isSurveyDones": 0,
      "exam_exists": "0",
      "passPercent": 33,
      "platform": "pc,mobile"
    },
    ...
  }
]
```

**關鍵欄位語義：**
- `isReadtimeValidCaption`: `"未報名" | "尚未通過" | "已通過" | ...`
- `isReadDones` / `isExamDones` / `isSurveyDones`: `0 | 1`
- `exam_exists`: `"0" | "1"` — 是否有測驗
- `passPercent`: 完成率（三條件：閱讀/測驗/問卷）

**做法：**
1. `discovery.mine()` — POST `getSigningCourses`，取得使用者已報名的全部課程（含 heartbeat/exam/survey 三階段狀態）
2. `discovery.browse(categoryId, keyword?)` — 先 `POST /mooc/explorer.php` 帶 `rootGroupId + course_category + csrfToken` prime session，再 POST `getSearchCourses` 拿分類內課程
3. `discovery.cheat(...)` — 綜合過濾：依身分 (`任何人` / `限制機關`)、最低認證時數、關鍵字等挑出候選

### 6.4 Enrollment (`course/enrollment.ts`)

**純 HTTP，`GET /enploy/<cid>`**。已證實這招繞過 client-side 身分檢查。回 200 / 302 視為成功。

**已挖到的分類 ID 清單**：

| categoryId | 專區 |
|---|---|
| 10040389 | 公務人員 10 小時課程專區 |
| 10036100 | 人工智慧 |
| 10027913 | 外購課程 |
| 10007170 | 科技素養 MRT |
| 10027389 | 淨零永續 |
| 10027390 | 資訊安全 |
| 10014384 | 新冠肺炎 |
| 10011548 | 媒體識讀 |
| 10007169 | 家庭教育 |
| 10023342 | 全齡樂學 |

**Dashboard「加入課程」UX：**
- **A. 主題瀏覽**：列出 10 個分類，點任一 → 即時 AJAX 拿清單 → 多選 → 報名
- **B. 關鍵字搜尋**：輸入「資安」「個資」等 → AJAX 回結果 → 多選 → 報名
- **C. 時數自動配：** 給剩餘目標時數（例如：還差 8 hr）→ bot 從 `任何人` + `isClassing=true` 的清單中組出總和 ≈ 目標 → 一鍵全報
- **D. 貼 URL**：`/info/<cid>` 貼上即解析 cid

每次報名送出後延遲 1 秒（原版行為），避免 rate limit。

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

### 6.8 Survey / Rating / Reflection Filler (`survey/filler.ts` + `reflection/generator.ts`)

從「評量區」側邊欄進入（`問卷/評價`、`測驗/考試` 兩大入口）：

- **問卷**：每題預設最高分選項（Likert 1-5 取 5）；若有文字框走 reflection generator
- **評價**：5 星 + `rating.comment`（config 可覆寫）
- **觀看心得 / 感想 / 收穫**：`<textarea>` 或 `<input>` 且提示含「心得」「感想」「收穫」字樣 → 呼叫 **reflection generator**

**Reflection Generator (`reflection/generator.ts`)：**
- 輸入：`{ caption, content, certification_hours, category_full_path }`（來自 course_ajax.php 的課程物件）
- 走 LLM（Gemini）：
  ```
  你是公務員撰寫線上課程心得。
  課程：{caption}
  簡介：{content[:300]}
  分類：{category_full_path}
  請以第一人稱寫 80-150 字心得，
  1) 點出課程 1-2 個實際重點
  2) 說明如何應用於業務
  3) 語氣誠懇，不寫「非常有收穫」「感謝授課」這類套話
  回純文字，不加標題或編號。
  ```
- Cache：`learned_answers` 擴充一張 `reflections(cid, text, generated_at)`，同一門課兩次都貼同一篇；避免重複燒 token 也避免 server-side 偵測
- LLM 失敗時：退回 `config.reflection.fallback_templates` 隨機一篇，填入 `{caption}` 變數

- 可在 `config.yaml` 針對單一 `course_id` 覆寫問卷/評價/心得
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
    status: 'boot' | 'await_login' | 'running' | 'paused' | 'done' | 'aborted';
    pauseReason?: string;
    user?: { name: string };
    now: {
      courseId?: string;
      courseName?: string;
      action: 'enroll'|'heartbeat'|'exam'|'survey'|'rating'|'reflection'|'idle';
      detail?: string;    // 第 X/Y 題、已閱讀 MM:SS、etc
      currentQuestion?: { text: string; answer: string; source: 'db'|'fuzzy'|'llm'|'random' };
    };
    courses: Array<{ id, name, phase, readSec, requiredSec, lastPing?, examDone, surveyDone, ratingDone, reflectionDone }>;
    logs: Array<{ ts: number; level: 'info'|'warn'|'error'; msg: string }>;
    stats: { done: number; total: number; quizzes: number; llmCalls: number; progressPct: number };
  }
  ```
- `POST /api/action/pause` / `resume` / `abort` / `focus-browser`
- `POST /api/config/update`（進階頁用，智障模式不會動到）

**前端 — 智障模式 = 預設畫面（無按鈕）：**

```
┌─ auto-elearn v1 ────────────────────────────────────────┐
│ 階段 1：等待登入                                           │
│   👉 請在下方的瀏覽器登入 e 等公務園                       │
│   ○ 偵測中...                                             │
│                                                          │
│ （登入後這個畫面自動消失，換成 Monitor）                   │
└──────────────────────────────────────────────────────────┘

↓ 偵測到登入後自動切換 ↓

┌─ ✅ 莊哲瑜，開始自動刷課 ────────────────────────────────┐
│                                                          │
│  ▓▓▓▓▓▓▓░░░░░░░░░░░  14/33 完成  42%                     │
│                                                          │
│  🎯 目前進行中                                            │
│  ┌──────────────────────────────────────────────────┐   │
│  │ 📖 淨零永續政策與業務整合                          │   │
│  │    已閱讀 18:24 / 1:00:00                          │   │
│  │    [●●●○○○○○○○] 30%                               │   │
│  │    心跳：✅ 1s ago （並行 8 條中的 #3）             │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  📋 所有課程                                              │
│  ✅ 資安基礎        1:00:00 / 1:00:00                    │
│  📖 淨零永續        0:18:24 / 1:00:00  心跳中 #3         │
│  📖 個資保護        0:06:12 / 1:00:00  心跳中 #5         │
│  ✏️  AI 代理          測驗中 5/10                          │
│  💬 媒體識讀        問卷 3/8                              │
│  ✍️  溝通領導         觀看心得 (LLM 生成中...)             │
│  ⭐ 性別主流化      評分中                                │
│  ⏳ 反洗錢          待報名                                │
│  ...                                                      │
│                                                          │
│  📜 日誌                                                  │
│  [16:23] LLM fallback: Q=「...」 A=「森林碳匯」          │
│  [16:23] 測驗通過：AI 代理 (85 分)                       │
│  ...                                                      │
│                                                          │
│  ⚙️ 進階設定  |  🛑 停止                                  │
└──────────────────────────────────────────────────────────┘
```

- 預設 `http://localhost:8787`，啟動自動開瀏覽器
- 連線斷開顯示 `Disconnected，嘗試重連…`
- **沒有 Start 按鈕** — 偵測到登入就跑；沒有選課對話框 — 自動掃使用者已報名的全部課程
- **只有一個「停止」按鈕**（智障模式）；進階頁可開暫停/恢復/帶瀏覽器到前景/單課操作等

**智障決策樹（全自動）：**
```
【Phase 0 - 啟動時補報】
呼叫 getSigningCourses 拿已報名清單
    ↓
計算「可完成總時數」= Σ certification_hours (for isClassing=true AND 未過期)
    ↓
if target.annual_hours > 可完成時數:
    差額 = target - sum
    for each categoryId in config.target.auto_enroll_categories (預設 [10040389]):
        POST course_ajax.php {action: getSearchCourses, categoryId}
          → 濾：studentTargetTypeCaption='任何人' AND isClassing=true AND 未報名
          → sort by certification_hours asc (優先報短的)
          → 依序 GET /enploy/<cid> 直到時數 ≥ 差額 或達 max_auto_enroll_per_run
          → 每次間隔 1s
    重新呼叫 getSigningCourses

【Phase 1 - 主循環】
for each 課程 (排序：剩餘時數短的先做，快速看到成就感):
    phase == enrolled && !isReadDones → 加入心跳佇列（並行 8）
    isReadDones && !isExamDones && exam_exists → exam solver
    isExamDones && !isSurveyDones → survey filler（含 reflection）
    isSurveyDones && !ratingDone → rating filler
    全部 done → 下一門

【Phase 2 - 全部完成後再補一輪】
若執行完所有課程後，仍不足 target.annual_hours:
    重跑 Phase 0 補報 → 回到 Phase 1
(避免無限迴圈：單次執行最多補報 max_auto_enroll_per_run × 3 輪)
```

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

reflection:
  enabled: true
  min_chars: 80
  max_chars: 150
  llm_prompt_template: |
    你是公務員撰寫線上課程心得。
    課程：{caption}
    簡介：{content}
    分類：{category_full_path}
    請以第一人稱寫 {min_chars}-{max_chars} 字心得，指出 1-2 個具體重點與業務應用，語氣誠懇，不寫罐頭話。
    回純文字，不加標題或編號。
  fallback_templates:
    - "本課程介紹{caption}的核心概念，讓我對相關議題有更完整的理解；未來在業務上遇到相關情境時，會依照課程提到的原則思考並處理。"
    - "透過{caption}的內容，我瞭解了相關政策背景與實務作法；在日常工作中將據此檢視流程，並與同仁分享，避免資訊落差。"

target:
  annual_hours: 20         # 年度目標時數；不足時自動補報
  auto_enroll_categories:  # 自動補報挑課的分類（順序即優先序）
    - 10040389             # 公務人員 10 小時課程專區（預設主力）
    # - 10027390           # 資訊安全（如想特定議題可加）
    # - 10027389           # 淨零永續
  auto_enroll_filter:
    student_target: "任何人"    # 優先挑不限身分的課
    require_isClassing: true
    sort_by: "certification_hours_asc"   # 短時數優先
  max_auto_enroll_per_run: 10      # 單次執行最多自動補幾門
  rounds: 3                        # Phase 2 補報迴圈最多 N 輪

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
