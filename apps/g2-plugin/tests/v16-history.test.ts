import { describe, expect, it, vi } from "vitest";
import { AudioEvent, AudioInputSource, AudioSpeakerRole, StartUpPageCreateResult, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { DirectConversationTransport, LEGACY_HISTORY_KEY, type GatewayEvent, type HistoryEntry, type HistorySession } from "@helix/conversation-sdk";
import { G2ConversationController, OPENAI_KNOWLEDGE_STORAGE_KEY, type G2BridgePort } from "../src/controller";
import { GlassesRenderer } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";
import { DEFAULT_CONFIG } from "../src/config";
import { ASKED_MARK, CUT_OFF_LABEL, REMOVE_ALL_SCOPES, cleanTranscript, cleanupDefaultTicks, cleanupPlan, cleanupPreview, sessionCard, sessionCues, transcriptText } from "../src/history-panel";

const form = { ...DEFAULT_CONFIG, transcriptionProvider: "openai-whisper" as const, copilotSummarize: false, copilotConcepts: false, copilotConflicts: false, copilotSuggestions: false,
  copilotImplicitAsks: false, copilotWebGrounding: false, autoQuestion: false, autoAnswer: false, autoNotes: false,
  accessToken: "", openaiApiKey: "session-key", deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", saveApiKeysOnPhone: false };

/** A controller on in-memory phone storage with a scripted transport and a fake OpenAI knowledge base. */
function rig(storage = new Map<string, string>()) {
  let hub: ((event: EvenHubEvent) => void) | undefined, speech = "";
  const events: GatewayEvent[] = [], api = { deleted: [] as string[], seq: 0 };
  const bridge: G2BridgePort = {
    getLocalStorage: async key => storage.get(key) ?? "",
    setLocalStorage: async (key, value) => { storage.set(key, value); return true; },
    createStartUpPageContainer: async () => StartUpPageCreateResult.success,
    textContainerUpgrade: async () => true,
    audioControl: async () => true,
    shutDownPageContainer: async () => true,
    onEvenHubEvent: listener => { hub = listener; return () => { hub = undefined; }; },
  };
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? "GET", path = url.replace("https://api.openai.com/v1", "");
    if (path.endsWith("transcriptions")) return Response.json({ text: speech });
    if (method === "POST" && path === "/vector_stores") return Response.json({ id: `vs_${++api.seq}` });
    if (method === "POST" && path === "/files") return Response.json({ id: `file-${++api.seq}` });
    if (method === "DELETE" && path.startsWith("/files/")) { api.deleted.push(path); return new Response("{}", { status: 200 }); }
    if (/^\/vector_stores\/vs_\d+(\/files)?$/u.test(path)) return Response.json({ id: "ok" });
    return new Response("{}", { status: 404 });
  };
  const controller = new G2ConversationController(bridge, new GlassesRenderer(bridge, { debounceMs: 0 }), new ConversationPresentation(), opts => {
    const transport = new DirectConversationTransport({ ...opts, insights: undefined, factCheck: { ...opts!.factCheck!, enabled: () => false }, fetch });
    transport.subscribe(event => events.push(event));
    return transport;
  });
  controller.keyTestFetch = fetch;
  const say = async (text: string) => {
    const count = events.filter(event => event.type === "transcript.final").length;
    speech = text;
    await controller.beginHold();
    hub?.({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array(new Int16Array(3200).fill(4000).buffer), source: AudioInputSource.Glasses, speakerRole: AudioSpeakerRole.Other }) } as EvenHubEvent);
    await controller.releaseHold();
    await vi.waitFor(() => expect(events.filter(event => event.type === "transcript.final")).toHaveLength(count + 1));
  };
  return { controller, storage, api, say };
}

