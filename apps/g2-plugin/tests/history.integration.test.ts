import { describe, expect, it, vi } from "vitest";
import { AudioEvent, AudioInputSource, AudioSpeakerRole, StartUpPageCreateResult, type TextContainerUpgrade, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { DirectConversationTransport, type DirectConversationOptions, type GatewayEvent, type FactCheckResult, type ContextInsight } from "@helix/conversation-sdk";
import { G2ConversationController, type G2BridgePort } from "../src/controller";
import { GlassesRenderer } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";
import { DEFAULT_CONFIG } from "../src/config";
import { safeSourceUrl, memoryEntryIds } from "../src/history-panel";

function fixture(storage = new Map<string, string>(), factory?: (options?: DirectConversationOptions) => DirectConversationTransport) {
  const updates: TextContainerUpgrade[] = [];
  let hubListener: ((event: EvenHubEvent) => void) | undefined;
  const bridge: G2BridgePort = {
    getLocalStorage: async key => storage.get(key) ?? "",
    setLocalStorage: async (key, value) => { storage.set(key, value); return true; },
    createStartUpPageContainer: async () => StartUpPageCreateResult.success,
    textContainerUpgrade: async update => { updates.push(update); return true; },
    audioControl: async () => true,
    shutDownPageContainer: async () => true,
    onEvenHubEvent: listener => { hubListener = listener; return () => { hubListener = undefined; }; },
  };
  const presentation = new ConversationPresentation();
  const renderer = new GlassesRenderer(bridge, { debounceMs: 0 });
  const controller = new G2ConversationController(bridge, renderer, presentation, factory);
  return { controller, presentation, updates, storage, bridge, emit: (event: object) => hubListener?.(event as EvenHubEvent) };
}
const form = { ...DEFAULT_CONFIG, transcriptionProvider: "openai-whisper" as const, copilotSummarize: false, copilotConcepts: false, copilotConflicts: false, copilotSuggestions: false, copilotImplicitAsks: false, copilotWebGrounding: false, accessToken: "", openaiApiKey: "test-key", deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", saveApiKeysOnPhone: false };
const omi = [{ id: "one", created_at: "2026-09-01T00:00:00Z", structured: { title: "预算 Budget" }, transcript_segments: [{ text: "预算给了六万元. The launch budget is sixty thousand.", speaker: "Art" }] }, { id: "empty", created_at: "2026-09-02T00:00:00Z", structured: { title: "Title-only meeting" } }];

async function webLaneFixture() {
  let speech = "";
  const events: GatewayEvent[] = [];
  const searches: { signal: AbortSignal; input: { earlierSpeech: string; claim: string }; at: number; resolve: (response: Response) => void }[] = [];
  const f = fixture(undefined, options => {
    const transport = new DirectConversationTransport({ ...options, insights: undefined, fetch: async (url, init) => {
      if (url.endsWith("transcriptions")) return Response.json({ text: speech });
      const body = JSON.parse(init!.body as string);
      if (body.tools) return new Promise<Response>(resolve => searches.push({ signal: init!.signal as AbortSignal, input: JSON.parse(body.input), at: Date.now(), resolve }));
      return new Response('data: {"type":"response.output_text.delta","delta":"Explicit answer."}\n\ndata: {"type":"response.completed"}\n\n');
    } });
    transport.subscribe(event => events.push(event));
    return transport;
  });
  await f.controller.initialize();
  await f.controller.connect({ ...form, liveWebFactCheck: true, autoQuestion: false, autoAnswer: false, autoNotes: false });
  const transcribe = async (text: string) => {
    const count = events.filter(event => event.type === "transcript.final").length;
    speech = text;
    await f.controller.beginHold();
    f.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array(new Int16Array(3200).fill(4000).buffer), source: AudioInputSource.Glasses, speakerRole: AudioSpeakerRole.Other }) });
    await f.controller.releaseHold();
    await vi.waitFor(() => expect(events.filter(event => event.type === "transcript.final")).toHaveLength(count + 1));
  };
  return { ...f, searches, transcribe };
}

