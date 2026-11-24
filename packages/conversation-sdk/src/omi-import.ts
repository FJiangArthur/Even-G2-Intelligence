import type { DirectFetch } from "./direct-providers.js";
import { LocalHistoryStore, isImportStorageFull, type HistoryEntry, type HistorySession } from "./local-history.js";

export interface OmiImportProgress {
  /** Conversations saved or already saved unchanged. */ imported: number; pages: number;
  /**
   * Only when > 0: conversations left out. With `skipInvalid`, those Omi returned in a shape Helix could
   * not read; always, those counted in `skippedHelix`.
   */
  skipped?: number;
  /** Only when > 0: the part of `skipped` that Helix itself had sent to Omi (they are already in History). */
  skippedHelix?: number;
  /** Only when > 0: conversations that could not be saved. Their earlier copies, if any, are unchanged. */
  failed?: number;
  /** Why the first of them could not be saved. */
  failReason?: string;
  /** The import budget is full: the import stopped at that conversation. */
  storageFull?: true;
}
export interface OmiImportOptions {
  key: string; store: LocalHistoryStore; fetch?: DirectFetch; signal?: AbortSignal;
  /**
   * A plain date (YYYY-MM-DD) is a day in the phone's time zone: `startDate` its first moment, `endDate`
   * its last. A timestamp is used as given (without an offset: UTC).
   */
  startDate?: string; endDate?: string;
  /** Called after every saved batch of conversations (at most 5) and after every page. */
  onProgress?: (progress: OmiImportProgress) => void;
  /**
   * Default false: one unreadable conversation fails its whole page (strict, nothing partial).
   * True: an unreadable conversation is skipped and counted in `skipped`, so one odd record cannot
   * block every later import. The response envelope (a JSON array of at most one page) stays strict.
   */
  skipInvalid?: boolean;
  /**
   * v0.16: keep only what Omi wrote about each conversation (title, overview, action items, category)
   * and no transcript lines. The transcript is not downloaded. A conversation imported earlier with its
   * transcript is replaced by the short form.
   */
  summariesOnly?: boolean;
}
const API = "https://api.omi.me/v1/dev/user/conversations";
const PAGE_SIZE = 25, PAGE_CAP = 200;
/** Conversations saved with one index write. Progress is reported after each batch. */
const SAVE_BATCH = 5;
/** A Helix session and the Omi conversation made from it start at the same moment (exportToOmi sends started_at). */
const SAME_START_MS = 2000;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const invalid = () => new Error("Omi returned an invalid conversation response. Import is incomplete; earlier saved records remain available.");
function cancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException("Omi import cancelled. Earlier saved records remain available.", "AbortError"); }
const inRange = (time: number) => Number.isFinite(time) && Math.abs(time) <= 8.64e15;
/**
 * A conversation timestamp. Accepts ISO 8601 with "T" or a space, with or without seconds, fraction and
 * offset ("Z", "+02:00", "+0200", "+02"), and Unix time in seconds or milliseconds (number or digits).
 * Without an offset (Python's naive datetime.isoformat()) it is read as UTC, not as phone-local time.
 */
