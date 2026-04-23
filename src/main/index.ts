import { app, BrowserWindow, BrowserView, ipcMain, shell } from "electron";
import { join } from "node:path";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";

import { IPC, type AppState, type ViewBounds, type CourseCard } from "../shared/ipc";
import { createBus } from "./bus";
import { attachElearnView, detectLogin, dismissNuisancePopups } from "./browser/view";
import { discover } from "./course/discovery";
import type { Tracked } from "./course/types";
import { runHeartbeatBatch } from "./heartbeat/engine";

const HEARTBEAT_PARALLEL = 8;
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_JITTER_MS = 1000;
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
  // keep last 200
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

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  // Attach elearn BrowserView to the bottom half
  elearnView = attachElearnView(mainWindow, HOMEPAGE);
  const [winW, winH] = mainWindow.getContentSize();
  elearnView.setBounds({ x: 0, y: Math.floor(winH * 0.45), width: winW, height: Math.ceil(winH * 0.55) });
  elearnView.setAutoResize({ width: true, height: false });

  // Kick off login detection
  state.status = "await_login";
  log("info", "等待使用者登入 e 等公務園");
  pushState();

  detectLogin(elearnView.webContents)
    .then(async (user) => {
      state.status = "running";
      state.user = { name: user };
      log("info", `偵測到登入：${user}`);
      pushState();
      await dismissNuisancePopups(elearnView!.webContents);
      runSession().catch((e) =>
        log("error", `Session 執行失敗：${e instanceof Error ? e.message : String(e)}`),
      );
    })
    .catch((err) => {
      log("error", `登入偵測失敗：${err}`);
    });
}

async function runSession() {
  if (!elearnView) return;
  const session = elearnView.webContents.session;

  // Phase 1: Discovery
  log("info", "掃描已報名課程...");
  const tracked = await discover(session);
  const active = tracked.filter((t) => t.course.isClassing);
  state.courses = tracked.map(trackedToCard);
  updateStats();
  pushState();
  log(
    "info",
    `共 ${tracked.length} 門（進行中 ${active.length} / 歷史 ${tracked.length - active.length}）`,
  );

  // Phase 2: Heartbeat (only classes still open + reading not yet done)
  const needReading = active.filter((t) => t.phase === "reading");
  if (needReading.length === 0) {
    log("info", "沒有需要閱讀的課程，跳過心跳階段");
  } else {
    log(
      "info",
      `${needReading.length} 門課需要閱讀，並行 ${HEARTBEAT_PARALLEL} 條心跳，每 ${
        HEARTBEAT_INTERVAL_MS / 1000
      }s 一次`,
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
          log("info", `閱讀結束：${card.name} (${String((extra as { pings?: number })?.pings ?? 0)} pings)`);
          card.phase = "exam";
        } else if (stage === "error") {
          log(
            "warn",
            `心跳錯誤 ${card.name}：${JSON.stringify(extra ?? {})}`,
          );
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
    log("info", "所有閱讀心跳完成");
  }

  // Phase 3: Exam / Survey / Rating / Reflection — TODO
  log("info", "TODO: 測驗 / 問卷 / 評價 / 心得階段尚未實作");
  state.status = "done";
  state.now.action = "idle";
  updateStats();
  pushState();
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
  // Small delay so SSE broadcast reaches renderer before quit
  setTimeout(() => app.quit(), 300);
});

// expose bus to future modules
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
