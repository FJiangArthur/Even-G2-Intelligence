import { describe, expect, it } from "vitest";
import { extractQuestions } from "../src/questions.js";

describe("extractQuestions", () => {
  it("matches multilingual fixture cases without an LLM round trip", () => {
    const fixturePath = fileURLToPath(new URL("./fixtures/multilingual-questions.json", import.meta.url));
    const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      readonly input: string;
      readonly question: boolean;
    }[];
    for (const fixture of fixtures) {
      expect(extractQuestions(fixture.input).length > 0, fixture.input).toBe(fixture.question);
    }
  });
  it("finds multiple explicit and spoken questions in source order", () => {
    const transcript = [
      "We shipped yesterday.",
      "What failed, and how do we fix it?",
      "Also, could we prevent recurrence?",
      "Why did the alerts miss it?",
    ].join(" ");

    expect(extractQuestions(transcript)).toEqual([
      expect.objectContaining({ text: "What failed?" }),
      expect.objectContaining({ text: "how do we fix it?" }),
      expect.objectContaining({ text: "could we prevent recurrence?" }),
    ]);
    const positions = extractQuestions(transcript).map((question) => question.sourceStart);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it("detects unpunctuated speech and removes duplicates", () => {
    expect(extractQuestions("how does caching work and why is it faster")).toEqual([
      expect.objectContaining({ text: "how does caching work?" }),
      expect.objectContaining({ text: "why is it faster?" }),
    ]);
    expect(extractQuestions("What now? What now?")).toHaveLength(1);
  });

  it("does not turn ordinary statements into questions", () => {
    expect(extractQuestions("We completed the migration. The checks are green.")).toEqual([]);
    expect(extractQuestions("We completed the migration, and what remains?")).toEqual([
      expect.objectContaining({ text: "what remains?" }),
    ]);
  });

  it.each([
    "Will Smith attended the meeting.",
    "May is a spring month.",
    "Can opener sales increased.",
    "How great this release is.",
    "What a productive afternoon.",
  ])("rejects ambiguous question-word declarative: %s", (transcript) => {
    expect(extractQuestions(transcript)).toEqual([]);
  });

  it("preserves explicit Chinese and Arabic question punctuation", () => {
    expect(extractQuestions("什么是检索增强生成？它如何减少幻觉？")).toEqual([
      expect.objectContaining({ text: "什么是检索增强生成？" }),
      expect.objectContaining({ text: "它如何减少幻觉？" }),
    ]);
    expect(extractQuestions("هل هذا صحيح؟")).toEqual([
      expect.objectContaining({ text: "هل هذا صحيح؟" }),
    ]);
  });

  it("keeps a question mark before closing quotes and brackets", () => {
    expect(extractQuestions('She asked, "What changed?" (Why now?)')).toEqual([
      expect.objectContaining({ text: 'She asked, "What changed?"' }),
      expect.objectContaining({ text: "(Why now?)" }),
    ]);
  });
});
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
