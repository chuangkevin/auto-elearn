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
  /** v0.8.1：使用者可能輸入短別名（例如 `kevin123`）；GetUID 會把它解析成完整身分證
   *  字號（`F130918271`）。submitNewAccount 用這個來決定 partition / account id —
   *  保證不論使用者怎麼打，同一個 e 等帳號永遠對應同一個 storage id。
   *  Login 失敗時可能也填了（例如 GetUID 成功但密碼錯）。 */
  resolvedAccount?: string;
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
        resolvedAccount: fullAccount,
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

    // 7. Small delay so the session cookie jar commits the Set-Cookie headers
    //    written by net.request during the sso redirect chain.
    // v0.8.6：600 → 250ms。實測 net.request 結束後 cookie jar 通常 50-100ms 內就
    //    commit 完，600ms 太保守。減 350ms 對單次 login 不多，但 alias 路徑（之
    //    前要跑兩次）能省下不少；同時加退路：cookie 沒抓到時短迴圈再等 200ms × 3。
    await new Promise((r) => setTimeout(r, 250));

    // 8. Cookie-based verify (spec: "idx + suc present" = authenticated).
    //    We deliberately avoid fetching learn_dashboard.php here because
    //    elearn is a SPA — the raw HTML response never contains 個人專區/登出,
    //    causing the old body-text check to always report failure even when
    //    the session is genuinely authenticated.
    // v0.8.6：250ms 後 cookie 還沒落地就再等 3 × 200ms — 比硬等 600ms 快，又不會
    //    在快速 case 噴 verify-failed。
    let cookies = await session.cookies.get({ url: "https://elearn.hrd.gov.tw/" });
    let idx = cookies.find((c) => c.name === "idx");
    for (let retry = 0; retry < 3 && !idx?.value; retry++) {
      await new Promise((r) => setTimeout(r, 200));
      cookies = await session.cookies.get({ url: "https://elearn.hrd.gov.tw/" });
      idx = cookies.find((c) => c.name === "idx");
    }
    if (!idx?.value) {
      const cookieSummary = cookies.map((c) => c.name).join(",");
      return {
        ok: false,
        stage: "verify",
        error: `session cookies missing idx; present=[${cookieSummary}]; sso status was ${sso.status}`,
        resolvedAccount: fullAccount,
      };
    }
    return { ok: true, resolvedAccount: fullAccount };
  } catch (e) {
    return { ok: false, stage: "exception", error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * v0.8.6：別名解析獨立 endpoint。submitNewAccount 用這個提早決定 partition id，
 * 避免「先用猜的 id 跑完整 SSO → 發現不對 → 換 partition 再跑一次完整 SSO」造成
 * ~30-60s 浪費（兩次 SSO 各 5 個 net.request × 政府主機慢）。
 *
 * 只打 GetUID（一次 POST，~1-2s）。回傳 null 代表：
 *   - 別名不存在
 *   - eCPA 暫時掛了
 *   - 該 alias 暫時被鎖（試太多次密碼）
 * caller 負責 fallback 行為（繼續用 raw input 還是直接報錯）。
 */
export async function resolveAlias(
  session: Session,
  alias: string,
): Promise<string | null> {
  const trimmed = alias.trim();
  // 已經是完整 ID（1 碼英文 + 9 碼數字）就不需要 resolve
  if (/^[A-Za-z]\d{9}$/.test(trimmed)) return trimmed;

  try {
    // 為了 GetUID 能拿到正確的 ASP.NET_SessionId，先 GET clogin 一次
    await req(session, "GET", CLOGIN_ASPX_URL, undefined, "https://elearn.hrd.gov.tw/");
    const uid = await req(
      session,
      "POST",
      "https://ecpa.dgpa.gov.tw/Home/GetUID",
      { account: trimmed },
      CLOGIN_ASPX_URL,
      "https://ecpa.dgpa.gov.tw",
    );
    if (uid.status >= 400) return null;
    const body = uid.body.trim();
    if (/^[A-Za-z]\d{9}$/.test(body)) return body;
    const m = body.match(/\b([A-Za-z]\d{9})\b/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

interface ReqOpts {
  /** true = send X-Requested-With: XMLHttpRequest. Match the real browser's
   *  behaviour: eCPA `/Home/*` endpoints DO get this header; the auto-submitted
   *  `sso_verify.php` form doesn't. Defaults to true for /Home/*, false otherwise. */
  xhr?: boolean;
}

function req(
  session: Session,
  method: "GET" | "POST",
  url: string,
  body?: Record<string, string>,
  referer?: string,
  origin?: string,
  opts: ReqOpts = {},
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
    const wantXhr = opts.xhr ?? /ecpa\.dgpa\.gov\.tw\/Home\//.test(url);
    if (wantXhr) r.setHeader("X-Requested-With", "XMLHttpRequest");
    if (referer) r.setHeader("Referer", referer);
    if (origin) r.setHeader("Origin", origin);
    let payload = "";
    if (body) {
      // No charset param — the browser's captured POSTs are just
      // `application/x-www-form-urlencoded`; tacking `; charset=UTF-8` on
      // made our requests distinguishable from the real form submit.
      r.setHeader("Content-Type", "application/x-www-form-urlencoded");
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
