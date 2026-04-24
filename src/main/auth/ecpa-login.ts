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

    // 2.5 If `account` looks like a SHORT ALIAS (anything other than one-letter
    //     + 9-digits 身分證字號 format), call Home/GetUID to resolve it to the
    //     full ID. eCPA's GetApTicketV2 only accepts the full ID; sending a
    //     short alias returns a silent failure and EnterApplicationTwoWay
    //     later returns just "0".
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
      // Response format observed: JSON-ish {"returnCode":"0","uid":"F130918271",...}
      // or plain string with the full ID embedded.
      const resolved =
        uid.body.match(/["'](?:UID|uid)["']\s*:\s*["']([A-Za-z]\d{9})["']/)?.[1] ||
        uid.body.match(/\b([A-Z]\d{9})\b/)?.[1];
      if (resolved) {
        fullAccount = resolved;
      } else {
        return {
          ok: false,
          stage: "GetUID",
          error: `alias not resolvable (body: ${uid.body.slice(0, 200)})`,
        };
      }
    }

    // 3. GetApTicketV2 — the actual credential check.
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
    // Response body is usually a small JSON like {"returnCode":"0","returnDesc":"OK"}.
    // Anything with returnCode != "0" means wrong account/password.
    const rc = ticket.body.match(/"returnCode"\s*:\s*"?([^",}]+)/)?.[1]?.trim();
    if (rc && rc !== "0" && rc !== "00" && rc !== "OK") {
      return {
        ok: false,
        stage: "GetApTicketV2",
        error: `returnCode=${rc} (${ticket.body.slice(0, 200)})`,
      };
    }

    // 4. EnterTwoWayLog — records the login event. Fire-and-forget.
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

    // 5. EnterApplicationTwoWay — this returns an HTML form with a hidden
    //    APReqEncodedData input that the real page auto-submits to sso_verify.
    const ap2 = await req(
      session,
      "POST",
      "https://ecpa.dgpa.gov.tw/Home/EnterApplicationTwoWay",
      { appId: "CrossHRD" },
      CLOGIN_ASPX_URL,
      "https://ecpa.dgpa.gov.tw",
    );
    if (ap2.status >= 400) {
      return { ok: false, stage: "EnterApplicationTwoWay", error: `HTTP ${ap2.status}` };
    }

    // Extract APReqEncodedData. Try several formats: HTML input, JSON, or raw body.
    const encoded =
      ap2.body.match(
        /name\s*=\s*["']APReqEncodedData["']\s+value\s*=\s*["']([0-9A-Fa-f]+)["']/,
      )?.[1] ||
      ap2.body.match(/["']APReqEncodedData["']\s*:\s*["']([0-9A-Fa-f]+)["']/)?.[1] ||
      ap2.body.match(/APReqEncodedData=([0-9A-Fa-f]+)/)?.[1];
    if (!encoded) {
      return {
        ok: false,
        stage: "EnterApplicationTwoWay",
        error: `no APReqEncodedData in response (${ap2.body.slice(0, 200)})`,
      };
    }

    // 6. POST sso_verify.php with the encoded ticket. 302 to sso_home;
    //    net.request auto-follows into the final /mooc/index.php load,
    //    picking up idx/suc/PHPSESSID cookies on the way.
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

    // 7. Confirm logged in.
    const home = await req(
      session,
      "GET",
      "https://elearn.hrd.gov.tw/mooc/index.php",
    );
    if (!/個人專區|learn_dashboard/.test(home.body)) {
      return { ok: false, stage: "verify", error: "dashboard marker not in body" };
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
