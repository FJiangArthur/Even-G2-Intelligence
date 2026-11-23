/**
 * Glasses HUD: the primary interaction surface on Even Realities G2.
 *
 * v0.10 "vibrant" layout on the 576×288 canvas (4-bit green, black = off):
 *   MASCOT  image  (0,0 40×36)     Hex the owl-bot: idle / listening / thinking / speaking / error
 *   HEADER  text   (y 2..36,  brightness 4)  view title, e.g. "◆ ANSWER 1/2"
 *   STATUS  text   (y 2..36,  brightness 2)  right-aligned status, e.g. "● 3m · TECH"
 *   BADGE   image  (536,0 40×36)   pixel icon of the conversation mode
 *   BODY    text   (y 38..232, brightness 4, rounded border) the active view; the only event-capture container
 *   SPLASH  image  (144,44 288×128) pixel-art wordmark while not connected (blank otherwise)
 *   CAPTION text   (y 234..288, brightness 3) continuous live caption (rolling two-line tail)
 * Images are sent only when their content changes (state, mode, splash), never animated.
 *
 * Views, in ring order: LIVE, ANSWER, ASK THEM (qa), CONCEPTS, CLAIMS, SUMMARY, CHECKS.
 * Swipe down reads forward (next page/item, then the next view); swipe up reads backward.
 * The BODY is hard-wrapped and never overflows: on G2 an overflowing capture
 * container scrolls natively and swallows the swipe events (simulator-verified).
 *
 * v0.8 MENU: double press swaps the BODY for a firmware-scrolled native LIST container
 * (rebuildPageContainer; header + caption keep their ids so they keep updating). The
 * firmware moves the highlight on swipes without telling the app; a click reports
 * listEvent.currentSelectItemIndex (omitted for index 0). Double press closes it.
 *
 * Glyph widths and the 27 px line pitch were measured on the official
 * evenhub-simulator 0.9.5 font. Physical-glasses font acceptance is separate.
 *
 * AMBIENT display (default; "always-on" keeps everything above on screen all the time): during a
 * session the glasses are blank. An answer (THEY ASKED / ANSWER / ANSWER KEY, "Thinking…") or a
 * cue of the current mode (concept, lookup, conflict, fact verdict, the top suggested question) pops up
 * in the same title + BODY style, pages by itself and disappears. Double-tap (the menu gesture) wakes the full HUD with
 * the MENU open; double-tap on the menu, or AMBIENT_IDLE_MS without a gesture, blanks it again.
 * The blank page is its own page (no frame border, no images) whose BODY still captures events.
 */
import { recordDiagnostic } from "./diagnostics";
import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import * as conversationSdk from "@helix/conversation-sdk";
import { MODE_PROFILES, PICKER_MODES, modeProfile, todoShort } from "@helix/conversation-sdk";
import type { CopilotClaim, CopilotConcept, CopilotSuggestion, HudMirror, VerificationResult } from "@helix/conversation-sdk";
import { AnswerPager, pageReadingMs, paginateAnswer, type PageLayout } from "./answer-pager";
import { blankImage, centeredImage, drawBitmap, encodeGrayPng, type GrayImage } from "./glasses-image";
import { ICONS, MASCOT_FRAMES, modeIcon, textBitmap, type MascotState } from "./pixel-art";
import { BridgeTimeoutError, PAGE_WRITE_DEADLINE_MS, TEXT_LATE_ANSWER_MS, TEXT_WRITE_DEADLINE_MS, withDeadline, writeTimeoutBackoff } from "./glasses-renderer";
import type { GlassesConversationState, GlassesRenderBridge } from "./glasses-renderer";
import { FEED_LIMIT } from "./presentation";
import type { FeedItem, PresentationSnapshot } from "./presentation";
import { SHORTCUT_ACTIONS } from "./shortcut-actions";

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** "hud" is the default glasses UI; "answers-only" keeps the v0.5 GlassesRenderer. */
export type GlassesLayout = "hud" | "answers-only";
export const DEFAULT_GLASSES_LAYOUT: GlassesLayout = "hud";
export function resolveGlassesLayout(value?: string | null): GlassesLayout {
  return value === "answers-only" ? "answers-only" : DEFAULT_GLASSES_LAYOUT;
}

/**
 * "ambient" (default): blank during a session; answers and cues pop up and disappear, the full
 * HUD shows only after the menu gesture. "always-on": the full HUD is always on screen.
 */
export type GlassesDisplay = "ambient" | "always-on";
export const DEFAULT_GLASSES_DISPLAY: GlassesDisplay = "ambient";
export function resolveGlassesDisplay(value?: string | null): GlassesDisplay {
  return value === "always-on" ? "always-on" : DEFAULT_GLASSES_DISPLAY;
}
/** Ambient display: the woken HUD blanks again this long after the last gesture. */
export const AMBIENT_IDLE_MS = 20_000;

export type HudView = "live" | "answer" | "qa" | "concepts" | "claims" | "summary" | "checks";
export const HUD_VIEWS: readonly HudView[] = Object.freeze(["live", "answer", "qa", "concepts", "claims", "summary", "checks"]);
export type HudGesture = "up" | "down" | "click" | "double";

/** What the controller must do after a gesture. `handled` = consumed by the HUD. */
export type HudCommand =
  | { readonly type: "ask"; readonly text: string }
  | { readonly type: "askLocal" }
  | { readonly type: "askGlobal" }
  /** Verify a claim/concept; the result arrives as a VerificationResult with the same id. */
  | { readonly type: "verify"; readonly target: string; readonly id: string; readonly kind: "claim" | "concept" }
  | { readonly type: "togglePause" }
  /** Tap on the "session paused while Helix was in the background" prompt. */
  | { readonly type: "resume" }
  /** v0.10: a mode chosen in the glasses menu (modeProfile id). */
  | { readonly type: "mode"; readonly mode: string }
  /** v0.11 glasses menu: end the session / connect with the keys saved on the phone. */
  | { readonly type: "stop" }
  | { readonly type: "connect" }
  | { readonly type: "handled" };

/** What the controller drives. GlassesRenderer satisfies it structurally. */
export interface GlassesSurface {
  initialize(): Promise<void>;
  render(glasses: GlassesConversationState, snapshot?: PresentationSnapshot): void;
  flush(): Promise<void>;
  dispose(): void;
  /** Undefined result = not handled; the controller falls back to its default. */
  handleGesture?(gesture: HudGesture): HudCommand | undefined;
  /** Click on the native MENU list (listEvent). Undefined = no menu is open. */
  selectListItem?(index: number, name?: string): HudCommand | undefined;
  /** Lifecycle: redraw the whole page (after WebView suspension / foreground return). */
  repush?(): Promise<boolean>;
  /** Phone -> glasses: show this view (closes the menu). */
  setView?(view: HudView): void;
  /** Epoch ms of the last page rebuild this surface made itself (0 = never). */
  readonly lastRebuildAt?: number;
  /** v0.8 glasses -> phone mirror listener (in addition to GlassesHudOptions.onMirror). */
  setMirrorListener?(listener?: (mirror: HudMirror) => void): void;
}

export interface GlassesHudOptions {
  /** Minimum interval between writes to one container. Clamped to >= 120 ms. */
  readonly debounceMs?: number;
  /** Minimum interval between caption writes. Default 1000 ms (v0.12.1; was 500): about one BLE write a second while people talk. */
  readonly captionIntervalMs?: number;
  /** Header clock / caption-expiry tick. 0 disables. Default 5000 ms (minute clock; saves battery). */
  readonly tickMs?: number;
  /** Transcript stays in the caption this long after the last speech before hints return. */
  readonly captionHoldMs?: number;
  /** Bridge failures (the display is unusable). */
  readonly onError?: (error: Error) => void;
  /** Internal formatting failures; never thrown from render(). Default console.warn. */
  readonly onRenderError?: (error: unknown) => void;
  /** v0.8 glasses -> phone mirror; called (asynchronously) whenever what the glasses show changes. */
  readonly onMirror?: (mirror: HudMirror) => void;
  readonly now?: () => number;
  /** v0.10 pixel-art images (mascot, mode badge, splash). Default on when the bridge can send images. */
  readonly images?: boolean;
  /** Minimum interval between two mascot image updates (default 8000 ms). */
  readonly mascotIntervalMs?: number;
  /** Pause after every glasses write before the next one (default WRITE_GAP_MS; 3x, at least 300 ms, after a page rebuild). */
  readonly writeGapMs?: number;
  /** Mascot follows each answer (thinking / speaking). Default false: images change only on a switch. */
  readonly mascotAnimation?: boolean;
  /** Setup → Answer length ("brief" | "standard" | "detailed"); "detailed" lets an ambient cue use more pages. */
  readonly answerLength?: string;
  /** Ambient (default) or always-on display; see GlassesDisplay. */
  readonly display?: GlassesDisplay;
  /** Ambient display: idle time after which the woken HUD blanks again. Default AMBIENT_IDLE_MS; at least 1000 ms. */
  readonly ambientIdleMs?: number;
}

/**
 * `header` is the whole header line as the phone mirror shows it ("LIVE · ● 3m · TECH");
 * `title` and `status` are what the two header containers show.
 */
export interface HudFrame {
  readonly header: string; readonly title: string; readonly status: string; readonly body: string; readonly caption: string;
  /** v0.11 right side of the BODY box: current mode (bright) and the view list with unseen counts. */
  readonly mode: string; readonly views: string;
}

/** Gesture map, for phone help text and docs. Ring and temple share these gestures. */
export const GESTURE_MAP: readonly { readonly gesture: string; readonly action: string }[] = Object.freeze([
  { gesture: "Tap", action: "context action: next answer page, ask the highlighted question, verify the highlighted claim or concept" },
  { gesture: "Double-tap", action: "open / close the glasses menu (answer the whole conversation, verify, jump to a view, pause); with the ambient display it wakes the HUD, and on the menu it hides the HUD again" },
  { gesture: "Hold", action: "push to talk; release to send" },
  { gesture: "Swipe ↑ / ↓", action: "previous / next view or page; in the menu: move the highlight" },
]);
/** One-line gesture help for the phone (Setup → G2 controls). */
export const GESTURE_HELP = "Tap: context action (next page · ask highlighted · verify) · Double-tap: glasses menu (whole-conversation answer, verify, views, pause) · Hold: talk, release to send · Swipe ↑↓: views, or the menu highlight";

/** Glasses menu actions, in list order. Labels are <= 64 chars (native list limit). */
export type HudMenuAction = "answer-local" | "answer-global" | "verify-claim" | "ask-them" | "concepts" | "claims"
  | "summary" | "checks" | "live" | "pause" | "close" | "mode" | `mode:${string}` | "stop" | "connect";
export interface HudMenuItem { readonly action: HudMenuAction; readonly label: string }
/** v0.11: the menu lives in the right side of the BODY box (~140 px), so labels are short. */
export const HUD_MENU_ITEMS: readonly HudMenuItem[] = Object.freeze([
  { action: "answer-local", label: "Answer" },
  { action: "answer-global", label: "Answer all" },
  { action: "verify-claim", label: "Verify" },
  { action: "ask-them", label: "Ask them" },
  { action: "concepts", label: "Concepts" },
  { action: "claims", label: "Claims" },
  { action: "summary", label: "Summary" },
  { action: "checks", label: "Checks" },
  { action: "live", label: "Live" },
  { action: "mode", label: "Mode ▶" },
  { action: "pause", label: "Pause" },
  { action: "stop", label: "Stop" },
  { action: "close", label: "Close" },
] as HudMenuItem[]);
/** Menu while not connected. */
const HUD_IDLE_MENU: readonly HudMenuItem[] = Object.freeze([
  { action: "connect", label: "Connect" }, { action: "mode", label: "Mode ▶" }, { action: "close", label: "Close" },
] as HudMenuItem[]);

/** Phone tab that shows the same content as a HUD view (phone follows the glasses). */
export function tabForHudView(view: string): "answers" | "qa" | "concepts" | "summary" | "checks" {
  switch (view) {
    case "qa": return "qa";
    case "concepts": return "concepts";
    case "summary": return "summary";
    case "claims": case "checks": return "checks";
    default: return "answers";
  }
}
/** HUD view for a phone tab (glasses follow the phone); undefined = tab has no glasses view. */
export function hudViewForTab(tab: string): HudView | undefined {
  switch (tab) {
    case "answers": return "live";
    case "qa": return "qa";
    case "concepts": return "concepts";
    case "summary": return "summary";
    case "checks": return "checks";
    default: return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* Geometry and text fitting                                           */
/* ------------------------------------------------------------------ */

export const HUD_LINE_HEIGHT = 27;
const HEADROOM = 12;
/** v0.11: one big BODY box (FRAME); inside it the view text on the left and the rail (mode + views) on the right. */
export const HUD_RAIL_WIDTH = 142;
export const HUD_FRAME = Object.freeze({ containerID: 9, containerName: "hud-frame", xPosition: 0, yPosition: 38, width: 576, height: 194,
  borderWidth: 2, borderColor: 9, borderRadius: 8, paddingLength: 0, textColor: 4, isEventCapture: 0 });
const RAIL_X = 576 - HUD_RAIL_WIDTH - 6;
export const HUD_PANELS = Object.freeze({
  header: Object.freeze({ containerID: 1, containerName: "hud-header", xPosition: 44, yPosition: 2, width: 222, height: 34,
    borderWidth: 0, borderColor: 0, borderRadius: 0, paddingLength: 0, textColor: 4, isEventCapture: 0, lines: 1 }),
  status: Object.freeze({ containerID: 5, containerName: "hud-status", xPosition: 268, yPosition: 2, width: 264, height: 34,
    borderWidth: 0, borderColor: 0, borderRadius: 0, paddingLength: 0, textColor: 2, isEventCapture: 0, lines: 1 }),
  body: Object.freeze({ containerID: 2, containerName: "hud-body", xPosition: 8, yPosition: 40, width: RAIL_X - 8, height: 190,
    borderWidth: 0, borderColor: 0, borderRadius: 0, paddingLength: 0, textColor: 4, isEventCapture: 1, lines: 6 }),
  caption: Object.freeze({ containerID: 3, containerName: "hud-caption", xPosition: 6, yPosition: 234, width: 564, height: 54,
    borderWidth: 0, borderColor: 0, borderRadius: 0, paddingLength: 0, textColor: 3, isEventCapture: 0, lines: 2 }),
  mode: Object.freeze({ containerID: 6, containerName: "hud-mode", xPosition: RAIL_X, yPosition: 39, width: HUD_RAIL_WIDTH, height: 27,
    borderWidth: 0, borderColor: 0, borderRadius: 0, paddingLength: 0, textColor: 4, isEventCapture: 0, lines: 1 }),
  views: Object.freeze({ containerID: 7, containerName: "hud-views", xPosition: RAIL_X, yPosition: 66, width: HUD_RAIL_WIDTH, height: 164,
    borderWidth: 0, borderColor: 0, borderRadius: 0, paddingLength: 0, textColor: 2, isEventCapture: 0, lines: 6 }),
});
/** The MENU list takes the place of the view list inside the box; everything else stays. */
export const HUD_MENU_LIST = Object.freeze({ containerID: 4, containerName: "hud-menu", xPosition: RAIL_X - 4, yPosition: 66, width: HUD_RAIL_WIDTH + 6,
  height: 164, borderWidth: 0, borderColor: 0, borderRadius: 0, paddingLength: 0, isEventCapture: 1, itemWidth: HUD_RAIL_WIDTH, maxItems: 20, maxChars: 64 });
/** v0.11.2 link health: a glasses write this slow means the link is congested. */
export const SLOW_WRITE_MS = 1200;
/** Default pause between two glasses writes. */
export const WRITE_GAP_MS = 80;
/** How long the lighter mode lasts after the last slow write. */
export const SLOW_HOLD_MS = 30_000;
const SLOW_CAPTION_MS = 1500, SLOW_PANEL_MS = 600;
/** v0.15: least time between two BODY writes while the answer on screen is still streaming. */
export const STREAMING_BODY_MS = 300;
/** v0.10 image containers (4-bit greyscale PNG via updateImageRawData). */
export const HUD_IMAGES = Object.freeze({
  mascot: Object.freeze({ containerID: 10, containerName: "hud-mascot", xPosition: 0, yPosition: 0, width: 40, height: 36 }),
  badge: Object.freeze({ containerID: 11, containerName: "hud-badge", xPosition: 536, yPosition: 0, width: 40, height: 36 }),
  splash: Object.freeze({ containerID: 12, containerName: "hud-splash", xPosition: 70, yPosition: 44, width: 288, height: 128 }),
});
type ImageKey = keyof typeof HUD_IMAGES;
type PanelKey = keyof typeof HUD_PANELS;
const PANEL_ORDER: readonly PanelKey[] = ["body", "header", "status", "caption", "mode", "views"];
/** Container text of a panel in a frame (the HEADER container shows the title). */
const panelText = (frame: HudFrame, key: PanelKey): string => key === "header" ? frame.title : frame[key];
const innerWidth = (key: PanelKey) => {
  const panel = HUD_PANELS[key];
  return panel.width - 2 * (panel.borderWidth + panel.paddingLength) - HEADROOM;
};
export const HUD_LINE_WIDTH = Object.freeze({ header: innerWidth("header"), status: innerWidth("status"), body: innerWidth("body"), caption: innerWidth("caption"),
  rail: HUD_RAIL_WIDTH - 4 });
export const BODY_LINES = HUD_PANELS.body.lines;

// Advance widths for ASCII 0x20..0x7e, measured on the simulator font and rounded up.
const ASCII_WIDTHS = [
  5.2, 4, 6, 14, 12, 14, 15, 4, 6, 6, 8, 10, 5, 10, 5, 5.2, // space ! " # $ % & ' ( ) * + , - . /
  12, 7, 11, 12, 12, 12, 12, 12, 12, 12, 4, 5, 10, 10, 10, 12, // 0-9 : ; < = > ?
  17, 13, 12, 11, 12, 10, 10, 12, 12, 5, 8, 12, 9, 16, 12, 12, // @ A-O
  12, 12, 12, 11, 10, 12, 13, 16, 13, 13, 12, 7, 5.2, 7, 10, 9, // P-Z [ \ ] ^ _
  5, 11, 11, 10, 11, 10, 7, 11, 11, 5, 5, 9, 4, 16, 11, 10, // ` a-o
  11, 11, 7, 10, 6, 11, 11, 15, 11, 11, 9, 8, 4, 8, 16, // p-z { | } ~
];
const SYMBOL_WIDTHS: Readonly<Record<string, number>> = {
  "·": 5, "…": 10, "•": 9, "‘": 5, "’": 5, "“": 7, "”": 7, "—": 15, "–": 11, "°": 7, "×": 10, "±": 10,
  "»": 12, "«": 12, "€": 15, "£": 12, "¥": 12, "→": 17, "←": 17, "↑": 14, "↓": 14, "●": 20, "○": 20,
  "◆": 20, "◇": 20, "▲": 20, "▼": 20, "▶": 20, "■": 20, "□": 20,
  // v0.10 glyphs verified on the simulator 0.9.5 font (rounded up).
  "★": 20, "☆": 20, "♥": 20, "♡": 20, "①": 20, "②": 20, "③": 20, "④": 20, "⑤": 20, "›": 8, "‹": 8,
  "⑥": 20, "⑦": 20, "⑧": 20, "⑨": 20,
  "▁": 20, "▂": 20, "▃": 20, "▄": 20, "▅": 20, "▆": 20, "▇": 20, "█": 20, "◀": 20, "◁": 20, "▷": 20, "△": 20, "▽": 20, "≈": 12, "§": 12, "♪": 14,
};
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text: string): string[] => [...segmenter.segment(text)].map(item => item.segment);

/** Conservative width of one grapheme cluster in canvas pixels. */
export function hudGlyphWidth(glyph: string): number {
  const code = glyph.codePointAt(0) ?? 32;
  if (code >= 0x20 && code <= 0x7e) return ASCII_WIDTHS[code - 0x20]!;
  if (code === 0x09) return 21;
  const symbol = SYMBOL_WIDTHS[glyph];
  if (symbol !== undefined) return symbol;
  if (/^\s/u.test(glyph)) return 5.2;
  if (code < 0x2e80 && /^\p{L}/u.test(glyph)) return 13; // Latin/Greek/Cyrillic letters, accented
  return 20; // CJK, kana, hangul, symbols and emoji (full width or dropped by the firmware)
}
export function hudTextWidth(text: string): number {
  let width = 0;
  for (const glyph of graphemes(text)) width += hudGlyphWidth(glyph);
  return width;
}

/** Line spans (glyph index ranges) of one paragraph under the greedy wrap rule. */
function wrapSpans(glyphs: readonly string[], width: number): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let start = 0;
  while (start < glyphs.length) {
    let cursor = start, used = 0, lastBreak = -1;
    while (cursor < glyphs.length) {
      const next = hudGlyphWidth(glyphs[cursor]!);
      if (used + next > width) break;
      used += next; cursor += 1;
      if (/\s/u.test(glyphs[cursor - 1]!)) lastBreak = cursor;
    }
    if (cursor < glyphs.length && lastBreak > start) cursor = lastBreak;
    if (cursor === start) cursor += 1;
    spans.push({ start, end: cursor });
    start = cursor;
    while (start < glyphs.length && start > 0 && /\s/u.test(glyphs[start]!)) start += 1;
  }
  return spans;
}

