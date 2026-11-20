import type { KnowledgeSource } from "./copilot-types.js";
import { cleanSessionNotes, cleanTodos, type SessionNote, type TodoItem } from "./todo-list.js";

/** Storage is provided by the phone host; no network or provider credentials are involved. */
export interface HistoryStorage {
  getLocalStorage(key: string): Promise<string>;
  setLocalStorage(key: string, value: string): Promise<boolean>;
}
/** A person attached to a session (v0.8). `mentions` is optional (copilot mention count). */
export interface SessionPerson { name: string; role?: string; mentions?: number }
export interface HistorySession {
  id: string; source: KnowledgeSource; title: string; startedAt: string; updatedAt: string;
  /** v0.8 session knowledge (all optional; <= 20 items of <= 500 chars each). */
  summary?: string[]; keyFacts?: string[]; people?: SessionPerson[]; concepts?: string[]; tags?: string[];
  /** Notes mode: the session's to-do list (<= 60 items) and running notes (<= 80), saved with the session. */
  todos?: TodoItem[]; notes?: SessionNote[];
}
/** Notes-mode fields of a session. In updateSessionNotebook and upsertSession, an absent field keeps the stored value; [] clears it. */
export type SessionNotebookData = Pick<HistorySession, "todos" | "notes">;
/** Knowledge fields of a session. In updateSessionKnowledge and upsertSession, an absent field keeps the stored value; [] clears it. */
export type SessionKnowledge = Pick<HistorySession, "summary" | "keyFacts" | "people" | "concepts" | "tags">;
export interface PersonAggregate {
  name: string;
  /** Distinct roles seen across sessions, most recent session first. */
  roles: string[];
  /** Sessions listing this person, most recent first. */
  sessionIds: string[];
  /** Sum of per-session mentions (1 per session when not recorded). */
  mentions: number;
  /** updatedAt of the most recent session listing this person. */
  lastSeen: string;
}
export interface SourceStats { sessions: number; entries: number; lastUpdated?: string }
export type KnowledgeStats = Record<KnowledgeSource, SourceStats>;
export interface HistoryEntry {
  id: string; sessionId: string; kind: "transcript" | "question" | "answer" | "fact-check";
  text: string; occurredAt: string; speaker?: string; metadata?: Record<string, string>;
  sources?: { url: string; title: string }[];
}
export interface RetrievedMemory { entry: HistoryEntry; session: HistorySession; score: number }
/**
 * Storage layout. v1 (<= v0.8): the whole archive as one value under LEGACY_HISTORY_KEY.
 * v2 (v0.9): a small index (sessions + per-shard sizes) under HISTORY_INDEX_KEY and one JSON
 * HistoryEntry[] per session under historyShardKey(id), so a live session rewrites only its own shard.
 * v0.9.1: a shard is split into chunks of a fixed number of entries (chunk 0 under historyShardKey(id),
 * chunk k under historyChunkKey(id, k); the index meta records `chunks` when > 1). A long live session
 * rewrites only its last chunk, so a save stays the same size however long the meeting runs.
 */
