import { describe, expect, it, vi } from "vitest";
import { AudioEvent, AudioInputSource, AudioSpeakerRole, StartUpPageCreateResult, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { DirectConversationTransport, HISTORY_INDEX_KEY, historyShardKey, type DirectConversationOptions, type GatewayEvent } from "@helix/conversation-sdk";
import { G2ConversationController, LIVE_HISTORY_WRITE_DELAY_MS, type G2BridgePort } from "../src/controller";
import { GlassesRenderer } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";
import { DEFAULT_CONFIG } from "../src/config";

const form = { ...DEFAULT_CONFIG, transcriptionProvider: "openai-whisper" as const, copilotSummarize: false, copilotConcepts: false, copilotConflicts: false, copilotSuggestions: false,
  copilotImplicitAsks: false, copilotWebGrounding: false, liveWebFactCheck: true, autoQuestion: false, autoAnswer: false, autoNotes: false,
  accessToken: "", openaiApiKey: "test-key", deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", saveApiKeysOnPhone: false };
const omi = [{ id: "one", created_at: "2026-09-01T00:00:00Z", structured: { title: "Budget" }, transcript_segments: [{ text: "The launch budget is sixty thousand.", speaker: "Art" }] }];

/** Live session with the production coalescing window (long enough that nothing saves on its own during a test). */
async function live(storage = new Map<string, string>(), delayMs = 60_000) {
  let hub: ((event: EvenHubEvent) => void) | undefined, speech = "", options!: DirectConversationOptions;
  const historyWrites: string[] = [];
  const bridge: G2BridgePort = {
    getLocalStorage: async key => storage.get(key) ?? "",
    setLocalStorage: async (key, value) => { if (key.startsWith("helix.g2.history.")) historyWrites.push(key); storage.set(key, value); return true; },
    createStartUpPageContainer: async () => StartUpPageCreateResult.success,
    textContainerUpgrade: async () => true,
    audioControl: async () => true,
    shutDownPageContainer: async () => true,
    onEvenHubEvent: listener => { hub = listener; return () => { hub = undefined; }; },
  };
  const events: GatewayEvent[] = [];
  const presentation = new ConversationPresentation();
  const controller = new G2ConversationController(bridge, new GlassesRenderer(bridge, { debounceMs: 0 }), presentation, opts => {
    options = opts!;
    const transport = new DirectConversationTransport({ ...opts, insights: undefined, factCheck: { ...opts!.factCheck!, enabled: () => false },
      fetch: async url => url.endsWith("transcriptions") ? Response.json({ text: speech }) : new Response("{}", { status: 404 }) });
    transport.subscribe(event => events.push(event));
    return transport;
  });
  controller.liveHistoryWriteDelayMs = delayMs;
  await controller.initialize();
  await controller.connect(form);
  const sessionId = controller.liveSessionId()!;
  const transcribe = async (text: string) => {
    const count = events.filter(event => event.type === "transcript.final").length;
    speech = text;
    await controller.beginHold();
    hub?.({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array(new Int16Array(3200).fill(4000).buffer), source: AudioInputSource.Glasses, speakerRole: AudioSpeakerRole.Other }) } as EvenHubEvent);
    await controller.releaseHold();
    await vi.waitFor(() => expect(events.filter(event => event.type === "transcript.final")).toHaveLength(count + 1));
    return events.filter(event => event.type === "transcript.final").at(-1)! as Extract<GatewayEvent, { type: "transcript.final" }>;
  };
  const fact = (transcriptId: string, id: string) => options.factCheck!.onResult({ id, sessionId, transcriptId, claim: "Claim", summary: "Sourced", status: "supported",
    checkedAt: new Date().toISOString(), sources: [{ url: "https://example.com/source", title: "Source" }] });
  return { controller, presentation, storage, historyWrites, sessionId, transcribe, fact, copilot: () => options.copilot! };
}

