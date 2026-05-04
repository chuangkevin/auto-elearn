import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  type AccountOpResult,
  type AppState,
  type AutoLoginProgress,
  type CourseCandidate,
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
  stealthClearSecret: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.STEALTH_CLEAR_SECRET),
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
  /** v0.8.11：用 shell.openExternal 開外部瀏覽器（main 端有 host 白名單） */
  openExternalUrl: (url: string): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke(IPC.OPEN_EXTERNAL_URL, url),

  // ── 多帳號 (v0.8.0) ─────────────────────────────────────────────
  beginUnlock: (id: string) => ipcRenderer.send(IPC.ACCOUNT_BEGIN_UNLOCK, id),
  verifyPin: (id: string, pin: string): Promise<AccountOpResult> =>
    ipcRenderer.invoke(IPC.ACCOUNT_VERIFY_PIN, { id, pin }),
  cancelUnlock: () => ipcRenderer.send(IPC.ACCOUNT_CANCEL_UNLOCK),
  switchActiveAccount: (id: string) => ipcRenderer.send(IPC.ACCOUNT_SWITCH_ACTIVE, id),
  closeTab: (id: string): Promise<AccountOpResult> =>
    ipcRenderer.invoke(IPC.ACCOUNT_CLOSE_TAB, id),
  goPicker: () => ipcRenderer.send(IPC.ACCOUNT_GO_PICKER),
  addAccountBegin: (): Promise<AccountOpResult> =>
    ipcRenderer.invoke(IPC.ACCOUNT_ADD_BEGIN),
  addAccountCancel: () => ipcRenderer.send(IPC.ACCOUNT_ADD_CANCEL),
  finishNewAccount: (
    payload: { nickname: string; pin: string },
  ): Promise<AccountOpResult> =>
    ipcRenderer.invoke(IPC.ACCOUNT_FINISH_NEW, payload),
  /** v0.8.1：左側一次填完 → 靜默 SSO + 建 tab + 存 record */
  addAccountSubmit: (
    payload: { account: string; password: string; nickname: string; pin: string },
  ): Promise<AccountOpResult> =>
    ipcRenderer.invoke(IPC.ACCOUNT_ADD_SUBMIT, payload),
  /** v0.8.1：鎖住指定 tab（切換時 main 會自動鎖前一個） */
  lockTab: (id: string): Promise<AccountOpResult> =>
    ipcRenderer.invoke(IPC.ACCOUNT_LOCK_TAB, id),
  /** v0.8.1：鎖住目前 active 帳號（左下「🔒 鎖定」按鈕） */
  lockActive: (): Promise<AccountOpResult> =>
    ipcRenderer.invoke(IPC.ACCOUNT_LOCK_ACTIVE),
  setAccountNickname: (
    payload: { id: string; nickname: string },
  ): Promise<AccountOpResult> =>
    ipcRenderer.invoke(IPC.ACCOUNT_SET_NICKNAME, payload),
  setAccountPin: (
    payload: { id: string; oldPin: string; newPin: string },
  ): Promise<AccountOpResult> =>
    ipcRenderer.invoke(IPC.ACCOUNT_SET_PIN, payload),
  resetPinBegin: (id: string) => ipcRenderer.send(IPC.ACCOUNT_RESET_PIN_BEGIN, id),
  resetPinVerify: (
    payload: { id: string; password: string },
  ): Promise<AccountOpResult> =>
    ipcRenderer.invoke(IPC.ACCOUNT_RESET_PIN_VERIFY, payload),
  resetPinComplete: (
    payload: { id: string; newPin: string },
  ): Promise<AccountOpResult> =>
    ipcRenderer.invoke(IPC.ACCOUNT_RESET_PIN_COMPLETE, payload),
  resetPinCancel: () => ipcRenderer.send(IPC.ACCOUNT_RESET_PIN_CANCEL),
  removeAccount: (id: string): Promise<AccountOpResult> =>
    ipcRenderer.invoke(IPC.ACCOUNT_REMOVE, id),
  logoutActiveAccount: (): Promise<AccountOpResult> =>
    ipcRenderer.invoke(IPC.ACCOUNT_LOGOUT_ACTIVE),
  clearAllAccounts: (): Promise<AccountOpResult> =>
    ipcRenderer.invoke(IPC.ACCOUNTS_CLEAR_ALL),
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;
