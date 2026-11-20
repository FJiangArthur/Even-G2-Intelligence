import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextInsightAnalyzer, type ContextInsight } from "../src/context-insights.js";

function response(value: unknown, raw = false) {
  return new Response(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: raw ? value : JSON.stringify(value) })}\n\ndata: {"type":"response.completed"}\n\n`);
}
function setup(fetch = vi.fn(async (_url: string, _init?: RequestInit) => response({ term: "RAG", explanation: "Retrieval augmented generation." }))) {
  const results: ContextInsight[] = [];
  const analyzer = new ContextInsightAnalyzer({ fetch, key: "fixture", sessionId: "s", profile: "openai-responses", model: "gpt-4o-mini", enabled: () => true, onResult: r => results.push(r) });
  return { analyzer, results, fetch };
}
afterEach(() => vi.useRealTimers());
describe("speech context insights", () => {
  it("explains one source term with the selected model and quoted bounded speech", async () => {
    const { analyzer, results, fetch } = setup();
    analyzer.submit("t1", "We discussed RAG.", "earlier ".repeat(1000));
    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0]).toMatchObject({ term: "RAG", transcriptId: "t1", sessionId: "s" });
    const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(body.model).toBe("gpt-4o-mini");
    const input = JSON.parse(body.input[0].content);
    expect(input.latestSpeech).toBe("We discussed RAG.");
    expect(input.latestSpeech.length + input.earlierSpeech.length).toBeLessThanOrEqual(4000);
    expect(body.tools).toBeUndefined();
    analyzer.cancel();
  });
  it("makes no provider call while disabled", async () => {
    const fetch = vi.fn();
    const analyzer = new ContextInsightAnalyzer({ fetch, key: "fixture", sessionId: "s", profile: "openai-responses", model: "gpt-4o-mini", enabled: () => false, onResult: vi.fn() });
    analyzer.submit("t1", "RAG");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["not json", JSON.stringify({ term: "absent", explanation: "No." }), JSON.stringify({ term: "RAG", explanation: "x".repeat(501) }), JSON.stringify({ term: "R".repeat(81), explanation: "No." }), "x".repeat(2001), JSON.stringify([{ term: "RAG", explanation: "No." }])])("drops invalid or oversized output: %s", async raw => {
    vi.useFakeTimers();
    const { analyzer, results } = setup(vi.fn(async () => response(raw, true)));
    analyzer.submit("t1", "RAG");
    await vi.advanceTimersByTimeAsync(1);
    expect(results).toEqual([]);
    analyzer.cancel();
  });
  it("keeps one active and latest pending with ten-second cooldown and session term dedupe", async () => {
    vi.useFakeTimers();
    let release!: (r: Response) => void;
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Promise<Response>(resolve => { release = resolve; }));
    const { analyzer, results } = setup(fetch);
    analyzer.submit("t1", "RAG"); analyzer.submit("t2", "second RAG"); analyzer.submit("t3", "latest RAG");
    expect(fetch).toHaveBeenCalledTimes(1);
    release(response({ term: "RAG", explanation: "Retrieval." }));
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    release(response({ term: "rag", explanation: "Repeat." }));
    await vi.advanceTimersByTimeAsync(1);
    expect(results).toHaveLength(1);
    expect(JSON.parse(JSON.parse(fetch.mock.calls[1]![1]?.body as string).input[0].content).latestSpeech).toBe("latest RAG");
    analyzer.cancel();
  });
  it("cancels stale callbacks even if the provider ignores abort; timeout frees the lane", async () => {
    vi.useFakeTimers();
    const releases: ((r: Response) => void)[] = [];
    const { analyzer, results, fetch } = setup(vi.fn(async (_u: string, _i?: RequestInit) => new Promise<Response>(r => releases.push(r))));
    analyzer.submit("t1", "RAG"); analyzer.cancel();
    releases[0]!(response({ term: "RAG", explanation: "Late." }));
    await vi.advanceTimersByTimeAsync(1);
    expect(results).toEqual([]);
    await vi.advanceTimersByTimeAsync(10000);
    analyzer.submit("t2", "RAG"); analyzer.submit("t3", "RAG");
    await vi.advanceTimersByTimeAsync(25000);
    expect(fetch).toHaveBeenCalledTimes(3);
    analyzer.cancel();
  });
  it("does not bypass the cooldown by cancelling an active request", async () => {
    vi.useFakeTimers();
    const { analyzer, fetch } = setup(vi.fn(async (_u: string, _i?: RequestInit) => new Promise<Response>(() => {})));
    analyzer.submit("t1", "RAG"); analyzer.cancel(); analyzer.submit("t2", "RAG");
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9999); expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(fetch).toHaveBeenCalledTimes(2);
    analyzer.cancel();
  });
});
