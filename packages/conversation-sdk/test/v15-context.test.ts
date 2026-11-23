import { describe, expect, it, vi } from "vitest";
import { DirectConversationTransport } from "../src/direct-transport.js";
import { HelixConversationClient } from "../src/client.js";
import { ConversationCopilot } from "../src/copilot.js";
import { DEFAULT_COPILOT_SETTINGS } from "../src/copilot-types.js";
import { TranscriptContext } from "../src/transcript-context.js";
import type { GatewayEvent, SessionConfig } from "../src/types.js";

const bytes = (text: string) => new TextEncoder().encode(text).length;
const config: SessionConfig = {
  sessionId: "v15-context", endpoint: { id: "openai-direct", url: "https://api.openai.com/v1/responses", provider: "openai", model: "gpt-4.1-mini" },
  prompt: { id: "p", version: "1", system: "Be brief.", maxResponseSentences: 2 },
  providers: { transcriptionProvider: "openai-whisper", answerProvider: "openai-responses" },
  speaker: { label: "User", role: "unknown" }, mode: "office-discussion", responseStrategy: "reactive", locale: "en-US",
  automation: { detectQuestions: true, answerQuestions: true, saveNotes: false }, memory: { readOmiContext: false, syncNotes: false },
};
const speaker = { label: "User", role: "unknown" as const };
function stream(text: string) {
  return new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\ndata: {"type":"response.completed"}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}
function setup() {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => stream("Answer."));
  const transport = new DirectConversationTransport({ fetch: fetcher });
  const client = new HelixConversationClient(transport, { vad: false });
  const events: GatewayEvent[] = [];
  client.subscribe(event => events.push(event));
  return { fetcher, transport, client, events };
}
/** About `chars` characters of short numbered sentences. */
function filler(tag: string, chars: number): string {
  let text = "";
  for (let i = 0; text.length < chars - 40; i++) text += `${tag} point ${i} was noted. `;
  return text.trim();
}
const lastContent = (fetcher: ReturnType<typeof setup>["fetcher"]): string => {
  const input = JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string).input as { content: string }[];
  return input.at(-1)!.content;
};
const backgroundOf = (content: string): string => JSON.parse(content.slice(content.indexOf("GLOBAL BACKGROUND\n") + "GLOBAL BACKGROUND\n".length, content.lastIndexOf("\nREQUEST\n")));

describe("finding 24: the session transcript is a rolling window", () => {
  it("drops the oldest lines instead of throwing at 96,000 bytes", () => {
    const context = new TranscriptContext();
    context.append("The very first line.");
    for (let i = 0; i < 400; i++) expect(() => context.append(`Line number ${i} ${"x".repeat(480)}.`)).not.toThrow();
    const text = context.global();
    expect(bytes(text)).toBeLessThanOrEqual(96_000);
    expect(bytes(text)).toBeGreaterThan(90_000);
    expect(text).not.toContain("The very first line.");
    expect(text).not.toContain("Line number 0 ");
    expect(text).toContain("Line number 399 ");
    expect(text.startsWith("Line number ")).toBe(true);
    expect(context.local()).toContain("Line number 399 ");
  });
  it("counts UTF-8 bytes and keeps the tail of a single oversized line", () => {
    const context = new TranscriptContext();
    context.append("界".repeat(32_000));
    expect(context.global()).toBe("界".repeat(32_000));
    context.append("a");
    expect(bytes(context.global())).toBeLessThanOrEqual(96_000);
    expect(context.global()).toBe("a");
    const single = new TranscriptContext();
    expect(() => single.append("界".repeat(40_000) + "END")).not.toThrow();
    expect(bytes(single.global())).toBeLessThanOrEqual(96_000);
    expect(single.global().endsWith("界END")).toBe(true);
    expect(single.global()).not.toContain("�");
  });
  it("keeps a long session alive: no fatal error, later lines are still shown and answered", async () => {
    const { fetcher, transport, client, events } = setup();
    await client.start(config, { openai: "runtime" });
    for (let i = 0; i < 14; i++) await transport.injectTranscript(filler(`Block${i}`, 8000), speaker);
    expect(events.filter(e => e.type === "error")).toEqual([]);
    expect(events.filter(e => e.type === "transcript.final")).toHaveLength(14);
    expect(client.state).not.toBe("failed");
    await transport.injectTranscript("What is the budget for the pilot?", speaker);
    await vi.waitFor(() => expect(events.some(e => e.type === "answer.completed")).toBe(true));
    expect(events.filter(e => e.type === "error")).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await client.dispose();
  });
});

