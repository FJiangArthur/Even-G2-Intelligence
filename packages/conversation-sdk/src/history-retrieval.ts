import type { HistoryEntry, HistorySession, RetrievalStats, RetrievedMemory } from "./local-history.js";

/*
 * Saved-knowledge search (BM25 over the best passage of each entry) behind a token index.
 *
 * The search used to tokenize the whole archive and deep-copy every match on each answer: on a
 * near-5 MiB archive that was one blocked task of about a second on a phone, long enough for
 * microphone events to pile up behind it. Here every entry is tokenized once, when it is first seen;
 * a query only walks integer token ids, copies only what it returns, and all of it runs as a generator
 * that the caller can pause every few milliseconds. Results are identical to the unindexed search,
 * floating-point summation order included.
 */

const STOP_WORDS = new Set("a an the and or but is are was were be been being to of in on at for with from by it its this that these those i you we they he she my your our their do does did can could would should what when where who how please me us about as".split(" "));
export const normalize = (value: string) => value.normalize("NFKC").toLowerCase();
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;
export const CJK_CHAR = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
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
export function tokenList(value: string): string[] {
  const separated = normalize(value).replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu, " $& ");
  const tokens = separated.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}]+/gu) ?? [];
  return tokens.flatMap(token => {
    if (CJK.test(token)) { const chars = [...token]; return chars.length === 1 ? chars : chars.slice(0, -1).map((c, i) => c + chars[i + 1]); }
    return STOP_WORDS.has(token) ? [] : [stemTerm(token)];
  });
}
export function terms(value: string): string[] { return [...new Set(tokenList(value))]; }
/*
 * How a query term matches a stored token (the index below answers this by lookup instead of comparing
 * every pair): the same stem = 1; a single CJK character inside a CJK token = 1; otherwise, for two
 * non-CJK tokens of >= 4 characters, one being a prefix of the other with at most 4 more characters = 0.7.
 */
const PREFIX_MIN = 4, PREFIX_EXTRA = 4, PREFIX_WEIGHT = 0.7;
/** Relative evidence weight. Transcript (what was said) outranks generated records. */
const KIND_WEIGHT: Readonly<Record<HistoryEntry["kind"], number>> = { transcript: 1, answer: 0.6, "fact-check": 0.5, question: 0 };
const BM25_K1 = 1.2, BM25_B = 0.75, PASSAGE_WIDTH = 600;
/** A query looks at the clock once per this many tokens walked (plus a few per entry): well under a millisecond of work. */
const SLICE_CHECK_WORK = 4096, SLICE_CHECK_DOC = 8;
/** What may be quoted as evidence: speech and generated records, never assistant rows or vendor summaries. */
function evidence(entry: HistoryEntry): boolean {
  return KIND_WEIGHT[entry.kind] > 0
    && !(entry.kind === "transcript" && /^(assistant|ai|system|omi summary)$/i.test(entry.speaker?.trim() ?? ""))
    // Imported Omi overviews are vendor-generated summaries, not evidence.
    && entry.metadata?.origin !== "omi-summary" && !/^omi summary$/i.test(entry.speaker?.trim() ?? "");
}
export function bounded(value: number | undefined, fallback: number, max: number): number {
  return value === undefined ? fallback : Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : fallback;
}

export interface RetrievalOptions { excludeSessionId?: string; limit?: number; maxChars?: number }
/** How a sliced search or index build used the thread: wall time, the longest uninterrupted slice, slices run. */
export interface RetrievalTiming { totalMs: number; maxSliceMs: number; slices: number }
/** The saved archive as the store holds it. A changed session has a new entry list; saved entries are never edited in place. */
export interface RetrievalSource { readonly sessions: readonly HistorySession[]; readonly entries: ReadonlyMap<string, readonly HistoryEntry[]> }
/** True when the running slice has used its time; the work then yields at the next safe point. */
export type SliceClock = () => boolean;
const NO_ENTRIES: readonly HistoryEntry[] = Object.freeze([]);
const NO_TOKENS: Uint32Array = new Uint32Array(0);

