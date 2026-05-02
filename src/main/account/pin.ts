/**
 * 4 位數字 PIN 的 hash + verify。
 *
 * PIN 是 UX 級防護（防同事偷看 / 防誤觸）不是真加密——4 位數字只有 10000 種組合，
 * 不適合存敏感資料。真正的帳密在 OS keychain（safeStorage）裡。
 *
 * 加 salt 是為了避免兩個帳號設了相同 PIN 但 hash 一樣（讓 index.json 沒辦法直接
 * 看出兩個帳號 PIN 相同）。
 */

import { createHash, randomBytes } from "node:crypto";

const PIN_RE = /^\d{4}$/;

export function validatePinFormat(pin: string): { ok: boolean; reason?: string } {
  if (typeof pin !== "string") return { ok: false, reason: "PIN 必須是 4 位數字" };
  if (!PIN_RE.test(pin)) return { ok: false, reason: "PIN 必須是 4 位數字" };
  return { ok: true };
}

export function newSalt(): string {
  return randomBytes(16).toString("hex");
}

export function hashPin(pin: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${pin}`).digest("hex");
}

export function verifyPin(pin: string, salt: string, storedHash: string): boolean {
  return hashPin(pin, salt) === storedHash;
}
