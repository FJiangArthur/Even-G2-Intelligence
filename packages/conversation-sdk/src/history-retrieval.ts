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

/** One searchable entry: token ids in text order, and the same per 600-character window when the text is longer. */
interface Doc { readonly entry: HistoryEntry; readonly tokens: readonly number[]; readonly windows?: readonly (readonly number[])[]; readonly time: number; readonly length: number }
/** Index of one session, aligned with its saved entry list. A slot is undefined until tokenized and null when it is not evidence. */
interface Shelf { list: readonly HistoryEntry[]; docs: (Doc | null | undefined)[]; pending: number; cursor: number; eligible: number; lengths: number }
interface Candidate { doc: Doc; score: number; window: number; order: number }

export class RetrievalIndex {
  private readonly ids = new Map<string, number>();
  private readonly names: string[] = [];
  /** Occurrences of each token in indexed evidence (passage-window fragments are known but count 0). */
  private readonly counts: number[] = [];
  /** CJK character -> tokens containing it; "prefix" -> non-CJK tokens that extend it by 1-4 characters. */
  private readonly byChar = new Map<string, number[]>();
  private readonly byPrefix = new Map<string, number[]>();
  private readonly shelves = new Map<string, Shelf>();
  private readonly unfinished = new Set<Shelf>();
  private source?: RetrievalSource;
  private eligible = 0;
  private lengths = 0;
  /** Bumped on every change, so a paused query can tell that it must start over. */
  private version = 0;

