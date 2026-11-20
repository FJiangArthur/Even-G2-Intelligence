import { describe, expect, it } from "vitest";
import {
  modeSystemPrompt,
  shouldAnswerDetectedQuestions,
  shouldGenerateProactiveResponse,
} from "../src/modes.js";

describe("conversation modes and response strategies", () => {
  it.each([
    { strategy: "reactive" as const, question: true, proactive: false },
    { strategy: "proactive" as const, question: false, proactive: true },
    { strategy: "both" as const, question: true, proactive: true },
  ])("keeps $strategy behavior distinct", ({ strategy, question, proactive }) => {
    expect(shouldAnswerDetectedQuestions(strategy)).toBe(question);
    expect(shouldGenerateProactiveResponse(
      "We need to choose a launch date by Friday",
      "office-discussion",
      strategy,
    )).toBe(proactive);
  });

  it("suppresses filler, fragments, passive mode, and reactive nonquestions", () => {
    expect(shouldGenerateProactiveResponse("okay", "general", "both")).toBe(false);
    expect(shouldGenerateProactiveResponse("launch date", "general", "both")).toBe(false);
    expect(shouldGenerateProactiveResponse(
      "We need to choose a launch date by Friday",
      "passive",
      "both",
    )).toBe(false);
    expect(shouldGenerateProactiveResponse(
      "We need to choose a launch date by Friday",
      "office-discussion",
      "reactive",
    )).toBe(false);
  });

  it.each([
    "There is no issue and no action item for us.",
    "We do not need to decide anything today.",
    "The movie was called Next Step and I loved it.",
    "This is not a problem and should not block us.",
  ])("suppresses negated or incidental actionable language: %s", (statement) => {
    expect(shouldGenerateProactiveResponse(statement, "office-discussion", "both"))
      .toBe(false);
  });

  it("adds mode and strategy as protected instructions", () => {
    const prompt = modeSystemPrompt("Never fabricate.", "interviewee", "proactive");
    expect(prompt).toContain("Never fabricate.");
    expect(prompt).toContain("Protected conversation mode: interviewee");
    expect(prompt).toContain("Detected questions wait for a manual query");
  });
});