/** Longest piece of text tokenized without looking at the clock. */
const CHUNK_CHARS = 2048;
// A cut is only made after one of these: they end a token, are unchanged by NFKC, combine with nothing and
// do not affect how a neighbouring letter is lower-cased ("." and "'" do, for a final sigma).
const CUT_AFTER = new Set([0x20, 0x0a, 0x0d, 0x09, 0x3001, 0x3002, 0xff0c, 0xff01, 0xff1f]);
/** ...and only before a character that starts its own normalization: Latin-1/Latin Extended, CJK ideographs, kana, Hangul syllables. */
const startsClean = (code: number) => code < 0x300 || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3041 && code <= 0x3096) || (code >= 0x30a1 && code <= 0x30fa) || (code >= 0xac00 && code <= 0xd7a3);
/**
 * Cuts a long text into pieces of about CHUNK_CHARS whose tokens, concatenated, are exactly the tokens of
 * the whole text, so a pasted document is tokenized with pauses instead of in one long task. A text
 * without a safe place to cut stays in one piece.
 */
export function tokenChunks(text: string, size = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (text.length - start > size * 2) {
    let cut = start + size;
    while (cut < text.length && !(CUT_AFTER.has(text.charCodeAt(cut - 1)) && startsClean(text.charCodeAt(cut)))) cut++;
    if (cut >= text.length) break;
    chunks.push(text.slice(start, cut)); start = cut;
  }
  chunks.push(start ? text.slice(start) : text);
  return chunks;
}

/** A tokenized entry before it is stored: token ids in text order and, when the text is longer than a passage, the ids of each 600-character window one after another (`ends` = where each window stops). */
interface Draft { readonly entry: HistoryEntry; readonly tokens: number[]; readonly windows?: number[]; readonly ends?: number[] }
/**
 * One searchable entry. Its token ids are shelf.ids[at, at + count), followed for a long entry by its
 * windows' ids (`ends` counts from at + count). One typed array per session, not per entry: a small
 * typed array costs far more than the ids it holds.
 */
interface Doc { readonly entry: HistoryEntry; readonly shelf: Shelf; at: number; readonly count: number; readonly ends?: Uint32Array; readonly time: number; readonly length: number }
/**
 * Index of one session, aligned with its saved entry list. A slot is undefined until tokenized and null
 * when it is not evidence. `ids` holds the token ids of its entries (`filled` in use, `wasted` of those
 * left by removed entries). `counts` (token -> occurrences in this session) exists once the session has
 * been the excluded one of a query, and is then kept up to date.
 */
interface Shelf { list: readonly HistoryEntry[]; docs: (Doc | null | undefined)[]; pending: number; cursor: number; eligible: number; lengths: number; ids: Uint32Array; filled: number; wasted: number; counts?: Map<number, number> }
const span = (doc: Doc): number => doc.count + (doc.ends?.length ? doc.ends[doc.ends.length - 1]! : 0);
const grown = (array: Uint32Array, needed: number): Uint32Array => { const next = new Uint32Array(Math.max(needed, Math.ceil(array.length * 1.5), 64)); next.set(array); return next; };
interface Candidate { doc: Doc; score: number; window: number; order: number }
/** The vocabulary is rebuilt when more than half of it (and at least this many tokens) is no longer in any entry. */
const COMPACT_MIN = 2048;
/** No CJK token starts below this (Hangul Jamo; kana and ideographs are higher). */
const CJK_FIRST = 0x1100;

export class RetrievalIndex {
  private readonly ids = new Map<string, number>();
  private readonly names: string[] = [];
  /** Occurrences of each token in indexed evidence (passage-window fragments are known but count 0). */
  private counts: Uint32Array = new Uint32Array(0);
  /** Occurrences anywhere in the index, windows included; `used` = tokens with any. */
  private refs: Uint32Array = new Uint32Array(0);
  private used = 0;
  /** First 4 characters -> longer non-CJK tokens starting with them (prefix matches). */
  private readonly byHead = new Map<string, number[]>();
  private readonly shelves = new Map<string, Shelf>();
  private readonly unfinished = new Set<Shelf>();
  private source?: RetrievalSource;
  private eligible = 0;
  private lengths = 0;
  /** Bumped on every change, so a paused query can tell that it must start over. */
  private version = 0;
  /** Query expansion, reused by every query: token -> slot in that query's match lists, valid while mark[token] is the query's number. */
  private mark: Uint32Array = new Uint32Array(0);
  private slot: Uint32Array = new Uint32Array(0);
  private queries = 0;

