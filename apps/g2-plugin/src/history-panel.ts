import { sessionRecap, type HistoryEntry, type HistorySession, type RetrievedMemory } from "@helix/conversation-sdk";
import type { G2ConversationController, HistoryState } from "./controller";
import { icon, type IconName } from "./pixel-art";
import { browserTransferEnv, exportFile } from "./file-transfer";
import { renderNotebook } from "./notebook-panel";

export function safeSourceUrl(value: string): string | undefined {
  if (/[\u0000- \u007f]/u.test(value)) return;
  try { const url = new URL(value); if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.hostname) return url.href; } catch { /* untrusted source */ }
}
/** "2026-11-17" -> "17 Nov 2026" for a source chip; undefined for anything that is not a plain date. */
export function sourceDateLabel(publishedAt: string | undefined): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(publishedAt ?? "");
  if (!match) return;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month} ${match[1]}` : undefined;
}
export function sourceLink(source: { url: string; title: string; publishedAt?: string; dateSource?: string; site?: string }): HTMLAnchorElement | undefined {
  const href = safeSourceUrl(source.url); if (!href) return;
  const link = document.createElement("a"); link.href = href; link.textContent = source.title || href;
  // News search: show when the page was published, and say where that date came from.
  const date = sourceDateLabel(source.publishedAt);
  if (date) {
    const stamp = document.createElement("span"); stamp.className = "source-date";
    stamp.textContent = ` · ${source.site ? `${source.site} · ` : ""}${date}`;
    stamp.title = source.dateSource === "model" ? "Date reported by the model for this page" : "Publication date from the search results";
    link.append(stamp);
  }
  link.target = "_blank"; link.rel = "noopener noreferrer"; return link;
}
export function memoryEntryIds(entry: HistoryEntry): string[] {
  try {
    const ids: unknown = JSON.parse(entry.metadata?.memoryEntryIds ?? "[]");
    return Array.isArray(ids) && ids.length <= 50 && ids.every(id => typeof id === "string" && id.length > 0 && id.length <= 2048) ? ids : [];
  } catch { return []; }
}

/* ------------------------------------------------------------------ session knowledge */

export type KnowledgeSourceId = "helix" | "omi" | "obsidian";
export interface SessionPersonView { readonly name: string; readonly role?: string; readonly context?: string; readonly mentions?: number }
export interface SessionConcept { readonly term: string; readonly explanation: string }
export interface SessionKnowledgeView {
  readonly summary: string[];
  readonly keyFacts: string[];
  readonly people: SessionPersonView[];
  readonly concepts: SessionConcept[];
  readonly tags: string[];
}
const str = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const strings = (value: unknown): string[] =>
  typeof value === "string" ? value.split(/\n+/u).map(line => line.replace(/^\s*[-*•]\s*/u, "").trim()).filter(Boolean)
    : Array.isArray(value) ? value.map(item => typeof item === "string" ? item.trim() : str((item as { text?: unknown })?.text)).filter(Boolean) : [];

export function sessionSource(session: HistorySession): KnowledgeSourceId {
  const source = (session as { source?: string }).source;
  return source === "omi" || source === "obsidian" ? source : "helix";
}

/**
 * Reads v0.8 session knowledge (summary/keyFacts/people/concepts/tags) defensively: the SDK may
 * store strings or objects. Imported Omi overviews stand in for a missing summary.
 */
export function sessionKnowledge(session: HistorySession, entries: readonly HistoryEntry[] = []): SessionKnowledgeView {
  const record = session as HistorySession & Record<string, unknown>;
  let summary = strings(record.summary);
  if (!summary.length) {
    const overview = entries.find(entry => entry.metadata?.origin === "omi-summary" || /^omi summary$/iu.test(entry.speaker ?? ""));
    if (overview) summary = overview.text.split(/(?<=[.!?])\s+/u).map(line => cleanLineText(line)).filter(Boolean).slice(0, 5);
  }
  const people: SessionPersonView[] = [];
  const seen = new Set<string>();
  for (const item of (Array.isArray(record.people) ? record.people : []) as unknown[]) {
    const person: SessionPersonView | undefined = typeof item === "string" ? { name: item.trim() }
      : item && typeof item === "object" ? {
        name: str((item as Record<string, unknown>).name),
        ...(str((item as Record<string, unknown>).role) ? { role: str((item as Record<string, unknown>).role) } : {}),
        ...(str((item as Record<string, unknown>).context) ? { context: str((item as Record<string, unknown>).context) } : {}),
        ...(typeof (item as Record<string, unknown>).mentions === "number" ? { mentions: (item as Record<string, number>).mentions } : {}),
      } : undefined;
    const key = person?.name.toLowerCase();
    if (!person?.name || !key || seen.has(key)) continue;
    seen.add(key); people.push(person);
  }
  const concepts: SessionConcept[] = [];
  for (const item of (Array.isArray(record.concepts) ? record.concepts : []) as unknown[]) {
    if (typeof item === "string" && item.trim()) concepts.push(splitConcept(item));
    else if (item && typeof item === "object") {
      const term = str((item as Record<string, unknown>).term) || str((item as Record<string, unknown>).name);
      if (term) concepts.push({ term, explanation: str((item as Record<string, unknown>).explanation) || str((item as Record<string, unknown>).definition) });
    }
  }
  return { summary, keyFacts: strings(record.keyFacts), people, concepts, tags: strings(record.tags) };
}

/** Stored concepts are strings; "Term: explanation" (or "Term — explanation") splits into its parts. */
export function splitConcept(value: string): SessionConcept {
  const text = value.trim();
  const match = /^(.{1,60}?)\s*(?::|—|–| - )\s+(.+)$/su.exec(text);
  return match ? { term: match[1]!.trim(), explanation: match[2]!.trim() } : { term: text, explanation: "" };
}
/** Inverse of splitConcept, bounded to the store's 500-char item limit. */
export function joinConcept(term: string, explanation: string): string {
  const head = term.trim().slice(0, 60);
  return (explanation.trim() ? `${head}: ${explanation.trim()}` : head).slice(0, 500);
}

/* -------------------------------------------------------------------- clean transcript */

export type TranscriptLineKind = "speech" | "helix" | "request" | "check";
export interface TranscriptLine {
  readonly speaker: string;
  readonly text: string;
  readonly kind: TranscriptLineKind;
  readonly entryIds: readonly string[];
}

const GENERIC = new Set(["", "speaker", "unknown", "g2 conversation", "conversation", "user"]);
/** History speaker labels -> "You" / "Them" / "Speaker" / a real name (Omi speaker names stay). */
export function historySpeaker(label: string | undefined): string {
  const clean = (label ?? "").split(" · ")[0]!.trim();
  if (/^(you|me|self)$/iu.test(clean)) return "You";
  if (/^(other|other speaker|them|guest)$/iu.test(clean)) return "Them";
  return GENERIC.has(clean.toLowerCase()) ? "Speaker" : clean.slice(0, 40);
}

const METADATA_KEY = /\b(?:latency(?:Ms|_ms)?|promptVersion|prompt_version|endpointId|endpoint_id|totalMs|firstTokenMs|inputTokens|outputTokens|costUsd|requestId|request_id|response_id|responseId)\s*[:=]\s*[^\s,;]+/gu;
const PROVENANCE = /\b(?:model|provider|endpoint)\s*(?:=\s*[^\s,;]+|:\s*(?=[^\s,;]*(?:gpt|whisper|openai|deepgram|soniox|omi|\/|\d))[^\s,;]+)/giu;

/** Strips URLs, endpoints, provider/model/latency metadata, JSON and citation markers from a line. */
export function cleanLineText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/\[([^\]\n]{1,200})\]\((?:https?:)?\/\/[^)\s]+\)/giu, "$1")
    .replace(/\b(?:https?|wss?|ftp):\/\/[^\s<>()]+/giu, " ")
    .replace(/\bwww\.[^\s<>()]+/giu, " ")
    .replace(/\{[^{}]*"[^"{}]*"\s*:[^{}]*\}/gu, " ")
    .replace(/\[\s*(?:"[^"]*"\s*,?\s*)+\]/gu, " ")
    .replace(METADATA_KEY, " ")
    .replace(PROVENANCE, " ")
    .replace(/\(\s*\d+(?:\.\d+)?\s*m?s\s*\)/giu, " ")
    .replace(/【[^】]*】|\[\d+(?:,\s*\d+)*\]/gu, "")
    .replace(/\(\s*\)/gu, "")
    .replace(/\s+([,.;:!?])/gu, "$1")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

const norm = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * History transcript as "Speaker: text" lines. Consecutive lines from one speaker merge into one
 * paragraph; re-sent partials (a line that is a prefix of the next) are dropped; detected questions
 * that repeat speech are dropped; Helix answers become indented "Helix:" lines; context requests and
 * imported summaries never show their prompt text.
 */
export function cleanTranscript(entries: readonly HistoryEntry[]): TranscriptLine[] {
  const speech = entries.filter(entry => entry.kind === "transcript").map(entry => norm(entry.text)).filter(Boolean);
  const lines: { speaker: string; text: string; kind: TranscriptLineKind; entryIds: string[] }[] = [];
  for (const entry of entries) {
    if (entry.metadata?.origin === "omi-summary" || /^omi summary$/iu.test(entry.speaker ?? "")) continue;
    const raw = entry.text ?? "";
    if (entry.kind === "transcript") {
      const text = cleanLineText(raw);
      if (!text) continue;
      const speaker = historySpeaker(entry.speaker);
      const last = lines.at(-1);
      if (last && last.kind === "speech" && last.speaker === speaker) {
        const a = norm(last.text), b = norm(text);
        if (b.startsWith(a)) last.text = text; // the earlier line was a partial of this one
        else if (!a.endsWith(b)) last.text = `${last.text} ${text}`;
        last.entryIds.push(entry.id);
      } else lines.push({ speaker, text, kind: "speech", entryIds: [entry.id] });
    } else if (entry.kind === "question") {
      const label = (entry.speaker ?? "").trim();
      if (/^local context$/iu.test(label) || /^whole conversation$/iu.test(label)) {
        lines.push({ speaker: "You", text: /^local/iu.test(label) ? "asked Helix about the last few sentences" : "asked Helix about the whole conversation", kind: "request", entryIds: [entry.id] });
        continue;
      }
      const text = cleanLineText(raw);
      const key = norm(text);
      if (!text || speech.some(said => said.includes(key))) continue; // detected from speech: already in the transcript
      lines.push({ speaker: historySpeaker(entry.speaker), text, kind: "request", entryIds: [entry.id] });
    } else if (entry.kind === "answer") {
      const text = cleanLineText(raw);
      if (text) lines.push({ speaker: "Helix", text, kind: "helix", entryIds: [entry.id] });
    } else if (entry.kind === "fact-check") {
      const [claim = "", ...rest] = raw.split("\n");
      const status = entry.metadata?.status;
      const text = cleanLineText(`${claim}${status ? ` (${status})` : ""}${rest.length ? `: ${rest.join(" ")}` : ""}`);
      if (text) lines.push({ speaker: "Check", text, kind: "check", entryIds: [entry.id] });
    }
  }
  return lines;
}

/** Plain text export of the clean transcript: "Speaker: text", Helix lines indented. */
export function transcriptText(lines: readonly TranscriptLine[]): string {
  return lines.map(line => `${line.kind === "helix" || line.kind === "check" ? "    " : ""}${line.speaker}: ${line.text}`).join("\n");
}

/* --------------------------------------------------------------------- formatting */

export function formatSessionDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
export function formatDuration(startIso: string, endIso: string): string {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}
export const SOURCE_LABEL: Readonly<Record<KnowledgeSourceId, string>> = { helix: "Helix", omi: "Omi", obsidian: "Obsidian" };
export const SOURCE_ICON: Readonly<Record<KnowledgeSourceId, IconName>> = { helix: "glasses", omi: "ring", obsidian: "gem" };

/** Local calendar day of a session, for grouping: "2026-11-19". */
export function sessionDayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
/** Day heading: "Today", "Yesterday", else "Mon, Nov 16" (with the year when it is not this year). */
export function formatSessionDay(iso: string, now: number = Date.now()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Undated";
  const today = new Date(now), yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sessionDayKey(iso) === sessionDayKey(today.toISOString())) return "Today";
  if (sessionDayKey(iso) === sessionDayKey(yesterday.toISOString())) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }) });
}
export function formatSessionTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * Display title. v0.13: the generated title when the session has one, an imported title as it came,
 * and otherwise a title derived on the phone from the summary or the transcript's topic words: never
 * the first thing that was said, and never the "Helix · <ISO time>" placeholder.
 */
export function sessionTitle(session: HistorySession, entries: readonly HistoryEntry[] = []): string {
  return cleanLineText(sessionRecap(session, entries).title) || "Untitled session";
}

/** A PDF added in Knowledge (pdf-knowledge.ts, id "pdf:..."): a document in the knowledge base, not a conversation. */
export function isDocumentSession(session: Pick<HistorySession, "id">): boolean { return session.id.startsWith("pdf:"); }

/** Session list card data (pure, testable). */
export interface SessionCardView {
  readonly id: string; readonly title: string; readonly source: KnowledgeSourceId;
  /** "Nov 19, 12:00 PM" · day key for grouping · "12:00 PM" · "6 min". */
  readonly date: string; readonly day: string; readonly time: string; readonly duration: string;
  /** One-to-two line summary of the conversation ("" when nothing is known). */
  readonly summary: string;
  /** Who wrote title + summary: the summary model, the phone (fallback), or the import. */
  readonly origin: "model" | "fallback" | "imported";
  readonly people: string[];
  /** Speaker turns in the transcript, and answers Helix gave. */
  readonly lines: number; readonly answers: number;
  /** "10 speaker turns · 2 Helix answers": what the two numbers count. */
  readonly counts: string;
  readonly startedAt: string;
  /** True for a PDF document: listed under "Documents", not under the day it was added. */
  readonly document?: boolean;
}
export function sessionCard(session: HistorySession, entries: readonly HistoryEntry[]): SessionCardView {
  const knowledge = sessionKnowledge(session, entries);
  const lines = cleanTranscript(entries);
  const times = entries.map(entry => entry.occurredAt).filter(Boolean).sort();
  const start = times[0] ?? session.startedAt, end = times.at(-1) ?? session.updatedAt;
  const speech = lines.filter(line => line.kind === "speech"), answers = lines.filter(line => line.kind === "helix").length;
  const recap = sessionRecap(session, entries);
  const document = isDocumentSession(session);
  // A PDF is described by what pdf-knowledge.ts stored about it ("PDF document, 12 pages, parsed on this phone"), not as an unsummarised talk.
  const summary = cleanLineText(document ? session.overview?.trim() || (session.keyFacts?.[0] ?? "") : recap.overview);
  const todos = session.todos ?? [], notes = session.notes ?? [];
  return {
    id: session.id, title: cleanLineText(recap.title) || "Untitled session",
    source: sessionSource(session), date: formatSessionDate(session.startedAt), day: sessionDayKey(session.startedAt), time: formatSessionTime(session.startedAt),
    duration: document ? "" : formatDuration(start, end),
    summary: summary.length > 240 ? `${summary.slice(0, 237).trimEnd()}…` : summary, origin: recap.origin,
    people: knowledge.people.map(person => person.name), lines: speech.length, answers,
    counts: document ? plural(entries.length, "passage")
      : `${plural(speech.length, "speaker turn")} · ${plural(answers, "Helix answer")}${todos.length ? ` · ${plural(todos.length, "to-do")} (${todos.filter(item => !item.done).length} open)` : ""}${notes.length ? ` · ${plural(notes.length, "note")}` : ""}`,
    startedAt: session.startedAt,
    ...(document ? { document } : {}),
  };
}
/** Day key and label of the group that holds PDF documents (after the conversations). */
export const DOCUMENTS_GROUP = "documents";
/** Conversations newest first by start time, in day groups; PDF documents follow in one "Documents" group (pure). */
export function groupSessionCards<T extends { readonly day: string; readonly startedAt: string; readonly document?: boolean }>(cards: readonly T[], now: number = Date.now()): { day: string; label: string; cards: T[] }[] {
  const groups: { day: string; label: string; cards: T[] }[] = [];
  const sorted = [...cards].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)), documents = sorted.filter(card => card.document);
  for (const card of sorted) {
    if (card.document) continue;
    const last = groups.at(-1);
    if (last?.day === card.day) last.cards.push(card);
    else groups.push({ day: card.day, label: formatSessionDay(card.startedAt, now), cards: [card] });
  }
  if (documents.length) groups.push({ day: DOCUMENTS_GROUP, label: "Documents", cards: documents });
  return groups;
}
/** Where a session's title and summary came from, for the session view (model, prompt version and time are kept as provenance). */
export function recapProvenance(session: HistorySession): string {
  const recap = session.recap;
  if (recap?.origin === "model") return `Summary by ${recap.model ?? "the summary model"} · ${formatSessionDate(recap.generatedAt)}${recap.promptVersion ? ` · ${recap.promptVersion}` : ""}`;
  if (isDocumentSession(session)) return "PDF document · added in Knowledge";
  if (sessionSource(session) !== "helix") return `Imported from ${SOURCE_LABEL[sessionSource(session)]}`;
  return recap ? `Title made on this phone · ${formatSessionDate(recap.generatedAt)} · no AI summary yet` : "Title made on this phone · no AI summary yet";
}
/** What "Let the knowledge base read history" does, in one line (pure). */
export function historyKnowledgeNote(on: boolean, openai: boolean): string {
  // One switch for everything that is saved (config useLocalMemory): conversations and what was imported in Knowledge.
  const scope = " It covers everything saved here: your conversations and what you imported in Knowledge (Omi, Obsidian notes, PDFs).";
  if (!on) return `Off: saved sessions are never read for answers and are not synced to OpenAI. They stay on this phone.${scope}`;
  return (openai
    ? "On: each question is searched in your synced OpenAI knowledge base (the phone is the fallback), and up to 5 short matching passages with their session title, speaker and time are sent to your answer provider with the question."
    : "On: for each answer Helix searches saved sessions on this phone and sends up to 5 short matching passages with their session title, speaker and time to your answer provider with the question.") + scope;
}

/** v0.11 AI cues: what Helix said in a session, each answer with the question that triggered it. */
export interface SessionCue { readonly kind: "answer" | "check"; readonly text: string; readonly question?: string }
export function sessionCues(entries: readonly HistoryEntry[]): SessionCue[] {
  const cues: SessionCue[] = [];
  let question: string | undefined;
  for (const entry of entries) {
    if (entry.kind === "question") {
      const label = (entry.speaker ?? "").trim();
      question = /^local context$/iu.test(label) ? "You asked about the last few sentences" : /^whole conversation$/iu.test(label) ? "You asked about the whole conversation" : cleanLineText(entry.text ?? "") || undefined;
    } else if (entry.kind === "answer") {
      const text = cleanLineText(entry.text ?? "");
      if (text) cues.push({ kind: "answer", text, ...(question ? { question } : {}) });
      question = undefined;
    } else if (entry.kind === "fact-check") {
      const [claim = "", ...rest] = (entry.text ?? "").split("\n");
      const status = entry.metadata?.status;
      const text = cleanLineText(`${claim}${status ? ` (${status})` : ""}${rest.length ? `: ${rest.join(" ")}` : ""}`);
      if (text) cues.push({ kind: "check", text });
    }
  }
  return cues;
}

/** v0.11 mindmap: the session as a two-level tree (pure, built from what is saved; no model call). */
export interface MindmapBranch { readonly kind: "summary" | "facts" | "people" | "concepts" | "questions"; readonly label: string; readonly children: string[] }
export interface Mindmap { readonly label: string; readonly children: MindmapBranch[] }
export function sessionMindmap(session: HistorySession, entries: readonly HistoryEntry[]): Mindmap {
  const knowledge = sessionKnowledge(session, entries);
  const short = (text: string) => text.length > 90 ? `${text.slice(0, 87).trimEnd()}…` : text;
  const questions = [...new Set(entries.filter(entry => entry.kind === "question" && !/^(local context|whole conversation)$/iu.test((entry.speaker ?? "").trim()))
    .map(entry => cleanLineText(entry.text ?? "")).filter(Boolean))].slice(0, 6);
  const branches: MindmapBranch[] = [
    { kind: "summary", label: "Summary", children: knowledge.summary.map(short) },
    { kind: "facts", label: "Key facts", children: knowledge.keyFacts.map(short) },
    { kind: "people", label: "People", children: knowledge.people.map(person => person.role ? `${person.name} · ${person.role}` : person.name) },
    { kind: "concepts", label: "Concepts", children: knowledge.concepts.map(concept => concept.term) },
    { kind: "questions", label: "Questions", children: questions.map(short) },
  ];
  return { label: sessionTitle(session, entries), children: branches.filter(branch => branch.children.length) };
}

/* ------------------------------------------------------------------------- panel */

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); if (text) node.textContent = text; if (className) node.className = className; return node;
};
const iconSpan = (name: IconName, className = "card-icon"): HTMLElement => {
  const span = element("span", undefined, className); span.setAttribute("aria-hidden", "true"); span.innerHTML = icon(name); return span;
};
const button = (label: string, className: string, iconName?: IconName): HTMLButtonElement => {
  const node = element("button", undefined, className); node.type = "button";
  if (iconName) node.append(iconSpan(iconName, "button-icon"));
  node.append(element("span", label, "button-label")); return node;
};

/**
 * In-page confirmation for a destructive action (never window.confirm: a native dialog can block the
 * Even WebView). The safe choice comes first and takes focus; Escape cancels.
 */
export function confirmBar(message: string, confirmLabel: string, onConfirm: () => void, onCancel: () => void): HTMLElement {
  const bar = element("div", undefined, "confirm-bar"); bar.setAttribute("role", "alertdialog"); bar.setAttribute("aria-label", confirmLabel);
  const text = element("p", message, "confirm-text");
  const keep = button("Keep", "button button-secondary button-small confirm-cancel");
  const go = button(confirmLabel, "button button-small confirm-go", "cross");
  keep.addEventListener("click", onCancel); go.addEventListener("click", onConfirm);
  bar.addEventListener("keydown", event => { if (event.key === "Escape") { event.stopPropagation(); onCancel(); } });
  const row = element("div", undefined, "confirm-actions"); row.append(keep, go);
  bar.append(text, row);
  queueMicrotask(() => { if (bar.isConnected) { keep.focus({ preventScroll: true }); bar.scrollIntoView?.({ block: "nearest" }); } });
  return bar;
}

export interface HistoryPanelOptions {
  readonly onAsk?: (question: string) => void | Promise<void>;
  /** Current Omi API key (Setup → API keys), for Send to Omi. */
  readonly omiKey?: () => string;
  /** Open the People tab focused on a person. */
  readonly onShowPeople?: (name: string) => void;
  /** Current OpenAI key (Setup), for Generate summary. */
  readonly openaiKey?: () => string;
}

type DetailTab = "summary" | "cues" | "transcript" | "mindmap";
const DETAIL_TABS: readonly (readonly [DetailTab, string, IconName])[] = [["summary", "Summary", "scroll"], ["cues", "AI cues", "gem"], ["transcript", "Transcript", "bubble"], ["mindmap", "Mindmap", "database"]];

/** Phone-only archive: session cards, then a clean session detail. Imported text never enters markup or URL routing. */
/** Minimum gap between renders driven by live history updates. */
export const RENDER_INTERVAL_MS = 1000;
export class HistoryPanel {
  private readonly panel = element("section");
  private readonly status = element("p");
  private readonly search = element("input");
  private readonly listView = element("div");
  private readonly list = element("ol");
  private readonly detail = element("div");
  private readonly unsubscribe: () => void;
  private selected?: string;
  private selectedEntry?: string;
  private detailTab: DetailTab = "summary";
  /** Set by open(session, entry): jump to the Transcript tab once to show the passage. */
  private jumpToEntry = false;
  private detailSignature?: string;
  private listSignature?: string;
  private notice = "";

  // ---- v0.13: knowledge toggle, select-to-remove and in-page confirmation ----
  private readonly knowledgeToggle = element("input");
  private readonly knowledgeNote = element("p", undefined, "field-note history-knowledge-note");
  private readonly selectButton = button("Select", "button button-quiet button-small history-select");
  private readonly selectBar = element("div", undefined, "history-select-bar");
  private readonly confirmSlot = element("div", undefined, "history-confirm-slot");
  /** Select mode: the ids ticked for removal (undefined = not selecting). */
  private picked?: Set<string>;

  constructor(root: HTMLElement, private readonly controller: G2ConversationController, private readonly options: HistoryPanelOptions = {}) {
    this.panel.className = "history-panel"; this.panel.id = "history-panel";
    this.panel.setAttribute("aria-label", "Saved sessions");
    const privacy = element("p", "Sessions stay on this phone. Open one to export it or remove it; imports and exports are in Knowledge. PDFs you added are listed last, under Documents.", "field-note");
    // The same setting as Knowledge → "Use saved knowledge in answers" (config useLocalMemory): one switch, shown in both tabs.
    const knowledge = element("section", undefined, "history-knowledge");
    this.knowledgeToggle.type = "checkbox"; this.knowledgeToggle.id = "history-knowledge-read";
    const toggleLabel = element("label", undefined, "toggle"); toggleLabel.htmlFor = this.knowledgeToggle.id;
    const toggleText = element("span", "Let the knowledge base read history");
    toggleText.append(element("small", "Answers can use and cite your saved sessions and imported documents, so Helix gets smarter as you go"));
    toggleLabel.append(this.knowledgeToggle, toggleText);
    this.knowledgeNote.id = "history-knowledge-note"; this.knowledgeToggle.setAttribute("aria-describedby", this.knowledgeNote.id);
    this.knowledgeToggle.addEventListener("change", () => { void controller.setLocalMemoryEnabled(this.knowledgeToggle.checked); });
    knowledge.append(toggleLabel, this.knowledgeNote);
    this.status.id = "history-status"; this.status.className = "field-note history-status"; this.status.setAttribute("role", "status"); this.status.setAttribute("aria-live", "polite");
    this.search.type = "search"; this.search.id = "history-search"; this.search.placeholder = "Search English or 中文 history";
    const searchLabel = element("label", "Search sessions", "sr-only"); searchLabel.htmlFor = this.search.id;
    this.search.addEventListener("input", () => { this.listSignature = undefined; this.renderList(); });
    const tools = element("div", undefined, "history-tools");
    this.selectButton.id = "history-select"; this.selectButton.setAttribute("aria-pressed", "false");
    this.selectButton.addEventListener("click", () => this.setSelecting(!this.picked));
    tools.append(this.search, this.selectButton);
    this.selectBar.hidden = true;
    this.list.className = "card-list session-list"; this.detail.className = "history-detail"; this.detail.hidden = true;
    this.listView.className = "history-list-view";
    this.listView.append(privacy, knowledge, searchLabel, tools, this.selectBar, this.confirmSlot, this.status, this.list);
    this.panel.append(this.listView, this.detail);
    root.append(this.panel);
    this.unsubscribe = controller.subscribeHistory(state => this.render(state));
  }
  private setSelecting(on: boolean): void {
    this.picked = on ? new Set() : undefined;
    this.confirmSlot.replaceChildren();
    this.selectButton.setAttribute("aria-pressed", String(on));
    this.selectButton.querySelector(".button-label")!.textContent = on ? "Done" : "Select";
    this.listSignature = undefined; this.rows.clear(); this.renderList();
  }
  private renderSelectBar(): void {
    const count = this.picked?.size ?? 0;
    this.selectBar.hidden = !this.picked;
    if (!this.picked) { this.selectBar.replaceChildren(); return; }
    const remove = button(count ? `Remove ${count}` : "Remove", "button button-secondary button-small history-remove-picked", "cross");
    remove.disabled = !count;
    remove.addEventListener("click", () => {
      const ids = [...this.picked ?? []];
      this.confirmSlot.replaceChildren(confirmBar(`Remove ${plural(ids.length, "session")} from this phone? Their transcripts, answers, summaries, to-dos and notes (for a PDF: its text) are deleted and cannot be restored.`,
        `Remove ${ids.length}`, () => { this.confirmSlot.replaceChildren(); this.removeSessions(ids, () => this.setSelecting(false)); }, () => this.confirmSlot.replaceChildren()));
    });
    this.selectBar.replaceChildren(element("span", count ? `${count} selected` : "Tap the sessions to remove", "field-note"), remove);
  }
  /** Confirmed removal: every store, the retrieval index and the OpenAI knowledge base (see controller.removeHistorySessions). */
  private removeSessions(ids: readonly string[], done: () => void): void {
    this.setNotice(`Removing ${plural(ids.length, "session")}…`);
    void this.controller.removeHistorySessions(ids, this.options.openaiKey?.() ?? "")
      .then(result => { done(); this.setNotice(result.message); }, error => this.setNotice(error instanceof Error ? error.message : String(error)));
  }
  public dispose(): void { this.unsubscribe(); clearTimeout(this.renderTimer); this.panel.remove(); }
  public focusSearch(): void { this.back(); this.search.scrollIntoView?.({ block: "center" }); this.search.focus({ preventScroll: true }); }
  public openSource(source: RetrievedMemory): void { this.open(source.session.id, source.entry.id); }
  public open(sessionId: string, entryId?: string): void {
    if (sessionId !== this.selected) this.detailTab = "summary";
    this.selected = sessionId; this.selectedEntry = entryId; this.jumpToEntry = !!entryId; this.detailSignature = undefined; this.renderDetail();
    const passage = [...this.detail.querySelectorAll<HTMLElement>("[data-entry-ids]")].find(node => entryId && node.dataset.entryIds!.split(" ").includes(entryId));
    for (const node of this.detail.querySelectorAll(".is-selected")) node.classList.remove("is-selected");
    passage?.classList.add("is-selected");
    (passage ?? this.detail).scrollIntoView?.({ block: "nearest" });
  }
  private back(): void {
    this.selected = undefined; this.selectedEntry = undefined; this.detailSignature = undefined;
    this.detail.hidden = true; this.detail.replaceChildren(); this.listView.hidden = false;
    if (this.listStale) { this.listStale = false; this.listSignature = undefined; this.renderList(); }
  }
  private dirty = false;
  /** Panels in hidden tabs only mark themselves dirty; history state changes on every saved line. */
  private hidden(): boolean { return this.panel.closest("[hidden]") !== null; }
  /** Called when the History tab is shown. */
  public refresh(): void { if (!this.dirty) return; this.dirty = false; this.renderVisible(); }
  // v0.11.1: history state changes on every saved line. Rendering used to clone the whole archive
  // per session on each change (seconds of blocked main thread with hundreds of sessions: the page
  // stopped responding while History was open during a live session). Now: at most one render per
  // RENDER_INTERVAL_MS, only the view on screen, and list rows cached until their session changes.
  private renderTimer?: ReturnType<typeof setTimeout>;
  private lastRender = 0;
  private readonly cards = new Map<string, { stamp: string; card: SessionCardView }>();
  private render(state: HistoryState): void {
    this.status.textContent = this.notice || state.status;
    this.knowledgeToggle.checked = state.useLocalMemory;
    this.knowledgeNote.textContent = historyKnowledgeNote(state.useLocalMemory, state.knowledge.source === "openai" && state.knowledge.synced > 0);
    if (this.hidden()) { this.dirty = true; return; }
    if (this.renderTimer !== undefined) return;
    const wait = this.lastRender + RENDER_INTERVAL_MS - Date.now();
    if (wait <= 0) { this.lastRender = Date.now(); this.renderVisible(); return; }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined; this.lastRender = Date.now();
      if (this.hidden()) { this.dirty = true; return; }
      this.renderVisible();
    }, wait);
  }
  private renderVisible(): void {
    if (this.selected) { this.listStale = true; this.renderDetail(); }
    else { this.listSignature = undefined; this.renderList(); }
  }
  private listStale = false;
  private readonly rows = new Map<string, { signature: string; node: HTMLElement }>();
  private renderList(): void {
    const query = this.search.value.trim();
    const hits = query ? this.controller.searchHistory(query) : [];
    // Include title-only imported conversations, which have no searchable entry.
    // v0.13: a Helix record with nothing in it is not a conversation (earlier versions saved one per Connect).
    const all = this.controller.listHistorySessions().filter(session => this.controller.historySessionHasContent(session)), live = new Set(all.map(session => session.id));
    for (const id of this.cards.keys()) if (!live.has(id)) { this.cards.delete(id); this.rows.delete(id); }
    if (this.picked) for (const id of this.picked) if (!live.has(id)) this.picked.delete(id);
    const liveId = this.controller.liveSessionId(), wanted = query.normalize("NFKC").toLowerCase();
    const cards = all.map(session => {
      const stamp = `${this.controller.historyEntryCount(session.id)}|${JSON.stringify(session)}`, cached = this.cards.get(session.id);
      if (cached?.stamp === stamp) return cached.card;
      const card = sessionCard(session, this.controller.openHistorySession(session.id)?.entries ?? []);
      this.cards.set(session.id, { stamp, card });
      return card;
    }).filter(card => !query || `${card.title}\n${card.summary}`.normalize("NFKC").toLowerCase().includes(wanted) || hits.some(hit => hit.session.id === card.id));
    const states = cards.map(card => [card.id === liveId, this.controller.sessionSummaryPending(card.id), this.picked?.has(card.id) ?? null]);
    const groups = groupSessionCards(cards);
    const signature = JSON.stringify([query, groups.map(group => group.label), cards, states, hits.map(hit => hit.entry.id)]);
    if (signature === this.listSignature) return;
    this.listSignature = signature;
    this.renderSelectBar();
    // Keyed rows: only sessions whose row data changed are rebuilt (the live session, once a second).
    const items: HTMLElement[] = [];
    for (const group of groups) {
      const heading = element("li", undefined, "session-day"); heading.setAttribute("role", "presentation");
      heading.append(element("h3", group.label, "session-day-label"), element("span", plural(group.cards.length, group.day === DOCUMENTS_GROUP ? "document" : "session"), "session-day-count"));
      items.push(heading);
      for (const card of group.cards) {
        const hit = hits.find(found => found.session.id === card.id)?.entry.id;
        const isLive = card.id === liveId, summarising = this.controller.sessionSummaryPending(card.id), picked = this.picked?.has(card.id);
        const rowSignature = JSON.stringify([card, hit, isLive, summarising, picked ?? null]), existing = this.rows.get(card.id);
        if (existing?.signature === rowSignature) { items.push(existing.node); continue; }
        items.push(this.sessionRow(card, { hit, isLive, summarising, picked }));
        this.rows.set(card.id, { signature: rowSignature, node: items.at(-1)! });
      }
    }
    this.list.replaceChildren(...items);
    if (!cards.length) this.list.append(element("li", query ? "No matching sessions." : "No saved sessions yet. Connect and talk, or import from Omi or Obsidian in Knowledge.", "field-note"));
  }
  /** One session card: title, when and how long, a one-to-two line summary, and labelled counts. */
  private sessionRow(card: SessionCardView, state: { hit?: string | undefined; isLive: boolean; summarising: boolean; picked?: boolean | undefined }): HTMLElement {
    const item = element("li", undefined, "session-item");
    const open = element("button", undefined, `card session-card source-${card.source}`); open.type = "button";
    open.dataset.sessionId = card.id;
    const head = element("span", undefined, "session-head");
    if (state.picked !== undefined) { const tick = element("span", undefined, `session-tick${state.picked ? " is-on" : ""}`); tick.setAttribute("aria-hidden", "true"); head.append(tick); }
    else head.append(iconSpan(SOURCE_ICON[card.source]));
    head.append(element("strong", card.title, "card-title"));
    if (state.isLive) head.append(element("span", "Live", "status-pill pill-live"));
    else if (state.summarising) head.append(element("span", "Summarising…", "status-pill"));
    else if (card.document) head.append(element("span", "PDF", "source-badge badge-pdf"));
    else if (card.source !== "helix") head.append(element("span", SOURCE_LABEL[card.source], `source-badge badge-${card.source}`));
    const when = element("span", [card.date, card.duration].filter(Boolean).join(" · "), "session-meta");
    open.append(head, when);
    if (card.summary) open.append(element("span", card.summary, "session-summary"));
    open.append(element("span", card.counts, "session-counts"));
    const label = `${card.title}, ${card.document ? "PDF document" : SOURCE_LABEL[card.source]}, ${card.date}${card.duration ? `, ${card.duration}` : ""}, ${card.counts}`;
    if (state.picked !== undefined) {
      open.setAttribute("aria-pressed", String(state.picked)); open.setAttribute("aria-label", `${state.picked ? "Selected" : "Select"}: ${label}`);
      open.addEventListener("click", () => {
        if (!this.picked) return;
        if (this.picked.has(card.id)) this.picked.delete(card.id); else this.picked.add(card.id);
        this.confirmSlot.replaceChildren(); this.listSignature = undefined; this.renderList();
      });
    } else {
      open.setAttribute("aria-label", label);
      open.addEventListener("click", () => this.open(card.id, state.hit));
    }
    item.append(open);
    return item;
  }
  private renderDetail(): void {
    if (!this.selected) return;
    const record = this.controller.openHistorySession(this.selected);
    // Memory provenance: only the entries this session's answers cite are looked up.
    const originals = new Map<string, HistorySession>();
    for (const entry of record?.entries ?? []) for (const id of memoryEntryIds(entry)) {
      if (originals.has(id)) continue;
      const original = this.controller.historySessionOfEntry(id);
      if (original) originals.set(id, original);
    }
    const signature = JSON.stringify([this.detailTab, record, this.selectedEntry, this.controller.sessionSummaryPending(this.selected), record?.entries.flatMap(entry => memoryEntryIds(entry).map(id => originals.get(id)))]);
    if (signature === this.detailSignature) return;
    this.detailSignature = signature;
    this.listView.hidden = true; this.detail.hidden = false;
    this.detail.replaceChildren();
    const back = button("All sessions", "button button-quiet button-small history-back"); back.addEventListener("click", () => this.back());
    this.detail.append(back);
    if (!record) { this.detail.append(element("p", "This session is no longer on this phone.", "field-note")); return; }
    const { session, entries } = record;
    const card = sessionCard(session, entries);
    const knowledge = sessionKnowledge(session, entries);
    const head = element("header", undefined, "detail-head");
    const titleRow = element("div", undefined, "card-head");
    titleRow.append(iconSpan(SOURCE_ICON[card.source]), element("h3", card.title, "detail-title"),
      card.document ? element("span", "PDF", "source-badge badge-pdf") : element("span", SOURCE_LABEL[card.source], `source-badge badge-${card.source}`));
    // v0.13: the session view leads with when it was, its summary and where that summary came from.
    head.append(titleRow, element("p", [formatSessionDay(session.startedAt), card.time, card.duration].filter(Boolean).join(" · "), "session-meta"),
      element("p", card.counts, "session-counts"));
    if (card.summary) head.append(element("p", card.summary, "detail-overview"));
    head.append(element("p", this.controller.sessionSummaryPending(session.id) ? "Writing the summary…" : recapProvenance(session), "field-note detail-provenance"));
    this.detail.append(head);

    // Export / send
    const actions = element("div", undefined, "detail-actions");
    const exportButton = button("Export .md", "button button-secondary button-small", "download");
    const copyButton = button("Copy Markdown", "button button-secondary button-small", "copy");
    const omiButton = button("Send to Omi", "button button-secondary button-small", "send");
    const remove = button("Remove", "button button-quiet button-small detail-remove", "cross");
    const support = card.source === "omi" ? { supported: false, reason: "This session came from Omi, so it is already there." }
      : card.document ? { supported: false, reason: "PDF documents are not sent to Omi." } : this.controller.omiExportSupport();
    omiButton.disabled = !support.supported;
    if (!support.supported) omiButton.title = support.reason;
    const markdown = () => this.controller.sessionMarkdown(session.id) ?? "";
    exportButton.addEventListener("click", () => {
      // v0.13: share sheet -> browser download -> clipboard -> Markdown preview, and the notice says which one happened.
      const text = markdown();
      void exportFile<HTMLAnchorElement>({ name: markdownFileName(card.title, session.startedAt), content: text, type: "text/markdown", text }, browserTransferEnv(copyToClipboard)).then(result => {
        this.setNotice(result.method === "view" ? "Saving and copying are both blocked here. Open “Markdown for Obsidian” below and select the text." : result.message);
        if (result.link) this.detail.querySelector(".detail-actions")?.append(result.link);
      });
    });
    copyButton.addEventListener("click", () => { void copyToClipboard(markdown()).then(ok => this.setNotice(ok ? "Markdown copied. Paste it into a new Obsidian note." : "Copy was blocked. Open the Markdown preview below and select the text.")); });
    omiButton.addEventListener("click", () => {
      omiButton.disabled = true;
      void this.controller.exportSessionsToOmi([session.id], this.options.omiKey?.() ?? "").then(result => this.setNotice(result.message), error => this.setNotice(error instanceof Error ? error.message : String(error)))
        .finally(() => { omiButton.disabled = !support.supported; });
    });
    // v0.13: confirmation is part of the page (a native confirm dialog can block the Even WebView).
    const confirmSlot = element("div", undefined, "history-confirm-slot");
    remove.addEventListener("click", () => {
      const what = card.document ? "The PDF’s text is deleted from the knowledge base (answers can no longer use it) and cannot be restored."
        : `Its transcript, answers and summary${session.todos?.length || session.notes?.length ? ", and its to-dos and notes," : ""} are deleted and cannot be restored.`;
      confirmSlot.replaceChildren(confirmBar(`Remove “${card.title}” from this phone? ${what}`,
        card.document ? "Remove document" : "Remove session", () => { confirmSlot.replaceChildren(); this.removeSessions([session.id], () => this.back()); }, () => { confirmSlot.replaceChildren(); remove.focus({ preventScroll: true }); }));
    });
    actions.append(exportButton, copyButton, omiButton, remove);
    this.detail.append(actions, confirmSlot);
    if (!support.supported) this.detail.append(element("p", support.reason, "field-note"));

    // v0.11 tabs: Summary · AI cues · Transcript · Mindmap
    const tabs = element("div", undefined, "detail-tabs"); tabs.setAttribute("role", "tablist");
    const pane = element("div", undefined, "detail-pane"); pane.setAttribute("role", "tabpanel");
    if (this.selectedEntry && this.detailTab !== "transcript" && this.jumpToEntry) this.detailTab = "transcript";
    this.jumpToEntry = false;
    for (const [id, label, iconName] of DETAIL_TABS) {
      const tab = button(label, `detail-tab${id === this.detailTab ? " is-active" : ""}`, iconName);
      tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(id === this.detailTab)); tab.dataset.detailTab = id;
      tab.addEventListener("click", () => { this.detailTab = id; this.detailSignature = undefined; this.renderDetail(); });
      tabs.append(tab);
    }
    this.detail.append(tabs, pane);
    const section = (title: string, iconName: IconName): HTMLElement => {
      const wrap = element("section", undefined, "detail-section");
      const heading = element("h4", undefined, "section-label"); heading.append(iconSpan(iconName, "section-icon"), title);
      wrap.append(heading); pane.append(wrap); return wrap;
    };
    const lines = cleanTranscript(entries);
    const hasKnowledge = knowledge.summary.length || knowledge.keyFacts.length;
    const generate = (label: string) => {
      const run = button(label, "button button-secondary button-small generate-summary", "scroll");
      run.addEventListener("click", () => {
        run.disabled = true; this.setNotice("Generating summary…");
        void this.controller.generateSessionKnowledge(session.id, this.options.openaiKey?.() ?? "")
          .then(() => this.setNotice("Summary saved."), error => this.setNotice(error instanceof Error ? error.message : String(error)))
          .finally(() => { run.disabled = false; });
      });
      return run;
    };

    if (this.detailTab === "summary") {
      if (knowledge.summary.length) {
        const list = element("ul", undefined, "summary-points");
        for (const bullet of knowledge.summary) { const row = element("li"); row.append(element("span", undefined, "bullet-mark"), element("span", bullet)); list.append(row); }
        section("Summary", "scroll").append(list);
      }
      if (knowledge.keyFacts.length) {
        const list = element("ul", undefined, "fact-list");
        for (const fact of knowledge.keyFacts) list.append(element("li", fact, "fact-row fact-text"));
        section("Key facts", "coin").append(list);
      }
      // Notes mode: the session's to-do list (editable once the session has ended) and running notes.
      if (session.todos?.length || session.notes?.length) {
        const live = this.controller.liveSessionId() === session.id;
        pane.append(renderNotebook({ todos: session.todos ?? [], notes: session.notes ?? [] },
          op => { void this.controller.editTodo(op, session.id).then(() => { this.detailSignature = undefined; this.renderDetail(); }, error => this.setNotice(error instanceof Error ? error.message : String(error))); },
          { editable: !live, readOnlyNote: "This session is live. Edit its to-dos in the Summary tab." }));
      }
      if (knowledge.people.length) {
        const chips = element("div", undefined, "chip-row");
        for (const person of knowledge.people) {
          const chip = element("button", undefined, "person-chip is-button"); chip.type = "button";
          chip.append(element("strong", person.name), ...(person.role ? [element("small", person.role)] : []));
          chip.setAttribute("aria-label", `${person.name}${person.role ? `, ${person.role}` : ""}. Open in People`);
          chip.addEventListener("click", () => this.options.onShowPeople?.(person.name));
          chips.append(chip);
        }
        section("People", "people").append(chips);
      }
      if (!hasKnowledge && !session.todos?.length && !session.notes?.length) pane.append(element("p", lines.some(line => line.kind === "speech")
        ? "No summary was saved for this session. Generate one from the transcript (one small model call with your OpenAI key)." : "Nothing was said in this session.", "field-note"));
      if (lines.some(line => line.kind === "speech")) pane.append(generate(hasKnowledge ? "Regenerate summary" : "Generate summary"));
    } else if (this.detailTab === "cues") {
      // What Helix told you: answers (with their question), checks, and the concepts it explained.
      const cues = sessionCues(entries);
      if (cues.length) {
        const list = element("ol", undefined, "cue-list");
        for (const cue of cues) {
          const row = element("li", undefined, `cue cue-${cue.kind}`);
          row.append(element("span", cue.kind === "answer" ? "Answer" : "Check", "cue-kind"));
          if (cue.question) row.append(element("p", cue.question, "cue-question"));
          row.append(element("p", cue.text, "cue-text"));
          list.append(row);
        }
        section("Answers and checks", "gem").append(list);
      }
      if (knowledge.concepts.length) {
        const list = element("dl", undefined, "concept-defs");
        for (const concept of knowledge.concepts) list.append(element("dt", concept.term), element("dd", concept.explanation || "—"));
        section("Concepts", "bulb").append(list);
      }
      if (!cues.length && !knowledge.concepts.length) pane.append(element("p", "Helix gave no answers, checks or concept cards in this session.", "field-note"));
    } else if (this.detailTab === "transcript") {
      const transcript = section("Transcript", "bubble");
      if (!lines.length) transcript.append(element("p", "No transcript lines.", "field-note"));
      const list = element("ol", undefined, "clean-transcript");
      for (const line of lines) {
        const row = element("li", undefined, `line line-${line.kind}`);
        row.dataset.entryIds = line.entryIds.join(" ");
        if (this.selectedEntry && line.entryIds.includes(this.selectedEntry)) row.classList.add("is-selected");
        row.append(element("strong", `${line.speaker}:`, "line-speaker"), " ", element("span", line.text, "line-text"));
        list.append(row);
      }
      transcript.append(list);
      // Memory provenance: answers that used earlier sessions link to the original passage.
      const memoryLinks = element("div", undefined, "message-sources");
      for (const entry of entries) for (const id of memoryEntryIds(entry)) {
        const original = originals.get(id);
        if (!original) continue;
        const chip = element("button", `Memory · ${cleanLineText(original.title)}`, "memory-chip"); chip.type = "button";
        chip.addEventListener("click", () => this.open(original.id, id)); memoryLinks.append(chip);
      }
      if (memoryLinks.childElementCount) transcript.append(memoryLinks);
      const preview = element("details", undefined, "markdown-preview");
      const summary = element("summary", "Markdown for Obsidian (with Mermaid diagram)");
      const area = element("textarea"); area.readOnly = true; area.rows = 10; area.className = "markdown-text"; area.setAttribute("aria-label", "Session Markdown");
      preview.addEventListener("toggle", () => { if (preview.open && !area.value) area.value = markdown(); });
      preview.append(summary, area);
      pane.append(preview);
    } else {
      const map = sessionMindmap(session, entries);
      if (!map.children.length) pane.append(element("p", "Nothing to map yet. Generate a summary first.", "field-note"), ...(lines.some(line => line.kind === "speech") ? [generate("Generate summary")] : []));
      else {
        const tree = element("div", undefined, "mindmap"); tree.setAttribute("role", "tree"); tree.setAttribute("aria-label", `Mindmap of ${card.title}`);
        tree.append(element("div", map.label, "mind-root"));
        const branches = element("ul", undefined, "mind-branches");
        for (const branch of map.children) {
          const item = element("li", undefined, `mind-branch mind-${branch.kind}`);
          item.append(element("span", branch.label, "mind-node"));
          const leaves = element("ul", undefined, "mind-leaves");
          for (const leaf of branch.children) leaves.append(element("li", leaf, "mind-leaf"));
          item.append(leaves); branches.append(item);
        }
        tree.append(branches); pane.append(tree);
      }
    }
  }
  private setNotice(message: string): void {
    this.notice = message; this.status.textContent = message;
    const live = this.detail.querySelector<HTMLElement>(".detail-notice") ?? element("p", undefined, "field-note detail-notice");
    live.setAttribute("role", "status"); live.textContent = message;
    if (!live.isConnected) this.detail.querySelector(".detail-actions")?.after(live);
    setTimeout(() => { if (this.notice === message) this.notice = ""; }, 6000);
  }
}

export function markdownFileName(title: string, startedAt: string): string {
  const day = Number.isFinite(Date.parse(startedAt)) ? new Date(startedAt).toISOString().slice(0, 10) : "session";
  const slug = title.normalize("NFKC").replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 60) || "Helix session";
  return `${day} ${slug}.md`;
}

/** Clipboard API first, then a hidden textarea + execCommand (the Even WebView may block navigator.clipboard). */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* fall back */ }
  try {
    const area = document.createElement("textarea");
    area.value = text; area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0";
    document.body.append(area); area.select();
    const ok = document.execCommand("copy"); area.remove(); return ok;
  } catch { return false; }
}

/**
 * @deprecated v0.13: use exportFile() from ./file-transfer, which falls back to the share sheet,
 * the clipboard or an in-page view and reports which one happened. This always reports ok.
 * Blob + object-URL download. Also returns a visible link the wearer can tap, because the Even
 * App WebView may ignore programmatic downloads. The URL is revoked after a minute.
 */
export function downloadFile(name: string, content: string | Uint8Array, type: string): { ok: boolean; name: string; link?: HTMLAnchorElement } {
  try {
    const blob = new Blob([content as BlobPart], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = name; link.className = "download-link"; link.textContent = `Download ${name}`;
    link.rel = "noopener";
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return { ok: true, name, link };
  } catch { return { ok: false, name }; }
}
