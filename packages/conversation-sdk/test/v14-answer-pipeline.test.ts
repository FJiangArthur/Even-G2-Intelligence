import { describe, expect, it, vi } from "vitest";
import { DirectConversationTransport, type DirectConversationOptions } from "../src/direct-transport.js";
import { HelixConversationClient } from "../src/client.js";
import { answerDirect, DirectProviderError } from "../src/direct-providers.js";
import { answerProviderInfo } from "../src/provider-registry.js";
import { ANSWER_KEY_PREFIX, OTHER_SPEAKER, SELF_SPEAKER, type ConversationMode, type GatewayEvent, type SessionConfig, type Speaker } from "../src/index.js";
import type { RetrievedMemory } from "../src/local-history.js";

const config: SessionConfig = {
  sessionId: "v14", endpoint: { id: "openai-direct", url: "https://api.openai.com/v1/responses", provider: "openai", model: "gpt-6.1-terra" },
  prompt: { id: "p", version: "1", system: "Be brief.", maxResponseSentences: 3 },
  providers: { transcriptionProvider: "openai-transcribe", answerProvider: "openai-responses" },
  speaker: { label: "G2 conversation", role: "unknown" }, mode: "general", responseStrategy: "reactive", locale: "en-US",
  automation: { detectQuestions: true, answerQuestions: true, saveNotes: false }, memory: { readOmiContext: false, syncNotes: false },
};
const UNKNOWN: Speaker = { label: "G2 conversation", role: "unknown" };
const completedEvent = { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 5 } } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const settle = (ms = 40) => sleep(ms);
/** SSE body; strings are sent as raw `data:` payloads (malformed events), objects as JSON. */
function sse(events: unknown[], delayMs = 0, signal?: AbortSignal | null) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({ async start(c) {
    try {
      for (const event of events) {
        if (delayMs) await sleep(delayMs);
        if (signal?.aborted) { c.error(new DOMException("aborted", "AbortError")); return; }
        c.enqueue(encoder.encode(`data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`));
      }
      c.close();
    } catch { /* stream cancelled */ }
  } }), { headers: { "Content-Type": "text/event-stream" } });
}
const answer = (text: string, delayMs = 0, signal?: AbortSignal | null) => sse([{ type: "response.output_text.delta", delta: text }, completedEvent], delayMs, signal);
const ofType = <T extends GatewayEvent["type"]>(events: GatewayEvent[], type: T) => events.filter((e): e is Extract<GatewayEvent, { type: T }> => e.type === type);
const requestOf = (init?: RequestInit) => { const body = JSON.parse(String(init?.body ?? "{}")); return JSON.stringify(body.input ?? body.messages ?? ""); };
/** The REQUEST part of an answer request (after the quoted transcript context). */
const asked = (request: string) => request.slice(request.lastIndexOf("REQUEST") + "REQUEST".length);
async function collect(iterator: AsyncGenerator<string>) { let result = ""; for await (const delta of iterator) result += delta; return result; }

