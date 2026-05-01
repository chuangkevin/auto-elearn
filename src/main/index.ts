import { app, BrowserWindow, BrowserView, ipcMain, shell, Menu, Tray, nativeImage, screen, type Session } from "electron";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";

import {
  IPC,
  type AccountMismatchPayload,
  type AppState,
  type AutoLoginProgress,
  type CourseCandidate,
  type CourseCard,
  type CredentialsStatus,
  type CredsPromptPayload,
  type ResumePrompt,
  type SearchOptions,
  type SwitchAccountPayload,
  type SwitchAccountResult,
  type ViewBounds,
} from "../shared/ipc";
import { createBus } from "./bus";
import { attachElearnView, autoLoginInView, detectLogin, dismissNuisancePopups } from "./browser/view";
import { loadConfig, saveConfig, setGeminiLogger } from "./llm/gemini";
import { discover } from "./course/discovery";
import { enrollMany } from "./course/enrollment";
import { unenrollCourse } from "./course/unenroll";
import type { Tracked } from "./course/types";
import {
  ElearnAuthError,
  getCategoryChildren,
  getSigningCourses,
  primeExplorer,
  searchCourses,
  type Course,
  type SearchFilters,
} from "./http/elearn";
import { fetchCourseDetail } from "./http/course-detail";
import { runHeartbeatBatch, type PollData } from "./heartbeat/engine";
import {
  clearCredentials,
  hasSavedCredentials,
  loadCredentials,
  saveCredentials,
  touchCredentials,
  type SavedCredentials,
} from "./auth/credentials";
import { groupByCategory, resolveAgencyCodes } from "./course/agency-code-map";
import { attachLoginSniffer, type SniffedCredentials } from "./auth/login-sniffer";
import { isSessionAlive } from "./auth/session-watchdog";
import { clearRun, loadRun, saveRun, type PersistedRun } from "./persist/run-state";
import { solveExam } from "./exam/solver";
import { fillSurvey } from "./survey/filler";
import {
  currentState as stealthCurrentState,
  lock as stealthLock,
  setSecret as stealthSetSecret,
  tryUnlock as stealthTryUnlock,
} from "./stealth/stealth";
import { maskAccount, maskName, maskSecretsInString } from "../shared/mask";
import { existsSync, mkdirSync, writeFileSync as fsWriteFileSync } from "node:fs";
import { appendLogLine, getLogsDir, installCrashHandlers, rebindLogsDirToUserData } from "./log/file-logger";
import { migrateFromOldUserDataIfNeeded } from "./persist/migrate-userdata";

// 必須在 app.whenReady 之前 install — 模組載入階段就可能因為 native 模組
// （better-sqlite3 / bindings 等）打不開或被防毒砍掉而炸 "Cannot find module"，
// 沒早 install 的話那種噴在 dialog 上的 error 不會留下任何 log，使用者只能截圖。
// file-logger 在 app 還沒 ready 時會把 log 寫到 OS 暫存目錄；ready 之後再切到
// userData/logs/。
installCrashHandlers((s) => {
  // 早期 install 時 _logSecrets 還沒填，maskLog 等於 identity；之後會逐步累積。
  try {
    return maskLog(s);
  } catch {
    return s;
  }
});

/**
 * In-memory cache of sensitive strings (real account / real user name)
 * that must never leak into UI or log payloads. Populated as the app learns
 * them and used by `pushSecretToMaskList` + `maskLog`.
 */
const _logSecrets: Array<{ value: string; masked: string }> = [];
function pushSecretToMaskList(value: string | undefined | null, masked: string) {
  if (!value || value.length < 2) return;
  if (_logSecrets.some((s) => s.value === value)) return;
  _logSecrets.push({ value, masked });
}
function maskLog(msg: string): string {
  return maskSecretsInString(msg, _logSecrets);
}

/**
 * 首次執行旗標 — 寫在 userData 下的 .first-run-acked。
 * 沒這個檔 = 第一次跑，UI 會在啟動時跳出「Windows 首次封鎖怎麼處理」說明。
 */
function firstRunFlagPath(): string {
  return join(app.getPath("userData"), ".first-run-acked");
}
function isFirstRun(): boolean {
  try {
    return !existsSync(firstRunFlagPath());
  } catch {
    return false;
  }
}
function ackFirstRun(): void {
  try {
    const dir = app.getPath("userData");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    fsWriteFileSync(firstRunFlagPath(), new Date().toISOString(), "utf8");
  } catch {
    /* 寫不進去就算了，至少不會 crash */
  }
}

// Hard cap purely to avoid spawning hundreds of hidden BrowserWindows during
// the ticket-extraction phase (each extractTicket() opens its own window for
// ~40 s, then closes). Effective parallelism = min(this, # selected courses).
// Pure HTTP heartbeats afterwards are cheap; the constraint is the temporary
// window count during extraction. With actid now properly extracted (each
// heartbeat carries enCid + actid), server credits per-course independently
// — there's no server-side concurrency conflict to worry about.
const HEARTBEAT_PARALLEL_MAX = 50;
const HEARTBEAT_INTERVAL_MS = 300_000;
const HEARTBEAT_JITTER_MS = 1000;
const ENROLL_DELAY_MS = 1000;

/** Known category IDs from site exploration — used for keyword search fan-out. */
const KNOWN_CATEGORIES = [
  "10040389", // 公務人員 10 小時課程專區
  "10036100", // 人工智慧
  "10027390", // 資訊安全
  "10027389", // 淨零永續
  "10027913", // 外購課程
  "10007170", // 科技素養 MRT
  "10011548", // 媒體識讀
  "10007169", // 家庭教育
  "10014384", // 新冠肺炎
  "10023342", // 全齡樂學
];

const abortSignal = { aborted: false };

const HOMEPAGE = "https://elearn.hrd.gov.tw/mooc/index.php";

let mainWindow: BrowserWindow | null = null;
let elearnView: BrowserView | null = null;
let tray: Tray | null = null;
// Set true once we *really* want the process to exit (tray "結束" / ACTION_ABORT
// / second-instance shutdown). The window close handler reads this to decide
// whether to hide-to-tray or let the close proceed.
let isQuittingForReal = false;
const bus = createBus();

// Credentials sniffed during the current login; held in-memory until the user answers
// the "save?" prompt so we never touch disk without consent.
let pendingSniffed: SniffedCredentials | null = null;
let autoLoginInFlight = false;

// Visual cue: during heartbeat we navigate the BrowserView to one of the in-flight
// courses so the user sees something changing. `focusedCid` is the course the view is
// currently showing; `runningCids` tracks every still-ticking course so we can pick a
// replacement when `focusedCid` finishes.
let focusedCid: string | null = null;
const runningCids = new Set<string>();

// Session-expiry watchdog (E.a) — non-null only while a pipeline is running.
let watchdogTimer: NodeJS.Timeout | null = null;
/** Count of consecutive failed reachability checks so we can also flag offline (E.c). */
let consecutiveDeadChecks = 0;

// BrowserView login watchdog — polls DOM every 30 s regardless of pipeline state.
let loginWatchdogTimer: NodeJS.Timeout | null = null;
let reloginInFlight = false;
/** Consecutive misses before we declare logged-out (avoids false alarm mid-navigation). */
let loginMissCount = 0;

function persistRun(status: PersistedRun["status"]) {
  if (!state.pipelineCids || state.pipelineCids.length === 0) return;
  const existing = loadRun();
  saveRun({
    pipelineCids: state.pipelineCids,
    startedAt: existing?.startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status,
  });
}

function navigateViewToCourse(cid: string) {
  if (!elearnView) return;
  const url = `https://elearn.hrd.gov.tw/info/${cid}`;
  elearnView.webContents.loadURL(url).catch(() => void 0);
}

function focusNextCourse() {
  const next = runningCids.values().next().value;
  if (next) {
    focusedCid = next;
    navigateViewToCourse(next);
  } else {
    focusedCid = null;
  }
}

function emitAutoLogin(progress: AutoLoginProgress) {
  mainWindow?.webContents.send(IPC.AUTOLOGIN_PROGRESS, progress);
}

// ── Central state ──────────────────────────────────────────────
const state: AppState = {
  status: "boot",
  now: { action: "idle" },
  courses: [],
  logs: [],
  stats: { done: 0, total: 0, quizzes: 0, llmCalls: 0, progressPct: 0 },
};

function pushState() {
  mainWindow?.webContents.send(IPC.STATE_PUSH, state);
}

function log(level: "info" | "warn" | "error", msg: string) {
  // 在 push 進 state 之前先把帳號 / 使用者名稱字串隱碼，
  // 不然敏感資訊會經由 log 日誌流出去（即使 UI 上有遮，從日誌也看得到）。
  const safe = maskLog(msg);
  state.logs.push({ ts: Date.now(), level, msg: safe });
  if (state.logs.length > 200) state.logs.splice(0, state.logs.length - 200);
  pushState();
  // 開發者主控台不必隱碼，方便 debug；正式打包後也不會被使用者看到。
  // eslint-disable-next-line no-console
  console.log(`[${level}] ${msg}`);
  // 同步把隱碼版寫到 userData/logs/main-YYYY-MM-DD.log，使用者要回報問題時
  // 可以從偽裝記事本右鍵的「版本」項打開資料夾把檔案傳給開發者。
  appendLogLine(level, safe);
}

// Pipe Gemini failures to the visible UI log so the user actually sees WHY
// the LLM fallback didn't help (bad key, quota exceeded, network, etc).
setGeminiLogger((msg) => log("warn", `[gemini] ${msg}`));

// ── Server-progress poll cache (shared across parallel driveCourse calls) ──
let _pollCache: { ts: number; map: Map<string, PollData> } | null = null;

async function fetchProgressCached(session: Session): Promise<Map<string, PollData>> {
  const now = Date.now();
  if (_pollCache && now - _pollCache.ts < 5_000) return _pollCache.map;
  const courses = await getSigningCourses(session);
  const map = new Map<string, PollData>(
    courses.map((c) => [
      c.cid,
      {
        isReadDones: c.isReadDones ?? 0,
        isExamDones: c.isExamDones ?? 0,
        isSurveyDones: c.isSurveyDones ?? 0,
        isReadtimeValidCaption: c.isReadtimeValidCaption,
        passPercent: c.passPercent,
      },
    ]),
  );
  _pollCache = { ts: now, map };
  return map;
}

// Gemini key dialog 從 v0.6.7 起改成 renderer 內的 React modal
// （src/renderer/src/App.tsx GeminiKeyModal）。原本 child BrowserWindow + modal
// 在多螢幕環境會跑到別的 monitor（v0.6.6 災情：Windows BrowserWindow modal
// 子視窗的初始 position 在某些 DPI / 多螢幕組合下會被 OS 放到錯的 display），
// 改成 renderer modal 後永遠跟主視窗同個 viewport。OS 選單的 click handler
// 改成發 IPC.GEMINI_DIALOG_REQUEST 讓 renderer 自己 setShowGeminiKey(true)。
function requestRendererGeminiDialog(): void {
  mainWindow?.webContents.send(IPC.GEMINI_DIALOG_REQUEST);
}

