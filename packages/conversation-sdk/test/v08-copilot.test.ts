import { describe, expect, it, vi } from "vitest";
import { ConversationCopilot } from "../src/copilot.js";
import { DirectConversationTransport } from "../src/direct-transport.js";
import { HelixConversationClient } from "../src/client.js";
import {
  DEFAULT_COPILOT_SETTINGS, type CopilotCallbacks, type CopilotClaim, type CopilotConcept, type CopilotPerson, type CopilotSettings,
  type CopilotTransport, type SessionConfig, type VerificationResult,
} from "../src/index.js";

const message = (text: string) => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 400, output_tokens: 90 } });
const verdict = (status: string, summary: string) => ({ status: "completed", output: [{ type: "web_search_call", status: "completed" }, { type: "message", content: [{ type: "output_text", text: JSON.stringify({ status, summary }), annotations: [{ type: "url_citation", url: "https://example.com/spec", title: "Spec", start_index: 0, end_index: 4 }] }] }] });
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
type Body = { text?: { format: { schema: { properties: Record<string, unknown> } } }; input: string; instructions: string; tool_choice?: string };
const empty = { summary: { bullets: [], keyFacts: [] }, concepts: [], conflicts: [], suggestedQuestions: [], asks: [], claims: [], people: [] };

function harness(responses: Record<string, unknown>[], settings: Partial<CopilotSettings> = {}, enabled = () => true) {
  const claims: CopilotClaim[] = [], people: CopilotPerson[] = [], concepts: CopilotConcept[] = [], verifications: VerificationResult[] = [];
  const bodies: Body[] = [];
  let call = 0;
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(init!.body as string) as Body; bodies.push(body);
    if (body.tool_choice === "required") return Response.json(verdict("supported", "Matches the published spec."));
    return Response.json(message(JSON.stringify({ ...empty, ...(responses[call++] ?? {}) })));
  });
  const callbacks: CopilotCallbacks = {
    enabled, settings: () => ({ ...DEFAULT_COPILOT_SETTINGS, ...settings }),
    onClaim: c => claims.push(c), onPerson: p => people.push(p), onConcept: c => concepts.push(c), onVerification: v => verifications.push(v),
  };
  const copilot = new ConversationCopilot({ fetch, key: "k", sessionId: "s", callbacks, cooldownMs: 0 });
  const analyses = () => bodies.filter(b => b.text);
  return { copilot, fetch, claims, people, concepts, verifications, bodies, analyses };
}

describe("copilot claims", () => {
  it("emits grounded claims with speaker/transcript attribution, rejects ungrounded or bad scope, dedupes per session", async () => {
    let open = false;
    const h = harness([
      { claims: [
        { text: "Jetson Orin has 64 GB of memory", speaker: "Model guess", scope: "public" },
        { text: "We will ship on March 3", speaker: "You", scope: "conversation" },
        { text: "The budget is $90k", speaker: "Bob", scope: "public" },
        { text: "Jetson Orin has 64 GB of memory", speaker: "Bob", scope: "maybe" },
      ] },
      { claims: [{ text: "jetson orin has 64GB of memory!", speaker: "Bob", scope: "public" }, { text: "The price is $1999 per unit", speaker: "Bob", scope: "public" }] },
    ], {}, () => open);
    // Both lines land in one analysis run.
    h.copilot.submit("t1", "Jetson Orin has 64 GB of memory.", { label: "Bob", role: "other" });
    h.copilot.submit("t2", "We will ship on March 3.", { label: "You", role: "self" });
    open = true; h.copilot.runNow();
    await settle();
    expect(h.claims).toHaveLength(2);
    expect(h.claims[0]).toMatchObject({ text: "Jetson Orin has 64 GB of memory", speaker: "Bob", transcriptId: "t1", scope: "public" });
    expect(h.claims[1]).toMatchObject({ text: "We will ship on March 3", speaker: "You", transcriptId: "t2", scope: "conversation" });
    h.copilot.submit("t3", "Jetson Orin has 64 GB of memory. The price is $1999 per unit.", { label: "Bob", role: "other" });
    await settle();
    expect(h.claims.map(c => c.text)).toEqual(["Jetson Orin has 64 GB of memory", "We will ship on March 3", "The price is $1999 per unit"]);
    expect(h.copilot.claims).toHaveLength(3);
    // Known claims are sent back so the model skips them; still one request per run.
    expect(JSON.parse(h.analyses()[1]!.input).knownClaims).toEqual(["Jetson Orin has 64 GB of memory", "We will ship on March 3"]);
    expect(h.analyses()).toHaveLength(2);
  });
  it("omits claims and people from schema, prompt and output when disabled", async () => {
    const h = harness([{ claims: [{ text: "Orin has 64 GB", speaker: "Bob", scope: "public" }], people: [{ name: "Elaine", role: "", context: "x" }] }], { claims: false, people: false });
    h.copilot.submit("t1", "Orin has 64 GB. Elaine agreed.", { label: "Bob", role: "other" });
    await settle();
    const body = h.analyses()[0]!;
    expect(Object.keys(body.text!.format.schema.properties)).not.toContain("claims");
    expect(Object.keys(body.text!.format.schema.properties)).not.toContain("people");
    expect(body.instructions).not.toMatch(/^claims:|^people:/mu);
    expect(JSON.parse(body.input).knownClaims).toBeUndefined();
    expect(h.claims).toEqual([]); expect(h.people).toEqual([]);
  });
});