  private intern(token: string): number {
    let id = this.ids.get(token);
    if (id !== undefined) return id;
    id = this.names.length; this.ids.set(token, id); this.names.push(token);
    if (id >= this.counts.length) { this.counts = grown(this.counts, id + 1); this.refs = grown(this.refs, id + 1); }
    if (token.length > PREFIX_MIN && !CJK.test(token)) { const head = token.slice(0, PREFIX_MIN), list = this.byHead.get(head); if (list) list.push(id); else this.byHead.set(head, [id]); }
    return id;
  }
  private internAll(text: string, into: number[]): void { for (const token of tokenList(text)) into.push(this.intern(token)); }
  private *build(entry: HistoryEntry, clock: SliceClock): Generator<void, Draft | null> {
    if (!evidence(entry)) return null;
    const text = entry.text, tokens: number[] = [];
    for (const chunk of tokenChunks(text)) { this.internAll(chunk, tokens); if (clock()) yield; }
    if (text.length <= PASSAGE_WIDTH) return { entry, tokens };
    const windows: number[] = [], ends: number[] = [];
    for (let start = 0; start < text.length; start += PASSAGE_WIDTH / 2) { this.internAll(text.slice(start, start + PASSAGE_WIDTH), windows); ends.push(windows.length); if (clock()) yield; }
    return { entry, tokens, windows, ends };
  }
  private count(doc: Doc, by: 1 | -1): void {
    const shelf = doc.shelf, ids = shelf.ids, refs = this.refs, counts = this.counts, own = shelf.counts, stop = doc.at + doc.count, end = doc.at + span(doc);
    for (let t = doc.at; t < end; t++) {
      const token = ids[t]!, before = refs[token]!;
      refs[token] = before + by; if (!before) this.used++; else if (before + by === 0) this.used--;
      if (t >= stop) continue; // window ids only keep their tokens known
      counts[token]! += by;
      if (own) { const next = (own.get(token) ?? 0) + by; if (next) own.set(token, next); else own.delete(token); }
    }
    shelf.eligible += by; shelf.lengths += by * doc.length; this.eligible += by; this.lengths += by * doc.length;
  }
  private place(shelf: Shelf, slot: number, draft: Draft | null): void {
    this.version++;
    if (draft) {
      const { entry, tokens, windows, ends } = draft, needed = shelf.filled + tokens.length + (windows?.length ?? 0);
      if (needed > shelf.ids.length) shelf.ids = grown(shelf.ids, needed);
      const doc: Doc = { entry, shelf, at: shelf.filled, count: tokens.length, ...(ends ? { ends: Uint32Array.from(ends) } : {}), time: Date.parse(entry.occurredAt), length: Math.max(1, Math.min(tokens.length, PASSAGE_WIDTH / 5)) };
      shelf.ids.set(tokens, shelf.filled); if (windows) shelf.ids.set(windows, shelf.filled + tokens.length);
      shelf.filled = needed; shelf.docs[slot] = doc; this.count(doc, 1);
    } else shelf.docs[slot] = null;
    if (!--shelf.pending) { this.unfinished.delete(shelf); this.pack(shelf); }
  }
  private remove(doc: Doc): void { this.count(doc, -1); doc.shelf.wasted += span(doc); }
  /** Gives back what a finished session's id array holds beyond its entries (growth slack, removed entries). */
  private pack(shelf: Shelf): void {
    const live = shelf.filled - shelf.wasted;
    if (!shelf.wasted && shelf.ids.length <= live * 1.25 + 64) return;
    const ids = new Uint32Array(live); let at = 0;
    for (const doc of shelf.docs) if (doc) { const size = span(doc); ids.set(shelf.ids.subarray(doc.at, doc.at + size), at); doc.at = at; at += size; }
    shelf.ids = ids; shelf.filled = live; shelf.wasted = 0;
  }
  /** Forgets every token and tokenizes the archive again (in slices, by sync). */
  private reset(): void {
    this.ids.clear(); this.names.length = 0; this.counts = new Uint32Array(0); this.refs = new Uint32Array(0); this.used = 0; this.byHead.clear();
    this.eligible = 0; this.lengths = 0; this.unfinished.clear();
    for (const shelf of this.shelves.values()) {
      shelf.docs.fill(undefined); shelf.pending = shelf.list.length; shelf.cursor = 0; shelf.eligible = 0; shelf.lengths = 0; shelf.counts = undefined;
      shelf.ids = NO_TOKENS; shelf.filled = 0; shelf.wasted = 0;
      if (shelf.pending) this.unfinished.add(shelf);
    }
  }
  /** Brings the shelves in line with the saved archive. Only entries that are new keep a slot to tokenize. */
  private reconcile(source: RetrievalSource): void {
    this.source = source; this.version++;
    const present = new Set<string>();
    let dropped = false;
    for (const session of source.sessions) {
      const list = source.entries.get(session.id) ?? NO_ENTRIES; let shelf = this.shelves.get(session.id);
      present.add(session.id);
      if (!shelf) {
        if (!list.length) continue;
        shelf = { list, docs: new Array<Doc | null | undefined>(list.length).fill(undefined), pending: list.length, cursor: 0, eligible: 0, lengths: 0, ids: NO_TOKENS, filled: 0, wasted: 0 };
        this.shelves.set(session.id, shelf); this.unfinished.add(shelf);
        continue;
      }
      if (shelf.list === list) continue;
      const old = shelf.list, docs = shelf.docs;
      let appended = old.length <= list.length;
      for (let i = 0; appended && i < old.length; i++) appended = old[i] === list[i];
      if (appended) { // a live session grows at its end
        for (let i = old.length; i < list.length; i++) docs.push(undefined);
        shelf.pending += list.length - old.length;
      } else {
        const kept = new Map<HistoryEntry, Doc | null>();
        docs.forEach((doc, i) => { if (doc !== undefined) kept.set(old[i]!, doc); });
        shelf.docs = list.map(entry => { const doc = kept.get(entry); if (doc !== undefined) kept.delete(entry); return doc; });
        for (const doc of kept.values()) if (doc) { this.remove(doc); dropped = true; }
        shelf.pending = shelf.docs.reduce((n, doc) => n + Number(doc === undefined), 0); shelf.cursor = 0;
      }
      shelf.list = list;
      if (shelf.pending) this.unfinished.add(shelf); else { this.unfinished.delete(shelf); this.pack(shelf); }
    }
    for (const [id, shelf] of this.shelves) {
      if (present.has(id)) continue;
      for (const doc of shelf.docs) if (doc) { this.count(doc, -1); dropped = true; }
      this.shelves.delete(id); this.unfinished.delete(shelf);
    }
    // Deleted sessions leave their words behind: once most of the vocabulary is unused, start again.
    if (dropped && (!this.shelves.size || (this.names.length >= COMPACT_MIN && this.used * 2 < this.names.length))) this.reset();
  }
  /** Tokenizes whatever the archive holds that the index does not. Resumable: after each pause it re-reads the archive. */
  *sync(current: () => RetrievalSource, clock: SliceClock): Generator<void, void> {
    for (;;) {
      if (this.source !== current()) this.reconcile(current());
      const shelf: Shelf | undefined = this.unfinished.values().next().value;
      if (!shelf) return;
      let paused = false;
      while (!paused && shelf.pending) {
        const slot = shelf.cursor, list = shelf.list, docs = shelf.docs;
        if (docs[slot] !== undefined) { shelf.cursor++; continue; }
        const entry = list[slot]!, version = this.version, draft = yield* this.build(entry, clock);
        // A long entry may have paused inside build: only place it when nothing changed meanwhile.
        if (this.version !== version) { paused = true; break; }
        this.place(shelf, slot, draft); shelf.cursor++;
        if (clock()) { yield; paused = true; }
      }
    }
  }
  /** Size of the index, for diagnostics and tests: distinct tokens kept, entries indexed, bytes of token ids. */
  size(): { vocabulary: number; entries: number; bytes: number } {
    let bytes = 0;
    for (const shelf of this.shelves.values()) { bytes += shelf.ids.byteLength; for (const doc of shelf.docs) if (doc?.ends) bytes += doc.ends.byteLength; }
    return { vocabulary: this.names.length, entries: this.eligible, bytes };
  }
  /**
   * Marks every known token that a query term matches and returns their match lists ([query term, weight, ...]
   * in query order; the list of token t is lists[slot[t]] while mark[t] is the returned query number).
   */
  private expand(queryTerms: readonly string[], containing: ReadonlyMap<number, readonly number[]>): { lists: number[][]; query: number } {
    if (this.mark.length < this.names.length) { const size = Math.max(1024, Math.ceil(this.names.length * 1.25)); this.mark = new Uint32Array(size); this.slot = new Uint32Array(size); this.queries = 0; }
    if (this.queries === 0xffffffff) { this.mark.fill(0); this.queries = 0; }
    const query = ++this.queries, mark = this.mark, slot = this.slot, lists: number[][] = [];
    const add = (token: number, term: number, weight: number) => {
      if (mark[token] === query) lists[slot[token]!]!.push(term, weight);
      else { mark[token] = query; slot[token] = lists.length; lists.push([term, weight]); }
    };
    queryTerms.forEach((term, i) => {
      if (CJK_CHAR.test(term)) { for (const token of containing.get(term.codePointAt(0)!) ?? []) add(token, i, 1); return; }
      const exact = this.ids.get(term);
      if (exact !== undefined) add(exact, i, 1);
      if (CJK.test(term) || term.length < PREFIX_MIN) return;
      // Longer tokens that start with the term, then shorter tokens that the term starts with.
      for (const token of this.byHead.get(term.slice(0, PREFIX_MIN)) ?? []) { const name = this.names[token]!, extra = name.length - term.length; if (extra > 0 && extra <= PREFIX_EXTRA && name.startsWith(term)) add(token, i, PREFIX_WEIGHT); }
      for (let length = Math.max(PREFIX_MIN, term.length - PREFIX_EXTRA); length < term.length; length++) {
        const token = this.ids.get(term.slice(0, length));
        if (token !== undefined && !CJK.test(this.names[token]!)) add(token, i, PREFIX_WEIGHT);
      }
    });
    return { lists, query };
  }
  /**
   * The search. Runs to completion when `clock` never fires; otherwise yields between slices and, if the
   * archive, the index or the shared query marks changed while it was paused, starts over so the result
   * is that of one saved state.
   */
  *search(current: () => RetrievalSource, query: string, options: RetrievalOptions, clock: SliceClock, copy: <T>(value: T) => T): Generator<void, RetrievalStats> {
    const limit = bounded(options.limit, 5, 50), maxChars = bounded(options.maxChars, 3000, 20_000);
    const queryTerms = terms(query).slice(0, 400), size = queryTerms.length;
    restart: for (;;) {
      yield* this.sync(current, clock);
      const version = this.version, source = this.source!, excluded = options.excludeSessionId === undefined ? undefined : this.shelves.get(options.excludeSessionId);
      const n = this.eligible - (excluded?.eligible ?? 0);
      const stats: RetrievalStats = { items: [], searchedEntries: n, matched: 0 };
      if (!size || !n) return stats;
      let work = 0;
      // The unindexed search only knew tokens of the entries it searched: a window fragment that occurs
      // nowhere else (or only in the excluded session) matched nothing. Counted once per session, then kept current.
      if (excluded?.eligible && !excluded.counts) {
        const own = new Map<number, number>();
        for (const doc of excluded.docs) {
          if (!doc) continue;
          for (let t = doc.at, stop = t + doc.count, ids = excluded.ids; t < stop; t++) own.set(ids[t]!, (own.get(ids[t]!) ?? 0) + 1);
          if ((work += doc.count) >= SLICE_CHECK_WORK) { work = 0; if (clock()) { yield; if (this.version !== version) continue restart; } }
        }
        excluded.counts = own;
      }
      const counts = this.counts, excludedCounts = excluded?.eligible ? excluded.counts : undefined;
      const known = (token: number): boolean => excludedCounts ? counts[token]! > (excludedCounts.get(token) ?? 0) : counts[token]! > 0;
      const shelves: Shelf[] = [];
      for (const session of source.sessions) { const shelf = this.shelves.get(session.id); if (shelf && shelf !== excluded && shelf.eligible) shelves.push(shelf); }
      // A query term that is a single CJK character matches every token containing it: found by one pass over
      // the vocabulary, only for queries that have such a term (an index of every character cost megabytes).
      const containing = new Map<number, number[]>();
      for (const term of queryTerms) if (CJK_CHAR.test(term)) containing.set(term.codePointAt(0)!, []);
      if (containing.size) {
        const names = this.names;
        for (let id = 0; id < names.length; id++) {
          const name = names[id]!, first = name.codePointAt(0)!;
          if (first >= CJK_FIRST) { // a CJK token is one character or two
            const width = first > 0xffff ? 2 : 1;
            containing.get(first)?.push(id);
            if (name.length > width) { const second = name.codePointAt(width)!; if (second !== first) containing.get(second)?.push(id); }
          }
          if (!(id & 4095) && id && clock()) { yield; if (this.version !== version) continue restart; }
        }
      }
      const { lists, query: mine } = this.expand(queryTerms, containing), mark = this.mark, slot = this.slot;
      const stale = () => this.version !== version || this.queries !== mine || this.mark !== mark;
      // Pass 1: document frequency of each query term, and which entries can score at all.
      const df = new Array<number>(size).fill(0), seenAt = new Int32Array(size).fill(-1), candidates: Doc[] = [];
      let serial = 0; work = 0;
      for (const shelf of shelves) for (const doc of shelf.docs) {
        if (!doc) continue;
        let hit = doc.ends !== undefined; // a long entry can match through a fragment at a window edge
        const tokens = shelf.ids;
        for (let t = doc.at, stop = t + doc.count; t < stop; t++) {
          const token = tokens[t]!;
          if (mark[token] !== mine) continue;
          const matches = lists[slot[token]!]!;
          hit = true;
          for (let j = 0; j < matches.length; j += 2) { const term = matches[j]!; if (seenAt[term] !== serial) { seenAt[term] = serial; df[term]!++; } }
        }
        if (hit) candidates.push(doc);
        serial++;
        if ((work += doc.count + SLICE_CHECK_DOC) >= SLICE_CHECK_WORK) { work = 0; if (clock()) { yield; if (stale()) continue restart; } }
      }
      const idf = df.map(d => Math.log(1 + (n - d + 0.5) / (d + 0.5)));
      const avgdl = (this.lengths - (excluded?.lengths ?? 0)) / n;
      // Per-entry accumulators, in the order a term is first met (the sums below depend on that order).
      const value = new Float64Array(size), metAt = new Int32Array(size).fill(-1), met: number[] = [];
      let round = 0;
      /** Meets the terms of tokens[from, to): per term the highest weight (a passage's worth) or the sum of weights (term frequency). */
      const meet = (tokens: Uint32Array | readonly number[], from: number, to: number, fragments: boolean, sum: boolean): void => {
        met.length = 0; round++;
        for (let t = from; t < to; t++) {
          const token = tokens[t]!;
          if (mark[token] !== mine || (fragments && !known(token))) continue;
          const matches = lists[slot[token]!]!;
          for (let j = 0; j < matches.length; j += 2) {
            const term = matches[j]!, weight = matches[j + 1]!;
            if (metAt[term] !== round) { metAt[term] = round; value[term] = weight; met.push(term); }
            else if (sum) value[term]! += weight; else if (weight > value[term]!) value[term] = weight;
          }
        }
      };
      const passageScore = (tokens: Uint32Array | readonly number[], from: number, to: number): number => {
        meet(tokens, from, to, true, false);
        let score = 0;
        for (const term of met) score += idf[term]! * value[term]!;
        return score;
      };
      // Pass 2: BM25 of each candidate's best passage; only the best `limit` are kept, in final order.
      const before = (a: Candidate, b: Candidate) => (b.score - a.score || b.doc.time - a.doc.time || a.doc.entry.id.localeCompare(b.doc.entry.id) || a.order - b.order) < 0;
      const top: Candidate[] = [];
      let matched = 0; work = 0;
      for (let order = 0; order < candidates.length; order++) {
        if (work >= SLICE_CHECK_WORK) { work = 0; if (clock()) { yield; if (stale()) continue restart; } }
        const doc = candidates[order]!, tokens = doc.shelf.ids, ends = doc.ends;
        let window = 0, len = doc.count;
        if (ends) {
          const base = doc.at + doc.count;
          let best = -1;
          for (let w = 0; w < ends.length; w++) {
            const from = w ? ends[w - 1]! : 0, score = passageScore(tokens, base + from, base + ends[w]!);
            if (score > best) { best = score; window = w; }
            // A document of hundreds of windows is not scored in one slice (the accumulators are only read within one call).
            if ((work += ends[w]! - from) >= SLICE_CHECK_WORK) { work = 0; if (clock()) { yield; if (stale()) continue restart; } }
          }
          const from = window ? ends[window - 1]! : 0;
          len = ends[window]! - from; meet(tokens, base + from, base + ends[window]!, true, true);
        } else meet(tokens, doc.at, doc.at + len, false, true);
        work += len + SLICE_CHECK_DOC;
        if (!met.length) continue;
        len = Math.max(1, len);
        let score = 0;
        for (const term of met) { const f = value[term]!; score += idf[term]! * (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * len / avgdl)); }
        score *= KIND_WEIGHT[doc.entry.kind];
        // One strong rare-term hit is enough; only zero-score entries are dropped.
        if (!(score > 0)) continue;
        matched++;
        if (!limit) continue;
        const timestamp = Math.max(0, doc.time);
        // Small monotonic recency weight resolves equal lexical scores without swamping relevance.
        const candidate: Candidate = { doc, score: score + 0.001 * timestamp / (timestamp + 1e12), window, order };
        if (top.length === limit && !before(candidate, top[limit - 1]!)) continue;
        let at = top.length; while (at > 0 && before(candidate, top[at - 1]!)) at--;
        top.splice(at, 0, candidate); if (top.length > limit) top.pop();
      }
      stats.matched = matched;
      let remaining = maxChars;
      if (!remaining || !limit) return stats;
      const sessions = new Map(source.sessions.map(session => [session.id, session]));
      for (const hit of top) {
        const full = hit.doc.entry.text, width = Math.min(PASSAGE_WIDTH, remaining);
        let text = full;
        if (full.length > width) {
          if (width === PASSAGE_WIDTH) text = full.slice(hit.window * (PASSAGE_WIDTH / 2), hit.window * (PASSAGE_WIDTH / 2) + PASSAGE_WIDTH);
          else {
            // The character budget is nearly used: the best passage of that width, found the slow way for this one entry.
            let best = -1; text = full.slice(0, width); work = 0;
            for (let start = 0; start < full.length; start += Math.max(1, Math.floor(width / 2))) {
              const part = full.slice(start, start + width), tokens: number[] = [];
              for (const token of tokenList(part)) { const id = this.ids.get(token); if (id !== undefined) tokens.push(id); }
              const score = passageScore(tokens, 0, tokens.length);
              if (score > best) { best = score; text = part; }
              if ((work += part.length + SLICE_CHECK_DOC) >= CHUNK_CHARS) { work = 0; if (clock()) { yield; if (stale()) continue restart; } }
            }
          }
        }
        const session = sessions.get(hit.doc.entry.sessionId);
        if (!text || !session) continue;
        stats.items.push({ entry: copy({ ...hit.doc.entry, text }), session: copy(session), score: hit.score } satisfies RetrievedMemory);
        remaining -= text.length;
        if (!remaining || stats.items.length >= limit) break;
      }
      return stats;
    }
  }
}

