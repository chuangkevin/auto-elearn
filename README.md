# auto-elearn

e 等公務園（elearn.hrd.gov.tw）自動刷課 Electron 桌面應用 — 自動登入、心跳閱讀、線上測驗、問卷、學習心得，一鍵完成公務人員每年訓練時數。

## 技術棧

- **Electron** 32 + **electron-vite**（主進程 + BrowserView 控制 SCORM frame）
- **React 18** + **TailwindCSS**（前端 UI）
- **TypeScript**（嚴格模式）
- **better-sqlite3**：題庫（`resources/mixed.db`，98,569 題）+ 本地學習庫
- **Playwright**：sniff/debug 工具
- **Gemini API**（`gemini-2.5-flash`）：題庫未命中時 fallback 答題、生成學習心得
- **electron-builder**：打包 Windows portable `.exe`

## 主要功能

| 功能 | 說明 |
|------|------|
| 自動登入 | eCPA SSO 自動填表 + 點擊，session 過期自動重登 |
| 心跳閱讀 | 並行心跳（最多 8 課同時），以 `isReadtimeValidCaption` 判斷完成 |
| 線上測驗 | 題庫匹配（dice similarity ≥ 0.6）+ Gemini fallback，最多重考 10 次到 100 分 |
| 閱讀測驗 | 同測驗流程，從 sysbar「閱讀測驗」入口進入 |
| 問卷 | 全選 value=1，自動繳交 |
| 學習心得 | Gemini 生成 120-180 字繁體中文心得，無 key 用通用模板 |

## 架構

```
src/main/
  browser/
    lc-nav.ts        # 共用 LC 導航（enterLC / sysbar / awaitWindowOpen）
    view.ts          # BrowserView 管理
  exam/
    solver.ts        # 測驗主流程（frameset → togo → exam_start.php）
    matcher.ts       # 題庫匹配 + Gemini
    answer-store.ts  # mixed.db + learned_answers 讀寫
  survey/filler.ts   # 問卷填寫
  reflection/writer.ts # 學習心得
  heartbeat/
    engine.ts        # 並行心跳引擎
    reader.ts        # SCORM session HTTP
  auth/
    auto-login.ts    # 自動登入
    credentials.ts   # 帳密加密儲存
  llm/gemini.ts      # Gemini API
  index.ts           # Pipeline: 報名 → 心跳 → 測驗 → 問卷 → 心得
```

### 測驗入口（SCORM LC 路徑）

```
/info/{cid}
  → button.btnAction（上課去）
  → LC frameset (center.elearn.hrd.gov.tw/mooc/index.php)
      mooc_sysbar frame → 點「測驗」/「閱讀測驗」
      s_main frame → [onclick*="togo("] → ID
        → exam_start.php?{id}+0
            → examBegin()
            → tr.bg03/tr.bg04 題目
            → 題庫 / Gemini 答題
            → 送出 → 檢查總分=100，否則重進 LC 重考
```

## 開發

```bash
npm install
npm run dev          # 開發模式
npm run build        # 生產 build
npm run build:win    # 打包 Windows portable .exe
```

## 設定

- **Gemini API Key**：App 選單 → 說明 → 設定 Gemini API Key
- **帳密**：首次啟動輸入，或在 eCPA 登入頁面登入後自動儲存（加密在 AppData）

## Release

標籤格式：`v{版本號}`，GitHub Actions 自動 build → zip → 發佈 Release。

```bash
# 在 package.json bump version 後
git tag v0.x.y
git push --tags
```

Release zip 內只有一個 portable `.exe`，使用者解壓雙擊即用。

## 部署 / 下載

- Repo：<https://github.com/chuangkevin/auto-elearn>
- Release：透過 GitHub Releases 取得 portable `.exe`
- 目標平台：Windows x64（其他平台未支援）
