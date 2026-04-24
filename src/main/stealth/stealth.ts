import { loadConfig, saveConfig } from "../llm/gemini";
import type { StealthState } from "../../shared/ipc";

/**
 * Plaintext-in-config stealth (user's explicit choice, 2026-04-24 —
 * see `memory/project_stealth_mode.md`). We use the same userData/config.json
 * the LLM client uses, under `stealthSecret`.
 *
 * This module just owns the *state transitions*; the renderer paints either the
 * Noteqad shell or the real UI based on the current state.
 */

let sessionUnlocked = false;

function storedSecret(): string | null {
  const raw = loadConfig().stealthSecret;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

export function currentState(): StealthState {
  if (!storedSecret()) return "no_secret";
  return sessionUnlocked ? "unlocked" : "locked";
}

export function tryUnlock(input: string): boolean {
  const secret = storedSecret();
  if (!secret) return false;
  if (input === secret) {
    sessionUnlocked = true;
    return true;
  }
  return false;
}

export function setSecret(newSecret: string): { ok: boolean; reason?: string } {
  const trimmed = newSecret.trim();
  if (!trimmed) return { ok: false, reason: "密碼不能為空" };
  if (trimmed.length < 2) return { ok: false, reason: "密碼太短" };
  saveConfig({ stealthSecret: trimmed });
  sessionUnlocked = true; // after setting, the user is implicitly unlocked
  return { ok: true };
}

export function lock(): void {
  sessionUnlocked = false;
}

/** Test-only helper: clears the in-memory unlocked flag. Does not touch config. */
export function resetSession(): void {
  sessionUnlocked = false;
}
