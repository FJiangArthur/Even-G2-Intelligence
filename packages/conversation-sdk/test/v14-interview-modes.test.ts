import { describe, expect, it, vi } from "vitest";
import { DirectConversationTransport } from "../src/direct-transport.js";
import { HelixConversationClient } from "../src/client.js";
import { copilotInstructions, copilotSchema } from "../src/copilot.js";
import {
  ANSWER_KEY_PREFIX, ANSWER_KEY_SENTENCES, ANSWER_LENGTHS, DEFAULT_COPILOT_SETTINGS, MODE_PROFILES, OTHER_SPEAKER, PICKER_MODES, SELF_SPEAKER, SUGGESTION_KIND_LABELS,
  answerKeyInput, answerSentenceLimit, modeProfile, modeSystemPrompt, normalizeConversationMode,
  type AnswerLength, type ConversationMode, type GatewayEvent, type SessionConfig,
} from "../src/index.js";

const base: SessionConfig = {
  sessionId: "v14", endpoint: { id: "openai-direct", url: "https://api.openai.com/v1/responses", provider: "openai", model: "gpt-6.1-terra" },
  prompt: { id: "p", version: "1", system: "Be brief.", maxResponseSentences: 3 },
  providers: { transcriptionProvider: "openai-transcribe", answerProvider: "openai-responses" },
  speaker: { label: "G2 conversation", role: "unknown" }, mode: "general", responseStrategy: "reactive", locale: "en-US",
  automation: { detectQuestions: true, answerQuestions: true, saveNotes: false }, memory: { readOmiContext: false, syncNotes: false },
};
const sse = (text: string) => new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\ndata: {"type":"response.completed"}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
const ofType = <T extends GatewayEvent["type"]>(events: GatewayEvent[], type: T) => events.filter((e): e is Extract<GatewayEvent, { type: T }> => e.type === type);
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

function harness(live: { mode?: ConversationMode; length?: AnswerLength; custom?: string } = {}) {
  const bodies: { instructions: string; input: string }[] = [];
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    bodies.push({ instructions: String(body.instructions ?? ""), input: JSON.stringify(body.input ?? body.messages ?? "") });
    return sse("I led the migration. For example, at my last team I cut build time in half.");
  });
  const transport = new DirectConversationTransport({ fetch: fetcher, mode: () => live.mode, answerLength: () => live.length, modeInstructions: () => live.custom });
  const client = new HelixConversationClient(transport);
  const events: GatewayEvent[] = [];
  client.subscribe(event => events.push(event));
  return { transport, client, events, bodies, live };
}

