import { describe, expect, it } from "vitest";
import { extractQuestions, RecentQuestions } from "../src/questions.js";

describe("v0.14 imperative and indirect questions without a question mark", () => {
  const positives: readonly string[] = [
    "I'd like to hear about your last project.",
    "I would like to know how you handled the migration.",
    "I'd love to hear more about the team you led.",
    "I want to understand your approach to testing.",
    "I'd like you to walk us through the architecture.",
    "Describe a time you disagreed with your manager.",
    "Give me an example of a hard trade-off you made.",
    "Give us a sense of the scale you worked at.",
    "Talk me through your debugging process.",
    "Talk about a project you are proud of.",
    "Take me through the incident from the start.",
    "Walk us through the design.",
    "Tell us about your current role.",
    "So, tell me about yourself.",
    "Please share an example of a conflict you resolved.",
    "Elaborate on the caching layer.",
    "I'm curious how you measured success.",
    "I was wondering if you could explain the rollout plan.",
    "Can you explain the consensus protocol.",
    "Okay, describe your ideal working environment",
  ];
  const negatives: readonly string[] = [
    "I'd like to thank everyone for joining.",
    "I'd like a coffee before we start.",
    "I'd like to hear back by Friday.",
    "I would like to move on to the next topic.",
    "I want to go home early today.",
    "Give me a second.",
    "Give me a minute to pull that up.",
    "Give us a call next week.",
    "Talk to you later.",
    "We talked about the budget yesterday.",
    "I wonder if it will rain tomorrow.",
    "I'm curious by nature.",
    "She described the outage in detail.",
    "The team shared an update this morning.",
    "Take me to the airport.",
    "My last project was a payments migration.",
    "We decided to ship on Friday.",
    "That is a good example of the trade-off.",
    "Thanks, that was a great walkthrough.",
    "The elaborate design took a year.",
  ];
  it.each(positives)("detects: %s", text => {
    const found = extractQuestions(text);
    expect(found).toHaveLength(1);
    expect(found[0]!.text.endsWith("?")).toBe(true);
  });
  it.each(negatives)("ignores: %s", text => {
    expect(extractQuestions(text)).toEqual([]);
  });
  it("keeps one request as one question when it continues after a conjunction", () => {
    expect(extractQuestions("I'd like to hear about your last project and how you managed it.").map(q => q.text)).toEqual(["I'd like to hear about your last project?"]);
    expect(extractQuestions("My last role was at a bank. Describe a time you missed a deadline. It happens to everyone.").map(q => q.text)).toEqual(["Describe a time you missed a deadline?"]);
  });
});

describe("v0.14 RecentQuestions", () => {
  it("matches questions that normalise to the same text within the window only", () => {
    const recent = new RecentQuestions(1000);
    expect(recent.has("What is the budget?", 0)).toBe(false);
    recent.add("What is the budget?", 0);
    expect(recent.has("so, what is the BUDGET", 500)).toBe(true);
    expect(recent.has("What is the timeline?", 500)).toBe(false);
    expect(recent.has("What is the budget?", 1001)).toBe(false);
    recent.add("Who owns it?", 2000); recent.delete("who owns it");
    expect(recent.has("Who owns it?", 2001)).toBe(false);
  });
});
