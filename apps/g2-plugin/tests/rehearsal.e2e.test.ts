/**
 * Rehearsal E2E: full scripted conversations through the real SDK pipeline with a
 * deterministic fake OpenAI (tests/fake-openai.ts). No network.
 *
 * Live now (v0.6 SDK surface): audio -> STT -> question detection -> streamed answer,
 * at transport/client level and through G2ConversationController + presentation + history.
 * Capability-gated (become live automatically once the v0.7 lanes land):
 *   - DirectConversationTransport.injectTranscript / verify / runCopilotNow + CopilotCallbacks
 *   - openai-realtime STT profile + webSocketFactory option
 *   - controller.rehearse / stopRehearsal / verify + presentation copilot fields
 */
import { describe, expect, it, vi } from "vitest";
import { AudioEvent, AudioInputSource, AudioSpeakerRole, StartUpPageCreateResult, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import {
  DEFAULT_COPILOT_SETTINGS,
  DirectConversationTransport,
  HelixConversationClient,
  TRANSCRIPTION_CATALOG,
  extractQuestions,
  type AnswerMeta,
  type CopilotAsk,
  type CopilotCallbacks,
  type CopilotConcept,
  type CopilotConflict,
  type CopilotSuggestion,
  type CopilotSummary,
  type DirectConversationOptions,
  type GatewayEvent,
  type SessionConfig,
  type Speaker,
  type UsageRecord,
  type VerificationResult,
} from "@helix/conversation-sdk";
import * as sdk from "@helix/conversation-sdk";
import { G2ConversationController, type G2BridgePort } from "../src/controller";
import { GlassesRenderer } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";
import { DEFAULT_CONFIG } from "../src/config";
import { REHEARSAL_SCRIPTS as ALL_REHEARSAL_SCRIPTS, RehearsalPlayer, defaultPauseMs, rehearsalScript, type RehearsalScript } from "../src/rehearsal";
import { analyzeConversation, createFakeOpenAI, synthSpeechPcm, type FakeOpenAI } from "./fake-openai";

// The two interview-harness scripts hold lines that must NOT all be answered (fragments, rhetorical questions,
// two questions in one line); tests/interview-scenario.test.ts runs them against their per-line outcomes.
// The talk script (v0.16) is a monologue whose questions must NOT be answered; tests/v16-talk-scenario.test.ts runs it.
const REHEARSAL_SCRIPTS = ALL_REHEARSAL_SCRIPTS.filter(script => !script.id.startsWith("interview-") && !script.id.startsWith("talk-"));

const FAKE_KEY = "sk-fake-rehearsal";
const MODEL = "gpt-4.1-mini"; // priced in model-catalog and within the SDK's known context budgets
const noSleep = () => Promise.resolve();
const WAIT = { timeout: 4000, interval: 2 };
vi.setConfig({ testTimeout: 30_000 });

/* ---------------- capability detection (no it.todo unless the API is absent) ---------------- */
const transportProto = DirectConversationTransport.prototype as unknown as Record<string, unknown>;
const HAS_INJECT = typeof transportProto.injectTranscript === "function";
const HAS_COPILOT_TRANSPORT = HAS_INJECT && typeof transportProto.verify === "function" && typeof transportProto.runCopilotNow === "function";
// The catalog entry can land before the transport path; also require the transport to accept webSocketFactory.
const HAS_REALTIME_STT = TRANSCRIPTION_CATALOG.some(item => item.profileId === "openai-realtime")
  && Function.prototype.toString.call(DirectConversationTransport).includes("webSocketFactory");
const controllerProto = G2ConversationController.prototype as unknown as Record<string, unknown>;
const HAS_REHEARSE = ["rehearse", "stopRehearsal", "verify"].every(name => typeof controllerProto[name] === "function");
const presentationKeys = Object.keys(new ConversationPresentation().snapshot());
const HAS_COPILOT_PRESENTATION = typeof (ConversationPresentation.prototype as unknown as Record<string, unknown>).applySummary === "function" && ["concepts", "conflicts", "suggestions", "asks", "verifications", "answerMeta", "usage"].every(key => presentationKeys.includes(key));
// SDK copilot lane class (copilot.ts), usable directly before transport wiring lands.
type CopilotCtor = new (options: { fetch: typeof fetch | ((url: string, init?: RequestInit) => Promise<Response>); key: string; sessionId: string; callbacks: CopilotCallbacks; onUsage?: (u: UsageRecord) => void; cooldownMs?: number }) =>
  { submit(transcriptId: string, text: string, speaker?: Speaker | string): void; runNow(): void; verify(target: string, id?: string): void; cancel(): void };
const SdkCopilot = (sdk as unknown as { ConversationCopilot?: CopilotCtor }).ConversationCopilot;
const liveIf = (condition: boolean) => (condition ? it : it.todo) as typeof it;

/* ---------------- shared helpers ---------------- */

function sessionConfig(script: RehearsalScript, transcriptionProvider = "openai-whisper"): SessionConfig {
  return {
    sessionId: `rehearsal_${script.id}_${Math.random().toString(36).slice(2)}`,
    endpoint: { id: "openai-direct", url: "https://api.openai.com/v1/responses", provider: "openai", model: MODEL },
    prompt: { id: "helix-direct", version: "1", system: "Answer the detected question directly and concisely.", mode: modeFor(script), maxResponseSentences: 3 },
    mode: modeFor(script), responseStrategy: "reactive",
    providers: { transcriptionProvider, answerProvider: "openai-responses" },
    memory: { readOmiContext: false, syncNotes: false },
    audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 },
    locale: "en", speaker: { label: "Rehearsal", role: "unknown" },
    automation: { detectQuestions: true, answerQuestions: true, saveNotes: true },
    client: { name: "@helix/g2-plugin", version: "0.7.0-test", device: "rehearsal" },
  } as SessionConfig;
}
function modeFor(script: RehearsalScript) {
  return script.kind === "interview" ? "interviewee" as const : script.kind === "meeting" ? "office-discussion" as const : "general" as const;
}

