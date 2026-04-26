import { app, BrowserWindow, BrowserView, ipcMain, shell, Menu, screen, type Session } from "electron";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";

import {
  IPC,
  type AppState,
  type AutoLoginProgress,
  type CourseCandidate,
  type CourseCard,
  type CredentialsStatus,
  type CredsPromptPayload,
  type ResumePrompt,
  type ViewBounds,
} from "../shared/ipc";
import { createBus } from "./bus";
import { attachElearnView, autoLoginInView, detectLogin, dismissNuisancePopups } from "./browser/view";
import { loadConfig, saveConfig } from "./llm/gemini";
import { discover } from "./course/discovery";
import { enrollMany } from "./course/enrollment";
import { unenrollCourse } from "./course/unenroll";
import type { Tracked } from "./course/types";
import {
  getSigningCourses,
  primeExplorer,
  searchCourses,
  type Course,
} from "./http/elearn";
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
import { writeReflection } from "./reflection/writer";
import {
  currentState as stealthCurrentState,
  lock as stealthLock,
  setSecret as stealthSetSecret,
  tryUnlock as stealthTryUnlock,
} from "./stealth/stealth";

function maskAccount(acc: string): string {
  if (!acc) return "";
  if (acc.length <= 4) return acc;
  return `${acc.slice(0, 1)}${"*".repeat(acc.length - 5)}${acc.slice(-4)}`;
}

const HEARTBEAT_PARALLEL = 8;
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
  state.logs.push({ ts: Date.now(), level, msg });
  if (state.logs.length > 200) state.logs.splice(0, state.logs.length - 200);
  pushState();
  // eslint-disable-next-line no-console
  console.log(`[${level}] ${msg}`);
}

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

// ── Gemini key dialog ─────────────────────────────────────────
function showGeminiKeyDialog(): void {
  if (!mainWindow) return;
  const preloadPath = join(__dirname, "../preload/index.js");
  const htmlPath = app.isPackaged
    ? join(process.resourcesPath, "resources/gemini-key-dialog.html")
    : join(app.getAppPath(), "resources/gemini-key-dialog.html");

  const dlg = new BrowserWindow({
    width: 480,
    height: 240,
    parent: mainWindow,
    modal: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    title: "設定 Gemini API Key",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  dlg.setMenu(null);
  dlg.loadFile(htmlPath);
}

function buildAppMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: "說明(&H)",
      submenu: [
        {
          label: "設定 Gemini API Key(&G)…",
          click: () => showGeminiKeyDialog(),
        },
      ],
    },
  ]);
  mainWindow?.setMenu(menu);
}

