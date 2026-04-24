import { net, type Session } from "electron";

/**
 * Silent auto-login by replaying the eCPA POST chain directly, no browser.
 *
 * Observed chain (see docs/research/06 and login_flow.md):
 *   1. GET elearn.hrd.gov.tw/                                  → seed PHPSESSID
 *   2. GET ecpa.dgpa.gov.tw/uIAM/clogin.asp?destid=CrossHRD    → 302
 *        → GET webform/clogin.aspx?returnUrl=...               → seed ASP.NET_SessionId
 *   3. POST ecpa.dgpa.gov.tw/Home/GetApTicketV2
 *        body: account, password, ApID=CrossHRD                → returns 0/1/OK
 *   4. POST ecpa.dgpa.gov.tw/Home/EnterTwoWayLog
 *        body: account, loginType=0, sn=, ticket=, appId=CrossHRD
 *   5. POST ecpa.dgpa.gov.tw/Home/EnterApplicationTwoWay
 *        body: appId=CrossHRD                                  → HTML with APReqEncodedData
 *   6. POST elearn.hrd.gov.tw/sso_verify.php
 *        body: loginType=0, APReqEncodedData=<hex>             → 302 sso_home
 *   7. follow to /mooc/index.php                               → logged in
 *
 * Uses Electron `net.request` so the provided `session`'s cookie jar is
 * automatically shared across all three hosts (elearn + ecpa + the iframe
 * sub-domains later). No manual Set-Cookie parsing.
 */