// Tray icon presents the app as "記事本" so a casual onlooker sees a Notepad
// system-tray entry, matching the disguise. Double-click restores the window;
// right-click → 結束 is the only path that actually exits the process.
function setupTray(iconPath: string): void {
  if (tray) return;
  const image = nativeImage.createFromPath(iconPath);
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip("記事本");

  const showWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  };

  const menu = Menu.buildFromTemplate([
    { label: "開啟", click: showWindow },
    { type: "separator" },
    {
      label: "結束",
      click: () => {
        isQuittingForReal = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("double-click", showWindow);
}

function buildAppMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: "說明(&H)",
      submenu: [
        {
          label: "設定 Gemini API Key(&G)…",
          click: () => requestRendererGeminiDialog(),
        },
      ],
    },
  ]);
  mainWindow?.setMenu(menu);
}

// ── Window + BrowserView ──────────────────────────────────────
function createWindow() {
  // v0.6.0 regression: previously resources/* was duplicated into <resourcesPath>/resources/
  // via package.json's `build.extraResources`. Moving the build config to
  // electron-builder.yml dropped that block, so in packaged builds
  // <resourcesPath>/resources/icon.ico no longer exists — only
  // <appPath>/resources/icon.ico (inside app.asar) does.
  // Passing a non-existent icon path through to BrowserWindow on Windows
  // can crash the renderer process on launch ("閃退") on systems whose
  // shell32 image-loading path doesn't tolerate a missing .ico gracefully,
  // which is why v0.6.0 booted fine on dev machines but flash-crashed for
  // some packaged-build users. Resolve via app.getAppPath() — asar
  // transparency reads the icon from inside app.asar.
  const iconPath = join(app.getAppPath(), "resources/icon.ico");

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    icon: iconPath,
    // Disguise: OS title bar always shows the Notepad title, regardless of whether
    // the app is locked or unlocked. Matches the stealth-mode intent.
    title: "未命名 - 記事本",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Electron keeps refreshing title from the rendered document; lock it down.
  // 整個 app 的視窗標題永遠是「未命名 - 記事本」；不論是不是偽裝模式都不會洩漏真實程式名稱。
  mainWindow.on("page-title-updated", (e) => {
    e.preventDefault();
    if (mainWindow && mainWindow.getTitle() !== "未命名 - 記事本") {
      mainWindow.setTitle("未命名 - 記事本");
    }
  });

  // Keep at least 100px of the title bar inside the display's work area so the
  // user can always grab the window back. Works across multi-monitor setups.
  mainWindow.on("move", () => {
    if (!mainWindow) return;
    const bounds = mainWindow.getBounds();
    const wa = screen.getDisplayMatching(bounds).workArea;
    const MARGIN = 100;
    const x = Math.max(wa.x - bounds.width + MARGIN, Math.min(bounds.x, wa.x + wa.width - MARGIN));
    const y = Math.max(wa.y, Math.min(bounds.y, wa.y + wa.height - MARGIN));
    if (x !== bounds.x || y !== bounds.y) mainWindow.setPosition(x, y);
  });

  mainWindow.on("ready-to-show", () => mainWindow?.show());

  // Hide-to-tray on user-initiated close. Only let the close proceed when the
  // app is genuinely shutting down (tray "結束" / ACTION_ABORT / before-quit
  // already fired). Without this, the X button kills the heartbeat pipeline
  // mid-run and the user has to relaunch + re-login.
  mainWindow.on("close", (e) => {
    if (isQuittingForReal) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    e.preventDefault();
    mainWindow.hide();
  });

  setupTray(iconPath);
  buildAppMenu();
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  elearnView = attachElearnView(mainWindow, HOMEPAGE);
  // Initial bounds = 0x0. The renderer owns layout; it pushes real bounds from the
  // `#browserview-mount` div as soon as it mounts. If renderer ever fails to push,
  // we stay at 0x0 which means all clicks fall through to the dashboard — much
  // better than a full-window invisible BrowserView eating left-panel clicks.
  elearnView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  // Do NOT autoResize — we'd rather hand authoritative bounds from the renderer
  // on every window resize event than have Electron grow the view out of sync.
  elearnView.setAutoResize({ width: false, height: false });

  // Sniff login POST so we can offer "remember me" after manual login succeeds
  // AND detect when a different account is logging in (account-switch flow).
  attachLoginSniffer(elearnView.webContents.session, (creds) => {
    pendingSniffed = creds;
    const saved = loadCredentials();
    if (saved && saved.account !== creds.account) {
      // Different account just submitted the login form — surface a toast so
      // the user can decide whether to switch (clears old creds + state) or
      // keep the saved account (in which case the BrowserView is currently
      // out of sync with state.user, but we don't auto-overwrite anything).
      const payload: AccountMismatchPayload = {
        savedMasked: maskAccount(saved.account),
        newMasked: maskAccount(creds.account),
      };
      mainWindow?.webContents.send(IPC.CREDS_ACCOUNT_MISMATCH, payload);
      log(
        "warn",
        `偵測到不同帳號登入：原儲存 ${payload.savedMasked} → 新登入 ${payload.newMasked}`,
      );
    } else if (state.user && saved && saved.account === creds.account) {
      // Same account re-logging in (session expired, manual re-login). No-op.
    } else {
      log("info", "已偵測到 eCPA 登入表單，待登入成功後會詢問是否儲存帳密");
    }
  });

  if (hasSavedCredentials()) {
    // 預先把帳號加進隱碼名單；之後若 log 不慎打到原始帳號也會自動換成隱碼版。
    const c = loadCredentials();
    if (c?.account) pushSecretToMaskList(c.account, maskAccount(c.account));
    state.status = "await_login";
    log("info", "已記得你的帳號，背景幫你登入中…");
    void tryAutoLogin().catch(() => void 0);
  } else {
    state.status = "setup";
    log("info", "第一次使用：請輸入人事服務網（e 等公務園）的帳號密碼");
  }
  state.isFirstRun = isFirstRun();
  pushState();

  attachDetectLoginOnce();
}

/**
 * Single-flight detectLogin runner. Re-entrant calls while one is already
 * pending are no-ops. After a successful detection it transitions
 * `state.status` to `selecting`, runs the post-login bookkeeping (refresh
 * courses, prompt save-creds / resume-run) and clears its own guard so a
 * later account switch can run it again from scratch.
 */
let detectLoginInFlight = false;
function attachDetectLoginOnce(): void {
  if (detectLoginInFlight) return;
  if (!elearnView) return;
  detectLoginInFlight = true;
  detectLogin(elearnView.webContents)
    .then(async (user) => {
      // 真名只出現在 main process 的記憶體裡，UI 拿到的永遠是隱碼版。
      pushSecretToMaskList(user, maskName(user));
      state.user = { name: maskName(user) };
      state.loginStatus = "ok";
      log("info", `已成功登入`);
      startLoginWatchdog();
      if (elearnView) await dismissNuisancePopups(elearnView.webContents);
      await refreshCourses();

      // Optional one-shot debug scraper (LC frame walker, slower).
      const scrapeCid = process.env.AUTO_ELEARN_SCRAPE_CID;
      if (scrapeCid && elearnView) {
        log("info", `🔬 偵測歷次紀錄 (cid=${scrapeCid})；不會送出任何測驗`);
        const { scrapeHistory } = await import("./debug/history-scraper");
        scrapeHistory(elearnView.webContents.session, scrapeCid, (m) => log("info", m))
          .then(() => log("info", "🔬 偵測完畢"))
          .catch((e) => log("warn", `🔬 失敗: ${e?.message ?? e}`));
      }

      // Recover correct-answer keys from past view_result.php pages without
      // submitting any new attempts. Trigger via env var:
      //   $env:AUTO_ELEARN_SOLVE_HISTORY_CID="10046346"  → single course
      //   $env:AUTO_ELEARN_SOLVE_HISTORY_CID="ALL"       → every course with
      //     past attempts (filter: state.courses where caption == "尚未通過"
      //     OR phase ∉ {pending, done}). Sequential to avoid /mooc/warning.php.
      const solveCid = process.env.AUTO_ELEARN_SOLVE_HISTORY_CID;
      if (solveCid && elearnView) {
        const { solveExamFromHistory } = await import("./exam/history-solver");
        const session = elearnView.webContents.session;
        const runFor = async (targetCid: string, idx: number, total: number): Promise<void> => {
          log("info", `🧮 [${idx}/${total}] 從歷次紀錄反推正解 (cid=${targetCid})`);
          try {
            const r = await solveExamFromHistory(session, targetCid, (m) => log("info", m));
            if (r.ok) log("info", `🧮 [${idx}/${total}] 完成：寫入 ${r.learned} 題`);
            else log("warn", `🧮 [${idx}/${total}] 失敗：${r.reason ?? "unknown"}`);
          } catch (e) {
            log("warn", `🧮 [${idx}/${total}] 例外：${(e as Error)?.message ?? e}`);
          }
        };
        if (solveCid.toUpperCase() === "ALL") {
          // Skip pending (not enrolled) and done (already passed) — neither
          // has past-attempt data worth solving from. Anything in
          // {enrolled, reading, exam, survey, verifying} is fair game.
          const targets = state.courses
            .filter((c) => c.phase !== "pending" && c.phase !== "done")
            .map((c) => c.cid);
          log("info", `🧮 ALL 模式：將處理 ${targets.length} 門課`);
          (async () => {
            let i = 0;
            for (const tcid of targets) {
              i++;
              await runFor(tcid, i, targets.length);
            }
            log("info", `🧮 ALL 全部完成`);
          })();
        } else {
          runFor(solveCid, 1, 1);
        }
      }

      // If we sniffed creds during this login session AND they aren't yet saved,
      // ask the user whether to remember them.
      if (pendingSniffed && !hasSavedCredentials()) {
        const payload: CredsPromptPayload = { maskedAccount: maskAccount(pendingSniffed.account) };
        mainWindow?.webContents.send(IPC.CREDS_PROMPT_SAVE, payload);
      } else if (pendingSniffed && hasSavedCredentials()) {
        // Creds already saved; transparently refresh password in case user changed it.
        const existing = loadCredentials();
        if (existing && existing.account === pendingSniffed.account) {
          // Same account, password may have been rotated.
          if (existing.password !== pendingSniffed.password) {
            saveCredentials({
              account: pendingSniffed.account,
              password: pendingSniffed.password,
              alias: existing.alias,
              savedAt: existing.savedAt,
              lastUsedAt: new Date().toISOString(),
            });
            log("info", "偵測到密碼已變更，已更新儲存");
          } else {
            touchCredentials();
          }
        }
        // Different account → mismatch event was already emitted by the
        // sniffer hook. We don't silently overwrite saved creds here.
      }

      state.status = "selecting";
      log("info", "請在上方搜尋 / 勾選要刷的課程，按「開始」即可");
      pushState();

      // E.d: if a previous run was interrupted, offer to resume.
      const prev = loadRun();
      if (prev && prev.status !== "done" && prev.status !== "aborted" && prev.pipelineCids.length) {
        const payload: ResumePrompt = {
          pipelineCids: prev.pipelineCids,
          startedAt: prev.startedAt,
          previousStatus: prev.status,
        };
        mainWindow?.webContents.send(IPC.RESUME_PROMPT, payload);
      }
    })
    .catch((err) => log("error", `登入偵測失敗：${err}`))
    .finally(() => {
      detectLoginInFlight = false;
    });
}

