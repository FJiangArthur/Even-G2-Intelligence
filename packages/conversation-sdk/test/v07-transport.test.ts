import { describe, expect, it, vi } from "vitest";
import { DirectConversationTransport, type DirectConversationOptions } from "../src/direct-transport.js";
import { HelixConversationClient } from "../src/client.js";
import { InMemoryNoteSink } from "../src/notes.js";
import { DEFAULT_COPILOT_SETTINGS, isGatewayEvent, type AnswerMeta, type CopilotCallbacks, type GatewayEvent, type SessionConfig, type UsageRecord, type VerificationResult } from "../src/index.js";
import type { RetrievedMemory } from "../src/local-history.js";

const config: SessionConfig = {
  sessionId: "phone-v07", endpoint: { id: "openai-direct", url: "https://api.openai.com/v1/responses", provider: "openai", model: "gpt-6.1-terra" },
  prompt: { id: "p", version: "1", system: "Be brief.", maxResponseSentences: 2 },
  providers: { transcriptionProvider: "openai-transcribe", answerProvider: "openai-responses" },
  // Generic session speaker (the G2 plugin uses role "unknown"); v0.8 never auto-answers "self" questions.
  speaker: { label: "User", role: "unknown" }, mode: "office-discussion", responseStrategy: "reactive", locale: "en-US",
  automation: { detectQuestions: true, answerQuestions: true, saveNotes: false }, memory: { readOmiContext: false, syncNotes: false },
};
const usageEvent = { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 1000, output_tokens: 200 } } };
function sse(events: unknown[], delayMs = 0) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({ async start(c) {
    for (const event of events) { if (delayMs) await new Promise(r => setTimeout(r, delayMs)); c.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); }
    c.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
}
const answer = (text: string, delayMs = 0) => sse([{ type: "response.output_text.delta", delta: text }, usageEvent], delayMs);
const copilotJson = (data: Record<string, unknown>) => Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(data), annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 5 } });
const isCopilot = (init?: RequestInit) => typeof init?.body === "string" && init.body.includes("helix_copilot");

function setup(fetcher: (url: string, init?: RequestInit) => Promise<Response>, options: DirectConversationOptions = {}) {
  const usage: UsageRecord[] = [], metas: AnswerMeta[] = [];
  const transport = new DirectConversationTransport({ fetch: fetcher, onUsage: u => usage.push(u), onAnswerMeta: m => metas.push(m), ...options });
  const events: GatewayEvent[] = [];
  const client = new HelixConversationClient(transport, { vad: false, noteSink: new InMemoryNoteSink(), autoSaveSuggestedNotes: true });
  client.subscribe(event => { expect(isGatewayEvent(event)).toBe(true); events.push(event); });
  return { transport, client, events, usage, metas };
}
function copilotCallbacks(overrides: Partial<CopilotCallbacks> = {}, settings = {}): CopilotCallbacks {
  return { enabled: () => true, settings: () => ({ ...DEFAULT_COPILOT_SETTINGS, ...settings }), ...overrides };
}