type Ev<T extends GatewayEvent["type"]> = Extract<GatewayEvent, { type: T }>;
const ofType = <T extends GatewayEvent["type"]>(events: GatewayEvent[], type: T) => events.filter((e): e is Ev<T> => e.type === type);

/** Every detected question has a completed answer (or an error was emitted, which fails the run). */
function unanswered(events: GatewayEvent[]): Ev<"question.detected">[] {
  const answered = new Set(ofType(events, "answer.completed").map(e => e.questionId).filter(Boolean));
  // v0.8: the wearer's own questions (role "self") are prompts for the other party, never auto-answered.
  return ofType(events, "question.detected").filter(q => sdk.questionKindFor(q.context.speaker.role) === "answer" && !answered.has(q.questionId));
}
async function settle(events: GatewayEvent[], transcripts: number): Promise<void> {
  await vi.waitFor(() => {
    expect(ofType(events, "error"), "no provider errors").toEqual([]);
    expect(ofType(events, "transcript.final").length).toBeGreaterThanOrEqual(transcripts);
    expect(unanswered(events).map(q => q.text), "questions still waiting for answer.completed").toEqual([]);
  }, WAIT);
}

function expectQuestionsAnswered(script: RehearsalScript, events: GatewayEvent[]) {
  const detected = ofType(events, "question.detected");
  const answers = ofType(events, "answer.completed");
  for (const needle of script.expectations.questions ?? []) {
    const question = detected.find(q => q.text.includes(needle));
    expect(question, `question detected: ${needle}`).toBeDefined();
    const answer = answers.find(a => a.questionId === question!.questionId);
    expect(answer?.text.trim(), `answer for: ${needle}`).toBeTruthy();
    expect(answer!.context.latencyMs.totalMs).toBeGreaterThanOrEqual(0);
  }
  for (const needle of script.expectations.selfQuestions ?? []) {
    const question = detected.find(q => q.text.includes(needle));
    expect(question, `self question detected: ${needle}`).toBeDefined();
    expect(question!.context.speaker.role).toBe("self");
    expect(answers.some(a => a.questionId === question!.questionId), `self question not auto-answered: ${needle}`).toBe(false);
  }
  expect(unanswered(events)).toEqual([]);
}

/* ---------------- controller fixture (pattern from history/controller integration tests) ---------------- */

function controllerFixture(factory: (options?: DirectConversationOptions) => DirectConversationTransport) {
  const storage = new Map<string, string>();
  let hubListener: ((event: EvenHubEvent) => void) | undefined;
  const bridge: G2BridgePort = {
    getLocalStorage: async key => storage.get(key) ?? "",
    setLocalStorage: async (key, value) => { storage.set(key, value); return true; },
    createStartUpPageContainer: async () => StartUpPageCreateResult.success,
    textContainerUpgrade: async () => true,
    audioControl: async () => true,
    shutDownPageContainer: async () => true,
    onEvenHubEvent: listener => { hubListener = listener; return () => { hubListener = undefined; }; },
  };
  const presentation = new ConversationPresentation();
  const renderer = new GlassesRenderer(bridge, { debounceMs: 0 });
  const controller = new G2ConversationController(bridge, renderer, presentation, factory);
  return { controller, presentation, storage, emit: (event: object) => hubListener?.(event as EvenHubEvent) };
}
// HTTP STT keeps this suite independent of the realtime lane (covered separately below).
const form = { ...DEFAULT_CONFIG, model: MODEL, transcriptionProvider: "openai-whisper" as const, accessToken: "", openaiApiKey: FAKE_KEY, deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", saveApiKeysOnPhone: false,
  responseStrategy: "reactive" as const, autoQuestion: true, autoAnswer: true, autoNotes: true, liveWebFactCheck: false, autoExplainTerms: false };

/* =============================================================================================== */

describe("rehearsal scripts", () => {
  it("ships three realistic scripts sharing one JSON source", () => {
    expect(REHEARSAL_SCRIPTS.map(s => s.id)).toEqual(["mock-interview-ml", "hardware-planning", "team-standup"]);
    for (const script of REHEARSAL_SCRIPTS) {
      expect(script.lines.length).toBeGreaterThanOrEqual(12);
      expect(script.lines.length).toBeLessThanOrEqual(25);
      expect(new Set(script.lines.map(l => l.speaker))).toEqual(new Set(["self", "other"]));
    }
    const interview = rehearsalScript("mock-interview-ml")!;
    const text = interview.lines.map(l => l.text).join(" ");
    expect(text).toContain("CDTF");
    expect(text).toContain("I'd like to hear about a time you dealt with a tight latency budget.");
    expect(text).toMatch(/30 FPS[\s\S]*12 FPS on Orin/);
    const hardware = rehearsalScript("hardware-planning")!.lines.map(l => l.text).join(" ");
    for (const needle of ["Jetson devices are hard to order and have a long lead time right now", "16 GB RAM with a 1 TB SSD", "$40,000", "$25,000", "NVMe", "ROS 2", "CDTF"]) expect(hardware).toContain(needle);
  });

  it("every expected question is detected on-device by the SDK", () => {
    for (const script of REHEARSAL_SCRIPTS) {
      const detected = script.lines.flatMap(line => extractQuestions(line.text).map(q => q.text));
      for (const needle of script.expectations.questions ?? []) expect(detected.some(q => q.includes(needle)), `${script.id}: ${needle}`).toBe(true);
      // v0.14: a request phrased as a wish ("I'd like to hear about a time…") is detected on-device too,
      // so an interviewer's prompt is answered without waiting for the copilot's implicit-ask pass.
      for (const needle of script.expectations.implicitQuestions ?? []) expect(detected.some(q => q.includes(needle)), `wish-form request is detected: ${needle}`).toBe(true);
    }
  });

  it("fake analysis finds each script's concepts, conflicts and asks", () => {
    for (const script of REHEARSAL_SCRIPTS) {
      const analysis = analyzeConversation(script.lines.map(l => l.text).join("\n"));
      for (const term of script.expectations.concepts ?? []) expect(analysis.concepts.map(c => c.term)).toContain(term);
      expect(analysis.conflicts.length > 0).toBe(!!script.expectations.conflict);
      for (const needle of script.expectations.lookups ?? []) expect(analysis.asks.some(a => a.kind === "lookup" && a.trigger.includes(needle))).toBe(true);
      for (const needle of script.expectations.proposes ?? []) expect(analysis.asks.some(a => a.kind === "propose" && a.trigger.includes(needle))).toBe(true);
      for (const needle of script.expectations.implicitQuestions ?? []) expect(analysis.asks.some(a => a.kind === "question" && a.trigger.includes(needle))).toBe(true);
    }
  });
});

