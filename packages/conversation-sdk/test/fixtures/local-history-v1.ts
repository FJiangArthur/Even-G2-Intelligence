// Frozen v0.8 (v1 single-key) LocalHistoryStore, used only as a reference by v09-history-shards.test.ts.
import type { KnowledgeSource } from "../../src/copilot-types.js";

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
}
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
interface Snapshot { version: 1; sessions: HistorySession[]; entries: HistoryEntry[] }
const KEY = "helix.g2.history.v1";
const MAX_BYTES = 5 * 1024 * 1024;
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
function cleanSession(value: unknown): HistorySession {
  if (!record(value) || !string(value.id) || !KNOWLEDGE_SOURCES.includes(value.source as KnowledgeSource) || typeof value.title !== "string" || !date(value.startedAt) || !date(value.updatedAt)) throw invalid();
  return { id: value.id, source: value.source as KnowledgeSource, title: value.title, startedAt: value.startedAt, updatedAt: value.updatedAt, ...cleanKnowledge(value) };
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
  if (new TextEncoder().encode(raw).length > MAX_BYTES) throw new Error("Local history exceeds the 5 MiB storage limit.");
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

/** One store per storage port. Reads are copied; queued mutations commit to cache only after a successful save. */
export class LocalHistoryStore {
  private snapshot: Snapshot = { version: 1, sessions: [], entries: [] };
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly storage: HistoryStorage) {}
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result;
  }
  private async read(): Promise<void> {
    if (this.loaded) return;
    let raw: string; try { raw = await this.storage.getLocalStorage(KEY); } catch { throw new Error("Could not load local history from storage."); }
    if (typeof raw !== "string") throw invalid();
    const next: Snapshot = raw === "" ? { version: 1, sessions: [], entries: [] } : decode(raw);
    this.snapshot = next; this.loaded = true;
  }
  load(): Promise<void> { return this.enqueue(() => this.read()); }
  private mutate(change: (draft: Snapshot) => void): Promise<void> {
    return this.enqueue(async () => {
      await this.read(); const draft = copy(this.snapshot); change(draft);
      const raw = JSON.stringify(draft);
      if (new TextEncoder().encode(raw).length > MAX_BYTES) throw new Error("Local history exceeds the 5 MiB storage limit. Export or delete sessions before retrying.");
      let saved: boolean; try { saved = await this.storage.setLocalStorage(KEY, raw); } catch { throw new Error("Could not save local history. Storage may be full or unavailable."); }
      if (saved !== true) throw new Error("Could not save local history. Storage may be full or unavailable.");
      this.snapshot = draft;
    });
  }
  /** Inserts or replaces a session. Knowledge fields absent from `session` keep their stored values. */
  async upsertSession(session: HistorySession): Promise<void> {
    const clean = cleanSession(session);
    return this.mutate(draft => {
      const index = draft.sessions.findIndex(s => s.id === clean.id);
      if (index < 0) { draft.sessions.push(clean); return; }
      const old = draft.sessions[index]!, merged: HistorySession = { ...clean };
      for (const key of KNOWLEDGE_KEYS) if (merged[key] === undefined && old[key] !== undefined) (merged as unknown as Record<string, unknown>)[key] = old[key];
      draft.sessions[index] = merged;
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
      const session = draft.sessions.find(s => s.id === id);
      if (!session) throw new Error("Cannot update knowledge for a session that is not saved.");
      for (const key of KNOWLEDGE_KEYS) {
        const value = clean[key];
        if (value === undefined) continue;
        if (value.length) (session as unknown as Record<string, unknown>)[key] = value; else delete session[key];
      }
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
    for (const session of this.snapshot.sessions) {
      const item = result[session.source];
      item.sessions++; sourceOf.set(session.id, session.source);
      if (!item.lastUpdated || Date.parse(session.updatedAt) > Date.parse(item.lastUpdated)) item.lastUpdated = session.updatedAt;
    }
    for (const entry of this.snapshot.entries) { const source = sourceOf.get(entry.sessionId); if (source) result[source].entries++; }
    return result;
  }
  async upsertEntries(entries: HistoryEntry[]): Promise<void> {
    if (!Array.isArray(entries)) throw invalid(); const cleaned = entries.map(cleanEntry);
    return this.mutate(draft => {
      const sessions = new Set(draft.sessions.map(s => s.id));
      if (cleaned.some(e => !sessions.has(e.sessionId))) throw new Error("Cannot save history entries without their session.");
      const merged = new Map(draft.entries.map(e => [e.id, e]));
      for (const entry of cleaned) merged.set(entry.id, entry);
      draft.entries = [...merged.values()];
    });
  }
  listSessions(): HistorySession[] { return copy(this.snapshot.sessions).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id)); }
  getEntries(sessionId: string): HistoryEntry[] { return copy(this.snapshot.entries.filter(e => e.sessionId === sessionId)).sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id)); }
  search(query: string, limit?: number): RetrievedMemory[] { return this.rank(query, false).slice(0, bounded(limit, 50, 500)); }
  retrieve(query: string, options: { excludeSessionId?: string; limit?: number; maxChars?: number } = {}): RetrievedMemory[] {
    return this.retrieveWithStats(query, options).items;
  }
  /** BM25 over the best passage of each eligible entry; returns diagnostics for UI. */
  retrieveWithStats(query: string, options: { excludeSessionId?: string; limit?: number; maxChars?: number } = {}): RetrievalStats {
    const limit = bounded(options.limit, 5, 50);
    let remaining = bounded(options.maxChars, 3000, 20_000);
    const sessions = new Map(this.snapshot.sessions.map(s => [s.id, s]));
    const eligible = this.snapshot.entries.filter(entry => entry.sessionId !== options.excludeSessionId && sessions.has(entry.sessionId) && KIND_WEIGHT[entry.kind] > 0
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
    const sessions = new Map(this.snapshot.sessions.map(s => [s.id, s]));
    const result: RetrievedMemory[] = [];
    for (const entry of this.snapshot.entries) {
      if (entry.sessionId === excludeSessionId) continue;
      const session = sessions.get(entry.sessionId); if (!session) continue;
      const score = Math.max(relevance(entry.text, queryTerms), relevance(session.title, queryTerms));
      if (!score) continue;
      const timestamp = Math.max(0, Date.parse(entry.occurredAt));
      result.push({ entry: copy(entry), session: copy(session), score: score + 0.001 * timestamp / (timestamp + 1e12) });
    }
    return result.sort((a, b) => b.score - a.score || Date.parse(b.entry.occurredAt) - Date.parse(a.entry.occurredAt) || a.entry.id.localeCompare(b.entry.id));
  }
  deleteSession(id: string): Promise<void> { return this.mutate(draft => { draft.sessions = draft.sessions.filter(s => s.id !== id); draft.entries = draft.entries.filter(e => e.sessionId !== id); }); }
  exportJson(): string { return JSON.stringify(this.snapshot, null, 2); }
}
