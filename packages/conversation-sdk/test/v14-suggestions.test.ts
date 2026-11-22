import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationCopilot, SUGGESTION_TTL_MS, suggestionMatchesSpeech } from "../src/copilot.js";
import { DEFAULT_COPILOT_SETTINGS, OTHER_SPEAKER, SELF_SPEAKER, type CopilotCallbacks, type CopilotSettings, type CopilotSuggestion, type CopilotSummary } from "../src/index.js";

const message = (text: string) => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 500, output_tokens: 100, output_tokens_details: { reasoning_tokens: 0 } } });
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const empty = { summary: { bullets: [], keyFacts: [] }, concepts: [], conflicts: [], suggestedQuestions: [], asks: [], claims: [], people: [] };
type Reply = string | Record<string, unknown>;
interface Input { newSpeech: string; earlierConversation: string; previousSuggestions: string[] }

/** Each analysis request takes the next reply; a string is sent as the raw model text (for malformed replies). */
function harness(replies: Reply[], settings: Partial<CopilotSettings> = {}) {
  const live: { settings: Partial<CopilotSettings> } = { settings };
  const emitted: CopilotSuggestion[][] = [], summaries: CopilotSummary[] = [], inputs: Input[] = [];
  let call = 0;
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string) as { input: string };
    inputs.push(JSON.parse(body.input) as Input);
    const reply = replies[call++] ?? {};
    return Response.json(message(typeof reply === "string" ? reply : JSON.stringify({ ...empty, ...reply })));
  });
  const callbacks: CopilotCallbacks = {
    enabled: () => true, settings: () => ({ ...DEFAULT_COPILOT_SETTINGS, implicitAsks: false, ...live.settings }),
    onSuggestions: items => emitted.push([...items]), onSummary: summary => summaries.push(summary),
  };
  const copilot = new ConversationCopilot({ fetch, key: "k", sessionId: "s", callbacks, cooldownMs: 0 });
  const last = () => emitted.at(-1) ?? [];
  return { copilot, fetch, emitted, summaries, inputs, live, last, questions: () => last().map(item => item.question) };
}
const LEAD = { question: "What lead time are you seeing for the Jetson boards?", why: "Pins down the schedule risk." };
const OWNER = { question: "Who approves the purchase request?", why: "The owner is unclear." };
const BUDGET = { question: "Is the forty thousand dollar budget already signed off?", why: "Confirms the number." };

afterEach(() => { vi.useRealTimers(); });

describe("suggestionMatchesSpeech", () => {
  it("matches the question said aloud with fillers, reordering and small wording changes", () => {
    expect(suggestionMatchesSpeech(LEAD.question, "So, um, what lead time are you seeing on Jetson boards right now?")).toBe(true);
    expect(suggestionMatchesSpeech(LEAD.question, "Okay. And for the Jetson board, what lead times do you see? Thanks.")).toBe(true);
    expect(suggestionMatchesSpeech(OWNER.question, "who approves the purchase request")).toBe(true);
  });
  it("does not match speech that only shares a topic word or two", () => {
    expect(suggestionMatchesSpeech(LEAD.question, "The Jetson boards arrived yesterday.")).toBe(false);
    expect(suggestionMatchesSpeech(LEAD.question, "What time is lunch?")).toBe(false);
    expect(suggestionMatchesSpeech(OWNER.question, "Finance approves nothing this quarter.")).toBe(false);
    expect(suggestionMatchesSpeech(LEAD.question, "")).toBe(false);
  });
  it("a question with fewer than two content words needs the whole sentence to be that question", () => {
    expect(suggestionMatchesSpeech("Why?", "Why?")).toBe(true);
    expect(suggestionMatchesSpeech("Why?", "That is why we moved the date.")).toBe(false);
  });
  it("handles text without spaces between words", () => {
    expect(suggestionMatchesSpeech("交货周期是多久？", "那交货周期是多久呢")).toBe(true);
    expect(suggestionMatchesSpeech("交货周期是多久？", "我们的预算很紧张")).toBe(false);
  });
});

