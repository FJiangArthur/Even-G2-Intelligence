/** v0.15 review fix: paragraph boundaries of a long monologue stay put when the feed limit trims the head. */
import { describe, expect, it } from "vitest";
import type { Speaker, TranscriptFinalEvent } from "@helix/conversation-sdk";
import { ConversationPresentation, FEED_LIMIT, feedBlocks, type FeedItem } from "../src/presentation";

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 8, 20, 0, 0) + seconds * 1000).toISOString();
const final = (id: string, seconds: number, label = "Other speaker", role: Speaker["role"] = "other") => ({
  protocolVersion: "2.1", sessionId: "s", occurredAt: at(seconds), type: "transcript.final", eventId: `e-${id}`, transcriptId: id, text: `Sentence ${id}.`,
  context: {
    prompt: { id: "p", version: "1" }, endpoint: { id: "openai-direct", url: "https://api.openai.com/v1/responses", provider: "openai", model: "m" },
    speaker: { label, role }, latencyMs: { totalMs: 10 },
  },
}) as TranscriptFinalEvent;
const paragraphs = (feed: readonly FeedItem[]) => feedBlocks(feed).filter(block => block.type === "paragraph");
const lines = (count: number, gapSeconds: number): FeedItem[] =>
  Array.from({ length: count }, (_, index) => ({ id: `t${index}`, kind: "transcript" as const, label: "Speaker", body: `Sentence ${index}.`, occurredAt: at(index * gapSeconds) }));

/** Feeds `total` finals `gapSeconds` apart; for every final that trims the head, reports how many paragraph ids did not survive it. */
function churn(total: number, gapSeconds: number): { lost: number[]; sizes: number[]; trimmed: number } {
  const p = new ConversationPresentation();
  p.setStatus("listening");
  const lost: number[] = [];
  let sizes: number[] = [], previous: string[] = [], trimmed = 0;
  for (let index = 0; index < total; index++) {
    const full = p.snapshot().feed.length >= FEED_LIMIT;
    p.apply(final(`t${index}`, index * gapSeconds));
    const blocks = paragraphs(p.snapshot().feed);
    const ids = blocks.map(block => block.id);
    if (full) { trimmed++; const now = new Set(ids); lost.push(previous.filter(id => !now.has(id)).length); }
    previous = ids;
    sizes = blocks.map(block => block.segments.length);
  }
  return { lost, sizes, trimmed };
}

describe("review of finding 19: paragraph boundaries are stable when the feed limit trims the head", () => {
  it("one final every 10 s for 100 minutes: each new final touches only the head of the feed", () => {
    const { lost, sizes, trimmed } = churn(600, 10);
    expect(trimmed).toBe(200);
    // The head paragraph is renamed by the trim; when it runs short it merges with the next one (two ids retire).
    expect(Math.max(...lost)).toBeLessThanOrEqual(2);
    expect(sizes.length).toBeGreaterThan(20);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(24);
  });

  it("one final every 4 s (15 a minute): the same, and paragraphs stay bounded", () => {
    const { lost, sizes } = churn(700, 4);
    // The head paragraph is renamed by the trim; when it runs short it merges with the next one (two ids retire).
    expect(Math.max(...lost)).toBeLessThanOrEqual(2);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(42);
  });

  it("the boundaries of a trimmed feed are the boundaries of the full one, apart from the head paragraph", () => {
    const all = lines(300, 7);
    const full = new Set(paragraphs(all).map(block => block.id));
    for (let cut = 1; cut < 60; cut++) {
      const ids = paragraphs(all.slice(cut)).map(block => block.id);
      expect(ids.slice(1).filter(id => !full.has(id))).toEqual([]);
    }
  });

  it("still keeps a short exchange that crosses a clock boundary in one paragraph", () => {
    expect(paragraphs(lines(11, 60))).toHaveLength(1);
  });
});
