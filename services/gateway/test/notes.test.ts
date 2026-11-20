import type { NoteProvenance } from "@helix/conversation-sdk";
import { describe, expect, it } from "vitest";
import { evaluateAutomaticNote } from "../src/notes.js";

const provenance: NoteProvenance = {
  sessionId: "session-1",
  sourceEventId: "answer-1",
  sourceType: "answer",
  capturedAt: "2026-09-06T12:00:00.000Z",
  prompt: { id: "helix", version: "1" },
  endpoint: { id: "mock", url: "mock://local", provider: "mock", model: "mock" },
  speaker: { label: "User", role: "self" },
  latencyMs: { totalMs: 42 },
};

describe("evaluateAutomaticNote", () => {
  it("accepts a definite safe answer and preserves provenance", () => {
    const decision = evaluateAutomaticNote({
      id: "note-1",
      content: "The release gate requires build, unit tests, and a device smoke test.",
      provenance,
    });

    expect(decision).toEqual({
      accepted: true,
      proposal: {
        id: "note-1",
        text: "The release gate requires build, unit tests, and a device smoke test.",
        provenance,
      },
    });
  });

  it.each([
    ["Maybe the rollout starts Tuesday.", "uncertain"],
    ["api_key: sk-example123456789", "sensitive"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "sensitive"],
    ["What should the team ship next?", "question-like"],
    ["Sorry, something went wrong. Please try again.", "canned-error"],
    ["That sounds great and I hope the conversation goes well.", "not-useful"],
    ["The weather is pleasant today and everyone seems happy.", "not-useful"],
  ] as const)("rejects %s as %s", (content, reason) => {
    const decision = evaluateAutomaticNote({ id: "note-2", content, provenance });
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) expect(decision.reasons).toContain(reason);
  });

  it("rejects a near-duplicate note", () => {
    const decision = evaluateAutomaticNote({
      id: "note-3",
      content: "The release gate requires build unit tests and a device smoke test.",
      provenance,
      existingNotes: ["The release gate requires build, unit tests, and a device smoke test."],
    });
    expect(decision.accepted).toBe(false);
    if (!decision.accepted) expect(decision.reasons).toContain("duplicate");
  });
});
