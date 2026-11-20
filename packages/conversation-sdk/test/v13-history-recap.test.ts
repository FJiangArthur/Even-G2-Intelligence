import { describe, expect, it } from "vitest";
import {
  HISTORY_INDEX_KEY, LocalHistoryStore, SESSION_DIGEST_PROMPT_VERSION, fallbackSessionRecap, historyChunkKey, historyShardKey, isAutoSessionTitle,
  removeOpenAIKnowledgeDocument, sessionHasContent, sessionKeywords, sessionRecap, spokenChars, summarizeSession,
  type HistoryEntry, type HistorySession, type OpenAIKnowledgeState,
} from "../src/index.js";

const session = (id: string, extra: Partial<HistorySession> = {}): HistorySession => ({ id, source: "helix", title: `Helix · 2026-11-19T17:00:00.000Z`, startedAt: "2026-11-19T17:00:00.000Z", updatedAt: "2026-11-19T17:06:00.000Z", ...extra });
const entry = (id: string, sessionId: string, text: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({ id, sessionId, kind: "transcript", text, occurredAt: "2026-11-19T17:00:00.000Z", speaker: "Other speaker", ...extra });
function disk(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial)), writes: string[] = [];
  return { values, writes, getLocalStorage: async (key: string) => values.get(key) ?? "", setLocalStorage: async (key: string, value: string) => { writes.push(key); values.set(key, value); return true; } };
}

describe("v0.13 session recap (title + overview) without a model", () => {
  const spoken = [
    entry("s:1", "s", "So", { occurredAt: "2026-11-19T17:00:00.000Z" }),
    entry("s:2", "s", "So the Orin order slipped again, says Kan.", { occurredAt: "2026-11-19T17:00:05.000Z" }),
    entry("s:3", "s", "Kan thinks the Orin stock comes back in March, I asked Kan to escalate.", { occurredAt: "2026-11-19T17:01:00.000Z", speaker: "You" }),
    entry("s:4", "s", "Can Kan escalate the order?", { kind: "question", occurredAt: "2026-11-19T17:01:10.000Z" }),
    entry("s:5", "s", "Yes, ask Kan to escalate with the distributor.", { kind: "answer", speaker: "Helix", occurredAt: "2026-11-19T17:01:20.000Z" }),
  ];
  it("never titles a session with the first thing that was said", () => {
    // Before v0.13 a Helix session was titled with its first utterance cut to 100 characters, or kept the placeholder.
    const legacy = session("s", { title: "So" });
    expect(isAutoSessionTitle(legacy, spoken)).toBe(true);
    expect(isAutoSessionTitle(session("s"), [])).toBe(true); // placeholder
    const recap = sessionRecap(legacy, spoken);
    expect(recap).toMatchObject({ title: "About Orin, Kan", origin: "fallback" });
    expect(recap.overview).toBe("Not summarised yet · mentions Orin, Kan. Opens with “So the Orin order slipped again, says Kan.”"); // the re-sent partial "So" is skipped
    expect(recap.title).not.toBe("So");
  });
  it("prefers the copilot summary, then topic words, then the time of day", () => {
    expect(fallbackSessionRecap(session("s", { summary: ["Orin order slipped to March.", "Kan escalates with the distributor.", "Third."] }), spoken))
      .toEqual({ title: "Orin order slipped to March", overview: "Orin order slipped to March. Kan escalates with the distributor." });
    const chat = [entry("c:1", "c", "And what's up"), entry("c:2", "c", "Not much, heading out.", { speaker: "You", occurredAt: "2026-11-19T17:00:09.000Z" })];
    expect(sessionKeywords(chat)).toEqual([]);
    expect(fallbackSessionRecap(session("c"), chat).title).toMatch(/^(Morning|Afternoon|Evening|Late-night) conversation$/u);
    const zh = [entry("z:1", "z", "我们下周把感知模块迁移到新的融合框架上。")];
    expect(fallbackSessionRecap(session("z"), zh)).toMatchObject({ title: expect.stringMatching(/ conversation$/u), overview: "Not summarised yet. Opens with “我们下周把感知模块迁移到新的融合框架上。”" });
    // Strict topic words: a code from its first mention, a name from two lines, an ordinary word from three.
    expect(sessionKeywords([entry("k:1", "k", "We're moving to CDTF"), entry("k:2", "k", "We're moving to CDTF for the mapping head.", { occurredAt: "2026-11-19T17:00:01.000Z" })])).toEqual(["CDTF"]);
    expect(sessionKeywords(["First", "Second", "Third"].map((word, n) => entry(`b:${n}`, "b", `${word}, the budget is still open.`, { occurredAt: `2026-11-19T17:0${n}:00.000Z` })))).toEqual(["budget"]);
  });
  it("keeps generated and imported titles as stored, and knows what counts as content", () => {
    const generated = session("g", { title: "Orin supply escalation", overview: "The Orin order slipped; Kan escalates.", recap: { origin: "model", generatedAt: "2026-11-19T17:07:00.000Z", model: "gpt-6-luna" } });
    expect(sessionRecap(generated, spoken)).toEqual({ title: "Orin supply escalation", overview: "The Orin order slipped; Kan escalates.", origin: "model" });
    expect(sessionRecap(session("o", { source: "omi", title: "1:1 with Kan" }), [entry("o:1", "o", "Kan confirmed the purchase order.", { kind: "answer", speaker: "Omi summary", metadata: { origin: "omi-summary" } })]))
      .toEqual({ title: "1:1 with Kan", overview: "Kan confirmed the purchase order.", origin: "imported" });
    expect(sessionRecap(session("h", { title: "Vendor call" }), spoken).title).toBe("Vendor call"); // a title someone chose is not replaced
    expect(sessionHasContent(session("e"), 0)).toBe(false);
    expect(sessionHasContent(session("e"), 1)).toBe(true);
    expect(sessionHasContent(session("e", { people: [{ name: "Kan" }] }), 0)).toBe(true);
    expect(spokenChars(spoken)).toBe("So".length + "So the Orin order slipped again, says Kan.".length +"Kan thinks the Orin stock comes back in March, I asked Kan to escalate.".length);
  });
});

