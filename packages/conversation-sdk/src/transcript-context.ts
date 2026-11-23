import type { ContextScope } from "./types.js";

/** Rolling window of session speech (UTF-8 bytes). The archive keeps the whole session. */
const MAX_TRANSCRIPT_BYTES = 96_000;
const encoder = new TextEncoder();

/** Raw session speech, independent of assistant history and presentation feeds. */
export class TranscriptContext {
  private lines: { text: string; bytes: number }[] = [];
  /** Bytes of the joined text, newlines included. */
  private bytes = 0;
  private text = "";
  private split?: string[];
  private rolled = false;
  /** True once speech has rolled off: the window no longer holds the whole session. */
  get truncated(): boolean { return this.rolled; }
  /** Never throws: when the window is full the oldest lines roll off. */
  append(text: string): void {
    let line = text.trim();
    if (!line) return;
    let size = encoder.encode(line).length;
    if (size > MAX_TRANSCRIPT_BYTES) {
      // One line larger than the whole window: keep its tail, without a split character.
      line = new TextDecoder().decode(encoder.encode(line).subarray(size - MAX_TRANSCRIPT_BYTES)).replace(/^�+/u, "").trim();
      size = encoder.encode(line).length;
      this.rolled = true;
    }
    this.lines.push({ text: line, bytes: size });
    this.bytes += size + (this.lines.length > 1 ? 1 : 0);
    let dropped = 0;
    while (this.bytes > MAX_TRANSCRIPT_BYTES && this.lines.length - dropped > 1) this.bytes -= this.lines[dropped++]!.bytes + 1;
    if (dropped) this.rolled = true;
    if (dropped) { this.lines.splice(0, dropped); this.text = this.lines.map(item => item.text).join("\n"); }
    else this.text = this.text ? `${this.text}\n${line}` : line;
    this.split = undefined;
  }
  /** Split once per appended line, shared by local() and background(). */
  private sentences(): string[] { return this.split ??= this.text.match(/[^.!?。！？]+[.!?。！？]*/gu)?.map(s => s.trim()).filter(Boolean) ?? []; }
  local(): string { return this.sentences().slice(-6).join("\n"); }
  global(): string { return this.text; }
  /** Sentences before the recent focus. `maxChars` keeps only the newest whole sentences that fit. */
  background(scope: ContextScope, maxChars?: number): string { return this.backgroundWindow(scope, maxChars).text; }
  /** background() plus `cut`: whether `maxChars` left earlier sentences out. */
  backgroundWindow(scope: ContextScope, maxChars?: number): { text: string; cut: boolean } {
    const sentences = this.sentences();
    let earlier = sentences.slice(0, -6);
    if (scope !== "global") {
      const terms = new Set(sentences.slice(-6).join("\n").toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
      earlier = earlier.filter(s => (s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).some(t => terms.has(t)));
    }
    if (maxChars === undefined) return { text: earlier.join("\n"), cut: false };
    let start = earlier.length, used = 0;
    while (start > 0) {
      const next = earlier[start - 1]!.length + (start < earlier.length ? 1 : 0);
      if (used + next > maxChars) break;
      used += next; start--;
    }
    // A single unpunctuated run longer than the cap: keep its tail.
    if (start === earlier.length && earlier.length) return { text: earlier[earlier.length - 1]!.slice(-Math.max(0, maxChars)), cut: true };
    return { text: earlier.slice(start).join("\n"), cut: start > 0 };
  }
}