export const LEGACY_HISTORY_KEY = "helix.g2.history.v1";
export const HISTORY_INDEX_KEY = "helix.g2.history.v2";
/** Storage key of one session's entries. Injective for any id (":" etc. are percent-encoded). */
export function historyShardKey(sessionId: string): string {
  let encoded: string;
  try { encoded = encodeURIComponent(sessionId); }
  // Lone surrogates: per code unit. encodeURIComponent never emits "%u", so this cannot collide.
  catch { encoded = Array.from({ length: sessionId.length }, (_, i) => `%u${sessionId.charCodeAt(i).toString(16).padStart(4, "0")}`).join(""); }
  return `${HISTORY_INDEX_KEY}.s.${encoded}`;
}
/** Storage key of chunk `index` of a session's entries. Chunk 0 is historyShardKey (v0.9 layout); shard keys never contain "#". */
export function historyChunkKey(sessionId: string, index: number): string {
  return index ? `${historyShardKey(sessionId)}#${index}` : historyShardKey(sessionId);
}
/** Entries per stored chunk (v0.9.1): ~30 KB of meeting transcript. */
export const HISTORY_CHUNK_ENTRIES = 100;
export interface LocalHistoryOptions {
  /**
   * Write coalescing window in ms. 0 (default): each mutation is saved on its own before the next one
   * applies. > 0: mutations made within the window are merged into one write of each changed shard
   * plus one index write, and every caller's promise settles with that write. Either way a mutation
   * becomes visible to reads only after it is saved. Use flush() to save immediately.
   */
  writeDelayMs?: number;
  /** Entries per stored chunk (default HISTORY_CHUNK_ENTRIES). Smaller values are for tests. */
  chunkEntries?: number;
}
interface ShardMeta { bytes: number; entries: number; chunks?: number }
/** What is stored for one session: its chunks' entry references and byte sizes (unchanged chunks are not rewritten). */
interface ChunkLayout { readonly refs: readonly (readonly HistoryEntry[])[]; readonly bytes: readonly number[] }
/** shards: { bytes, entries[, chunks] } per session (an unreadable shard keeps its stored meta as is). */
interface V2Index { version: 2; sessions: HistorySession[]; shards: Record<string, ShardMeta | unknown>; legacyV1?: true }
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_WRITE_DELAY_MS = 60_000;
/** Bridge round trips in flight at once (load, migration, multi-shard saves). */
const IO_CONCURRENCY = 8;
/** After a failed v1 -> v2 migration retry, later saves keep writing v1 for this long before retrying. */
const MIGRATION_RETRY_MS = 60_000;
const LOAD_FAILED = "Could not load local history from storage.";
const SAVE_FAILED = "Could not save local history. Storage may be full or unavailable.";
const TOO_LARGE = "Local history exceeds the 5 MiB storage limit.";
const TOO_LARGE_SAVE = `${TOO_LARGE} Export or delete sessions before retrying.`;
interface Snapshot { version: 1; sessions: HistorySession[]; entries: HistoryEntry[] }
// Only provenance belongs here. Arbitrary provider payloads, headers and credential fields do not.
const METADATA_KEYS = new Set(["model", "provider", "endpoint", "promptVersion", "prompt_version", "latencyMs", "latency_ms", "noteId", "origin", "omiConversationId", "omiSegmentId", "speakerId", "startSeconds", "endSeconds", "language", "status", "checkedAt", "section"]);
export const KNOWLEDGE_SOURCES: readonly KnowledgeSource[] = Object.freeze(["helix", "omi", "obsidian"]);
const KNOWLEDGE_KEYS = ["summary", "keyFacts", "people", "concepts", "tags"] as const;
const MAX_KNOWLEDGE_ITEMS = 20, MAX_KNOWLEDGE_CHARS = 500;
const STOP_WORDS = new Set("a an the and or but is are was were be been being to of in on at for with from by it its this that these those i you we they he she my your our their do does did can could would should what when where who how please me us about as".split(" "));
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const date = (value: unknown): value is string => string(value) && Number.isFinite(Date.parse(value));
const invalid = () => new Error("Invalid local history data. Existing storage has not been replaced.");
const copy = <T>(value: T): T => structuredClone(value);
function safeUrl(value: unknown): string | undefined {
  if (!string(value)) return undefined;
  try { const url = new URL(value); if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) return value; } catch { /* untrusted citation */ }
  return undefined;
}
const knowledgeText = (value: unknown): string => typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, MAX_KNOWLEDGE_CHARS).trim() : "";
const personKey = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
/** Non-string items are dropped; strings are trimmed, bounded and deduped. Non-arrays yield undefined. */
function cleanStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>(), result: string[] = [];
  for (const item of value) {
    const text = knowledgeText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text); result.push(text);
    if (result.length >= MAX_KNOWLEDGE_ITEMS) break;
  }
  return result;
}
function cleanPeople(value: unknown): SessionPerson[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>(), result: SessionPerson[] = [];
  for (const item of value) {
    if (!record(item)) continue;
    const name = knowledgeText(item.name), key = personKey(name);
    if (!key || seen.has(key)) continue;
    const role = knowledgeText(item.role), mentions = item.mentions;
    seen.add(key);
    result.push({ name, ...(role ? { role } : {}), ...(typeof mentions === "number" && Number.isSafeInteger(mentions) && mentions > 0 ? { mentions: Math.min(mentions, 1_000_000) } : {}) });
    if (result.length >= MAX_KNOWLEDGE_ITEMS) break;
  }
  return result;
}
/** Validated, bounded knowledge fields present in `value` (invalid shapes are dropped, not fatal). */
function cleanKnowledge(value: Record<string, unknown>): SessionKnowledge {
  const result: SessionKnowledge = {};
  for (const key of KNOWLEDGE_KEYS) {
    if (value[key] === undefined) continue;
    const clean = key === "people" ? cleanPeople(value[key]) : cleanStrings(value[key]);
    if (clean) (result as Record<string, unknown>)[key] = clean;
  }
  return result;
}
const NOTEBOOK_KEYS = ["todos", "notes"] as const;
/** Validated to-dos and notes present in `value` (invalid items are dropped, not fatal). */
function cleanNotebook(value: Record<string, unknown>): SessionNotebookData {
  const result: SessionNotebookData = {};
  const todos = value.todos === undefined ? undefined : cleanTodos(value.todos), notes = value.notes === undefined ? undefined : cleanSessionNotes(value.notes);
  if (todos) result.todos = todos;
  if (notes) result.notes = notes;
  return result;
}
function cleanSession(value: unknown): HistorySession {
  if (!record(value) || !string(value.id) || !KNOWLEDGE_SOURCES.includes(value.source as KnowledgeSource) || typeof value.title !== "string" || !date(value.startedAt) || !date(value.updatedAt)) throw invalid();
  return { id: value.id, source: value.source as KnowledgeSource, title: value.title, startedAt: value.startedAt, updatedAt: value.updatedAt, ...cleanKnowledge(value), ...cleanNotebook(value) };
}
function cleanEntry(value: unknown): HistoryEntry {
  if (!record(value) || !string(value.id) || !string(value.sessionId) || typeof value.kind !== "string" || !["transcript", "question", "answer", "fact-check"].includes(value.kind) || !string(value.text) || !date(value.occurredAt)) throw invalid();
  const result: HistoryEntry = { id: value.id, sessionId: value.sessionId, kind: value.kind as HistoryEntry["kind"], text: value.text, occurredAt: value.occurredAt };
  if (string(value.speaker)) result.speaker = value.speaker;
  if (record(value.metadata)) {
    const metadata: Record<string, string> = {};
    for (const [key, content] of Object.entries(value.metadata)) {
      if (key === "memoryEntryIds" && value.kind === "answer" && typeof content === "string" && content.length <= 102_400) {
        try {
          const ids: unknown = JSON.parse(content);
          if (Array.isArray(ids) && ids.length <= 50 && ids.every(id => typeof id === "string" && id.length <= 2048 && /^(?:omi:|obsidian:|session_)[a-zA-Z0-9_%:.-]+$/.test(id))) metadata[key] = JSON.stringify([...new Set(ids)]);
        } catch { /* Only local source identifiers, never arbitrary metadata. */ }
        continue;
      }
      if (!METADATA_KEYS.has(key) || typeof content !== "string") continue;
      if (key === "endpoint") {
        const safe = safeUrl(content); if (!safe) continue;
        const url = new URL(safe); url.search = ""; url.hash = ""; metadata[key] = url.toString();
      } else metadata[key] = content;
    }
    result.metadata = metadata;
  }
  if (Array.isArray(value.sources)) result.sources = value.sources.flatMap(source => record(source) && typeof source.title === "string" && safeUrl(source.url) ? [{ url: source.url as string, title: source.title }] : []);
  return result;
}
function decode(raw: string): Snapshot {
  if (utf8Length(raw) > MAX_BYTES) throw new Error(TOO_LARGE);
  let data: unknown; try { data = JSON.parse(raw); } catch { throw invalid(); }
  if (!record(data) || data.version !== 1 || !Array.isArray(data.sessions) || !Array.isArray(data.entries)) throw invalid();
  const sessions = data.sessions.map(cleanSession), entries = data.entries.map(cleanEntry);
  const sessionIds = new Set(sessions.map(s => s.id));
  if (sessionIds.size !== sessions.length || new Set(entries.map(e => e.id)).size !== entries.length || entries.some(e => !sessionIds.has(e.sessionId))) throw invalid();
  return { version: 1, sessions, entries };
}
const normalize = (value: string) => value.normalize("NFKC").toLowerCase();
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;
const CJK_CHAR = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
/** Light English suffix folding: "lead times" ~ "lead time", "jetsons" ~ "jetson". */
export function stemTerm(token: string): string {
  if (token.length <= 3 || !/^[a-z]+$/.test(token)) return token;
  if (token.endsWith("'s")) token = token.slice(0, -2);
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("sses")) return token.slice(0, -2);
  if (token.endsWith("ing") && token.length > 5) return token.slice(0, -3);
  if (token.endsWith("ed") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("es") && /(?:ch|sh|x|z)es$/.test(token)) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss") && !token.endsWith("us") && !token.endsWith("is")) return token.slice(0, -1);
  return token;
}
/** Tokens with duplicates (for term frequency). CJK runs become bigrams. */
function tokenList(value: string): string[] {
  const separated = normalize(value).replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu, " $& ");
  const tokens = separated.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}]+/gu) ?? [];
  return tokens.flatMap(token => {
    if (CJK.test(token)) { const chars = [...token]; return chars.length === 1 ? chars : chars.slice(0, -1).map((c, i) => c + chars[i + 1]); }
    return STOP_WORDS.has(token) ? [] : [stemTerm(token)];
  });
}
function terms(value: string): string[] { return [...new Set(tokenList(value))]; }
function relevance(text: string, queryTerms: string[]): number {
  const found = new Set(terms(text));
  return queryTerms.reduce((n, term) => n + Number(found.has(term) || (CJK_CHAR.test(term) && normalize(text).includes(term))), 0) / queryTerms.length;
}
/** Exact stem = 1, shared prefix (>= 4 chars) = 0.7, single CJK char inside a bigram = 1. */
function matchWeight(query: string, token: string): number {
  if (query === token) return 1;
  if (CJK_CHAR.test(query)) return token.includes(query) ? 1 : 0;
  const [short, long] = query.length <= token.length ? [query, token] : [token, query];
  return short.length >= 4 && long.length - short.length <= 4 && long.startsWith(short) && /^[\p{L}\p{N}]+$/u.test(short) && !CJK.test(short) ? 0.7 : 0;
}
/** Relative evidence weight. Transcript (what was said) outranks generated records. */
const KIND_WEIGHT: Readonly<Record<HistoryEntry["kind"], number>> = { transcript: 1, answer: 0.6, "fact-check": 0.5, question: 0 };
const BM25_K1 = 1.2, BM25_B = 0.75, PASSAGE_WIDTH = 600;
export interface RetrievalStats { items: RetrievedMemory[]; searchedEntries: number; matched: number }
function bounded(value: number | undefined, fallback: number, max: number): number {
  return value === undefined ? fallback : Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : fallback;
}

