import {
  AudioEvent,
  AudioInputSource,
  AudioSpeakerRole,
  OsEventTypeList,
  StartUpPageCreateResult,
  type CreateStartUpPageContainer,
  type EvenHubEvent,
  type TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { G2ConversationController, type G2BridgePort } from "../src/controller";
import { GlassesRenderer } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";
import type { SessionFormState } from "../src/config";
import { WebSocketConversationTransport } from "@helix/conversation-sdk";

// Legacy protocol adapter used only to observe controller gesture ordering.
function testController(bridge: FakeBridge, renderer: GlassesRenderer, presentation: ConversationPresentation) {
  return new G2ConversationController(bridge, renderer, presentation, () => new WebSocketConversationTransport({
    url: "ws://127.0.0.1:8787/v2/conversations", protocols: ["helix.v2", "helix-auth.c2hvcnQtbGl2ZWQtdG9rZW4"],
  }));
}

type FakeListener = (event: { data?: unknown }) => void;

class FakeWebSocket {
  public static latest?: FakeWebSocket;
  public readyState = 0;
  public binaryType = "blob";
  public readonly sent: Array<string | ArrayBuffer | ArrayBufferView | Blob> = [];
  public readonly protocols: string | readonly string[] | undefined;
  private readonly listeners = new Map<string, Set<FakeListener>>();

  public constructor(_url: string, protocols?: string | readonly string[]) {
    this.protocols = protocols;
    FakeWebSocket.latest = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  public addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) ?? new Set<FakeListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: FakeListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  public send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    this.sent.push(data);
    if (typeof data !== "string") return;

    const message = JSON.parse(data) as Record<string, unknown>;
    if (message.type !== "session.start") return;
    const session = message.session as {
      sessionId: string;
      endpoint: object;
      prompt: { id: string; version: string };
      mode?: "general" | "interviewee" | "interviewer" | "social" | "office-discussion" | "passive";
      responseStrategy?: "reactive" | "proactive" | "both";
      providers?: {
        transcriptionProvider?: string;
        answerProvider?: string;
      };
      memory?: {
        readOmiContext: boolean;
        syncNotes: boolean;
      };
      automation?: {
        detectQuestions: boolean;
        answerQuestions: boolean;
        saveNotes: boolean;
      };
      audio: object;
    };
    queueMicrotask(() => this.emit("message", {
      data: JSON.stringify({
        protocolVersion: "2.1",
        type: "session.started",
        eventId: "event_started",
        sessionId: session.sessionId,
        occurredAt: new Date().toISOString(),
        accepted: {
          prompt: { id: session.prompt.id, version: session.prompt.version },
          endpoint: session.endpoint,
          audio: session.audio,
          mode: session.mode,
          responseStrategy: session.responseStrategy,
          transcriptionProvider: session.providers?.transcriptionProvider
            ? { profileId: session.providers.transcriptionProvider }
            : undefined,
          answerProvider: session.providers?.answerProvider
            ? { profileId: session.providers.answerProvider }
            : undefined,
          memory: session.memory,
          automation: session.automation,
        },
      }),
    }));
  }

  public close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

class FakeBridge implements G2BridgePort {
  public readonly calls: string[] = [];
  public readonly storage = new Map<string, string>();
  public readonly updates: TextContainerUpgrade[] = [];
  public readonly shutdownModes: number[] = [];
  private eventListener?: (event: EvenHubEvent) => void;

  public async createStartUpPageContainer(
    _container: CreateStartUpPageContainer,
  ): Promise<StartUpPageCreateResult> {
    this.calls.push("startup-page");
    return StartUpPageCreateResult.success;
  }

  public async textContainerUpgrade(container: TextContainerUpgrade): Promise<boolean> {
    this.updates.push(container);
    return true;
  }

  public async audioControl(isOpen: boolean, source?: AudioInputSource): Promise<boolean> {
    this.calls.push(`audio:${String(isOpen)}:${source ?? "default"}`);
    return true;
  }

  public async shutDownPageContainer(exitMode = 0): Promise<boolean> {
    this.shutdownModes.push(exitMode);
    return true;
  }

  public onEvenHubEvent(callback: (event: EvenHubEvent) => void): () => void {
    this.eventListener = callback;
    return () => { this.eventListener = undefined; };
  }

  public async getLocalStorage(key: string): Promise<string> {
    return this.storage.get(key) ?? "";
  }

  public async setLocalStorage(key: string, value: string): Promise<boolean> {
    this.storage.set(key, value);
    return true;
  }

  public emit(event: object): void {
    this.eventListener?.(event as EvenHubEvent);
  }
}

const form: SessionFormState = {
  copilotModel: "gpt-6-luna", copilotSummarize: true, copilotConcepts: true, copilotConflicts: true,
  copilotSuggestions: true, copilotImplicitAsks: true, copilotWebGrounding: true,
  autoExplainTerms: true,
  useLocalMemory: true,
  liveWebFactCheck: false,
  gatewayUrl: "ws://127.0.0.1:8787/v2/conversations",
  accessToken: "short-lived-token",
  openaiApiKey: "",
  deepgramApiKey: "",
  sonioxApiKey: "",
  omiApiKey: "",
  saveApiKeysOnPhone: false,
  endpointId: "test-endpoint",
  provider: "mock",
  model: "mock-fast",
  promptId: "test-prompt",
  promptVersion: "1",
  instructions: "Answer directly.",
  locale: "en",
  maxResponseSentences: 3,
  conversationMode: "interviewer",
  responseStrategy: "proactive",
  transcriptionProvider: "soniox",
  answerProvider: "openai-responses",
  autoQuestion: true,
  autoAnswer: true,
  autoNotes: true,
  readOmiContext: true,
  syncOmiNotes: true,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWebSocket.latest = undefined;
});

