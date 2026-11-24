import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectConversationTransport, MONOLOGUE_AFTER_MS } from "../src/direct-transport.js";
import { HelixConversationClient } from "../src/client.js";
import { ConversationCopilot, MAX_SAY_LINES, copilotInstructions, copilotSchema } from "../src/copilot.js";
import { transcribeDirect } from "../src/direct-providers.js";
import { realtimeSessionConfig } from "../src/realtime-transcription.js";
import {
  ANSWER_KEY_PREFIX, AUTO_SPEECH_LANGUAGE, DEFAULT_COPILOT_SETTINGS, MODE_PROFILES, OTHER_SPEAKER, SELF_SPEAKER, SPEECH_RECOGNITION_RULE, SPOKEN_LANGUAGE_RULE,
  extractQuestions, isAutoSpeechLanguage, isRhetoricalQuestion, isSelfAnsweredQuestion, lineRequest, modeSystemPrompt, speechLanguageHint,
  type ConversationMode, type CopilotCallbacks, type CopilotSettings, type CopilotSuggestion, type GatewayEvent, type SessionConfig, type Speaker,
} from "../src/index.js";

const base: SessionConfig = {
  sessionId: "v16", endpoint: { id: "openai-direct", url: "https://api.openai.com/v1/responses", provider: "openai", model: "gpt-6.1-terra" },
  prompt: { id: "p", version: "1", system: "Be brief.", maxResponseSentences: 3 },
  providers: { transcriptionProvider: "openai-transcribe", answerProvider: "openai-responses" },
  speaker: { label: "G2 conversation", role: "unknown" }, mode: "general", responseStrategy: "reactive", locale: "en-US",
  automation: { detectQuestions: true, answerQuestions: true, saveNotes: false }, memory: { readOmiContext: false, syncNotes: false },
};
const UNKNOWN: Speaker = { label: "G2 conversation", role: "unknown" };
const sse = (text: string) => new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\ndata: {"type":"response.completed"}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
const ofType = <T extends GatewayEvent["type"]>(events: GatewayEvent[], type: T) => events.filter((e): e is Extract<GatewayEvent, { type: T }> => e.type === type);
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const signal = () => new AbortController().signal;

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

describe("speech-recognition and language rules", () => {
  it("the answer prompt tells the model to read garbled speech for its meaning and never comment on it", () => {
    for (const mode of ["general", "interviewer", "interviewee", "learning", "passive"] as const) {
      const prompt = modeSystemPrompt("Base.", mode, "reactive");
      expect(prompt).toContain(SPEECH_RECOGNITION_RULE);
      expect(prompt).toContain(SPOKEN_LANGUAGE_RULE);
    }
    expect(SPEECH_RECOGNITION_RULE).toMatch(/live speech recognition/u);
    expect(SPEECH_RECOGNITION_RULE).toMatch(/wrong words, mixed languages and cut-off sentences/u);
    expect(SPEECH_RECOGNITION_RULE).toMatch(/Infer the most likely meaning silently/u);
    expect(SPEECH_RECOGNITION_RULE).toMatch(/Never mention the transcript, speech recognition, missing words or unclear audio/u);
    expect(SPEECH_RECOGNITION_RULE).toMatch(/never ask the wearer to clarify or repeat/u);
    expect(SPEECH_RECOGNITION_RULE).toMatch(/respond to the topic of the surrounding conversation/u);
    expect(SPOKEN_LANGUAGE_RULE).toMatch(/language being spoken/u);
  });
  it("uncertainty is about facts, not about unclear speech", () => {
    const prompt = modeSystemPrompt("Base.", "general", "reactive");
    expect(prompt).not.toMatch(/If evidence is missing, state uncertainty/u);
    expect(prompt).toMatch(/When a fact is not known, say so briefly instead of inventing it; this is about facts, never about unclear or unfinished speech/u);
  });
  it("a user-edited mode prompt keeps both rules", () => {
    const prompt = modeSystemPrompt("Base.", "general", "reactive", "Mine.");
    expect(prompt).toContain(SPEECH_RECOGNITION_RULE);
    expect(prompt).toContain(SPOKEN_LANGUAGE_RULE);
  });
  it("the copilot prompt carries the same two rules in every mode", () => {
    for (const mode of Object.keys(MODE_PROFILES)) {
      const text = copilotInstructions({ ...DEFAULT_COPILOT_SETTINGS, mode });
      expect(text).toContain(SPEECH_RECOGNITION_RULE);
      expect(text).toContain(SPOKEN_LANGUAGE_RULE);
    }
  });
});

