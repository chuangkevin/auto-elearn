import { app, BrowserWindow, BrowserView, ipcMain, shell } from "electron";
import { join } from "node:path";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";

import {
  IPC,
  type AppState,
  type CourseCandidate,
  type CourseCard,
  type ViewBounds,
} from "../shared/ipc";
import { createBus } from "./bus";
import { attachElearnView, detectLogin, dismissNuisancePopups } from "./browser/view";
import { discover } from "./course/discovery";
import { enrollMany } from "./course/enrollment";
import type { Tracked } from "./course/types";
import {
  getSigningCourses,
  primeExplorer,
  searchCourses,
  type Course,
} from "./http/elearn";
import { runHeartbeatBatch } from "./heartbeat/engine";

const HEARTBEAT_PARALLEL = 8;
const HEARTBEAT_INTERVAL_MS = 5000;
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

// ── Window + BrowserView ──────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    title: "auto-elearn",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("ready-to-show", () => mainWindow?.show());
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
  const [winW, winH] = mainWindow.getContentSize();
  elearnView.setBounds({
    x: 0,
    y: Math.floor(winH * 0.45),
    width: winW,
    height: Math.ceil(winH * 0.55),
  });
  elearnView.setAutoResize({ width: true, height: false });

  state.status = "await_login";
  log("info", "等待使用者登入 e 等公務園");
  pushState();

  detectLogin(elearnView.webContents)
    .then(async (user) => {
      state.user = { name: user };
      log("info", `偵測到登入：${user}`);
      await dismissNuisancePopups(elearnView!.webContents);
      await refreshCourses();
      state.status = "selecting";
      log("info", "請在上方搜尋 / 勾選要刷的課程，按「開始」即可");
      pushState();
    })
    .catch((err) => log("error", `登入偵測失敗：${err}`));
}

// ── Discovery helpers ─────────────────────────────────────────
async function refreshCourses(): Promise<void> {
  if (!elearnView) return;
  try {
    const tracked = await discover(elearnView.webContents.session);
    state.courses = tracked.map(trackedToCard);
    updateStats();
    pushState();
    const active = tracked.filter((t) => t.course.isClassing).length;
    log("info", `掃描完成：已報名 ${tracked.length} 門（進行中 ${active}）`);
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
  state.stats.total = state.courses.length;
  state.stats.done = state.courses.filter((c) => c.phase === "done").length;
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

// ── Pipeline ──────────────────────────────────────────────────
async function runPipelineFor(cids: string[]): Promise<void> {
  if (!elearnView) return;
  const session = elearnView.webContents.session;
  abortSignal.aborted = false;

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

    await runHeartbeatBatch(session, needReading, {
      parallel: HEARTBEAT_PARALLEL,
      intervalMs: HEARTBEAT_INTERVAL_MS,
      jitterMs: HEARTBEAT_JITTER_MS,
      graceSec: 120,
      signal: abortSignal,
      onProgress: (cid, stage, extra) => {
        const card = state.courses.find((c) => c.cid === cid);
        if (!card) return;
        if (stage === "open") {
          log("info", `開始閱讀：${card.name}`);
        } else if (stage === "done") {
          const pings = (extra as { pings?: number })?.pings ?? 0;
          log("info", `閱讀結束：${card.name} (${pings} pings)`);
          card.phase = "exam";
        } else if (stage === "error") {
          log("warn", `心跳錯誤 ${card.name}：${JSON.stringify(extra ?? {})}`);
        }
        pushState();
      },
      onTick: (cid, pings, elapsedSec) => {
        const card = state.courses.find((c) => c.cid === cid);
        if (!card) return;
        card.readSec = Math.min(card.requiredSec, elapsedSec);
        card.lastPingAt = Date.now();
        state.now.courseId = cid;
        state.now.courseName = card.name;
        state.now.action = "heartbeat";
        state.now.detail = `${formatHms(card.readSec)} / ${formatHms(card.requiredSec)} (${pings} pings)`;
        pushState();
        if (pings === 1 || pings % 30 === 0) {
          log("info", `${card.name}: ${pings} ping, 累積 ${formatHms(elapsedSec)}`);
        }
      },
    });
  }

  // TODO: exam / survey / rating / reflection phases
  log("info", "TODO: 測驗 / 問卷 / 評價 / 心得 — 尚未實作");
  state.status = "done";
  state.now.action = "idle";
  state.now.courseId = undefined;
  state.now.courseName = undefined;
  state.now.detail = undefined;
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
  state.status = "aborted";
  log("info", "使用者中止");
  pushState();
  setTimeout(() => app.quit(), 300);
});

ipcMain.on(IPC.ACTION_BACK, async () => {
  abortSignal.aborted = true;
  state.status = "selecting";
  state.pauseReason = undefined;
  state.now = { action: "idle" };
  log("info", "返回選課畫面");
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
app.whenReady().then(() => {
  electronApp.setAppUserModelId("tw.kevin.auto-elearn");
  app.on("browser-window-created", (_, w) => optimizer.watchWindowShortcuts(w));
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
