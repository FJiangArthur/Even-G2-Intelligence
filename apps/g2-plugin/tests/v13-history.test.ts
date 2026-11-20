import { describe, expect, it, vi } from "vitest";
import { AudioEvent, AudioInputSource, AudioSpeakerRole, StartUpPageCreateResult, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { DirectConversationTransport, HISTORY_INDEX_KEY, LEGACY_HISTORY_KEY, historyShardKey, type DirectConversationOptions, type GatewayEvent, type HistoryEntry, type HistorySession } from "@helix/conversation-sdk";
import { G2ConversationController, LIFECYCLE_STORAGE_KEY, OPENAI_KNOWLEDGE_STORAGE_KEY, RESUME_SAME_SESSION_MS, type G2BridgePort } from "../src/controller";
import { GlassesRenderer } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "../src/config";
import { formatSessionDay, groupSessionCards, historyKnowledgeNote, recapProvenance, sessionCard, sessionDayKey, sessionTitle } from "../src/history-panel";

const form = { ...DEFAULT_CONFIG, transcriptionProvider: "openai-whisper" as const, copilotSummarize: false, copilotConcepts: false, copilotConflicts: false, copilotSuggestions: false,
  copilotImplicitAsks: false, copilotWebGrounding: false, autoQuestion: false, autoAnswer: false, autoNotes: false,
  accessToken: "", openaiApiKey: "session-key", deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", saveApiKeysOnPhone: false };
const DIGEST = { title: "Orin supply escalation", overview: "The Orin order slipped again. Kan will escalate with the distributor.",
  summary: ["Orin order slipped to March.", "Kan escalates with the distributor."], keyFacts: ["March"], concepts: [{ term: "Orin", explanation: "NVIDIA Jetson module." }] };

/** A controller on in-memory phone storage with a scripted transport: speech -> transcript, the session digest call, everything else 404. */
function rig(storage = new Map<string, string>()) {
  let hub: ((event: EvenHubEvent) => void) | undefined, speech = "", options!: DirectConversationOptions;
  const historyWrites: string[] = [], events: GatewayEvent[] = [];
  const api = { digests: [] as { auth: string; model: string; input: { title: string; transcript: string } }[], digestStatus: 200, files: [] as string[], fileStatus: 200, seq: 0 };
  const bridge: G2BridgePort = {
    getLocalStorage: async key => storage.get(key) ?? "",
    setLocalStorage: async (key, value) => { if (key.startsWith("helix.g2.history.")) historyWrites.push(key); storage.set(key, value); return true; },
    createStartUpPageContainer: async () => StartUpPageCreateResult.success,
    textContainerUpgrade: async () => true,
    audioControl: async () => true,
    shutDownPageContainer: async () => true,
    onEvenHubEvent: listener => { hub = listener; return () => { hub = undefined; }; },
  };
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? "GET", path = url.replace("https://api.openai.com/v1", "");
    if (path.endsWith("transcriptions")) return Response.json({ text: speech });
    if (path === "/responses" && String(init.body).includes("helix_session_digest")) {
      const body = JSON.parse(String(init.body)) as { model: string; input: string };
      api.digests.push({ auth: (init.headers as Record<string, string>).Authorization!, model: body.model, input: JSON.parse(body.input) });
      return api.digestStatus === 200 ? Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(DIGEST) }] }] }) : new Response("{}", { status: api.digestStatus });
    }
    if (method === "POST" && path === "/vector_stores") return Response.json({ id: `vs_${++api.seq}` });
    if (method === "POST" && path === "/files") return Response.json({ id: `file-${++api.seq}` });
    if (method === "DELETE" && path.startsWith("/files/")) { api.files.push(path); return new Response("{}", { status: api.fileStatus }); }
    if (/^\/vector_stores\/vs_\d+(\/files)?$/u.test(path)) return Response.json({ id: "ok" });
    return new Response("{}", { status: 404 });
  };
  const presentation = new ConversationPresentation();
  const controller = new G2ConversationController(bridge, new GlassesRenderer(bridge, { debounceMs: 0 }), presentation, opts => {
    options = opts!;
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
  return { controller, presentation, storage, historyWrites, api, say, options: () => options };
}
const helix = (id: string, extra: Partial<HistorySession> = {}): HistorySession => ({ id, source: "helix", title: "Helix · 2026-11-19T17:42:00.000Z", startedAt: "2026-11-19T17:42:00.000Z", updatedAt: "2026-11-19T17:42:00.000Z", ...extra });
const line = (id: string, sessionId: string, text: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({ id, sessionId, kind: "transcript", text, occurredAt: "2026-11-19T12:00:00.000Z", speaker: "Other speaker", ...extra });
const seed = (sessions: HistorySession[], entries: HistoryEntry[] = []) => new Map([[LEGACY_HISTORY_KEY, JSON.stringify({ version: 1, sessions, entries })]]);

describe("v0.13 history: empty sessions", () => {
  it("does not save a session in which nothing was said or answered, however often Helix connects", async () => {
    const f = rig();
    await f.controller.initialize();
    await f.controller.connect(form);
    expect(f.controller.liveSessionId()).toMatch(/^session_/u);
    await f.controller.connect(form); // reconnect
    await f.controller.disconnect();
    await f.controller.connect(form);
    await f.controller.dispose();
    expect(f.controller.listHistorySessions()).toEqual([]);
    expect(f.historyWrites).toEqual([]); // not even an index write
    expect(f.api.digests).toEqual([]); // and no summary call for an empty session
    expect(f.storage.get(HISTORY_INDEX_KEY) ?? "").toBe("");
  });
  it("prunes the empty Helix records earlier versions left behind, and nothing else", async () => {
    const storage = seed([
      helix("session_empty1"), helix("session_empty2", { startedAt: "2026-11-19T17:21:00.000Z", updatedAt: "2026-11-19T17:21:00.000Z" }), helix("session_empty3", { title: "" }),
      helix("session_summary", { summary: ["Only the copilot summary survived."] }),
      helix("session_real", { title: "Bacon" }),
      { id: "omi:title-only", source: "omi", title: "Title-only meeting", startedAt: "2026-11-18T10:00:00.000Z", updatedAt: "2026-11-18T10:00:00.000Z" },
    ], [line("session_real:1", "session_real", "Bacon"), line("session_real:2", "session_real", "Bacon and eggs for the offsite breakfast.", { occurredAt: "2026-11-19T12:00:20.000Z" })]);
    const f = rig(storage);
    await f.controller.initialize();
    expect(f.controller.listHistorySessions().map(session => session.id).sort()).toEqual(["omi:title-only", "session_real", "session_summary"]);
    expect(f.controller.listHistorySessions().every(session => f.controller.historySessionHasContent(session))).toBe(true);
    // Pruned from storage, not just hidden: a restart does not bring them back.
    await f.controller.dispose();
    expect(f.storage.get(HISTORY_INDEX_KEY)).not.toMatch(/session_empty/u);
    const again = rig(f.storage); await again.controller.initialize();
    expect(again.controller.listHistorySessions()).toHaveLength(3);
    // The surviving legacy session was titled with its first utterance: History shows a derived title instead.
    const real = again.controller.openHistorySession("session_real")!;
    expect(again.controller.historyTitle(real.session)).not.toBe("Bacon");
    expect(sessionCard(real.session, real.entries)).toMatchObject({ title: expect.stringMatching(/ conversation$/u), origin: "fallback", counts: "1 speaker turn · 0 Helix answers",
      summary: "Not summarised yet. Opens with “Bacon and eggs for the offsite breakfast.”" });
    await again.controller.dispose();
  });
});

describe("v0.13 history: post-conversation summary", () => {
  it("summarises the session once when it ends, with the session's own key and the selected copilot model, and stores provenance", async () => {
    const f = rig();
    await f.controller.initialize();
    await f.controller.connect({ ...form, copilotModel: "gpt-6-luna" });
    const id = f.controller.liveSessionId()!;
    await f.say("So");
    await f.say("So the Orin order slipped again and the distributor now says March.");
    expect(f.api.digests).toEqual([]); // nothing while the session is live
    const before = Date.now();
    await f.controller.disconnect();
    // The on-phone title is saved before the model answers (and stays if it never does).
    expect(f.controller.sessionSummaryPending(id) || f.api.digests.length === 1).toBe(true);
    await f.controller.recapSettled();
    expect(f.api.digests).toEqual([{ auth: "Bearer session-key", model: "gpt-6-luna", input: { title: "", transcript: expect.stringContaining("the Orin order slipped again") } }]);
    const { session, entries } = f.controller.openHistorySession(id)!;
    expect(session).toMatchObject({ title: "Orin supply escalation", overview: DIGEST.overview, summary: DIGEST.summary, keyFacts: ["March"], concepts: ["Orin: NVIDIA Jetson module."],
      recap: { origin: "model", model: "gpt-6-luna", provider: "openai", endpoint: "https://api.openai.com/v1/responses", promptVersion: "session-digest-v2", latencyMs: expect.any(Number) } });
    expect(Date.parse(session.recap!.generatedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(session.endedAt!)).toBeGreaterThanOrEqual(before);
    expect(f.controller.sessionSummaryPending(id)).toBe(false);
    // The card and the session view lead with it.
    expect(sessionCard(session, entries)).toMatchObject({ title: "Orin supply escalation", summary: DIGEST.overview, origin: "model", counts: "1 speaker turn · 0 Helix answers" });
    expect(recapProvenance(session)).toMatch(/^Summary by gpt-6-luna · .+ · session-digest-v2$/u);
    expect(f.controller.sessionMarkdown(id)).toContain("# Orin supply escalation");
    await f.controller.dispose();
    expect(f.api.digests).toHaveLength(1); // dispose does not summarise it again
  });
  it("keeps the on-phone fallback when the call fails or there is too little speech, and upgrades it on demand", async () => {
    const f = rig();
    f.api.digestStatus = 500;
    await f.controller.initialize();
    await f.controller.connect(form);
    const id = f.controller.liveSessionId()!;
    await f.say("We should move the CDTF review to Thursday because the CDTF numbers are late.");
    await f.controller.disconnect(); await f.controller.recapSettled();
    expect(f.api.digests).toHaveLength(1);
    const failed = f.controller.openHistorySession(id)!.session;
    expect(failed).toMatchObject({ title: "About CDTF", recap: { origin: "fallback", generatedAt: expect.any(String) }, endedAt: expect.any(String) });
    expect(failed.recap).not.toHaveProperty("model");
    expect(failed.summary).toBeUndefined();
    expect(recapProvenance(failed)).toMatch(/^Title made on this phone · .+ · no AI summary yet$/u);
    // Too little speech: no call at all.
    await f.controller.connect(form);
    const short = f.controller.liveSessionId()!;
    await f.say("Bacon");
    await f.controller.disconnect(); await f.controller.recapSettled();
    expect(f.api.digests).toHaveLength(1);
    expect(f.controller.openHistorySession(short)!.session.recap).toMatchObject({ origin: "fallback" });
    // On demand from the session view (Generate summary), with the key from Setup.
    f.api.digestStatus = 200;
    await f.controller.generateSessionKnowledge(id, "setup-key");
    expect(f.api.digests.at(-1)).toMatchObject({ auth: "Bearer setup-key", input: { title: "" } }); // the on-phone title is not passed as a hint
    expect(f.controller.openHistorySession(id)!.session).toMatchObject({ title: "Orin supply escalation", overview: DIGEST.overview, recap: { origin: "model", promptVersion: "session-digest-v2" } });
    await expect(f.controller.generateSessionKnowledge("missing", "setup-key")).rejects.toThrow(/no longer on this phone/u);
    await f.controller.dispose();
  });
  it("ends with the fallback only when no key reached the session or summaries are switched off", async () => {
    const f = rig();
    await f.controller.initialize();
    f.controller.summarizeOnEnd = false;
    await f.controller.connect(form);
    const id = f.controller.liveSessionId()!;
    await f.say("The quarterly budget review moved to Friday and the budget owner is Elaine.");
    await f.controller.disconnect(); await f.controller.recapSettled();
    expect(f.api.digests).toEqual([]);
    expect(f.controller.openHistorySession(id)!.session).toMatchObject({ recap: { origin: "fallback" }, endedAt: expect.any(String) });
    await f.controller.dispose();
  });
});

describe("v0.13 history: one conversation, one session", () => {
  /** A live session that the phone reclaimed: nothing ran on the way out except the periodic history flush. */
  async function interrupted(text: string) {
    const first = rig();
    await first.controller.initialize();
    first.controller.summarizeOnEnd = false;
    await first.controller.connect(form);
    const id = first.controller.liveSessionId()!;
    await first.say(text);
    await first.controller.flushHistory(); // page hidden
    await vi.waitFor(() => expect(first.storage.get(LIFECYCLE_STORAGE_KEY)).toContain(id));
    return { storage: new Map(first.storage), id };
  }
  it("tap-to-resume continues the interrupted session instead of starting another", async () => {
    const { storage, id } = await interrupted("We agreed to ship the perception release on Friday.");
    const f = rig(storage);
    await f.controller.initialize();
    f.controller.summarizeOnEnd = false;
    expect(f.controller.pendingResume).toMatchObject({ connected: true, sessionId: id });
    await f.controller.connect(form); // what the resume banner runs
    const resumed = f.controller.liveSessionId()!;
    expect(resumed).not.toBe(id);
    // While live, the earlier part is a separate record, so answers can still retrieve it.
    expect(f.options().retrieveMemory?.("perception release Friday", resumed).map(hit => hit.session.id)).toEqual([id]);
    await f.say("Kan will write the release notes before Friday.");
    await f.controller.disconnect();
    const sessions = f.controller.listHistorySessions();
    expect(sessions.map(session => session.id)).toEqual([id]);
    expect(f.controller.openHistorySession(id)!.entries.map(entry => entry.text)).toEqual(["We agreed to ship the perception release on Friday.", "Kan will write the release notes before Friday."]);
    expect(f.controller.openHistorySession(resumed)).toBeUndefined();
    expect(f.storage.get(historyShardKey(resumed))).toBe("");
    expect(sessions[0]).toMatchObject({ recap: { origin: "fallback" }, endedAt: expect.any(String) });
    await f.controller.dispose();
  });
  it("folds a resumed session that was interrupted again into its first part at the next start", async () => {
    const { storage, id } = await interrupted("We agreed to ship the perception release on Friday.");
    const second = rig(storage);
    await second.controller.initialize();
    await second.controller.connect(form);
    const resumed = second.controller.liveSessionId()!;
    await second.say("Kan will write the release notes before Friday.");
    await second.controller.flushHistory(); // reclaimed again: two records on disk
    expect(second.controller.listHistorySessions()).toHaveLength(2);
    expect(JSON.parse(second.storage.get(LIFECYCLE_STORAGE_KEY)!)).toMatchObject({ sessionId: id }); // the next resume continues the first part
    const third = rig(new Map(second.storage));
    await third.controller.initialize();
    expect(third.controller.listHistorySessions().map(session => session.id)).toEqual([id]);
    expect(third.controller.openHistorySession(id)!.entries).toHaveLength(2);
    expect(third.controller.openHistorySession(resumed)).toBeUndefined();
    await third.controller.dispose();
  });
  it("starts a new session when there is nothing to resume or the interruption was long ago", async () => {
    const { storage, id } = await interrupted("We agreed to ship the perception release on Friday.");
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + RESUME_SAME_SESSION_MS + 60_000 });
    try {
      const f = rig(storage);
      await f.controller.initialize();
      f.controller.summarizeOnEnd = false;
      await f.controller.connect(form);
      await f.say("A different conversation an hour later.");
      await f.controller.disconnect();
      expect(f.controller.listHistorySessions().map(session => session.id).sort()).toEqual([id, f.controller.listHistorySessions().find(session => session.id !== id)!.id].sort());
      expect(f.controller.listHistorySessions()).toHaveLength(2);
      // A user Stop ends the conversation: the next Connect is a new session too.
      await f.controller.connect(form);
      await f.say("And a third one after a deliberate stop.");
      await f.controller.disconnect();
      expect(f.controller.listHistorySessions()).toHaveLength(3);
      await f.controller.dispose();
    } finally { vi.useRealTimers(); }
  });
});

describe("v0.13 history: removal and the knowledge switch", () => {
  const at = "2026-11-10T10:00:00.000Z";
  const seeded = () => seed(["s1", "s2", "s3"].map(id => ({ id, source: "helix" as const, title: `Vendor call ${id}`, startedAt: at, updatedAt: at, people: [{ name: `Person ${id}` }] })),
    ["s1", "s2", "s3"].map(id => line(`${id}:e1`, id, `Orin lead time is twelve weeks (${id}).`, { occurredAt: at })));
  it("removes a session from the history index, its shard, search, retrieval, People, and its file in the OpenAI knowledge base", async () => {
    const f = rig(seeded());
    await f.controller.initialize();
    await f.controller.setKnowledgeSource("openai");
    await f.controller.syncOpenAIKnowledge("setup-key");
    expect(f.controller.knowledgeBase()).toMatchObject({ synced: 3, pending: 0, removals: 0 });
    const s1File = JSON.parse(f.storage.get(OPENAI_KNOWLEDGE_STORAGE_KEY)!).state.files.s1.fileId as string;
    // With the key at hand, the uploaded file is deleted right away.
    const removed = await f.controller.removeHistorySessions(["s1"], "setup-key");
    expect(removed).toMatchObject({ removed: 1, failed: 0, pendingInOpenAI: 0, message: "Session removed from this phone and local retrieval." });
    expect(f.api.files).toEqual([`/files/${s1File}`]);
    expect(f.controller.openHistorySession("s1")).toBeUndefined();
    expect(f.storage.get(historyShardKey("s1"))).toBe("");
    expect(f.storage.get(HISTORY_INDEX_KEY)).not.toContain('"s1"');
    expect(f.controller.searchHistory("Orin lead time").map(hit => hit.session.id).sort()).toEqual(["s2", "s3"]);
    expect(f.controller.listPeople().map(person => person.name).sort()).toEqual(["Person s2", "Person s3"]);
    expect(Object.keys(JSON.parse(f.storage.get(OPENAI_KNOWLEDGE_STORAGE_KEY)!).state.files).sort()).toEqual(["s2", "s3"]);
    expect(f.controller.knowledgeBase()).toMatchObject({ synced: 2, removals: 0 });
    // Without a key, or when OpenAI cannot be reached, it is clearly pending and the next sync removes it.
    const noKey = await f.controller.removeHistorySessions(["s2"]);
    expect(noKey).toMatchObject({ removed: 1, pendingInOpenAI: 1 });
    expect(noKey.message).toMatch(/still in your OpenAI knowledge base until the next Sync/u);
    f.api.fileStatus = 500;
    expect(await f.controller.removeHistorySessions(["s3", "s3", "missing"], "setup-key")).toMatchObject({ removed: 2, pendingInOpenAI: 1 });
    expect(f.controller.listHistorySessions()).toEqual([]);
    expect(f.controller.knowledgeBase()).toMatchObject({ synced: 2, removals: 2 });
    expect(f.controller.historySnapshot().status).toMatch(/still in your OpenAI knowledge base/u);
    f.api.fileStatus = 200;
    expect(await f.controller.syncOpenAIKnowledge("setup-key")).toMatchObject({ removed: 2 });
    expect(f.controller.knowledgeBase()).toMatchObject({ synced: 0, removals: 0 });
    // Gone after a restart as well.
    await f.controller.dispose();
    const again = rig(f.storage); await again.controller.initialize();
    expect(again.controller.listHistorySessions()).toEqual([]);
    await again.controller.dispose();
  });
  it("“Let the knowledge base read history” is the existing useLocalMemory setting: on by default, gates every read and the sync, and persists", async () => {
    expect(DEFAULT_CONFIG.useLocalMemory).toBe(true);
    const f = rig(seeded());
    await f.controller.initialize();
    expect(f.controller.historySnapshot().useLocalMemory).toBe(true);
    await f.controller.setKnowledgeSource("openai");
    await f.controller.syncOpenAIKnowledge("setup-key");
    await f.controller.connect(form);
    const live = f.controller.liveSessionId()!, options = f.options();
    // On: saved sessions are found, with the session they came from (source attribution).
    expect(options.retrieveMemory?.("Orin lead time", live).map(hit => hit.session.title).sort()).toEqual(["Vendor call s1", "Vendor call s2", "Vendor call s3"]);
    expect(options.retrieveMemoryWithStats?.("Orin lead time", live)).toMatchObject({ searchedEntries: 3, matched: 3 });
    expect(options.openaiKnowledge?.()).toMatchObject({ vectorStoreId: expect.stringMatching(/^vs_/u) });
    // Off: never read for answers (phone or OpenAI), and not synced.
    await f.controller.setLocalMemoryEnabled(false);
    expect(options.retrieveMemory?.("Orin lead time", live)).toEqual([]);
    expect(options.retrieveMemoryWithStats?.("Orin lead time", live)).toEqual({ items: [], searchedEntries: 0, matched: 0 });
    expect(options.openaiKnowledge?.()).toBeUndefined();
    await expect(f.controller.syncOpenAIKnowledge("setup-key")).rejects.toThrow(/Let the knowledge base read history/u);
    expect(f.controller.knowledgeBase().notice).toMatch(/may not read history/u);
    expect(JSON.parse(f.storage.get(CONFIG_STORAGE_KEY)!).useLocalMemory).toBe(false);
    expect(f.controller.listHistorySessions()).toHaveLength(3); // switching it off deletes nothing
    await f.controller.dispose();
    const again = rig(f.storage); await again.controller.initialize();
    expect(again.controller.historySnapshot().useLocalMemory).toBe(false);
    await again.controller.setLocalMemoryEnabled(true);
    expect(JSON.parse(again.storage.get(CONFIG_STORAGE_KEY)!).useLocalMemory).toBe(true);
    await again.controller.dispose();
  });
  it("says in one line what is sent to the answer provider", () => {
    expect(historyKnowledgeNote(true, false)).toMatch(/^On: .*saved sessions on this phone.*up to 5 short matching passages.*answer provider/u);
    expect(historyKnowledgeNote(true, true)).toMatch(/^On: .*OpenAI knowledge base.*answer provider/u);
    expect(historyKnowledgeNote(false, true)).toMatch(/^Off: saved sessions are never read for answers and are not synced to OpenAI/u);
  });
});

describe("v0.13 history list (pure)", () => {
  it("groups cards by day, newest first, with Today and Yesterday", () => {
    const now = new Date(2026, 10, 19, 15, 0).getTime(), local = (day: number, hour: number) => new Date(2026, 10, day, hour, 0).toISOString();
    const cards = [local(18, 21), local(19, 9), local(19, 12), local(16, 8), new Date(2025, 11, 31, 8, 0).toISOString()].map((startedAt, index) => ({ id: `c${index}`, startedAt, day: sessionDayKey(startedAt) }));
    const groups = groupSessionCards(cards, now);
    expect(groups.map(group => [group.label, group.cards.map(card => card.id)])).toEqual([["Today", ["c2", "c1"]], ["Yesterday", ["c0"]], [formatSessionDay(local(16, 8), now), ["c3"]], [formatSessionDay(cards[4]!.startedAt, now), ["c4"]]]);
    expect(formatSessionDay(local(16, 8), now)).toMatch(/Nov/u);
    expect(formatSessionDay(cards[4]!.startedAt, now)).toMatch(/2025/u);
    expect(formatSessionDay("not a date", now)).toBe("Undated");
  });
  it("labels the counts and never shows a placeholder title or a bare “10 · 2”", () => {
    const entries = [line("s:1", "s", "The Orin order slipped again and Orin stock is the blocker."), line("s:2", "s", "Can Kan escalate the Orin order?", { speaker: "You", occurredAt: "2026-11-19T12:01:00.000Z" }),
      line("s:3", "s", "Yes: ask Kan to escalate with the distributor.", { kind: "answer", speaker: "Helix", occurredAt: "2026-11-19T12:02:00.000Z" })];
    const card = sessionCard(helix("s", { startedAt: "2026-11-19T12:00:00.000Z" }), entries);
    expect(card).toMatchObject({ title: "About Orin", counts: "2 speaker turns · 1 Helix answer", duration: "2 min", lines: 2, answers: 1, origin: "fallback" });
    expect(card.title).not.toMatch(/^Helix ·|^Helix session/u);
    expect(card.date).toBeTruthy(); expect(card.time).toBeTruthy();
    expect(sessionTitle(helix("p"))).toMatch(/ conversation$/u);
  });
});