describe("v0.13 local history store: recap, empty sessions, merge, batch removal", () => {
  it("stores the recap with its provenance, survives a reload, and keeps a generated title over the live placeholder", async () => {
    const storage = disk(), store = new LocalHistoryStore(storage);
    await store.upsertSession(session("s")); await store.upsertEntries([entry("s:1", "s", "The Orin order slipped.")]);
    await store.updateSessionRecap("s", { title: "  Orin supply escalation ", overview: "The order slipped; Kan escalates.", endedAt: "2026-11-19T17:06:30.000Z",
      recap: { origin: "model", generatedAt: "2026-11-19T17:06:31.000Z", model: "gpt-6-luna", provider: "openai", endpoint: "https://api.openai.com/v1/responses?x=1", promptVersion: SESSION_DIGEST_PROMPT_VERSION, latencyMs: 812.4,
        ...({ apiKey: "sk-secret" } as object) } });
    await store.upsertSession(session("s", { updatedAt: "2026-11-19T17:09:00.000Z" })); // a late live write with the placeholder title
    const reloaded = new LocalHistoryStore(storage); await reloaded.load();
    expect(reloaded.getSession("s")).toEqual({ ...session("s", { updatedAt: "2026-11-19T17:09:00.000Z" }), title: "Orin supply escalation", overview: "The order slipped; Kan escalates.", endedAt: "2026-11-19T17:06:30.000Z",
      recap: { origin: "model", generatedAt: "2026-11-19T17:06:31.000Z", model: "gpt-6-luna", provider: "openai", endpoint: "https://api.openai.com/v1/responses", promptVersion: "session-digest-v2", latencyMs: 812 } });
    expect(storage.values.get(HISTORY_INDEX_KEY)).not.toContain("sk-secret");
    await expect(store.updateSessionRecap("missing", { title: "x" })).rejects.toThrow(/not saved/u);
  });
  it("lists sessions with nothing in them, but not ones with knowledge, other sources on request, or unreadable shards", async () => {
    const storage = disk(), store = new LocalHistoryStore(storage);
    await store.upsertSession(session("empty1")); await store.upsertSession(session("empty2", { updatedAt: "2026-11-19T18:00:00.000Z" }));
    await store.upsertSession(session("knowledge", { summary: ["A decision."] }));
    await store.upsertSession(session("omi:title-only", { source: "omi", title: "Title-only meeting" }));
    await store.upsertSession(session("full")); await store.upsertEntries([entry("full:1", "full", "Something was said.")]);
    await store.upsertSession(session("broken")); await store.upsertEntries([entry("broken:1", "broken", "Unreadable later.")]);
    expect(store.emptySessionIds("helix")).toEqual(["empty2", "empty1"]);
    expect(store.emptySessionIds()).toEqual(["empty2", "empty1", "omi:title-only"]);
    storage.values.set(historyShardKey("broken"), "{not json");
    const reloaded = new LocalHistoryStore(storage); await reloaded.load();
    expect(reloaded.corruptSessionIds()).toEqual(["broken"]);
    expect(reloaded.emptySessionIds("helix")).toEqual(["empty2", "empty1"]); // "broken" has entries that are only unavailable
    storage.writes.length = 0;
    await reloaded.deleteSessions(reloaded.emptySessionIds("helix"));
    expect(storage.writes).toEqual([HISTORY_INDEX_KEY]); // one index write for the whole batch; empty sessions have no shard
    expect(reloaded.listSessions().map(item => item.id).sort()).toEqual(["broken", "full", "knowledge", "omi:title-only"]);
  });
  it("removes sessions from the index, every shard chunk and retrieval in one save", async () => {
    const storage = disk(), store = new LocalHistoryStore(storage, { chunkEntries: 2 });
    for (const id of ["a", "b", "c"]) {
      await store.upsertSession(session(id));
      await store.upsertEntries([1, 2, 3, 4, 5].map(n => entry(`${id}:${n}`, id, `Session ${id} line ${n}: the pallet inventory is ${id === "a" ? "low" : "fine"}.`)));
    }
    expect(storage.values.get(historyChunkKey("a", 2))).toContain("a:5");
    expect(store.retrieve("pallet inventory").map(hit => hit.session.id)).toContain("a");
    storage.writes.length = 0;
    await store.deleteSessions(["a", "c", "a", "missing"]);
    expect(storage.writes.filter(key => key === HISTORY_INDEX_KEY)).toHaveLength(1);
    for (const id of ["a", "c"]) for (const chunk of [0, 1, 2]) expect(storage.values.get(historyChunkKey(id, chunk))).toBe("");
    expect(store.listSessions().map(item => item.id)).toEqual(["b"]);
    expect(new Set(store.retrieve("pallet inventory").map(hit => hit.session.id))).toEqual(new Set(["b"]));
    expect(store.search("pallet").every(hit => hit.session.id === "b")).toBe(true);
    expect(store.sessionIdOfEntry("a:1")).toBeUndefined();
    const reloaded = new LocalHistoryStore(storage); await reloaded.load();
    expect(reloaded.listSessions().map(item => item.id)).toEqual(["b"]);
    expect(reloaded.getEntries("b")).toHaveLength(5);
  });
  it("merges a resumed session into the one it continues", async () => {
    const storage = disk(), store = new LocalHistoryStore(storage);
    await store.upsertSession(session("first", { title: "Kickoff", summary: ["Chose the x86 box."], people: [{ name: "Kan", mentions: 2 }], overview: "First half.", recap: { origin: "model", generatedAt: "2026-11-19T17:07:00.000Z" } }));
    await store.upsertEntries([entry("first:1", "first", "We chose the x86 box.")]);
    await store.upsertSession(session("second", { startedAt: "2026-11-19T17:10:00.000Z", updatedAt: "2026-11-19T17:20:00.000Z", continues: "first", summary: ["Budget is 25k."], people: [{ name: "kan" }, { name: "Elaine" }], endedAt: "2026-11-19T17:21:00.000Z" }));
    await store.upsertEntries([entry("second:1", "second", "The budget is twenty five thousand.", { occurredAt: "2026-11-19T17:11:00.000Z" })]);
    await store.mergeSession("second", "first");
    expect(store.listSessions().map(item => item.id)).toEqual(["first"]);
    const merged = store.getSession("first")!;
    expect(merged).toMatchObject({ title: "Kickoff", startedAt: "2026-11-19T17:00:00.000Z", updatedAt: "2026-11-19T17:20:00.000Z", endedAt: "2026-11-19T17:21:00.000Z",
      summary: ["Chose the x86 box.", "Budget is 25k."], people: [{ name: "Kan", mentions: 2 }, { name: "Elaine" }] });
    expect(merged.recap).toBeUndefined(); expect(merged.overview).toBeUndefined(); // the old recap no longer covers the session
    expect(store.getEntries("first").map(item => [item.id, item.sessionId])).toEqual([["first:1", "first"], ["second:1", "first"]]);
    expect(store.sessionIdOfEntry("second:1")).toBe("first");
    expect(storage.values.get(historyShardKey("second"))).toBe("");
    expect(store.retrieve("budget twenty five thousand")[0]?.session.id).toBe("first");
    const reloaded = new LocalHistoryStore(storage); await reloaded.load();
    expect(reloaded.getEntries("first")).toHaveLength(2);
    await expect(store.mergeSession("gone", "first")).rejects.toThrow(/not saved/u);
    await expect(store.mergeSession("first", "first")).rejects.toThrow(/not saved/u);
  });
});