describe("lines to say (sayLines modes)", () => {
  const SAY: ConversationMode[] = ["general", "learning", "social", "partner"];
  const ASK: ConversationMode[] = ["interviewer", "interviewee", "negotiation", "technical"];
  it("Meeting, Learning, Social and Partner are the sayLines modes", () => {
    for (const mode of SAY) expect(MODE_PROFILES[mode].sayLines, mode).toBe(true);
    for (const mode of ASK) expect(MODE_PROFILES[mode].sayLines, mode).toBeUndefined();
    for (const mode of SAY) expect(MODE_PROFILES[mode].suggestionKinds, mode).toBeUndefined();
  });
  it("their suggestions text asks for lines to read aloud that engage with the substance", () => {
    for (const mode of SAY) {
      const text = copilotInstructions({ ...DEFAULT_COPILOT_SETTINGS, mode });
      expect(text, mode).toMatch(/suggestedQuestions: at most 3 lines the WEARER can say next/u);
      expect(text, mode).toMatch(/read aloud word for word, in the language being spoken/u);
      expect(text, mode).toMatch(/a sharp question, a comparison with a named idea, a counterpoint, an example, or a connection to something said earlier/u);
      expect(text, mode).toMatch(/like a well-read participant and name the idea/u);
      expect(text, mode).toMatch(/Never a question about the transcript or the audio, never a request to repeat or clarify/u);
      expect(text, mode).toMatch(/why is at most 8 words/u);
    }
    expect(copilotInstructions({ ...DEFAULT_COPILOT_SETTINGS, mode: "partner" })).toMatch(/warm, plain and honest/u);
    expect(copilotInstructions({ ...DEFAULT_COPILOT_SETTINGS, mode: "partner" })).toMatch(/nothing manipulative/u);
  });
  it("the schema keeps the field names (question, why) and adds no kind", () => {
    for (const mode of SAY) {
      const item = (copilotSchema({ ...DEFAULT_COPILOT_SETTINGS, mode }).properties as { suggestedQuestions: { items: { properties: Record<string, unknown> } } }).suggestedQuestions.items;
      expect(Object.keys(item.properties)).toEqual(["question", "why"]);
    }
  });
  it("the question modes keep their question suggestions", () => {
    for (const mode of ASK) expect(copilotInstructions({ ...DEFAULT_COPILOT_SETTINGS, mode }), mode).not.toMatch(/lines the WEARER can say next/u);
    expect(copilotInstructions({ ...DEFAULT_COPILOT_SETTINGS, mode: "interviewer" })).toMatch(/follow-up probes the INTERVIEWER/u);
  });
});

const message = (text: string) => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 500, output_tokens: 100, output_tokens_details: { reasoning_tokens: 0 } } });
const empty = { summary: { bullets: [], keyFacts: [] }, concepts: [], conflicts: [], suggestedQuestions: [], asks: [], claims: [], people: [] };
function copilotHarness(replies: Record<string, unknown>[], settings: Partial<CopilotSettings>) {
  const emitted: CopilotSuggestion[][] = [];
  let call = 0;
  const fetch = vi.fn(async () => Response.json(message(JSON.stringify({ ...empty, ...(replies[call++] ?? {}) }))));
  const callbacks: CopilotCallbacks = {
    enabled: () => true, settings: () => ({ ...DEFAULT_COPILOT_SETTINGS, implicitAsks: false, ...settings }),
    onSuggestions: items => emitted.push([...items]),
  };
  const copilot = new ConversationCopilot({ fetch, key: "k", sessionId: "s", callbacks, cooldownMs: 0 });
  return { copilot, emitted, last: () => emitted.at(-1) ?? [] };
}
const LINES = [
  { question: "How does this differ from futurism: is planning for the future also a way of leaving the present?", why: "Compares with a named idea." },
  { question: "The Stoics said the same about the present moment, but they still rehearsed misfortune in advance.", why: "They may ask: counterpoint." },
  { question: "Focusing on the present helped me most when I stopped checking my phone at dinner.", why: "A concrete example." },
  { question: "Is presence a skill you train, or a state you fall into?", why: "Sharp question." },
];

