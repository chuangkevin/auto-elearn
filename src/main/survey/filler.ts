import { BrowserWindow, type Session } from "electron";

export interface SurveyResult {
  ok: boolean;
  filled: number;
  submitted: boolean;
  error?: string;
}

/**
 * Fill in the "問卷/評價" for a single course.
 *
 * Observed flow (matches decompile of 原 E等閱讀家):
 *   1. /info/<cid> has a "填寫問卷" button (sometimes in an iframe)
 *   2. Click it — may open a new page with a Likert/star form
 *   3. Pick value="1" on every radio/checkbox (site convention: value 1 = best)
 *   4. Submit via `input[type='submit'][value='確定繳交']`
 *
 * Star ratings (評價) usually render as radios with values 1-5 where 5 is best;
 * our selector `value='5'` branch covers that.
 */
export async function fillSurvey(
  cid: string,
  session: Session,
  opts: {
    onProgress?: (msg: string) => void;
    timeoutMs?: number;
  } = {},
): Promise<SurveyResult> {
  const { onProgress } = opts;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const result: SurveyResult = { ok: false, filled: 0, submitted: false };

  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    webPreferences: {
      session,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.on("did-frame-finish-load", () => {
    win.webContents
      .executeJavaScript(
        `try { window.alert = () => void 0; window.confirm = () => true; window.prompt = () => ''; } catch(e){}`,
        true,
      )
      .catch(() => void 0);
  });

  const deadline = Date.now() + timeoutMs;
  const log = (msg: string) => onProgress?.(msg);

  try {
    await win.loadURL(`https://elearn.hrd.gov.tw/info/${cid}`);
    await wait(1200);

    // Click 填寫問卷 / 進行問卷
    const clickedOpen = await allFrames<{ ok: boolean; where?: string }>(
      win,
      `(() => {
        const tryClick = el => { if (el) { el.click(); return true; } return false; };
        let btn = Array.from(DOC.querySelectorAll('div.main-text')).find(el => /填寫問卷|進行問卷|填寫評價|進行評價/.test((el.textContent || '').trim()));
        if (btn) return { ok: tryClick(btn), where: 'div.main-text' };
        btn = DOC.querySelector('input[value*="填寫問卷"], input[value*="進行問卷"], input[value*="填寫評價"]');
        if (btn) return { ok: tryClick(btn), where: 'input' };
        btn = Array.from(DOC.querySelectorAll('a')).find(el => /填寫問卷|進行問卷|填寫評價|進行評價/.test((el.textContent || '').trim()));
        if (btn) return { ok: tryClick(btn), where: 'a' };
        return null;
      })()`,
    );
    if (!clickedOpen?.ok) {
      result.error = "找不到填寫問卷按鈕";
      return result;
    }
    log(`點擊「填寫問卷」(${clickedOpen.where})`);
    await wait(2000);

    // Fill the form: radio/checkbox value='1' (best), plus any star-radio value='5'.
    const filled = await allFrames<number>(
      win,
      `(() => {
        let n = 0;
        // Group inputs by name and pick one per group.
        const groups = new Map();
        Array.from(DOC.querySelectorAll('input[type=radio], input[type=checkbox]')).forEach(el => {
          const name = el.name || '';
          if (!groups.has(name)) groups.set(name, []);
          groups.get(name).push(el);
        });
        for (const [name, inputs] of groups) {
          // Prefer value='1'; if not present try value='5' (star rating); else first input.
          const byVal = (v) => inputs.find(i => String(i.value) === v);
          const pick = byVal('1') || byVal('5') || inputs[0];
          if (!pick) continue;
          pick.checked = true;
          pick.dispatchEvent(new Event('change', { bubbles: true }));
          n++;
        }
        // Plain rating inputs / textareas that expect "滿意" / a number — leave textareas
        // empty here; reflection phase (if needed) handles writing them.
        return n;
      })()`,
    );
    result.filled = filled ?? 0;
    log(`已勾選 ${result.filled} 組答案`);

    if (Date.now() > deadline) {
      result.error = "timeout before submit";
      return result;
    }

    // Submit
    const submitted = await allFrames<boolean>(
      win,
      `(() => {
        const btn = DOC.querySelector("input[type='submit'][value='確定繳交']")
                 || DOC.querySelector("input[type='submit'][value*='繳交']")
                 || DOC.querySelector("input[type='submit'][value*='送出']");
        if (btn) { btn.click(); return true; }
        return null;
      })()`,
    );
    result.submitted = !!submitted;
    if (!submitted) {
      result.error = "找不到繳交按鈕";
      return result;
    }
    log("已提交問卷");
    await wait(2000);

    result.ok = true;
    return result;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    return result;
  } finally {
    try {
      win.destroy();
    } catch {
      /* already gone */
    }
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function allFrames<T>(win: BrowserWindow, bodyUsingDOC: string): Promise<T | null> {
  const wrapped = `(() => {
    const attempt = (DOC) => {
      try { return (${bodyUsingDOC}); } catch (e) { return null; }
    };
    let v = attempt(document);
    if (v) return v;
    for (let i = 0; i < window.frames.length; i++) {
      try {
        const fdoc = window.frames[i].document;
        v = attempt(fdoc);
        if (v) return v;
      } catch (e) {}
    }
    return null;
  })()`;
  try {
    return (await win.webContents.executeJavaScript(wrapped, true)) as T | null;
  } catch {
    return null;
  }
}