describe("RehearsalPlayer", () => {
  it("injects serially, maps speakers, scales pauses by speed and reports completion", async () => {
    const script = rehearsalScript("team-standup")!;
    const injected: { text: string; speaker: Speaker }[] = [];
    const pauses: number[] = [];
    let inFlight = 0, maxInFlight = 0;
    const progress: number[] = [];
    let done: unknown;
    const player = new RehearsalPlayer({
      inject: async (text, speaker) => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await Promise.resolve(); injected.push({ text, speaker }); inFlight--; },
      sleep: async ms => { pauses.push(ms); },
      onProgress: index => progress.push(index),
      onDone: result => { done = result; },
    });
    const result = await player.play(script, 2);
    expect(result).toMatchObject({ completed: true, lines: script.lines.length, total: script.lines.length, scriptId: script.id });
    expect(done).toEqual(result);
    expect(player.state).toBe("completed");
    expect(maxInFlight).toBe(1);
    expect(progress).toEqual(script.lines.map((_, i) => i));
    expect(injected[0]!.speaker).toEqual({ label: "Other speaker", role: "other" });
    expect(injected.find((_, i) => script.lines[i]!.speaker === "self")!.speaker).toEqual({ label: "You", role: "self" });
    expect(pauses).toHaveLength(script.lines.length - 1);
    const explicit = script.lines.findIndex(l => l.pauseMs);
    expect(pauses[explicit]).toBe(script.lines[explicit]!.pauseMs! / 2);
    expect(pauses[0]).toBe(defaultPauseMs(script.lines[0]!.text) / 2);
  });

  it("stop() aborts mid-script, including during a pause", async () => {
    const script = rehearsalScript("mock-interview-ml")!;
    let count = 0;
    const player = new RehearsalPlayer({
      inject: async () => { count++; if (count === 3) setTimeout(() => player.stop(), 5); },
      // Pauses after line 3 never resolve: only stop() can wake them.
      sleep: () => count >= 3 ? new Promise(() => undefined) : Promise.resolve(),
    });
    const result = await player.play(script);
    expect(result.completed).toBe(false);
    expect(result.lines).toBe(3);
    expect(player.state).toBe("stopped");
  });

  it("an inject failure ends the run as failed with the error", async () => {
    const player = new RehearsalPlayer({ inject: async text => { if (text.includes("budget")) throw new Error("provider down"); }, sleep: noSleep });
    const result = await player.play(rehearsalScript("hardware-planning")!);
    expect(result).toMatchObject({ completed: false, error: "provider down" });
    expect(player.state).toBe("failed");
  });
});

/* =============================================================================================== */

