import { request } from "undici";
import fs from "node:fs";
import { storagePath } from "../persist/storage-paths";

/**
 * Minimal Gemini client. The API key lives in `<storage-dir>/config.json` under
 * `geminiApiKey`. If the file or key is absent, every call returns null so the
 * caller can fall back to a generic string / skip.
 */

interface LocalConfig {
  geminiApiKey?: string;
  geminiModel?: string;
  /** Plaintext secret for stealth Noteqad disguise (user's explicit choice, see memory) */
  stealthSecret?: string;
}

function configPath(): string {
  return storagePath("config.json");
}

export function loadConfig(): LocalConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf-8");
    return JSON.parse(raw) as LocalConfig;
  } catch {
    return {};
  }
}

export function saveConfig(patch: Partial<LocalConfig>): void {
  const cur = loadConfig();
  const merged = { ...cur, ...patch };
  try {
    fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2));
  } catch {
    /* non-fatal */
  }
}

export function hasGeminiKey(): boolean {
  return !!loadConfig().geminiApiKey;
}

/**
 * v0.8.10：免費 Gemini key 每天有 limit（free_tier_requests=20）。多帳號 × 多
 * 課程同時跑很容易撞到。撞到後 1 小時內全部 LLM 呼叫都直接 skip，讓 solver
 * 走「DB → fuzzy → brute force」路徑，不要每題都打 API 拿 429 再 fallback —
 * 那樣 30 次 attempt 都在重打 Gemini，每題等 timeout，浪費。
 *
 * 1 hour 是 free tier rate-limit window 的合理估計（GCP 一般 60s 或 24h
 * 兩種，免費版傾向 daily 但 1h 是保守 retry 點）。其實只要記住 timestamp，
 * 1h 後讓 LLM 再試，沒額度會再次回 429 重設這個 flag。
 */
let _quotaExhaustedAt = 0;
const QUOTA_RETRY_AFTER_MS = 60 * 60 * 1000;

function markQuotaExhausted(): void {
  _quotaExhaustedAt = Date.now();
  llog(
    "Gemini 額度撞到上限 — 這 1 小時內所有 LLM 呼叫都會直接 skip，solver 走暴力解題（DB → fuzzy → brute）。1 小時後自動再試。",
  );
}

/** v0.8.10：matcher / solver 用這個判斷該不該叫 LLM（取代 hasGeminiKey） */
export function isGeminiUsable(): boolean {
  if (!hasGeminiKey()) return false;
  if (_quotaExhaustedAt === 0) return true;
  if (Date.now() - _quotaExhaustedAt > QUOTA_RETRY_AFTER_MS) {
    _quotaExhaustedAt = 0; // retry window 過了，下次呼叫會再試
    return true;
  }
  return false;
}

/** Log Gemini failures via this hook. Set by index.ts so warnings surface. */
let _logFn: ((msg: string) => void) | null = null;
export function setGeminiLogger(fn: (msg: string) => void): void {
  _logFn = fn;
}
function llog(msg: string): void {
  if (_logFn) _logFn(msg);
  else console.warn("[gemini]", msg);
}

export async function generateText(
  prompt: string,
  opts: { maxOutputTokens?: number; timeoutMs?: number } = {},
): Promise<string | null> {
  const cfg = loadConfig();
  if (!cfg.geminiApiKey) {
    llog("hasGeminiKey=false — config.json 裡沒有 geminiApiKey，已跳過 LLM");
    return null;
  }
  // v0.8.10：1 小時內已知 quota 用完 → 直接 short-circuit，不要再打 API 拿 429
  if (_quotaExhaustedAt > 0 && Date.now() - _quotaExhaustedAt < QUOTA_RETRY_AFTER_MS) {
    return null;
  }
  const model = cfg.geminiModel ?? "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${cfg.geminiApiKey}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      // gemini-2.5-flash defaults to thinking-on. With small maxOutputTokens
      // (e.g. 64) the model burns the entire budget on hidden "thinking
      // tokens" and emits no final text — caller sees 200 OK with empty
      // candidates. For our short single-letter answers we explicitly turn
      // thinking OFF so the budget goes straight to the visible reply.
      maxOutputTokens: opts.maxOutputTokens ?? 256,
      temperature: 0.8,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  try {
    const res = await request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      headersTimeout: opts.timeoutMs ?? 20_000,
      bodyTimeout: opts.timeoutMs ?? 20_000,
    });
    if (res.statusCode >= 400) {
      // Surface the actual reason — most common issues are API_KEY_INVALID,
      // QUOTA_EXCEEDED, or model name wrong. Without this, every Gemini call
      // silently falls back to "random" and the user thinks the LLM never ran.
      let snippet = "";
      try {
        const errJson = (await res.body.json()) as { error?: { message?: string; status?: string } };
        snippet = errJson?.error?.message ?? errJson?.error?.status ?? "";
      } catch {
        try { snippet = (await res.body.text()).slice(0, 200); } catch { /* ignore */ }
      }
      llog(`Gemini ${res.statusCode}: ${snippet}`);
      // v0.8.10：429 = quota — 1 小時內接著的呼叫直接 short-circuit，不要每題都打
      if (res.statusCode === 429 && _quotaExhaustedAt === 0) {
        markQuotaExhausted();
      }
      return null;
    }
    const json = (await res.body.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) llog("Gemini 回應 200 但 candidates/text 是空");
    return text || null;
  } catch (e) {
    llog(`Gemini 呼叫失敗：${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
