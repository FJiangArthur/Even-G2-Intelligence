import type { DirectFetch } from "./direct-providers.js";
import { LocalHistoryStore, type HistoryEntry, type HistorySession } from "./local-history.js";

export interface OmiImportProgress { /** Conversations successfully processed/upserted, including existing records. */ imported: number; pages: number }
export interface OmiImportOptions {
  key: string; store: LocalHistoryStore; fetch?: DirectFetch; signal?: AbortSignal;
  startDate?: string; endDate?: string; onProgress?: (progress: OmiImportProgress) => void;
}
const API = "https://api.omi.me/v1/dev/user/conversations";
const PAGE_SIZE = 25, PAGE_CAP = 200;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const invalid = () => new Error("Omi returned an invalid conversation response. Import is incomplete; earlier saved records remain available.");
function cancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException("Omi import cancelled. Earlier saved records remain available.", "AbortError"); }
function iso(value: unknown): string {
  if (!nonempty(value) || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) throw invalid();
  const parsed = Date.parse(value);
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const calendar = new Date(Date.UTC(year!, month! - 1, day!));
  if (!Number.isFinite(parsed) || calendar.toISOString().slice(0, 10) !== value.slice(0, 10)) throw invalid();
  return new Date(parsed).toISOString();
}
function filterDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try { return iso(value); } catch { throw new Error("Omi import date must be a valid ISO date or timestamp."); }
}
const GENERIC_SPEAKER = /^(?:speaker[\s_-]*\d*|user|you|me|unknown|omi(?:\s+summary)?)$/iu;
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
function parseConversation(value: unknown): { session: HistorySession; entries: HistoryEntry[] } {
  if (!record(value) || !nonempty(value.id) || !record(value.structured)) throw invalid();
  const startedAt = iso(value.started_at ?? value.created_at), updatedAt = iso(value.finished_at ?? value.created_at ?? value.started_at);
  const sessionId = `omi:${encodeURIComponent(value.id)}`;
  const title = value.structured.title, overview = value.structured.overview;
  if (title != null && typeof title !== "string" || overview != null && typeof overview !== "string") throw invalid();
  const session: HistorySession = { id: sessionId, source: "omi", title: nonempty(title) ? title : "Omi conversation", startedAt, updatedAt };
  // v0.8 knowledge: Omi's structured overview -> summary, action items -> key facts, category -> tag.
  if (nonempty(overview)) session.summary = overviewBullets(overview);
  const facts = actionItems(value.structured.action_items);
  if (facts.length) session.keyFacts = facts;
  if (nonempty(value.structured.category)) session.tags = [value.structured.category.trim().slice(0, 100)];
  const userIds = userSpeakerIds(value.participants), people = new Map<string, string>();
  const entries: HistoryEntry[] = [];
  if (nonempty(overview)) entries.push({ id: `${sessionId}:overview`, sessionId, kind: "answer", text: overview, occurredAt: startedAt, speaker: "Omi summary", metadata: { origin: "omi-summary", omiConversationId: value.id } });
  const segments = value.transcript_segments ?? [];
  if (!Array.isArray(segments)) throw invalid();
  const ids = new Set<string>();
  for (const [index, segment] of segments.entries()) {
    if (!record(segment) || typeof segment.text !== "string") throw invalid();
    if (!segment.text.trim()) continue;
    if (segment.id != null && !nonempty(segment.id) || segment.start != null && (typeof segment.start !== "number" || !Number.isFinite(segment.start) || segment.start < 0) || segment.end != null && (typeof segment.end !== "number" || !Number.isFinite(segment.end) || segment.end < 0)) throw invalid();
    if (typeof segment.start === "number" && typeof segment.end === "number" && segment.end < segment.start) throw invalid();
    if (segment.speaker_name != null && typeof segment.speaker_name !== "string" || segment.speaker_id != null && typeof segment.speaker_id !== "string" && typeof segment.speaker_id !== "number" || segment.speaker != null && typeof segment.speaker !== "string") throw invalid();
    const segmentId = nonempty(segment.id) ? `id:${encodeURIComponent(segment.id)}` : `index:${index}`;
    const id = `${sessionId}:transcript:${segmentId}`; if (ids.has(id)) throw invalid(); ids.add(id);
    const offset = typeof segment.start === "number" ? segment.start : 0;
    const time = Date.parse(startedAt) + offset * 1000; if (!Number.isFinite(time) || Math.abs(time) > 8.64e15) throw invalid();
    const speaker = nonempty(segment.speaker_name) ? segment.speaker_name : nonempty(segment.speaker) ? segment.speaker : segment.speaker_id != null ? `Speaker ${segment.speaker_id}` : undefined;
    const metadata: Record<string, string> = { origin: "omi-transcript", omiConversationId: value.id };
    if (nonempty(segment.id)) metadata.omiSegmentId = segment.id;
    if (segment.speaker_id != null) metadata.speakerId = String(segment.speaker_id);
    if (segment.start != null) metadata.startSeconds = String(segment.start);
    if (segment.end != null) metadata.endSeconds = String(segment.end);
    entries.push({ id, sessionId, kind: "transcript", text: segment.text, occurredAt: new Date(time).toISOString(), ...(speaker ? { speaker } : {}), metadata });
    // Only names Omi resolved (speaker_name), never generic labels or the account owner.
    const owner = segment.is_user === true || (segment.speaker_id != null && userIds.has(String(segment.speaker_id)));
    if (nonempty(segment.speaker_name) && !owner && !GENERIC_SPEAKER.test(segment.speaker_name.trim())) {
      const name = segment.speaker_name.trim(), key = name.normalize("NFKC").toLowerCase();
      if (!people.has(key) && people.size < 20) people.set(key, name);
    }
  }
  if (people.size) session.people = [...people.values()].map(name => ({ name }));
  return { session, entries };
}

