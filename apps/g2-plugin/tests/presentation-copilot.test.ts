import type { AnswerMeta, UsageRecord } from "@helix/conversation-sdk";
import { describe, expect, it } from "vitest";
import { ConversationPresentation } from "../src/presentation";

const usage = (id: string, kind: UsageRecord["kind"], costUsd?: number): UsageRecord => ({
  id, kind, model: "gpt-6-luna", inputTokens: 100, cachedInputTokens: 0, outputTokens: 20, reasoningTokens: 0,
  webSearchCalls: 0, audioSeconds: 0, ...(costUsd === undefined ? {} : { costUsd }), measured: true, at: "2026-11-07T00:00:00Z",
});
const concept = (id: string, term: string) => ({ id, term, explanation: `${term} explained`, createdAt: "2026-11-07T00:00:00Z", origin: "copilot" as const });

describe("ConversationPresentation copilot state", () => {
  it("dedupes concepts by term, bounds them and turns insights into concepts", () => {
    const p = new ConversationPresentation(); p.setStatus("listening");
    p.applyConcept(concept("c1", "CDTF"));
    p.applyConcept({ ...concept("c2", "cdtf"), explanation: "Updated" });
    expect(p.snapshot().concepts).toHaveLength(1);
    expect(p.snapshot().concepts[0]).toMatchObject({ term: "cdtf", explanation: "Updated" });
    p.applyInsight({ id: "i1", sessionId: "s", transcriptId: "t", term: "BEV", explanation: "Bird's-eye view.", createdAt: "2026-11-07T00:00:00Z" });
    expect(p.snapshot().concepts.at(-1)).toMatchObject({ id: "i1", origin: "insight", term: "BEV", transcriptId: "t" });
    for (let index = 0; index < 120; index++) p.applyConcept(concept(`x${index}`, `Term ${index}`));
    expect(p.snapshot().concepts).toHaveLength(100);
    expect(p.snapshot().concepts.at(-1)?.term).toBe("Term 119");
  });

  it("never pushes concepts or summaries to the glasses", () => {
    const p = new ConversationPresentation(); p.setStatus("listening");
    const before = p.snapshot().glasses;
    p.applyConcept(concept("c1", "CDTF"));
    p.applySummary({ bullets: ["A"], keyFacts: [], updatedAt: "2026-11-07T00:00:00Z", transcriptChars: 10 });
    p.setSuggestions([{ id: "s", question: "Why?", why: "", createdAt: "" }]);
    expect(p.snapshot().glasses).toEqual(before);
  });

  it("cues conflicts on the glasses only when eligible and idle", () => {
    const p = new ConversationPresentation(); p.setStatus("listening");
    const conflict = { id: "x", earlier: "six cameras", later: "three cameras", explanation: "Camera count changed", createdAt: "" };
    p.applyConflict(conflict);
    expect(p.snapshot().glasses.cue).toBeUndefined();
    p.applyConflict({ ...conflict, id: "y" }, true);
    expect(p.snapshot().glasses.cue).toEqual({ id: "y", text: "Conflict: Camera count changed" });
    p.beginRequest();
    p.applyConflict({ ...conflict, id: "z" }, true);
    expect(p.snapshot().glasses.cue).toBeUndefined();
    expect(p.snapshot().conflicts.map(item => item.id)).toEqual(["x", "y", "z"]);
    const stopped = new ConversationPresentation(); stopped.setStatus("stopped");
    stopped.applyConflict(conflict, true);
    expect(stopped.snapshot().glasses.cue).toBeUndefined();
  });

  it("upserts asks and verifications by id and tracks unseen counts per tab", () => {
    const p = new ConversationPresentation();
    p.applyAsk({ id: "k", kind: "lookup", topic: "Jetson lead time", trigger: "lead time", status: "pending", createdAt: "" });
    p.applyAsk({ id: "k", kind: "lookup", topic: "Jetson lead time", trigger: "lead time", status: "done", answer: "6–10 weeks", sources: [{ url: "https://example.com", title: "Ex" }], createdAt: "" });
    expect(p.snapshot().asks).toHaveLength(1);
    expect(p.snapshot().asks[0]).toMatchObject({ status: "done", answer: "6–10 weeks" });
    expect(p.snapshot().unseen.qa).toBe(2);
    expect(p.snapshot().peek).toMatchObject({ tab: "qa", kind: "ask", title: "Looking up · done" });
    p.applyVerification({ id: "v", target: "claim", status: "uncertain", summary: "", sources: [], checkedAt: "", requestedBy: "user" });
    p.applyVerification({ id: "v", target: "claim", status: "supported", summary: "ok", sources: [], checkedAt: "", requestedBy: "user" });
    expect(p.snapshot().verifications).toEqual([expect.objectContaining({ id: "v", status: "supported" })]);
    expect(p.snapshot().unseen.checks).toBe(2);
    p.markSeen("qa");
    expect(p.snapshot().unseen).toMatchObject({ qa: 0, checks: 2 });
    p.setSuggestions([{ id: "a", question: "A?", why: "", createdAt: "" }]);
    p.setSuggestions([{ id: "a", question: "A?", why: "", createdAt: "" }, { id: "b", question: "B?", why: "", createdAt: "" }]);
    expect(p.snapshot().unseen.qa).toBe(2);
    p.applySummary({ bullets: ["x"], keyFacts: [], updatedAt: "", transcriptChars: 1 });
    p.applySummary({ bullets: ["x"], keyFacts: [], updatedAt: "later", transcriptChars: 2 });
    expect(p.snapshot().unseen.summary).toBe(1);
    expect(p.snapshot().summary?.updatedAt).toBe("later");
  });

  it("totals usage once per record, counts unpriced records, and records answer latency", () => {
    const p = new ConversationPresentation();
    p.applyUsage(usage("u1", "copilot", 0.001));
    p.applyUsage(usage("u1", "copilot", 0.001));
    p.applyUsage(usage("u2", "answer"));
    const meta: AnswerMeta = { answerId: "a", grounded: "memory", sources: [], retrieval: { searchedEntries: 3, matched: 1, webUsed: false },
      timing: { speechMs: 0, queueMs: 0, generationMs: 900, endToEndMs: 1234 }, usage: usage("u3", "answer", 0.002) };
    p.applyAnswerMeta(meta);
    p.applyUsage(usage("u3", "answer", 0.002));
    const snapshot = p.snapshot();
    expect(snapshot.usage).toMatchObject({ requests: 3, unknownCostCount: 1, inputTokens: 300, outputTokens: 60 });
    expect(snapshot.usage.costUsd).toBeCloseTo(0.003);
    expect(snapshot.usage.byKind.answer).toMatchObject({ requests: 2, unknownCostCount: 1 });
    expect(snapshot.lastLatencyMs).toBe(1234);
    expect(snapshot.answerMeta.a?.retrieval.matched).toBe(1);
    p.reset();
    expect(p.snapshot()).toMatchObject({ concepts: [], asks: [], usage: { requests: 0 }, answerMeta: {} });
    expect(p.snapshot().lastLatencyMs).toBeUndefined();
  });

  it("keeps fact checks in the checks list with unsafe sources removed", () => {
    const p = new ConversationPresentation(); p.setStatus("listening");
    p.applyFactCheck({ id: "f", sessionId: "s", transcriptId: "t", claim: "c", status: "supported", summary: "s", checkedAt: "", sources: [{ url: "javascript:alert(1)", title: "bad" }, { url: "https://ok.example", title: "ok" }] });
    expect(p.snapshot().factChecks[0]?.sources).toEqual([{ url: "https://ok.example", title: "ok" }]);
    expect(p.snapshot().unseen.checks).toBe(1);
  });
});
