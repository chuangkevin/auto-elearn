# auto-elearn — Design Spec

- **Date:** 2026-04-23
- **Status:** Draft v2（已含站點 API 探勘結果）
- **Target platform:** `https://elearn.hrd.gov.tw` (e 等公務園+學習平臺)
- **探勘輸出:** `D:/tmp/elearn-explore/{report,probe_api,probe_enroll}.md` + `network.json`

## 1. Purpose

一個比既有 `E等閱讀家` 功能更完整、架構更乾淨的自動刷課工具。核心差異：
- 使用者自行登入（不儲存帳密，不逆向 SSO）
- **關鍵字搜尋 + 勾選 + 一鍵開跑**：不寫死分類、不硬套別人單位的要求，每人可依自己的年度訓練單挑課
- 動態抓課程清單（不寫死 course ID）
- 並行心跳（一次刷 N 門課）
- **測驗 + 問卷 + 評價 + 觀看心得**四者全自動
- 不認識的題目走 LLM fallback 而非亂猜
- 心得使用 LLM 依課程內容生成（避免千篇一律罐頭）
- 1 秒刷新的即時監視器 UI
- 使用者需要時可隨時接手內嵌瀏覽器

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
| 外殼 | **Electron 28+**（single-window Windows desktop app） |
| Runtime | Node.js 20 LTS（Electron 內建） |
| 語言 | TypeScript 5 |
| 主程序後端 | Electron main process（無 Fastify，IPC 取代 HTTP） |
| 瀏覽器自動化 | **Electron `BrowserView`**（內嵌 Chromium，透過 `webContents.executeJavaScript` / `session.cookies` / `webRequest` 攔截） |
| HTTP client | `undici` (Node 內建 fetch)（純 HTTP 呼叫 elearn API 時用） |
| DB | SQLite via `better-sqlite3`（native module，Electron 需 rebuild） |
| 渲染層 | React 18 + Vite + Tailwind |
| 狀態同步 | Electron IPC (`ipcMain` ↔ `ipcRenderer`) + `contextBridge` |
| 模糊比對 | `fast-fuzzy` |
| LLM | Gemini via `@kevinsisi/ai-core`（若 HomeProject key-pool-standard 可用）否則 `@google/generative-ai` |
| Config | YAML via `yaml`（使用者家目錄 `~/.auto-elearn/config.yaml`） |
| 建置 | `electron-vite`（dev + build 一條龍；支援 main / preload / renderer 三段） |
| 打包 | `electron-builder` → NSIS `.exe` installer（含 auto-updater 基礎，v1 先不開啟） |

UI 文字：**繁體中文**。

**為什麼 Electron（對比舊方案）：**
- 單視窗：Dashboard（React renderer）+ 內嵌 e 等公務園 `BrowserView` 上下分區
- 少一個 Playwright Chromium：`BrowserView` 就是 Chromium，`webContents` 提供類 Playwright 功能（`executeJavaScript` 相當於 `page.evaluate`，`session.cookies` / `webRequest` 提供 cookie 與攔截）
- 使用者認知降到最低：雙擊 `.exe` → 單一視窗 → 登入 → 跑
- 打包成熟：`electron-builder` 一行命令產 `.exe` installer

## 4. Monorepo 目錄