function setup(fetcher: (url: string, init?: RequestInit) => Promise<Response>, options: DirectConversationOptions = {}, mode?: ConversationMode) {
  const transport = new DirectConversationTransport({ fetch: fetcher, ...(mode ? { mode: () => mode } : {}), ...options });
  const client = new HelixConversationClient(transport);
  const events: GatewayEvent[] = [];
  client.subscribe(event => events.push(event));
  return { transport, client, events };
}
/** A provider that answers each request with the question it was asked, tracking overlap. */
function echoProvider(delayMs = 0) {
  const state = { active: 0, maxActive: 0, requests: [] as string[] };
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    const request = requestOf(init); state.requests.push(request);
    state.active++; state.maxActive = Math.max(state.maxActive, state.active);
    const index = state.requests.length;
    const encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({ async start(c) {
      try {
        if (delayMs) await sleep(delayMs);
        if (!init?.signal?.aborted) {
          c.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: `Answer ${index}.` })}\n\ndata: ${JSON.stringify(completedEvent)}\n\n`));
          c.close();
        } else c.error(new DOMException("aborted", "AbortError"));
      } catch { /* cancelled */ } finally { state.active--; }
    } }), { headers: { "Content-Type": "text/event-stream" } });
  });
  return { fetcher, state };
}

describe("v0.14 serial answer queue", () => {
  it("answers every question in one transcript line, one at a time and in order", async () => {
    const { fetcher, state } = echoProvider(15);
    const h = setup(fetcher);
    await h.client.start(config, { openai: "k" });
    await h.transport.injectTranscript("What is the budget for the pilot? Who owns the launch date? When does the trial start?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(3));
    const detected = ofType(h.events, "question.detected").map(e => e.questionId);
    expect(ofType(h.events, "answer.completed").map(e => e.questionId)).toEqual(detected);
    expect(state.maxActive).toBe(1);
    expect(state.requests.map(asked).map(request => /(budget|launch date|trial start)/u.exec(request)?.[1])).toEqual(["budget", "launch date", "trial start"]);
    expect(ofType(h.events, "error")).toHaveLength(0);
    await h.client.dispose();
  });
  it("does not cancel the interviewer's answer key when the candidate asks the next question", async () => {
    const { fetcher, state } = echoProvider(25);
    const h = setup(fetcher, {}, "interviewer");
    await h.client.start(config, { openai: "k" });
    await h.transport.injectTranscript("How did you scale the ingestion pipeline to ten billion events?", SELF_SPEAKER);
    await h.transport.injectTranscript("What does the on-call rotation look like for this team?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(2));
    expect(asked(state.requests[0]!)).toContain(ANSWER_KEY_PREFIX);
    expect(asked(state.requests[1]!)).not.toContain(ANSWER_KEY_PREFIX);
    expect(asked(state.requests[1]!)).toContain("on-call rotation");
    expect(ofType(h.events, "answer.completed").map(e => e.text)).toEqual(["Answer 1.", "Answer 2."]);
    await h.client.dispose();
  });
  it("lets a manual ask pre-empt the running answer and queues questions heard while it runs", async () => {
    const { fetcher, state } = echoProvider(30);
    const h = setup(fetcher);
    await h.client.start(config, { openai: "k" });
    await h.transport.injectTranscript("What is the budget for the pilot?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(state.requests).toHaveLength(1));
    await h.client.ask("Summarise the risks so far.");
    await vi.waitFor(() => expect(state.requests).toHaveLength(2));
    await h.transport.injectTranscript("Who owns the launch date?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(2));
    // The pre-empted automatic answer never completes; the manual one and the queued one do, in that order.
    expect(ofType(h.events, "answer.completed").map(e => e.text)).toEqual(["Answer 2.", "Answer 3."]);
    expect(ofType(h.events, "answer.completed")[0]!.context.trigger).toBe("manual");
    expect(asked(state.requests[2]!)).toContain("Who owns the launch date");
    expect(ofType(h.events, "error")).toHaveLength(0);
    await h.client.dispose();
  });
  it("keeps at most three waiting questions, dropping the oldest without an error", async () => {
    const { fetcher, state } = echoProvider(40);
    const h = setup(fetcher);
    await h.client.start(config, { openai: "k" });
    const lines = ["What is the budget for the pilot?", "Who owns the launch date?", "When does the trial start?", "Where is the test site located?", "Which vendor supplies the sensors?"];
    for (const line of lines) await h.transport.injectTranscript(line, OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(4));
    await settle(80);
    expect(state.requests).toHaveLength(4);
    expect(state.requests.map(asked).map(request => /(budget|launch date|trial start|test site|vendor)/u.exec(request)?.[1])).toEqual(["budget", "trial start", "test site", "vendor"]);
    expect(ofType(h.events, "question.detected")).toHaveLength(5);
    expect(ofType(h.events, "error")).toHaveLength(0);
    await h.client.dispose();
  });
  it("drops a waiting question that became stale before its turn", async () => {
    const { fetcher, state } = echoProvider(60);
    const h = setup(fetcher, { answerQueue: { maxAgeMs: 20 } });
    await h.client.start(config, { openai: "k" });
    await h.transport.injectTranscript("What is the budget for the pilot?", OTHER_SPEAKER);
    await h.transport.injectTranscript("Who owns the launch date?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    await settle(60);
    expect(state.requests).toHaveLength(1);
    expect(ofType(h.events, "error")).toHaveLength(0);
    // A dropped question may be asked again and is then answered.
    await h.transport.injectTranscript("Who owns the launch date?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(2));
    await h.client.dispose();
  });
  it("never reports conversation-busy because answers are queued; a real backlog is a non-fatal notice", async () => {
    const { fetcher } = echoProvider(30);
    const h = setup(fetcher);
    await h.client.start(config, { openai: "k" });
    for (let i = 0; i < 12; i++) await h.transport.injectTranscript(`What is the status of work package number ${i}?`, OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed").length).toBeGreaterThanOrEqual(4));
    expect(ofType(h.events, "error")).toHaveLength(0);
    await h.client.dispose();

    // Transcription backlog (the pending cap of 4): one non-fatal, retryable notice, not an error per dropped turn.
    const slow = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("transcriptions")) { await sleep(50); return Response.json({ text: "The pilot is on track." }); }
      return answer("ok");
    });
    const b = setup(slow);
    await b.client.start(config, { openai: "k" });
    for (let i = 0; i < 8; i++) { await b.client.sendAudio(new Int16Array(3200).fill(4000)); await b.client.commitAudio(); }
    const busy = ofType(b.events, "error");
    expect(busy).toHaveLength(1);
    expect(busy[0]).toMatchObject({ code: "conversation-busy", fatal: false, retryable: true });
    await b.client.dispose();
  });
});

describe("v0.14 cross-turn question dedupe", () => {
  it("does not answer the same question again within the window, and answers it again afterwards", async () => {
    const { fetcher, state } = echoProvider();
    const h = setup(fetcher, { answerQueue: { dedupeMs: 80 } });
    await h.client.start(config, { openai: "k" });
    await h.transport.injectTranscript("What is the budget for the pilot?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    await h.transport.injectTranscript("So, what is the budget for the pilot", OTHER_SPEAKER);
    await settle();
    expect(state.requests).toHaveLength(1);
    expect(ofType(h.events, "question.detected")).toHaveLength(1);
    await sleep(90);
    await h.transport.injectTranscript("What is the budget for the pilot?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(2));
    await h.client.dispose();
  });
  it("answers a repeated question when the first attempt failed", async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => ++calls === 1 ? new Response("{}", { status: 400 }) : answer("Forty thousand."));
    const h = setup(fetcher);
    await h.client.start(config, { openai: "k" });
    await h.transport.injectTranscript("What is the budget for the pilot?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "error")).toHaveLength(1));
    await h.transport.injectTranscript("What is the budget for the pilot?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    await h.client.dispose();
  });
});

describe("v0.14 unknown speaker in Interviewer mode", () => {
  it("gives a neutral direct answer, never an answer key, when the speaker role is unknown", async () => {
    const { fetcher, state } = echoProvider();
    const h = setup(fetcher, {}, "interviewer");
    await h.client.start(config, { openai: "k" });
    await h.transport.injectTranscript("How would you design a rate limiter for a public API?", UNKNOWN);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    expect(state.requests[0]).not.toContain(ANSWER_KEY_PREFIX);
    expect(state.requests[0]).toContain("design a rate limiter");
    expect(state.requests[0]).toMatch(/not known who asked/u);
    await h.client.dispose();
    // Outside Interviewer mode an unknown speaker's question is sent as it is.
    const plain = echoProvider();
    const g = setup(plain.fetcher);
    await g.client.start(config, { openai: "k" });
    await g.transport.injectTranscript("How would you design a rate limiter for a public API?", UNKNOWN);
    await vi.waitFor(() => expect(ofType(g.events, "answer.completed")).toHaveLength(1));
    expect(plain.state.requests[0]).not.toMatch(/not known who asked/u);
    await g.client.dispose();
  });
});

describe("v0.14 one retry before the first token", () => {
  it("retries once after a network error and after HTTP 503 / 429, without an error event", async () => {
    for (const first of [() => { throw new TypeError("Failed to fetch"); }, () => new Response("{}", { status: 503 }), () => new Response("{}", { status: 429 })]) {
      let calls = 0;
      const fetcher = vi.fn(async () => ++calls === 1 ? first() : answer("Recovered."));
      const h = setup(fetcher, { retryDelayMs: 5 });
      await h.client.start(config, { openai: "k" });
      await h.transport.injectTranscript("What is the budget for the pilot?", OTHER_SPEAKER);
      await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
      expect(calls).toBe(2);
      expect(ofType(h.events, "error")).toHaveLength(0);
      expect(ofType(h.events, "answer.delta")).toHaveLength(1);
      await h.client.dispose();
    }
  });
  it("retries only once", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 503 }));
    const h = setup(fetcher, { retryDelayMs: 5 });
    await h.client.start(config, { openai: "k" });
    await h.transport.injectTranscript("What is the budget for the pilot?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "error")).toHaveLength(1));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(ofType(h.events, "error")[0]).toMatchObject({ code: "provider-response", fatal: false });
    await h.client.dispose();
  });
  it("never retries an authentication failure", async () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 401 }));
    const h = setup(fetcher, { retryDelayMs: 5 });
    await h.client.start(config, { openai: "k" });
    await h.transport.injectTranscript("What is the budget for the pilot?", OTHER_SPEAKER).catch(() => undefined);
    await vi.waitFor(() => expect(ofType(h.events, "error")).toHaveLength(1));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(ofType(h.events, "error")[0]).toMatchObject({ code: "provider-authentication", fatal: true });
    await h.client.dispose().catch(() => undefined);
  });
  it("never retries after text was emitted, so deltas are not duplicated", async () => {
    const encoder = new TextEncoder();
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ async start(c) {
      c.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Forty " })}\n\n`));
      await sleep(5); c.error(new TypeError("network lost"));
    } }), { headers: { "Content-Type": "text/event-stream" } }));
    const h = setup(fetcher, { retryDelayMs: 5 });
    await h.client.start(config, { openai: "k" });
    await h.transport.injectTranscript("What is the budget for the pilot?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "error")).toHaveLength(1));
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(ofType(h.events, "answer.delta")).toHaveLength(1);
    await h.client.dispose();
  });
  it("gives up when no first token arrives in time, and the next question is still answered", async () => {
    let calls = 0;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => ++calls === 1 ? answer("Too late.", 200, init?.signal) : answer("On time."));
    const h = setup(fetcher, { firstTokenTimeoutMs: 30 });
    await h.client.start(config, { openai: "k" });
    await h.transport.injectTranscript("What is the budget for the pilot?", OTHER_SPEAKER);
    await h.transport.injectTranscript("Who owns the launch date?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    expect(ofType(h.events, "error")).toHaveLength(1);
    expect(ofType(h.events, "error")[0]).toMatchObject({ code: "provider-timeout", fatal: false, retryable: true });
    expect(ofType(h.events, "answer.completed")[0]!.text).toBe("On time.");
    expect(calls).toBe(2);
    await h.client.dispose();
  });
});

