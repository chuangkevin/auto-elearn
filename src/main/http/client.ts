import type { Session } from "electron";
import { request } from "undici";

export interface ElearnRequestOptions {
  method?: "GET" | "POST";
  body?: Record<string, string>;
  referer?: string;
  timeoutMs?: number;
  /** Set when making XHR-style POSTs that need Origin (e.g. course_record.php). */
  originHeader?: string;
}

/** Build a Cookie header from the BrowserView's session. */
async function cookieHeader(session: Session, url: string): Promise<string> {
  const cookies = await session.cookies.get({ url });
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

function toFormBody(obj: Record<string, string>): string {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`)
    .join("&");
}

/**
 * Fire an HTTP request reusing the BrowserView's session cookies.
 * Returns the raw text body.
 */
export async function elearnRequest(
  session: Session,
  url: string,
  opts: ElearnRequestOptions = {},
): Promise<{ status: number; text: string; headers: Record<string, string | string[] | undefined> }> {
  const method = opts.method ?? "GET";
  const cookie = await cookieHeader(session, url);
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 auto-elearn/0.1",
    Accept: "application/json, text/html, */*",
    "Accept-Language": "zh-TW,zh;q=0.9",
    "X-Requested-With": "XMLHttpRequest",
    Cookie: cookie,
  };
  if (opts.referer) headers.Referer = opts.referer;
  if (opts.originHeader) headers.Origin = opts.originHeader;
  let body: string | undefined;
  if (method === "POST" && opts.body) {
    headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
    body = toFormBody(opts.body);
  }

  const res = await request(url, {
    method,
    headers,
    body,
    headersTimeout: opts.timeoutMs ?? 15000,
    bodyTimeout: opts.timeoutMs ?? 15000,
  });
  const text = await res.body.text();
  return { status: res.statusCode, text, headers: res.headers as Record<string, string | string[] | undefined> };
}
