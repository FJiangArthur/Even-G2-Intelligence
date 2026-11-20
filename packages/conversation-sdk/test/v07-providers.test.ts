import { describe, expect, it, vi } from "vitest";
import { answerDirect, parseChatUsage, parseResponsesUsage, stripCitationMarkers, transcribeDirect, TRANSCRIPTION_MODELS } from "../src/direct-providers.js";
import { estimateCostUsd, transcriptionInfo, usageRecord, TRANSCRIPTION_CATALOG, type RawUsage } from "../src/model-catalog.js";
import { needsWebLookup } from "../src/questions.js";

const signal = () => new AbortController().signal;
function sse(events: unknown[]) { return new Response(events.map(e => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } }); }
async function collect(iterator: AsyncGenerator<string>) { let result = ""; for await (const delta of iterator) result += delta; return result; }
const done = { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 200, output_tokens_details: { reasoning_tokens: 50 } } } };
const body = (fetcher: ReturnType<typeof vi.fn>, call = 0) => JSON.parse(fetcher.mock.calls[call]![1]!.body as string);

describe("catalog-driven answer bodies", () => {
  it("sends reasoning effort and a >= 2000 output budget for reasoning models", async () => {
    const fetcher = vi.fn(async (_u: string, _i?: RequestInit) => sse([{ type: "response.output_text.delta", delta: "Hi." }, done]));
    await collect(answerDirect(fetcher, "k", "openai-responses", "gpt-6.1-terra", "I", [{ role: "user", content: "Q" }], signal()));
    expect(body(fetcher)).toMatchObject({ model: "gpt-6.1-terra", reasoning: { effort: "none" }, stream: true, store: false });
    expect(body(fetcher).max_output_tokens).toBeGreaterThanOrEqual(2000);
    await collect(answerDirect(fetcher, "k", "openai-responses", "gpt-6.1-sol", "I", [{ role: "user", content: "Q" }], signal()));
    expect(body(fetcher, 1).reasoning).toEqual({ effort: "low" });
  });
  it("keeps 600 output tokens and no reasoning param for non-reasoning models", async () => {
    const fetcher = vi.fn(async (_u: string, _i?: RequestInit) => sse([done]));
    await collect(answerDirect(fetcher, "k", "openai-responses", "gpt-4.1-mini", "I", [{ role: "user", content: "Q" }], signal()));
    expect(body(fetcher).max_output_tokens).toBe(600); expect(body(fetcher).reasoning).toBeUndefined();
  });
  it("transparently uses Responses for a responsesOnly model selected with the chat profile", async () => {
    const fetcher = vi.fn(async (_u: string, _i?: RequestInit) => sse([{ type: "response.output_text.delta", delta: "Hi." }, done]));
    await expect(collect(answerDirect(fetcher, "k", "openai-compatible", "gpt-6-luna", "I", [{ role: "user", content: "Q" }], signal()))).resolves.toBe("Hi.");
    expect(fetcher.mock.calls[0]![0]).toBe("https://api.openai.com/v1/responses");
    expect(body(fetcher)).toMatchObject({ instructions: "I", input: [{ role: "user", content: "Q" }] });
  });
  it("requests chat usage and uses max_completion_tokens for reasoning chat models", async () => {
    const fetcher = vi.fn(async (_u: string, _i?: RequestInit) => sse(['{"choices":[{"delta":{"content":"A"}}]}', "[DONE]"]));
    await collect(answerDirect(fetcher, "k", "openai-compatible", "gpt-4o-mini", "I", [], signal()));
    expect(body(fetcher)).toMatchObject({ stream_options: { include_usage: true }, max_tokens: 600 });
    await collect(answerDirect(fetcher, "k", "openai-compatible", "gpt-5-future", "I", [], signal()));
    expect(fetcher.mock.calls[1]![0]).toContain("chat/completions");
    expect(body(fetcher, 1).max_tokens).toBeUndefined(); expect(body(fetcher, 1).max_completion_tokens).toBeGreaterThanOrEqual(2000);
  });
});

