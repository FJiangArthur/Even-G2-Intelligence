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

/** Appended to an answer the provider cut short, so both glasses layouts show where it stops. */
export const CUT_OFF_MARK = " … (cut off)";
/** Answers that may wait behind the one being read; an older waiting answer is dropped (the phone keeps all of them). */
export const MAX_WAITING_ANSWERS = 2;
/** A streaming answer that received no text for this long is treated as cut off, so it cannot hold the display forever. */
export const STREAM_STALL_MS = 20_000;

export interface PagedAnswer {
  readonly id?: string;
  readonly questionId?: string;
  readonly text: string;
  readonly streaming: boolean;
  /** The provider cut the answer short: the text ends with CUT_OFF_MARK once it stops streaming. */
  readonly partial?: boolean;
  /** Page geometry of this answer; defaults to the pager's layout. */
  readonly layout?: PageLayout;
}
interface WaitingAnswer { identity: string; revision?: number; answer: PagedAnswer }

/** Timers belong to the reading lifecycle, never to incoming transcript events.
 * Once a page has a successor its boundary is frozen, including while tokens
 * arrive, so later pagination cannot skip or repeat already displayed text.
 *
 * Back-to-back answers: a different answer that arrives while the first page of the
 * current one is still inside its reading time waits (see `waiting`) and takes over
 * when that time is up, or when the current answer ends or is dismissed. Clearing the
 * answer (`update(undefined)`, e.g. a manual ask) drops everything at once. */
export class AnswerPager {
  private identity?: string;
  private source = "";
  private pages: string[] = [];
  private index = 0;
  private streaming = true;
  private cut = false;
  private hidden = false;
  private disposed = false;
  private timer?: ReturnType<typeof setTimeout>;
  private timerKind?: "advance" | "hide";
  private revision?: number;
  private queue: WaitingAnswer[] = [];
  /** When the first page of the current answer appeared. */
  private shownAt = 0;
  private swapTimer?: ReturnType<typeof setTimeout>;
  private stallTimer?: ReturnType<typeof setTimeout>;