/** Greedy word wrap matching paginateAnswer's line rule. "\n" always breaks. */
export function wrapText(text: string, width: number = HUD_LINE_WIDTH.body): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const glyphs = graphemes(paragraph);
    if (!glyphs.length) { lines.push(""); continue; }
    for (const span of wrapSpans(glyphs, width)) lines.push(glyphs.slice(span.start, span.end).join("").trimEnd());
  }
  return lines;
}

/** Shortens one line to `width`, ending with "…" (at a word boundary when cheap). */
export function ellipsize(line: string, width: number): string {
  if (hudTextWidth(line) <= width) return line;
  const glyphs = graphemes(line.trimEnd());
  const budget = width - hudGlyphWidth("…");
  let used = 0, cut = 0;
  while (cut < glyphs.length && used + hudGlyphWidth(glyphs[cut]!) <= budget) used += hudGlyphWidth(glyphs[cut++]!);
  let head = glyphs.slice(0, cut).join("");
  const space = head.lastIndexOf(" ");
  if (space > head.length * 0.6) head = head.slice(0, space);
  return `${head.replace(/[\s,;:.\-–—]+$/u, "")}…`;
}

/** Wraps and truncates to at most `maxLines`; the last kept line ends with "…". */
export function fitLines(text: string, maxLines: number, width: number = HUD_LINE_WIDTH.body): string[] {
  if (maxLines <= 0) return [];
  const lines = wrapText(text, width);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = ellipsize(`${kept[maxLines - 1]!} ${lines[maxLines]!}`, width);
  return kept;
}

/** The last `maxLines` wrapped lines; a cut head is marked with "…". */
export function tailLines(text: string, maxLines: number, width: number, prefix = ""): string[] {
  const source = text.length > 600 ? text.slice(-600).replace(/^\S*\s/u, "") : text;
  const full = wrapText(`${prefix}${source}`, width).filter(line => line.trim());
  if (full.length <= maxLines && source === text) return full;
  const tail = full.slice(-maxLines);
  let first = tail[0]!.replace(/^\s+/u, "");
  if (!first.startsWith(prefix) || !prefix) {
    while (first && hudTextWidth(`${prefix}…${first}`) > width) first = first.replace(/^\S+\s*/u, "");
    tail[0] = `${prefix}…${first}`;
  }
  return tail;
}

/** One caption segment: a final sentence or the live partial, with its speaker tag ("Them: "). */
export interface CaptionSegment { readonly tag: string; readonly text: string; readonly partial?: boolean }

type CaptionTail = (finals: readonly string[], partial: string, maxChars: number) => string;
/** The SDK's v0.8 helper (dedupes a partial that repeats the last final, CJK-aware joining), when built. */
const sdkCaptionTail = (conversationSdk as unknown as { captionTail?: CaptionTail }).captionTail;

/** Joins one speaker's finals (+ live partial) into one run of text. */
function joinRun(finals: readonly string[], partial: string): string {
  if (typeof sdkCaptionTail === "function") {
    try { return oneLine(sdkCaptionTail(finals, partial, 4000)); } catch { /* fall through */ }
  }
  const last = finals[finals.length - 1] ?? "";
  // A cumulative partial that already contains the last final replaces it.
  const parts = partial && last && oneLine(partial).startsWith(oneLine(last)) ? [...finals.slice(0, -1), partial] : [...finals, partial];
  return oneLine(parts.filter(Boolean).join(" "));
}

/**
 * Continuous caption: recent final sentences + the live partial as one rolling text, so the
 * caption flows across sentence boundaries instead of resetting at each final. Consecutive
 * segments of one speaker merge; a speaker change inserts its tag inline. When the head is
 * cut, the first visible line starts with the tag of the speaker it belongs to, then "…".
 */
export function rollingCaption(segments: readonly CaptionSegment[], maxLines: number, width: number): string[] {
  const runs: { tag: string; finals: string[]; partial: string }[] = [];
  for (const segment of segments) {
    const text = oneLine(segment.text);
    if (!text) continue;
    let last = runs[runs.length - 1];
    if (!last || last.tag !== segment.tag) runs.push(last = { tag: segment.tag, finals: [], partial: "" });
    if (segment.partial) last.partial = text; else last.finals.push(text);
  }
  const merged = runs.map(run => ({ tag: run.tag, text: joinRun(run.finals, run.partial) })).filter(run => run.text);
  // Bound the work: keep only the newest ~700 characters (always more than two caption lines).
  let budget = 700;
  const kept: { tag: string; text: string }[] = [];
  for (let index = merged.length - 1; index >= 0 && budget > 0; index -= 1) {
    const run = merged[index]!;
    const text = run.text.length > budget ? run.text.slice(-budget).replace(/^\S*\s/u, "") : run.text;
    kept.unshift({ tag: run.tag, text });
    budget -= run.text.length + run.tag.length + 1;
  }
  // One inline text; remember where each speaker run (its tag) starts, in glyphs.
  const glyphs: string[] = [];
  const starts: { at: number; tag: string; tagLength: number }[] = [];
  for (const run of kept) {
    if (glyphs.length) glyphs.push(" ");
    const tag = graphemes(run.tag);
    starts.push({ at: glyphs.length, tag: run.tag, tagLength: tag.length });
    glyphs.push(...tag, ...graphemes(run.text));
  }
  if (!glyphs.length) return [];
  const spans = wrapSpans(glyphs, width);
  const lines = spans.slice(-maxLines).map(span => glyphs.slice(span.start, span.end).join("").trimEnd());
  const trimmed = kept.length !== merged.length || kept[0]!.text !== merged[0]!.text;
  if (spans.length <= maxLines && !trimmed) return lines; // everything fits: nothing was cut
  const first = spans[spans.length - lines.length]!.start;
  const owner = [...starts].reverse().find(item => item.at <= first)!;
  if (first === owner.at) return lines; // the cut falls exactly on a speaker turn
  // The first visible line starts inside a speaker's run: name that speaker; "…" marks cut words
  // (none are cut when the wrap merely broke right after the tag).
  const prefix = `${owner.tag}${first > owner.at + owner.tagLength ? "…" : ""}`;
  let head = lines[0]!;
  while (head && hudTextWidth(`${prefix}${head}`) > width) head = head.replace(/^\S+\s*/u, "");
  // Making room for the prefix dropped all of that speaker's words: start at the next speaker.
  const next = starts.find(item => item.at > owner.at);
  lines[0] = next && next.tag && head.startsWith(next.tag) ? head : `${prefix}${head}`;
  return lines;
}

const ANSWER_LAYOUT: PageLayout = Object.freeze({ lineWidth: HUD_LINE_WIDTH.body, lines: BODY_LINES, bytes: 1500, measure: hudGlyphWidth });
/** "THEY ASKED" answers keep the question on the first body line. */
const THEY_ASKED_LAYOUT: PageLayout = Object.freeze({ ...ANSWER_LAYOUT, lines: BODY_LINES - 1 });

/* ------------------------------------------------------------------ */
/* Snapshot helpers                                                    */
/* ------------------------------------------------------------------ */

const ACTIVE = ["connected", "listening", "paused"];
const ANSWER_HIDDEN = ["failed", "error", "stopped", "exited", "ready", "starting", "connecting", "authorizing"];
const answerVisible = (state: GlassesConversationState) => !state.error && !ANSWER_HIDDEN.includes(state.status);
function oneLine(text: string): string { return text.replace(/\s+/gu, " ").trim(); }
// Control characters break native wrapping; keep newlines only.
const clean = (text: string) => text.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/gu, " ");
const pad2 = (value: number) => String(value).padStart(2, "0");

/** Verdict words for the glasses (no ✓ ✗ ⚠: they do not render on G2). */
export function verdictLabel(status: string): string {
  switch (status) {
    case "supported": return "● OK";
    case "contradicted": return "▲ FALSE";
    case "uncertain": return "◆ UNSURE";
    case "unavailable": return "· N/A";
    default: return status.toUpperCase();
  }
}
const verdictLine = (result: { status: string }) => `${verdictLabel(result.status)} · ${result.status}`;

/** "Title: text", without doubling punctuation ("Is it enough? Yes"). */
const titled = (title: string, text: string) => text ? `${title}${/[?!.:]$/u.test(title) ? "" : ":"} ${text}` : title;
/** Spaces approximating a pixel indent in the proportional font. */
const indent = (pixels: number) => " ".repeat(Math.max(0, Math.round(pixels / hudGlyphWidth(" "))));
/** Right-aligns one line in `width` px with leading spaces (the font is proportional; within ~5 px). */
function rightAlign(text: string, width: number): string {
  const line = ellipsize(text, width);
  return `${" ".repeat(Math.max(0, Math.floor((width - hudTextWidth(line)) / hudGlyphWidth(" "))))}${line}`;
}

type ItemKind = "concept" | "conflict" | "ask" | "verification" | "fact-check" | "fact" | "suggestion" | "todo";
interface HudItem {
  readonly key: string;
  readonly sig: string;
  readonly kind: ItemKind;
  /** LIVE single-block form. */
  readonly live: string;
  /** CHECKS card form, when the item is a check. */
  readonly check?: string;
  /** Verdicts: the dated source line shown at the end of the ambient pop-up ("Src: reuters.com · 2026-11-18 · +2"). */
  readonly source?: string;
}

/** "web check", or "news check" when the search was biased to recent reporting (Setup → news search). */
const checkKind = (result: { recency?: string }, plain: string) => result.recency === "news" ? "news check" : plain;
/** One line naming the newest dated source of a verdict (site or host, date, how many more); undefined without sources. */
export function verdictSourceLine(sources: readonly { url: string; title?: string; publishedAt?: string; site?: string }[]): string | undefined {
  if (!sources.length) return undefined;
  const dated = sources.filter(source => source.publishedAt).sort((a, b) => b.publishedAt!.localeCompare(a.publishedAt!));
  const best = dated[0] ?? sources[0]!;
  let name = oneLine(best.site ?? "");
  if (!name) { try { name = new URL(best.url).hostname.replace(/^www\./u, ""); } catch { name = oneLine(best.title ?? ""); } }
  if (!name) return undefined;
  return `Src: ${name}${best.publishedAt ? ` · ${best.publishedAt}` : ""}${sources.length > 1 ? ` · +${sources.length - 1}` : ""}`;
}

const ASK_LABEL: Readonly<Record<string, string>> = { lookup: "LOOKUP", propose: "PROPOSAL", question: "QUESTION" };

function collectItems(snapshot: PresentationSnapshot): HudItem[] {
  const items: HudItem[] = [];
  for (const concept of snapshot.concepts) {
    items.push({ key: `c:${concept.id}`, sig: `${concept.term}|${concept.explanation}`, kind: "concept",
      live: titled(oneLine(concept.term), oneLine(concept.explanation)) });
  }
  for (const conflict of snapshot.conflicts) {
    const what = oneLine(conflict.explanation || conflict.later);
    items.push({ key: `x:${conflict.id}`, sig: `${conflict.explanation}|${conflict.later}`, kind: "conflict",
      live: `▲ Conflict: ${what}`,
      check: `▲ CONFLICT\n${what}${conflict.earlier ? `\nWas: ${oneLine(conflict.earlier)}` : ""}${conflict.later && conflict.explanation ? `\nNow: ${oneLine(conflict.later)}` : ""}` });
  }
  for (const ask of snapshot.asks) {
    // Implicit asks (lookup / propose): "→ LOOKUP · topic: result".
    const label = ASK_LABEL[ask.kind] ?? "QUESTION";
    const topic = oneLine(ask.topic);
    const live = ask.status === "pending" ? `→ ${label} · ${topic}…`
      : ask.status === "failed" ? `→ ${label} failed · ${topic}`
        : `→ ${label} · ${titled(topic, oneLine(ask.answer ?? ""))}`;
    items.push({ key: `k:${ask.id}`, sig: `${ask.status}|${ask.answer ?? ""}`, kind: "ask", live });
  }
  for (const result of snapshot.verifications) {
    const summary = oneLine(result.summary);
    const source = verdictSourceLine(result.sources);
    items.push({ key: `v:${result.id}`, sig: `${result.status}|${result.summary}`, kind: "verification",
      live: titled(verdictLabel(result.status), `${oneLine(result.target)}${summary ? ` — ${summary}` : ""}`),
      check: `${verdictLine(result)} · ${checkKind(result, "verify")}\n${oneLine(result.target)}${summary ? `\n${summary}` : ""}`,
      ...(source ? { source } : {}) });
  }
  for (const result of snapshot.factChecks) {
    const summary = oneLine(result.summary);
    const source = verdictSourceLine(result.sources);
    items.push({ key: `f:${result.id}`, sig: `${result.status}|${result.summary}`, kind: "fact-check",
      live: titled(verdictLabel(result.status), `${oneLine(result.claim)}${summary ? ` — ${summary}` : ""}`),
      check: `${verdictLine(result)} · ${checkKind(result, "web check")}\n${oneLine(result.claim)}${summary ? `\n${summary}` : ""}`,
      ...(source ? { source } : {}) });
  }
  for (const fact of snapshot.summary?.keyFacts ?? []) {
    items.push({ key: `kf:${oneLine(fact).toLowerCase()}`, sig: "", kind: "fact", live: `Fact: ${oneLine(fact)}` });
  }
  // Notes mode: one short confirmation per captured or changed to-do ("TODO + Send quote - Mei, Fri").
  for (const cue of snapshot.notebook?.cues ?? []) {
    items.push({ key: `t:${cue.id}`, sig: cue.text, kind: "todo", live: oneLine(cue.text) });
  }
  for (const suggestion of snapshot.suggestions) {
    items.push({ key: `s:${suggestion.id}`, sig: "", kind: "suggestion", live: `? ${oneLine(suggestion.question)}` });
  }
  return items;
}

