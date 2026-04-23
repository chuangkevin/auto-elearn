import { contextBridge, ipcRenderer } from "electron";
import {
  IPC,
  type AppState,
  type CourseCandidate,
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
  searchCourses: (keyword: string): Promise<CourseCandidate[]> =>
    ipcRenderer.invoke(IPC.SEARCH_COURSES, keyword),
  startPipeline: (cids: string[]) => ipcRenderer.send(IPC.PIPELINE_START, cids),
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;
