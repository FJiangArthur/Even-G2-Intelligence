import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioEvent, AudioInputSource, AudioSpeakerRole, StartUpPageCreateResult, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { DirectConversationTransport, HISTORY_INDEX_KEY, LocalHistoryStore, historyShardKey, type DirectConversationOptions, type GatewayEvent } from "@helix/conversation-sdk";
import { G2ConversationController, type G2BridgePort, type HistoryState } from "../src/controller";
import { GlassesRenderer } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";
import { DEFAULT_CONFIG } from "../src/config";

const form = { ...DEFAULT_CONFIG, transcriptionProvider: "openai-whisper" as const, copilotSummarize: false, copilotConcepts: false, copilotConflicts: false, copilotSuggestions: false,
  copilotImplicitAsks: false, copilotWebGrounding: false, liveWebFactCheck: false, autoQuestion: false, autoAnswer: false, autoNotes: false,
  accessToken: "", openaiApiKey: "test-key", deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", saveApiKeysOnPhone: false };

/** A saved archive of `count` earlier sessions (v2 layout), written by a store of its own. */
async function archive(count: number): Promise<Map<string, string>> {
  const storage = new Map<string, string>();
  const store = new LocalHistoryStore({ getLocalStorage: async key => storage.get(key) ?? "", setLocalStorage: async (key, value) => { storage.set(key, value); return true; } });
  for (let i = 0; i < count; i++) {
    const id = `old${i}`, at = new Date(Date.UTC(2026, 7, 1 + i)).toISOString();
    await store.replaceSession({ id, source: "helix", title: `Earlier ${i}`, startedAt: at, updatedAt: at, summary: ["Saved earlier."], todos: [{ id: `t${i}`, text: "Follow up", done: false, origin: "user", createdAt: at, updatedAt: at }] },
      [{ id: `${id}:e0`, sessionId: id, kind: "transcript", text: "An earlier line.", occurredAt: at }]);
  }
  return storage;
}
/** Live session; `delayMs` is the history coalescing window (60 s: nothing saves on its own during a test). */
async function live(storage = new Map<string, string>(), delayMs = 60_000) {
  let hub: ((event: EvenHubEvent) => void) | undefined, speech = "";
  const historyWrites: string[] = [], stuck = { history: false };
  const bridge: G2BridgePort = {
    getLocalStorage: async key => storage.get(key) ?? "",
    setLocalStorage: async (key, value) => {
      if (key.startsWith("helix.g2.history.")) { if (stuck.history) return new Promise<boolean>(() => undefined); historyWrites.push(key); }
      storage.set(key, value); return true;
    },
    createStartUpPageContainer: async () => StartUpPageCreateResult.success,
    textContainerUpgrade: async () => true,
    audioControl: async () => true,
    shutDownPageContainer: async () => true,
    onEvenHubEvent: listener => { hub = listener; return () => { hub = undefined; }; },
  };
  const events: GatewayEvent[] = [];
  const presentation = new ConversationPresentation();
  const controller = new G2ConversationController(bridge, new GlassesRenderer(bridge, { debounceMs: 0 }), presentation, (opts?: DirectConversationOptions) => {
    const transport = new DirectConversationTransport({ ...opts, insights: undefined,
      fetch: async url => url.endsWith("transcriptions") ? Response.json({ text: speech }) : new Response("{}", { status: 404 }) });
    transport.subscribe(event => events.push(event));
    return transport;
  });
  controller.liveHistoryWriteDelayMs = delayMs;
  await controller.initialize();
  const states: HistoryState[] = [];
  controller.subscribeHistory(state => states.push(state));
  controller.subscribeHistory(() => undefined); // several panels listen in the app
  await controller.connect(form);
  const sessionId = controller.liveSessionId()!;
  const transcribe = async (text: string) => {
    const count = events.filter(event => event.type === "transcript.final").length;
    speech = text;
    await controller.beginHold();
    hub?.({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array(new Int16Array(3200).fill(4000).buffer), source: AudioInputSource.Glasses, speakerRole: AudioSpeakerRole.Other }) } as EvenHubEvent);
    await controller.releaseHold();
    await vi.waitFor(() => expect(events.filter(event => event.type === "transcript.final")).toHaveLength(count + 1));
    await new Promise(resolve => setTimeout(resolve, 5)); // the archive write is issued behind the event
  };
  return { controller, presentation, storage, historyWrites, stuck, states, sessionId, transcribe };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("v15 history: one archive pass per saved change, not per line (findings 14, 22)", () => {
  it("archiving lines of a live session does not copy the session list; the save copies it once", async () => {
    const f = await live(await archive(12));
    const list = vi.spyOn(LocalHistoryStore.prototype, "listSessions");
    await f.transcribe("Order the Jetson boards this week.");
    await f.transcribe("Finance approved the budget.");
    await f.transcribe("Lead time is twelve weeks.");
    expect(list).toHaveBeenCalledTimes(0); // nothing is saved yet: reads cannot have changed
    await f.controller.flushHistory();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(list).toHaveBeenCalledTimes(1); // three "Saved" emits, one copy
    const last = f.states.at(-1)!;
    expect(last.status).toBe("Saved on this phone.");
    expect(last.sessions).toHaveLength(13);
    expect(last.sessions[0]!.id).toBe(f.sessionId); // newest first, the live session included once saved
    expect(f.controller.historySnapshot().sessions.map(session => session.id)).toEqual(last.sessions.map(session => session.id));
    await f.controller.dispose();
  });
  it("the OpenAI knowledge base counts reuse the same pass", async () => {
    const f = await live(await archive(12));
    await f.controller.setKnowledgeSource("openai");
    expect(f.controller.knowledgeBase().pending).toBe(12);
    const list = vi.spyOn(LocalHistoryStore.prototype, "listSessions");
    await f.transcribe("Order the Jetson boards this week.");
    await f.transcribe("Finance approved the budget.");
    expect(f.controller.knowledgeBase().pending).toBe(12);
    expect(list).toHaveBeenCalledTimes(0);
    await f.controller.disconnect();
    expect(f.controller.knowledgeBase().pending).toBe(13); // the ended session now waits for a sync
    await f.controller.dispose();
  });
  it("listeners still see every saved change: a new line, a deletion, an edited to-do", async () => {
    const f = await live(await archive(3), 0);
    await f.transcribe("Order the Jetson boards this week.");
    await f.controller.flushHistory();
    expect(f.states.at(-1)!.sessions.map(session => session.id)).toContain(f.sessionId);
    await f.controller.deleteHistorySession("old1");
    expect(f.states.at(-1)!.sessions.map(session => session.id)).not.toContain("old1");
    expect(f.controller.historySnapshot().sessions.map(session => session.id)).not.toContain("old1");
    expect(await f.controller.editTodo({ op: "complete", id: "t2" }, "old2")).toBe(true);
    expect(f.states.at(-1)!.sessions.find(session => session.id === "old2")!.todos![0]!.done).toBe(true);
    await f.controller.dispose();
  });
  it("each listener gets its own array, so sorting or filtering one does not disturb the others or the cache", async () => {
    const f = await live(await archive(4));
    const mine = f.states.at(-1)!.sessions, order = mine.map(session => session.id);
    mine.reverse(); mine.pop();
    expect(f.controller.historySnapshot().sessions.map(session => session.id)).toEqual(order);
    const snapshot = f.controller.historySnapshot().sessions;
    snapshot.length = 0;
    expect(f.controller.historySnapshot().sessions.map(session => session.id)).toEqual(order);
    await f.controller.dispose();
  });
  it("does not announce 'Saving local history…' for every line while live writes are coalesced", async () => {
    const f = await live(await archive(2));
    const before = f.states.length;
    await f.transcribe("Order the Jetson boards this week.");
    await f.transcribe("Finance approved the budget.");
    expect(f.states.slice(before).map(state => state.status)).not.toContain("Saving local history…");
    await f.controller.flushHistory();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(f.states.at(-1)!.status).toBe("Saved on this phone.");
    await f.controller.dispose();
  });
  it("still announces it for writes that go straight to storage", async () => {
    const f = await live(await archive(2), 0);
    const before = f.states.length;
    await f.transcribe("Order the Jetson boards this week.");
    await f.controller.flushHistory();
    const statuses = f.states.slice(before).map(state => state.status);
    expect(statuses).toContain("Saving local history…");
    expect(statuses.at(-1)).toBe("Saved on this phone.");
    await f.controller.dispose();
  });
});