describe("copilot stamps lines", () => {
  it.each(["general", "learning", "social", "partner"])("%s: every suggestion is kind say, at most three, and why has no heading", async mode => {
    const h = copilotHarness([{ suggestedQuestions: LINES }], { mode });
    h.copilot.submit("t1", "Being present is the whole point of this talk.", OTHER_SPEAKER);
    await vi.waitFor(() => expect(h.last().length).toBeGreaterThan(0));
    expect(MAX_SAY_LINES).toBe(3);
    expect(h.last()).toHaveLength(3);
    expect(h.last().map(item => item.kind)).toEqual(["say", "say", "say"]);
    expect(h.last().map(item => item.question)).toEqual(LINES.slice(0, 3).map(item => item.question));
    expect(h.last().map(item => item.why)).toEqual(LINES.slice(0, 3).map(item => item.why));
    for (const item of h.last()) expect(item.why).not.toMatch(/^Ask them/u);
    h.copilot.cancel();
  });
  it("a kind sent by the model in a sayLines mode is ignored: the line is still kind say", async () => {
    const h = copilotHarness([{ suggestedQuestions: [{ ...LINES[0], kind: "they-ask" }] }], { mode: "general" });
    h.copilot.submit("t1", "Being present is the whole point of this talk.", OTHER_SPEAKER);
    await vi.waitFor(() => expect(h.last()).toHaveLength(1));
    expect(h.last()[0]).toMatchObject({ kind: "say", why: "Compares with a named idea." });
    h.copilot.cancel();
  });
  it("a line the wearer says aloud is marked said, like an asked question", async () => {
    const h = copilotHarness([{ suggestedQuestions: [LINES[3]] }], { mode: "general" });
    h.copilot.submit("t1", "Being present is the whole point of this talk.", OTHER_SPEAKER);
    await vi.waitFor(() => expect(h.last()).toHaveLength(1));
    h.copilot.submit("t2", "So is presence a skill you train, or a state you fall into?", SELF_SPEAKER);
    expect(h.last()[0]).toMatchObject({ kind: "say" });
    expect(h.last()[0]!.askedAt).toBeTruthy();
    h.copilot.cancel();
  });
  it("Candidate mode still splits they-ask and ask-them, with the heading in why", async () => {
    const h = copilotHarness([{ suggestedQuestions: [
      { question: "How did you measure the impact of that migration?", why: "Checks ownership.", kind: "they-ask" },
      { question: "What does success look like in the first ninety days?", why: "Shows expectations.", kind: "ask-them" },
    ] }], { mode: "interviewee" });
    h.copilot.submit("t1", "Tell me about the migration you led last year.", OTHER_SPEAKER);
    await vi.waitFor(() => expect(h.last()).toHaveLength(2));
    expect(h.last().map(item => item.kind)).toEqual(["they-ask", "ask-them"]);
    expect(h.last().map(item => item.why)).toEqual(["They may ask: Checks ownership.", "Ask them: Shows expectations."]);
    h.copilot.cancel();
  });
  it.each(["interviewer", "negotiation", "technical"])("%s keeps plain question suggestions (no kind, up to five)", async mode => {
    const five = [...LINES, { question: "Which benchmark did you run on the new cluster?", why: "Evidence." }];
    const h = copilotHarness([{ suggestedQuestions: five }], { mode });
    h.copilot.submit("t1", "We moved the service to the new cluster in March.", OTHER_SPEAKER);
    await vi.waitFor(() => expect(h.last()).toHaveLength(5));
    for (const item of h.last()) expect(item.kind).toBeUndefined();
    h.copilot.cancel();
  });
});

