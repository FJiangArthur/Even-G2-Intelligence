import { describe, expect, it, vi } from "vitest";
import { DirectConversationTransport } from "../src/direct-transport.js";
import { HelixConversationClient } from "../src/client.js";
import { InMemoryNoteSink } from "../src/notes.js";
import {
  OTHER_SPEAKER, SELF_SPEAKER, SpeakerRoleTally, isGatewayEvent, isGenericSpeaker, questionKindFor, roleSpeaker,
  type GatewayEvent, type SessionConfig, type Speaker,
} from "../src/index.js";
import type { RealtimeSocketLike } from "../src/realtime-transcription.js";

const SESSION_SPEAKER: Speaker = { label: "G2 conversation", role: "unknown" };
const base: SessionConfig = {
  sessionId: "v08", endpoint: { id: "openai-direct", url: "https://api.openai.com/v1/responses", provider: "openai", model: "gpt-6.1-terra" },
  prompt: { id: "p", version: "1", system: "Be brief.", maxResponseSentences: 2 },
  providers: { transcriptionProvider: "openai-transcribe", answerProvider: "openai-responses" },
  speaker: SESSION_SPEAKER, mode: "office-discussion", responseStrategy: "reactive", locale: "en-US",
  automation: { detectQuestions: true, answerQuestions: true, saveNotes: true }, memory: { readOmiContext: false, syncNotes: false },
};
const answer = (text: string) => new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\ndata: {"type":"response.completed"}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
const loud = (n = 1600) => new Int16Array(n).fill(4000), quiet = (n = 1600) => new Int16Array(n).fill(20);
const ofType = <T extends GatewayEvent["type"]>(events: GatewayEvent[], type: T) => events.filter((e): e is Extract<GatewayEvent, { type: T }> => e.type === type);
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

describe("speaker attribution helpers", () => {
  it("picks the dominant role by loud samples, falls back to all samples and ignores untagged frames", () => {
    const tally = new SpeakerRoleTally();
    expect(tally.dominant()).toBeUndefined(); expect(tally.empty).toBe(true);
    tally.add(undefined, 16000, true); tally.add("bogus", 16000, true);
    expect(tally.empty).toBe(true);
    tally.add("self", 8000, false); tally.add("other", 1600, true);
    expect(tally.dominant()).toBe("other");
    tally.reset(); tally.add("self", 8000, false); tally.add("other", 1600, false);
    expect(tally.dominant()).toBe("self");
    tally.reset(); tally.add("self", 1600, true); tally.add("other", 1600, true);
    expect(tally.dominant()).toBe("other"); // ties keep answering as the default
  });
  it("replaces only generic speakers and maps roles to You / Other speaker / session speaker", () => {
    const tally = new SpeakerRoleTally(); tally.add("self", 3200, true);
    expect(tally.speaker(SESSION_SPEAKER, SESSION_SPEAKER)).toEqual(SELF_SPEAKER);
    expect(tally.speaker({ label: "Speaker", role: "unknown" }, SESSION_SPEAKER)).toEqual(SELF_SPEAKER);
    expect(tally.speaker(OTHER_SPEAKER, SESSION_SPEAKER)).toEqual(SELF_SPEAKER);
    expect(tally.speaker({ label: "Alice", role: "other" }, SESSION_SPEAKER)).toEqual({ label: "Alice", role: "other" });
    expect(tally.speaker({ id: "p1", label: "Speaker", role: "unknown" }, SESSION_SPEAKER)).toMatchObject({ id: "p1" });
    expect(new SpeakerRoleTally().speaker(SESSION_SPEAKER, SESSION_SPEAKER)).toBe(SESSION_SPEAKER);
    expect(roleSpeaker("other", SESSION_SPEAKER)).toEqual({ label: "Other speaker", role: "other" });
    expect(roleSpeaker("unknown", SESSION_SPEAKER)).toBe(SESSION_SPEAKER);
    expect(isGenericSpeaker({ label: "You", role: "self" }, SESSION_SPEAKER)).toBe(true);
    expect(isGenericSpeaker({ label: "Art", role: "self" }, SESSION_SPEAKER)).toBe(false);
  });
  it("questionKindFor: the wearer's own questions are asks, everyone else's are answered", () => {
    expect(questionKindFor("self")).toBe("ask");
    expect(questionKindFor("other")).toBe("answer");
    expect(questionKindFor("unknown")).toBe("answer");
    expect(questionKindFor(undefined)).toBe("answer");
  });
});

function uploaded(transcripts: string[]) {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith("transcriptions") ? Response.json({ text: transcripts.shift() ?? "" }) : answer("Friday."));
  const transport = new DirectConversationTransport({ fetch: fetcher });
  const events: GatewayEvent[] = [];
  const client = new HelixConversationClient(transport, { vad: false, noteSink: new InMemoryNoteSink(), autoSaveSuggestedNotes: true });
  client.subscribe(event => { expect(isGatewayEvent(event)).toBe(true); events.push(event); });
  const answerCalls = () => fetcher.mock.calls.filter(c => c[0].endsWith("/responses")).length;
  return { fetcher, transport, client, events, answerCalls };
}

