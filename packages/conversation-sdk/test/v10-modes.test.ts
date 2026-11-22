import { describe, expect, it, vi } from "vitest";
import { DirectConversationTransport } from "../src/direct-transport.js";
import { HelixConversationClient } from "../src/client.js";
import { copilotInstructions } from "../src/copilot.js";
import {
  ANSWER_KEY_PREFIX, CONVERSATION_MODES, DEFAULT_COPILOT_SETTINGS, MODE_PROFILES, OTHER_SPEAKER, PICKER_MODES, SELF_SPEAKER, modeProfile, modeSystemPrompt,
  type ConversationMode, type GatewayEvent, type SessionConfig,
} from "../src/index.js";

const base: SessionConfig = {
  sessionId: "v10", endpoint: { id: "openai-direct", url: "https://api.openai.com/v1/responses", provider: "openai", model: "gpt-6.1-terra" },
  prompt: { id: "p", version: "1", system: "Be brief.", maxResponseSentences: 3 },
  providers: { transcriptionProvider: "openai-transcribe", answerProvider: "openai-responses" },
  speaker: { label: "G2 conversation", role: "unknown" }, mode: "general", responseStrategy: "reactive", locale: "en-US",
  automation: { detectQuestions: true, answerQuestions: true, saveNotes: false }, memory: { readOmiContext: false, syncNotes: false },
};
const sse = (text: string) => new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\ndata: {"type":"response.completed"}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
const ofType = <T extends GatewayEvent["type"]>(events: GatewayEvent[], type: T) => events.filter((e): e is Extract<GatewayEvent, { type: T }> => e.type === type);
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

function harness(live: { mode?: ConversationMode; answerQuestions?: boolean } = {}) {
  const bodies: { instructions: string; input: string }[] = [];
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    bodies.push({ instructions: String(body.instructions ?? ""), input: JSON.stringify(body.input ?? body.messages ?? "") });
    return sse("Strong answer: ownership; numbers. Probe: what broke? Flag: vague team credit.");
  });
  const transport = new DirectConversationTransport({ fetch: fetcher, mode: () => live.mode, automation: () => live.answerQuestions === undefined ? undefined : { answerQuestions: live.answerQuestions } });
  const client = new HelixConversationClient(transport);
  const events: GatewayEvent[] = [];
  client.subscribe(event => events.push(event));
  return { transport, client, events, bodies, live };
}

describe("v0.10 mode profiles", () => {
  it("covers every protocol mode; the picker lists the user modes with short glasses tags", () => {
    for (const mode of CONVERSATION_MODES) expect(MODE_PROFILES[mode].id).toBe(mode);
    expect(PICKER_MODES).toEqual(["general", "technical", "interviewer", "partner", "negotiation", "learning", "social", "passive", "notes"]);
    for (const mode of PICKER_MODES) {
      const profile = MODE_PROFILES[mode];
      expect(profile.picker).toBe(true);
      expect(profile.short.length).toBeLessThanOrEqual(6);
      expect(profile.askLabel.length).toBeLessThanOrEqual(9);
    }
    expect(MODE_PROFILES.interviewee.picker).toBe(false);
    expect(modeProfile("nonsense").id).toBe("general");
    expect(modeProfile(undefined).id).toBe("general");
  });
  it("partner mode turns off fact-checking style features and auto-answers; quiet keeps only the summary", () => {
    expect(MODE_PROFILES.partner.presets).toMatchObject({ concepts: false, conflicts: false, claims: false, webGrounding: false, implicitAsks: false, autoAnswer: false, summarize: true, suggestions: true });
    expect(MODE_PROFILES.passive.presets).toMatchObject({ summarize: true, suggestions: false, concepts: false, autoAnswer: false });
    expect(MODE_PROFILES.technical.presets).toMatchObject({ concepts: true, claims: true, implicitAsks: true, autoAnswer: true });
  });
  it("answer prompts carry the mode; the interviewer prompt forbids protected-characteristic judgements", () => {
    expect(modeSystemPrompt("Base.", "technical", "reactive")).toContain(MODE_PROFILES.technical.answer);
    const interviewer = modeSystemPrompt("Base.", "interviewer", "reactive");
    expect(interviewer).toMatch(/INTERVIEWER \(the wearer\), never the candidate/u);
    expect(interviewer).toMatch(/protected characteristics/u);
  });
  it("copilot instructions follow the mode: default meeting text, interviewer probes, partner check-ins", () => {
    const meeting = copilotInstructions({ ...DEFAULT_COPILOT_SETTINGS });
    expect(meeting).toContain("useful questions the WEARER could ask the other party next");
    expect(meeting).not.toContain("Conversation mode:");
    const interviewer = copilotInstructions({ ...DEFAULT_COPILOT_SETTINGS, mode: "interviewer" });
    expect(interviewer).toContain("follow-up probes the INTERVIEWER");
    expect(interviewer).toContain("candidate evidence");
    expect(interviewer).toMatch(/Never infer or mention protected characteristics/u);
    const partner = copilotInstructions({ ...DEFAULT_COPILOT_SETTINGS, mode: "partner" });
    expect(partner).toContain("gentle things the WEARER could say next");
    expect(partner).toContain("never suggest manipulative or dishonest lines");
    expect(copilotInstructions({ ...DEFAULT_COPILOT_SETTINGS, mode: "learning" })).toContain("At most 5; an empty list is fine");
  });
});

