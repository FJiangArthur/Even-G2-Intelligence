import { describe, expect, it, vi } from "vitest";
import {
  HISTORY_INDEX_KEY, IMPORT_HISTORY_MAX_BYTES, IMPORT_STORAGE_FULL, LIVE_HISTORY_MAX_BYTES, LocalHistoryStore, MarkdownImportPlanner,
  importOmiConversations, isImportStorageFull, markdownToSession, renameMarkdownSession,
  type HistoryEntry, type HistorySession, type OmiImportProgress,
} from "../src/index.js";

const key = "test-only-placeholder";
function disk(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { values, getLocalStorage: async (name: string) => values.get(name) ?? "", setLocalStorage: vi.fn(async (name: string, value: string) => { values.set(name, value); return true; }) };
}
async function open(d = disk(), options = {}) { const store = new LocalHistoryStore(d, options); await store.load(); return { store, disk: d }; }
const at = "2026-11-10T10:00:00.000Z";
const session = (id: string, source: HistorySession["source"], extra: Partial<HistorySession> = {}): HistorySession => ({ id, source, title: id, startedAt: at, updatedAt: at, ...extra });
const line = (id: string, sessionId: string, text: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({ id, sessionId, kind: "transcript", text, occurredAt: at, speaker: "Them", ...extra });
/** About `bytes` of entries for one session. */
function bulk(sessionId: string, bytes: number): HistoryEntry[] {
  const text = "calibration rig lead time ".repeat(160); // 4160 chars
  return Array.from({ length: Math.ceil(bytes / (text.length + 120)) }, (_, i) => line(`${sessionId}:e${i}`, sessionId, text));
}
function conversation(id: string, extra: Record<string, unknown> = {}) {
  return { id, created_at: "2026-09-01T00:00:00Z", started_at: "2026-09-01T00:00:00Z", finished_at: "2026-09-01T00:01:00Z",
    structured: { title: `Launch ${id}`, overview: "The launch moved to October. Ada owns the checklist.", action_items: [{ description: "Order the Jetson boards" }], category: "work" },
    transcript_segments: [{ id: "seg-0", text: "The launch moved to October.", start: 12, end: 15, speaker: "SPEAKER_00", speaker_id: 0, is_user: false }], ...extra };
}
const omi = (store: LocalHistoryStore, body: unknown[], extra: Record<string, unknown> = {}) => importOmiConversations({ key, store, fetch: async () => Response.json(body), ...extra });

describe("v0.16 storage budgets: imports cannot stop a live save", () => {
  it("states the two budgets", () => {
    expect(LIVE_HISTORY_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(IMPORT_HISTORY_MAX_BYTES).toBe(5 * 1024 * 1024);
  });

  it("a full import budget refuses the next import with its own message and still saves live lines", async () => {
    const { store, disk: d } = await open();
    await store.replaceSession(session("obsidian:big", "obsidian"), bulk("obsidian:big", 4.7 * 1024 * 1024));
    // The next import does not fit: it is refused whole, with the import message, and nothing of it exists.
    const refused = store.replaceSession(session("omi:more", "omi"), bulk("omi:more", 0.6 * 1024 * 1024));
    await expect(refused).rejects.toThrow(IMPORT_STORAGE_FULL);
    expect(isImportStorageFull(await refused.catch(error => error))).toBe(true);
    expect(store.getSession("omi:more")).toBeUndefined();
    expect(store.entryCount("obsidian:big")).toBeGreaterThan(1000);
    // Live history is under its own budget: it saves, although the archive as a whole is past 5 MiB.
    await store.upsertSession(session("session_live", "helix"));
    await store.upsertEntries(bulk("session_live", 1.2 * 1024 * 1024));
    await store.upsertEntries([line("session_live:last", "session_live", "One more live line.")]);
    const usage = store.storageUsage();
    expect(usage.imports.bytes).toBeGreaterThan(4.6 * 1024 * 1024); expect(usage.imports.bytes).toBeLessThanOrEqual(usage.imports.maxBytes);
    expect(usage.live.bytes).toBeGreaterThan(1.1 * 1024 * 1024);
    expect(usage.live.bytes + usage.imports.bytes).toBeGreaterThan(5 * 1024 * 1024);
    // Load path: the larger archive loads again, live lines included, and keeps saving.
    const again = new LocalHistoryStore(disk(Object.fromEntries(d.values))); await again.load();
    expect(again.getEntries("session_live").at(-1)?.text).toBe("One more live line.");
    await again.upsertEntries([line("session_live:after", "session_live", "Saved after a restart.")]);
    await expect(again.replaceSession(session("omi:more", "omi"), bulk("omi:more", 0.6 * 1024 * 1024))).rejects.toThrow(IMPORT_STORAGE_FULL);
  });

  it("an import refused inside a coalesced live batch fails alone: the live lines of that batch are saved", async () => {
    const { store } = await open(disk(), { writeDelayMs: 60_000 });
    const filled = store.replaceSession(session("obsidian:big", "obsidian"), bulk("obsidian:big", 4.8 * 1024 * 1024));
    await store.flush(); await filled;
    const live = [store.upsertSession(session("session_live", "helix")), store.upsertEntries([line("l1", "session_live", "First live line.")])];
    const refused = store.replaceSession(session("omi:more", "omi"), bulk("omi:more", 0.5 * 1024 * 1024));
    const later = store.upsertEntries([line("l2", "session_live", "Second live line.")]);
    await expect(refused).rejects.toThrow(IMPORT_STORAGE_FULL);
    await store.flush(); await Promise.all([...live, later]);
    expect(store.getEntries("session_live").map(entry => entry.text)).toEqual(["First live line.", "Second live line."]);
    expect(store.getSession("omi:more")).toBeUndefined();
  });

  it("live history keeps its own 5 MiB limit and message; imports already over their budget still load and can be removed", async () => {
    const { store } = await open();
    await store.upsertSession(session("session_live", "helix"));
    await store.upsertEntries(bulk("session_live", 4.9 * 1024 * 1024));
    await expect(store.upsertEntries(bulk("session_live", 0.3 * 1024 * 1024).map(entry => ({ ...entry, id: `x${entry.id}` })))).rejects.toThrow(/Local history exceeds the 5 MiB storage limit/u);
    // An import still fits beside full live history.
    await store.replaceSession(session("obsidian:note", "obsidian"), [line("obsidian:note:0", "obsidian:note", "A note.")]);
    expect(store.getSession("obsidian:note")).toBeDefined();
    // An index that lists imports past their budget (written by hand here) loads; removing one works.
    const big = JSON.stringify(bulk("omi:a", 2.9 * 1024 * 1024)), other = JSON.stringify(bulk("omi:b", 2.9 * 1024 * 1024));
    const over = disk({ [HISTORY_INDEX_KEY]: JSON.stringify({ version: 2, sessions: [session("omi:a", "omi"), session("omi:b", "omi")], shards: { "omi:a": { bytes: big.length, entries: JSON.parse(big).length }, "omi:b": { bytes: other.length, entries: JSON.parse(other).length } } }),
      [`${HISTORY_INDEX_KEY}.s.${encodeURIComponent("omi:a")}`]: big, [`${HISTORY_INDEX_KEY}.s.${encodeURIComponent("omi:b")}`]: other });
    const loaded = new LocalHistoryStore(over); await loaded.load();
    expect(loaded.storageUsage().imports.bytes).toBeGreaterThan(IMPORT_HISTORY_MAX_BYTES);
    await loaded.upsertSession(session("session_live", "helix")); await loaded.upsertEntries([line("l1", "session_live", "Live still saves.")]);
    await expect(loaded.replaceSession(session("omi:c", "omi"), [line("omi:c:0", "omi:c", "No room.")])).rejects.toThrow(IMPORT_STORAGE_FULL);
    await loaded.deleteSession("omi:b");
    await loaded.replaceSession(session("omi:c", "omi"), [line("omi:c:0", "omi:c", "Room again.")]);
    expect(loaded.getEntries("omi:c")).toHaveLength(1);
  });

  it("replaceSession can take the place of a note saved under an old id in one save, never of a live session", async () => {
    const { store } = await open();
    await store.replaceSession(session("obsidian:Untitled", "obsidian"), [line("obsidian:Untitled:0", "obsidian:Untitled", "Old copy.")]);
    await store.upsertSession(session("session_live", "helix"));
    await store.replaceSession(session("obsidian:Untitled:habc", "obsidian"), [line("obsidian:Untitled:habc:0", "obsidian:Untitled:habc", "New copy.")], { supersedes: "obsidian:Untitled" });
    expect(store.listSessions().map(item => item.id).sort()).toEqual(["obsidian:Untitled:habc", "session_live"]);
    await store.replaceSession(session("obsidian:x", "obsidian"), [], { supersedes: "session_live" });
    expect(store.getSession("session_live")).toBeDefined();
  });
});

describe("v0.16 Omi import", () => {
  it("labels the wearer \"You\" and raw SPEAKER_00-style voices \"Speaker 1\", \"Speaker 2\" (1-based)", async () => {
    const { store } = await open();
    await omi(store, [conversation("a", { participants: [{ speaker_id: 7, is_user: true }], transcript_segments: [
      { text: "I will bring the rig.", start: 0, speaker: "SPEAKER_01", speaker_id: 1, is_user: true },
      { text: "Thanks.", start: 2, speaker: "SPEAKER_00", speaker_id: 0, is_user: false },
      { text: "When?", start: 3, speaker: "speaker_02", speaker_id: 2 },
      { text: "Friday.", start: 4, speaker: "SPEAKER_07", speaker_id: 7 },
      { text: "Good.", start: 5, speaker: "SPEAKER_03", speaker_name: "Ada", speaker_id: 3 },
      { text: "No label.", start: 6, speaker_id: 4 },
    ] })]);
    expect(store.getEntries("omi:a").filter(entry => entry.kind === "transcript").map(entry => entry.speaker)).toEqual(["You", "Speaker 1", "Speaker 3", "You", "Ada", "Speaker 5"]);
    expect(store.getSession("omi:a")?.people).toEqual([{ name: "Ada" }]);
  });

  it("accepts a missing or null `structured` and other timestamp forms instead of dropping the conversation", async () => {
    const { store } = await open();
    const segments = [{ text: "Hello there.", start: 1 }];
    const result = await omi(store, [
      { id: "none", started_at: "2026-09-01 08:30:00", finished_at: "2026-09-01 08:40:00", transcript_segments: segments },
      { id: "null", structured: null, created_at: "2026-09-02T08:30:00.123456", transcript_segments: segments },
      { id: "epoch", structured: {}, started_at: 1788251400, finished_at: 1788251460000, transcript_segments: segments },
      { id: "offset", structured: { title: "Offset" }, started_at: "2026-09-03T10:30+0200", finished_at: "2026-09-03 10:45:00+02:00", transcript_segments: segments },
      { id: "digits", structured: {}, created_at: "1788251400", transcript_segments: segments },
    ]);
    expect(result).toEqual({ imported: 5, pages: 1 });
    const saved = Object.fromEntries(store.listSessions().map(item => [item.id, item]));
    expect(saved["omi:none"]).toMatchObject({ title: "Omi conversation", startedAt: "2026-09-01T08:30:00.000Z", updatedAt: "2026-09-01T08:40:00.000Z" });
    expect(saved["omi:null"]).toMatchObject({ startedAt: "2026-09-02T08:30:00.123Z" });
    expect(saved["omi:epoch"]).toMatchObject({ startedAt: new Date(1788251400000).toISOString(), updatedAt: new Date(1788251460000).toISOString() });
    expect(saved["omi:offset"]).toMatchObject({ startedAt: "2026-09-03T08:30:00.000Z", updatedAt: "2026-09-03T08:45:00.000Z" });
    expect(saved["omi:digits"]).toMatchObject({ startedAt: new Date(1788251400000).toISOString() });
    // Still strict about what is not a time at all.
    for (const bad of ["yesterday", "2026-02-30T00:00:00Z", "2026-09-01T25:00:00Z", "", -5, {}]) {
      await expect(omi(store, [conversation("bad", { started_at: bad })])).rejects.toThrow(/invalid conversation response/u);
    }
  });

  it("skips conversations that Helix itself sent to Omi: by marker, and by start time with title or first line for older uploads", async () => {
    const { store } = await open();
    await store.upsertSession(session("session_talk", "helix", { title: "Calibration sync", startedAt: "2026-09-05T09:00:00.000Z" }));
    await store.upsertEntries([line("t1", "session_talk", "The rig ships on Friday.", { occurredAt: "2026-09-05T09:00:03.000Z" })]);
    // Fix pass: a marker skips only while the session it names (or one started at that moment) is still on this phone.
    await store.upsertSession(session("session_other", "helix")); await store.upsertSession(session("session_x", "helix"));
    const body = [
      conversation("marked", { external_data: { client_session_id: "helix-session_other" } }),
      conversation("marked-top", { client_session_id: "helix-session_x" }),
      conversation("text", { started_at: "2026-09-05T09:00:00Z", external_data: { text_source_spec: "helix" } }),
      conversation("same-title", { started_at: "2026-09-05T09:00:00Z", structured: { title: "Calibration Sync!" } }),
      conversation("same-line", { started_at: "2026-09-05T09:00:01Z", structured: { title: "Omi's own title" }, transcript_segments: [{ text: "The rig ships on Friday.", start: 0, speaker: "SPEAKER_00" }] }),
      conversation("integration", { started_at: "2026-09-05T09:00:00.500Z", source: "external_integration", structured: { title: "Another title" }, transcript_segments: [] }),
      // Kept: same moment but nothing else in common; and same title at another time.
      conversation("coincidence", { started_at: "2026-09-05T09:00:00Z", source: "omi", structured: { title: "Lunch" }, transcript_segments: [{ text: "Soup today.", start: 0 }] }),
      conversation("later", { started_at: "2026-09-06T09:00:00Z", structured: { title: "Calibration sync" } }),
    ];
    const progress: OmiImportProgress[] = [];
    const result = await omi(store, body, { onProgress: (item: OmiImportProgress) => progress.push(item) });
    expect(result).toEqual({ imported: 2, pages: 1, skipped: 6, skippedHelix: 6 });
    expect(store.listSessions().filter(item => item.source === "omi").map(item => item.id).sort()).toEqual(["omi:coincidence", "omi:later"]);
    expect(progress.at(-1)).toEqual(result);
  });

  it("\"Summaries only\" stores overview, key facts and action items, no transcript lines, and does not download transcripts", async () => {
    const { store: withTranscripts } = await open(), { store } = await open(), urls: string[] = [];
    const fetcher = async (url: string) => { urls.push(url); return Response.json([conversation("a"), conversation("b")]); };
    await importOmiConversations({ key, store: withTranscripts, fetch: fetcher });
    expect(withTranscripts.getEntries("omi:a").filter(entry => entry.kind === "transcript")).toHaveLength(1);
    const full = withTranscripts.storageUsage().imports.bytes;
    await expect(importOmiConversations({ key, store, fetch: fetcher, summariesOnly: true })).resolves.toEqual({ imported: 2, pages: 1 });
    expect(new URL(urls[0]!).searchParams.get("include_transcript")).toBe("true");
    expect(new URL(urls[1]!).searchParams.get("include_transcript")).toBe("false");
    expect(store.getEntries("omi:a").filter(entry => entry.kind === "transcript")).toEqual([]);
    expect(store.getEntries("omi:a").map(entry => entry.metadata?.origin)).toEqual(["omi-summary"]);
    expect(store.getSession("omi:a")).toMatchObject({ title: "Launch a", summary: ["The launch moved to October.", "Ada owns the checklist."], keyFacts: ["Order the Jetson boards"], tags: ["work"] });
    expect(store.storageUsage().imports.bytes).toBeLessThan(full);
    // Fix pass: a transcript saved by an earlier import is not deleted by a summaries-only import (v16-import-fixes.test.ts).
    await importOmiConversations({ key, store: withTranscripts, fetch: fetcher, summariesOnly: true });
    expect(withTranscripts.getEntries("omi:a").filter(entry => entry.kind === "transcript")).toHaveLength(1);
  });

  it("makes summaries, key facts and concepts of imported sessions searchable at answer time; live sessions are searched as before", async () => {
    const { store } = await open();
    await omi(store, [conversation("a")], { summariesOnly: true });
    await store.replaceSession(session("obsidian:Plan", "obsidian", { summary: ["Budget is sixty thousand."], concepts: ["Photogrammetry"] }), [line("obsidian:Plan:0", "obsidian:Plan", "Unrelated body text.")]);
    await store.upsertSession(session("session_live", "helix", { summary: ["Zeppelin maintenance was discussed."], keyFacts: ["Zeppelin hangar is in Friedrichshafen."] }));
    await store.upsertEntries([line("l1", "session_live", "We talked about the weather.")]);
    const ids = (query: string) => store.retrieve(query).map(hit => hit.entry.id);
    expect(ids("who owns the checklist")).toEqual(["omi:a:knowledge:summary"]);
    expect(ids("Jetson boards order")).toEqual(["omi:a:knowledge:keyFacts"]);
    expect(ids("photogrammetry")).toEqual(["obsidian:Plan:knowledge:concepts"]);
    const hit = store.retrieve("budget sixty thousand")[0]!;
    expect(hit).toMatchObject({ entry: { id: "obsidian:Plan:knowledge:summary", sessionId: "obsidian:Plan", kind: "transcript", speaker: "Summary", text: "Budget is sixty thousand." }, session: { id: "obsidian:Plan", source: "obsidian" } });
    expect(store.sessionIdOfEntry(hit.entry.id)).toBe("obsidian:Plan");
    // The same through the sliced search the live answer path uses.
    expect((await store.retrieveAsync("who owns the checklist")).items.map(item => item.entry.id)).toEqual(["omi:a:knowledge:summary"]);
    // Live Helix sessions: summary and key facts are not records (unchanged).
    expect(ids("zeppelin hangar")).toEqual([]);
    // Kept in step with the archive: an edited summary, then a removed session.
    await store.updateSessionKnowledge("obsidian:Plan", { summary: ["Budget is ninety thousand."] });
    expect(store.retrieve("budget")[0]?.entry.text).toBe("Budget is ninety thousand.");
    await store.deleteSession("obsidian:Plan");
    expect(ids("budget ninety thousand")).toEqual([]); expect(store.sessionIdOfEntry("obsidian:Plan:knowledge:summary")).toBeUndefined();
  });

  it("re-import replaces the conversation: lines gone from Omi do not stay, an unchanged one is not written again", async () => {
    const { store, disk: d } = await open();
    const long = conversation("a", { transcript_segments: [{ text: "First.", start: 0 }, { text: "Second.", start: 1 }, { text: "Third.", start: 2 }] });
    await omi(store, [long]);
    expect(store.getEntries("omi:a").filter(entry => entry.kind === "transcript")).toHaveLength(3);
    await store.updateSessionKnowledge("omi:a", { concepts: ["Added on this phone"] });
    const writes = d.setLocalStorage.mock.calls.length;
    await expect(omi(store, [long])).resolves.toEqual({ imported: 1, pages: 1 });
    expect(d.setLocalStorage.mock.calls.length).toBe(writes); // unchanged: nothing written
    await omi(store, [conversation("a", { transcript_segments: [{ text: "First, corrected.", start: 0 }] })]);
    expect(store.getEntries("omi:a").filter(entry => entry.kind === "transcript").map(entry => entry.text)).toEqual(["First, corrected."]);
    expect(store.getSession("omi:a")?.concepts).toEqual(["Added on this phone"]); // what the phone added is kept
  });

  it("when the import budget is full the old copy stays and the result says so, with counts", async () => {
    const { store } = await open();
    await omi(store, [conversation("a")]);
    await store.replaceSession(session("obsidian:big", "obsidian"), bulk("obsidian:big", 4.9 * 1024 * 1024));
    const huge = Array.from({ length: 400 }, (_, i) => ({ text: "A much longer version of the talk. ".repeat(20), start: i }));
    const progress: OmiImportProgress[] = [];
    const result = await omi(store, [conversation("a", { transcript_segments: huge }), conversation("b", { transcript_segments: huge })], { onProgress: (item: OmiImportProgress) => progress.push(item) });
    expect(result).toEqual({ imported: 0, pages: 0, failed: 2, failReason: IMPORT_STORAGE_FULL, storageFull: true });
    expect(progress.at(-1)).toEqual(result);
    expect(store.getEntries("omi:a").filter(entry => entry.kind === "transcript").map(entry => entry.text)).toEqual(["The launch moved to October."]);
    expect(store.getSession("omi:b")).toBeUndefined();
  });

  it("reads plain filter dates as days in the phone's time zone and reports progress within a page", async () => {
    const zone = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const { store } = await open(), urls: string[] = [], progress: OmiImportProgress[] = [];
      const body = Array.from({ length: 12 }, (_, i) => conversation(`c${i}`));
      await importOmiConversations({ key, store, startDate: "2026-11-01", endDate: "2026-11-02", onProgress: item => progress.push(item), fetch: async url => { urls.push(url); return Response.json(body); } });
      const params = new URL(urls[0]!).searchParams;
      expect(params.get("start_date")).toBe(new Date(2026, 10, 1, 0, 0, 0, 0).toISOString());
      expect(params.get("end_date")).toBe(new Date(2026, 10, 2, 23, 59, 59, 999).toISOString());
      // Los Angeles is not UTC: the day starts at 07:00Z (or 08:00Z), not at 00:00Z.
      expect(params.get("start_date")).not.toBe("2026-11-01T00:00:00.000Z");
      // A timestamp is used as given.
      await importOmiConversations({ key, store, startDate: "2026-11-01T05:00:00Z", fetch: async url => { urls.push(url); return Response.json([]); } });
      expect(new URL(urls[1]!).searchParams.get("start_date")).toBe("2026-11-01T05:00:00.000Z");
      // 12 conversations: counts after 5, 10 and 12, then the page.
      expect(progress.map(item => [item.imported, item.pages])).toEqual([[5, 0], [10, 0], [12, 0], [12, 1]]);
    } finally { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; }
  });

  it("saves a batch of conversations with one index write", async () => {
    const { store, disk: d } = await open();
    await omi(store, Array.from({ length: 5 }, (_, i) => conversation(`c${i}`)));
    expect(d.setLocalStorage.mock.calls.filter(([name]) => name === HISTORY_INDEX_KEY)).toHaveLength(1);
    expect(store.listSessions()).toHaveLength(5);
    expect(store.writeDelayMs).toBe(0);
  });
});

describe("v0.16 Markdown / Obsidian import", () => {
  const note = (body: string, front = "") => `${front ? `---\n${front}\n---\n` : ""}# Untitled\n\n${body}\n`;

  it("gives two notes with one file name their own ids when a path or frontmatter tells them apart; the id survives edits", () => {
    const a = markdownToSession(note("Alpha line."), "Untitled.md", { path: "Vault/Work/Untitled.md" });
    const b = markdownToSession(note("Beta line."), "Untitled.md", { path: "Vault/Home/Untitled.md" });
    expect(a.session.id).toMatch(/^obsidian:Untitled:h[0-9a-f]{8}$/u);
    expect(b.session.id).not.toBe(a.session.id);
    expect(a.legacySessionId).toBe("obsidian:Untitled"); expect(b.legacySessionId).toBe("obsidian:Untitled");
    expect(markdownToSession(note("Alpha line, edited.\n\nMore."), "Untitled.md", { path: "Vault/Work/Untitled.md" }).session.id).toBe(a.session.id);
    // Frontmatter id / created / date, in that order.
    const withId = markdownToSession(note("Body.", "id: 20261101-abc\ncreated: 2026-11-01\ndate: 2026-11-02"), "Untitled.md");
    expect(withId.session.id).toBe(markdownToSession(note("Edited body.", "id: 20261101-abc\ncreated: 2026-12-24"), "Untitled.md").session.id);
    expect(markdownToSession(note("Body.", "created: 2026-11-01"), "Untitled.md").session.id).not.toBe(markdownToSession(note("Body.", "created: 2026-11-05"), "Untitled.md").session.id);
    // Nothing to tell it apart: the plain name, as before. A Helix export keeps its session id.
    const bare = markdownToSession(note("Body."), "Untitled.md");
    expect(bare.session.id).toBe("obsidian:Untitled"); expect(bare.legacySessionId).toBeUndefined();
    expect(markdownToSession(note("Body.", "helix_session_id: session_abc\ndate: 2026-11-01"), "Untitled.md").session.id).toBe("obsidian:session_abc");
    // Entry ids follow the session id.
    expect(a.entries.every(entry => entry.sessionId === a.session.id && entry.id.startsWith(`${a.session.id}:`))).toBe(true);
    expect(renameMarkdownSession(a, "obsidian:x").entries.map(entry => entry.id)).toEqual(a.entries.map((_, i) => `obsidian:x:${i}`));
  });

  it("plans one import: duplicate base names both survive, the same text twice is one note, old ids are replaced", async () => {
    const { store } = await open();
    // Saved by an earlier version under the plain name.
    const old = markdownToSession(note("Old alpha line.\n\nA line that was removed later."), "Untitled.md");
    await store.replaceSession(old.session, old.entries);
    const planner = new MarkdownImportPlanner(store);
    const a = planner.place(markdownToSession(note("Alpha line."), "Untitled.md", { path: "Work/Untitled.md" }));
    const b = planner.place(markdownToSession(note("Beta line."), "Untitled.md", { path: "Home/Untitled.md" }));
    const again = planner.place(markdownToSession(note("Alpha line."), "Untitled.md", { path: "Work/Untitled.md" }));
    expect(a.supersedes).toBe("obsidian:Untitled");   // the first note that maps to the old id takes its place
    expect(b.supersedes).toBeUndefined(); expect(b.duplicate).toBeUndefined();
    expect(again.duplicate).toBe(true);
    for (const placed of [a, b]) await store.replaceSession(placed.note.session, placed.note.entries, placed.supersedes ? { supersedes: placed.supersedes } : {});
    expect(store.listSessions().map(item => item.id).sort()).toEqual([a.note.session.id, b.note.session.id].sort());
    expect(store.getEntries(a.note.session.id).map(entry => entry.text)).toEqual(["Alpha line."]); // no stale lines of the old copy
    // Second import of the same two files: replaced in place, nothing doubled.
    const next = new MarkdownImportPlanner(store);
    const a2 = next.place(markdownToSession(note("Alpha line."), "Untitled.md", { path: "Work/Untitled.md" }));
    expect(a2.note.session.id).toBe(a.note.session.id); expect(a2.supersedes).toBeUndefined();
  });

  it("numbers a second, different note with the same plain name inside one import, and never lets pasted text replace another note", async () => {
    const { store } = await open();
    const planner = new MarkdownImportPlanner(store);
    const first = planner.place(markdownToSession(note("One."), "Untitled.md")), second = planner.place(markdownToSession(note("Two."), "Untitled.md")), third = planner.place(markdownToSession(note("Three."), "Untitled.md"));
    expect([first, second, third].map(placed => placed.note.session.id)).toEqual(["obsidian:Untitled", "obsidian:Untitled:n2", "obsidian:Untitled:n3"]);
    expect(second.note.entries[0]).toMatchObject({ id: "obsidian:Untitled:n2:0", sessionId: "obsidian:Untitled:n2", text: "Two." });
    // Pasted notes: the id comes from the text, so two notes with one title are two sessions.
    const p1 = markdownToSession("# Ideas\n\nFirst idea.\n", "Ideas.md", { pasted: true }), p2 = markdownToSession("# Ideas\n\nAnother idea.\n", "Ideas.md", { pasted: true });
    expect(p1.session.id).not.toBe(p2.session.id);
    expect(markdownToSession("# Ideas\n\nFirst idea.\n", "Ideas.md", { pasted: true }).session.id).toBe(p1.session.id);
    // An old pasted note under the plain title: only the very same text takes its place.
    const legacy = markdownToSession("# Ideas\n\nFirst idea.\n", "Ideas.md");
    await store.replaceSession(legacy.session, legacy.entries);
    const pastes = new MarkdownImportPlanner(store);
    expect(pastes.place(p2, { pasted: true }).supersedes).toBeUndefined();
    expect(pastes.place(p1, { pasted: true }).supersedes).toBe("obsidian:Ideas");
  });

  it("re-import of a shortened note leaves no stale lines", async () => {
    const { store } = await open();
    const long = markdownToSession(note("Line one.\n\nLine two.\n\nLine three.\n\nLine four."), "Plan.md", { path: "Vault/Plan.md" });
    await store.replaceSession(long.session, long.entries);
    expect(store.entryCount(long.session.id)).toBe(4);
    const short = markdownToSession(note("Line one, rewritten."), "Plan.md", { path: "Vault/Plan.md" });
    expect(short.session.id).toBe(long.session.id);
    await store.replaceSession(short.session, short.entries);
    expect(store.getEntries(short.session.id).map(entry => entry.text)).toEqual(["Line one, rewritten."]);
    expect(store.search("three")).toEqual([]);
  });

  it("dates an undated note by its file, not by the import, and reports what the limits cut", () => {
    const modified = Date.parse("2026-03-04T05:06:07.000Z");
    const undated = markdownToSession(note("Body."), "Untitled.md", { lastModified: modified, now: "2026-11-23T12:00:00.000Z" });
    expect(undated.session.startedAt).toBe("2026-03-04T05:06:07.000Z"); expect(undated.session.updatedAt).toBe("2026-03-04T05:06:07.000Z");
    expect(markdownToSession(note("Body.", "date: 2026-01-02"), "Untitled.md", { lastModified: modified }).session.startedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(markdownToSession(note("Body."), "2026-02-03 Untitled.md", { lastModified: modified }).session.startedAt).toBe("2026-02-03T00:00:00.000Z");
    expect(markdownToSession(note("Body."), "Untitled.md", { now: "2026-11-23T12:00:00.000Z" }).session.startedAt).toBe("2026-11-23T12:00:00.000Z");
    expect(undated.truncated).toBeUndefined();
    // 5,003 lines, one of them far too long, and 25 summary items.
    const body = `## Summary\n${Array.from({ length: 25 }, (_, i) => `- Summary item ${i}`).join("\n")}\n\n## Transcript\n\n${Array.from({ length: 5002 }, (_, i) => `**Ada:** Line ${i}`).join("\n\n")}\n\n**Ada:** ${"long ".repeat(1000)}\n`;
    const cut = markdownToSession(`# Big\n\n${body}`, "Big.md");
    expect(cut.entries).toHaveLength(5000); expect(cut.session.summary).toHaveLength(20);
    expect(cut.truncated).toBe("3 lines past the 5,000-line limit left out; 1 long line cut to 4,000 characters; 5 summary or list items left out or shortened (20 of 500 characters each are kept).");
  });
});