describe("v0.7 direct transport", () => {
  it("reports measured usage, monotonic AnswerTiming and preserves legacy latency semantics for a spoken question", async () => {
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("transcriptions")) { await new Promise(r => setTimeout(r, 15)); return Response.json({ text: "What is our launch plan?" }); }
      return answer("Ship Friday.", 10);
    });
    const { client, events, usage, metas } = setup(fetcher);
    await client.start(config, { openai: "k" });
    await client.sendAudio(new Int16Array(16000).fill(4000)); await client.commitAudio();
    await vi.waitFor(() => expect(metas).toHaveLength(1));
    const form = fetcher.mock.calls[0]![1]!.body as FormData;
    expect(form.get("model")).toBe("gpt-transcribe"); expect(form.get("language")).toBeNull();
    const t = metas[0]!.timing;
    expect(t.speechMs).toBe(1000); expect(t.transcriptionMs).toBeGreaterThanOrEqual(10);
    expect(t.queueMs).toBeGreaterThanOrEqual(0); expect(t.firstTokenMs).toBeGreaterThanOrEqual(0);
    expect(t.generationMs).toBeGreaterThanOrEqual(t.firstTokenMs!); expect(t.endToEndMs).toBeGreaterThanOrEqual(t.generationMs);
    expect(t.endToEndMs).toBeGreaterThanOrEqual(t.transcriptionMs! + t.queueMs);
    expect(metas[0]).toMatchObject({ grounded: "conversation", sources: [], retrieval: { searchedEntries: 0, matched: 0, webUsed: false } });
    expect(metas[0]!.usage).toMatchObject({ kind: "answer", model: "gpt-6.1-terra", inputTokens: 1000, outputTokens: 200, measured: true, costUsd: 0.002 });
    expect(usage.find(u => u.kind === "transcription")).toMatchObject({ model: "gpt-transcribe", audioSeconds: 1, measured: true });
    const completed = events.find(e => e.type === "answer.completed")!;
    expect(completed.type === "answer.completed" && completed.context.latencyMs.totalMs).toBeGreaterThanOrEqual(0);
    const request = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
    expect(request).toMatchObject({ reasoning: { effort: "none" } }); expect(request.max_output_tokens).toBeGreaterThanOrEqual(2000);
    await client.dispose();
  });
  it("measures queueMs from manual submit, not from audio", async () => {
    const fetcher = vi.fn(async () => answer("A."));
    const { client, metas } = setup(fetcher);
    await client.start(config, { openai: "k" }); await client.ask("Hello?");
    await vi.waitFor(() => expect(metas).toHaveLength(1));
    expect(metas[0]!.timing.speechMs).toBe(0); expect(metas[0]!.timing.transcriptionMs).toBeUndefined();
    expect(metas[0]!.timing.endToEndMs).toBeGreaterThanOrEqual(metas[0]!.timing.generationMs);
    await client.dispose();
  });
  it("grounds a time-sensitive question on the web, strips markers and reports sources", async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (isCopilot(init)) return copilotJson({});
      return sse([
        { type: "response.output_text.delta", delta: "Jetson Orin lead time is about 12 weeks. cite" },
        { type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://example.com/jetson", title: "Distributor" } },
        { type: "response.completed", response: { status: "completed", output: [{ type: "web_search_call", id: "w" }], usage: { input_tokens: 100, output_tokens: 20 } } },
      ]);
    });
    const { client, events, metas } = setup(fetcher, { copilot: copilotCallbacks({ enabled: () => false }) });
    await client.start(config, { openai: "k" }); await client.ask("What is the current Jetson Orin lead time?");
    await vi.waitFor(() => expect(metas).toHaveLength(1));
    const request = JSON.parse(fetcher.mock.calls.find(c => !isCopilot(c[1]))![1]!.body as string);
    expect(request.tools).toEqual([{ type: "web_search" }]); expect(request.instructions).toMatch(/web search/i);
    const completed = events.find(e => e.type === "answer.completed");
    expect(completed?.type === "answer.completed" && completed.text).toBe("Jetson Orin lead time is about 12 weeks.");
    expect(metas[0]).toMatchObject({ grounded: "web", sources: [{ url: "https://example.com/jetson", title: "Distributor" }], retrieval: { webUsed: true } });
    expect(metas[0]!.usage).toMatchObject({ webSearchCalls: 1 });
    expect(metas[0]!.usage!.costUsd).toBeCloseTo((100 * 1 + 20 * 5) / 1e6 + 0.01, 10);
    await client.dispose();
  });
  it("does not use web search when webGrounding is off or the question is not time-sensitive", async () => {
    for (const [settings, question] of [[{ webGrounding: false }, "What is the current Jetson lead time?"], [{}, "Who owns delivery?"]] as const) {
      const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => answer("A."));
      const { client, metas } = setup(fetcher, { copilot: copilotCallbacks({ enabled: () => false }, settings) });
      await client.start(config, { openai: "k" }); await client.ask(question);
      await vi.waitFor(() => expect(metas).toHaveLength(1));
      expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).tools).toBeUndefined();
      await client.dispose();
    }
  });
  it("passes retrieval diagnostics, allows prior answers as memory and asks for [M1] citations", async () => {
    const old = (id: string, kind: "transcript" | "answer", text: string): RetrievedMemory => ({ entry: { id, sessionId: "old", kind, text, occurredAt: "2026-09-01T00:00:00Z" }, session: { id: "old", source: "helix", title: "Old", startedAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" }, score: 1 });
    const retrieveMemoryWithStats = vi.fn(() => ({ items: [old("a", "transcript", "Jetsons have long lead times."), old("b", "answer", "About 12 weeks.")], searchedEntries: 40, matched: 2 }));
    const fetcher = vi.fn(async () => answer("About 12 weeks [M1]."));
    const { client, metas } = setup(fetcher, { retrieveMemoryWithStats });
    await client.start(config, { openai: "k" }); await client.ask("Jetson lead time?");
    await vi.waitFor(() => expect(metas).toHaveLength(1));
    const instructions = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).instructions as string;
    expect(instructions).toContain("[M1]"); expect(instructions).toContain('"kind":"answer"');
    expect(metas[0]).toMatchObject({ grounded: "memory", retrieval: { searchedEntries: 40, matched: 2, webUsed: false } });
    await client.dispose();
  });
  it("injectTranscript runs the post-transcription path without STT: transcript.final, auto answer, copilot submit", async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("transcriptions")) throw new Error("STT must not be called");
      if (isCopilot(init)) return copilotJson({ summary: { bullets: ["Discussed CDTF."], keyFacts: [] }, concepts: [{ term: "CDTF", explanation: "A fixture format." }], conflicts: [], suggestedQuestions: [], asks: [] });
      return answer("CDTF is our test fixture format.");
    });
    const onConcept = vi.fn(), insightResult = vi.fn();
    const { transport, client, events, metas } = setup(fetcher, { copilot: copilotCallbacks({ onConcept }), insights: { enabled: () => true, onResult: insightResult } });
    await client.start(config, { openai: "k" });
    await transport.injectTranscript("We rely on CDTF here. What is CDTF used for?", { label: "Interviewer", role: "other" });
    await vi.waitFor(() => expect(events.some(e => e.type === "answer.completed")).toBe(true));
    await vi.waitFor(() => expect(onConcept).toHaveBeenCalledWith(expect.objectContaining({ term: "CDTF" })));
    const final = events.find(e => e.type === "transcript.final");
    expect(final?.type === "transcript.final" && final.context.speaker.label).toBe("Interviewer");
    expect(events.find(e => e.type === "question.detected")).toMatchObject({ text: "What is CDTF used for?" });
    expect(fetcher.mock.calls.every(c => !c[0].endsWith("transcriptions"))).toBe(true);
    // Copilot concepts replace the insight lane: no insight request was sent.
    expect(fetcher.mock.calls.filter(c => String(c[1]?.body).includes("strict JSON"))).toHaveLength(0);
    await vi.waitFor(() => expect(metas).toHaveLength(1)); expect(metas[0]!.timing.speechMs).toBe(0);
    await client.dispose();
  });
  it("injected transcripts are serialized through the same queue in order", async () => {
    const fetcher = vi.fn(async () => answer("A."));
    const { transport, client, events } = setup(fetcher);
    await client.start({ ...config, automation: { detectQuestions: false, answerQuestions: false, saveNotes: false } }, { openai: "k" });
    await Promise.all(["One.", "Two.", "Three."].map(t => transport.injectTranscript(t, { label: "A", role: "other" })));
    expect(events.filter(e => e.type === "transcript.final").map(e => e.type === "transcript.final" && e.text)).toEqual(["One.", "Two.", "Three."]);
    expect(fetcher).not.toHaveBeenCalled();
    await client.dispose();
  });
  it("verify() emits a VerificationResult and runCopilotNow bypasses cooldown; disconnect cancels copilot", async () => {
    const verifications: VerificationResult[] = [];
    let copilotSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      if (body.tool_choice === "required") return Response.json({ status: "completed", output: [{ type: "web_search_call", status: "completed" }, { type: "message", content: [{ type: "output_text", text: JSON.stringify({ status: "contradicted", summary: "It was 1969." }), annotations: [{ type: "url_citation", url: "https://nasa.gov/", title: "NASA", start_index: 0, end_index: 3 }] }] }] });
      if (isCopilot(init)) { copilotSignal = init!.signal as AbortSignal; return new Promise<Response>(() => undefined); }
      return answer("A.");
    });
    const { transport, client, usage } = setup(fetcher, { copilot: copilotCallbacks({ onVerification: v => verifications.push(v) }) });
    await client.start({ ...config, automation: { detectQuestions: false, answerQuestions: false, saveNotes: false } }, { openai: "k" });
    transport.verify("The moon landing was in 1970.", "claim-1");
    await vi.waitFor(() => expect(verifications).toHaveLength(1));
    expect(verifications[0]).toMatchObject({ id: "claim-1", status: "contradicted", requestedBy: "user", sources: [{ url: "https://nasa.gov/", title: "NASA" }] });
    expect(usage.some(u => u.kind === "verify")).toBe(true);
    await transport.injectTranscript("Some statement.", { label: "A", role: "other" });
    transport.runCopilotNow();
    await vi.waitFor(() => expect(copilotSignal).toBeDefined());
    await client.dispose(); expect(copilotSignal!.aborted).toBe(true);
  });
  it("copilot asks never become glasses answers", async () => {
    const asks: string[] = [];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      if (isCopilot(init)) return copilotJson({ summary: { bullets: [], keyFacts: [] }, concepts: [], conflicts: [], suggestedQuestions: [], asks: [{ kind: "propose", topic: "evaluate an architecture for 16GB RAM + 1TB SSD", trigger: "the architecture is 16 GB RAM with a 1 TB SSD" }] });
      return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Use the SSD for swap.", annotations: [] }] }] });
    });
    const { transport, client, events } = setup(fetcher, { copilot: copilotCallbacks({ onAsk: a => asks.push(a.status) }) });
    await client.start({ ...config, responseStrategy: "reactive" }, { openai: "k" });
    await transport.injectTranscript("So the architecture is 16 GB RAM with a 1 TB SSD.", { label: "A", role: "other" });
    await vi.waitFor(() => expect(asks).toEqual(["pending", "done"]));
    expect(events.some(e => e.type === "answer.delta" || e.type === "answer.completed")).toBe(false);
    await client.dispose();
  });
});

import { answerableQuestion } from "../src/direct-transport.js";
describe("answerableQuestion (live STT fragments)", () => {
  it("skips fragments but keeps real short questions", () => {
    for (const q of ["Where?", "How is this convergence of?", "So the?"]) expect(answerableQuestion(q)).toBe(false);
    for (const q of ["What is CDTF used for?", "Why is open?", "Can I use it for industries?", "这个怎么用？"]) expect(answerableQuestion(q)).toBe(true);
  });
});
