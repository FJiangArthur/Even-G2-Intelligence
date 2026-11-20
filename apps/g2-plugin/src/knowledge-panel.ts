/**
 * v0.8 Knowledge tab: Omi / Obsidian / local Helix context, a pixel knowledge map, and transfers
 * among the three. The top half is pure (no DOM at module load) so the controller and tests can
 * use it; the panel class at the bottom renders into the phone WebView.
 */
import {
  markdownToSession, sessionToMarkdown, vaultBundle,
  type HistoryEntry, type HistorySession, type KnowledgeSource, type KnowledgeStats, type OmiExportResult, type PersonAggregate, type VaultFile,
} from "@helix/conversation-sdk";
import type { G2ConversationController, HistoryState } from "./controller";
import {
  SOURCE_ICON, SOURCE_LABEL, cleanLineText, copyToClipboard, downloadFile, sessionKnowledge, sessionSource, sessionTitle,
} from "./history-panel";
import { icon, type IconName } from "./pixel-art";

/* ================================================================ SDK adapter */

export type MarkdownFile = VaultFile;
export interface ImportedSession { readonly session: HistorySession; readonly entries: HistoryEntry[] }

/** Session -> Obsidian note (SDK sessionToMarkdown: frontmatter, sections, Mermaid mindmap, clean transcript). */
export function sessionMarkdown(session: HistorySession, entries: readonly HistoryEntry[]): string {
  return sessionToMarkdown(session, entries);
}