const GENERIC_SPEAKER = /^(|speaker|unknown|g2 conversation|conversation|user|helix)$/iu;
/** Caption tag for a transcript feed item: "Them: ", "You: ", a real name, or none. */
function speakerTag(item: Pick<FeedItem, "label"> & { readonly speaker?: string; readonly speakerRole?: string }): string {
  if (item.speakerRole === "other") return "Them: ";
  if (item.speakerRole === "self") return "You: ";
  const label = item.label.split(" · ")[0]?.trim() ?? "";
  if (label === "Other speaker" || label === "Them") return "Them: ";
  if (label === "You") return "You: ";
  const name = (item.speaker ?? "").trim();
  if (name && !GENERIC_SPEAKER.test(name) && !/^(them|you|other speaker)$/iu.test(name)) return `${name.slice(0, 16)}: `;
  return "";
}

/** ①..⑨ render on the G2 font (simulator-verified); they number suggestions and unseen counts. */
const CIRCLED = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨"];
type RailKey = Exclude<HudView, "claims">;
const RAIL_ROWS: readonly RailKey[] = ["live", "answer", "qa", "concepts", "summary", "checks"];
const RAIL_LABEL: Readonly<Record<RailKey, string>> = { live: "LIVE", answer: "ANSWER", qa: "ASK THEM", concepts: "CONCEPTS", summary: "SUMMARY", checks: "CHECKS" };
const VIEW_LABEL: Readonly<Record<HudView, string>> = {
  live: "LIVE", answer: "◆ ANSWER", qa: "ASK THEM", concepts: "CONCEPTS", claims: "CLAIMS", summary: "SUMMARY", checks: "CHECKS",
};
const CAPS = { concepts: 5, claims: 6, checks: 5, summaryPages: 3, suggestions: 4 } as const;
const HANDLED: HudCommand = Object.freeze({ type: "handled" });
const HINT_CAPTION = "tap: act · double-tap: menu\nhold: talk · swipe ↑↓: views";
const VERIFY_PENDING_MS = 45_000;
/** Ambient cues: at most CUE_QUEUE wait their turn; one that waited longer than CUE_STALE_MS is dropped. */
const CUE_QUEUE = 3, CUE_STALE_MS = 45_000, CUE_PAGES = 3, CUE_PAGES_DETAILED = 6, CUE_LAST_PAGE_MS = 5000;
/** Ambient: "● listening" / "○ paused" shows this long after the mic state changes. */
const STATUS_CUE_MS = 4000;
const CUE_TITLE: Readonly<Partial<Record<ItemKind, string>>> = { concept: "CONCEPT", ask: "LOOKUP", conflict: "CHECK", verification: "CHECK", "fact-check": "FACT CHECK", todo: "TO-DO" };
/**
 * Ambient suggested question (v0.14): the top one that was not yet said aloud pops up by itself, at most
 * one every SUGGESTION_CUE_GAP_MS, and stays at least SUGGESTION_CUE_MS so it can be read and said.
 */
export const SUGGESTION_CUE_GAP_MS = 20_000;
export const SUGGESTION_CUE_MS = 10_000;
/** A transient problem (glasses.notice) shows this long in the status line; the answer stays up. */
export const NOTICE_MS = 6000;
/** A cue that pops up on the blank ambient display: body pages, the page shown and when it turns / expires. */
interface AmbientCue { readonly key: string; readonly title: string; readonly pages: readonly string[]; readonly at: number; page: number; until: number;
  /** Minimum time on the last page (default CUE_LAST_PAGE_MS). */ readonly minMs?: number }
