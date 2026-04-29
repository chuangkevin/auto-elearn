import { useEffect, useRef, useState } from "react";

/**
 * Fake Notepad shell shown when the app is locked.
 *
 * - Layout mimics Windows Notepad (title bar + menu bar + textarea).
 * - User types into the textarea normally. If their most recently-entered line
 *   (pressed Enter) matches the stored secret, we call `onUnlockAttempt(line)`
 *   which resolves to whether the unlock succeeded.
 * - "Hidden gesture" for first-time password setup: clicking 檔案 > 結束 five
 *   times within 15s opens a 設定密碼 dialog.
 */
interface Props {
  hasSecret: boolean;
  onUnlockAttempt: (secret: string) => Promise<boolean>;
  onSetSecret: (secret: string) => Promise<{ ok: boolean; reason?: string }>;
}

const MENU_BAR = [
  { label: "檔案(F)", items: ["新增(N)", "開啟舊檔(O)...", "儲存檔案(S)", "另存新檔(A)...", "分隔", "頁面設定(U)...", "列印(P)...", "分隔", "結束(X)"] },
  { label: "編輯(E)", items: ["復原(U)", "分隔", "剪下(T)", "複製(C)", "貼上(P)", "刪除(L)", "分隔", "尋找(F)...", "尋找下一個(N)", "取代(R)...", "移至(G)...", "分隔", "全選(A)", "時間/日期(D)"] },
  { label: "格式(O)", items: ["自動換行(W)", "字型(F)..."] },
  { label: "檢視(V)", items: ["狀態列(S)"] },
  { label: "說明(H)", items: ["檢視說明(H)", "分隔", "關於記事本(A)"] },
];

