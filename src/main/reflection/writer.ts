import { BrowserWindow, type Session } from "electron";
import { generateText, hasGeminiKey } from "../llm/gemini";

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

/**
 * Best-effort: if the course page / reflection page has a textarea for 心得 / 學習心得,
 * fill it with Gemini-generated content (if API key is configured) or a generic
 * template. Skips gracefully when no textarea is found or no key is present.
 */
export async function writeReflection(
  cid: string,
  courseName: string,
  session: Session,
  opts: { onProgress?: (msg: string) => void; timeoutMs?: number } = {},
): Promise<ReflectionResult> {
  const { onProgress } = opts;
  const timeoutMs = opts.timeoutMs ?? 45_000;

  // 1. Get text to put in the field
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
  onProgress?.(`心得來源：${source}`);

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
        `try { window.alert = () => void 0; window.confirm = () => true; } catch(e){}`,
        true,
      )
      .catch(() => void 0);
  });

  const result: ReflectionResult = { ok: false, source, text };

  try {
    await win.loadURL(`https://elearn.hrd.gov.tw/info/${cid}`);
    await new Promise((r) => setTimeout(r, Math.min(1200, timeoutMs / 4)));

    // Try to click a 心得 / 學習心得 link first, if one is visible
    await win.webContents
      .executeJavaScript(
        `(() => {
          const tryClick = el => { if (el) { el.click(); return true; } return false; };
          const hit = Array.from(document.querySelectorAll('a, button, div.main-text, input'))
            .find(el => /學習心得|填寫心得|寫心得/.test((el.textContent || el.value || '').trim()));
          return tryClick(hit);
        })()`,
        true,
      )
      .catch(() => void 0);
    await new Promise((r) => setTimeout(r, 1500));

    // Find a textarea; fill it; submit.
    const filled = await win.webContents
      .executeJavaScript(
        `(() => {
          const attempt = (DOC) => {
            const ta = DOC.querySelector('textarea');
            if (!ta) return null;
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ta), 'value')?.set;
            if (setter) setter.call(ta, ${JSON.stringify(text)}); else ta.value = ${JSON.stringify(text)};
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.dispatchEvent(new Event('change', { bubbles: true }));
            const form = ta.form || ta.closest('form');
            const btn = (form && form.querySelector("input[type='submit'], button[type='submit']"))
                     || Array.from((form || DOC).querySelectorAll('button, input'))
                        .find(el => /送出|確定|繳交|提交/.test((el.textContent || el.value || '')));
            if (btn) btn.click();
            return { ok: true, clicked: !!btn };
          };
          let v = attempt(document);
          if (v) return v;
          for (let i = 0; i < window.frames.length; i++) {
            try { const doc = window.frames[i].document; v = attempt(doc); if (v) return v; } catch(e){}
          }
          return null;
        })()`,
        true,
      )
      .catch(() => null);

    if (!filled) {
      result.error = "頁面沒有心得 textarea，略過";
      return result;
    }
    result.ok = true;
    onProgress?.("心得已填寫並送出");
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
