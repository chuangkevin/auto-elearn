import { BrowserWindow, type Session } from "electron";
import type { SavedCredentials } from "./credentials";

const ECPA_ENTRY = "https://ecpa.dgpa.gov.tw/uIAM/clogin.asp?destid=CrossHRD";
const ELEARN_HOME_PREFIX = "https://elearn.hrd.gov.tw/mooc/";

export interface AutoLoginResult {
  ok: boolean;
  error?: string;
  finalUrl?: string;
}

/**
 * Silent re-login by driving the real eCPA form inside a hidden BrowserWindow.
 *
 * Why a hidden window instead of raw POST replay? The eCPA login chain is:
 *   clogin.aspx's client JS: GetUID → GetApTicketV2 → EnterTwoWayLog → EnterApplicationTwoWay
 *   → auto-submit hidden form with APReqEncodedData → /sso_verify.php → /sso_home.php → /mooc/index.php
 *
 * Replaying the POST chain by hand is brittle (captures CSRF-ish hidden fields, session
 * state on aspnet). Driving the real page lets the site's own JS handle every step — we
 * just have to type into the form and click.
 *
 * The hidden window shares the `session` argument's cookie jar, so on success the main
 * BrowserView instantly has fresh `idx`/`suc`/`PHPSESSID` without any manual copying.
 */
export async function performAutoLogin(
  creds: SavedCredentials,
  session: Session,
  opts: { timeoutMs?: number } = {},
): Promise<AutoLoginResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return new Promise<AutoLoginResult>((resolve) => {
    const win = new BrowserWindow({
      show: false,
      width: 900,
      height: 700,
      webPreferences: {
        session,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    let settled = false;
    let filled = false;
    const done = (result: AutoLoginResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        win.destroy();
      } catch {
        /* already gone */
      }
      resolve(result);
    };

    const timer = setTimeout(() => done({ ok: false, error: "auto-login timeout" }), timeoutMs);

    const checkUrl = (url: string) => {
      if (url.startsWith(ELEARN_HOME_PREFIX)) {
        done({ ok: true, finalUrl: url });
      }
    };

    win.webContents.on("did-navigate", (_e, url) => checkUrl(url));
    win.webContents.on("did-navigate-in-page", (_e, url) => checkUrl(url));

    win.webContents.on("did-finish-load", async () => {
      const url = win.webContents.getURL();
      checkUrl(url);
      if (settled) return;
      if (!url.includes("ecpa.dgpa.gov.tw")) return;
      if (!url.toLowerCase().includes("clogin")) return;
      if (filled) return;
      filled = true;

      // Give the aspnet page ~700ms so its own JS wires up event listeners before we fill.
      await new Promise((r) => setTimeout(r, 700));
      try {
        const result: { ok: boolean; reason?: string; foundSelectors?: Record<string, boolean> } =
          await win.webContents.executeJavaScript(
            `(() => {
              const q = (sel) => document.querySelector(sel);
              const visible = (el) => !!el && el.offsetParent !== null;

              // The eCPA page has 4 login columns; we want the right-most (帳號密碼登入).
              // Strategy: find all password inputs that are visible; if multiple, pick the
              // one whose account sibling is also visible and whose form is on the 帳號密碼
              // panel. We fall back to the rightmost visible password input.
              const passwords = Array.from(document.querySelectorAll('input[type="password"]'))
                .filter(visible);
              if (!passwords.length) return { ok: false, reason: 'no password input' };

              // Pick a password whose form also has a text/input for account (not PinCode)
              let passwordEl = null;
              let accountEl = null;
              for (const pw of passwords) {
                const form = pw.form || pw.closest('form') || pw.closest('div');
                if (!form) continue;
                const candidates = Array.from(form.querySelectorAll('input[type="text"], input[type="tel"], input:not([type])'))
                  .filter(visible)
                  .filter(el => !/pin/i.test(el.name + ' ' + el.id + ' ' + (el.placeholder || '')));
                if (candidates.length) {
                  passwordEl = pw; accountEl = candidates[0];
                  // Prefer the one whose placeholder mentions eCPA
                  const ecpaHint = candidates.find(el => /ecpa|帳號/i.test(el.placeholder || el.name || ''));
                  if (ecpaHint) accountEl = ecpaHint;
                  break;
                }
              }
              if (!accountEl || !passwordEl) {
                return { ok: false, reason: 'no matching account+password pair' };
              }

              // Fill with events so any aspnet / jQuery validators see the change.
              const setValue = (el, v) => {
                const proto = Object.getPrototypeOf(el);
                const desc = Object.getOwnPropertyDescriptor(proto, 'value');
                if (desc && desc.set) desc.set.call(el, v); else el.value = v;
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              };
              setValue(accountEl, ${JSON.stringify(creds.account)});
              setValue(passwordEl, ${JSON.stringify(creds.password)});

              // Find the submit button inside the same form/panel.
              const form = passwordEl.form || passwordEl.closest('form') || passwordEl.closest('div');
              let btn =
                (form && form.querySelector('button[type="submit"], input[type="submit"]')) ||
                (form && Array.from(form.querySelectorAll('button, a, input')).find(el => /登入|login/i.test(el.textContent || el.value || '')));
              if (!btn) {
                // Final fallback: submit the form directly if native
                if (form && typeof form.submit === 'function') {
                  setTimeout(() => { try { form.submit(); } catch {} }, 200);
                  return { ok: true, reason: 'form.submit()' };
                }
                return { ok: false, reason: 'no submit button' };
              }
              // Fire blur first so aspnet postbacks / GetUID fetches run.
              accountEl.dispatchEvent(new Event('blur', { bubbles: true }));
              setTimeout(() => { try { btn.click(); } catch {} }, 250);
              return { ok: true, reason: 'clicked ' + (btn.textContent || '').trim().slice(0, 20) };
            })()`,
            true,
          );
        if (!result?.ok) {
          done({ ok: false, error: `fill failed: ${result?.reason ?? "unknown"}` });
        }
      } catch (e) {
        done({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });

    win.loadURL(ECPA_ENTRY).catch((e) => done({ ok: false, error: String(e) }));
  });
}