describe("usage capture and cost", () => {
  it("parses Responses usage including cached/reasoning tokens and web search calls", async () => {
    const onUsage = vi.fn();
    const final = { ...done, response: { ...done.response, output: [{ type: "web_search_call", id: "ws1", status: "completed" }, { type: "message", content: [] }] } };
    await collect(answerDirect(async () => sse([{ type: "response.output_text.delta", delta: "A." }, final]), "k", "openai-responses", "gpt-6.1-terra", "", [], signal(), { onUsage, webSearch: true }));
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 1000, cachedInputTokens: 0, outputTokens: 200, reasoningTokens: 50, webSearchCalls: 1 }, true);
  });
  it("parses the final chat usage chunk", async () => {
    const onUsage = vi.fn();
    await collect(answerDirect(async () => sse(['{"choices":[{"delta":{"content":"A"}}]}', '{"choices":[],"usage":{"prompt_tokens":30,"prompt_tokens_details":{"cached_tokens":10},"completion_tokens":5,"completion_tokens_details":{"reasoning_tokens":0}}}', "[DONE]"]), "k", "openai-compatible", "gpt-4o-mini", "", [], signal(), { onUsage }));
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 30, cachedInputTokens: 10, outputTokens: 5, reasoningTokens: 0, webSearchCalls: 0 }, true);
  });
  it("estimates bytes/4 and marks measured=false when usage is absent", async () => {
    const onUsage = vi.fn();
    await collect(answerDirect(async () => sse([{ type: "response.output_text.delta", delta: "abcdefgh" }, { type: "response.completed" }]), "k", "openai-responses", "gpt-4.1-mini", "", [], signal(), { onUsage }));
    const [usage, measured] = onUsage.mock.calls[0]! as [RawUsage, boolean];
    expect(measured).toBe(false); expect(usage.outputTokens).toBe(2); expect(usage.inputTokens).toBeGreaterThan(0);
  });
  it("computes cost from list price: 1,000 in / 200 out on gpt-6.1-terra = $0.002", () => {
    expect(estimateCostUsd("gpt-6.1-terra", { inputTokens: 1000, outputTokens: 200 })).toBeCloseTo(0.002, 10);
    expect(estimateCostUsd("gpt-6.1-terra", { inputTokens: 1000, cachedInputTokens: 1000, outputTokens: 0, webSearchCalls: 1 })).toBeCloseTo(0.01005, 10);
    expect(estimateCostUsd("gpt-4o-mini", { inputTokens: 1000 })).toBeUndefined();
    expect(usageRecord("transcription", "gpt-transcribe", { audioSeconds: 60 }, true).costUsd).toBeCloseTo(0.0045, 10);
    expect(usageRecord("transcription", "gpt-live-transcribe", { audioSeconds: 60 }, true).costUsd).toBeCloseTo(0.017, 10);
  });
  it("returns undefined for malformed usage objects", () => {
    expect(parseResponsesUsage({ input_tokens: "1" })).toBeUndefined(); expect(parseChatUsage(null)).toBeUndefined();
    expect(parseResponsesUsage({ input_tokens: -5, output_tokens: 3 })).toEqual({ inputTokens: 0, outputTokens: 3, cachedInputTokens: 0, reasoningTokens: 0 });
  });
});

describe("web-grounded streams", () => {
  it("adds web_search, collects url_citation annotations and strips split citation markers", async () => {
    const onCitations = vi.fn(), fetcher = vi.fn(async (_u: string, _i?: RequestInit) => sse([
      { type: "response.output_item.added", item: { type: "web_search_call", id: "ws_1" } },
      { type: "response.output_text.delta", delta: "Lead time is 12 weeks. cite" },
      { type: "response.output_text.delta", delta: "turn0search0" },
      { type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "https://example.com/jetson", title: "Jetson", start_index: 0, end_index: 5 } },
      { type: "response.output_text.annotation.added", annotation: { type: "url_citation", url: "javascript:alert(1)", title: "Bad" } },
      { type: "response.completed", response: { status: "completed" } },
    ]));
    const text = await collect(answerDirect(fetcher, "k", "openai-compatible", "gpt-4.1-mini", "", [{ role: "user", content: "lead time?" }], signal(), { webSearch: true, onCitations }));
    expect(text.trim()).toBe("Lead time is 12 weeks.");
    expect(fetcher.mock.calls[0]![0]).toContain("/responses");
    expect(body(fetcher).tools).toEqual([{ type: "web_search" }]);
    expect(onCitations).toHaveBeenCalledWith([{ url: "https://example.com/jetson", title: "Jetson" }]);
  });
  it("strips inline markdown citation links from speakable text", () => {
    expect(stripCitationMarkers("It ships in May ([nvidia.com](https://nvidia.com/x)).")).toBe("It ships in May.");
  });
});