async function liveHistoryFixture(beforeTranscription?: () => Promise<void>) {
  let options!: DirectConversationOptions;
  let transcriptText = "Original archived transcript";
  const events: GatewayEvent[] = [];
  const f = fixture(undefined, opts => {
    options = opts!;
    const transport = new DirectConversationTransport({ ...opts,
      // Deliver fact results explicitly to control their arrival relative to storage.
      factCheck: { ...opts!.factCheck!, enabled: () => false },
      insights: undefined,
      fetch: async url => {
        if (url.endsWith("transcriptions")) {
          await beforeTranscription?.();
          return Response.json({ text: transcriptText });
        }
        return new Response('data: {"type":"response.output_text.delta","delta":"Newer explicit answer."}\n\ndata: {"type":"response.completed"}\n\n', { headers: { "content-type": "text/event-stream" } });
      },
    });
    transport.subscribe(event => events.push(event));
    return transport;
  });
  await f.controller.initialize();
  await f.controller.connect({ ...form, liveWebFactCheck: true, autoQuestion: false, autoAnswer: false, autoNotes: false });
  const transcribe = async (text: string) => {
    const previousCount = events.filter(event => event.type === "transcript.final").length;
    transcriptText = text;
    await f.controller.beginHold();
    f.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array(new Int16Array(3200).fill(4000).buffer), source: AudioInputSource.Glasses, speakerRole: AudioSpeakerRole.Other }) });
    await f.controller.releaseHold();
    await vi.waitFor(() => expect(events.filter(event => event.type === "transcript.final")).toHaveLength(previousCount + 1));
    return events.filter(event => event.type === "transcript.final").at(-1)!;
  };
  const transcript = await transcribe(transcriptText);
  await vi.waitFor(() => expect(f.controller.openHistorySession(transcript.sessionId)?.entries).toHaveLength(1));
  const fact: FactCheckResult = { id: "during-delete-fact", sessionId: transcript.sessionId, transcriptId: transcript.transcriptId,
    claim: "Late claim", summary: "Late sourced result", status: "supported", checkedAt: new Date().toISOString(),
    sources: [{ url: "https://example.com/source", title: "Source" }] };
  return { ...f, transcribe, sessionId: transcript.sessionId,
    deliverInsight: (insight: ContextInsight) => options.insights!.onResult(insight),
    deliverFact: (overrides: Partial<FactCheckResult> = {}) => options.factCheck!.onResult({ ...fact, ...overrides }) };
}