/** UTF-8 byte length without allocating (lone surrogates count as U+FFFD, like TextEncoder). */
function utf8Length(value: string): number {
  let bytes = value.length;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) continue;
    if (code < 0x800) bytes += 1;
    else if (code >= 0xd800 && code <= 0xdbff && (value.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { bytes += 2; i++; }
    else bytes += 2;
  }
  return bytes;
}
/** Runs `run` over items with at most `limit` in flight; never rejects. */
async function settleAll<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { results[i] = { status: "fulfilled", value: await run(items[i]!) }; } catch (reason) { results[i] = { status: "rejected", reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
const own = (value: Record<string, unknown>, key: string): unknown => Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
const shardMeta = (value: unknown): value is ShardMeta => record(value) && Number.isSafeInteger(value.bytes) && (value.bytes as number) >= 0 && Number.isSafeInteger(value.entries) && (value.entries as number) >= 0;
/** Stored chunk count of a shard meta (1 for v0.9 metas and unreadable ones). */
const chunkCount = (value: unknown): number => record(value) && Number.isSafeInteger(value.chunks) && (value.chunks as number) >= 1 && (value.chunks as number) <= 100_000 ? value.chunks as number : 1;
const sameEntry = (a: HistoryEntry, b: HistoryEntry) => a === b || JSON.stringify(a) === JSON.stringify(b);
const writeDelay = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), MAX_WRITE_DELAY_MS) : 0;
/** A stored shard: a JSON array of valid entries of `sessionId` with unique ids. Undefined when corrupt. */
function decodeShard(raw: string, sessionId: string): HistoryEntry[] | undefined {
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return undefined;
    const entries = data.map(cleanEntry), ids = new Set(entries.map(e => e.id));
    return ids.size === entries.length && entries.every(e => e.sessionId === sessionId) ? entries : undefined;
  } catch { return undefined; }
}

interface State { readonly sessions: readonly HistorySession[]; readonly entries: ReadonlyMap<string, readonly HistoryEntry[]> }
const EMPTY_STATE: State = { sessions: [], entries: new Map() };
const NO_ENTRIES: readonly HistoryEntry[] = Object.freeze([]);
const flatten = (state: State): HistoryEntry[] => state.sessions.flatMap(s => state.entries.get(s.id) ?? NO_ENTRIES);
/**
 * Copy-on-write view of the pending state for one mutation: only the sessions array, the shard map and
 * the touched session's entry list are copied, never the rest of the archive. Discarded if the change throws.
 */
