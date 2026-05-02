import { safeStorage } from "electron";
import fs from "node:fs";
import { storagePath } from "../persist/storage-paths";

export interface SavedCredentials {
  /** Full ID captured from GetApTicketV2 (身分證字號 format) */
  account: string;
  password: string;
  /** Short alias the user originally typed (optional, informational) */
  alias?: string;
  savedAt: string;
  lastUsedAt?: string;
}

function filePath(): string {
  return storagePath("credentials.bin");
}

export function credentialsAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

export function hasSavedCredentials(): boolean {
  try {
    return fs.existsSync(filePath());
  } catch {
    return false;
  }
}

export function saveCredentials(c: SavedCredentials): { ok: boolean; reason?: string } {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, reason: "safeStorage not available on this platform" };
  }
  try {
    const json = JSON.stringify(c);
    const buf = safeStorage.encryptString(json);
    fs.writeFileSync(filePath(), buf);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export function loadCredentials(): SavedCredentials | null {
  try {
    if (!fs.existsSync(filePath())) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    const buf = fs.readFileSync(filePath());
    const json = safeStorage.decryptString(buf);
    return JSON.parse(json) as SavedCredentials;
  } catch {
    return null;
  }
}

export function clearCredentials(): void {
  try {
    fs.unlinkSync(filePath());
  } catch {
    /* idempotent */
  }
}

export function touchCredentials(): void {
  const c = loadCredentials();
  if (!c) return;
  c.lastUsedAt = new Date().toISOString();
  saveCredentials(c);
}