export interface EcpaLoginResult {
  ok: boolean;
  error?: string;
  /** Which step broke, for telemetry */
  stage?: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const CLOGIN_ASPX_URL =
  "https://ecpa.dgpa.gov.tw/webform/clogin.aspx?returnUrl=https://elearn.hrd.gov.tw/sso_verify.php&Naminglogo=https://ecpa.dgpa.gov.tw/webform/logo-hrd.png&showecpa=Y";

export async function loginViaEcpa(
  session: Session,
  account: string,
  password: string,
): Promise<EcpaLoginResult> {
  try {
    // 1. Prime elearn session (makes sure we have a PHPSESSID to write idx/suc into later).
    await req(session, "GET", "https://elearn.hrd.gov.tw/mooc/index.php");

    // 2. Enter eCPA clogin. The uIAM entry 302s across to webform/clogin.aspx;
    //    useSessionCookies=true + redirect=follow takes us there automatically.
    const clogin = await req(
      session,
      "GET",
      "https://ecpa.dgpa.gov.tw/uIAM/clogin.asp?destid=CrossHRD",
      undefined,
      "https://elearn.hrd.gov.tw/",
    );
    if (clogin.status >= 400) {
      return { ok: false, stage: "clogin", error: `HTTP ${clogin.status}` };
    }

    // 2.5 If `account` doesn't look like a full 身分證字號 (one letter + 9 digits),
    //     call Home/GetUID to resolve the short alias. The response is PLAIN
    //     TEXT — just the full ID, e.g. body = "F130918271" (no JSON wrapping).
    let fullAccount = account.trim();
    if (!/^[A-Za-z]\d{9}$/.test(fullAccount)) {
      const uid = await req(
        session,
        "POST",
        "https://ecpa.dgpa.gov.tw/Home/GetUID",
        { account: fullAccount },
        CLOGIN_ASPX_URL,
        "https://ecpa.dgpa.gov.tw",
      );
      if (uid.status >= 400) {
        return { ok: false, stage: "GetUID", error: `HTTP ${uid.status}` };
      }
      const trimmed = uid.body.trim();
      if (/^[A-Za-z]\d{9}$/.test(trimmed)) {
        fullAccount = trimmed;
      } else {
        // Fallback: letter+9digits anywhere in body
        const m = uid.body.match(/\b([A-Za-z]\d{9})\b/);
        if (m) fullAccount = m[1];
        else {
          return {
            ok: false,
            stage: "GetUID",
            error: `alias not resolvable (body: "${uid.body.slice(0, 120)}")`,
          };
        }
      }
    }

    // 3. GetApTicketV2 — credential check; RESPONSE BODY IS THE APReqEncodedData
    //    hex string directly (no JSON envelope). Empty / non-hex body = wrong
    //    password.
    const ticket = await req(
      session,
      "POST",
      "https://ecpa.dgpa.gov.tw/Home/GetApTicketV2",
      { account: fullAccount, password, ApID: "CrossHRD" },
      CLOGIN_ASPX_URL,
      "https://ecpa.dgpa.gov.tw",
    );
    if (ticket.status >= 400) {
      return { ok: false, stage: "GetApTicketV2", error: `HTTP ${ticket.status}` };
    }
    const hex = ticket.body.trim();
    if (!/^[0-9A-Fa-f]{100,}$/.test(hex)) {
      // Short / empty / "0" body = credential mismatch (or eCPA lockout).
      return {
        ok: false,
        stage: "GetApTicketV2",
        error: `帳號或密碼錯誤 (body: "${hex.slice(0, 120)}")`,
      };
    }
    const encoded = hex;

    // 4. EnterTwoWayLog — records the login event. Body responds "0" on success.
    await req(
      session,
      "POST",
      "https://ecpa.dgpa.gov.tw/Home/EnterTwoWayLog",
      {
        account: fullAccount,
        loginType: "0",
        sn: "",
        ticket: "",
        appId: "CrossHRD",
      },
      CLOGIN_ASPX_URL,
      "https://ecpa.dgpa.gov.tw",
    );

    // 5. EnterApplicationTwoWay — signals "I'm about to jump to the app". Body "0".
    await req(
      session,
      "POST",
      "https://ecpa.dgpa.gov.tw/Home/EnterApplicationTwoWay",
      { appId: "CrossHRD" },
      CLOGIN_ASPX_URL,
      "https://ecpa.dgpa.gov.tw",
    );

    // 6. POST sso_verify.php with the encoded ticket. 302 → sso_home → 302
    //    /mooc/index.php; net.request auto-follows with useSessionCookies so
    //    the idx / suc / PHPSESSID cookies from the redirects land in our
    //    shared session jar.
    const sso = await req(
      session,
      "POST",
      "https://elearn.hrd.gov.tw/sso_verify.php",
      { loginType: "0", APReqEncodedData: encoded },
      "https://ecpa.dgpa.gov.tw/",
      "https://ecpa.dgpa.gov.tw",
    );
    if (sso.status >= 400) {
      return { ok: false, stage: "sso_verify", error: `HTTP ${sso.status}` };
    }

    // 7. Trust-but-verify: check that session now has the auth cookies set.
    //    This beats pulling /mooc/index.php — that endpoint always returns
    //    200 HTML regardless of auth (its content just differs) and the
    //    rendered body doesn't always include our "個人專區" marker when
    //    fetched server-side without full JS execution.
    const cookies = await session.cookies.get({ url: "https://elearn.hrd.gov.tw/" });
    const cookieNames = new Set(cookies.map((c) => c.name));
    const required = ["idx", "suc"];
    const missing = required.filter((n) => !cookieNames.has(n));
    if (missing.length) {
      return {
        ok: false,
        stage: "verify",
        error: `session missing cookies: ${missing.join(", ")} (have: ${Array.from(cookieNames).join(",")})`,
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, stage: "exception", error: e instanceof Error ? e.message : String(e) };
  }
}

function req(
  session: Session,
  method: "GET" | "POST",
  url: string,
  body?: Record<string, string>,
  referer?: string,
  origin?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = net.request({
      method,
      url,
      session,
      useSessionCookies: true,
      redirect: "follow",
    });
    r.setHeader("User-Agent", UA);
    r.setHeader("Accept", "application/json, text/html, */*");
    r.setHeader("Accept-Language", "zh-TW,zh;q=0.9");
    r.setHeader("X-Requested-With", "XMLHttpRequest");
    if (referer) r.setHeader("Referer", referer);
    if (origin) r.setHeader("Origin", origin);
    let payload = "";
    if (body) {
      r.setHeader("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
      payload = Object.entries(body)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? "")}`)
        .join("&");
      r.write(payload);
    }
    r.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve({ status: res.statusCode, body: text });
      });
      res.on("error", reject);
    });
    r.on("error", reject);
    r.end();
  });
}