describe("manual ask returns a line to say", () => {
  it("the request asks for the single best thing to say next, word for word, plus a correction", () => {
    for (const scope of ["local", "global"] as const) {
      const text = lineRequest(scope);
      expect(text).toMatch(/single best thing to say next, word for word, in the language being spoken, as one or two sentences they can read aloud/u);
      expect(text).toMatch(/add one sentence starting "Correction:"/u);
      expect(text).not.toMatch(/unresolved question|follow-up question or next response/u);
    }
    expect(lineRequest("local")).toMatch(/the recent focus, using relevant earlier background/u);
    expect(lineRequest("global")).toMatch(/the whole captured session/u);
    expect(lineRequest("global", true)).toMatch(/Base it on the captured session\./u);
  });
  it.each(["local", "global"] as const)("live %s ask: line request, no 'you could say' clause, no sentence-limit clash", async scope => {
    const h = harness({ mode: "general" });
    await h.client.start(base, { openai: "k" });
    await h.transport.injectTranscript("Being present means you stop rehearsing tomorrow.", OTHER_SPEAKER);
    await h.client.askContext(scope);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    const body = h.bodies.at(-1)!;
    expect(body.request).toBe(lineRequest(scope));
    expect(body.instructions).not.toMatch(/you could say/u);
    expect(body.instructions).not.toMatch(/Respond in at most/u);
    expect(body.instructions).toMatch(/The reply is the wearer's own next line/u);
    expect(body.instructions).toMatch(/one or two sentences, plus at most one correction sentence/u);
    expect(body.instructions).toContain(SPEECH_RECOGNITION_RULE);
    await h.client.dispose();
  });
  it("an ordinary answer keeps the 'omit coaching phrases' clause and the sentence limit", async () => {
    const h = harness({ mode: "general" });
    await h.client.start(base, { openai: "k" });
    await h.transport.injectTranscript("What lead time are you seeing for the Jetson boards?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(h.bodies).toHaveLength(1));
    expect(h.bodies[0]!.instructions).toMatch(/coaching phrases such as 'you could say'/u);
    expect(h.bodies[0]!.instructions).toMatch(/Respond in at most 3 sentences\./u);
    await h.client.dispose();
  });
  it("Interviewer mode: a manual ask sends no answer-key instruction", async () => {
    const h = harness({ mode: "interviewer" });
    await h.client.start(base, { openai: "k" });
    await h.transport.injectTranscript("So the future of work is really about attention.", OTHER_SPEAKER);
    for (const scope of ["local", "global"] as const) {
      await h.client.askContext(scope);
      await vi.waitFor(() => expect(h.bodies.at(-1)?.request).toBe(lineRequest(scope)));
      const body = h.bodies.at(-1)!;
      expect(body.input).not.toContain(ANSWER_KEY_PREFIX);
      for (const text of [body.instructions, body.input]) {
        expect(text).not.toMatch(/answer key/iu);
        expect(text).not.toMatch(/Strong answer|Probe:|Flag:|red flag/u);
      }
      await settle();
    }
    await h.client.ask("What is a fair way to compare two candidates?");
    await vi.waitFor(() => expect(h.bodies.at(-1)?.request).toContain("What is a fair way to compare two candidates?"));
    expect(h.bodies.at(-1)!.instructions).not.toMatch(/answer key|Strong answer|red flag/iu);
    expect(h.bodies.at(-1)!.input).not.toContain(ANSWER_KEY_PREFIX);
    await h.client.dispose();
  });
  it("Interviewer mode: the wearer's own spoken question still gets the answer key, a candidate's question does not", async () => {
    const h = harness({ mode: "interviewer" });
    await h.client.start(base, { openai: "k" });
    await h.transport.injectTranscript("How did you scale the ingestion pipeline to ten billion events a day?", SELF_SPEAKER);
    await vi.waitFor(() => expect(h.bodies).toHaveLength(1));
    expect(h.bodies[0]!.request.startsWith(ANSWER_KEY_PREFIX)).toBe(true);
    expect(h.bodies[0]!.request).toMatch(/"Strong answer:"/u);
    await settle();
    await h.transport.injectTranscript("What does the on-call rotation look like for this team?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(h.bodies).toHaveLength(2));
    expect(h.bodies[1]!.request).not.toContain(ANSWER_KEY_PREFIX);
    expect(h.bodies[1]!.instructions).not.toMatch(/answer key/iu);
    expect(modeSystemPrompt("Base.", "interviewer", "reactive")).toMatch(/protected characteristics/u);
    await h.client.dispose();
  });
});

describe("rhetorical questions in talks", () => {
  it("questions a speaker voices for the audience are not questions to answer", () => {
    for (const text of [
      "You might ask why this matters at all?", "Now, you may wonder how anyone lives like that?", "Some of you might be wondering where this is going?",
      "Have you ever wondered why time feels faster as we age?", "What if I told you the future does not exist?", "And you know what?",
      "Isn't it?", "Don't you think?", "So what do I mean by that?", "Why am I telling you this?", "What's the point?", "You see what I'm saying?",
    ]) {
      expect(isRhetoricalQuestion(text), text).toBe(true);
      expect(extractQuestions(text), text).toEqual([]);
    }
  });
  it("a question the speaker goes on to answer is skipped; said on its own it stays a question", () => {
    for (const [question, answer] of [
      ["So what does that mean?", "It means we stop living in the next meeting."],
      ["Why is that?", "Because attention is the only thing we really own."],
      ["Is there anything we can do?", "Yes, we can start with ten minutes a day."],
      ["So what can we do about it?", "We can practise noticing."],
      ["How does that work?", "The mind returns to the breath every time."],
    ] as const) {
      expect(isSelfAnsweredQuestion(question), question).toBe(true);
      expect(extractQuestions(`${question} ${answer}`), question).toEqual([]);
      expect(extractQuestions(question).map(item => item.text), question).toHaveLength(1);
      // Followed only by a tag or by another question, it is still a question.
      expect(extractQuestions(`${question} Right?`), question).toHaveLength(1);
    }
    expect(extractQuestions("What does that mean? Can you explain the clause to me?").map(item => item.text)).toEqual(["What does that mean?", "Can you explain the clause to me?"]);
  });
  it("interview and meeting questions still work", () => {
    for (const text of [
      "Can you tell me about a time you led a difficult migration?", "What lead time are you seeing for the Jetson boards? We need them in March.",
      "Why did you leave your last role? I saw it was a short stint.", "What does the on-call rotation look like for this team?",
      "How do you handle conflict on a team?", "What do you mean by eventual consistency?", "Is there anything else you would like to ask us?",
      "What can you do in the first ninety days? Walk me through it.", "Tell me about yourself.", "Have you ever noticed a production bug that others missed?",
    ]) expect(extractQuestions(text).length, text).toBeGreaterThanOrEqual(1);
  });
});

describe("Korean questions", () => {
  it("detects Korean questions with and without a question mark", () => {
    expect(extractQuestions("현재에 집중하는 것이 왜 중요합니까?").map(item => item.text)).toEqual(["현재에 집중하는 것이 왜 중요합니까?"]);
    for (const text of ["왜 미래를 걱정하면 안 됩니까", "어떻게 하면 현재에 집중할 수 있습니까.", "이 방법이 정말 효과가 있습니까", "그게 가능한 건가요", "지금 시작해도 될까요"]) {
      expect(extractQuestions(text), text).toHaveLength(1);
    }
  });
  it("Korean statements are not questions", () => {
    for (const text of ["내일 만나요.", "저는 집에 가요.", "현재에 집중하는 것이 중요합니다.", "그러니까 미래는 아직 오지 않았습니다."]) expect(extractQuestions(text), text).toEqual([]);
  });
  it("Korean tags and self-answered questions are rhetorical", () => {
    for (const text of ["그렇죠?", "맞죠?", "있잖아요.", "뭐랄까요?", "어떻게 말해야 할까요?"]) {
      expect(isRhetoricalQuestion(text), text).toBe(true);
      expect(extractQuestions(text), text).toEqual([]);
    }
    expect(extractQuestions("왜 그럴까요? 우리는 항상 내일을 생각하기 때문입니다.")).toEqual([]);
    expect(extractQuestions("왜 그럴까요?")).toHaveLength(1);
  });
});

describe("monologue guard", () => {
  const QUESTION = "Why do we spend so much of life rehearsing a future that never arrives?";
  const SECOND = "What would change if you treated this hour as the only one you have?";
  async function talk(mode: ConversationMode | undefined, tagged: boolean) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-23T10:00:00Z"));
    const h = harness({ mode });
    await h.client.start(base, { openai: "k" });
    const them = tagged ? OTHER_SPEAKER : UNKNOWN;
    if (tagged) await h.transport.injectTranscript("Thanks for having me on the show.", SELF_SPEAKER);
    // The other side talks for 70 s in turns a few seconds apart.
    for (let i = 0; i < 7; i++) {
      vi.setSystemTime(Date.now() + 10_000);
      await h.transport.injectTranscript(`Point number ${i} about living in the present moment.`, them);
    }
    await settle();
    return { h, them };
  }
  it("the default is 60 seconds", () => { expect(MONOLOGUE_AFTER_MS).toBe(60_000); });
  it("tagged roles: after 60 s of the other side alone, their questions are shown but not answered", async () => {
    const { h, them } = await talk("general", true);
    const before = h.bodies.length;
    await h.transport.injectTranscript(QUESTION, them);
    await settle();
    expect(h.bodies).toHaveLength(before);
    expect(ofType(h.events, "answer.completed")).toHaveLength(0);
    // The transcript and the detected question still reach the host.
    expect(ofType(h.events, "transcript.final").at(-1)!.text).toBe(QUESTION);
    expect(ofType(h.events, "question.detected").map(event => event.text)).toContain(QUESTION);
    await h.client.dispose();
  });
  it("the copilot is still fed during a monologue", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-23T10:00:00Z"));
    const urls: string[] = [];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      urls.push(body.text?.format?.name === "helix_copilot" ? "copilot" : "answer");
      return body.text?.format?.name === "helix_copilot" ? Response.json(message(JSON.stringify({ ...empty, suggestedQuestions: [LINES[0]] }))) : sse("An answer.");
    });
    const lines: CopilotSuggestion[][] = [];
    const transport = new DirectConversationTransport({ fetch: fetcher, mode: () => "general", copilot: {
      enabled: () => true, settings: () => ({ ...DEFAULT_COPILOT_SETTINGS, implicitAsks: false, claims: false, people: false, mode: "general" }), onSuggestions: items => lines.push([...items]),
    } });
    const client = new HelixConversationClient(transport);
    await client.start(base, { openai: "k" });
    await transport.injectTranscript("Thanks for having me on the show.", SELF_SPEAKER);
    for (let i = 0; i < 7; i++) { vi.setSystemTime(Date.now() + 10_000); await transport.injectTranscript(`Point number ${i} about living in the present moment.`, OTHER_SPEAKER); }
    await transport.injectTranscript(QUESTION, OTHER_SPEAKER);
    transport.runCopilotNow();
    await vi.waitFor(() => expect(lines.at(-1)?.[0]).toMatchObject({ kind: "say", question: LINES[0]!.question }));
    expect(urls).not.toContain("answer");
    await client.dispose();
  });
  it("a turn from the wearer ends the monologue: the next question is answered", async () => {
    const { h, them } = await talk("general", true);
    await h.transport.injectTranscript("That is a fair point.", SELF_SPEAKER);
    vi.setSystemTime(Date.now() + 5_000);
    await h.transport.injectTranscript(QUESTION, them);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    await h.client.dispose();
  });
  it("a long pause starts the count again", async () => {
    const { h, them } = await talk("general", true);
    vi.setSystemTime(Date.now() + 120_000);
    await h.transport.injectTranscript(QUESTION, them);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    await h.client.dispose();
  });
  it("before 60 s the other side's question is answered", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = harness({ mode: "general" });
    await h.client.start(base, { openai: "k" });
    await h.transport.injectTranscript("Thanks for having me on the show.", SELF_SPEAKER);
    for (let i = 0; i < 3; i++) { vi.setSystemTime(Date.now() + 10_000); await h.transport.injectTranscript(`Point number ${i} about the present.`, OTHER_SPEAKER); }
    await h.transport.injectTranscript(QUESTION, OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    await h.client.dispose();
  });
  it("untagged sessions are never suppressed", async () => {
    const { h, them } = await talk("general", false);
    await h.transport.injectTranscript(QUESTION, them);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    await h.client.dispose();
  });
  it("only other-tagged turns, with no turn from the wearer yet, are not suppressed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const h = harness({ mode: "general" });
    await h.client.start(base, { openai: "k" });
    for (let i = 0; i < 7; i++) { vi.setSystemTime(Date.now() + 10_000); await h.transport.injectTranscript(`Point number ${i} about the present.`, OTHER_SPEAKER); }
    await h.transport.injectTranscript(QUESTION, OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    await h.client.dispose();
  });
  it.each(["interviewer", "interviewee"] as const)("%s mode is exempt", async mode => {
    const { h, them } = await talk(mode, true);
    await h.transport.injectTranscript(SECOND, them);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    await h.client.dispose();
  });
  it("a manual ask is never suppressed", async () => {
    const { h } = await talk("general", true);
    await h.client.askContext("local");
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    expect(h.bodies.at(-1)!.request).toBe(lineRequest("local"));
    await h.client.ask("What is presentism?");
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(2));
    await h.client.dispose();
  });
});

