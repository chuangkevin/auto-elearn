import fs from "node:fs";
import { storagePath } from "./storage-paths";

export interface PersistedRun {
  pipelineCids: string[];
  startedAt: string;
  updatedAt: string;
  status: "running" | "paused" | "done" | "aborted";
}

function filePath(): string {
  return storagePath("run-state.json");
}

export function saveRun(run: PersistedRun): void {
  try {
    fs.writeFileSync(filePath(), JSON.stringify(run, null, 2));
  } catch {
    /* non-fatal */
  }
}

export function loadRun(): PersistedRun | null {
  try {
    if (!fs.existsSync(filePath())) return null;
    const raw = fs.readFileSync(filePath(), "utf-8");
    return JSON.parse(raw) as PersistedRun;
  } catch {
    return null;
  }
}

export function clearRun(): void {
  try {
    fs.unlinkSync(filePath());
  } catch {
    /* idempotent */
  }
}