describe("copilot people", () => {
  it("accepts only grounded person names and rejects invented, generic, team or speaker-label entries", async () => {
    const h = harness([{ people: [
      { name: "Elaine", role: "head of robotics", context: "Owns the Jetson purchase." },
      { name: "Marcus", role: "", context: "Invented." },
      { name: "Finance", role: "", context: "A team." },
      { name: "Other speaker", role: "", context: "Label." },
      { name: "You", role: "", context: "Wearer." },
      { name: "elaine", role: "", context: "duplicate lowercase" },
      { name: "R2D2", role: "", context: "digits" },
      { name: "Bob", role: "vendor rep", context: "Speaking." },
    ] }]);
    h.copilot.submit("t1", "Elaine, our head of robotics, owns the Jetson purchase. Finance needs the quote.", { label: "Bob", role: "other" });
    await settle();
    expect(h.people.map(p => p.name)).toEqual(["Elaine", "Bob"]);
    expect(h.people[0]).toMatchObject({ role: "head of robotics", context: "Owns the Jetson purchase.", mentions: 1 });
    expect(h.people[0]!.firstSeen).toBe(h.people[0]!.lastSeen);
  });
  it("upserts by normalized name across runs: mentions, lastSeen, context and first-name merge", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-08T10:00:00Z"));
      const h = harness([
        { people: [{ name: "Elaine", role: "", context: "Owns the purchase." }] },
        { people: [{ name: "Elaine Chen", role: "head of robotics", context: "Approved the budget." }] },
        { people: [{ name: "ELAINE CHEN", role: "", context: "" }] },
      ]);
      h.copilot.submit("t1", "Elaine owns the purchase.");
      await settle();
      vi.setSystemTime(new Date("2026-11-08T10:05:00Z"));
      h.copilot.submit("t2", "Elaine Chen, head of robotics, approved the budget.");
      await settle();
      h.copilot.submit("t3", "Thanks Elaine Chen.");
      await settle();
      expect(h.people).toHaveLength(3);
      expect(new Set(h.people.map(p => p.id)).size).toBe(1);
      expect(h.people[1]).toMatchObject({ name: "Elaine Chen", role: "head of robotics", context: "Approved the budget.", mentions: 2, firstSeen: "2026-11-08T10:00:00.000Z", lastSeen: "2026-11-08T10:05:00.000Z" });
      expect(h.people[2]).toMatchObject({ name: "Elaine Chen", role: "head of robotics", context: "Approved the budget.", mentions: 3 });
      expect(h.copilot.people).toEqual([h.people[2]]);
      expect(JSON.parse(h.analyses()[2]!.input).knownPeople).toEqual([{ name: "Elaine Chen", role: "head of robotics" }]);
    } finally { vi.useRealTimers(); }
  });
  it("accepts a named speaker label and CJK names that appear in the text; rejects concept terms", async () => {
    const h = harness([
      { concepts: [{ term: "Orin", explanation: "An NVIDIA module." }], people: [{ name: "Priya", role: "", context: "Asked about pricing." }, { name: "王伟", role: "采购", context: "负责采购" }, { name: "Orin", role: "", context: "?" }] },
    ]);
    h.copilot.submit("t1", "王伟负责采购。 How much does Orin cost?", { label: "Priya", role: "other" });
    await settle();
    expect(h.people.map(p => p.name)).toEqual(["Priya", "王伟"]);
  });
  it("asks for wearer-phrased suggestions: lines to say in Meeting (v0.16), questions to ask in the question modes", async () => {
    const h = harness([{}]);
    h.copilot.submit("t1", "Our lead time is long.");
    await settle();
    expect(h.analyses()[0]!.instructions).toMatch(/lines the WEARER can say next, each written to be read aloud word for word/);
    expect(h.analyses()[0]!.instructions).toMatch(/never invent or complete a name/);
  });
});

