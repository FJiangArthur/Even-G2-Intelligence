import { expect, it } from "vitest";
import { TranscriptContext } from "../src/transcript-context.js";

it("retains the session independently of recent focus and retrieves relevant earlier background", () => {
  const context = new TranscriptContext();
  context.append("At the beginning Alice owned delivery.");
  for (let i = 0; i < 60; i++) context.append(`Later topic ${i}.`);
  expect(context.global()).toContain("Alice owned delivery");
  expect(context.local()).not.toContain("At the beginning");
  expect(context.local()).toContain("Later topic 59");
  context.append("Who owns delivery?");
  expect(context.background("local")).toContain("Alice owned delivery");
  expect(context.background("global")).not.toContain("Who owns delivery?");
});

// v0.15: the 96,000-byte limit is a rolling window, not a session-ending error.
it("counts UTF-8 bytes and rolls the oldest line off at the limit instead of throwing", () => {
  const context = new TranscriptContext();
  expect(context.global()).toBe("");
  context.append("界".repeat(32000));
  expect(context.global()).toBe("界".repeat(32000));
  expect(() => context.append("a")).not.toThrow();
  expect(context.global()).toBe("a");
});
