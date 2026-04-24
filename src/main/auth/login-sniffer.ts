import type { Session } from "electron";

export interface SniffedCredentials {
  account: string;
  password: string;
  capturedAt: string;
}

export type SniffListener = (creds: SniffedCredentials) => void;

/**
 * Listen for the eCPA `GetApTicketV2` POST the site fires during login. That request's
 * body is `account=...&password=...&ApID=CrossHRD` — the only way to learn the full ID
 * + password without asking the user to retype them. We never persist anything here;
 * credentials are forwarded to the listener which is responsible for deciding what to
 * do (prompt user, save, discard).
 *
 * Also watches `/Home/GetUID` so we can remember the short alias the user actually
 * typed (useful as a display-only field; we log in with the full ID).
 */
export function attachLoginSniffer(session: Session, onCapture: SniffListener): () => void {
  const lastAlias: { value: string | null } = { value: null };

  const filter = { urls: ["https://ecpa.dgpa.gov.tw/Home/*"] };

  const handler = (
    details: Electron.OnBeforeRequestListenerDetails,
    cb: (response: Electron.CallbackResponse) => void,
  ) => {
    cb({});
    if (details.method !== "POST" || !details.uploadData?.length) return;
    const chunk = details.uploadData[0];
    if (!chunk?.bytes) return;
    let body: string;
    try {
      body = Buffer.from(chunk.bytes).toString("utf-8");
    } catch {
      return;
    }
    const params = new URLSearchParams(body);

    if (details.url.includes("/Home/GetUID")) {
      const alias = params.get("account");
      if (alias) lastAlias.value = alias;
      return;
    }

    if (details.url.includes("/Home/GetApTicketV2")) {
      const account = params.get("account");
      const password = params.get("password");
      if (!account || !password) return;
      onCapture({
        account,
        password,
        capturedAt: new Date().toISOString(),
      });
    }
  };

  session.webRequest.onBeforeRequest(filter, handler);

  return () => {
    // Passing a null listener detaches per Electron docs.
    session.webRequest.onBeforeRequest(filter, null as unknown as typeof handler);
  };
}