describe("verification of claims and concepts", () => {
  it("verifyClaim looks up the stored claim, uses its speech as context and returns a sourced result with the claim id", async () => {
    const h = harness([{ claims: [{ text: "Jetson Orin has 64 GB of memory", speaker: "Bob", scope: "public" }] }]);
    expect(h.copilot.verifyClaim("missing")).toBe(false);
    h.copilot.submit("t1", "Jetson Orin has 64 GB of memory.", { label: "Bob", role: "other" });
    h.copilot.submit("t2", "Unrelated later speech.", { label: "Ann", role: "other" });
    await settle();
    const claim = h.claims[0]!;
    expect(h.copilot.verifyClaim(claim.id)).toBe(true);
    await settle();
    const request = h.bodies.find(b => b.tool_choice === "required")!;
    const input = JSON.parse(request.input);
    expect(input.claim).toBe("Jetson Orin has 64 GB of memory");
    expect(input.earlierSpeech).toContain("Bob: Jetson Orin has 64 GB of memory.");
    expect(request.instructions).not.toMatch(/term definition/);
    expect(h.verifications).toEqual([expect.objectContaining({ id: claim.id, target: claim.text, status: "supported", requestedBy: "user", sources: [{ url: "https://example.com/spec", title: "Spec" }] })]);
  });
  it("verifies a concept as a definition (by stored id or 'TERM: explanation') and returns a sourced VerificationResult", async () => {
    const h = harness([{ concepts: [{ term: "CDTF", explanation: "A camera distortion test fixture format." }] }]);
    h.copilot.submit("t1", "We calibrate with CDTF.");
    await settle();
    const concept = h.concepts[0]!;
    h.copilot.verify(`${concept.term}: ${concept.explanation}`, concept.id);
    await settle();
    h.copilot.verify("NVMe: a storage interface protocol for SSDs");
    await settle();
    h.copilot.verify("Budget: $40k");
    await settle();
    const checks = h.bodies.filter(b => b.tool_choice === "required");
    expect(checks).toHaveLength(3);
    expect(checks[0]!.instructions).toMatch(/term definition/); expect(checks[1]!.instructions).toMatch(/term definition/);
    expect(checks[2]!.instructions).not.toMatch(/term definition/);
    expect(JSON.parse(checks[0]!.input).claim).toBe("CDTF: A camera distortion test fixture format.");
    expect(h.verifications[0]).toMatchObject({ id: concept.id, target: "CDTF: A camera distortion test fixture format.", status: "supported", sources: [{ url: "https://example.com/spec", title: "Spec" }] });
  });
});

describe("DirectConversationTransport.verifyClaim", () => {
  const config: SessionConfig = {
    sessionId: "v08-claims", endpoint: { id: "openai-direct", url: "https://api.openai.com/v1/responses", provider: "openai", model: "gpt-6.1-terra" },
    prompt: { id: "p", version: "1", system: "Be brief." }, providers: { transcriptionProvider: "openai-transcribe", answerProvider: "openai-responses" },
    speaker: { label: "G2 conversation", role: "unknown" }, automation: { detectQuestions: false, answerQuestions: false, saveNotes: false },
  };
  it("forwards onClaim/onPerson through the transport and verifies a claim by id; unknown ids return false", async () => {
    const claims: CopilotClaim[] = [], people: CopilotPerson[] = [], verifications: VerificationResult[] = [];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(init!.body as string);
      if (body.tool_choice === "required") return Response.json(verdict("contradicted", "Orin AGX ships with 32 or 64 GB."));
      return Response.json(message(JSON.stringify({ ...empty, claims: [{ text: "Orin AGX only has 16 GB", speaker: "Bob", scope: "public" }], people: [{ name: "Elaine", role: "", context: "Buyer." }] })));
    });
    const transport = new DirectConversationTransport({ fetch: fetcher, copilot: {
      enabled: () => true, settings: () => DEFAULT_COPILOT_SETTINGS,
      onClaim: c => claims.push(c), onPerson: p => people.push(p), onVerification: v => verifications.push(v),
    } });
    const contract: CopilotTransport = transport;
    expect(contract.verifyClaim?.("nothing")).toBe(false);
    const client = new HelixConversationClient(transport, { vad: false });
    await client.start(config, { openai: "k" });
    await transport.injectTranscript("Orin AGX only has 16 GB, Elaine said.", { label: "Bob", role: "other" });
    await vi.waitFor(() => expect(claims).toHaveLength(1));
    expect(people.map(p => p.name)).toEqual(["Elaine"]);
    expect(transport.verifyClaim("nope")).toBe(false);
    expect(transport.verifyClaim(claims[0]!.id)).toBe(true);
    await vi.waitFor(() => expect(verifications).toHaveLength(1));
    expect(verifications[0]).toMatchObject({ id: claims[0]!.id, status: "contradicted", sources: [{ url: "https://example.com/spec", title: "Spec" }] });
    await client.dispose();
    expect(transport.verifyClaim(claims[0]!.id)).toBe(false);
  });
});
