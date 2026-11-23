import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioEvent, AudioInputSource, AudioSpeakerRole, StartUpPageCreateResult, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { DirectConversationTransport, LocalHistoryStore, type DirectConversationOptions, type GatewayEvent } from "@helix/conversation-sdk";
import { G2ConversationController, type G2BridgePort } from "../src/controller";
import { GlassesRenderer } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";
import { DEFAULT_CONFIG } from "../src/config";

const form = { ...DEFAULT_CONFIG, transcriptionProvider: "openai-whisper" as const, copilotSummarize: false, copilotConcepts: false, copilotConflicts: false, copilotSuggestions: false,
  copilotImplicitAsks: false, copilotWebGrounding: false, liveWebFactCheck: false, autoQuestion: false, autoAnswer: false, autoNotes: false,
  accessToken: "", openaiApiKey: "test-key", deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", saveApiKeysOnPhone: false };

/** Live session whose history writes can be held: while `slow.on`, they are answered only by release(). */
async function live(delayMs = 60_000) {
  let hub: ((event: EvenHubEvent) => void) | undefined, speech = "";
  const storage = new Map<string, string>(), slow = { on: false }, held: (() => void)[] = [];
  const bridge: G2BridgePort = {
    getLocalStorage: async key => storage.get(key) ?? "",
    setLocalStorage: (key, value) => new Promise<boolean>(resolve => {
      const answer = () => { storage.set(key, value); resolve(true); };
      if (slow.on && key.startsWith("helix.g2.history.")) held.push(answer); else answer();
    }),
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
  controller.summarizeOnEnd = false;
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
    await new Promise(resolve => setTimeout(resolve, 5)); // the archive write is issued behind the event
  };
  const release = () => { slow.on = false; for (const answer of held.splice(0)) answer(); };
  return { controller, presentation, slow, release, sessionId, transcribe };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("v15 history fix: a session whose save outlasts the Stop wait is still finalized", () => {
  it("records the end time and the on-phone title once the late save lands", async () => {
    const f = await live();
    f.controller.historyTeardownWaitMs = 60;
    await f.transcribe("Order the Jetson boards this week.");
    f.slow.on = true;
    const started = Date.now();
    await f.controller.disconnect();
    expect(Date.now() - started).toBeLessThan(2000); // Stop itself still does not wait for storage
    expect(f.presentation.snapshot().status).toBe("ready");
    expect(f.controller.openHistorySession(f.sessionId)).toBeUndefined();
    f.release(); // storage answers after Stop gave up waiting
    await vi.waitFor(() => expect(f.controller.openHistorySession(f.sessionId)?.session.endedAt).toEqual(expect.any(String)));
    const record = f.controller.openHistorySession(f.sessionId)!;
    expect(record.entries.map(entry => entry.text)).toEqual(["Order the Jetson boards this week."]);
    expect(record.session.recap?.origin).toBe("fallback");
    expect(record.session.title).toBeTruthy();
    await f.controller.dispose();
  });
  it("is not finalized from the part of the transcript that was saved before Stop", async () => {
    const f = await live();
    f.controller.historyTeardownWaitMs = 60;
    await f.transcribe("Morning.");
    await f.controller.flushHistory(); // the first line is saved
    f.slow.on = true;
    await f.transcribe("We agreed to order the Jetson boards this week.");
    const recap = vi.spyOn(LocalHistoryStore.prototype, "updateSessionRecap");
    await f.controller.disconnect();
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(recap).not.toHaveBeenCalled(); // the title and the summary gate wait for the rest of the lines
    f.release();
    await vi.waitFor(() => expect(f.controller.openHistorySession(f.sessionId)?.session.endedAt).toEqual(expect.any(String)));
    expect(f.controller.openHistorySession(f.sessionId)!.entries).toHaveLength(2);
    await f.controller.dispose();
  });
  it("a save that answers in time is finalized before Stop returns, as before", async () => {
    const f = await live();
    await f.transcribe("Saved by Stop.");
    await f.controller.disconnect();
    expect(f.controller.openHistorySession(f.sessionId)?.session.endedAt).toEqual(expect.any(String));
    await f.controller.dispose();
  });
});