describe("uploaded STT: dominant role since the last commit", () => {
  it("attributes a generic commit to the wearer, shows the question but does not auto-answer it", async () => {
    const h = uploaded(["When can you ship the boards?"]);
    await h.client.start(base, { openai: "k" });
    for (let i = 0; i < 5; i++) await h.client.sendAudio(loud(), { speakerRole: "self" });
    await h.client.sendAudio(loud(), { speakerRole: "other" });
    await h.client.commitAudio(); // generic session speaker
    await vi.waitFor(() => expect(ofType(h.events, "question.detected")).toHaveLength(1));
    await settle();
    expect(ofType(h.events, "transcript.final")[0]!.context.speaker).toEqual(SELF_SPEAKER);
    expect(ofType(h.events, "question.detected")[0]).toMatchObject({ text: "When can you ship the boards?", context: { speaker: SELF_SPEAKER } });
    expect(ofType(h.events, "answer.completed")).toHaveLength(0);
    expect(h.answerCalls()).toBe(0);
    await h.client.dispose();
  });
  it("auto-answers questions from the other party; quiet frames lose to loud frames", async () => {
    const h = uploaded(["When can you ship the boards?"]);
    await h.client.start(base, { openai: "k" });
    for (let i = 0; i < 8; i++) await h.client.sendAudio(quiet(), { speakerRole: "self" });
    for (let i = 0; i < 2; i++) await h.client.sendAudio(loud(), { speakerRole: "other" });
    await h.client.commitAudio("manual", { label: "Speaker", role: "unknown" });
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    expect(ofType(h.events, "transcript.final")[0]!.context.speaker).toEqual(OTHER_SPEAKER);
    expect(ofType(h.events, "answer.completed")[0]!.context.speaker).toEqual(OTHER_SPEAKER);
    await h.client.dispose();
  });
  it("keeps an explicit commit speaker, resets the tally per commit and uses the session speaker for unknown frames", async () => {
    const h = uploaded(["Alice here, when do we ship?", "And who owns QA?"]);
    await h.client.start(base, { openai: "k" });
    for (let i = 0; i < 3; i++) await h.client.sendAudio(loud(), { speakerRole: "self" });
    await h.client.commitAudio("manual", { id: "p1", label: "Alice", role: "other" });
    await vi.waitFor(() => expect(ofType(h.events, "transcript.final")).toHaveLength(1));
    for (let i = 0; i < 3; i++) await h.client.sendAudio(loud(), { speakerRole: "unknown" });
    await h.client.commitAudio();
    await vi.waitFor(() => expect(ofType(h.events, "transcript.final")).toHaveLength(2));
    const [first, second] = ofType(h.events, "transcript.final");
    expect(first!.context.speaker).toEqual({ id: "p1", label: "Alice", role: "other" });
    expect(second!.context.speaker).toEqual(SESSION_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed").length).toBeGreaterThanOrEqual(1));
    await h.client.dispose();
  });
  it("untagged frames keep the commit speaker (legacy hosts)", async () => {
    const h = uploaded(["What is the plan?"]);
    await h.client.start(base, { openai: "k" });
    await h.client.sendAudio(loud(16000));
    await h.client.commitAudio("manual", SELF_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "question.detected")).toHaveLength(1));
    await settle();
    expect(ofType(h.events, "transcript.final")[0]!.context.speaker).toEqual(SELF_SPEAKER);
    expect(h.answerCalls()).toBe(0);
    await h.client.dispose();
  });
  it("attributes notes to the dominant speaker", async () => {
    const h = uploaded(["We decided to ship the Jetson build on Friday."]);
    await h.client.start(base, { openai: "k" });
    for (let i = 0; i < 4; i++) await h.client.sendAudio(loud(), { speakerRole: "other" });
    await h.client.commitAudio();
    await vi.waitFor(() => expect(ofType(h.events, "note.suggested")).toHaveLength(1));
    expect(ofType(h.events, "note.suggested")[0]!.note.provenance.speaker).toEqual(OTHER_SPEAKER);
    await h.client.dispose();
  });
});