class Draft {
  private ownSessions = false; private ownEntries = false; private ownOwners = false; private ownTouched = false;
  private readonly ownLists = new Set<string>();
  constructor(
    public sessions: readonly HistorySession[], public entries: ReadonlyMap<string, readonly HistoryEntry[]>,
    /** Entry id -> session id changes over the saved owners (null = removed). */
    public owners: ReadonlyMap<string, string | null>, public touched: ReadonlySet<string>,
    private readonly savedOwners: ReadonlyMap<string, string>, private readonly corrupt: ReadonlyMap<string, unknown>,
  ) {}
  writableSessions(): HistorySession[] {
    if (!this.ownSessions) { this.sessions = [...this.sessions]; this.ownSessions = true; }
    return this.sessions as HistorySession[];
  }
  list(id: string): readonly HistoryEntry[] { return this.entries.get(id) ?? NO_ENTRIES; }
  writableList(id: string): HistoryEntry[] {
    // An unreadable shard stays as stored until the session is deleted.
    if (this.corrupt.has(id)) throw invalid();
    this.touch(id);
    if (!this.ownLists.has(id)) { this.map().set(id, [...this.list(id)]); this.ownLists.add(id); }
    return this.entries.get(id) as HistoryEntry[];
  }
  dropList(id: string): void {
    this.touch(id);
    for (const entry of this.list(id)) this.setOwner(entry.id, null);
    if (this.entries.has(id)) this.map().delete(id);
    this.ownLists.delete(id);
  }
  ownerOf(entryId: string): string | undefined {
    const changed = this.owners.get(entryId);
    return changed === null ? undefined : changed ?? this.savedOwners.get(entryId);
  }
  setOwner(entryId: string, sessionId: string | null): void {
    if (!this.ownOwners) { this.owners = new Map(this.owners); this.ownOwners = true; }
    (this.owners as Map<string, string | null>).set(entryId, sessionId);
  }
  private map(): Map<string, readonly HistoryEntry[]> {
    if (!this.ownEntries) { this.entries = new Map(this.entries); this.ownEntries = true; }
    return this.entries as Map<string, readonly HistoryEntry[]>;
  }
  private touch(id: string): void {
    if (!this.ownTouched) { this.touched = new Set(this.touched); this.ownTouched = true; }
    (this.touched as Set<string>).add(id);
  }
}
interface Batch {
  state: State; owners: ReadonlyMap<string, string | null>; touched: ReadonlySet<string>;
  readonly waiters: { resolve: () => void; reject: (error: unknown) => void }[];
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * One store per storage port. Reads are copied; queued mutations commit to cache only after a successful save.
 * Storage v2 is sharded per session: a mutation writes only the shards it changed (skipping unchanged
 * ones), then the index, which is the commit point; dropped shards are cleared after the index.
 */
export class LocalHistoryStore {
  private state: State = EMPTY_STATE;
  /** Saved entry id -> session id (entry ids are unique across the archive). */
  private readonly owners = new Map<string, string>();
  /** Stored byte size of every non-empty (or unreadable) shard; the 5 MiB cap is checked from these. */
  private readonly shardBytes = new Map<string, number>();
  private shardTotal = 0;
  /** Unreadable shards: session listed without entries; index meta written back unchanged. */
  private readonly corrupt = new Map<string, unknown>();
  /** Shards whose stored value may differ from the cache after a failed save; rewritten by the next save. */
  private readonly diverged = new Set<string>();
  /** Keys of dropped shards whose clearing failed; retried on later saves. */
  private readonly garbage = new Set<string>();
  /** v0.9.1: stored chunks per session (absent: unknown, so the next save writes every chunk). */
  private readonly layouts = new Map<string, ChunkLayout>();
  /** Highest chunk count stored or attempted per session, so dropped and shrunk shards clear every chunk key. */
  private readonly chunkHigh = new Map<string, number>();
  private readonly chunkEntries: number;
  /** Last saved index value ("" until v2 exists). */
  private indexRaw = "";
  /** source: the v1 key still holds the archive (migration pending). cleanup: v2 committed, v1 key still to clear. */
  private legacy: "none" | "source" | "cleanup" = "none";
  private migrationRetryAt = 0;
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();
  private batch?: Batch;
  private delay: number;
  private flat?: HistoryEntry[];
  constructor(private readonly storage: HistoryStorage, options: LocalHistoryOptions = {}) {
    this.delay = writeDelay(options.writeDelayMs);
    this.chunkEntries = bounded(options.chunkEntries, HISTORY_CHUNK_ENTRIES, 100_000) || HISTORY_CHUNK_ENTRIES;
  }
  /** See LocalHistoryOptions.writeDelayMs. Setting 0 saves pending mutations now. */
  get writeDelayMs(): number { return this.delay; }
  set writeDelayMs(value: number) {
    this.delay = writeDelay(value);
    if (!this.delay && this.batch) void this.flush().catch(() => undefined);
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result;
  }
  private async get(key: string): Promise<string> {
    let raw: unknown; try { raw = await this.storage.getLocalStorage(key); } catch { throw new Error(LOAD_FAILED); }
    if (typeof raw !== "string") throw invalid();
    return raw;
  }
  private async put(key: string, value: string): Promise<void> {
    let saved: unknown; try { saved = await this.storage.setLocalStorage(key, value); } catch { throw new Error(SAVE_FAILED); }
    if (saved !== true) throw new Error(SAVE_FAILED);
  }
  private setBytes(id: string, bytes: number | undefined): void {
    this.shardTotal += (bytes ?? 0) - (this.shardBytes.get(id) ?? 0);
    if (bytes === undefined) this.shardBytes.delete(id); else this.shardBytes.set(id, bytes);
  }
  private async read(): Promise<void> {
    if (this.loaded) return;
    const index = await this.get(HISTORY_INDEX_KEY);
    if (index) await this.readIndex(index);
    else {
      const raw = await this.get(LEGACY_HISTORY_KEY);
      if (raw) {
        const snapshot = decode(raw), entries = new Map<string, HistoryEntry[]>();
        for (const entry of snapshot.entries) {
          let list = entries.get(entry.sessionId); if (!list) entries.set(entry.sessionId, list = []);
          list.push(entry); this.owners.set(entry.id, entry.sessionId);
        }
        this.state = { sessions: snapshot.sessions, entries };
        this.legacy = "source"; this.migrationRetryAt = 0;
        // Reads are served from the v1 data now; the shards are written behind this load.
        void this.enqueue(() => this.migrate()).catch(() => undefined);
      }
    }
    this.loaded = true; this.flat = undefined;
  }
  private async readIndex(raw: string): Promise<void> {
    let data: unknown; try { data = JSON.parse(raw); } catch { throw invalid(); }
    if (!record(data) || data.version !== 2 || !Array.isArray(data.sessions) || !record(data.shards)) throw invalid();
    const sessions = data.sessions.map(cleanSession), metas = data.shards;
    if (new Set(sessions.map(s => s.id)).size !== sessions.length) throw invalid();
    // Sessions recorded as empty have no shard to read (a stale key under their id is ignored).
    const stored = sessions.filter(s => { const meta = own(metas, s.id); return meta !== undefined && !(shardMeta(meta) && meta.entries === 0); });
    const plan = stored.flatMap((s, i) => Array.from({ length: chunkCount(own(metas, s.id)) }, (_, k) => ({ i, key: historyChunkKey(s.id, k) })));
    const settled = await settleAll(plan, IO_CONCURRENCY, read => this.storage.getLocalStorage(read.key));
    const values = stored.map(() => [] as (string | undefined)[]);
    plan.forEach((read, j) => { const result = settled[j]!; values[read.i]!.push(result.status === "fulfilled" && typeof result.value === "string" ? result.value : undefined); });
    const entries = new Map<string, HistoryEntry[]>(), owners = new Map<string, string>(), bytes = new Map<string, number>();
    const corrupt = new Map<string, unknown>(), diverged = new Set<string>(), layouts = new Map<string, ChunkLayout>(), high = new Map<string, number>();
    stored.forEach((session, i) => {
      const meta = own(metas, session.id), chunks = values[i]!;
      if (chunks.length === 1 && chunks[0] === "" && !(shardMeta(meta) && meta.entries > 0)) return;
      high.set(session.id, chunks.length);
      const parts = chunks.map(value => value === undefined || value === "" ? undefined : decodeShard(value, session.id));
      bytes.set(session.id, chunks.every(value => value !== undefined) ? chunks.reduce((n, value) => n + utf8Length(value!), 0) : shardMeta(meta) ? meta.bytes : 0);
      if (parts.some(part => !part)) { corrupt.set(session.id, meta); return; }
      // Chunks of one session: a duplicate left by an interrupted save stays in its first chunk.
      const seen = new Set<string>(), shard: HistoryEntry[] = [];
      for (const part of parts as HistoryEntry[][]) for (const entry of part) if (!seen.has(entry.id)) { seen.add(entry.id); shard.push(entry); }
      // Entry ids are unique archive-wide; a duplicate left by an interrupted move stays in its first shard.
      const kept = shard.filter(entry => !owners.has(entry.id));
      if (kept.length !== shard.length || seen.size !== parts.reduce((n, part) => n + part!.length, 0)) diverged.add(session.id);
      else layouts.set(session.id, { refs: parts as HistoryEntry[][], bytes: chunks.map(value => utf8Length(value!)) });
      for (const entry of kept) owners.set(entry.id, session.id);
      if (kept.length) entries.set(session.id, kept);
    });
    let total = utf8Length(raw); for (const size of bytes.values()) total += size;
    if (total > MAX_BYTES) throw new Error(TOO_LARGE);
    this.state = { sessions, entries };
    for (const [id, owner] of owners) this.owners.set(id, owner);
    for (const [id, size] of bytes) this.setBytes(id, size);
    for (const [id, meta] of corrupt) this.corrupt.set(id, meta);
    for (const id of diverged) this.diverged.add(id);
    for (const [id, layout] of layouts) this.layouts.set(id, layout);
    for (const [id, count] of high) this.chunkHigh.set(id, count);
    this.indexRaw = raw;
    if (data.legacyV1 === true) this.legacy = "cleanup";
  }
  /** v1 -> v2: writes every shard, then the index, then clears the v1 key. On failure the v1 data keeps serving. */
  private async migrate(): Promise<void> {
    if (this.legacy !== "source") return;
    try { await this.cleanup(await this.writeShards(this.state, this.state.sessions.map(s => s.id))); }
    catch { this.migrationRetryAt = 0; /* The next save retries. */ }
  }
  load(): Promise<void> { return this.enqueue(() => this.read()); }
  /** Saves pending (coalesced) mutations now; resolves after every earlier mutation has settled. */
  flush(): Promise<void> { return this.enqueue(async () => { if (this.batch) await this.persist(this.batch); }); }
  /** v0.9: sessions whose stored entries could not be read or validated. They are listed without entries and their shard is kept until deleted. */
  corruptSessionIds(): string[] { return [...this.corrupt.keys()]; }
  private mutate(change: (draft: Draft) => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.enqueue(async () => {
        await this.read();
        const open = this.batch;
        const draft = new Draft(open?.state.sessions ?? this.state.sessions, open?.state.entries ?? this.state.entries,
          open?.owners ?? new Map(), open?.touched ?? new Set(), this.owners, this.corrupt);
        change(draft);
        const batch: Batch = open ?? { state: this.state, owners: draft.owners, touched: draft.touched, waiters: [] };
        batch.state = { sessions: draft.sessions, entries: draft.entries }; batch.owners = draft.owners; batch.touched = draft.touched;
        batch.waiters.push({ resolve, reject });
        this.batch = batch;
        if (!this.delay) await this.persist(batch);
        else batch.timer ??= setTimeout(() => {
          batch.timer = undefined;
          void this.enqueue(async () => { if (this.batch === batch) await this.persist(batch); }).catch(() => undefined);
        }, this.delay);
      }).catch(reject);
    });
  }
  /** Saves a batch; its callers settle with the outcome. The cache changes only on success. */
  private async persist(batch: Batch): Promise<void> {
    if (this.batch === batch) this.batch = undefined;
    if (batch.timer !== undefined) { clearTimeout(batch.timer); batch.timer = undefined; }
    try {
      if (this.legacy === "source") await this.persistLegacy(batch);
      else { const clears = await this.writeShards(batch.state, batch.touched); this.commit(batch); await this.cleanup(clears); }
    } catch (error) { for (const waiter of batch.waiters) waiter.reject(error); throw error; }
    for (const waiter of batch.waiters) waiter.resolve();
  }
  /** Migration pending: retry it with this save; until it succeeds, save the whole archive to v1 as before v0.9. */
  private async persistLegacy(batch: Batch): Promise<void> {
    if (Date.now() >= this.migrationRetryAt) {
      try {
        const clears = await this.writeShards(batch.state, batch.state.sessions.map(s => s.id));
        this.commit(batch); await this.cleanup(clears); return;
      } catch { this.migrationRetryAt = Date.now() + MIGRATION_RETRY_MS; }
    }
    const raw = JSON.stringify({ version: 1, sessions: batch.state.sessions, entries: flatten(batch.state) });
    if (utf8Length(raw) > MAX_BYTES) throw new Error(TOO_LARGE_SAVE);
    await this.put(LEGACY_HISTORY_KEY, raw);
    this.commit(batch);
  }
  /**
   * Writes the changed shards of `next` (plus any left diverged by a failed save), then the index.
   * Throws before the index on any failure. Returns the keys to clear after commit.
   */
  private async writeShards(next: State, changed: Iterable<string>): Promise<Map<string, string | undefined>> {
    const present = new Set(next.sessions.map(s => s.id));
    const writes: { id: string; key: string; raw: string; bytes: number }[] = [], clears = new Map<string, string | undefined>();
    const written = new Map<string, ShardMeta>(), nextLayouts = new Map<string, ChunkLayout>();
    let total = this.shardTotal;
    for (const id of new Set([...changed, ...this.diverged])) {
      if (this.corrupt.has(id) && present.has(id)) continue;
      const list = present.has(id) ? next.entries.get(id) ?? NO_ENTRIES : NO_ENTRIES, stored = this.shardBytes.get(id) ?? 0;
      const layout = this.diverged.has(id) ? undefined : this.layouts.get(id);
      const high = Math.max(1, this.chunkHigh.get(id) ?? 0, layout?.refs.length ?? 0, this.corrupt.has(id) ? chunkCount(this.corrupt.get(id)) : 0);
      if (list.length) {
        // Only chunks whose entries changed are rewritten (entries are immutable once stored, so identity is enough).
        const refs: (readonly HistoryEntry[])[] = [], sizes: number[] = [];
        let bytes = 0;
        for (let k = 0, start = 0; start < list.length; k++, start += this.chunkEntries) {
          const part = list.slice(start, start + this.chunkEntries), before = layout?.refs[k];
          let size: number;
          if (before && before.length === part.length && before.every((entry, i) => entry === part[i])) size = layout!.bytes[k]!;
          else { const raw = JSON.stringify(part); size = utf8Length(raw); writes.push({ id, key: historyChunkKey(id, k), raw, bytes: size }); }
          refs.push(part); sizes.push(size); bytes += size;
        }
        for (let k = refs.length; k < high; k++) clears.set(historyChunkKey(id, k), undefined); // Shrunk: cleared after the index.
        nextLayouts.set(id, { refs, bytes: sizes });
        written.set(id, { bytes, entries: list.length, ...(refs.length > 1 ? { chunks: refs.length } : {}) }); total += bytes - stored;
      } else if (this.shardBytes.has(id) || this.diverged.has(id) || this.corrupt.has(id)) {
        clears.set(historyShardKey(id), id); total -= stored;
        for (let k = 1; k < high; k++) clears.set(historyChunkKey(id, k), undefined);
      }
    }
    // A save that fails part-way may leave new chunk keys behind: remember them so they are cleared later.
    for (const [id, layout] of nextLayouts) this.chunkHigh.set(id, Math.max(this.chunkHigh.get(id) ?? 0, layout.refs.length));
    for (const key of this.garbage) if (!clears.has(key)) clears.set(key, undefined);
    const shards = Object.fromEntries(next.sessions.map(s => {
      if (this.corrupt.has(s.id)) return [s.id, this.corrupt.get(s.id)];
      const entries = next.entries.get(s.id)?.length ?? 0, chunks = entries ? this.layouts.get(s.id)?.refs.length ?? 1 : 1;
      return [s.id, written.get(s.id) ?? { bytes: entries ? this.shardBytes.get(s.id) ?? 0 : 0, entries, ...(chunks > 1 ? { chunks } : {}) }];
    }));
    const index: V2Index = { version: 2, sessions: next.sessions as HistorySession[], shards, ...(this.legacy !== "none" ? { legacyV1: true as const } : {}) };
    const indexRaw = JSON.stringify(index);
    if (total + utf8Length(indexRaw) > MAX_BYTES) throw new Error(TOO_LARGE_SAVE);
    const results = await settleAll(writes, IO_CONCURRENCY, write => this.put(write.key, write.raw));
    // Written or not, those shards may now differ from the cache: the next save rewrites them.
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) { for (const write of writes) this.diverged.add(write.id); throw failed.reason; }
    if (indexRaw !== this.indexRaw) {
      try { await this.put(HISTORY_INDEX_KEY, indexRaw); } catch (error) { for (const write of writes) this.diverged.add(write.id); throw error; }
    }
    // Committed.
    this.indexRaw = indexRaw;
    for (const [id, layout] of nextLayouts) { this.layouts.set(id, layout); this.setBytes(id, layout.bytes.reduce((n, b) => n + b, 0)); this.diverged.delete(id); }
    for (const id of clears.values()) if (id !== undefined) { this.setBytes(id, undefined); this.diverged.delete(id); this.corrupt.delete(id); this.layouts.delete(id); }
    if (this.legacy === "source") this.legacy = "cleanup";
    return clears;
  }
  /** Best effort after commit: unreachable keys are retried by later saves. */
  private async cleanup(clears: Map<string, string | undefined>): Promise<void> {
    const keys = [...clears.keys()];
    const results = await settleAll(keys, IO_CONCURRENCY, key => this.put(key, ""));
    results.forEach((result, i) => { if (result.status === "fulfilled") this.garbage.delete(keys[i]!); else this.garbage.add(keys[i]!); });
    if (this.legacy === "cleanup") { try { await this.put(LEGACY_HISTORY_KEY, ""); this.legacy = "none"; } catch { /* Retried by the next save. */ } }
  }
  private commit(batch: Batch): void {
    this.state = batch.state; this.flat = undefined;
    for (const [id, session] of batch.owners) if (session === null) this.owners.delete(id); else this.owners.set(id, session);
  }
  private entries(): HistoryEntry[] { return this.flat ??= flatten(this.state); }
  /** Inserts or replaces a session. Knowledge fields absent from `session` keep their stored values. */
  async upsertSession(session: HistorySession): Promise<void> {
    const clean = cleanSession(session);
    return this.mutate(draft => {
      const index = draft.sessions.findIndex(s => s.id === clean.id), sessions = draft.writableSessions();
      if (index < 0) { sessions.push(clean); return; }
      const old = sessions[index]!, merged: HistorySession = { ...clean };
      for (const key of KNOWLEDGE_KEYS) if (merged[key] === undefined && old[key] !== undefined) (merged as unknown as Record<string, unknown>)[key] = old[key];
      for (const key of NOTEBOOK_KEYS) if (merged[key] === undefined && old[key] !== undefined) (merged as unknown as Record<string, unknown>)[key] = old[key];
      sessions[index] = merged;
    });
  }
  /**
   * v0.8: sets summary/keyFacts/people/concepts/tags of an existing session (validated, <= 20 items of
   * <= 500 chars). Absent fields are kept, [] clears. Does not change updatedAt or entries.
   */
  async updateSessionKnowledge(id: string, patch: SessionKnowledge): Promise<void> {
    if (!record(patch)) throw new Error("Session knowledge must be an object.");
    const clean = cleanKnowledge(patch as Record<string, unknown>);
    return this.mutate(draft => {
      const index = draft.sessions.findIndex(s => s.id === id);
      if (index < 0) throw new Error("Cannot update knowledge for a session that is not saved.");
      const session: HistorySession = { ...draft.sessions[index]! };
      for (const key of KNOWLEDGE_KEYS) {
        const value = clean[key];
        if (value === undefined) continue;
        if (value.length) (session as unknown as Record<string, unknown>)[key] = value; else delete session[key];
      }
      draft.writableSessions()[index] = session;
    });
  }
  /**
   * Notes mode: sets the to-do list and/or running notes of an existing session (validated and bounded).
   * Absent fields are kept, [] clears. Does not change updatedAt or entries.
   */
  async updateSessionNotebook(id: string, patch: SessionNotebookData): Promise<void> {
    if (!record(patch)) throw new Error("Session notebook must be an object.");
    const clean = cleanNotebook(patch as Record<string, unknown>);
    return this.mutate(draft => {
      const index = draft.sessions.findIndex(s => s.id === id);
      if (index < 0) throw new Error("Cannot update the notebook of a session that is not saved.");
      const session: HistorySession = { ...draft.sessions[index]! };
      for (const key of NOTEBOOK_KEYS) {
        const value = clean[key];
        if (value === undefined) continue;
        if (value.length) (session as unknown as Record<string, unknown>)[key] = value; else delete session[key];
      }
      draft.writableSessions()[index] = session;
    });
  }
  /** v0.8 People tab: people across all sessions, merged by normalized name, most mentioned first. */
  listPeople(): PersonAggregate[] {
    const sessions = this.listSessions(), people = new Map<string, PersonAggregate & { roleKeys: Set<string> }>();
    for (const session of sessions) for (const person of session.people ?? []) {
      const key = personKey(person.name);
      if (!key) continue;
      let item = people.get(key);
      if (!item) { item = { name: person.name, roles: [], sessionIds: [], mentions: 0, lastSeen: session.updatedAt, roleKeys: new Set() }; people.set(key, item); }
      if (!item.sessionIds.includes(session.id)) item.sessionIds.push(session.id);
      item.mentions += person.mentions ?? 1;
      if (person.role && !item.roleKeys.has(personKey(person.role))) { item.roleKeys.add(personKey(person.role)); item.roles.push(person.role); }
    }
    return [...people.values()].map(({ roleKeys: _roles, ...person }) => person)
      .sort((a, b) => b.mentions - a.mentions || Date.parse(b.lastSeen) - Date.parse(a.lastSeen) || a.name.localeCompare(b.name));
  }
  /** v0.8 Knowledgebase tab: sessions, entries and latest session update per source. */
  stats(): KnowledgeStats {
    const result = Object.fromEntries(KNOWLEDGE_SOURCES.map(source => [source, { sessions: 0, entries: 0 }])) as KnowledgeStats;
    const sourceOf = new Map<string, KnowledgeSource>();
    for (const session of this.state.sessions) {
      const item = result[session.source];
      item.sessions++; sourceOf.set(session.id, session.source);
      if (!item.lastUpdated || Date.parse(session.updatedAt) > Date.parse(item.lastUpdated)) item.lastUpdated = session.updatedAt;
    }
    for (const [id, list] of this.state.entries) { const source = sourceOf.get(id); if (source) result[source].entries += list.length; }
    return result;
  }
  async upsertEntries(entries: HistoryEntry[]): Promise<void> {
    if (!Array.isArray(entries)) throw invalid(); const cleaned = entries.map(cleanEntry);
    return this.mutate(draft => {
      const sessions = new Set(draft.sessions.map(s => s.id));
      if (cleaned.some(e => !sessions.has(e.sessionId))) throw new Error("Cannot save history entries without their session.");
      for (const entry of cleaned) {
        const owner = draft.ownerOf(entry.id);
        if (owner === entry.sessionId) {
          const i = draft.list(owner).findIndex(e => e.id === entry.id);
          if (i >= 0 && sameEntry(draft.list(owner)[i]!, entry)) continue; // Unchanged: the shard is not rewritten.
          const list = draft.writableList(owner);
          if (i >= 0) list[i] = entry; else list.push(entry);
          continue;
        }
        // Entry ids are archive-wide: an id saved under another session moves, as in v1.
        const target = draft.writableList(entry.sessionId);
        if (owner !== undefined) { const from = draft.writableList(owner), i = from.findIndex(e => e.id === entry.id); if (i >= 0) from.splice(i, 1); }
        target.push(entry); draft.setOwner(entry.id, entry.sessionId);
      }
    });
  }
  listSessions(): HistorySession[] { return copy([...this.state.sessions]).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id)); }
  /** One session without copying the whole archive (listSessions clones every session). */
  getSession(sessionId: string): HistorySession | undefined { const found = this.state.sessions.find(session => session.id === sessionId); return found ? copy(found) : undefined; }
  /** Saved entries of a session; O(1), for change detection. */
  entryCount(sessionId: string): number { return this.state.entries.get(sessionId)?.length ?? 0; }
  /** The session that holds an entry (memory provenance links); no copies. */
  sessionIdOfEntry(entryId: string): string | undefined {
    const owner = this.owners.get(entryId);
    if (owner !== undefined) return this.state.entries.has(owner) ? owner : undefined;
    for (const [sessionId, entries] of this.state.entries) if (entries.some(entry => entry.id === entryId)) return sessionId;
    return undefined;
  }
  getEntries(sessionId: string): HistoryEntry[] { return copy([...this.state.entries.get(sessionId) ?? NO_ENTRIES]).sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id)); }
  search(query: string, limit?: number): RetrievedMemory[] { return this.rank(query, false).slice(0, bounded(limit, 50, 500)); }
  retrieve(query: string, options: { excludeSessionId?: string; limit?: number; maxChars?: number } = {}): RetrievedMemory[] {
    return this.retrieveWithStats(query, options).items;
  }
  /** BM25 over the best passage of each eligible entry; returns diagnostics for UI. */
  retrieveWithStats(query: string, options: { excludeSessionId?: string; limit?: number; maxChars?: number } = {}): RetrievalStats {
    const limit = bounded(options.limit, 5, 50);
    let remaining = bounded(options.maxChars, 3000, 20_000);
    const sessions = new Map(this.state.sessions.map(s => [s.id, s]));
    const eligible = this.entries().filter(entry => entry.sessionId !== options.excludeSessionId && sessions.has(entry.sessionId) && KIND_WEIGHT[entry.kind] > 0
      && !(entry.kind === "transcript" && /^(assistant|ai|system|omi summary)$/i.test(entry.speaker?.trim() ?? ""))
      // Imported Omi overviews are vendor-generated summaries, not evidence.
      && entry.metadata?.origin !== "omi-summary" && !/^omi summary$/i.test(entry.speaker?.trim() ?? ""));
    const stats: RetrievalStats = { items: [], searchedEntries: eligible.length, matched: 0 };
    const queryTerms = terms(query).slice(0, 400);
    if (!queryTerms.length || !eligible.length) return stats;
    // Expand each corpus token to the query terms it matches, once per call.
    const tokensById = new Map(eligible.map(entry => [entry.id, tokenList(entry.text)]));
    const expansion = new Map<string, [number, number][]>();
    for (const tokens of tokensById.values()) for (const token of tokens) {
      if (expansion.has(token)) continue;
      const matches: [number, number][] = [];
      queryTerms.forEach((q, i) => { const w = matchWeight(q, token); if (w) matches.push([i, w]); });
      expansion.set(token, matches);
    }
    const df = new Array<number>(queryTerms.length).fill(0);
    for (const tokens of tokensById.values()) {
      const seen = new Set<number>();
      for (const token of tokens) for (const [i] of expansion.get(token)!) seen.add(i);
      for (const i of seen) df[i]!++;
    }
    const n = eligible.length;
    const idf = df.map(d => Math.log(1 + (n - d + 0.5) / (d + 0.5)));
    const passageOf = (entry: HistoryEntry, width: number): { text: string; tokens: string[] } => {
      const all = tokensById.get(entry.id)!;
      if (entry.text.length <= width) return { text: entry.text, tokens: all };
      let best = { text: entry.text.slice(0, width), tokens: tokenList(entry.text.slice(0, width)), score: -1 };
      for (let start = 0; start < entry.text.length; start += Math.max(1, Math.floor(width / 2))) {
        const text = entry.text.slice(start, start + width), tokens = tokenList(text), hit = new Map<number, number>();
        for (const token of tokens) for (const [i, w] of expansion.get(token) ?? []) hit.set(i, Math.max(hit.get(i) ?? 0, w));
        const score = [...hit].reduce((sum, [i, w]) => sum + idf[i]! * w, 0);
        if (score > best.score) best = { text, tokens, score };
      }
      return best;
    };
    const lengths = eligible.map(entry => Math.max(1, Math.min(tokensById.get(entry.id)!.length, PASSAGE_WIDTH / 5)));
    const avgdl = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const scored: RetrievedMemory[] = [];
    for (const entry of eligible) {
      const selected = passageOf(entry, PASSAGE_WIDTH), tf = new Map<number, number>();
      for (const token of selected.tokens) for (const [i, w] of expansion.get(token) ?? []) tf.set(i, (tf.get(i) ?? 0) + w);
      if (!tf.size) continue;
      const len = Math.max(1, selected.tokens.length);
      let score = 0;
      for (const [i, f] of tf) score += idf[i]! * (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * len / avgdl));
      score *= KIND_WEIGHT[entry.kind];
      // One strong rare-term hit is enough; only zero-score entries are dropped.
      if (!(score > 0)) continue;
      const timestamp = Math.max(0, Date.parse(entry.occurredAt));
      // Small monotonic recency weight resolves equal lexical scores without swamping relevance.
      scored.push({ entry: copy(entry), session: copy(sessions.get(entry.sessionId)!), score: score + 0.001 * timestamp / (timestamp + 1e12) });
    }
    stats.matched = scored.length;
    scored.sort((a, b) => b.score - a.score || Date.parse(b.entry.occurredAt) - Date.parse(a.entry.occurredAt) || a.entry.id.localeCompare(b.entry.id));
    if (!remaining || !limit) return stats;
    for (const hit of scored) {
      const width = Math.min(PASSAGE_WIDTH, remaining);
      const selected = passageOf(hit.entry, width);
      if (!selected.text) continue;
      hit.entry.text = selected.text; remaining -= selected.text.length; stats.items.push(hit);
      if (!remaining || stats.items.length >= limit) break;
    }
    return stats;
  }
  private rank(query: string, _evidenceOnly: boolean, excludeSessionId?: string): RetrievedMemory[] {
    const queryTerms = terms(query); if (!queryTerms.length) return [];
    const sessions = new Map(this.state.sessions.map(s => [s.id, s]));
    const result: RetrievedMemory[] = [];
    for (const entry of this.entries()) {
      if (entry.sessionId === excludeSessionId) continue;
      const session = sessions.get(entry.sessionId); if (!session) continue;
      const score = Math.max(relevance(entry.text, queryTerms), relevance(session.title, queryTerms));
      if (!score) continue;
      const timestamp = Math.max(0, Date.parse(entry.occurredAt));
      result.push({ entry: copy(entry), session: copy(session), score: score + 0.001 * timestamp / (timestamp + 1e12) });
    }
    return result.sort((a, b) => b.score - a.score || Date.parse(b.entry.occurredAt) - Date.parse(a.entry.occurredAt) || a.entry.id.localeCompare(b.entry.id));
  }
  /** Drops the session from the index, then clears its shard. */
  deleteSession(id: string): Promise<void> {
    return this.mutate(draft => {
      const index = draft.sessions.findIndex(s => s.id === id);
      if (index >= 0) draft.writableSessions().splice(index, 1);
      draft.dropList(id);
    });
  }
  /** Single-file export in the v1 snapshot format ({ version: 1, sessions, entries }). */
  exportJson(): string { return JSON.stringify({ version: 1, sessions: this.state.sessions, entries: this.entries() }, null, 2); }
}
