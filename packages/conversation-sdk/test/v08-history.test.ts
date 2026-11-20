import { describe, expect, it, vi } from "vitest";
import { LocalHistoryStore, KNOWLEDGE_SOURCES, type HistoryEntry, type HistorySession } from "../src/index.js";

/** Keyed phone storage; `initial` is a v1 (single-key) archive. */
function storage(initial = "") {
  const values = new Map<string, string>(initial ? [["helix.g2.history.v1", initial]] : []);
  return { values, getLocalStorage: vi.fn(async (key: string) => values.get(key) ?? ""), setLocalStorage: vi.fn(async (key: string, next: string) => { values.set(key, next); return true; }) };
}
const session = (id: string, extra: Partial<HistorySession> = {}): HistorySession => ({ id, source: "helix", title: id, startedAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", ...extra });
const entry = (id: string, sessionId: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({ id, sessionId, kind: "transcript", text: `text ${id}`, occurredAt: "2026-09-01T00:00:00Z", ...extra });

describe("LocalHistoryStore v0.8 session knowledge", () => {
  it("loads v0.7 snapshots unchanged (no knowledge fields added)", async () => {
    const old = JSON.stringify({ version: 1, sessions: [{ id: "a", source: "omi", title: "Old", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" }], entries: [entry("e", "a")] });
    const db = new LocalHistoryStore(storage(old)); await db.load();
    expect(db.listSessions()).toEqual([{ id: "a", source: "omi", title: "Old", startedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" }]);
    expect(Object.keys(db.listSessions()[0]!)).toEqual(["id", "source", "title", "startedAt", "updatedAt"]);
  });
  it("validates and bounds knowledge fields (<= 20 items, <= 500 chars) and drops invalid shapes without failing the load", async () => {
    const raw = JSON.stringify({ version: 1, entries: [], sessions: [{
      ...session("k", { source: "obsidian" }),
      summary: [...Array.from({ length: 25 }, (_, i) => `Point ${i}`), "dup"], keyFacts: ["x".repeat(600), 42, null, "  ", "Fact\u0000two"],
      people: [{ name: "Elaine", role: "CTO" }, { name: "elaine" }, { name: "" }, "Bob", { name: "Bob", mentions: 3 }, { name: "Zed", mentions: -1 }],
      concepts: "CDTF", tags: ["robotics", "robotics", "jetson"],
    }] });
    const db = new LocalHistoryStore(storage(raw)); await db.load();
    const [s] = db.listSessions();
    expect(s!.source).toBe("obsidian");
    expect(s!.summary).toHaveLength(20);
    expect(s!.keyFacts).toEqual(["x".repeat(500), "Fact two"]);
    expect(s!.people).toEqual([{ name: "Elaine", role: "CTO" }, { name: "Bob", mentions: 3 }, { name: "Zed" }]);
    expect(s!.concepts).toBeUndefined();
    expect(s!.tags).toEqual(["robotics", "jetson"]);
  });
  it("rejects unknown sources", async () => {
    const db = new LocalHistoryStore(storage()); await db.load();
    await expect(db.upsertSession({ ...session("x"), source: "notion" as never })).rejects.toThrow(/history/i);
    expect(KNOWLEDGE_SOURCES).toEqual(["helix", "omi", "obsidian"]);
  });
  it("updateSessionKnowledge sets, keeps and clears fields, persists, and leaves updatedAt alone", async () => {
    const disk = storage(), db = new LocalHistoryStore(disk); await db.load();
    await db.upsertSession(session("s"));
    await db.updateSessionKnowledge("s", { summary: ["Discussed Jetson procurement."], keyFacts: ["Budget $40k"], people: [{ name: "Elaine", role: "head of robotics", mentions: 2 }], concepts: ["CDTF"], tags: ["jetson"] });
    await db.updateSessionKnowledge("s", { summary: ["Updated."], tags: [] });
    const restarted = new LocalHistoryStore(disk); await restarted.load();
    expect(restarted.listSessions()[0]).toEqual({ ...session("s"), summary: ["Updated."], keyFacts: ["Budget $40k"], people: [{ name: "Elaine", role: "head of robotics", mentions: 2 }], concepts: ["CDTF"] });
    await expect(db.updateSessionKnowledge("missing", { summary: ["x"] })).rejects.toThrow(/not saved/i);
    await expect(db.updateSessionKnowledge("s", null as never)).rejects.toThrow(/object/i);
  });
  it("upsertSession without knowledge fields keeps stored knowledge (live archive updates)", async () => {
    const db = new LocalHistoryStore(storage()); await db.load();
    await db.upsertSession(session("s"));
    await db.updateSessionKnowledge("s", { summary: ["Kept."], people: [{ name: "Elaine" }] });
    await db.upsertSession(session("s", { title: "Renamed", updatedAt: "2026-09-02T00:00:00Z" }));
    expect(db.listSessions()[0]).toMatchObject({ title: "Renamed", updatedAt: "2026-09-02T00:00:00Z", summary: ["Kept."], people: [{ name: "Elaine" }] });
    await db.upsertSession(session("s", { summary: [] }));
    expect(db.listSessions()[0]!.summary).toEqual([]);
  });
  it("listPeople aggregates people across sessions by normalized name", async () => {
    const db = new LocalHistoryStore(storage()); await db.load();
    await db.upsertSession(session("old", { updatedAt: "2026-09-01T00:00:00Z", people: [{ name: "elaine", role: "PM" }, { name: "Bob" }] }));
    await db.upsertSession(session("new", { updatedAt: "2026-10-01T00:00:00Z", people: [{ name: "Elaine", role: "Head of robotics", mentions: 4 }] }));
    await db.upsertSession(session("none"));
    expect(db.listPeople()).toEqual([
      { name: "Elaine", roles: ["Head of robotics", "PM"], sessionIds: ["new", "old"], mentions: 5, lastSeen: "2026-10-01T00:00:00Z" },
      { name: "Bob", roles: [], sessionIds: ["old"], mentions: 1, lastSeen: "2026-09-01T00:00:00Z" },
    ]);
  });
  it("stats reports sessions, entries and last update per source", async () => {
    const db = new LocalHistoryStore(storage()); await db.load();
    await db.upsertSession(session("h1", { updatedAt: "2026-09-03T00:00:00Z" }));
    await db.upsertSession(session("h2", { updatedAt: "2026-09-05T00:00:00Z" }));
    await db.upsertSession(session("o1", { source: "omi" }));
    await db.upsertEntries([entry("a", "h1"), entry("b", "h2"), entry("c", "h2"), entry("d", "o1")]);
    expect(db.stats()).toEqual({
      helix: { sessions: 2, entries: 3, lastUpdated: "2026-09-05T00:00:00Z" },
      omi: { sessions: 1, entries: 1, lastUpdated: "2026-09-01T00:00:00Z" },
      obsidian: { sessions: 0, entries: 0 },
    });
  });
  it("accepts obsidian entry ids as answer memory provenance", async () => {
    const db = new LocalHistoryStore(storage()); await db.load(); await db.upsertSession(session("s"));
    await db.upsertEntries([entry("ans", "s", { kind: "answer", metadata: { memoryEntryIds: '["obsidian:Helix%2F2026-09-01%20Launch:3","omi:x"]', section: "Plan" } })]);
    expect(db.getEntries("s")[0]!.metadata).toEqual({ memoryEntryIds: '["obsidian:Helix%2F2026-09-01%20Launch:3","omi:x"]', section: "Plan" });
  });
});
