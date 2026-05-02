/**
 * 隱碼工具 — 同時給 main process 和 renderer 用。
 *
 * 目的：登入後的「使用者名稱 / 帳號（身分證字號）」屬於敏感資訊，
 * 不能讓使用者旁邊的人從畫面或 log 看到完整內容。
 */

/**
 * 帳號隱碼：保留第 1 碼 + *** + 後 1 碼（v0.7.10 起更短）。
 * "F123456789" -> "F***9"
 * "ABC"        -> "A***" (太短時保留前 1 碼，後段留空)
 *
 * 為什麼縮短：之前 "F***89" 還會洩漏身分證末 2 碼，使用者旁邊的人對得起來；
 * 改成只留末 1 碼資訊量更低，仍夠使用者自己辨識「對，是我這個帳號」。
 */
export function maskAccount(account: string | null | undefined): string {
  if (!account) return "";
  const a = String(account).trim();
  if (!a) return "";
  if (a.length <= 2) return `${a.charAt(0)}***`;
  return `${a.charAt(0)}***${a.slice(-1)}`;
}

/**
 * 使用者名稱隱碼：完全不顯示任何字（v0.7.10 起更嚴）。
 * "王小明" -> "***"
 * "Kevin"  -> "***"
 *
 * 為什麼整個遮：之前 "王***" 仍會洩漏姓氏，公務體系內部認得姓氏 + 機關就猜得出人；
 * 改成完全的 "***"，只保留「有東西在這」的視覺指示。但 maskSecretsInString 仍能
 * 用「真名 → ***」做 log 替換，不影響 log 隱碼。
 */
export function maskName(name: string | null | undefined): string {
  if (!name) return "";
  const n = String(name).trim();
  if (!n) return "";
  return "***";
}

/**
 * 把字串裡所有出現的「敏感詞」全部換成隱碼版本。
 * 用在送進 log 列表前，確保 log 文字也不洩漏。
 *
 * 注意：避免空字串造成 infinite replace；長度短於 2 的詞略過（容易誤傷）。
 */
export function maskSecretsInString(
  text: string,
  secrets: Array<{ value: string; masked: string }>,
): string {
  if (!text) return text;
  let out = text;
  for (const { value, masked } of secrets) {
    if (!value || value.length < 2) continue;
    if (value === masked) continue;
    // 用 split/join 避免 regex 特殊字元問題（人名可能含空白、英文姓名含 .）
    if (out.includes(value)) {
      out = out.split(value).join(masked);
    }
  }
  return out;
}