describe("suggestion lifecycle", () => {
  it("marks a suggestion asked when the wearer says it, shows it as asked for one refresh, then drops it for good", async () => {
    const h = harness([
      { suggestedQuestions: [LEAD, OWNER] },
      { suggestedQuestions: [LEAD, OWNER] },
      { suggestedQuestions: [LEAD, OWNER, BUDGET] },
      { suggestedQuestions: [LEAD, BUDGET] },
      { suggestedQuestions: [{ question: "What lead times do you see for Jetson boards?", why: "Reworded." }, BUDGET] },
    ]);
    h.copilot.submit("t1", "Jetson boards are hard to order right now.", OTHER_SPEAKER);
    await settle();
    expect(h.questions()).toEqual([LEAD.question, OWNER.question]);
    expect(h.last().every(item => item.askedAt === undefined)).toBe(true);
    const leadId = h.last()[0]!.id;

    // The other party saying it is not the wearer asking it.
    h.copilot.submit("t2", "What lead time are you seeing for the Jetson boards?", OTHER_SPEAKER);
    await settle();
    expect(h.last().find(item => item.id === leadId)?.askedAt).toBeUndefined();

    const before = h.emitted.length;
    h.copilot.submit("t3", "So what lead time are you seeing on the Jetson boards right now?", SELF_SPEAKER);
    // Marked at once, before the next analysis returns.
    expect(h.emitted).toHaveLength(before + 1);
    const asked = h.last().find(item => item.id === leadId)!;
    expect(Number.isNaN(Date.parse(asked.askedAt!))).toBe(false);
    expect(h.copilot.suggestions.find(item => item.id === leadId)?.askedAt).toBe(asked.askedAt);
    await settle();
    // Refresh 3: still listed once, as asked, after the open ones.
    expect(h.questions()).toEqual([OWNER.question, BUDGET.question, LEAD.question]);
    expect(h.last().at(-1)).toMatchObject({ id: leadId, askedAt: asked.askedAt });
    // The model is told only about open suggestions.
    expect(h.inputs.at(-1)!.previousSuggestions).not.toContain(LEAD.question);

    h.copilot.submit("t4", "Sure, about twelve weeks.", OTHER_SPEAKER);
    await settle();
    // Refresh 4: the asked one is gone although the model proposed it again.
    expect(h.questions()).toEqual([BUDGET.question]);

    h.copilot.submit("t5", "Okay.", OTHER_SPEAKER);
    await settle();
    // A reworded copy of an asked question never comes back in this session.
    expect(h.questions()).toEqual([BUDGET.question]);
  });
  it("drops an asked suggestion after one refresh even when the model returns no new list", async () => {
    const h = harness([{ suggestedQuestions: [LEAD, OWNER] }, {}, {}]);
    h.copilot.submit("t1", "Jetson boards are hard to order right now.", OTHER_SPEAKER);
    await settle();
    h.copilot.submit("t2", "Who approves the purchase request?", SELF_SPEAKER);
    await settle();
    expect(h.last().map(item => [item.question, item.askedAt !== undefined])).toEqual([[LEAD.question, false], [OWNER.question, true]]);
    h.copilot.submit("t3", "Elaine does.", OTHER_SPEAKER);
    await settle();
    expect(h.questions()).toEqual([LEAD.question]);
  });
  it("Candidate: labels the two kinds in why and matches each against the right speaker", async () => {
    const expectQ = { question: "Why do you want to leave your current role?", why: "Motivation.", kind: "they-ask" };
    const askQ = { question: "How is success measured in the first ninety days?", why: "Shows you care about impact.", kind: "ask-them" };
    const h = harness([{ suggestedQuestions: [expectQ, askQ, { question: "What is the team size?", why: "They may ask: Context.", kind: "bogus" }] }], { mode: "interviewee" });
    h.copilot.submit("t1", "Thanks for coming in today.", OTHER_SPEAKER);
    await settle();
    expect(h.last().map(item => [item.kind, item.why])).toEqual([
      ["they-ask", "They may ask: Motivation."],
      ["ask-them", "Ask them: Shows you care about impact."],
      ["ask-them", "Ask them: Context."],
    ]);
    // The wearer saying the interviewer's likely question does not count; the interviewer asking it does.
    h.copilot.submit("t2", "Why do I want to leave my current role?", SELF_SPEAKER);
    expect(h.last()[0]!.askedAt).toBeUndefined();
    h.copilot.submit("t3", "So why do you want to leave your current role?", OTHER_SPEAKER);
    expect(h.last().find(item => item.kind === "they-ask")?.askedAt).toBeDefined();
    // The candidate's own question is matched against the wearer only.
    h.copilot.submit("t4", "How is success measured in the first ninety days?", OTHER_SPEAKER);
    expect(h.last().find(item => item.question === askQ.question)?.askedAt).toBeUndefined();
    h.copilot.submit("t5", "How is success measured in the first ninety days?", SELF_SPEAKER);
    expect(h.last().find(item => item.question === askQ.question)?.askedAt).toBeDefined();
    await settle();
  });
  it("other modes carry no kind and leave why untouched; an unattributed speaker can ask either kind", async () => {
    const h = harness([{ suggestedQuestions: [{ ...LEAD, kind: "they-ask" }] }]);
    h.copilot.submit("t1", "Jetson boards are hard to order right now.");
    await settle();
    expect(h.last()[0]).not.toHaveProperty("kind");
    expect(h.last()[0]!.why).toBe(LEAD.why);
    h.copilot.submit("t2", "What lead time are you seeing for the Jetson boards?", "Speaker 2");
    expect(h.last()[0]!.askedAt).toBeDefined();
    await settle();
  });
  it("expires suggestions the model has not proposed for about three minutes, without waiting for speech", async () => {
    vi.useFakeTimers();
    const h = harness([{ suggestedQuestions: [LEAD, OWNER] }, { suggestedQuestions: [LEAD] }, {}]);
    expect(SUGGESTION_TTL_MS).toBe(180_000);
    h.copilot.submit("t1", "Jetson boards are hard to order right now.", OTHER_SPEAKER);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.questions()).toEqual([LEAD.question, OWNER.question]);
    const leadId = h.last()[0]!.id;
    await vi.advanceTimersByTimeAsync(100_000);
    h.copilot.submit("t2", "We might need a second supplier.", OTHER_SPEAKER);
    await vi.advanceTimersByTimeAsync(10);
    // Proposed again: same item, its clock restarts.
    expect(h.last().map(item => item.id)).toEqual([leadId]);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.questions()).toEqual([LEAD.question]);
    const count = h.emitted.length;
    await vi.advanceTimersByTimeAsync(81_000);
    expect(h.emitted).toHaveLength(count + 1);
    expect(h.last()).toEqual([]);
    expect(h.copilot.suggestions).toEqual([]);
  });
  it("an old list is not kept alive by a refresh that returns no suggestions", async () => {
    vi.useFakeTimers();
    const h = harness([{ suggestedQuestions: [LEAD] }, {}]);
    h.copilot.submit("t1", "Jetson boards are hard to order right now.", OTHER_SPEAKER);
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(170_000);
    h.copilot.submit("t2", "Anyway.", OTHER_SPEAKER);
    await vi.advanceTimersByTimeAsync(10);
    expect(h.questions()).toEqual([LEAD.question]);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(h.last()).toEqual([]);
  });
  it("clears the list when the mode changes and does not offer the old mode's questions to the model", async () => {
    const h = harness([{ suggestedQuestions: [LEAD, OWNER] }, { suggestedQuestions: [BUDGET] }], { mode: "general" });
    h.copilot.submit("t1", "Jetson boards are hard to order right now.", OTHER_SPEAKER);
    await settle();
    expect(h.questions()).toEqual([LEAD.question, OWNER.question]);
    h.live.settings = { mode: "technical" };
    h.copilot.submit("t2", "The budget is forty thousand dollars.", OTHER_SPEAKER);
    expect(h.last()).toEqual([]);
    await settle();
    expect(h.inputs[1]!.previousSuggestions).toEqual([]);
    expect(h.questions()).toEqual([BUDGET.question]);
  });
  it("cancel stops the expiry timer", async () => {
    vi.useFakeTimers();
    const h = harness([{ suggestedQuestions: [LEAD] }]);
    h.copilot.submit("t1", "Jetson boards are hard to order right now.", OTHER_SPEAKER);
    await vi.advanceTimersByTimeAsync(10);
    const count = h.emitted.length;
    h.copilot.cancel();
    await vi.advanceTimersByTimeAsync(400_000);
    expect(h.emitted).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("copilot replies that are not valid JSON", () => {
  it("re-analyses the same speech on the next run instead of losing it", async () => {
    const h = harness(["{not json", { summary: { bullets: ["Jetson supply is tight."], keyFacts: [] } }]);
    h.copilot.submit("t1", "Jetson boards are hard to order right now.", OTHER_SPEAKER);
    await settle();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.inputs[1]!.newSpeech).toContain("Jetson boards are hard to order");
    expect(h.inputs[1]!.earlierConversation).toBe("");
    expect(h.summaries.map(summary => summary.bullets)).toEqual([["Jetson supply is tight."]]);
  });
  it("speech that arrives during the retry joins the same span", async () => {
    vi.useFakeTimers();
    const emitted: CopilotSummary[] = [], inputs: Input[] = [];
    let call = 0;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      inputs.push(JSON.parse((JSON.parse(init!.body as string) as { input: string }).input) as Input);
      return Response.json(message(call++ === 0 ? "[1,2]" : JSON.stringify({ ...empty, summary: { bullets: ["Both lines."], keyFacts: [] } })));
    });
    const copilot = new ConversationCopilot({ fetch, key: "k", sessionId: "s", cooldownMs: 1000,
      callbacks: { enabled: () => true, settings: () => ({ ...DEFAULT_COPILOT_SETTINGS }), onSummary: summary => emitted.push(summary) } });
    copilot.submit("t1", "First line about the budget.", OTHER_SPEAKER);
    await vi.advanceTimersByTimeAsync(10);
    expect(fetch).toHaveBeenCalledTimes(1);
    copilot.submit("t2", "Second line about the vendor.", OTHER_SPEAKER);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(inputs[1]!.newSpeech).toContain("First line about the budget.");
    expect(inputs[1]!.newSpeech).toContain("Second line about the vendor.");
    expect(emitted).toHaveLength(1);
    copilot.cancel();
  });
  it("gives up on a span after two retries, and a provider that stays bad gets one attempt per span", async () => {
    const h = harness(["{not json", "", "[]", "nope", "still bad", { summary: { bullets: ["Recovered."], keyFacts: [] } }, "bad again", "and again", "third"]);
    h.copilot.submit("t1", "Jetson boards are hard to order right now.", OTHER_SPEAKER);
    await settle();
    expect(h.fetch).toHaveBeenCalledTimes(3);
    h.copilot.submit("t2", "We might need a second supplier.", OTHER_SPEAKER);
    await settle();
    expect(h.fetch).toHaveBeenCalledTimes(4);
    expect(h.inputs[3]!.newSpeech).not.toContain("Jetson boards are hard to order");
    h.copilot.submit("t3", "Finance wants the quote by Friday.", OTHER_SPEAKER);
    await settle();
    expect(h.fetch).toHaveBeenCalledTimes(5);
    // A good reply restores the retry budget.
    h.copilot.submit("t4", "Elaine owns the purchase.", OTHER_SPEAKER);
    await settle();
    expect(h.fetch).toHaveBeenCalledTimes(6);
    expect(h.summaries).toHaveLength(1);
    h.copilot.submit("t5", "The demo is in March.", OTHER_SPEAKER);
    await settle();
    expect(h.fetch).toHaveBeenCalledTimes(9);
  });
});