```
auto-elearn/
├─ package.json                 # Electron app root (electron-vite + electron-builder)
├─ electron.vite.config.ts
├─ electron-builder.yml
├─ src/
│  ├─ main/                     # Electron main process (Node)
│  │  ├─ index.ts               # app lifecycle, BrowserWindow + BrowserView
│  │  ├─ ipc.ts                 # ipcMain handlers (actions / state push)
│  │  ├─ state.ts               # 全域執行狀態 + EventEmitter
│  │  ├─ config.ts              # 讀 ~/.auto-elearn/config.yaml
│  │  ├─ bus.ts                 # log / state broadcast → renderer via IPC
│  │  ├─ browser/
│  │  │  ├─ view.ts             # BrowserView 建立 / 大小同步 / navigate
│  │  │  ├─ login.ts            # 偵測「個人專區」觸發接手
│  │  │  └─ pause-gate.ts       # Promise gate
│  │  ├─ http/
│  │  │  ├─ client.ts           # undici client，帶上 BrowserView session cookies
│  │  │  └─ elearn.ts           # API 包裝：getSigningCourses/getSearchCourses/checkCoursePass/enroll/heartbeat
│  │  ├─ course/
│  │  │  ├─ discovery.ts        # 掃已報名 + 全站搜尋
│  │  │  ├─ enrollment.ts       # GET /enploy/<id>
│  │  │  ├─ auto-enroll.ts      # 年度時數不足自動補報策略
│  │  │  └─ types.ts
│  │  ├─ heartbeat/
│  │  │  ├─ engine.ts           # p-limit(N) 並行
│  │  │  └─ reader.ts           # BrowserView 進閱讀器抽 pTicket/cid，之後純 HTTP
│  │  ├─ exam/
│  │  │  ├─ solver.ts           # webContents.executeJavaScript 作答
│  │  │  ├─ matcher.ts          # DB exact → fuzzy → LLM
│  │  │  └─ answer-store.ts     # better-sqlite3 讀 + 寫回
│  │  ├─ survey/
│  │  │  └─ filler.ts           # 問卷 + 評價
│  │  ├─ reflection/
│  │  │  ├─ generator.ts        # LLM 心得產生 + fallback 模板
│  │  │  └─ store.ts            # 心得 cache
│  │  ├─ llm/
│  │  │  └─ gemini.ts           # Gemini / key-pool
│  │  └─ db.ts                  # better-sqlite3 setup + migrations
│  ├─ preload/
│  │  └─ index.ts               # contextBridge 暴露 api.invoke / api.on
│  └─ renderer/                  # React (Vite)
│     ├─ index.html
│     ├─ src/
│     │  ├─ main.tsx
│     │  ├─ App.tsx              # 等登入 / 監視器 切換
│     │  ├─ components/
│     │  │  ├─ AwaitingLogin.tsx
│     │  │  ├─ Monitor.tsx
│     │  │  ├─ NowPlaying.tsx
│     │  │  ├─ CourseList.tsx
│     │  │  ├─ LogPanel.tsx
│     │  │  └─ ControlBar.tsx
│     │  ├─ hooks/
│     │  │  └─ useAppState.ts    # useSyncExternalStore + IPC
│     │  └─ index.css            # Tailwind
├─ resources/
│  └─ mixed.db                   # 搬自 E等閱讀家（98,569 題）→ electron-builder 會複製到 userData
├─ buildResources/
│  ├─ icon.ico
│  └─ icon.png
└─ docs/superpowers/specs/
   └─ 2026-04-23-auto-elearn-design.md
```

**視窗佈局：**
- 單一 `BrowserWindow` (1280×900, resizable)
- `BrowserView` 固定掛在視窗下半（e 等公務園）
- 上半是 React renderer（Dashboard）
- `BrowserView` 的 `bounds` 會跟著 renderer 宣告的分隔線調整（IPC 通知）

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

**UX：選課 → 報名 → 刷課（不是零互動全自動）**

理由：使用者的年度訓練要求按「指定關鍵字/主題 + 時數」分配（例：資安 3hr、AI 3hr、性別 2hr、環境 4hr…），**每個單位的要求不同**，不該寫死在程式裡。讓使用者自己搜尋、勾選要報名的課程最有彈性。

### 畫面 1：等待登入

```
┌─ auto-elearn v1 ────────────────────────────────────────┐
│ 👉 請在下方瀏覽器登入 e 等公務園（帳密 / 自然人憑證 / MyData） │
│ ○ 偵測中...                                               │
└──────────────────────────────────────────────────────────┘
```

### 畫面 2：登入後 — 選課 Dashboard（取代原本的 Monitor 直接開跑）