describe("finding 23: automatic answers carry a bounded transcript window", () => {
  it("caps GLOBAL BACKGROUND for an automatic question at a sentence boundary, newest speech kept", async () => {
    const { fetcher, transport, client, events } = setup();
    await client.start(config, { openai: "runtime" });
    await transport.injectTranscript("Zebramarker opened the meeting.", speaker);
    for (let i = 0; i < 8; i++) await transport.injectTranscript(filler(`Block${i}`, 7900), speaker);
    await transport.injectTranscript("Recentmarker closed the topic. One. Two. Three. Four. Five. Six. Seven.", speaker);
    expect(fetcher).not.toHaveBeenCalled();
    await transport.injectTranscript("What is the budget for the pilot?", speaker);
    await vi.waitFor(() => expect(events.some(e => e.type === "answer.completed")).toBe(true));
    const content = lastContent(fetcher), background = backgroundOf(content);
    expect(background.length).toBeLessThanOrEqual(24_000);
    expect(background.length).toBeGreaterThan(12_000);
    expect(background).not.toContain("Zebramarker");
    expect(background).not.toContain("Block0 ");
    expect(background).toContain("Recentmarker closed the topic.");
    // Cut at a sentence boundary: the window starts with a whole sentence.
    expect(background.split("\n")[0]).toMatch(/^Block\d+ point \d+ was noted\.$/);
    expect(content.split("REQUEST\n")[1]).toBe("What is the budget for the pilot?");
    await client.dispose();
  });
  it("leaves a manual whole-session request uncapped", async () => {
    const { fetcher, transport, client, events } = setup();
    await client.start({ ...config, automation: { detectQuestions: false, answerQuestions: false, saveNotes: false } }, { openai: "runtime" });
    await transport.injectTranscript("Zebramarker opened the meeting.", speaker);
    for (let i = 0; i < 8; i++) await transport.injectTranscript(filler(`Block${i}`, 7900), speaker);
    await client.askContext("global");
    await vi.waitFor(() => expect(events.some(e => e.type === "answer.completed")).toBe(true));
    const background = backgroundOf(lastContent(fetcher));
    expect(background).toContain("Zebramarker opened the meeting.");
    expect(background.length).toBeGreaterThan(60_000);
    await client.dispose();
  });
  it("background(scope, maxChars) keeps whole trailing sentences and is unbounded by default", () => {
    const context = new TranscriptContext();
    for (let i = 0; i < 100; i++) context.append(`Sentence ${String(i).padStart(3, "0")} here.`);
    expect(context.background("global").split("\n")).toHaveLength(94);
    const capped = context.background("global", 100).split("\n");
    expect(capped.every(s => /^Sentence \d{3} here\.$/.test(s))).toBe(true);
    expect(capped.join("\n").length).toBeLessThanOrEqual(100);
    expect(capped.at(-1)).toBe("Sentence 093 here.");
    expect(capped.length).toBeGreaterThan(3);
  });
});

describe("finding 36: the copilot backs off when its analysis keeps failing", () => {
  const callbacks = { enabled: () => true, settings: () => DEFAULT_COPILOT_SETTINGS };
  const empty = () => Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ summary: { bullets: [], keyFacts: [] }, concepts: [], conflicts: [], suggestedQuestions: [], asks: [] }) }] }] });
  it("doubles the wait after each failure, up to two minutes, and returns to the base cooldown after a success", async () => {
    vi.useFakeTimers();
    try {
      let fail = true;
      const fetch = vi.fn(async () => { if (fail) throw new TypeError("offline"); return empty(); });
      const copilot = new ConversationCopilot({ fetch, key: "k", sessionId: "s", cooldownMs: 8000, callbacks });
      copilot.submit("a", "We use the new pipeline.");
      await vi.advanceTimersByTimeAsync(0); expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15_000); expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_100); expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(31_000); expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_100); expect(fetch).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(64_100); expect(fetch).toHaveBeenCalledTimes(4);
      // 8 s * 2^4 = 128 s is capped at 120 s, and stays there.
      await vi.advanceTimersByTimeAsync(119_000); expect(fetch).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(1_100); expect(fetch).toHaveBeenCalledTimes(5);
      await vi.advanceTimersByTimeAsync(120_100); expect(fetch).toHaveBeenCalledTimes(6);
      // Ten minutes of silence: at most one request every two minutes (it was 75 at a fixed 8 s).
      await vi.advanceTimersByTimeAsync(600_000); expect(fetch).toHaveBeenCalledTimes(11);
      fail = false;
      await vi.advanceTimersByTimeAsync(120_100); expect(fetch).toHaveBeenCalledTimes(12);
      copilot.submit("b", "Second topic now.");
      await vi.advanceTimersByTimeAsync(7_000); expect(fetch).toHaveBeenCalledTimes(12);
      await vi.advanceTimersByTimeAsync(1_100); expect(fetch).toHaveBeenCalledTimes(13);
      copilot.cancel();
    } finally { vi.useRealTimers(); }
  });
  it("new speech resets the back-off to the base cooldown", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async () => { throw new TypeError("offline"); });
      const copilot = new ConversationCopilot({ fetch, key: "k", sessionId: "s", cooldownMs: 8000, callbacks });
      copilot.submit("a", "We use the new pipeline.");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(16_100);
      await vi.advanceTimersByTimeAsync(32_100); expect(fetch).toHaveBeenCalledTimes(3);
      // Next retry would be 64 s away; new speech brings it back to 8 s.
      await vi.advanceTimersByTimeAsync(1_000);
      copilot.submit("b", "Something new was said.");
      await vi.advanceTimersByTimeAsync(7_000); expect(fetch).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1_100); expect(fetch).toHaveBeenCalledTimes(4);
      copilot.cancel();
    } finally { vi.useRealTimers(); }
  });
  it.each([[401, {}], [402, {}], [404, { error: { code: "model_not_found", message: "The model `gpt-x` does not exist" } }]])("does not retry the same speech after HTTP %i", async (status, body) => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async () => Response.json(body, { status }));
      const copilot = new ConversationCopilot({ fetch, key: "k", sessionId: "s", cooldownMs: 8000, callbacks });
      copilot.submit("a", "We use the new pipeline.");
      await vi.advanceTimersByTimeAsync(0); expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(600_000); expect(fetch).toHaveBeenCalledTimes(1);
      // New speech gets one fresh attempt.
      copilot.submit("b", "Something new was said.");
      await vi.advanceTimersByTimeAsync(8_100); expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(600_000); expect(fetch).toHaveBeenCalledTimes(2);
      copilot.cancel();
    } finally { vi.useRealTimers(); }
  });
});
