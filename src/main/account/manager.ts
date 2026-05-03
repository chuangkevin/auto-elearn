/**
 * AccountSession 集合管理。
 *
 * 一個「session」= 一個正在 app 內被打開的帳號（picker 上 tile 點開、PIN 過了之後）。
 * 每個 session 都掛一個自己 partition 的 BrowserView、自己的 AppState、自己的
 * heartbeat / pipeline / watchdog 旗標。彼此 cookie / storage / pipeline 互不干擾。
 *
 * 沒打開的帳號（在 picker 看得到但沒解鎖）只是 storage 裡的 AccountRecord，
 * 不會出現在這裡。
 */

import type { BrowserView } from "electron";
import { session as sessionModule } from "electron";
import type { AppState, AppStatus } from "../../shared/ipc";
import type { SniffedCredentials } from "../auth/login-sniffer";
import type { AccountRecord } from "./storage";

export interface AccountSession {
  /** sha256(account)[:12] */
  id: string;
  /** 從 accounts/index.json 讀出來的 metadata（暱稱、PIN hash 等） */
  record: AccountRecord;
  /** 解密後的 raw 帳號（IPC 不會送出） */
  account: string;
  /** 解密後的 raw 密碼（IPC 不會送出） */
  password: string;
  /** Electron 用的 partition string：`persist:elearn-<id>` */
  partitionId: string;
  /** 這個帳號的嵌入式瀏覽器；null 代表「tab 被關了」但帳號還在 picker */
  view: BrowserView | null;
  /** 這個帳號當下的 UI state（renderer 拿到的就是 active session 的這個 state） */
  state: AppState;
  /** Pipeline 中止旗標 */
  abortSignal: { aborted: boolean };
  /** v0.8.3：暫停旗標。abortSignal 是「終止」（不可逆，pipeline 整個結束）；pauseSignal
   *  是「暫停」（可恢復）。chain 的 exam / survey 步驟跟 heartbeat engine 都會在 step
   *  邊界讀這個旗標，paused=true 時 sleep 500ms 重檢，直到 false 或 aborted。
   *  v0.8.2 之前 ACTION_PAUSE 只翻 state.status="paused" 但沒任何模組真的讀，所以
   *  暫停只是 UI 假裝 — 考試問卷照跑，使用者能看到 BrowserView 還在執行動作。 */
  pauseSignal: { paused: boolean };
  /** v0.8.7：使用者剛退選但 server 端可能還沒同步的 cid 集合。runPipelineFor 在 enrol
   *  階段會跳過這裡的 cid，避免「退選 → 開始 → 又被 enrollMany 加回去」的迴圈。
   *  ACTION_BACK / 顯式重新搜尋勾選時清空。 */
  recentlyUnenrolled: Set<string>;
  pipelineRunning: boolean;
  /** 心跳階段正在跑的課，view focus 切換用 */
  runningCids: Set<string>;
  /** 目前 view 顯示哪一門課的 /info 頁面 */
  focusedCid: string | null;
  /** 從 login-sniffer 抓到、還沒持久化的 creds（多帳號模式不太用得到，但保險起見保留） */
  pendingSniffed: SniffedCredentials | null;
  /** v0.8.1：tab 是否已通過 PIN 驗證。v0.8.2 起跟 lastUnlockedAt 配合：
   *   - unlocked=false（被使用者手動「🔒 鎖定」按了）→ 切過去無條件要求 PIN
   *   - unlocked=true 但 lastUnlockedAt > 5 min 之前 → 也要求 PIN（grace 失效）
   *   - unlocked=true 且 lastUnlockedAt < 5 min → 直接切過去，不打擾 */
  unlocked: boolean;
  /** v0.8.2：上一次 PIN 通過的 timestamp（也包括 fresh session 建立時 = 視同剛通過）。
   *  setActiveSessionAndShow 用 `now - lastUnlockedAt < 5 min` 來決定要不要要求 PIN。
   *  manual lock 直接砍 unlocked，完全跳過 grace；grace 過期則 unlocked 自然失效。
   *  注意：grace 只針對「切換 tab」這個動作；session 一直擺著不切，超過 5 分鐘
   *  也不會自動鎖（按下「🔒 鎖定」才會立即鎖）。 */
  lastUnlockedAt: number;
  autoLoginInFlight: boolean;
  reloginInFlight: boolean;
  logoutHandlingInFlight: boolean;
  watchdogTimer: NodeJS.Timeout | null;
  loginWatchdogTimer: NodeJS.Timeout | null;
  consecutiveDeadChecks: number;
  loginMissCount: number;
  setupFallbackTimer: NodeJS.Timeout | null;
  /** 觀察 status 卡住用 */
  lastStatusChangeAt: number;
  lastObservedStatus: AppStatus;
  /** 解構這個 session 時要呼叫的 cleanup 函式（e.g. login-sniffer detacher） */
  onDestroy: Array<() => void>;
}

const sessions = new Map<string, AccountSession>();
let activeId: string | null = null;

export function partitionIdFor(id: string): string {
  return `persist:elearn-${id}`;
}

export function listSessions(): AccountSession[] {
  return Array.from(sessions.values());
}

export function getSession(id: string): AccountSession | null {
  return sessions.get(id) ?? null;
}

export function getActiveSession(): AccountSession | null {
  if (!activeId) return null;
  return sessions.get(activeId) ?? null;
}

export function getActiveId(): string | null {
  return activeId;
}

export function setActiveId(id: string | null): void {
  activeId = id;
}

export function hasSession(id: string): boolean {
  return sessions.has(id);
}

export function registerSession(s: AccountSession): void {
  sessions.set(s.id, s);
}

export function deregisterSession(id: string): void {
  if (activeId === id) activeId = null;
  sessions.delete(id);
}

/** 全新 session 用的 default state。
 * 注意 `multi` 欄位是 placeholder：renderer 拿到的 AppState 在 main `pushState()` 時
 * 會用 buildMultiInfo() 蓋掉這個 placeholder；per-session state 內部 read/write
 * 從不碰它，所以放空殼就好。 */
export function createInitialState(): AppState {
  return {
    status: "boot",
    now: { action: "idle" },
    courses: [],
    logs: [],
    stats: { done: 0, total: 0, quizzes: 0, llmCalls: 0, progressPct: 0 },
    multi: {
      mode: "boot",
      pickerAccounts: [],
      tabs: [],
      activeAccountId: null,
    },
  };
}

/**
 * 把指定 id 列表的 partition storage 清乾淨（cookies / localStorage / serviceworker）。
 * 用在「全域清除」或單一帳號移除 —— 沒清的話下次同 id 再加帳號會撞到舊 cookie。
 */
export async function clearPartitionDataFor(ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      const s = sessionModule.fromPartition(partitionIdFor(id));
      await s.clearStorageData().catch(() => void 0);
    } catch {
      /* partition 從未被建立過就 swallow */
    }
  }
}