export default function Noteqad({ hasSecret, onUnlockAttempt, onSetSecret }: Props) {
  const [text, setText] = useState("");
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [exitClicks, setExitClicks] = useState(0);
  const exitClickTimestamps = useRef<number[]>([]);
  const [showSetupDialog, setShowSetupDialog] = useState(false);
  const [setupValue, setSetupValue] = useState("");
  const [setupConfirm, setSetupConfirm] = useState("");
  const [setupErr, setSetupErr] = useState<string | null>(null);
  const [wrongFlash, setWrongFlash] = useState(false);
  const [wrongCount, setWrongCount] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 右鍵 context menu 狀態：null = 沒打開；{x,y} = 在那個座標顯示。
  // 真正記事本的右鍵只有編輯指令 + 從右至左閱讀那些；我們在最後加一條
  //「版本 vX.Y.Z」當作藏在偽裝裡的 log 出口。
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [appVersion, setAppVersion] = useState<string>("");

  // Unlock = last line + Enter equals secret. We check on keydown rather than
  // polling, so the comparison happens at the moment the user presses Enter.
  async function onTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter") return;
    // IME: some input methods use Enter to confirm a composition. Skip those
    // — otherwise Chinese-typing users never unlock because their Enter was
    // "confirm composition" not "submit".
    const ne = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
    if (ne.isComposing || (e as unknown as { keyCode?: number }).keyCode === 229) {
      return;
    }
    if (!hasSecret) return;
    // Read from the DOM node instead of React state — in case the `text`
    // closure is stale (e.g. user typed fast and the re-render hasn't landed),
    // the textarea's .value is always the authoritative source.
    const raw = textareaRef.current?.value ?? text;
    const lines = raw.split(/\r?\n/);
    const last = (lines[lines.length - 1] ?? "").trim();
    if (!last) return;
    e.preventDefault();
    const ok = await onUnlockAttempt(last);
    if (!ok) {
      setWrongFlash(true);
      setWrongCount((n) => n + 1);
      setTimeout(() => setWrongFlash(false), 900);
      return;
    }
    // parent will re-render us away once unlocked
  }

  function handleMenuItem(menu: string, item: string) {
    setOpenMenu(null);

    // Hidden gesture: 檔案 > 結束 × 5 within 15s → open setup dialog.
    if (menu === "檔案(F)" && item === "結束(X)") {
      const now = Date.now();
      const stamps = exitClickTimestamps.current.filter((t) => now - t < 15000);
      stamps.push(now);
      exitClickTimestamps.current = stamps;
      const n = stamps.length;
      setExitClicks(n);
      if (n >= 5) {
        exitClickTimestamps.current = [];
        setExitClicks(0);
        setShowSetupDialog(true);
        return;
      }
      if (n >= 3) {
        // Graceful "app will close after N more clicks" simulated dialog? No — keep quiet.
      }
      return;
    }

    // Support a handful of useful items so the illusion sticks.
    if (menu === "檔案(F)" && item.startsWith("新增")) {
      setText("");
      return;
    }
    if (menu === "編輯(E)" && item === "全選(A)") {
      textareaRef.current?.select();
      return;
    }
    if (menu === "編輯(E)" && item === "時間/日期(D)") {
      const now = new Date();
      const stamp = `${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")} ${now.toLocaleDateString()}`;
      setText((t) => t + stamp);
      return;
    }
    if (menu === "說明(H)" && item.startsWith("關於")) {
      alert("記事本\n版本 23H2");
      return;
    }
    // other items intentionally no-op
  }

  async function submitSetup() {
    setSetupErr(null);
    if (!setupValue || setupValue !== setupConfirm) {
      setSetupErr("兩次輸入不一致");
      return;
    }
    const res = await onSetSecret(setupValue);
    if (!res.ok) {
      setSetupErr(res.reason ?? "儲存失敗");
      return;
    }
    setShowSetupDialog(false);
    setSetupValue("");
    setSetupConfirm("");
  }

  // Focus textarea on mount for quick Typed-Enter unlock UX
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Absolute path of config.json (for the setup dialog) — fetched once, lazy.
  const [configPath, setConfigPath] = useState<string>("");
  useEffect(() => {
    const api = (
      window as unknown as {
        api?: {
          stealthConfigPath?: () => Promise<string>;
          getAppVersion?: () => Promise<string>;
        };
      }
    ).api;
    api?.stealthConfigPath?.().then(setConfigPath).catch(() => void 0);
    api?.getAppVersion?.().then(setAppVersion).catch(() => void 0);
  }, []);

  // 右鍵 menu 開著的時候，按 Esc / 點外面要關掉。
  useEffect(() => {
    if (!contextMenu) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setContextMenu(null);
    }
    function onClick() {
      setContextMenu(null);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [contextMenu]);

  // 右鍵 menu 的「動作」清單。前段是真記事本會有的編輯指令，最後一條是
  // 我們塞進去的「版本 vX.Y.Z」— 點下去打開 log 資料夾，使用者可以直接把
  // 當天 .log 檔丟給開發者除錯。
  function ctxAction(action: "undo" | "cut" | "copy" | "paste" | "delete" | "selectAll" | "openLogs") {
    setContextMenu(null);
    const ta = textareaRef.current;
    switch (action) {
      case "undo":
        document.execCommand("undo");
        break;
      case "cut":
        document.execCommand("cut");
        break;
      case "copy":
        document.execCommand("copy");
        break;
      case "paste":
        document.execCommand("paste");
        break;
      case "delete": {
        if (!ta) return;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        if (start === end) return;
        const next = text.slice(0, start) + text.slice(end);
        setText(next);
        break;
      }
      case "selectAll":
        ta?.select();
        break;
      case "openLogs": {
        const api = (
          window as unknown as { api?: { openLogsFolder?: () => void } }
        ).api;
        api?.openLogsFolder?.();
        break;
      }
    }
  }

  return (
    // No fake title bar — the OS window already has one saying "未命名 - 記事本"
    // (mainWindow.title + page-title-updated prevent). Drawing our own would
    // stack two identical bars, which is the first thing a suspicious observer
    // would spot.
    <div className="h-screen flex flex-col bg-[#efefef] text-black font-sans select-none">
      {/* Menu bar */}
      <div className="h-6 bg-[#f5f5f5] border-b border-[#e5e5e5] flex items-center text-[12px] relative select-none">
        {MENU_BAR.map((m) => (
          <div
            key={m.label}
            className="relative"
            onMouseEnter={() => openMenu && setOpenMenu(m.label)}
          >
            <button
              className={`px-3 py-0.5 hover:bg-[#dcdcdc] ${openMenu === m.label ? "bg-[#dcdcdc]" : ""}`}
              onClick={() => setOpenMenu((cur) => (cur === m.label ? null : m.label))}
            >
              {m.label}
            </button>
            {openMenu === m.label && (
              <div
                className="absolute top-6 left-0 bg-white border border-[#bfbfbf] shadow-md min-w-[200px] py-1 z-20"
                onMouseLeave={() => setOpenMenu(null)}
              >
                {m.items.map((item, idx) =>
                  item === "分隔" ? (
                    <div key={idx} className="h-px bg-[#dcdcdc] my-1" />
                  ) : (
                    <button
                      key={idx}
                      className="block w-full text-left px-4 py-0.5 hover:bg-[#0b65c2] hover:text-white text-[12px]"
                      onClick={() => handleMenuItem(m.label, item)}
                    >
                      {item}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Textarea */}
      <textarea
        ref={textareaRef}
        className={`flex-1 w-full p-2 font-mono text-[13px] leading-tight outline-none resize-none transition-colors ${
          wrongFlash ? "bg-rose-100 border-2 border-rose-400" : "bg-white"
        }`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onTextareaKeyDown}
        onContextMenu={(e) => {
          // 攔截 Electron 預設的網頁 context menu（不擋的話會顯示「重新整理 / 檢查」
          // 那些一看就知道是 Chromium 的選項，破壞偽裝）。改顯示我們自己畫的記事本
          // 風格選單，最後一項放「版本 vX.Y.Z」當作藏在偽裝裡的 log 出口。
          e.preventDefault();
          // 不要讓全域 mousedown 監聽器立刻把剛打開的 menu 關掉
          e.stopPropagation();
          setContextMenu({ x: e.clientX, y: e.clientY });
        }}
        spellCheck={false}
        style={{ whiteSpace: "pre-wrap" }}
      />

      {/* 狀態列：用來在密碼錯時悄悄提示，但平時看起來就只是行/欄座標。 */}
      <div className="h-5 bg-[#f5f5f5] border-t border-[#e5e5e5] text-[11px] px-2 flex items-center text-[#666]">
        <span className={wrongFlash ? "text-rose-600 font-semibold" : ""}>
          {wrongFlash
            ? `密碼不對${wrongCount >= 3 ? "（忘記密碼？點上面「檔案 → 結束」連點 5 次可以重設）" : ""}`
            : `第 ${text.split("\n").length} 行，第 ${text.split("\n").slice(-1)[0].length + 1} 欄`}
        </span>
        <span className="ml-auto">100%</span>
        <span className="ml-4">Windows (CRLF)</span>
        <span className="ml-4">UTF-8</span>
      </div>

      {/* 右鍵 context menu — 真記事本風格的小 popup。最後一條「版本 vX.Y.Z」是
          藏在偽裝裡的 log 出口；點下去打開 userData/logs/ 資料夾。 */}
      {contextMenu && (
        <div
          className="fixed z-[90] min-w-[200px] bg-white border border-[#bfbfbf] shadow-md py-1 select-none"
          style={{
            // 防止 menu 跑出畫面右邊 / 下面（簡單夾一下）。
            left: Math.min(contextMenu.x, Math.max(0, window.innerWidth - 220)),
            top: Math.min(contextMenu.y, Math.max(0, window.innerHeight - 280)),
          }}
          // 自己內部的 mousedown 不要被全域 listener 收掉，不然點選項時 menu
          // 會在 ctxAction 跑之前就被關掉。
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <CtxItem label="復原(U)" onClick={() => ctxAction("undo")} />
          <CtxSep />
          <CtxItem label="剪下(T)" onClick={() => ctxAction("cut")} />
          <CtxItem label="複製(C)" onClick={() => ctxAction("copy")} />
          <CtxItem label="貼上(P)" onClick={() => ctxAction("paste")} />
          <CtxItem label="刪除(L)" onClick={() => ctxAction("delete")} />
          <CtxSep />
          <CtxItem label="全選(A)" onClick={() => ctxAction("selectAll")} />
          <CtxSep />
          <CtxItem
            label={`版本 ${appVersion ? `v${appVersion}` : "（讀取中…）"}`}
            onClick={() => ctxAction("openLogs")}
            title="點我打開記錄檔資料夾，可以把 .log 檔傳給開發者除錯"
          />
        </div>
      )}

      {/* Hidden-gesture setup / reset dialog */}
      {showSetupDialog && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50">
          <div className="bg-white border border-[#bfbfbf] shadow-lg w-[420px] p-4">
            <div className="text-sm font-semibold mb-2">
              {hasSecret ? "重新設定解鎖密碼" : "設定解鎖密碼"}
            </div>
            <div className="text-xs text-slate-600 mb-3 leading-relaxed">
              {hasSecret ? (
                <>
                  忘記密碼？直接在這裡蓋一組新的就好。<br />
                  （平常要解鎖：直接在下面的記事本文字區打密碼 + Enter）
                  <br />
                </>
              ) : (
                <>
                  設好後，下次打開時會看到這個記事本畫面。<br />
                  在文字區裡輸入這組密碼 + Enter 才會進到真正的程式。
                  <br />
                </>
              )}
              密碼存在這個檔案：
              <div className="mt-1 font-mono text-[11px] text-slate-700 bg-slate-100 border border-slate-300 rounded px-2 py-1 break-all select-all">
                {configPath || "(路徑載入中…)"}
              </div>
            </div>
            <input
              className="w-full px-2 py-1 border border-[#bfbfbf] text-sm mb-2"
              placeholder={hasSecret ? "輸入新密碼" : "輸入密碼"}
              type="password"
              value={setupValue}
              onChange={(e) => setSetupValue(e.target.value)}
              autoFocus
            />
            <input
              className="w-full px-2 py-1 border border-[#bfbfbf] text-sm mb-2"
              placeholder="再輸入一次"
              type="password"
              value={setupConfirm}
              onChange={(e) => setSetupConfirm(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitSetup()}
            />
            {setupErr && <div className="text-xs text-red-600 mb-2">{setupErr}</div>}
            <div className="flex justify-end gap-2">
              <button
                className="px-3 py-1 bg-[#e5e5e5] hover:bg-[#d5d5d5] border border-[#bfbfbf] text-sm"
                onClick={() => {
                  setShowSetupDialog(false);
                  setSetupValue("");
                  setSetupConfirm("");
                }}
              >
                取消
              </button>
              <button
                className="px-3 py-1 bg-[#0b65c2] hover:bg-[#0955a5] text-white text-sm"
                onClick={submitSetup}
              >
                {hasSecret ? "蓋掉舊的並解鎖" : "確定"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Debug hint — visible only when clicking 結束 repeatedly so first-time users know */}
      {exitClicks > 0 && exitClicks < 5 && (
        <div className="fixed right-2 bottom-6 text-[10px] text-slate-400 pointer-events-none">
          ({exitClicks}/5)
        </div>
      )}
    </div>
  );
}

function CtxItem({
  label,
  onClick,
  title,
}: {
  label: string;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      className="block w-full text-left px-4 py-0.5 hover:bg-[#0b65c2] hover:text-white text-[12px]"
      onClick={onClick}
      title={title}
    >
      {label}
    </button>
  );
}

function CtxSep() {
  return <div className="h-px bg-[#dcdcdc] my-1" />;
}
