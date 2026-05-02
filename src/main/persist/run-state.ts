import fs from "node:fs";
import { storagePath } from "./storage-paths";

export interface PersistedRun {
  pipelineCids: string[];
  startedAt: string;
  updatedAt: string;
  status: "running" | "paused" | "done" | "aborted";
}

/**
 * v0.8.0 起 run-state 走 per-account：每個帳號自己的中斷狀態。
 * 沒帶 accountId 是給 v0.7.x 路徑（已退役）保留 fallback。
 */
function filePath(accountId?: string): string {
  if (accountId) return storagePath("accounts", `${accountId}.run.json`);
  return storagePath("run-state.json");
}

export function saveRun(run: PersistedRun, accountId?: string): void {
  try {
    fs.writeFileSync(filePath(accountId), JSON.stringify(run, null, 2));
  } catch {
    /* non-fatal */
  }
}

export function loadRun(accountId?: string): PersistedRun | null {
  try {
    const p = filePath(accountId);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw) as PersistedRun;
  } catch {
    return null;
  }
}

export function clearRun(accountId?: string): void {
  try {
    fs.unlinkSync(filePath(accountId));
  } catch {
    /* idempotent */
  }
}
