import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  Menu,
  Tray,
  nativeImage,
  screen,
  session as sessionModule,
  type Session,
} from "electron";
import { join } from "node:path";
import { writeFileSync, existsSync, mkdirSync, writeFileSync as fsWriteFileSync } from "node:fs";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";

import {
  IPC,
  type AccountOpResult,
  type AccountSummary,
  type AppState,
  type AppStatus,
  type AutoLoginProgress,
  type CourseCandidate,
  type CourseCard,
  type MultiInfo,
  type MultiMode,
  type ResumePrompt,
  type SearchOptions,
  type ViewBounds,
} from "../shared/ipc";
import { createBus } from "./bus";
import {
  attachElearnView,
  autoLoginInView,
  detachElearnView,
  detectLogin,
  dismissNuisancePopups,
  hideElearnView,
} from "./browser/view";
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
import { extractTicket } from "./heartbeat/reader";
import { attachLoginSniffer, type SniffedCredentials } from "./auth/login-sniffer";
import { loginViaEcpa, resolveAlias } from "./auth/ecpa-login";
import { isSessionAlive } from "./auth/session-watchdog";
import { clearRun, loadRun, saveRun } from "./persist/run-state";
import { solveExam } from "./exam/solver";
import { fillSurvey } from "./survey/filler";
import {
  prefetchCoursesViaWebBank,
  bulkPrefetchBankIndex,
  type PrefetchResult,
} from "./exam/web-bank";
import {
  clearSecret as stealthClearSecret,
  currentState as stealthCurrentState,
  lock as stealthLock,
  setSecret as stealthSetSecret,
  tryUnlock as stealthTryUnlock,
} from "./stealth/stealth";
import { maskAccount, maskName, maskSecretsInString } from "../shared/mask";
import {
  appendLogLine,
  getLogsDir,
  installCrashHandlers,
  rebindLogsDirToUserData,
} from "./log/file-logger";
import { migrateFromOldUserDataIfNeeded } from "./persist/migrate-userdata";
import { getStorageDir, storagePath } from "./persist/storage-paths";
import { migrateUserDataToPortableIfNeeded } from "./persist/migrate-portable";
import { groupByCategory, resolveAgencyCodes } from "./course/agency-code-map";
import { randomBytes } from "node:crypto";
import { msUntilNextMidnight, runPurge } from "./cleanup/purge";

// ── 多帳號模組 ─────────────────────────────────────────────────
import {
  type AccountSession,
  clearPartitionDataFor,
  createInitialState,
  deregisterSession,
  getActiveId,
  getActiveSession,
  getSession,
  hasSession,
  listSessions,
  partitionIdFor,
  registerSession,
  setActiveId,
} from "./account/manager";
import {
  type AccountRecord,
  type SavedAccountCreds,
  clearAllAccounts as clearAllAccountRecords,
  computeAccountId,
  getAccount,
  getLastActiveId,
  listAccounts,
  loadAccountCreds,
  removeAccount as removeAccountRecord,
  saveAccountCreds,
  setLastActive,
  setNickname as setNicknameStored,
  setPinFor,
  touchLastUsed,
  upsertAccount,
} from "./account/storage";
import { hashPin, newSalt, validatePinFormat, verifyPin } from "./account/pin";

// ── Crash handler ───────────────────────────────────────────────
// 必須在 app.whenReady 之前 install — 模組載入階段就可能因為 native 模組
// （better-sqlite3 / bindings 等）打不開或被防毒砍掉而炸 "Cannot find module"，
// 沒早 install 的話那種噴在 dialog 上的 error 不會留下任何 log。
installCrashHandlers((s) => {
  try {
    return maskLog(s);
  } catch {
    return s;
  }
});

// ── 共用常數 ──────────────────────────────────────────────────
const HEARTBEAT_PARALLEL_MAX = 50;
const HEARTBEAT_INTERVAL_MS = 300_000;
const HEARTBEAT_JITTER_MS = 1000;
const ENROLL_DELAY_MS = 1000;
const HOMEPAGE = "https://elearn.hrd.gov.tw/mooc/index.php";
const ECPA_LOGIN_URL = "https://ecpa.dgpa.gov.tw/uIAM/clogin.asp?destid=CrossHRD";

/** Known category IDs from site exploration — used for keyword search fan-out. */
const KNOWN_CATEGORIES = [
  "10040389",
  "10036100",
  "10027390",
  "10027389",
  "10027913",
  "10007170",
  "10011548",
  "10007169",
  "10014384",
  "10023342",
];

// ── App-wide globals ───────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuittingForReal = false;
let purgeTimer: NodeJS.Timeout | null = null;
const bus = createBus();

// 多帳號 UI 模式
let multiMode: MultiMode = "boot";
let pinTarget: {
  id: string;
  nickname: string;
  maskedAccount: string;
  failedAttempts?: number;
} | null = null;
let resetPinState: {
  id: string;
  nickname: string;
  stage: "verify" | "set";
  failedAttempts?: number;
} | null = null;
let postLoginState: { id: string; suggestedNickname?: string } | null = null;
/** 「+ 新增帳號」流程：尚未持久化的 session id（random）；登入成功後會 re-key 成 account-derived id */
let pendingNewSessionId: string | null = null;

/**
 * v0.8.7+v0.8.8：跨帳號的課程擁有權 + 排隊。
 *
 * 為什麼需要鎖：實測同一堂課被 2 個帳號同時 heartbeat → server 端 SCORM session
 * 互相打掉，先進場的 reading time 歸零。
 *
 * 為什麼不能直接擋（v0.8.7 做法）：「多人同時刷課」是核心功能 — 後進場的不能
 * 直接被標完成跳過，要等先進場的做完才上。
 *
 * 設計：
 *  - courseOwners: cid → 目前擁有者
 *  - acquireCourseOwnership(cid, s) → ok 拿到了 / 失敗回傳被誰佔
 *  - releaseAllCoursesForAccount(s.id) → 釋放這個帳號佔的課程
 *  - 排隊用 caller-side polling（runPipelineFor 每 15s 重 acquire），不靠 event-driven
 *    resolver，pipeline 邏輯比較好讀；缺點是 release 後最多等 15s 才換手
 */
const courseOwners = new Map<
  string,
  { accountId: string; nickname: string; startedAt: number }
>();

function acquireCourseOwnership(
  cid: string,
  s: AccountSession,
): { ok: boolean; takenBy?: string } {
  const existing = courseOwners.get(cid);
  if (existing && existing.accountId !== s.id) {
    return { ok: false, takenBy: existing.nickname };
  }
  courseOwners.set(cid, {
    accountId: s.id,
    nickname: s.record.nickname,
    startedAt: Date.now(),
  });
  return { ok: true };
}

function releaseAllCoursesForAccount(accountId: string): void {
  for (const [cid, info] of Array.from(courseOwners)) {
    if (info.accountId === accountId) courseOwners.delete(cid);
  }
}

function releaseCourseOwnership(cid: string, accountId: string): void {
  const existing = courseOwners.get(cid);
  if (existing?.accountId === accountId) courseOwners.delete(cid);
}