describe("fake OpenAI contract", () => {
  it("streams Responses SSE with usage on response.completed", async () => {
    const fake = createFakeOpenAI();
    const response = await fake.fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${FAKE_KEY}` },
      body: JSON.stringify({ model: MODEL, stream: true, reasoning: { effort: "low" }, input: [{ role: "user", content: "REQUEST\nWhat's the budget?" }] }) });
    const text = await response.text();
    const events = text.split("\n\n").filter(Boolean).map(block => JSON.parse(block.slice(6)));
    expect(events.filter(e => e.type === "response.output_text.delta").map(e => e.delta).join("")).toContain("What's the budget?");
    const completed = events.at(-1);
    expect(completed.type).toBe("response.completed");
    expect(completed.response.usage).toMatchObject({ input_tokens: expect.any(Number), input_tokens_details: { cached_tokens: 0 }, output_tokens: expect.any(Number), output_tokens_details: { reasoning_tokens: 64 } });
    expect(fake.requests[0]).toMatchObject({ intent: "answer", stream: true, kind: "responses-stream" });
  });

  it("chat completions stream ends with a usage chunk when include_usage is set", async () => {
    const fake = createFakeOpenAI();
    const response = await fake.fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${FAKE_KEY}` },
      body: JSON.stringify({ model: MODEL, stream: true, stream_options: { include_usage: true }, messages: [{ role: "system", content: "x" }, { role: "user", content: "Who owns it?" }] }) });
    const blocks = (await response.text()).split("\n\n").filter(Boolean);
    expect(blocks.at(-1)).toBe("data: [DONE]");
    expect(JSON.parse(blocks.at(-2)!.slice(6)).usage).toMatchObject({ prompt_tokens: expect.any(Number), completion_tokens: expect.any(Number) });
  });

  it("json_schema requests get schema-shaped JSON computed from the conversation", async () => {
    const fake = createFakeOpenAI();
    const str = { type: "string" }, obj = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
    const schema = obj({ summary: obj({ bullets: { type: "array", items: str }, keyFacts: { type: "array", items: str } }), concepts: { type: "array", items: obj({ term: str, explanation: str }) },
      conflicts: { type: "array", items: obj({ earlier: str, later: str, explanation: str }) }, asks: { type: "array", items: obj({ kind: { type: "string", enum: ["lookup", "propose", "question"] }, topic: str, trigger: str }) } });
    const speech = rehearsalScript("hardware-planning")!.lines.map(l => `${l.speaker === "self" ? "You" : "Other speaker"}: ${l.text}`).join("\n");
    const response = await fake.fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { Authorization: `Bearer ${FAKE_KEY}` },
      body: JSON.stringify({ model: "gpt-6-luna", instructions: "e.g. CDTF, 16 GB RAM", input: JSON.stringify({ newSpeech: speech, alreadyExplainedTerms: ["Kubernetes"] }), text: { format: { type: "json_schema", name: "helix_copilot", schema, strict: true } } }) });
    const value = await response.json();
    const data = JSON.parse(value.output.at(-1).content[0].text);
    expect(data.summary.bullets.length).toBeGreaterThan(0);
    expect(data.concepts.map((c: { term: string }) => c.term)).toEqual(expect.arrayContaining(["CDTF", "NVMe", "ROS 2"]));
    expect(data.concepts.map((c: { term: string }) => c.term)).not.toContain("Kubernetes");
    expect(data.conflicts[0].earlier).toContain("$40,000");
    expect(data.conflicts[0].later).toContain("$25,000");
    expect(data.asks.map((a: { kind: string }) => a.kind)).toEqual(["lookup", "propose"]);
    expect(speech).toContain(data.asks[0].trigger); // verbatim quote
    expect(fake.requests[0]).toMatchObject({ intent: "copilot", schemaName: "helix_copilot" });
  });

  it("web_search JSON satisfies the SDK fact-check parser (WebFactChecker)", async () => {
    const fake = createFakeOpenAI();
    const results: sdk.FactCheckResult[] = [];
    const checker = new sdk.WebFactChecker({ fetch: fake.fetch, key: FAKE_KEY, sessionId: "s", enabled: () => true, onResult: r => results.push(r) });
    checker.submit("t1", "The Jetson AGX Orin has 64 GB of memory.");
    await vi.waitFor(() => expect(results).toHaveLength(1), WAIT);
    expect(results[0]).toMatchObject({ status: "supported" });
    expect(results[0]!.sources.length).toBeGreaterThan(0);
    const request = fake.requests.find(r => r.webSearch)!;
    expect(request.intent).toBe("fact-check");
  });

  it("fake realtime socket speaks the transcription protocol", async () => {
    const fake = createFakeOpenAI({ transcripts: ["Jetson devices are hard to order."], latency: { realtimeMs: 10 } });
    const secret = await (await fake.fetch("https://api.openai.com/v1/realtime/client_secrets", { method: "POST", headers: { Authorization: `Bearer ${FAKE_KEY}` }, body: "{}" })).json();
    const socket = fake.webSocketFactory("wss://api.openai.com/v1/realtime?intent=transcription", ["realtime", `openai-insecure-api-key.${secret.value}`]);
    const messages: { type: string; [k: string]: unknown }[] = [];
    socket.addEventListener("message", event => messages.push(JSON.parse(String(event.data))));
    await new Promise<void>(resolve => { socket.onopen = () => resolve(); });
    socket.send(JSON.stringify({ type: "session.update", session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "gpt-live-transcribe" }, turn_detection: null } } } }));
    socket.send(JSON.stringify({ type: "input_audio_buffer.commit" })); // empty -> error, like the real API
    const pcm24k = Buffer.from(new Int16Array(24000 * 0.3).fill(3000).buffer).toString("base64");
    socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm24k }));
    socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    await vi.waitFor(() => expect(messages.some(m => m.type === "conversation.item.input_audio_transcription.completed")).toBe(true), WAIT);
    const types = messages.map(m => m.type);
    expect(types[0]).toBe("session.created");
    expect(types).toContain("session.updated");
    expect(messages.find(m => m.type === "error")).toMatchObject({ error: { code: "input_audio_buffer_commit_empty" } });
    const deltas = messages.filter(m => m.type === "conversation.item.input_audio_transcription.delta").map(m => m.delta).join("");
    const completed = messages.find(m => m.type === "conversation.item.input_audio_transcription.completed")!;
    expect(deltas).toBe("Jetson devices are hard to order.");
    expect(completed).toMatchObject({ transcript: "Jetson devices are hard to order.", item_id: messages.find(m => m.type === "input_audio_buffer.committed")!.item_id });
    expect(socket.commits[0]!.completedAt! - socket.commits[0]!.at).toBeGreaterThanOrEqual(10);
    socket.close();
    await vi.waitFor(() => expect(socket.readyState).toBe(3), WAIT);
    const rejected = fake.webSocketFactory("wss://api.openai.com/v1/realtime?intent=transcription", ["realtime"]);
    await vi.waitFor(() => expect(rejected.readyState).toBe(3), WAIT);
  });
});

