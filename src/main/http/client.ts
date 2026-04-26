import type { Session } from "electron";

export interface ElearnRequestOptions {
  method?: "GET" | "POST";
  body?: Record<string, string>;
  referer?: string;
  timeoutMs?: number;
  /** Set when making XHR-style POSTs that need Origin (e.g. course_record.php). */
  originHeader?: string;
  /** Kept for API compatibility; session.fetch handles redirects automatically. */
  maxRedirections?: number;
}

function toFormBody(obj: Record<string, string>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`)
    .join("&");
}

/**
 * Fire an HTTP request using Electron's session.fetch(), which automatically
 * includes all session cookies (including httpOnly) from the BrowserView's
 * cookie jar — no manual extraction needed.
 *
 * Replaces the previous undici approach where session.cookies.get() was called
 * manually but failed to deliver all required cookies to the server.
 */
export async function elearnRequest(
  session: Session,
  url: string,
  opts: ElearnRequestOptions = {},
): Promise<{ status: number; text: string; headers: Record<string, string | string[] | undefined> }> {
  const method = opts.method ?? "GET";
  const fetchHeaders: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 auto-elearn/0.1",
    Accept: "application/json, text/html, */*",
    "Accept-Language": "zh-TW,zh;q=0.9",
    "X-Requested-With": "XMLHttpRequest",
  };
  if (opts.referer) fetchHeaders.Referer = opts.referer;
  if (opts.originHeader) fetchHeaders.Origin = opts.originHeader;
  let body: string | undefined;
  if (method === "POST" && opts.body) {
    fetchHeaders["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    body = toFormBody(opts.body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await session.fetch(url, {
      method,
      headers: fetchHeaders,
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    const headers: Record<string, string | undefined> = {};
    res.headers.forEach((v: string, k: string) => {
      headers[k] = v;
    });
    return { status: res.status, text, headers };
  } finally {
    clearTimeout(timer);
  }
}