function stamp(value: unknown): string {
  if (typeof value === "number") {
    const time = Math.abs(value) < 1e11 ? value * 1000 : value;
    if (!Number.isFinite(value) || value <= 0 || !inRange(time)) throw invalid();
    return new Date(time).toISOString();
  }
  if (!nonempty(value)) throw invalid();
  const text = value.trim();
  if (/^\d{9,13}(?:\.\d+)?$/u.test(text)) return stamp(Number(text));
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?$/iu.exec(text);
  if (!match) throw invalid();
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(part => Number(part ?? 0)) as [number, number, number, number, number, number];
  const millis = Math.floor(Number(`0.${match[7] ?? "0"}`) * 1000);
  const wall = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis));
  // 2026-02-30 or 25:00 roll over to another day or hour: not a real time.
  if (!inRange(wall.getTime()) || wall.getUTCFullYear() !== year || wall.getUTCMonth() !== month - 1 || wall.getUTCDate() !== day || wall.getUTCHours() !== hour || wall.getUTCMinutes() !== minute || wall.getUTCSeconds() !== second) throw invalid();
  const zone = match[8];
  let offset = 0;
  if (zone && !/^z$/iu.test(zone)) {
    const digits = zone.slice(1).replace(":", ""), hours = Number(digits.slice(0, 2)), minutes = Number(digits.slice(2) || 0);
    if (hours > 14 || minutes > 59) throw invalid();
    offset = (zone.startsWith("-") ? -1 : 1) * (hours * 60 + minutes) * 60_000;
  }
  const time = wall.getTime() - offset;
  if (!inRange(time)) throw invalid();
  return new Date(time).toISOString();
}
/** An import date filter: a plain date is a day in the phone's own time zone, anything else a timestamp. */
function filterDate(value: string | undefined, edge: "start" | "end"): string | undefined {
  if (value === undefined) return undefined;
  try {
    const day = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value.trim()) : null;
    if (!day) return stamp(value);
    const [year, month, date] = day.slice(1).map(Number) as [number, number, number];
    const local = edge === "start" ? new Date(year, month - 1, date, 0, 0, 0, 0) : new Date(year, month - 1, date, 23, 59, 59, 999);
    if (!inRange(local.getTime()) || local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== date) throw invalid();
    return local.toISOString();
  } catch { throw new Error("Omi import date must be a valid ISO date or timestamp."); }
}
const GENERIC_SPEAKER = /^(?:speaker[\s_-]*\d*|user|you|me|unknown|omi(?:\s+summary)?)$/iu;
/** Omi's label for a voice it did not name: "SPEAKER_00" is the first voice. */
const RAW_SPEAKER = /^speaker_(\d{1,4})$/iu;
/** Sentence bullets from an Omi overview (session.summary is <= 20 x 500 chars; the store bounds it again). */
function overviewBullets(overview: string): string[] {
  const sentences = overview.replace(/\s+/g, " ").match(/[^.!?。！？]+[.!?。！？]*/gu)?.map(s => s.trim()).filter(Boolean) ?? [];
  return sentences.slice(0, 20).map(s => s.slice(0, 500));
}
/** Omi action items (objects with description, or strings) as key facts. Unknown shapes are ignored. */
function actionItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => nonempty(item) ? [item.trim()] : record(item) && nonempty(item.description) ? [item.description.trim()] : []).slice(0, 20).map(s => s.slice(0, 500));
}
/** Speaker ids Omi maps to the account owner (participants[].is_user), so they are not listed as people. */
function userSpeakerIds(value: unknown): Set<string> {
  const ids = new Set<string>();
  if (Array.isArray(value)) for (const item of value) if (record(item) && item.is_user === true && (typeof item.speaker_id === "number" || typeof item.speaker_id === "string")) ids.add(String(item.speaker_id));
  return ids;
}
/** How a segment's speaker is shown: the wearer is "You"; an unnamed voice is "Speaker 1", "Speaker 2", ... */
function speakerLabel(segment: Record<string, unknown>, owner: boolean): string | undefined {
  if (owner) return "You";
  const given = nonempty(segment.speaker_name) ? segment.speaker_name : nonempty(segment.speaker) ? segment.speaker : undefined;
  const raw = given === undefined ? null : RAW_SPEAKER.exec(given.trim());
  if (raw) return `Speaker ${Number(raw[1]) + 1}`;
  if (given !== undefined) return given;
  if (segment.speaker_id == null) return undefined;
  return typeof segment.speaker_id === "number" && Number.isSafeInteger(segment.speaker_id) && segment.speaker_id >= 0 ? `Speaker ${segment.speaker_id + 1}` : `Speaker ${String(segment.speaker_id)}`;
}
interface Parsed { session: HistorySession; entries: HistoryEntry[]; /** First spoken line, for matching a conversation Helix sent. */ firstLine?: string }
function parseConversation(value: unknown, summariesOnly = false): Parsed {
  // v0.16: a conversation without `structured` (still processing, or discarded) is kept with a plain title.
  if (!record(value) || !nonempty(value.id) || value.structured != null && !record(value.structured)) throw invalid();
  const structured = record(value.structured) ? value.structured : {};
  const startedAt = stamp(value.started_at ?? value.created_at), updatedAt = stamp(value.finished_at ?? value.created_at ?? value.started_at);
  const sessionId = `omi:${encodeURIComponent(value.id)}`;
  const title = structured.title, overview = structured.overview;
  if (title != null && typeof title !== "string" || overview != null && typeof overview !== "string") throw invalid();
  const session: HistorySession = { id: sessionId, source: "omi", title: nonempty(title) ? title : "Omi conversation", startedAt, updatedAt };
  // v0.8 knowledge: Omi's structured overview -> summary, action items -> key facts, category -> tag.
  if (nonempty(overview)) session.summary = overviewBullets(overview);
  const facts = actionItems(structured.action_items);
  if (facts.length) session.keyFacts = facts;
  if (nonempty(structured.category)) session.tags = [structured.category.trim().slice(0, 100)];
  const userIds = userSpeakerIds(value.participants), people = new Map<string, string>();
  const entries: HistoryEntry[] = [];
  if (nonempty(overview)) entries.push({ id: `${sessionId}:overview`, sessionId, kind: "answer", text: overview, occurredAt: startedAt, speaker: "Omi summary", metadata: { origin: "omi-summary", omiConversationId: value.id } });
  const segments = value.transcript_segments ?? [];
  if (!Array.isArray(segments)) throw invalid();
  const ids = new Set<string>();
  let firstLine: string | undefined;
  for (const [index, segment] of segments.entries()) {
    if (!record(segment) || typeof segment.text !== "string") throw invalid();
    if (!segment.text.trim()) continue;
    if (segment.id != null && !nonempty(segment.id) || segment.start != null && (typeof segment.start !== "number" || !Number.isFinite(segment.start) || segment.start < 0) || segment.end != null && (typeof segment.end !== "number" || !Number.isFinite(segment.end) || segment.end < 0)) throw invalid();
    if (typeof segment.start === "number" && typeof segment.end === "number" && segment.end < segment.start) throw invalid();
    if (segment.speaker_name != null && typeof segment.speaker_name !== "string" || segment.speaker_id != null && typeof segment.speaker_id !== "string" && typeof segment.speaker_id !== "number" || segment.speaker != null && typeof segment.speaker !== "string") throw invalid();
    const segmentId = nonempty(segment.id) ? `id:${encodeURIComponent(segment.id)}` : `index:${index}`;
    const id = `${sessionId}:transcript:${segmentId}`; if (ids.has(id)) throw invalid(); ids.add(id);
    const offset = typeof segment.start === "number" ? segment.start : 0;
    const time = Date.parse(startedAt) + offset * 1000; if (!inRange(time)) throw invalid();
    firstLine ??= segment.text;
    const owner = segment.is_user === true || (segment.speaker_id != null && userIds.has(String(segment.speaker_id)));
    // Only names Omi resolved (speaker_name), never generic labels or the account owner.
    if (nonempty(segment.speaker_name) && !owner && !GENERIC_SPEAKER.test(segment.speaker_name.trim())) {
      const name = segment.speaker_name.trim(), key = name.normalize("NFKC").toLowerCase();
      if (!people.has(key) && people.size < 20) people.set(key, name);
    }
    if (summariesOnly) continue;
    const speaker = speakerLabel(segment, owner);
    const metadata: Record<string, string> = { origin: "omi-transcript", omiConversationId: value.id };
    if (nonempty(segment.id)) metadata.omiSegmentId = segment.id;
    if (segment.speaker_id != null) metadata.speakerId = String(segment.speaker_id);
    if (segment.start != null) metadata.startSeconds = String(segment.start);
    if (segment.end != null) metadata.endSeconds = String(segment.end);
    entries.push({ id, sessionId, kind: "transcript", text: segment.text, occurredAt: new Date(time).toISOString(), ...(speaker ? { speaker } : {}), metadata });
  }
  if (people.size) session.people = [...people.values()].map(name => ({ name }));
  return { session, entries, ...(firstLine === undefined ? {} : { firstLine }) };
}