async function tryAutoLogin(): Promise<boolean> {
  if (autoLoginInFlight) return false;
  if (!elearnView) return false;
  const creds = loadCredentials();
  if (!creds) return false;

  // Wait up to 6 s for BrowserView to finish loading elearn with any cached
  // session. Skip the SSO chain entirely if already logged in — running it
  // against a live session clears the idx cookie and immediately logs out.
  for (let i = 0; i < 6; i++) {
    const already = await isBrowserViewLoggedIn();
    if (already === true) {
      log("info", "BrowserView 已登入（idx cookie 有效），跳過 SSO");
      return true;
    }
    if (already === false) break; // elearn loaded, confirmed not logged in
    await new Promise((r) => setTimeout(r, 1000));
  }

  autoLoginInFlight = true;
  emitAutoLogin({ stage: "start" });
  log("info", `偵測到已儲存帳密（${maskAccount(creds.account)}），背景自動登入中...`);
  try {
    // Drive login directly in the visible BrowserView — same cookie jar, no isolation.
    const result = await autoLoginInView(elearnView, creds, { timeoutMs: 60_000 });
    if (result.ok) {
      emitAutoLogin({ stage: "success" });
      log("info", "自動登入成功（view）");
      touchCredentials();
      // SSO redirect already navigated the view to elearn; detectLogin will
      // fire and transition state to "selecting" once 個人專區 appears.
      return true;
    }
    log("warn", `自動登入失敗：${result.error ?? "unknown"}；改跳預填表單`);

    // Fallback — BrowserView already on eCPA; showPrefilledEcpaLogin will
    // re-navigate + pre-fill so the user just clicks 登入.
    await showPrefilledEcpaLogin(creds);
    emitAutoLogin({
      stage: "failed",
      error: "自動填表失敗；瀏覽器已導到 eCPA、帳密已預填，點橘框登入即可",
    });
    return false;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emitAutoLogin({ stage: "failed", error: msg });
    log("warn", `自動登入發生例外：${msg}`);
    try {
      await showPrefilledEcpaLogin(creds);
    } catch {
      /* nothing we can do */
    }
    return false;
  } finally {
    autoLoginInFlight = false;
  }
}

/**
 * Navigate the visible BrowserView to eCPA clogin and pre-fill the 帳號密碼登入
 * column. User only has to click the orange 登入 button — a REAL mouse click,
 * so aspnet's isTrusted-sensitive event handlers fire correctly. This is the
 * fallback when silent auto-login's synthesized click doesn't trigger the
 * login chain.
 */
async function showPrefilledEcpaLogin(creds: SavedCredentials): Promise<void> {
  if (!elearnView) return;
  const ECPA_URL = "https://ecpa.dgpa.gov.tw/uIAM/clogin.asp?destid=CrossHRD";
  const wc = elearnView.webContents;

  // Reconcile the renderer state before we navigate away from wherever the
  // BrowserView currently is: we KNOW the user isn't logged in server-side
  // (that's why we're falling through to prefill), so the left panel must
  // show await_login, not a stale selecting screen. Restart detectLogin so
  // as soon as the user clicks 登入 and lands back on elearn we flip state.
  state.status = "await_login";
  state.user = undefined;
  state.pipelineCids = undefined;
  state.courses = [];
  state.now = { action: "idle" };
  pushState();
  log("info", "等候登入中（自動登入失敗，請點橘框登入）");
  // Single-flight: if the original createWindow detectLogin is still running
  // it'll catch the login. Otherwise this kicks a fresh one. Either way no
  // double-fires can transition state twice.
  attachDetectLoginOnce();

  const onLoad = () => {
    const url = wc.getURL();
    if (!url.includes("ecpa.dgpa.gov.tw")) return;
    if (!url.toLowerCase().includes("clogin")) return;
    wc
      .executeJavaScript(
        `(() => {
          const visible = el => !!el && el.offsetParent !== null;
          const passwords = Array.from(document.querySelectorAll('input[type="password"]')).filter(visible);
          for (const pw of passwords) {
            const form = pw.form || pw.closest('form, div');
            if (!form) continue;
            const accounts = Array.from(form.querySelectorAll('input[type="text"], input[type="tel"], input:not([type])'))
              .filter(visible)
              .filter(el => !/pin/i.test((el.name||'') + ' ' + (el.id||'') + ' ' + (el.placeholder||'')));
            if (!accounts.length) continue;
            const acct = accounts.find(el => /ecpa|帳號/i.test(el.placeholder || el.name || '')) || accounts[0];
            const setValue = (el, v) => {
              const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
              if (desc && desc.set) desc.set.call(el, v); else el.value = v;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            setValue(acct, ${JSON.stringify(creds.account)});
            setValue(pw, ${JSON.stringify(creds.password)});
            acct.dispatchEvent(new Event('blur', { bubbles: true }));
            // Visual cue: briefly outline the 登入 button
            const btn = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'))
              .filter(visible)
              .find(el => /登入/.test((el.textContent || el.value || '').trim()));
            if (btn) {
              btn.style.outline = '3px solid #f59e0b';
              btn.style.boxShadow = '0 0 12px #f59e0b';
            }
            return true;
          }
          return false;
        })()`,
        true,
      )
      .catch(() => void 0);
    wc.off("did-finish-load", onLoad);
  };
  wc.on("did-finish-load", onLoad);
  wc.loadURL(ECPA_URL).catch(() => void 0);
  log("info", "已將瀏覽器導到 eCPA 登入頁，帳密已幫你填好，點橘框的「登入」即可");
}

// ── Discovery helpers ─────────────────────────────────────────
async function refreshCourses(): Promise<void> {
  if (!elearnView) return;
  try {
    const tracked = await discover(elearnView.webContents.session);
    state.courses = tracked.map(trackedToCard);
    updateStats();
    pushState();
    // Break down by phase — getSigningCourses returns both real enrolments
    // AND agency-assigned phantom "未報名" rows, and a flat "100 門" count
    // misleads. Show real vs phantom separately.
    const phantom = tracked.filter(
      (t) => t.course.isReadtimeValidCaption === "未報名",
    ).length;
    const real = tracked.length - phantom;
    const inProgress = tracked.filter(
      (t) =>
        t.course.isReadtimeValidCaption !== "未報名" &&
        t.course.isReadtimeValidCaption !== "已通過" &&
        t.course.isClassing,
    ).length;
    log(
      "info",
      `掃描完成：你目前真正的課程 ${real} 門（進行中未完成 ${inProgress}）` +
        `；機關推薦但你沒點過的 ${phantom} 門已略過`,
    );
    // Diagnostic: print per-course server flags + detail-page snapshot.
    // The UI log only shows in-progress / not-yet-passed rows (otherwise
    // 47 已通過 lines drown out anything useful). The full diag still
    // gets written to temp/auto-elearn-diag.txt for offline forensics.
    const diagLines: string[] = [`=== 課程狀態診斷 ${new Date().toISOString()} ===`];
    let donePassed = 0;
    for (const t of tracked.filter((t) => t.course.isReadtimeValidCaption !== "未報名")) {
      const r = t.course.isReadDones ?? 0;
      const e = t.course.isExamDones ?? 0;
      const s = t.course.isSurveyDones ?? 0;
      const cap = t.course.isReadtimeValidCaption ?? "?";
      const pp = t.course.passPercent ?? "-";
      const d = t.detail
        ? ` | detail: read=${t.detail.readSec ?? "?"}s exam=${t.detail.examScore ?? "?"} survey=${t.detail.surveyDone === true ? "已填" : t.detail.surveyDone === false ? "未填" : "?"} pass=${t.detail.passed === true ? "通過" : t.detail.passed === false ? "未通過" : "--"}`
        : " | detail: (none)";
      const line = `📋 [list 閱:${r} 測:${e} 問:${s} cap:${cap} p:${pp}% → phase:${t.phase}]${d} ${t.course.caption}`;
      diagLines.push(line);
      if (cap === "已通過") {
        donePassed++;
        continue;
      }
      log("info", `  ${line}`);
    }
    if (donePassed > 0) log("info", `  ✓ 已通過 ${donePassed} 門（不在日誌列出，完整紀錄寫到 temp/auto-elearn-diag.txt）`);
    try {
      writeFileSync(join(app.getPath("temp"), "auto-elearn-diag.txt"), diagLines.join("\n"), "utf8");
    } catch { /* non-fatal */ }
  } catch (e) {
    log("error", `掃描失敗：${e instanceof Error ? e.message : String(e)}`);
  }
}

function trackedToCard(t: Tracked): CourseCard {
  // Prefer authoritative detail-page state (閱讀時數 / 測驗 / 問卷) over the
  // unreliable listing flags. Listing flags are kept only as fallback.
  // examDone uses the per-course declared threshold from 課程須知.
  // course-detail.ts falls back to 80 when the page omits the value, so a
  // course that genuinely requires 60 lights ✓ at 60, while courses where
  // we couldn't read the page conservatively need 80.
  const passFloor = t.detail?.passingScore ?? 80;
  const examDone =
    t.detail?.examScore != null
      ? t.detail.examScore >= passFloor
      : (t.course.isExamDones ?? 0) === 1;
  const surveyDone =
    t.detail?.surveyDone ?? ((t.course.isSurveyDones ?? 0) === 1);
  return {
    cid: t.course.cid,
    name: t.course.caption,
    phase: t.phase === "reading_done" ? "reading" : (t.phase as CourseCard["phase"]),
    readSec: t.readSec,
    requiredSec: t.requiredSec,
    examDone,
    surveyDone,
    lastPingAt: t.lastPingAt,
  };
}

function updateStats() {
  const scopeCids = state.pipelineCids ? new Set(state.pipelineCids) : null;
  const scope = scopeCids
    ? state.courses.filter((c) => scopeCids.has(c.cid))
    : state.courses;
  state.stats.total = scope.length;
  state.stats.done = scope.filter((c) => c.phase === "done").length;
  state.stats.progressPct =
    state.stats.total === 0 ? 0 : Math.round((state.stats.done / state.stats.total) * 100);
}

// ── BrowserView login watchdog ────────────────────────────────
// Returns: true = logged in, false = on elearn but NOT logged in, null = not on elearn / loading
async function isBrowserViewLoggedIn(): Promise<boolean | null> {
  if (!elearnView) return null;
  const url = elearnView.webContents.getURL();
  if (!url.includes("elearn.hrd.gov.tw")) return null; // on ECPA or other — skip
  if (elearnView.webContents.isLoading()) return null; // mid-nav — skip
  try {
    const found: boolean = await elearnView.webContents.executeJavaScript(
      `(() => {
        const a = document.querySelector('a[href="/mooc/user/learn_dashboard.php"]');
        return !!a && (a.textContent || '').trim().includes('個人專區');
      })()`,
      true,
    );
    return found;
  } catch {
    return null; // page not ready — skip
  }
}

