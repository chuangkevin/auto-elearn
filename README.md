# auto-elearn

e 等公務園（elearn.hrd.gov.tw）自動刷課 Electron 桌面應用，支援多帳號、自動登入、心跳閱讀、線上測驗與問卷流程自動化。

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
| 多帳號 | 每帳號獨立 Electron partition，cookies / localStorage / pipeline 互不污染 |
| 自動登入 | eCPA SSO 靜默登入，session 過期可自動補登 |
| 心跳閱讀 | 並行心跳（最多 50 課），以 `/info/{cid}` 與 `isReadtimeValidCaption` 校正完成狀態 |
| 半途並行 | 閱讀達 50% 即可提前啟動測驗 / 問卷 chain，縮短整批 wall-clock time |
| 外部題庫預抓 | 啟動時同步抓 web bank 題庫寫入 `learned_answers`，優先命中已知題目 |
| 閱讀測驗 | 同測驗流程，從 sysbar「閱讀測驗」入口進入 |
| 線上測驗 | `history-solve` → `learned_answers` → `mixed.db` → Gemini → brute force 多層解題 |
| 問卷 | 全選 value=1，自動繳交；測驗未過不會提早送問卷 |

## 架構

```
src/main/
  account/
    manager.ts       # 多帳號 session / active tab / partition 管理
    storage.ts       # accounts/index.json + <id>.bin 儲存層
  browser/
    lc-nav.ts        # 共用 LC 導航（enterLC / sysbar / awaitWindowOpen）
    view.ts          # BrowserView 管理
  log/
    file-logger.ts   # 每日日誌 main-YYYY-MM-DD.log
  persist/
    storage-paths.ts # portable-mode 資料夾路徑
    run-state.ts     # 每帳號未完成 pipeline 狀態
  exam/
    solver.ts        # 測驗主流程（frameset → togo → exam_start.php）
    matcher.ts       # 題庫匹配 + Gemini
    answer-store.ts  # mixed.db + learned_answers 讀寫
    history-solver.ts # 從歷次成績頁反推正解
    web-bank.ts      # 外部 web bank 題庫 prefetch / bulk prefetch
  heartbeat/
    engine.ts        # 並行心跳引擎
    reader.ts        # SCORM session HTTP
  auth/
    ecpa-login.ts    # eCPA 靜默登入
  llm/gemini.ts      # Gemini API
  survey/filler.ts   # 問卷填寫
  index.ts           # Pipeline: 報名 → 心跳 → 測驗 → 問卷 → server 確認
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
- **帳密 / PIN**：每個帳號各自儲存；帳密加密在 `accounts/<id>.bin`，PIN hash 在 `accounts/index.json`

## 資料目錄

已打包 portable 版時，所有可寫資料都在 `.exe` 同層的 `auto-elearn-data/`。

常見檔案如下：

| 路徑 | 用途 | 會不會持續累積 | 可否定期清理 |
|------|------|----------------|--------------|
| `accounts/index.json` | 帳號 metadata、暱稱、PIN hash | 低 | 不建議；除非你要刪帳號 |
| `accounts/<id>.bin` | 加密帳密 | 低 | 不建議；刪了要重登 |
| `accounts/<id>.run.json` | 該帳號未完成 pipeline 狀態 | 低 | 可以；屬於 crash/中斷後的暫存狀態 |
| `auto-elearn.db` | `learned_answers`、其他本地 SQLite 表 | 中 | 不建議當成定期清理目標；會損失累積題庫 |
| `config.json` | Gemini key、stealth secret | 低 | 不建議；刪了要重新設定 |
| `logs/main-YYYY-MM-DD.log` | main / renderer 每日日誌 | 高 | 可以，最適合做定期清理 |
| `web-bank-index.json` | 外部題庫索引快取 | 中 | 可以；刪掉後下次會重抓 |
| `web-bank-bulk-done.json` | bulk prefetch 已處理 URL snapshot | 中 | 可以；刪掉後下次會重新掃 top-500 題庫頁 |
| `.first-run-acked` | SmartScreen 提示已讀旗標 | 幾乎不變 | 不需要清 |
| `.migrated-from-auto-elearn` | 舊版 userData 遷移 sentinel | 幾乎不變 | 不需要清 |
| `.portable-migrated` | portable 遷移 sentinel | 幾乎不變 | 不需要清 |

## 自動 Purge

程式現在會自動執行 purge：

1. 每次啟動 app 時先跑一次
2. 如果 app 一直沒關，則每天凌晨 `00:00` 再跑一次

目前保留策略：

- `logs/main-YYYY-MM-DD.log`：保留 14 天
- `%TEMP%/auto-elearn-*` debug dump：保留 7 天
- `D:\tmp\auto-elearn-history-*` debug dump：保留 7 天
- `accounts/*.run.json`：保留 7 天；若已經是孤兒檔（帳號早就不在 `accounts/index.json`），也會清掉

## 可定期清理的資料

適合用工作排程或手動每月清一次的項目：

1. `auto-elearn-data/logs/` 內的舊 `.log`
2. `auto-elearn-data/web-bank-index.json`
3. `auto-elearn-data/web-bank-bulk-done.json`
4. `auto-elearn-data/accounts/*.run.json`

原因：

- `logs/` 只會一直 append，不會自動刪舊檔；長久運行後最容易長大
- `web-bank-index.json` 與 `web-bank-bulk-done.json` 都是可重建快取，刪掉只會讓下次多抓一次網路資料
- `accounts/*.run.json` 只是未完成流程恢復資訊；正常跑完本來就會清掉，長期留下通常是異常中斷造成

## 不建議定期清理的資料

1. `auto-elearn-data/auto-elearn.db`
2. `auto-elearn-data/accounts/index.json`
3. `auto-elearn-data/accounts/<id>.bin`
4. `auto-elearn-data/config.json`

原因：

- `auto-elearn.db` 內的 `learned_answers` 會隨歷次測驗、web bank prefetch、history-solve 累積，是這個專案最有價值的本地知識庫
- 帳號與設定檔刪掉之後，使用者需要重新登入、重設 PIN、重新填 Gemini key

## 系統暫存檔

除了 `auto-elearn-data/`，程式還會在系統暫存目錄寫 debug dump，用於 parser / SCORM / 題庫失敗時的事後分析。常見檔名：

- `%TEMP%/auto-elearn-info-<cid>.html`
- `%TEMP%/auto-elearn-result-<cid>.html`
- `%TEMP%/auto-elearn-exam-row.html`
- `%TEMP%/auto-elearn-actid-<cid>.json`
- `%TEMP%/auto-elearn-noactid-<cid>.json`
- `%TEMP%/auto-elearn-web-bank-parse.txt`
- `%TEMP%/auto-elearn-diag-<accountId>.txt`

這些檔案都可以安全刪除；刪掉只會失去 debug 線索，不影響正式功能。

另外 `src/main/debug/history-scraper.ts` 會把人工除錯輸出寫到 `D:\tmp\auto-elearn-history-*`；若有跑過該工具，也可以一起清。

## 目前行為

- 日誌會按天切檔，並在 app 啟動 / 每天凌晨自動清掉超過 14 天的舊檔
- temp debug dump 會在 app 啟動 / 每天凌晨自動清掉超過 7 天的舊檔
- `accounts/*.run.json` 殘留檔會在 app 啟動 / 每天凌晨自動清理
- web-bank 快取目前**不會**被 purge；它是固定數量的小型快取，不是主要成長來源

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