  public constructor(
    private readonly onChange: (text: string) => void,
    private layout: PageLayout = FULL_CANVAS_PAGE,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Default geometry for answers that carry no layout of their own. Pages already
   * shown keep their boundaries; takes effect for unfrozen text only.
   */
  public setLayout(layout: PageLayout): void { this.layout = layout; }

  public get text(): string { return this.hidden ? "" : this.pages[this.index] ?? ""; }
  public get pageIndex(): number { return this.index; }
  /** Pages known so far (grows while streaming); zero once hidden. */
  public get pageCount(): number { return this.hidden ? 0 : this.pages.length; }
  public get isStreaming(): boolean { return this.streaming; }
  /** "<id>:<revision>" of the answer on screen; undefined when nothing is shown. */
  public get key(): string | undefined { return this.text ? `${this.identity ?? "anonymous"}:${this.revision ?? 0}` : undefined; }
  /** Answers waiting behind the one on screen. */
  public get waiting(): number { return this.text ? this.queue.length : 0; }
  /** The answer on screen was cut short (provider cut-off, or its stream stalled). */
  public get isCutOff(): boolean { return this.cut && !this.streaming; }

  /** Manual reading control (glasses HUD swipe/tap). Restarts the reading
   * timer for the new page. Returns false at a boundary or when hidden. */
  public next(): boolean { return this.go(this.index + 1); }
  public previous(): boolean { return this.go(this.index - 1); }
  /** Hide the current answer now; like expiry, it never revives. A waiting answer takes its place. */
  public dismiss(): void {
    if (this.disposed || this.hidden || !this.pages.length) return;
    this.cancelTimer();
    if (this.promote()) return;
    this.hidden = true;
    this.onChange("");
  }
  private go(index: number): boolean {
    if (this.disposed || this.hidden || index < 0 || index >= this.pages.length) return false;
    this.cancelTimer();
    // The wearer is reading this answer: a waiting one no longer cuts in, it follows when this one ends.
    this.cancelSwap();
    this.index = index;
    this.onChange(this.text);
    this.schedule();
    return true;
  }

  public update(answer?: PagedAnswer, revision?: number): void {
    if (this.disposed) return;
    if (!answer) {
      this.clear();
      this.identity = undefined;
      this.revision = revision;
      this.onChange("");
      return;
    }
    const identity = answer.id ?? answer.questionId ?? "anonymous";
    if (identity !== this.identity || revision !== this.revision) {
      const waiting = this.queue.find(item => item.identity === identity && item.revision === revision);
      if (waiting) { waiting.answer = answer; return; }
      if (this.text && (this.queue.length || this.dwellLeft() > 0)) {
        // The answer on screen gets no more text once another one has started.
        if (this.streaming) { this.streaming = false; this.cancelStall(); this.schedule(); }
        this.queue = [...this.queue, { identity, revision, answer }].slice(-MAX_WAITING_ANSWERS);
        this.scheduleSwap();
        this.onChange(this.text);
        return;
      }
      this.clear();
      this.identity = identity;
      this.revision = revision;
    }
    this.show(answer);
  }

  private show(answer: PagedAnswer): void {
    // Providers commonly trim the final response after streaming whitespace.
    // That completion must not restart a reader already on a later page.
    const raw = answer.text.trimStart();
    const text = answer.partial && !answer.streaming && raw.trim() ? `${raw.trimEnd()}${CUT_OFF_MARK}` : raw;
    const trimmedCompletion = !answer.streaming && this.source.startsWith(text)
      && this.source.slice(text.length).trim() === "";
    if (!text.startsWith(this.source) && !trimmedCompletion) {
      // The same answer restarted with different text.
      const queue = this.queue;
      this.clear();
      this.queue = queue;
    }
    if (this.hidden) return; // A retained completed answer must never revive.
    const frozen = this.pages.slice(0, Math.max(0, this.pages.length - 1));
    const offset = frozen.reduce((sum, page) => sum + page.length, 0);
    const first = !this.pages.length;
    this.pages = [...frozen, ...paginateAnswer(text.slice(offset), answer.layout ?? this.layout)];
    if (first && this.pages.length) this.shownAt = this.now();
    const grew = text !== this.source;
    this.source = text;
    this.streaming = answer.streaming;
    this.cut = answer.partial === true;
    if (!answer.streaming) this.cancelStall();
    else if (grew || this.stallTimer === undefined) this.armStall();
    this.onChange(this.text);
    this.schedule();
    if (this.queue.length) this.scheduleSwap();
  }

  /** Reading time still owed to the first page of the answer on screen. */
  private dwellLeft(): number {
    if (this.index !== 0 || !this.text) return 0;
    const visibleCharacters = [...segmenter.segment(this.text.trim())].length;
    return Math.max(0, this.shownAt + pageReadingMs(visibleCharacters) - this.now());
  }

  /** The next waiting answer takes the display. */
  private promote(): boolean {
    const next = this.queue.shift();
    if (!next) return false;
    const queue = this.queue;
    this.clear();
    this.queue = queue;
    this.identity = next.identity;
    this.revision = next.revision;
    this.show(next.answer);
    return true;
  }

  private scheduleSwap(): void {
    if (this.swapTimer !== undefined || !this.queue.length || this.index !== 0) return;
    this.swapTimer = setTimeout(() => {
      this.swapTimer = undefined;
      if (this.disposed || !this.queue.length) return;
      this.cancelTimer();
      this.promote();
    }, this.dwellLeft());
  }
  private cancelSwap(): void {
    if (this.swapTimer !== undefined) clearTimeout(this.swapTimer);
    this.swapTimer = undefined;
  }

  private armStall(): void {
    this.cancelStall();
    this.stallTimer = setTimeout(() => {
      this.stallTimer = undefined;
      if (this.disposed || this.hidden || !this.streaming) return;
      this.streaming = false;
      this.cut = true;
      this.onChange(this.text);
      this.schedule();
    }, STREAM_STALL_MS);
  }
  private cancelStall(): void {
    if (this.stallTimer !== undefined) clearTimeout(this.stallTimer);
    this.stallTimer = undefined;
  }

  /** Forgets the answer on screen and every waiting one. */
  private clear(): void {
    this.cancelTimer();
    this.cancelSwap();
    this.cancelStall();
    this.queue = [];
    this.pages = [];
    this.index = 0;
    this.hidden = false;
    this.source = "";
    this.cut = false;
    this.streaming = true;
    this.shownAt = 0;
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
      else if (this.promote()) return;
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
    this.clear();
    this.hidden = true;
    this.disposed = true;
    this.onChange("");
  }
}
