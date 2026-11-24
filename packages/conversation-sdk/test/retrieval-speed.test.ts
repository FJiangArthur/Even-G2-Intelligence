import { describe, expect, it, vi } from "vitest";
import { YIELD_FALLBACK_MS, hostYield, tokenChunks, tokenList as indexTokens } from "../src/history-retrieval.js";
import { LEGACY_HISTORY_KEY, LocalHistoryStore, type HistoryEntry, type HistorySession, type LocalHistoryOptions, type RetrievalStats, type RetrievedMemory } from "../src/index.js";

/*
 * Saved-knowledge search (LocalHistoryStore.retrieve*) must return exactly what the pre-index
 * implementation returned, without holding the main thread. `oracle` below is that implementation,
 * kept verbatim except for two things that cannot change a result: tokenList is memoized (it is pure)
 * and only the returned matches are deep-copied.
 */

// ---------------------------------------------------------------- oracle (pre-index algorithm)
const STOP_WORDS = new Set("a an the and or but is are was were be been being to of in on at for with from by it its this that these those i you we they he she my your our their do does did can could would should what when where who how please me us about as".split(" "));
const normalize = (value: string) => value.normalize("NFKC").toLowerCase();
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;
const CJK_CHAR = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;
function stemTerm(token: string): string {
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
const tokenMemo = new Map<string, string[]>();
function tokenList(value: string): string[] {
  const known = tokenMemo.get(value); if (known) return known;
  const separated = normalize(value).replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu, " $& ");
  const tokens = separated.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}]+/gu) ?? [];
  const result = tokens.flatMap(token => {
    if (CJK.test(token)) { const chars = [...token]; return chars.length === 1 ? chars : chars.slice(0, -1).map((c, i) => c + chars[i + 1]); }
    return STOP_WORDS.has(token) ? [] : [stemTerm(token)];
  });
  tokenMemo.set(value, result);
  return result;
}
function terms(value: string): string[] { return [...new Set(tokenList(value))]; }
function matchWeight(query: string, token: string): number {
  if (query === token) return 1;
  if (CJK_CHAR.test(query)) return token.includes(query) ? 1 : 0;
  const [short, long] = query.length <= token.length ? [query, token] : [token, query];
  return short.length >= 4 && long.length - short.length <= 4 && long.startsWith(short) && /^[\p{L}\p{N}]+$/u.test(short) && !CJK.test(short) ? 0.7 : 0;
}
const KIND_WEIGHT: Readonly<Record<HistoryEntry["kind"], number>> = { transcript: 1, answer: 0.6, "fact-check": 0.5, question: 0 };
const BM25_K1 = 1.2, BM25_B = 0.75, PASSAGE_WIDTH = 600;
function bounded(value: number | undefined, fallback: number, max: number): number {
  return value === undefined ? fallback : Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : fallback;
}
interface Snapshot { sessions: HistorySession[]; entries: HistoryEntry[] }
type Options = { excludeSessionId?: string; limit?: number; maxChars?: number };
function oracle(snapshot: Snapshot, query: string, options: Options = {}): RetrievalStats {
  const limit = bounded(options.limit, 5, 50);
  let remaining = bounded(options.maxChars, 3000, 20_000);
  const sessions = new Map(snapshot.sessions.map(s => [s.id, s]));
  // v0.16: an imported session's summary, key facts and concepts are searched as records of that session.
  const knowledge = snapshot.sessions.filter(session => session.source !== "helix").flatMap(session => ([["summary", "Summary"], ["keyFacts", "Key facts"], ["concepts", "Concepts"]] as const).flatMap(([key, speaker]): HistoryEntry[] => {
    const text = (session[key] ?? []).join("\n");
    return text ? [{ id: `${session.id}:knowledge:${key}`, sessionId: session.id, kind: "transcript", text, occurredAt: session.startedAt, speaker, metadata: { origin: "session-summary" } }] : [];
  }));
  const eligible = [...snapshot.entries, ...knowledge].filter(entry => entry.sessionId !== options.excludeSessionId && sessions.has(entry.sessionId) && KIND_WEIGHT[entry.kind] > 0
    && !(entry.kind === "transcript" && /^(assistant|ai|system|omi summary)$/i.test(entry.speaker?.trim() ?? ""))
    && entry.metadata?.origin !== "omi-summary" && !/^omi summary$/i.test(entry.speaker?.trim() ?? ""));
  const stats: RetrievalStats = { items: [], searchedEntries: eligible.length, matched: 0 };
  const queryTerms = terms(query).slice(0, 400);
  if (!queryTerms.length || !eligible.length) return stats;
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
    if (!(score > 0)) continue;
    const timestamp = Math.max(0, Date.parse(entry.occurredAt));
    scored.push({ entry, session: sessions.get(entry.sessionId)!, score: score + 0.001 * timestamp / (timestamp + 1e12) });
  }
  stats.matched = scored.length;
  scored.sort((a, b) => b.score - a.score || Date.parse(b.entry.occurredAt) - Date.parse(a.entry.occurredAt) || a.entry.id.localeCompare(b.entry.id));
  if (!remaining || !limit) return stats;
  for (const found of scored) {
    const hit: RetrievedMemory = { entry: structuredClone(found.entry), session: structuredClone(found.session), score: found.score };
    const width = Math.min(PASSAGE_WIDTH, remaining);
    const selected = passageOf(hit.entry, width);
    if (!selected.text) continue;
    hit.entry.text = selected.text; remaining -= selected.text.length; stats.items.push(hit);
    if (!remaining || stats.items.length >= limit) break;
  }
  return stats;
}