describe("E2E · SDK ConversationCopilot lane against the fake (copilot.ts)", () => {
  for (const script of REHEARSAL_SCRIPTS) {
    liveIf(!!SdkCopilot)(`${script.id}: summary, concepts, conflicts, asks and verification`, async () => {
      const fake = createFakeOpenAI();
      const log: CopilotLog = { summaries: [], concepts: [], conflicts: [], suggestions: [], asks: new Map(), verifications: [], metas: [], usage: [] };
      const copilot = new SdkCopilot!({ fetch: fake.fetch, key: FAKE_KEY, sessionId: "s", callbacks: copilotCallbacks(log), onUsage: u => log.usage.push(u), cooldownMs: 0 });
      script.lines.forEach((line, index) => copilot.submit(`t${index}`, line.text, line.speaker === "self" ? "You" : "Other speaker"));
      copilot.runNow();
      const e = script.expectations;
      await vi.waitFor(() => {
        expect(log.summaries.at(-1)?.bullets.length ?? 0).toBeGreaterThan(0);
        for (const term of e.concepts ?? []) expect(log.concepts.map(c => c.term)).toContain(term);
        expect(log.conflicts.length > 0).toBe(!!e.conflict);
        const asks = finalAsks(log);
        for (const needle of e.lookups ?? []) {
          const ask = asks.find(a => a.kind === "lookup" && a.trigger.includes(needle));
          expect(ask?.status, `lookup: ${needle}`).toBe("done");
          expect(ask!.sources?.length ?? 0).toBeGreaterThan(0);
        }
        for (const needle of e.proposes ?? []) expect(asks.find(a => a.kind === "propose" && a.trigger.includes(needle))?.status, `propose: ${needle}`).toBe("done");
        for (const needle of e.implicitQuestions ?? []) expect(asks.find(a => a.kind === "question" && a.trigger.includes(needle))?.status, `implicit question: ${needle}`).toBe("done");
      }, WAIT);
      for (const history of log.asks.values()) expect(history.map(a => a.status)).toEqual(["pending", "done"]);
      expect(log.usage.length).toBeGreaterThan(0);
      for (const usage of log.usage) { expect(usage.measured).toBe(true); expect(usage.costUsd ?? 0).toBeGreaterThan(0); }
      if (e.lookups?.length) expect(log.usage.some(u => u.kind === "lookup" && u.webSearchCalls > 0)).toBe(true);
      copilot.verify(log.summaries.at(-1)!.bullets[0]!, "bullet-0");
      await vi.waitFor(() => expect(log.verifications.at(-1)).toMatchObject({ id: "bullet-0", requestedBy: "user", status: "supported" }), WAIT);
      expect(log.verifications.at(-1)!.sources.length).toBeGreaterThan(0);
      copilot.cancel();
    });
  }
});

/* =============================================================================================== */

/** Client + real DirectConversationTransport; each line goes through audio -> HTTP STT -> answer. */
async function runAudioPath(fake: FakeOpenAI, script: RehearsalScript) {
  const transport = new DirectConversationTransport({ fetch: fake.fetch });
  const events: GatewayEvent[] = [];
  transport.subscribe(event => events.push(event));
  const client = new HelixConversationClient(transport);
  await client.start(sessionConfig(script), { openai: FAKE_KEY });
  let lines = 0;
  const player = new RehearsalPlayer({
    sleep: noSleep,
    inject: async (text, speaker) => {
      fake.queueTranscript(text);
      await client.sendAudio(synthSpeechPcm(700), { source: "rehearsal" });
      await client.commitAudio("manual", speaker);
      // Real speech leaves the answer time to stream while the next person talks;
      // with zero pauses we settle here so the next turn cannot supersede it.
      await settle(events, ++lines);
    },
  });
  const result = await player.play(script, 1);
  await client.stop("user");
  return { result, events, client };
}

describe("E2E · audio path through DirectConversationTransport (live now)", () => {
  for (const script of REHEARSAL_SCRIPTS) {
    it(`${script.id}: runs to completion and answers every question`, async () => {
      const fake = createFakeOpenAI();
      const { result, events } = await runAudioPath(fake, script);
      expect(result).toMatchObject({ completed: true, lines: script.lines.length, total: script.lines.length });
      expect(ofType(events, "error")).toEqual([]);
      expect(ofType(events, "transcript.final").map(e => e.text)).toEqual(script.lines.map(l => l.text));
      expectQuestionsAnswered(script, events);
      expect(events.at(-1)?.type).toBe("session.ended");
      // Speaker identity survives the pipeline.
      const finals = ofType(events, "transcript.final");
      finals.forEach((event, index) => expect(event.context.speaker.role).toBe(script.lines[index]!.speaker));
      // Provider traffic: one STT upload per line, the selected model on every answer, key only in the header.
      expect(fake.byIntent("transcription")).toHaveLength(script.lines.length);
      const answers = fake.byIntent("answer");
      expect(answers.length).toBeGreaterThanOrEqual(script.expectations.questions?.length ?? 0);
      for (const request of answers) {
        expect(request.body.model).toBe(MODEL);
        expect(request.authorization).toBe(`Bearer ${FAKE_KEY}`);
        expect(JSON.stringify(request.body)).not.toContain(FAKE_KEY);
      }
      expect(fake.pendingTranscripts()).toEqual([]);
    });
  }

  it("answer timing is measured against fake provider latency", async () => {
    const fake = createFakeOpenAI({ latency: { transcriptionMs: 30, firstTokenMs: 40, interTokenMs: 2 } });
    const script = rehearsalScript("team-standup")!;
    const { events } = await runAudioPath(fake, script);
    const answer = ofType(events, "answer.completed")[0]!;
    // totalMs is measured from commit: >= STT + first token. Generous upper bound for CI jitter.
    expect(answer.context.latencyMs.totalMs).toBeGreaterThanOrEqual(65);
    expect(answer.context.latencyMs.totalMs).toBeLessThan(3000);
    expect(answer.context.latencyMs.firstTokenMs).toBeGreaterThanOrEqual(65);
    expect(answer.context.latencyMs.transcriptionMs).toBeGreaterThanOrEqual(25);
  });

  it("a revoked key fails visibly instead of hanging", async () => {
    const fake = createFakeOpenAI({ failures: { "/audio/transcriptions": 401 } });
    const transport = new DirectConversationTransport({ fetch: fake.fetch });
    const events: GatewayEvent[] = [];
    transport.subscribe(event => events.push(event));
    const client = new HelixConversationClient(transport);
    await client.start(sessionConfig(rehearsalScript("team-standup")!), { openai: FAKE_KEY });
    fake.queueTranscript("Who owns the release?");
    await client.sendAudio(synthSpeechPcm(700));
    await client.commitAudio("manual", { label: "Other speaker", role: "other" });
    await vi.waitFor(() => expect(ofType(events, "error")[0]).toMatchObject({ code: "provider-authentication", fatal: true }), WAIT);
    await client.stop("user").catch(() => undefined);
  });
});

