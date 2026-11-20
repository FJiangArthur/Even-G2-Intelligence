/** Native 576×288 display: a 568×280 text area, about ten 28px lines.
 * Widths are calibrated against the official simulator's proportional font.
 * Leave horizontal headroom for font variation; the bridge wraps each page.
 * Device font acceptance remains a separate physical-glasses check. */
const LINE_WIDTH = 550;
const PAGE_LINES = 10;
const PAGE_BYTES = 950; // Startup-compatible ceiling, including complex emoji.
const encoder = new TextEncoder();
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function defaultGlyphWidth(glyph: string): number {
  if (/^\s$/u.test(glyph)) return 5;
  if (/^[ilI.,!:'|]$/u.test(glyph)) return 5;
  if (/^[mwMW@#%]$/u.test(glyph)) return 14;
  if (/^[A-Z]$/u.test(glyph)) return 11;
  if (/^[\x20-\x7e]/u.test(glyph)) return 9.5;
  return 20.5;
}

/** Page geometry. The default is the full-canvas answers-only page; the glasses
 * HUD passes its smaller body region and its simulator-calibrated glyph widths. */
export interface PageLayout {
  /** Usable width of one line in canvas pixels. */
  readonly lineWidth: number;
  /** Lines per page. */
  readonly lines: number;
  /** UTF-8 ceiling per page. */
  readonly bytes?: number;
  /** Width of one grapheme cluster; defaults to the full-canvas heuristic. */
  readonly measure?: (glyph: string) => number;
}
export const FULL_CANVAS_PAGE: PageLayout = Object.freeze({ lineWidth: LINE_WIDTH, lines: PAGE_LINES, bytes: PAGE_BYTES });

/** No inserted newlines, truncation or normalization: concatenating pages
 * reproduces the answer exactly, including Unicode clusters and whitespace. */
export function paginateAnswer(text: string, layout: PageLayout = FULL_CANVAS_PAGE): string[] {
  if (!text) return [];
  const lineWidth = layout.lineWidth, pageLines = layout.lines, pageBytes = layout.bytes ?? PAGE_BYTES;
  const glyphWidth = layout.measure ?? defaultGlyphWidth;
  const glyphs = [...segmenter.segment(text)].map(item => item.segment);
  const pages: string[] = [];
  let start = 0;
  while (start < glyphs.length) {
    let cursor = start;
    let bytes = 0;
    let byteLimit = false;
    for (let line = 0; line < pageLines && cursor < glyphs.length; line += 1) {
      const lineStart = cursor;
      let width = 0;
      let lastBreak = -1;
      while (cursor < glyphs.length) {
        const glyph = glyphs[cursor]!;
        const glyphBytes = encoder.encode(glyph).length;
        if (bytes + glyphBytes > pageBytes && cursor > start) { byteLimit = true; break; }
        bytes += glyphBytes;
        if (glyph.includes("\n")) { cursor += 1; break; }
        const nextWidth = glyphWidth(glyph);
        if (width + nextWidth > lineWidth) {
          if (lastBreak > lineStart) {
            for (let index = lastBreak; index < cursor; index += 1) bytes -= encoder.encode(glyphs[index]!).length;
            cursor = lastBreak;
          }
          bytes -= glyphBytes;
          break;
        }
        width += nextWidth;
        cursor += 1;
        if (/\s/u.test(glyph)) lastBreak = cursor;
      }
      if (byteLimit) break;
    }
    pages.push(glyphs.slice(start, cursor).join(""));
    start = cursor;
  }
  return pages;
}

export function pageReadingMs(visibleCharacters: number): number {
  return Math.min(10000, Math.max(3000, visibleCharacters * 45));
}

export interface PagedAnswer {
  readonly id?: string;
  readonly questionId?: string;
  readonly text: string;
  readonly streaming: boolean;
}

/** Timers belong to the reading lifecycle, never to incoming transcript events.
 * Once a page has a successor its boundary is frozen, including while tokens
 * arrive, so later pagination cannot skip or repeat already displayed text. */
export class AnswerPager {
  private identity?: string;
  private source = "";
  private pages: string[] = [];
  private index = 0;
  private streaming = true;
  private hidden = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private timerKind?: "advance" | "hide";
  private revision?: number;

  public constructor(
    private readonly onChange: (text: string) => void,
    private layout: PageLayout = FULL_CANVAS_PAGE,
  ) {}

  /**
   * Geometry for the next answer. Pages already shown keep their boundaries; the
   * glasses HUD sets it before each update (e.g. one line less when it shows the
   * question above a "THEY ASKED" answer). Takes effect for unfrozen text only.
   */
  public setLayout(layout: PageLayout): void { this.layout = layout; }

  public get text(): string { return this.hidden ? "" : this.pages[this.index] ?? ""; }
  public get pageIndex(): number { return this.index; }
  /** Pages known so far (grows while streaming); zero once hidden. */
  public get pageCount(): number { return this.hidden ? 0 : this.pages.length; }
  public get isStreaming(): boolean { return this.streaming; }

  /** Manual reading control (glasses HUD swipe/tap). Restarts the reading
   * timer for the new page. Returns false at a boundary or when hidden. */
  public next(): boolean { return this.go(this.index + 1); }
  public previous(): boolean { return this.go(this.index - 1); }
  /** Hide the current answer now; like expiry, it never revives. */
  public dismiss(): void {
    if (this.disposed || this.hidden || !this.pages.length) return;
    this.cancelTimer();
    this.hidden = true;
    this.onChange("");
  }
  private go(index: number): boolean {
    if (this.disposed || this.hidden || index < 0 || index >= this.pages.length) return false;
    this.cancelTimer();
    this.index = index;
    this.onChange(this.text);
    this.schedule();
    return true;
  }

  public update(answer?: PagedAnswer, revision?: number): void {
    if (this.disposed) return;
    const identity = answer?.id ?? answer?.questionId ?? "anonymous";
    // Providers commonly trim the final response after streaming whitespace.
    // That completion must not restart a reader already on a later page.
    const text = answer?.text.trimStart() ?? "";
    const trimmedCompletion = !answer?.streaming && this.source.startsWith(text)
      && this.source.slice(text.length).trim() === "";
    const replacement = revision !== this.revision || identity !== this.identity
      || (answer !== undefined && !text.startsWith(this.source) && !trimmedCompletion);
    if (!answer || replacement) {
      this.cancelTimer();
      this.pages = [];
      this.index = 0;
      this.hidden = false;
      this.source = "";
      this.identity = answer ? identity : undefined;
      this.revision = revision;
    }
    if (!answer) { this.onChange(""); return; }
    if (this.hidden) return; // A retained completed answer must never revive.
    const frozen = this.pages.slice(0, Math.max(0, this.pages.length - 1));
    const offset = frozen.reduce((sum, page) => sum + page.length, 0);
    this.pages = [...frozen, ...paginateAnswer(text.slice(offset), this.layout)];
    this.source = text;
    this.streaming = answer.streaming;
    this.onChange(this.text);
    this.schedule();
  }

  private schedule(): void {
    const hasNext = this.index + 1 < this.pages.length;
    const kind = hasNext ? "advance" : !this.streaming && this.text ? "hide" : undefined;
    if (kind === this.timerKind) return;
    this.cancelTimer();
    if (!kind) return;
    this.timerKind = kind;
    const visibleCharacters = [...segmenter.segment(this.text.trim())].length;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.timerKind = undefined;
      if (kind === "advance") this.index += 1;
      else this.hidden = true;
      this.onChange(this.text);
      if (!this.hidden) this.schedule();
    }, kind === "advance" ? pageReadingMs(visibleCharacters) : 8000);
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.timerKind = undefined;
  }

  public dispose(): void {
    this.cancelTimer();
    this.hidden = true;
    this.disposed = true;
    this.onChange("");
  }
}