function runScheduledPurge(reason: "startup" | "midnight"): void {
  try {
    const report = runPurge();
    const deleted =
      report.logsDeleted +
      report.tempDeleted +
      report.debugHistoryDeleted +
      report.runStateDeleted;
    const summary =
      deleted === 0
        ? `🧹 purge(${reason})：無需清理`
        : `🧹 purge(${reason})：共清 ${deleted} 個檔案（logs ${report.logsDeleted}、temp ${report.tempDeleted}、history ${report.debugHistoryDeleted}、run-state ${report.runStateDeleted}）`;
    appendLogLine("info", summary);
    if (report.errors.length > 0) {
      appendLogLine("warn", `🧹 purge(${reason}) 錯誤 ${report.errors.length} 筆：${report.errors.join(" | ")}`);
    }
  } catch (e) {
    appendLogLine(
      "error",
      `🧹 purge(${reason}) 失敗：${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function scheduleNextMidnightPurge(): void {
  if (purgeTimer) clearTimeout(purgeTimer);
  purgeTimer = setTimeout(() => {
    runScheduledPurge("midnight");
    scheduleNextMidnightPurge();
  }, msUntilNextMidnight());
}

/** Renderer 推來的 active view bounds */
let lastBounds: ViewBounds = { x: 0, y: 0, width: 0, height: 0 };

/** 還沒 active session 時的 log 暫存（picker / 啟動時用） */
const _bootstrapLogs: AppState["logs"] = [];

/** 全域隱碼名單。每個帳號加進來時會 push 自己的 account / 顯示名稱。 */
const _logSecrets: Array<{ value: string; masked: string }> = [];
function pushSecretToMaskList(value: string | undefined | null, masked: string) {
  if (!value || value.length < 2) return;
  if (_logSecrets.some((s) => s.value === value)) return;
  _logSecrets.push({ value, masked });
}
function maskLog(msg: string): string {
  return maskSecretsInString(msg, _logSecrets);
}

// ── First run 標記 ─────────────────────────────────────────────
function firstRunFlagPath(): string {
  return storagePath(".first-run-acked");
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
    const dir = getStorageDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    fsWriteFileSync(firstRunFlagPath(), new Date().toISOString(), "utf8");
  } catch {
    /* swallow */
  }
}

// ── Log helpers ───────────────────────────────────────────────
type LogLevel = "info" | "warn" | "error";

function logSession(s: AccountSession, level: LogLevel, msg: string) {
  const safe = maskLog(msg);
  s.state.logs.push({ ts: Date.now(), level, msg: safe });
  if (s.state.logs.length > 200) s.state.logs.splice(0, s.state.logs.length - 200);
  if (s.id === getActiveId()) pushState();
  // eslint-disable-next-line no-console
  console.log(`[${s.record.nickname || s.id.slice(0, 6)}][${level}] ${msg}`);
  appendLogLine(level, `[${s.record.nickname || s.id.slice(0, 6)}] ${safe}`);
}

function logGlobal(level: LogLevel, msg: string) {
  const safe = maskLog(msg);
  const active = getActiveSession();
  if (active) {
    active.state.logs.push({ ts: Date.now(), level, msg: safe });
    if (active.state.logs.length > 200)
      active.state.logs.splice(0, active.state.logs.length - 200);
  } else {
    _bootstrapLogs.push({ ts: Date.now(), level, msg: safe });
    if (_bootstrapLogs.length > 200)
      _bootstrapLogs.splice(0, _bootstrapLogs.length - 200);
  }
  pushState();
  // eslint-disable-next-line no-console
  console.log(`[${level}] ${msg}`);
  appendLogLine(level, safe);
}

setGeminiLogger((m) => logGlobal("warn", `[gemini] ${m}`));

// ── State pushing ─────────────────────────────────────────────
function buildMultiInfo(): MultiInfo {
  const records = listAccounts();
  const activeId = getActiveId();
  const summaries: AccountSummary[] = records.map((r) => {
    const sess = getSession(r.id);
    return {
      id: r.id,
      nickname: r.nickname,
      maskedAccount: r.maskedAccount,
      isOpen: !!sess,
      isActive: r.id === activeId,
      status: sess?.state.status,
      pipelineRunning: sess?.pipelineRunning ?? false,
      // v0.8.1：locked 旗標讓 UI 顯示 🔒 icon；未 isOpen 的不掛此欄位
      // v0.8.2：套用 grace — grace 過期等同 locked（切過去要 PIN）
      locked: sess ? !isWithinPinGrace(sess) : undefined,
      doneCount: sess?.state.stats.done,
      totalCount: sess?.state.stats.total,
      lastUsedAt: r.lastUsedAt,
    };
  });
  // sort picker: lastUsedAt desc，沒記錄的最後
  summaries.sort((a, b) => {
    const aT = a.lastUsedAt ?? "";
    const bT = b.lastUsedAt ?? "";
    if (aT === bT) return a.nickname.localeCompare(b.nickname);
    return bT.localeCompare(aT);
  });

  // tabs：所有 open 的 session（含 pending new account）。Pending 用合成 summary。
  const tabs: AccountSummary[] = [];
  for (const s of listSessions()) {
    if (pendingNewSessionId === s.id && !getAccount(s.id)) {
      tabs.push({
        id: s.id,
        nickname: "新增中…",
        maskedAccount: "—",
        isOpen: true,
        isActive: s.id === activeId,
        status: s.state.status,
        pipelineRunning: false,
      });
      continue;
    }
    const sum = summaries.find((x) => x.id === s.id);
    if (sum) tabs.push(sum);
  }

  return {
    mode: multiMode,
    pickerAccounts: summaries,
    tabs,
    activeAccountId: activeId,
    pinTarget: pinTarget ?? undefined,
    resetPin: resetPinState ?? undefined,
    postLogin: postLoginState ?? undefined,
  };
}

function pushState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const active = getActiveSession();
  const merged: AppState = active
    ? { ...active.state, isFirstRun: isFirstRun(), multi: buildMultiInfo() }
    : {
        ...createInitialState(),
        logs: _bootstrapLogs.slice(),
        isFirstRun: isFirstRun(),
        multi: buildMultiInfo(),
      };
  mainWindow.webContents.send(IPC.STATE_PUSH, merged);
}

function emitAutoLogin(s: AccountSession, p: AutoLoginProgress) {
  // 只有 active session 的進度才推給 UI
  if (s.id !== getActiveId()) return;
  mainWindow?.webContents.send(IPC.AUTOLOGIN_PROGRESS, p);
}

// ── AccountSession lifecycle ─────────────────────────────────
function makeSession(opts: {
  id: string;
  record: AccountRecord;
  account: string;
  password: string;
  startUrl: string;
}): AccountSession {
  if (!mainWindow) throw new Error("makeSession: mainWindow not ready");
  const partitionId = partitionIdFor(opts.id);
  const session: AccountSession = {
    id: opts.id,
    record: opts.record,
    account: opts.account,
    password: opts.password,
    partitionId,
    view: null,
    state: createInitialState(),
    abortSignal: { aborted: false },
    // v0.8.3：暫停旗標跟 abort 分開 — abort=不可逆終止，pause=可恢復暫停
    pauseSignal: { paused: false },
    // v0.8.7：剛退選但 server 還沒同步 / runPipelineFor 不要 auto re-enrol 的 cid
    recentlyUnenrolled: new Set<string>(),
    pipelineRunning: false,
    runningCids: new Set(),
    focusedCid: null,
    pendingSniffed: null,
    // v0.8.1：fresh session 預設 unlocked（建立 session 一定是剛通過 PIN/剛新增）
    unlocked: true,
    // v0.8.2：5-min grace 起點
    lastUnlockedAt: Date.now(),
    autoLoginInFlight: false,
    reloginInFlight: false,
    logoutHandlingInFlight: false,
    watchdogTimer: null,
    loginWatchdogTimer: null,
    consecutiveDeadChecks: 0,
    loginMissCount: 0,
    setupFallbackTimer: null,
    lastStatusChangeAt: Date.now(),
    lastObservedStatus: "boot",
    onDestroy: [],
  };

  const view = attachElearnView(
    mainWindow,
    opts.startUrl,
    (reason) => {
      void handleBrowserViewLogout(session, reason).catch(() => void 0);
    },
    {
      partition: partitionId,
      // 跨 domain 導航記到 per-session log，供使用者 / 開發者定位 hahow 登入上限
      // 頁面的真實 URL（BrowserView 沒有網址列）+ 自然人 SSO 的 redirect chain。
      navLogger: (msg) => logSession(session, "warn", msg),
      // v0.8.4：偵測到 hahow 限制頁時自動點繼續 + 暫停其他帳號的 heartbeat
      onHahowLimitHit: (info) => {
        void handleHahowLimitHit(session, info).catch((e) =>
          logSession(session, "error", `hahow 限制頁處理例外：${(e as Error)?.message ?? e}`),
        );
      },
    },
  );
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  view.setAutoResize({ width: false, height: false });
  session.view = view;

  if (opts.account) pushSecretToMaskList(opts.account, maskAccount(opts.account));

  const detachSniffer = attachLoginSniffer(view.webContents.session, (creds) => {
    handleSnifferCapture(session, creds);
  });
  session.onDestroy.push(detachSniffer);

  // v0.8.5：partition cookie 診斷 — 確認 persist:elearn-<id> 在重啟後有沒有保留
  // hahow / elearn 的 session 識別。如果每次都回 0 → partition 沒持久化（不太可
  // 能，但要排除）。如果每次都 fresh device-id → hahow 不認 partition。
  void diagnosePartitionCookies(session).catch(() => void 0);

  startDetectLogin(session);
  registerSession(session);
  return session;
}

async function diagnosePartitionCookies(s: AccountSession): Promise<void> {
  if (!s.view) return;
  try {
    const sess = s.view.webContents.session;
    const elearnCookies = await sess.cookies.get({ domain: "elearn.hrd.gov.tw" }).catch(() => []);
    const hahowCookies = await sess.cookies.get({ domain: "hahow.in" }).catch(() => []);
    const hahowTwCookies = await sess.cookies.get({ domain: "hahow.tw" }).catch(() => []);
    const idx = elearnCookies.find((c) => c.name === "idx");
    const allHahow = [...hahowCookies, ...hahowTwCookies];
    logSession(
      s,
      "info",
      `[partition ${s.partitionId}] elearn idx=${idx?.value ? "yes" : "no"}, hahow cookies=${allHahow.length}${
        allHahow.length > 0 ? ` (${allHahow.map((c) => c.name).join(",")})` : ""
      }`,
    );
  } catch (e) {
    logSession(s, "warn", `partition cookie 診斷失敗：${(e as Error)?.message ?? e}`);
  }
}

async function destroySession(s: AccountSession): Promise<void> {
  s.abortSignal.aborted = true;
  s.pipelineRunning = false;
  // v0.8.7+v0.8.8：釋放佔住的課程，叫醒 queue 第一個帳號接手
  releaseAllCoursesForAccount(s.id);
  if (s.watchdogTimer) {
    clearInterval(s.watchdogTimer);
    s.watchdogTimer = null;
  }
  if (s.loginWatchdogTimer) {
    clearInterval(s.loginWatchdogTimer);
    s.loginWatchdogTimer = null;
  }
  if (s.setupFallbackTimer) {
    clearTimeout(s.setupFallbackTimer);
    s.setupFallbackTimer = null;
  }
  for (const fn of s.onDestroy) {
    try {
      fn();
    } catch {
      /* swallow */
    }
  }
  s.onDestroy = [];
  if (s.view && mainWindow) {
    detachElearnView(mainWindow, s.view);
  }
  s.view = null;
  s.runningCids.clear();
  s.focusedCid = null;
  deregisterSession(s.id);
}

/** v0.8.2：5 分鐘 PIN grace。輸過 PIN 在這個區間內切換 tab 不需要重輸。 */
const PIN_GRACE_MS = 5 * 60 * 1000;

function isWithinPinGrace(s: AccountSession): boolean {
  return s.unlocked && Date.now() - s.lastUnlockedAt < PIN_GRACE_MS;
}

// v0.8.4：hahow 「登入數量上限」處理。
//
// 背景：hahow for business 限制同帳號最多 2 個裝置同時登入；每個 partition 都被
// 視為獨立裝置，第 3 個帳號 SCORM 跳到 hahow 課時撞到 limit 頁。沒處理會卡住整
// 個 chain，且舊裝置的 SCORM session 被 server 砍 → 進度歸零。
//
// 全域 in-flight 旗：3 個帳號同時撞到 limit 頁時，避免每個各自跑 click + pause-others
// 演成踢自己。處理 8 秒內只允許一個 session 進入處理流程。
let hahowEvictionInFlight = false;
const HAHOW_AUTO_RESUME_MS = 30_000;

async function handleHahowLimitHit(
  s: AccountSession,
  info: {
    click: () => Promise<{
      clicked: boolean;
      buttonText?: string;
      unsafeButtonFound?: boolean;
      pageButtons?: string[];
    }>;
    navUrl: string;
  },
): Promise<void> {
  if (hahowEvictionInFlight) {
    logSession(s, "warn", `🟠 hahow 限制頁（已有別 tab 在處理中，跳過）：${info.navUrl}`);
    return;
  }
  hahowEvictionInFlight = true;
  setTimeout(() => {
    hahowEvictionInFlight = false;
  }, 8000);

  logSession(s, "warn", `🟠 hahow 偵測到「登入數量上限」頁：${info.navUrl}`);

  // Step 1：嚴格只點「登出其他裝置」這類安全按鈕；點「繼續/使用此裝置」會踢掉
  // 我們自己的 SCORM heartbeat hidden window → 進度直接歸零（v0.8.4 撞過的坑）。
  const result = await info.click();
  if (result.clicked) {
    logSession(
      s,
      "info",
      `▶ 已點「${result.buttonText ?? "?"}」（明確只踢其他裝置），3 秒後 reload 此頁恢復狀態`,
    );
    // 3 秒後 reload 當前 view URL — hahow 點完通常會自動 redirect，但 redirect
    // 失敗時 reload 是保險。
    setTimeout(() => {
      try {
        s.view?.webContents.reload();
      } catch {
        /* swallow */
      }
    }, 3000);
  } else {
    const dump =
      result.pageButtons && result.pageButtons.length > 0
        ? `\n      頁面上的按鈕：${result.pageButtons.map((b) => `「${b}」`).join(" ")}`
        : "";
    if (result.unsafeButtonFound) {
      logSession(
        s,
        "error",
        `❌ hahow limit 頁只有「繼續/使用此裝置」按鈕（會踢掉我們自己 SCORM window 造成課程重置），刻意不點。請手動處理或回報以下按鈕清單：${dump}`,
      );
    } else {
      logSession(
        s,
        "error",
        `❌ hahow limit 頁認不出按鈕，請手動點「登出其他裝置」並截圖回報。${dump}`,
      );
    }
  }

  // Step 2：把其他 session 全部暫停（reactive — 哪個是真的被踢的不知道，全停穩）
  // 30 秒後自動 resume，下次 heartbeat 失敗時 v0.8.1 reauthFn 會自動補登 + 重抽
  // ticket，session 就回來了。
  const pausedIds: string[] = [];
  for (const other of listSessions()) {
    if (other.id === s.id) continue;
    if (!other.pipelineRunning) continue;
    if (other.pauseSignal.paused) continue; // 使用者已自己暫停，不要再插手
    other.pauseSignal.paused = true;
    pausedIds.push(other.id);
    logSession(
      other,
      "warn",
      "⚠ 另一個帳號剛搶下 hahow 裝置位置，這個帳號可能被踢；暫停 heartbeat 30 秒",
    );
  }

  // Step 3：30 秒後自動 resume — 下次心跳失敗時 reauthFn 會重抽 ticket
  if (pausedIds.length > 0) {
    setTimeout(() => {
      for (const id of pausedIds) {
        const target = getSession(id);
        if (!target) continue;
        // 使用者可能在這 30s 內已經手動 resume 或 abort，那不要動
        if (target.abortSignal.aborted) continue;
        if (!target.pauseSignal.paused) continue;
        target.pauseSignal.paused = false;
        logSession(
          target,
          "info",
          "▶ 自動恢復 hahow 暫停（被踢的話下次心跳失敗會自動重登 + 重抽 ticket）",
        );
      }
    }, HAHOW_AUTO_RESUME_MS);
  }
}

/**
 * v0.8.3：暫停 gate。chain 的 exam/survey 步驟、heartbeat engine 在 step 邊界呼叫
 * 這個函式：paused=true 時 sleep 500ms 重檢，直到 false 或 aborted。
 *
 * 設計刻意「step boundary」而非「中斷 in-flight 操作」 —— 暫停的 semantic 是
 * 「暫停接著做下一步」，不是「立刻砍掉現在這題」。砍掉題目會 corrupt exam 狀態
 * （server 已記 partial answer，下次重來算第幾次 attempt 不準）。
 *
 * 回傳 true = should continue（unpaused 且未 abort），false = aborted（caller 應停）
 */
async function awaitNotPaused(s: AccountSession): Promise<boolean> {
  if (s.abortSignal.aborted) return false;
  if (!s.pauseSignal.paused) return true;
  logSession(s, "info", "⏸ 暫停中，等使用者按「繼續」...");
  while (s.pauseSignal.paused && !s.abortSignal.aborted) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!s.abortSignal.aborted) {
    logSession(s, "info", "▶ 已恢復");
  }
  return !s.abortSignal.aborted;
}

function setActiveSessionAndShow(id: string | null): void {
  // v0.8.2：切換 tab 不再 auto-lock 前一個（v0.8.1 行為太擾人，每次切都要 PIN）。
  // 改成「PIN 通過後 5 分鐘內切過去免重輸」的 grace 模型。手動按「🔒 鎖定」會把
  // unlocked 砍 false，不論在不在 grace 都要重輸；grace 過期 → unlocked 自然失效。

  setActiveId(id);

  const target = id ? getSession(id) : null;
  // 需要重輸 PIN 的條件：unlocked=false（手動鎖了）OR grace 過期
  const needsPin = !!(id && target && !isWithinPinGrace(target));
  if (needsPin) {
    pinTarget = {
      id: target!.id,
      nickname: target!.record.nickname,
      maskedAccount: target!.record.maskedAccount,
      failedAttempts: 0,
    };
    multiMode = "pin";
  } else if (id) {
    pinTarget = null;
    multiMode = "active";
    setLastActive(id);
    touchLastUsed(id);
  } else {
    pinTarget = null;
    multiMode = "picker";
  }
  // 隱藏所有非 active / 仍需 PIN 的 view；active + 在 grace 內的 bounds 由 renderer push
  for (const s of listSessions()) {
    const showThis = s.id === id && isWithinPinGrace(s);
    if (!showThis) hideElearnView(s.view);
  }
  const active = id ? getSession(id) : null;
  if (active && isWithinPinGrace(active) && active.view && mainWindow) {
    // 重新套用 last-known bounds（renderer 應該很快會再 push 一次更新）
    try {
      active.view.setBounds(lastBounds);
    } catch {
      /* swallow */
    }
  }
  pushState();
  // destroy + rebuild rebound 後常見 keyboard focus 卡掉，主動把 focus 拉回主視窗
  // 多次 focus 確保跨過任何 BrowserView 的 loadURL settle 時間
  const focusBackToMain = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.focus();
      mainWindow.webContents.focus();
    } catch {
      /* swallow */
    }
  };
  focusBackToMain();
  setTimeout(focusBackToMain, 200);
  setTimeout(focusBackToMain, 600);
}

// ── Sniffer capture: 區分新帳號 / 既有帳號流程 ─────────────────
function handleSnifferCapture(s: AccountSession, creds: SniffedCredentials) {
  if (pendingNewSessionId === s.id && !getAccount(s.id)) {
    // 新帳號流程：算出真實 id，看有沒有衝突
    const newId = computeAccountId(creds.account);
    const existing = getAccount(newId);
    if (existing) {
      logGlobal(
        "warn",
        `這個 e 等帳號（${maskAccount(creds.account)}）已經在帳號列表中（${existing.nickname}），請改從 picker 選擇`,
      );
      void destroySession(s);
      pendingNewSessionId = null;
      multiMode = "picker";
      pushState();
      return;
    }
    // re-key：把 random id 換成 account-derived id
    deregisterSession(s.id);
    s.id = newId;
    s.partitionId = partitionIdFor(newId);
    s.account = creds.account;
    s.password = creds.password;
    s.record = {
      id: newId,
      nickname: "",
      maskedAccount: maskAccount(creds.account),
      pinHash: "",
      pinSalt: "",
      addedAt: new Date().toISOString(),
    };
    pushSecretToMaskList(creds.account, maskAccount(creds.account));
    pendingNewSessionId = newId;
    registerSession(s);
    setActiveId(newId);
    multiMode = "post_login";
    postLoginState = { id: newId };
    logGlobal("info", `已偵測 ${maskAccount(creds.account)} 登入成功，請設定暱稱與 PIN`);
    pushState();
    return;
  }

  // 既有帳號：使用者可能改密碼了，更新 storage
  if (creds.password && creds.password !== s.password) {
    saveAccountCreds(s.id, { account: s.account, password: creds.password });
    s.password = creds.password;
    logSession(s, "info", "偵測到密碼已變更，已更新儲存");
  }
}

// ── detectLogin polling ───────────────────────────────────────
function startDetectLogin(s: AccountSession): void {
  if (!s.view) return;
  detectLogin(s.view.webContents)
    .then(async (user) => {
      pushSecretToMaskList(user, maskName(user));
      s.state.user = { name: maskName(user) };
      s.state.loginStatus = "ok";

      if (pendingNewSessionId === s.id && !getAccount(s.id)) {
        // 新帳號流程：detectLogin 通常比 sniffer 早 fire（SSO redirect 落地了）
        // sniffer 還會在背景跑；這邊不主動翻 status，等 sniffer 寫 post_login mode
        logSession(s, "info", "新帳號 SSO 已登入，等候捕捉帳密");
        return;
      }

      logSession(s, "info", `已成功登入`);
      startLoginWatchdog(s);
      if (s.view) await dismissNuisancePopups(s.view.webContents);
      await refreshCourses(s);

      s.state.status = "selecting";
      logSession(s, "info", "請在上方搜尋 / 勾選要刷的課程，按「開始」即可");
      pushState();

      // E.d: resume previous interrupted run
      const prev = loadRun(s.id);
      if (
        prev &&
        prev.status !== "done" &&
        prev.status !== "aborted" &&
        prev.pipelineCids.length
      ) {
        if (s.id === getActiveId()) {
          mainWindow?.webContents.send(IPC.RESUME_PROMPT, {
            pipelineCids: prev.pipelineCids,
            startedAt: prev.startedAt,
            previousStatus: prev.status,
          });
        }
      }
    })
    .catch((err) => logSession(s, "error", `登入偵測失敗：${err}`));
}

// ── tryAutoLogin（per-session） ───────────────────────────────
async function tryAutoLogin(s: AccountSession): Promise<boolean> {
  if (s.autoLoginInFlight) return false;
  if (!s.view) return false;
  if (!s.account || !s.password) return false;

  for (let i = 0; i < 6; i++) {
    const already = await isBrowserViewLoggedIn(s);
    if (already === true) {
      logSession(s, "info", "BrowserView 已登入（idx cookie 有效），跳過 SSO");
      return true;
    }
    if (already === false) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  s.autoLoginInFlight = true;
  emitAutoLogin(s, { stage: "start" });
  logSession(
    s,
    "info",
    `偵測到已儲存帳密（${maskAccount(s.account)}），背景自動登入中...`,
  );
  try {
    const result = await autoLoginInView(
      s.view,
      { account: s.account, password: s.password },
      { timeoutMs: 60_000 },
    );
    if (result.ok) {
      emitAutoLogin(s, { stage: "success" });
      logSession(s, "info", "自動登入成功（view）");
      touchLastUsed(s.id);
      return true;
    }
    logSession(s, "warn", `自動登入失敗：${result.error ?? "unknown"}`);
    emitAutoLogin(s, { stage: "failed", error: result.error });
    return false;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emitAutoLogin(s, { stage: "failed", error: msg });
    logSession(s, "warn", `自動登入發生例外：${msg}`);
    return false;
  } finally {
    s.autoLoginInFlight = false;
  }
}

// ── Logout 偵測（BrowserView 觸發） ───────────────────────────
async function handleBrowserViewLogout(
  s: AccountSession,
  reason: "url" | "raw-source",
): Promise<void> {
  if (s.logoutHandlingInFlight) return;
  if (!s.view) return;
  if (s.autoLoginInFlight || s.reloginInFlight) return;
  s.logoutHandlingInFlight = true;
  try {
    logSession(
      s,
      "warn",
      reason === "raw-source"
        ? "BrowserView 顯示成原始碼（eCPA 登出回的非 HTML 回應），自動導回登入頁"
        : "BrowserView 偵測到登出網址，自動導回登入頁",
    );
    s.state.loginStatus = "failed";
    s.state.user = undefined;
    pushState();

    if (s.account && s.password) {
      await tryAutoLogin(s);
    } else {
      await s.view.webContents.loadURL(ECPA_LOGIN_URL).catch(() => void 0);
    }
  } finally {
    s.logoutHandlingInFlight = false;
  }
}

// ── Login watchdog（per-session） ─────────────────────────────
async function isBrowserViewLoggedIn(
  s: AccountSession,
): Promise<boolean | null> {
  if (!s.view) return null;
  const url = s.view.webContents.getURL();
  if (!url.includes("elearn.hrd.gov.tw")) return null;
  if (s.view.webContents.isLoading()) return null;
  try {
    const found: boolean = await s.view.webContents.executeJavaScript(
      `(() => {
        const a = document.querySelector('a[href="/mooc/user/learn_dashboard.php"]');
        return !!a && (a.textContent || '').trim().includes('個人專區');
      })()`,
      true,
    );
    return found;
  } catch {
    return null;
  }
}

function startLoginWatchdog(s: AccountSession) {
  stopLoginWatchdog(s);
  s.loginMissCount = 0;
  s.loginWatchdogTimer = setInterval(async () => {
    if (s.autoLoginInFlight || s.reloginInFlight) return;
    const st = s.state.status;
    if (st === "boot" || st === "setup" || st === "await_login") return;

    const status = await isBrowserViewLoggedIn(s);
    if (status === null) return;

    if (status === true) {
      s.loginMissCount = 0;
      if (s.state.loginStatus !== "ok") {
        s.state.loginStatus = "ok";
        pushState();
      }
      return;
    }

    s.loginMissCount++;
    if (s.loginMissCount < 2) return;
    s.loginMissCount = 0;

    if (!s.account || !s.password) {
      logSession(s, "warn", "BrowserView 偵測到登出，但沒有儲存帳密，無法自動重登");
      s.state.loginStatus = "failed";
      pushState();
      return;
    }

    s.reloginInFlight = true;
    logSession(s, "warn", "BrowserView 偵測到登出，自動重新登入中...");
    s.state.loginStatus = "relogging";
    const wasRunning = s.state.status === "running";
    if (wasRunning) {
      s.state.status = "paused";
      s.state.pauseReason = "session_expired";
    }
    pushState();

    const ok = await tryAutoLogin(s);
    const verified = await isBrowserViewLoggedIn(s);
    if (ok && verified === true) {
      s.state.loginStatus = "ok";
      if (wasRunning) {
        s.state.status = "running";
        s.state.pauseReason = undefined;
        logSession(s, "info", "BrowserView session 已恢復，繼續刷課");
      }
    } else if (!ok) {
      s.state.loginStatus = "failed";
      logSession(s, "error", "BrowserView 自動重登失敗，請手動重新登入");
    } else {
      s.state.loginStatus = "failed";
      logSession(s, "error", "重登報告成功但 BrowserView 仍未登入（SSO 可能失敗）");
    }
    pushState();
    s.reloginInFlight = false;
  }, 30_000);
}

function stopLoginWatchdog(s: AccountSession) {
  if (s.loginWatchdogTimer) {
    clearInterval(s.loginWatchdogTimer);
    s.loginWatchdogTimer = null;
  }
}

// ── Pipeline session watchdog ─────────────────────────────────
function startSessionWatchdog(s: AccountSession, sess: Session) {
  stopSessionWatchdog(s);
  s.watchdogTimer = setInterval(async () => {
    if (s.state.status !== "running") return;
    const alive = await isSessionAlive(sess);
    if (alive) {
      s.consecutiveDeadChecks = 0;
      return;
    }
    s.consecutiveDeadChecks++;
    logSession(s, "warn", `偵測到 session 無回應（第 ${s.consecutiveDeadChecks} 次）`);
    if (s.consecutiveDeadChecks < 2) return;

    s.state.status = "paused";
    s.state.pauseReason = "session_expired";
    persistRun(s, "paused");
    if (s.id === getActiveId()) {
      mainWindow?.webContents.send(IPC.PIPELINE_PAUSED, "session_expired");
    }
    pushState();

    if (s.account && s.password) {
      const ok = await tryAutoLogin(s);
      if (ok) {
        const nowAlive = await isSessionAlive(sess);
        if (nowAlive) {
          s.state.status = "running";
          s.state.pauseReason = undefined;
          s.consecutiveDeadChecks = 0;
          persistRun(s, "running");
          logSession(s, "info", "Session 已恢復，繼續刷課");
          pushState();
        } else {
          logSession(s, "error", "自動重登報告成功但 session 仍異常");
        }
      } else {
        logSession(s, "error", "自動重登失敗");
      }
    } else {
      logSession(s, "warn", "沒有儲存帳密；請手動在下方瀏覽器重新登入");
    }
  }, 90_000);
}

function stopSessionWatchdog(s: AccountSession) {
  if (s.watchdogTimer) {
    clearInterval(s.watchdogTimer);
    s.watchdogTimer = null;
  }
  s.consecutiveDeadChecks = 0;
}

function persistRun(
  s: AccountSession,
  status: "running" | "paused" | "done" | "aborted",
) {
  if (!s.state.pipelineCids || s.state.pipelineCids.length === 0) return;
  const existing = loadRun(s.id);
  saveRun(
    {
      pipelineCids: s.state.pipelineCids,
      startedAt: existing?.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status,
    },
    s.id,
  );
}

// ── BrowserView 焦點管理（per-session） ──────────────────────
function navigateViewToCourse(s: AccountSession, cid: string) {
  if (!s.view) return;
  s.view.webContents
    .loadURL(`https://elearn.hrd.gov.tw/info/${cid}`)
    .catch(() => void 0);
}
function focusNextCourse(s: AccountSession) {
  const next = s.runningCids.values().next().value;
  if (next) {
    s.focusedCid = next;
    navigateViewToCourse(s, next);
  } else {
    s.focusedCid = null;
  }
}

// ── Server-progress poll cache（per-session） ─────────────────
function makeProgressPollCache(sess: Session) {
  let cache: { ts: number; map: Map<string, PollData> } | null = null;
  return async function fetchProgressCached(): Promise<Map<string, PollData>> {
    const now = Date.now();
    if (cache && now - cache.ts < 5_000) return cache.map;
    const courses = await getSigningCourses(sess);
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
    cache = { ts: now, map };
    return map;
  };
}

// ── Course discovery / refresh ────────────────────────────────
function trackedToCard(t: Tracked): CourseCard {
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

function updateStats(s: AccountSession) {
  const scopeCids = s.state.pipelineCids ? new Set(s.state.pipelineCids) : null;
  const scope = scopeCids
    ? s.state.courses.filter((c) => scopeCids.has(c.cid))
    : s.state.courses;
  s.state.stats.total = scope.length;
  s.state.stats.done = scope.filter((c) => c.phase === "done").length;
  s.state.stats.progressPct =
    s.state.stats.total === 0
      ? 0
      : Math.round((s.state.stats.done / s.state.stats.total) * 100);
}

async function refreshCourses(s: AccountSession): Promise<void> {
  if (!s.view) return;
  try {
    const sess = s.view.webContents.session;
    const tracked = await discover(sess);
    s.state.courses = tracked.map(trackedToCard);
    updateStats(s);
    pushState();
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
    logSession(
      s,
      "info",
      `掃描完成：你目前真正的課程 ${real} 門（進行中未完成 ${inProgress}）；機關推薦但你沒點過的 ${phantom} 門已略過`,
    );
    const diagLines: string[] = [`=== 課程狀態診斷 ${new Date().toISOString()} ===`];
    let donePassed = 0;
    for (const t of tracked.filter(
      (t) => t.course.isReadtimeValidCaption !== "未報名",
    )) {
      const r = t.course.isReadDones ?? 0;
      const e = t.course.isExamDones ?? 0;
      const sv = t.course.isSurveyDones ?? 0;
      const cap = t.course.isReadtimeValidCaption ?? "?";
      const pp = t.course.passPercent ?? "-";
      const d = t.detail
        ? ` | detail: read=${t.detail.readSec ?? "?"}s exam=${t.detail.examScore ?? "?"} survey=${t.detail.surveyDone === true ? "已填" : t.detail.surveyDone === false ? "未填" : "?"} pass=${t.detail.passed === true ? "通過" : t.detail.passed === false ? "未通過" : "--"}`
        : " | detail: (none)";
      const line = `📋 [list 閱:${r} 測:${e} 問:${sv} cap:${cap} p:${pp}% → phase:${t.phase}]${d} ${t.course.caption}`;
      diagLines.push(line);
      if (cap === "已通過") {
        donePassed++;
        continue;
      }
      logSession(s, "info", `  ${line}`);
    }
    if (donePassed > 0)
      logSession(
        s,
        "info",
        `  ✓ 已通過 ${donePassed} 門（不在日誌列出，完整紀錄寫到 temp/auto-elearn-diag.txt）`,
      );
    try {
      writeFileSync(
        join(app.getPath("temp"), `auto-elearn-diag-${s.id}.txt`),
        diagLines.join("\n"),
        "utf8",
      );
    } catch {
      /* swallow */
    }
  } catch (e) {
    logSession(s, "error", `掃描失敗：${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Pipeline ───────────────────────────────────────────────────
async function runPipelineFor(s: AccountSession, cids: string[]): Promise<void> {
  if (!s.view) return;
  const session = s.view.webContents.session;
  s.abortSignal.aborted = false;
  s.pauseSignal.paused = false; // v0.8.3：fresh pipeline 一定不在暫停狀態
  s.pipelineRunning = true;

  const fetchProgressCached = makeProgressPollCache(session);

  s.state.pipelineCids = [...cids];
  updateStats(s);
  persistRun(s, "running");
  pushState();

  // Up-front plan summary
  try {
    const planTracked = await discover(session);
    const planSel = new Set(cids);
    const plan = planTracked.filter((t) => planSel.has(t.course.cid));
    const enrolledCids = new Set(s.state.courses.map((c) => c.cid));
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
    const alreadyDone = plan.filter(
      (t) => t.course.isReadtimeValidCaption === "已通過",
    ).length;
    logSession(
      s,
      "info",
      `📋 本批 ${cids.length} 門課計畫：報名 ${needEnroll} · 閱讀 ${needRead} · 測驗 ${needExamPlan} · 問卷 ${needSurveyPlan}（已通過 ${alreadyDone}）`,
    );
  } catch (e) {
    logSession(s, "warn", `預估失敗：${e instanceof Error ? e.message : String(e)}`);
  }

  // 1. Enrol
  const enrolled = new Set(s.state.courses.map((c) => c.cid));
  // v0.8.7：使用者剛退選的 cid 不要被自動加選回去 — 即使 selectedCids 裡還有它
  // （renderer 沒同步刷掉 / pipelineCids 是 click 時的 snapshot）也跳過。
  const skippedDueToRecentUnenrol: string[] = [];
  const toEnrol = cids
    .filter((c) => !enrolled.has(c))
    .filter((c) => {
      if (s.recentlyUnenrolled.has(c)) {
        skippedDueToRecentUnenrol.push(c);
        return false;
      }
      return true;
    });
  if (skippedDueToRecentUnenrol.length > 0) {
    logSession(
      s,
      "warn",
      `⏭ 不自動加選 ${skippedDueToRecentUnenrol.length} 門剛被退選的課程（${skippedDueToRecentUnenrol.join(",")}）— 要重新上請去搜尋頁勾選按開始`,
    );
  }
  if (toEnrol.length > 0) {
    s.state.status = "enrolling";
    s.state.now.action = "enroll";
    s.state.now.detail = `${toEnrol.length} 門課待報名`;
    pushState();
    // v0.8.1：多帳號模式下，A tab 在背景被 hahow / SSO 踢出時 partition cookies 仍
    // 在但已失效，enrollCourse 會 silently 302 到 login → 看似報名 200 OK 實則沒
    // 寫成功。報名前 ping 一下 dashboard，沒有 idx 就先補登。
    const alive = await isSessionAlive(session);
    if (!alive) {
      logSession(s, "warn", "報名前發現 session 失效，先自動補登...");
      await tryAutoLogin(s).catch(() => void 0);
    }
    logSession(s, "info", `開始報名 ${toEnrol.length} 門新課程... (partition=${s.partitionId})`);
    const results = await enrollMany(session, toEnrol, ENROLL_DELAY_MS);
    const ok = results.filter((r) => r.ok).map((r) => r.cid);
    const bad = results.filter((r) => !r.ok);
    logSession(s, "info", `報名完成：成功 ${ok.length} / 失敗 ${bad.length}`);
    for (const b of bad) {
      logSession(s, "warn", `報名失敗 cid=${b.cid} status=${b.status} ${b.errorMsg ?? ""}`);
    }
    await refreshCourses(s);
  }

  // 2. Heartbeat
  s.state.status = "running";
  const tracked = await discover(session);
  const selected = new Set(cids);
  const skipRead = tracked.filter(
    (t) =>
      selected.has(t.course.cid) &&
      t.course.isClassing &&
      t.phase !== "reading" &&
      t.phase !== "pending",
  );
  if (skipRead.length > 0) {
    logSession(
      s,
      "info",
      `${skipRead.length} 門課已過閱讀階段，跳過心跳：${skipRead.map((t) => t.course.caption).join("、")}`,
    );
  }

  const completedHeartbeat = new Set<string>();
  const chainPromises: Promise<void>[] = [];
  const chainStarted = new Set<string>();
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

  const runFinishChain = async (
    cid: string,
    name: string,
    awaitHeartbeat: boolean,
  ): Promise<void> => {
    if (s.abortSignal.aborted) return;
    if (!(await awaitNotPaused(s))) return; // v0.8.3：暫停中先卡住，不要起 chain
    const card = s.state.courses.find((c) => c.cid === cid);
    try {
      const fresh = await fetchCourseDetail(session, cid);
      const surveyDone = fresh?.surveyDone === true;
      const passed = fresh?.passed === true;

      let examOK = passed;
      if (!passed && !s.abortSignal.aborted) {
        // v0.8.13: race the shared prefetch promise with a 30s timeout.
        // Fast path (heartbeat-driven chains): prefetch already resolved.
        // Edge path (skipRead courses with no heartbeat): chain hits this
        // before web-bank has finished — wait briefly so learned_answers
        // is populated before solveExam reads it.
        const PREFETCH_TIMEOUT_MS = 30_000;
        await Promise.race([
          prefetchPromise,
          new Promise<void>((resolve) => setTimeout(resolve, PREFETCH_TIMEOUT_MS)),
        ]);

        try {
          const { solveExamFromHistory } = await import("./exam/history-solver");
          const r = await solveExamFromHistory(session, cid, (m) =>
            logSession(s, "info", `  [${name}] ${m}`),
          );
          if (r.ok)
            logSession(
              s,
              "info",
              `📚 [${name}] 從歷次紀錄學到 ${r.learned} 題（已存 learned_answers）`,
            );
          else
            logSession(s, "info", `  [${name}] 跳過 history-solve：${r.reason ?? "n/a"}`);
        } catch (e) {
          logSession(s, "warn", `  [${name}] history-solve 例外：${(e as Error)?.message ?? e}`);
        }

        const threshold = fresh?.passingScore ?? 80;
        const examTask = (async (): Promise<boolean> => {
          const EXAM_ROUNDS = 3;
          let res: Awaited<ReturnType<typeof solveExam>> | null = null;
          for (let round = 1; round <= EXAM_ROUNDS; round++) {
            if (s.abortSignal.aborted) break;
            // v0.8.3：暫停 gate — 每輪測驗開始前停下來等使用者
            if (!(await awaitNotPaused(s))) break;
            if (round === 1) {
              logSession(s, "info", `開始測驗：${name}（門檻 ${threshold} 分）`);
            } else {
              const prev = res?.score != null ? `${res.score}分` : "?";
              logSession(
                s,
                "info",
                `[${name}] 上一輪 ${prev} < ${threshold}，第 ${round}/${EXAM_ROUNDS} 輪重考；先重跑歷次反推`,
              );
              try {
                const { solveExamFromHistory } = await import("./exam/history-solver");
                const hr = await solveExamFromHistory(session, cid, (m) =>
                  logSession(s, "info", `  [${name}] ${m}`),
                );
                if (hr.ok && hr.learned > 0) {
                  logSession(
                    s,
                    "info",
                    `📚 [${name}] 第 ${round} 輪歷史反推學到 ${hr.learned} 題`,
                  );
                }
              } catch (e) {
                logSession(
                  s,
                  "warn",
                  `  [${name}] 第 ${round} 輪歷史反推例外：${(e as Error)?.message ?? e}`,
                );
              }
              await new Promise((r) => setTimeout(r, 5000));
            }
            res = await solveExam(cid, session, {
              onProgress: (msg) => logSession(s, "info", `  [${name}] ${msg}`),
              passingScore: threshold,
              courseName: name,
            });
            if (!res.ok) {
              logSession(s, "warn", `測驗失敗 ${name}：${res.error ?? "unknown"}`);
              return false;
            }
            if (res.passed === true || res.total === 0) break;
          }
          if (res && res.ok) {
            const scoreStr = res.score != null ? `${res.score}分` : "?";
            const readStr = res.readExamScore != null ? ` 閱讀:${res.readExamScore}分` : "";
            logSession(
              s,
              "info",
              `測驗完成 ${name}：${res.passed ? "✅ 通過" : "⚠ 判定不明"} ${scoreStr}${readStr}，共 ${res.total} 題（題庫 ${res.bySource["web-prefetch"]} / DB ${res.bySource.db} / fuzzy ${res.bySource.fuzzy} / LLM ${res.bySource.llm} / brute ${res.bySource.brute} / random ${res.bySource.random}）`,
            );
            if (card && res.passed) card.examDone = true;
            return res.passed === true || res.total === 0;
          }
          return false;
        })();

        const surveyTask = (async (): Promise<void> => {
          if (surveyDone || s.abortSignal.aborted) return;
          // v0.8.3：暫停 gate — 開始填問卷前停下來
          if (!(await awaitNotPaused(s))) return;
          logSession(s, "info", `[${name}] 開始填問卷`);
          let sr = await fillSurvey(cid, session, {
            onProgress: (msg) => logSession(s, "info", `  [${name}] ${msg}`),
          });
          if (!sr.ok && !s.abortSignal.aborted) {
            logSession(
              s,
              "warn",
              `[${name}] 問卷三次內部重試皆失敗 (${sr.error ?? "unknown"})，30s 後再做一次外層重試`,
            );
            await new Promise((r) => setTimeout(r, 30_000));
            if (!s.abortSignal.aborted) {
              // v0.8.3：30s 等待結束後若仍是暫停狀態，等使用者恢復再 retry
              if (!(await awaitNotPaused(s))) return;
              sr = await fillSurvey(cid, session, {
                onProgress: (msg) =>
                  logSession(s, "info", `  [${name}] (外層重試) ${msg}`),
              });
            }
          }
          if (sr.ok) {
            const tag = sr.serverConfirmed ? "✅ server 確認" : "⚠ 未驗證";
            logSession(
              s,
              "info",
              `問卷完成 ${name}：${tag}，attempt=${sr.attempts} filled=${sr.filled} submitted=${sr.submitted}`,
            );
            if (card && sr.serverConfirmed) card.surveyDone = true;
          } else {
            logSession(
              s,
              "warn",
              `❌ 問卷最終失敗 ${name}：attempt=${sr.attempts} ${sr.error ?? "unknown"}`,
            );
          }
        })();

        const [examResult] = await Promise.all([examTask, surveyTask]);
        examOK = examResult;
        void examOK;
      }

      if (card && card.phase !== "done") {
        card.phase = "verifying";
        pushState();
      }

      if (awaitHeartbeat) {
        const wait = heartbeatDonePromises.get(cid);
        if (wait) {
          logSession(
            s,
            "info",
            `[${name}] 測驗+問卷已交，等待閱讀心跳完成後確認通過狀態...`,
          );
          await wait;
        }
      }

      if (card && card.phase !== "done") {
        const passingScore = fresh?.passingScore ?? 80;
        let lastDetail: Awaited<ReturnType<typeof fetchCourseDetail>> | null = null;
        for (let i = 0; i < 12; i++) {
          if (s.abortSignal.aborted) break;
          await new Promise((r) => setTimeout(r, 10_000));
          const final = await fetchCourseDetail(session, cid).catch(() => null);
          lastDetail = final;
          if (final?.passed === true) {
            card.phase = "done";
            if (final.examScore != null) {
              card.examDone = final.examScore >= passingScore;
            }
            if (final.surveyDone != null) card.surveyDone = final.surveyDone;
            updateStats(s);
            pushState();
            logSession(s, "info", `[${name}] ✅ server 已確認通過`);
            break;
          }
        }
        if (card.phase !== "done") {
          const gaps: string[] = [];
          if (
            lastDetail?.examScore != null &&
            lastDetail.examScore < passingScore
          ) {
            gaps.push(`測驗 ${lastDetail.examScore}/${passingScore} 分（未通過）`);
            if (card.examDone) {
              card.examDone = false;
              pushState();
            }
          }
          if (lastDetail?.surveyDone === false) {
            gaps.push("問卷 server 端未記");
            if (card.surveyDone) {
              card.surveyDone = false;
              pushState();
            }
          }
          if (gaps.length > 0) {
            logSession(
              s,
              "warn",
              `[${name}] ❌ server 沒記到：${gaps.join("、")}；UI 已同步取消勾選，請點該課重跑`,
            );
          } else {
            logSession(
              s,
              "info",
              `[${name}] 問卷已交但 server 通過狀態尚未刷新（120s 內未翻為「通過」）；保持「等待通過確認」狀態`,
            );
          }
        }
      }
    } catch (e) {
      logSession(s, "warn", `[${name}] chain 失敗：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  for (const t of skipRead) {
    startChainOnce(t.course.cid, t.course.caption, false);
  }

  const allNeedReading = tracked.filter(
    (t) => selected.has(t.course.cid) && t.course.isClassing && t.phase === "reading",
  );
  for (const t of allNeedReading) ensureHeartbeatDonePromise(t.course.cid);

  // v0.8.8：把跨帳號的擁有權檢查改成「拿到立刻上 / 拿不到排隊等」— 同一堂課
  // 同時間只能 1 個帳號 heartbeat（server SCORM session 會互相打掉，先進場的會
  // 歸零）；後進場的不能直接被略過/標完成，要等先進場的做完再接手。
  const immediate: typeof allNeedReading = [];
  const queued: typeof allNeedReading = [];
  for (const t of allNeedReading) {
    const claim = acquireCourseOwnership(t.course.cid, s);
    if (claim.ok) {
      immediate.push(t);
    } else {
      queued.push(t);
      const card = s.state.courses.find((c) => c.cid === t.course.cid);
      if (card) card.waitingForOwner = claim.takenBy;
      logSession(
        s,
        "info",
        `⏸ 「${t.course.caption}」：「${claim.takenBy}」帳號正在上，先排隊；其他課先上，這堂等他上完再接手`,
      );
    }
  }
  if (queued.length > 0) pushState();

  // v0.8.13: fire web-bank prefetch in parallel with heartbeat. Promise is
  // held so per-course chains can await it (especially skipRead courses
  // that go straight to chain without a heartbeat phase).
  const allTracked = [...immediate, ...queued, ...skipRead];
  const courseNamesByCid = new Map<string, string>();
  for (const t of allTracked) courseNamesByCid.set(t.course.cid, t.course.caption ?? "");
  const prefetchCids = allTracked.map((t) => t.course.cid);

  // v0.8.14: bulk prefetch the entire bank into learned_answers in the
  // background, once per 24h. Per-course prefetch (below) still covers the
  // selected cids fast for the chain that's about to fire; bulk fills in
  // the rest of the corpus over ~15 min so subsequent exam pages — even
  // ones whose course-name fuzzy match was a false positive — can hit
  // learned_answers by question text alone.
  // v0.8.18: always fire bulk on every pipeline start. Bulk is incremental
  // (delta vs processedUrls snapshot) — no work if top-500 fully cached;
  // automatic retry of previously-failed pages.
  bulkPrefetchBankIndex(
    (msg) => logSession(s, "info", `[題庫·全量] ${msg}`),
    (p) => {
      if (s.abortSignal.aborted) return;
      s.state.webBankBulkProgress = p;
      pushState();
    },
  ).catch((e) => {
    logSession(
      s,
      "warn",
      `[題庫·全量] 例外（不影響本次刷課）：${(e as Error)?.message ?? e}`,
    );
    if (!s.abortSignal.aborted) {
      s.state.webBankBulkProgress = undefined;
      pushState();
    }
  });

  let prefetchPromise: Promise<PrefetchResult>;
  if (prefetchCids.length > 0) {
    s.state.webBankProgress = {
      running: true,
      questionsWritten: 0,
      coursesHit: 0,
      coursesMiss: 0,
      coursesFailed: 0,
      coursesTotal: prefetchCids.length,
    };
    pushState();
    prefetchPromise = prefetchCoursesViaWebBank(
      prefetchCids,
      courseNamesByCid,
      (msg) => logSession(s, "info", `[題庫] ${msg}`),
    )
      .then((res) => {
        if (s.abortSignal.aborted) return res; // session 已 abort，state 不要動
        s.state.webBankProgress = {
          running: false,
          questionsWritten: res.questionsWritten,
          coursesHit: res.coursesHit,
          coursesMiss: res.coursesMiss,
          coursesFailed: res.coursesFailed,
          coursesTotal: prefetchCids.length,
        };
        pushState();
        return res;
      })
      .catch((e) => {
        logSession(s, "warn", `[題庫] prefetch 例外：${(e as Error)?.message ?? e}`);
        const failResult: PrefetchResult = {
          questionsWritten: 0,
          coursesHit: 0,
          coursesMiss: 0,
          coursesFailed: prefetchCids.length,
        };
        if (!s.abortSignal.aborted) {
          s.state.webBankProgress = {
            running: false,
            ...failResult,
            coursesTotal: prefetchCids.length,
          };
          pushState();
        }
        return failResult;
      });
  } else {
    s.state.webBankProgress = undefined;
    pushState();
    prefetchPromise = Promise.resolve({
      questionsWritten: 0,
      coursesHit: 0,
      coursesMiss: 0,
      coursesFailed: 0,
    });
  }

  // v0.8.1：caption map 給 reauthFn 重抽 ticket 用 — extractTicket 需要 caption
  // 才能在多 lesson 共用 SCORM tree 時挑對課，沒帶會抓到 sibling 變成 noop 心跳。
  const captionByCid = new Map<string, string>();
  for (const t of allNeedReading) captionByCid.set(t.course.cid, t.course.caption ?? "");

  /** v0.8.8：runHeartbeatBatch 的標準參數打包，主批跟排隊輪候 batch 共用 */
  const runHbBatch = async (batch: typeof allNeedReading) => {
    const parallel = Math.min(batch.length, HEARTBEAT_PARALLEL_MAX);
    await runHeartbeatBatch(session, batch, {
      parallel,
      intervalMs: HEARTBEAT_INTERVAL_MS,
      jitterMs: HEARTBEAT_JITTER_MS,
      graceSec: 120,
      signal: s.abortSignal,
      pauseSignal: s.pauseSignal, // v0.8.3：暫停時 heartbeat 在 tick 邊界 sleep
      pollIntervalMs: 30_000,
      // v0.8.1：心跳連續 3 次失敗時觸發 — 通常是 hahow 並行登入上限或 SSO timeout
      // 把 server 端的 reading session 砍了，partition cookies 仍在但 idx 已失效。
      // 這裡走靜默 net.request 補登 → 重新從 SCORM 抽一張新的 actid，loop 接著用
      // 新 ticket 繼續打剩下的時間，避免「失敗 5 次直接 break」造成的時數歸零。
      reauthFn: async (cid) => {
        if (!s.account || !s.password) {
          logSession(s, "warn", `[${cid.slice(0, 8)}] 心跳失敗想 reauth 但沒有儲存帳密（SSO-only？）`);
          return null;
        }
        const partSess = sessionModule.fromPartition(s.partitionId);
        logSession(s, "warn", `[${cid.slice(0, 8)}] 心跳連續失敗，靜默重登 + 重抽 actid...`);
        const r = await loginViaEcpa(partSess, s.account, s.password);
        if (!r.ok) {
          logSession(s, "error", `[${cid.slice(0, 8)}] reauth 登入失敗：${r.error ?? r.stage}`);
          return null;
        }
        const caption = captionByCid.get(cid);
        const t = await extractTicket(cid, 30_000, caption, partSess);
        if (!t) {
          logSession(s, "error", `[${cid.slice(0, 8)}] reauth 後仍抽不到 ticket，放棄`);
          return null;
        }
        logSession(s, "info", `[${cid.slice(0, 8)}] reauth 成功，新 actid=${(t.actid ?? "?").slice(0, 40)}`);
        return t;
      },
      pollFn: async (cid) => {
        try {
          const map = await fetchProgressCached();
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
        const card = s.state.courses.find((c) => c.cid === cid);
        if (!card) return;
        if (detail.readSec != null) {
          const newReadSec = Math.min(card.requiredSec, detail.readSec);
          if (newReadSec !== card.readSec) {
            card.readSec = newReadSec;
            logSession(
              s,
              "info",
              `[${card.name}] 📡 server 閱讀時數 ${Math.round(newReadSec / 60)} 分鐘 / 需 ${Math.round(card.requiredSec / 60)} 分鐘`,
            );
            pushState();
          }
        }
      },
      onPoll: (cid, data) => {
        const card = s.state.courses.find((c) => c.cid === cid);
        if (!card) return;
        if (data.isExamDones === 1) card.examDone = true;
        if (data.isSurveyDones === 1) card.surveyDone = true;
        const captionDone = data.isReadtimeValidCaption === "已通過";
        const readStatus = data.isReadDones === 1 || captionDone ? "閱讀✓" : "閱讀⏳";
        const examStatus = data.isExamDones === 1 ? "測驗✓" : "測驗○";
        const surveyStatus = data.isSurveyDones === 1 ? "問卷✓" : "問卷○";
        const pctStr = data.passPercent != null ? ` 整體${data.passPercent}%` : "";
        logSession(
          s,
          "info",
          `[${card.name}] 📡 server 進度:${pctStr} ${readStatus} ${examStatus} ${surveyStatus} caption:${data.isReadtimeValidCaption ?? "?"}`,
        );
        if (
          (data.isReadDones === 1 || captionDone) &&
          card.readSec < card.requiredSec
        ) {
          card.readSec = card.requiredSec;
          logSession(
            s,
            "info",
            `[${card.name}] 📡 伺服器確認閱讀達標（caption=${data.isReadtimeValidCaption}），提前結束心跳`,
          );
        }
        pushState();
      },
      onProgress: (cid, stage, extra) => {
        const card = s.state.courses.find((c) => c.cid === cid);
        if (!card) return;
        if (stage === "open") {
          const e0 = extra as { origin?: string; actid?: string; encCid?: string };
          const tail =
            (e0.origin ? ` (心跳 host: ${e0.origin}` : "") +
            (e0.encCid ? `, enCid: ${e0.encCid}` : "") +
            (e0.actid ? `, actid: ${e0.actid.slice(0, 40)}` : "") +
            (e0.origin ? ")" : "");
          logSession(s, "info", `開始閱讀：${card.name}${tail}`);
          s.runningCids.add(cid);
          if (!s.focusedCid) {
            s.focusedCid = cid;
            navigateViewToCourse(s, cid);
          }
        } else if (stage === "tick") {
          const e2 = extra as {
            firstResponse?: string;
            status?: number;
            timediff?: string;
            enterSession?: { status: number; ok: boolean; body?: string };
            startSession?: { status: number; ok: boolean; body: string };
            refreshSession?: { ok: boolean; status: number; body: string };
          };
          if (e2.enterSession) {
            logSession(
              s,
              "info",
              `[${card.name}] enterReadingSession → ${e2.enterSession.ok ? "OK" : "FAIL"} (${e2.enterSession.status}) ${e2.enterSession.body ?? ""}`,
            );
          }
          if (e2.startSession) {
            logSession(
              s,
              "info",
              `[${card.name}] startReadingSession → ${e2.startSession.ok ? "OK" : "FAIL"} (${e2.startSession.status}) ${e2.startSession.body}`,
            );
          }
          if (e2.refreshSession) {
            logSession(
              s,
              "info",
              `[${card.name}] ♻ 重新建立 session → ${e2.refreshSession.ok ? "OK" : "FAIL"} (${e2.refreshSession.status}) ${e2.refreshSession.body}`,
            );
          }
          if (e2.firstResponse !== undefined) {
            const td = e2.timediff !== undefined ? ` timediff=${e2.timediff}` : "";
            logSession(s, "info", `[${card.name}] 心跳回應${td}: ${e2.firstResponse}`);
          }
        } else if (stage === "done") {
          const pings = (extra as { pings?: number })?.pings ?? 0;
          const serverConfirmed =
            (extra as { serverConfirmed?: boolean })?.serverConfirmed ?? false;
          logSession(
            s,
            "info",
            `閱讀結束：${card.name} (${pings} pings, ${serverConfirmed ? "伺服器確認達標" : "計時到期"})`,
          );
          completedHeartbeat.add(cid);
          if (card.phase !== "verifying") card.phase = "exam";
          s.runningCids.delete(cid);
          if (s.focusedCid === cid) focusNextCourse(s);
          markHeartbeatDone(cid);
          // v0.8.8：釋放這堂課的擁有權，排隊的帳號最多等 15s 就可接手
          releaseCourseOwnership(cid, s.id);
          startChainOnce(cid, card.name, false);
        } else if (stage === "error") {
          logSession(s, "warn", `心跳錯誤 ${card.name}：${JSON.stringify(extra ?? {})}`);
          s.runningCids.delete(cid);
          if (s.focusedCid === cid) focusNextCourse(s);
        }
      },
      onHalfway: (cid) => {
        const card = s.state.courses.find((c) => c.cid === cid);
        if (!card) return;
        logSession(s, "info", `[${card.name}] 📖 閱讀已過半，並行啟動測驗+問卷`);
        startChainOnce(cid, card.name, true);
        pushState();
      },
      onTick: (cid, pings, elapsedSec) => {
        const card = s.state.courses.find((c) => c.cid === cid);
        if (!card) return;
        if (elapsedSec > card.readSec)
          card.readSec = Math.min(card.requiredSec, elapsedSec);
        card.lastPingAt = Date.now();
        s.state.now.courseId = cid;
        s.state.now.courseName = card.name;
        s.state.now.action = "heartbeat";
        const readMin = Math.floor(card.readSec / 60);
        const reqMin = Math.floor(card.requiredSec / 60);
        const pct =
          card.requiredSec > 0
            ? Math.min(100, Math.round((card.readSec / card.requiredSec) * 100))
            : 0;
        s.state.now.detail = `${pct}% · 已讀 ${readMin} 分鐘 / 需 ${reqMin} 分鐘 (${pings} pings)`;
        pushState();
        const interval = pings < 30 ? 6 : 30;
        if (pings === 1 || pings % interval === 0) {
          logSession(
            s,
            "info",
            `${card.name}: ${pings} ping, 已讀 ${readMin} 分鐘 / 需 ${reqMin} 分鐘 (${pct}%)`,
          );
        }
      },
    });
  };
  // ── helper end ──

  if (allNeedReading.length === 0) {
    logSession(s, "info", "沒有需要閱讀的課程");
  } else {
    s.state.now.action = "heartbeat";
    pushState();
    startSessionWatchdog(s, session);

    // 主批 — 立刻拿到 ownership 的課程
    if (immediate.length > 0) {
      logSession(
        s,
        "info",
        `${immediate.length} 門課開始閱讀${queued.length > 0 ? `（另有 ${queued.length} 門排隊等候）` : ""}（並行 ${Math.min(immediate.length, HEARTBEAT_PARALLEL_MAX)}，每 ${HEARTBEAT_INTERVAL_MS / 1000}s 心跳）`,
      );
      await runHbBatch(immediate);
    } else if (queued.length > 0) {
      logSession(s, "info", `所有 ${queued.length} 門課都被別的帳號佔用中，先排隊等候...`);
    }

    // v0.8.8：排隊輪候 — 主批做完後 / 邊做邊釋放，輪流 acquire 還沒拿到的課程
    while (queued.length > 0 && !s.abortSignal.aborted) {
      // 等等再 retry — 太快會在 release 之前就重檢，浪費。15s 是排隊更新的合理 cadence
      await new Promise((r) => setTimeout(r, 15_000));
      if (s.abortSignal.aborted) break;

      const stillQueued: typeof queued = [];
      const justAcquired: typeof queued = [];
      for (const t of queued) {
        const claim = acquireCourseOwnership(t.course.cid, s);
        if (claim.ok) {
          justAcquired.push(t);
          const card = s.state.courses.find((c) => c.cid === t.course.cid);
          if (card) card.waitingForOwner = undefined;
          logSession(
            s,
            "info",
            `▶ 「${t.course.caption}」 排隊到了，開始上`,
          );
        } else {
          stillQueued.push(t);
          // 持有者可能換了；UI 跟著更新
          const card = s.state.courses.find((c) => c.cid === t.course.cid);
          if (card && claim.takenBy && card.waitingForOwner !== claim.takenBy) {
            card.waitingForOwner = claim.takenBy;
          }
        }
      }
      queued.length = 0;
      queued.push(...stillQueued);
      pushState();

      if (justAcquired.length > 0) {
        await runHbBatch(justAcquired);
      }
    }
  }

  if (chainPromises.length > 0) {
    logSession(s, "info", `等候 ${chainPromises.length} 條 per-course chain 完成...`);
    await Promise.allSettled(chainPromises);
  }

  stopSessionWatchdog(s);

  // v0.8.19: pipeline-end summary — count pass/fail across cards.
  const cards = s.state.courses.filter((c) => selected.has(c.cid));
  let passCount = 0;
  let failCount = 0;
  let pendingCount = 0;
  const failed: string[] = [];
  for (const c of cards) {
    if (c.phase === "done") {
      passCount++;
    } else if (
      c.phase === "exam" ||
      c.phase === "survey" ||
      c.phase === "verifying"
    ) {
      failCount++;
      failed.push(c.name);
    } else {
      pendingCount++;
    }
  }
  const summary = `📊 本批 ${cards.length} 門總結：✅ ${passCount} 過 / ❌ ${failCount} 沒過${pendingCount ? ` / ⏳ ${pendingCount} 未跑完` : ""}${failed.length > 0 ? `；失敗：${failed.slice(0, 5).join("、")}${failed.length > 5 ? `…(共 ${failed.length} 門)` : ""}` : ""}`;
  logSession(s, "info", summary);

  // v0.8.7+v0.8.8：pipeline 結束 → 釋放擁有權，queue 下一個帳號接手
  releaseAllCoursesForAccount(s.id);
  s.state.status = "done";
  s.state.now.action = "idle";
  s.state.now.courseId = undefined;
  s.state.now.courseName = undefined;
  s.state.now.detail = undefined;
  s.state.webBankProgress = undefined;
  s.state.webBankBulkProgress = undefined;
  s.runningCids.clear();
  s.focusedCid = null;
  clearRun(s.id);
  s.pipelineRunning = false;
  await refreshCourses(s);
  updateStats(s);
  pushState();
}

// ── Search ─────────────────────────────────────────────────────
function normaliseKeyword(raw: string | undefined): string {
  if (!raw) return "";
  return raw.replace(/[\s　﻿​]+/g, " ").trim();
}

async function keywordSearch(
  s: AccountSession,
  opts: SearchOptions,
): Promise<CourseCandidate[]> {
  if (!s.view) return [];
  const session = s.view.webContents.session;
  const trimmed = normaliseKeyword(opts.keyword);
  const allByCid = new Map<string, Course>();
  const mineCids = new Set(s.state.courses.map((c) => c.cid));
  let authFailed = false;

  let hoursMin =
    Number.isFinite(opts.hoursMin) && (opts.hoursMin as number) > 0
      ? (opts.hoursMin as number)
      : undefined;
  let hoursMax =
    Number.isFinite(opts.hoursMax) && (opts.hoursMax as number) > 0
      ? (opts.hoursMax as number)
      : undefined;
  if (hoursMin !== undefined && hoursMax !== undefined && hoursMin > hoursMax) {
    [hoursMin, hoursMax] = [hoursMax, hoursMin];
    logSession(s, "info", `時數範圍 min/max 顛倒，已自動對調 → ${hoursMin} ~ ${hoursMax}`);
  }
  const filters: SearchFilters = { fromSchoolId: opts.fromSchoolId, hoursMin, hoursMax };

  const runSearch = async (categoryId: string, perpage: number, label: string) => {
    try {
      if (categoryId) await primeExplorer(session, categoryId);
      const results = await searchCourses(session, categoryId, trimmed, perpage, filters);
      logSession(
        s,
        "info",
        `  ${label}: ${results.length} 筆 (isClassing=${results.filter((c) => c.isClassing).length})`,
      );
      for (const r of results) if (!allByCid.has(r.cid)) allByCid.set(r.cid, r);
    } catch (e) {
      if (e instanceof ElearnAuthError) {
        authFailed = true;
        logSession(s, "error", `${label} 失敗：${e.message}`);
      } else {
        logSession(s, "warn", `${label} 失敗：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  const explicitCategory =
    opts.subCategoryId && opts.subCategoryId.trim()
      ? opts.subCategoryId.trim()
      : opts.mainCategoryId && opts.mainCategoryId.trim()
        ? opts.mainCategoryId.trim()
        : "";

  if (explicitCategory) {
    await runSearch(explicitCategory, 100, `cat=${explicitCategory} kw="${trimmed}"`);
    if (allByCid.size === 0 && trimmed && !authFailed) {
      logSession(s, "info", `  cat=${explicitCategory} 無結果，fallback 全站 kw="${trimmed}"`);
      await runSearch("", 100, `fallback 全站 kw="${trimmed}"`);
    }
  } else {
    await runSearch("", 100, `全站 kw="${trimmed}"`);
    for (const cat of KNOWN_CATEGORIES) {
      if (authFailed) break;
      await runSearch(cat, 50, `cat=${cat} kw="${trimmed}"`);
    }
  }

  logSession(
    s,
    "info",
    `  併集 byCid: ${allByCid.size} 筆 (isClassing=${Array.from(allByCid.values()).filter((c) => c.isClassing).length})`,
  );
  if (authFailed) {
    logSession(s, "warn", "搜尋過程偵測到 session 失效。請等待自動重登後再試一次。");
  }

  return Array.from(allByCid.values())
    .filter((c) => c.isClassing)
    // v0.8.13：client-side 二次過濾 hours — 本來 elearn server 應該照 body
    // certification_hours_minimum/maximum 過濾，使用者實測沒效果（可能 server
    // 不認那兩個 param 或 silently ignore），加 client filter 確保使用者輸的
    // 範圍真的會生效。沒 hoursMin / hoursMax 的話這個 filter 是 no-op。
    .filter((c) => {
      const h = c.certification_hours ?? 0;
      if (hoursMin !== undefined && h < hoursMin) return false;
      if (hoursMax !== undefined && h > hoursMax) return false;
      return true;
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
}

// ── Stuck-state watchdog（per-session）─────────────────────────
let stuckWatchdogTimer: NodeJS.Timeout | null = null;
function startStuckStateWatchdog() {
  if (stuckWatchdogTimer) return;
  stuckWatchdogTimer = setInterval(() => {
    for (const s of listSessions()) {
      if (s.state.status !== s.lastObservedStatus) {
        s.lastObservedStatus = s.state.status;
        s.lastStatusChangeAt = Date.now();
        continue;
      }
      const stuckMs = Date.now() - s.lastStatusChangeAt;
      const status = s.state.status;
      if (status === "await_login" && stuckMs > 5 * 60_000) {
        logSession(
          s,
          "warn",
          "登入流程卡住超過 5 分鐘，自動回到「第一次使用」畫面",
        );
        s.state.status = "setup";
        s.state.loginStatus = undefined;
        pushState();
        startSetupFallbackTimer(s);
        s.lastStatusChangeAt = Date.now();
      } else if (status === "enrolling" && stuckMs > 3 * 60_000) {
        logSession(s, "warn", "選課流程卡住超過 3 分鐘，自動回到課程列表");
        s.state.status = "selecting";
        pushState();
        s.lastStatusChangeAt = Date.now();
      }
    }
  }, 15_000);
}

function clearSetupFallbackTimer(s: AccountSession) {
  if (s.setupFallbackTimer) {
    clearTimeout(s.setupFallbackTimer);
    s.setupFallbackTimer = null;
  }
}
function startSetupFallbackTimer(s: AccountSession) {
  clearSetupFallbackTimer(s);
  s.setupFallbackTimer = setTimeout(async () => {
    s.setupFallbackTimer = null;
    if (s.state.status !== "setup") return;
    if (!s.view) return;
    const loggedIn = await isBrowserViewLoggedIn(s).catch(() => null);
    if (loggedIn !== true) return;
    logSession(s, "info", "偵測到 BrowserView 已登入，自動切換到操作畫面");
    s.state.status = "selecting";
    pushState();
    try {
      await dismissNuisancePopups(s.view.webContents);
      await refreshCourses(s);
    } catch (e) {
      logSession(s, "warn", `fallback 後刷新課程失敗：${e instanceof Error ? e.message : String(e)}`);
    }
  }, 30_000);
}

// ── Window / Tray ──────────────────────────────────────────────
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

function requestRendererGeminiDialog(): void {
  mainWindow?.webContents.send(IPC.GEMINI_DIALOG_REQUEST);
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

function createWindow() {
  const iconPath = join(app.getAppPath(), "resources/icon.ico");
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    icon: iconPath,
    title: "未命名 - 記事本",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.on("page-title-updated", (e) => {
    e.preventDefault();
    if (mainWindow && mainWindow.getTitle() !== "未命名 - 記事本") {
      mainWindow.setTitle("未命名 - 記事本");
    }
  });
  mainWindow.on("move", () => {
    if (!mainWindow) return;
    const bounds = mainWindow.getBounds();
    const wa = screen.getDisplayMatching(bounds).workArea;
    const MARGIN = 100;
    const x = Math.max(
      wa.x - bounds.width + MARGIN,
      Math.min(bounds.x, wa.x + wa.width - MARGIN),
    );
    const y = Math.max(wa.y, Math.min(bounds.y, wa.y + wa.height - MARGIN));
    if (x !== bounds.x || y !== bounds.y) mainWindow.setPosition(x, y);
  });
  mainWindow.on("ready-to-show", () => mainWindow?.show());
  // v0.8.21: close button → hide to tray, only really quit via tray menu
  // 「結束」(which sets isQuittingForReal=true first). Minimise also hides
  // so the taskbar entry disappears, matching user's stealth use case.
  mainWindow.on("close", (e) => {
    if (!isQuittingForReal && mainWindow && !mainWindow.isDestroyed()) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on("minimize", ((e: Electron.Event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      e.preventDefault();
      mainWindow.hide();
    }
  }) as never);

  // v0.8.22: re-apply last-known BrowserView bounds after window state
  // changes — show (from tray), restore, maximize / unmaximize, full-screen
  // toggles. Without this the BrowserView keeps its old bounds and ends up
  // misaligned with the new chrome (left half of UI overlaps blank space,
  // right half shows clipped elearn page).
  //
  // v0.8.25：debounce — show/restore/maximize/unmaximize/full-screen 一連串
  // event 同時 fire（最多 4-5 個 in tens of ms），加上 renderer 的 ResizeObserver
  // 也會推 bounds，瞬間 N 倍 setBounds + IPC 灌進 main → tray restore 後 UI
  // 凍住要強關。改成 200ms debounce + 不再 listen resize（renderer 已 handle）。
  let _reapplyTimer: NodeJS.Timeout | null = null;
  const reapplyActiveBounds = () => {
    if (_reapplyTimer) clearTimeout(_reapplyTimer);
    _reapplyTimer = setTimeout(() => {
      _reapplyTimer = null;
      const active = getActiveSession();
      if (!active?.view || !mainWindow || mainWindow.isDestroyed()) return;
      try {
        active.view.setBounds(lastBounds);
      } catch {
        /* swallow */
      }
      // v0.8.25：tray restore 後讓 renderer 重拿 focus，避免 input 看起來鎖死
      try {
        mainWindow?.webContents.focus();
      } catch {
        /* swallow */
      }
    }, 200);
  };
  mainWindow.on("show", reapplyActiveBounds);
  mainWindow.on("restore", reapplyActiveBounds);
  mainWindow.on("maximize", reapplyActiveBounds);
  mainWindow.on("unmaximize", reapplyActiveBounds);
  mainWindow.on("enter-full-screen", reapplyActiveBounds);
  mainWindow.on("leave-full-screen", reapplyActiveBounds);
  // 不再 listen "resize" — renderer ResizeObserver 已即時推 lastBounds 過來，
  // main 端再加一條會 dup + race 造成 tray restore flood
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

  // ── 啟動模式：picker ─────────────────────────────────────
  // 不論有沒有帳號 record，第一個畫面都是 picker。Renderer 看 multi.pickerAccounts 列表決定要不要顯示「+ 新增帳號」。
  multiMode = "picker";
  setActiveId(null);
  pushState();

  startStuckStateWatchdog();
}

// ── 多帳號 IPC handlers ───────────────────────────────────────
async function openExistingAccountAsTab(record: AccountRecord): Promise<AccountOpResult> {
  const creds = loadAccountCreds(record.id);
  if (!creds) {
    return { ok: false, reason: "找不到該帳號的儲存資料（可能已被移除）" };
  }
  let session = getSession(record.id);
  if (!session) {
    session = makeSession({
      id: record.id,
      record,
      account: creds.account,
      password: creds.password,
      startUrl: ECPA_LOGIN_URL,
    });
    // 主動跑一次 auto-login（而非等 detectLogin 自然偵測）
    void tryAutoLogin(session).catch(() => void 0);
  }
  setActiveSessionAndShow(record.id);
  return { ok: true };
}

async function beginAddAccount(): Promise<AccountOpResult> {
  // 建一個 random-id pending session，跑 fresh BrowserView 到 eCPA login，
  // 等 sniffer 抓到帳密後 re-key + 進 post_login 模式。
  const pendingId = `pending-${randomBytes(6).toString("hex")}`;
  const fakeRecord: AccountRecord = {
    id: pendingId,
    nickname: "新增中…",
    maskedAccount: "—",
    pinHash: "",
    pinSalt: "",
    addedAt: new Date().toISOString(),
  };
  const session = makeSession({
    id: pendingId,
    record: fakeRecord,
    account: "",
    password: "",
    startUrl: ECPA_LOGIN_URL,
  });
  pendingNewSessionId = pendingId;
  session.state.status = "setup";
  setActiveSessionAndShow(pendingId);
  logGlobal("info", "請在右邊瀏覽器登入 e 等公務園，登入完成後會請你設定暱稱與 PIN");
  return { ok: true };
}

async function cancelAddAccount(): Promise<void> {
  if (!pendingNewSessionId) return;
  const s = getSession(pendingNewSessionId);
  if (s) await destroySession(s);
  pendingNewSessionId = null;
  postLoginState = null;
  multiMode = "picker";
  setActiveId(null);
  pushState();
}

async function finishNewAccount(payload: {
  nickname: string;
  pin: string;
}): Promise<AccountOpResult> {
  if (!pendingNewSessionId) return { ok: false, reason: "沒有進行中的新增帳號流程" };
  const s = getSession(pendingNewSessionId);
  if (!s) return { ok: false, reason: "pending session 不存在" };
  if (!s.account || !s.password)
    return { ok: false, reason: "尚未偵測到帳密，請先在右邊登入" };
  const nickname = (payload.nickname ?? "").trim();
  if (!nickname) return { ok: false, reason: "暱稱不能為空" };
  if (nickname.length > 20) return { ok: false, reason: "暱稱不要超過 20 字" };
  const pinCheck = validatePinFormat(payload.pin);
  if (!pinCheck.ok) return { ok: false, reason: pinCheck.reason };

  const salt = newSalt();
  const record: AccountRecord = {
    id: s.id,
    nickname,
    maskedAccount: maskAccount(s.account),
    pinHash: hashPin(payload.pin, salt),
    pinSalt: salt,
    addedAt: s.record.addedAt,
    lastUsedAt: new Date().toISOString(),
  };
  const credsRes = saveAccountCreds(s.id, { account: s.account, password: s.password });
  if (!credsRes.ok) return { ok: false, reason: `儲存帳密失敗：${credsRes.reason}` };
  upsertAccount(record);
  s.record = record;
  setLastActive(s.id);

  pendingNewSessionId = null;
  postLoginState = null;
  multiMode = "active";
  // 推 post-login 流程之後，detectLogin 已經完成，但 status 還是 setup —— 翻到 selecting
  s.state.status = "selecting";
  // 把已經登入的畫面推進 dashboard 流程
  if (s.view) {
    void dismissNuisancePopups(s.view.webContents).catch(() => void 0);
    void refreshCourses(s).catch(() => void 0);
  }
  startLoginWatchdog(s);
  pushState();
  logSession(s, "info", `已新增帳號「${nickname}」並儲存到帳號列表`);
  return { ok: true };
}

async function verifyPinAndOpen(payload: {
  id: string;
  pin: string;
}): Promise<AccountOpResult> {
  const record = getAccount(payload.id);
  if (!record) return { ok: false, reason: "找不到該帳號" };
  if (!record.pinHash || !record.pinSalt) return { ok: false, reason: "該帳號尚未設定 PIN" };
  const pinCheck = validatePinFormat(payload.pin);
  if (!pinCheck.ok) return { ok: false, reason: pinCheck.reason };
  const ok = verifyPin(payload.pin, record.pinSalt, record.pinHash);
  if (!ok) {
    pinTarget = pinTarget
      ? { ...pinTarget, failedAttempts: (pinTarget.failedAttempts ?? 0) + 1 }
      : null;
    pushState();
    return { ok: false, reason: "PIN 不正確" };
  }
  pinTarget = null;
  // v0.8.1：locked tab 已 open 時，verify 通過直接解鎖 + 顯示，不要重建 session
  // （那會 detach view、丟失正在跑的 pipeline）
  // v0.8.2：通過 PIN 後刷新 grace 起點 — 之後 5 分鐘內切換不需要重輸
  const existing = getSession(record.id);
  if (existing) {
    existing.unlocked = true;
    existing.lastUnlockedAt = Date.now();
    setActiveSessionAndShow(record.id);
    return { ok: true };
  }
  return openExistingAccountAsTab(record);
}

async function closeTab(id: string): Promise<AccountOpResult> {
  const s = getSession(id);
  if (!s) return { ok: false, reason: "tab 不存在" };
  if (pendingNewSessionId === id) {
    // 關掉新增中的 tab = 取消新增
    await cancelAddAccount();
    return { ok: true };
  }
  await destroySession(s);
  // 如果 active 是它，回 picker 讓使用者選下一個
  if (getActiveId() === id || getActiveId() === null) {
    multiMode = "picker";
    setActiveId(null);
    pushState();
  } else {
    pushState();
  }
  logGlobal("info", `已關閉 ${s.record.nickname} 的 tab（pipeline 已停，帳號保留在 picker）`);
  return { ok: true };
}

// v0.8.1：tab 鎖定 — 把 unlocked 翻 false。如果是 active tab，UI 即刻變成 PIN 輸入；
// 否則只是把 lock icon 點亮，下次切換到那個 tab 才會要求 PIN。
// v0.8.2：手動鎖會跳過 5-min grace（lastUnlockedAt 倒推到很久以前），切過去一定要 PIN。
async function lockTabOp(id: string): Promise<AccountOpResult> {
  const s = getSession(id);
  if (!s) return { ok: false, reason: "tab 不存在" };
  s.unlocked = false;
  s.lastUnlockedAt = 0;
  if (getActiveId() === id) {
    // 當下就把 view 藏掉 + 切 PIN 模式，避免使用者離開電腦那瞬間還露出畫面
    hideElearnView(s.view);
    pinTarget = {
      id: s.id,
      nickname: s.record.nickname,
      maskedAccount: s.record.maskedAccount,
      failedAttempts: 0,
    };
    multiMode = "pin";
  }
  pushState();
  return { ok: true };
}

async function lockActiveTabOp(): Promise<AccountOpResult> {
  const s = getActiveSession();
  if (!s) return { ok: false, reason: "沒有 active 帳號" };
  return lockTabOp(s.id);
}

// v0.8.1：左側表單一次填齊 → 靜默 SSO + 建 session + 寫入帳號。沒有右側 BrowserView
// 互動，使用者也不需要在 web 上動手。loginViaEcpa 走 net.request 共用 cookie jar。
async function submitNewAccount(payload: {
  account: string;
  password: string;
  nickname: string;
  pin: string;
}): Promise<AccountOpResult> {
  const account = (payload.account ?? "").trim();
  const password = payload.password ?? "";
  const nickname = (payload.nickname ?? "").trim();
  const pin = payload.pin ?? "";

  if (!account) return { ok: false, reason: "請輸入 e 等公務園帳號" };
  if (!password) return { ok: false, reason: "請輸入密碼" };
  if (!nickname) return { ok: false, reason: "請取一個暱稱" };
  if (nickname.length > 20) return { ok: false, reason: "暱稱不要超過 20 字" };
  const pinCheck = validatePinFormat(pin);
  if (!pinCheck.ok) return { ok: false, reason: pinCheck.reason };

  pushSecretToMaskList(account, maskAccount(account));

  // v0.8.6：先「便宜」確認 alias → full ID（1 個 GetUID HTTP，~1-2s），再決定 partition。
  // 這樣完整 SSO 鏈只跑一次，不再「猜 partition → 跑完整 SSO → 發現不對 → 換 partition →
  // 再跑一次完整 SSO」浪費 30-60s。完整 ID 的 case 直接跳過 GetUID。
  const isFullId = /^[A-Za-z]\d{9}$/.test(account);
  let resolved = account;
  if (!isFullId) {
    logGlobal("info", `正在解析帳號 ${maskAccount(account)} ...`);
    // 用 default session 解析就好（不會留下任何 cookie 給後續 SSO 用）
    const lookup = await resolveAlias(sessionModule.defaultSession, account);
    if (!lookup) {
      return {
        ok: false,
        reason: "無法解析帳號（可能是別名打錯、eCPA 暫時無法使用、或帳號被鎖）",
      };
    }
    resolved = lookup;
  }
  const realId = computeAccountId(resolved);
  const dup = getAccount(realId);
  if (dup) {
    return {
      ok: false,
      reason: `這個帳號已經在列表中（${dup.nickname}）`,
    };
  }

  pushSecretToMaskList(resolved, maskAccount(resolved));

  // 直接在 real partition 跑一次 SSO
  const partition = partitionIdFor(realId);
  const partSess = sessionModule.fromPartition(partition);
  // v0.8.6：fresh partition 不需要 clearStorageData（無資料可清）；只有遇到舊
  // partition 殘骸才清。判斷方式：partition 已有 elearn cookies = 舊資料。
  const existingCookies = await partSess.cookies
    .get({ url: "https://elearn.hrd.gov.tw/" })
    .catch(() => []);
  if (existingCookies.length > 0) {
    await partSess.clearStorageData().catch(() => void 0);
  }

  logGlobal("info", `正在背景登入 ${maskAccount(resolved)} ...`);
  // v0.8.13：每步進度推給 UI，使用者看得到沒卡死。stage label 中文化讓使用者知道
  // 在做什麼。
  const stageLabels: Record<string, string> = {
    prime: "連線 e 等公務園",
    clogin: "進入 eCPA 登入頁",
    getuid: "解析帳號",
    ticket: "驗證帳密",
    "twoway-log": "登入紀錄",
    "twoway-app": "切到應用",
    "sso-verify": "SSO 跳回 e 等",
    "verify-cookie": "確認 session",
  };
  const r = await loginViaEcpa(partSess, resolved, password, (s, ms) => {
    const label = stageLabels[s] ?? s;
    if (ms > 5000) {
      logGlobal("warn", `登入步驟 [${label}] ${ms}ms — server 較慢`);
    } else {
      logGlobal("info", `登入步驟 [${label}] ${ms}ms ✓`);
    }
  });
  if (!r.ok) {
    // v0.8.11：第一次登入要先啟用帳號 → 把 activation 資訊一起傳給 renderer
    // 顯示「前往啟用帳號」按鈕（用 shell.openExternal 開外部瀏覽器）。
    if (r.activationRequired) {
      logGlobal(
        "warn",
        `${maskAccount(resolved)} 第一次登入需要先啟用帳號（${r.activationUrl ?? "去 ecpa.dgpa.gov.tw 找啟用入口"}）`,
      );
      return {
        ok: false,
        reason: r.error ?? "需要先啟用帳號",
        activationRequired: true,
        activationUrl: r.activationUrl,
      };
    }
    return {
      ok: false,
      reason: `登入失敗（${r.stage ?? "?"}）：${r.error ?? "unknown"}`,
    };
  }

  // Step 2: 寫入儲存層（creds + record + PIN）
  const credsRes = saveAccountCreds(realId, { account: resolved, password });
  if (!credsRes.ok) return { ok: false, reason: `儲存帳密失敗：${credsRes.reason}` };
  const salt = newSalt();
  const record: AccountRecord = {
    id: realId,
    nickname,
    maskedAccount: maskAccount(resolved),
    pinHash: hashPin(pin, salt),
    pinSalt: salt,
    addedAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
  };
  upsertAccount(record);
  setLastActive(realId);

  // Step 3: 建 BrowserView session — 用同一個 partition，cookies 自動繼承
  const accountSession = makeSession({
    id: realId,
    record,
    account: resolved,
    password,
    startUrl: "https://elearn.hrd.gov.tw/mooc/user/learn_dashboard.php",
  });
  accountSession.state.status = "selecting";
  setActiveSessionAndShow(realId);
  startLoginWatchdog(accountSession);
  // refreshCourses 不等：dashboard 一 dom-ready 就會 fire detectLogin → refreshCourses
  logSession(accountSession, "info", `已新增帳號「${nickname}」並登入成功`);
  return { ok: true };
}

async function removeAccount(id: string): Promise<AccountOpResult> {
  const record = getAccount(id);
  const s = getSession(id);
  if (s) await destroySession(s);
  if (pendingNewSessionId === id) pendingNewSessionId = null;
  removeAccountRecord(id);
  // 清掉 partition data，不留 cookie 殘骸
  await clearPartitionDataFor([id]);
  if (getActiveId() === null || getActiveId() === id) {
    multiMode = "picker";
    setActiveId(null);
  }
  pushState();
  logGlobal(
    "info",
    `已從帳號列表移除「${record?.nickname ?? id}」（cookie / 帳密 / PIN 全清）`,
  );
  return { ok: true };
}

async function clearAllAccountsHandler(): Promise<AccountOpResult> {
  const records = listAccounts();
  const ids = records.map((r) => r.id);
  for (const s of listSessions()) {
    await destroySession(s);
  }
  pendingNewSessionId = null;
  pinTarget = null;
  resetPinState = null;
  postLoginState = null;
  clearAllAccountRecords();
  await clearPartitionDataFor(ids);
  multiMode = "picker";
  setActiveId(null);
  // v0.8.6：使用者回報「清除後無法輸入」— 防禦性把 BrowserView bounds 歸零、
  // 把焦點明確還給 renderer（避免上一個 session 的 view destroy 殘留焦點）。
  // 全部 session 都已 destroy，這裡 setBounds 找不到 view 不會炸；只是把
  // lastBounds 記成 0 讓下次新增的帳號 view 一開始就不可見。
  lastBounds = { x: 0, y: 0, width: 0, height: 0 };
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.focus();
      mainWindow.webContents.focus();
    } catch {
      /* swallow */
    }
  }
  pushState();
  // 多推一次 state，覆蓋 renderer 在 unmount→mount transition 之間錯過的訊息
  setTimeout(() => pushState(), 60);
  logGlobal("info", `已清除全部 ${ids.length} 個帳號（cookie / 帳密 / PIN / pipeline 全清）`);
  return { ok: true };
}

// ── App lifecycle ──────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    mainWindow.flashFrame(true);
    setTimeout(() => mainWindow?.flashFrame(false), 2000);
  });

  app.on("before-quit", () => {
    isQuittingForReal = true;
  });

  app.on("will-quit", () => {
    if (purgeTimer) {
      clearTimeout(purgeTimer);
      purgeTimer = null;
    }
    if (tray) {
      tray.destroy();
      tray = null;
    }
  });

  app.whenReady().then(() => {
    electronApp.setAppUserModelId("tw.kevin.auto-elearn");

    const mig = migrateFromOldUserDataIfNeeded();
    const portMig = migrateUserDataToPortableIfNeeded();

    rebindLogsDirToUserData();

    if (mig.ranThisLaunch) {
      logGlobal(
        "info",
        `偵測到 v0.5.x 舊資料夾，已搬到新位置：` +
          `成功 ${mig.migrated.length} 個（${mig.migrated.join(", ") || "—"}）` +
          (mig.skippedAlreadyExists.length
            ? `；跳過已存在 ${mig.skippedAlreadyExists.length} 個`
            : "") +
          (mig.failed.length ? `；失敗 ${mig.failed.length} 個` : ""),
      );
    }
    if (portMig.ranThisLaunch) {
      logGlobal(
        "info",
        `已切換為 portable 模式：把 %APPDATA% 的資料搬到 .exe 旁邊的資料夾：` +
          `成功 ${portMig.migrated.length} 個（${portMig.migrated.join(", ") || "—"}）` +
          (portMig.skippedAlreadyExists.length
            ? `；跳過已存在 ${portMig.skippedAlreadyExists.length} 個`
            : "") +
          (portMig.failed.length ? `；失敗 ${portMig.failed.length} 個` : ""),
      );
    }
    if (!mig.ranThisLaunch && !portMig.ranThisLaunch) {
      appendLogLine(
        "info",
        `資料夾：${getStorageDir()}（portable 模式：${app.isPackaged ? "是" : "否（dev）"}）`,
      );
    }

    runScheduledPurge("startup");
    scheduleNextMidnightPurge();

    app.on("browser-window-created", (_, w) => optimizer.watchWindowShortcuts(w));
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (!isQuittingForReal) return;
  if (process.platform !== "darwin") app.quit();
});

// ── IPC ───────────────────────────────────────────────────────
ipcMain.handle(IPC.STATE_GET, () => {
  // Build the same shape pushState sends
  const active = getActiveSession();
  return active
    ? { ...active.state, isFirstRun: isFirstRun(), multi: buildMultiInfo() }
    : {
        ...createInitialState(),
        logs: _bootstrapLogs.slice(),
        isFirstRun: isFirstRun(),
        multi: buildMultiInfo(),
      };
});

ipcMain.on(IPC.VIEW_BOUNDS, (_evt, b: ViewBounds) => {
  if (!mainWindow) return;
  const [winW, winH] = mainWindow.getContentSize();
  const x = Math.max(0, Math.floor(b.x));
  const y = Math.max(0, Math.floor(b.y));
  const width = Math.max(0, Math.min(winW - x, Math.floor(b.width)));
  const height = Math.max(0, Math.min(winH - y, Math.floor(b.height)));
  lastBounds = { x, y, width, height };
  const active = getActiveSession();
  if (active?.view) {
    // v0.8.13：原本 v0.8.12 用 isWithinPinGrace gate 是 bug — grace 5 分鐘後過期，
    // 但使用者其實還在這個 tab 上正常使用，沒主動鎖定。grace 過期後 resize 推
    // 過來的 bounds 被拒絕，BrowserView 卡舊 bounds → 黑色空隙。
    // 改用 unlocked 旗標：unlocked=true 一直到使用者主動鎖或 PIN modal 出現
    // 才會翻 false，跟「使用了多久」無關。
    if (!active.unlocked) return;
    try {
      active.view.setBounds(lastBounds);
    } catch {
      /* swallow */
    }
  }
});

ipcMain.on(IPC.NAVIGATE_VIEW, (_evt, url: string) => {
  const s = getActiveSession();
  if (!s?.view) return;
  s.view.webContents.loadURL(url).catch(() => void 0);
});

ipcMain.on(IPC.ACTION_PAUSE, () => {
  const s = getActiveSession();
  if (!s) return;
  // v0.8.3：之前只翻 state.status，但 chain / heartbeat 沒讀，等於暫停假動作。
  // 改翻 pauseSignal 讓 awaitNotPaused gate 真的擋住下一步。
  s.pauseSignal.paused = true;
  s.state.status = "paused";
  s.state.pauseReason = "manual";
  logSession(s, "info", "使用者手動暫停（考試/問卷/心跳會在下一個步驟邊界停下）");
  pushState();
});

ipcMain.on(IPC.ACTION_RESUME, () => {
  const s = getActiveSession();
  if (!s) return;
  s.pauseSignal.paused = false;
  s.state.status = "running";
  s.state.pauseReason = undefined;
  logSession(s, "info", "使用者恢復");
  pushState();
});

ipcMain.on(IPC.ACTION_ABORT, () => {
  const s = getActiveSession();
  if (s) {
    s.abortSignal.aborted = true;
    // 順便清 paused，免得 awaitNotPaused 卡在 sleep loop 裡（abort=true 已會解，
    // 但 paused=true 視覺/log 會繼續顯示「暫停中」一拍，清掉乾淨）
    s.pauseSignal.paused = false;
    stopSessionWatchdog(s);
    s.state.status = "aborted";
    persistRun(s, "aborted");
    logSession(s, "info", "使用者中止");
    pushState();
  }
  setTimeout(() => app.quit(), 300);
});

ipcMain.on(IPC.ACTION_BACK, async () => {
  const s = getActiveSession();
  if (!s) return;
  s.abortSignal.aborted = true;
  stopSessionWatchdog(s);
  // v0.8.7+v0.8.8：回到選課畫面 = fresh start；釋放佔住的課程 + 清掉退選防呆 set
  releaseAllCoursesForAccount(s.id);
  s.recentlyUnenrolled.clear();
  s.state.status = "selecting";
  s.state.pauseReason = undefined;
  s.state.now = { action: "idle" };
  s.state.pipelineCids = undefined;
  s.runningCids.clear();
  s.focusedCid = null;
  s.pipelineRunning = false;
  clearRun(s.id);
  logSession(s, "info", "返回選課畫面");
  if (s.view) s.view.webContents.loadURL(HOMEPAGE).catch(() => void 0);
  await refreshCourses(s);
  pushState();
});

ipcMain.on(IPC.REFRESH_COURSES, () => {
  const s = getActiveSession();
  if (!s) return;
  refreshCourses(s).catch(() => void 0);
});

ipcMain.handle(IPC.SEARCH_COURSES, async (_evt, payload: string | SearchOptions) => {
  const s = getActiveSession();
  if (!s) return [] as CourseCandidate[];
  try {
    const opts: SearchOptions =
      typeof payload === "string" ? { keyword: payload } : (payload ?? {});
    const results = await keywordSearch(s, opts);
    const human =
      opts.keyword || opts.mainCategoryId || opts.subCategoryId || opts.fromSchoolId
        ? `kw="${opts.keyword ?? ""}" cat=${opts.subCategoryId || opts.mainCategoryId || "-"} school=${opts.fromSchoolId || "-"}${
            opts.hoursMin || opts.hoursMax
              ? ` hr=${opts.hoursMin ?? 0}~${opts.hoursMax ?? "∞"}`
              : ""
          }`
        : "(全部)";
    logSession(s, "info", `搜尋 ${human}: ${results.length} 筆`);
    return results;
  } catch (e) {
    logSession(s, "error", `搜尋失敗：${e instanceof Error ? e.message : String(e)}`);
    return [] as CourseCandidate[];
  }
});

ipcMain.handle(IPC.CATEGORY_CHILDREN, async (_evt, parentId: string) => {
  const s = getActiveSession();
  if (!s?.view) return [];
  if (!parentId || !parentId.trim()) return [];
  try {
    const session = s.view.webContents.session;
    return await getCategoryChildren(session, parentId.trim());
  } catch (e) {
    logSession(
      s,
      "warn",
      `次類別取得失敗 (${parentId})：${e instanceof Error ? e.message : String(e)}`,
    );
    return [];
  }
});

ipcMain.handle(IPC.SEARCH_BY_CODES, async (_evt, codes: string[]) => {
  const s = getActiveSession();
  if (!s?.view) return [] as CourseCandidate[];
  const session = s.view.webContents.session;
  const clean = Array.from(
    new Set((codes || []).map((c) => String(c).trim()).filter(Boolean)),
  );
  if (clean.length === 0) return [] as CourseCandidate[];

  const resolved = resolveAgencyCodes(clean);
  const known = resolved.filter((r) => r.resolution);
  const unknown = resolved.filter((r) => !r.resolution).map((r) => r.input);
  if (unknown.length) {
    logSession(s, "warn", `代碼 ${unknown.join(", ")} 沒有對應分類，已略過`);
  }
  if (known.length === 0) return [] as CourseCandidate[];

  const groups = groupByCategory(known);
  logSession(
    s,
    "info",
    `用代碼搜尋：${clean.join(", ")} → ${groups
      .map((g) => `${g.labels.join("/")} (cat=${g.categoryId})`)
      .join("; ")}`,
  );

  const byCid = new Map<string, Course>();
  const mineCids = new Set(s.state.courses.map((c) => c.cid));
  let codeAuthFailed = false;
  for (const g of groups) {
    if (codeAuthFailed) break;
    try {
      await primeExplorer(session, g.categoryId);
      const broad = await searchCourses(session, g.categoryId, "", 50);
      logSession(
        s,
        "info",
        `  cat=${g.categoryId} broad sweep: ${broad.length} 筆 (isClassing=${broad.filter((c) => c.isClassing).length})`,
      );
      for (const r of broad) if (!byCid.has(r.cid)) byCid.set(r.cid, r);
      for (const kw of g.keywords) {
        const results = await searchCourses(session, g.categoryId, kw, 50);
        logSession(s, "info", `  cat=${g.categoryId} kw="${kw}": ${results.length} 筆`);
        for (const r of results) if (!byCid.has(r.cid)) byCid.set(r.cid, r);
      }
    } catch (e) {
      if (e instanceof ElearnAuthError) {
        codeAuthFailed = true;
        logSession(
          s,
          "error",
          `${g.labels.join("/")} (cat=${g.categoryId}) 查詢失敗：${e.message}`,
        );
      } else {
        logSession(
          s,
          "warn",
          `${g.labels.join("/")} (cat=${g.categoryId}) 查詢失敗：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }
  logSession(
    s,
    "info",
    `  併集 byCid: ${byCid.size} 筆 (isClassing=${Array.from(byCid.values()).filter((c) => c.isClassing).length})`,
  );

  const allKeywords = groups.flatMap((g) => g.keywords);
  const anyKeywordRequested = allKeywords.length > 0;
  const allLabels = groups.flatMap((g) => g.labels);
  const anyGroupWantsEverything = groups.some((g) => g.keywords.length === 0);

  const applyPostFilter = (pool: Map<string, Course>): CourseCandidate[] =>
    Array.from(pool.values())
      .filter((c) => c.isClassing)
      .filter((c) => {
        if (!anyKeywordRequested) return true;
        if (anyGroupWantsEverything) return true;
        const haystack = `${c.caption} ${c.category_full_path ?? ""} ${c.content ?? ""}`;
        return (
          allKeywords.some((k) => haystack.includes(k)) ||
          allLabels.some((l) => haystack.includes(l))
        );
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
  logSession(s, "info", `代碼搜尋共 ${out.length} 筆`);
  if (out.length === 0 && anyKeywordRequested && !codeAuthFailed) {
    const fallbackTerms = Array.from(new Set([...allKeywords, ...allLabels])).filter(Boolean);
    for (const term of fallbackTerms) {
      try {
        const results = await searchCourses(session, "", term, 100);
        logSession(s, "info", `  fallback 全站 kw="${term}": ${results.length} 筆`);
        for (const r of results) if (!byCid.has(r.cid)) byCid.set(r.cid, r);
      } catch (e) {
        if (e instanceof ElearnAuthError) {
          codeAuthFailed = true;
          logSession(s, "error", `fallback "${term}" 失敗：${e.message}`);
          break;
        }
        logSession(s, "warn", `fallback "${term}" 失敗：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    out = applyPostFilter(byCid);
    logSession(s, "info", `代碼搜尋(fallback)共 ${out.length} 筆`);
  }
  if (codeAuthFailed) {
    logSession(s, "warn", "搜尋過程偵測到 session 失效。請等待自動重登後再試一次。");
  }
  return out;
});

ipcMain.handle(IPC.UNENROLL_COURSE, async (_evt, cid: string) => {
  const s = getActiveSession();
  if (!s?.view) return { ok: false, error: "沒有 active 帳號" };
  const card = s.state.courses.find((c) => c.cid === cid);
  const name = card?.name ?? cid;
  logSession(s, "info", `嘗試退選：${name}`);
  const res = await unenrollCourse(cid, s.view.webContents.session);
  if (res.ok) {
    // v0.8.7：記住使用者剛退選 — 即使 server 還沒同步、即使 renderer selectedCids
    // 沒同步刷掉，下次 runPipelineFor 也不要把這個 cid auto-enrol 回來
    s.recentlyUnenrolled.add(cid);
    await refreshCourses(s);
    // v0.8.7：refresh 後驗證 server 端真的移除了 — 沒移除就明確警告（不擋
    // pipeline，但讓使用者知道）。常見原因：unenroll click 收到 confirm 但
    // server 處理失敗 / 課程在「退選期」之外。
    const stillEnrolled = s.state.courses.some((c) => c.cid === cid);
    if (stillEnrolled) {
      logSession(
        s,
        "warn",
        `⚠ 退選 ${name} 後 server 仍顯示已選 — 可能 server 還在同步、或這門課現在不能退選。下次 pipeline 會跳過 auto-enrol，但 server 真實狀態是「仍已選」。`,
      );
    } else {
      logSession(s, "info", `退選完成（server 已同步）：${name}`);
    }
  } else {
    logSession(s, "warn", `退選失敗 ${name}：${res.error ?? "unknown"}`);
  }
  return res;
});

ipcMain.on(IPC.PIPELINE_START, (_evt, cids: string[]) => {
  const s = getActiveSession();
  if (!s) {
    logGlobal("warn", "沒有 active 帳號，無法啟動 pipeline");
    return;
  }
  if (!Array.isArray(cids) || cids.length === 0) {
    logSession(s, "warn", "沒有選取任何課程");
    return;
  }
  const unique = Array.from(
    new Set(cids.filter((c) => typeof c === "string" && c)),
  );
  logSession(s, "info", `啟動 pipeline：${unique.length} 門課`);
  runPipelineFor(s, unique).catch((e) =>
    logSession(s, "error", `Pipeline 執行失敗：${e instanceof Error ? e.message : String(e)}`),
  );
});

ipcMain.on(IPC.RESUME_ANSWER, (_evt, resume: boolean) => {
  const s = getActiveSession();
  if (!s) return;
  const prev = loadRun(s.id);
  if (!prev || !prev.pipelineCids.length) return;
  if (!resume) {
    clearRun(s.id);
    logSession(s, "info", "使用者選擇不恢復上次進度");
    return;
  }
  logSession(s, "info", `恢復上次中斷的進度（${prev.pipelineCids.length} 門）`);
  runPipelineFor(s, prev.pipelineCids).catch((e) =>
    logSession(s, "error", `恢復 pipeline 失敗：${e instanceof Error ? e.message : String(e)}`),
  );
});

// Stealth
ipcMain.handle(IPC.STEALTH_STATUS, () => stealthCurrentState());
ipcMain.handle(IPC.STEALTH_UNLOCK, (_evt, secret: string) => stealthTryUnlock(secret));
ipcMain.handle(IPC.STEALTH_SET_SECRET, (_evt, secret: string) => stealthSetSecret(secret));
ipcMain.on(IPC.STEALTH_LOCK, () => stealthLock());
ipcMain.handle(IPC.STEALTH_CLEAR_SECRET, () => {
  stealthClearSecret();
  logGlobal("info", "已解除偽裝模式（清掉密碼），下次打開會直接看到真正畫面");
  return { ok: true };
});
ipcMain.handle(IPC.STEALTH_CONFIG_PATH, () => storagePath("config.json"));

// Gemini
ipcMain.handle(IPC.GEMINI_KEY_GET, () => loadConfig().geminiApiKey ?? "");
ipcMain.handle(IPC.GEMINI_KEY_SET, (_evt, key: string) => {
  saveConfig({ geminiApiKey: key.trim() || undefined });
});
ipcMain.on(IPC.OPEN_GEMINI_DIALOG, () => requestRendererGeminiDialog());

// First run + logs + version
ipcMain.on(IPC.ACK_FIRST_RUN, () => {
  ackFirstRun();
  pushState();
});
ipcMain.on(
  IPC.RENDERER_LOG,
  (_evt, payload: { level: "info" | "warn" | "error"; msg: string }) => {
    if (!payload || typeof payload.msg !== "string") return;
    const lvl = payload.level === "warn" || payload.level === "error" ? payload.level : "info";
    appendLogLine(lvl, maskLog(payload.msg), "renderer");
  },
);
ipcMain.on(IPC.OPEN_LOGS_FOLDER, () => {
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

// v0.8.11：開外部瀏覽器，限定 ecpa.dgpa.gov.tw / elearn.hrd.gov.tw / moica /
// nat.gov.tw 之類的政府站。給「前往啟用帳號」按鈕用，避免 renderer 被 prompt
// injection 拐去開隨意網址。
ipcMain.handle(IPC.OPEN_EXTERNAL_URL, async (_evt, url: string): Promise<{ ok: boolean; reason?: string }> => {
  if (typeof url !== "string" || !url) return { ok: false, reason: "no url" };
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") {
      return { ok: false, reason: "non-http url blocked" };
    }
    const ALLOWED = [
      "ecpa.dgpa.gov.tw",
      "elearn.hrd.gov.tw",
      "moica.nat.gov.tw",
      "fido.nat.gov.tw",
      "nidp.nat.gov.tw",
    ];
    const okHost = ALLOWED.some((h) => u.host === h || u.host.endsWith("." + h));
    if (!okHost) {
      logGlobal("warn", `OPEN_EXTERNAL_URL 拒絕非白名單 host：${u.host}`);
      return { ok: false, reason: `host ${u.host} 不在白名單` };
    }
    await shell.openExternal(url);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
});

// ── 多帳號 IPC ────────────────────────────────────────────────
ipcMain.on(IPC.ACCOUNT_BEGIN_UNLOCK, (_evt, id: string) => {
  const r = getAccount(id);
  if (!r) return;
  pinTarget = {
    id: r.id,
    nickname: r.nickname,
    maskedAccount: r.maskedAccount,
    failedAttempts: 0,
  };
  resetPinState = null;
  postLoginState = null;
  multiMode = "pin";
  pushState();
});

ipcMain.handle(
  IPC.ACCOUNT_VERIFY_PIN,
  async (_evt, payload: { id: string; pin: string }): Promise<AccountOpResult> =>
    verifyPinAndOpen(payload),
);

ipcMain.on(IPC.ACCOUNT_CANCEL_UNLOCK, () => {
  pinTarget = null;
  if (multiMode === "pin") {
    // v0.8.1：取消 locked-active tab 的 PIN 輸入 → 退回 picker（保留 active session
    // 仍是 locked 狀態，回 picker 可以選別的帳號或新增）
    const active = getActiveSession();
    if (active && !active.unlocked) {
      setActiveSessionAndShow(null);
      return;
    }
    multiMode = getActiveId() ? "active" : "picker";
  }
  pushState();
});

ipcMain.on(IPC.ACCOUNT_SWITCH_ACTIVE, (_evt, id: string) => {
  const s = getSession(id);
  if (!s) return;
  setActiveSessionAndShow(id);
});

ipcMain.handle(
  IPC.ACCOUNT_CLOSE_TAB,
  async (_evt, id: string): Promise<AccountOpResult> => closeTab(id),
);

ipcMain.on(IPC.ACCOUNT_GO_PICKER, () => {
  setActiveSessionAndShow(null);
});

ipcMain.handle(IPC.ACCOUNT_ADD_BEGIN, async (): Promise<AccountOpResult> => beginAddAccount());

ipcMain.on(IPC.ACCOUNT_ADD_CANCEL, () => {
  void cancelAddAccount();
});

// v0.8.1：新版「左側表單」新增帳號入口
ipcMain.handle(
  IPC.ACCOUNT_ADD_SUBMIT,
  async (
    _evt,
    payload: { account: string; password: string; nickname: string; pin: string },
  ): Promise<AccountOpResult> => submitNewAccount(payload),
);

// v0.8.1：tab 鎖定
ipcMain.handle(
  IPC.ACCOUNT_LOCK_TAB,
  async (_evt, id: string): Promise<AccountOpResult> => lockTabOp(id),
);
ipcMain.handle(
  IPC.ACCOUNT_LOCK_ACTIVE,
  async (): Promise<AccountOpResult> => lockActiveTabOp(),
);

ipcMain.handle(
  IPC.ACCOUNT_FINISH_NEW,
  async (_evt, payload: { nickname: string; pin: string }): Promise<AccountOpResult> =>
    finishNewAccount(payload),
);

ipcMain.handle(
  IPC.ACCOUNT_SET_NICKNAME,
  async (_evt, payload: { id: string; nickname: string }): Promise<AccountOpResult> => {
    const r = getAccount(payload.id);
    if (!r) return { ok: false, reason: "帳號不存在" };
    const n = (payload.nickname ?? "").trim();
    if (!n) return { ok: false, reason: "暱稱不能為空" };
    if (n.length > 20) return { ok: false, reason: "暱稱不要超過 20 字" };
    setNicknameStored(payload.id, n);
    const s = getSession(payload.id);
    if (s) {
      s.record = { ...s.record, nickname: n };
    }
    pushState();
    return { ok: true };
  },
);

ipcMain.handle(
  IPC.ACCOUNT_SET_PIN,
  async (
    _evt,
    payload: { id: string; oldPin: string; newPin: string },
  ): Promise<AccountOpResult> => {
    const r = getAccount(payload.id);
    if (!r) return { ok: false, reason: "帳號不存在" };
    if (!verifyPin(payload.oldPin, r.pinSalt, r.pinHash)) {
      return { ok: false, reason: "原 PIN 不正確" };
    }
    const fmt = validatePinFormat(payload.newPin);
    if (!fmt.ok) return { ok: false, reason: fmt.reason };
    const salt = newSalt();
    setPinFor(payload.id, hashPin(payload.newPin, salt), salt);
    pushState();
    return { ok: true };
  },
);

ipcMain.on(IPC.ACCOUNT_RESET_PIN_BEGIN, (_evt, id: string) => {
  const r = getAccount(id);
  if (!r) return;
  resetPinState = { id: r.id, nickname: r.nickname, stage: "verify", failedAttempts: 0 };
  pinTarget = null;
  postLoginState = null;
  multiMode = "reset_pin";
  pushState();
});

ipcMain.handle(
  IPC.ACCOUNT_RESET_PIN_VERIFY,
  async (_evt, payload: { id: string; password: string }): Promise<AccountOpResult> => {
    const r = getAccount(payload.id);
    if (!r) return { ok: false, reason: "帳號不存在" };
    const creds = loadAccountCreds(payload.id);
    if (!creds) return { ok: false, reason: "找不到該帳號的儲存資料" };
    if ((payload.password ?? "") !== creds.password) {
      resetPinState = resetPinState
        ? { ...resetPinState, failedAttempts: (resetPinState.failedAttempts ?? 0) + 1 }
        : null;
      pushState();
      return { ok: false, reason: "e 等公務園密碼不正確" };
    }
    if (resetPinState && resetPinState.id === payload.id) {
      resetPinState = { ...resetPinState, stage: "set", failedAttempts: 0 };
      pushState();
    }
    return { ok: true };
  },
);

ipcMain.handle(
  IPC.ACCOUNT_RESET_PIN_COMPLETE,
  async (_evt, payload: { id: string; newPin: string }): Promise<AccountOpResult> => {
    const r = getAccount(payload.id);
    if (!r) return { ok: false, reason: "帳號不存在" };
    if (resetPinState?.id !== payload.id || resetPinState.stage !== "set") {
      return { ok: false, reason: "請重新走一次「忘記 PIN」流程" };
    }
    const fmt = validatePinFormat(payload.newPin);
    if (!fmt.ok) return { ok: false, reason: fmt.reason };
    const salt = newSalt();
    setPinFor(payload.id, hashPin(payload.newPin, salt), salt);
    resetPinState = null;
    multiMode = "picker";
    pushState();
    logGlobal("info", `已重設「${r.nickname}」的 PIN`);
    return { ok: true };
  },
);

ipcMain.on(IPC.ACCOUNT_RESET_PIN_CANCEL, () => {
  resetPinState = null;
  multiMode = getActiveId() ? "active" : "picker";
  pushState();
});

ipcMain.handle(
  IPC.ACCOUNT_REMOVE,
  async (_evt, id: string): Promise<AccountOpResult> => removeAccount(id),
);

ipcMain.handle(IPC.ACCOUNT_LOGOUT_ACTIVE, async (): Promise<AccountOpResult> => {
  const s = getActiveSession();
  if (!s) return { ok: false, reason: "沒有 active 帳號" };
  const id = s.id;
  await destroySession(s);
  if (pendingNewSessionId === id) pendingNewSessionId = null;
  multiMode = "picker";
  setActiveId(null);
  pushState();
  return { ok: true };
});

ipcMain.handle(IPC.ACCOUNTS_CLEAR_ALL, async (): Promise<AccountOpResult> =>
  clearAllAccountsHandler(),
);

export { bus };
