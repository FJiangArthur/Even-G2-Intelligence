import { describe, expect, it } from "vitest";
import {
  CLEANUP_MERGE_GAP_MS, LocalHistoryStore, MIN_RECAP_TRANSCRIPT_CHARS, contextAskScope, historyScopeIds, proposeHistoryCleanup,
  type CleanupRecord, type HistoryEntry, type HistorySession,
} from "../src/index.js";

const T0 = Date.parse("2026-11-19T17:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const helix = (id: string, start: number, extra: Partial<HistorySession> = {}): HistorySession =>
  ({ id, source: "helix", title: `Helix · ${at(start)}`, startedAt: at(start), updatedAt: at(start + 1), ...extra });
const entry = (id: string, sessionId: string, text: string, extra: Partial<HistoryEntry> = {}): HistoryEntry =>
  ({ id, sessionId, kind: "transcript", text, occurredAt: at(0), speaker: "Other speaker", ...extra });
const LONG = "We agreed to move the Orin order to March and Kan will escalate with the distributor today.";
const talk = (session: HistorySession, minutes = 1): CleanupRecord =>
  ({ session, entries: [entry(`${session.id}:t`, session.id, LONG, { occurredAt: new Date(Date.parse(session.startedAt) + minutes * 60_000).toISOString() })] });
const tap = (id: string, sessionId: string, scope: "Local context" | "Whole conversation" = "Local context"): HistoryEntry =>
  entry(id, sessionId, "Using the recent context, answer.", { kind: "question", speaker: scope });
const answer = (id: string, sessionId: string, text = "Say: let us pin the date."): HistoryEntry => entry(id, sessionId, text, { kind: "answer", speaker: "Helix" });
function disk() {
  const values = new Map<string, string>();
  return { values, getLocalStorage: async (key: string) => values.get(key) ?? "", setLocalStorage: async (key: string, value: string) => { values.set(key, value); return true; } };
}

describe("v0.16 history clean-up proposal", () => {
  it("proposes Helix sessions with almost no speech and nothing of their own", () => {
    expect(LONG.length).toBeGreaterThanOrEqual(MIN_RECAP_TRANSCRIPT_CHARS);
    const stray = helix("stray", 0), finalized = helix("finalized", 100, { title: "Evening conversation", recap: { origin: "fallback", generatedAt: at(101) }, endedAt: at(101) });
    const proposal = proposeHistoryCleanup([
      { session: stray, entries: [entry("stray:1", "stray", "Okay.")] },
      { session: finalized, entries: [entry("finalized:1", "finalized", "Testing, one two.")] },
      talk(helix("real", 200)),
    ]);
    expect(proposal.removals.map(item => [item.id, item.reason])).toEqual([["stray", "little-speech"], ["finalized", "little-speech"]]);
    expect(proposal.removals[1]).toMatchObject({ source: "helix", title: "Evening conversation", startedAt: at(100) });
  });
  it("never proposes an imported or recapped session for having little in it", () => {
    const records: CleanupRecord[] = [
      { session: { id: "omi:1", source: "omi", title: "Quick note", startedAt: at(0), updatedAt: at(1) }, entries: [entry("omi:1:1", "omi:1", "Hi.")] },
      { session: { id: "omi:2", source: "omi", title: "Title only", startedAt: at(5), updatedAt: at(5) }, entries: [] },
      { session: { id: "obsidian:n", source: "obsidian", title: "Short note", startedAt: at(10), updatedAt: at(10) }, entries: [entry("obsidian:n:1", "obsidian:n", "One line.", { kind: "answer" })] },
      { session: { id: "pdf:doc", source: "obsidian", title: "Manual.pdf", startedAt: at(15), updatedAt: at(15), tags: ["pdf"] }, entries: [] },
      { session: helix("recapped", 100, { title: "Orin check-in", overview: "A short check-in.", recap: { origin: "model", generatedAt: at(101), model: "m" } }), entries: [entry("recapped:1", "recapped", "Okay.")] },
      { session: helix("model-title", 200, { title: "Orin check-in", recap: { origin: "model", generatedAt: at(201) } }), entries: [tap("model-title:q", "model-title"), answer("model-title:a", "model-title")] },
      { session: helix("named", 300, { title: "My own title" }), entries: [entry("named:1", "named", "Okay.")] },
      { session: helix("summarised", 400, { summary: ["The copilot kept this."] }), entries: [entry("summarised:1", "summarised", "Okay.")] },
      { session: helix("notes", 500, { todos: [{ id: "t1", text: "Buy milk", done: false, createdAt: at(500), updatedAt: at(500) }] }), entries: [entry("notes:1", "notes", "Okay.")] },
      { session: helix("typed", 600), entries: [entry("typed:q", "typed", "What is the lead time on Thor?", { kind: "question", speaker: "You" }), answer("typed:a", "typed", "Six to ten weeks.")] },
    ];
    expect(proposeHistoryCleanup(records)).toEqual({ removals: [], merges: [] });
  });
  it("proposes sessions that hold only tapped answers and no transcript", () => {
    const proposal = proposeHistoryCleanup([
      { session: helix("taps", 0), entries: [tap("taps:q1", "taps"), tap("taps:q2", "taps"), answer("taps:a1", "taps"), tap("taps:q3", "taps", "Whole conversation"), answer("taps:a2", "taps")] },
      { session: helix("spoken", 100), entries: [entry("spoken:t", "spoken", LONG), tap("spoken:q", "spoken"), answer("spoken:a", "spoken")] },
    ]);
    expect(proposal.removals.map(item => [item.id, item.reason])).toEqual([["taps", "answers-only"]]);
  });
  it("skips the sessions it is told to leave alone", () => {
    const records = [{ session: helix("live", 0), entries: [entry("live:1", "live", "Hi.")] }, { session: helix("old", 100), entries: [entry("old:1", "old", "Hi.")] }];
    expect(proposeHistoryCleanup(records, { skip: ["live"] }).removals.map(item => item.id)).toEqual(["old"]);
  });
  it("proposes the smaller copy of a duplicate import, and an Omi copy of a Helix session", () => {
    const note = (id: string, title: string, start: number, lines: number): CleanupRecord => ({ session: { id, source: "obsidian", title, startedAt: at(start), updatedAt: at(start) },
      entries: Array.from({ length: lines }, (_, i) => entry(`${id}:${i}`, id, `Line ${i} of the note.`)) });
    // Omi keeps the start time to the second: the Helix session started 400 ms later.
    const sent = helix("session_sent", 300, { startedAt: new Date(T0 + 300 * 60_000 + 400).toISOString(), title: "Orin supply escalation", recap: { origin: "model", generatedAt: at(310) }, endedAt: at(310) });
    const proposal = proposeHistoryCleanup([
      note("obsidian:a", "Weekly Sync", 0, 1), note("obsidian:a-2", "weekly  sync!", 0, 3),
      note("obsidian:b", "Weekly sync", 60, 2), // another day: not a duplicate
      { session: { id: "omi:x", source: "omi", title: "Weekly sync", startedAt: at(0), updatedAt: at(0) }, entries: [] }, // another source
      talk(sent),
      { session: { id: "omi:back", source: "omi", title: "Orin Supply Escalation", startedAt: "2026-11-19T22:00:00Z", updatedAt: at(311) }, entries: [entry("omi:back:1", "omi:back", LONG)] },
      { session: { id: "omi:other", source: "omi", title: "Orin supply escalation", startedAt: at(900), updatedAt: at(901) }, entries: [] }, // same title, another time
    ]);
    expect(proposal.removals).toEqual([
      { id: "obsidian:a", reason: "duplicate-import", source: "obsidian", title: "Weekly Sync", startedAt: at(0), duplicateOf: "obsidian:a-2" },
      { id: "omi:back", reason: "duplicate-import", source: "omi", title: "Orin Supply Escalation", startedAt: "2026-11-19T22:00:00Z", duplicateOf: "session_sent" },
    ]);
  });
  it("does not call an Omi copy a duplicate of a Helix session that is itself proposed for removal", () => {
    const stray = helix("stray", 0, { title: "Evening conversation", recap: { origin: "fallback", generatedAt: at(1) } });
    const proposal = proposeHistoryCleanup([
      { session: stray, entries: [entry("stray:1", "stray", "Okay.")] },
      { session: { id: "omi:copy", source: "omi", title: "Evening conversation", startedAt: at(0), updatedAt: at(1) }, entries: [] },
    ]);
    expect(proposal.removals.map(item => item.id)).toEqual(["stray"]);
  });
  it("offers a merge only for two Helix sessions minutes apart, and never as a removal", () => {
    const a = helix("a", 0, { endedAt: at(5) }), b = helix("b", 12), c = helix("c", 40, { endedAt: at(45) }), d = helix("d", 56);
    const proposal = proposeHistoryCleanup([talk(d), talk(c), talk(b), talk(a),
      { session: { id: "omi:near", source: "omi", title: "Near", startedAt: at(6), updatedAt: at(7) }, entries: [entry("omi:near:1", "omi:near", LONG)] }]);
    expect(CLEANUP_MERGE_GAP_MS).toBe(10 * 60_000);
    expect(proposal.removals).toEqual([]);
    // a ends 17:05, b starts 17:12 (7 min): offered. b's last line 17:13, c starts 17:40: not. c ends 17:45, d starts 17:56 (11 min): not.
    expect(proposal.merges).toEqual([{ fromId: "b", intoId: "a", fromTitle: expect.any(String), intoTitle: expect.any(String), fromStartedAt: at(12), intoStartedAt: at(0), gapMs: 7 * 60_000 }]);
    expect(proposeHistoryCleanup([talk(c), talk(d)], { mergeGapMs: 11 * 60_000 }).merges.map(merge => [merge.intoId, merge.fromId])).toEqual([["c", "d"]]);
  });
  it("measures the pause from the last saved line when the session never ended cleanly", () => {
    const a = helix("a", 0), b = helix("b", 30);
    expect(proposeHistoryCleanup([talk(a, 25), talk(b)]).merges.map(merge => merge.gapMs)).toEqual([5 * 60_000]);
    expect(proposeHistoryCleanup([talk(a, 2), talk(b)]).merges).toEqual([]);
  });
});

describe("v0.16 remove-all scopes", () => {
  const sessions: HistorySession[] = [helix("h1", 0), helix("h2", 10),
    { id: "omi:1", source: "omi", title: "Omi", startedAt: at(0), updatedAt: at(0) },
    { id: "obsidian:n", source: "obsidian", title: "Note", startedAt: at(0), updatedAt: at(0) },
    { id: "pdf:doc", source: "obsidian", title: "Manual.pdf", startedAt: at(0), updatedAt: at(0), tags: ["pdf"] }];
  it("lists only the sessions of the chosen source; PDFs belong to everything only", () => {
    expect(historyScopeIds(sessions, "helix")).toEqual(["h1", "h2"]);
    expect(historyScopeIds(sessions, "omi")).toEqual(["omi:1"]);
    expect(historyScopeIds(sessions, "obsidian")).toEqual(["obsidian:n"]);
    expect(historyScopeIds(sessions, "all")).toEqual(["h1", "h2", "omi:1", "obsidian:n", "pdf:doc"]);
    expect(historyScopeIds(sessions, "helix", ["h2"])).toEqual(["h1"]);
    expect(historyScopeIds(sessions, "all", ["h2"])).not.toContain("h2");
  });
});

describe("v0.16 saved taps and cut-off answers", () => {
  it("recognises a saved tap by its label", () => {
    expect(contextAskScope({ kind: "question", speaker: "Local context" })).toBe("recent");
    expect(contextAskScope({ kind: "question", speaker: " whole conversation " })).toBe("whole");
    expect(contextAskScope({ kind: "question", speaker: "You" })).toBeUndefined();
    expect(contextAskScope({ kind: "answer", speaker: "Local context" })).toBeUndefined();
  });
  it("keeps the partial mark of a cut-off answer through a save and a load", async () => {
    const storage = disk(), store = new LocalHistoryStore(storage);
    await store.load();
    await store.upsertSession(helix("s", 0));
    await store.upsertEntries([
      entry("s:a1", "s", "The lead time is", { kind: "answer", speaker: "Helix", metadata: { model: "m", partial: "true", authorization: "never stored" } }),
      entry("s:a2", "s", "Complete answer.", { kind: "answer", speaker: "Helix", metadata: { model: "m" } }),
    ]);
    const reloaded = new LocalHistoryStore(storage);
    await reloaded.load();
    const saved = reloaded.getEntries("s");
    expect(saved.find(item => item.id === "s:a1")!.metadata).toEqual({ model: "m", partial: "true" });
    expect(saved.find(item => item.id === "s:a2")!.metadata).toEqual({ model: "m" });
    // The single-file export keeps it too.
    expect(JSON.parse(reloaded.exportJson()).entries.find((item: HistoryEntry) => item.id === "s:a1").metadata.partial).toBe("true");
  });
});
