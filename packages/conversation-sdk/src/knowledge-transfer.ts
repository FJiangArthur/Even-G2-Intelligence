/**
 * v0.8 knowledge transfer between Helix local history, Obsidian (Markdown vault
 * notes) and Omi (developer API). Markdown functions are pure; exportToOmi is the
 * only network call and runs only when the host explicitly invokes it.
 */
import type { DirectFetch } from "./direct-providers.js";
import { stripCitationMarkers } from "./direct-providers.js";
import type { HistoryEntry, HistorySession, SessionPerson } from "./local-history.js";
import { MAX_TODOS, parseTodoLine, todoLine, type TodoItem } from "./todo-list.js";

export interface SessionWithEntries { readonly session: HistorySession; readonly entries: readonly HistoryEntry[] }
export interface MarkdownSession { session: HistorySession; entries: HistoryEntry[]; /** Original Helix session id when the note was exported by Helix. */ helixSessionId?: string }
export interface VaultFile { path: string; content: string }
export interface MarkdownImportOptions { /** Fallback timestamp when the note has no date (default: now). */ now?: string }

const MAX_MARKDOWN_CHARS = 2_000_000, MAX_ENTRY_CHARS = 4000, MAX_ENTRIES = 5000, MAX_ITEMS = 20, MAX_ITEM_CHARS = 500;
const SECTION = { summary: "Summary", keyFacts: "Key facts", people: "People", concepts: "Concepts", diagram: "Diagram", transcript: "Transcript", todos: "To-dos", notes: "Notes" } as const;
const HELIX_SPEAKER = "Helix";

/* ------------------------------------------------------------------ text hygiene */

const URLS = /\b(?:https?|wss?|ftp):\/\/[^\s<>()\]]+|\bwww\.[^\s<>()\]]+|\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|ai|me|dev|app|co|gov|edu)\/[^\s<>()\]]*/giu;
/** One clean line: no provider citation markers, URLs, [M1] memory refs or control characters. */
function cleanLine(text: string): string {
  return stripCitationMarkers(text)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(URLS, url => /[.,;:!?]+$/u.exec(url)?.[0] ?? "")
    .replace(/\s*\[M\d+\]/gu, "")
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/gu, " ")
    .replace(/\(\s*\)/gu, "")
    .replace(/\s+([.,;:!?])/gu, "$1")
    .replace(/\s+/g, " ").trim();
}
/** Export-only: neutralize Obsidian comment/HTML-comment openers inside text. */
const safeMd = (text: string) => text.replace(/%%/gu, "% %").replace(/<!--/gu, "< !--");
const bounded = (text: string, max: number) => Array.from(text).length <= max ? text : Array.from(text).slice(0, max).join("").trim();
const normal = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const speakerLabel = (value: string | undefined) => cleanLine(value ?? "").replace(/[*_`[\]#|:<>]/gu, "").trim().slice(0, 60);
/** Lines that would re-parse as Markdown structure get a leading backslash. */
const escapeLead = (text: string) => /^(?:[#>*+-]|\d+[.)]\s|\*\*|```|~~~|\||%%)/u.test(text) ? `\\${text}` : text;
function obsidianTag(value: string): string {
  const tag = value.trim().replace(/^#+/u, "").replace(/\s+/gu, "-").replace(/[^\p{L}\p{N}_\-/]/gu, "").slice(0, 60);
  return /[^\p{N}_\-/]/u.test(tag) ? tag : "";
}
const yaml = (value: string) => JSON.stringify(value);
const isoDay = (value: string) => { const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : "1970-01-01"; };
function sortedEntries(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id));
}
function sentences(text: string): string[] {
  return text.replace(/\s+/g, " ").match(/[^.!?。！？]+[.!?。！？]*/gu)?.map(s => s.trim()).filter(Boolean) ?? [];
}

/* ------------------------------------------------------------------ Mermaid */