export const retrievalClock: () => number = typeof performance !== "undefined" && typeof performance.now === "function" ? () => performance.now() : () => Date.now();
const NEVER: SliceClock = () => false;
/** Runs sliced work in one go (callers that cannot wait). */
export function runNow<T>(work: (clock: SliceClock) => Generator<void, T>): T {
  const steps = work(NEVER);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}
/** Why runSliced stopped early: its caller gave up (deadline or abort). */
export class RetrievalCancelled extends Error { constructor() { super("Saved-knowledge search was cancelled."); this.name = "RetrievalCancelled"; } }
/**
 * Runs sliced work, handing the thread back (`pause`) whenever a slice has used `sliceMs`. When `cancelled`
 * turns true the work is dropped at its next pause (or before it starts) and RetrievalCancelled is thrown.
 */
export async function runSliced<T>(work: (clock: SliceClock) => Generator<void, T>, sliceMs: number, pause: () => Promise<void>, onTiming?: (timing: RetrievalTiming) => void, cancelled?: () => boolean): Promise<T> {
  if (cancelled?.()) throw new RetrievalCancelled();
  const began = retrievalClock();
  let started = began, maxSliceMs = 0, slices = 0;
  const steps = work(() => retrievalClock() - started >= sliceMs);
  for (;;) {
    const step = steps.next(), now = retrievalClock();
    slices++; maxSliceMs = Math.max(maxSliceMs, now - started);
    if (step.done) { try { onTiming?.({ totalMs: now - began, maxSliceMs, slices }); } catch { /* diagnostics only */ } return step.value; }
    await pause();
    if (cancelled?.()) throw new RetrievalCancelled();
    started = retrievalClock();
  }
}
/** What yieldToHost needs from its environment (the page's globals; tests pass their own). */
export interface YieldScope {
  setImmediate?: (run: () => void) => unknown;
  MessageChannel?: new () => { port1: { onmessage: ((event: { data: unknown }) => void) | null }; port2: { postMessage(message: unknown): void } };
  setTimeout: (run: () => void, ms: number) => unknown; clearTimeout: (timer: never) => void;
}
/** If a host ever holds port messages back, a yield ends after this long anyway: a search must not wait forever. */
export const YIELD_FALLBACK_MS = 100;
/**
 * A yield that lets everything already queued for the thread run (in the Even app's WebView: microphone
 * and touch events posted by the host), then continues: a macrotask without the 4 ms clamp of nested timers.
 */
export function hostYield(scope: YieldScope): () => Promise<void> {
  if (typeof scope.setImmediate === "function") return () => new Promise(resolve => { scope.setImmediate!(resolve); });
  if (typeof scope.MessageChannel !== "function") return () => new Promise(resolve => { scope.setTimeout(resolve, 0); });
  // Each yield waits for its own message: one that arrives after its yield timed out must not end a later yield early.
  const waiting = new Map<number, () => void>(), channel = new scope.MessageChannel();
  let last = 0;
  channel.port1.onmessage = event => waiting.get(event.data as number)?.();
  return () => new Promise(resolve => {
    const id = ++last, done = () => { waiting.delete(id); scope.clearTimeout(timer as never); resolve(); };
    const timer = scope.setTimeout(done, YIELD_FALLBACK_MS);
    waiting.set(id, done); channel.port2.postMessage(id);
  });
}
let shared: (() => Promise<void>) | undefined;
export function yieldToHost(): Promise<void> { return (shared ??= hostYield(globalThis as unknown as YieldScope))(); }
