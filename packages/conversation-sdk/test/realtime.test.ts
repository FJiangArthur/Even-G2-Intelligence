import { describe, expect, it, vi } from "vitest";
import { DirectConversationTransport } from "../src/direct-transport.js";
import { HelixConversationClient } from "../src/client.js";
import { InMemoryNoteSink } from "../src/notes.js";
import { isGatewayEvent, type GatewayEvent, type SessionConfig, type UsageRecord, type AnswerMeta } from "../src/index.js";
import { REALTIME_URL, resample16kTo24k, type RealtimeSocketLike } from "../src/realtime-transcription.js";

class FakeSocket implements RealtimeSocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  closed = false;
  constructor(public url: string, public protocols: string[]) { FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  server(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
  drop() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
  of(type: string) { return this.sent.filter(m => m.type === type); }
}

const config: SessionConfig = {
  sessionId: "rt", endpoint: { id: "openai-direct", url: "https://api.openai.com/v1/responses", provider: "openai", model: "gpt-6.1-terra" },
  prompt: { id: "p", version: "1", system: "Be brief.", maxResponseSentences: 2 },
  providers: { transcriptionProvider: "openai-realtime", answerProvider: "openai-responses" },
  // Generic session speaker (the G2 plugin uses role "unknown"); v0.8 never auto-answers "self" questions.
  speaker: { label: "User", role: "unknown" }, mode: "office-discussion", responseStrategy: "reactive", locale: "en-US",
  automation: { detectQuestions: true, answerQuestions: true, saveNotes: false }, memory: { readOmiContext: false, syncNotes: false },
};
const answer = (text: string) => new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\ndata: {"type":"response.completed"}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
const loud = (n = 1600) => new Int16Array(n).fill(4000), quiet = (n = 1600) => new Int16Array(n);

function setup(mint: () => Response = () => Response.json({ value: "ek_ephemeral" })) {
  FakeSocket.all = [];
  const usage: UsageRecord[] = [], metas: AnswerMeta[] = [], events: GatewayEvent[] = [];
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith("client_secrets") ? mint() : answer("Ship Friday."));
  const transport = new DirectConversationTransport({ fetch: fetcher, webSocketFactory: (url, protocols) => new FakeSocket(url, protocols), onUsage: u => usage.push(u), onAnswerMeta: m => metas.push(m), realtimeReconnectBaseMs: 5 });
  const client = new HelixConversationClient(transport, { vad: false, noteSink: new InMemoryNoteSink(), autoSaveSuggestedNotes: true });
  client.subscribe(event => { expect(isGatewayEvent(event)).toBe(true); events.push(event); });
  return { fetcher, transport, client, events, usage, metas };
}
async function socket() { await vi.waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0)); const s = FakeSocket.all.at(-1)!; s.open(); return s; }