describe("injected transcripts follow the same question policy", () => {
  it("answers other/unknown questions, never the wearer's own", async () => {
    const h = uploaded([]);
    await h.client.start(base, { openai: "k" });
    await h.transport.injectTranscript("What lead time are you seeing for Jetson boards?", SELF_SPEAKER);
    await settle();
    expect(ofType(h.events, "question.detected")).toHaveLength(1);
    expect(h.answerCalls()).toBe(0);
    await h.transport.injectTranscript("What lead time are you seeing for Jetson boards?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    expect(ofType(h.events, "answer.completed")[0]!.questionId).toBe(ofType(h.events, "question.detected")[1]!.questionId);
    await h.client.dispose();
  });
  it("still honours automation.answerQuestions=false for other speakers", async () => {
    const h = uploaded([]);
    await h.client.start({ ...base, automation: { detectQuestions: true, answerQuestions: false, saveNotes: false } }, { openai: "k" });
    await h.transport.injectTranscript("When will the boards ship to us?", OTHER_SPEAKER);
    await settle();
    expect(ofType(h.events, "question.detected")).toHaveLength(1);
    expect(h.answerCalls()).toBe(0);
    await h.client.dispose();
  });
});

class FakeSocket implements RealtimeSocketLike {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: ((event?: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  constructor(public url: string, public protocols: string[]) { FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  server(event: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(event) }); }
  of(type: string) { return this.sent.filter(m => m.type === type); }
}
function realtime() {
  FakeSocket.all = [];
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith("client_secrets") ? Response.json({ value: "ek" }) : answer("Friday."));
  const transport = new DirectConversationTransport({ fetch: fetcher, webSocketFactory: (url, protocols) => new FakeSocket(url, protocols), realtimeReconnectBaseMs: 5 });
  const events: GatewayEvent[] = [];
  const client = new HelixConversationClient(transport, { vad: false, noteSink: new InMemoryNoteSink(), autoSaveSuggestedNotes: true });
  client.subscribe(event => { expect(isGatewayEvent(event)).toBe(true); events.push(event); });
  const answerCalls = () => fetcher.mock.calls.filter(c => c[0].endsWith("/responses")).length;
  return { client, events, answerCalls };
}
const rtConfig: SessionConfig = { ...base, providers: { transcriptionProvider: "openai-realtime", answerProvider: "openai-responses" }, automation: { detectQuestions: true, answerQuestions: true, saveNotes: false } };

describe("realtime STT: dominant role within each turn", () => {
  it("uses the turn's dominant role on live and committed partials, final and question; self questions are not answered", async () => {
    const h = realtime();
    await h.client.start(rtConfig, { openai: "k" });
    await h.client.sendAudio(loud(), { speakerRole: "self" });
    await vi.waitFor(() => expect(FakeSocket.all.length).toBe(1));
    const s = FakeSocket.all[0]!; s.open();
    for (let i = 0; i < 4; i++) await h.client.sendAudio(loud(), { speakerRole: "self" });
    await h.client.sendAudio(quiet(), { speakerRole: "other" });
    s.server({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: "When can you ship" });
    expect(ofType(h.events, "transcript.partial").at(-1)!.context.speaker).toEqual(SELF_SPEAKER);
    await h.client.commitAudio(); // generic
    s.server({ type: "input_audio_buffer.committed", item_id: "a" });
    s.server({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: " the boards?" });
    expect(ofType(h.events, "transcript.partial").at(-1)!.context.speaker).toEqual(SELF_SPEAKER);
    s.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "When can you ship the boards?" });
    await vi.waitFor(() => expect(ofType(h.events, "question.detected")).toHaveLength(1));
    await settle();
    expect(ofType(h.events, "transcript.final")[0]!.context.speaker).toEqual(SELF_SPEAKER);
    expect(ofType(h.events, "question.detected")[0]!.context.speaker).toEqual(SELF_SPEAKER);
    expect(h.answerCalls()).toBe(0);

    // Next turn: the other party asks; the tally was reset at the previous commit.
    for (let i = 0; i < 4; i++) await h.client.sendAudio(loud(), { speakerRole: "other" });
    await h.client.commitAudio();
    s.server({ type: "input_audio_buffer.committed", item_id: "b" });
    s.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "b", transcript: "How long is the Jetson lead time?" });
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    expect(ofType(h.events, "transcript.final")[1]!.context.speaker).toEqual(OTHER_SPEAKER);
    expect(h.answerCalls()).toBe(1);
    await h.client.dispose();
  });
  it("auto-committed turns (silence endpointing) also use the dominant role; unknown maps to the session speaker", async () => {
    const h = realtime();
    await h.client.start(rtConfig, { openai: "k" });
    await h.client.sendAudio(loud(), { speakerRole: "unknown" });
    await vi.waitFor(() => expect(FakeSocket.all.length).toBe(1));
    const s = FakeSocket.all[0]!; s.open();
    await h.client.sendAudio(loud(), { speakerRole: "unknown" });
    for (let i = 0; i < 12; i++) await h.client.sendAudio(new Int16Array(1600), { speakerRole: "self" }); // silence ends the turn
    expect(s.of("input_audio_buffer.commit")).toHaveLength(1);
    s.server({ type: "input_audio_buffer.committed", item_id: "u" });
    s.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u", transcript: "Who approves the budget?" });
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    expect(ofType(h.events, "transcript.final")[0]!.context.speaker).toEqual(SESSION_SPEAKER);
    await h.client.dispose();
  });
});
