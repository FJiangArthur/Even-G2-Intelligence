/** v0.16 fix pass: regressions for the findings of the independent review of the prompts and phone work. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectConversationTransport } from "../src/direct-transport.js";
import { HelixConversationClient } from "../src/client.js";
import { ConversationCopilot } from "../src/copilot.js";
import {
  DEFAULT_COPILOT_SETTINGS, OTHER_SPEAKER, SELF_SPEAKER,
  extractQuestions, isRhetoricalQuestion, isSelfAnsweredQuestion, lineRequest,
  type ConversationMode, type CopilotCallbacks, type CopilotSettings, type CopilotSuggestion, type GatewayEvent, type SessionConfig, type Speaker,
} from "../src/index.js";

const base: SessionConfig = {
  sessionId: "v16-fix", endpoint: { id: "openai-direct", url: "https://api.openai.com/v1/responses", provider: "openai", model: "gpt-6.1-terra" },
  prompt: { id: "p", version: "1", system: "Be brief.", maxResponseSentences: 3 },
  providers: { transcriptionProvider: "openai-transcribe", answerProvider: "openai-responses" },
  speaker: { label: "G2 conversation", role: "unknown" }, mode: "general", responseStrategy: "reactive", locale: "en-US",
  automation: { detectQuestions: true, answerQuestions: true, saveNotes: false }, memory: { readOmiContext: false, syncNotes: false },
};
const UNKNOWN: Speaker = { label: "G2 conversation", role: "unknown" };
const sse = (text: string) => new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\ndata: {"type":"response.completed"}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
const ofType = <T extends GatewayEvent["type"]>(events: GatewayEvent[], type: T) => events.filter((e): e is Extract<GatewayEvent, { type: T }> => e.type === type);
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

function harness(live: { mode?: ConversationMode } = {}) {
  const bodies: { instructions: string; input: string; request: string }[] = [];
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const content = String((body.input as { content: string }[] | undefined)?.at(-1)?.content ?? "");
    bodies.push({ instructions: String(body.instructions ?? ""), input: JSON.stringify(body.input ?? ""), request: content.slice(content.indexOf("REQUEST\n") + 8) });
    return sse("Planning for the future can itself be a way of leaving the present.");
  });
  const transport = new DirectConversationTransport({ fetch: fetcher, mode: () => live.mode });
  const client = new HelixConversationClient(transport);
  const events: GatewayEvent[] = [];
  client.subscribe(event => events.push(event));
  return { transport, client, events, bodies, live };
}
afterEach(() => { vi.useRealTimers(); });

const QUESTION = "Why do we spend so much of life rehearsing a future that never arrives?";

describe("monologue guard: a wearer who only listens", () => {
  it("other-tagged turns with no turn from the wearer at all are suppressed after 60 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-23T10:00:00Z"));
    const h = harness({ mode: "general" });
    await h.client.start(base, { openai: "k" });
    for (let i = 0; i < 7; i++) { vi.setSystemTime(Date.now() + 10_000); await h.transport.injectTranscript(`Point number ${i} about the present.`, OTHER_SPEAKER); }
    await settle();
    const before = h.bodies.length;
    await h.transport.injectTranscript(QUESTION, OTHER_SPEAKER);
    await settle();
    expect(h.bodies).toHaveLength(before);
    expect(ofType(h.events, "answer.completed")).toHaveLength(0);
    // Still listed for the phone.
    expect(ofType(h.events, "question.detected").map(event => event.text)).toContain(QUESTION);
    await h.client.dispose();
  });
  it("a first question from the other side, before 60 s, is answered with no turn from the wearer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-23T10:00:00Z"));
    const h = harness({ mode: "general" });
    await h.client.start(base, { openai: "k" });
    await h.transport.injectTranscript("Nice to meet you.", OTHER_SPEAKER);
    vi.setSystemTime(Date.now() + 5_000);
    await h.transport.injectTranscript("What lead time can you commit to for the first batch?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    await h.client.dispose();
  });
});

describe("monologue guard: a two-way conversation with poorly tagged wearer turns", () => {
  it("a turn of unknown role between the other side's turns ends their floor", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-23T10:00:00Z"));
    const h = harness({ mode: "general" });
    await h.client.start(base, { openai: "k" });
    await h.transport.injectTranscript("Thanks for making the time today.", SELF_SPEAKER);
    // 80 s of back and forth: the wearer's replies come through with no usable tag.
    for (let i = 0; i < 4; i++) {
      vi.setSystemTime(Date.now() + 10_000);
      await h.transport.injectTranscript(`We reviewed batch ${i} and the yield held up.`, OTHER_SPEAKER);
      vi.setSystemTime(Date.now() + 10_000);
      await h.transport.injectTranscript(`Good, that matches what we measured on run ${i}.`, UNKNOWN);
    }
    vi.setSystemTime(Date.now() + 5_000);
    await h.transport.injectTranscript("So what lead time can you commit to?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    await h.client.dispose();
  });
});

describe("Korean statements that start with an interrogative syllable", () => {
  it.each([
    "왜냐하면 지금 시간이 없기 때문입니다.", "누구나 그렇게 생각합니다.", "언제나 감사하게 생각하고 있어요.",
    "무엇보다 건강이 제일 중요합니다.", "어느 정도 준비가 되었습니다.", "어디든지 갈 수 있어요.",
    "왜 그런지 설명하겠습니다.", "어떻게든 해 보겠습니다.", "얼마 전에 친구를 만났어요.", "시간이 없으니까 먼저 갈게요.", "비가 오니까",
  ])("is not a question: %s", text => { expect(extractQuestions(text)).toEqual([]); });
  it.each([
    "왜 미래를 걱정하면 안 됩니까", "어떻게 하면 현재에 집중할 수 있습니까.", "누가 이 일을 맡을 거예요", "언제 시작할 수 있어요",
    "어디에서 만날까요", "무슨 뜻이에요", "그게 가능한 건가요", "어느 정도 걸립니까", "얼마나 걸려요", "이 방법이 정말 효과가 있습니까",
  ])("is still a question: %s", text => { expect(extractQuestions(text)).toHaveLength(1); });
});

describe("a question followed by a statement that does not answer it", () => {
  it.each([
    ["What do you do? I heard you work in robotics.", "What do you do?"],
    ["What should we do about it? The deadline is Friday.", "What should we do about it?"],
    ["Why is that? I thought the tests passed.", "Why is that?"],
    ["Why is that? Take your time.", "Why is that?"],
    ["What happens next? I need to tell my manager.", "What happens next?"],
    ["Why not? We have the budget.", "Why not?"],
    ["这是什么意思呢？我没听懂。", "这是什么意思呢？"],
    ["What can you do about it? The customer is waiting.", "What can you do about it?"],
  ])("stays a question: %s", (line, question) => {
    expect(extractQuestions(line).map(item => item.text)).toContain(question);
  });
  it("is skipped only when the speaker goes on to answer it", () => {
    for (const line of [
      "So what does that mean? It means the mind is busy narrating.", "Why is that? Because attention is the only thing we really own.",
      "Is there anything we can do? Yes, we can start with ten minutes a day.", "So what can we do about it? We can practise noticing.",
      "How does that work? It works by returning to the breath every time.", "So why is that? Mostly habit, to be honest.",
      "What's the answer? There is no single answer.", "这是什么意思呢？意思是我们一直在想明天。", "왜 그럴까요? 우리는 항상 내일을 생각하기 때문입니다.",
    ]) expect(extractQuestions(line), line).toEqual([]);
  });
  it("second-person forms are not on the self-answered list", () => {
    for (const text of ["What do you do?", "What can you do about it?", "Is there anything you can do?"]) expect(isSelfAnsweredQuestion(text), text).toBe(false);
    for (const text of ["What can we do about it?", "Is there anything we can do?"]) expect(isSelfAnsweredQuestion(text), text).toBe(true);
  });
  it("keepSelfAnswered keeps the question whatever follows (Interviewer and Candidate modes)", () => {
    expect(extractQuestions("Why is that? Because the tests passed last week.", 3, { keepSelfAnswered: true }).map(item => item.text)).toEqual(["Why is that?"]);
    expect(extractQuestions("Why is that? Because the tests passed last week.")).toEqual([]);
  });
  it.each(["interviewer", "interviewee"] as const)("%s mode: a question the speaker seems to answer is still detected and answered", async mode => {
    const h = harness({ mode });
    await h.client.start(base, { openai: "k" });
    await h.transport.injectTranscript("Why is that? Because I would like to hear your reasoning.", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    expect(ofType(h.events, "question.detected").map(event => event.text)).toEqual(["Why is that?"]);
    await h.client.dispose();
  });
  it("Meeting mode: the same line is not a question to answer", async () => {
    const h = harness({ mode: "general" });
    await h.client.start(base, { openai: "k" });
    await h.transport.injectTranscript("Why is that? Because I would like to hear your reasoning.", OTHER_SPEAKER);
    await settle();
    expect(ofType(h.events, "question.detected")).toEqual([]);
    expect(h.bodies).toHaveLength(0);
    await h.client.dispose();
  });
});

describe("talk openers do not swallow a real question in the same clause", () => {
  it("a comma that begins a question of its own ends the rhetorical part", () => {
    for (const text of [
      "Have you ever wondered about working at a startup, or do you prefer big companies?",
      "People often ask what you do for a living, so what do you do?",
      "You might be wondering about the price, but can you tell me your budget first?",
    ]) {
      expect(isRhetoricalQuestion(text), text).toBe(false);
      expect(extractQuestions(text), text).toHaveLength(1);
    }
  });
  it("the plain talk forms stay rhetorical", () => {
    for (const text of [
      "You might ask why this matters at all?", "Have you ever wondered why time feels faster as we age?", "What if I told you the future does not exist?",
      "You might be wondering whether this is just zoning out.", "Why am I telling you this, of all things?",
    ]) expect(extractQuestions(text), text).toEqual([]);
  });
  it("'What's the point?' is a real question unless the speaker answers it", () => {
    expect(isRhetoricalQuestion("What's the point?")).toBe(false);
    expect(extractQuestions("What's the point?").map(item => item.text)).toEqual(["What's the point?"]);
    expect(extractQuestions("What's the point? I want to know before we commit budget.").map(item => item.text)).toContain("What's the point?");
    expect(extractQuestions("So what's the point? The point is that attention is trainable.")).toEqual([]);
  });
});

describe("typed manual ask when earlier speech has rolled off", () => {
  it("the note is about missing facts and does not invite talk about the capture", async () => {
    const h = harness({ mode: "general" });
    await h.client.start(base, { openai: "k" });
    // More speech than the transcript keeps, so the request is marked as missing earlier speech.
    const filler = "We talked about the supplier schedule and the test plan in a lot of detail today. ";
    for (let i = 0; i < 40; i++) await h.transport.injectTranscript(filler.repeat(20), UNKNOWN);
    await h.client.ask("What did we agree about pricing?");
    await vi.waitFor(() => expect(h.bodies.at(-1)?.request).toContain("What did we agree about pricing?"));
    const request = h.bodies.at(-1)!.request;
    expect(request).toMatch(/If the answer depends on something not shown above, say you do not have that detail\./u);
    expect(request).not.toMatch(/Earlier speech|not included|say so briefly/u);
    await h.client.dispose();
  });
});

describe("a line to say in modes that do not fact-check", () => {
  it("lineRequest leaves the correction clause out when asked to", () => {
    expect(lineRequest("local")).toMatch(/add one sentence starting "Correction:"/u);
    expect(lineRequest("local", false, false)).not.toMatch(/Correction/u);
    expect(lineRequest("global", true, false)).not.toMatch(/Correction/u);
    expect(lineRequest("local", false, false)).toMatch(/single best thing to say next, word for word/u);
  });
  it.each(["partner", "social"] as const)("%s mode: a manual tap asks for no correction", async mode => {
    const h = harness({ mode });
    await h.client.start(base, { openai: "k" });
    await h.transport.injectTranscript("We moved here in 2018, right after the wedding.", OTHER_SPEAKER);
    await h.client.askContext("local");
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    const body = h.bodies.at(-1)!;
    expect(body.request).toBe(lineRequest("local", false, false));
    expect(`${body.request}\n${body.instructions}`).not.toMatch(/correction/iu);
    expect(body.instructions).toMatch(/Respond with the line only: one or two sentences\./u);
    await h.client.dispose();
  });
  it("Meeting mode keeps the correction", async () => {
    const h = harness({ mode: "general" });
    await h.client.start(base, { openai: "k" });
    await h.transport.injectTranscript("The Jetson boards shipped in 2018.", OTHER_SPEAKER);
    await h.client.askContext("local");
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    expect(h.bodies.at(-1)!.request).toMatch(/Correction:/u);
    expect(h.bodies.at(-1)!.instructions).toMatch(/plus at most one correction sentence/u);
    await h.client.dispose();
  });
});

const message = (text: string) => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 500, output_tokens: 100, output_tokens_details: { reasoning_tokens: 0 } } });
const empty = { summary: { bullets: [], keyFacts: [] }, concepts: [], conflicts: [], suggestedQuestions: [], asks: [], claims: [], people: [] };
const LINE = { question: "How does this differ from futurism: is planning for the future also a way of leaving the present?", why: "Compares with a named idea." };
const OTHER_LINE = { question: "Is presence a skill you train, or a state you fall into?", why: "Sharp question." };

describe("a line the wearer taps as said", () => {
  function copilotHarness(replies: Record<string, unknown>[], settings: Partial<CopilotSettings> = {}) {
    const emitted: CopilotSuggestion[][] = [];
    let call = 0;
    const fetch = vi.fn(async () => Response.json(message(JSON.stringify({ ...empty, ...(replies[call++] ?? {}) }))));
    const callbacks: CopilotCallbacks = {
      enabled: () => true, settings: () => ({ ...DEFAULT_COPILOT_SETTINGS, implicitAsks: false, mode: "general", ...settings }),
      onSuggestions: items => emitted.push([...items]),
    };
    const copilot = new ConversationCopilot({ fetch, key: "k", sessionId: "s", callbacks, cooldownMs: 0 });
    return { copilot, emitted, last: () => emitted.at(-1) ?? [] };
  }
  it("is marked said by the copilot and is not proposed again", async () => {
    const h = copilotHarness([{ suggestedQuestions: [LINE] }, { suggestedQuestions: [LINE, OTHER_LINE] }]);
    h.copilot.submit("t1", "Being present is the whole point of this talk.", OTHER_SPEAKER);
    await vi.waitFor(() => expect(h.last()).toHaveLength(1));
    const id = h.last()[0]!.id;
    expect(h.copilot.markSuggestionSaid(id)).toBe(true);
    expect(h.last()[0]).toMatchObject({ id, kind: "say" });
    expect(h.last()[0]!.askedAt).toBeTruthy();
    // A second tap, or an unknown id, changes nothing.
    const count = h.emitted.length;
    expect(h.copilot.markSuggestionSaid(id)).toBe(false);
    expect(h.copilot.markSuggestionSaid("nope")).toBe(false);
    expect(h.emitted).toHaveLength(count);
    // The model proposes the same sentence again: it does not come back as a fresh line.
    h.copilot.submit("t2", "Presence does not take time, it gives time back.", OTHER_SPEAKER);
    h.copilot.runNow();
    await vi.waitFor(() => expect(h.last().some(item => item.question === OTHER_LINE.question)).toBe(true));
    expect(h.last().filter(item => item.question === LINE.question && !item.askedAt)).toEqual([]);
    h.copilot.cancel();
  });
  it("the transport passes the tap to the session's copilot", async () => {
    const lines: CopilotSuggestion[][] = [];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return body.text?.format?.name === "helix_copilot" ? Response.json(message(JSON.stringify({ ...empty, suggestedQuestions: [LINE] }))) : sse("An answer.");
    });
    const transport = new DirectConversationTransport({ fetch: fetcher, mode: () => "general", copilot: {
      enabled: () => true, settings: () => ({ ...DEFAULT_COPILOT_SETTINGS, implicitAsks: false, claims: false, people: false, mode: "general" }), onSuggestions: items => lines.push([...items]),
    } });
    const client = new HelixConversationClient(transport);
    expect(transport.markSuggestionSaid("anything")).toBe(false);
    await client.start(base, { openai: "k" });
    await transport.injectTranscript("Being present is the whole point of this talk.", OTHER_SPEAKER);
    transport.runCopilotNow();
    await vi.waitFor(() => expect(lines.at(-1)?.[0]).toMatchObject({ kind: "say" }));
    const id = lines.at(-1)![0]!.id;
    expect(transport.markSuggestionSaid(id)).toBe(true);
    expect(lines.at(-1)![0]!.askedAt).toBeTruthy();
    await client.dispose();
  });
});
