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