function startLoginWatchdog() {
  stopLoginWatchdog();
  loginMissCount = 0;
  loginWatchdogTimer = setInterval(async () => {
    if (autoLoginInFlight || reloginInFlight) return;
    const s = state.status;
    if (s === "boot" || s === "setup" || s === "await_login") return;

    const status = await isBrowserViewLoggedIn();
    if (status === null) return; // not on elearn or loading — skip, don't count as miss

    if (status === true) {
      loginMissCount = 0;
      if (state.loginStatus !== "ok") {
        state.loginStatus = "ok";
        pushState();
      }
      return;
    }

    // status === false: on elearn but not logged in
    loginMissCount++;
    if (loginMissCount < 2) return; // one miss may be mid-navigation
    loginMissCount = 0;

    if (!hasSavedCredentials()) {
      log("warn", "BrowserView 偵測到登出，但沒有儲存帳密，無法自動重登");
      state.loginStatus = "failed";
      pushState();
      return;
    }

    reloginInFlight = true;
    log("warn", "BrowserView 偵測到登出，自動重新登入中...");
    state.loginStatus = "relogging";
    const wasRunning = state.status === "running";
    if (wasRunning) {
      state.status = "paused";
      state.pauseReason = "session_expired";
    }
    pushState();

    const ok = await tryAutoLogin();
    // Always verify DOM — tryAutoLogin can return ok=true if SSO lands on an
    // elearn URL but doesn't actually establish a session (false positive).
    const verified = await isBrowserViewLoggedIn();
    if (ok && verified === true) {
      state.loginStatus = "ok";
      if (wasRunning) {
        state.status = "running";
        state.pauseReason = undefined;
        log("info", "BrowserView session 已恢復，繼續刷課");
      }
    } else if (!ok) {
      state.loginStatus = "failed";
      log("error", "BrowserView 自動重登失敗，請手動重新登入");
    } else {
      // tryAutoLogin ok but DOM still not logged in
      state.loginStatus = "failed";
      log("error", "重登報告成功但 BrowserView 仍未登入（SSO 可能失敗）");
    }
    pushState();
    reloginInFlight = false;
  }, 30_000);
}

function stopLoginWatchdog() {
  if (loginWatchdogTimer) {
    clearInterval(loginWatchdogTimer);
    loginWatchdogTimer = null;
  }
}

/**
 * Drop every piece of in-memory + on-disk state that belongs to the currently
 * logged-in account: pipeline, watchdogs, persisted run, sniffed creds, the
 * UI's notion of who is logged in. Optionally wipes the BrowserView's session
 * storage (cookies/localStorage/...) so the next navigation behaves as if the
 * app had just been launched for the first time.
 *
 * Does NOT touch `state.status` — caller decides where to land (`setup`,
 * `await_login`, `selecting`).
 */