describe("G2 controller integration", () => {
  it("cancels pending taps when the OS overlay opens and dispatches native shortcuts without disconnecting", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    const bridge = new FakeBridge(), presentation = new ConversationPresentation();
    const controller = testController(bridge, new GlassesRenderer(bridge), presentation);
    await controller.initialize(); await controller.connect(form);
    const socket = FakeWebSocket.latest!;
    const queries = () => socket.sent.filter((item): item is string => typeof item === "string").map(item => JSON.parse(item)).filter(item => item.type === "query");
    vi.useFakeTimers();
    bridge.emit({ textEvent: {} });
    bridge.emit({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT }, textEvent: {} });
    await vi.advanceTimersByTimeAsync(300); expect(queries()).toEqual([]);
    bridge.emit({ menuItemClickEvent: { itemID: 1 }, textEvent: {} });
    await vi.advanceTimersByTimeAsync(300);
    expect(queries()).toHaveLength(1);
    expect(queries()[0].text).toContain("technical term");
    expect(queries()[0].text).toContain("whole captured conversation");
    expect(presentation.snapshot().glasses.manualPending).toBe(true);
    bridge.emit({ menuItemClickEvent: { itemID: 2 } }); bridge.emit({ menuItemClickEvent: { itemID: 3 } });
    await vi.advanceTimersByTimeAsync(1);
    expect(queries().slice(1).map(q => q.contextScope)).toEqual(["local", "global"]);
    bridge.emit({ textEvent: {} }); bridge.emit({ menuItemClickEvent: { itemID: 99 } });
    bridge.emit({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT }, textEvent: {} });
    await vi.advanceTimersByTimeAsync(300); expect(queries()).toHaveLength(3);
    expect(socket.readyState).toBe(1); expect(bridge.shutdownModes).toEqual([]);
    await controller.dispose();
  });
  it("discriminates click/local from double/global, replaces requests and cancels pending clicks on exit", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    const bridge = new FakeBridge(), presentation = new ConversationPresentation();
    const controller = testController(bridge, new GlassesRenderer(bridge), presentation);
    await controller.initialize();
    await controller.connect(form);
    const socket = FakeWebSocket.latest!;
    const queries = () => socket.sent.filter((item): item is string => typeof item === "string")
      .map(item => JSON.parse(item)).filter(item => item.type === "query");
    vi.useFakeTimers();
    bridge.emit({ textEvent: {} });
    await vi.advanceTimersByTimeAsync(249);
    expect(queries()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(queries()).toHaveLength(1);
    expect(queries()[0]).toMatchObject({ contextScope: "local", speaker: { label: "Local context" } });
    bridge.emit({ sysEvent: {} });
    await vi.advanceTimersByTimeAsync(100);
    bridge.emit({ textEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } });
    await vi.advanceTimersByTimeAsync(250);
    expect(queries()).toHaveLength(2);
    expect(queries()[1]).toMatchObject({ contextScope: "global", speaker: { label: "Whole conversation" } });
    expect(bridge.shutdownModes).toEqual([]);
    expect(bridge.calls).toEqual(["startup-page"]);
    expect(FakeWebSocket.latest).toBe(socket);
    await controller.askContext("local");
    expect(queries()).toHaveLength(3);
    bridge.emit({ sysEvent: {} });
    bridge.emit({ sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(queries()).toHaveLength(3);
    expect(presentation.snapshot().status).toBe("exited");
    expect(socket.readyState).toBe(3);
    vi.useRealTimers();
  });
  it("uses the default phone transport without a WebSocket and closes the microphone on provider auth failure", async () => {
    const socket = vi.fn(); vi.stubGlobal("WebSocket", socket);
    const fetcher = vi.fn(async () => new Response("private upstream detail", { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    const bridge = new FakeBridge(), presentation = new ConversationPresentation();
    const controller = new G2ConversationController(bridge, new GlassesRenderer(bridge), presentation);
    await controller.initialize();
    await controller.connect({ ...form, gatewayUrl: "", openaiApiKey: "runtime", transcriptionProvider: "openai-whisper", readOmiContext: false, syncOmiNotes: false });
    await controller.startListening(); await controller.ask("What next?");
    await vi.waitFor(() => expect(presentation.snapshot().status).toBe("failed"));
    expect(socket).not.toHaveBeenCalled();
    // One model-access probe (GET /v1/models, 401 -> ignored) plus the single answer request.
    expect((fetcher.mock.calls as unknown as [string][]).filter(([url]) => !url.endsWith("/models"))).toHaveLength(1);
    expect(bridge.calls.at(-1)).toBe(`audio:false:${AudioInputSource.Glasses}`);
    expect(JSON.stringify(presentation.snapshot())).not.toContain("private upstream detail");
    expect(JSON.stringify(presentation.snapshot())).not.toContain("Gateway connection failed");
    await controller.dispose();
  });
  it("serializes phone pause and hold/release, drains tail audio, ignores duplicate release, and exits without a host follow-up event", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    const bridge = new FakeBridge();
    const presentation = new ConversationPresentation();
    const controller = testController(bridge, new GlassesRenderer(bridge), presentation);
    await controller.initialize();
    await controller.connect(form);
    const socket = FakeWebSocket.latest!;
    const emit = (eventType: OsEventTypeList) => bridge.emit({ sysEvent: { eventType } });
    const commits = () => socket.sent.filter((item): item is string => typeof item === "string")
      .map((item) => JSON.parse(item)).filter((item) => item.type === "audio.commit");
    await controller.startListening();
    await vi.waitFor(() => expect(presentation.snapshot().status).toBe("listening"));
    await controller.togglePause();
    await vi.waitFor(() => expect(presentation.snapshot().status).toBe("paused"));
    emit(OsEventTypeList.LONG_PRESS_EVENT);
    await vi.waitFor(() => expect(presentation.snapshot().glasses.interaction).toContain("HOLDING"));
    bridge.emit({ audioEvent: new AudioEvent({
      audioPcm: new Uint8Array([0x34, 0x12, 0x34, 0x12]),
      source: AudioInputSource.Glasses, speakerRole: AudioSpeakerRole.Self,
    }) });
    // Release arrives before the pending audio-send microtask has drained.
    emit(OsEventTypeList.LONG_PRESS_RELEASE_EVENT);
    emit(OsEventTypeList.LONG_PRESS_RELEASE_EVENT);
    await vi.waitFor(() => expect(presentation.snapshot().glasses.interaction).toContain("SENT"));
    expect(presentation.snapshot().status).toBe("paused");
    expect(commits()).toHaveLength(1);
    expect(socket.sent.findIndex((item) => item instanceof ArrayBuffer))
      .toBeLessThan(socket.sent.findIndex((item) => typeof item === "string" && item.includes('"audio.commit"')));
    await controller.beginHold();
    await controller.releaseHold();
    expect(commits()).toHaveLength(1);
    expect(presentation.snapshot().glasses.interaction).toContain("NO NEW AUDIO");
    await controller.startListening();
    void controller.requestExit();
    void controller.requestExit();
    await vi.waitFor(() => expect(bridge.shutdownModes).toEqual([1]));
    expect(presentation.snapshot().status).toBe("exited");
    expect(socket.readyState).toBe(3);
    expect(bridge.calls.at(-1)).toBe("audio:false:default");
    const calls = bridge.calls.length;
    emit(OsEventTypeList.CLICK_EVENT);
    await controller.togglePause();
    expect(bridge.calls).toHaveLength(calls);
  });

  it("leaves continuous listening enabled after a hold and clears old content on reconnect", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    const bridge = new FakeBridge();
    const presentation = new ConversationPresentation();
    const controller = testController(bridge, new GlassesRenderer(bridge), presentation);
    await controller.initialize();
    await controller.connect(form);
    await controller.startListening();
    await controller.beginHold();
    await controller.beginHold();
    await controller.releaseHold();
    expect(presentation.snapshot().status).toBe("listening");
    expect(bridge.calls.filter((call) => call.startsWith("audio:true"))).toHaveLength(1);
    presentation.setInteraction("OLD TURN");
    await controller.connect(form);
    expect(presentation.snapshot().glasses.interaction).toBeUndefined();
    expect(presentation.snapshot().feed).toEqual([]);
    await controller.dispose();
  });
  it("rejects credential-shaped persisted values before storage or transport startup", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    const bridge = new FakeBridge();
    const presentation = new ConversationPresentation();
    const renderer = new GlassesRenderer(bridge);
    const controller = testController(bridge, renderer, presentation);

    await controller.initialize();
    await expect(controller.connect({
      ...form,
      instructions: "Use api_key=abcdefghijklmnopqrstuvwxyz012345 for this request",
    })).rejects.toThrow("instructions looks like a credential");

    expect(bridge.storage.size).toBe(0);
    expect(FakeWebSocket.latest).toBeUndefined();
    await controller.dispose();
  });

  it("orders startup, authenticated session, glasses mic, audio metadata, and exit cleanup", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    const bridge = new FakeBridge();
    const presentation = new ConversationPresentation();
    const renderer = new GlassesRenderer(bridge);
    const controller = testController(bridge, renderer, presentation);

    await controller.initialize();
    await controller.connect(form);
    await vi.waitFor(() => expect(presentation.snapshot().status).toBe("connected"));

    const socket = FakeWebSocket.latest;
    expect(socket?.protocols).toEqual(["helix.v2", "helix-auth.c2hvcnQtbGl2ZWQtdG9rZW4"]);
    const startCommand = socket?.sent
      .filter((item): item is string => typeof item === "string")
      .map((item) => JSON.parse(item) as Record<string, unknown>)
      .find((item) => item.type === "session.start");
    expect(startCommand?.session).toMatchObject({
      mode: "interviewer",
      responseStrategy: "proactive",
      providers: {
        transcriptionProvider: "soniox",
        answerProvider: "openai-responses",
      },
      memory: {
        readOmiContext: false,
        syncNotes: false,
      },
      prompt: {
        mode: "interviewer",
      },
      client: {
        name: "@helix/g2-plugin",
        version: "0.7.0",
      },
    });
    expect(bridge.calls).toEqual(["startup-page"]);

    await controller.startListening();
    expect(bridge.calls).toEqual([
      "startup-page",
      `audio:true:${AudioInputSource.Glasses}`,
    ]);

    bridge.emit({
      audioEvent: new AudioEvent({
        audioPcm: new Uint8Array([0x34, 0x12, 0xcc, 0xff]),
        source: AudioInputSource.Glasses,
        direction: -27,
        speakerRole: AudioSpeakerRole.Other,
      }),
    });

    await vi.waitFor(() => {
      expect(socket?.sent.some((item) => item instanceof ArrayBuffer)).toBe(true);
    });
    const metadataFrame = socket?.sent
      .filter((item): item is string => typeof item === "string")
      .map((item) => JSON.parse(item) as Record<string, unknown>)
      .find((item) => item.type === "audio.frame");
    expect(metadataFrame).toMatchObject({
      source: AudioInputSource.Glasses,
      direction: -27,
      speakerRole: "other",
      sampleCount: 2,
    });

    bridge.emit({ sysEvent: { eventType: OsEventTypeList.SYSTEM_EXIT_EVENT } });
    await vi.waitFor(() => expect(socket?.readyState).toBe(3));
    expect(bridge.calls.at(-1)).toBe("audio:false:default");
  });

  it("omits provider preferences only when both profiles use the gateway defaults", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    const bridge = new FakeBridge();
    const presentation = new ConversationPresentation();
    const renderer = new GlassesRenderer(bridge);
    const controller = testController(bridge, renderer, presentation);

    await controller.initialize();
    await controller.connect({
      ...form,
      transcriptionProvider: "gateway-default",
      answerProvider: "gateway-default",
    });
    await vi.waitFor(() => expect(presentation.snapshot().status).toBe("connected"));

    const startCommand = FakeWebSocket.latest?.sent
      .filter((item): item is string => typeof item === "string")
      .map((item) => JSON.parse(item) as Record<string, unknown>)
      .find((item) => item.type === "session.start");
    expect(startCommand?.session).not.toHaveProperty("providers");

    await controller.dispose();
  });

  it("passes trimmed BYOK exactly once outside the persisted session to its injected transport", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    const bridge = new FakeBridge();
    const presentation = new ConversationPresentation();
    const renderer = new GlassesRenderer(bridge);
    const controller = testController(bridge, renderer, presentation);

    await controller.initialize();
    await controller.connect({
      ...form,
      gatewayUrl: "wss://gateway.example.com/v2/conversations",
      openaiApiKey: " openai-runtime ",
      deepgramApiKey: "deepgram-runtime",
      sonioxApiKey: "soniox-runtime",
      omiApiKey: "omi-runtime",
    });
    await vi.waitFor(() => expect(presentation.snapshot().status).toBe("connected"));
    await controller.ask("What comes next?");
    const commands = FakeWebSocket.latest?.sent
      .filter((item): item is string => typeof item === "string")
      .map((item) => JSON.parse(item) as Record<string, unknown>) ?? [];
    const start = commands.find((item) => item.type === "session.start");
    expect(start).toMatchObject({
      credentials: {
        openai: "openai-runtime",
        soniox: "soniox-runtime",
      },
    });
    expect(start?.session).not.toHaveProperty("credentials");
    expect(start?.credentials).not.toHaveProperty("omi");
    expect(commands.filter((item) => "credentials" in item)).toHaveLength(1);
    expect(JSON.stringify(FakeWebSocket.latest?.protocols ?? "")).not.toContain("openai-runtime");
    await controller.dispose();
  });

  it("sends one manual query and waits for the gateway event before presenting it", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    const bridge = new FakeBridge();
    const presentation = new ConversationPresentation();
    const renderer = new GlassesRenderer(bridge);
    const controller = testController(bridge, renderer, presentation);

    await controller.initialize();
    await controller.connect({ ...form, autoNotes: false });
    await vi.waitFor(() => expect(presentation.snapshot().status).toBe("connected"));

    await controller.ask("  What should I say next?  ");

    const queryCommands = FakeWebSocket.latest?.sent
      .filter((item): item is string => typeof item === "string")
      .map((item) => JSON.parse(item) as Record<string, unknown>)
      .filter((item) => item.type === "query");
    expect(queryCommands).toHaveLength(1);
    expect(queryCommands?.[0]).toMatchObject({
      text: "What should I say next?",
      speaker: { label: "You", role: "self" },
    });
    expect(presentation.snapshot().feed).toEqual([]);

    await controller.dispose();
  });
  it("v0.12.2 audio intake: 20 ms frames are handed on in ~100 ms batches, and a backlog delivered at once after a suspension is dropped", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 10, 21, 20, 0, 0) });
    const bridge = new FakeBridge();
    const presentation = new ConversationPresentation();
    const controller = testController(bridge, new GlassesRenderer(bridge), presentation);
    controller.audioRealtimeGuard = true;
    await controller.initialize();
    await controller.connect(form);
    const socket = FakeWebSocket.latest!;
    await controller.startListening();
    await vi.waitFor(() => expect(presentation.snapshot().status).toBe("listening"));
    const frame = () => bridge.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array(640).fill(7), source: AudioInputSource.Glasses, speakerRole: AudioSpeakerRole.Other }) });
    const audio = () => socket.sent.filter((item): item is ArrayBuffer => item instanceof ArrayBuffer);
    const bytes = () => audio().reduce((sum, item) => sum + item.byteLength, 0);
    // One second of live audio, 20 ms apart: 50 frames in, 10 hand-offs of 100 ms out, nothing lost.
    for (let i = 0; i < 50; i++) { vi.setSystemTime(Date.now() + 20); frame(); }
    await vi.waitFor(() => expect(bytes()).toBe(50 * 640));
    expect(audio()).toHaveLength(10);
    // Locked for 5 minutes: the native side queued 15,000 frames and delivers them in one go on resume.
    vi.setSystemTime(Date.now() + 300_000);
    const before = bytes();
    for (let i = 0; i < 15_000; i++) frame();
    await controller.togglePause(); // drains what was accepted
    const accepted = (bytes() - before) / 640 / 50;
    expect(accepted).toBeGreaterThan(1.5); expect(accepted).toBeLessThanOrEqual(2); // only the 2 s burst allowance
    // Live audio afterwards flows normally again.
    await controller.startListening();
    await vi.waitFor(() => expect(presentation.snapshot().status).toBe("listening"));
    const resumed = bytes();
    for (let i = 0; i < 25; i++) { vi.setSystemTime(Date.now() + 20); frame(); }
    await vi.waitFor(() => expect(bytes() - resumed).toBe(25 * 640));
    vi.useRealTimers();
    await controller.dispose();
  });
  it("v0.12.3 overload while locked: audio arriving slower than it is recorded on a hidden page pauses the microphone; a visible page resumes it", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    const doc = { visibilityState: "visible" };
    vi.stubGlobal("document", doc);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: Date.UTC(2026, 10, 21, 20, 0, 0) });
    const bridge = new FakeBridge();
    const presentation = new ConversationPresentation();
    const controller = testController(bridge, new GlassesRenderer(bridge), presentation);
    controller.audioRealtimeGuard = true;
    await controller.initialize();
    await controller.connect(form);
    await controller.startListening();
    await vi.waitFor(() => expect(presentation.snapshot().status).toBe("listening"));
    const frame = () => bridge.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array(640).fill(7), source: AudioInputSource.Glasses, speakerRole: AudioSpeakerRole.Other }) });
    const micCalls = () => bridge.calls.filter(call => call.startsWith("audio:"));
    // This device delivers 42 frames a second in the foreground (as measured): that is the baseline, not an overload.
    for (let i = 0; i < 42 * 8; i++) { vi.setSystemTime(Date.now() + 24); frame(); }
    expect(controller.audioPausedForLoad).toBe(false);
    const opened = micCalls().length;
    // Visible but slow (weak link): never paused.
    for (let i = 0; i < 24 * 10; i++) { vi.setSystemTime(Date.now() + 42); frame(); }
    expect(controller.audioPausedForLoad).toBe(false);
    for (let i = 0; i < 42 * 4; i++) { vi.setSystemTime(Date.now() + 24); frame(); }
    // Locked: every event now takes 42 ms, so 24 a second get through.
    doc.visibilityState = "hidden";
    for (let i = 0; i < 24 * 5; i++) { vi.setSystemTime(Date.now() + 42); frame(); }
    expect(controller.audioPausedForLoad).toBe(false); // not on the first slow seconds
    for (let i = 0; i < 24 * 4; i++) { vi.setSystemTime(Date.now() + 42); frame(); }
    expect(controller.audioPausedForLoad).toBe(true);
    expect(micCalls().slice(opened)).toEqual([`audio:false:${AudioInputSource.Glasses}`]);
    expect(presentation.snapshot().glasses.interaction).toContain("MIC PAUSED");
    // A glasses event while still locked does not turn it back on.
    await controller.resumeFromBackground("foreground-enter");
    expect(controller.audioPausedForLoad).toBe(true);
    // Unlock: microphone back on.
    doc.visibilityState = "visible";
    vi.setSystemTime(Date.now() + 5000);
    await controller.resumeFromBackground("visible");
    expect(controller.audioPausedForLoad).toBe(false);
    expect(micCalls().at(-1)).toBe(`audio:true:${AudioInputSource.Glasses}`);
    // Locked again and overloaded again: paused, then the retry timer re-opens it after 30 s.
    doc.visibilityState = "hidden";
    for (let i = 0; i < 24 * 9; i++) { vi.setSystemTime(Date.now() + 42); frame(); }
    expect(controller.audioPausedForLoad).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(controller.audioPausedForLoad).toBe(false);
    expect(micCalls().at(-1)).toBe(`audio:true:${AudioInputSource.Glasses}`);
    vi.useRealTimers();
    await controller.dispose();
  });
});