/* =============================================================================================== */

describe("E2E · G2ConversationController + presentation + history (live now)", () => {
  for (const script of REHEARSAL_SCRIPTS) {
    it(`${script.id}: hold-to-talk turns run through the controller to completion`, async () => {
      const fake = createFakeOpenAI();
      const events: GatewayEvent[] = [];
      const f = controllerFixture(options => {
        const transport = new DirectConversationTransport({ ...options, fetch: fake.fetch });
        transport.subscribe(event => events.push(event));
        return transport;
      });
      await f.controller.initialize();
      await f.controller.connect(form);
      let lines = 0;
      const player = new RehearsalPlayer({
        sleep: noSleep,
        inject: async (text, speaker) => {
          fake.queueTranscript(text);
          await f.controller.beginHold();
          const pcm = synthSpeechPcm(700);
          f.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array(pcm.buffer), source: AudioInputSource.Glasses,
            speakerRole: speaker.role === "self" ? AudioSpeakerRole.Self : AudioSpeakerRole.Other }) });
          await f.controller.releaseHold();
          await settle(events, ++lines);
        },
      });
      const result = await player.play(script);
      expect(result.completed).toBe(true);
      expectQuestionsAnswered(script, events);
      const snapshot = f.presentation.snapshot();
      expect(snapshot.status).not.toBe("failed");
      expect(snapshot.error).toBeUndefined();
      const answerItems = snapshot.feed.filter(item => item.kind === "answer");
      expect(answerItems.length).toBeGreaterThanOrEqual(script.expectations.questions?.length ?? 0);
      expect(answerItems.every(item => !item.streaming && item.body.trim())).toBe(true);
      // History archived on the phone: every transcript line, question and answer.
      await f.controller.disconnect();
      const [session] = f.controller.listHistorySessions();
      const archived = f.controller.openHistorySession(session!.id)!;
      expect(archived.entries.filter(e => e.kind === "transcript").map(e => e.text)).toEqual(script.lines.map(l => l.text));
      expect(archived.entries.filter(e => e.kind === "answer").length).toBe(ofType(events, "answer.completed").length);
      expect(archived.entries.some(e => e.kind === "answer" && e.metadata?.model === MODEL)).toBe(true);
    });
  }
});

/* =============================================================================================== */

interface CopilotLog {
  summaries: CopilotSummary[]; concepts: CopilotConcept[]; conflicts: CopilotConflict[]; suggestions: CopilotSuggestion[][];
  asks: Map<string, CopilotAsk[]>; verifications: VerificationResult[]; metas: AnswerMeta[]; usage: UsageRecord[];
}
function copilotCallbacks(log: CopilotLog): CopilotCallbacks {
  return {
    enabled: () => true, settings: () => DEFAULT_COPILOT_SETTINGS,
    onSummary: s => log.summaries.push(s), onConcept: c => log.concepts.push(c), onConflict: c => log.conflicts.push(c),
    onSuggestions: items => log.suggestions.push([...items]),
    onAsk: ask => log.asks.set(ask.id, [...(log.asks.get(ask.id) ?? []), ask]),
    onVerification: v => log.verifications.push(v),
  };
}
function finalAsks(log: CopilotLog): CopilotAsk[] { return [...log.asks.values()].map(history => history.at(-1)!); }
function metaOf(event: GatewayEvent): AnswerMeta | undefined {
  const candidate = event as unknown as { meta?: AnswerMeta; answerMeta?: AnswerMeta; context?: { meta?: AnswerMeta; answerMeta?: AnswerMeta } };
  return candidate.meta ?? candidate.answerMeta ?? candidate.context?.meta ?? candidate.context?.answerMeta;
}