const T0 = Date.parse("2026-11-10T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const helix = (id: string, start: number, extra: Partial<HistorySession> = {}): HistorySession =>
  ({ id, source: "helix", title: `Helix · ${at(start)}`, startedAt: at(start), updatedAt: at(start + 1), ...extra });
const line = (id: string, sessionId: string, text: string, extra: Partial<HistoryEntry> = {}): HistoryEntry =>
  ({ id, sessionId, kind: "transcript", text, occurredAt: at(0), speaker: "Other speaker", ...extra });
const seed = (sessions: HistorySession[], entries: HistoryEntry[] = []) => new Map([[LEGACY_HISTORY_KEY, JSON.stringify({ version: 1, sessions, entries })]]);
const LONG = "Orin lead time is twelve weeks and Kan will escalate with the distributor.";

describe("v0.16 history view: taps and cut-off answers", () => {
  const entry = (n: number, kind: HistoryEntry["kind"], speaker: string, text: string, metadata?: Record<string, string>): HistoryEntry =>
    ({ id: `e${n}`, sessionId: "s", kind, text, occurredAt: at(n), speaker, ...(metadata ? { metadata } : {}) });
  const entries = [
    entry(1, "transcript", "Other speaker", "Presence is about attention, not time."),
    entry(2, "question", "Local context", "Using the recent context, answer."),
    entry(3, "question", "Local context", "Using the recent context, answer."),
    entry(4, "question", "Local context", "Using the recent context, answer."),
    entry(5, "answer", "Helix", "How does this differ from futurism?"),
    entry(6, "transcript", "Other speaker", "Planning is still a present act."),
    entry(7, "question", "Whole conversation", "Using the whole captured conversation, answer."),
    entry(8, "answer", "Helix", "The talk argues that attention", { partial: "true" }),
    entry(9, "question", "Local context", "Using the recent context, answer."),
    entry(10, "question", "Local context", "Using the recent context, answer."),
    entry(11, "transcript", "Other speaker", "Thank you all."),
    entry(12, "question", "You", "Typed question to Helix"),
    entry(13, "answer", "Helix", "A typed answer."),
  ];
  it("prints no line per tap: the answer carries a small mark, and taps without an answer show nothing", () => {
    const lines = cleanTranscript(entries);
    expect(lines.map(item => [item.kind, item.speaker, item.text, item.asked ?? "", item.cutOff ?? false])).toEqual([
      ["speech", "Them", "Presence is about attention, not time.", "", false],
      ["helix", "Helix", "How does this differ from futurism?", "recent", false],
      ["speech", "Them", "Planning is still a present act.", "", false],
      ["helix", "Helix", "The talk argues that attention", "whole", true],
      ["speech", "Them", "Thank you all.", "", false],
      ["request", "You", "Typed question to Helix", "", false],
      ["helix", "Helix", "A typed answer.", "", false],
    ]);
    const text = transcriptText(lines);
    expect(text).not.toMatch(/asked Helix about/u);
    expect(text).toContain(`    Helix (${ASKED_MARK.recent}): How does this differ from futurism?`);
    expect(text).toContain(`    Helix (${ASKED_MARK.whole}): The talk argues that attention ${CUT_OFF_LABEL}`);
    expect(CUT_OFF_LABEL).toBe("(cut off)");
    // The tap that was answered stays addressable (a search hit on it opens the answer); nothing of the prompt text is shown.
    expect(lines[1]!.entryIds).toEqual(["e4", "e5"]);
    expect(JSON.stringify(lines)).not.toContain("Using the");
  });
  it("counts and cues stay per answer, not per tap", () => {
    expect(sessionCues(entries)).toEqual([
      { kind: "answer", text: "How does this differ from futurism?", asked: "recent" },
      { kind: "answer", text: "The talk argues that attention", asked: "whole", cutOff: true },
      { kind: "answer", text: "A typed answer.", question: "Typed question to Helix" },
    ]);
    const card = sessionCard(helix("s", 0), entries);
    expect(card).toMatchObject({ lines: 3, answers: 3 });
  });
  it("the saved question entries are kept, and the partial mark survives the controller's store", async () => {
    const f = rig(seed([helix("s", 0, { title: "Presence talk", recap: { origin: "model", generatedAt: at(20) } })], entries));
    await f.controller.initialize();
    const record = f.controller.openHistorySession("s")!;
    expect(record.entries.filter(item => item.kind === "question")).toHaveLength(7); // six taps and the typed one
    expect(record.entries.find(item => item.id === "e8")!.metadata).toEqual({ partial: "true" });
    expect(cleanTranscript(record.entries).filter(item => item.cutOff).map(item => item.text)).toEqual(["The talk argues that attention"]);
    await f.controller.dispose();
  });
});

describe("v0.16 History clean-up", () => {
  const archive = () => seed([
    helix("stray", 0), // one stray word
    helix("taps", 30), // only tapped answers
    helix("talk-a", 100, { title: "Vendor call", recap: { origin: "model", generatedAt: at(106) }, endedAt: at(105), people: [{ name: "Kan" }] }),
    helix("talk-b", 110, { title: "Vendor call, part two", recap: { origin: "model", generatedAt: at(116) }, endedAt: at(115) }),
    helix("recapped", 300, { title: "Short check-in", overview: "A short check-in.", recap: { origin: "model", generatedAt: at(301) } }),
    { id: "omi:tiny", source: "omi", title: "Tiny Omi note", startedAt: at(400), updatedAt: at(400) },
    { id: "obsidian:n1", source: "obsidian", title: "Weekly sync", startedAt: at(500), updatedAt: at(500) },
    { id: "obsidian:n2", source: "obsidian", title: "Weekly Sync", startedAt: at(500), updatedAt: at(500) },
    { id: "pdf:doc", source: "obsidian", title: "Manual.pdf", startedAt: at(600), updatedAt: at(600), tags: ["pdf"] },
  ], [
    line("stray:1", "stray", "Okay."),
    line("taps:q", "taps", "Using the recent context, answer.", { kind: "question", speaker: "Local context", occurredAt: at(30) }),
    line("taps:a", "taps", "Say: let us pin the date.", { kind: "answer", speaker: "Helix", occurredAt: at(31) }),
    line("talk-a:1", "talk-a", LONG, { occurredAt: at(101) }),
    line("talk-b:1", "talk-b", `${LONG} And the Thor kits follow in March.`, { occurredAt: at(111) }),
    line("recapped:1", "recapped", "Okay.", { occurredAt: at(300) }),
    line("omi:tiny:1", "omi:tiny", "Hi.", { occurredAt: at(400) }),
    line("obsidian:n1:1", "obsidian:n1", "Agenda for the weekly sync.", { occurredAt: at(500) }),
    line("obsidian:n2:1", "obsidian:n2", "Agenda for the weekly sync.", { occurredAt: at(500) }),
    line("obsidian:n2:2", "obsidian:n2", "Second line of the newer copy.", { occurredAt: at(501) }),
    line("pdf:doc:1", "pdf:doc", "Page one of the manual.", { occurredAt: at(600) }),
  ]);
  it("previews what it found, grouped by reason, removals ticked and the merge unticked", async () => {
    const f = rig(archive());
    await f.controller.initialize();
    const proposal = f.controller.historyCleanupProposal();
    expect(proposal.removals.map(item => [item.id, item.reason]).sort()).toEqual([["obsidian:n1", "duplicate-import"], ["stray", "little-speech"], ["taps", "answers-only"]]);
    expect(proposal.merges.map(merge => [merge.intoId, merge.fromId])).toEqual([["talk-a", "talk-b"]]);
    // Never an imported, recapped or PDF session for being small.
    for (const id of ["omi:tiny", "recapped", "pdf:doc", "obsidian:n2", "talk-a", "talk-b"]) expect(proposal.removals.map(item => item.id)).not.toContain(id);
    const groups = cleanupPreview(proposal);
    expect(groups.map(group => [group.id, group.tickedByDefault, group.rows.map(row => row.key)])).toEqual([
      ["little-speech", true, ["remove:stray"]], ["answers-only", true, ["remove:taps"]], ["duplicate-import", true, ["remove:obsidian:n1"]], ["merge", false, ["merge:talk-b"]]]);
    expect(groups.at(-1)!.rows[0]!.label).toBe("Merge Vendor call + Vendor call, part two");
    expect(groups.at(-1)!.note).toMatch(/cannot be undone/u);
    const ticks = cleanupDefaultTicks(proposal);
    expect([...ticks].sort()).toEqual(["remove:obsidian:n1", "remove:stray", "remove:taps"]);
    expect(cleanupPlan(proposal, ticks)).toEqual({ remove: expect.arrayContaining(["stray", "taps", "obsidian:n1"]), merge: [] });
    expect(cleanupPlan(proposal, new Set(["merge:talk-b"]))).toEqual({ remove: [], merge: [{ fromId: "talk-b", intoId: "talk-a" }] });
    // Computing the proposal changes nothing.
    expect(f.controller.listHistorySessions()).toHaveLength(9);
    await f.controller.dispose();
  });
  it("removes only what is ticked, from search and the OpenAI knowledge base too, and merges only when ticked", async () => {
    const f = rig(archive());
    await f.controller.initialize();
    await f.controller.setKnowledgeSource("openai");
    await f.controller.syncOpenAIKnowledge("setup-key");
    const files = () => JSON.parse(f.storage.get(OPENAI_KNOWLEDGE_STORAGE_KEY)!).state.files as Record<string, { fileId: string }>;
    const strayFile = files().stray!.fileId, partTwoFile = files()["talk-b"]!.fileId;
    const proposal = f.controller.historyCleanupProposal();
    // The wearer unticks the duplicate and leaves the merge unticked.
    const ticks = cleanupDefaultTicks(proposal); ticks.delete("remove:obsidian:n1");
    const first = await f.controller.applyHistoryCleanup(cleanupPlan(proposal, ticks), "setup-key");
    expect(first).toMatchObject({ removed: 2, merged: 0, failed: 0, pendingInOpenAI: 0 });
    expect(first.message).toBe("2 sessions removed from this phone and local retrieval.");
    expect(f.controller.listHistorySessions().map(session => session.id).sort()).toEqual(["obsidian:n1", "obsidian:n2", "omi:tiny", "pdf:doc", "recapped", "talk-a", "talk-b"]);
    expect(f.controller.searchHistory("pin the date")).toEqual([]);
    expect(f.api.deleted).toContain(`/files/${strayFile}`);
    expect(Object.keys(files())).not.toContain("taps");
    expect(f.controller.openHistorySession("talk-b")!.entries).toHaveLength(1); // not merged: it was not ticked
    // Now the merge is ticked.
    const again = f.controller.historyCleanupProposal();
    expect(again.removals.map(item => item.id)).toEqual(["obsidian:n1"]);
    const second = await f.controller.applyHistoryCleanup(cleanupPlan(again, new Set(["merge:talk-b"])), "setup-key");
    expect(second).toMatchObject({ removed: 0, merged: 1, failed: 0 });
    expect(second.message).toMatch(/^1 session merged into the one before\./u);
    expect(f.controller.openHistorySession("talk-b")).toBeUndefined();
    const merged = f.controller.openHistorySession("talk-a")!;
    expect(merged.entries.map(entry => entry.id)).toEqual(["talk-a:1", "talk-b:1"]);
    expect(merged.session).toMatchObject({ startedAt: at(100), people: [{ name: "Kan" }] });
    expect(f.controller.searchHistory("Thor kits").map(hit => hit.session.id)).toEqual(["talk-a"]);
    expect(f.api.deleted).toContain(`/files/${partTwoFile}`);
    expect(Object.keys(files())).not.toContain("talk-b");
    expect(f.controller.listHistorySessions().map(session => session.id)).toContain("obsidian:n1"); // unticked: still there
    await f.controller.dispose();
  });
  it("merges a chain of ticked pairs into the first session", async () => {
    const f = rig(seed([helix("a", 0, { endedAt: at(5) }), helix("b", 8, { endedAt: at(12) }), helix("c", 15, { endedAt: at(20) })],
      [line("a:1", "a", LONG, { occurredAt: at(1) }), line("b:1", "b", LONG, { occurredAt: at(9) }), line("c:1", "c", LONG, { occurredAt: at(16) })]));
    await f.controller.initialize();
    const proposal = f.controller.historyCleanupProposal();
    expect(proposal.merges.map(merge => [merge.intoId, merge.fromId])).toEqual([["a", "b"], ["b", "c"]]);
    const result = await f.controller.applyHistoryCleanup(cleanupPlan(proposal, new Set(["merge:c", "merge:b"])));
    expect(result).toMatchObject({ merged: 2, removed: 0, failed: 0 });
    expect(f.controller.listHistorySessions().map(session => session.id)).toEqual(["a"]);
    expect(f.controller.openHistorySession("a")!.entries.map(entry => entry.id)).toEqual(["a:1", "b:1", "c:1"]);
    await f.controller.dispose();
  });
  it("leaves the live session out of the proposal, a merge and a removal", async () => {
    const f = rig(seed([helix("old", -9999, { endedAt: at(-9990) })], [line("old:1", "old", LONG, { occurredAt: at(-9998) })]));
    await f.controller.initialize();
    await f.controller.connect(form);
    await f.say("Okay.");
    const live = f.controller.liveSessionId()!;
    await vi.waitFor(() => expect(f.controller.openHistorySession(live)?.entries).toHaveLength(1));
    expect(f.controller.historyCleanupProposal()).toEqual({ removals: [], merges: [] });
    const result = await f.controller.applyHistoryCleanup({ remove: [live], merge: [{ fromId: live, intoId: "old" }] });
    expect(result).toMatchObject({ removed: 0, merged: 0, failed: 1 });
    expect(f.controller.openHistorySession(live)!.entries).toHaveLength(1);
    expect(f.controller.historyScopeIds("all")).toEqual(["old"]);
    await f.controller.dispose();
  });
});

describe("v0.16 History remove all", () => {
  const archive = () => seed([helix("h1", 0, { title: "One" }), helix("h2", 100, { title: "Two" }),
    { id: "omi:1", source: "omi", title: "Omi talk", startedAt: at(200), updatedAt: at(200) },
    { id: "obsidian:n", source: "obsidian", title: "Note", startedAt: at(300), updatedAt: at(300) },
    { id: "pdf:doc", source: "obsidian", title: "Manual.pdf", startedAt: at(400), updatedAt: at(400), tags: ["pdf"] }],
  [line("h1:1", "h1", LONG), line("h2:1", "h2", LONG), line("omi:1:1", "omi:1", "Omi said the Thor kits ship in March."), line("obsidian:n:1", "obsidian:n", "A note about Thor."), line("pdf:doc:1", "pdf:doc", "Manual page about Thor.")]);
  it("offers four scopes in plain words", () => {
    expect(REMOVE_ALL_SCOPES).toEqual([["helix", "Helix conversations"], ["omi", "Omi imports"], ["obsidian", "Obsidian notes"], ["all", "Everything, with PDFs"]]);
  });
  it("removes one source at a time and leaves the others", async () => {
    const f = rig(archive());
    await f.controller.initialize();
    const ids = () => f.controller.listHistorySessions().map(session => session.id).sort();
    expect(f.controller.historyScopeIds("helix").sort()).toEqual(["h1", "h2"]);
    expect(await f.controller.removeAllHistory("omi")).toMatchObject({ removed: 1, failed: 0, message: "Session removed from this phone and local retrieval." });
    expect(ids()).toEqual(["h1", "h2", "obsidian:n", "pdf:doc"]);
    expect(await f.controller.removeAllHistory("omi")).toMatchObject({ removed: 0, message: "Nothing to remove." });
    expect(await f.controller.removeAllHistory("obsidian")).toMatchObject({ removed: 1 });
    expect(ids()).toEqual(["h1", "h2", "pdf:doc"]); // the PDF is not an Obsidian note
    expect(await f.controller.removeAllHistory("helix")).toMatchObject({ removed: 2 });
    expect(ids()).toEqual(["pdf:doc"]);
    expect(f.controller.searchHistory("Thor").map(hit => hit.session.id)).toEqual(["pdf:doc"]);
    await f.controller.dispose();
  });
  it("removes everything, including PDFs and their files in the OpenAI knowledge base", async () => {
    const f = rig(archive());
    await f.controller.initialize();
    await f.controller.setKnowledgeSource("openai");
    await f.controller.syncOpenAIKnowledge("setup-key");
    expect(f.controller.knowledgeBase()).toMatchObject({ synced: 5 });
    expect(await f.controller.removeAllHistory("all", "setup-key")).toMatchObject({ removed: 5, failed: 0, pendingInOpenAI: 0 });
    expect(f.controller.listHistorySessions()).toEqual([]);
    expect(f.api.deleted).toHaveLength(5);
    expect(f.controller.knowledgeBase()).toMatchObject({ synced: 0, removals: 0 });
    expect(f.controller.searchHistory("Thor")).toEqual([]);
    await f.controller.dispose();
  });
});
