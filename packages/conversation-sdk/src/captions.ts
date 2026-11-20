/**
 * v0.8 continuous captions. Realtime partials restart at each turn; hosts keep
 * the recent final sentences and call captionTail to render one rolling caption
 * (glasses + phone) that flows across sentence boundaries. Pure, no protocol change.
 */

const clean = (value: unknown): string => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
const words = (value: string): string[] => value.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
const startsWith = (list: readonly string[], prefix: readonly string[]) => prefix.length <= list.length && prefix.every((word, i) => list[i] === word);
const endsWith = (list: readonly string[], suffix: readonly string[]) => suffix.length <= list.length && suffix.every((word, i) => list[list.length - suffix.length + i] === word);

/** CJK text joins without a space; everything else joins with one. */
function join(parts: readonly string[]): string {
  let out = "";
  for (const part of parts) {
    if (!out) { out = part; continue; }
    const before = Array.from(out).at(-1) ?? "", after = Array.from(part)[0] ?? "";
    out += CJK.test(before) && CJK.test(after) ? part : ` ${part}`;
  }
  return out;
}

/**
 * Joins the most recent final sentences and the live partial into one rolling
 * caption of at most `maxChars` code points. Older text is dropped from the
 * front (cut at a word boundary, prefixed with "…"). A partial that repeats the
 * last final is not shown twice; a cumulative partial that already contains the
 * last final replaces it.
 */
export function captionTail(finals: readonly string[], partial: string, maxChars: number): string {
  const max = Number.isFinite(maxChars) ? Math.floor(maxChars) : 0;
  if (max <= 0) return "";
  const source = Array.isArray(finals) ? finals : [];
  // Scan back only as far as needed to fill the window.
  const parts: string[] = [];
  let length = 0;
  for (let i = source.length - 1; i >= 0 && length <= max; i--) {
    const text = clean(source[i]);
    if (!text) continue;
    parts.unshift(text); length += Array.from(text).length + 1;
  }
  let live = clean(partial);
  const last = parts.at(-1);
  if (live && last) {
    const lw = words(live), fw = words(last);
    if (lw.length && fw.length) {
      const same = lw.length === fw.length && startsWith(fw, lw);
      if (same || (lw.length >= 2 && (endsWith(fw, lw) || startsWith(fw, lw)))) live = "";
      else if (lw.length > fw.length && startsWith(lw, fw)) parts.pop();
    }
  }
  if (live) parts.push(live);
  const text = join(parts);
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  if (max === 1) return "…";
  const cut = chars.length - (max - 1);
  let tail = chars.slice(cut).join("");
  // Cut inside a word: drop the fragment up to the next space when one is near.
  if (/[\p{L}\p{N}]/u.test(chars[cut - 1] ?? "") && /^[\p{L}\p{N}]/u.test(tail)) {
    const space = tail.indexOf(" ");
    if (space > 0 && space < Math.max(12, Math.floor(tail.length * 0.4))) tail = tail.slice(space + 1);
  }
  tail = tail.trimStart();
  return tail ? `…${tail}` : "…";
}