/* ------------------------------------------------------------------ conversations Helix sent to Omi */

const plainText = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
/** What exportToOmi (knowledge-transfer.ts) puts on a conversation, wherever Omi returns it. */
function helixMarker(value: Record<string, unknown>): boolean {
  const holders = [value, value.external_data, value.source_spec, value.structured].filter(record);
  return holders.some(holder => (typeof holder.client_session_id === "string" && /^helix-/iu.test(holder.client_session_id.trim()))
    || (typeof holder.text_source_spec === "string" && holder.text_source_spec.trim().toLowerCase() === "helix"));
}
interface LocalSession { id: string; time: number; title: string }
/**
 * True for a conversation that is a Helix (or imported note) session sent to Omi earlier: importing it
 * back would list the same talk twice. By marker when Omi returns one; otherwise a session on this phone
 * that started at the same moment and has the same title or first line, or any such session when Omi
 * marks the conversation as coming from an integration.
 */
function sentByHelix(value: unknown, parsed: Parsed, local: readonly LocalSession[], store: LocalHistoryStore): boolean {
  if (!record(value)) return false;
  if (helixMarker(value)) return true;
  const time = Date.parse(parsed.session.startedAt);
  const near = local.filter(session => Math.abs(session.time - time) <= SAME_START_MS);
  if (!near.length) return false;
  if (typeof value.source === "string" && value.source.trim().toLowerCase() === "external_integration") return true;
  const title = plainText(parsed.session.title), line = parsed.firstLine === undefined ? "" : plainText(parsed.firstLine);
  return near.some(session => (title && title === session.title)
    || (line && plainText(store.getEntries(session.id).find(entry => entry.kind === "transcript")?.text ?? "") === line));
}

