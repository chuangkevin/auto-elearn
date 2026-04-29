import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  type AppState,
  type AutoLoginProgress,
  type CourseCandidate,
  type CredsPromptPayload,
  type CredentialsStatus,
  type ResumePrompt,
  type SearchOptions,
  type StealthState,
  type ViewBounds,
} from "../shared/ipc";

const api = {
  getState: (): Promise<AppState> => ipcRenderer.invoke(IPC.STATE_GET),
  onState: (cb: (s: AppState) => void) => {
    const listener = (_evt: Electron.IpcRendererEvent, s: AppState) => cb(s);
    ipcRenderer.on(IPC.STATE_PUSH, listener);
    return () => ipcRenderer.off(IPC.STATE_PUSH, listener);
  },
  setViewBounds: (bounds: ViewBounds) => ipcRenderer.send(IPC.VIEW_BOUNDS, bounds),
  navigateView: (url: string) => ipcRenderer.send(IPC.NAVIGATE_VIEW, url),
  pause: () => ipcRenderer.send(IPC.ACTION_PAUSE),
  resume: () => ipcRenderer.send(IPC.ACTION_RESUME),
  abort: () => ipcRenderer.send(IPC.ACTION_ABORT),
  backToSelect: () => ipcRenderer.send(IPC.ACTION_BACK),
  refreshCourses: () => ipcRenderer.send(IPC.REFRESH_COURSES),
  searchCourses: (opts: SearchOptions | string): Promise<CourseCandidate[]> =>
    ipcRenderer.invoke(IPC.SEARCH_COURSES, opts),
  getCategoryChildren: (parentId: string): Promise<Array<{ id: string; label: string }>> =>
    ipcRenderer.invoke(IPC.CATEGORY_CHILDREN, parentId),
  searchByCodes: (codes: string[]): Promise<CourseCandidate[]> =>
    ipcRenderer.invoke(IPC.SEARCH_BY_CODES, codes),
  startPipeline: (cids: string[]) => ipcRenderer.send(IPC.PIPELINE_START, cids),
  unenrollCourse: (cid: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.UNENROLL_COURSE, cid),
  getCredsStatus: (): Promise<CredentialsStatus> => ipcRenderer.invoke(IPC.CREDS_STATUS),
  forgetCredentials: () => ipcRenderer.send(IPC.CREDS_FORGET),
  saveCredentialsManual: (
    payload: { account: string; password: string },
  ): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IPC.CREDS_SAVE_MANUAL, payload),
  answerCredsPrompt: (save: boolean) => ipcRenderer.send(IPC.CREDS_SAVE_ANSWER, save),
  onCredsPrompt: (cb: (p: CredsPromptPayload) => void) => {
    const listener = (_evt: Electron.IpcRendererEvent, p: CredsPromptPayload) => cb(p);
    ipcRenderer.on(IPC.CREDS_PROMPT_SAVE, listener);
    return () => ipcRenderer.off(IPC.CREDS_PROMPT_SAVE, listener);
  },
  onAutoLoginProgress: (cb: (p: AutoLoginProgress) => void) => {
    const listener = (_evt: Electron.IpcRendererEvent, p: AutoLoginProgress) => cb(p);
    ipcRenderer.on(IPC.AUTOLOGIN_PROGRESS, listener);
    return () => ipcRenderer.off(IPC.AUTOLOGIN_PROGRESS, listener);
  },
  onResumePrompt: (cb: (p: ResumePrompt) => void) => {
    const listener = (_evt: Electron.IpcRendererEvent, p: ResumePrompt) => cb(p);
    ipcRenderer.on(IPC.RESUME_PROMPT, listener);
    return () => ipcRenderer.off(IPC.RESUME_PROMPT, listener);
  },
  answerResumePrompt: (resume: boolean) => ipcRenderer.send(IPC.RESUME_ANSWER, resume),
  getStealthStatus: (): Promise<StealthState> => ipcRenderer.invoke(IPC.STEALTH_STATUS),
  stealthUnlock: (secret: string): Promise<boolean> => ipcRenderer.invoke(IPC.STEALTH_UNLOCK, secret),
  stealthSetSecret: (secret: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IPC.STEALTH_SET_SECRET, secret),
  stealthLock: () => ipcRenderer.send(IPC.STEALTH_LOCK),
  stealthConfigPath: (): Promise<string> => ipcRenderer.invoke(IPC.STEALTH_CONFIG_PATH),
  getGeminiKey: (): Promise<string> => ipcRenderer.invoke(IPC.GEMINI_KEY_GET),
  setGeminiKey: (key: string): Promise<void> => ipcRenderer.invoke(IPC.GEMINI_KEY_SET, key),
  openGeminiDialog: () => ipcRenderer.send(IPC.OPEN_GEMINI_DIALOG),
  onGeminiDialogRequest: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on(IPC.GEMINI_DIALOG_REQUEST, listener);
    return () => ipcRenderer.off(IPC.GEMINI_DIALOG_REQUEST, listener);
  },
  ackFirstRun: () => ipcRenderer.send(IPC.ACK_FIRST_RUN),
  rendererLog: (level: "info" | "warn" | "error", msg: string) =>
    ipcRenderer.send(IPC.RENDERER_LOG, { level, msg }),
  openLogsFolder: () => ipcRenderer.send(IPC.OPEN_LOGS_FOLDER),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke(IPC.APP_VERSION_GET),
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;
