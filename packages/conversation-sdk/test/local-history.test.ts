import { describe, expect, it, vi } from "vitest";
import { LocalHistoryStore, type HistoryEntry, type HistorySession } from "../src/index.js";

const session = (id = "helix:a", date = "2026-09-01T00:00:00Z"): HistorySession => ({ id, source: "helix", title: "Launch", startedAt: date, updatedAt: date });
const entry = (id = "entry:a", text = "发布计划改到十月。", extra: Partial<HistoryEntry> = {}): HistoryEntry => ({ id, sessionId: "helix:a", kind: "transcript", text, occurredAt: "2026-09-01T00:00:00Z", ...extra });
/** Keyed phone storage; `initial` is a v1 (single-key) archive. */
function storage(initial = "") {
  const values = new Map<string, string>(initial ? [["helix.g2.history.v1", initial]] : []);
  return { values, getLocalStorage: vi.fn(async (key: string) => values.get(key) ?? ""), setLocalStorage: vi.fn(async (key: string, next: string) => { values.set(key, next); return true; }) };
}

describe("LocalHistoryStore", () => {
  it("retains bounded local source IDs on saved answers and rejects arbitrary payloads", async () => {
    const db = new LocalHistoryStore(storage()); await db.load(); await db.upsertSession(session());
    await db.upsertEntries([entry("answer", "Answer", { kind: "answer", metadata: { memoryEntryIds: '["omi:one:transcript:index:0"]' } }),
      entry("bad", "Bad", { metadata: { memoryEntryIds: '{"apiKey":"secret"}' } })]);
    expect(db.getEntries("helix:a").find(e => e.id === "answer")?.metadata?.memoryEntryIds).toBe('["omi:one:transcript:index:0"]');
    expect(db.getEntries("helix:a").find(e => e.id === "bad")?.metadata?.memoryEntryIds).toBeUndefined();
  });
  it("persists, deduplicates and returns copied bilingual evidence after restart", async () => {
    const disk = storage(), db = new LocalHistoryStore(disk); await db.load();
    await db.upsertSession(session());
    await db.upsertEntries([entry(), entry("en", "The launch date changed to October.")]);
    await db.upsertEntries([entry()]);
    const restarted = new LocalHistoryStore(disk); await restarted.load();
    expect(restarted.retrieve("发布计划")[0]?.entry.id).toBe("entry:a");
    expect(restarted.retrieve("launch date")[0]?.entry.id).toBe("en");
    expect(restarted.getEntries("helix:a")).toHaveLength(2);
    restarted.getEntries("helix:a")[0]!.text = "mutated";
    restarted.listSessions()[0]!.title = "mutated";
    restarted.retrieve("发布计划")[0]!.entry.text = "mutated";
    expect(restarted.retrieve("发布计划")[0]?.entry.text).toBe("发布计划改到十月。");
    expect(restarted.listSessions()[0]?.title).toBe("Launch");
    expect(disk.setLocalStorage).toHaveBeenLastCalledWith("helix.g2.history.v2", expect.any(String)); // v2 index is written last
  });
  it("serializes mutations and only publishes successfully saved snapshots", async () => {
    const disk = storage(), db = new LocalHistoryStore(disk); await db.load();
    let finish!: (value: boolean) => void;
    disk.setLocalStorage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = db.upsertSession(session()); const second = db.upsertSession(session("helix:b"));
    await vi.waitFor(() => expect(disk.setLocalStorage).toHaveBeenCalledTimes(1));
    expect(db.listSessions()).toEqual([]); finish(true);
    await Promise.all([first, second]); expect(db.listSessions()).toHaveLength(2);
    disk.setLocalStorage.mockResolvedValueOnce(false);
    await expect(db.deleteSession("helix:a")).rejects.toThrow(/sav|storage/i);
    expect(db.listSessions()).toHaveLength(2);
    disk.setLocalStorage.mockRejectedValueOnce(new Error("secret provider token"));
    await expect(db.upsertEntries([entry()])).rejects.toThrow(/save/i);
    expect(db.getEntries("helix:a")).toEqual([]);
    await db.deleteSession("helix:a"); expect(db.listSessions()).toHaveLength(1);
  });
  it("copies arguments before queued persistence", async () => {
    const db = new LocalHistoryStore(storage()); await db.load();
    const s = session(); const saved = db.upsertSession(s); s.title = "mutated"; await saved;
    expect(db.listSessions()[0]?.title).toBe("Launch");
    const e = entry(); const written = db.upsertEntries([e]); e.text = "mutated"; await written;
    expect(db.getEntries(s.id)[0]?.text).toContain("发布计划");
  });
  it("deletes a session and its entries across restart", async () => {
    const disk = storage(), db = new LocalHistoryStore(disk); await db.load(); await db.upsertSession(session()); await db.upsertEntries([entry()]);
    await db.deleteSession("helix:a"); const restarted = new LocalHistoryStore(disk); await restarted.load();
    expect(restarted.listSessions()).toEqual([]); expect(restarted.search("发布")).toEqual([]);
  });
  it.each(["{bad", "null", '{"version":2,"sessions":[],"entries":[]}', '{"version":1,"sessions":[{}],"entries":[]}', '{"version":1,"sessions":[],"entries":[{}]}'])("rejects malformed snapshots without overwriting them: %s", async raw => {
    const disk = storage(raw), db = new LocalHistoryStore(disk);
    await expect(db.load()).rejects.toThrow(/history/i);
    await expect(db.upsertSession(session())).rejects.toThrow(/history/i);
    expect(disk.setLocalStorage).not.toHaveBeenCalled();
  });
  it("prefers transcript evidence, includes answers/fact-checks at lower weight, excludes questions, assistant speech, unrelated text, current session and blank queries", async () => {
    const db = new LocalHistoryStore(storage()); await db.load(); await db.upsertSession(session());
    await db.upsertEntries([entry("answer", "October launch", { kind: "answer" }), entry("fact", "October launch", { kind: "fact-check" }), entry("question", "October launch", { kind: "question" }), entry("assistant", "October launch", { speaker: "assistant" }), entry("speech", "October launch"), entry("other", "orchids bloom")]);
    expect(db.retrieve("October launch").map(x => x.entry.id)).toEqual(["speech", "answer", "fact"]);
    expect(db.search("October")).toHaveLength(5);
    expect(db.search("Launch")).toHaveLength(6); // Session titles are searchable, too.
    expect(db.retrieve("October", { excludeSessionId: "helix:a" })).toEqual([]);
    expect(db.retrieve("unknown")).toEqual([]); expect(db.retrieve(" ")).toEqual([]); expect(db.retrieve("the and is")).toEqual([]);
  });
  it("ranks relevance before recency and breaks ties with recency", async () => {
    const db = new LocalHistoryStore(storage()); await db.load(); await db.upsertSession(session());
    await db.upsertEntries([entry("old", "October launch", { occurredAt: "2025-01-01T00:00:00Z" }), entry("new", "October launch", { occurredAt: "2026-01-01T00:00:00Z" }), entry("partial", "October", { occurredAt: "2026-09-01T00:00:00Z" })]);
    expect(db.retrieve("October launch").map(x => x.entry.id)).toEqual(["new", "old", "partial"]);
  });
  it("retrieves the relevant passage of a long transcript within a total character budget", async () => {
    const db = new LocalHistoryStore(storage()); await db.load(); await db.upsertSession(session());
    await db.upsertEntries([entry("long", `${"unrelated words. ".repeat(200)}The launch target is October. ${"other words. ".repeat(100)}`), entry("short", "October launch")]);
    const found = db.retrieve("launch target", { maxChars: 160, limit: 2 });
    expect(found[0]?.entry.text).toContain("launch target is October");
    expect(found.reduce((n, x) => n + x.entry.text.length, 0)).toBeLessThanOrEqual(160);
    expect(db.getEntries("helix:a").find(x => x.id === "long")?.text.length).toBeGreaterThan(3000);
    expect(db.retrieve("launch", { maxChars: 0 })).toEqual([]);
  });
  it("strips unknown metadata and invalid citation URLs on writes and load", async () => {
    const disk = storage(), db = new LocalHistoryStore(disk); await db.load(); await db.upsertSession(session());
    await db.upsertEntries([entry("safe", "launch", { metadata: { model: "gpt-4.1", promptVersion: "v1", apiKey: "secret", authorization: "secret", arbitrary: "secret" }, sources: [{ title: "Safe", url: "https://example.com/a" }, { title: "Unsafe", url: "javascript:alert(1)" }] })]);
    expect(db.getEntries("helix:a")[0]?.metadata).toEqual({ model: "gpt-4.1", promptVersion: "v1" });
    expect(db.getEntries("helix:a")[0]?.sources).toEqual([{ title: "Safe", url: "https://example.com/a" }]);
    expect(db.exportJson()).not.toContain("secret");
    const raw = JSON.parse(db.exportJson()); raw.entries[0].metadata.accessToken = "secret";
    const restarted = new LocalHistoryStore(storage(JSON.stringify(raw))); await restarted.load(); expect(restarted.exportJson()).not.toContain("secret");
  });
  it("rejects orphan entries and oversized UTF-8 snapshots without losing prior history", async () => {
    const disk = storage(), db = new LocalHistoryStore(disk); await db.load();
    await expect(db.upsertEntries([entry()])).rejects.toThrow(/session/i);
    await db.upsertSession(session()); await db.upsertEntries([entry()]);
    const before = db.exportJson();
    await expect(db.upsertEntries([entry("huge", "语".repeat(1_800_000))])).rejects.toThrow(/5 MiB|quota|limit/i);
    expect(db.exportJson()).toBe(before);
  });
  it("rejects coercible enum values instead of persisting invalid schema", async () => {
    const db = new LocalHistoryStore(storage()); await db.load();
    await expect(db.upsertSession({ ...session(), source: ["helix"] } as unknown as HistorySession)).rejects.toThrow(/history/i);
    await db.upsertSession(session());
    await expect(db.upsertEntries([{ ...entry(), kind: ["transcript"] } as unknown as HistoryEntry])).rejects.toThrow(/history/i);
  });
  it("matches mixed English/Chinese boundaries and single Chinese characters", async () => {
    const db = new LocalHistoryStore(storage()); await db.load(); await db.upsertSession(session());
    await db.upsertEntries([entry("mixed", "October发布计划改到十月")]);
    expect(db.retrieve("October")[0]?.entry.id).toBe("mixed");
    expect(db.retrieve("十")[0]?.entry.id).toBe("mixed");
  });
  it("BM25 finds 'Jetson lead time' from a prior session phrased 'jetsons have long lead times' and reports diagnostics", async () => {
    const db = new LocalHistoryStore(storage()); await db.load();
    await db.upsertSession(session("helix:old")); await db.upsertSession(session("helix:now"));
    await db.upsertEntries([
      entry("jet", "Honestly the jetsons have long lead times, we waited ten weeks.", { sessionId: "helix:old" }),
      entry("noise1", "We talked about the roadmap and hiring.", { sessionId: "helix:old" }),
      entry("noise2", "Lunch was good, the team liked the tacos.", { sessionId: "helix:old" }),
      entry("cur", "Jetson lead time question again", { sessionId: "helix:now" }),
    ]);
    const stats = db.retrieveWithStats("What is the Jetson lead time?", { excludeSessionId: "helix:now" });
    expect(stats.items[0]?.entry.id).toBe("jet");
    expect(stats.searchedEntries).toBe(3); expect(stats.matched).toBe(1);
    expect(stats.items.every(item => item.entry.sessionId !== "helix:now")).toBe(true);
  });
  it("counts one strong rare-term hit and matches shared prefixes", async () => {
    const db = new LocalHistoryStore(storage()); await db.load(); await db.upsertSession(session());
    await db.upsertEntries([entry("a", "The deployment of the new cluster was delayed by procurement."), entry("b", "General chat about the weather and the week."), entry("c", "General chat about the plan and the week.")]);
    expect(db.retrieve("Any update about deploying it this week or something?")[0]?.entry.id).toBe("a");
  });
  it("ranks prior answers below matching transcript evidence and keeps the assistant transcript filter", async () => {
    const db = new LocalHistoryStore(storage()); await db.load(); await db.upsertSession(session());
    await db.upsertEntries([
      entry("ans", "Jetson Orin lead time is about 12 weeks.", { kind: "answer", speaker: "assistant" }),
      entry("speech", "Jetson Orin lead time is about 12 weeks.", { speaker: "Bob" }),
      entry("bot", "Jetson Orin lead time is about 12 weeks.", { speaker: "Assistant" }),
    ]);
    expect(db.retrieve("Jetson Orin lead time").map(x => x.entry.id)).toEqual(["speech", "ans"]);
  });
});