describe("transcription profiles", () => {
  it("sends gpt-transcribe with model, file, json format and prompt context but no language", async () => {
    const fetcher = vi.fn(async (_u: string, _i?: RequestInit) => Response.json({ text: "Hello." }));
    await transcribeDirect(fetcher, "openai-transcribe", "k", new Int16Array(3200), "en-US", signal(), undefined, { prompt: `${"x".repeat(300)} talking about Jetson` });
    const form = fetcher.mock.calls[0]![1]!.body as FormData;
    expect(form.get("model")).toBe("gpt-transcribe"); expect(form.get("response_format")).toBe("json");
    expect(form.get("language")).toBeNull(); expect(form.get("file")).toBeInstanceOf(Blob);
    expect(String(form.get("prompt")).length).toBeLessThanOrEqual(200); expect(String(form.get("prompt"))).toMatch(/Jetson$/);
  });
  it("keeps whisper-1 and gpt-4o-mini-transcribe with language and without prompt", async () => {
    for (const [profile, model] of [["openai-whisper", "whisper-1"], ["openai-compatible", "gpt-4o-mini-transcribe"]] as const) {
      const fetcher = vi.fn(async (_u: string, _i?: RequestInit) => Response.json({ text: "Hi." }));
      await transcribeDirect(fetcher, profile, "k", new Int16Array(3200), "en", signal(), undefined, { prompt: "ctx" });
      const form = fetcher.mock.calls[0]![1]!.body as FormData;
      expect(form.get("model")).toBe(model); expect(form.get("language")).toBe("en"); expect(form.get("prompt")).toBeNull();
    }
  });
  it("lists the new profiles in TRANSCRIPTION_MODELS and the catalog", () => {
    expect(TRANSCRIPTION_MODELS["openai-transcribe"]).toBe("gpt-transcribe");
    expect(TRANSCRIPTION_MODELS["openai-realtime"]).toBe("gpt-live-transcribe");
    expect(TRANSCRIPTION_CATALOG[0]?.profileId).toBe("openai-realtime");
    expect(transcriptionInfo("openai-realtime")?.pricePerMinute).toBe(0.017);
  });
});

describe("needsWebLookup", () => {
  it.each([
    "What is the current lead time for Jetson Orin?", "Jetsons have long lead times right now", "How much does an RTX 5090 cost?",
    "Is the H200 in stock anywhere?", "What's the latest release of Kubernetes?", "When does the Pixel 11 ship?", "现在显卡价格是多少？", "What is the price of copper today",
  ])("true for time-sensitive lookups: %s", text => expect(needsWebLookup(text)).toBe(true));
  it.each([
    "Who owns delivery?", "Explain retrieval augmented generation.", "What did Alice say the price was?", "What price did we mention earlier?", "ok", "How should we structure the team?",
  ])("false for conversational or timeless questions: %s", text => expect(needsWebLookup(text)).toBe(false));
});

import { directFetch as directFetchForQuota } from "../src/direct-providers.js";
describe("billing classification", () => {
  it("treats insufficient_quota 429 as a fatal billing error, other 429s as retryable rate limits", async () => {
    const quota = async () => new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "You have no credits remaining." } }), { status: 429 });
    await expect(directFetchForQuota(quota, "https://api.openai.com/v1/responses", {}, "OpenAI answer")).rejects.toMatchObject({ code: "provider-billing", retryable: false });
    const rate = async () => new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "Rate limit" } }), { status: 429 });
    await expect(directFetchForQuota(rate, "https://api.openai.com/v1/responses", {}, "OpenAI answer")).rejects.toMatchObject({ code: "provider-rate-limit", retryable: true });
  });
});

import { testOpenAIKey } from "../src/direct-providers.js";
describe("testOpenAIKey (Setup → Test key)", () => {
  const models = (ids: string[]) => Response.json({ data: ids.map(id => ({ id })) });
  it("reports ok with probe latency, realtime availability and model fallback", async () => {
    const calls: { url: string; body?: Record<string, unknown> }[] = [];
    const fetcher = async (url: string, init?: RequestInit) => { calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined }); return url.endsWith("/models") ? models(["gpt-5.6-terra", "gpt-live-transcribe"]) : Response.json({ status: "completed" }); };
    const result = await testOpenAIKey(fetcher, "sk-test", "gpt-6.1-terra");
    expect(result).toMatchObject({ status: "ok", model: "gpt-5.6-terra", realtime: true });
    expect(result.message).toContain("Helix will use gpt-5.6-terra");
    expect(calls[1]!.body).toMatchObject({ model: "gpt-5.6-terra", reasoning: { effort: "none" }, store: false });
    expect(JSON.stringify(result)).not.toContain("sk-test");
  });
  it("classifies revoked keys and empty credit balances", async () => {
    expect((await testOpenAIKey(async () => new Response("", { status: 401 }), "sk-x", "gpt-6.1-terra")).status).toBe("invalid");
    const broke = async (url: string) => url.endsWith("/models") ? models(["gpt-6.1-terra"]) : new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "You have no credits remaining." } }), { status: 429 });
    expect(await testOpenAIKey(broke, "sk-x", "gpt-6.1-terra")).toMatchObject({ status: "no-credits", model: "gpt-6.1-terra" });
  });
});
