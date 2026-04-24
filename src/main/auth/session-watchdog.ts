import type { Session } from "electron";
import { elearnRequest } from "../http/client";

/**
 * Light-touch session-expiry check. Hits `/mooc/user/learn_dashboard.php?tab=1` and
 * inspects whether the response looks like a logged-in dashboard vs. the login page.
 * The dashboard always contains `個人專區` (the sidebar link); the login redirect page
 * lands on `co_login_dialog.php` or bounces to the index page without that marker.
 */
export async function isSessionAlive(session: Session): Promise<boolean> {
  try {
    const { status, text } = await elearnRequest(
      session,
      "https://elearn.hrd.gov.tw/mooc/user/learn_dashboard.php?tab=1",
      { method: "GET", timeoutMs: 10_000 },
    );
    if (status >= 400) return false;
    if (status >= 300 && status < 400) return false; // redirect to login
    // Dashboard pages contain the 個人專區 link + user-specific markers.
    return /個人專區/.test(text) && /learn_dashboard\.php/.test(text);
  } catch {
    return false;
  }
}