describe("v0.13 session digest and knowledge base removal", () => {
  it("returns a bounded title and overview with the summary, and tolerates a model that omits them", async () => {
    const bodies: { instructions: string; text: { format: { schema: { required: string[] } } } }[] = [];
    const reply = (value: object) => async (_url: string, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] }); };
    const lines = [{ speaker: "Them", text: "The Orin order slipped again." }];
    const digest = await summarizeSession(reply({ title: " “Orin supply escalation” ", overview: "The Orin order slipped.\nKan escalates.", summary: ["Order slipped."], keyFacts: [], concepts: [] }), "k", "gpt-6-luna", { title: "", lines });
    expect(digest).toEqual({ title: "Orin supply escalation", overview: "The Orin order slipped. Kan escalates.", summary: ["Order slipped."], keyFacts: [], concepts: [] });
    expect(bodies[0]!.text.format.schema.required).toEqual(["title", "overview", "summary", "keyFacts", "concepts"]);
    expect(bodies[0]!.instructions).toMatch(/never the opening words/u);
    expect(await summarizeSession(reply({ summary: ["A"] }), "k", "m", { title: "", lines })).toMatchObject({ title: "", overview: "", summary: ["A"] });
  });
  it("removes one synced document now, treats a missing file as removed, and keeps it pending when OpenAI fails", async () => {
    const state: OpenAIKnowledgeState = { vectorStoreId: "vs_1", files: { s1: { fileId: "file-1", stamp: "1|a" }, s2: { fileId: "file-2", stamp: "1|b" } } };
    const calls: string[] = [];
    const respond = (status: number) => async (url: string, init?: RequestInit) => { calls.push(`${init?.method} ${url} ${(init?.headers as Record<string, string>).Authorization}`); return new Response("{}", { status }); };
    expect(await removeOpenAIKnowledgeDocument(respond(200), " key ", state, "s1")).toEqual({ vectorStoreId: "vs_1", files: { s2: { fileId: "file-2", stamp: "1|b" } } });
    expect(calls).toEqual(["DELETE https://api.openai.com/v1/files/file-1 Bearer key"]);
    expect((await removeOpenAIKnowledgeDocument(respond(404), "key", state, "s2")).files).toEqual({ s1: { fileId: "file-1", stamp: "1|a" } });
    await expect(removeOpenAIKnowledgeDocument(respond(500), "key", state, "s1")).rejects.toThrow(/could not remove/u);
    await expect(removeOpenAIKnowledgeDocument(respond(200), "", state, "s1")).rejects.toThrow(/API key/u);
    expect(await removeOpenAIKnowledgeDocument(respond(200), "key", state, "never-synced")).toBe(state);
  });
});