describe("OpenAI Realtime transcription (gpt-live-transcribe)", () => {
  it("resamples 16 kHz to 24 kHz: 16000 samples -> 24000", () => {
    const out = resample16kTo24k(new Int16Array(16000).map((_, i) => i % 100));
    expect(out).toHaveLength(24000); expect(out[0]).toBe(0); expect(out[3]).toBe(2);
  });
  it("mints an ephemeral secret, authenticates via subprotocol and sends the transcription session.update", async () => {
    const { fetcher, client } = setup();
    await client.start(config, { openai: "sk-secret" });
    await client.sendAudio(loud());
    const s = await socket();
    expect(fetcher.mock.calls[0]![0]).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({ session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "gpt-live-transcribe", delay: "low", languages: ["en"] }, turn_detection: null } } } });
    expect(s.url).toBe(REALTIME_URL);
    expect(s.protocols).toEqual(["realtime", "openai-insecure-api-key.ek_ephemeral"]);
    expect(s.sent[0]).toEqual({ type: "session.update", session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "gpt-live-transcribe", delay: "low", languages: ["en"] }, turn_detection: null } } } });
    expect(JSON.stringify(s.sent)).not.toContain("sk-secret");
    await client.dispose(); expect(s.closed).toBe(true);
  });
  it("falls back to the raw key subprotocol when minting returns 404", async () => {
    const { client } = setup(() => new Response("", { status: 404 }));
    await client.start(config, { openai: "sk-raw" }); await client.sendAudio(loud());
    const s = await socket();
    expect(s.protocols).toEqual(["realtime", "openai-insecure-api-key.sk-raw"]);
    await client.dispose();
  });
  it("streams appends before commit, emits partials and runs the normal transcript path with an auto answer", async () => {
    const { client, events, usage, metas } = setup();
    await client.start(config, { openai: "k" });
    await client.sendAudio(loud());
    const s = await socket();
    for (let i = 0; i < 4; i++) await client.sendAudio(loud());
    const appends = s.of("input_audio_buffer.append");
    expect(appends.length).toBeGreaterThanOrEqual(5);
    expect(s.of("input_audio_buffer.commit")).toHaveLength(0);
    // 1600 samples at 16 kHz -> 2400 at 24 kHz -> 4800 bytes -> 6400 base64 chars.
    expect((appends[0]!.audio as string).length).toBe(6400);
    await client.commitAudio();
    expect(s.of("input_audio_buffer.commit")).toHaveLength(1);
    s.server({ type: "input_audio_buffer.committed", item_id: "item_1" });
    s.server({ type: "conversation.item.input_audio_transcription.delta", item_id: "item_1", delta: "What is" });
    s.server({ type: "conversation.item.input_audio_transcription.delta", item_id: "item_1", delta: " the plan?" });
    expect(events.filter(e => e.type === "transcript.partial").map(e => e.type === "transcript.partial" && e.text)).toEqual(["What is", "What is the plan?"]);
    s.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", transcript: "What is the plan?" });
    await vi.waitFor(() => expect(events.some(e => e.type === "answer.completed")).toBe(true));
    expect(events.find(e => e.type === "transcript.final")).toMatchObject({ text: "What is the plan?" });
    expect(usage.find(u => u.kind === "transcription")).toMatchObject({ model: "gpt-live-transcribe", audioSeconds: 0.5 });
    await vi.waitFor(() => expect(metas).toHaveLength(1));
    expect(metas[0]!.timing.speechMs).toBe(500);
    expect(metas[0]!.timing.endToEndMs).toBeGreaterThanOrEqual(metas[0]!.timing.generationMs);
    await client.dispose();
  });
  it("delivers out-of-order completions in commit order", async () => {
    const { client, events } = setup();
    await client.start({ ...config, automation: { detectQuestions: false, answerQuestions: false, saveNotes: false } }, { openai: "k" });
    await client.sendAudio(loud()); const s = await socket(); await client.sendAudio(loud()); await client.commitAudio();
    await client.sendAudio(loud()); await client.sendAudio(loud()); await client.commitAudio();
    expect(s.of("input_audio_buffer.commit")).toHaveLength(2);
    s.server({ type: "input_audio_buffer.committed", item_id: "a" });
    s.server({ type: "input_audio_buffer.committed", item_id: "b" });
    s.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "b", transcript: "Second." });
    await new Promise(r => setTimeout(r, 5));
    expect(events.some(e => e.type === "transcript.final")).toBe(false);
    s.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "First." });
    await vi.waitFor(() => expect(events.filter(e => e.type === "transcript.final")).toHaveLength(2));
    expect(events.filter(e => e.type === "transcript.final").map(e => e.type === "transcript.final" && e.text)).toEqual(["First.", "Second."]);
    await client.dispose();
  });
  it("auto-commits short turns after ~1.1 s of client-side silence (adaptive) and keeps streaming continuously", async () => {
    const { client } = setup();
    await client.start(config, { openai: "k" });
    await client.sendAudio(loud()); const s = await socket();
    await client.sendAudio(loud());
    for (let i = 0; i < 8; i++) await client.sendAudio(quiet()); // 800 ms: a breath inside a short turn
    expect(s.of("input_audio_buffer.commit")).toHaveLength(0);
    for (let i = 0; i < 3; i++) await client.sendAudio(quiet()); // 1.1 s
    expect(s.of("input_audio_buffer.commit")).toHaveLength(1);
    const before = s.of("input_audio_buffer.append").length;
    for (let i = 0; i < 20; i++) await client.sendAudio(quiet());
    // No loudness gate: quiet sentence openings must reach the model, so silence streams too...
    expect(s.of("input_audio_buffer.append").length).toBeGreaterThan(before);
    // ...but silence alone never ends (commits) a turn.
    expect(s.of("input_audio_buffer.commit")).toHaveLength(1);
    await client.dispose();
  });
  it("drops too-short or silence-only holds instead of committing", async () => {
    const { client } = setup();
    await client.start(config, { openai: "k" });
    await client.sendAudio(loud(800)); const s = await socket(); await client.commitAudio();
    expect(s.of("input_audio_buffer.commit")).toHaveLength(0);
    for (let i = 0; i < 10; i++) await client.sendAudio(quiet());
    await client.commitAudio();
    expect(s.of("input_audio_buffer.commit")).toHaveLength(0);
    // Dropped turns are cleared server-side instead of committed.
    expect(s.of("input_audio_buffer.clear").length).toBeGreaterThan(0);
    await client.dispose();
  });
  it("reconnects with backoff after a drop and replays the uncommitted turn", async () => {
    const { client, events } = setup();
    await client.start({ ...config, automation: { detectQuestions: false, answerQuestions: false, saveNotes: false } }, { openai: "k" });
    await client.sendAudio(loud()); const first = await socket();
    await client.sendAudio(loud());
    const sentAudio = first.of("input_audio_buffer.append").length;
    first.drop();
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2));
    const second = FakeSocket.all[1]!; second.open();
    expect(second.sent[0]!.type).toBe("session.update");
    expect(second.of("input_audio_buffer.append")).toHaveLength(sentAudio);
    await client.commitAudio();
    second.server({ type: "input_audio_buffer.committed", item_id: "x" });
    second.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "x", transcript: "After reconnect." });
    await vi.waitFor(() => expect(events.some(e => e.type === "transcript.final")).toBe(true));
    expect(events.some(e => e.type === "error" && e.fatal)).toBe(false);
    await client.dispose();
  });
  it("reports failed items nonfatally and authentication errors fatally", async () => {
    const { client, events } = setup();
    await client.start(config, { openai: "k" });
    await client.sendAudio(loud()); const s = await socket(); await client.commitAudio();
    s.server({ type: "input_audio_buffer.committed", item_id: "f" });
    s.server({ type: "conversation.item.input_audio_transcription.failed", item_id: "f", error: { message: "private" } });
    await vi.waitFor(() => expect(events.some(e => e.type === "error")).toBe(true));
    expect(events.find(e => e.type === "error")).toMatchObject({ fatal: false });
    s.server({ type: "error", error: { type: "authentication_error", code: "invalid_api_key", message: "private key detail" } });
    await vi.waitFor(() => expect(events.some(e => e.type === "error" && e.fatal)).toBe(true));
    expect(JSON.stringify(events)).not.toContain("private");
    await client.dispose();
  });
  it("streams live captions before commit and hands them to the committed turn (no lost sentence start)", async () => {
    const { client, events } = setup();
    await client.start({ ...config, automation: { detectQuestions: true, answerQuestions: false, saveNotes: false } }, { openai: "k" });
    await client.sendAudio(quiet()); const s = await socket();
    // A soft opening below any fixed threshold is still streamed.
    await client.sendAudio(new Int16Array(1600).fill(120));
    expect(s.of("input_audio_buffer.append").length).toBeGreaterThan(0);
    for (const delta of [" And", " what", " is", " more", " important"]) s.server({ type: "conversation.item.input_audio_transcription.delta", item_id: "live1", delta });
    const partials = events.filter(e => e.type === "transcript.partial").map(e => (e as { text: string }).text);
    expect(partials.at(-1)).toBe("And what is more important");
    await client.sendAudio(loud()); await client.commitAudio();
    s.server({ type: "input_audio_buffer.committed", item_id: "live1" });
    s.server({ type: "conversation.item.input_audio_transcription.delta", item_id: "live1", delta: "?" });
    expect((events.filter(e => e.type === "transcript.partial").at(-1) as { text: string }).text).toBe("And what is more important?");
    s.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "live1", transcript: "And what is more important?" });
    await vi.waitFor(() => expect(events.some(e => e.type === "transcript.final")).toBe(true));
    expect(events.find(e => e.type === "question.detected")).toMatchObject({ text: "And what is more important?" });
    await client.dispose();
  });
  it("ends a turn on sentence punctuation in the live caption even when the mic never looks loud", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { client } = setup();
      await client.start({ ...config, automation: { detectQuestions: false, answerQuestions: false, saveNotes: false } }, { openai: "k" });
      await client.sendAudio(quiet()); const s = await socket();
      for (let i = 0; i < 12; i++) await client.sendAudio(new Int16Array(1600).fill(30)); // 1.2 s, very quiet mic
      s.server({ type: "conversation.item.input_audio_transcription.delta", item_id: "q1", delta: "Is sixteen gigabytes enough?" });
      expect(s.of("input_audio_buffer.commit")).toHaveLength(0);
      vi.setSystemTime(Date.now() + 700);
      await client.sendAudio(new Int16Array(1600).fill(30));
      expect(s.of("input_audio_buffer.commit")).toHaveLength(1);
      // Late pre-commit deltas for the committed item must not start a new turn.
      s.server({ type: "conversation.item.input_audio_transcription.delta", item_id: "q1", delta: " " });
      vi.setSystemTime(Date.now() + 700);
      await client.sendAudio(new Int16Array(1600).fill(30));
      expect(s.of("input_audio_buffer.commit")).toHaveLength(1);
      await client.dispose();
    } finally { vi.useRealTimers(); }
  });
  it("never sends session.update mid-stream and keeps streamed words when a completion comes back empty", async () => {
    const { client, events } = setup();
    await client.start({ ...config, automation: { detectQuestions: false, answerQuestions: false, saveNotes: false } }, { openai: "k" });
    await client.sendAudio(loud()); const s = await socket();
    const updatesAtOpen = s.of("session.update").length;
    s.server({ type: "conversation.item.input_audio_transcription.delta", item_id: "e1", delta: "We should order the Jetson boards this week." });
    await client.sendAudio(loud()); await client.commitAudio();
    expect(s.of("session.update")).toHaveLength(updatesAtOpen);
    s.server({ type: "input_audio_buffer.committed", item_id: "e1" });
    s.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "e1", transcript: "" });
    await vi.waitFor(() => expect(events.find(e => e.type === "transcript.final")).toMatchObject({ text: "We should order the Jetson boards this week." }));
    await client.dispose();
  });
  it("resumeAfterSuspend replaces a silent (possibly dead) socket and replays the open turn", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { client, transport } = setup();
      await client.start({ ...config, automation: { detectQuestions: false, answerQuestions: false, saveNotes: false } }, { openai: "k" });
      await client.sendAudio(loud()); const first = await socket();
      await client.sendAudio(loud());
      expect(transport.resumeAfterSuspend(10_000)).toBe(false); // fresh socket: keep it
      vi.setSystemTime(Date.now() + 15_000);
      expect(transport.resumeAfterSuspend(10_000)).toBe(true);
      expect(first.closed).toBe(true);
      vi.useRealTimers();
      await vi.waitFor(() => expect(FakeSocket.all.length).toBe(2));
      const second = FakeSocket.all[1]!; second.open();
      expect(second.of("input_audio_buffer.append").length).toBeGreaterThan(0);
      await client.dispose();
    } finally { vi.useRealTimers(); }
  });
  it("v0.12.1 idle gate: after 3 s of silence the uplink pauses, a soft sound resumes it with the pre-roll, and it can be turned off", async () => {
    const uplink: string[] = [];
    FakeSocket.all = [];
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith("client_secrets") ? Response.json({ value: "ek_ephemeral" }) : answer("ok"));
    const make = (options: object) => new HelixConversationClient(new DirectConversationTransport({ fetch: fetcher, webSocketFactory: (url, protocols) => new FakeSocket(url, protocols), realtimeReconnectBaseMs: 5, ...options }), { vad: false, noteSink: new InMemoryNoteSink(), autoSaveSuggestedNotes: true });
    const appended = (s: FakeSocket) => s.of("input_audio_buffer.append").length;
    const client = make({ onUplink: (state: string) => uplink.push(state) });
    await client.start({ ...config, automation: { detectQuestions: true, answerQuestions: false, saveNotes: false } }, { openai: "k" });
    await client.sendAudio(quiet()); const s = await socket();
    for (let i = 0; i < 29; i++) await client.sendAudio(quiet()); // 3 s of silence in total
    const atPause = appended(s);
    for (let i = 0; i < 50; i++) await client.sendAudio(quiet()); // 5 s more: nothing is sent
    expect(uplink).toEqual(["paused"]);
    expect(appended(s)).toBeLessThanOrEqual(atPause + 1);
    expect(s.of("input_audio_buffer.clear").length).toBeGreaterThan(0);
    // A soft opening (well below the loud threshold) wakes the uplink; the 0.8 s before it goes out first.
    await client.sendAudio(new Int16Array(1600).fill(160));
    await client.sendAudio(loud());
    expect(uplink).toEqual(["paused", "resumed"]);
    expect(appended(s) - atPause).toBeGreaterThanOrEqual(9); // ~8 pre-roll chunks + the wake frame + speech
    // Words keep it open through pauses shorter than 3 s.
    for (let i = 0; i < 10; i++) await client.sendAudio(quiet());
    expect(uplink).toHaveLength(2);
    await client.dispose();

    FakeSocket.all = [];
    const always = make({ idleGate: false, onUplink: (state: string) => uplink.push(state) });
    await always.start({ ...config, sessionId: "always-on", automation: { detectQuestions: true, answerQuestions: false, saveNotes: false } }, { openai: "k" });
    await always.sendAudio(quiet()); const t = await socket();
    for (let i = 0; i < 60; i++) await always.sendAudio(quiet());
    expect(appended(t)).toBeGreaterThan(40);
    expect(uplink).toHaveLength(2);
    await always.dispose();
  });
});
