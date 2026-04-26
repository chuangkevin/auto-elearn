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

### 答題流程（三層優先順序）
1. `learned_answers` 本地學習庫（最高優先）
2. `resources/mixed.db` 題庫（98,569 題，dice similarity >= 0.6 命中）
3. Gemini LLM fallback（`gemini-2.5-flash`，key 從 AppData/.../config.json）

### 測驗重考
- 目標分數：100 分
- 最多重試次數：`MAX_EXAM_ATTEMPTS = 10`（`solver.ts`）
- 每次重試都重新進入 LC（re-enter）

### 問卷入口
- sysbar「問卷」→ s_main 找 `.process-btn.pay.active` 點擊 → 攔截 window.open → 填 radio value='1' → 送出

### 心得入口
- sysbar「心得」→ s_main 直接有 `textarea`（無 popup）→ Gemini 生成 120-180 字 → 送出

## Release 流程

1. 確認所有功能正常
2. 更新 `package.json` 版本號
3. commit + push
4. 打 tag：`git tag v{版本號}`
5. push tag：`git push --tags`
6. GitHub Actions 自動 build → zip → 發布到 Release
7. 確認 Release 頁面有 zip 檔

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
