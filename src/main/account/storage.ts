/**
 * 多帳號儲存層。把 v0.7.x 之前的單一 `credentials.bin` 換成：
 *
 *   auto-elearn-data/
 *     accounts/
 *       index.json          ← 公開 metadata（暱稱、PIN hash、addedAt 等）
 *       <id>.bin            ← safeStorage 加密過的 {account, password}
 *
 * 設計考量：
 *  - id = sha256(account)[:12]：deterministic，搬機器後同帳號還是同 id
 *  - PIN hash 跟 creds 分開存：PIN 的 hash 沒有真正保密性（4 位數字字典攻擊），
 *    所以放 plain JSON OK；creds 必須走 OS keychain
 *  - **不做** v0.7.x 舊 credentials.bin 的 migration（依使用者明確要求）
 */

import { safeStorage } from "electron";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { storagePath } from "../persist/storage-paths";

export interface AccountRecord {
  id: string;
  nickname: string;
  /** "F*****8271" — UI 永遠拿這個，不拿 raw account */
  maskedAccount: string;
  pinHash: string;
  pinSalt: string;
  addedAt: string;
  lastUsedAt?: string;
  /** v0.8.1 預留：使用者用「行動自然人憑證」/ TWFidO SSO 登入的帳號，沒有 e 等密
   *  碼可存。autoLogin / 心跳 reauth 走不通 → session 過期時要彈 toast 請使用者
   *  自己重登，不要悶頭重試。寫入流程在 v0.8.1 還沒實作（無法用左側表單登入），
   *  欄位先留下，等之後可以從 sniffer / cookie 變化偵測再啟用。 */
  ssoOnly?: boolean;
}

export interface AccountIndex {
  accounts: AccountRecord[];
  lastActiveId?: string;
}

export interface SavedAccountCreds {
  account: string;
  password: string;
}

const ACCOUNTS_DIR = "accounts";
const INDEX_FILE = "index.json";

function accountsDir(): string {
  return storagePath(ACCOUNTS_DIR);
}

function ensureAccountsDir(): void {
  const d = accountsDir();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function indexPath(): string {
  return join(accountsDir(), INDEX_FILE);
}

function credsFilePath(id: string): string {
  return join(accountsDir(), `${id}.bin`);
}

export function computeAccountId(account: string): string {
  // 大寫化避免使用者一下打 a123 一下打 A123 變成兩個帳號
  return createHash("sha256")
    .update(account.toUpperCase())
    .digest("hex")
    .slice(0, 12);
}

export function readIndex(): AccountIndex {
  try {
    if (!fs.existsSync(indexPath())) return { accounts: [] };
    const raw = fs.readFileSync(indexPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.accounts)) return { accounts: [] };
    return parsed as AccountIndex;
  } catch {
    return { accounts: [] };
  }
}

export function writeIndex(idx: AccountIndex): void {
  ensureAccountsDir();
  fs.writeFileSync(indexPath(), JSON.stringify(idx, null, 2), "utf8");
}

export function listAccounts(): AccountRecord[] {
  return readIndex().accounts;
}

export function getAccount(id: string): AccountRecord | null {
  return readIndex().accounts.find((a) => a.id === id) ?? null;
}

export function getLastActiveId(): string | null {
  return readIndex().lastActiveId ?? null;
}

export function setLastActive(id: string | null): void {
  const idx = readIndex();
  idx.lastActiveId = id ?? undefined;
  writeIndex(idx);
}

export function upsertAccount(rec: AccountRecord): void {
  const idx = readIndex();
  const i = idx.accounts.findIndex((a) => a.id === rec.id);
  if (i >= 0) idx.accounts[i] = rec;
  else idx.accounts.push(rec);
  writeIndex(idx);
}

export function setNickname(id: string, nickname: string): void {
  const idx = readIndex();
  const a = idx.accounts.find((x) => x.id === id);
  if (!a) return;
  a.nickname = nickname;
  writeIndex(idx);
}

export function setPinFor(id: string, pinHash: string, pinSalt: string): void {
  const idx = readIndex();
  const a = idx.accounts.find((x) => x.id === id);
  if (!a) return;
  a.pinHash = pinHash;
  a.pinSalt = pinSalt;
  writeIndex(idx);
}

export function touchLastUsed(id: string): void {
  const idx = readIndex();
  const a = idx.accounts.find((x) => x.id === id);
  if (!a) return;
  a.lastUsedAt = new Date().toISOString();
  idx.lastActiveId = id;
  writeIndex(idx);
}

export function saveAccountCreds(
  id: string,
  creds: SavedAccountCreds,
): { ok: boolean; reason?: string } {
  if (!safeStorage.isEncryptionAvailable()) {
    return { ok: false, reason: "safeStorage 不可用" };
  }
  try {
    ensureAccountsDir();
    const buf = safeStorage.encryptString(JSON.stringify(creds));
    fs.writeFileSync(credsFilePath(id), buf);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export function loadAccountCreds(id: string): SavedAccountCreds | null {
  try {
    const p = credsFilePath(id);
    if (!fs.existsSync(p)) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    const buf = fs.readFileSync(p);
    const json = safeStorage.decryptString(buf);
    return JSON.parse(json) as SavedAccountCreds;
  } catch {
    return null;
  }
}

export function deleteAccountCreds(id: string): void {
  try {
    fs.unlinkSync(credsFilePath(id));
  } catch {
    /* idempotent */
  }
}

export function removeAccount(id: string): void {
  const idx = readIndex();
  idx.accounts = idx.accounts.filter((a) => a.id !== id);
  if (idx.lastActiveId === id) idx.lastActiveId = undefined;
  writeIndex(idx);
  deleteAccountCreds(id);
}

export function clearAllAccounts(): void {
  const idx = readIndex();
  for (const a of idx.accounts) deleteAccountCreds(a.id);
  writeIndex({ accounts: [] });
}