```
┌─ ✅ 莊哲瑜 ─────────────────────────────────────────────┐
│                                                          │
│ 📂 繼續上次進度 (1)                                       │
│   ▢ 實驗室通風空調系統與HEPA... [1hr] 閱讀 0:00/1:00      │
│   [續跑這些 →]                                           │
│                                                          │
│ ➕ 挑新課                                                 │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ 🔍 [輸入關鍵字                    ] [搜尋]            │ │
│ │ 篩選：身分 [任何人 ▾]  時數 [不限 ▾]  [只顯示未報名 ☑] │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                          │
│ 搜尋結果 (關鍵字: 資安)                                   │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ ☑ 115 年度資安暨個資保護基礎認知課程    3hr  任何人   │ │
│ │ ☐ 僑務委員會 115 年度上半年資通安全...   3hr  任何人   │ │
│ │ ☐ 資訊安全管理概論與實務                 3hr  任何人   │ │
│ │ ... (捲動)                                            │ │
│ └─────────────────────────────────────────────────────┘ │
│ 已選：3 門 / 9 hr  累積本年度目標：9 / 20 hr              │
│                                                          │
│ [+ 加入清單]  [🚀 開始報名並自動刷課 →]                   │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

**操作邏輯：**
- **搜尋**：關鍵字 → `POST course_ajax.php {action: getSearchCourses, keyword}`；不預先寫死分類
- **篩選**：身分限制（預設「任何人」以避報名失敗）、認證時數範圍、「已/未報名」toggle
- **勾選**：多選；同時即時顯示「已選 N 門 / X hr」讓使用者對照自己單位的要求
- **加入清單**：把勾的加到「待處理」區（像購物車），可繼續搜別的關鍵字再加
- **開始報名並自動刷課**：送出 → 進 Monitor 畫面

### 畫面 3：Monitor（報名 + 刷課執行中）

```
┌─ 🚀 執行中：12 門課 ─────────────────────────────────────┐
│  ▓▓▓▓░░░░░░░░░░░░░░  3/12 完成  25%                       │
│                                                           │
│  🎯 目前進行中                                             │
│   📖 淨零永續政策   已閱讀 18:24/1:00:00  心跳 ✅ 1s ago   │
│                                                           │
│  📋 全部                                                   │
│   ✅ 資安基礎       已完成                                  │
│   📖 淨零永續       閱讀中 (31%)                            │
│   📖 個資保護       閱讀中 (10%)                            │
│   ✏️ AI 代理         測驗 5/10                              │
│   💬 媒體識讀       問卷 3/8                                │
│   ✍️  溝通領導        觀看心得 (LLM 生成中...)              │
│   ⏳ 反洗錢          待報名                                 │
│                                                           │
│  📜 日誌                                                   │
│   [16:23] LLM 回答: 森林碳匯 (信心 0.92)                    │
│   ...                                                      │
│                                                           │
│  [⏸ 暫停]  [🛑 停止並回選課畫面]                            │
└───────────────────────────────────────────────────────────┘
```

### 主要狀態機

```
boot → await_login → selecting → enrolling → running → paused ⇄ running → done
                         ↑                                  ↓
                         └──── back_to_select ──────────────┘
```

| 狀態 | 觸發 | 畫面 |
|---|---|---|
| `boot` | app 啟動 | Loading |
| `await_login` | BrowserView 還沒偵測到「個人專區」 | 畫面 1 |
| `selecting` | 登入後預設進入 | 畫面 2（可重覆搜尋/勾選） |
| `enrolling` | 按「開始報名並自動刷課」 | 畫面 3，報名中 |
| `running` | 報名完，開始心跳/測驗等 | 畫面 3 |
| `paused` | 使用者按暫停 or 自動暫停（captcha 等） | 畫面 3 + pauseReason |
| `done` | 全部課程處理完 | 畫面 3 + 結果摘要 |
| `aborted` | 使用者按停止 | app 關閉 或 回畫面 2 |

### 完整流程（主循環不變，前置改成使用者挑）

```
【Phase 0 - 選課（使用者驅動）】
登入 → state=selecting
  - getSigningCourses 拿已報名清單（讓使用者知道什麼已經有了）
  - 使用者搜尋 keyword → getSearchCourses(categoryId="", keyword)
      → 過濾：isClassing && (studentTargetTypeCaption == '任何人' || 設定放寬)
      → 排除已報名
  - 使用者勾選 → 累積到 selected list
  - 按「開始」→ state=enrolling

【Phase 1 - 報名】
for each selected cid:
  GET /enploy/<cid>  (間隔 1s 避免 rate limit)
  回 200/302 → 成功；其他 → 失敗，log warn，繼續下一門
→ 再呼叫 getSigningCourses 確認
→ state=running

【Phase 2 - 刷課主循環（和選課邏輯獨立）】
combined = 繼續上次的已報名課程 ∪ 本次新報名
for each 課程 (排序：剩餘時數短的先):
  phase == "reading" → 並行 N 條 heartbeat
  phase == "exam"   → exam solver (DB → fuzzy → LLM)
  phase == "survey" → survey filler
  phase == "rating" → rating filler
  有文字心得 → reflection generator (LLM + fallback 模板)
  全部 done → 下一門
