import type { HistoryEntry, HistorySession, RetrievedMemory } from "@helix/conversation-sdk";
import type { G2ConversationController, HistoryState } from "./controller";
import { icon, type IconName } from "./pixel-art";
import { browserTransferEnv, exportFile } from "./file-transfer";

export function safeSourceUrl(value: string): string | undefined {
  if (/[\u0000- \u007f]/u.test(value)) return;
  try { const url = new URL(value); if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.hostname) return url.href; } catch { /* untrusted source */ }
}
export function sourceLink(source: { url: string; title: string }): HTMLAnchorElement | undefined {
  const href = safeSourceUrl(source.url); if (!href) return;
  const link = document.createElement("a"); link.href = href; link.textContent = source.title || href;
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
        lines.push({ speaker: "You", text: /^local/iu.test(label) ? "asked Helix about the last minute" : "asked Helix about the whole conversation", kind: "request", entryIds: [entry.id] });
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

/** Display title: cleaned, and the placeholder "Helix · <ISO>" becomes "Helix session · Nov 5, 7:00 PM". */
export function sessionTitle(session: HistorySession): string {
  const title = cleanLineText(session.title) || "Untitled session";
  return /^Helix · \d{4}-/u.test(title) ? `Helix session · ${formatSessionDate(session.startedAt)}` : title;
}

/** Session list card data (pure, testable). */
export interface SessionCardView {
  readonly id: string; readonly title: string; readonly source: KnowledgeSourceId; readonly date: string; readonly duration: string;
  readonly summary: string; readonly people: string[]; readonly lines: number; readonly answers: number;
}
export function sessionCard(session: HistorySession, entries: readonly HistoryEntry[]): SessionCardView {
  const knowledge = sessionKnowledge(session, entries);
  const lines = cleanTranscript(entries);
  const times = entries.map(entry => entry.occurredAt).filter(Boolean).sort();
  const start = times[0] ?? session.startedAt, end = times.at(-1) ?? session.updatedAt;
  const speech = lines.filter(line => line.kind === "speech");
  const summary = knowledge.summary.slice(0, 2).join(" ") || speech.slice(0, 2).map(line => `${line.speaker}: ${line.text}`).join(" ");
  return {
    id: session.id, title: sessionTitle(session),
    source: sessionSource(session), date: formatSessionDate(session.startedAt), duration: formatDuration(start, end),
    summary: summary.length > 220 ? `${summary.slice(0, 217).trimEnd()}…` : summary,
    people: knowledge.people.map(person => person.name), lines: speech.length, answers: lines.filter(line => line.kind === "helix").length,
  };
}

/** v0.11 AI cues: what Helix said in a session, each answer with the question that triggered it. */
export interface SessionCue { readonly kind: "answer" | "check"; readonly text: string; readonly question?: string }
export function sessionCues(entries: readonly HistoryEntry[]): SessionCue[] {
  const cues: SessionCue[] = [];
  let question: string | undefined;
  for (const entry of entries) {
    if (entry.kind === "question") {
      const label = (entry.speaker ?? "").trim();
      question = /^local context$/iu.test(label) ? "You asked about the last minute" : /^whole conversation$/iu.test(label) ? "You asked about the whole conversation" : cleanLineText(entry.text ?? "") || undefined;
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
  return { label: sessionTitle(session), children: branches.filter(branch => branch.children.length) };
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

  constructor(root: HTMLElement, private readonly controller: G2ConversationController, private readonly options: HistoryPanelOptions = {}) {
    this.panel.className = "history-panel"; this.panel.id = "history-panel";
    this.panel.setAttribute("aria-label", "Saved sessions");
    const privacy = element("p", "Sessions stay on this phone. Deleting a session removes it from local retrieval. Memory toggles, imports and exports are in Knowledge.", "field-note");
    this.status.id = "history-status"; this.status.className = "field-note history-status"; this.status.setAttribute("role", "status"); this.status.setAttribute("aria-live", "polite");
    this.search.type = "search"; this.search.id = "history-search"; this.search.placeholder = "Search English or 中文 history";
    const searchLabel = element("label", "Search sessions", "sr-only"); searchLabel.htmlFor = this.search.id;
    this.search.addEventListener("input", () => { this.listSignature = undefined; this.renderList(); });
    this.list.className = "card-list session-list"; this.detail.className = "history-detail"; this.detail.hidden = true;
    this.listView.className = "history-list-view";
    this.listView.append(privacy, searchLabel, this.search, this.status, this.list);
    this.panel.append(this.listView, this.detail);
    root.append(this.panel);
    this.unsubscribe = controller.subscribeHistory(state => this.render(state));
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
    const all = this.controller.listHistorySessions(), live = new Set(all.map(session => session.id));
    for (const id of this.cards.keys()) if (!live.has(id)) { this.cards.delete(id); this.rows.delete(id); }
    const sessions = all.filter(session => !query || session.title.normalize("NFKC").toLowerCase().includes(query.normalize("NFKC").toLowerCase()) || hits.some(hit => hit.session.id === session.id));
    const cards = sessions.map(session => {
      const stamp = `${this.controller.historyEntryCount(session.id)}|${JSON.stringify(session)}`, cached = this.cards.get(session.id);
      if (cached?.stamp === stamp) return cached.card;
      const card = sessionCard(session, this.controller.openHistorySession(session.id)?.entries ?? []);
      this.cards.set(session.id, { stamp, card });
      return card;
    });
    const signature = JSON.stringify([query, cards, hits.map(hit => hit.entry.id)]);
    if (signature === this.listSignature) return;
    this.listSignature = signature;
    // Keyed rows: only sessions whose row data changed are rebuilt (the live session, once a second).
    const items: HTMLElement[] = [];
    for (const card of cards) {
      const hit = hits.find(found => found.session.id === card.id)?.entry.id;
      const rowSignature = JSON.stringify([card, hit]), existing = this.rows.get(card.id);
      if (existing?.signature === rowSignature) { items.push(existing.node); continue; }
      const item = element("li", undefined, "session-item");
      const open = element("button", undefined, `card session-card source-${card.source}`); open.type = "button";
      open.dataset.sessionId = card.id;
      // v0.11: one compact row per session (title, when, how long, counts); details are in the tabs.
      open.classList.add("session-row");
      const main = element("span", undefined, "row-main");
      main.append(element("strong", card.title, "card-title"), element("span", [card.date, card.duration].filter(Boolean).join(" · "), "session-meta"));
      open.append(iconSpan(SOURCE_ICON[card.source]), main,
        element("span", `${card.lines} · ${card.answers}`, "session-counts"), element("span", undefined, "row-chevron"));
      open.title = `${card.lines} line${card.lines === 1 ? "" : "s"} · ${card.answers} answer${card.answers === 1 ? "" : "s"}`;
      open.setAttribute("aria-label", `${card.title}, ${SOURCE_LABEL[card.source]}, ${card.date}${card.duration ? `, ${card.duration}` : ""}`);
      open.addEventListener("click", () => this.open(card.id, hit));
      item.append(open); items.push(item);
      this.rows.set(card.id, { signature: rowSignature, node: item });
    }
    this.list.replaceChildren(...items);
    if (!sessions.length) this.list.append(element("li", query ? "No matching sessions." : "No saved sessions yet. Connect and talk, or import from Omi or Obsidian in Knowledge.", "field-note"));
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
    const signature = JSON.stringify([this.detailTab, record, this.selectedEntry, record?.entries.flatMap(entry => memoryEntryIds(entry).map(id => originals.get(id)))]);
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
    titleRow.append(iconSpan(SOURCE_ICON[card.source]), element("h3", card.title, "detail-title"), element("span", SOURCE_LABEL[card.source], `source-badge badge-${card.source}`));
    head.append(titleRow, element("p", [card.date, card.duration, `${card.lines} lines`].filter(Boolean).join(" · "), "session-meta"));
    this.detail.append(head);

    // Export / send
    const actions = element("div", undefined, "detail-actions");
    const exportButton = button("Export .md", "button button-secondary button-small", "download");
    const copyButton = button("Copy Markdown", "button button-secondary button-small", "copy");
    const omiButton = button("Send to Omi", "button button-secondary button-small", "send");
    const remove = button("Delete", "button button-quiet button-small", "cross");
    const support = card.source === "omi" ? { supported: false, reason: "This session came from Omi, so it is already there." } : this.controller.omiExportSupport();
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
    remove.addEventListener("click", () => {
      if (window.confirm(`Delete “${card.title}” from this phone and local retrieval?`)) {
        void this.controller.deleteHistorySession(session.id).then(() => this.back()).catch(() => {});
      }
    });
    actions.append(exportButton, copyButton, omiButton, remove);
    this.detail.append(actions);
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
      if (!hasKnowledge) pane.append(element("p", lines.some(line => line.kind === "speech")
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