async function resetForAccountSwitch(opts: { wipeSession: boolean }): Promise<void> {
  // Stop all background work that depends on the old account.
  abortSignal.aborted = true;
  stopSessionWatchdog();
  stopLoginWatchdog();
  consecutiveDeadChecks = 0;
  loginMissCount = 0;
  reloginInFlight = false;
  // autoLoginInFlight is intentionally NOT cleared — if a fresh autologin is
  // running it will set its own flag in its finally block. Forcing it false
  // here would let two concurrent autologins race.

  // In-memory pipeline state.
  runningCids.clear();
  focusedCid = null;
  pendingSniffed = null;

  // Persisted run on disk so a leftover paused run can't auto-resume into a
  // different account.
  clearRun();
  clearCredentials();

  // Reset UI state to a clean shell. Caller flips status afterwards.
  state.user = undefined;
  state.loginStatus = undefined;
  state.pauseReason = undefined;
  state.pipelineCids = undefined;
  state.returnedToSelect = undefined;
  state.courses = [];
  state.now = { action: "idle" };
  state.stats = { done: 0, total: 0, quizzes: 0, llmCalls: 0, progressPct: 0 };

  if (opts.wipeSession && elearnView) {
    try {
      await elearnView.webContents.session.clearStorageData({
        storages: [
          "cookies",
          "localstorage",
          "indexdb",
          "websql",
          "shadercache",
          "filesystem",
          "cachestorage",
        ],
      });
    } catch (e) {
      log("warn", `清除 BrowserView session 失敗：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Drop the cached server-progress map; it belongs to the old account.
  _pollCache = null;
}

/**
 * Execute a user-requested account switch end-to-end.
 *
 * Caller decides whether the new credentials are passed in (eager autologin)
 * or whether we land on the setup screen (let the user log in manually).
 * Either way the OLD account's state is fully cleared first.
 */
async function performAccountSwitch(payload: SwitchAccountPayload): Promise<SwitchAccountResult> {
  const account = (payload.account ?? "").trim();
  const password = payload.password ?? "";
  const wipeSession = payload.wipeSession !== false;

  if (account || password) {
    if (!account || !password) {
      return { ok: false, reason: "帳號或密碼為空" };
    }
  }

  log("info", "🔄 切換帳號：清除上一組帳號的所有狀態...");
  await resetForAccountSwitch({ wipeSession });

  if (account && password) {
    const toSave: SavedCredentials = {
      account,
      password,
      savedAt: new Date().toISOString(),
    };
    const res = saveCredentials(toSave);
    if (!res.ok) {
      // Land on setup so the user isn't stuck — they can retry from the form.
      state.status = "setup";
      pushState();
      return { ok: false, reason: res.reason ?? "存帳密失敗" };
    }
    pushSecretToMaskList(account, maskAccount(account));
    log("info", `已儲存新帳號（${maskAccount(account)}），背景登入中...`);

    if (wipeSession) {
      // Clean slate: load homepage so detectLogin / autologin start from a
      // known state. detectLogin is fired below and stays watching the view.
      state.status = "await_login";
      pushState();
      if (elearnView) {
        elearnView.webContents.loadURL(HOMEPAGE).catch(() => void 0);
      }
      // Re-attach detectLogin so the new account's name flows back into UI.
      attachDetectLoginOnce();
      void tryAutoLogin().catch(() => void 0);
    } else {
      // Sync-from-browser: BrowserView is already logged in as the new user.
      // Just re-detect to refresh state.user, then scan courses.
      state.status = "await_login";
      pushState();
      attachDetectLoginOnce();
    }
    return { ok: true };
  }

  // No new creds → leave the user on the setup screen.
  state.status = "setup";
  pushState();
  if (wipeSession && elearnView) {
    elearnView.webContents.loadURL(HOMEPAGE).catch(() => void 0);
  }
  log("info", "已清除帳號，請重新輸入要切換的帳號");
  return { ok: true };
}

// ── Pipeline ──────────────────────────────────────────────────
function startSessionWatchdog(session: Electron.Session) {
  stopSessionWatchdog();
  watchdogTimer = setInterval(async () => {
    if (state.status !== "running") return;
    const alive = await isSessionAlive(session);
    if (alive) {
      consecutiveDeadChecks = 0;
      return;
    }
    consecutiveDeadChecks++;
    log("warn", `偵測到 session 無回應（第 ${consecutiveDeadChecks} 次）`);
    if (consecutiveDeadChecks < 2) return; // one blip may just be a transient slow response

    state.status = "paused";
    state.pauseReason = "session_expired";
    persistRun("paused");
    mainWindow?.webContents.send(IPC.PIPELINE_PAUSED, "session_expired");
    pushState();

    if (hasSavedCredentials()) {
      const ok = await tryAutoLogin();
      if (ok) {
        // Re-verify session landed correctly before un-pausing.
        const nowAlive = await isSessionAlive(session);
        if (nowAlive) {
          state.status = "running";
          state.pauseReason = undefined;
          consecutiveDeadChecks = 0;
          persistRun("running");
          log("info", "Session 已恢復，繼續刷課");
          pushState();
        } else {
          log("error", "自動重登報告成功但 session 仍異常；請檢查網路");
        }
      } else {
        log("error", "自動重登失敗；等待網路 / 手動登入");
      }
    } else {
      log("warn", "沒有儲存帳密；請手動在下方瀏覽器重新登入，之後按恢復");
    }
  }, 90_000);
}

function stopSessionWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  consecutiveDeadChecks = 0;
}

async function runPipelineFor(cids: string[]): Promise<void> {
  if (!elearnView) return;
  const session = elearnView.webContents.session;
  abortSignal.aborted = false;

  // Scope the dashboard + stats to what the user actually asked for
  state.pipelineCids = [...cids];
  updateStats();
  persistRun("running");
  pushState();

  // Up-front plan summary so the user sees what work this batch will actually do
  // BEFORE we walk through phases that might log "沒有需要 X 的課程" early on.
  // Without this, when most selected courses are past reading or already done,
  // the user sees "0 筆 / 沒有 X" several times then the pipeline suddenly
  // starts working — looks broken.
  try {
    const planTracked = await discover(session);
    const planSel = new Set(cids);
    const plan = planTracked.filter((t) => planSel.has(t.course.cid));
    const enrolledCids = new Set(state.courses.map((c) => c.cid));
    const needEnroll = cids.filter((c) => !enrolledCids.has(c)).length;
    const needRead = plan.filter((t) => t.phase === "reading").length;
    const needExamPlan = plan.filter(
      (t) =>
        t.course.isReadtimeValidCaption !== "已通過" &&
        t.detail?.examScore == null &&
        (t.course.isExamDones ?? 0) !== 1,
    ).length;
    const needSurveyPlan = plan.filter(
      (t) => t.course.isReadtimeValidCaption !== "已通過" && t.detail?.surveyDone !== true,
    ).length;
    const alreadyDone = plan.filter((t) => t.course.isReadtimeValidCaption === "已通過").length;
    log(
      "info",
      `📋 本批 ${cids.length} 門課計畫：報名 ${needEnroll} · 閱讀 ${needRead} · 測驗 ${needExamPlan} · 問卷 ${needSurveyPlan}（已通過 ${alreadyDone}）`,
    );
  } catch (e) {
    log("warn", `預估失敗：${e instanceof Error ? e.message : String(e)}`);
  }

  // 1. Enrol any not-yet-enrolled cids
  const enrolled = new Set(state.courses.map((c) => c.cid));
  const toEnrol = cids.filter((c) => !enrolled.has(c));
  if (toEnrol.length > 0) {
    state.status = "enrolling";
    state.now.action = "enroll";
    state.now.detail = `${toEnrol.length} 門課待報名`;
    pushState();
    log("info", `開始報名 ${toEnrol.length} 門新課程...`);
    const results = await enrollMany(session, toEnrol, ENROLL_DELAY_MS);
    const ok = results.filter((r) => r.ok).map((r) => r.cid);
    const bad = results.filter((r) => !r.ok);
    log("info", `報名完成：成功 ${ok.length} / 失敗 ${bad.length}`);
    for (const b of bad) {
      log("warn", `報名失敗 cid=${b.cid} status=${b.status} ${b.errorMsg ?? ""}`);
    }
    await refreshCourses();
  }

  // 2. Heartbeat for courses that need reading (user-ticked, currently open)
  state.status = "running";
  const tracked = await discover(session);
  const selected = new Set(cids);

  // Courses not in "reading" phase (classify returned done/exam/survey/rating) skip heartbeat.
  const skipRead = tracked.filter(
    (t) => selected.has(t.course.cid) && t.course.isClassing && t.phase !== "reading" && t.phase !== "pending",
  );
  if (skipRead.length > 0) {
    log(
      "info",
      `${skipRead.length} 門課已過閱讀階段，跳過心跳：${skipRead.map((t) => t.course.caption).join("、")}`,
    );
  }

  const completedHeartbeat = new Set<string>();
  // Per-course finish chains (測驗→問卷) collected here so a fast course
  // doesn't have to wait for the slowest one in the batch to finish heartbeat
  // before progressing through its remaining phases.
  const chainPromises: Promise<void>[] = [];
  // Tracks which courses have already had their chain fired, so the halfway
  // hook (early-fire path) and the heartbeat-done hook (fallback path) don't
  // both push the chain twice for the same course.
  const chainStarted = new Set<string>();
  // Resolved when a course's heartbeat has fully finished. Used by chains
  // started early (at 50% reading) to defer their final 通過-confirmation poll
  // until the rest of the reading credit lands — otherwise a chain that
  // wraps up exam+survey at the 30-min mark would never see 通過 flip in its
  // 30-second poll window because reading is still ticking towards 60 min.
  const heartbeatDoneResolvers = new Map<string, () => void>();
  const heartbeatDonePromises = new Map<string, Promise<void>>();
  const ensureHeartbeatDonePromise = (cid: string) => {
    if (heartbeatDonePromises.has(cid)) return;
    heartbeatDonePromises.set(
      cid,
      new Promise<void>((resolve) => heartbeatDoneResolvers.set(cid, resolve)),
    );
  };
  const markHeartbeatDone = (cid: string) => {
    const r = heartbeatDoneResolvers.get(cid);
    if (r) {
      r();
      heartbeatDoneResolvers.delete(cid);
    }
  };
  const startChainOnce = (cid: string, name: string, awaitHeartbeat: boolean) => {
    if (chainStarted.has(cid)) return;
    chainStarted.add(cid);
    chainPromises.push(runFinishChain(cid, name, awaitHeartbeat));
  };

  // Pure async chain that runs for ONE course. Fires either when the course
  // has crossed 50% reading (halfway path) or when its heartbeat fully
  // finishes (fallback path / skipRead courses with no heartbeat). Re-fetches
  // detail inside so gating matches current server state.
  const runFinishChain = async (cid: string, name: string, awaitHeartbeat: boolean): Promise<void> => {
    if (abortSignal.aborted) return;
    const card = state.courses.find((c) => c.cid === cid);
    try {
      // Fresh detail to drive survey skip decisions with current server data.
      // Note: we DON'T use detail.examScore as a "skip exam" signal — a score
      // of 0 just means "you got 0 last time you tried", not "exam done".
      // Anything below 通過 should still re-attempt; solver handles "no togo
      // button" gracefully if the page genuinely has no exam.
      const fresh = await fetchCourseDetail(session, cid);
      const surveyDone = fresh?.surveyDone === true;
      const passed = fresh?.passed === true;

      // 1. 測驗 + 問卷 — run in parallel, per the user's spec for the halfway
      //    chain: 「halfway 觸發後，測驗跟問卷要同時並行，不是串行」. 問卷 is
      //    no longer gated by examOK — failing the exam used to skip the
      //    survey to avoid a suspicious "failed exam → fresh 問卷" trail,
      //    but in practice the survey runs invisibly and waiting on a flaky
      //    exam wastes minutes the user doesn't have. The exam path retries
      //    up to 3 rounds internally; the survey path fires once and reports.
      let examOK = passed;
      if (!passed && !abortSignal.aborted) {
        // History-based pre-solve runs first (synchronously) so both the
        // exam task AND any later attempts benefit from the freshly-saved
        // learned_answers. solveExamFromHistory mathematically derives the
        // answer key from past view_result.php pages without submitting any
        // new exam attempt — cheap (~5-25 s) and zero exam attempts consumed.
        try {
          const { solveExamFromHistory } = await import("./exam/history-solver");
          const r = await solveExamFromHistory(session, cid, (msg) => log("info", `  [${name}] ${msg}`));
          if (r.ok) log("info", `📚 [${name}] 從歷次紀錄學到 ${r.learned} 題（已存 learned_answers）`);
          else log("info", `  [${name}] 跳過 history-solve：${r.reason ?? "n/a"}`);
        } catch (e) {
          log("warn", `  [${name}] history-solve 例外：${(e as Error)?.message ?? e}`);
        }

        const threshold = fresh?.passingScore ?? 80;

        // ── Exam task — up to 3 outer rounds of solveExam, retry-on-fail. ──
        // solveExam internally retries up to ~30 attempts (brute-force probe
        // + LLM fallback) but exits early once its bfQueue is exhausted, even
        // when score < passing — intentional, to avoid spinning forever, but
        // it leaves the course stuck if a single round can't find a passing
        // combo. Re-running solveExam re-seeds bfStates from the now-updated
        // learned_answers (brute saves with confidence 0.95), giving the next
        // round a higher baseline. Capped at 3 rounds to avoid suspicious
        // attempt counts on the server side.
        const examTask = (async (): Promise<boolean> => {
          const EXAM_ROUNDS = 3;
          let res: Awaited<ReturnType<typeof solveExam>> | null = null;
          for (let round = 1; round <= EXAM_ROUNDS; round++) {
            if (abortSignal.aborted) break;
            if (round === 1) {
              log("info", `開始測驗：${name}（門檻 ${threshold} 分）`);
            } else {
              const prev = res?.score != null ? `${res.score}分` : "?";
              log(
                "info",
                `[${name}] 上一輪 ${prev} < ${threshold}，第 ${round}/${EXAM_ROUNDS} 輪重考；先重跑歷次反推`,
              );
              try {
                const { solveExamFromHistory } = await import("./exam/history-solver");
                const hr = await solveExamFromHistory(session, cid, (msg) => log("info", `  [${name}] ${msg}`));
                if (hr.ok && hr.learned > 0) {
                  log("info", `📚 [${name}] 第 ${round} 輪歷史反推學到 ${hr.learned} 題`);
                }
              } catch (e) {
                log("warn", `  [${name}] 第 ${round} 輪歷史反推例外：${(e as Error)?.message ?? e}`);
              }
              await new Promise((r) => setTimeout(r, 5000));
            }
            res = await solveExam(cid, session, {
              onProgress: (msg) => log("info", `  [${name}] ${msg}`),
              passingScore: threshold,
            });
            if (!res.ok) {
              log("warn", `測驗失敗 ${name}：${res.error ?? "unknown"}`);
              return false; // setup failure won't be fixed by another round
            }
            if (res.passed === true || res.total === 0) break;
          }
          if (res && res.ok) {
            const scoreStr = res.score != null ? `${res.score}分` : "?";
            const readStr = res.readExamScore != null ? ` 閱讀:${res.readExamScore}分` : "";
            log(
              "info",
              `測驗完成 ${name}：${res.passed ? "✅ 通過" : "⚠ 判定不明"} ${scoreStr}${readStr}，共 ${res.total} 題（DB ${res.bySource.db} / fuzzy ${res.bySource.fuzzy} / LLM ${res.bySource.llm} / brute ${res.bySource.brute} / random ${res.bySource.random}）`,
            );
            if (card && res.passed) card.examDone = true;
            // total === 0 → no exam menu in sysbar (rare; reading-only courses)
            // → treat as OK so the done-poll can proceed.
            return res.passed === true || res.total === 0;
          }
          return false;
        })();

        // ── Survey task — fires once, in parallel with exam. Independent of
        //    exam outcome per user spec; even if exam fails the survey gets
        //    submitted so the course is half-credited rather than fully stuck.
        const surveyTask = (async (): Promise<void> => {
          if (surveyDone || abortSignal.aborted) return;
          log("info", `問卷：${name}`);
          const sr = await fillSurvey(cid, session, {
            onProgress: (msg) => log("info", `  [${name}] ${msg}`),
          });
          if (sr.ok) {
            log("info", `問卷完成 ${name}：勾選 ${sr.filled} 題 + 繳交`);
            if (card) card.surveyDone = true;
          } else {
            log("warn", `問卷失敗 ${name}：${sr.error ?? "unknown"}`);
          }
        })();

        const [examResult] = await Promise.all([examTask, surveyTask]);
        examOK = examResult;
      }

      // No more "心得" step — elearn's actual flow is reading/exam/survey only.
      // The old reflection writer always failed for courses without a 心得
      // dropdown and the user complained: course passes once 問卷 is filled,
      // making the step pure noise.

      // Mark card as "verifying" so UI shows a "等待 server 確認通過..." badge
      // instead of the prematurely-green "done" state.
      if (card && card.phase !== "done") {
        card.phase = "verifying";
        pushState();
      }

      // If this chain was started early (at 50% reading), the rest of the
      // reading time is still being credited by an active heartbeat. The
      // server will not flip 通過狀態 until reading credit reaches the full
      // requiredSec, so block on heartbeat completion before doing the
      // 通過-confirmation poll. Without this, an early chain finishes its
      // exam+survey, polls for 30 s while heartbeat still has 25 min to go,
      // and falsely concludes "尚未刷新".
      if (awaitHeartbeat) {
        const wait = heartbeatDonePromises.get(cid);
        if (wait) {
          log("info", `[${name}] 測驗+問卷已交，等待閱讀心跳完成後確認通過狀態...`);
          await wait;
        }
      }

      // Only mark phase=done when SERVER confirms 通過狀態 == 通過. That
      // can lag behind 問卷 submission by a few seconds while elearn
      // finalises the credit. Poll detail up to 30 s before giving up.
      if (card && card.phase !== "done") {
        for (let i = 0; i < 6; i++) {
          if (abortSignal.aborted) break;
          await new Promise((r) => setTimeout(r, 5000));
          const final = await fetchCourseDetail(session, cid).catch(() => null);
          if (final?.passed === true) {
            card.phase = "done";
            updateStats();
            pushState();
            log("info", `[${name}] ✅ server 已確認通過`);
            break;
          }
        }
        if (card.phase !== "done") {
          log(
            "info",
            `[${name}] 問卷已交但 server 通過狀態尚未刷新；保持「等待通過確認」狀態，server 應會自動更新`,
          );
        }
      }
    } catch (e) {
      log("warn", `[${name}] chain 失敗：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Fire chains for skipRead courses immediately — they've nothing to wait for
  // and no heartbeat will run for them.
  for (const t of skipRead) {
    startChainOnce(t.course.cid, t.course.caption, false);
  }

  const needReading = tracked.filter(
    (t) => selected.has(t.course.cid) && t.course.isClassing && t.phase === "reading",
  );

  // Pre-create the heartbeat-done promise for every reading course so the
  // halfway hook can await it without race conditions.
  for (const t of needReading) ensureHeartbeatDonePromise(t.course.cid);

  if (needReading.length === 0) {
    log("info", "沒有需要閱讀的課程");
  } else {
    const parallel = Math.min(needReading.length, HEARTBEAT_PARALLEL_MAX);
    log(
      "info",
      `${needReading.length} 門課開始閱讀（並行 ${parallel}，每 ${
        HEARTBEAT_INTERVAL_MS / 1000
      }s 心跳）`,
    );
    state.now.action = "heartbeat";
    pushState();
    startSessionWatchdog(session);

    await runHeartbeatBatch(session, needReading, {
      parallel,
      intervalMs: HEARTBEAT_INTERVAL_MS,
      jitterMs: HEARTBEAT_JITTER_MS,
      graceSec: 120,
      signal: abortSignal,
      pollIntervalMs: 30_000,
      pollFn: async (cid) => {
        try {
          const map = await fetchProgressCached(session);
          return map.get(cid) ?? null;
        } catch {
          return null;
        }
      },
      detailPollIntervalMs: 120_000,
      detailPollFn: async (cid) => {
        try {
          const detail = await fetchCourseDetail(session, cid);
          return detail ? { readSec: detail.readSec } : null;
        } catch {
          return null;
        }
      },
      onDetailPoll: (cid, detail) => {
        const card = state.courses.find((c) => c.cid === cid);
        if (!card) return;
        if (detail.readSec != null) {
          // Authoritative server reading time — overrides local elapsed
          // estimate so the card matches /info/{cid} 閱讀時數 instead of
          // showing only "since pipeline started".
          const newReadSec = Math.min(card.requiredSec, detail.readSec);
          if (newReadSec !== card.readSec) {
            card.readSec = newReadSec;
            log("info", `[${card.name}] 📡 server 閱讀時數 ${Math.round(newReadSec / 60)} 分鐘 / 需 ${Math.round(card.requiredSec / 60)} 分鐘`);
            pushState();
          }
        }
      },
      onPoll: (cid, data) => {
        const card = state.courses.find((c) => c.cid === cid);
        if (!card) return;
        if (data.isExamDones === 1) card.examDone = true;
        if (data.isSurveyDones === 1) card.surveyDone = true;
        const captionDone = data.isReadtimeValidCaption === "已通過";
        const readStatus = (data.isReadDones === 1 || captionDone) ? "閱讀✓" : "閱讀⏳";
        const examStatus = data.isExamDones === 1 ? "測驗✓" : "測驗○";
        const surveyStatus = data.isSurveyDones === 1 ? "問卷✓" : "問卷○";
        const pctStr = data.passPercent != null ? ` 整體${data.passPercent}%` : "";
        log("info", `[${card.name}] 📡 server 進度:${pctStr} ${readStatus} ${examStatus} ${surveyStatus} caption:${data.isReadtimeValidCaption ?? "?"}`);
        if ((data.isReadDones === 1 || captionDone) && card.readSec < card.requiredSec) {
          card.readSec = card.requiredSec;
          log("info", `[${card.name}] 📡 伺服器確認閱讀達標（caption=${data.isReadtimeValidCaption}），提前結束心跳`);
        }
        pushState();
      },
      onProgress: (cid, stage, extra) => {
        const card = state.courses.find((c) => c.cid === cid);
        if (!card) return;
        if (stage === "open") {
          const e0 = extra as { origin?: string; actid?: string; encCid?: string };
          const tail =
            (e0.origin ? ` (心跳 host: ${e0.origin}` : "") +
            (e0.encCid ? `, enCid: ${e0.encCid}` : "") +
            (e0.actid ? `, actid: ${e0.actid.slice(0, 40)}` : "") +
            (e0.origin ? ")" : "");
          log("info", `開始閱讀：${card.name}${tail}`);
          runningCids.add(cid);
          if (!focusedCid) {
            focusedCid = cid;
            navigateViewToCourse(cid);
          }
        } else if (stage === "tick") {
          const e2 = extra as {
            firstResponse?: string; status?: number; timediff?: string;
            enterSession?: { status: number; ok: boolean; body?: string };
            startSession?: { status: number; ok: boolean; body: string };
            refreshSession?: { ok: boolean; status: number; body: string };
          };
          if (e2.enterSession) {
            log("info", `[${card.name}] enterReadingSession → ${e2.enterSession.ok ? "OK" : "FAIL"} (${e2.enterSession.status}) ${e2.enterSession.body ?? ""}`);
          }
          if (e2.startSession) {
            log("info", `[${card.name}] startReadingSession → ${e2.startSession.ok ? "OK" : "FAIL"} (${e2.startSession.status}) ${e2.startSession.body}`);
          }
          if (e2.refreshSession) {
            log("info", `[${card.name}] ♻ 重新建立 session → ${e2.refreshSession.ok ? "OK" : "FAIL"} (${e2.refreshSession.status}) ${e2.refreshSession.body}`);
          }
          if (e2.firstResponse !== undefined) {
            const td = e2.timediff !== undefined ? ` timediff=${e2.timediff}` : "";
            log("info", `[${card.name}] 心跳回應${td}: ${e2.firstResponse}`);
          }
        } else if (stage === "done") {
          const pings = (extra as { pings?: number })?.pings ?? 0;
          const serverConfirmed = (extra as { serverConfirmed?: boolean })?.serverConfirmed ?? false;
          log("info", `閱讀結束：${card.name} (${pings} pings, ${serverConfirmed ? "伺服器確認達標" : "計時到期"})`);
          completedHeartbeat.add(cid);
          if (card.phase !== "verifying") card.phase = "exam";
          runningCids.delete(cid);
          if (focusedCid === cid) focusNextCourse();
          // Unblock any chain that fired at 50% and is waiting on heartbeat
          // completion before doing its 通過-confirmation poll.
          markHeartbeatDone(cid);
          // Fallback: chain wasn't started early (e.g. very short course where
          // halfway never fired before heartbeat finished). Start it now.
          // Once-only — the early-fire path also goes through startChainOnce.
          startChainOnce(cid, card.name, false);
        } else if (stage === "error") {
          log("warn", `心跳錯誤 ${card.name}：${JSON.stringify(extra ?? {})}`);
          runningCids.delete(cid);
          if (focusedCid === cid) focusNextCourse();
        }
      },
      onHalfway: (cid) => {
        const card = state.courses.find((c) => c.cid === cid);
        if (!card) return;
        // Fire 測驗+問卷 chain in parallel with the remaining reading. The
        // chain awaits heartbeat completion before its final 通過-confirm
        // poll so it doesn't bail prematurely while reading is still ticking.
        log("info", `[${card.name}] 📖 閱讀已過半，並行啟動測驗+問卷`);
        startChainOnce(cid, card.name, true);
        pushState();
      },
      onTick: (cid, pings, elapsedSec) => {
        const card = state.courses.find((c) => c.cid === cid);
        if (!card) return;
        // Keep readSec as max(server-confirmed, local elapsed) so UI never goes backwards
        if (elapsedSec > card.readSec) card.readSec = Math.min(card.requiredSec, elapsedSec);
        card.lastPingAt = Date.now();
        state.now.courseId = cid;
        state.now.courseName = card.name;
        state.now.action = "heartbeat";
        const readMin = Math.floor(card.readSec / 60);
        const reqMin = Math.floor(card.requiredSec / 60);
        const pct = card.requiredSec > 0 ? Math.min(100, Math.round((card.readSec / card.requiredSec) * 100)) : 0;
        state.now.detail = `${pct}% · 已讀 ${readMin} 分鐘 / 需 ${reqMin} 分鐘 (${pings} pings)`;
        pushState();
        // Log every 6 pings (~30s) for a while, then taper to every 30 pings
        const interval = pings < 30 ? 6 : 30;
        if (pings === 1 || pings % interval === 0) {
          log("info", `${card.name}: ${pings} ping, 已讀 ${readMin} 分鐘 / 需 ${reqMin} 分鐘 (${pct}%)`);
        }
      },
    });
  }

  // Wait for all post-heartbeat chains (kicked off as each course's heartbeat
  // finished — see runFinishChain below). This is what lets a fast course
  // start its 測驗 / 問卷 / 心得 immediately while slower courses are still
  // ticking through their 60 minutes of reading.
  if (chainPromises.length > 0) {
    log("info", `等候 ${chainPromises.length} 條 per-course chain 完成...`);
    await Promise.allSettled(chainPromises);
  }

  stopSessionWatchdog();
  state.status = "done";
  state.now.action = "idle";
  state.now.courseId = undefined;
  state.now.courseName = undefined;
  state.now.detail = undefined;
  runningCids.clear();
  focusedCid = null;
  clearRun();
  await refreshCourses();
  updateStats();
  pushState();
}

// ── Search helper ─────────────────────────────────────────────
/**
 * Normalise a free-text search keyword: strip ASCII + full-width whitespace,
 * BOM, and zero-width chars so "性別 平等" / "性別　平等" / " 性別平等﻿"
 * all behave the same.
 */
function normaliseKeyword(raw: string | undefined): string {
  if (!raw) return "";
  return raw.replace(/[\s　﻿​]+/g, " ").trim();
}

async function keywordSearch(opts: SearchOptions): Promise<CourseCandidate[]> {
  if (!elearnView) return [];
  const session = elearnView.webContents.session;
  const trimmed = normaliseKeyword(opts.keyword);
  const allByCid = new Map<string, Course>();
  const mineCids = new Set(state.courses.map((c) => c.cid));
  let authFailed = false;

  // Hour range sanitisation: reject negatives, swap if min > max, treat NaN as
  // unset. The elearn server returns 0 results when the range is reversed
  // — silently making this user-hostile.
  let hoursMin = Number.isFinite(opts.hoursMin) && (opts.hoursMin as number) > 0 ? (opts.hoursMin as number) : undefined;
  let hoursMax = Number.isFinite(opts.hoursMax) && (opts.hoursMax as number) > 0 ? (opts.hoursMax as number) : undefined;
  if (hoursMin !== undefined && hoursMax !== undefined && hoursMin > hoursMax) {
    [hoursMin, hoursMax] = [hoursMax, hoursMin];
    log("info", `時數範圍 min/max 顛倒，已自動對調 → ${hoursMin} ~ ${hoursMax}`);
  }

  const filters: SearchFilters = {
    fromSchoolId: opts.fromSchoolId,
    hoursMin,
    hoursMax,
  };

  const runSearch = async (categoryId: string, perpage: number, label: string) => {
    try {
      if (categoryId) await primeExplorer(session, categoryId);
      const results = await searchCourses(session, categoryId, trimmed, perpage, filters);
      log(
        "info",
        `  ${label}: ${results.length} 筆 (isClassing=${results.filter((c) => c.isClassing).length})`,
      );
      for (const r of results) if (!allByCid.has(r.cid)) allByCid.set(r.cid, r);
    } catch (e) {
      if (e instanceof ElearnAuthError) {
        authFailed = true;
        log("error", `${label} 失敗：${e.message}（請重新登入或等待自動重登）`);
      } else {
        log("warn", `${label} 失敗：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  // Determine categoryId from main/sub selection. Sub overrides main; main
  // alone lets the server widen to all of its descendants.
  const explicitCategory =
    opts.subCategoryId && opts.subCategoryId.trim()
      ? opts.subCategoryId.trim()
      : opts.mainCategoryId && opts.mainCategoryId.trim()
        ? opts.mainCategoryId.trim()
        : "";

  if (explicitCategory) {
    await runSearch(explicitCategory, 100, `cat=${explicitCategory} kw="${trimmed}"`);
    // Fallback: category-narrowed search returned nothing AND we have a keyword
    // → try site-wide. Covers the common rot scenario where the course moved
    // to a different category but still matches by name.
    if (allByCid.size === 0 && trimmed && !authFailed) {
      log("info", `  cat=${explicitCategory} 無結果，fallback 全站 kw="${trimmed}"`);
      await runSearch("", 100, `fallback 全站 kw="${trimmed}"`);
    }
  } else {
    // No category — site-wide first, then supplement with the legacy
    // KNOWN_CATEGORIES sweep for categories the site-wide search may rank low.
    await runSearch("", 100, `全站 kw="${trimmed}"`);
    for (const cat of KNOWN_CATEGORIES) {
      // Search must NOT honour the pipeline's abortSignal — that flag persists
      // after a user clicks "返回選課" and would silently skip every search
      // until the next pipeline starts.
      if (authFailed) break; // stop hammering when session is gone
      await runSearch(cat, 50, `cat=${cat} kw="${trimmed}"`);
    }
  }

  log("info", `  併集 byCid: ${allByCid.size} 筆 (isClassing=${Array.from(allByCid.values()).filter((c) => c.isClassing).length})`);
  if (authFailed) {
    log("warn", "搜尋過程偵測到 session 失效。請等待自動重登後再試一次。");
  }

  return Array.from(allByCid.values())
    .filter((c) => c.isClassing)
    .map<CourseCandidate>((c) => ({
      cid: c.cid,
      caption: c.caption,
      certification_hours: c.certification_hours,
      fromSchoolName: c.fromSchoolName,
      studentTargetTypeCaption: c.studentTargetTypeCaption,
      category_full_path: c.category_full_path,
      classPeriod: c.classPeriod,
      isClassing: !!c.isClassing,
      already_enrolled: mineCids.has(c.cid),
    }))
    // 0-hr courses are 組裝 / 精裝 packages without standalone reading content —
    // the auto-pipeline can't heartbeat them. Push to the end so the real,
    // shorter-first courses surface at the top of the results.
    .sort((a, b) => {
      const aZero = a.certification_hours <= 0;
      const bZero = b.certification_hours <= 0;
      if (aZero !== bZero) return aZero ? 1 : -1;
      return a.certification_hours - b.certification_hours;
    });
}

// ── IPC ────────────────────────────────────────────────────────
ipcMain.handle(IPC.STATE_GET, () => state);

ipcMain.on(IPC.VIEW_BOUNDS, (_evt, b: ViewBounds) => {
  if (!mainWindow || !elearnView) return;
  const [winW, winH] = mainWindow.getContentSize();
  const x = Math.max(0, Math.floor(b.x));
  const y = Math.max(0, Math.floor(b.y));
  const width = Math.min(winW - x, Math.floor(b.width));
  const height = Math.min(winH - y, Math.floor(b.height));
  elearnView.setBounds({ x, y, width, height });
});

ipcMain.on(IPC.NAVIGATE_VIEW, (_evt, url: string) => {
  if (!elearnView) return;
  elearnView.webContents.loadURL(url).catch(() => void 0);
});

ipcMain.on(IPC.ACTION_PAUSE, () => {
  state.status = "paused";
  state.pauseReason = "manual";
  log("info", "使用者手動暫停");
  pushState();
});

ipcMain.on(IPC.ACTION_RESUME, () => {
  state.status = "running";
  state.pauseReason = undefined;
  log("info", "使用者恢復");
  pushState();
});

ipcMain.on(IPC.ACTION_ABORT, () => {
  abortSignal.aborted = true;
  stopSessionWatchdog();
  state.status = "aborted";
  persistRun("aborted");
  log("info", "使用者中止");
  pushState();
  setTimeout(() => app.quit(), 300);
});

ipcMain.handle(IPC.STEALTH_STATUS, () => stealthCurrentState());
ipcMain.handle(IPC.STEALTH_UNLOCK, (_evt, secret: string) => stealthTryUnlock(secret));
ipcMain.handle(IPC.STEALTH_SET_SECRET, (_evt, secret: string) => stealthSetSecret(secret));
ipcMain.on(IPC.STEALTH_LOCK, () => stealthLock());
ipcMain.handle(IPC.STEALTH_CONFIG_PATH, () => join(app.getPath("userData"), "config.json"));

ipcMain.handle(IPC.GEMINI_KEY_GET, () => loadConfig().geminiApiKey ?? "");
ipcMain.handle(IPC.GEMINI_KEY_SET, (_evt, key: string) => {
  saveConfig({ geminiApiKey: key.trim() || undefined });
});
// Legacy: renderer 不應該再呼叫這個（直接在 React 內 setShowGeminiKey(true) 即可），
// 但為了 preload 對外的 api 形狀向後相容暫時保留 — 改成 forward 同個事件給
// renderer 自己處理。
ipcMain.on(IPC.OPEN_GEMINI_DIALOG, () => requestRendererGeminiDialog());

ipcMain.on(IPC.ACK_FIRST_RUN, () => {
  ackFirstRun();
  state.isFirstRun = false;
  pushState();
});

ipcMain.on(IPC.RENDERER_LOG, (_evt, payload: { level: "info" | "warn" | "error"; msg: string }) => {
  // Renderer 端 console.error / window 'error' / unhandledrejection 都走這條，
  // 也經過隱碼後寫到同一個 log 檔，這樣使用者一份檔給開發者就夠。
  if (!payload || typeof payload.msg !== "string") return;
  const lvl = payload.level === "warn" || payload.level === "error" ? payload.level : "info";
  appendLogLine(lvl, maskLog(payload.msg), "renderer");
});

ipcMain.on(IPC.OPEN_LOGS_FOLDER, () => {
  // getLogsDir() 每次呼叫都會 existsSync + mkdir 兜底；即使使用者手動刪過
  // logs 資料夾，這裡也會先重建一個空的，避免 File Explorer 跳「位置無法
  // 使用」的錯誤對話框（v0.6.7 dev 驗證時的災情）。
  // shell.openPath 失敗時會 resolve 一個 error 字串而不是 throw — 用 then
  // 把 error 寫進 log 檔，這樣即使開不起來，使用者下次傳 log 給開發者也看得到。
  const dir = getLogsDir();
  shell
    .openPath(dir)
    .then((err) => {
      if (err) appendLogLine("warn", `shell.openPath 失敗：${err}（路徑：${dir}）`);
    })
    .catch((e) => {
      appendLogLine(
        "warn",
        `shell.openPath 例外：${e instanceof Error ? e.message : String(e)}（路徑：${dir}）`,
      );
    });
});

ipcMain.handle(IPC.APP_VERSION_GET, () => app.getVersion());

ipcMain.on(IPC.RESUME_ANSWER, (_evt, resume: boolean) => {
  const prev = loadRun();
  if (!prev || !prev.pipelineCids.length) return;
  if (!resume) {
    clearRun();
    log("info", "使用者選擇不恢復上次進度");
    return;
  }
  log("info", `恢復上次中斷的進度（${prev.pipelineCids.length} 門）`);
  runPipelineFor(prev.pipelineCids).catch((e) =>
    log("error", `恢復 pipeline 失敗：${e instanceof Error ? e.message : String(e)}`),
  );
});

ipcMain.on(IPC.ACTION_BACK, async () => {
  abortSignal.aborted = true;
  stopSessionWatchdog();
  state.status = "selecting";
  state.pauseReason = undefined;
  state.now = { action: "idle" };
  state.pipelineCids = undefined;
  runningCids.clear();
  focusedCid = null;
  clearRun();
  log("info", "返回選課畫面");
  if (elearnView) elearnView.webContents.loadURL(HOMEPAGE).catch(() => void 0);
  await refreshCourses();
  pushState();
});

ipcMain.on(IPC.REFRESH_COURSES, () => {
  refreshCourses().catch(() => void 0);
});

ipcMain.handle(IPC.SEARCH_COURSES, async (_evt, payload: string | SearchOptions) => {
  try {
    // Backwards-compat: old renderer code may still pass a bare keyword string.
    const opts: SearchOptions = typeof payload === "string" ? { keyword: payload } : (payload ?? {});
    const results = await keywordSearch(opts);
    const human =
      opts.keyword || opts.mainCategoryId || opts.subCategoryId || opts.fromSchoolId
        ? `kw="${opts.keyword ?? ""}" cat=${opts.subCategoryId || opts.mainCategoryId || "-"} school=${opts.fromSchoolId || "-"}${
            opts.hoursMin || opts.hoursMax ? ` hr=${opts.hoursMin ?? 0}~${opts.hoursMax ?? "∞"}` : ""
          }`
        : "(全部)";
    log("info", `搜尋 ${human}: ${results.length} 筆`);
    return results;
  } catch (e) {
    log("error", `搜尋失敗：${e instanceof Error ? e.message : String(e)}`);
    return [] as CourseCandidate[];
  }
});

ipcMain.handle(IPC.CATEGORY_CHILDREN, async (_evt, parentId: string) => {
  if (!elearnView) return [];
  if (!parentId || !parentId.trim()) return [];
  try {
    const session = elearnView.webContents.session;
    const children = await getCategoryChildren(session, parentId.trim());
    return children;
  } catch (e) {
    log("warn", `次類別取得失敗 (${parentId})：${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
});

ipcMain.handle(IPC.SEARCH_BY_CODES, async (_evt, codes: string[]) => {
  if (!elearnView) return [] as CourseCandidate[];
  const session = elearnView.webContents.session;
  const clean = Array.from(new Set((codes || []).map((c) => String(c).trim()).filter(Boolean)));
  if (clean.length === 0) return [] as CourseCandidate[];

  const resolved = resolveAgencyCodes(clean);
  const known = resolved.filter((r) => r.resolution);
  const unknown = resolved.filter((r) => !r.resolution).map((r) => r.input);
  if (unknown.length) {
    log("warn", `代碼 ${unknown.join(", ")} 沒有對應分類，已略過（如需支援請更新 agency-code-map）`);
  }
  if (known.length === 0) return [] as CourseCandidate[];

  const groups = groupByCategory(known);
  log(
    "info",
    `用代碼搜尋：${clean.join(", ")} → ${groups
      .map((g) => `${g.labels.join("/")} (cat=${g.categoryId})`)
      .join("; ")}`,
  );

  const byCid = new Map<string, Course>();
  const mineCids = new Set(state.courses.map((c) => c.cid));

  // Search ignores abortSignal — that flag is for the pipeline only, and a
  // stale-true value (set by 返回選課) would otherwise silently skip every
  // search request until the next pipeline starts.
  let codeAuthFailed = false;
  for (const g of groups) {
    if (codeAuthFailed) break;
    try {
      await primeExplorer(session, g.categoryId);
      // Broad sweep first (empty keyword returns whole category).
      const broad = await searchCourses(session, g.categoryId, "", 50);
      log("info", `  cat=${g.categoryId} broad sweep: ${broad.length} 筆 (isClassing=${broad.filter((c) => c.isClassing).length})`);
      for (const r of broad) if (!byCid.has(r.cid)) byCid.set(r.cid, r);
      // If the group narrows by specific keywords, also run those to pick up sub-topics
      // the broad sweep may have truncated at 50.
      for (const kw of g.keywords) {
        const results = await searchCourses(session, g.categoryId, kw, 50);
        log("info", `  cat=${g.categoryId} kw="${kw}": ${results.length} 筆`);
        for (const r of results) if (!byCid.has(r.cid)) byCid.set(r.cid, r);
      }
    } catch (e) {
      if (e instanceof ElearnAuthError) {
        codeAuthFailed = true;
        log("error", `${g.labels.join("/")} (cat=${g.categoryId}) 查詢失敗：${e.message}`);
      } else {
        log(
          "warn",
          `${g.labels.join("/")} (cat=${g.categoryId}) 查詢失敗：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
  log("info", `  併集 byCid: ${byCid.size} 筆 (isClassing=${Array.from(byCid.values()).filter((c) => c.isClassing).length})`);

  // Post-filter: a 專區 categoryId like AI_ZONE (540-546) spans multiple sub-topics
  // (基礎認知 / 生成式 / 公務應用 / 導入 / 產業應用). When the user passed specific
  // sub-codes, we only want courses in those sub-topics. Strategy: if ANY group in
  // this search narrowed by keywords, a result must match at least one keyword from
  // the groups that share its categoryId. Groups with no keywords impose no filter.
  const allKeywords = groups.flatMap((g) => g.keywords);
  const anyKeywordRequested = allKeywords.length > 0;
  const allLabels = groups.flatMap((g) => g.labels);
  const anyGroupWantsEverything = groups.some((g) => g.keywords.length === 0);

  const applyPostFilter = (pool: Map<string, Course>): CourseCandidate[] =>
    Array.from(pool.values())
      .filter((c) => c.isClassing)
      .filter((c) => {
        if (!anyKeywordRequested) return true; // all groups are broad — keep everything
        if (anyGroupWantsEverything) return true; // mixed: at least one group has no kw, so keep all
        const haystack = `${c.caption} ${c.category_full_path ?? ""} ${c.content ?? ""}`;
        // Match by keyword first, then by label (label lets the user say "all 環境教育" with no filter)
        return allKeywords.some((k) => haystack.includes(k)) || allLabels.some((l) => haystack.includes(l));
      })
      .map<CourseCandidate>((c) => ({
        cid: c.cid,
        caption: c.caption,
        certification_hours: c.certification_hours,
        fromSchoolName: c.fromSchoolName,
        studentTargetTypeCaption: c.studentTargetTypeCaption,
        category_full_path: c.category_full_path,
        classPeriod: c.classPeriod,
        isClassing: !!c.isClassing,
        already_enrolled: mineCids.has(c.cid),
      }))
      .sort((a, b) => {
        const aZero = a.certification_hours <= 0;
        const bZero = b.certification_hours <= 0;
        if (aZero !== bZero) return aZero ? 1 : -1;
        return a.certification_hours - b.certification_hours;
      });

  let out = applyPostFilter(byCid);
  log("info", `代碼搜尋共 ${out.length} 筆`);

  // Fallback: if the category-scoped sweep + post-filter produced nothing,
  // retry as a plain site-wide keyword search. The agency code → categoryId
  // mapping rots (courses get moved between categories on the elearn side),
  // so a keyword like "職場霸凌" may live outside the originally-mapped
  // 人權教育 category. The site-wide search box itself can still find them.
  if (out.length === 0 && anyKeywordRequested && !codeAuthFailed) {
    const fallbackTerms = Array.from(new Set([...allKeywords, ...allLabels])).filter(Boolean);
    for (const term of fallbackTerms) {
      try {
        const results = await searchCourses(session, "", term, 100);
        log("info", `  fallback 全站 kw="${term}": ${results.length} 筆`);
        for (const r of results) if (!byCid.has(r.cid)) byCid.set(r.cid, r);
      } catch (e) {
        if (e instanceof ElearnAuthError) {
          codeAuthFailed = true;
          log("error", `fallback "${term}" 失敗：${e.message}`);
          break;
        }
        log("warn", `fallback "${term}" 失敗：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    out = applyPostFilter(byCid);
    log("info", `代碼搜尋(fallback)共 ${out.length} 筆`);
  }
  if (codeAuthFailed) {
    log("warn", "搜尋過程偵測到 session 失效。請等待自動重登後再試一次。");
  }

  return out;
});

ipcMain.handle(IPC.UNENROLL_COURSE, async (_evt, cid: string) => {
  const card = state.courses.find((c) => c.cid === cid);
  const name = card?.name ?? cid;
  log("info", `嘗試退選：${name}`);
  const res = await unenrollCourse(cid);
  if (res.ok) {
    log("info", `退選完成：${name}`);
    await refreshCourses();
  } else {
    log("warn", `退選失敗 ${name}：${res.error ?? "unknown"}`);
  }
  return res;
});

ipcMain.handle(IPC.CREDS_STATUS, (): CredentialsStatus => {
  const c = loadCredentials();
  if (!c) return { saved: false };
  return {
    saved: true,
    maskedAccount: maskAccount(c.account),
    savedAt: c.savedAt,
    lastUsedAt: c.lastUsedAt,
  };
});

ipcMain.on(IPC.CREDS_SAVE_ANSWER, (_evt, save: boolean) => {
  if (!pendingSniffed) return;
  if (!save) {
    log("info", "使用者選擇不儲存帳密");
    pendingSniffed = null;
    return;
  }
  const toSave: SavedCredentials = {
    account: pendingSniffed.account,
    password: pendingSniffed.password,
    savedAt: new Date().toISOString(),
  };
  const res = saveCredentials(toSave);
  if (res.ok) {
    log("info", `已儲存帳密（${maskAccount(toSave.account)}），下次 session 過期可自動重登`);
  } else {
    log("warn", `儲存帳密失敗：${res.reason ?? "unknown"}`);
  }
  pendingSniffed = null;
});

ipcMain.on(IPC.CREDS_FORGET, async () => {
  // 「忘記帳號」現在等於一次完整切換到「沒帳號」狀態：把 pipeline / watchdog /
  // BrowserView session 一起清掉，回到 setup 畫面。沒做這件事 → 上次的
  // pipeline 還在背景跑、BrowserView cookies 還是舊帳號 → UI 顯示「登入」
  // 但點不動的鎖死狀況（v0.7.5 修法）。
  await performAccountSwitch({ wipeSession: true });
  log("info", "已清除儲存的帳密");
});

ipcMain.handle(
  IPC.CREDS_SWITCH_ACCOUNT,
  async (_evt, payload?: SwitchAccountPayload): Promise<SwitchAccountResult> => {
    try {
      return await performAccountSwitch(payload ?? {});
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      log("error", `切換帳號失敗：${reason}`);
      // Don't leave state mid-transition: drop to setup so the user has a
      // working entry point even on failure.
      state.status = "setup";
      pushState();
      return { ok: false, reason };
    }
  },
);

ipcMain.handle(
  IPC.CREDS_SAVE_MANUAL,
  (_evt, payload: { account: string; password: string }) => {
    const account = (payload?.account ?? "").trim();
    const password = payload?.password ?? "";
    if (!account || !password) {
      return { ok: false, reason: "帳號或密碼為空" };
    }
    const toSave: SavedCredentials = {
      account,
      password,
      savedAt: new Date().toISOString(),
    };
    const res = saveCredentials(toSave);
    if (res.ok) {
      log("info", `已手動儲存帳密（${maskAccount(account)}）`);
      // First-run setup: transition to await_login and kick off auto-login
      if (state.status === "setup") {
        state.status = "await_login";
        pushState();
        void tryAutoLogin().catch(() => void 0);
      }
    }
    return res;
  },
);

ipcMain.on(IPC.PIPELINE_START, (_evt, cids: string[]) => {
  if (!Array.isArray(cids) || cids.length === 0) {
    log("warn", "沒有選取任何課程");
    return;
  }
  // Capture unique cids only
  const unique = Array.from(new Set(cids.filter((c) => typeof c === "string" && c)));
  log("info", `啟動 pipeline：${unique.length} 門課`);
  runPipelineFor(unique).catch((e) =>
    log("error", `Pipeline 執行失敗：${e instanceof Error ? e.message : String(e)}`),
  );
});

export { bus, state, log, pushState };

// ── App lifecycle ─────────────────────────────────────────────
// Single-instance lock: launching Noteqad.exe while it's already running should
// just focus the existing window, not spawn a second process. Before we had
// this, 10+ zombie processes piled up during testing — each with its own
// BrowserWindow overlapping the others, which looked like "double title bars".
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // v0.6.7：原本第二個 instance 會 popup native 對話框告訴使用者「已經開過了」，
  // 但那個 native dialog 在多螢幕環境會跑到別的 monitor，看起來跟「閃退」一模一樣
  // — 反而更糟。
  //
  // 改成第二個 instance 直接靜默 quit，由第一個 instance 的 second-instance
  // handler 把它已有的視窗 restore + focus + flashFrame，使用者看到的是
  //「我點兩下 .exe，現有視窗自己跳出來閃了一下」— 完全合理的 UX，不會誤判閃退。
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    // 工作列圖示閃 2 秒讓使用者一眼看到「我剛點的那次跑這裡來了」。
    mainWindow.flashFrame(true);
    setTimeout(() => mainWindow?.flashFrame(false), 2000);
  });

  // Any path that calls app.quit() (tray "結束", ACTION_ABORT, OS shutdown)
  // routes through before-quit. Setting the flag here lets the close handler
  // fall through instead of hiding the window again.
  app.on("before-quit", () => {
    isQuittingForReal = true;
  });

  app.on("will-quit", () => {
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });

  app.whenReady().then(() => {
    electronApp.setAppUserModelId("tw.kevin.auto-elearn");

    // 必須在任何讀寫 userData 的程式碼（hasSavedCredentials / loadConfig /
    // db.ts / loadRun 等）之前跑：v0.5.x 的舊資料夾複製到 v0.6.x 的新位置。
    // 否則升級的使用者會被當成「全新使用者」，要重設帳密 + 偽裝密碼。
    const mig = migrateFromOldUserDataIfNeeded();

    // crash handler 已在模組載入時 install；現在 app ready 了，把 log 路徑
    // 從 OS 暫存目錄切回正規的 userData/logs/。
    rebindLogsDirToUserData();

    if (mig.ranThisLaunch) {
      log(
        "info",
        `偵測到 v0.5.x 舊資料夾，已搬到新位置：` +
          `成功 ${mig.migrated.length} 個（${mig.migrated.join(", ") || "—"}）` +
          (mig.skippedAlreadyExists.length
            ? `；跳過已存在 ${mig.skippedAlreadyExists.length} 個`
            : "") +
          (mig.failed.length ? `；失敗 ${mig.failed.length} 個` : ""),
      );
      for (const f of mig.failed) {
        log("warn", `搬家失敗：${f.file} — ${f.reason}`);
      }
    } else {
      // 不是從 v0.5.x 升上來，或之前已經遷移過 — 不洗版，輕量記一筆方便除錯
      appendLogLine("info", `userData 路徑：${app.getPath("userData")}（無需遷移）`);
    }

    app.on("browser-window-created", (_, w) => optimizer.watchWindowShortcuts(w));
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  // We hide-to-tray instead of closing on the X button, so window-all-closed
  // only fires when the app is genuinely shutting down (tray "結束" / ACTION_ABORT).
  // Quit only when isQuittingForReal is set; otherwise stay alive in the tray.
  if (!isQuittingForReal) return;
  if (process.platform !== "darwin") app.quit();
});