describe("phone local history integration", () => {
  it("keeps active web checking through successive holds and empty pause, with latest pending cooldown, context and dedupe", async () => {
    vi.useFakeTimers();
    const f = await webLaneFixture();
    try {
      await f.transcribe("Apollo 11 landed on the Moon in 1969.");
      expect(f.searches).toHaveLength(1);
      await f.transcribe("Its launch was in 1969.");
      await f.transcribe("Its mission lasted 8 days.");
      await f.controller.startListening();
      await f.controller.togglePause(); // No new audio: must leave scheduler/priority untouched.
      expect.soft(f.searches[0]!.signal.aborted).toBe(false);
      expect.soft(f.searches).toHaveLength(1);
      f.searches[0]!.resolve(Response.json({}));
      await vi.advanceTimersByTimeAsync(0);
      const completedAt = Date.now();
      await vi.advanceTimersByTimeAsync(2999);
      expect.soft(f.searches).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.searches).toHaveLength(2);
      expect(f.searches[1]!.at - completedAt).toBe(3000);
      expect(f.searches[1]!.input).toEqual({ earlierSpeech: "Apollo 11 landed on the Moon in 1969.\nIts launch was in 1969.", claim: "Its mission lasted 8 days.", summaryLanguage: expect.stringContaining("English") });
      f.searches[1]!.resolve(Response.json({}));
      await vi.advanceTimersByTimeAsync(0);
      await f.transcribe("Apollo 11 landed on the Moon in 1969.");
      await vi.advanceTimersByTimeAsync(3000);
      expect(f.searches).toHaveLength(2);
    } finally { await f.controller.dispose(); vi.useRealTimers(); }
  });

  it.each(["manual", "local", "global", "off", "disconnect", "exit"])("cancels active and pending web checks on %s and silences late provider completion", async action => {
    const f = await webLaneFixture();
    await f.transcribe("Apollo 11 landed on the Moon in 1969.");
    await f.transcribe("Its mission lasted 8 days.");
    if (action === "manual") await f.controller.ask("What next?");
    else if (action === "local" || action === "global") await f.controller.askContext(action);
    else if (action === "off") await f.controller.setLiveWebFactCheckEnabled(false);
    else if (action === "disconnect") await f.controller.disconnect();
    else await f.controller.requestExit();
    expect(f.searches.every(search => search.signal.aborted)).toBe(true);
    for (const search of f.searches) search.resolve(Response.json({}));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.presentation.snapshot().feed.some(item => item.kind === "fact-check")).toBe(false);
    await f.controller.dispose();
  });
  it("exposes live explanation toggle, drops stale/disabled callbacks and preserves disabled state on save failure", async () => {
    let options!: DirectConversationOptions;
    let cancellations = 0;
    const f = fixture(undefined, opts => {
      options = opts!;
      const transport = new DirectConversationTransport({ ...opts, insights: undefined, fetch: async () => new Response('data: {"type":"response.output_text.delta","delta":"Answer."}\n\ndata: {"type":"response.completed"}\n\n') });
      const cancel = transport.cancelInsights.bind(transport);
      vi.spyOn(transport, "cancelInsights").mockImplementation(() => { cancellations++; cancel(); });
      return transport;
    });
    await f.controller.initialize(); await f.controller.connect(form);
    expect(options.insights?.enabled()).toBe(true);
    const sessionId = f.controller.liveSessionId()!; // v0.13: no history record until something is said
    const insight = { id: "i", sessionId, transcriptId: "t", term: "RAG", explanation: "Retrieval.", createdAt: new Date().toISOString() };
    options.insights!.onResult(insight);
    expect(f.presentation.snapshot().feed.some(item => item.kind === "insight")).toBe(true);
    vi.spyOn(f.bridge, "setLocalStorage").mockResolvedValue(false);
    const disable = f.controller.setAutoExplainTermsEnabled(false);
    expect(options.insights!.enabled()).toBe(false); expect(cancellations).toBeGreaterThan(0);
    await disable;
    expect(f.controller.historySnapshot().status).toContain("could not be saved");
    options.insights!.onResult({ ...insight, id: "disabled" });
    expect(f.presentation.snapshot().feed.some(item => item.id === "disabled")).toBe(false);
    expect(f.presentation.snapshot().glasses.cue).toBeUndefined();
    await f.controller.disconnect(); await f.controller.setAutoExplainTermsEnabled(true);
    options.insights!.onResult({ ...insight, id: "late" });
    expect(f.presentation.snapshot().feed.some(item => item.id === "late")).toBe(false);
    await f.controller.dispose();
  });
  it.each(["accepted archive", "deletion"])("does not resurrect a deleted active session when transcripts and facts arrive during the %s storage write", async phase => {
    const f = await liveHistoryFixture();
    let release!: () => void;
    let paused = false;
    const original = f.bridge.setLocalStorage.bind(f.bridge);
    vi.spyOn(f.bridge, "setLocalStorage").mockImplementation(async (key, value) => {
      if (key === "helix.g2.history.v2" && !paused && (phase === "accepted archive" || !JSON.parse(value).sessions.some((session: { id: string }) => session.id === f.sessionId))) {
        paused = true;
        await new Promise<void>(resolve => { release = resolve; });
      }
      return original(key, value);
    });
    if (phase === "accepted archive") await f.transcribe("Transcript accepted before deletion");
    const deletion = f.controller.deleteHistorySession(f.sessionId);
    await vi.waitFor(() => expect(release).toBeDefined());
    await f.transcribe("Transcript arriving during deletion");
    f.deliverFact();
    expect.soft(f.presentation.snapshot().feed.some(item => item.id === "during-delete-fact")).toBe(true);
    release(); await deletion;
    expect(f.controller.openHistorySession(f.sessionId)).toBeUndefined();
    const later = await f.transcribe("Transcript arriving after deletion about RAG");
    f.deliverFact({ id: "after-delete-fact", transcriptId: later.transcriptId, status: "contradicted" });
    expect.soft(f.presentation.snapshot().feed.some(item => item.id === "after-delete-fact")).toBe(true);
    expect.soft(f.presentation.snapshot().glasses.answer?.text).toBe("Correction: Late sourced result");
    f.deliverInsight({ id: "after-delete-insight", sessionId: later.sessionId, transcriptId: later.transcriptId, term: "RAG", explanation: "Retrieval augmented generation", createdAt: new Date().toISOString() });
    expect.soft(f.presentation.snapshot().feed.some(item => item.id === "after-delete-insight")).toBe(true);
    await f.controller.importOmi({ key: "omi-test", fetch: async () => Response.json(omi) });
    await f.controller.ask("What is the budget?");
    await vi.waitFor(() => expect(f.presentation.snapshot().glasses.answer).toMatchObject({ text: "Newer explicit answer.", streaming: false }));
    expect.soft(f.presentation.snapshot().feed.find(item => item.kind === "answer")?.memorySources?.[0]?.session.id).toBe("omi:one");
    f.deliverFact({ id: "older-after-delete", transcriptId: later.transcriptId, status: "contradicted" });
    expect.soft(f.presentation.snapshot().glasses.answer?.text).toBe("Newer explicit answer.");
    await f.controller.connect({ ...form, liveWebFactCheck: true, autoQuestion: false, autoAnswer: false, autoNotes: false });
    f.deliverFact({ id: "old-connection-fact" });
    expect(f.presentation.snapshot().feed.some(item => item.id === "old-connection-fact")).toBe(false);
    const reconnected = await f.transcribe("Reconnected archive resumes");
    await f.controller.disconnect();
    expect(f.controller.openHistorySession(reconnected.sessionId)?.entries.map(entry => entry.text)).toEqual(["Reconnected archive resumes"]);
    expect(f.controller.openHistorySession(f.sessionId)).toBeUndefined();
    await f.controller.dispose();
    const restarted = fixture(f.storage); await restarted.controller.initialize();
    expect(restarted.controller.openHistorySession(f.sessionId)).toBeUndefined();
    expect(restarted.controller.searchHistory("transcript")).toEqual([]);
    await restarted.controller.dispose();
  });

  it("preserves the existing archive and resumes future live writes after deletion fails", async () => {
    const f = await liveHistoryFixture();
    let release!: () => void;
    const original = f.bridge.setLocalStorage.bind(f.bridge);
    const write = vi.spyOn(f.bridge, "setLocalStorage").mockImplementation(async (key, value) => {
      if (key === "helix.g2.history.v2" && !JSON.parse(value).sessions.some((session: { id: string }) => session.id === f.sessionId)) {
        await new Promise<void>(resolve => { release = resolve; });
        return false;
      }
      return original(key, value);
    });
    const deletion = f.controller.deleteHistorySession(f.sessionId);
    const rejected = expect(deletion).rejects.toThrow("Could not save local history");
    await vi.waitFor(() => expect(release).toBeDefined());
    const transcript = await f.transcribe("Transcript arriving during deletion");
    f.deliverFact({ transcriptId: transcript.transcriptId, status: "contradicted" });
    expect.soft(f.presentation.snapshot().feed.some(item => item.id === "during-delete-fact")).toBe(true);
    expect.soft(f.presentation.snapshot().glasses.answer?.text).toBe("Correction: Late sourced result");
    release(); await rejected;
    expect(f.controller.historySnapshot().status).toContain("Could not save local history");
    write.mockRestore();
    await f.transcribe("Recovered transcript after failed deletion");
    f.deliverFact();
    await f.controller.disconnect();
    const entries = f.controller.openHistorySession(f.sessionId)!.entries;
    expect(entries.filter(entry => entry.kind === "transcript").map(entry => entry.text)).toEqual([
      "Original archived transcript", "Recovered transcript after failed deletion",
    ]);
    expect(entries.some(entry => entry.kind === "fact-check")).toBe(true);
    await f.controller.dispose();
    const restarted = fixture(f.storage); await restarted.controller.initialize();
    expect(restarted.controller.openHistorySession(f.sessionId)?.entries).toEqual(entries);
    await restarted.controller.dispose();
  });

  it("keeps a newer completed manual answer above a delayed transcript's fact during and after failed deletion", async () => {
    let pauseTranscription = false;
    let releaseTranscription!: () => void;
    const f = await liveHistoryFixture(async () => {
      if (pauseTranscription) await new Promise<void>(resolve => { releaseTranscription = resolve; });
    });
    let releaseDeletion!: () => void;
    const original = f.bridge.setLocalStorage.bind(f.bridge);
    vi.spyOn(f.bridge, "setLocalStorage").mockImplementation(async (key, value) => {
      if (key === "helix.g2.history.v2" && !JSON.parse(value).sessions.some((session: { id: string }) => session.id === f.sessionId)) {
        await new Promise<void>(resolve => { releaseDeletion = resolve; });
        return false;
      }
      return original(key, value);
    });
    const deletion = f.controller.deleteHistorySession(f.sessionId);
    const rejected = expect(deletion).rejects.toThrow("Could not save local history");
    await vi.waitFor(() => expect(releaseDeletion).toBeDefined());
    pauseTranscription = true;
    const speech = f.transcribe("Older speech finalized after the manual request");
    await vi.waitFor(() => expect(releaseTranscription).toBeDefined());
    const answer = f.controller.ask("Give me the next step");
    releaseTranscription();
    const transcript = await speech;
    await answer;
    await vi.waitFor(() => expect(f.presentation.snapshot().glasses.answer).toMatchObject({ text: "Newer explicit answer.", streaming: false }));
    f.deliverFact({ transcriptId: transcript.transcriptId, status: "contradicted" });
    expect.soft(f.presentation.snapshot().feed.some(item => item.id === "during-delete-fact")).toBe(true);
    expect.soft(f.presentation.snapshot().glasses.answer?.text).toBe("Newer explicit answer.");
    releaseDeletion(); await rejected;
    f.deliverFact({ id: "after-failure-fact", transcriptId: transcript.transcriptId, status: "contradicted" });
    expect(f.presentation.snapshot().feed.some(item => item.id === "after-failure-fact")).toBe(true);
    expect(f.presentation.snapshot().glasses.answer?.text).toBe("Newer explicit answer.");
    await f.controller.disconnect();
    expect(f.controller.openHistorySession(f.sessionId)?.entries.map(entry => entry.kind).sort()).toEqual(["fact-check", "transcript"]);
    await f.controller.dispose();
  });

  it("deletes after an already-running Omi import and permits a later explicit reimport", async () => {
    const f = fixture(); await f.controller.initialize();
    await f.controller.importOmi({ key: "omi-test", fetch: async () => Response.json(omi) });
    let release!: (response: Response) => void;
    const importing = f.controller.importOmi({ key: "omi-test", fetch: () => new Promise<Response>(resolve => { release = resolve; }) });
    await vi.waitFor(() => expect(release).toBeDefined());
    const deletion = f.controller.deleteHistorySession("omi:one");
    release(Response.json(omi));
    await Promise.all([importing, deletion]);
    expect(f.controller.openHistorySession("omi:one")).toBeUndefined();
    expect(f.controller.openHistorySession("omi:empty")).toBeDefined();
    await f.controller.dispose();
    const restarted = fixture(f.storage); await restarted.controller.initialize();
    expect(restarted.controller.openHistorySession("omi:one")).toBeUndefined();
    await restarted.controller.importOmi({ key: "omi-test", fetch: async () => Response.json(omi) });
    expect(restarted.controller.openHistorySession("omi:one")?.entries).toHaveLength(1);
    await restarted.controller.dispose();
  });

  it("starts a newly requested explicit import only after a pending deletion settles", async () => {
    const f = fixture(); await f.controller.initialize();
    await f.controller.importOmi({ key: "omi-test", fetch: async () => Response.json(omi) });
    let release!: () => void;
    const original = f.bridge.setLocalStorage.bind(f.bridge);
    vi.spyOn(f.bridge, "setLocalStorage").mockImplementation(async (key, value) => {
      if (key === "helix.g2.history.v2" && !JSON.parse(value).sessions.some((session: { id: string }) => session.id === "omi:one")) {
        await new Promise<void>(resolve => { release = resolve; });
      }
      return original(key, value);
    });
    const deletion = f.controller.deleteHistorySession("omi:one");
    await vi.waitFor(() => expect(release).toBeDefined());
    const fetcher = vi.fn(async () => Response.json(omi));
    const importing = f.controller.importOmi({ key: "omi-test", fetch: fetcher });
    await Promise.resolve(); await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
    release(); await deletion;
    expect(f.controller.openHistorySession("omi:one")).toBeUndefined();
    await importing;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(f.controller.openHistorySession("omi:one")?.entries).toHaveLength(1);
    await f.controller.dispose();
  });

  it("imports without a connection, deduplicates, restarts and opens source records", async () => {
    const first = fixture(); await first.controller.initialize();
    const fetcher = vi.fn(async () => Response.json(omi));
    await first.controller.importOmi({ key: "omi-test", fetch: fetcher });
    await first.controller.importOmi({ key: "omi-test", fetch: fetcher });
    expect(first.controller.listHistorySessions()).toHaveLength(2);
    expect(first.controller.searchHistory("预算")).toHaveLength(1);
    const hit = first.controller.searchHistory("budget")[0]!;
    expect(first.controller.openHistorySession(hit.session.id)?.entries).toHaveLength(1);
    expect([...first.storage].filter(([key]) => key.startsWith("helix.g2.history.")).map(([, value]) => value).join("\n")).not.toContain("omi-test");
    await first.controller.dispose();
    const second = fixture(first.storage); await second.controller.initialize();
    expect(second.controller.searchHistory("budget")[0]?.entry.speaker).toBe("Art");
    await second.controller.deleteHistorySession(hit.session.id);
    expect(second.controller.searchHistory("budget")).toEqual([]);
    await second.controller.dispose();
  });

  it("keeps import running on disconnect but cancels on dispose", async () => {
    const { controller } = fixture(); await controller.initialize();
    let signal: AbortSignal | undefined;
    const pending = controller.importOmi({ key: "omi-test", fetch: async (_url, init) => {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    } });
    await vi.waitFor(() => expect(signal).toBeDefined());
    await controller.disconnect(); expect(signal?.aborted).toBe(false);
    await controller.dispose(); await pending;
    expect(signal?.aborted).toBe(true);
  });

  it("shows real first SSE delta on phone and glasses before completion, retrieves without Omi key and archives only completion", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let options!: DirectConversationOptions;
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { "content-type": "text/event-stream" } }));
    // The model-access probe is answered separately so `stream` is the answer stream.
    const routed = async (url: string, init?: RequestInit) => url.endsWith("/models") ? new Response("", { status: 401 }) : (void init, fetcher());
    const f = fixture(undefined, opts => { options = opts!; return new DirectConversationTransport({ ...opts, fetch: routed }); });
    await f.controller.initialize(); await f.controller.importOmi({ key: "omi-test", fetch: async () => Response.json(omi) });
    await f.controller.connect(form);
    expect(options.retrieveMemory?.("budget", "other")).toHaveLength(1);
    await f.controller.setLocalMemoryEnabled(false);
    expect(options.retrieveMemory?.("budget", "other")).toEqual([]);
    await f.controller.setLocalMemoryEnabled(true);
    const ask = f.controller.ask("What is the budget?");
    await vi.waitFor(() => expect(stream).toBeDefined());
    stream.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"First partial"}\n\n'));
    await vi.waitFor(() => expect(f.presentation.snapshot().feed.some(item => item.streaming && item.body === "First partial")).toBe(true));
    await vi.waitFor(() => expect(f.updates.some(item => item.content?.includes("First partial"))).toBe(true));
    expect(f.controller.listHistorySessions().filter(s => s.source === "helix").flatMap(s => f.controller.openHistorySession(s.id)!.entries).some(e => e.kind === "answer")).toBe(false);
    stream.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed"}}\n\n')); stream.close(); await ask;
    await vi.waitFor(() => expect(f.controller.searchHistory("First partial").some(h => h.entry.kind === "answer")).toBe(true));
    expect(f.presentation.snapshot().feed.find(item => item.kind === "answer")?.memorySources?.[0]?.session.id).toBe("omi:one");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await f.controller.dispose();
    const restarted = fixture(f.storage); await restarted.controller.initialize();
    const answer = restarted.controller.searchHistory("First partial").find(hit => hit.entry.kind === "answer")!;
    expect(memoryEntryIds(answer.entry)).toEqual(["omi:one:transcript:index:0"]);
    expect(restarted.controller.openHistorySession("omi:one")?.entries.some(entry => entry.id === memoryEntryIds(answer.entry)[0])).toBe(true);
    await restarted.controller.dispose();
  });

  it("rejects unsafe source links", () => {
    expect(safeSourceUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeSourceUrl("https://user:secret@example.com")).toBeUndefined();
    expect(safeSourceUrl("https://example.com/source")).toBe("https://example.com/source");
  });

  it("reports archive write failures while the direct answer keeps streaming", async () => {
    const storage = new Map<string, string>();
    const f = fixture(storage, options => new DirectConversationTransport({ ...options, fetch: async () => new Response('data: {"type":"response.output_text.delta","delta":"Still answering."}\n\ndata: {"type":"response.completed"}\n\n', { headers: { "content-type": "text/event-stream" } }) }));
    await f.controller.initialize();
    const write = vi.spyOn(storage, "set").mockImplementation((key, value) => {
      if (key === "helix.g2.history.v2") throw new Error("quota");
      return Map.prototype.set.call(storage, key, value) as Map<string, string>;
    });
    await f.controller.connect(form); await f.controller.ask("Help me");
    await vi.waitFor(() => expect(f.presentation.snapshot().glasses.answer?.text).toBe("Still answering."));
    await vi.waitFor(() => expect(f.controller.historySnapshot().status).toContain("Could not save local history"));
    expect(f.presentation.snapshot().status).toBe("connected");
    expect(f.controller.listHistorySessions()).toEqual([]);
    write.mockRestore(); await f.controller.dispose();
  });

  it("drains deferred old-session writes before reconnect without moving records or reviving the glasses answer", async () => {
    const f = fixture(undefined, options => new DirectConversationTransport({ ...options, fetch: async () => new Response('data: {"type":"response.output_text.delta","delta":"Old session answer."}\n\ndata: {"type":"response.completed"}\n\n', { headers: { "content-type": "text/event-stream" } }) }));
    await f.controller.initialize();
    let release!: () => void; let paused = false;
    const original = f.bridge.setLocalStorage.bind(f.bridge);
    vi.spyOn(f.bridge, "setLocalStorage").mockImplementation(async (key, value) => {
      if (key === "helix.g2.history.v2" && !paused) {
        paused = true; await new Promise<void>(resolve => { release = resolve; });
      }
      return original(key, value);
    });
    await f.controller.connect(form); await f.controller.ask("Old session question?");
    await vi.waitFor(() => expect(f.presentation.snapshot().glasses.answer?.text).toBe("Old session answer."));
    let reconnected = false;
    const reconnect = f.controller.connect(form).then(() => { reconnected = true; });
    await Promise.resolve(); expect(reconnected).toBe(false);
    expect(f.presentation.snapshot().glasses.answer).toBeUndefined();
    release(); await reconnect;
    // v0.13: the reconnected session has said nothing yet, so it has no history record.
    await vi.waitFor(() => expect(f.controller.listHistorySessions()).toHaveLength(1));
    const sessions = f.controller.listHistorySessions().map(session => f.controller.openHistorySession(session.id)!);
    expect(sessions.filter(record => record.entries.length > 0)).toHaveLength(1);
    const old = sessions.find(record => record.entries.length > 0)!;
    expect(old.entries.map(entry => entry.kind).sort()).toEqual(["answer", "question"]);
    expect(old.entries.every(entry => entry.sessionId === old.session.id)).toBe(true);
    expect(f.presentation.snapshot().feed).toEqual([]);
    expect(f.presentation.snapshot().glasses.answer).toBeUndefined();
    await f.controller.dispose();
  });

  it("immediately aborts web search on toggle off and protects a newer completed explicit answer from an older claim", async () => {
    let options!: DirectConversationOptions;
    const events: GatewayEvent[] = [];
    let webSignal!: AbortSignal;
    let resolveWeb!: (response: Response) => void;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("transcriptions")) return Response.json({ text: "The moon landing was in 1970." });
      if (JSON.parse(init!.body as string).tools) { webSignal = init!.signal as AbortSignal; return new Promise<Response>(resolve => { resolveWeb = resolve; }); }
      return new Response('data: {"type":"response.output_text.delta","delta":"A newer explicit answer."}\n\ndata: {"type":"response.completed"}\n\n', { headers: { "content-type": "text/event-stream" } });
    });
    const f = fixture(undefined, opts => {
      options = opts!; const transport = new DirectConversationTransport({ ...opts, fetch: fetcher });
      transport.subscribe(event => events.push(event)); return transport;
    });
    await f.controller.initialize();
    await f.controller.connect({ ...form, liveWebFactCheck: true, autoQuestion: false, autoAnswer: false, autoNotes: false });
    await f.controller.beginHold();
    f.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array(new Int16Array(3200).fill(4000).buffer), source: AudioInputSource.Glasses, speakerRole: AudioSpeakerRole.Other }) });
    await f.controller.releaseHold();
    await vi.waitFor(() => expect(webSignal).toBeDefined());
    const transcript = events.find(event => event.type === "transcript.final")!;
    const fact: FactCheckResult = { id: "fact-one", sessionId: transcript.sessionId, transcriptId: transcript.type === "transcript.final" ? transcript.transcriptId : "", claim: "Moon landing in 1970", summary: "Apollo 11 landed in 1969.", status: "contradicted", checkedAt: new Date().toISOString(), sources: [{ url: "https://www.nasa.gov/mission/apollo-11/", title: "NASA" }] };
    options.factCheck!.onResult(fact);
    expect(f.presentation.snapshot().glasses.answer?.text).toContain("Correction:");
    await f.controller.ask("Give me the next step");
    await vi.waitFor(() => expect(f.presentation.snapshot().glasses.answer?.text).toBe("A newer explicit answer."));
    options.factCheck!.onResult({ ...fact, id: "late-old-fact" });
    expect(f.presentation.snapshot().glasses.answer?.text).toBe("A newer explicit answer.");
    expect(f.presentation.snapshot().feed.some(item => item.id === "late-old-fact")).toBe(true);
    // A new speech commit creates another independent fact request.
    await f.controller.beginHold();
    f.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array(new Int16Array(3200).fill(4000).buffer), source: AudioInputSource.Glasses, speakerRole: AudioSpeakerRole.Other }) });
    const previousSignal = webSignal;
    await f.controller.releaseHold();
    await vi.waitFor(() => expect(webSignal).not.toBe(previousSignal));
    const toggle = f.controller.setLiveWebFactCheckEnabled(false);
    expect(webSignal.aborted).toBe(true); await toggle;
    options.factCheck!.onResult({ ...fact, id: "disabled-late" });
    expect(f.presentation.snapshot().feed.some(item => item.id === "disabled-late")).toBe(false);
    resolveWeb(Response.json({}));
    await f.controller.disconnect();
    options.factCheck!.onResult({ ...fact, id: "stopped-late" });
    expect(f.presentation.snapshot().glasses.answer).toBeUndefined();
    const archived = f.controller.searchHistory("moon");
    expect(archived.some(item => item.entry.kind === "transcript")).toBe(true);
    expect(archived.some(item => item.entry.kind === "fact-check" && item.entry.sources?.length === 1)).toBe(true);
    await f.controller.dispose();
  });
});
