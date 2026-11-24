/**
 * v0.8 Knowledge tab: Omi / Obsidian / local Helix context, a pixel knowledge map, and transfers
 * among the three. The top half is pure (no DOM at module load) so the controller and tests can
 * use it; the panel class at the bottom renders into the phone WebView.
 */
import {
  markdownToSession, sessionToMarkdown, vaultBundle,
  type HistoryEntry, type HistorySession, type KnowledgeSource, type KnowledgeStats, type OmiExportResult, type PersonAggregate, type VaultFile,
  type MarkdownImportOptions, type MarkdownSession, type OmiImportProgress,
} from "@helix/conversation-sdk";
import type { G2ConversationController, HistoryState, MarkdownImportItem } from "./controller";
import {
  SOURCE_ICON, SOURCE_LABEL, cleanLineText, confirmBar, copyToClipboard, sessionKnowledge, sessionSource, sessionTitle,
} from "./history-panel";
import { icon, type IconName } from "./pixel-art";
import { PDF_LIMITS, type PdfFileStatus, type PdfInput, type PdfParser } from "@helix/conversation-sdk";
import { browserTransferEnv, exportFile, fetchTextFromUrl, importUrl, inEmbeddedWebView, readTextFile, urlFileName } from "./file-transfer";

/* ================================================================ SDK adapter */

export type MarkdownFile = VaultFile;
export interface ImportedSession extends MarkdownSession { readonly session: HistorySession; readonly entries: HistoryEntry[] }

/** Session -> Obsidian note (SDK sessionToMarkdown: frontmatter, sections, Mermaid mindmap, clean transcript). */
export function sessionMarkdown(session: HistorySession, entries: readonly HistoryEntry[]): string {
  return sessionToMarkdown(session, entries);
}

