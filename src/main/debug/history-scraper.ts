import { BrowserWindow, type Session } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  wait,
  execJs,
  suppressDialogs,
  enterLC,
  getSysbarLinks,
  clickSysbarLink,
} from "../browser/lc-nav";

/**
 * Non-destructive elearn LC explorer. Opens a hidden window with the user's
 * existing logged-in session, enters /info/{cid} → 上課去, then walks the
 * SCORM sysbar clicking ONLY history-related links (歷次紀錄 / 學習紀錄 / etc.).
 * Dumps every frame's HTML to D:\tmp\auto-elearn-history-{cid}-*.json so the
 * exam-result-page parser can be calibrated against the real DOM.
 *
 * Critical: this never clicks "togo" / "送出" / examBegin — zero exam
 * attempts are submitted, so it's safe to run even when the user is one
 * attempt away from being rate-limited.
 */
export async function scrapeHistory(
  session: Session,
  cid: string,
  log: (msg: string) => void,
): Promise<void> {
  const dumpDir = "D:/tmp";
  const stamp = Date.now();

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      session,
      contextIsolation: true,
      nodeIntegration: false,
      disableDialogs: true,
    },
  });
  suppressDialogs(win);

  const dumpFrames = async (tag: string): Promise<void> => {
    const json = await execJs<string>(
      win,
      `(() => {
        const out = { url: location.href, title: document.title, frames: [] };
        try {
          for (let i = 0; i < window.frames.length; i++) {
            try {
              const f = window.frames[i];
              out.frames.push({
                idx: i,
                name: f.name || '',
                url: f.location.href,
                title: f.document.title || '',
                html: (f.document.documentElement.outerHTML || '').slice(0, 300000),
              });
            } catch (e) {
              out.frames.push({ idx: i, name: 'cross-origin-or-error', err: String(e) });
            }
          }
        } catch (e) {}
        return JSON.stringify(out);
      })()`,
    );
    const file = join(dumpDir, `auto-elearn-history-${cid}-${tag}-${stamp}.json`);
    writeFileSync(file, json ?? "{}", "utf8");
    log(`[scrape ${cid}] dumped ${tag} → ${file}`);
  };

  try {
    log(`[scrape ${cid}] enterLC ...`);
    const ok = await enterLC(win, cid, (m) => log(`[scrape ${cid}] ${m}`));
    if (!ok) {
      log(`[scrape ${cid}] enterLC 失敗`);
      return;
    }

    const links = await getSysbarLinks(win);
    log(`[scrape ${cid}] sysbar 全部連結: ${JSON.stringify(links)}`);
    await dumpFrames("00-after-enter");

    // The sysbar's "測驗/考試" handler routes s_main → /learn/exam/exam_list.php.
    // That's the exam-list page — it shows past attempts with scores and
    // (depending on course) per-question review links. We jump there
    // directly via JS so we don't rely on click handler text variations.
    log(`[scrape ${cid}] navigating s_main → /learn/exam/exam_list.php`);
    await execJs(
      win,
      `(() => {
        try {
          const f = window.frames['s_main'];
          if (f) { f.location.href = '/learn/exam/exam_list.php'; return true; }
        } catch (e) {}
        return false;
      })()`,
    );
    await wait(3000);
    await dumpFrames("01-exam-list");

    // The exam-list page uses div[onclick] buttons (not <a> / <button>).
    // Specifically: `togo(...)` for new attempt, `viewResult(...)` for past
    // attempt review. Read the function sources WITHOUT calling them, plus
    // fetch the exam_list.js source so we know whether viewResult is
    // destructive (locks retries) or just a navigation.
    const inspect = await execJs<{
      togoSrc: string;
      viewResultSrc: string;
      onclickButtons: Array<{ text: string; onclick: string }>;
      examListJs: string;
    }>(
      win,
      `(async () => {
        const out = { togoSrc: '', viewResultSrc: '', onclickButtons: [], examListJs: '' };
        try {
          const f = window.frames['s_main'];
          if (f) {
            try { out.togoSrc = (typeof f.togo === 'function' ? f.togo.toString() : 'not-a-fn'); } catch(e){ out.togoSrc = 'err: ' + e.message; }
            try { out.viewResultSrc = (typeof f.viewResult === 'function' ? f.viewResult.toString() : 'not-a-fn'); } catch(e){ out.viewResultSrc = 'err: ' + e.message; }
            try {
              const nodes = f.document.querySelectorAll('[onclick]');
              for (const n of nodes) {
                const t = (n.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
                out.onclickButtons.push({ text: t, onclick: n.getAttribute('onclick') || '' });
              }
            } catch(e) {}
            try {
              const r = await f.fetch('/learn/exam/exam_list.js');
              out.examListJs = (await r.text()).slice(0, 60000);
            } catch(e) { out.examListJs = 'fetch-err: ' + e.message; }
          }
        } catch(e) {}
        return out;
      })()`,
    );

    if (inspect) {
      log(`[scrape ${cid}] togo() src: ${inspect.togoSrc.slice(0, 600)}`);
      log(`[scrape ${cid}] viewResult() src: ${inspect.viewResultSrc.slice(0, 600)}`);
      log(`[scrape ${cid}] [onclick] buttons (${inspect.onclickButtons.length}):`);
      for (const b of inspect.onclickButtons) {
        log(`[scrape ${cid}]   ${b.text} → ${b.onclick.slice(0, 100)}`);
      }
      writeFileSync(join(dumpDir, `auto-elearn-history-${cid}-exam_list.js-${stamp}.txt`), inspect.examListJs ?? "", "utf8");
      log(`[scrape ${cid}] dumped exam_list.js → D:\\tmp\\auto-elearn-history-${cid}-exam_list.js-${stamp}.txt`);

      // Extract the viewResult eid from any [onclick="viewResult('...')"]
      // attribute, navigate s_main DIRECTLY to /learn/exam/view_result.php
      // (instead of letting viewResult() pop up a new window — easier to
      // dump). view_result.php is read-only per the JS source, so this is
      // safe to fire even if the user is wary of retake locks.
      let eid: string | null = null;
      for (const b of inspect.onclickButtons) {
        const m = b.onclick.match(/viewResult\(['"]([^'"]+)['"]\)/);
        if (m) {
          eid = m[1];
          break;
        }
      }
      if (eid) {
        log(`[scrape ${cid}] 🎯 直接導向 view_result.php?${eid}（read-only viewer）`);
        await execJs(
          win,
          `(() => {
            try {
              const f = window.frames['s_main'];
              if (f) { f.location.href = '/learn/exam/view_result.php?' + ${JSON.stringify(eid)}; return true; }
            } catch (e) {}
            return false;
          })()`,
        );
        await wait(4000);
        await dumpFrames("02-view-result");
        log(`[scrape ${cid}] 已 dump view_result.php 內容`);
      } else {
        log(`[scrape ${cid}] 找不到 viewResult eid — 使用者可能尚未送出任何測驗`);
      }
    }

    // Look for review/score links inside s_main on that page.
    const examListLinks = await execJs<Array<{ text: string; href: string; onclick: string }>>(
      win,
      `(() => {
        const out = [];
        try {
          const f = window.frames['s_main'];
          if (!f) return out;
          const doc = f.document;
          const nodes = doc.querySelectorAll('a,button,input[type=button]');
          for (const n of nodes) {
            const t = (n.textContent || n.value || '').trim();
            if (!t) continue;
            out.push({ text: t.slice(0, 60), href: n.href || '', onclick: n.getAttribute('onclick') || '' });
          }
        } catch (e) {}
        return out.slice(0, 60);
      })()`,
    );
    log(`[scrape ${cid}] /learn/exam/exam_list.php 上的連結 (前 60):`);
    for (const l of examListLinks ?? []) {
      log(`[scrape ${cid}]   text=${JSON.stringify(l.text)} href=${l.href} onclick=${l.onclick.slice(0, 80)}`);
    }

    // Click any link that looks like a "review past attempt" / "查看試卷" /
    // "歷次成績" — but NEVER "重新測驗" / "送出" / "繳交" / "togo". Drill
    // into the first safe match to dump per-question review HTML.
    const safeReview = /(查看|檢視|試卷|review|歷次|成績|測驗結果|分數|答案)/;
    const unsafe = /(重新|重考|送出|繳交|繳卷|togo|exam_start|examBegin|new|新測驗|開始)/;
    let drilled = 0;
    for (const l of examListLinks ?? []) {
      if (drilled >= 3) break; // cap
      if (!safeReview.test(l.text)) continue;
      if (unsafe.test(l.text) || unsafe.test(l.href) || unsafe.test(l.onclick)) {
        log(`[scrape ${cid}] 跳過危險連結: ${l.text}`);
        continue;
      }
      drilled++;
      log(`[scrape ${cid}] 嘗試點選 「${l.text}」`);
      await execJs(
        win,
        `(() => {
          try {
            const f = window.frames['s_main'];
            if (!f) return false;
            const doc = f.document;
            const nodes = doc.querySelectorAll('a,button,input[type=button]');
            for (const n of nodes) {
              const t = (n.textContent || n.value || '').trim();
              if (t === ${JSON.stringify(l.text)}) { n.click(); return true; }
            }
          } catch (e) {}
          return false;
        })()`,
      );
      await wait(3000);
      const safeName = l.text.replace(/\s+/g, "_").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
      await dumpFrames(`02-review-${drilled}-${safeName}`);
      // Go back so the next click starts from exam_list again
      await execJs(
        win,
        `(() => {
          try {
            const f = window.frames['s_main'];
            if (f && f.location.pathname !== '/learn/exam/exam_list.php') {
              f.location.href = '/learn/exam/exam_list.php';
            }
          } catch (e) {}
          return null;
        })()`,
      );
      await wait(2000);
    }

    // Patterns that look like history / record / past-attempts pages.
    // Cast a wide net so even oddly-named courses get coverage; per-link
    // dump is segregated by safe-name so we can compare.
    const patterns = [
      /歷次/, /歷程/, /紀錄/, /歷史/, /成績/, /結果/, /次紀錄/, /學習/,
    ];
    let visited = 0;
    for (const link of links) {
      if (!patterns.some((p) => p.test(link))) continue;
      // Skip the "開始上課" / "測驗" / "問卷" entries — only history-style.
      if (/開始上課|^測驗|^問卷|^考試/.test(link)) continue;
      visited++;
      log(`[scrape ${cid}] click sysbar 「${link}」`);
      const clicked = await clickSysbarLink(win, link);
      if (!clicked) {
        log(`[scrape ${cid}] 點擊失敗: ${link}`);
        continue;
      }
      await wait(2500);

      const safeName = link
        .replace(/\s+/g, "_")
        .replace(/[\\/:*?"<>|]/g, "_")
        .slice(0, 40);
      await dumpFrames(`link-${visited}-${safeName}`);

      // After dumping, also try to find any "查看" / "詳細" / "review" /
      // attempt-id links inside s_main and click the first one — past
      // attempt entries usually need a second click to expand the per-Q
      // review.
      const subLinks = await execJs<Array<{ text: string; href: string }>>(
        win,
        `(() => {
          const out = [];
          const tryFrame = (doc) => {
            const nodes = doc.querySelectorAll('a,button');
            for (const n of nodes) {
              const t = (n.textContent || '').trim();
              if (!t) continue;
              if (/查看|詳情|詳細|檢視|看試卷|review|歷次|第.*次/.test(t) && t.length < 40) {
                out.push({ text: t, href: n.href || n.getAttribute('onclick') || '' });
              }
            }
          };
          try {
            for (let i = 0; i < window.frames.length; i++) {
              try { tryFrame(window.frames[i].document); } catch (e) {}
            }
          } catch (e) {}
          return out.slice(0, 5);
        })()`,
      );
      log(`[scrape ${cid}] 子連結 (前 5): ${JSON.stringify(subLinks)}`);

      // Try to click the FIRST sub-link to drill into a per-attempt review
      // page. Same caveat: only safe text patterns, never a "送出" button.
      if (subLinks && subLinks.length > 0) {
        const sub = subLinks[0];
        if (sub.text && !/送出|繳交|提交|繳卷/.test(sub.text)) {
          log(`[scrape ${cid}] click 子連結 「${sub.text}」`);
          await execJs(
            win,
            `(() => {
              try {
                for (let i = 0; i < window.frames.length; i++) {
                  try {
                    const doc = window.frames[i].document;
                    const nodes = doc.querySelectorAll('a,button');
                    for (const n of nodes) {
                      if ((n.textContent || '').trim() === ${JSON.stringify(sub.text)}) {
                        n.click();
                        return true;
                      }
                    }
                  } catch (e) {}
                }
              } catch (e) {}
              return false;
            })()`,
          );
          await wait(2500);
          await dumpFrames(`link-${visited}-${safeName}-detail`);
        }
      }
    }

    log(`[scrape ${cid}] 共處理 ${visited} 個歷史相關連結；檔案放在 ${dumpDir}/auto-elearn-history-${cid}-*-${stamp}.json`);
  } catch (e) {
    log(`[scrape ${cid}] error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    try {
      win.destroy();
    } catch {
      /* already destroyed */
    }
  }
}
