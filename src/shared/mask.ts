/**
 * 隱碼工具 — 同時給 main process 和 renderer 用。
 *
 * 目的：登入後的「使用者名稱 / 帳號（身分證字號）」屬於敏感資訊，
 * 不能讓使用者旁邊的人從畫面或 log 看到完整內容。
 */

/**
 * 帳號隱碼：保留第 1 碼 + *** + 後 2 碼。
 * "F123456789" -> "F***89"
 * "ABC"        -> "A***" (太短時保留前 1 碼，後段留空)
 */
export function maskAccount(account: string | null | undefined): string {
  if (!account) return "";
  const a = String(account).trim();
  if (!a) return "";
  if (a.length <= 3) return `${a.charAt(0)}***`;
  return `${a.charAt(0)}***${a.slice(-2)}`;
}

/**
 * 使用者名稱隱碼：保留第 1 個字 + ***。
 * "王小明" -> "王***"
 * "Kevin"  -> "K***"
 */
export function maskName(name: string | null | undefined): string {
  if (!name) return "";
  const n = String(name).trim();
  if (!n) return "";
  // 取第一個字（中文一個字、英文一個字母）
  const first = Array.from(n)[0] ?? "";
  return `${first}***`;
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