/** Obsidian note -> session + entries (SDK markdownToSession; source "obsidian"). */
export function markdownSession(name: string, markdown: string, options: MarkdownImportOptions = {}): ImportedSession {
  try {
    const parsed = markdownToSession(markdown, name, options);
    return { ...parsed, session: { ...parsed.session, source: "obsidian" } };
  } catch (error) { throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Vault bundle: one note per session at Helix/YYYY-MM-DD title.md (SDK vaultBundle). */
export function vaultFiles(sessions: readonly { session: HistorySession; entries: readonly HistoryEntry[] }[]): MarkdownFile[] {
  return vaultBundle(sessions).files;
}

/** Omi results for a batch of sessions -> one human sentence. */
export function omiExportSummary(results: readonly OmiExportResult[]): { exported: number; message: string } {
  const exported = results.filter(result => result.status === "exported").length;
  const skipped = results.filter((result): result is Extract<OmiExportResult, { status: "skipped" }> => result.status === "skipped");
  const failed = results.filter((result): result is Extract<OmiExportResult, { status: "failed" }> => result.status === "failed");
  const parts = [`Sent ${exported} of ${results.length} session${results.length === 1 ? "" : "s"} to Omi.`];
  if (skipped.length) parts.push(`${skipped.length} skipped: ${[...new Set(skipped.map(item => item.reason))].join(" ")}`);
  if (failed.length) parts.push(`${failed.length} failed: ${[...new Set(failed.map(item => item.message))].join(" ")}`);
  return { exported, message: parts.join(" ") };
}

/** All files as one Markdown document (the Copy fallback when downloads are blocked). */
export function combinedMarkdown(files: readonly MarkdownFile[]): string {
  return files.map(file => `<!-- ${file.path} -->\n${file.content.trim()}`).join("\n\n---\n\n");
}

/* ============================================================ v0.13 status text */

export interface FileLine { readonly name: string; readonly state: "working" | "done" | "failed"; readonly detail: string }
const PDF_STATE_TEXT: Readonly<Record<PdfFileStatus["state"], string>> = {
  queued: "Waiting", reading: "Reading the file…", uploading: "Uploading to OpenAI…", parsing: "Reading the text…", saving: "Saving on this phone…",
  done: "Added", failed: "Failed", cancelled: "Cancelled",
};
/** One PDF's progress as a row: state, counts and the error or limit that applies. */
export function pdfFileLine(file: PdfFileStatus, parser?: PdfParser): FileLine {
  const state = file.state === "done" ? "done" : file.state === "failed" || file.state === "cancelled" ? "failed" : "working";
  let detail = file.state === "parsing" && parser === "openai" ? "OpenAI is reading the PDF… (can take a minute)" : PDF_STATE_TEXT[file.state];
  if (file.state === "done") detail = `Added: ${file.pages ?? 0} page${file.pages === 1 ? "" : "s"}, ${file.passages ?? 0} searchable passage${file.passages === 1 ? "" : "s"}${file.detail ? `. ${file.detail}` : ""}`;
  else if (file.detail) detail = file.state === "failed" ? `Failed: ${file.detail}` : file.detail;
  return { name: file.name, state, detail };
}
/** Per-note outcome of a Markdown import, in the order the files were given. */
export function markdownFileLines(names: readonly string[], unreadable: readonly { name: string; error: string }[], failed: readonly { name: string; error: string }[]): FileLine[] {
  const errors = new Map([...failed, ...unreadable].map(item => [item.name, item.error]));
  return names.map(name => errors.has(name) ? { name, state: "failed" as const, detail: `Failed: ${errors.get(name)!.replace(`${name}: `, "")}` } : { name, state: "done" as const, detail: "Imported" });
}
/* ------------------------------------------------------------ v0.16 import outcomes */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sentence = (text: string) => text.trim().replace(/[.\s]+$/u, "");
/**
 * The Omi import card: counts while it runs, and at the end what was imported, skipped and failed,
 * each with its reason. A failure (the import budget is full, storage refused the save) is named here,
 * on the card of the import that hit it.
 */
export function omiImportText(progress: OmiImportProgress, done: boolean): string {
  const skipped = progress.skipped ?? 0, helix = progress.skippedHelix ?? 0, unreadable = Math.max(0, skipped - helix), failed = progress.failed ?? 0;
  if (!done) return `Imported ${progress.imported} conversations · ${progress.pages} pages${skipped ? ` · ${skipped} skipped` : ""}`;
  const parts = [`${plural(progress.imported, "conversation")} processed`];
  if (unreadable) parts.push(`${unreadable} skipped (Omi returned them in a form Helix cannot read)`);
  if (helix) parts.push(`${helix} skipped (sent to Omi by Helix, already in History)`);
  if (failed) parts.push(`${failed} failed: ${sentence(progress.failReason ?? "could not be saved")}`);
  return failed ? `Import stopped: ${parts.join(" · ")}. What was saved before stays as it was.` : `Import complete: ${parts.join(" · ")}. Repeated imports update existing records.`;
}
/** Why an Omi import ended early (network, key, a response Helix cannot read), with what had been saved by then. */
export function omiImportErrorText(message: string, progress?: OmiImportProgress): string {
  return progress?.imported ? `${sentence(message)}. ${plural(progress.imported, "conversation")} had been saved before that.` : message;
}
export interface MarkdownFileOutcome {
  readonly name: string; readonly state: "imported" | "skipped" | "failed";
  /** Why it was skipped or failed, or what the import limits cut from an imported note. */
  readonly detail?: string;
}
/** One row per note, in the order given. Unlike markdownFileLines, two notes with one file name keep their own rows. */
export function markdownOutcomeLines(files: readonly MarkdownFileOutcome[]): FileLine[] {
  return files.map(file => file.state === "failed" ? { name: file.name, state: "failed" as const, detail: `Failed: ${file.detail ?? "could not be imported"}` }
    : file.state === "skipped" ? { name: file.name, state: "failed" as const, detail: `Skipped: ${file.detail ?? "not imported"}` }
    : { name: file.name, state: "done" as const, detail: file.detail ? `Imported. Shortened: ${file.detail}` : "Imported" });
}
/** The notes card: imported / skipped / failed with the main reason for each, and how many notes were shortened. */
export function markdownImportText(files: readonly MarkdownFileOutcome[]): string {
  const of = (state: MarkdownFileOutcome["state"]) => files.filter(file => file.state === state);
  const imported = of("imported"), skipped = of("skipped"), failed = of("failed"), cut = imported.filter(file => file.detail).length;
  const main = (items: readonly MarkdownFileOutcome[]) => {
    const counts = new Map<string, number>();
    for (const item of items) { const reason = sentence(item.detail ?? ""); if (reason) counts.set(reason, (counts.get(reason) ?? 0) + 1); }
    const top = [...counts].sort((a, b) => b[1] - a[1])[0];
    return top ? `: ${top[0]}${counts.size > 1 ? " (and other reasons, see below)" : ""}` : "";
  };
  const parts = [`Imported ${imported.length} of ${plural(files.length, "note")}`];
  if (skipped.length) parts.push(`${skipped.length} skipped${main(skipped)}`);
  if (failed.length) parts.push(`${failed.length} failed${main(failed)}`);
  return `${parts.join(" · ")}.${cut ? ` ${plural(cut, "note")} shortened by the import limits (see below).` : ""}`;
}

/** The Omi auto-import line under its switch. */
export function autoImportText(view: { enabled: boolean; running: boolean; lastSuccessAt?: string; lastImported?: number; lastError?: string }, format: (iso: string) => string = iso => new Date(iso).toLocaleString()): string {
  if (!view.enabled) return "Off. Omi conversations are imported only when you tap Import from Omi.";
  if (view.running) return "Importing new Omi conversations…";
  const last = view.lastSuccessAt ? `Last import ${format(view.lastSuccessAt)}: ${view.lastImported ?? 0} conversation${view.lastImported === 1 ? "" : "s"} checked.` : "";
  if (view.lastError) return `Not imported: ${view.lastError}${last ? ` ${last}` : ""} Helix retries in a few minutes while this page is open.`;
  return last ? `${last} Checks again about every 30 minutes while Helix is open.` : "On. The first import starts now and covers the last 14 days.";
}

/* ======================================================== stats & diagram model */

export interface SourceOverview { readonly source: KnowledgeSource; readonly sessions: number; readonly entries: number; readonly lastUpdated?: string }
export function sourceOverview(stats: Partial<KnowledgeStats> | undefined): SourceOverview[] {
  return (["omi", "obsidian", "helix"] as const).map(source => ({ source, sessions: stats?.[source]?.sessions ?? 0, entries: stats?.[source]?.entries ?? 0,
    ...(stats?.[source]?.lastUpdated ? { lastUpdated: stats[source]!.lastUpdated } : {}) }));
}

export interface KnowledgeMapInput {
  readonly stats: Partial<KnowledgeStats>;
  readonly sessions: readonly HistorySession[];
  readonly people: readonly PersonAggregate[];
}
const SOURCE_TONE: Readonly<Record<KnowledgeSource, string>> = { helix: "helix", omi: "omi", obsidian: "obsidian" };
const esc = (value: string) => value.replace(/[&<>"']/gu, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
const clip = (value: string, max: number) => { const text = cleanLineText(value).replace(/\s+/gu, " "); return text.length > max ? `${text.slice(0, max - 1)}…` : text; };

/**
 * Pixel knowledge map (inline SVG, crispEdges): sources -> recent sessions -> people/concepts.
 * Colors come from CSS classes (km-*) so dark and light themes both work.
 */
export function knowledgeMapSvg(input: KnowledgeMapInput, width = 360): string {
  const sessions = [...input.sessions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 6);
  const sessionIds = new Set(sessions.map(session => session.id));
  const people = input.people.filter(person => person.sessionIds.some(id => sessionIds.has(id))).slice(0, 5);
  const conceptMap = new Map<string, { term: string; sessions: Set<string> }>();
  for (const session of sessions) for (const concept of sessionKnowledge(session).concepts) {
    const key = concept.term.toLowerCase();
    const item = conceptMap.get(key) ?? { term: concept.term, sessions: new Set<string>() };
    item.sessions.add(session.id); conceptMap.set(key, item);
  }
  const concepts = [...conceptMap.values()].sort((a, b) => b.sessions.size - a.sessions.size).slice(0, Math.max(0, 8 - people.length));
  const overview = sourceOverview(input.stats);
  const col = { src: { x: 4, w: 84 }, ses: { x: 116, w: 116 }, ent: { x: 262, w: width - 266 } };
  const pitch = { src: 50, ses: 34, ent: 30 };
  const entities = [...people.map(person => ({ kind: "person" as const, label: person.name, sessions: person.sessionIds })),
    ...concepts.map(concept => ({ kind: "concept" as const, label: concept.term, sessions: [...concept.sessions] }))];
  const top = 26;
  const height = Math.max(top + overview.length * pitch.src, top + sessions.length * pitch.ses, top + entities.length * pitch.ent, top + 70) + 8;
  const srcY = (index: number) => top + index * pitch.src + 6;
  const sesY = (index: number) => top + index * pitch.ses;
  const entY = (index: number) => top + index * pitch.ent;
  const parts: string[] = [];
  const node = (x: number, y: number, w: number, h: number, tone: string) =>
    `<rect class="km-drop" x="${x + 2}" y="${y + 2}" width="${w}" height="${h}"/><rect class="km-frame km-${tone}" x="${x}" y="${y}" width="${w}" height="${h}"/><rect class="km-fill" x="${x + 2}" y="${y + 2}" width="${w - 4}" height="${h - 4}"/><rect class="km-tab km-${tone}" x="${x + 2}" y="${y + 2}" width="4" height="${h - 4}"/>`;
  /** Orthogonal stepped connector (pixel staircase look). */
  const edge = (x1: number, y1: number, x2: number, y2: number, tone: string, dashed = false) => {
    const mid = Math.round((x1 + x2) / 2);
    return `<path class="km-edge km-${tone}${dashed ? " km-dashed" : ""}" d="M${x1} ${y1}H${mid}V${y2}H${x2}"/>`;
  };
  parts.push(`<text class="km-col" x="${col.src.x}" y="14">SOURCES</text><text class="km-col" x="${col.ses.x}" y="14">SESSIONS</text><text class="km-col" x="${col.ent.x}" y="14">PEOPLE · CONCEPTS</text>`);
  // Edges first so nodes sit on top.
  sessions.forEach((session, index) => {
    const source = sessionSource(session);
    const from = overview.findIndex(item => item.source === source);
    parts.push(edge(col.src.x + col.src.w, srcY(from) + 19, col.ses.x, sesY(index) + 13, SOURCE_TONE[source]));
  });
  entities.forEach((entity, index) => {
    for (const id of entity.sessions) {
      const at = sessions.findIndex(session => session.id === id);
      if (at < 0) continue;
      parts.push(edge(col.ses.x + col.ses.w, sesY(at) + 13, col.ent.x, entY(index) + 11, entity.kind, entity.kind === "concept"));
    }
  });
  overview.forEach((item, index) => {
    const y = srcY(index), tone = SOURCE_TONE[item.source];
    parts.push(node(col.src.x, y, col.src.w, 38, tone),
      `<text class="km-label" x="${col.src.x + 11}" y="${y + 16}">${esc(SOURCE_LABEL[item.source].toUpperCase())}</text>`,
      `<text class="km-sub" x="${col.src.x + 11}" y="${y + 30}">${item.sessions} session${item.sessions === 1 ? "" : "s"}</text>`);
  });
  if (!sessions.length) parts.push(`<text class="km-sub" x="${col.ses.x}" y="${top + 16}">No sessions yet</text>`);
  sessions.forEach((session, index) => {
    const y = sesY(index), tone = SOURCE_TONE[sessionSource(session)];
    parts.push(node(col.ses.x, y, col.ses.w, 26, tone), `<text class="km-text" x="${col.ses.x + 10}" y="${y + 17}">${esc(clip(sessionTitle(session), 17))}</text>`);
  });
  entities.forEach((entity, index) => {
    const y = entY(index);
    parts.push(node(col.ent.x, y, col.ent.w, 22, entity.kind), `<text class="km-text" x="${col.ent.x + 10}" y="${y + 15}">${esc(clip(entity.label, Math.max(6, Math.floor((col.ent.w - 14) / 5.6))))}</text>`);
  });
  if (!entities.length && sessions.length) parts.push(`<text class="km-sub" x="${col.ent.x}" y="${top + 14}">Saved when the</text><text class="km-sub" x="${col.ent.x}" y="${top + 26}">copilot runs</text>`);
  return `<svg class="knowledge-map" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" shape-rendering="crispEdges" role="img" aria-label="Knowledge map: ${overview.map(item => `${SOURCE_LABEL[item.source]} ${item.sessions} sessions`).join(", ")}; ${sessions.length} recent sessions; ${people.length} people; ${concepts.length} concepts">${parts.join("")}</svg>`;
}

/* ============================================================ zip (store only) */

const CRC_TABLE = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
function crc32(bytes: Uint8Array): number { let c = 0xffffffff; for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
/** Uncompressed .zip of Markdown files, so an Obsidian vault folder can be dropped in as-is. */
export function zipFiles(files: readonly MarkdownFile[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  const u16 = (view: DataView, at: number, value: number) => view.setUint16(at, value, true);
  const u32 = (view: DataView, at: number, value: number) => view.setUint32(at, value, true);
  for (const file of files) {
    const name = encoder.encode(file.path), data = encoder.encode(file.content), crc = crc32(data);
    const local = new Uint8Array(30 + name.length); const lv = new DataView(local.buffer);
    u32(lv, 0, 0x04034b50); u16(lv, 4, 20); u16(lv, 6, 0x0800); u16(lv, 8, 0); u16(lv, 10, 0); u16(lv, 12, 0x21);
    u32(lv, 14, crc); u32(lv, 18, data.length); u32(lv, 22, data.length); u16(lv, 26, name.length); u16(lv, 28, 0); local.set(name, 30);
    const entry = new Uint8Array(46 + name.length); const cv = new DataView(entry.buffer);
    u32(cv, 0, 0x02014b50); u16(cv, 4, 20); u16(cv, 6, 20); u16(cv, 8, 0x0800); u16(cv, 10, 0); u16(cv, 12, 0); u16(cv, 14, 0x21);
    u32(cv, 16, crc); u32(cv, 20, data.length); u32(cv, 24, data.length); u16(cv, 28, name.length); u16(cv, 30, 0); u16(cv, 32, 0);
    u16(cv, 34, 0); u16(cv, 36, 0); u32(cv, 38, 0); u32(cv, 42, offset); entry.set(name, 46);
    chunks.push(local, data); central.push(entry); offset += local.length + data.length;
  }
  const size = central.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22); const ev = new DataView(end.buffer);
  u32(ev, 0, 0x06054b50); u16(ev, 8, files.length); u16(ev, 10, files.length); u32(ev, 12, size); u32(ev, 16, offset);
  const out = new Uint8Array(offset + size + 22);
  let at = 0; for (const chunk of [...chunks, ...central, end]) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/* ======================================================================= panel */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node;
};
const iconSpan = (name: IconName, className = "card-icon"): HTMLElement => { const span = el("span", className); span.setAttribute("aria-hidden", "true"); span.innerHTML = icon(name); return span; };
const button = (label: string, className = "button button-secondary button-small", iconName?: IconName): HTMLButtonElement => {
  const node = el("button", className); node.type = "button";
  if (iconName) node.append(iconSpan(iconName, "button-icon"));
  node.append(el("span", "button-label", label)); return node;
};
const SOURCE_COPY: Readonly<Record<KnowledgeSource, string>> = {
  omi: "Conversations imported from your Omi account",
  obsidian: "Notes imported from your Obsidian vault",
  helix: "Sessions captured live on G2",
};

export interface KnowledgePanelOptions {
  readonly omiKey: () => string;
  /** OpenAI key from Setup (in memory), for the OpenAI knowledge base sync. */
  readonly openaiKey?: () => string;
  readonly openSession?: (id: string) => void;
}

export class KnowledgePanel {
  private readonly panel = el("section", "knowledge-panel");
  private readonly sourcesNode = el("ul", "source-cards");
  private readonly mapNode = el("div", "knowledge-map-wrap");
  private readonly status = el("p", "field-note knowledge-status");
  private readonly local = el("input");
  private readonly web = el("input");
  private readonly importButton = button("Import from Omi", "button button-secondary button-small", "download");
  private readonly cancelButton = button("Cancel", "button button-quiet button-small", "stop");
  private readonly omiExportButton = button("Send all Helix sessions to Omi", "button button-secondary button-small", "send");
  private readonly obsidianToOmiButton = button("Send Obsidian notes to Omi", "button button-secondary button-small", "send");
  private readonly omiReason = el("p", "field-note");
  private readonly downloadSlot = el("div", "download-slot");
  // v0.13: results are shown next to the control that produced them, not only at the top of the tab.
  private readonly exportStatus = el("p", "field-note io-status");
  private readonly importStatus = el("p", "field-note io-status");
  private readonly importList = el("ul", "file-status-list");
  private readonly omiStatus = el("p", "field-note io-status");
  private readonly autoImport = el("input");
  private readonly summariesOnly = el("input");
  private readonly autoImportStatus = el("p", "field-note io-status");
  private readonly pdfList = el("ul", "file-status-list");
  private readonly pdfStatus = el("p", "field-note io-status");
  private readonly pdfCancel = button("Cancel", "button button-quiet button-small", "stop");
  private pdfBusy: HTMLElement[] = [];
  private pdfSignature = "[]";
  private readonly onVisible = () => { if (document.visibilityState === "visible") void this.controller.maybeAutoImport("resume"); };
  private readonly unsubscribe: () => void;
  private signature = "";
  private notice = "";

  constructor(root: HTMLElement, private readonly controller: G2ConversationController, private readonly options: KnowledgePanelOptions) {
    this.panel.id = "knowledge-panel";
    this.panel.setAttribute("aria-label", "Knowledge sources and transfers");
    this.status.id = "knowledge-status"; this.status.setAttribute("role", "status"); this.status.setAttribute("aria-live", "polite");

    const sources = this.group("Sources", "database", "Omi: imported conversations · Obsidian: imported notes · Helix: live G2 sessions. Everything stays on this phone until you export or send it.");
    sources.append(this.sourcesNode);
    const map = this.group("Knowledge map", "bulb", "Sources feed sessions; sessions link the people and concepts found in them.");
    map.append(this.mapNode);

    // Transfers: one route per direction.
    const transfers = this.group("Transfers", "send", "Move context between Helix, Obsidian and Omi.");
    transfers.append(
      this.route("helix", "obsidian", "Export sessions as Markdown notes with summary, people, concepts and a Mermaid map.", this.exportControls()),
      this.route("obsidian", "helix", "Import .md or .txt notes: choose files, paste text, or load a link. Summary, key facts, people and “Speaker: text” lines are kept.", this.importControls()),
      this.route("omi", "helix", "Import your Omi conversations (uses the Omi API key in Setup → API keys). Repeat imports update existing records. Conversations that Helix sent to Omi are not imported back.", this.omiImportControls()),
      this.pdfCard(),
      this.route("helix", "omi", "Send saved sessions to Omi as conversations. Needs an Omi developer key with conversations:write; Omi accepts about 25 per hour.", this.omiExportControls()),
      this.route("obsidian", "omi", "Import notes from Obsidian first, then send them to Omi.", this.obsidianToOmiControls()),
    );

    // Memory toggles (moved here from History).
    const memory = this.group("Memory", "magnifier", "How saved context is used during a live conversation.");
    this.local.type = this.web.type = "checkbox";
    this.local.id = "use-local-memory"; this.web.id = "live-web-fact-check";
    const localLabel = el("label", "toggle"); localLabel.htmlFor = this.local.id;
    localLabel.append(this.local, this.toggleText("Use saved knowledge in answers", "Answers may cite earlier sessions from all three sources and the PDFs you added. Off: nothing saved is read or synced"));
    const webLabel = el("label", "toggle"); webLabel.htmlFor = this.web.id;
    webLabel.append(this.web, this.toggleText("Live web fact check", "Short claims are checked as you talk"));
    const disclosure = el("p", "field-note", "When enabled, short speech claims are sent to the web search of your answer provider (OpenAI by default; see Setup → Copilot). Search incurs provider charges. Checks may take time and do not verify every utterance. Saved knowledge includes the summaries, key facts and concepts of imported conversations and notes.");
    this.local.addEventListener("change", () => { void controller.setLocalMemoryEnabled(this.local.checked); });
    this.web.addEventListener("change", () => { void controller.setLiveWebFactCheckEnabled(this.web.checked); });
    memory.append(localLabel, this.knowledgeControls(), webLabel, disclosure);

    this.panel.prepend(this.status);
    root.append(this.panel);
    for (const node of [this.exportStatus, this.importStatus, this.omiStatus, this.autoImportStatus, this.pdfStatus]) node.setAttribute("role", "status");
    this.unsubscribe = controller.subscribeHistory(state => this.render(state));
    // v0.13 Omi auto-import: the controller checks once now and then every minute; also when the app returns to the foreground.
    controller.configureAutoImport(options.omiKey);
    document.addEventListener("visibilitychange", this.onVisible);
  }

  public dispose(): void { document.removeEventListener("visibilitychange", this.onVisible); this.unsubscribe(); this.panel.remove(); }

  /** A result line beside the control that produced it, mirrored in the tab's status line. */
  private say(node: HTMLElement, message: string): void { node.textContent = message; this.setNotice(message); }
  private fileRows(list: HTMLElement, lines: readonly FileLine[]): void {
    list.replaceChildren(...lines.map(line => {
      const row = el("li", `file-status is-${line.state}`);
      row.append(el("span", "file-status-name", line.name), el("span", "file-status-detail", line.detail));
      return row;
    }));
  }

  private group(title: string, iconName: IconName, copy: string): HTMLElement {
    const section = el("section", "config-group knowledge-group");
    const heading = el("div", "config-group-heading");
    const h3 = el("h3", "group-title"); h3.append(iconSpan(iconName, "section-icon"), title);
    heading.append(h3, el("p", "", copy));
    section.append(heading); this.panel.append(section); return section;
  }
  private toggleText(title: string, note: string): HTMLElement { const span = el("span", "", title); span.append(el("small", "", note)); return span; }

  private route(from: KnowledgeSource, to: KnowledgeSource, copy: string, controls: HTMLElement): HTMLElement {
    const card = el("article", `route-card route-${from}-${to}`);
    const head = el("div", "route-head");
    const badge = (source: KnowledgeSource) => { const node = el("span", `source-badge badge-${source}`); node.append(iconSpan(SOURCE_ICON[source], "badge-icon"), SOURCE_LABEL[source]); return node; };
    const arrow = el("span", "route-arrow"); arrow.setAttribute("aria-hidden", "true");
    head.append(badge(from), arrow, badge(to));
    head.setAttribute("aria-label", `${SOURCE_LABEL[from]} to ${SOURCE_LABEL[to]}`);
    card.append(head, el("p", "route-copy", copy), controls);
    return card;
  }

  private exportControls(): HTMLElement {
    const row = el("div", "button-row");
    const vault = button("Export vault", "button button-secondary button-small", "download");
    const copy = button("Copy Markdown", "button button-secondary button-small", "copy");
    const show = button("Show Markdown here", "button button-quiet button-small", "book");
    const view = el("textarea", "export-view"); view.readOnly = true; view.rows = 8; view.hidden = true; view.id = "vault-export-view";
    view.setAttribute("aria-label", "Exported Markdown. Select all and copy.");
    const reveal = (text: string) => { view.value = text; view.hidden = false; view.focus({ preventScroll: true }); view.select(); };
    vault.addEventListener("click", () => {
      const files = this.controller.vaultFiles();
      if (!files.length) { this.say(this.exportStatus, "Nothing to export yet."); return; }
      const text = combinedMarkdown(files), count = `${files.length} note${files.length === 1 ? "" : "s"}`;
      const file = files.length === 1 ? { name: files[0]!.path.split("/").pop()!, content: files[0]!.content, type: "text/markdown", text }
        : { name: `helix-vault-${new Date().toISOString().slice(0, 10)}.zip`, content: zipFiles(files), type: "application/zip", text };
      // Called straight from the tap: the share sheet needs the user gesture. The line below stays while a share sheet is open.
      this.say(this.exportStatus, `Exporting ${count}… If a share sheet opened, choose where to save. Otherwise use Copy Markdown or Show Markdown here.`);
      void exportFile<HTMLAnchorElement>(file, browserTransferEnv(copyToClipboard)).then(result => {
        this.downloadSlot.replaceChildren(...(result.link ? [result.link] : []));
        if (result.method === "view") reveal(text);
        this.say(this.exportStatus, result.cancelled ? result.message : `${result.message} (${count}${file.type === "application/zip" && (result.method === "share" || result.method === "download") ? "; unzip it into your vault" : ""})`);
      });
    });
    copy.addEventListener("click", () => {
      const files = this.controller.vaultFiles();
      if (!files.length) { this.say(this.exportStatus, "Nothing to export yet."); return; }
      const text = combinedMarkdown(files);
      void copyToClipboard(text).then(ok => {
        if (!ok) reveal(text);
        this.say(this.exportStatus, ok ? `Copied ${files.length} note${files.length === 1 ? "" : "s"} as Markdown.` : "Copy was blocked. The Markdown is shown below: select all of it and copy.");
      });
    });
    show.addEventListener("click", () => {
      if (!view.hidden) { view.hidden = true; return; }
      const files = this.controller.vaultFiles();
      if (!files.length) { this.say(this.exportStatus, "Nothing to export yet."); return; }
      reveal(combinedMarkdown(files));
    });
    row.append(vault, copy, show);
    const wrap = el("div", "route-controls"); wrap.append(row, this.exportStatus, this.downloadSlot, view,
      el("p", "field-note", inEmbeddedWebView()
        ? "Inside the Even app, Export opens the share sheet when the phone offers one; otherwise the notes are copied to the clipboard or shown here. One session at a time: History → open a session → Export .md."
        : "One session at a time: History → open a session → Export .md."));
    return wrap;
  }

  private importControls(): HTMLElement {
    const wrap = el("div", "route-controls");
    // No `accept` filter: iOS greys out .md files for extension filters it does not know. The content is checked after reading.
    const input = el("input"); input.type = "file"; input.multiple = true; input.id = "obsidian-import-files";
    const label = el("label", "file-pick"); label.htmlFor = input.id;
    label.append(iconSpan("upload", "button-icon"), el("span", "button-label", "Choose note files"), input);
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      if (!files.length) { this.say(this.importStatus, "No file was selected."); return; }
      // v0.16: each file is read only when its turn comes, so a large selection is never all in memory at once.
      void this.importMarkdown(files.map(file => ({ name: file.name, text: () => readTextFile(file), lastModified: file.lastModified,
        ...(file.webkitRelativePath ? { path: file.webkitRelativePath } : {}) })))
        .finally(() => { input.value = ""; });
    });
    const paste = el("details", "paste-markdown");
    const summary = el("summary", "", "Paste text instead (no file picker needed)");
    const area = el("textarea"); area.id = "obsidian-paste"; area.rows = 6; area.placeholder = "# Note title\n\n## Summary\n- …\n\nPriya: …";
    const pasteLabel = el("label", "sr-only", "Markdown to import"); pasteLabel.htmlFor = area.id;
    const go = button("Import pasted note", "button button-secondary button-small", "upload");
    go.addEventListener("click", () => {
      const text = area.value;
      if (!text.trim()) { this.say(this.importStatus, "Paste a Markdown note first."); return; }
      const title = /^#\s+(.+)$/mu.exec(text)?.[1]?.trim() ?? "Pasted note";
      void this.importMarkdown([{ name: `${title.slice(0, 60)}.md`, text, pasted: true }]).then(ok => { if (ok) area.value = ""; });
    });
    paste.append(summary, pasteLabel, area, go);
    const link = el("details", "paste-markdown");
    const url = el("input"); url.type = "url"; url.id = "obsidian-import-url"; url.placeholder = "https://…/note.md"; url.autocapitalize = "none"; url.spellcheck = false;
    const urlLabel = el("label", "sr-only", "Link to a Markdown or text file"); urlLabel.htmlFor = url.id;
    const load = button("Import from link", "button button-secondary button-small", "download");
    load.addEventListener("click", () => {
      load.disabled = true; this.say(this.importStatus, "Loading the link…");
      const from = url.value;
      void fetchTextFromUrl(from).then(file => this.importMarkdown([{ ...file, path: importUrl(from).toString() }])).then(ok => { if (ok) url.value = ""; })
        .catch(error => this.say(this.importStatus, error instanceof Error ? error.message : String(error)))
        .finally(() => { load.disabled = false; });
    });
    link.append(el("summary", "", "Import from a link"), urlLabel, url, load,
      el("p", "field-note", "Works for links that allow cross-site reads. Inside the Even app only the plugin's listed provider hosts can be reached, so most links fail there: paste the text instead."));
    wrap.append(label, paste, link, this.importStatus, this.importList);
    return wrap;
  }

  private async importMarkdown(files: MarkdownImportItem[]): Promise<boolean> {
    this.say(this.importStatus, `Importing ${files.length} note${files.length === 1 ? "" : "s"}…`);
    try {
      const result = await this.controller.importMarkdownFiles(files, {
        // Progress stays on the card ("3 / 40"); only the result is mirrored in the tab's status line.
        onProgress: progress => { this.importStatus.textContent = `Importing ${progress.done + 1} / ${progress.total}: ${progress.name}`; },
      });
      this.fileRows(this.importList, markdownOutcomeLines(result.files));
      this.say(this.importStatus, result.message);
      return result.imported > 0;
    } catch (error) { this.say(this.importStatus, `Import failed: ${error instanceof Error ? error.message : String(error)}`); return false; }
  }

  /** v0.13: several PDFs into the knowledge base, parsed on the phone or by OpenAI. */
  private pdfCard(): HTMLElement {
    const card = el("article", "route-card route-pdf");
    const head = el("div", "route-head");
    const from = el("span", "source-badge badge-pdf"); from.append(iconSpan("book", "badge-icon"), "PDF");
    const arrow = el("span", "route-arrow"); arrow.setAttribute("aria-hidden", "true");
    const to = el("span", "source-badge badge-helix"); to.append(iconSpan(SOURCE_ICON.helix, "badge-icon"), SOURCE_LABEL.helix);
    head.append(from, arrow, to); head.setAttribute("aria-label", "PDF documents to Helix");
    const megabytes = Math.round(PDF_LIMITS.maxBytes / 1024 / 1024);
    const copy = el("p", "route-copy", `Add PDF documents to the knowledge base. Their text becomes searchable in answers (and is synced to the OpenAI knowledge base when you use it). Up to ${PDF_LIMITS.maxFiles} PDFs at once, ${megabytes} MB each. The parsed text is stored with your imported notes and Omi conversations, which together hold 5 MiB (separate from your live sessions), so several large PDFs may not all fit; one that does not fit is reported as failed and nothing of it is kept. They are stored under Obsidian with the tag “pdf” and listed in History under Documents, where you can open or remove them. “Use saved knowledge in answers” must be on for answers to read them.`);
    const box = el("fieldset", "toggle-group pdf-parser"); box.append(el("legend", "", "Read the PDFs"));
    const local = el("input"), openai = el("input");
    const option = (input: HTMLInputElement, value: PdfParser, title: string, note: string) => {
      input.type = "radio"; input.name = "pdf-parser"; input.value = value; input.id = `pdf-parser-${value}`;
      const label = el("label", "toggle"); label.htmlFor = input.id; label.append(input, this.toggleText(title, note)); return label;
    };
    box.append(
      option(local, "local", "On this phone", `Nothing is uploaded and it costs nothing. Reads the text layer only: scanned or photographed PDFs have no text to read (no OCR), and multi-column pages can come out mixed. First ${PDF_LIMITS.maxPages} pages.`),
      option(openai, "openai", "With OpenAI", "Uploads each PDF to your OpenAI project with the key from Setup. OpenAI reads the text and an image of every page, so scanned PDFs work; you pay for input tokens per page plus the transcribed text as output tokens. The upload is deleted from OpenAI when the PDF is done."),
    );
    local.checked = true;
    const parser = (): PdfParser => openai.checked ? "openai" : "local";
    const input = el("input"); input.type = "file"; input.multiple = true; input.accept = "application/pdf,.pdf"; input.id = "pdf-import-files";
    const pick = el("label", "file-pick"); pick.htmlFor = input.id;
    pick.append(iconSpan("upload", "button-icon"), el("span", "button-label", "Choose PDFs"), input);
    const start = (inputs: PdfInput[], done: () => void) => {
      if (!inputs.length) { this.say(this.pdfStatus, "No PDF was selected."); done(); return; }
      const mode = parser();
      this.say(this.pdfStatus, mode === "openai" ? `Sending ${inputs.length} PDF${inputs.length === 1 ? "" : "s"} to OpenAI, one at a time…` : `Reading ${inputs.length} PDF${inputs.length === 1 ? "" : "s"} on this phone…`);
      void this.controller.importPdfs(inputs, { parser: mode, openaiKey: this.options.openaiKey?.() ?? "",
        // pdfjs is a separate chunk, fetched only now.
        extractLocal: async (data, extract) => (await import("./pdf-local")).extractPdfText(data, extract) })
        .then(files => {
          const added = files.filter(file => file.state === "done").length, failed = files.length - added;
          this.say(this.pdfStatus, `Added ${added} of ${files.length} PDF${files.length === 1 ? "" : "s"}.${failed ? ` ${failed} not added (see below).` : ""}${added ? " Ask about them, or find them in History under Documents." : ""}`);
        })
        .catch(error => this.say(this.pdfStatus, error instanceof Error ? error.message : String(error)))
        .finally(done);
    };
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      start(files.map(file => ({ name: file.name, size: file.size, data: file })), () => { input.value = ""; });
    });
    const link = el("details", "paste-markdown");
    const url = el("input"); url.type = "url"; url.id = "pdf-import-url"; url.placeholder = "https://…/paper.pdf"; url.autocapitalize = "none"; url.spellcheck = false;
    const urlLabel = el("label", "sr-only", "Link to a PDF"); urlLabel.htmlFor = url.id;
    const add = button("Add PDF from link (OpenAI)", "button button-secondary button-small", "download");
    add.addEventListener("click", () => {
      let target: URL;
      try { target = importUrl(url.value); } catch (error) { this.say(this.pdfStatus, error instanceof Error ? error.message : String(error)); return; }
      openai.checked = true; // a link is fetched by OpenAI, not by the phone
      start([{ name: urlFileName(target, "pdf"), url: target.toString() }], () => { url.value = ""; });
    });
    link.append(el("summary", "", "No file picker? Add a PDF by link"), urlLabel, url, add,
      el("p", "field-note", "The link is sent to OpenAI, which downloads and reads the PDF (publicly reachable https links only). The phone does not download it, so this also works where the file picker does not."));
    this.pdfCancel.id = "pdf-import-cancel"; this.pdfCancel.hidden = true;
    this.pdfCancel.addEventListener("click", () => this.controller.cancelPdfImport());
    this.pdfBusy = [input, add, local, openai];
    const controls = el("div", "route-controls"); controls.append(box, pick, link, this.pdfCancel, this.pdfStatus, this.pdfList);
    card.append(head, copy, controls);
    return card;
  }

  private omiImportControls(): HTMLElement {
    const wrap = el("div", "route-controls");
    const start = el("input"), end = el("input"); start.type = end.type = "date";
    start.id = "omi-import-start"; end.id = "omi-import-end";
    const startLabel = el("label", "", "From (optional, your local date)"); startLabel.append(start);
    const endLabel = el("label", "", "Through (optional, your local date)"); endLabel.append(end);
    const grid = el("div", "field-grid"); grid.append(startLabel, endLabel);
    this.importButton.id = "import-omi"; this.cancelButton.id = "cancel-omi-import";
    this.importButton.addEventListener("click", () => {
      if (!this.options.omiKey().trim()) { this.say(this.omiStatus, "Enter your Omi developer API key in Setup → API keys first."); return; }
      // v0.16: plain dates are days in this phone's time zone (the SDK turns them into the first and last moment of the day).
      void this.controller.importOmi({ key: this.options.omiKey(), summariesOnly: this.summariesOnly.checked, ...(start.value ? { startDate: start.value } : {}), ...(end.value ? { endDate: end.value } : {}) })
        .catch(error => this.say(this.omiStatus, error instanceof Error ? error.message : String(error)));
    });
    this.cancelButton.addEventListener("click", () => this.controller.cancelImport());
    const row = el("div", "button-row"); row.append(this.importButton, this.cancelButton);
    // v0.13 auto-import
    this.autoImport.type = "checkbox"; this.autoImport.id = "omi-auto-import";
    const autoLabel = el("label", "toggle"); autoLabel.htmlFor = this.autoImport.id;
    autoLabel.append(this.autoImport, this.toggleText("Import new Omi conversations automatically", "When Helix opens and about every 30 minutes while it is open. Needs the Omi key saved on this phone."));
    this.autoImport.addEventListener("change", () => { void this.controller.setAutoImportEnabled(this.autoImport.checked); });
    // v0.16 summaries only: a small import for a large Omi history.
    this.summariesOnly.type = "checkbox"; this.summariesOnly.id = "omi-summaries-only";
    const summariesLabel = el("label", "toggle"); summariesLabel.htmlFor = this.summariesOnly.id;
    summariesLabel.append(this.summariesOnly, this.toggleText("Summaries only", "Saves each conversation's title, overview and action items, and no transcript. Transcripts already saved stay. Uses much less space; answers can still search the summaries. Also applies to automatic imports."));
    this.summariesOnly.addEventListener("change", () => { void this.controller.setOmiSummariesOnly(this.summariesOnly.checked); });
    wrap.append(grid, summariesLabel, row, this.omiStatus, autoLabel, this.autoImportStatus,
      el("p", "field-note", "Automatic import cannot run while the Even app is closed or Helix is not open: plugins have no background execution."));
    return wrap;
  }

  private omiExportControls(): HTMLElement {
    const wrap = el("div", "route-controls");
    this.omiExportButton.id = "export-omi";
    this.omiExportButton.addEventListener("click", () => { void this.sendToOmi("helix"); });
    wrap.append(this.omiExportButton, this.omiReason);
    return wrap;
  }

  private obsidianToOmiControls(): HTMLElement {
    const wrap = el("div", "route-controls");
    this.obsidianToOmiButton.id = "export-obsidian-omi";
    this.obsidianToOmiButton.addEventListener("click", () => { void this.sendToOmi("obsidian"); });
    wrap.append(this.obsidianToOmiButton);
    return wrap;
  }

  private async sendToOmi(source: KnowledgeSource): Promise<void> {
    // v0.13: PDF documents are stored under the Obsidian source but are not notes to send to Omi.
    const ids = this.controller.listHistorySessions().filter(session => sessionSource(session) === source && !session.id.startsWith("pdf:")).map(session => session.id);
    if (!ids.length) { this.setNotice(source === "obsidian" ? "Import notes from Obsidian first." : "No Helix sessions to send yet."); return; }
    this.omiExportButton.disabled = this.obsidianToOmiButton.disabled = true;
    try {
      const result = await this.controller.exportSessionsToOmi(ids, this.options.omiKey());
      this.setNotice(result.message);
    } catch (error) { this.setNotice(error instanceof Error ? error.message : String(error)); }
    finally { this.signature = ""; this.render(this.controller.historySnapshot()); }
  }

  private setNotice(message: string): void {
    this.notice = message; this.status.textContent = message;
    setTimeout(() => { if (this.notice === message) { this.notice = ""; } }, 8000);
  }

  // ---- v0.12 knowledge base source: on this phone, or an OpenAI vector store ----
  private readonly kbLocal = document.createElement("input");
  private readonly kbOpenai = document.createElement("input");
  private readonly kbStatus = el("p", "field-note kb-status");
  private readonly kbSync = document.createElement("button");
  private readonly kbStop = document.createElement("button");
  private readonly kbDelete = document.createElement("button");
  private knowledgeControls(): HTMLElement {
    const box = el("fieldset", "toggle-group kb-source");
    const legend = el("legend", "", "Knowledge base for answers"); box.append(legend);
    const option = (input: HTMLInputElement, value: string, title: string, note: string) => {
      input.type = "radio"; input.name = "knowledge-source"; input.value = value; input.id = `knowledge-source-${value}`;
      const label = el("label", "toggle"); label.htmlFor = input.id; label.append(input, this.toggleText(title, note));
      input.addEventListener("change", () => { if (input.checked) void this.controller.setKnowledgeSource(value === "openai" ? "openai" : "local"); });
      return label;
    };
    this.kbStatus.id = "knowledge-base-status"; this.kbStatus.setAttribute("role", "status");
    for (const [node, id, text, style] of [[this.kbSync, "knowledge-sync", "Sync to OpenAI", "button-secondary"], [this.kbStop, "knowledge-sync-stop", "Stop", "button-quiet"], [this.kbDelete, "knowledge-delete", "Delete from OpenAI", "button-quiet"]] as const) {
      node.type = "button"; node.id = id; node.textContent = text; node.className = `button ${style} button-small`;
    }
    const key = () => this.options.openaiKey?.() ?? "";
    const run = (work: Promise<unknown>) => { void work.catch(() => undefined); }; // the controller puts the outcome in the status line
    this.kbSync.addEventListener("click", () => run(this.controller.syncOpenAIKnowledge(key())));
    this.kbStop.addEventListener("click", () => this.controller.cancelKnowledgeSync());
    // v0.13: confirmed in the page, like removing a session (a native confirm dialog can block the Even WebView).
    const confirmSlot = el("div", "history-confirm-slot"); confirmSlot.id = "knowledge-delete-confirm";
    this.kbDelete.addEventListener("click", () => {
      confirmSlot.replaceChildren(confirmBar("Delete the Helix knowledge base from your OpenAI project? The sessions stay on this phone. This cannot be undone.",
        "Delete from OpenAI", () => { confirmSlot.replaceChildren(); run(this.controller.deleteOpenAIKnowledge(key())); }, () => { confirmSlot.replaceChildren(); this.kbDelete.focus({ preventScroll: true }); }));
    });
    const actions = el("div", "provider-key-actions"); actions.append(this.kbSync, this.kbStop, this.kbDelete);
    box.append(
      option(this.kbLocal, "local", "On this phone", "Keyword search over saved sessions. Nothing leaves the phone for the lookup."),
      option(this.kbOpenai, "openai", "OpenAI knowledge base", "Semantic search in a vector store in your own OpenAI project. Adds one request per answer; falls back to the phone if it is slow."),
      actions, confirmSlot, this.kbStatus,
      el("p", "field-note", "Sync uploads your saved sessions (transcripts, answers, summaries) as files to your OpenAI project with the key from Setup. OpenAI stores them until you delete them; the first 1 GB of vector storage is free, then about $0.10 per GB per day. Both options need “Use saved knowledge in answers” on (the same switch as History → “Let the knowledge base read history”)."),
    );
    return box;
  }
  private renderKnowledgeBase(state: HistoryState): void {
    const kb = state.knowledge;
    this.kbLocal.checked = kb.source === "local"; this.kbOpenai.checked = kb.source === "openai";
    this.kbSync.disabled = !!kb.syncing; this.kbStop.hidden = !kb.syncing; this.kbDelete.hidden = !kb.hasStore; this.kbDelete.disabled = !!kb.syncing;
    this.kbSync.textContent = kb.hasStore ? (kb.pending ? `Sync ${kb.pending} to OpenAI` : "Sync to OpenAI") : "Create and sync to OpenAI";
    const when = kb.syncedAt ? new Date(kb.syncedAt).toLocaleString() : "";
    this.kbStatus.textContent = kb.syncing ? `Syncing ${kb.syncing.done} of ${kb.syncing.total}…${kb.syncing.failed ? ` ${kb.syncing.failed} failed` : ""}`
      : kb.notice ? kb.notice
      : kb.hasStore ? `${kb.synced} session${kb.synced === 1 ? "" : "s"} in OpenAI${kb.pending ? ` · ${kb.pending} new or changed, not synced yet` : kb.removals ? "" : " · up to date"}${kb.removals ? ` · ${kb.removals} removed on this phone, still in OpenAI until you sync` : ""}${when ? ` · last sync ${when}` : ""}`
      : kb.source === "openai" ? "Nothing is in OpenAI yet: answers use the phone until you sync." : "";
  }

  private dirty = false;
  /** Called when the Knowledge tab is shown. */
  public refresh(): void { if (this.dirty) { this.dirty = false; this.render(this.controller.historySnapshot()); } }
  private render(state: HistoryState): void {
    this.local.checked = state.useLocalMemory; this.web.checked = state.liveWebFactCheck;
    this.renderKnowledgeBase(state);
    this.importButton.disabled = state.importing; this.cancelButton.disabled = !state.importing;
    // v0.13: Omi import progress beside its buttons, auto-import state, PDF progress.
    // v0.16: the card shows its own import's progress and outcome, whatever the words (a storage error names neither Omi nor conversations).
    if (state.omiImport.message) this.omiStatus.textContent = state.omiImport.message;
    this.omiStatus.classList.toggle("is-warning", !!state.omiImport.failed);
    this.summariesOnly.checked = !!state.autoImport.summariesOnly; this.summariesOnly.disabled = state.importing;
    this.autoImport.checked = state.autoImport.enabled;
    this.autoImportStatus.textContent = autoImportText(state.autoImport);
    this.autoImportStatus.classList.toggle("is-warning", state.autoImport.enabled && !!state.autoImport.lastError);
    this.pdfCancel.hidden = !state.pdfImport.running;
    for (const node of this.pdfBusy) (node as HTMLInputElement | HTMLButtonElement).disabled = state.pdfImport.running;
    const pdfLines = state.pdfImport.files.map(file => pdfFileLine(file, state.pdfImport.parser)), pdfSignature = JSON.stringify(pdfLines);
    if (pdfSignature !== this.pdfSignature) { this.pdfSignature = pdfSignature; this.fileRows(this.pdfList, pdfLines); }
    if (!this.notice) this.status.textContent = state.status;
    if (this.panel.closest("[hidden]")) { this.dirty = true; return; }
    const support = this.controller.omiExportSupport();
    const counts = sourceOverview(this.controller.knowledgeStats());
    this.omiExportButton.disabled = !support.supported || !counts.find(item => item.source === "helix")?.sessions;
    this.obsidianToOmiButton.disabled = !support.supported || !counts.find(item => item.source === "obsidian")?.sessions;
    this.omiReason.textContent = support.supported ? "" : support.reason;
    this.omiReason.hidden = support.supported;
    const sessions = this.controller.listHistorySessions();
    const people = this.controller.listPeople();
    const signature = JSON.stringify([counts, sessions.map(session => [session.id, session.updatedAt, session.title, session.people, session.concepts]), people.map(person => [person.name, person.sessionIds])]);
    if (signature === this.signature) return;
    this.signature = signature;
    this.sourcesNode.replaceChildren(...counts.map(item => {
      const card = el("li", `card source-card source-${item.source}`);
      card.title = SOURCE_COPY[item.source];
      const head = el("div", "card-head");
      head.append(iconSpan(SOURCE_ICON[item.source]), el("h4", "card-title", SOURCE_LABEL[item.source]));
      const tally = el("p", "source-tally");
      tally.append(el("strong", "", String(item.sessions)), el("span", "", `session${item.sessions === 1 ? "" : "s"}`));
      card.append(head, tally, el("p", "source-lines", `${item.entries} line${item.entries === 1 ? "" : "s"}`),
        el("p", "panel-meta", item.lastUpdated ? `Updated ${shortDate(item.lastUpdated)}` : "Nothing yet"));
      card.setAttribute("aria-label", `${SOURCE_LABEL[item.source]} context: ${item.sessions} sessions, ${item.entries} lines. ${SOURCE_COPY[item.source]}.`);
      return card;
    }));
    // v0.13: the map shows the titles History shows (never a placeholder or the first utterance).
    this.mapNode.innerHTML = knowledgeMapSvg({ stats: this.controller.knowledgeStats(), sessions: sessions.map(session => ({ ...session, title: this.controller.historyTitle(session) })), people });
    this.mapNode.prepend(...[pixelLegend()]);
  }
}

function shortDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function pixelLegend(): HTMLElement {
  const legend = el("p", "km-legend");
  for (const [tone, label] of [["helix", "Helix"], ["omi", "Omi"], ["obsidian", "Obsidian"], ["person", "Person"], ["concept", "Concept"]] as const) {
    const item = el("span", `km-key km-key-${tone}`, label); legend.append(item);
  }
  return legend;
}