/** Obsidian note -> session + entries (SDK markdownToSession; source "obsidian"). */
export function markdownSession(name: string, markdown: string): ImportedSession {
  try {
    const parsed = markdownToSession(markdown, name);
    return { session: { ...parsed.session, source: "obsidian" }, entries: parsed.entries };
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
      this.route("obsidian", "helix", "Import .md notes. Summary, key facts, people and “Speaker: text” lines are kept.", this.importControls()),
      this.route("omi", "helix", "Import your Omi conversations (uses the Omi API key in Setup → API keys). Repeat imports update existing records.", this.omiImportControls()),
      this.route("helix", "omi", "Send saved sessions to Omi as conversations. Needs an Omi developer key with conversations:write; Omi accepts about 25 per hour.", this.omiExportControls()),
      this.route("obsidian", "omi", "Import notes from Obsidian first, then send them to Omi.", this.obsidianToOmiControls()),
    );

    // Memory toggles (moved here from History).
    const memory = this.group("Memory", "magnifier", "How saved context is used during a live conversation.");
    this.local.type = this.web.type = "checkbox";
    this.local.id = "use-local-memory"; this.web.id = "live-web-fact-check";
    const localLabel = el("label", "toggle"); localLabel.htmlFor = this.local.id;
    localLabel.append(this.local, this.toggleText("Use saved knowledge in answers", "Answers may cite earlier sessions from all three sources"));
    const webLabel = el("label", "toggle"); webLabel.htmlFor = this.web.id;
    webLabel.append(this.web, this.toggleText("Live web fact check", "Short claims are checked as you talk"));
    const disclosure = el("p", "field-note", "When enabled, short speech claims are sent to OpenAI web search. Search incurs provider charges. Checks may take time and do not verify every utterance. Imported summaries and AI answers are never used as memory evidence.");
    this.local.addEventListener("change", () => { void controller.setLocalMemoryEnabled(this.local.checked); });
    this.web.addEventListener("change", () => { void controller.setLiveWebFactCheckEnabled(this.web.checked); });
    memory.append(localLabel, this.knowledgeControls(), webLabel, disclosure);

    this.panel.prepend(this.status);
    root.append(this.panel);
    this.unsubscribe = controller.subscribeHistory(state => this.render(state));
  }

  public dispose(): void { this.unsubscribe(); this.panel.remove(); }

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
    const vault = button("Download vault", "button button-secondary button-small", "download");
    const copy = button("Copy Markdown", "button button-secondary button-small", "copy");
    vault.addEventListener("click", () => {
      const files = this.controller.vaultFiles();
      if (!files.length) { this.setNotice("Nothing to export yet."); return; }
      const single = files.length === 1;
      const result = single ? downloadFile(files[0]!.path.split("/").pop()!, files[0]!.content, "text/markdown")
        : downloadFile(`helix-vault-${new Date().toISOString().slice(0, 10)}.zip`, zipFiles(files), "application/zip");
      this.downloadSlot.replaceChildren(...(result.link ? [result.link] : []));
      this.setNotice(result.ok ? `Prepared ${result.name} (${files.length} note${files.length === 1 ? "" : "s"}). Unzip it into your vault. If nothing downloaded, tap the link or use Copy Markdown.` : "Downloads are blocked in this app. Use Copy Markdown and paste into Obsidian.");
    });
    copy.addEventListener("click", () => {
      const files = this.controller.vaultFiles();
      void copyToClipboard(combinedMarkdown(files)).then(ok => this.setNotice(ok ? `Copied ${files.length} note${files.length === 1 ? "" : "s"} as Markdown.` : "Copy was blocked. Export a single session from History and select its Markdown preview."));
    });
    row.append(vault, copy);
    const wrap = el("div", "route-controls"); wrap.append(row, this.downloadSlot,
      el("p", "field-note", "One session at a time: History → open a session → Export .md."));
    return wrap;
  }

  private importControls(): HTMLElement {
    const wrap = el("div", "route-controls");
    const input = el("input"); input.type = "file"; input.multiple = true; input.accept = ".md,text/markdown"; input.id = "obsidian-import-files";
    const label = el("label", "file-pick"); label.htmlFor = input.id;
    label.append(iconSpan("upload", "button-icon"), el("span", "button-label", "Choose .md files"), input);
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      if (!files.length) return;
      void Promise.all(files.map(async file => ({ name: file.name, text: await file.text() })))
        .then(items => this.importMarkdown(items))
        .finally(() => { input.value = ""; });
    });
    const paste = el("details", "paste-markdown");
    const summary = el("summary", "", "Paste Markdown instead");
    const area = el("textarea"); area.id = "obsidian-paste"; area.rows = 6; area.placeholder = "# Note title\n\n## Summary\n- …\n\nPriya: …";
    const pasteLabel = el("label", "sr-only", "Markdown to import"); pasteLabel.htmlFor = area.id;
    const go = button("Import pasted note", "button button-secondary button-small", "upload");
    go.addEventListener("click", () => {
      const text = area.value;
      if (!text.trim()) { this.setNotice("Paste a Markdown note first."); return; }
      const title = /^#\s+(.+)$/mu.exec(text)?.[1]?.trim() ?? "Pasted note";
      void this.importMarkdown([{ name: `${title.slice(0, 60)}.md`, text }]).then(ok => { if (ok) area.value = ""; });
    });
    paste.append(summary, pasteLabel, area, go);
    wrap.append(label, paste);
    return wrap;
  }

  private async importMarkdown(files: { name: string; text: string }[]): Promise<boolean> {
    this.setNotice(`Importing ${files.length} note${files.length === 1 ? "" : "s"}…`);
    try {
      const result = await this.controller.importMarkdownFiles(files);
      const failed = result.failed.length ? ` ${result.failed.length} failed: ${result.failed.map(item => item.error).join("; ")}` : "";
      this.setNotice(`Imported ${result.imported} note${result.imported === 1 ? "" : "s"} from Obsidian.${failed}`);
      return result.imported > 0;
    } catch (error) { this.setNotice(error instanceof Error ? error.message : String(error)); return false; }
  }

  private omiImportControls(): HTMLElement {
    const wrap = el("div", "route-controls");
    const start = el("input"), end = el("input"); start.type = end.type = "date";
    start.id = "omi-import-start"; end.id = "omi-import-end";
    const startLabel = el("label", "", "From (optional)"); startLabel.append(start);
    const endLabel = el("label", "", "Through (optional)"); endLabel.append(end);
    const grid = el("div", "field-grid"); grid.append(startLabel, endLabel);
    this.importButton.id = "import-omi"; this.cancelButton.id = "cancel-omi-import";
    this.importButton.addEventListener("click", () => {
      void this.controller.importOmi({ key: this.options.omiKey(), ...(start.value ? { startDate: start.value } : {}), ...(end.value ? { endDate: `${end.value}T23:59:59.999Z` } : {}) })
        .catch(error => this.setNotice(error instanceof Error ? error.message : String(error)));
    });
    this.cancelButton.addEventListener("click", () => this.controller.cancelImport());
    const row = el("div", "button-row"); row.append(this.importButton, this.cancelButton);
    wrap.append(grid, row);
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
    const ids = this.controller.listHistorySessions().filter(session => sessionSource(session) === source).map(session => session.id);
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
    this.kbDelete.addEventListener("click", () => {
      if (window.confirm("Delete the Helix knowledge base from your OpenAI project? The sessions stay on this phone. This cannot be undone.")) run(this.controller.deleteOpenAIKnowledge(key()));
    });
    const actions = el("div", "provider-key-actions"); actions.append(this.kbSync, this.kbStop, this.kbDelete);
    box.append(
      option(this.kbLocal, "local", "On this phone", "Keyword search over saved sessions. Nothing leaves the phone for the lookup."),
      option(this.kbOpenai, "openai", "OpenAI knowledge base", "Semantic search in a vector store in your own OpenAI project. Adds one request per answer; falls back to the phone if it is slow."),
      actions, this.kbStatus,
      el("p", "field-note", "Sync uploads your saved sessions (transcripts, answers, summaries) as files to your OpenAI project with the key from Setup. OpenAI stores them until you delete them; the first 1 GB of vector storage is free, then about $0.10 per GB per day. Both options need “Use saved knowledge in answers” on."),
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