describe("v0.14 guarded stream parsing", () => {
  const signal = () => new AbortController().signal;
  const user = [{ role: "user", content: "Hello" }];
  it("skips a single malformed SSE event (Responses and Chat Completions)", async () => {
    const responses = vi.fn(async () => sse([{ type: "response.output_text.delta", delta: "Forty " }, "{not json", "null", { type: "response.output_text.delta", delta: "thousand." }, completedEvent]));
    expect(await collect(answerDirect(responses, "k", "openai-responses", "gpt-6.1-terra", "Be brief.", user, signal()))).toBe("Forty thousand.");
    const chat = vi.fn(async () => sse([{ choices: [{ delta: { content: "Forty " } }] }, "{not json", { choices: [{ delta: { content: "thousand." }, finish_reason: "stop" }] }, "[DONE]"]));
    expect(await collect(answerDirect(chat, "k", "deepseek", "deepseek-flash", "Be brief.", user, signal(), { provider: answerProviderInfo("deepseek")! }))).toBe("Forty thousand.");
  });
  it("reports an unusable stream as a provider-response error, not a network error", async () => {
    for (const provider of [undefined, answerProviderInfo("deepseek")!]) {
      const fetcher = vi.fn(async () => sse(["<html>bad gateway</html>", "{oops", "[DONE]"]));
      const error = await collect(answerDirect(fetcher, "k", provider ? "deepseek" : "openai-responses", provider ? "deepseek-flash" : "gpt-6.1-terra", "Be brief.", user, signal(), provider ? { provider } : {})).catch(e => e);
      expect(error).toBeInstanceOf(DirectProviderError);
      expect((error as DirectProviderError).code).toBe("provider-response");
      expect((error as DirectProviderError).message).toMatch(/unreadable/u);
    }
    const fetcher = vi.fn(async () => sse(["{oops", "{oops again"]));
    const h = setup(fetcher);
    await h.client.start(config, { openai: "k" });
    await h.transport.injectTranscript("What is the budget for the pilot?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "error")).toHaveLength(1));
    expect(ofType(h.events, "error")[0]!.code).toBe("provider-response");
    expect(ofType(h.events, "error")[0]!.message).not.toMatch(/connection/iu);
    await h.client.dispose();
  });
});

describe("v0.14 cut-off answers", () => {
  const incomplete = { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 10, output_tokens: 600 } } };
  it("completes with partial: true and the text so far when the provider stops at the length limit", async () => {
    const fetcher = vi.fn(async () => sse([{ type: "response.output_text.delta", delta: "The budget is forty thousand and the" }, incomplete]));
    const h = setup(fetcher);
    await h.client.start(config, { openai: "k" });
    await h.transport.injectTranscript("What is the budget for the pilot?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    expect(ofType(h.events, "answer.completed")[0]).toMatchObject({ partial: true, text: "The budget is forty thousand and the" });
    expect(ofType(h.events, "error")).toHaveLength(0);
    await h.client.dispose();
  });
  it("marks a Chat Completions answer cut at finish_reason length as partial", async () => {
    const fetcher = vi.fn(async () => sse([{ choices: [{ delta: { content: "The budget is" } }] }, { choices: [{ delta: { content: " forty" }, finish_reason: "length" }] }, "[DONE]"]));
    const h = setup(fetcher);
    await h.client.start({ ...config, providers: { transcriptionProvider: "deepgram", answerProvider: "deepseek" } }, { deepseek: "k", deepgram: "d" });
    await h.transport.injectTranscript("What is the budget for the pilot?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    expect(ofType(h.events, "answer.completed")[0]).toMatchObject({ partial: true, text: "The budget is forty" });
    await h.client.dispose();
  });
  it("omits `partial` on a complete answer and still fails when nothing arrived before the cut", async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => ++calls === 1 ? answer("Forty thousand.") : sse([incomplete]));
    const h = setup(fetcher);
    await h.client.start(config, { openai: "k" });
    await h.transport.injectTranscript("What is the budget for the pilot?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    expect("partial" in ofType(h.events, "answer.completed")[0]!).toBe(false);
    await h.transport.injectTranscript("Who owns the launch date?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "error")).toHaveLength(1));
    expect(ofType(h.events, "error")[0]).toMatchObject({ code: "provider-response", fatal: false });
    await h.client.dispose();
  });
  it("keeps a partial manual answer out of the follow-up history", async () => {
    const bodies: string[] = [];
    let calls = 0;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(requestOf(init));
      return ++calls === 1 ? sse([{ type: "response.output_text.delta", delta: "CUTOFFTEXT and the" }, incomplete]) : answer("WHOLEANSWER.");
    });
    const h = setup(fetcher);
    await h.client.start(config, { openai: "k" });
    await h.client.ask("Summarise the risks so far.");
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    await h.client.ask("And the owners?");
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(2));
    await h.client.ask("And the dates?");
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(3));
    expect(bodies[1]).not.toContain("CUTOFFTEXT");
    expect(bodies[2]).toContain("WHOLEANSWER"); expect(bodies[2]).not.toContain("CUTOFFTEXT");
    await h.client.dispose();
  });
});

