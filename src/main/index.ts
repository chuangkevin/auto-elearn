import { app, BrowserWindow, BrowserView, ipcMain, shell } from "electron";
import { join } from "node:path";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";

import { IPC, type AppState, type ViewBounds } from "../shared/ipc";
import { createBus } from "./bus";
import { attachElearnView, detectLogin } from "./browser/view";

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
    .then((user) => {
      state.status = "running";
      state.user = { name: user };
      log("info", `偵測到登入：${user}`);
      pushState();
    })
    .catch((err) => {
      log("error", `登入偵測失敗：${err}`);
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
  state.status = "aborted";
  log("info", "使用者中止");
  pushState();
  app.quit();
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