  private intern(token: string): number {
    let id = this.ids.get(token);
    if (id !== undefined) return id;
    id = this.names.length; this.ids.set(token, id); this.names.push(token); this.counts.push(0);
    const add = (map: Map<string, number[]>, key: string) => { const list = map.get(key); if (list) list.push(id); else map.set(key, [id]); };
    if (CJK.test(token)) for (const char of new Set(token)) add(this.byChar, char);
    else for (let length = Math.max(PREFIX_MIN, token.length - PREFIX_EXTRA); length < token.length; length++) add(this.byPrefix, token.slice(0, length));
    return id;
  }
  private encode(text: string): number[] { const tokens = tokenList(text), result = new Array<number>(tokens.length); for (let i = 0; i < tokens.length; i++) result[i] = this.intern(tokens[i]!); return result; }
  private *build(entry: HistoryEntry, clock: SliceClock): Generator<void, Doc | null> {
    if (!evidence(entry)) return null;
    const text = entry.text, tokens = this.encode(text);
    let windows: number[][] | undefined;
    if (text.length > PASSAGE_WIDTH) {
      windows = [];
      for (let start = 0; start < text.length; start += PASSAGE_WIDTH / 2) { windows.push(this.encode(text.slice(start, start + PASSAGE_WIDTH))); if (clock()) yield; }
    }
    return { entry, tokens, ...(windows ? { windows } : {}), time: Date.parse(entry.occurredAt), length: Math.max(1, Math.min(tokens.length, PASSAGE_WIDTH / 5)) };
  }
  private place(shelf: Shelf, slot: number, doc: Doc | null): void {
    shelf.docs[slot] = doc; this.version++;
    if (!--shelf.pending) this.unfinished.delete(shelf);
    if (!doc) return;
    for (const token of doc.tokens) this.counts[token]!++;
    shelf.eligible++; shelf.lengths += doc.length; this.eligible++; this.lengths += doc.length;
  }
  private drop(shelf: Shelf, doc: Doc | null | undefined): void {
    if (!doc) return;
    for (const token of doc.tokens) this.counts[token]!--;
    shelf.eligible--; shelf.lengths -= doc.length; this.eligible--; this.lengths -= doc.length;
  }
  /** Brings the shelves in line with the saved archive. Only entries that are new keep a slot to tokenize. */
  private reconcile(source: RetrievalSource): void {
    this.source = source; this.version++;
    const present = new Set<string>();
    for (const session of source.sessions) {
      const list = source.entries.get(session.id) ?? NO_ENTRIES; let shelf = this.shelves.get(session.id);
      present.add(session.id);
      if (!shelf) {
        if (!list.length) continue;
        shelf = { list, docs: new Array<Doc | null | undefined>(list.length).fill(undefined), pending: list.length, cursor: 0, eligible: 0, lengths: 0 };
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
        for (const doc of kept.values()) this.drop(shelf, doc);
        shelf.pending = shelf.docs.reduce((n, doc) => n + Number(doc === undefined), 0); shelf.cursor = 0;
      }
      shelf.list = list;
      if (shelf.pending) this.unfinished.add(shelf); else this.unfinished.delete(shelf);
    }
    for (const [id, shelf] of this.shelves) {
      if (present.has(id)) continue;
      for (const doc of shelf.docs) this.drop(shelf, doc);
      this.shelves.delete(id); this.unfinished.delete(shelf);
    }
    // Nothing left to search: also forget the vocabulary of what was removed.
    if (!this.shelves.size && this.names.length) { this.ids.clear(); this.names.length = 0; this.counts.length = 0; this.byChar.clear(); this.byPrefix.clear(); }
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
        const entry = list[slot]!, version = this.version, doc = yield* this.build(entry, clock);
        // A long entry may have paused inside build: only place it when nothing changed meanwhile.
        if (this.version !== version) { paused = true; break; }
        this.place(shelf, slot, doc); shelf.cursor++;
        if (clock()) { yield; paused = true; }
      }
    }
  }
  /** Token id -> [query term, weight, ...] in query order, for every known token that a query term matches. */
  private expand(queryTerms: readonly string[]): (number[] | undefined)[] {
    const expansion = new Array<number[] | undefined>(this.names.length).fill(undefined);
    const add = (token: number, term: number, weight: number) => { const list = expansion[token]; if (list) list.push(term, weight); else expansion[token] = [term, weight]; };
    queryTerms.forEach((term, i) => {
      if (CJK_CHAR.test(term)) { for (const token of this.byChar.get(term) ?? []) add(token, i, 1); return; }
      const exact = this.ids.get(term);
      if (exact !== undefined) add(exact, i, 1);
      if (CJK.test(term)) return;
      if (term.length >= PREFIX_MIN) for (const token of this.byPrefix.get(term) ?? []) add(token, i, PREFIX_WEIGHT);
      for (let length = Math.max(PREFIX_MIN, term.length - PREFIX_EXTRA); length < term.length; length++) {
        const token = this.ids.get(term.slice(0, length));
        if (token !== undefined && !CJK.test(this.names[token]!)) add(token, i, PREFIX_WEIGHT);
      }
    });
    return expansion;
  }
  /**
   * The search. Runs to completion when `clock` never fires; otherwise yields between slices and, if the
   * archive or the index changed while it was paused, starts over so the result is that of one saved state.
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
      const shelves: Shelf[] = [];
      for (const session of source.sessions) { const shelf = this.shelves.get(session.id); if (shelf && shelf !== excluded && shelf.eligible) shelves.push(shelf); }
      const expansion = this.expand(queryTerms), counts = this.counts;
      // The unindexed search only knew tokens of the entries it searched: a window fragment that occurs
      // nowhere else (or only in the excluded session) matched nothing.
      let excludedCounts: Map<number, number> | undefined;
      const known = (token: number): boolean => {
        const count = counts[token]!;
        if (!count || !excluded) return count > 0;
        if (!excludedCounts) { excludedCounts = new Map(); for (const doc of excluded.docs) if (doc) for (const id of doc.tokens) excludedCounts.set(id, (excludedCounts.get(id) ?? 0) + 1); }
        return count > (excludedCounts.get(token) ?? 0);
      };
      // Pass 1: document frequency of each query term, and which entries can score at all.
      const df = new Array<number>(size).fill(0), seenAt = new Int32Array(size).fill(-1), candidates: Doc[] = [];
      let serial = 0, work = 0;
      for (const shelf of shelves) for (const doc of shelf.docs) {
        if (!doc) continue;
        let hit = doc.windows !== undefined; // a long entry can match through a fragment at a window edge
        for (const token of doc.tokens) {
          const matches = expansion[token];
          if (!matches) continue;
          hit = true;
          for (let j = 0; j < matches.length; j += 2) { const term = matches[j]!; if (seenAt[term] !== serial) { seenAt[term] = serial; df[term]!++; } }
        }
        if (hit) candidates.push(doc);
        serial++;
        if ((work += doc.tokens.length + SLICE_CHECK_DOC) >= SLICE_CHECK_WORK) { work = 0; if (clock()) { yield; if (this.version !== version) continue restart; } }
      }
      const idf = df.map(d => Math.log(1 + (n - d + 0.5) / (d + 0.5)));
      const avgdl = (this.lengths - (excluded?.lengths ?? 0)) / n;
      // Per-entry accumulators, in the order a term is first met (the sums below depend on that order).
      const value = new Float64Array(size), metAt = new Int32Array(size).fill(-1), met: number[] = [];
      let round = 0;
      const windowScore = (tokens: readonly number[], fragments: boolean): number => {
        met.length = 0; round++;
        for (const token of tokens) {
          const matches = expansion[token];
          if (!matches || (fragments && !known(token))) continue;
          for (let j = 0; j < matches.length; j += 2) {
            const term = matches[j]!, weight = matches[j + 1]!;
            if (metAt[term] !== round) { metAt[term] = round; value[term] = weight; met.push(term); } else if (weight > value[term]!) value[term] = weight;
          }
        }
        let score = 0;
        for (const term of met) score += idf[term]! * value[term]!;
        return score;
      };
      // Pass 2: BM25 of each candidate's best passage; only the best `limit` are kept, in final order.
      const before = (a: Candidate, b: Candidate) => (b.score - a.score || b.doc.time - a.doc.time || a.doc.entry.id.localeCompare(b.doc.entry.id) || a.order - b.order) < 0;
      const top: Candidate[] = [];
      let matched = 0; work = 0;
      for (let order = 0; order < candidates.length; order++) {
        if (work >= SLICE_CHECK_WORK) { work = 0; if (clock()) { yield; if (this.version !== version) continue restart; } }
        const doc = candidates[order]!;
        work += (doc.windows ? doc.tokens.length * 3 : doc.tokens.length) + SLICE_CHECK_DOC; // windows overlap by half, and the best one is read twice
        let tokens = doc.tokens, window = 0;
        if (doc.windows) {
          let best = -1;
          for (let w = 0; w < doc.windows.length; w++) { const score = windowScore(doc.windows[w]!, true); if (score > best) { best = score; window = w; } }
          tokens = doc.windows[window]!;
        }
        met.length = 0; round++;
        for (const token of tokens) {
          const matches = expansion[token];
          if (!matches || (doc.windows && !known(token))) continue;
          for (let j = 0; j < matches.length; j += 2) {
            const term = matches[j]!, weight = matches[j + 1]!;
            if (metAt[term] !== round) { metAt[term] = round; value[term] = weight; met.push(term); } else value[term]! += weight;
          }
        }
        if (!met.length) continue;
        const len = Math.max(1, tokens.length);
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
            let best = -1; text = full.slice(0, width);
            for (let start = 0; start < full.length; start += Math.max(1, Math.floor(width / 2))) {
              const part = full.slice(start, start + width), tokens: number[] = [];
              for (const token of tokenList(part)) { const id = this.ids.get(token); if (id !== undefined) tokens.push(id); }
              const score = windowScore(tokens, true);
              if (score > best) { best = score; text = part; }
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

const clockNow: () => number = typeof performance !== "undefined" && typeof performance.now === "function" ? () => performance.now() : () => Date.now();
const NEVER: SliceClock = () => false;
/** Runs sliced work in one go (callers that cannot wait). */
export function runNow<T>(work: (clock: SliceClock) => Generator<void, T>): T {
  const steps = work(NEVER);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}
