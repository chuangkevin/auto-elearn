import { app } from "electron";
import { request } from "undici";
import fs from "node:fs";
import path from "node:path";

/**
 * Minimal Gemini client. The API key lives in `userData/config.json` under
 * `geminiApiKey`. If the file or key is absent, every call returns null so the
 * caller can fall back to a generic string / skip.
 */

interface LocalConfig {
  geminiApiKey?: string;
  geminiModel?: string;
}

function configPath(): string {
  return path.join(app.getPath("userData"), "config.json");
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

export async function generateText(
  prompt: string,
  opts: { maxOutputTokens?: number; timeoutMs?: number } = {},
): Promise<string | null> {
  const cfg = loadConfig();
  if (!cfg.geminiApiKey) return null;
  const model = cfg.geminiModel ?? "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${cfg.geminiApiKey}`;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: opts.maxOutputTokens ?? 256,
      temperature: 0.8,
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
    return text || null;
  } catch {
    return null;
  }
}