/** Explicit import only. No Omi requests occur during local retrieval or answering. */
export async function importOmiConversations(options: OmiImportOptions): Promise<OmiImportProgress> {
  const { key, store, signal, onProgress } = options;
  if (typeof key !== "string" || !key.trim() || /\s|[^\x21-\x7e]/.test(key) || key.length > 8192) throw new Error("Enter a valid Omi API key before importing.");
  const startDate = filterDate(options.startDate), endDate = filterDate(options.endDate);
  if (startDate && endDate && Date.parse(startDate) > Date.parse(endDate)) throw new Error("Omi import start date must not be after end date.");
  const fetcher: DirectFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const seen = new Set<string>(); let imported = 0, pages = 0;
  cancelled(signal); await store.load(); cancelled(signal);
  for (let page = 0; page < PAGE_CAP; page++) {
    cancelled(signal);
    const url = new URL(API); url.searchParams.set("include_transcript", "true"); url.searchParams.set("limit", String(PAGE_SIZE)); url.searchParams.set("offset", String(page * PAGE_SIZE));
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
    const conversations = data.map(parseConversation), pageIds = new Set<string>();
    for (const { session } of conversations) {
      if (seen.has(session.id) || pageIds.has(session.id)) throw new Error("Omi returned duplicate conversation IDs. Import is incomplete; earlier saved records remain available.");
      pageIds.add(session.id);
    }
    for (const { session, entries } of conversations) {
      cancelled(signal); await store.upsertSession(session); cancelled(signal);
      if (entries.length) await store.upsertEntries(entries);
      imported++; seen.add(session.id); cancelled(signal);
    }
    pages++; onProgress?.({ imported, pages }); cancelled(signal);
    if (data.length < PAGE_SIZE) return { imported, pages };
  }
  throw new Error("Omi import is incomplete after the 200-page limit. Narrow the date range and import again; earlier saved records remain available.");
}
