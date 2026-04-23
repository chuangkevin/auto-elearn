import { contextBridge, ipcRenderer } from "electron";
import { IPC, type AppState, type ViewBounds } from "../shared/ipc";

const api = {
  getState: (): Promise<AppState> => ipcRenderer.invoke(IPC.STATE_GET),
  onState: (cb: (s: AppState) => void) => {
    const listener = (_evt: Electron.IpcRendererEvent, s: AppState) => cb(s);
    ipcRenderer.on(IPC.STATE_PUSH, listener);
    return () => ipcRenderer.off(IPC.STATE_PUSH, listener);
  },
  setViewBounds: (bounds: ViewBounds) => ipcRenderer.send(IPC.VIEW_BOUNDS, bounds),
  pause: () => ipcRenderer.send(IPC.ACTION_PAUSE),
  resume: () => ipcRenderer.send(IPC.ACTION_RESUME),
  abort: () => ipcRenderer.send(IPC.ACTION_ABORT),
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;