/** Runs sliced work, handing the thread back (`pause`) whenever a slice has used `sliceMs`. */
export async function runSliced<T>(work: (clock: SliceClock) => Generator<void, T>, sliceMs: number, pause: () => Promise<void>, onTiming?: (timing: RetrievalTiming) => void): Promise<T> {
  const began = clockNow();
  let started = began, maxSliceMs = 0, slices = 0;
  const steps = work(() => clockNow() - started >= sliceMs);
  for (;;) {
    const step = steps.next(), now = clockNow();
    slices++; maxSliceMs = Math.max(maxSliceMs, now - started);
    if (step.done) { try { onTiming?.({ totalMs: now - began, maxSliceMs, slices }); } catch { /* diagnostics only */ } return step.value; }
    await pause();
    started = clockNow();
  }
}
let port: MessagePort | undefined;
const waiting: (() => void)[] = [];
/**
 * Lets everything already queued for the thread run (in the Even app's WebView: microphone and touch
 * events posted by the host), then continues. A macrotask without the 4 ms clamp of nested timers.
 */
export function yieldToHost(): Promise<void> {
  const scope = globalThis as { setImmediate?: (run: () => void) => unknown; MessageChannel?: typeof MessageChannel };
  if (typeof scope.setImmediate === "function") return new Promise(resolve => { scope.setImmediate!(resolve); });
  if (typeof scope.MessageChannel === "function") {
    if (!port) { const channel = new scope.MessageChannel(); channel.port1.onmessage = () => waiting.shift()?.(); port = channel.port2; }
    // The timer is only a way out should a host ever hold port messages back: a search must not wait forever.
    return new Promise(resolve => {
      const timer = setTimeout(() => { const at = waiting.indexOf(done); if (at >= 0) waiting.splice(at, 1); resolve(); }, 250);
      const done = () => { clearTimeout(timer); resolve(); };
      waiting.push(done); port!.postMessage(0);
    });
  }
  return new Promise(resolve => { setTimeout(resolve, 0); });
}