describe("v0.14 knowledge search query", () => {
  it("searches saved knowledge with the bare question, not the answer-key wrapper", async () => {
    const queries: string[] = [];
    const { fetcher } = echoProvider();
    const retrieveMemory = (query: string): RetrievedMemory[] => { queries.push(query); return []; };
    const h = setup(fetcher, { retrieveMemory }, "interviewer");
    await h.client.start(config, { openai: "k" });
    await h.transport.injectTranscript("How did you scale the ingestion pipeline to ten billion events?", SELF_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    await h.transport.injectTranscript("How would you design a rate limiter for a public API?", UNKNOWN);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(2));
    expect(queries).toHaveLength(2);
    expect(queries[0]!.startsWith("How did you scale the ingestion pipeline to ten billion events?")).toBe(true);
    expect(queries[1]!.startsWith("How would you design a rate limiter for a public API?")).toBe(true);
    for (const query of queries) { expect(query).not.toContain("ANSWER KEY"); expect(query).not.toMatch(/not known who asked/u); }
    await h.client.dispose();
  });
  it("sends the bare question to the OpenAI knowledge base", async () => {
    const searches: string[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/vector_stores/")) { searches.push(String(init?.body ?? "")); return Response.json({ data: [] }); }
      return answer("Key.");
    });
    const h = setup(fetcher, { openaiKnowledge: () => ({ vectorStoreId: "vs_1" }) }, "interviewer");
    await h.client.start(config, { openai: "k" });
    await h.transport.injectTranscript("How did you scale the ingestion pipeline to ten billion events?", SELF_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    expect(searches).toHaveLength(1);
    expect(searches[0]).toContain("ingestion pipeline"); expect(searches[0]).not.toContain("ANSWER KEY");
    await h.client.dispose();
  });
});
