import { describe, expect, it } from "vitest";
import {
  LocalHistoryStore, MarkdownImportPlanner, importOmiConversations, markdownToSession, proposeHistoryCleanup,
  type CleanupRecord, type HistoryEntry, type HistorySession,
} from "../src/index.js";

const key = "test-only-placeholder";
function disk() {
  const values = new Map<string, string>();
  return { values, getLocalStorage: async (name: string) => values.get(name) ?? "", setLocalStorage: async (name: string, value: string) => { values.set(name, value); return true; } };
}
async function open() { const store = new LocalHistoryStore(disk()); await store.load(); return store; }
const at = "2026-11-10T10:00:00.000Z";
const entry = (id: string, sessionId: string, text: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({ id, sessionId, kind: "transcript", text, occurredAt: at, speaker: "Other speaker", ...extra });
function conversation(id: string, extra: Record<string, unknown> = {}) {
  return { id, created_at: "2026-09-01T00:00:00Z", started_at: "2026-09-01T00:00:00Z", finished_at: "2026-09-01T00:01:00Z",
    structured: { title: `Launch ${id}`, overview: "The launch moved to October. Ada owns the checklist.", action_items: [{ description: "Order the Jetson boards" }], category: "work" },
    transcript_segments: [{ id: "seg-0", text: "The launch moved to October.", start: 12, end: 15, speaker: "SPEAKER_00", speaker_name: "Ada", speaker_id: 0, is_user: false }], ...extra };
}
const omi = (store: LocalHistoryStore, body: unknown[], extra: Record<string, unknown> = {}) => importOmiConversations({ key, store, fetch: async () => Response.json(body), ...extra });

describe("v0.16 fixes: clean-up proposal", () => {
  const note = (id: string, title: string, lines: string[], extra: Partial<HistorySession> = {}): CleanupRecord => ({
    session: { id, source: "obsidian", title, startedAt: "2026-11-03T00:00:00.000Z", updatedAt: "2026-11-03T00:00:00.000Z", ...extra },
    entries: lines.map((text, i) => entry(`${id}:${i}`, id, text)) });

  it("does not call two different notes with one title and one day duplicates", () => {
    const proposal = proposeHistoryCleanup([
      note("obsidian:2026-11-03%20Standup", "Standup", ["Work: the Orin order slipped to March.", "Kan escalates with the distributor.", "Review the budget."]),
      note("obsidian:2026-11-03%20Standup:n2", "Standup", ["Personal: book the dentist.", "Call the landlord about the heating."]),
    ]);
    expect(proposal.removals).toEqual([]);
  });
  it("still proposes a copy whose every line is in the copy that stays", () => {
    const proposal = proposeHistoryCleanup([
      note("obsidian:a", "Standup", ["Work: the Orin order slipped to March."]),
      note("obsidian:b", "standup!", ["Work: the Orin order slipped to March.", "Kan escalates with the distributor."]),
    ]);
    expect(proposal.removals.map(item => [item.id, item.reason, item.duplicateOf])).toEqual([["obsidian:a", "duplicate-import", "obsidian:b"]]);
  });
  it("keeps a copy without lines unless its summary is the same as the one that stays", () => {
    const same = proposeHistoryCleanup([note("omi:a", "Standup", [], { source: "omi", summary: ["One."] }), note("omi:b", "Standup", [], { source: "omi", summary: ["One."] })]);
    expect(same.removals).toHaveLength(1);
    const other = proposeHistoryCleanup([note("omi:a", "Standup", [], { source: "omi", summary: ["One."] }), note("omi:b", "Standup", [], { source: "omi", summary: ["Two."] })]);
    expect(other.removals).toEqual([]);
  });

  const helix = (id: string): HistorySession => ({ id, source: "helix", title: `Helix · ${at}`, startedAt: at, updatedAt: at });
  it("does not call a few Chinese, Japanese or Korean sentences \"almost nothing said\"", () => {
    const zh = "今天下午三点开会，记得带上上周的预算报告和供应商报价单";
    expect(zh.length).toBeLessThan(40);
    const proposal = proposeHistoryCleanup([
      { session: helix("zh"), entries: [entry("zh:1", "zh", zh)] },
      { session: helix("ko"), entries: [entry("ko:1", "ko", "오늘 오후 세 시에 회의가 있습니다 예산 보고서를 가져오세요")] },
      { session: helix("short-zh"), entries: [entry("short-zh:1", "short-zh", "好的。")] },
      { session: helix("stray"), entries: [entry("stray:1", "stray", "Okay.")] },
    ]);
    expect(proposal.removals.map(item => [item.id, item.reason])).toEqual([["short-zh", "little-speech"], ["stray", "little-speech"]]);
  });
  it("keeps a short spoken question that Helix answered or checked; a tapped answer alone protects nothing", () => {
    const question = "What's the lead time on Thor?";
    const proposal = proposeHistoryCleanup([
      { session: helix("asked"), entries: [entry("asked:1", "asked", question, { speaker: "You" }), entry("asked:q", "asked", question, { kind: "question", speaker: "You" }), entry("asked:a", "asked", "About twelve weeks.", { kind: "answer", speaker: "Helix" })] },
      { session: helix("checked"), entries: [entry("checked:1", "checked", "Thor ships in two weeks."), entry("checked:f", "checked", "Not supported: the lead time is twelve weeks.", { kind: "fact-check", speaker: "Helix" })] },
      { session: helix("tapped"), entries: [entry("tapped:1", "tapped", "Okay."), entry("tapped:q", "tapped", "Using the recent context, answer.", { kind: "question", speaker: "Local context" }), entry("tapped:a", "tapped", "Say: hello.", { kind: "answer", speaker: "Helix" })] },
      { session: helix("unanswered"), entries: [entry("unanswered:1", "unanswered", "Is this on?"), entry("unanswered:q", "unanswered", "Is this on?", { kind: "question", speaker: "Other speaker" })] },
    ]);
    expect(proposal.removals.map(item => [item.id, item.reason])).toEqual([["tapped", "little-speech"], ["unanswered", "little-speech"]]);
  });
});

describe("v0.16 fixes: Omi import", () => {
  it("keeps a summary, key facts, people and tags added on the phone when Omi supplies none", async () => {
    const store = await open();
    const bare = conversation("a", { structured: undefined, transcript_segments: [{ id: "seg-0", text: "The launch moved to October.", start: 12, speaker: "SPEAKER_00" }] });
    await omi(store, [bare]);
    await store.updateSessionKnowledge("omi:a", { summary: ["Generated bullet."], keyFacts: ["Generated fact."], people: [{ name: "Ada" }], tags: ["launch"] });
    await store.updateSessionRecap("omi:a", { overview: "Generated overview.", recap: { origin: "model", generatedAt: at } });
    await expect(omi(store, [bare])).resolves.toMatchObject({ imported: 1 });
    expect(store.getSession("omi:a")).toMatchObject({ summary: ["Generated bullet."], keyFacts: ["Generated fact."], people: [{ name: "Ada" }], tags: ["launch"], overview: "Generated overview." });
    // What Omi does supply still wins.
    await omi(store, [conversation("a")]);
    expect(store.getSession("omi:a")).toMatchObject({ summary: ["The launch moved to October.", "Ada owns the checklist."], keyFacts: ["Order the Jetson boards"], tags: ["work"] });
  });

  it("\"Summaries only\" does not delete a transcript that is already saved, nor the people found in it", async () => {
    const store = await open();
    await omi(store, [conversation("a"), conversation("b")]);
    expect(store.getSession("omi:a")?.people).toEqual([{ name: "Ada" }]);
    const short = (id: string, overview: string) => { const { transcript_segments: _none, ...rest } = conversation(id); return { ...rest, structured: { ...rest.structured, overview } }; };
    await expect(omi(store, [short("a", "The launch moved to November."), short("b", "The launch moved to October. Ada owns the checklist."), short("c", "A new one.")], { summariesOnly: true })).resolves.toEqual({ imported: 3, pages: 1 });
    expect(store.getEntries("omi:a").map(item => [item.kind, item.text])).toEqual([["answer", "The launch moved to November."], ["transcript", "The launch moved to October."]]);
    expect(store.getSession("omi:a")).toMatchObject({ summary: ["The launch moved to November."], people: [{ name: "Ada" }] });
    expect(store.getEntries("omi:b").filter(item => item.kind === "transcript")).toHaveLength(1);
    expect(store.getEntries("omi:c").map(item => item.kind)).toEqual(["answer"]); // new in this import: the short form
  });

  it("skips a conversation Helix sent only while the Helix session is still on this phone", async () => {
    const store = await open();
    await store.upsertSession({ id: "session_here", source: "helix", title: "Calibration sync", startedAt: "2026-09-05T09:00:00.000Z", updatedAt: "2026-09-05T09:10:00.000Z" });
    await store.upsertEntries([entry("t1", "session_here", "The rig ships on Friday.", { occurredAt: "2026-09-05T09:00:03.000Z" })]);
    const result = await omi(store, [
      conversation("here", { started_at: "2026-09-02T00:00:00Z", external_data: { client_session_id: "helix-session_here" } }), // by id, whatever the start time
      conversation("text-here", { started_at: "2026-09-05T09:00:00Z", external_data: { text_source_spec: "helix" } }), // no id in the marker: by start time
      conversation("gone", { started_at: "2026-09-03T00:00:00Z", external_data: { client_session_id: "helix-session_removed" } }),
      conversation("text-gone", { started_at: "2026-09-04T00:00:00Z", external_data: { text_source_spec: "helix" } }),
    ]);
    expect(result).toEqual({ imported: 2, pages: 1, skipped: 2, skippedHelix: 2 });
    expect(store.listSessions().filter(item => item.source === "omi").map(item => item.id).sort()).toEqual(["omi:gone", "omi:text-gone"]);
  });
});

describe("v0.16 fixes: notes with one plain file name across imports", () => {
  const note = (body: string, front = "") => `${front ? `---\n${front}\n---\n` : ""}# Untitled\n\n${body}\n`;
  const X = "Orin lead time is twelve weeks.\n\nKan escalates with the distributor on Monday.\n\nBudget review moves to March.";
  const Y = "Dentist appointment on Thursday afternoon.\n\nCall the landlord about the broken heating.\n\nRenew the passport before June.";
  async function save(store: LocalHistoryStore, text: string, name = "Untitled.md") {
    const placed = new MarkdownImportPlanner(store).place(markdownToSession(text, name));
    await store.replaceSession(placed.note.session, placed.note.entries, placed.supersedes ? { supersedes: placed.supersedes } : {});
    return placed;
  }
  const texts = (store: LocalHistoryStore, id: string) => store.getEntries(id).map(item => item.text);

  it("a different note imported later does not replace the saved one", async () => {
    const store = await open();
    expect((await save(store, note(X))).note.session.id).toBe("obsidian:Untitled");
    const second = await save(store, note(Y));
    expect(second.note.session.id).toBe("obsidian:Untitled:n2");
    expect(texts(store, "obsidian:Untitled")[0]).toBe("Orin lead time is twelve weeks.");
    expect(texts(store, "obsidian:Untitled:n2")[0]).toBe("Dentist appointment on Thursday afternoon.");
    // A third different note takes the next free id, also when :n2 was removed meanwhile.
    expect((await save(store, note("Recipe: two eggs, flour and a pinch of salt.\n\nBake for twenty minutes."))).note.session.id).toBe("obsidian:Untitled:n3");
  });
  it("an edited note imported again lands on its own saved copy, whichever id that has", async () => {
    const store = await open();
    await save(store, note(X)); await save(store, note(Y));
    const editedY = await save(store, note(Y.replace("Thursday afternoon", "Friday morning").replace("\n\nRenew the passport before June.", "")));
    expect(editedY.note.session.id).toBe("obsidian:Untitled:n2");
    expect(texts(store, "obsidian:Untitled:n2")).toEqual(["Dentist appointment on Friday morning.", "Call the landlord about the broken heating."]); // no stale lines
    expect(texts(store, "obsidian:Untitled")).toHaveLength(3); // X is untouched
    const editedX = await save(store, note(`${X}\n\nOne more line.`));
    expect(editedX.note.session.id).toBe("obsidian:Untitled");
    expect(store.listSessions()).toHaveLength(2);
  });
  it("both notes re-imported in one pick keep their places", async () => {
    const store = await open();
    await save(store, note(X)); await save(store, note(Y));
    const planner = new MarkdownImportPlanner(store);
    // Picked in the other order this time.
    expect(planner.place(markdownToSession(note(`${Y}\n\nNew line.`), "Untitled.md")).note.session.id).toBe("obsidian:Untitled:n2");
    expect(planner.place(markdownToSession(note(X), "Untitled.md")).note.session.id).toBe("obsidian:Untitled");
  });
  it("two different notes that share a file name and a frontmatter date are both kept across imports", async () => {
    const store = await open();
    const first = await save(store, note(X, "date: 2026-11-03"), "Meeting.md"), second = await save(store, note(Y, "date: 2026-11-03"), "Meeting.md");
    expect(second.note.session.id).not.toBe(first.note.session.id);
    expect(store.listSessions()).toHaveLength(2);
    // A frontmatter id names the note: it is replaced in place even when rewritten.
    const named = await save(store, note(X, "id: abc-1"), "Meeting.md"), rewritten = await save(store, note(Y, "id: abc-1"), "Meeting.md");
    expect(rewritten.note.session.id).toBe(named.note.session.id);
    expect(store.listSessions()).toHaveLength(3);
  });
  it("a different dated note does not take the place of a note saved under the old plain id", async () => {
    const store = await open();
    await save(store, note(X)); // obsidian:Untitled, as an earlier version saved it
    const other = new MarkdownImportPlanner(store).place(markdownToSession(note(Y, "date: 2026-11-03"), "Untitled.md"));
    expect(other.supersedes).toBeUndefined();
    const same = new MarkdownImportPlanner(store).place(markdownToSession(note(X, "date: 2026-11-03"), "Untitled.md"));
    expect(same.supersedes).toBe("obsidian:Untitled");
  });
});