describe("live history write coalescing", () => {
  it("app bootstrap value is 10 s (v0.12.1: fewer bridge storage writes)", () => expect(LIVE_HISTORY_WRITE_DELAY_MS).toBe(10_000));
  it("coalesces a live session's writes into one shard write and one index write, committed only when saved", async () => {
    const f = await live();
    const first = await f.transcribe("Order the Jetson boards this week.");
    await f.transcribe("Finance approved the budget.");
    await f.transcribe("Lead time is twelve weeks.");
    f.fact(first.transcriptId, "fact-1");
    const now = new Date().toISOString();
    f.copilot().onSummary!({ bullets: ["Hardware order."], keyFacts: ["12 weeks"], updatedAt: now, transcriptChars: 80 });
    f.controller.flushSessionKnowledge(); // Knowledge for a record that is itself still pending.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.historyWrites).toEqual([]);
    expect(f.controller.openHistorySession(f.sessionId)).toBeUndefined(); // Commit after save.
    await f.controller.flushHistory();
    expect(f.historyWrites).toEqual([historyShardKey(f.sessionId), HISTORY_INDEX_KEY]);
    const record = f.controller.openHistorySession(f.sessionId)!;
    expect(record.entries.map(entry => entry.kind)).toEqual(["transcript", "transcript", "transcript", "fact-check"]);
    expect(record.session).toMatchObject({ title: "Order the Jetson boards this week.", summary: ["Hardware order."], keyFacts: ["12 weeks"] });
    expect(f.controller.historySnapshot().status).toBe("Saved on this phone.");
    await f.transcribe("One more line.");
    await f.controller.disconnect(); // Saves the rest.
    expect(f.historyWrites).toEqual([historyShardKey(f.sessionId), HISTORY_INDEX_KEY, historyShardKey(f.sessionId), HISTORY_INDEX_KEY]);
    await f.controller.dispose();
    const restarted = await live(f.storage);
    expect(restarted.controller.openHistorySession(f.sessionId)?.entries).toHaveLength(5);
    await restarted.controller.dispose();
  });
  it("saves pending writes on dispose", async () => {
    const f = await live();
    await f.transcribe("Saved by dispose.");
    expect(f.historyWrites).toEqual([]);
    await f.controller.dispose();
    expect(f.historyWrites).toEqual([historyShardKey(f.sessionId), HISTORY_INDEX_KEY]);
  });
  it("deletes and imports immediately during a live session instead of waiting for the window", async () => {
    const f = await live();
    await f.transcribe("Delete me.");
    const started = Date.now();
    // Import writes through (sequential awaited saves) and also saves the pending live write.
    await f.controller.importOmi({ key: "omi-test", fetch: async () => Response.json(omi) });
    expect(f.controller.openHistorySession("omi:one")?.entries).toHaveLength(1);
    expect(f.controller.openHistorySession(f.sessionId)?.entries).toHaveLength(1);
    await f.transcribe("Pending when the deletion starts.");
    await f.controller.deleteHistorySession(f.sessionId);
    expect(f.controller.openHistorySession(f.sessionId)).toBeUndefined();
    expect(f.storage.get(historyShardKey(f.sessionId))).toBe("");
    expect(Date.now() - started).toBeLessThan(5000);
    const after = await f.transcribe("Not archived: the live record was deleted.");
    expect(after.sessionId).toBe(f.sessionId);
    await f.controller.disconnect();
    expect(f.controller.openHistorySession(f.sessionId)).toBeUndefined();
    await f.controller.dispose();
  });
  it("reports a failed coalesced save and keeps the last saved state", async () => {
    const f = await live();
    await f.controller.flushHistory();
    await f.transcribe("Will fail.");
    vi.spyOn(f.storage, "set").mockImplementation((key, value) => { if (key === HISTORY_INDEX_KEY) throw new Error("quota"); return Map.prototype.set.call(f.storage, key, value) as Map<string, string>; });
    await expect(f.controller.flushHistory()).rejects.toThrow("Could not save local history");
    expect(f.controller.historySnapshot().status).toContain("Could not save local history");
    expect(f.controller.openHistorySession(f.sessionId)?.entries).toEqual([]);
    vi.restoreAllMocks();
    await f.transcribe("Recovered.");
    await f.controller.disconnect();
    expect(f.controller.openHistorySession(f.sessionId)?.entries.map(entry => entry.text)).toEqual(["Recovered."]);
    await f.controller.dispose();
  });
});