/** Candidate mode: the wearer is the candidate, so an answer to the interviewer's question is a reply to say. */
const candidateMode = (mode: string | undefined) => modeProfile(mode).id === "interviewee";
/** Candidate mode suggestion kinds (SDK: optional `kind`, absent = a question for the wearer to ask). */
type KindedSuggestion = CopilotSuggestion & { readonly kind?: string };
const suggestionKindLabels = (conversationSdk as unknown as { SUGGESTION_KIND_LABELS?: Readonly<Record<string, string>> }).SUGGESTION_KIND_LABELS;
const theyMayAsk = (suggestion: KindedSuggestion) => suggestion.kind === "they-ask";
const THEY_MAY_ASK_LABEL = (suggestionKindLabels?.["they-ask"] ?? "They may ask").toUpperCase();
/** The SDK prefixes `why` with the kind in Candidate mode; the title already says it. */
const suggestionWhy = (suggestion: KindedSuggestion) => oneLine(suggestion.why ?? "").replace(/^(they may ask|ask them)\s*[:\-–—]\s*/iu, "");
const questionKey = (text: string) => oneLine(text).toLowerCase();
/** "4m ago" / "1h05m ago" for a finished answer recalled later; "" under a minute. */
function ageText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "";
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h${pad2(minutes % 60)}m ago`;
}
const PARTIAL_ID = "transcript-partial";

interface BodyView { readonly text: string; readonly label: string; readonly position?: string; readonly status?: string; readonly selection?: number }
type AnswerKind = "answer" | "they" | "self";
/** What the HUD knew about an answer when it first arrived (it may be shown later, after the one before it). */
interface AnswerInfo { readonly kind: AnswerKind; readonly question?: string; readonly reply: boolean }

/* ------------------------------------------------------------------ */
/* HUD                                                                 */
/* ------------------------------------------------------------------ */

export class GlassesHud implements GlassesSurface {
  private readonly debounce: number;
  private readonly intervals: Record<PanelKey, number>;
  private readonly now: () => number;
  private glasses: GlassesConversationState = { status: "starting" };
  private snapshot?: PresentationSnapshot;
  private viewName: HudView = "live";
  private readonly cursor: Record<HudView, number> = { live: 0, answer: 0, qa: 0, concepts: 0, claims: 0, summary: 0, checks: 0 };
  private returnView?: HudView;
  private lastAnswerKey?: string;
  private readonly answerInfo = new Map<string, AnswerInfo>();
  /** First time each finished answer was seen (age of a recalled answer). */
  private readonly answerSeenAt = new Map<string, number>();
  private notice?: { id: number; text: string; at: number };
  /** Suggested questions (normalized text) that already popped up or were on screen in the QA view. */
  private readonly suggestionsCued = new Set<string>();
  private suggestionCueAt = -SUGGESTION_CUE_GAP_MS;
  /** When a suggestion held back by the gap may pop up (0 = none waiting). */
  private suggestionDue = 0;
  private readonly seen = new Map<string, { sig: string; seq: number }>();
  private seq = 0;
  private fresh = 0;
  private sessionStart?: number;
  private previousStatus = "starting";
  private interaction?: { text: string; at: number };
  /** First time each final transcript was seen (caption hold window). */
  private readonly finalsSeen = new Map<string, number>();
  private partialSeenAt = 0;
  private items: HudItem[] = [];
  private pager: AnswerPager;
  private frameValue: HudFrame;
  /** Menu state; `native` = shown as a firmware LIST container page. */
  private menu?: { items: HudMenuItem[]; selection: number; native: boolean; kind?: "main" | "mode"; idle?: boolean };
  /** v0.11 unseen items per rail row, and the ids already counted. */
  private readonly unseen: Record<RailKey, number> = { live: 0, answer: 0, qa: 0, concepts: 0, summary: 0, checks: 0 };
  private readonly counted = new Set<string>();
  private summarySig = "";
  /** Verifications requested from the glasses: id -> request time and result signature then. */
  private readonly requested = new Map<string, { at: number; before: string }>();
  private lastGesture?: string;
  private mirrorListener?: (mirror: HudMirror) => void;
  private mirrorKey = "";
  private mirrorQueued = false;
  private rebuildAt = 0;
  private rebuilding?: Promise<boolean>;
  /** Which page is on the glasses: the 3-text HUD or the MENU list page. */
  private page: "hud" | "menu" = "hud";
  /**
   * Whether the HUD page on the glasses has the SPLASH image container. Image containers are opaque
   * (simulator-verified: black pixels hide text under them), so the splash exists only on the
   * not-connected page and a connect/disconnect swaps pages with rebuildPageContainer.
   */
  private pageSplash = false;
  private readonly sent = new Map<PanelKey, string>();
  private readonly sentAt = new Map<PanelKey, number>();
  private readonly dirtySince = new Map<PanelKey, number>();
  /** After a rejected write the link is likely congested: pause all writes. */
  private blockedUntil = 0;
  // v0.15: a write the glasses never answer is given up after a deadline (see withDeadline), so the
  // single write queue cannot halt. Consecutive unanswered writes, the back-off after them, and a full
  // re-push owed once the link answers again (what the glasses show after an unanswered write is unknown).
  private timeouts = 0;
  private timeoutUntil = 0;
  private timeoutTimer?: ReturnType<typeof setTimeout>;
  private repushOwed = false;
  // A text write that passed its deadline may still be answered (a link that is steadily slower than the
  // deadline). Until TEXT_LATE_ANSWER_MS after its start the same text is not sent again, and a late
  // "accepted" counts as sent. `writeSeq` orders the writes; `sentSeq` is the newest one each container shows.
  private readonly awaited = new Map<PanelKey, { content: string; seq: number; until: number }>();
  private readonly sentSeq = new Map<PanelKey, number>();
  private writeSeq = 0;
  /** Unanswered writes whose outcome is still unknown; at 0 no re-push is owed. */
  private unknownWrites = 0;
  /** True while render() runs ingest(): the pager callback leaves the refresh to render(). */
  private ingesting = false;
  /** What ingest() last handed to the pager; an unchanged answer is not handed over again. */
  private pagerInput?: { id?: string; questionId?: string; text?: string; streaming?: boolean; partial?: boolean; layout?: PageLayout; revision?: number; none: boolean };
  private initialized = false;
  private disposed = false;
  private generation = 0;
  private initializing?: Promise<void>;
  private inFlight?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private ticker?: ReturnType<typeof setInterval>;
  // ---- v0.10 images ----
  private readonly imageWanted = new Map<ImageKey, string>();
  private readonly imagesSent = new Map<ImageKey, string>();
  private readonly imageSentAt = new Map<ImageKey, number>();
  private readonly imageCache = new Map<string, Uint8Array>();
  private imageInFlight?: Promise<void>;
  private imageTimer?: ReturnType<typeof setTimeout>;
  private imageFailures = 0;
  /** Starts from options.images; later changed by setImagesEnabled or by repeated image failures. */
  private imagesDisabled = false;
  // v0.11.2 link health: one glasses write in flight at a time (text, image or page), and when the
  // Even bridge answers slowly (a congested or dropping glasses link) images pause and captions slow down.
  // v0.11.4 pacing: the bridge promise may resolve before the glasses have finished with a container,
  // so every write is followed by a gap before the next one goes out (adjustable in Setup → Diagnostics).
  private writeGap = WRITE_GAP_MS;
  private nextWriteAt = 0;
  private slowUntil = 0;
  private slowImages = 0;
  private lastSlowLog = 0;
  // ---- ambient display ----
  private displayMode: GlassesDisplay;
  private readonly idleMs: number;
  /** The woken HUD stays until this time (0 = not woken). State follows the clock: timers only call refresh(). */
  private awakeUntil = 0;
  /** Whether the HUD page on the glasses is the blank ambient page (no frame, no images). */
  private pageAmbient = false;
  private cue?: AmbientCue;
  private cueQueue: AmbientCue[] = [];
  private statusCueAt?: number;
  private ambientTimer?: ReturnType<typeof setTimeout>;
  /** Pages one ambient cue may use; follows Setup → Answer length. */
  private cuePages = CUE_PAGES;

  public constructor(
    private readonly bridge: GlassesRenderBridge,
    private readonly options: GlassesHudOptions = {},
  ) {
    const debounce = this.debounce = Math.max(120, options.debounceMs ?? 120);
    this.imagesDisabled = options.images === false;
    this.writeGap = Math.max(0, options.writeGapMs ?? WRITE_GAP_MS);
    this.intervals = { header: debounce, status: debounce, body: debounce, mode: debounce, views: debounce, caption: Math.max(debounce, options.captionIntervalMs ?? 1000) };
    this.now = options.now ?? (() => Date.now());
    this.displayMode = options.display ?? DEFAULT_GLASSES_DISPLAY;
    this.idleMs = Math.max(1000, options.ambientIdleMs ?? AMBIENT_IDLE_MS);
    this.setAnswerLength(options.answerLength);
    this.pager = this.createPager();
    this.frameValue = this.compose();
  }

  /** Current view (for tests, QA and the phone mirror). */
  public get view(): HudView { return this.viewName; }
  /** Text currently intended for the three containers (BODY = menu text while the menu is open). */
  public get frame(): HudFrame { return this.frameValue; }
  public get menuOpen(): boolean { return !!this.menu; }
  /** True while the MENU is a native list page (vs the text fallback in BODY). */
  public get menuNative(): boolean { return !!this.menu?.native; }
  public get menuItems(): readonly HudMenuItem[] { return this.menu?.items ?? []; }
  public get lastRebuildAt(): number { return this.rebuildAt; }
  /** Display setting: "ambient" or "always-on". */
  public get display(): GlassesDisplay { return this.displayMode; }
  /** True while the ambient display hides the HUD (blank, or only an answer / cue pop-up). */
  public get ambient(): boolean { return this.ambientActive(); }
  /** What the phone mirror shows. */
  public get mirror(): HudMirror {
    const frame = this.frameValue;
    // Menu: every item, one per line; `selection` is the absolute index.
    const body = this.menu ? this.menu.items.map(item => item.label).join("\n") : frame.body;
    const ambient = this.ambientActive();
    const images = this.imagesOn && this.initialized && !ambient ? Object.fromEntries(this.imageWanted) : undefined;
    return {
      view: this.viewName, header: frame.header, body, caption: frame.caption, menuOpen: !!this.menu,
      title: frame.title, status: frame.status.trim(),
      railMode: frame.mode.trim(), railViews: frame.views, content: frame.body,
      ...(images && Object.keys(images).length ? { images } : {}),
      ...(ambient ? { ambient: true } : {}),
      ...(this.selection() === undefined ? {} : { selection: this.selection() }),
      ...(this.lastGesture ? { lastGesture: this.lastGesture } : {}),
      updatedAt: this.now(),
    };
  }

  /** Glasses -> phone mirror; publishes the current state right away. */
  public setMirrorListener(listener?: (mirror: HudMirror) => void): void {
    this.mirrorListener = listener;
    this.mirrorKey = "";
    this.publishMirror();
  }

  public initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.initializing) return this.initializing;
    if (this.disposed) { this.disposed = false; this.pager = this.createPager(); }
    const generation = this.generation;
    const operation = this.createPage(generation).finally(() => {
      if (this.initializing === operation) this.initializing = undefined;
    });
    this.initializing = operation;
    return operation;
  }

  private async createPage(generation: number): Promise<void> {
    this.menu = undefined;
    const frame = this.frameValue = this.compose();
    const splash = this.splashActive(), ambient = this.ambientActive();
    const page = this.hudPage(frame, splash, ambient);
    const result = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(page));
    this.nextWriteAt = this.now() + (this.writeGap ? Math.max(300, this.writeGap * 3) : 0);
    if (generation !== this.generation) return;
    if (result !== StartUpPageCreateResult.success) {
      // Warm/cold WebView restart (Android reclaimed the WebView, a reload): the page already
      // exists, so createStartUpPageContainer reports `invalid` (simulator-verified). Take it over.
      const rebuilt = this.bridge.rebuildPageContainer ? await this.bridge.rebuildPageContainer(new RebuildPageContainer(page)).catch(() => false) : false;
      if (generation !== this.generation) return;
      if (!rebuilt) throw new Error(`G2 startup page creation failed with result ${result}`);
      this.rebuildAt = this.now();
    }
    this.initialized = true;
    this.page = "hud";
    this.pageSplash = splash;
    this.pageAmbient = ambient;
    const at = this.now();
    for (const key of PANEL_ORDER) { this.sent.set(key, panelText(frame, key)); this.sentAt.set(key, at); }
    this.imagesSent.clear(); // a new page has empty image containers
    this.startTicker();
    this.refresh();
  }

  /** Never throws. The snapshot carries copilot data; `glasses` alone still works. */
  public render(glasses: GlassesConversationState, snapshot?: PresentationSnapshot): void {
    if (this.disposed) return;
    try {
      this.glasses = glasses;
      if (snapshot) this.snapshot = snapshot;
      this.ingesting = true;
      try { this.ingest(); } finally { this.ingesting = false; }
      this.refresh();
    } catch (error) { this.reportRenderError(error); }
  }

  /** Pure state machine step; returns what the controller should do. Never throws. */
  public handleGesture(gesture: HudGesture): HudCommand | undefined {
    if (this.disposed) return undefined;
    try {
      const status = this.glasses.status;
      if (this.menu) {
        // Ambient display: double-tap on the menu hides the whole HUD again (wake and hide are one gesture).
        const hide = gesture === "double" && this.ambientSession() && !this.menu.idle;
        const command = hide ? this.sleep() : this.menuGesture(gesture);
        if (!hide) this.touch();
        this.refresh();
        return command;
      }
      if (this.ambientActive()) {
        const command = this.ambientGesture(gesture);
        this.refresh();
        return command;
      }
      if (!ACTIVE.includes(status) && status !== "failed") {
        // Not connected: swipes and the menu have nothing to show; taps keep the controller's
        // default unless the "tap to resume" prompt is up.
        if (gesture === "click" && this.glasses.resumePrompt && (status === "ready" || status === "stopped")) {
          this.lastGesture = "click:resume";
          return { type: "resume" };
        }
        // v0.11: Connect / Mode from the glasses while not connected.
        if (gesture === "double" && status !== "connecting" && status !== "authorizing" && status !== "starting") {
          this.openMenu(true);
          this.refresh();
          return HANDLED;
        }
        return gesture === "click" ? undefined : HANDLED;
      }
      this.fresh = 0;
      this.lastGesture = gesture;
      this.touch();
      let command: HudCommand = HANDLED;
      if (gesture === "double") this.openMenu();
      else if (gesture === "click") command = this.click();
      else this.move(gesture === "down" ? 1 : -1);
      this.refresh();
      return command;
    } catch (error) {
      this.reportRenderError(error);
      return undefined;
    }
  }

  /** Click on the native MENU list (listEvent.currentSelectItemIndex, name when the host sends it). */
  public selectListItem(index: number, name?: string): HudCommand | undefined {
    if (this.disposed) return undefined;
    // Ambient display: the woken menu closes by itself (idle or hide). A list click that arrives after
    // that is stale; it must not fall through to a tap on the blank display (which asks a billable question).
    if (!this.menu) return this.ambientActive() ? HANDLED : undefined;
    try {
      const items = this.menu.items;
      const byName = name ? items.findIndex(item => item.label === name) : -1;
      const position = byName >= 0 ? byName : Math.max(0, Math.min(items.length - 1, Math.trunc(index) || 0));
      this.menu.selection = position;
      this.touch();
      const command = this.runMenuItem(items[position]!);
      this.refresh();
      return command;
    } catch (error) {
      this.reportRenderError(error);
      return undefined;
    }
  }

  /** Phone -> glasses: show `view` (closes the menu; keeps that view's cursor). */
  public setView(view: HudView): void {
    if (this.disposed || !HUD_VIEWS.includes(view)) return;
    try {
      if (this.menu) this.closeMenu();
      if (view !== this.viewName) {
        if (this.viewName === "answer" && this.pager.text) this.pager.dismiss();
        this.returnView = undefined;
        this.viewName = view;
      }
      this.lastGesture = `phone:${view}`;
      this.refresh();
    } catch (error) { this.reportRenderError(error); }
  }

  /**
   * Lifecycle re-push: redraw the whole current page (HUD or MENU) with rebuildPageContainer
   * and re-send the OS menu. Used after Android suspended/reclaimed the WebView and on
   * foreground return. Safe while an OS overlay is open (simulator-verified: the overlay
   * stays, the rebuilt page shows when it closes).
   */
  public async repush(): Promise<boolean> {
    if (this.disposed) return false;
    if (!this.initialized) {
      try { await this.initialize(); return this.initialized; } catch { return false; }
    }
    this.lastGesture = "repush";
    return this.rebuild(this.menu?.native ? "menu" : "hud", true);
  }

  public flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.rebuilding) return this.rebuilding.then(() => this.flush());
    if (this.inFlight) return this.inFlight.then(() => this.flush());
    if (!this.initialized || !this.dirty().length) return Promise.resolve();
    return this.send(true);
  }

  public dispose(): void {
    if (this.imageTimer) clearTimeout(this.imageTimer);
    this.imageTimer = undefined;
    this.disposed = true;
    this.initialized = false;
    this.initializing = undefined;
    this.generation += 1;
    this.menu = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    if (this.ambientTimer) clearTimeout(this.ambientTimer);
    this.ambientTimer = undefined;
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = undefined;
    this.awakeUntil = 0; this.cue = undefined; this.cueQueue = [];
    this.pager.dispose();
  }

  /* ---------------- state ---------------- */

  private createPager(): AnswerPager {
    this.pagerInput = undefined;
    return new AnswerPager(() => {
      if (this.disposed || this.ingesting) return; // during render(): ingest() follows the answer, render() refreshes
      try { this.followAnswer(); this.refresh(); } catch (error) { this.reportRenderError(error); }
    }, ANSWER_LAYOUT, () => this.now());
  }

  private ingest(): void {
    const glasses = this.glasses;
    const status = glasses.status;
    const now = this.now();
    if (status !== this.previousStatus) {
      if ((status === "connecting" || status === "authorizing") && !["connecting", "authorizing"].includes(this.previousStatus)) this.resetSession();
      this.previousStatus = status;
      if (ACTIVE.includes(status)) this.statusCueAt = now;
    }
    if (ACTIVE.includes(status) && this.sessionStart === undefined) this.sessionStart = now;
    if (glasses.interaction !== this.interaction?.text) this.interaction = glasses.interaction ? { text: glasses.interaction, at: now } : undefined;
    if (glasses.notice?.id !== this.notice?.id) this.notice = glasses.notice ? { ...glasses.notice, at: now } : undefined;

    const snapshot = this.snapshot;
    if (snapshot) {
      this.items = collectItems(snapshot);
      const keys = new Set<string>();
      for (const item of this.items) {
        keys.add(item.key);
        const previous = this.seen.get(item.key);
        if (previous?.sig === item.sig) continue;
        this.seen.set(item.key, { sig: item.sig, seq: ++this.seq });
        if (item.kind !== "fact" && (!previous || item.kind === "ask")) this.fresh += 1;
        this.offerCue(item, now);
      }
      for (const key of [...this.seen.keys()]) if (!keys.has(key)) this.seen.delete(key);
      this.countUnseen(snapshot);
      for (const item of snapshot.feed) {
        if (item.kind !== "transcript" || !item.body.trim()) continue;
        if (item.id === PARTIAL_ID) this.partialSeenAt = now;
        else if (!this.finalsSeen.has(item.id)) this.finalsSeen.set(item.id, now);
      }
      while (this.finalsSeen.size > FEED_LIMIT) this.finalsSeen.delete(this.finalsSeen.keys().next().value!);
      for (const item of snapshot.feed) if (item.kind === "answer" && !item.streaming && !this.answerSeenAt.has(item.id)) this.answerSeenAt.set(item.id, now);
      while (this.answerSeenAt.size > FEED_LIMIT) this.answerSeenAt.delete(this.answerSeenAt.keys().next().value!);
      this.settleRequests(snapshot.verifications);
    }

    // Three question kinds: questions others asked -> THEY ASKED answer; the wearer's own
    // spoken questions are never auto-shown; explicit requests (tap/menu/phone) -> ANSWER.
    // A menu opened while connected closes on disconnect, and the idle menu closes on connect.
    if (this.menu && !!this.menu.idle === (ACTIVE.includes(status) || status === "failed")) this.closeMenu();
    const kind = this.kindOf(glasses);
    // v0.10 Interviewer mode: the wearer's own questions get an answer key, shown like THEY ASKED.
    const answer = answerVisible(glasses) && (kind !== "self" || this.answerKeys()) ? glasses.answer : undefined;
    if (answer) {
      // Kind and question are fixed when the answer first arrives: with answers back to back it may
      // be shown only after the one before it, when `glasses.question` already belongs to a later one.
      const key = `${answer.id ?? answer.questionId ?? "anonymous"}:${glasses.answerResetRevision ?? 0}`;
      let info = this.answerInfo.get(key);
      if (!info) {
        info = { kind, reply: kind === "they" && candidateMode(glasses.mode), ...(glasses.question?.text ? { question: glasses.question.text } : {}) };
        this.answerInfo.set(key, info);
        while (this.answerInfo.size > 12) this.answerInfo.delete(this.answerInfo.keys().next().value!);
      }
      this.updatePager({ ...answer, layout: info.kind === "answer" ? ANSWER_LAYOUT : THEY_ASKED_LAYOUT }, glasses.answerResetRevision);
    } else this.updatePager(undefined, glasses.answerResetRevision);
    this.followAnswer();
  }

  /**
   * pager.update, skipped when nothing about the answer changed since the last call (most events are
   * transcript partials). An answer the pager ended by itself (stalled stream) is still handed over.
   */
  private updatePager(answer: Parameters<AnswerPager["update"]>[0], revision?: number): void {
    const last = this.pagerInput;
    const same = !!last && last.none === !answer && last.revision === revision && last.id === answer?.id && last.questionId === answer?.questionId
      && last.text === answer?.text && last.streaming === answer?.streaming && last.partial === answer?.partial && last.layout === answer?.layout;
    if (same && !(answer?.streaming && !this.pager.isStreaming)) return;
    this.pagerInput = { none: !answer, revision, id: answer?.id, questionId: answer?.questionId, text: answer?.text, streaming: answer?.streaming, partial: answer?.partial, layout: answer?.layout };
    this.pager.update(answer, revision);
  }

  /** The ANSWER view follows whichever answer the pager shows now (a new one, or the next waiting one). */
  private followAnswer(): void {
    const glasses = this.glasses;
    const key = this.pager.key ? `answer:${this.pager.key}` : glasses.manualPending ? `pending:${glasses.answerResetRevision ?? 0}` : undefined;
    if (key && key !== this.lastAnswerKey) {
      this.lastAnswerKey = key;
      if (this.viewName !== "answer") { this.returnView = this.viewName; this.viewName = "answer"; }
    }
    this.autoReturn();
  }
  private shownAnswer(): AnswerInfo { return this.answerInfo.get(this.pager.key ?? "") ?? { kind: "answer", reply: false }; }

  /** v0.11: new answers / prompts / concepts / checks since their view was last on screen. */
  private countUnseen(snapshot: PresentationSnapshot): void {
    const add = (row: RailKey, ids: Iterable<string>) => {
      for (const id of ids) {
        const key = `${row}:${id}`;
        if (this.counted.has(key)) continue;
        this.counted.add(key);
        this.unseen[row] += 1;
      }
    };
    add("answer", snapshot.feed.filter(item => item.kind === "answer" && !item.streaming).map(item => item.id));
    add("qa", snapshot.suggestions.filter(item => !item.askedAt).map(item => item.id));
    add("concepts", snapshot.concepts.map(item => item.id));
    add("checks", [...snapshot.conflicts, ...snapshot.verifications, ...snapshot.factChecks, ...snapshot.claims].map(item => item.id));
    const notebook = snapshot.notebook ? `#${snapshot.notebook.todos.map(item => `${item.id}:${item.done}:${item.text}:${item.owner ?? ""}:${item.due ?? ""}`).join("|")}#${snapshot.notebook.notes.length}` : "";
    const sig = snapshot.summary || notebook ? `${snapshot.summary?.bullets.join("|") ?? ""}#${snapshot.summary?.keyFacts.join("|") ?? ""}${notebook}` : "";
    if (sig !== this.summarySig) { this.summarySig = sig; if (sig) this.unseen.summary = 1; }
    while (this.counted.size > 2000) this.counted.delete(this.counted.values().next().value!);
  }

  private answerKeys(): boolean { return modeProfile(this.glasses.mode).selfQuestions === "answer-key"; }
  private askLabel(): string { return modeProfile(this.glasses.mode).askLabel; }
  /** Notes mode: the SUMMARY view is the to-do / notes view. */
  private noteTaking(): boolean { return modeProfile(this.glasses.mode).presets.noteTaking === true; }
  private summaryLabel(): string { return this.noteTaking() ? "TO-DO" : VIEW_LABEL.summary; }

  private kindOf(glasses: GlassesConversationState): AnswerKind {
    const question = glasses.question;
    // Corrections / proactive answers have no question; explicit requests are manual.
    if (!question || glasses.manualPending || !glasses.answer?.questionId) return "answer";
    const trigger = question.trigger ?? (["Local context", "Whole conversation", "You"].includes(question.speaker ?? "") ? "manual" : "question");
    if (trigger !== "question") return "answer";
    if (question.role === "self" || (question.role === undefined && question.speaker === "You")) return "self";
    return "they";
  }

  private resetSession(): void {
    this.viewName = "live";
    for (const view of HUD_VIEWS) this.cursor[view] = 0;
    this.returnView = undefined;
    this.seen.clear();
    this.fresh = 0;
    this.sessionStart = undefined;
    this.finalsSeen.clear();
    this.partialSeenAt = 0;
    this.items = [];
    this.requested.clear();
    this.counted.clear(); this.summarySig = "";
    this.answerInfo.clear(); this.answerSeenAt.clear(); this.notice = undefined;
    this.suggestionsCued.clear(); this.suggestionCueAt = -SUGGESTION_CUE_GAP_MS; this.suggestionDue = 0;
    for (const key of RAIL_ROWS) this.unseen[key] = 0;
    this.awakeUntil = 0; this.cue = undefined; this.cueQueue = [];
    if (this.menu) this.closeMenu();
  }

  /* ---------------- ambient display ---------------- */

  /** Ambient setting during a running session (the only time the display goes blank). */
  private ambientSession(): boolean {
    return this.displayMode === "ambient" && ACTIVE.includes(this.glasses.status);
  }
  /** True while the ambient display replaces the HUD: a session is running, the HUD is not woken, no menu. */
  private ambientActive(): boolean {
    return this.ambientSession() && !this.menu && this.now() >= this.awakeUntil;
  }

  /** Setup → Answer length. Applies to cues that arrive from now on (answers always page in full). */
  public setAnswerLength(length: string | undefined): void {
    this.cuePages = length === "detailed" ? CUE_PAGES_DETAILED : CUE_PAGES;
  }

  /** Setup switch: ambient or always-on. Takes effect right away (the page is swapped when needed). */
  public setDisplay(display: GlassesDisplay): void {
    if (this.disposed || display === this.displayMode) return;
    this.displayMode = display;
    this.awakeUntil = 0; this.cue = undefined; this.cueQueue = [];
    this.lastGesture = `display:${display}`;
    try { this.refresh(); } catch (error) { this.reportRenderError(error); }
  }

  /** The menu gesture on the blank display: show the full HUD until idle. */
  private wake(): void {
    this.awakeUntil = this.now() + this.idleMs;
    this.cue = undefined; this.cueQueue = [];
  }
  /** A gesture on the woken HUD restarts the idle time. */
  private touch(): void {
    if (this.ambientSession() && this.awakeUntil) this.awakeUntil = this.now() + this.idleMs;
  }
  /** Back to the blank display (double-tap on the menu, or idle). */
  private sleep(): HudCommand {
    this.awakeUntil = 0;
    if (this.menu) this.closeMenu();
    this.lastGesture = "ambient:sleep";
    return HANDLED;
  }

  /** A new or changed LIVE item becomes a cue that pops up on the blank display. */
  private offerCue(item: HudItem, now: number): void {
    if (!this.ambientSession() || this.awakeUntil > now) return;
    const title = CUE_TITLE[item.kind];
    // Lookups pop up when their answer arrived, not while pending or after a failure.
    if (!title || (item.kind === "ask" && /^(pending|failed)\|/u.test(item.sig))) return;
    // Verdict pop-ups end with the dated source line (news search), so the wearer sees how fresh the evidence is.
    const lines = wrapText(clean(`${item.check ?? item.live}${item.source ? `\n${item.source}` : ""}`), HUD_LINE_WIDTH.body);
    const pages: string[] = [];
    // Setup → Answer length "Detailed" writes longer lookups and verdicts: allow them more pages before the "…".
    const CUE_PAGES = this.cuePages;
    for (let index = 0; index < lines.length && pages.length < CUE_PAGES; index += BODY_LINES) {
      const page = lines.slice(index, index + BODY_LINES);
      // The last allowed page ends with "…" when text is left over (all of it is in the woken HUD and on the phone).
      const rest = lines[index + BODY_LINES];
      if (pages.length + 1 === CUE_PAGES && rest !== undefined) page[page.length - 1] = ellipsize(`${page[page.length - 1]!} ${rest}`, HUD_LINE_WIDTH.body);
      pages.push(page.join("\n"));
    }
    if (!pages.length) return;
    if (this.cue?.key === item.key) this.cue = undefined; // the item changed while on screen: show the new text
    this.cueQueue = [...this.cueQueue.filter(cue => cue.key !== item.key), { key: item.key, title, pages, at: now, page: 0, until: 0 }].slice(-CUE_QUEUE);
  }

  /** Reading time of the cue's current page; the last page stays at least CUE_LAST_PAGE_MS. */
  private cueReadMs(cue: AmbientCue): number {
    const ms = pageReadingMs(graphemes(cue.pages[cue.page] ?? "").length);
    return cue.page + 1 < cue.pages.length ? ms : Math.max(cue.minMs ?? CUE_LAST_PAGE_MS, ms);
  }

  /** Cue title of a suggested question: the mode's label, or "THEY MAY ASK" for the other side's likely next question. */
  private suggestionTitle(suggestion: KindedSuggestion): string {
    return theyMayAsk(suggestion) ? THEY_MAY_ASK_LABEL : this.askLabel();
  }

  /**
   * The top suggested question that was not said aloud yet pops up once, as one page that reads in a
   * glance: the question first, the reason only when all of it fits under it. It waits in the cue
   * queue like any cue (never over an answer, dropped when stale) and leaves when the question is asked.
   */
  private offerSuggestion(now: number): void {
    const open = (this.snapshot?.suggestions ?? []).filter(item => !item.askedAt && oneLine(item.question)) as KindedSuggestion[];
    const live = new Set(open.map(item => `s:${questionKey(item.question)}`));
    const gone = (cue: AmbientCue) => cue.key.startsWith("s:") && !live.has(cue.key);
    if (this.cue && gone(this.cue)) this.cue = undefined;
    this.cueQueue = this.cueQueue.filter(cue => !gone(cue));
    this.suggestionDue = 0;
    const top = open[0];
    if (!top) return;
    const text = questionKey(top.question), key = `s:${text}`;
    if (this.suggestionsCued.has(text) || this.cue?.key === key || this.cueQueue.some(cue => cue.key === key)) return;
    const due = this.suggestionCueAt + SUGGESTION_CUE_GAP_MS;
    if (now < due) { this.suggestionDue = due; return; }
    const width = HUD_LINE_WIDTH.body;
    const question = fitLines(clean(oneLine(top.question)), BODY_LINES, width);
    const why = suggestionWhy(top);
    const reason = why ? wrapText(clean(`Why: ${why}`), width) : [];
    const lines = !reason.length || question.length + reason.length > BODY_LINES ? question
      : question.length + 1 + reason.length <= BODY_LINES ? [...question, "", ...reason] : [...question, ...reason];
    this.suggestionCueAt = now;
    // One suggestion at a time: a newer top one replaces an older one still waiting.
    this.cueQueue = [...this.cueQueue.filter(cue => !cue.key.startsWith("s:")),
      { key, title: this.suggestionTitle(top), pages: [lines.join("\n")], at: now, page: 0, until: 0, minMs: SUGGESTION_CUE_MS }].slice(-CUE_QUEUE);
  }

  /**
   * Moves the ambient state to the current time: idle HUD -> blank, cue page turns, cue expiry, next
   * cue. Only ever moves forward, so a late or stale timer cannot bring back anything that expired.
   */
  private stepAmbient(): void {
    if (this.displayMode !== "ambient") return;
    const now = this.now();
    // Outside a session nothing is ambient: a wake left over from the ended session must not later
    // "sleep" (close) the Connect/Mode menu opened since.
    if (!ACTIVE.includes(this.glasses.status)) { this.awakeUntil = 0; this.cue = undefined; this.cueQueue = []; return; }
    if (this.awakeUntil && now >= this.awakeUntil) this.sleep();
    if (this.awakeUntil) { this.cue = undefined; this.cueQueue = []; return; }
    this.offerSuggestion(now);
    if (this.answerBusy()) {
      // An answer has the display: the cue waits and starts over afterwards.
      if (this.cue) { this.cueQueue = [{ ...this.cue, page: 0 }, ...this.cueQueue].slice(0, CUE_QUEUE); this.cue = undefined; }
      return;
    }
    const cue = this.cue;
    if (cue && now >= cue.until) {
      if (cue.page + 1 < cue.pages.length) { cue.page += 1; cue.until = now + this.cueReadMs(cue); }
      else this.cue = undefined;
    }
    this.cueQueue = this.cueQueue.filter(item => now - item.at < CUE_STALE_MS);
    if (!this.cue && this.cueQueue.length) {
      const next = this.cueQueue.shift()!;
      next.page = 0; next.until = now + this.cueReadMs(next);
      this.cue = next;
      if (next.key.startsWith("s:")) {
        // Shown: it never pops up again, and the gap to the next suggestion counts from now.
        this.suggestionsCued.add(next.key.slice(2));
        if (this.suggestionsCued.size > 200) this.suggestionsCued.delete(this.suggestionsCued.values().next().value!);
        this.suggestionCueAt = now;
      }
    }
  }

  /** One timer for the next ambient deadline; it only calls refresh(), which re-reads the clock. */
  private scheduleAmbient(): void {
    if (this.ambientTimer) clearTimeout(this.ambientTimer);
    this.ambientTimer = undefined;
    if (this.displayMode !== "ambient" || this.disposed) return;
    const now = this.now();
    const deadlines = [this.awakeUntil, this.cue?.until ?? 0, (this.statusCueAt ?? -STATUS_CUE_MS) + STATUS_CUE_MS,
      this.interaction ? this.interaction.at + 4001 : 0, ...this.cueQueue.map(cue => cue.at + CUE_STALE_MS),
      this.suggestionDue, this.notice ? this.notice.at + NOTICE_MS : 0,
      this.pageSwapDue() ? this.blockedUntil : 0].filter(time => time > now);
    if (!deadlines.length) return;
    this.ambientTimer = setTimeout(() => {
      this.ambientTimer = undefined;
      if (this.disposed) return;
      try { this.refresh(); } catch (error) { this.reportRenderError(error); }
    }, Math.max(1, Math.min(...deadlines) - now));
  }

  /** The glasses show the wrong one of the HUD page / blank ambient page (and the bridge can swap pages). */
  private pageSwapDue(): boolean {
    return this.initialized && this.page === "hud" && typeof this.bridge.rebuildPageContainer === "function" && this.ambientActive() !== this.pageAmbient;
  }

  /** Gestures on the blank display: double-tap wakes the HUD; tap / swipe act on the pop-up only. */
  private ambientGesture(gesture: HudGesture): HudCommand {
    this.lastGesture = `ambient:${gesture}`;
    if (gesture === "double") {
      this.wake();
      this.openMenu();
      return HANDLED;
    }
    if (this.pager.text) {
      if (gesture === "up") { this.pager.previous(); return HANDLED; }
      if (this.pager.next() || this.pager.isStreaming) return HANDLED;
      this.leaveAnswer(this.returnView ?? "live");
      return HANDLED;
    }
    if (this.glasses.manualPending) return HANDLED;
    const cue = this.cue;
    if (cue) {
      const page = cue.page + (gesture === "up" ? -1 : 1);
      if (page >= cue.pages.length) this.cue = undefined;
      else if (page >= 0) { cue.page = page; cue.until = this.now() + this.cueReadMs(cue); }
      return HANDLED;
    }
    // Nothing on screen: a tap asks about the last few sentences (the answer pops up); swipes have nothing to turn.
    return gesture === "click" ? { type: "askLocal" } : HANDLED;
  }

  /** The blank display, or the answer / cue that is popping up on it. */
  private composeAmbient(): HudFrame {
    const cue = this.cue, answering = this.answerBusy();
    const pop: BodyView | undefined = answering ? this.answerView()
      : cue ? { label: cue.title, text: cue.pages[cue.page] ?? "", ...(cue.pages.length > 1 ? { position: `${cue.page + 1}/${cue.pages.length}` } : {}),
        status: cue.page + 1 < cue.pages.length ? "swipe ↓ more" : "tap to close" } : undefined;
    if (answering) this.unseen.answer = 0; // an answer that popped up was seen
    const parts: string[] = [];
    const interaction = this.interactionText(), status = this.glasses.status;
    // A problem leads the line: it is brief, and the rest is what gets shortened.
    const problem = this.problemText();
    if (problem) parts.push(problem);
    if (interaction) parts.push(interaction);
    else if (this.statusCueAt !== undefined && this.now() - this.statusCueAt < STATUS_CUE_MS) parts.push(status === "listening" ? "● listening" : status === "paused" ? "○ paused" : "○ mic off");
    if (pop?.status) parts.push(pop.status);
    const statusLine = parts.length ? ellipsize(parts.join(" · "), HUD_LINE_WIDTH.status) : "";
    const title = pop ? ellipsize(`${pop.label}${pop.position ? ` ${pop.position}` : ""}`, HUD_LINE_WIDTH.header) || " " : " ";
    return {
      header: [title, statusLine].filter(part => part.trim()).join(" · ") || " ",
      title,
      status: rightAlign(statusLine, HUD_LINE_WIDTH.status) || " ",
      body: pop ? fitLines(clean(pop.text), BODY_LINES, HUD_LINE_WIDTH.body).join("\n") || " " : " ",
      caption: " ", mode: " ", views: " ",
    };
  }

  /** "! message" for a session-ending error, or for NOTICE_MS after a transient problem. */
  private problemText(): string | undefined {
    if (this.glasses.error) return `! ${oneLine(this.glasses.error)}`;
    const notice = this.notice;
    return notice && this.now() - notice.at < NOTICE_MS ? `! ${oneLine(notice.text)}` : undefined;
  }

  /** An auto-shown answer returns to the previous view once it is gone. */
  private autoReturn(): void {
    if (this.viewName !== "answer" || this.returnView === undefined) return;
    if (this.pager.text || this.glasses.manualPending) return;
    this.viewName = this.returnView;
    this.returnView = undefined;
  }

  private answerBusy(): boolean { return !!this.pager.text || !!this.glasses.manualPending; }

  private click(): HudCommand {
    const view = this.viewName;
    if (view === "qa") {
      const list = this.suggestions();
      const suggestion = list[Math.min(this.cursor.qa, list.length - 1)];
      return suggestion ? { type: "ask", text: suggestion.question } : { type: "askLocal" };
    }
    if (view === "claims") {
      const claim = this.selectedClaim();
      return claim ? this.verifyCommand(claim.id, claim.text, "claim") : HANDLED;
    }
    if (view === "concepts") {
      const concept = this.selectedConcept();
      return concept ? this.verifyCommand(concept.id, conceptTarget(concept), "concept") : { type: "askLocal" };
    }
    if (view === "answer") {
      if (this.pager.text) {
        if (this.pager.next()) return HANDLED;
        if (this.pager.isStreaming) return HANDLED;
        this.leaveAnswer(this.returnView ?? "live");
        return HANDLED;
      }
      if (this.glasses.manualPending) return HANDLED;
      const pages = this.recallPages();
      if (!pages.length) return { type: "askLocal" };
      if (this.cursor.answer + 1 < pages.length) this.cursor.answer += 1;
      else this.leaveAnswer("live");
      return HANDLED;
    }
    return { type: "askLocal" };
  }

  /** Verify unless already pending or settled (an unavailable result may be retried). */
  private verifyCommand(id: string, target: string, kind: "claim" | "concept"): HudCommand {
    const state = this.verifyState(id);
    if (state.pending) return HANDLED;
    if (state.result && state.result.status !== "unavailable") return HANDLED;
    this.requested.set(id, { at: this.now(), before: resultSig(state.result) });
    this.lastGesture = `verify:${id}`;
    return { type: "verify", target, id, kind };
  }

  private verifyState(id: string): { pending: boolean; result?: VerificationResult } {
    const result = this.snapshot?.verifications.find(item => item.id === id);
    const request = this.requested.get(id);
    const local = !!request && this.now() - request.at < VERIFY_PENDING_MS && resultSig(result) === request.before;
    const shared = !!this.snapshot?.verifying?.includes(id) && (!request || this.now() - request.at < VERIFY_PENDING_MS);
    return { pending: local || shared, ...(result ? { result } : {}) };
  }

  private settleRequests(results: readonly VerificationResult[]): void {
    for (const [id, request] of [...this.requested]) {
      const result = results.find(item => item.id === id);
      if (resultSig(result) !== request.before || this.now() - request.at >= VERIFY_PENDING_MS) this.requested.delete(id);
    }
  }

  private leaveAnswer(target: HudView): void {
    const restoring = target === this.returnView;
    this.pager.dismiss();
    if (this.pager.text) return; // the next waiting answer took its place
    this.returnView = undefined;
    if (restoring) this.viewName = target; // keep that view's cursor (e.g. the Q&A highlight)
    else this.enter(target, 1);
  }

  private move(direction: 1 | -1): void {
    const view = this.viewName;
    if (view === "answer" && this.pager.text) {
      if (direction > 0 ? this.pager.next() : this.pager.previous()) return;
      if (direction > 0) {
        if (this.pager.isStreaming) return; // more pages are coming
        this.leaveAnswer(this.returnView ?? nextView(view, 1));
        return;
      }
      this.returnView = undefined;
      this.enter(nextView(view, -1), -1);
      return;
    }
    if (view === "answer" && this.glasses.manualPending) {
      // Waiting for the answer: allow leaving, keep the request running.
      this.returnView = undefined;
      this.enter(nextView(view, direction), direction);
      return;
    }
    const size = this.positions(view);
    const next = Math.min(this.cursor[view], size - 1) + direction;
    if (next >= 0 && next < size) { this.cursor[view] = next; return; }
    this.returnView = undefined;
    this.enter(nextView(view, direction), direction);
  }

  /** Forward entry starts at the top; backward entry at the last position (swipe back = undo). */
  private enter(view: HudView, direction: 1 | -1): void {
    this.viewName = view;
    this.cursor[view] = direction > 0 ? 0 : Math.max(0, this.positions(view) - 1);
  }

  private positions(view: HudView): number {
    switch (view) {
      case "live": return 1;
      case "answer": return Math.max(1, this.answerBusy() ? 1 : this.recallPages().length);
      case "qa": return Math.max(1, this.suggestions().length);
      case "concepts": return Math.max(1, this.conceptList().length);
      case "claims": return Math.max(1, this.claimList().length);
      case "summary": return Math.max(1, this.summaryPages().length);
      case "checks": return Math.max(1, this.checkList().length);
    }
  }

  /** Highlighted index in the current view or menu (phone mirror). */
  private selection(): number | undefined {
    if (this.menu) return this.menu.selection;
    if (this.viewName === "live") return undefined;
    if (this.viewName === "answer") return this.pager.text ? this.pager.pageIndex : this.cursor.answer;
    return Math.min(this.cursor[this.viewName], this.positions(this.viewName) - 1);
  }

  /* ---------------- menu ---------------- */

  private menuEntries(idle = false): HudMenuItem[] {
    if (idle) return HUD_IDLE_MENU.map(item => ({ ...item }));
    const status = this.glasses.status;
    const pauseLabel = status === "listening" ? "Pause" : status === "paused" ? "Resume" : "Listen";
    return HUD_MENU_ITEMS.map(item => {
      if (item.action === "pause") return { ...item, label: pauseLabel };
      if (item.action === "claims" && this.claimList().length) return { ...item, label: `Claims · ${this.claimList().length}` };
      if (item.action === "concepts" && this.conceptList().length) return { ...item, label: `Concepts · ${this.conceptList().length}` };
      if (item.action === "ask-them") return { ...item, label: sentenceCase(this.askLabel()) };
      if (item.action === "summary" && this.noteTaking()) return { ...item, label: "To-do" }; // Notes mode: the SUMMARY view is the TO-DO view
      return item;
    }).slice(0, HUD_MENU_LIST.maxItems).map(item => ({ ...item, label: item.label.slice(0, HUD_MENU_LIST.maxChars) }));
  }

  private openMenu(idle = false): void {
    const native = typeof this.bridge.rebuildPageContainer === "function";
    this.menu = { items: this.menuEntries(idle), selection: 0, native, ...(idle ? { idle } : {}) };
    this.lastGesture = "menu:open";
    if (native) void this.rebuild("menu", false);
  }

  private closeMenu(): void {
    const native = this.menu?.native;
    this.menu = undefined;
    this.lastGesture = "menu:close";
    if (native || this.page === "menu") void this.rebuild("hud", false);
  }

  private menuGesture(gesture: HudGesture): HudCommand {
    const menu = this.menu!;
    this.lastGesture = `menu:${gesture}`;
    switch (gesture) {
      case "double": this.closeMenu(); return HANDLED;
      // Native list: the firmware moves the highlight (no event); track it if the host reports scrolls.
      case "up": menu.selection = Math.max(0, menu.selection - 1); return HANDLED;
      case "down": menu.selection = Math.min(menu.items.length - 1, menu.selection + 1); return HANDLED;
      case "click": return this.runMenuItem(menu.items[menu.selection]!);
    }
  }

  /** v0.10: the mode list (same native LIST page, new items). */
  private openModeMenu(): void {
    const current = modeProfile(this.glasses.mode).id;
    const items: HudMenuItem[] = PICKER_MODES.map(mode => ({ action: `mode:${mode}` as const,
      label: MODE_PROFILES[mode].label })); // the current mode is the bright line above the list
    const native = this.menu?.native ?? typeof this.bridge.rebuildPageContainer === "function";
    this.menu = { items, selection: Math.max(0, PICKER_MODES.indexOf(current)), native, kind: "mode", ...(this.menu?.idle ? { idle: true } : {}) };
    this.lastGesture = "menu:mode";
    if (native) void this.rebuild("menu", true);
  }

  private runMenuItem(item: HudMenuItem): HudCommand {
    if (item.action === "mode") { this.openModeMenu(); return HANDLED; }
    if (item.action.startsWith("mode:")) {
      this.closeMenu();
      const mode = item.action.slice(5);
      this.lastGesture = `menu:${item.action}`;
      return { type: "mode", mode };
    }
    this.closeMenu();
    this.lastGesture = `menu:${item.action}`;
    const go = (view: HudView) => {
      if (this.viewName === "answer" && this.pager.text && view !== "answer") this.pager.dismiss();
      this.returnView = undefined;
      this.viewName = view;
      this.cursor[view] = Math.min(this.cursor[view], this.positions(view) - 1);
    };
    switch (item.action) {
      case "answer-local": return { type: "askLocal" };
      case "answer-global": return { type: "askGlobal" };
      case "verify-claim": {
        go("claims");
        this.cursor.claims = 0;
        const claim = this.selectedClaim();
        return claim ? this.verifyCommand(claim.id, claim.text, "claim") : HANDLED;
      }
      case "ask-them": go("qa"); return HANDLED;
      case "concepts": case "claims": case "summary": case "checks": case "live": go(item.action); return HANDLED;
      case "pause": return { type: "togglePause" };
      case "stop": return { type: "stop" };
      case "connect": return { type: "connect" };
      case "close": return HANDLED;
      default: return HANDLED;
    }
  }

  /* ---------------- data views ---------------- */

  /** Suggested questions not yet said aloud (asked ones stay on the phone, struck out, until the SDK drops them). */
  private suggestions(): KindedSuggestion[] { return (this.snapshot?.suggestions ?? []).filter(item => !item.askedAt).slice(0, CAPS.suggestions); }
  private conceptList() { return [...(this.snapshot?.concepts ?? [])].reverse().slice(0, CAPS.concepts); }
  private claimList(): CopilotClaim[] { return [...(this.snapshot?.claims ?? [])].reverse().slice(0, CAPS.claims); }
  private selectedConcept(): CopilotConcept | undefined {
    const list = this.conceptList();
    return list[Math.min(this.cursor.concepts, list.length - 1)];
  }
  private selectedClaim(): CopilotClaim | undefined {
    const list = this.claimList();
    return list[Math.min(this.cursor.claims, list.length - 1)];
  }
  private ordered(kinds: readonly ItemKind[]): HudItem[] {
    return this.items.filter(item => kinds.includes(item.kind))
      .sort((a, b) => (this.seen.get(b.key)?.seq ?? 0) - (this.seen.get(a.key)?.seq ?? 0));
  }
  private checkList(): HudItem[] { return this.ordered(["conflict", "verification", "fact-check"]).slice(0, CAPS.checks); }

  private summaryPages(): string[][] {
    const summary = this.snapshot?.summary ?? { bullets: [], keyFacts: [] };
    // Notes mode: the to-do list (open items first) and the newest notes lead this view.
    const notebook = this.snapshot?.notebook, todos = notebook?.todos ?? [], notes = notebook?.notes ?? [];
    if (!summary.bullets.length && !summary.keyFacts.length && !todos.length && !notes.length) return [];
    const lines: string[] = [];
    const add = (marker: string, text: string) => {
      const hang = indent(hudTextWidth(`${marker} `));
      const width = HUD_LINE_WIDTH.body - Math.max(hudTextWidth(`${marker} `), hudTextWidth(hang));
      wrapText(oneLine(text), width).forEach((line, index) => lines.push(`${index ? hang : `${marker} `}${line}`));
    };
    for (const todo of [...todos.filter(item => !item.done), ...todos.filter(item => item.done)]) add(todo.done ? "[x]" : "[ ]", todoShort(todo, 80));
    if (notes.length) {
      if (lines.length) lines.push("Notes");
      for (const note of notes.slice(-6).reverse()) add("•", note.text);
    }
    if (lines.length && summary.bullets.length) lines.push("Summary");
    for (const bullet of summary.bullets) add("•", bullet);
    if (summary.keyFacts.length) {
      lines.push("Key facts");
      for (const fact of summary.keyFacts) add("–", fact);
    }
    const pages: string[][] = [];
    for (let index = 0; index < lines.length; index += BODY_LINES) pages.push(lines.slice(index, index + BODY_LINES));
    if (pages.length > CAPS.summaryPages) {
      const kept = pages.slice(0, CAPS.summaryPages);
      const last = kept[kept.length - 1]!;
      last[last.length - 1] = "… more on the phone";
      return kept;
    }
    return pages;
  }

  private lastAnswer(): FeedItem | undefined {
    const feed: readonly FeedItem[] = this.snapshot?.feed ?? [];
    return [...feed].reverse().find(item => item.kind === "answer" && !item.streaming && item.body.trim());
  }
  private lastAnswerText(): string { return this.lastAnswer()?.body.trim() ?? ""; }
  private recallPages(): string[] {
    const text = this.lastAnswerText();
    return text ? paginateAnswer(clean(text), ANSWER_LAYOUT) : [];
  }

  /* ---------------- composition ---------------- */

  private refresh(): void {
    this.stepAmbient();
    this.frameValue = this.compose();
    const now = this.now();
    for (const key of PANEL_ORDER) {
      if (this.sent.get(key) === panelText(this.frameValue, key)) this.dirtySince.delete(key);
      else if (!this.dirtySince.has(key)) this.dirtySince.set(key, now);
    }
    this.schedule();
    // Connect / disconnect: swap to the page with (or without) the opaque SPLASH container.
    // Ambient display: swap between the blank page and the HUD page (wake, idle, session start / end).
    const swap = now >= this.timeoutUntil && ((this.imagesOn && this.splashActive() !== this.pageSplash) || (this.pageSwapDue() && now >= this.blockedUntil));
    if (this.initialized && this.page === "hud" && !this.rebuilding && swap) void this.rebuild("hud", false);
    this.updateImages();
    this.publishMirror();
    this.scheduleAmbient();
  }

  private compose(): HudFrame {
    if (this.ambientActive()) return this.composeAmbient();
    const status = this.glasses.status;
    const active = ACTIVE.includes(status) || status === "failed";
    // v0.11: the native MENU sits in the rail, so the view stays visible; only the text fallback uses the BODY.
    const view = active ? this.bodyView() : this.inactiveView();
    const body = this.menu && !this.menu.native ? this.menuView() : view;
    const label = this.menu ? (this.menu.kind === "mode" ? "MODE" : "MENU") : body.label;
    const title = ellipsize(`${label}${!this.menu && body.position ? ` ${body.position}` : ""}`, HUD_LINE_WIDTH.header) || " ";
    const statusLine = this.composeStatus(this.menu ? { ...body, status: this.menuHint() } : body, active);
    this.unseen[this.railKey()] = 0; // what is on screen is seen
    return {
      header: [title, statusLine].filter(part => part.trim()).join(" · ") || " ",
      title,
      status: rightAlign(statusLine, HUD_LINE_WIDTH.status) || " ",
      body: fitLines(clean(body.text), BODY_LINES, HUD_LINE_WIDTH.body).join("\n") || " ",
      caption: this.composeCaption(active),
      mode: ellipsize(modeProfile(this.glasses.mode).label.toUpperCase(), HUD_LINE_WIDTH.rail) || " ",
      views: active ? this.composeRail() : " ",
    };
  }

  /** Rail row of the current view (CLAIMS lives under CHECKS, as on the phone). */
  private railKey(): RailKey { return this.viewName === "claims" ? "checks" : this.viewName; }

  /** v0.11 view list: "▶ ANSWER" for the current view, "CONCEPTS ②" for unseen items elsewhere. */
  private composeRail(): string {
    const current = this.railKey();
    return RAIL_ROWS.map(key => {
      const name = key === "qa" ? this.askLabel() : key === "summary" ? this.summaryLabel() : RAIL_LABEL[key];
      if (key === current) return ellipsize(`▶ ${name}`, HUD_LINE_WIDTH.rail);
      const count = this.unseen[key];
      const badge = !count ? "" : key === "summary" ? " ●" : ` ${CIRCLED[Math.min(count, CIRCLED.length) - 1]}`;
      return `${ellipsize(name, HUD_LINE_WIDTH.rail - hudTextWidth(badge))}${badge}`;
    }).join("\n");
  }
  /** Unseen counts by rail row (for tests, QA and the phone mirror). */
  public get unseenCounts(): Readonly<Record<RailKey, number>> { return { ...this.unseen }; }

  /** v0.10: the splash art fills the BODY while not connected; its text sits on the last line. */
  private splashActive(): boolean {
    if (!this.imagesOn || this.menu) return false;
    const status = this.glasses.status;
    return !(ACTIVE.includes(status) || status === "failed");
  }

  private inactiveView(): BodyView {
    const view = this.inactiveText();
    if (!this.splashActive()) return view;
    // The splash image covers BODY lines 1-5 (y 44..172): keep one short line under it.
    const last = oneLine(view.text.split("\n\n").at(-1) ?? "");
    return { ...view, text: `${"\n".repeat(BODY_LINES - 1)}${ellipsize(last, HUD_LINE_WIDTH.body)}` };
  }

  private inactiveText(): BodyView {
    switch (this.glasses.status) {
      case "connecting": case "authorizing":
        return { label: "HELIX", status: "connecting…", text: "Connecting…\n\nStarting the conversation session." };
      case "stopped": case "exited":
        if (this.glasses.resumePrompt) return this.resumeView();
        return { label: "HELIX", status: "stopped", text: "Session ended.\n\nDouble-tap: menu ▶ Connect to start again." };
      default:
        if (this.glasses.resumePrompt) return this.resumeView();
        return { label: "HELIX", status: "not connected", text: "Helix is ready.\n\nOn your phone: add your API key, tap Connect." };
    }
  }

  private resumeView(): BodyView {
    const raw = oneLine(this.glasses.resumePrompt ?? ""), connect = /tap to connect\.?$/iu.test(raw);
    const prompt = raw.replace(/\s*·\s*tap to (?:resume|connect)\.?$/iu, "");
    return { label: "HELIX", status: connect ? "not connected" : "paused", text: `${prompt}${/[.!?]$/u.test(prompt) ? "" : "."}\n\n▶ Tap to ${connect ? "connect" : "resume"}.` };
  }

  /** Header hint while the menu is open; on the ambient display double-tap hides the whole HUD. */
  private menuHint(): string {
    return this.ambientSession() && !this.menu?.idle ? "tap: select · double: hide" : "tap: select · double: close";
  }

  private menuView(): BodyView {
    const menu = this.menu!;
    const width = HUD_LINE_WIDTH.body;
    const first = Math.max(0, Math.min(menu.selection - 2, menu.items.length - BODY_LINES));
    const lines = menu.items.slice(first, first + BODY_LINES).map((item, offset) =>
      ellipsize(`${first + offset === menu.selection ? "▶ " : indent(hudTextWidth("▶ "))}${item.label}`, width));
    return { label: menu.kind === "mode" ? "MODE" : "MENU", status: this.menuHint(), text: lines.join("\n"), selection: menu.selection };
  }

  private bodyView(): BodyView {
    switch (this.viewName) {
      case "live": return this.liveView();
      case "answer": return this.answerView();
      case "qa": return this.qaView();
      case "concepts": return this.conceptsView();
      case "claims": return this.claimsView();
      case "summary": return this.summaryView();
      case "checks": return this.checksView();
    }
  }

  private liveView(): BodyView {
    const glasses = this.glasses;
    if (glasses.status === "failed") {
      return { label: "LIVE", text: `Problem: ${oneLine(glasses.error ?? "Helix stopped.")}\n\nCheck the phone, then tap to try again.` };
    }
    const items = this.ordered(["concept", "conflict", "ask", "verification", "fact-check", "fact", "todo"]);
    if (!items.length) {
      const text = glasses.status === "listening"
        ? "Listening…\n\nConcepts, lookups, claims and\nquestions appear as people talk."
        : "Mic is off.\n\nHold to talk, or start listening\non your phone or in the menu.";
      return { label: "LIVE", text };
    }
    const [newest, ...older] = items;
    const room = older.length ? 4 : BODY_LINES;
    const head = fitLines(clean(newest!.live), room, HUD_LINE_WIDTH.body);
    const lines = [...head];
    const left = BODY_LINES - head.length - 1;
    if (left > 0 && older.length) {
      lines.push("");
      for (const item of older.slice(0, left)) lines.push(ellipsize(`· ${oneLine(item.live)}`, HUD_LINE_WIDTH.body));
    }
    return { label: "LIVE", text: lines.join("\n") };
  }

  private answerView(): BodyView {
    const glasses = this.glasses;
    if (this.pager.text) {
      const total = this.pager.pageCount;
      const streaming = this.pager.isStreaming;
      const info = this.shownAnswer();
      const they = info.kind === "they", key = info.kind === "self";
      const page = wrapText(clean(this.pager.text).trim(), HUD_LINE_WIDTH.body);
      const question = they || key ? ellipsize(`${key ? "You: " : "Q: "}${oneLine(info.question ?? "")}`, HUD_LINE_WIDTH.body) : undefined;
      // "+1": another answer is waiting behind this one. Candidate mode: the answer is a reply to say.
      const waiting = this.pager.waiting, last = this.pager.pageIndex + 1 >= total;
      const close = waiting ? "tap: next answer" : this.pager.isCutOff ? "cut off · tap to close"
        : they ? `${info.reply ? "reply" : "answer"} · tap to close` : key ? "key · tap to close" : "tap to close";
      return { label: they ? (info.reply ? "◆ YOUR REPLY" : "◆ THEY ASKED") : key ? "§ ANSWER KEY" : VIEW_LABEL.answer,
        position: `${this.pager.pageIndex + 1}/${streaming ? "…" : total}${waiting ? ` +${waiting}` : ""}`,
        status: streaming ? "answering" : !last ? "swipe ↓ more" : close,
        text: [...(question ? [question] : []), ...page].join("\n") };
    }
    if (glasses.manualPending) {
      const speaker = glasses.question?.speaker;
      const about = speaker === "Local context" ? "About the last few sentences."
        : speaker === "Whole conversation" ? "Using the whole conversation."
          : glasses.question?.text ? `Q: ${oneLine(glasses.question.text)}` : "";
      return { label: VIEW_LABEL.answer, status: "thinking", text: `Thinking…${about ? `\n\n${about}` : ""}` };
    }
    const pages = this.recallPages();
    if (!pages.length) {
      return { label: VIEW_LABEL.answer, text: "No answer yet.\n\nTap: ask about the last few lines.\nMenu (double-tap): the whole talk." };
    }
    const index = Math.min(this.cursor.answer, pages.length - 1);
    // A finished answer recalled later is labelled with its age, so it is not read as the current one.
    const seenAt = this.answerSeenAt.get(this.lastAnswer()?.id ?? "");
    const age = seenAt === undefined ? "" : ageText(this.now() - seenAt);
    return { label: VIEW_LABEL.answer, position: `${index + 1}/${pages.length}`, status: age ? `last · ${age}` : "last answer",
      text: wrapText(clean(pages[index]!).trim(), HUD_LINE_WIDTH.body).join("\n") };
  }

  /** Questions the wearer could ask the other party; the highlighted one is the prompt to say. */
  private qaView(): BodyView {
    const suggestions = this.suggestions();
    if (!suggestions.length) {
      return { label: this.askLabel(), text: modeProfile(this.glasses.mode).presets.suggestions || this.snapshot?.suggestions.length
        ? "Nothing to say yet.\n\nPrompts for you appear here\nas the talk develops."
        : "Suggestions are off in this mode.\n\nDouble-tap: menu ▶ Mode to change." };
    }
    // On screen here: these do not pop up again on the ambient display.
    for (const suggestion of suggestions) this.suggestionsCued.add(questionKey(suggestion.question));
    const selected = Math.min(this.cursor.qa, suggestions.length - 1);
    const room = BODY_LINES - (suggestions.length - 1);
    const lines: string[] = [];
    suggestions.forEach((suggestion, index) => {
      const marker = `${CIRCLED[index] ?? index + 1} `;
      // Candidate mode: "Q:" marks a question the other side may ask next (tap for a reply to say).
      const question = `${theyMayAsk(suggestion) ? "Q: " : ""}${oneLine(suggestion.question)}`;
      const lead = hudTextWidth("▶ ");
      if (index === selected) {
        const hang = indent(lead + hudTextWidth(marker));
        const wrapped = fitLines(question, room, HUD_LINE_WIDTH.body - Math.max(hudTextWidth(`▶ ${marker}`), hudTextWidth(hang)));
        wrapped.forEach((line, row) => lines.push(row ? `${hang}${line}` : `▶ ${marker}${line}`));
      } else {
        lines.push(ellipsize(`${indent(lead)}${marker}${question}`, HUD_LINE_WIDTH.body));
      }
    });
    return { label: this.askLabel(), position: `${selected + 1}/${suggestions.length}`, status: "say it · tap: answer", text: lines.join("\n") };
  }

  /** Verdict lines for a verify target: pending, result (word + summary) or nothing. */
  private verdictLines(id: string, room: number): { lines: string[]; status: string } {
    const state = this.verifyState(id);
    if (state.pending) return { lines: ["Verifying…"], status: "verifying…" };
    const result = state.result;
    if (!result) return { lines: [], status: "click: verify" };
    const summary = oneLine(result.summary);
    const head = ellipsize(`${verdictLine(result)}${result.sources.length ? ` · ${result.sources.length} source${result.sources.length > 1 ? "s" : ""}` : ""}`, HUD_LINE_WIDTH.body);
    return { lines: [head, ...fitLines(summary, Math.max(0, room - 1), HUD_LINE_WIDTH.body)],
      status: result.status === "unavailable" ? "click: retry" : "verified" };
  }

  private conceptsView(): BodyView {
    const concepts = this.conceptList();
    if (!concepts.length) {
      return { label: VIEW_LABEL.concepts, text: "No concepts yet.\n\nTechnical terms are explained\nhere as they come up." };
    }
    const index = Math.min(this.cursor.concepts, concepts.length - 1);
    const concept = concepts[index]!;
    const term = ellipsize(oneLine(concept.term), HUD_LINE_WIDTH.body);
    const verdict = this.verdictLines(concept.id, 2);
    const explanation = fitLines(oneLine(concept.explanation), BODY_LINES - 1 - verdict.lines.length, HUD_LINE_WIDTH.body);
    return { label: VIEW_LABEL.concepts, position: `${index + 1}/${concepts.length}`, status: verdict.status,
      text: [term, ...explanation, ...verdict.lines].join("\n") };
  }

  private claimsView(): BodyView {
    const claims = this.claimList();
    if (!claims.length) {
      return { label: VIEW_LABEL.claims, text: "No claims yet.\n\nNumbers, dates and facts people\nstate appear here to verify." };
    }
    const index = Math.min(this.cursor.claims, claims.length - 1);
    const claim = claims[index]!;
    const who = claim.speaker ? speakerTag({ label: claim.speaker, speaker: claim.speaker }) : "";
    const verdict = this.verdictLines(claim.id, 3);
    const room = BODY_LINES - verdict.lines.length - (verdict.lines.length ? 0 : 1);
    const text = fitLines(`${who}“${oneLine(claim.text)}”`, Math.max(1, room), HUD_LINE_WIDTH.body);
    const footer = verdict.lines.length ? verdict.lines
      : [claim.scope === "conversation" ? "▶ click: verify against the talk" : "▶ click: verify on the web"];
    return { label: VIEW_LABEL.claims, position: `${index + 1}/${claims.length}`, status: verdict.status, text: [...text, ...footer].join("\n") };
  }

  private summaryView(): BodyView {
    const pages = this.summaryPages(), label = this.summaryLabel();
    if (!pages.length) {
      if (this.noteTaking()) return { label, text: "No to-dos or notes yet.\n\nAction items and notes appear\nhere as people talk." };
      return { label: VIEW_LABEL.summary, text: "No summary yet.\n\nA rolling summary appears after\nabout a minute of conversation." };
    }
    const index = Math.min(this.cursor.summary, pages.length - 1);
    return { label, position: `${index + 1}/${pages.length}`, text: pages[index]!.join("\n") };
  }

  private checksView(): BodyView {
    const checks = this.checkList();
    if (!checks.length) {
      return { label: VIEW_LABEL.checks, text: "No checks yet.\n\nConflicts, fact checks and your\nverified claims show up here." };
    }
    const index = Math.min(this.cursor.checks, checks.length - 1);
    return { label: VIEW_LABEL.checks, position: `${index + 1}/${checks.length}`, text: checks[index]!.check ?? checks[index]!.live };
  }

  /** Right side of the header: mic clock / gesture feedback, view status, mode tag. */
  private composeStatus(body: BodyView, active: boolean): string {
    const parts: string[] = [];
    if (!active) {
      if (body.status) parts.push(body.status);
    } else if (this.glasses.status === "failed" && !this.menu) {
      parts.push("! ERROR");
    } else if (this.menu) {
      // MENU: the gesture hint matters more than the clock in the narrow status area.
      if (body.status) parts.push(body.status);
    } else {
      const problem = this.problemText();
      if (problem) parts.push(problem);
      const interaction = this.interactionText();
      if (interaction) parts.push(interaction);
      else parts.push(this.micText());
      if (body.status) parts.push(body.status);
      else if (this.viewName === "live" && this.fresh > 0) parts.push(`${this.fresh > 9 ? "9+" : this.fresh} new`);
    }
    // Without images (no badge) the mode is a text tag that stays visible: the rest is shortened first.
    const mode = modeProfile(this.glasses.mode);
    const tag = this.glasses.mode && !this.imagesOn && mode.id !== "general" ? mode.short : "";
    const room = HUD_LINE_WIDTH.status - (tag ? hudTextWidth(` · ${tag}`) : 0);
    const head = parts.length ? ellipsize(parts.join(" · "), room) : "";
    return [head, tag].filter(Boolean).join(" · ");
  }

  private micText(): string {
    if (this.glasses.status !== "listening") return "○ MIC OFF";
    const elapsed = Math.max(0, Math.floor((this.now() - (this.sessionStart ?? this.now())) / 1000));
    const hours = Math.floor(elapsed / 3600);
    // Minute resolution: a per-second clock rewrote the header (BLE) and the phone mirror every second.
    const clock = hours ? `${hours}h${pad2(Math.floor(elapsed / 60) % 60)}m` : `${Math.floor(elapsed / 60)}m`;
    return `● ${clock}`;
  }

  /** Gesture feedback from the controller, shortened; transient ones expire. */
  private interactionText(): string | undefined {
    const interaction = this.interaction;
    if (!interaction) return undefined;
    const text = interaction.text;
    if (/HOLDING/u.test(text)) return "● HOLD · release to send";
    const rehearsal = /^REHEARSAL (\d+\/\d+)/u.exec(text);
    if (rehearsal) return `REHEARSAL ${rehearsal[1]}`;
    if (/^(ANSWER \/ RECEIVING|MIC ON|PAUSED \/)/u.test(text)) return undefined;
    if (this.now() - interaction.at > 4000) return undefined;
    if (/^SENT/u.test(text)) return "SENT";
    if (/^NO NEW AUDIO/u.test(text)) return "no new audio";
    if (/STOP/u.test(text)) return "stopping";
    return oneLine(text).toLowerCase();
  }

  /** Continuous caption: finals heard within the hold window + the live partial, never blank between sentences. */
  private composeCaption(active: boolean): string {
    if (!active) return HINT_CAPTION;
    const feed = this.snapshot?.feed ?? [];
    const now = this.now();
    const holdMs = this.options.captionHoldMs ?? 30000;
    const segments: CaptionSegment[] = [];
    let latest = 0;
    let partial: FeedItem | undefined;
    for (const item of feed) {
      if (item.kind !== "transcript" || !item.body.trim()) continue;
      if (item.id === PARTIAL_ID) { partial = item; continue; }
      const seenAt = this.finalsSeen.get(item.id) ?? now;
      if (now - seenAt > holdMs) continue;
      latest = Math.max(latest, seenAt);
      segments.push({ tag: speakerTag(item), text: clean(item.body) });
    }
    if (partial) { segments.push({ tag: speakerTag(partial), text: clean(partial.body), partial: true }); latest = Math.max(latest, this.partialSeenAt || now); }
    if (!segments.length || now - latest > holdMs) return HINT_CAPTION;
    // Bound the work: the last ~12 segments are always more than two caption lines.
    return rollingCaption(segments.slice(-12), 2, HUD_LINE_WIDTH.caption).join("\n") || HINT_CAPTION;
  }

  /* ---------------- v0.10 images ---------------- */

  /** True when this HUD draws pixel-art images (bridge support, not disabled after failures). */
  public get imagesOn(): boolean {
    return !this.imagesDisabled && typeof this.bridge.updateImageRawData === "function";
  }
  /** What each image container should show now (for tests / QA). */
  public get images(): Readonly<Record<string, string>> { return Object.fromEntries(this.imageWanted); }

  private mascotState(): MascotState {
    const status = this.glasses.status;
    if (status === "failed") return "error";
    if (!ACTIVE.includes(status)) return status === "connecting" || status === "authorizing" ? "thinking" : "idle";
    // v0.11.3: images change only on a switch (connect, listen/pause, mode, error), never per answer.
    // The thinking/speaking animation sent an image every few seconds during a conversation, on a
    // link that also carries the microphone audio and the text; that traffic can starve the glasses.
    if (this.options.mascotAnimation) {
      if (this.glasses.manualPending && !this.pager.text) return "thinking";
      if (this.pager.text && this.pager.isStreaming) return "speaking";
      if (this.items.some(item => item.kind === "ask" && /…$/u.test(item.live))) return "thinking";
    }
    return status === "listening" ? "listening" : "idle";
  }

  private updateImages(): void {
    if (!this.imagesOn || !this.initialized) return;
    const mode = modeProfile(this.glasses.mode).id;
    this.imageWanted.set("mascot", `mascot:${this.mascotState()}`);
    this.imageWanted.set("badge", `badge:${mode}`);
    if (this.pageSplash) this.imageWanted.set("splash", `splash:${mode}`); else this.imageWanted.delete("splash");
    this.pumpImages();
  }

  /** One image at a time (SDK rule), latest wanted image wins, mascot at most every mascotIntervalMs. */
  private pumpImages(): void {
    if (this.imageInFlight || this.inFlight || this.disposed || !this.initialized || this.rebuilding || !this.imagesOn) return;
    if (this.page === "hud" && this.pageAmbient) return; // the blank ambient page has no image containers
    const now = this.now();
    if (this.nextWriteAt > now) {
      if (!this.imageTimer) this.imageTimer = setTimeout(() => { this.imageTimer = undefined; this.pumpImages(); }, this.nextWriteAt - now);
      return;
    }
    if (this.slowUntil > now) { // link is slow: text only until it recovers
      if (!this.imageTimer) this.imageTimer = setTimeout(() => { this.imageTimer = undefined; this.pumpImages(); }, this.slowUntil - now);
      return;
    }
    let next: ImageKey | undefined, wait = Infinity;
    for (const key of ["badge", "splash", "mascot"] as const) {
      if (key === "splash" && (this.page !== "hud" || !this.pageSplash)) continue;
      const want = this.imageWanted.get(key);
      if (!want || this.imagesSent.get(key) === want) continue;
      const due = key === "mascot" && this.imagesSent.has(key) ? (this.imageSentAt.get(key) ?? 0) + (this.options.mascotIntervalMs ?? 8000) : 0;
      if (due > now) { wait = Math.min(wait, due - now); continue; }
      next = key; break;
    }
    if (!next) {
      if (wait < Infinity && !this.imageTimer) this.imageTimer = setTimeout(() => { this.imageTimer = undefined; this.pumpImages(); }, wait);
      return;
    }
    const key = next, want = this.imageWanted.get(key)!, generation = this.generation;
    const container = HUD_IMAGES[key];
    const operation = (async () => {
      let ok = false;
      const startedAt = this.now();
      try {
        const result = await withDeadline(this.bridge.updateImageRawData!(new ImageRawDataUpdate({ containerID: container.containerID, containerName: container.containerName, imageData: this.imageBytes(want) })),
          PAGE_WRITE_DEADLINE_MS, `${container.containerName} image update`);
        ok = typeof result !== "string" || ImageRawDataUpdateResult.isSuccess(ImageRawDataUpdateResult.normalize(result));
        if (generation === this.generation) this.writeAnswered();
      } catch (error) { ok = false; if (error instanceof BridgeTimeoutError && generation === this.generation) this.writeUnanswered("image", error); }
      // Even docs: `success` means accepted, not displayed; a full-size (288x144) image takes about
      // 800 ms to reach the glasses and 100 ms is the floor between image sends.
      const airtime = this.writeGap ? 100 + Math.round(800 * (container.width * container.height) / (288 * 144)) : 0;
      this.nextWriteAt = this.now() + Math.max(this.writeGap, airtime);
      this.noteLatency("image", this.now() - startedAt);
      if (generation !== this.generation) return;
      this.imageSentAt.set(key, this.now());
      this.imagesSent.set(key, want); // a failing image is not retried in a loop
      if (ok) this.imageFailures = 0;
      else if (++this.imageFailures >= 3) this.imagesDisabled = true; // host cannot draw our images: text-only HUD
    })().finally(() => {
      if (this.imageInFlight === operation) this.imageInFlight = undefined;
      if (!this.disposed) { this.schedule(); this.pumpImages(); }
    });
    this.imageInFlight = operation;
  }

  private imageBytes(key: string): Uint8Array {
    const cached = this.imageCache.get(key);
    if (cached) return cached;
    const bytes = encodeGrayPng(renderImage(key));
    if (this.imageCache.size > 24) this.imageCache.delete(this.imageCache.keys().next().value!);
    this.imageCache.set(key, bytes);
    return bytes;
  }

  /* ---------------- mirror ---------------- */

  private publishMirror(): void {
    if ((!this.options.onMirror && !this.mirrorListener) || this.disposed) return;
    const mirror = this.mirror;
    const key = JSON.stringify({ ...mirror, updatedAt: 0 });
    if (key === this.mirrorKey) return;
    this.mirrorKey = key;
    if (this.mirrorQueued) return;
    this.mirrorQueued = true;
    // Asynchronous: the listener feeds the presentation, which re-renders this HUD.
    queueMicrotask(() => {
      this.mirrorQueued = false;
      if (this.disposed) return;
      const mirror = this.mirror;
      try { this.options.onMirror?.(mirror); this.mirrorListener?.(mirror); } catch (error) { this.reportRenderError(error); }
    });
  }

  /* ---------------- transport ---------------- */

  private hudPage(frame: HudFrame, splash = this.splashActive(), ambient = false): Partial<CreateStartUpPageContainer> {
    if (ambient) {
      // Blank ambient page: the same text containers (BODY still the one event-capture container), no frame border, no images.
      const panels = PANEL_ORDER.map(key => new TextContainerProperty(panelProperty(key, panelText(frame, key))));
      return { containerTotalNum: panels.length, textObject: panels, menuObject: osMenu() };
    }
    const textObject = [new TextContainerProperty(frameProperty()), ...PANEL_ORDER.map(key => new TextContainerProperty(panelProperty(key, panelText(frame, key))))];
    // Declaration order is drawing order: images after the BODY so the splash draws on top of it.
    const keys = splash ? (["mascot", "badge", "splash"] as const) : (["mascot", "badge"] as const);
    const imageObject = this.imagesOn ? keys.map(key => new ImageContainerProperty({ ...HUD_IMAGES[key] })) : [];
    return { containerTotalNum: textObject.length + imageObject.length, textObject, ...(imageObject.length ? { imageObject } : {}), menuObject: osMenu() };
  }

  /** MENU page: the same page with the native list in place of the view list (the list captures events). */
  private menuPage(frame: HudFrame): Partial<RebuildPageContainer> {
    const items = (this.menu?.items ?? HUD_MENU_ITEMS).map(item => item.label);
    const list = HUD_MENU_LIST;
    const imageObject = this.imagesOn ? (["mascot", "badge"] as const).map(key => new ImageContainerProperty({ ...HUD_IMAGES[key] })) : [];
    const textObject = [new TextContainerProperty(frameProperty()),
      ...(["body", "header", "status", "caption", "mode"] as const).map(key => new TextContainerProperty({ ...panelProperty(key, panelText(frame, key)), isEventCapture: 0 }))];
    return {
      containerTotalNum: textObject.length + 1 + imageObject.length,
      ...(imageObject.length ? { imageObject } : {}),
      textObject,
      listObject: [new ListContainerProperty({
        containerID: list.containerID, containerName: list.containerName, xPosition: list.xPosition, yPosition: list.yPosition,
        width: list.width, height: list.height, borderWidth: list.borderWidth, borderColor: list.borderColor,
        borderRadius: list.borderRadius, paddingLength: list.paddingLength, isEventCapture: list.isEventCapture,
        itemContainer: new ListItemContainerProperty({ itemCount: items.length, itemWidth: list.itemWidth, isItemSelectBorderEn: 1, itemName: items }),
      })],
      menuObject: osMenu(), // rebuild without menuObject clears the OS context menu
    };
  }

  /**
   * Full page swap, serialized with container writes. The latest menu state wins, so a queued
   * swap after a quick open/close is skipped (`force` = lifecycle re-push: always redraw).
   * Falls back to the text menu in BODY when the list page is rejected.
   */
  private rebuild(_kind: "hud" | "menu", force: boolean): Promise<boolean> {
    const generation = this.generation;
    const previous = this.rebuilding ?? Promise.resolve(true);
    const operation: Promise<boolean> = previous.catch(() => false).then(async () => {
      if (this.inFlight) await this.inFlight.catch(() => undefined);
      if (this.imageInFlight) await this.imageInFlight.catch(() => undefined);
      const gap = this.nextWriteAt - this.now();
      if (gap > 0) await new Promise(done => setTimeout(done, gap));
      if (!this.initialized || generation !== this.generation || !this.bridge.rebuildPageContainer) return false;
      const target = this.menu?.native ? "menu" : "hud";
      const splash = target === "hud" && this.splashActive();
      const ambient = target === "hud" && this.ambientActive();
      if (!force && target === this.page && (target === "menu" || (splash === this.pageSplash && ambient === this.pageAmbient))) return true;
      this.frameValue = this.compose();
      const frame = this.frameValue;
      let ok = false;
      const startedAt = this.now();
      try {
        ok = await withDeadline(this.bridge.rebuildPageContainer(new RebuildPageContainer(target === "menu" ? this.menuPage(frame) : this.hudPage(frame, splash, ambient))),
          PAGE_WRITE_DEADLINE_MS, "page rebuild");
        // An accepted page is the full re-push: nothing more is owed.
        if (generation === this.generation && ok) { this.repushOwed = false; this.writeAnswered(); }
      } catch (error) {
        if (error instanceof BridgeTimeoutError) { if (generation === this.generation) this.writeUnanswered("page", error); }
        else this.reportRenderError(error);
      }
      recordDiagnostic("glasses-page", `${force ? "re-push" : target === "menu" ? "menu" : ambient !== this.pageAmbient ? (ambient ? "ambient" : "wake") : splash !== this.pageSplash ? "connect/disconnect" : "menu close"} · ${this.lastGesture || "-"} · ${ok ? "ok" : "rejected"} ${((this.now() - startedAt) / 1000).toFixed(1)} s`);
      this.nextWriteAt = this.now() + (this.writeGap ? Math.max(300, this.writeGap * 3) : 0); // a new page needs longer to settle
      this.noteLatency("page", this.now() - startedAt);
      if (generation !== this.generation) return false;
      if (!ok) {
        if (target === "menu" && this.menu) { this.menu.native = false; this.page = "hud"; }
        this.blockedUntil = Math.max(this.blockedUntil, this.now() + 1000);
        return false;
      }
      this.page = target;
      this.pageSplash = splash;
      this.pageAmbient = ambient;
      this.rebuildAt = this.now();
      const at = this.now();
      for (const key of PANEL_ORDER) {
        if (key === "views" && target === "menu") continue;
        this.sent.set(key, panelText(frame, key)); this.sentAt.set(key, at);
        this.sentSeq.set(key, this.writeSeq); this.awaited.delete(key); // a late answer to an older text write no longer counts
      }
      if (target === "menu") this.sent.set("views", frame.views); // the list is in its place
      this.imagesSent.clear(); // rebuilt image containers start empty
      return true;
    }).finally(() => {
      if (this.rebuilding === operation) this.rebuilding = undefined;
      if (!this.disposed) this.refresh();
    });
    this.rebuilding = operation;
    return operation;
  }

  private startTicker(): void {
    const tickMs = this.options.tickMs ?? 5000;
    if (tickMs <= 0 || this.ticker) return;
    this.ticker = setInterval(() => {
      if (!this.initialized || this.disposed) return;
      try { this.refresh(); } catch (error) { this.reportRenderError(error); }
    }, tickMs);
  }

  /** Containers that exist on the current page and differ from what was sent. */
  private dirty(): PanelKey[] {
    return PANEL_ORDER.filter(key => !(key === "views" && this.page === "menu") && this.sent.get(key) !== panelText(this.frameValue, key));
  }

  private dueAt(key: PanelKey): number {
    const since = this.dirtySince.get(key) ?? this.now();
    let interval = this.slowUntil > this.now() ? Math.max(this.intervals[key], key === "caption" ? SLOW_CAPTION_MS : SLOW_PANEL_MS) : this.intervals[key];
    // A streaming answer changes at every token: a few body writes per page are enough.
    if (key === "body" && this.pager.text && this.pager.isStreaming) interval = Math.max(interval, STREAMING_BODY_MS);
    const due = Math.max(since + this.debounce, (this.sentAt.get(key) ?? 0) + interval, this.blockedUntil);
    // This very text is on its way in a write that passed its deadline: wait for the late answer first.
    const awaited = this.awaited.get(key);
    return awaited && awaited.content === panelText(this.frameValue, key) ? Math.max(due, awaited.until) : due;
  }

  private schedule(): void {
    if (!this.initialized || this.timer || this.inFlight || this.rebuilding || this.imageInFlight) return;
    const dirty = this.dirty();
    if (!dirty.length) return;
    const due = Math.max(this.nextWriteAt, Math.min(...dirty.map(key => this.dueAt(key))));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.inFlight || this.imageInFlight || this.rebuilding) return; // whichever is in flight reschedules when it ends
      void this.send(false);
    }, Math.max(0, due - this.now()));
  }

  private send(force: boolean): Promise<void> {
    const operation = this.writePanels(this.generation, force).finally(() => {
      if (this.inFlight === operation) this.inFlight = undefined;
      this.schedule();
      if (!this.inFlight && !this.disposed) this.pumpImages();
    });
    this.inFlight = operation;
    return operation;
  }

  private async writePanels(generation: number, force: boolean): Promise<void> {
    for (const key of PANEL_ORDER) {
      if (!this.initialized || generation !== this.generation || this.rebuilding) return;
      if (key === "views" && this.page === "menu") continue; // the view list is replaced by the MENU list
      const content = panelText(this.frameValue, key);
      if (this.sent.get(key) === content) continue;
      if (!force && this.dueAt(key) > this.now()) continue;
      const panel = HUD_PANELS[key];
      try {
        const gap = this.nextWriteAt - this.now();
        if (gap > 0) {
          await new Promise(done => setTimeout(done, gap));
          if (!this.initialized || generation !== this.generation || this.rebuilding) return;
          if (panelText(this.frameValue, key) !== content) continue; // changed while waiting: next pass sends the newer text
        }
        const startedAt = this.now();
        const seq = ++this.writeSeq;
        this.awaited.delete(key); // a newer write of this container replaces the one still waited for
        const call = this.bridge.textContainerUpgrade(new TextContainerUpgrade({
          containerID: panel.containerID, containerName: panel.containerName, content,
        }));
        let accepted: boolean;
        try {
          accepted = await withDeadline(call, TEXT_WRITE_DEADLINE_MS, `${panel.containerName} text update`);
        } catch (error) {
          if (error instanceof BridgeTimeoutError && generation === this.generation) this.awaitLateAnswer(key, content, seq, startedAt, call, generation);
          throw error;
        }
        this.nextWriteAt = this.now() + this.writeGap;
        this.noteLatency("text", this.now() - startedAt);
        if (generation !== this.generation) return;
        if (!accepted) throw new Error(`G2 rejected the ${panel.containerName} text update`);
        this.sent.set(key, content);
        this.sentAt.set(key, this.now());
        this.sentSeq.set(key, seq);
        if (panelText(this.frameValue, key) === content) this.dirtySince.delete(key);
        else this.dirtySince.set(key, this.now());
        if (this.writeAnswered()) return; // the re-push carries every container
      } catch (error) {
        if (generation !== this.generation) return;
        // Back off one second before retrying any container (longer after an unanswered write).
        this.blockedUntil = Math.max(this.blockedUntil, this.now() + 1000);
        if (error instanceof BridgeTimeoutError) this.writeUnanswered("text", error);
        this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
  }

  /**
   * A text write passed its deadline. The call cannot be cancelled and on a link that is steadily slower
   * than the deadline it still arrives: the same text is held back until TEXT_LATE_ANSWER_MS after the
   * write started (the queue goes on with the other containers after the back-off), and an "accepted"
   * that comes late marks the container as sent. Without this the first changed container would be sent
   * again after every back-off and the ones behind it never.
   */
  private awaitLateAnswer(key: PanelKey, content: string, seq: number, startedAt: number, call: Promise<boolean>, generation: number): void {
    this.awaited.set(key, { content, seq, until: startedAt + TEXT_LATE_ANSWER_MS });
    const settled = (accepted: boolean): void => {
      if (this.awaited.get(key)?.seq === seq) this.awaited.delete(key);
      if (this.disposed || generation !== this.generation) return;
      if (!accepted || !this.initialized || seq <= (this.sentSeq.get(key) ?? 0)) { this.schedule(); return; }
      const now = this.now();
      this.sent.set(key, content);
      this.sentAt.set(key, now);
      this.sentSeq.set(key, seq);
      if (panelText(this.frameValue, key) === content) this.dirtySince.delete(key);
      else if (!this.dirtySince.has(key)) this.dirtySince.set(key, now);
      recordDiagnostic("bridge-timeout", `${HUD_PANELS[key].containerName} text update answered late · ${((now - startedAt) / 1000).toFixed(1)} s`);
      // The link answers: the back-off ends, and with no write left unknown no re-push is owed.
      this.timeouts = 0;
      if (this.blockedUntil <= this.timeoutUntil) this.blockedUntil = Math.min(this.blockedUntil, now);
      this.timeoutUntil = 0;
      this.unknownWrites = Math.max(0, this.unknownWrites - 1);
      if (!this.unknownWrites) this.repushOwed = false;
      if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
      if (this.timer) clearTimeout(this.timer); // it was set for the end of the back-off
      this.timer = undefined;
      try { this.refresh(); } catch (cause) { this.reportRenderError(cause); }
    };
    call.then(settled, () => settled(false));
  }

  /**
   * A glasses write got no answer within its deadline: it counts as failed (nothing is marked as sent;
   * only a text write may still be answered late, see awaitLateAnswer). All writes pause for a growing back-off, so retries do not add a call per
   * deadline to a host that is already behind, and the HUD goes into its lighter mode.
   */
  private writeUnanswered(kind: "text" | "image" | "page", error: BridgeTimeoutError): void {
    const now = this.now();
    const wait = writeTimeoutBackoff(++this.timeouts);
    this.timeoutUntil = now + wait;
    this.blockedUntil = Math.max(this.blockedUntil, this.timeoutUntil);
    this.repushOwed = true;
    this.unknownWrites += 1;
    recordDiagnostic("bridge-timeout", `${error.message} · next glasses write in ${wait / 1000} s`);
    if (kind === "text") this.noteLatency(kind, TEXT_WRITE_DEADLINE_MS); // image and page writes report their own duration
    // Page swaps wait for the back-off too; this wakes them (and the text queue) when it is over.
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = setTimeout(() => {
      this.timeoutTimer = undefined;
      if (this.disposed) return;
      try { this.refresh(); } catch (cause) { this.reportRenderError(cause); }
    }, wait);
  }

  /** The glasses answered a write. After unanswered ones, redraw the whole page once (returns true then). */
  private writeAnswered(): boolean {
    this.timeouts = 0;
    this.unknownWrites = 0;
    if (!this.repushOwed) return false;
    this.repushOwed = false;
    if (this.disposed || !this.initialized || !this.bridge.rebuildPageContainer) return false;
    this.lastGesture = "after unanswered write";
    void this.rebuild(this.menu?.native ? "menu" : "hud", true);
    return true;
  }

  /** A glasses write took `ms`. Slow answers put the HUD in a lighter mode for SLOW_HOLD_MS. */
  private noteLatency(kind: "text" | "image" | "page", ms: number): void {
    if (ms < SLOW_WRITE_MS) return;
    const now = this.now();
    const first = this.slowUntil <= now;
    this.slowUntil = now + SLOW_HOLD_MS;
    if (kind === "image" && ++this.slowImages >= 2 && !this.imagesDisabled) {
      this.imagesDisabled = true; // twice slow: the link cannot carry our images; text-only HUD for this session
      recordDiagnostic("glasses-backoff", `images off for this session · image write ${(ms / 1000).toFixed(1)} s`);
      return;
    }
    if (first || now - this.lastSlowLog > 10_000) {
      this.lastSlowLog = now;
      recordDiagnostic("glasses-backoff", `${kind} write ${(ms / 1000).toFixed(1)} s · images paused, captions slowed for ${SLOW_HOLD_MS / 1000} s`);
    }
  }
  /** True while the HUD is in its lighter mode after slow glasses writes (tests, diagnostics). */
  public get linkSlow(): boolean { return this.slowUntil > this.now(); }

  /** Setup → Diagnostics: pause between glasses writes (0 = none). Takes effect on the next write. */
  public setWriteGap(ms: number): void { this.writeGap = Math.max(0, Math.min(5000, Number.isFinite(ms) ? ms : WRITE_GAP_MS)); }
  public get writeGapMs(): number { return this.writeGap; }

  /** Setup switch: pixel art on the glasses (off = text-only HUD, fewer and smaller glasses writes). */
  public setImagesEnabled(enabled: boolean): void {
    if (this.disposed || enabled === !this.imagesDisabled) return;
    this.imagesDisabled = !enabled;
    if (enabled) { this.slowImages = 0; this.imageFailures = 0; }
    if (this.initialized) { this.lastGesture = enabled ? "images:on" : "images:off"; void this.rebuild(this.menu?.native ? "menu" : "hud", true); }
  }

  private reportRenderError(error: unknown): void {
    (this.options.onRenderError ?? ((cause: unknown) => console.warn("Helix HUD render failed", cause)))(error);
  }
}

function resultSig(result?: VerificationResult): string {
  return result ? `${result.status}|${result.summary}|${result.checkedAt}` : "";
}

function conceptTarget(concept: CopilotConcept): string {
  return `${oneLine(concept.term)}: ${oneLine(concept.explanation)}`;
}

/** Pixel art for an image key: "mascot:<state>", "badge:<mode>", "splash:<mode>" or "splash:off". */
export function renderImage(key: string): GrayImage {
  const [kind, value = ""] = key.split(":");
  if (kind === "mascot") {
    const frames = MASCOT_FRAMES[(value in MASCOT_FRAMES ? value : "idle") as MascotState];
    return centeredImage(frames[0]!, HUD_IMAGES.mascot.width, HUD_IMAGES.mascot.height, 2);
  }
  if (kind === "badge") return centeredImage(ICONS[modeIcon(value)], HUD_IMAGES.badge.width, HUD_IMAGES.badge.height, 3, ICON_PALETTE);
  const { width, height } = HUD_IMAGES.splash;
  const image = blankImage(width, height);
  if (kind !== "splash" || value === "off") return image;
  drawBitmap(image, MASCOT_FRAMES.idle[0]!, 6, 24, 5);
  drawBitmap(image, textBitmap("HELIX"), 100, 26, 6);
  const label = modeProfile(value).label.toUpperCase();
  drawBitmap(image, ICONS[modeIcon(value)], 100, 82, 2, ICON_PALETTE);
  drawBitmap(image, textBitmap(label), 132, 88, 2, { ".": 0, k: 10 });
  return image;
}
/** Icons on glasses: bright outline, mid fill, so the shape reads at 3x on a green display. */
const ICON_PALETTE: Readonly<Record<string, number>> = Object.freeze({ ".": 0, k: 15, f: 7, w: 15, s: 4 });

function sentenceCase(text: string): string { const lower = text.toLowerCase(); return lower.charAt(0).toUpperCase() + lower.slice(1); }

function nextView(view: HudView, direction: 1 | -1): HudView {
  const index = HUD_VIEWS.indexOf(view);
  return HUD_VIEWS[(index + direction + HUD_VIEWS.length) % HUD_VIEWS.length]!;
}

function osMenu(): MenuContainerProperty {
  return new MenuContainerProperty({ menuItems: SHORTCUT_ACTIONS.map(item => new MenuItemProperty(item)) });
}

function frameProperty(): Partial<TextContainerProperty> {
  const { containerID, containerName, xPosition, yPosition, width, height, borderWidth, borderColor, borderRadius, paddingLength, textColor, isEventCapture } = HUD_FRAME;
  return { containerID, containerName, xPosition, yPosition, width, height, borderWidth, borderColor, borderRadius, paddingLength, textColor, isEventCapture, content: " " };
}

function panelProperty(key: PanelKey, content: string): Partial<TextContainerProperty> {
  const panel = HUD_PANELS[key];
  return {
    containerID: panel.containerID, containerName: panel.containerName,
    xPosition: panel.xPosition, yPosition: panel.yPosition, width: panel.width, height: panel.height,
    borderWidth: panel.borderWidth, borderColor: panel.borderColor, borderRadius: panel.borderRadius,
    paddingLength: panel.paddingLength, textColor: panel.textColor, isEventCapture: panel.isEventCapture,
    content: content || " ",
  };
}