→ state=done
```

**移除：** 原本 Phase 0 的「自動從 10040389 專區湊目標時數」不再是預設行為。保留為「進階設定」的 opt-in（使用者可勾「如果目標時數不足，從預設專區自動補課」，預設關閉）。

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

## 14. eCPA 自動登入鏈（2026-04-24 修訂）

Silent login 透過 Electron `net.request` (`useSessionCookies: true`) 照抄瀏覽器實際打的 POST 順序，完全繞過瀏覽器 / synthesized click 問題。

| Step | URL | Body | Response |
|---|---|---|---|
| seed | `GET elearn.hrd.gov.tw/mooc/index.php` | — | PHPSESSID |
| enter | `GET ecpa.dgpa.gov.tw/uIAM/clogin.asp?destid=CrossHRD` | — | 302 → clogin.aspx（會拿到 ASP.NET_SessionId） |
| resolve | `POST ecpa.dgpa.gov.tw/Home/GetUID` | `account=<短碼>` | **純文字 body = 全 ID**（`F130918271`），不是 JSON |
| ticket | `POST ecpa.dgpa.gov.tw/Home/GetApTicketV2` | `account=<全ID>&password=...&ApID=CrossHRD` | **body 本身就是 APReqEncodedData** hex（≥100 chars）；空或 `0` = 帳密錯 |
| log | `POST ecpa.dgpa.gov.tw/Home/EnterTwoWayLog` | `account=<全ID>&loginType=0&sn=&ticket=&appId=CrossHRD` | `0` = OK |
| app2 | `POST ecpa.dgpa.gov.tw/Home/EnterApplicationTwoWay` | `appId=CrossHRD` | `0` = OK（沒有 ticket，不要在這裡找 APReqEncodedData） |
| verify | `POST elearn.hrd.gov.tw/sso_verify.php` | `loginType=0&APReqEncodedData=<hex>` | 302 → sso_home → /mooc/index.php |

**成功判定：** 檢查 `session.cookies.get({ url: elearn.hrd.gov.tw })` 是否有 `idx` + `suc`。
**Fallback 順序：** (1) POST replay（本節）→ (2) hidden-window form drive → (3) 預填主 BrowserView 給使用者手動點登入。(1) 快速 + 可靠，(2)/(3) 備援。

Headers 每個 POST 都要帶：`X-Requested-With: XMLHttpRequest`, `Referer: ecpa.dgpa.gov.tw/webform/clogin.aspx?returnUrl=...`, `Origin: ecpa.dgpa.gov.tw`。

原始探測資料：`docs/research/07-ecpa-login-full-chain.md`（redacted）。

## 15. 心跳 SPOC 子網域修正（2026-04-24）

許多課程掛在子網域（例如 `mohw.elearn.hrd.gov.tw` = 衛福部 SPOC）。原版 `ecpa.js` 在 iframe 裡用相對 fetch（`/mooc/controllers/course_record.php?actype=end`），會自動 resolve 到 iframe 的 host。

本 app 原本硬寫 `elearn.hrd.gov.tw` 當 heartbeat target — server 回 HTTP 200 但 **credit 0 時數**（該網域沒有對應的閱讀 session）。

修：
- `heartbeat/reader.ts` 同時讀 `frame.location.href`，`TicketInfo` 新增 `origin` 欄位
- `http/elearn.ts` 的 `heartbeat()` 和 `enterReadingSession()` 都改收 `origin` 當絕對 base
- engine `driveCourse()` 把 `ticket.origin` 傳進去

心跳成功的 server 回應：`{"code":1,"msg":"success","timediff":"...","data":"..."}`（`code=1` 才代表真的 crediting）。

## 16. 建置 / 發佈（2026-04-24）

- 產出：`release/win-unpacked/Noteqad.exe`（未簽章 portable folder，約 290 MB）
- NSIS `.exe` 安裝包目前卡在 electron-builder 的 winCodeSign 需要 symlink 權限（Windows 必須啟用開發人員模式或以管理員身分執行）；workaround 見 `docs/BUILD.md`
- 單實例鎖：`app.requestSingleInstanceLock` — 避免連續 rebuild/relaunch 時疊加多個 process（10 個疊起來會看到「兩條 title bar」、IPC 被舊版處理等怪狀）
- `userData` 路徑：`%APPDATA%/auto-elearn/`（`package.json` 的 `name` 勝過 electron-builder `productName`，別搞錯）

## 17. Stealth Noteqad 偽裝（S task, 2026-04-24）

- 登入 app 時，Shell 根據 `config.json` 的 `stealthSecret` 是否存在決定渲染 `<Noteqad>` 假 Notepad 還是真 `<App>`
- 解鎖：textarea 最後一行打密碼 + Enter；失敗會在狀態列顯示「密碼錯誤」；IME 組字時會跳過 Enter 避免誤觸
- 忘記密碼：檔案 → 結束 連點 5 次（15 秒內）→ 跳「重設密碼」對話框（完整路徑顯示給使用者複製）
- 再鎖：🫥 按鈕或 `Ctrl+Alt+H`；pipeline 在背景繼續跑
- OS title bar 鎖在「未命名 - 記事本」；`page-title-updated` 事件被攔下來；exe 檔名 `Noteqad.exe`
- 密碼以明碼存 `config.json`（使用者明確指定）— 威脅模型是「旁人偷看畫面」，不是檔案系統外洩