describe("v15 history: Stop does not wait for a storage reply that never comes (finding 12)", () => {
  it("disconnect returns to ready within the teardown wait and the save finishes behind it", async () => {
    const f = await live();
    f.controller.historyTeardownWaitMs = 60;
    await f.transcribe("Saved in the end.");
    f.stuck.history = true;
    const started = Date.now();
    await f.controller.disconnect();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(f.presentation.snapshot().status).toBe("ready");
    expect(f.controller.openHistorySession(f.sessionId)).toBeUndefined(); // not confirmed by storage, so not shown as saved
    // Storage answers again: later saves are not lost behind the unanswered one for good.
    f.stuck.history = false;
    await f.controller.dispose();
  });
  it("dispose completes too", async () => {
    const f = await live();
    f.controller.historyTeardownWaitMs = 60;
    await f.transcribe("Page is closing.");
    f.stuck.history = true;
    const started = Date.now();
    await f.controller.dispose();
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it("waits for a save that answers in time, as before", async () => {
    const f = await live();
    expect(f.controller.historyTeardownWaitMs).toBeGreaterThanOrEqual(5000);
    await f.transcribe("Saved by Stop.");
    await f.controller.disconnect();
    expect(f.controller.openHistorySession(f.sessionId)?.entries.map(entry => entry.text)).toEqual(["Saved by Stop."]);
    expect(f.historyWrites.slice(0, 2)).toEqual([historyShardKey(f.sessionId), HISTORY_INDEX_KEY]);
    expect(f.controller.openHistorySession(f.sessionId)?.session.endedAt).toEqual(expect.any(String));
    await f.controller.dispose();
  });
});