describe("E2E · injectTranscript + copilot lane (DirectConversationTransport v0.7)", () => {
  for (const script of REHEARSAL_SCRIPTS) {
    liveIf(HAS_COPILOT_TRANSPORT)(`${script.id}: copilot surfaces summary, concepts, conflicts and asks; answers carry meta`, async () => {
      const fake = createFakeOpenAI({ latency: { firstTokenMs: 5, jsonMs: 5, webSearchMs: 5 } });
      const log: CopilotLog = { summaries: [], concepts: [], conflicts: [], suggestions: [], asks: new Map(), verifications: [], metas: [], usage: [] };
      // Extra option names are tolerated; the SDK agent picks the final ones (see docs/REHEARSAL.md).
      const transport = new DirectConversationTransport({ fetch: fake.fetch, copilot: copilotCallbacks(log),
        onAnswerMeta: (meta: AnswerMeta) => log.metas.push(meta), onUsage: (usage: UsageRecord) => log.usage.push(usage) } as DirectConversationOptions);
      const inject = (transport as unknown as { injectTranscript: (t: string, s: Speaker) => Promise<void> }).injectTranscript.bind(transport);
      const events: GatewayEvent[] = [];
      transport.subscribe(event => { events.push(event); const meta = metaOf(event); if (meta) log.metas.push(meta); });
      const client = new HelixConversationClient(transport);
      await client.start(sessionConfig(script), { openai: FAKE_KEY });
      let lines = 0;
      const player = new RehearsalPlayer({ sleep: noSleep, inject: async (text, speaker) => { await inject(text, speaker); await settle(events, ++lines); } });
      const result = await player.play(script);
      expect(result.completed).toBe(true);
      expect(fake.byIntent("transcription"), "injectTranscript must not call STT").toHaveLength(0);
      (transport as unknown as { runCopilotNow: () => void }).runCopilotNow();

      const e = script.expectations;
      await vi.waitFor(() => {
        expect(log.summaries.at(-1)?.bullets.length ?? 0).toBeGreaterThan(0);
        for (const term of e.concepts ?? []) expect(log.concepts.map(c => c.term)).toContain(term);
        if (e.conflict) expect(log.conflicts.length).toBeGreaterThan(0);
        const asks = finalAsks(log);
        for (const needle of e.lookups ?? []) {
          const ask = asks.find(a => a.kind === "lookup" && a.trigger.includes(needle));
          expect(ask?.status, `lookup ask: ${needle}`).toBe("done");
          expect(ask!.sources?.length ?? 0).toBeGreaterThan(0);
        }
        for (const needle of e.proposes ?? []) expect(asks.find(a => a.kind === "propose" && a.trigger.includes(needle))?.status, `propose ask: ${needle}`).toBe("done");
      }, WAIT);
      // Asks report pending before done/failed for the same id.
      for (const history of log.asks.values()) if (history.length > 1) expect(history[0]!.status).toBe("pending");
      expect(fake.requests.filter(r => r.intent === "lookup").every(r => r.webSearch)).toBe(true);

      expectQuestionsAnswered(script, events);
      const answers = ofType(events, "answer.completed");
      expect(log.metas.length, "AnswerMeta per completed answer").toBeGreaterThanOrEqual(answers.length);
      for (const meta of log.metas) {
        expect(meta.timing.generationMs).toBeGreaterThanOrEqual(0);
        expect(meta.timing.endToEndMs).toBeGreaterThanOrEqual(meta.timing.generationMs);
        expect(meta.timing.queueMs).toBeGreaterThanOrEqual(0);
        if (meta.timing.firstTokenMs !== undefined) expect(meta.timing.firstTokenMs).toBeLessThanOrEqual(meta.timing.generationMs);
        expect(meta.timing.speechMs).toBe(0); // injected text has no audio
        expect(meta.usage?.measured).toBe(true);
        expect(meta.usage?.costUsd ?? 0).toBeGreaterThan(0); // MODEL has a published price
      }
      // Verification of any point (e.g. the first summary bullet).
      (transport as unknown as { verify: (target: string, id?: string) => void }).verify(log.summaries.at(-1)!.bullets[0]!, "bullet-0");
      await vi.waitFor(() => expect(log.verifications.at(-1)).toMatchObject({ requestedBy: "user" }), WAIT);
      expect(["supported", "contradicted", "uncertain", "unavailable"]).toContain(log.verifications.at(-1)!.status);
      await client.stop("user");
    });
  }

  liveIf(HAS_INJECT)("mock-interview-ml: implicit question raises a question ask", async () => {
    const fake = createFakeOpenAI();
    const log: CopilotLog = { summaries: [], concepts: [], conflicts: [], suggestions: [], asks: new Map(), verifications: [], metas: [], usage: [] };
    const transport = new DirectConversationTransport({ fetch: fake.fetch, copilot: copilotCallbacks(log) } as DirectConversationOptions);
    const client = new HelixConversationClient(transport);
    const script = rehearsalScript("mock-interview-ml")!;
    await client.start(sessionConfig(script), { openai: FAKE_KEY });
    const inject = (transport as unknown as { injectTranscript: (t: string, s: Speaker) => Promise<void> }).injectTranscript.bind(transport);
    await new RehearsalPlayer({ inject, sleep: noSleep }).play(script);
    (transport as unknown as { runCopilotNow?: () => void }).runCopilotNow?.();
    await vi.waitFor(() => expect(finalAsks(log).some(a => a.kind === "question" && a.trigger.includes("tight latency budget"))).toBe(true), WAIT);
    await client.stop("user");
  });
});

/* =============================================================================================== */

