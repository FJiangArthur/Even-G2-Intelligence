import { DirectProviderError } from "./direct-providers.js";
import type { ContextScope } from "./types.js";

/** Raw session speech, independent of assistant history and presentation feeds. */
export class TranscriptContext {
  private text = "";
  append(text: string): void {
    if (!text.trim()) return;
    const next = [this.text, text.trim()].filter(Boolean).join("\n");
    if (new TextEncoder().encode(next).length > 96_000) {
      throw new DirectProviderError("context-limit", "context-limit: Session transcript reached 96,000 UTF-8 bytes. Start a new session.");
    }
    this.text = next;
  }
  private sentences(): string[] { return this.text.match(/[^.!?。！？]+[.!?。！？]*/gu)?.map(s => s.trim()).filter(Boolean) ?? []; }
  local(): string { return this.sentences().slice(-6).join("\n"); }
  global(): string { return this.text; }
  background(scope: ContextScope): string {
    const sentences = this.sentences(), earlier = sentences.slice(0, -6);
    if (scope === "global") return earlier.join("\n");
    const terms = new Set(this.local().toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
    return earlier.filter(s => (s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).some(t => terms.has(t))).join("\n");
  }
}