// ── Window + BrowserView ──────────────────────────────────────
function createWindow() {
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, "resources/icon.ico")
    : join(app.getAppPath(), "resources/icon.ico");

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
  mainWindow.on("page-title-updated", (e) => e.preventDefault());

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

  // Sniff login POST so we can offer "remember me" after manual login succeeds.
  attachLoginSniffer(elearnView.webContents.session, (creds) => {
    pendingSniffed = creds;
    log("info", "已偵測到 eCPA 登入表單，待登入成功後會詢問是否儲存帳密");
  });

  if (hasSavedCredentials()) {
    state.status = "await_login";
    log("info", "偵測到已儲存帳密，背景自動登入中...");
    void tryAutoLogin().catch(() => void 0);
  } else {
    state.status = "setup";
    log("info", "首次啟動：請設定 eCPA 帳號密碼");
  }
  pushState();

  detectLogin(elearnView.webContents)
    .then(async (user) => {
      state.user = { name: user };
      state.loginStatus = "ok";
      log("info", `偵測到登入：${user}`);
      startLoginWatchdog();
      await dismissNuisancePopups(elearnView!.webContents);
      await refreshCourses();

      // If we sniffed creds during this login session AND they aren't yet saved,
      // ask the user whether to remember them.
      if (pendingSniffed && !hasSavedCredentials()) {
        const payload: CredsPromptPayload = { maskedAccount: maskAccount(pendingSniffed.account) };
        mainWindow?.webContents.send(IPC.CREDS_PROMPT_SAVE, payload);
      } else if (pendingSniffed && hasSavedCredentials()) {
        // Creds already saved; transparently refresh password in case user changed it.
        const existing = loadCredentials();
        if (existing && existing.password !== pendingSniffed.password) {
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
    .catch((err) => log("error", `登入偵測失敗：${err}`));
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
  // Fire-and-forget: this runs in parallel with the navigate below.
  detectLogin(wc)
    .then(async (user) => {
      state.user = { name: user };
      state.loginStatus = "ok";
      log("info", `偵測到登入：${user}`);
      startLoginWatchdog();
      await dismissNuisancePopups(wc);
      await refreshCourses();
      state.status = "selecting";
      log("info", "請在上方搜尋 / 勾選要刷的課程，按「確認操作」即可");
      pushState();
    })
    .catch((err) => log("error", `登入偵測失敗：${err}`));

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
    // Diagnostic: print per-course server flags and write to temp file
    const diagLines: string[] = [`=== 課程狀態診斷 ${new Date().toISOString()} ===`];
    for (const t of tracked.filter((t) => t.course.isReadtimeValidCaption !== "未報名")) {
      const r = t.course.isReadDones ?? 0;
      const e = t.course.isExamDones ?? 0;
      const s = t.course.isSurveyDones ?? 0;
      const line = `📋 [閱讀:${r} 測驗:${e} 問卷:${s} phase:${t.phase}] ${t.course.caption}`;
      log("info", `  ${line}`);
      diagLines.push(line);
    }
    try {
      writeFileSync("C:/Users/Kevin/AppData/Local/Temp/auto-elearn-diag.txt", diagLines.join("\n"), "utf8");
    } catch { /* non-fatal */ }
  } catch (e) {
    log("error", `掃描失敗：${e instanceof Error ? e.message : String(e)}`);
  }
}

function trackedToCard(t: Tracked): CourseCard {
  return {
    cid: t.course.cid,
    name: t.course.caption,
    phase: t.phase === "reading_done" ? "reading" : (t.phase as CourseCard["phase"]),
    readSec: t.readSec,
    requiredSec: t.requiredSec,
    examDone: (t.course.isExamDones ?? 0) === 1,
    surveyDone: (t.course.isSurveyDones ?? 0) === 1,
    ratingDone: false,
    reflectionDone: false,
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

function formatHms(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
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

  const needReading = tracked.filter(
    (t) => selected.has(t.course.cid) && t.course.isClassing && t.phase === "reading",
  );

  if (needReading.length === 0) {
    log("info", "沒有需要閱讀的課程");
  } else {
    log(
      "info",
      `${needReading.length} 門課開始閱讀（並行 ${HEARTBEAT_PARALLEL}，每 ${
        HEARTBEAT_INTERVAL_MS / 1000
      }s 心跳）`,
    );
    state.now.action = "heartbeat";
    pushState();
    startSessionWatchdog(session);

    await runHeartbeatBatch(session, needReading, {
      parallel: HEARTBEAT_PARALLEL,
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
          const origin = (extra as { origin?: string })?.origin;
          log("info", `開始閱讀：${card.name}${origin ? ` (心跳 host: ${origin})` : ""}`);
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
          card.phase = "exam";
          runningCids.delete(cid);
          if (focusedCid === cid) focusNextCourse();
        } else if (stage === "error") {
          log("warn", `心跳錯誤 ${card.name}：${JSON.stringify(extra ?? {})}`);
          runningCids.delete(cid);
          if (focusedCid === cid) focusNextCourse();
        }
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

  // 3. Exam phase — for courses that just finished heartbeat OR skipped heartbeat (already past
  // reading). isReadDones is always 0 from the server, so we gate on completedHeartbeat (local
  // tracking) and caption !== "已通過" (fully done courses need no exam).
  // solveExam handles "no exam button" gracefully, so false positives are OK.
  const afterReadingTracked = await discover(session);
  const needExam = afterReadingTracked.filter(
    (t) =>
      selected.has(t.course.cid) &&
      t.course.isClassing &&
      t.course.isReadtimeValidCaption !== "已通過" &&
      (completedHeartbeat.has(t.course.cid) || skipRead.some((s) => s.course.cid === t.course.cid)),
  );
  if (needExam.length > 0) {
    log("info", `${needExam.length} 門課進入測驗階段`);
    state.now.action = "exam";
    pushState();
    for (const t of needExam) {
      if (abortSignal.aborted) break;
      const card = state.courses.find((c) => c.cid === t.course.cid);
      const name = card?.name ?? t.course.cid;
      state.now.courseId = t.course.cid;
      state.now.courseName = name;
      state.now.detail = "解題中...";
      pushState();
      log("info", `開始測驗：${name}`);
      const res = await solveExam(t.course.cid, session, {
        onProgress: (msg) => log("info", `  [${name}] ${msg}`),
      });
      if (res.ok) {
        log(
          "info",
          `測驗完成 ${name}：${res.passed ? "✅ 通過" : "⚠ 判定不明"}，共 ${res.total} 題（DB ${res.bySource.db} / fuzzy ${res.bySource.fuzzy} / random ${res.bySource.random}）`,
        );
        if (card && res.passed) card.examDone = true;
      } else {
        log("warn", `測驗失敗 ${name}：${res.error ?? "unknown"}`);
      }
    }
  } else {
    log("info", "沒有需要測驗的課程");
  }

  // 4. Survey / rating phase — same gating as exam.
  const afterExamTracked = await discover(session);
  const needSurvey = afterExamTracked.filter(
    (t) =>
      selected.has(t.course.cid) &&
      t.course.isClassing &&
      t.course.isReadtimeValidCaption !== "已通過" &&
      (completedHeartbeat.has(t.course.cid) || skipRead.some((s) => s.course.cid === t.course.cid)),
  );
  if (needSurvey.length > 0) {
    log("info", `${needSurvey.length} 門課進入問卷 / 評價階段`);
    state.now.action = "survey";
    pushState();
    for (const t of needSurvey) {
      if (abortSignal.aborted) break;
      const card = state.courses.find((c) => c.cid === t.course.cid);
      const name = card?.name ?? t.course.cid;
      state.now.courseId = t.course.cid;
      state.now.courseName = name;
      state.now.detail = "填問卷...";
      pushState();
      log("info", `問卷：${name}`);
      const sr = await fillSurvey(t.course.cid, session, {
        onProgress: (msg) => log("info", `  [${name}] ${msg}`),
      });
      if (sr.ok) {
        log("info", `問卷完成 ${name}：勾選 ${sr.filled} 題 + 繳交`);
        if (card) card.surveyDone = true;
      } else {
        log("warn", `問卷失敗 ${name}：${sr.error ?? "unknown"}`);
      }
    }
  } else {
    log("info", "沒有需要填寫的問卷");
  }

  // 5. Reflection / 學習心得 — best effort.
  const needReflection = afterExamTracked.filter(
    (t) => selected.has(t.course.cid) && t.course.isClassing,
  );
  if (needReflection.length > 0) {
    state.now.action = "reflection";
    pushState();
    for (const t of needReflection) {
      if (abortSignal.aborted) break;
      const card = state.courses.find((c) => c.cid === t.course.cid);
      const name = card?.name ?? t.course.cid;
      state.now.courseId = t.course.cid;
      state.now.courseName = name;
      state.now.detail = "寫心得...";
      pushState();
      const rr = await writeReflection(t.course.cid, name, session, {
        onProgress: (msg) => log("info", `  [${name}] ${msg}`),
      });
      if (rr.ok) {
        log("info", `心得完成 ${name}（${rr.source}）`);
        if (card) card.reflectionDone = true;
      } else if (rr.error && !rr.error.includes("略過")) {
        log("warn", `心得失敗 ${name}：${rr.error}`);
      }
    }
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
async function keywordSearch(keyword: string): Promise<CourseCandidate[]> {
  if (!elearnView) return [];
  const session = elearnView.webContents.session;
  const trimmed = keyword.trim();
  const allByCid = new Map<string, Course>();
  const mineCids = new Set(state.courses.map((c) => c.cid));

  for (const cat of KNOWN_CATEGORIES) {
    if (abortSignal.aborted) break;
    try {
      await primeExplorer(session, cat);
      const results = await searchCourses(session, cat, trimmed, 50);
      for (const r of results) {
        if (!allByCid.has(r.cid)) allByCid.set(r.cid, r);
      }
    } catch (e) {
      // Skip this category; search is best-effort
      log("warn", `搜尋分類 ${cat} 失敗：${e instanceof Error ? e.message : String(e)}`);
    }
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
    .sort((a, b) => a.certification_hours - b.certification_hours);
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
ipcMain.on(IPC.OPEN_GEMINI_DIALOG, () => showGeminiKeyDialog());

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

ipcMain.handle(IPC.SEARCH_COURSES, async (_evt, keyword: string) => {
  try {
    const results = await keywordSearch(keyword);
    log("info", `搜尋「${keyword || "(全部)"}」: ${results.length} 筆`);
    return results;
  } catch (e) {
    log("error", `搜尋失敗：${e instanceof Error ? e.message : String(e)}`);
    return [] as CourseCandidate[];
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

  for (const g of groups) {
    if (abortSignal.aborted) break;
    try {
      await primeExplorer(session, g.categoryId);
      // Broad sweep first (empty keyword returns whole category).
      const broad = await searchCourses(session, g.categoryId, "", 50);
      for (const r of broad) if (!byCid.has(r.cid)) byCid.set(r.cid, r);
      // If the group narrows by specific keywords, also run those to pick up sub-topics
      // the broad sweep may have truncated at 50.
      for (const kw of g.keywords) {
        if (abortSignal.aborted) break;
        const results = await searchCourses(session, g.categoryId, kw, 50);
        for (const r of results) if (!byCid.has(r.cid)) byCid.set(r.cid, r);
      }
    } catch (e) {
      log(
        "warn",
        `${g.labels.join("/")} (cat=${g.categoryId}) 查詢失敗：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Post-filter: a 專區 categoryId like AI_ZONE (540-546) spans multiple sub-topics
  // (基礎認知 / 生成式 / 公務應用 / 導入 / 產業應用). When the user passed specific
  // sub-codes, we only want courses in those sub-topics. Strategy: if ANY group in
  // this search narrowed by keywords, a result must match at least one keyword from
  // the groups that share its categoryId. Groups with no keywords impose no filter.
  const allKeywords = groups.flatMap((g) => g.keywords);
  const anyKeywordRequested = allKeywords.length > 0;
  const allLabels = groups.flatMap((g) => g.labels);
  const anyGroupWantsEverything = groups.some((g) => g.keywords.length === 0);

  const out: CourseCandidate[] = Array.from(byCid.values())
    .filter((c) => c.isClassing)
    .filter((c) => {
      if (!anyKeywordRequested) return true; // all groups are broad — keep everything
      if (anyGroupWantsEverything) return true; // mixed: at least one group has no kw, so keep all
      const haystack = `${c.caption} ${c.category_full_path ?? ""} ${c.content ?? ""}`;
      // Match by keyword first, then by label (label lets the user say "all 環境教育" with no filter)
      return allKeywords.some((k) => haystack.includes(k)) || allLabels.some((l) => haystack.includes(l));
    })
    .map((c) => ({
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
    .sort((a, b) => a.certification_hours - b.certification_hours);
  log("info", `代碼搜尋共 ${out.length} 筆`);
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

ipcMain.on(IPC.CREDS_FORGET, () => {
  clearCredentials();
  log("info", "已清除儲存的帳密");
});

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
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    electronApp.setAppUserModelId("tw.kevin.auto-elearn");
    app.on("browser-window-created", (_, w) => optimizer.watchWindowShortcuts(w));
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