describe("Candidate mode (id interviewee)", () => {
  it("is a first-class picker mode right after Interviewer, with its own label, tag and presets", () => {
    expect(PICKER_MODES).toEqual(["general", "technical", "interviewer", "interviewee", "partner", "negotiation", "learning", "social", "passive", "notes"]);
    const candidate = MODE_PROFILES.interviewee;
    expect(candidate).toMatchObject({ id: "interviewee", label: "Candidate", short: "CAND", askLabel: "PREP", picker: true, selfQuestions: "ignore" });
    expect(candidate.blurb).not.toMatch(/legacy/iu);
    expect(candidate.blurb.length).toBeGreaterThan(30);
    expect(candidate.presets).toMatchObject({ autoAnswer: true, implicitAsks: false, suggestions: true, summarize: true, responseStrategy: "reactive" });
    // No two picker modes share a glasses tag.
    expect(new Set(PICKER_MODES.map(mode => MODE_PROFILES[mode].short)).size).toBe(PICKER_MODES.length);
  });
  it("keeps the stored id and the legacy interview alias working", () => {
    expect(normalizeConversationMode("interviewee")).toBe("interviewee");
    expect(normalizeConversationMode("interview")).toBe("interviewee");
    expect(modeProfile("interviewee").label).toBe("Candidate");
  });
  it("answers as the candidate in the first person, from saved knowledge, without inventing experience", () => {
    const prompt = modeSystemPrompt("Base.", "interviewee", "reactive");
    expect(prompt).toContain("Protected conversation mode: interviewee.");
    expect(prompt).toMatch(/wearer is the CANDIDATE/u);
    expect(prompt).toMatch(/first person/u);
    expect(prompt).toMatch(/direct answer first/u);
    expect(prompt).toMatch(/saved knowledge/u);
    expect(prompt).toMatch(/situation, action, result/u);
    expect(prompt).toMatch(/Never invent experience, employers, numbers or titles/u);
    expect(prompt).toMatch(/what to cover/u);
  });
  it("copilot: tracks the interviewer, splits suggestions into the two kinds and summarises the interview", () => {
    const settings = { ...DEFAULT_COPILOT_SETTINGS, mode: "interviewee" };
    const text = copilotInstructions(settings);
    expect(text).toContain("Conversation mode: Candidate.");
    expect(text).toMatch(/other speaker is the interviewer/u);
    expect(text).toMatch(/evaluating/u);
    expect(text).toContain(`kind "they-ask"`);
    expect(text).toContain(`kind "ask-them"`);
    expect(text).toMatch(/questions the interviewer asked, how each answer went, follow-ups the wearer owes and next steps/u);
    expect(SUGGESTION_KIND_LABELS).toEqual({ "they-ask": "They may ask", "ask-them": "Ask them" });
    const item = (copilotSchema(settings).properties as { suggestedQuestions: { items: { properties: Record<string, unknown>; required: string[] } } }).suggestedQuestions.items;
    expect(item.properties.kind).toEqual({ type: "string", enum: ["they-ask", "ask-them"] });
    expect(item.required).toContain("kind");
    // Other modes keep the two-field suggestion schema.
    const meeting = (copilotSchema({ ...DEFAULT_COPILOT_SETTINGS }).properties as { suggestedQuestions: { items: { properties: Record<string, unknown> } } }).suggestedQuestions.items;
    expect(Object.keys(meeting.properties)).toEqual(["question", "why"]);
  });
  it("live: the interviewer's question gets a candidate answer; the wearer's own question is not answered", async () => {
    const h = harness({ mode: "interviewee" });
    await h.client.start(base, { openai: "k" });
    await h.transport.injectTranscript("What questions do you have about the team's roadmap?", SELF_SPEAKER);
    await settle();
    expect(h.bodies).toHaveLength(0);
    await h.transport.injectTranscript("Can you tell me about a time you led a difficult migration?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    expect(h.bodies[0]!.instructions).toContain(MODE_PROFILES.interviewee.answer);
    expect(h.bodies[0]!.input).not.toContain(ANSWER_KEY_PREFIX);
    await h.client.dispose();
  });
});

describe("rules that survive a user-edited mode prompt", () => {
  it("Interviewer keeps the fairness rule whatever the custom prompt says", () => {
    const prompt = modeSystemPrompt("Base.", "interviewer", "reactive", "Only tell me jokes about the candidate.");
    expect(prompt).toContain("Only tell me jokes about the candidate.");
    expect(prompt).not.toContain(MODE_PROFILES.interviewer.answer);
    expect(prompt).toMatch(/never comment on age, gender, race, religion, disability, family, nationality, accent or other protected characteristics/u);
    expect(prompt.indexOf("protected characteristics")).toBeGreaterThan(prompt.indexOf("Only tell me jokes"));
    // The rule sits in the protected mode paragraph, before the strategy paragraph.
    expect(prompt.indexOf("protected characteristics")).toBeLessThan(prompt.indexOf("Protected response strategy"));
  });
  it("Candidate keeps the no-invented-experience rule; a 4000-character prompt cannot push it out", () => {
    const prompt = modeSystemPrompt("Base.", "interviewee", "reactive", "x".repeat(6000));
    expect(prompt).toMatch(/Never invent experience, employers, numbers or titles/u);
    expect(prompt).toContain("x".repeat(4000));
    expect(prompt).not.toContain("x".repeat(4001));
  });
  it("the built-in prompts state each rule once; other modes get nothing appended", () => {
    expect(modeSystemPrompt("Base.", "interviewer", "reactive").match(/protected characteristics/gu)).toHaveLength(1);
    expect(modeSystemPrompt("Base.", "interviewee", "reactive").match(/Never invent experience/gu)).toHaveLength(1);
    expect(modeSystemPrompt("Base.", "technical", "reactive", "Mine.")).toContain("Protected conversation mode: technical. Mine.\n\n");
    expect(MODE_PROFILES.technical.guard).toBeUndefined();
  });
  it("live: a custom Interviewer prompt still carries the fairness rule to the provider", async () => {
    const h = harness({ mode: "interviewer", custom: "Be blunt." });
    await h.client.start(base, { openai: "k" });
    await h.transport.injectTranscript("What does the on-call rotation look like for this team?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(h.bodies).toHaveLength(1));
    expect(h.bodies[0]!.instructions).toContain("Be blunt.");
    expect(h.bodies[0]!.instructions).toMatch(/protected characteristics/u);
    await h.client.dispose();
  });
});

describe("answer key versus the sentence limit", () => {
  it("the key never asks for more sentences than the limit allows, at every length and session limit", () => {
    expect(ANSWER_KEY_SENTENCES).toBe(3);
    for (const length of ANSWER_LENGTHS) {
      for (const sessionLimit of [undefined, 1, 2, 3, 6, 10]) {
        expect(answerSentenceLimit(length, sessionLimit, true)).toBeGreaterThanOrEqual(ANSWER_KEY_SENTENCES);
        // Ordinary answers are unchanged.
        expect(answerSentenceLimit(length, sessionLimit)).toBe(answerSentenceLimit(length, sessionLimit, false));
      }
      const key = answerKeyInput("How did you scale it?", length);
      expect(key.startsWith(ANSWER_KEY_PREFIX)).toBe(true);
      for (const label of [`"Strong answer:"`, `"Probe:"`, `"Flag:"`]) expect(key).toContain(label);
      expect(key).toMatch(/exactly three short labelled sentences/u);
      expect(key).toMatch(/sentence limit[^.]*does not apply/u);
    }
    expect(answerSentenceLimit("brief", 3)).toBe(2);
    expect(answerSentenceLimit("brief", 3, true)).toBe(3);
    expect(answerSentenceLimit("detailed", 3, true)).toBe(6);
  });
  it("Brief shrinks the parts of the key, Detailed widens them; Standard keeps the 2-4 points", () => {
    expect(answerKeyInput("Q?", "brief")).toMatch(/the 2 most important points/u);
    expect(answerKeyInput("Q?", "brief")).toMatch(/a few words/u);
    expect(answerKeyInput("Q?", "standard")).toMatch(/the 2-4 points a strong answer covers/u);
    expect(answerKeyInput("Q?")).toBe(answerKeyInput("Q?", "standard"));
    expect(answerKeyInput("Q?", "detailed")).toMatch(/the 4-6 points/u);
    expect(answerKeyInput("Q?", "nonsense")).toBe(answerKeyInput("Q?", "standard"));
  });
  it("live: at Brief the interviewer's answer key request is consistent (three sentences, brief parts)", async () => {
    const h = harness({ mode: "interviewer", length: "brief" });
    await h.client.start(base, { openai: "k" });
    await h.transport.injectTranscript("How did you scale the ingestion pipeline to ten billion events a day?", SELF_SPEAKER);
    await vi.waitFor(() => expect(h.bodies).toHaveLength(1));
    expect(h.bodies[0]!.instructions).toContain("Respond in at most 3 sentences.");
    expect(h.bodies[0]!.input).toContain("the 2 most important points");
    // The candidate's question is an ordinary answer: the Brief cap of 2 still applies.
    await h.transport.injectTranscript("What does the on-call rotation look like for this team?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(h.bodies).toHaveLength(2));
    expect(h.bodies[1]!.instructions).toContain("Respond in at most 2 sentences.");
    await h.client.dispose();
  });
});