/** Mindmap-safe node text: letters, digits and light punctuation only (no shape brackets). */
function mermaidText(value: string, max = 40): string {
  const text = value.replace(/[^\p{L}\p{N} .,'&+\-/%$]/gu, " ").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max), space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : cut).trim();
}
const TRAILING_STOP = /\s+(?:a|an|the|and|or|but|of|to|in|on|at|for|with|from|by|is|are|was|were)$/iu;
/** Short topic label: the bullet cut at a word boundary (<= 40 chars) without dangling stop words. */
function topicOf(text: string): string {
  let topic = mermaidText(text.replace(/[.!?。！？]+$/u, ""), 40);
  while (TRAILING_STOP.test(topic)) topic = topic.replace(TRAILING_STOP, "");
  return topic;
}

/**
 * Mermaid mindmap of one session (topics from summary/key facts/tags, people, concepts),
 * rendered natively by Obsidian. Returns the diagram source without code fences.
 */
export function sessionDiagram(session: HistorySession): string {
  const dedupe = (items: string[], max: number) => [...new Map(items.filter(Boolean).map(item => [normal(item), item])).values()].slice(0, max);
  const topics = dedupe((session.summary?.length ? session.summary : session.keyFacts?.length ? session.keyFacts : session.tags ?? []).map(topicOf), 6);
  const people = dedupe((session.people ?? []).map(p => mermaidText(p.role ? `${p.name} - ${p.role}` : p.name)), 8);
  const concepts = dedupe((session.concepts ?? []).map(c => mermaidText(c)), 8);
  const lines = ["mindmap", `  root((${mermaidText(session.title, 60) || "Session"}))`];
  for (const [label, items] of [["Topics", topics], ["People", people], ["Concepts", concepts]] as const) {
    if (!items.length) continue;
    lines.push(`    ${label}`, ...items.map(item => `      ${item}`));
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ Helix -> Markdown */

/**
 * Obsidian-friendly note for one session: YAML frontmatter (title, date, source, people,
 * tags, helix_session_id, started_at, updated_at), Summary, Key facts, People, Concepts,
 * a Mermaid mindmap and a clean transcript ("**Speaker:** text"; answers "> Helix: ...").
 * No URLs, endpoints, models or other provider metadata are written.
 */
export function sessionToMarkdown(session: HistorySession, entries: readonly HistoryEntry[]): string {
  const title = cleanLine(session.title) || "Helix session";
  const people = session.people ?? [];
  const tags = [...new Set((session.tags ?? []).map(obsidianTag).filter(Boolean))];
  const ordered = sortedEntries(entries.filter(entry => entry.sessionId === session.id));
  const vendorSummary = ordered.filter(entry => entry.metadata?.origin === "omi-summary");
  let summary = (session.summary ?? []).map(cleanLine).filter(Boolean);
  if (!summary.length) summary = vendorSummary.flatMap(entry => sentences(cleanLine(entry.text))).slice(0, MAX_ITEMS);
  const list = (items: readonly string[]) => items.map(item => `- ${safeMd(item)}`);
  const front = [
    "---",
    `title: ${yaml(title)}`,
    `date: ${isoDay(session.startedAt)}`,
    `source: ${session.source}`,
    `helix_session_id: ${yaml(session.id)}`,
    `started_at: ${yaml(session.startedAt)}`,
    `updated_at: ${yaml(session.updatedAt)}`,
    ...(people.length ? ["people:", ...people.map(p => `  - ${yaml(cleanLine(p.name))}`)] : ["people: []"]),
    ...(tags.length ? ["tags:", ...tags.map(tag => `  - ${yaml(tag)}`)] : ["tags: []"]),
    "---",
  ];
  const body: string[] = ["", `# ${title}`, ""];
  if (summary.length) body.push(`## ${SECTION.summary}`, ...list(summary), "");
  const facts = (session.keyFacts ?? []).map(cleanLine).filter(Boolean);
  if (facts.length) body.push(`## ${SECTION.keyFacts}`, ...list(facts), "");
  // Notes mode: to-dos as task checkboxes (Obsidian tasks), then the running notes.
  const todos = session.todos ?? [];
  if (todos.length) body.push(`## ${SECTION.todos}`, ...todos.map(item => `- [${item.done ? "x" : " "}] ${safeMd(cleanLine(todoLine(item)))}`), "");
  const notes = (session.notes ?? []).map(note => cleanLine(note.text)).filter(Boolean);
  if (notes.length) body.push(`## ${SECTION.notes}`, ...list(notes), "");
  if (people.length) body.push(`## ${SECTION.people}`, ...people.map(p => `- **${speakerLabel(p.name) || "Unknown"}**${p.role ? ` — ${cleanLine(p.role)}` : ""}`), "");
  const concepts = (session.concepts ?? []).map(cleanLine).filter(Boolean);
  if (concepts.length) body.push(`## ${SECTION.concepts}`, ...list(concepts), "");
  body.push(`## ${SECTION.diagram}`, "```mermaid", sessionDiagram({ ...session, title, summary }), "```", "");
  body.push(`## ${SECTION.transcript}`, "");
  const spoken = ordered.filter(entry => entry.kind === "transcript").map(entry => normal(entry.text)).join("|");
  for (const entry of ordered) {
    if (entry.metadata?.origin === "omi-summary") continue;
    // Fact-checks are stored as "claim\nsummary": keep the two parts apart on one line.
    const text = safeMd(entry.kind === "fact-check" ? entry.text.split(/\n+/u).map(cleanLine).filter(Boolean).join(" — ") : cleanLine(entry.text));
    if (!text) continue;
    let line: string;
    if (entry.kind === "answer") line = `> ${HELIX_SPEAKER}: ${text}`;
    else if (entry.kind === "fact-check") line = `> ${HELIX_SPEAKER} check: ${text}`;
    else if (entry.kind === "question") {
      // Detected questions repeat the transcript; only typed questions add information.
      if (spoken.includes(normal(text))) continue;
      line = `> Asked ${HELIX_SPEAKER}: ${text}`;
    } else {
      const speaker = speakerLabel(entry.speaker);
      line = speaker ? `**${speaker}:** ${text}` : escapeLead(text);
    }
    body.push(line, "");
  }
  return `${[...front, ...body].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** Vault export: one note per session at "Helix/YYYY-MM-DD title.md" (collisions get " (2)"). */
export function vaultBundle(sessions: readonly SessionWithEntries[], options: { folder?: string } = {}): { files: VaultFile[] } {
  const folder = (options.folder ?? "Helix").split("/").map(fileSafe).filter(Boolean).join("/") || "Helix";
  const used = new Set<string>(), files: VaultFile[] = [];
  for (const { session, entries } of sessions) {
    const base = `${isoDay(session.startedAt)} ${fileSafe(session.title) || "Session"}`;
    let path = `${folder}/${base}.md`;
    for (let n = 2; used.has(path.toLowerCase()); n++) path = `${folder}/${base} (${n}).md`;
    used.add(path.toLowerCase());
    files.push({ path, content: sessionToMarkdown(session, entries) });
  }
  return { files };
}
function fileSafe(value: string): string {
  const text = cleanLine(value).replace(/[\\/:*?"<>|#^[\]{}]/gu, " ").replace(/\s+/g, " ").replace(/^[.\s]+|[.\s]+$/gu, "");
  return Array.from(text).slice(0, 80).join("").trim();
}

/* ------------------------------------------------------------------ Markdown -> Helix */

type Front = Record<string, string | string[]>;
function unquote(value: string): string {
  const text = value.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) { try { const parsed: unknown = JSON.parse(text); if (typeof parsed === "string") return parsed; } catch { /* fall through */ } return text.slice(1, -1); }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replace(/''/g, "'");
  return text.replace(/\s+#.*$/u, "");
}
function inlineList(value: string): string[] {
  const items: string[] = [];
  let current = "", quote = "";
  for (const ch of value.slice(1, -1)) {
    if (quote) { current += ch; if (ch === quote) quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === ",") { items.push(current); current = ""; continue; }
    current += ch;
  }
  items.push(current);
  return items.map(unquote).map(item => item.trim()).filter(Boolean);
}
/** Minimal YAML frontmatter subset: scalars, inline [lists] and "- item" block lists. */
function parseFrontmatter(lines: readonly string[]): Front {
  const result: Front = {};
  let listKey: string | undefined;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/u, "");
    const item = /^\s+-\s+(.*)$/u.exec(line) ?? (listKey ? /^-\s+(.*)$/u.exec(line) : null);
    if (item && listKey) { (result[listKey] as string[]).push(unquote(item[1]!)); continue; }
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/u.exec(line);
    if (!pair) { if (line.trim()) listKey = undefined; continue; }
    const key = pair[1]!.toLowerCase(), value = pair[2]!.trim();
    if (!value) { result[key] = []; listKey = key; continue; }
    listKey = undefined;
    result[key] = value.startsWith("[") && value.endsWith("]") ? inlineList(value) : unquote(value);
  }
  return result;
}
const frontString = (front: Front, ...keys: string[]) => { for (const key of keys) { const value = front[key]; if (typeof value === "string" && value.trim()) return value.trim(); } return undefined; };
const frontList = (front: Front, key: string, separator: RegExp): string[] => {
  const value = front[key];
  if (Array.isArray(value)) return value;
  return typeof value === "string" && value.trim() ? value.split(separator).map(item => item.trim()).filter(Boolean) : [];
};
const TAG_LINE = /^(?:\s*#[\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)+\s*$/u;
function isoOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = /^\d{4}-\d{2}-\d{2}$/u.test(value) ? `${value}T00:00:00.000Z` : value;
  const time = Date.parse(text);
  return Number.isFinite(time) && Math.abs(time) <= 8.64e15 ? new Date(time).toISOString() : undefined;
}
/** Obsidian inline syntax -> plain text; collects inline #tags. */
function plain(text: string, tags?: Set<string>): string {
  let value = text
    .replace(/!\[\[[^\]]*\]\]/gu, "").replace(/!\[[^\]]*\]\([^)]*\)/gu, "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, "$2").replace(/\[\[([^\]]+)\]\]/gu, (_m, target: string) => target.replace(/#\^?/gu, " "))
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/`([^`]*)`/gu, "$1").replace(/\*\*|__|==|~~/gu, "")
    .replace(/(^|[^\p{L}\p{N}*])\*(\S(?:[^*]*\S)?)\*(?![\p{L}\p{N}])/gu, "$1$2")
    .replace(/\^[A-Za-z0-9-]+$/u, "");
  value = value.replace(/(^|\s)#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu, (_m, lead: string, tag: string) => { tags?.add(tag); return `${lead}${tag}`; });
  return bounded(cleanLine(value), MAX_ENTRY_CHARS);
}
function idPart(value: string): string {
  const encoded = Array.from(value.normalize("NFC")).map(ch => /[A-Za-z0-9_.-]/u.test(ch) ? ch : encodeURIComponent(ch).replace(/[!'()*~]/gu, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("");
  if (encoded.length <= 200) return encoded || "note";
  let hash = 0x811c9dc5;
  for (let i = 0; i < encoded.length; i++) { hash ^= encoded.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return `${encoded.slice(0, 150)}-${hash.toString(16)}`;
}
function parsePerson(text: string): SessionPerson | undefined {
  const bold = /^\*\*([^*]+)\*\*\s*(?:[—–:-]\s*(.*))?$/u.exec(text.trim());
  const [name, role] = bold ? [bold[1]!, bold[2] ?? ""] : (() => {
    const paren = /^([^()]+)\(([^)]+)\)\s*$/u.exec(text);
    if (paren) return [paren[1]!, paren[2]!];
    const split = /^(.+?)\s+[—–-]\s+(.+)$/u.exec(text) ?? /^([^:]+):\s+(.+)$/u.exec(text);
    return split ? [split[1]!, split[2]!] : [text, ""];
  })();
  const cleanName = bounded(plain(name), MAX_ITEM_CHARS), cleanRole = bounded(plain(role), MAX_ITEM_CHARS);
  return cleanName ? { name: cleanName, ...(cleanRole ? { role: cleanRole } : {}) } : undefined;
}
const SECTION_KEYS: Readonly<Record<string, keyof typeof SECTION>> = {
  summary: "summary", overview: "summary", keyfacts: "keyFacts", facts: "keyFacts", people: "people", participants: "people",
  concepts: "concepts", diagram: "diagram", transcript: "transcript", todos: "todos", todo: "todos", actionitems: "todos",
};
type Draft = { kind: HistoryEntry["kind"]; text: string; speaker?: string; origin: string; section?: string };

/**
 * Parses an Obsidian note (or a sessionToMarkdown export) into a history session with source
 * "obsidian". Frontmatter is optional; Summary / Key facts / People / Concepts sections become
 * session knowledge; "**Speaker:** text" lines, "> Helix: ..." answers, headings, paragraphs and
 * bullets become entries. Mermaid blocks are skipped. Round-trips sessionToMarkdown output.
 */
export function markdownToSession(markdown: string, fileName: string, options: MarkdownImportOptions = {}): MarkdownSession {
  if (typeof markdown !== "string" || typeof fileName !== "string") throw new Error("Markdown note and file name must be text.");
  if (markdown.length > MAX_MARKDOWN_CHARS) throw new Error("Markdown note is too large to import (2 MB limit).");
  let lines = markdown.replace(/^﻿/u, "").replace(/\r\n?/gu, "\n").replace(/%%[\s\S]*?%%/gu, "").replace(/<!--[\s\S]*?-->/gu, "").split("\n");
  let front: Front = {};
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, i) => i > 0 && (line.trim() === "---" || line.trim() === "..."));
    if (end > 0) { front = parseFrontmatter(lines.slice(1, end)); lines = lines.slice(end + 1); }
  }
  const tags = new Set<string>(), summary: string[] = [], keyFacts: string[] = [], concepts: string[] = [], people: SessionPerson[] = [];
  const drafts: Draft[] = [], todos: TodoItem[] = [];
  let h1: string | undefined, section: keyof typeof SECTION | undefined, heading: string | undefined;
  let paragraph: string[] = [], fence: { marker: string; mermaid: boolean; lines: string[] } | undefined;
  const add = (draft: Draft) => { if (draft.text && drafts.length < MAX_ENTRIES) drafts.push(draft); };
  const note = (text: string, origin = "obsidian-note") => add({ kind: "transcript", text, origin, ...(heading ? { section: heading } : {}) });
  const knowledge = (text: string): boolean => {
    if (!text) return true;
    if (section === "summary") { summary.push(text); return true; }
    if (section === "keyFacts") { keyFacts.push(text); return true; }
    if (section === "concepts") { concepts.push(text.split(/\s+[—–]\s+|:\s+/u)[0]!.trim()); return true; }
    return false;
  };
  const flush = () => {
    if (!paragraph.length) return;
    const joined = paragraph.join(" "); paragraph = [];
    const text = plain(joined, tags);
    if (TAG_LINE.test(joined)) return;
    // Prose under People/Diagram (or any other section) is kept as a note entry, never dropped.
    if (!knowledge(text)) note(text);
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/u, "");
    if (fence) {
      if (line.trim().startsWith(fence.marker)) {
        if (!fence.mermaid) { const code = bounded(fence.lines.join(" ").replace(/\s+/g, " ").trim(), MAX_ENTRY_CHARS); if (code) note(code, "obsidian-code"); }
        fence = undefined;
      } else fence.lines.push(line);
      continue;
    }
    const open = /^\s*(```+|~~~+)\s*([\w-]*)/u.exec(line);
    if (open) { flush(); fence = { marker: open[1]!, mermaid: open[2]!.toLowerCase() === "mermaid", lines: [] }; continue; }
    if (!line.trim()) { flush(); continue; }
    const head = /^(#{1,6})\s+(.*?)\s*#*$/u.exec(line);
    if (head) {
      flush();
      const text = plain(head[2]!, tags);
      if (head[1] === "#" && h1 === undefined) { h1 = text; section = undefined; heading = undefined; continue; }
      const key = SECTION_KEYS[normal(text)];
      section = key; heading = key ? undefined : text;
      if (!key && text) note(text, "obsidian-heading");
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) { flush(); continue; }
    if (/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/u.test(line)) continue;
    const quote = /^\s*>\s?(.*)$/u.exec(line);
    if (quote) {
      flush();
      const content = quote[1]!.replace(/^\[![\w-]+\][+-]?\s*/u, "");
      const helix = /^(?:\*\*)?(Helix check|Asked Helix|Helix)(?:\*\*)?:\s*(?:\*\*)?\s*(.*)$/iu.exec(content);
      if (helix) {
        const label = helix[1]!.toLowerCase(), text = plain(helix[2]!, tags);
        add(label === "helix" ? { kind: "answer", text, speaker: HELIX_SPEAKER, origin: "obsidian-answer" }
          : label === "helix check" ? { kind: "fact-check", text, speaker: HELIX_SPEAKER, origin: "obsidian-check" }
          : { kind: "question", text, speaker: "You", origin: "obsidian-question" });
        continue;
      }
      const text = plain(content, tags);
      if (!knowledge(text)) note(text, "obsidian-quote");
      continue;
    }
    const speaker = /^\s*\*\*([^*\n]{1,60}?)(?::\*\*|\*\*:)\s*(.*)$/u.exec(line);
    if (speaker && section !== "people") {
      flush();
      const label = speakerLabel(plain(speaker[1]!)), text = plain(speaker[2]!, tags);
      if (label && text) add({ kind: "transcript", text, speaker: label, origin: "obsidian-transcript", ...(heading ? { section: heading } : {}) });
      continue;
    }
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/u.exec(line);
    if (bullet) {
      flush();
      if (section === "people") { const person = parsePerson(bullet[1]!); if (person) people.push(person); continue; }
      if (section === "todos") {
        // Task checkboxes written by sessionToMarkdown (or by hand) come back as the session's to-do list.
        const fields = parseTodoLine(plain(bullet[1]!, tags));
        if (fields.text && todos.length < MAX_TODOS) todos.push({ id: `todo-${todos.length + 1}`, ...fields, done: /^\s*(?:[-*+]|\d+[.)])\s+\[[xX]\]/u.test(line), origin: "user", createdAt: "", updatedAt: "" });
        continue;
      }
      const text = plain(bullet[1]!, tags);
      if (!knowledge(text)) note(text, "obsidian-bullet");
      continue;
    }
    const escaped = /^\s*\\(?=[#>*+\-|%`~\d])/u.test(line), row = !escaped && /^\s*\|/u.test(line);
    const text = escaped ? line.replace(/^\s*\\/u, "") : row ? line.replace(/\|/gu, " ") : line;
    // Transcript lines and table rows are one entry each; prose lines join into paragraphs.
    if (section === "transcript" || row) { flush(); paragraph.push(text); flush(); } else paragraph.push(text);
  }
  if (fence && !fence.mermaid) paragraph.push(...fence.lines);
  flush();

  const helixSessionId = frontString(front, "helix_session_id");
  const baseName = fileName.replace(/^.*[\\/]/u, "").replace(/\.md$/iu, "");
  const datePrefix = /^(\d{4}-\d{2}-\d{2})\s+(.*)$/u.exec(baseName);
  const title = bounded(plain(frontString(front, "title") ?? h1 ?? datePrefix?.[2] ?? baseName) || "Obsidian note", 300);
  const fallback = isoOf(options.now) ?? new Date().toISOString();
  const startedAt = isoOf(frontString(front, "started_at", "startedat")) ?? isoOf(frontString(front, "date", "created")) ?? isoOf(datePrefix?.[1]) ?? fallback;
  const updatedAt = isoOf(frontString(front, "updated_at", "updatedat", "updated", "modified")) ?? startedAt;
  const sessionId = `obsidian:${idPart(helixSessionId ?? fileName.replace(/\.md$/iu, ""))}`;
  for (const tag of frontList(front, "tags", /[,\s]+/u)) tags.add(tag);
  const byName = new Map<string, SessionPerson>();
  for (const name of frontList(front, "people", /,/u).map(value => plain(value))) if (name && !byName.has(normal(name))) byName.set(normal(name), { name: bounded(name, MAX_ITEM_CHARS) });
  for (const person of people) byName.set(normal(person.name), { ...byName.get(normal(person.name)), ...person });
  const items = (values: Iterable<string>) => [...new Set([...values].map(v => bounded(v, MAX_ITEM_CHARS)).filter(Boolean))].slice(0, MAX_ITEMS);
  const cleanTags = items([...tags].map(obsidianTag));
  const session: HistorySession = { id: sessionId, source: "obsidian", title, startedAt, updatedAt };
  if (summary.length) session.summary = items(summary);
  if (keyFacts.length) session.keyFacts = items(keyFacts);
  if (byName.size) session.people = [...byName.values()].slice(0, MAX_ITEMS);
  if (concepts.length) session.concepts = items(concepts);
  if (cleanTags.length) session.tags = cleanTags;
  if (todos.length) session.todos = todos.map(item => ({ ...item, createdAt: startedAt, updatedAt }));
  const base = Date.parse(startedAt);
  const entries: HistoryEntry[] = drafts.map((draft, index) => ({
    id: `${sessionId}:${index}`, sessionId, kind: draft.kind, text: draft.text,
    occurredAt: new Date(base + index * 1000).toISOString(),
    ...(draft.speaker ? { speaker: draft.speaker } : {}),
    metadata: { origin: draft.origin, ...(draft.section ? { section: bounded(draft.section, 200) } : {}) },
  }));
  return { session, entries, ...(helixSessionId ? { helixSessionId } : {}) };
}

/* ------------------------------------------------------------------ Helix -> Omi */

/**
 * Omi developer API (docs.omi.me/doc/developer/api/conversations, read 2026-11-08):
 * POST https://api.omi.me/v1/dev/user/conversations/from-segments with
 * { transcript_segments: [{ text, start, end, speaker, is_user }] (1..500), client_session_id, source, started_at, language }
 * -> { id, status, discarded }. Retries with the same client_session_id return the same id.
 * POST https://api.omi.me/v1/dev/user/conversations { text (1..100000), text_source, text_source_spec, started_at } for text-only sessions.
 * POST https://api.omi.me/v1/dev/user/memories/batch { memories: [{ content (<=500), tags }] (<=25) } needs memories:write.
 * Writes are rate limited (25 conversation writes per hour). Keys are developer keys (omi_dev_...).
 */
export const OMI_DEV_API = "https://api.omi.me/v1/dev/user";
export interface OmiExportOptions {
  key: string; session: HistorySession; entries: readonly HistoryEntry[];
  fetch?: DirectFetch; signal?: AbortSignal;
  /** BCP-47 or ISO 639-1 language; Omi defaults to "en" when omitted. */
  language?: string;
  /** Also create Omi memories from the session's key facts (needs memories:write). Default false. */
  memories?: boolean;
}
export type OmiExportResult =
  | { status: "exported"; conversationId: string; endpoint: "from-segments" | "from-text"; segments: number; discarded: boolean; memories?: number; memoriesError?: string }
  | { status: "skipped"; reason: string; conversationId?: string }
  | { status: "failed"; code: "invalid-key" | "auth" | "rate-limited" | "rejected" | "network" | "http" | "invalid-response"; message: string };
interface OmiSegment { text: string; start: number; end: number; speaker: string; is_user: boolean }
const SELF_LABEL = /^(?:you|me|self|wearer)$/iu;
const NOT_SPEECH = /^(?:assistant|ai|system|helix|omi summary)$/iu;

/** Spoken transcript only (never Helix answers), with monotonic offsets from the session start. */
function omiSegments(session: HistorySession, entries: readonly HistoryEntry[]): OmiSegment[] {
  const start = Date.parse(session.startedAt), speakers = new Map<string, string>();
  const segments: OmiSegment[] = [];
  let cursor = 0;
  for (const entry of sortedEntries(entries)) {
    if (entry.sessionId !== session.id || entry.kind !== "transcript" || entry.metadata?.origin === "omi-summary" || NOT_SPEECH.test(entry.speaker?.trim() ?? "")) continue;
    const text = bounded(cleanLine(entry.text), MAX_ENTRY_CHARS);
    if (!text) continue;
    const label = entry.speaker?.trim() || "Speaker";
    if (!speakers.has(label)) speakers.set(label, `SPEAKER_${String(speakers.size).padStart(2, "0")}`);
    const offset = Math.max(0, (Date.parse(entry.occurredAt) - start) / 1000);
    const begin = Math.max(Number.isFinite(offset) ? offset : 0, cursor);
    const words = text.split(/\s+/u).length, duration = Math.max(1, Math.round(words / 2.5 * 10) / 10);
    segments.push({ text, start: Math.round(begin * 10) / 10, end: Math.round((begin + duration) * 10) / 10, speaker: speakers.get(label)!, is_user: SELF_LABEL.test(label) });
    cursor = begin + duration;
  }
  if (segments.length <= 500) return segments;
  // Over Omi's 500-segment limit: merge same-speaker runs, then fixed-size groups.
  const merged: OmiSegment[] = [];
  for (const segment of segments) {
    const last = merged.at(-1);
    if (last && last.speaker === segment.speaker) { last.text = `${last.text} ${segment.text}`; last.end = segment.end; } else merged.push({ ...segment });
  }
  if (merged.length <= 500) return merged;
  const size = Math.ceil(merged.length / 500), grouped: OmiSegment[] = [];
  for (let i = 0; i < merged.length; i += size) {
    const group = merged.slice(i, i + size);
    grouped.push({ ...group[0]!, text: group.map(s => s.text).join(" "), end: group.at(-1)!.end });
  }
  return grouped;
}
function omiFailure(status: number): OmiExportResult {
  if (status === 401 || status === 403) return { status: "failed", code: "auth", message: "Omi rejected the API key. Use an Omi developer key (omi_dev_…) with conversations:write." };
  if (status === 429) return { status: "failed", code: "rate-limited", message: "Omi's write limit was reached (about 25 conversations per hour). Try again later." };
  if (status === 400 || status === 422) return { status: "failed", code: "rejected", message: "Omi rejected the exported conversation." };
  return { status: "failed", code: "http", message: "Omi export failed. Check the connection and try again." };
}
function cancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException("Omi export cancelled.", "AbortError"); }

/**
 * Explicit export of one Helix/Obsidian session to Omi as a conversation (transcript segments,
 * idempotent per session via client_session_id; text-only sessions use the create-from-text
 * endpoint). Optional key-fact memories. Never throws except AbortError; never echoes the key.
 */
export async function exportToOmi(options: OmiExportOptions): Promise<OmiExportResult> {
  const { key, session, entries, signal } = options;
  if (typeof key !== "string" || !key.trim() || /\s|[^\x21-\x7e]/u.test(key) || key.length > 8192) return { status: "failed", code: "invalid-key", message: "Enter a valid Omi developer API key before exporting." };
  if (session.source === "omi") return { status: "skipped", reason: "This session came from Omi; exporting it back would duplicate it." };
  cancelled(signal);
  const fetcher: DirectFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const language = typeof options.language === "string" && /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/u.test(options.language) ? options.language.slice(0, 3).replace(/[-_].*$/u, "").toLowerCase() : undefined;
  const segments = omiSegments(session, entries);
  const facts = (session.keyFacts ?? []).map(cleanLine).filter(Boolean);
  let endpoint: "from-segments" | "from-text", body: Record<string, unknown>;
  if (segments.length) {
    endpoint = "from-segments";
    body = { transcript_segments: segments, client_session_id: `helix-${idPart(session.id)}`.slice(0, 200), source: "external_integration", started_at: new Date(Date.parse(session.startedAt)).toISOString(), ...(language ? { language } : {}) };
  } else {
    const summary = [...(session.summary ?? []), ...facts].map(cleanLine).filter(Boolean);
    if (!summary.length) return { status: "skipped", reason: "This session has no transcript or summary to export." };
    endpoint = "from-text";
    body = { text: bounded(`${cleanLine(session.title)}\n${summary.join("\n")}`, 100_000), text_source: "other_text", text_source_spec: "helix", started_at: new Date(Date.parse(session.startedAt)).toISOString(), ...(language ? { language } : {}) };
  }
  const post = async (path: string, payload: unknown): Promise<Response> => {
    try { return await fetcher(`${OMI_DEV_API}/${path}`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(payload), redirect: "error", ...(signal ? { signal } : {}) }); }
    catch (error) { cancelled(signal); throw error; }
  };
  let response: Response;
  try { response = await post(endpoint === "from-segments" ? "conversations/from-segments" : "conversations", body); }
  catch (error) { if (error instanceof DOMException && error.name === "AbortError") throw error; return { status: "failed", code: "network", message: "Could not reach Omi. Nothing was exported." }; }
  cancelled(signal);
  if (response.redirected || !response.ok) return omiFailure(response.status);
  let data: unknown;
  try { data = await response.json(); } catch { cancelled(signal); return { status: "failed", code: "invalid-response", message: "Omi returned an invalid export response." }; }
  cancelled(signal);
  const record = typeof data === "object" && data !== null && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
  if (!record || typeof record.id !== "string" || !record.id.trim() || record.id.length > 256) return { status: "failed", code: "invalid-response", message: "Omi returned an invalid export response." };
  if (record.status === "deleted") return { status: "skipped", reason: "This session was exported before and deleted in Omi.", conversationId: record.id };
  const result: OmiExportResult & { status: "exported" } = { status: "exported", conversationId: record.id, endpoint, segments: segments.length, discarded: record.discarded === true };
  if (options.memories && facts.length) {
    try {
      const memories = facts.slice(0, 25).map(content => ({ content: bounded(content, 500), tags: ["helix"] }));
      const reply = await post("memories/batch", { memories });
      cancelled(signal);
      if (!reply.ok || reply.redirected) result.memoriesError = reply.status === 403 || reply.status === 401 ? "Omi memories need a key with memories:write and Developer Memory API access." : "Omi did not save the key facts as memories.";
      else {
        const saved: unknown = await reply.json().catch(() => undefined);
        const count = typeof saved === "object" && saved !== null ? (saved as Record<string, unknown>).created_count : undefined;
        result.memories = typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : memories.length;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      result.memoriesError = "Could not reach Omi to save the key facts as memories.";
    }
  }
  return result;
}
