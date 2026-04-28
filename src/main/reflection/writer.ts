import { BrowserWindow, type Session } from "electron";
import { generateText, hasGeminiKey } from "../llm/gemini";
import {
  wait,
  execJs,
  suppressDialogs,
  enterLC,
  getSysbarLinks,
  clickSysbarLink,
} from "../browser/lc-nav";

export interface ReflectionResult {
  ok: boolean;
  text?: string;
  error?: string;
  source: "gemini" | "generic" | "none";
}

const GENERIC_TEMPLATES = [
  "課程內容清楚，透過實例說明讓我對主題有更完整的理解；最受用的是將理論與實務結合的段落，未來在工作中會將學到的重點落實到日常流程裡。",
  "整體課程節奏適中，講師的脈絡清晰，能把關鍵概念拆解成容易吸收的小段落；印象最深的是實務案例的分析，讓我反思過去在處理類似情境時還有可以改進的地方。",
  "本課程幫助我釐清了許多原本模糊的概念，尤其是在風險辨識與因應步驟上獲得具體的方向。之後會把這些思維內化成處理業務的基本功，並與同仁分享。",
];

function randomGeneric(): string {
  return GENERIC_TEMPLATES[Math.floor(Math.random() * GENERIC_TEMPLATES.length)];
}

export async function writeReflection(
  cid: string,
  courseName: string,
  session: Session,
  opts: { onProgress?: (msg: string) => void; timeoutMs?: number } = {},
): Promise<ReflectionResult> {
  const log = opts.onProgress ?? (() => void 0);

  // Generate text first (no browser needed)
  let text: string | null = null;
  let source: ReflectionResult["source"] = "none";
  if (hasGeminiKey()) {
    const prompt = `你是一位公務員，剛完成「${courseName}」這堂線上課程，請用繁體中文寫一段 120-180 字的學習心得，內容要：\n- 具體提到課程主題\n- 舉一個你會如何運用在工作上的例子\n- 語氣平實、不浮誇、不使用條列\n直接輸出心得內文，不要加標題或額外說明。`;
    const gen = await generateText(prompt, { maxOutputTokens: 400, timeoutMs: 15_000 });
    if (gen && gen.length >= 60) {
      text = gen;
      source = "gemini";
    }
  }
  if (!text) {
    text = randomGeneric();
    source = "generic";
  }
  log(`心得來源：${source}`);

  // No disableDialogs — see reader.ts; window.confirm must return true.
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { session, contextIsolation: true, nodeIntegration: false },
  });
  suppressDialogs(win);

  const result: ReflectionResult = { ok: false, source, text };

  try {
    const lcOk = await enterLC(win, cid, log);
    if (!lcOk) {
      result.error = "無法進入學習中心";
      return result;
    }

    const links = await getSysbarLinks(win);
    if (!links.some((l) => /心得/.test(l))) {
      result.error = "無心得選單，略過";
      return result;
    }

    await clickSysbarLink(win, "心得");

    // The reflection textarea is directly in s_main (no popup)
    // Wait for it to appear
    await wait(1500);

    const safeText = JSON.stringify(text);
    const filled = await execJs<boolean>(
      win,
      `(() => {
        const tryDoc = (doc) => {
          const ta = doc.querySelector('textarea');
          if (!ta) return false;
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value')?.set;
          if (setter) setter.call(ta, ${safeText}); else ta.value = ${safeText};
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          ta.dispatchEvent(new Event('change', { bubbles: true }));
          const form = ta.form || ta.closest('form');
          const btn = (form && form.querySelector("input[type='submit'],button[type='submit']"))
                   || Array.from((form || doc).querySelectorAll('button,input'))
                      .find(el => /送出|確定|繳交|提交/.test(el.textContent || el.value || ''));
          if (btn) { btn.click(); return true; }
          return true; // filled but no submit found
        };
        // Try s_main by name
        const byName = window.frames['s_main'];
        if (byName) { try { if (tryDoc(byName.document)) return true; } catch(e) {} }
        // Iterate frames
        for (let i = 0; i < window.frames.length; i++) {
          try {
            if (window.frames[i].name === 's_main') {
              if (tryDoc(window.frames[i].document)) return true;
            }
          } catch(e) {}
        }
        // Fallback: frame[1]
        if (window.frames.length >= 2) {
          try { if (tryDoc(window.frames[1].document)) return true; } catch(e) {}
        }
        // Last resort: top document
        return tryDoc(document);
      })()`,
    );

    if (!filled) {
      result.error = "找不到心得 textarea，略過";
      return result;
    }

    await wait(2000);
    log("心得已填寫並送出 ✓");
    result.ok = true;
    return result;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    return result;
  } finally {
    try {
      win.destroy();
    } catch {
      /* already closed */
    }
  }
}