// ---------------------------------------------------------------- synthetic archive
function random(seed: number): () => number {
  return () => { seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const COMMON = ("think know going really actually need want time people work project meeting budget schedule release customer vendor order shipping delivery lead times weeks months quarter price pricing contract review reviewed reviewing "
  + "design designs designed testing tested tests camera cameras sensor sensors calibration calibrated model models training trained inference latency memory compute hardware boards board jetson jetsons orin modules module "
  + "the a of and to in is it that was for on with as what when where who how please about should would could not just like have there more some very good great okay right yes no maybe "
  + "perception planning control robot robots robotics dataset datasets labels labeling approve approved approval finance legal marketing launch launched launching october friday thursday tomorrow yesterday "
  + "classes glasses boxes churches matches wishes status analysis business address policies policy companies company studies study parties party").split(" ");
const SYLLABLES = "ka lo mi ren sto ver dal qui ton bra fen gul hap jor kel lum nar ost pri rud sil tav urn vex wim yar zed chi sha tho phe".split(" ");
const FIXED = ["We should order the Jetson boards this week.", "The lead time for Orin modules is about twelve weeks right now.", "发布计划改到十月。", "预算给了六万元，下周确认。", "October发布计划改到十月", "カメラの較正は木曜日です。", "회의는 금요일에 합니다."];
const KANA = "あいうえおかきくけこさしすせそカメラテストデータ", HANGUL = "회의금요일예산출시카메라모델";
function makeText(rand: () => number) {
  const invented: string[] = [];
  for (let i = 0; i < 4000; i++) {
    let word = ""; const parts = 2 + Math.floor(rand() * 3);
    for (let p = 0; p < parts; p++) word += SYLLABLES[Math.floor(rand() * SYLLABLES.length)];
    invented.push(word);
  }
  const skew = (n: number, power = 3) => Math.floor(n * rand() ** power);
  const han = (count: number) => { let text = ""; for (let i = 0; i < count; i++) text += String.fromCodePoint(0x4e00 + (skew(2500) * 37) % 5000); return text; };
  const word = (): string => {
    const r = rand();
    if (r < 0.55) return COMMON[skew(COMMON.length, 1.5)]!;
    const base = invented[skew(invented.length)]!, form = rand();
    if (r > 0.97) return `${Math.floor(rand() * 5000)}${rand() < 0.3 ? base.slice(0, 2).toUpperCase() : ""}`;
    return form < 0.6 ? base : form < 0.75 ? `${base}s` : form < 0.85 ? `${base}ing` : form < 0.93 ? `${base}ed` : `${base}${SYLLABLES[Math.floor(rand() * SYLLABLES.length)]}`;
  };
  const sentence = (): string => {
    const r = rand();
    if (r < 0.03) return FIXED[Math.floor(rand() * FIXED.length)]!;
    if (r < 0.26) { let text = ""; for (let parts = 1 + Math.floor(rand() * 3); parts > 0; parts--) text += han(1 + Math.floor(rand() * 14)) + (parts > 1 ? "，" : "。"); return text; }
    if (r < 0.28) return `${[...KANA].sort(() => rand() - 0.5).slice(0, 3 + Math.floor(rand() * 8)).join("")}。`;
    if (r < 0.30) return `${[...HANGUL].sort(() => rand() - 0.5).slice(0, 2 + Math.floor(rand() * 6)).join("")} ${word()}.`;
    const words: string[] = [];
    for (let count = 4 + Math.floor(rand() * 18); count > 0; count--) words.push(rand() < 0.04 ? han(1 + Math.floor(rand() * 4)) : word());
    const text = words.join(" ");
    return `${text[0]!.toUpperCase()}${text.slice(1)}${rand() < 0.2 ? "?" : "."}`;
  };
  const passage = (chars: number): string => { let text = sentence(); while (text.length < chars) text += ` ${sentence()}`; return text; };
  return { word, sentence, passage, han };
}
const SPEAKERS = ["You", "Other speaker", "Speaker 2", "Elaine", undefined, "Assistant", "AI", " omi summary ", "System"] as const;
function makeEntry(rand: () => number, text: ReturnType<typeof makeText>, id: string, sessionId: string, at: number): HistoryEntry {
  const r = rand(), kind: HistoryEntry["kind"] = r < 0.8 ? "transcript" : r < 0.9 ? "answer" : r < 0.95 ? "question" : "fact-check";
  const size = rand(), body = size < 0.975 ? text.passage(15 + Math.floor(rand() * 110)) : size < 0.993 ? text.passage(601 + Math.floor(rand() * 1800)) : size < 0.9995 ? text.passage(Math.floor(550 + rand() * 100)) : text.passage(8000 + Math.floor(rand() * 12_000));
  const speaker = kind === "transcript" ? SPEAKERS[rand() < 0.94 ? Math.floor(rand() * 5) : 5 + Math.floor(rand() * 4)] : undefined;
  const metadata = kind === "answer" ? { model: "gpt-6.1-terra", provider: "openai" } : rand() < 0.01 ? { origin: "omi-summary" } : undefined;
  return { id, sessionId, kind, text: body, occurredAt: new Date(at).toISOString(), ...(speaker ? { speaker } : {}), ...(metadata ? { metadata } : {}) };
}
const encoder = new TextEncoder(), utf8 = (value: string) => encoder.encode(value).length;
/** A v1 snapshot of about `bytes` of JSON: many sessions of mixed English and CJK speech, answers, long documents. */
function makeArchive(bytes: number, seed = 7): Snapshot & { rand: () => number; text: ReturnType<typeof makeText> } {
  const rand = random(seed), text = makeText(rand), sessions: HistorySession[] = [], entries: HistoryEntry[] = [];
  for (let s = 0, used = 60; used < bytes; s++) {
    const id = `session_seed_${s}`, start = Date.UTC(2026, 0, 1) + s * 3_600_000 * 7, source = s % 9 === 0 ? "omi" as const : s % 13 === 0 ? "obsidian" as const : "helix" as const;
    const session: HistorySession = { id, source, title: text.passage(20).slice(0, 60), startedAt: new Date(start).toISOString(), updatedAt: new Date(start + 3_600_000).toISOString(), ...(s % 3 ? {} : { summary: [text.sentence()], people: [{ name: "Elaine", role: "calibration" }] }) };
    sessions.push(session); used += utf8(JSON.stringify(session)) + 1;
    for (let i = 0, count = 10 + Math.floor(rand() * 110); i < count && used < bytes; i++) {
      // Every few entries share a timestamp so equal scores fall through to the id order.
      const entry = makeEntry(rand, text, `${id}:e${i}`, id, start + Math.floor(i / 3) * 9000);
      entries.push(entry); used += utf8(JSON.stringify(entry)) + 1;
    }
  }
  return { sessions, entries, rand, text };
}
function makeQuery(rand: () => number, text: ReturnType<typeof makeText>, entries: readonly HistoryEntry[]): string {
  const r = rand(), sample = () => entries[Math.floor(rand() * entries.length)]?.text ?? text.sentence();
  if (r < 0.03) return ["", "the of and", "?!", "   "][Math.floor(rand() * 4)]!;
  if (r < 0.12) return text.han(1);                                            // single CJK character
  if (r < 0.22) return text.han(2 + Math.floor(rand() * 6));
  if (r < 0.32) { const word = text.word(); return word.slice(0, Math.max(1, word.length - Math.floor(rand() * 5))) + (rand() < 0.5 ? "ing" : ""); } // prefixes and suffixes
  if (r < 0.55) return `${text.sentence()} ${text.word()} ${text.word()}`;
  if (r < 0.70) { const from = sample(), at = Math.floor(rand() * from.length); return from.slice(at, at + 20 + Math.floor(rand() * 200)); } // cut mid-word, like a passage window
  // The live answer path: the question plus the last 2000 characters of transcript.
  return `${text.sentence().slice(0, 2000)}\n${text.passage(1200 + Math.floor(rand() * 1500)).slice(-2000)}`;
}
function makeOptions(rand: () => number, sessions: readonly HistorySession[]): Options {
  const r = rand(), options: Options = {};
  if (r < 0.6) options.excludeSessionId = rand() < 0.1 || !sessions.length ? "session_missing" : sessions[Math.floor(rand() * sessions.length)]!.id;
  if (rand() < 0.3) options.limit = [0, 1, 3, 12, 50, 80, Number.NaN][Math.floor(rand() * 7)]!;
  if (rand() < 0.35) options.maxChars = [0, 1, 37, 250, 601, 1500, 9000, 20_000][Math.floor(rand() * 8)]!;
  return options;
}
function memoryDisk(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { getLocalStorage: async (key: string) => values.get(key) ?? "", setLocalStorage: async (key: string, value: string) => { values.set(key, value); return true; } };
}
async function storeOf(snapshot: Snapshot, options: LocalHistoryOptions = {}): Promise<LocalHistoryStore> {
  const store = new LocalHistoryStore(memoryDisk({ [LEGACY_HISTORY_KEY]: JSON.stringify({ version: 1, sessions: snapshot.sessions, entries: snapshot.entries }) }), options);
  await store.load(); await store.flush();
  return store;
}
/** The store's saved state in storage order, which is what the search runs over. */
const saved = (store: LocalHistoryStore): Snapshot => JSON.parse(store.exportJson()) as Snapshot;
const MIB = 1024 * 1024;
/** Records how long the search holds the thread between two yields. */
function sliceRecorder() {
  const slices: number[] = []; let resumed = performance.now();
  return { slices, reset: () => { slices.length = 0; resumed = performance.now(); },
    yield: async () => { slices.push(performance.now() - resumed); await new Promise<void>(resolve => setImmediate(resolve)); resumed = performance.now(); } };
}

describe("saved-knowledge search index", () => {
  it("returns exactly what the unindexed search returned on random queries, with and without mutations in between", async () => {
    const archive = makeArchive(0.7 * MIB), store = await storeOf(archive), { rand, text } = archive;
    let snapshot = saved(store), queries = 0, withItems = 0, cut = 0;
    const check = async (count: number) => {
      for (let i = 0; i < count; i++) {
        const query = makeQuery(rand, text, snapshot.entries), options = makeOptions(rand, snapshot.sessions), expected = oracle(snapshot, query, options);
        expect(store.retrieveWithStats(query, options)).toEqual(expected);
        expect(store.retrieve(query, options)).toEqual(expected.items);
        if (i % 3 === 0) expect(await store.retrieveAsync(query, options)).toEqual(expected);
        // Byte-identical, key order included.
        expect(JSON.stringify(store.retrieveWithStats(query, options))).toBe(JSON.stringify(expected));
        queries++; withItems += Number(expected.items.length > 0); cut += Number(expected.items.some(item => item.entry.text.length === PASSAGE_WIDTH));
      }
    };
    await check(260);
    // Every way the archive changes, each followed by more random queries.
    const live: HistorySession = { id: "session_live", source: "helix", title: "Live", startedAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-01T10:00:00.000Z" };
    const steps: (() => Promise<void>)[] = [
      async () => { await store.upsertSession(live); await store.upsertEntries(Array.from({ length: 40 }, (_, i) => makeEntry(rand, text, `live:${i}`, live.id, Date.UTC(2026, 9, 1, 10, 0, i)))); },
      async () => { await store.upsertEntries([makeEntry(rand, text, "live:40", live.id, Date.UTC(2026, 9, 1, 10, 1))]); },                             // append
      async () => { await store.upsertEntries([{ ...makeEntry(rand, text, "live:3", live.id, Date.UTC(2026, 9, 1, 10, 0, 3)), kind: "transcript", speaker: "You" }]); }, // revise in place
      async () => { await store.upsertEntries([{ ...snapshot.entries[5]!, sessionId: live.id }]); },                                                       // an id moves between sessions
      async () => { await store.deleteSession(snapshot.sessions[3]!.id); },
      async () => { await store.deleteSessions(snapshot.sessions.slice(10, 14).map(s => s.id)); },
      async () => { await store.mergeSession(snapshot.sessions[7]!.id, snapshot.sessions[2]!.id); },                                                       // resume: coalesce
      async () => { const id = "pdf:doc"; await store.replaceSession({ ...live, id, title: "Document", source: "helix" }, Array.from({ length: 30 }, (_, i) => ({ ...makeEntry(rand, text, `${id}:${i}`, id, Date.UTC(2026, 9, 2)), kind: "transcript" as const, text: text.passage(1200), metadata: { origin: "pdf-local", section: `Page ${i + 1}` } }))); },
      async () => { const id = "pdf:doc"; await store.replaceSession({ ...live, id, title: "Document v2", source: "helix" }, Array.from({ length: 12 }, (_, i) => ({ ...makeEntry(rand, text, `${id}:${i}`, id, Date.UTC(2026, 9, 3)), kind: "transcript" as const, text: text.passage(900) }))); },
      async () => { await store.updateSessionNotebook(live.id, { todos: [{ id: "t1", text: "Order the Jetson boards", done: false, createdAt: live.startedAt, updatedAt: live.startedAt }] }); },
      async () => { await store.updateSessionKnowledge(snapshot.sessions[0]!.id, { summary: ["Orin lead time is twelve weeks."], tags: ["hardware"] }); await store.updateSessionRecap(snapshot.sessions[1]!.id, { title: "Vendor call", overview: "Lead times." }); },
      async () => { await store.upsertSession({ ...snapshot.sessions[4]!, title: "Renamed session", updatedAt: "2026-11-01T00:00:00.000Z" }); },
      async () => { store.writeDelayMs = 50; const writes = Array.from({ length: 6 }, (_, i) => store.upsertEntries([makeEntry(rand, text, `live:late${i}`, live.id, Date.UTC(2026, 9, 1, 11, 0, i))])); await store.flush(); await Promise.all(writes); store.writeDelayMs = 0; },
      async () => { await store.deleteSessions(snapshot.sessions.map(s => s.id)); },                                                                       // everything removed
      async () => { await store.upsertSession(live); await store.upsertEntries([makeEntry(rand, text, "again:1", live.id, Date.UTC(2026, 9, 5))]); },
    ];
    for (const step of steps) { await step(); snapshot = saved(store); await check(14); }
    expect(queries).toBeGreaterThanOrEqual(400);
    expect(withItems).toBeGreaterThan(200); expect(cut).toBeGreaterThan(20);
  }, 240_000);

  it("sees each kind of change at once and forgets what was removed", async () => {
    const store = new LocalHistoryStore(memoryDisk());
    const session = (id: string, extra: Partial<HistorySession> = {}): HistorySession => ({ id, source: "helix", title: id, startedAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", ...extra });
    const entry = (id: string, sessionId: string, body: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({ id, sessionId, kind: "transcript", text: body, occurredAt: "2026-09-01T00:00:00.000Z", ...extra });
    const ids = async (query: string, options: Options = {}) => {
      const sync = store.retrieveWithStats(query, options), later = await store.retrieveAsync(query, options);
      expect(later).toEqual(sync); expect(sync).toEqual(oracle(saved(store), query, options));
      return sync.items.map(item => item.entry.id).sort();
    };
    await store.load();
    expect(await ids("zeppelin")).toEqual([]);
    await store.upsertSession(session("a")); await store.upsertEntries([entry("a1", "a", "The zeppelin invoice is overdue."), entry("a2", "a", "Nothing relevant here.")]);
    expect(await ids("zeppelin")).toEqual(["a1"]);
    await store.upsertEntries([entry("a3", "a", "A second zeppelin order arrived.")]);                       // append
    expect(await ids("zeppelin")).toEqual(["a1", "a3"]);
    await store.upsertEntries([entry("a1", "a", "The airship invoice is overdue.")]);                         // text replaced
    expect(await ids("zeppelin")).toEqual(["a3"]); expect(await ids("airship")).toEqual(["a1"]);
    await store.upsertEntries([entry("a3", "a", "A second zeppelin order arrived.", { speaker: "Assistant" })]); // no longer evidence
    expect(await ids("zeppelin")).toEqual([]);
    await store.upsertSession(session("b")); await store.upsertEntries([entry("b1", "b", "Zeppelins need hangars."), entry("a2", "b", "Moved zeppelin note.")]); // a2 moves to b
    expect(await ids("zeppelin")).toEqual(["a2", "b1"]); expect(await ids("zeppelin", { excludeSessionId: "b" })).toEqual([]);
    expect(store.retrieveWithStats("zeppelin").items.find(item => item.entry.id === "a2")!.session.id).toBe("b");
    await store.upsertSession(session("b", { title: "Hangar planning" }));                                    // session fields are read fresh
    expect(store.retrieveWithStats("zeppelin").items[0]!.session.title).toBe("Hangar planning");
    await store.upsertSession(session("c", { continues: "b" })); await store.upsertEntries([entry("c1", "c", "The zeppelin hangar is booked.")]);
    await store.mergeSession("c", "b");                                                                       // resume: c folds into b
    expect(await ids("zeppelin")).toEqual(["a2", "b1", "c1"]); expect(await ids("zeppelin", { excludeSessionId: "b" })).toEqual([]);
    await store.replaceSession(session("pdf:x", { title: "Manual" }), [entry("p1", "pdf:x", "Zeppelin manual page one."), entry("p2", "pdf:x", "Maintenance page.")]);
    expect(await ids("zeppelin manual")).toContain("p1");
    await store.replaceSession(session("pdf:x", { title: "Manual" }), [entry("p9", "pdf:x", "Rewritten maintenance page.")]); // PDF imported again
    expect(await ids("zeppelin manual")).not.toContain("p1"); expect(await ids("rewritten")).toEqual(["p9"]);
    await store.updateSessionNotebook("b", { notes: [{ id: "n1", text: "zeppelin budget", createdAt: "2026-09-01T00:00:00.000Z" }] }); // notebooks are not searched
    expect(await ids("budget")).toEqual([]);
    await store.deleteSession("b");
    expect(await ids("zeppelin")).toEqual([]); expect(store.retrieveWithStats("airship").searchedEntries).toBe(2);
    await store.deleteSessions(["a", "pdf:x"]);
    expect(store.retrieveWithStats("airship")).toEqual({ items: [], searchedEntries: 0, matched: 0 });
    // A word cut by a 600-character passage window ("zeppe|linxyz") only counts while that fragment is a word of the searched entries.
    await store.upsertSession(session("long")); await store.upsertSession(session("word"));
    await store.upsertEntries([entry("l1", "long", `${"plain filler ".repeat(46).slice(0, 594)} zeppelinxyz ${"more filler ".repeat(20)}`), entry("w1", "word", "zeppe")]);
    expect(await ids("zeppe")).toEqual(["l1", "w1"]); expect(await ids("zeppe", { excludeSessionId: "word" })).toEqual([]);
    // The excluded session's own words are counted once and then follow its changes: it loses the word, another session gains it.
    await store.upsertSession(session("third")); await store.upsertEntries([entry("w1", "word", "nothing here"), entry("t1", "third", "zeppe")]);
    expect(await ids("zeppe", { excludeSessionId: "word" })).toEqual(["l1", "t1"]);
    await store.upsertEntries([entry("w2", "word", "zeppe")]); await store.deleteSession("third");
    expect(await ids("zeppe", { excludeSessionId: "word" })).toEqual([]); expect(await ids("zeppe")).toEqual(["l1", "w2"]);
    await store.deleteSession("word");
    expect(await ids("zeppe")).toEqual([]);
    await store.deleteSession("long");
    // A new store over the same storage (page reload) and a failed save: the search follows what is saved.
    const disk = memoryDisk(), first = new LocalHistoryStore(disk);
    await first.upsertSession(session("a")); await first.upsertEntries([entry("a1", "a", "The zeppelin invoice is overdue.")]);
    const second = new LocalHistoryStore(disk);
    expect(second.retrieveWithStats("zeppelin").searchedEntries).toBe(0);                                     // not loaded yet
    await second.load();
    expect((await second.retrieveAsync("zeppelin")).items.map(item => item.entry.id)).toEqual(["a1"]);
    disk.setLocalStorage = async () => false;
    await expect(second.upsertEntries([entry("a2", "a", "Unsaved zeppelin line.")])).rejects.toThrow();
    expect((await second.retrieveAsync("zeppelin")).items.map(item => item.entry.id)).toEqual(["a1"]);
    // Returned records are copies.
    const hit = second.retrieveWithStats("zeppelin").items[0]!; hit.entry.text = "changed"; hit.session.title = "changed";
    expect(second.retrieveWithStats("zeppelin").items[0]).toMatchObject({ entry: { text: "The zeppelin invoice is overdue." }, session: { title: "a" } });
  });

  it("builds a near-5 MiB archive's index in short slices and answers warm queries quickly", async () => {
    const archive = makeArchive(4.8 * MIB, 11), recorder = sliceRecorder();
    const store = await storeOf(archive, { retrievalYield: recorder.yield }), { rand, text } = archive, snapshot = saved(store);
    const live = () => `${text.sentence()}\n${text.passage(2600).slice(-2000)}`;
    // Cold: the build is cut into slices; the page is never held for long.
    recorder.reset();
    let timing: { totalMs: number; maxSliceMs: number; slices: number } | undefined;
    await store.warmRetrieval(report => { timing = report; });
    const buildSlices = [...recorder.slices].sort((a, b) => a - b);
    expect(buildSlices.length).toBeGreaterThan(10);
    expect(timing!.slices).toBe(recorder.slices.length + 1);
    expect(buildSlices[Math.floor(buildSlices.length / 2)]!).toBeLessThan(15);   // budget is 5 ms; thresholds leave room for a busy CI machine
    expect(buildSlices[buildSlices.length - 1]!).toBeLessThan(120);
    expect(timing!.maxSliceMs).toBeLessThan(120);
    // Warm: a live-shaped query (question + 2000 characters of transcript) over the whole archive.
    const warm: number[] = [], sliceMax: number[] = [];
    for (let i = 0; i < 12; i++) {
      const query = live(), options = { excludeSessionId: snapshot.sessions[i]!.id };
      recorder.reset();
      const began = performance.now(), result = await store.retrieveAsync(query, { ...options, onTiming: report => sliceMax.push(report.maxSliceMs) });
      warm.push(performance.now() - began);
      if (i < 3) expect(result).toEqual(oracle(snapshot, query, options));
      expect(result.searchedEntries).toBeGreaterThan(10_000);
    }
    warm.sort((a, b) => a - b); sliceMax.sort((a, b) => a - b);
    expect(warm[Math.floor(warm.length / 2)]!).toBeLessThan(250);                // was 300-1200 ms of one blocked task
    expect(sliceMax[Math.floor(sliceMax.length / 2)]!).toBeLessThan(25);
    expect(sliceMax[sliceMax.length - 1]!).toBeLessThan(120);
    // The synchronous form stays available and no longer re-reads the archive.
    const began = performance.now(); for (let i = 0; i < 5; i++) store.retrieveWithStats(live());
    expect((performance.now() - began) / 5).toBeLessThan(250);
    if (process.env.HELIX_BENCH) console.info(`[bench] entries ${snapshot.entries.length} sessions ${snapshot.sessions.length} · build ${timing!.totalMs.toFixed(0)} ms in ${timing!.slices} slices (median ${buildSlices[Math.floor(buildSlices.length / 2)]!.toFixed(1)} ms, max ${buildSlices[buildSlices.length - 1]!.toFixed(1)} ms) · warm async median ${warm[Math.floor(warm.length / 2)]!.toFixed(1)} ms max ${warm[warm.length - 1]!.toFixed(1)} ms · query slice median ${sliceMax[Math.floor(sliceMax.length / 2)]!.toFixed(1)} ms max ${sliceMax[sliceMax.length - 1]!.toFixed(1)} ms · sync ${((performance.now() - began) / 5).toFixed(1)} ms`);
  }, 240_000);

  it("answers a query that arrives while the index is cold or still warming, and during changes", async () => {
    const archive = makeArchive(1.5 * MIB, 23), recorder = sliceRecorder();
    const store = await storeOf(archive, { retrievalYield: recorder.yield, retrievalSliceMs: 2 }), { rand, text } = archive, snapshot = saved(store);
    const queries = Array.from({ length: 4 }, () => makeQuery(random(5), text, snapshot.entries) + ` ${text.sentence()}`);
    // Cold: nothing built yet; three queries and a warm-up are in flight together.
    recorder.reset();
    const warming = store.warmRetrieval(), pending = queries.slice(0, 3).map(query => store.retrieveAsync(query, { excludeSessionId: snapshot.sessions[1]!.id }));
    let settled = false; void pending[0]!.then(() => { settled = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);                                                // it waits for the sliced build; it does not block for it
    const results = await Promise.all(pending); await warming;
    expect(recorder.slices.length).toBeGreaterThan(5);
    results.forEach((result, i) => expect(result).toEqual(oracle(snapshot, queries[i]!, { excludeSessionId: snapshot.sessions[1]!.id })));
    // A synchronous query in the middle of a sliced build completes the build itself and is still right.
    const second = await storeOf(archive, { retrievalYield: recorder.yield, retrievalSliceMs: 2 });
    const building = second.warmRetrieval(), racing = second.retrieveAsync(queries[3]!);
    await new Promise<void>(resolve => setImmediate(resolve)); await new Promise<void>(resolve => setImmediate(resolve));
    expect(second.retrieveWithStats(queries[0]!)).toEqual(oracle(snapshot, queries[0]!));
    expect(await racing).toEqual(oracle(snapshot, queries[3]!)); await building;
    // Changes saved while a sliced query runs: the answer is that of one saved state, never a mix of two.
    const third = await storeOf(archive, { retrievalYield: recorder.yield, retrievalSliceMs: 1 });
    const query = `${text.passage(1500)} zeppelin`, states = [saved(third)];
    const racingQuery = third.retrieveAsync(query);
    const changes = [() => third.deleteSession(states[0]!.sessions[0]!.id), () => third.upsertSession({ id: "late", source: "helix", title: "Late", startedAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }),
      () => third.upsertEntries([{ id: "late:1", sessionId: "late", kind: "transcript", text: "The zeppelin hangar is booked for October.", occurredAt: "2026-10-01T00:00:00.000Z" }])];
    const changing = (async () => { for (const change of changes) { await change(); states.push(saved(third)); } })();
    const raced = await racingQuery; await changing;
    expect(states.map(state => JSON.stringify(oracle(state, query)))).toContain(JSON.stringify(raced));
    expect(await third.retrieveAsync(query)).toEqual(oracle(states[3]!, query));
  }, 240_000);

  it("gives the result of one saved state whatever happens at any pause of a sliced search", async () => {
    const big = makeArchive(0.3 * MIB, 31), { text, rand } = big;
    // Long entries only: most pauses fall inside the tokenizing of one entry.
    const small: Snapshot = { sessions: big.sessions.slice(0, 3), entries: big.sessions.slice(0, 3).flatMap(session => Array.from({ length: 3 }, (_, i) => ({ ...makeEntry(rand, text, `${session.id}:long${i}`, session.id, Date.UTC(2026, 5, 1, 0, i)), kind: "transcript" as const, speaker: "You", text: text.passage(1500 + i * 900) }))) };
    const query = `${text.passage(900)} zeppelin`, other = text.sentence();
    // At pause k of a search: a synchronous search (k % 3 = 0), a saved change (1), or a saved change and then a synchronous search (2).
    const run = async (archive: Snapshot, k: number, warm: boolean): Promise<number> => {
      const excludeSessionId = archive.sessions[1]!.id, states: Snapshot[] = [];
      let pauses = 0, armed = !warm;
      const store: LocalHistoryStore = await storeOf(archive, { retrievalSliceMs: 0, retrievalYield: async () => {
        if (!armed || ++pauses !== k) return;
        if (k % 3) {
          await store.deleteSession(archive.sessions[0]!.id);
          await store.upsertEntries([{ id: `late:${k}`, sessionId: archive.sessions[2]!.id, kind: "transcript", text: `The zeppelin hangar is booked. ${text.passage(700)}`, occurredAt: "2026-10-01T00:00:00.000Z" }]);
          states.push(saved(store));
        }
        if (k % 3 !== 1) expect(store.retrieveWithStats(other)).toEqual(oracle(states[states.length - 1]!, other));
      } });
      states.push(saved(store));
      if (warm) { await store.warmRetrieval(); armed = true; }
      const result = await store.retrieveAsync(query, { excludeSessionId });
      armed = false;
      expect(states.map(state => JSON.stringify(oracle(state, query, { excludeSessionId })))).toContain(JSON.stringify(result));
      expect(await store.retrieveAsync(query)).toEqual(oracle(states[states.length - 1]!, query));
      expect(store.retrieveWithStats(other, { excludeSessionId })).toEqual(oracle(states[states.length - 1]!, other, { excludeSessionId }));
      return pauses;
    };
    const cold = await run(big, 0, false), warm = await run(big, 0, true), long = await run(small, 0, false);
    expect(cold).toBeGreaterThan(100); expect(warm).toBeGreaterThan(5); expect(long).toBeGreaterThan(40);
    for (let k = 1; k <= cold; k += 41) await run(big, k, false);
    for (let k = 1; k <= warm; k++) await run(big, k, true);
    for (let k = 1; k <= long; k++) await run(small, k, false);
  }, 240_000);

  it("gives up at its deadline or on abort without holding later searches, and never searches in one go instead", async () => {
    const archive = makeArchive(0.3 * MIB, 41), { text } = archive, query = `${text.sentence()} ${text.passage(600)}`;
    // A page that gets no time: every yield waits until the test lets it go.
    const parked: (() => void)[] = []; let starved = true, pauses = 0;
    const store = await storeOf(archive, { retrievalSliceMs: 0, retrievalYield: () => { pauses++; return starved ? new Promise<void>(resolve => { parked.push(resolve); }) : Promise.resolve(); } });
    const snapshot = saved(store), blocking = vi.spyOn(store, "retrieveWithStats"), finished: unknown[] = [];
    const began = performance.now();
    expect(await store.retrieveAsync(query, { deadlineMs: 40, onTiming: timing => finished.push(timing) })).toEqual({ items: [], searchedEntries: 0, matched: 0, timedOut: true });
    expect(performance.now() - began).toBeLessThan(2000);
    expect(blocking).not.toHaveBeenCalled(); expect(pauses).toBe(1);
    // Searches behind the abandoned one: each settles by its own deadline or abort, and none of them starts work.
    expect((await store.retrieveAsync(query, { deadlineMs: 20, excludeSessionId: snapshot.sessions[0]!.id })).timedOut).toBe(true);
    const answer = new AbortController(), aborted = store.retrieveAsync(query, { signal: answer.signal, deadlineMs: 60_000 });
    answer.abort(new Error("answer cancelled"));
    await expect(aborted).rejects.toThrow("answer cancelled");
    await expect(store.retrieveAsync(query, { signal: answer.signal })).rejects.toThrow("answer cancelled"); // already aborted
    expect(pauses).toBe(1);
    // The page gets time again: the abandoned search stops at once, the index build it had started goes on
    // (queued by the timeout), and the next question is answered from the whole archive.
    starved = false; parked.splice(0).forEach(resume => resume());
    await store.warmRetrieval();
    expect(store.retrievalIndexSize().entries).toBe(oracle(snapshot, query).searchedEntries);
    expect(finished).toEqual([]);                                            // the abandoned search never ran to its end
    expect(await store.retrieveAsync(query, { deadlineMs: 60_000, onTiming: timing => finished.push(timing) })).toEqual(oracle(snapshot, query));
    expect(finished).toHaveLength(1); expect(blocking).not.toHaveBeenCalled();
    // An abort in the middle of a search over a warm index: at most the pause it was in, then no more work.
    let searching = false, searchPauses = 0;
    const stopper = new AbortController();
    const second = await storeOf(archive, { retrievalSliceMs: 0, retrievalYield: async () => { if (searching && ++searchPauses === 3) stopper.abort(); } });
    await second.warmRetrieval(); searching = true;
    await expect(second.retrieveAsync(query, { signal: stopper.signal })).rejects.toThrow();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(searchPauses).toBe(3); searching = false;
    expect(await second.retrieveAsync(query)).toEqual(oracle(snapshot, query)); // and the next search is not behind it
    // A deadline that is read from the clock at a pause (the timer itself is late on a throttled page).
    let busy = true;
    const third = await storeOf(archive, { retrievalSliceMs: 0, retrievalYield: async () => { if (!busy) return; busy = false; const until = performance.now() + 30; while (performance.now() < until) { /* the page is busy elsewhere */ } } });
    expect((await third.retrieveAsync(query, { deadlineMs: 10 })).timedOut).toBe(true);
    await third.warmRetrieval();
    expect(await third.retrieveAsync(query, { deadlineMs: 60_000 })).toEqual(oracle(snapshot, query));
  }, 60_000);

  it("tokenizes a pasted document in pieces that give exactly the tokens of the whole", async () => {
    const rand = random(77), text = makeText(rand);
    // Places where a careless cut changes the tokens: final sigma, combining marks, kana voicing marks, Hangul jamo, full-width forms.
    const tricky = ["ΟΔΟΣ. Β", "ΑΣ ", "ΑΣ.", "é ", " ́x", "が ", "。゙か", "한 ", " ᅡᆫ", "ＡＢＣ，ｄｅｆ", "don't ", "3.5 ", "ﬁne ", "İstanbul ", "１２３、", "𠀋𠀋 ", "ｶﾞ "];
    for (let round = 0; round < 60; round++) {
      let body = "";
      while (body.length < 400 + round * 40) body += rand() < 0.4 ? tricky[Math.floor(rand() * tricky.length)]! : `${text.sentence()}${rand() < 0.5 ? " " : ""}`;
      for (const size of [4, 16, 64, 2048]) {
        const chunks = tokenChunks(body, size);
        expect(chunks.join("")).toBe(body);
        expect(chunks.flatMap(chunk => indexTokens(chunk))).toEqual(indexTokens(body));
      }
    }
    const prose = text.passage(300_000), pieces = tokenChunks(prose);
    expect(pieces.length).toBeGreaterThan(100); expect(Math.max(...pieces.map(piece => piece.length))).toBeLessThan(4200);
    expect(tokenChunks("x".repeat(50_000))).toHaveLength(1);                  // nowhere safe to cut: one piece, as before
    // In the index: one 300 000-character entry is tokenized across pauses (its windows alone are 1000 of them), and searched like any other.
    const session: HistorySession = { id: "doc", source: "helix", title: "Pasted", startedAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" };
    const snapshot: Snapshot = { sessions: [session], entries: [{ id: "doc:1", sessionId: "doc", kind: "transcript", text: prose, occurredAt: session.startedAt }, { id: "doc:2", sessionId: "doc", kind: "transcript", text: text.sentence(), occurredAt: session.startedAt }] };
    let pauses = 0;
    const store = await storeOf(snapshot, { retrievalSliceMs: 0, retrievalYield: async () => { pauses++; } });
    await store.warmRetrieval();
    expect(pauses).toBeGreaterThanOrEqual(prose.length / 300 + pieces.length);
    const query = prose.slice(150_000, 150_300);
    expect(await store.retrieveAsync(query)).toEqual(oracle(snapshot, query));
    expect(store.retrieveWithStats(query, { maxChars: 250 })).toEqual(oracle(snapshot, query, { maxChars: 250 }));
  }, 60_000);

  it("keeps the index small: ids in typed arrays per session, and words of deleted sessions are forgotten", async () => {
    const store = new LocalHistoryStore(memoryDisk()), at = "2026-09-01T00:00:00.000Z";
    const session = (id: string): HistorySession => ({ id, source: "helix", title: id, startedAt: at, updatedAt: at });
    await store.upsertSession(session("big")); await store.upsertSession(session("small"));
    await store.upsertEntries(Array.from({ length: 60 }, (_, i): HistoryEntry => ({ id: `big:${i}`, sessionId: "big", kind: "transcript", occurredAt: at,
      text: Array.from({ length: i % 10 ? 50 : 400 }, (_, j) => `rare${i}x${j}`).join(" ") })));
    await store.upsertEntries([{ id: "small:1", sessionId: "small", kind: "transcript", text: "The zeppelin hangar is booked. 发布计划改到十月。", occurredAt: at }]);
    expect(store.retrievalIndexSize()).toEqual({ vocabulary: 0, entries: 0, bytes: 0 });  // nothing is built until it is used
    expect(store.retrieveWithStats("rare7x3 zeppelin")).toEqual(oracle(saved(store), "rare7x3 zeppelin"));
    const full = store.retrievalIndexSize();
    expect(full.entries).toBe(61); expect(full.vocabulary).toBeGreaterThan(5000);
    // 4 bytes per token id (long entries also keep their passage windows: about 3 ids per token), no slack left behind.
    const tokens = saved(store).entries.reduce((n, entry) => n + tokenList(entry.text).length * (entry.text.length > 600 ? 3.2 : 1), 0);
    expect(full.bytes).toBeGreaterThan(tokens * 3); expect(full.bytes).toBeLessThan(tokens * 4 * 1.3 + 2048);
    await store.deleteSession("big");
    expect(store.retrieveWithStats("rare7x3 zeppelin 十月")).toEqual(oracle(saved(store), "rare7x3 zeppelin 十月"));
    const left = store.retrievalIndexSize();
    expect(left.entries).toBe(1); expect(left.vocabulary).toBeLessThan(40); expect(left.bytes).toBeLessThan(400);
    // A session that keeps growing and being revised does not accumulate dead ids either.
    await store.upsertSession(session("live"));
    for (let i = 0; i < 120; i++) {
      await store.upsertEntries([{ id: `live:${i % 30}`, sessionId: "live", kind: "transcript", text: `Revision ${i} of line ${i % 30} about the zeppelin budget.`, occurredAt: at }]);
      if (i % 20 === 19) expect(await store.retrieveAsync("zeppelin budget revision")).toEqual(oracle(saved(store), "zeppelin budget revision"));
    }
    expect(store.retrievalIndexSize().bytes).toBeLessThan(31 * 12 * 4 * 2);
  });

  it("ends each yield with its own message: one that arrives late does not cut a later yield short", async () => {
    const posted: unknown[] = []; let deliver!: (event: { data: unknown }) => void;
    class Channel {
      port1 = { set onmessage(handler: (event: { data: unknown }) => void) { deliver = handler; } } as unknown as { onmessage: ((event: { data: unknown }) => void) | null };
      port2 = { postMessage: (message: unknown) => { posted.push(message); } };
    }
    vi.useFakeTimers();
    try {
      const pause = hostYield({ MessageChannel: Channel, setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: timer => clearTimeout(timer) });
      let first = false, second = false, third = false;
      void pause().then(() => { first = true; });
      await vi.advanceTimersByTimeAsync(YIELD_FALLBACK_MS - 1); expect(first).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(first).toBe(true);          // the host held the message back: the timer ends the yield
      void pause().then(() => { second = true; });
      deliver({ data: posted[0] }); await vi.advanceTimersByTimeAsync(0);
      expect(second).toBe(false);                                              // the first yield's message, late: not ours
      deliver({ data: posted[1] }); await vi.advanceTimersByTimeAsync(0);
      expect(second).toBe(true);
      void pause().then(() => { third = true; });
      deliver({ data: posted[2] }); await vi.advanceTimersByTimeAsync(0);
      expect(third).toBe(true); expect(vi.getTimerCount()).toBe(0);            // and its fallback timer is cleared
      // Without a MessageChannel (or with setImmediate) it is a plain macrotask.
      let plain = false; void hostYield({ setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: timer => clearTimeout(timer) })().then(() => { plain = true; });
      await vi.advanceTimersByTimeAsync(0); expect(plain).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
