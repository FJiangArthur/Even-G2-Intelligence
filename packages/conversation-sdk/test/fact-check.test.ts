import { afterEach, describe, expect, it, vi } from "vitest";
import { WebFactChecker } from "../src/fact-check.js";

const cited = (options: { search?: boolean; url?: string; status?: string } = {}) => ({
  status: "completed",
  output: [
    ...(options.search === false ? [] : [{ type: "web_search_call", status: "completed" }]),
    { type: "message", content: [{ type: "output_text", text: JSON.stringify({ status: options.status ?? "contradicted", summary: "The landing occurred in 1969." }), annotations: [{ type: "url_citation", url: options.url ?? "https://www.nasa.gov/history/apollo-11-mission-overview/", title: "NASA Apollo 11", start_index: 0, end_index: 20 }] }] },
  ],
});
const settle = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe("sourced background web checks", () => {
  it("does no work while off or for acknowledgments and personal preferences", async () => {
    const fetch = vi.fn(), onResult = vi.fn(); let enabled = false;
    const checker = new WebFactChecker({ key: "fixture", sessionId: "s", fetch, enabled: () => enabled, onResult });
    checker.submit("t", "The moon landing was in 1969."); enabled = true;
    for (const text of ["Thanks!", "好的。", "I prefer tea.", "我喜欢咖啡。", "I have 2 cats.", "我今年30岁。", "Do you like coffee?"]) checker.submit("t", text);
    await settle(); expect(fetch).not.toHaveBeenCalled(); checker.cancel();
  });
  it.each(["The moon landing was in 1970.", "登月发生于1970年。", "Is the moon made of cheese?", "月亮是奶酪做的吗？", "Water is an element.", "水是一种元素。", "水是元素。"])("checks bilingual public candidates: %s", async claim => {
    const fetch = vi.fn(async () => Response.json(cited())), onResult = vi.fn();
    const checker = new WebFactChecker({ key: "fixture", sessionId: "s", fetch, enabled: () => true, onResult });
    checker.submit("t", claim); await settle();
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s", transcriptId: "t", claim, status: "contradicted", checkedAt: expect.any(String), sources: [{ url: "https://www.nasa.gov/history/apollo-11-mission-overview/", title: "NASA Apollo 11" }] }));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "gpt-6-luna", store: false, tools: [{ type: "web_search" }], tool_choice: "required", max_output_tokens: 2000, reasoning: { effort: "none" } });
    expect(init).toMatchObject({ redirect: "error", credentials: "omit" }); checker.cancel();
  });
  it.each([{ search: false }, { url: "javascript:alert(1)" }, { url: "data:text/html,evil" }, { url: "https://key:secret@example.com" }])("never promotes unsourced model belief: %j", async options => {
    const onResult = vi.fn(); const checker = new WebFactChecker({ key: "fixture", sessionId: "s", fetch: async () => Response.json(cited(options)), enabled: () => true, onResult });
    checker.submit("t", "The moon landing was in 1970."); await settle();
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ status: "uncertain" }));
    expect(onResult.mock.calls[0]![0].summary).not.toContain("occurred in 1969"); checker.cancel();
  });
  it("rejects missing citations, incomplete search and malformed provider verdicts", async () => {
    for (const value of [
      { ...cited(), output: [{ type: "web_search_call", status: "completed" }, { type: "message", content: [{ type: "output_text", text: '{"status":"supported","summary":"True"}', annotations: [] }] }] },
      { ...cited(), output: cited().output.map(item => item.type === "web_search_call" ? { ...item, status: "failed" } : item) },
      cited({ status: "made-up" }),
      { ...cited(), output: [{ type: "web_search_call", status: "completed" }, { type: "message", content: [{ type: "output_text", text: '{"status":"supported","summary":"True"}', annotations: [{ type: "url_citation", url: "https://example.com", title: "Fake span", start_index: -1, end_index: 1000 }] }] }] },
    ]) {
      const onResult = vi.fn(); const checker = new WebFactChecker({ key: "fixture", sessionId: "s", fetch: async () => Response.json(value), enabled: () => true, onResult });
      checker.submit("t", "Water is an element."); await settle(); expect(onResult.mock.calls[0]![0].status).toBe("uncertain"); checker.cancel();
    }
  });
  it("removes inline provider citation controls from speakable summaries while retaining sources", async () => {
    const value = cited();
    value.output = [{ type: "web_search_call", status: "completed" }, { type: "message", content: [{ type: "output_text", text: JSON.stringify({ status: "supported", summary: "The landing was in 1969. citeturn0search0" }), annotations: [{ type: "url_citation", url: "https://www.nasa.gov/", title: "NASA", start_index: 0, end_index: 20 }] }] }];
    const onResult = vi.fn(), checker = new WebFactChecker({ key: "fixture", sessionId: "s", enabled: () => true, fetch: async () => Response.json(value), onResult });
    checker.submit("t", "The moon landing was in 1969."); await settle();
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ summary: "The landing was in 1969.", sources: [{ url: "https://www.nasa.gov/", title: "NASA" }] })); checker.cancel();
  });
  it("rejects array-shaped statuses instead of coercing them to a valid verdict", async () => {
    const value = cited();
    value.output = [{ type: "web_search_call", status: "completed" }, { type: "message", content: [{ type: "output_text", text: JSON.stringify({ status: ["contradicted"], summary: "A correction." }), annotations: [{ type: "url_citation", url: "https://www.nasa.gov/", title: "NASA", start_index: 0, end_index: 20 }] }] }];
    const onResult = vi.fn(), checker = new WebFactChecker({ key: "fixture", sessionId: "s", enabled: () => true, fetch: async () => Response.json(value), onResult });
    checker.submit("t", "The moon landing was in 1970."); await settle();
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ status: "uncertain", sources: [] })); checker.cancel();
  });
  it("aborts immediately and silences late results across disable and re-enable", async () => {
    let resolve!: (value: Response) => void, signal!: AbortSignal; const onResult = vi.fn(); let enabled = true;
    const checker = new WebFactChecker({ key: "fixture", sessionId: "s", fetch: async (_url, init) => { signal = init!.signal as AbortSignal; return new Promise(r => { resolve = r; }); }, enabled: () => enabled, onResult });
    checker.submit("t", "The moon landing was in 1970."); enabled = false; checker.cancel(); enabled = true;
    expect(signal.aborted).toBe(true); resolve(Response.json(cited())); await settle(); expect(onResult).not.toHaveBeenCalled();
  });
  it("keeps one active and only the latest pending; applies cooldown and dedupe", async () => {
    vi.useFakeTimers(); let resolve!: (value: Response) => void;
    const fetch = vi.fn(async () => new Promise<Response>(r => { resolve = r; })), onResult = vi.fn();
    const checker = new WebFactChecker({ key: "fixture", sessionId: "s", fetch, enabled: () => true, onResult });
    checker.submit("a", "The moon landing was in 1970."); checker.submit("b", "Water is an element."); checker.submit("c", "Mars has 3 moons.");
    expect(fetch).toHaveBeenCalledTimes(1); resolve(Response.json(cited())); await settle();
    expect(onResult.mock.calls[0]?.[0].transcriptId).toBe("a");
    await vi.advanceTimersByTimeAsync(2999); expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(fetch).toHaveBeenCalledTimes(2);
    resolve(Response.json(cited())); await settle(); expect(onResult.mock.calls[1]![0].transcriptId).toBe("c");
    checker.submit("d", "Mars has 3 moons."); await vi.advanceTimersByTimeAsync(4000); expect(fetch).toHaveBeenCalledTimes(2);
    checker.submit("b-again", "Water is an element."); expect(fetch).toHaveBeenCalledTimes(3);
    resolve(Response.json(cited())); await settle(); expect(onResult.mock.calls[2]![0].transcriptId).toBe("b-again"); checker.cancel();
  });
  it("bounds claims and retains preceding spoken context for a pronoun claim", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => Response.json(cited())), onResult = vi.fn();
    const checker = new WebFactChecker({ key: "fixture", sessionId: "s", fetch, enabled: () => true, onResult });
    checker.submit("intro", "We were discussing Apollo 11"); checker.submit("t", "It landed in 1970."); await settle();
    const body = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(body.input).toContain("Apollo 11"); expect(body.input).toContain("It landed in 1970."); checker.cancel();
    checker.submit("long", "Is this a public fact? " + "word ".repeat(1000)); await settle(); expect(onResult.mock.calls.at(-1)![0].claim.length).toBeLessThanOrEqual(2000); checker.cancel();
  });
  it("sanitizes provider failures and times out even a fetch that ignores abort", async () => {
    vi.useFakeTimers(); const onResult = vi.fn();
    const checker = new WebFactChecker({ key: "fixture", sessionId: "s", fetch: async () => new Promise(() => {}), enabled: () => true, onResult });
    checker.submit("t", "The moon landing was in 1970."); await vi.advanceTimersByTimeAsync(20_000);
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ status: "unavailable", sources: [] })); checker.cancel();
    const failed = new WebFactChecker({ key: "fixture", sessionId: "s", fetch: async () => { throw new Error("secret private body"); }, enabled: () => true, onResult });
    failed.submit("t", "Water is an element."); await settle(); expect(JSON.stringify(onResult.mock.calls)).not.toContain("secret private body"); failed.cancel();
  });
  it("verifyNow bypasses candidate filters, uses the configured model and reports verify usage", async () => {
    const fetch = vi.fn(async () => Response.json({ ...cited(), usage: { input_tokens: 100, output_tokens: 10 } })), onUsage = vi.fn();
    const checker = new WebFactChecker({ key: "fixture", sessionId: "s", fetch, enabled: () => false, onResult: vi.fn(), model: "gpt-4.1-mini", onUsage });
    await expect(checker.verifyNow("I think it was 1970", "")).resolves.toMatchObject({ status: "contradicted", sources: [expect.objectContaining({ title: "NASA Apollo 11" })] });
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ model: "gpt-4.1-mini", max_output_tokens: 500 }); expect(body.reasoning).toBeUndefined();
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ kind: "verify", model: "gpt-4.1-mini", inputTokens: 100, webSearchCalls: 1, measured: true }));
    await expect(new WebFactChecker({ key: "fixture", sessionId: "s", fetch: async () => { throw new Error("offline"); }, enabled: () => true, onResult: vi.fn() }).verifyNow("x")).resolves.toMatchObject({ status: "unavailable" });
  });
});

import { claimLanguage } from "../src/fact-check.js";
describe("verify summary hygiene (v0.8 live finding)", () => {
  it("pins the summary language to the claim's script", () => {
    expect(claimLanguage("预算给了六万元")).toBe("Chinese");
    expect(claimLanguage("We should order the Jetson boards this week.")).toMatch(/English/);
  });
});