describe("speech language auto (mixed languages)", () => {
  it("auto is recognised in any case; other locales give their two-letter language", () => {
    expect(AUTO_SPEECH_LANGUAGE).toBe("auto");
    for (const value of ["auto", "AUTO", " Auto "]) { expect(isAutoSpeechLanguage(value)).toBe(true); expect(speechLanguageHint(value)).toBeUndefined(); }
    expect(isAutoSpeechLanguage("en")).toBe(false);
    expect(isAutoSpeechLanguage(undefined)).toBe(false);
    expect(speechLanguageHint("en-US")).toBe("en");
    expect(speechLanguageHint("zh_CN")).toBe("zh");
    expect(speechLanguageHint(undefined)).toBeUndefined();
  });
  it("realtime: auto sends no languages list; a locale still pins it", () => {
    const transcription = (locale?: string) => (realtimeSessionConfig(undefined, locale) as { audio: { input: { transcription: Record<string, unknown> } } }).audio.input.transcription;
    expect(transcription("en-US").languages).toEqual(["en"]);
    expect(transcription("ko").languages).toEqual(["ko"]);
    expect("languages" in transcription("auto")).toBe(false);
    expect("languages" in transcription("AUTO")).toBe(false);
  });
  it("uploaded Whisper: auto sends no language field", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ text: "안녕하세요 hello 你好" }));
    await transcribeDirect(fetcher, "openai-whisper", "k", new Int16Array(3200), "en-US", signal());
    await transcribeDirect(fetcher, "openai-whisper", "k", new Int16Array(3200), "auto", signal());
    expect((fetcher.mock.calls[0]![1]!.body as FormData).get("language")).toBe("en");
    expect((fetcher.mock.calls[1]![1]!.body as FormData).has("language")).toBe(false);
  });
  it("Deepgram: auto asks for multilingual recognition; a locale leaves the request as it was", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ results: { channels: [{ alternatives: [{ transcript: "Hello." }] }] } }));
    await transcribeDirect(fetcher, "deepgram", "k", new Int16Array(3200), "en", signal());
    await transcribeDirect(fetcher, "deepgram", "k", new Int16Array(3200), "auto", signal());
    expect(fetcher.mock.calls[0]![0]).toBe("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true");
    expect(fetcher.mock.calls[1]![0]).toBe("https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&language=multi");
  });
  it("Soniox: auto sends no language hints", async () => {
    const sent: Record<string, unknown>[] = [];
    let socket!: FakeSocket;
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      onopen?: () => void; onmessage?: (event: { data: string }) => void; onerror?: () => void; onclose?: () => void;
      constructor() { socket = this; }
      send(data: unknown) { if (typeof data === "string" && data.startsWith("{")) sent.push(JSON.parse(data) as Record<string, unknown>); }
      close() {}
    }
    vi.stubGlobal("WebSocket", FakeSocket);
    try {
      for (const locale of ["ko-KR", "auto"]) {
        const result = transcribeDirect(vi.fn(), "soniox", "k", new Int16Array(3200), locale, signal());
        socket.onopen?.();
        socket.onmessage?.({ data: JSON.stringify({ tokens: [{ text: "ok", is_final: true }], finished: true }) });
        await result;
      }
      expect(sent[0]).toMatchObject({ language_hints: ["ko"] });
      expect("language_hints" in sent[1]!).toBe(false);
      expect(sent[1]).toMatchObject({ model: "stt-rt-v5" });
    } finally { vi.unstubAllGlobals(); }
  });
  it("a session with locale auto starts and passes it to realtime transcription unpinned", async () => {
    const h = harness({ mode: "general" });
    await h.client.start({ ...base, locale: "auto" }, { openai: "k" });
    await h.transport.injectTranscript("오늘 주제는 being present 입니다.", OTHER_SPEAKER);
    expect(ofType(h.events, "transcript.final")).toHaveLength(1);
    await h.client.dispose();
  });
});