/* ------------------------------------------------------------------ saving */

const KEPT_KEYS = ["concepts", "todos", "notes", "overview", "endedAt", "recap", "continues"] as const;
/** The record to save: what Omi returned, plus what was added to the saved copy on this phone (a generated title, concepts, to-dos). */
function merged(session: HistorySession, old: HistorySession | undefined): HistorySession {
  if (!old) return session;
  const result: HistorySession = { ...session };
  for (const key of KEPT_KEYS) if (old[key] !== undefined) (result as unknown as Record<string, unknown>)[key] = old[key];
  if (old.recap) result.title = old.title;
  return result;
}
const canonical = (value: object) => JSON.stringify(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
/** The saved copy already is exactly this: nothing is written (an automatic import repeats the last day every time). */
function unchanged(store: LocalHistoryStore, session: HistorySession, entries: readonly HistoryEntry[]): boolean {
  const old = store.getSession(session.id);
  if (!old || canonical(old) !== canonical(session) || store.entryCount(session.id) !== entries.length) return false;
  const saved = new Map(store.getEntries(session.id).map(entry => [entry.id, entry]));
  return entries.every(entry => { const other = saved.get(entry.id); return !!other && canonical({ ...other, metadata: canonical(other.metadata ?? {}) }) === canonical({ ...entry, metadata: canonical(entry.metadata ?? {}) }); });
}
/**
 * Saves a few conversations with one index write: each replaces its earlier copy as a whole, so lines
 * that are gone from Omi do not stay. A conversation that does not fit is refused on its own.
 */
async function saveBatch(store: LocalHistoryStore, batch: readonly Parsed[]): Promise<(unknown | undefined)[]> {
  const delay = store.writeDelayMs;
  store.writeDelayMs = 60_000;
  let jobs: Promise<unknown | undefined>[] = [];
  try {
    jobs = batch.map(item => store.replaceSession(item.session, item.entries).then(() => undefined, (error: unknown) => error ?? new Error("Could not save the conversation.")));
    await store.flush().catch(() => undefined); // each job has the outcome
  } finally { store.writeDelayMs = delay; }
  return Promise.all(jobs);
}

/** Explicit import only. No Omi requests occur during local retrieval or answering. */
export async function importOmiConversations(options: OmiImportOptions): Promise<OmiImportProgress> {
  const { key, store, signal, onProgress } = options, summariesOnly = options.summariesOnly === true;
  if (typeof key !== "string" || !key.trim() || /\s|[^\x21-\x7e]/.test(key) || key.length > 8192) throw new Error("Enter a valid Omi API key before importing.");
  const startDate = filterDate(options.startDate, "start"), endDate = filterDate(options.endDate, "end");
  if (startDate && endDate && Date.parse(startDate) > Date.parse(endDate)) throw new Error("Omi import start date must not be after end date.");
  const fetcher: DirectFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const seen = new Set<string>(); let imported = 0, pages = 0, skippedInvalid = 0, skippedHelix = 0, failed = 0, failReason: string | undefined, storageFull = false;
  const progress = (): OmiImportProgress => ({ imported, pages,
    ...(skippedInvalid + skippedHelix ? { skipped: skippedInvalid + skippedHelix } : {}), ...(skippedHelix ? { skippedHelix } : {}),
    ...(failed ? { failed, ...(failReason ? { failReason } : {}) } : {}), ...(storageFull ? { storageFull: true as const } : {}) });
  cancelled(signal); await store.load(); cancelled(signal);
  const local: LocalSession[] = store.listSessions().filter(session => session.source !== "omi").map(session => ({ id: session.id, time: Date.parse(session.startedAt), title: plainText(session.title) }));
  for (let page = 0; page < PAGE_CAP; page++) {
    cancelled(signal);
    const url = new URL(API); url.searchParams.set("include_transcript", summariesOnly ? "false" : "true"); url.searchParams.set("limit", String(PAGE_SIZE)); url.searchParams.set("offset", String(page * PAGE_SIZE));
    if (startDate) url.searchParams.set("start_date", startDate); if (endDate) url.searchParams.set("end_date", endDate);
    let response: Response;
    try { response = await fetcher(url.toString(), { method: "GET", headers: { Authorization: `Bearer ${key}` }, redirect: "error", ...(signal ? { signal } : {}) }); }
    catch { cancelled(signal); throw new Error("Could not reach Omi. Import is incomplete; earlier saved records remain available."); }
    cancelled(signal);
    if (response.redirected || !response.ok) throw new Error("Omi import request failed. Check the API key and connection; earlier saved records remain available.");
    let data: unknown; try { data = await response.json(); } catch { cancelled(signal); throw invalid(); }
    cancelled(signal);
    if (!Array.isArray(data) || data.length > PAGE_SIZE) throw invalid();
    // Validate the entire page before committing any conversation from it.
    const conversations: Parsed[] = [];
    let invalidHere = 0, helixHere = 0;
    for (const item of data) {
      let parsed: Parsed;
      try { parsed = parseConversation(item, summariesOnly); } catch (error) { if (!options.skipInvalid) throw error; invalidHere++; continue; }
      if (sentByHelix(item, parsed, local, store)) helixHere++; else conversations.push(parsed);
    }
    const pageIds = new Set<string>();
    for (const { session } of conversations) {
      if (seen.has(session.id) || pageIds.has(session.id)) throw new Error("Omi returned duplicate conversation IDs. Import is incomplete; earlier saved records remain available.");
      pageIds.add(session.id);
    }
    skippedInvalid += invalidHere; skippedHelix += helixHere;
    for (let at = 0; at < conversations.length && !failed; at += SAVE_BATCH) {
      cancelled(signal);
      const batch: Parsed[] = [];
      for (const item of conversations.slice(at, at + SAVE_BATCH)) {
        const session = merged(item.session, store.getSession(item.session.id));
        if (unchanged(store, session, item.entries)) { imported++; seen.add(session.id); } else batch.push({ ...item, session });
      }
      const outcomes = batch.length ? await saveBatch(store, batch) : [];
      outcomes.forEach((error, index) => {
        if (error === undefined) { imported++; seen.add(batch[index]!.session.id); return; }
        failed++; storageFull ||= isImportStorageFull(error);
        failReason ??= error instanceof Error ? error.message : String(error);
      });
      cancelled(signal);
      if (!failed) onProgress?.(progress());
    }
    // Storage that refuses one conversation refuses the rest: stop here and say why. What was saved stays.
    if (failed) { onProgress?.(progress()); return progress(); }
    pages++; onProgress?.(progress()); cancelled(signal);
    if (data.length < PAGE_SIZE) return progress();
  }
  throw new Error("Omi import is incomplete after the 200-page limit. Narrow the date range and import again; earlier saved records remain available.");
}