describe("E2E · realtime STT over the fake WebSocket (openai-realtime profile)", () => {
  liveIf(HAS_REALTIME_STT)("hardware-planning: audio frames -> realtime transcription -> answers", async () => {
    const fake = createFakeOpenAI({ latency: { realtimeMs: 20 } });
    const script = rehearsalScript("hardware-planning")!;
    const transport = new DirectConversationTransport({ fetch: fake.fetch, webSocketFactory: fake.webSocketFactory } as DirectConversationOptions);
    const events: GatewayEvent[] = [];
    transport.subscribe(event => events.push(event));
    const client = new HelixConversationClient(transport);
    await client.start(sessionConfig(script, "openai-realtime"), { openai: FAKE_KEY });
    let lines = 0;
    const result = await new RehearsalPlayer({ sleep: noSleep, inject: async (text, speaker) => {
      fake.queueTranscript(text);
      const pcm = synthSpeechPcm(1200);
      for (let offset = 0; offset < pcm.length; offset += 1600) await client.sendAudio(pcm.subarray(offset, offset + 1600));
      await client.commitAudio("manual", speaker);
      await settle(events, ++lines);
    } }).play(script);
    expect(result.completed).toBe(true);
    expect(ofType(events, "transcript.final").map(e => e.text)).toEqual(script.lines.map(l => l.text));
    expectQuestionsAnswered(script, events);
    // Ephemeral token flow: key only in the client_secrets POST; socket authenticates with the token.
    expect(fake.byIntent("client-secret").length).toBeGreaterThanOrEqual(1);
    const socket = fake.sockets[0]!;
    expect(socket.url).toMatch(/^wss:\/\/api\.openai\.com\/v1\/realtime\?intent=transcription/);
    expect(socket.protocols).toContain("realtime");
    expect(socket.authToken).toMatch(/^ek_fake_/);
    expect(socket.protocols.join(",")).not.toContain(FAKE_KEY);
    const update = socket.received.find(e => e.type === "session.update") as { session?: { type?: string; audio?: { input?: { format?: { rate?: number } } } } } | undefined;
    expect(update?.session?.type).toBe("transcription");
    expect(update?.session?.audio?.input?.format?.rate).toBe(24000);
    expect(socket.commits.length).toBe(script.lines.length);
    expect(fake.byIntent("transcription"), "no HTTP STT uploads on the realtime path").toHaveLength(0);
    await client.stop("user");
  });
});

/* =============================================================================================== */

describe("E2E · controller.rehearse + presentation copilot snapshot (integrator wiring)", () => {
  for (const script of REHEARSAL_SCRIPTS) {
    liveIf(HAS_REHEARSE && HAS_COPILOT_PRESENTATION && HAS_INJECT)(`${script.id}: controller.rehearse runs to completion`, async () => {
      const fake = createFakeOpenAI();
      const events: GatewayEvent[] = [];
      const f = controllerFixture(options => {
        const transport = new DirectConversationTransport({ ...options, fetch: fake.fetch });
        transport.subscribe(event => events.push(event));
        return transport;
      });
      const controller = f.controller as unknown as G2ConversationController & {
        rehearse(scriptId: string, speed?: number): Promise<{ completed: boolean; lines: number; durationMs: number }>;
        stopRehearsal(): void; verify(target: string, id?: string): void;
      };
      await controller.initialize();
      await controller.connect(form);
      const result = await controller.rehearse(script.id, 1000);
      expect(result).toMatchObject({ completed: true, lines: script.lines.length });
      await settle(events, script.lines.length);
      expectQuestionsAnswered(script, events);
      type Snapshot = ReturnType<ConversationPresentation["snapshot"]> & {
        summary?: CopilotSummary; concepts: readonly CopilotConcept[]; conflicts: readonly CopilotConflict[]; suggestions: readonly CopilotSuggestion[];
        asks: readonly CopilotAsk[]; verifications: readonly VerificationResult[]; answerMeta: Readonly<Record<string, AnswerMeta>> | readonly AnswerMeta[]; usage: readonly UsageRecord[] | { totalUsd?: number };
      };
      const e = script.expectations;
      await vi.waitFor(() => {
        const s = f.presentation.snapshot() as Snapshot;
        expect(s.status).not.toBe("failed");
        expect(s.summary?.bullets.length ?? 0).toBeGreaterThan(0);
        for (const term of e.concepts ?? []) expect(s.concepts.map(c => c.term)).toContain(term);
        if (e.conflict) expect(s.conflicts.length).toBeGreaterThan(0);
        for (const needle of e.lookups ?? []) {
          const ask = s.asks.find(a => a.kind === "lookup" && a.trigger.includes(needle));
          expect(ask?.status).toBe("done"); expect(ask!.sources?.length ?? 0).toBeGreaterThan(0);
        }
        for (const needle of e.proposes ?? []) expect(s.asks.find(a => a.kind === "propose" && a.trigger.includes(needle))?.status).toBe("done");
        const metas = Object.values(s.answerMeta);
        expect(metas.length).toBeGreaterThanOrEqual(ofType(events, "answer.completed").length);
        for (const meta of metas) { expect(meta.timing.endToEndMs).toBeGreaterThanOrEqual(0); expect(meta.usage?.costUsd ?? 0).toBeGreaterThan(0); }
      }, WAIT);
      const bullet = (f.presentation.snapshot() as Snapshot).summary!.bullets[0]!;
      controller.verify(bullet, "summary-0");
      await vi.waitFor(() => expect((f.presentation.snapshot() as Snapshot).verifications.length).toBeGreaterThan(0), WAIT);
      await controller.disconnect();
      const [session] = controller.listHistorySessions();
      expect(controller.openHistorySession(session!.id)!.entries.filter(x => x.kind === "transcript")).toHaveLength(script.lines.length);
    });
  }

  liveIf(HAS_REHEARSE && HAS_INJECT)("stopRehearsal() ends a running rehearsal early", async () => {
    const fake = createFakeOpenAI();
    const f = controllerFixture(options => new DirectConversationTransport({ ...options, fetch: fake.fetch }));
    const controller = f.controller as unknown as G2ConversationController & { rehearse(id: string, speed?: number): Promise<{ completed: boolean; lines: number }>; stopRehearsal(): void };
    await controller.initialize();
    await controller.connect(form);
    const running = controller.rehearse("mock-interview-ml", 1); // real pauses: seconds per line
    await new Promise(resolve => setTimeout(resolve, 50));
    controller.stopRehearsal();
    const result = await running;
    expect(result.completed).toBe(false);
    expect(result.lines).toBeLessThan(rehearsalScript("mock-interview-ml")!.lines.length);
    expect(f.presentation.snapshot().status).not.toBe("failed");
  });
});