describe("v0.10 live modes in the phone transport", () => {
  it("Interviewer: the wearer's own question gets an answer key; the candidate's question gets a normal answer", async () => {
    const h = harness({ mode: "interviewer" });
    await h.client.start(base, { openai: "k" });
    await h.transport.injectTranscript("How did you scale the ingestion pipeline to ten billion events a day?", SELF_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(1));
    const key = h.bodies.find(body => body.input.includes(ANSWER_KEY_PREFIX));
    expect(key?.input).toContain("ten billion events a day");
    expect(key?.instructions).toContain(MODE_PROFILES.interviewer.answer);
    expect(ofType(h.events, "answer.completed")[0]!.questionId).toBe(ofType(h.events, "question.detected")[0]!.questionId);
    await h.transport.injectTranscript("What does the on-call rotation look like for this team?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed")).toHaveLength(2));
    expect(h.bodies.filter(body => body.input.includes(ANSWER_KEY_PREFIX))).toHaveLength(1);
    await h.client.dispose();
  });
  it("switching modes mid-session changes prompts and question handling without reconnecting", async () => {
    const h = harness({ mode: "general" });
    await h.client.start(base, { openai: "k" });
    await h.transport.injectTranscript("How did you scale the ingestion pipeline?", SELF_SPEAKER);
    await settle();
    expect(h.bodies).toHaveLength(0); // Meeting: the wearer's own questions are not answered.
    h.live.mode = "interviewer";
    await h.transport.injectTranscript("How did you scale the ingestion pipeline?", SELF_SPEAKER);
    await vi.waitFor(() => expect(h.bodies).toHaveLength(1));
    h.live.mode = "technical";
    await h.transport.injectTranscript("Which GPU does the detector run on?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(h.bodies).toHaveLength(2));
    expect(h.bodies[1]!.instructions).toContain(MODE_PROFILES.technical.answer);
    // The protocol-level session mode in event contexts stays as started.
    // (A newer question supersedes an answer still streaming, as before v0.10.)
    await vi.waitFor(() => expect(ofType(h.events, "answer.completed").length).toBeGreaterThan(0));
    expect(ofType(h.events, "answer.completed").at(-1)!.context.mode).toBe("general");
    await h.client.dispose();
  });
  it("a live automation override (Partner: no auto-answers) stops answers for the other party", async () => {
    const h = harness({ mode: "partner", answerQuestions: false });
    await h.client.start(base, { openai: "k" });
    await h.transport.injectTranscript("Do you want to get dinner on Friday?", OTHER_SPEAKER);
    await settle();
    expect(ofType(h.events, "question.detected")).toHaveLength(1);
    expect(h.bodies).toHaveLength(0);
    h.live.answerQuestions = true;
    await h.transport.injectTranscript("Do you want to get dinner on Saturday instead?", OTHER_SPEAKER);
    await vi.waitFor(() => expect(h.bodies).toHaveLength(1));
    expect(h.bodies[0]!.instructions).toContain(MODE_PROFILES.partner.answer);
    await h.client.dispose();
  });
});
