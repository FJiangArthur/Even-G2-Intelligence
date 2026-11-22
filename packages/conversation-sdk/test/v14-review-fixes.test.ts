import { describe, expect, it, vi } from "vitest";
import { DirectConversationTransport, type DirectConversationOptions } from "../src/direct-transport.js";
import { HelixConversationClient } from "../src/client.js";
import { answerDirect, DirectProviderError } from "../src/direct-providers.js";
import { answerProviderInfo } from "../src/provider-registry.js";
import { extractQuestions, isGenericFollowUp, isRhetoricalQuestion, RecentQuestions } from "../src/questions.js";
import { OTHER_SPEAKER, type GatewayEvent, type SessionConfig } from "../src/index.js";

const config: SessionConfig = {
  sessionId: "v14-review", endpoint: { id: "openai-direct", url: "https://api.openai.com/v1/responses", provider: "openai", model: "gpt-6.1-terra" },
  prompt: { id: "p", version: "1", system: "Be brief.", maxResponseSentences: 3 },
  providers: { transcriptionProvider: "openai-transcribe", answerProvider: "openai-responses" },
  speaker: { label: "G2 conversation", role: "unknown" }, mode: "general", responseStrategy: "reactive", locale: "en-US",
  automation: { detectQuestions: true, answerQuestions: true, saveNotes: true }, memory: { readOmiContext: false, syncNotes: false },
};
const deepseek = { ...config, providers: { transcriptionProvider: "deepgram", answerProvider: "deepseek" } };
const completedEvent = { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 5 } } };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function sse(events: unknown[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({ start(c) {
    for (const event of events) c.enqueue(encoder.encode(`data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`));
    c.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
}
const ofType = <T extends GatewayEvent["type"]>(events: GatewayEvent[], type: T) => events.filter((e): e is Extract<GatewayEvent, { type: T }> => e.type === type);
const requestOf = (init?: RequestInit) => { const body = JSON.parse(String(init?.body ?? "{}")); return JSON.stringify(body.input ?? body.messages ?? ""); };
const asked = (request: string) => request.slice(request.lastIndexOf("REQUEST") + "REQUEST".length);
async function collect(iterator: AsyncGenerator<string>) { let result = ""; for await (const delta of iterator) result += delta; return result; }
function setup(fetcher: (url: string, init?: RequestInit) => Promise<Response>, options: DirectConversationOptions = {}) {
  const transport = new DirectConversationTransport({ fetch: fetcher, ...options });
  const client = new HelixConversationClient(transport);
  const events: GatewayEvent[] = [];
  client.subscribe(event => events.push(event));
  return { transport, client, events };
}
/** Answers each request with "Answer N." after `delayMs`; an aborted request never completes. */
function echoProvider(delayMs = 0) {
  const state = { requests: [] as string[] };
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    state.requests.push(requestOf(init));
    const index = state.requests.length, encoder = new TextEncoder();
    return new Response(new ReadableStream<Uint8Array>({ async start(c) {
      try {
        if (delayMs) await sleep(delayMs);
        if (init?.signal?.aborted) { c.error(new DOMException("aborted", "AbortError")); return; }
        c.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: `Answer ${index}.` })}\n\ndata: ${JSON.stringify(completedEvent)}\n\n`));
        c.close();
      } catch { /* cancelled */ }
    } }), { headers: { "Content-Type": "text/event-stream" } });
  });
  return { fetcher, state };
}
const BUDGET = "What is the budget for the pilot?";

describe("review 2: a question that is queued or in flight is a duplicate at any age", () => {
  it("RecentQuestions: pending never expires; the window counts from completion", () => {
    const recent = new RecentQuestions(1000), job = {};
    recent.begin(BUDGET, job, 0);
    expect(recent.has(BUDGET, 60_000)).toBe(true);
    recent.settle(BUDGET, job, 60_000);
    expect(recent.has(BUDGET, 60_900)).toBe(true);
    expect(recent.has(BUDGET, 61_001)).toBe(false);
  });
  it("does not queue a second answer when the repeat arrives after the window but before the answer ends", async () => {
    const { fetcher, state } = echoProvider(250);
    const h = setup(fetcher, { answerQueue: { dedupeMs: 120 } });
    await h.client.start(config, { openai: "k" });
    await h.transport.injectTranscript(BUDGET, OTHER_SPEAKER);
    await sleep(180); // older than the window, still streaming
    await h.transport.injectTranscript(BUDGET, OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    await sleep(50); // 300 ms after it was asked, 50 ms after it was answered
    await h.transport.injectTranscript(BUDGET, OTHER_SPEAKER);
    await sleep(40);
    expect(state.requests).toHaveLength(1);
    await sleep(150);
    await h.transport.injectTranscript(BUDGET, OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(2));
    await h.client.dispose();
  });
});

describe("review 3: generic follow-ups about a new topic are not duplicates", () => {
  it("recognises short anaphoric or generic follow-ups only", () => {
    for (const text of ["Can you give an example?", "Can you elaborate on that?", "Why is that?", "Could you say more?", "What do you mean?"]) expect(isGenericFollowUp(text), text).toBe(true);
    for (const text of [BUDGET, "Who owns the launch date?", "Can you give an example of a deadlock you debugged in a production system last year?"]) expect(isGenericFollowUp(text), text).toBe(false);
  });
  it("answers the same follow-up again after other speech, but not an immediate repeat or one still in flight", async () => {
    const { fetcher, state } = echoProvider(30);
    const h = setup(fetcher);
    await h.client.start(config, { openai: "k" });
    const followUp = "Can you give an example?";
    await h.transport.injectTranscript("We moved the ingestion pipeline to a queue.", OTHER_SPEAKER);
    await h.transport.injectTranscript(followUp, OTHER_SPEAKER);
    await h.transport.injectTranscript("Sure, and the cache layer was rewritten too.", OTHER_SPEAKER);
    // Still in flight: identical text is a duplicate even with speech in between.
    await h.transport.injectTranscript(followUp, OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    await sleep(40);
    expect(state.requests).toHaveLength(1);
    // Answered, then other speech: the same words now ask about the new topic.
    await h.transport.injectTranscript("Then we rewrote the billing service last spring.", OTHER_SPEAKER);
    await h.transport.injectTranscript(followUp, OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(2));
    expect(ofType(h.events, "question.detected")).toHaveLength(2);
    // Heard twice in a row with nothing in between: a repeat.
    await h.transport.injectTranscript(followUp, OTHER_SPEAKER);
    await sleep(60);
    expect(state.requests).toHaveLength(2);
    await h.client.dispose();
  });
  it("still dedupes a specific question after other speech", async () => {
    const { fetcher, state } = echoProvider();
    const h = setup(fetcher);
    await h.client.start(config, { openai: "k" });
    await h.transport.injectTranscript(BUDGET, OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    await h.transport.injectTranscript("The pilot runs in two regions.", OTHER_SPEAKER);
    await h.transport.injectTranscript(BUDGET, OTHER_SPEAKER);
    await sleep(40);
    expect(state.requests).toHaveLength(1);
    await h.client.dispose();
  });
});

describe("review 4: proactive help never takes a question's place in the queue", () => {
  it("drops a proactive job while an answer runs, so no waiting question is evicted", async () => {
    const { fetcher, state } = echoProvider(40);
    const h = setup(fetcher, { responseStrategy: () => "both" });
    await h.client.start(config, { openai: "k" });
    await h.transport.injectTranscript(BUDGET, OTHER_SPEAKER);
    await h.transport.injectTranscript("Who owns the launch date?", OTHER_SPEAKER);
    await h.transport.injectTranscript("We need to decide on the vendor by Friday.", OTHER_SPEAKER);
    await h.transport.injectTranscript("When does the trial start?", OTHER_SPEAKER);
    await h.transport.injectTranscript("Where is the test site located?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(4));
    await sleep(80);
    expect(state.requests.map(asked).map(request => /(budget|launch date|vendor|trial start|test site)/u.exec(request)?.[1])).toEqual(["budget", "launch date", "trial start", "test site"]);
    expect(ofType(h.events, "answer.completed").map(e => e.context.trigger)).toEqual(["question", "question", "question", "question"]);
    // With nothing running, proactive help still works.
    await h.transport.injectTranscript("We need to decide on the vendor by Friday.", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(5));
    expect(ofType(h.events, "answer.completed")[4]!.context.trigger).toBe("proactive");
    await h.client.dispose();
  });
});

describe("review 5: a pre-empted automatic answer does not wipe the manual ask's dedupe entry", () => {
  it("RecentQuestions: release and settle are no-ops for a job that no longer owns the entry", () => {
    const recent = new RecentQuestions(1000), automatic = {}, manual = {};
    recent.begin(BUDGET, automatic, 0);
    recent.begin(BUDGET, manual, 10);
    expect(recent.owns(BUDGET, automatic)).toBe(false);
    recent.release(BUDGET, automatic);
    expect(recent.has(BUDGET, 20)).toBe(true);
    recent.settle(BUDGET, manual, 30);
    recent.release(BUDGET, automatic);
    expect(recent.has(BUDGET, 40)).toBe(true);
  });
  it("does not answer the question a third time after a manual ask for the same text", async () => {
    const { fetcher, state } = echoProvider(40);
    const h = setup(fetcher);
    await h.client.start(config, { openai: "k" });
    await h.transport.injectTranscript(BUDGET, OTHER_SPEAKER);
    await vi.waitFor(() => expect(state.requests).toHaveLength(1));
    await h.client.ask(BUDGET);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    expect(ofType(h.events, "answer.completed")[0]!.context.trigger).toBe("manual");
    await h.transport.injectTranscript(BUDGET, OTHER_SPEAKER);
    await sleep(80);
    expect(state.requests).toHaveLength(2);
    await h.client.dispose();
  });
});

describe("review 6: instructions and wishes that are not requests for an answer", () => {
  const negatives = [
    "Give me time to think.", "Give us time", "Give me some time.",
    "I want you to give the report to Sam", "I want you to take a look at the doc", "I want to see what happens",
    "I'd like you to show up on time.", "I want to learn Spanish this year.",
  ];
  const positives = [
    "I'd like you to give us an example of a failure.", "I want you to show me how you would debug it.",
    "I'd like to see how you approach code review.", "I want you to tell us about your last role.",
    "I'd like you to take us through the rollout.", "I want to learn more about your team.",
    "Give me a concrete example of a trade-off.", "Share a story about a difficult launch.",
  ];
  it.each(negatives)("ignores: %s", text => { expect(extractQuestions(text)).toEqual([]); });
  it.each(positives)("detects: %s", text => { expect(extractQuestions(text)).toHaveLength(1); });
});

describe("review 7: the self-talk filter leaves genuine short questions alone", () => {
  it.each(["What's the term for that?", "What was the name?", "What else?", "What is the word for it?", "Who knows?", "Really?"])("detects: %s", text => {
    expect(isRhetoricalQuestion(text)).toBe(false);
    expect(extractQuestions(text)).toHaveLength(1);
  });
  it.each(["Where do I even start?", "Hmm, how should I put it?", "What was I saying?", "Where was I?", "You know?", "Right?", "Does that make sense?", "Let me think?"])("ignores: %s", text => {
    expect(extractQuestions(text)).toEqual([]);
  });
  it("ignores self-talk after a statement", () => {
    expect(extractQuestions("Good question. Where do I even start?")).toEqual([]);
  });
});

describe("review 8: a skipped stream event after text started makes the answer partial", () => {
  const signal = () => new AbortController().signal;
  const user = [{ role: "user", content: "Hello" }];
  const gapResponses = () => sse([{ type: "response.output_text.delta", delta: "GAPTEXT forty " }, "{not json", { type: "response.output_text.delta", delta: "thousand." }, completedEvent]);
  it("reports the gap through onIncomplete (Responses and Chat Completions), and not for a skip before any text", async () => {
    const onIncomplete = vi.fn();
    expect(await collect(answerDirect(vi.fn(async () => gapResponses()), "k", "openai-responses", "gpt-6.1-terra", "Be brief.", user, signal(), { onIncomplete }))).toBe("GAPTEXT forty thousand.");
    expect(onIncomplete).toHaveBeenCalledTimes(1);
    const chat = vi.fn(async () => sse([{ choices: [{ delta: { content: "Forty " } }] }, "{not json", "null", { choices: [{ delta: { content: "thousand." }, finish_reason: "stop" }] }, "[DONE]"]));
    expect(await collect(answerDirect(chat, "k", "deepseek", "deepseek-flash", "Be brief.", user, signal(), { provider: answerProviderInfo("deepseek")!, onIncomplete }))).toBe("Forty thousand.");
    expect(onIncomplete).toHaveBeenCalledTimes(2);
    const early = vi.fn(async () => sse(["{not json", { type: "response.output_text.delta", delta: "Forty thousand." }, completedEvent]));
    expect(await collect(answerDirect(early, "k", "openai-responses", "gpt-6.1-terra", "Be brief.", user, signal(), { onIncomplete }))).toBe("Forty thousand.");
    const earlyChat = vi.fn(async () => sse(["{not json", { choices: [{ delta: { content: "Forty thousand." }, finish_reason: "stop" }] }, "[DONE]"]));
    expect(await collect(answerDirect(earlyChat, "k", "deepseek", "deepseek-flash", "Be brief.", user, signal(), { provider: answerProviderInfo("deepseek")!, onIncomplete }))).toBe("Forty thousand.");
    expect(onIncomplete).toHaveBeenCalledTimes(2);
  });
  it("completes with partial: true, and keeps the answer out of follow-up history and automatic notes", async () => {
    const bodies: string[] = [];
    let calls = 0;
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => { bodies.push(requestOf(init)); return ++calls === 1 ? gapResponses() : sse([{ type: "response.output_text.delta", delta: "WHOLEANSWER: the team will spend fifty thousand dollars." }, completedEvent]); });
    const h = setup(fetcher);
    await h.client.start(config, { openai: "k" });
    await h.client.ask("Summarise the budget so far.");
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    expect(ofType(h.events, "answer.completed")[0]).toMatchObject({ partial: true, text: "GAPTEXT forty thousand." });
    await h.client.ask("And the owners?");
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(2));
    expect("partial" in ofType(h.events, "answer.completed")[1]!).toBe(false);
    expect(bodies[1]).not.toContain("GAPTEXT");
    await vi.waitFor(() => expect(ofType(h.events, "note.suggested")).toHaveLength(1));
    expect(ofType(h.events, "note.suggested")[0]!.note.text).toContain("WHOLEANSWER");
    expect(ofType(h.events, "error")).toHaveLength(0);
    await h.client.dispose();
  });
});

describe("review 9: only a length limit makes an answer partial", () => {
  const delta = { type: "response.output_text.delta", delta: "The budget is forty" };
  const incomplete = (reason: string) => ({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason }, usage: { input_tokens: 10, output_tokens: 600 } } });
  it("Responses: content_filter is a provider error that names the filter, max_output_tokens stays partial", async () => {
    let calls = 0;
    const fetcher = vi.fn(async () => sse([delta, incomplete(++calls === 1 ? "content_filter" : "max_output_tokens")]));
    const h = setup(fetcher);
    await h.client.start(config, { openai: "k" });
    await h.transport.injectTranscript(BUDGET, OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "error")).toHaveLength(1));
    expect(ofType(h.events, "error")[0]).toMatchObject({ code: "provider-response", fatal: false });
    expect(ofType(h.events, "error")[0]!.message).toMatch(/content filter/iu);
    expect(ofType(h.events, "answer.completed")).toHaveLength(0);
    await h.transport.injectTranscript("Who owns the launch date?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    expect(ofType(h.events, "answer.completed")[0]).toMatchObject({ partial: true });
    await h.client.dispose();
  });
  it("Chat Completions: finish_reason content_filter is a provider error, not a complete answer", async () => {
    const fetcher = vi.fn(async () => sse([{ choices: [{ delta: { content: "The budget is" } }] }, { choices: [{ delta: {}, finish_reason: "content_filter" }] }, "[DONE]"]));
    const h = setup(fetcher);
    await h.client.start(deepseek, { deepseek: "k", deepgram: "d" });
    await h.transport.injectTranscript(BUDGET, OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "error")).toHaveLength(1));
    expect(ofType(h.events, "error")[0]!.message).toMatch(/content filter/iu);
    expect(ofType(h.events, "answer.completed")).toHaveLength(0);
    await h.client.dispose();
    const openaiChat = vi.fn(async () => sse([{ choices: [{ delta: { content: "The budget is" } }] }, { choices: [{ delta: {}, finish_reason: "content_filter" }] }, "[DONE]"]));
    const error = await collect(answerDirect(openaiChat, "k", "openai-compatible", "gpt-4o-mini", "Be brief.", [{ role: "user", content: "Hello" }], new AbortController().signal, { onIncomplete: () => undefined })).catch(e => e);
    expect(error).toBeInstanceOf(DirectProviderError);
    expect((error as DirectProviderError).message).toMatch(/content filter/iu);
  });
});
