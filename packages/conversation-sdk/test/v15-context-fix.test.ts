import { describe, expect, it, vi } from "vitest";
import { DirectConversationTransport } from "../src/direct-transport.js";
import { HelixConversationClient } from "../src/client.js";
import { TranscriptContext } from "../src/transcript-context.js";
import type { GatewayEvent, SessionConfig } from "../src/types.js";

const config: SessionConfig = {
  sessionId: "v15-context-fix", endpoint: { id: "openai-direct", url: "https://api.openai.com/v1/responses", provider: "openai", model: "gpt-4.1-mini" },
  prompt: { id: "p", version: "1", system: "Be brief.", maxResponseSentences: 2 },
  providers: { transcriptionProvider: "openai-whisper", answerProvider: "openai-responses" },
  speaker: { label: "User", role: "unknown" }, mode: "office-discussion", responseStrategy: "reactive", locale: "en-US",
  automation: { detectQuestions: false, answerQuestions: false, saveNotes: false }, memory: { readOmiContext: false, syncNotes: false },
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
const requestOf = (content: string): string => content.slice(content.lastIndexOf("\nREQUEST\n") + "\nREQUEST\n".length);
const answered = (events: GatewayEvent[], count = 1) => vi.waitFor(() => expect(events.filter(e => e.type === "answer.completed")).toHaveLength(count));
const OMITTED = /earlier speech .* is not included/i;

describe("review of finding 23: only an explicit whole-session ask sends the whole window", () => {
  it("caps GLOBAL BACKGROUND for a typed question and says that earlier speech was left out", async () => {
    const { fetcher, transport, client, events } = setup();
    await client.start(config, { openai: "runtime" });
    await transport.injectTranscript("Zebramarker opened the meeting.", speaker);
    for (let i = 0; i < 8; i++) await transport.injectTranscript(filler(`Block${i}`, 7900), speaker);
    await transport.injectTranscript("Recentmarker closed the topic. One. Two. Three. Four. Five. Six. Seven.", speaker);
    await client.ask("What did we decide about the pilot?");
    await answered(events);
    const content = lastContent(fetcher), background = backgroundOf(content);
    expect(background.length).toBeLessThanOrEqual(24_000);
    expect(background.length).toBeGreaterThan(12_000);
    expect(background).not.toContain("Zebramarker");
    expect(background).toContain("Recentmarker closed the topic.");
    expect(background.split("\n")[0]).toMatch(/^Block\d+ point \d+ was noted\.$/);
    expect(requestOf(content).startsWith("What did we decide about the pilot?\n")).toBe(true);
    expect(requestOf(content)).toMatch(OMITTED);
    // The note is part of this request only: the stored turn is the wearer's own text.
    await client.ask("And the owner?");
    await answered(events, 2);
    const input = JSON.parse(fetcher.mock.calls.at(-1)![1]!.body as string).input as { role: string; content: string }[];
    expect(input.at(-3)!.content).toBe("What did we decide about the pilot?");
    await client.dispose();
  });
  it("caps the background of a manual recent-focus ask too", async () => {
    const { fetcher, transport, client, events } = setup();
    await client.start(config, { openai: "runtime" });
    for (let i = 0; i < 8; i++) await transport.injectTranscript(filler("Pilot", 7900), speaker);
    await transport.injectTranscript("Pilot point was raised again. One. Two. Three. Four. Five.", speaker);
    await client.askContext("local");
    await answered(events);
    expect(backgroundOf(lastContent(fetcher)).length).toBeLessThanOrEqual(24_000);
    expect(backgroundOf(lastContent(fetcher)).length).toBeGreaterThan(12_000);
    await client.dispose();
  });
  it("adds nothing to a typed question while the whole session still fits", async () => {
    const { fetcher, transport, client, events } = setup();
    await client.start(config, { openai: "runtime" });
    await transport.injectTranscript("Zebramarker opened the meeting.", speaker);
    await transport.injectTranscript(filler("Block", 4000), speaker);
    await client.ask("What did we decide about the pilot?");
    await answered(events);
    const content = lastContent(fetcher);
    expect(backgroundOf(content)).toContain("Zebramarker opened the meeting.");
    expect(requestOf(content)).toBe("What did we decide about the pilot?");
    await client.dispose();
  });
});

describe("review of finding 24: a rolled window is not presented as the whole session", () => {
  it("TranscriptContext reports when the oldest lines have rolled off", () => {
    const context = new TranscriptContext();
    context.append("The very first line.");
    expect(context.truncated).toBe(false);
    for (let i = 0; i < 150; i++) context.append(`Line number ${i} ${"x".repeat(480)}.`);
    expect(context.truncated).toBe(false);
    for (let i = 150; i < 400; i++) context.append(`Line number ${i} ${"x".repeat(480)}.`);
    expect(context.truncated).toBe(true);
    const oversized = new TranscriptContext();
    oversized.append("y".repeat(100_000));
    expect(oversized.truncated).toBe(true);
  });
  it("backgroundWindow tells whether earlier sentences were left out", () => {
    const context = new TranscriptContext();
    for (let i = 0; i < 100; i++) context.append(`Sentence ${String(i).padStart(3, "0")} here.`);
    expect(context.backgroundWindow("global")).toEqual({ text: context.background("global"), cut: false });
    expect(context.backgroundWindow("global", 100)).toEqual({ text: context.background("global", 100), cut: true });
    expect(context.backgroundWindow("global", 100_000).cut).toBe(false);
  });
  it("a whole-session ask keeps the full window and its usual wording until speech rolls off", async () => {
    const { fetcher, transport, client, events } = setup();
    await client.start(config, { openai: "runtime" });
    await transport.injectTranscript("Zebramarker opened the meeting.", speaker);
    for (let i = 0; i < 8; i++) await transport.injectTranscript(filler(`Block${i}`, 7900), speaker);
    await client.askContext("global");
    await answered(events);
    const content = lastContent(fetcher);
    expect(backgroundOf(content)).toContain("Zebramarker opened the meeting.");
    expect(backgroundOf(content).length).toBeGreaterThan(60_000);
    expect(requestOf(content)).toBe("Answer the most recent unresolved question in the whole captured session. If no question is present, suggest one useful follow-up question or next response.");
    await client.dispose();
  });
  it("a whole-session ask after the window rolled says the earliest speech is missing", async () => {
    const { fetcher, transport, client, events } = setup();
    await client.start(config, { openai: "runtime" });
    await transport.injectTranscript("Zebramarker opened the meeting.", speaker);
    for (let i = 0; i < 14; i++) await transport.injectTranscript(filler(`Block${i}`, 8000), speaker);
    await client.askContext("global");
    await answered(events);
    const content = lastContent(fetcher), background = backgroundOf(content);
    expect(background).not.toContain("Zebramarker");
    expect(background.length).toBeGreaterThan(60_000);
    expect(requestOf(content)).not.toContain("whole captured session");
    expect(requestOf(content)).toMatch(OMITTED);
    await client.dispose();
  });
});
