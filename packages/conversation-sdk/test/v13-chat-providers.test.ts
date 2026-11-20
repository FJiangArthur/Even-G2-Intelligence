import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { answerDirect, DirectProviderError } from "../src/direct-providers.js";
import { chatComplete, chatRequestBody, cleanPublishedAt, deepseekSearchDetails, testProviderKey, zhipuSearchQuery, zhipuWebSearch } from "../src/chat-providers.js";
import { ANSWER_MODELS, answerModelInfo, estimateCostUsd } from "../src/model-catalog.js";
import { ANSWER_PROVIDER_CATALOG, CHAT_PROVIDER_IDS, answerProviderInfo, directEndpoint, providerLimitations, providerModel, providerOrigins, resolveSearchRoute, searchAvailability } from "../src/provider-registry.js";
import { PROVIDER_CREDENTIAL_NAMES, isDirectProviderUrl, normalizeSessionStartCredentials } from "../src/types.js";
import { DirectConversationTransport, type DirectConversationOptions } from "../src/direct-transport.js";
import { HelixConversationClient } from "../src/client.js";
import { InMemoryNoteSink } from "../src/notes.js";
import { ConversationCopilot } from "../src/copilot.js";
import { DEFAULT_COPILOT_SETTINGS, type AnswerMeta, type CopilotSummary, type GatewayEvent, type SessionConfig, type UsageRecord } from "../src/index.js";

const signal = () => new AbortController().signal;
const provider = (id: string) => answerProviderInfo(id)!;
function sse(events: unknown[]) { return new Response(events.map(e => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } }); }
async function collect(iterator: AsyncGenerator<string>) { let result = ""; for await (const delta of iterator) result += delta; return result; }
const sent = (fetcher: ReturnType<typeof vi.fn>, call = 0) => JSON.parse(fetcher.mock.calls[call]![1]!.body as string);
const chatJson = (content: string, extra: Record<string, unknown> = {}) => Response.json({ choices: [{ message: { role: "assistant", content, ...extra }, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 10 } });
const settle = async (ms = 30) => { await new Promise(resolve => setTimeout(resolve, ms)); };

describe("provider registry", () => {
  it("offers DeepSeek, Qwen (two regions), Zhipu GLM (two regions) and Moonshot Kimi with fixed https bases and their own key", () => {
    expect(CHAT_PROVIDER_IDS).toEqual(["deepseek", "qwen", "qwen-intl", "zhipu", "zai", "moonshot"]);
    expect(Object.fromEntries(ANSWER_PROVIDER_CATALOG.filter(item => item.api === "chat").map(item => [item.id, [item.baseUrl, item.credential]]))).toEqual({
      deepseek: ["https://api.deepseek.com", "deepseek"],
      qwen: ["https://dashscope.aliyuncs.com/compatible-mode/v1", "dashscope"],
      "qwen-intl": ["https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "dashscope"],
      zhipu: ["https://open.bigmodel.cn/api/paas/v4", "zhipu"],
      zai: ["https://api.z.ai/api/paas/v4", "zhipu"],
      moonshot: ["https://api.moonshot.ai/v1", "moonshot"],
    });
    for (const item of ANSWER_PROVIDER_CATALOG) {
      expect(PROVIDER_CREDENTIAL_NAMES).toContain(item.credential);
      expect(isDirectProviderUrl(`${item.baseUrl}/chat/completions`)).toBe(true);
      if (item.api === "chat") { expect(item.models.map(model => model.id)).toContain(item.defaultModel); expect(item.models.map(model => model.id)).toContain(item.defaultCopilotModel); }
    }
    expect(normalizeSessionStartCredentials({ deepseek: " sk-d ", dashscope: "sk-q", zhipu: "id.secret", moonshot: "sk-m" })).toEqual({ deepseek: "sk-d", dashscope: "sk-q", zhipu: "id.secret", moonshot: "sk-m" });
  });
  it("whitelists every provider origin in the plugin manifest", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../../apps/g2-plugin/app.json", import.meta.url), "utf8")) as { permissions: { name: string; whitelist?: string[] }[] };
    const whitelist = manifest.permissions.find(item => item.name === "network")!.whitelist!;
    for (const origin of providerOrigins()) expect(whitelist).toContain(origin);
  });
  it("lists a price only where a USD list price was verified and never bills DeepSeek searches per call", () => {
    expect(ANSWER_MODELS.some(model => model.id.startsWith("deepseek"))).toBe(false); // the OpenAI picker is unchanged
    expect(answerModelInfo("deepseek-flash")?.price).toEqual({ input: 0.3, cachedInput: 0.006, output: 1.2 });
    expect(estimateCostUsd("deepseek-flash", { inputTokens: 1_000_000, outputTokens: 1_000_000, webSearchCalls: 3 })).toBe(1.5);
    for (const id of ["qwen3.7-plus", "qwen4-max", "glm-5.2", "glm-5.3", "kimi-k3.1-pro", "kimi-k3"]) {
      expect(answerModelInfo(id)?.price).toBeUndefined();
      expect(estimateCostUsd(id, { inputTokens: 1000, outputTokens: 100 })).toBeUndefined();
    }
  });
  it("replaces another provider's model with this provider's default and keeps custom ids", () => {
    expect(providerModel(provider("deepseek"), "gpt-6.1-terra", "answer")).toBe("deepseek-flash");
    expect(providerModel(provider("qwen"), "glm-5.2", "copilot")).toBe("qwen3.8-flash");
    expect(providerModel(provider("zhipu"), "glm-5.3", "answer")).toBe("glm-5.3");
    expect(providerModel(provider("moonshot"), "kimi-k4-preview", "answer")).toBe("kimi-k4-preview");
    expect(providerModel(provider("openai-responses"), "gpt-4.1", "answer")).toBe("gpt-4.1");
    expect(providerModel(provider("deepseek"), undefined, "copilot")).toBe("deepseek-flash");
  });
  it("gives provenance endpoints without credentials", () => {
    expect(directEndpoint("openai-responses", "gpt-6.1-terra")).toEqual({ id: "openai-direct", url: "https://api.openai.com/v1/responses", provider: "openai", model: "gpt-6.1-terra" });
    expect(directEndpoint("openai-compatible", "gpt-4.1", false).url).toBe("https://api.openai.com/v1/chat/completions");
    expect(directEndpoint("qwen-intl", "qwen3.7-plus")).toEqual({ id: "qwen-intl-direct", url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", provider: "alibaba", model: "qwen3.7-plus" });
  });
  it("routes search to the provider's own verified search, else to OpenAI, else nowhere", () => {
    expect(resolveSearchRoute("deepseek", { deepseek: "d", openai: "o" }, "deepseek-v4-pro")).toMatchObject({ capability: "deepseek-web-search", key: "d", model: "deepseek-flash", fallback: false });
    expect(resolveSearchRoute("zhipu", { zhipu: "z" }, "gpt-6-luna")).toMatchObject({ capability: "zhipu-web-search", key: "z", model: "glm-4.7-flash" });
    const fallback = resolveSearchRoute("moonshot", { moonshot: "m", openai: "o" });
    expect(fallback).toMatchObject({ capability: "openai-web-search", key: "o", model: "gpt-6-luna", fallback: true });
    expect(fallback!.provider.baseUrl).toBe("https://api.openai.com/v1");
    expect(resolveSearchRoute("qwen", { dashscope: "q" })).toBeUndefined();
    expect(resolveSearchRoute("zai", { zhipu: "z" })).toBeUndefined();
    expect(resolveSearchRoute("openai-responses", { openai: "o" }, "gpt-6.1-terra")).toMatchObject({ capability: "openai-web-search", key: "o", model: "gpt-6.1-terra", fallback: false });
  });
  it("says clearly in Setup when the selected provider has no search and what is reduced", () => {
    expect(searchAvailability("openai-responses", { openai: true })).toMatchObject({ available: true, via: "OpenAI" });
    expect(searchAvailability("deepseek", { deepseek: true }).message).toContain("DeepSeek web search");
    const none = searchAvailability("qwen", { dashscope: true });
    expect(none.available).toBe(false);
    expect(none.message).toMatch(/Qwen.*has no web search.*Web and news checks are off/u);
    expect(searchAvailability("moonshot", { moonshot: true, openai: true })).toMatchObject({ available: true, via: "OpenAI" });
    expect(providerLimitations("openai-responses", {})).toEqual([]);
    expect(providerLimitations("deepseek", { deepseek: true }).join(" ")).toMatch(/Responses API.*not used.*Without an OpenAI key.*Deepgram or Soniox.*knowledge base is off/u);
    expect(providerLimitations("deepseek", { openai: true }).join(" ")).toContain("keep using your OpenAI key");
  });
});

describe("provider request differences", () => {
  const messages = [{ role: "user", content: "Q" }];
  it("applies each provider's thinking switch, token parameter, usage option and JSON mode", () => {
    expect(chatRequestBody(provider("deepseek"), "deepseek-flash", messages, { stream: true, maxTokens: 600 })).toEqual({ model: "deepseek-flash", messages, stream: true, stream_options: { include_usage: true }, max_tokens: 600, thinking: { type: "disabled" } });
    // Qwen compatible mode: response_format is not documented, so JSON mode is requested in the prompt only.
    expect(chatRequestBody(provider("qwen"), "qwen3.7-plus", messages, { stream: false, maxTokens: 400, json: true })).toEqual({ model: "qwen3.7-plus", messages, stream: false, max_tokens: 400, enable_thinking: false });
    expect(chatRequestBody(provider("deepseek"), "deepseek-flash", messages, { stream: false, maxTokens: 400, json: true })).toMatchObject({ response_format: { type: "json_object" } });
    expect(chatRequestBody(provider("moonshot"), "kimi-k3", messages, { stream: false, maxTokens: 400, json: true })).toMatchObject({ response_format: { type: "json_object" } });
    // Zhipu: at least 1024 tokens, usage arrives without stream_options, GLM-5.3 cannot disable thinking.
    expect(chatRequestBody(provider("zhipu"), "glm-5.2", messages, { stream: true, maxTokens: 300 })).toEqual({ model: "glm-5.2", messages, stream: true, max_tokens: 1024, thinking: { type: "disabled" } });
    expect(chatRequestBody(provider("zai"), "glm-5.3", messages, { stream: true, maxTokens: 2000 })).toEqual({ model: "glm-5.3", messages, stream: true, max_tokens: 2000 });
    expect(chatRequestBody(provider("moonshot"), "kimi-k3", messages, { stream: true, maxTokens: 2000 })).toEqual({ model: "kimi-k3", messages, stream: true, stream_options: { include_usage: true }, max_completion_tokens: 2000, reasoning_effort: "low" });
    for (const id of CHAT_PROVIDER_IDS) expect(chatRequestBody(provider(id), provider(id).defaultModel, messages, { stream: true, maxTokens: 600 })).not.toHaveProperty("store");
  });
  it("never combines JSON mode with DeepSeek web tools", () => {
    const body = chatRequestBody(provider("deepseek"), "deepseek-flash", messages, { stream: false, maxTokens: 500, json: true, tools: [{ type: "deepseek_web_search" }] });
    expect(body.tools).toEqual([{ type: "deepseek_web_search" }]); expect(body).not.toHaveProperty("response_format");
  });
});

describe("streamed answers through a direct provider", () => {
  it("sends the provider key only to the provider, skips thinking text and reads DeepSeek usage", async () => {
    const onUsage = vi.fn();
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => sse([
      { choices: [{ delta: { reasoning_content: "thinking…" } }] }, { choices: [{ delta: { content: "Ship " } }] }, { choices: [{ delta: { content: "Friday." }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 120, prompt_cache_hit_tokens: 100, completion_tokens: 6 } }, "[DONE]"]));
    await expect(collect(answerDirect(fetcher, "sk-deepseek", "deepseek", "deepseek-flash", "I", [{ role: "user", content: "Q" }], signal(), { provider: provider("deepseek"), onUsage }))).resolves.toBe("Ship Friday.");
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(init).toMatchObject({ method: "POST", redirect: "error", credentials: "omit", cache: "no-store", headers: { Authorization: "Bearer sk-deepseek" } });
    expect(sent(fetcher)).toMatchObject({ model: "deepseek-flash", stream: true, max_tokens: 600, thinking: { type: "disabled" }, messages: [{ role: "system", content: "I" }, { role: "user", content: "Q" }] });
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 120, cachedInputTokens: 100, outputTokens: 6, reasoningTokens: 0, webSearchCalls: 0 }, true);
  });
  it("gives always-reasoning models the larger token budget", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => sse([{ choices: [{ delta: { content: "A." }, finish_reason: "stop" }] }, "[DONE]"]));
    await collect(answerDirect(fetcher, "k", "moonshot", "kimi-k3.1-pro", "I", [], signal(), { provider: provider("moonshot") }));
    expect(fetcher.mock.calls[0]![0]).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(sent(fetcher).max_completion_tokens).toBe(2000); expect(sent(fetcher).max_tokens).toBeUndefined();
  });
  it("adds the DeepSeek web search tool and returns dated citations from the final chunk", async () => {
    const onCitations = vi.fn(), onUsage = vi.fn();
    const final = { choices: [{ delta: {
      annotations: [{ type: "url_citation", url_citation: { url: "https://news.example.com/jetson", title: "Jetson lead times", start_index: 0, end_index: 5 } }, { type: "url_citation", url_citation: { url: "javascript:alert(1)", title: "x" } }],
      server_tool_calls: [{ index: 0, calls: [{ type: "deepseek_web_search", status: "completed", action: { type: "search", queries: ["jetson lead time"] }, sources: [{ type: "web", url: "https://news.example.com/jetson", title: "Jetson lead times", published_at: "2026-11-17T08:00:00Z" }] }] }],
    }, finish_reason: "stop" }] };
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => sse([{ choices: [{ delta: { content: "About 12 weeks." } }] }, final, "[DONE]"]));
    await collect(answerDirect(fetcher, "k", "deepseek", "deepseek-flash", "I", [], signal(), { provider: provider("deepseek"), webSearch: true, onCitations, onUsage }));
    expect(sent(fetcher).tools).toEqual([{ type: "deepseek_web_search" }]);
    expect(onCitations).toHaveBeenCalledWith([{ url: "https://news.example.com/jetson", title: "Jetson lead times", publishedAt: "2026-11-17", dateSource: "search" }]);
    expect(onUsage.mock.calls[0]![0].webSearchCalls).toBe(1);
  });
  it("classifies provider failures without showing upstream text", async () => {
    const run = (response: Response) => collect(answerDirect(async () => response, "k", "zhipu", "glm-5.2", "I", [], signal(), { provider: provider("zhipu") }));
    await expect(run(new Response("secret upstream detail", { status: 401 }))).rejects.toMatchObject({ code: "provider-authentication", message: "Zhipu GLM answer: check your API key and permissions." });
    await expect(run(new Response("{}", { status: 402 }))).rejects.toMatchObject({ code: "provider-billing" });
    await expect(run(Response.json({ error: { code: "1211", message: "Model does not exist" } }, { status: 400 }))).rejects.toMatchObject({ code: "model-access", message: expect.stringContaining("model glm-5.2 is not available to this key") });
    await expect(run(sse([{ choices: [{ delta: { content: "cut" } }] }]))).rejects.toBeInstanceOf(DirectProviderError);
  });
});

describe("provider search helpers", () => {
  it("normalizes publication dates and rejects impossible ones", () => {
    const now = Date.UTC(2026, 10, 19);
    expect(cleanPublishedAt("2026-11-17T08:00:00Z", now)).toBe("2026-11-17");
    expect(cleanPublishedAt("2026年11月5日", now)).toBe("2026-11-05");
    expect(cleanPublishedAt(1_794_873_600, now)).toBe("2026-11-17");
    for (const bad of ["", "yesterday", "2031-01-01", "1970-01-01", null, {}]) expect(cleanPublishedAt(bad, now)).toBeUndefined();
  });
  it("falls back to the search results when DeepSeek cites nothing", () => {
    const details = deepseekSearchDetails({ server_tool_calls: [{ calls: [{ type: "deepseek_web_search", status: "completed", sources: [{ url: "https://a.example/x", title: "A" }] }, { type: "deepseek_web_search", status: "failed", sources: [{ url: "https://b.example/y", title: "B" }] }] }] });
    expect(details).toEqual({ sources: [], searched: [{ url: "https://a.example/x", title: "A" }], calls: 1 });
  });
  it("calls the Zhipu Web Search API with a 70-character query and a recency filter", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ search_result: [
      { title: "央行公布最新利率", link: "https://news.example.cn/rate", media: "新华网", publish_date: "2026-11-18", content: "  利率  维持不变。 " },
      { title: "bad", link: "ftp://x", content: "" }, { title: "dup", link: "https://news.example.cn/rate" }] }));
    const results = await zhipuWebSearch(fetcher, provider("zhipu"), "id.secret", "x".repeat(200), { recency: "oneMonth" });
    expect(fetcher.mock.calls[0]![0]).toBe("https://open.bigmodel.cn/api/paas/v4/web_search");
    expect(fetcher.mock.calls[0]![1]!.headers).toMatchObject({ Authorization: "Bearer id.secret" });
    expect(sent(fetcher)).toEqual({ search_query: "x".repeat(70), search_engine: "search_std", search_intent: false, count: 8, search_recency_filter: "oneMonth", content_size: "medium" });
    expect(results).toEqual([{ url: "https://news.example.cn/rate", title: "央行公布最新利率", publishedAt: "2026-11-18", dateSource: "search", site: "新华网", snippet: "利率 维持不变。" }]);
    expect([...zhipuSearchQuery("最新".repeat(60))]).toHaveLength(70);
  });
  it("tests a provider key with one tiny request and never echoes the key", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => chatJson("OK"));
    const ok = await testProviderKey(fetcher, provider("qwen-intl"), " sk-q ", "qwen3.7-plus");
    expect(ok).toMatchObject({ status: "ok", model: "qwen3.7-plus" });
    expect(fetcher.mock.calls[0]![0]).toBe("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(sent(fetcher)).toMatchObject({ max_tokens: 32, enable_thinking: false, stream: false });
    expect(await testProviderKey(async () => new Response("", { status: 401 }), provider("deepseek"), "sk-secret-value", "deepseek-flash")).toMatchObject({ status: "invalid", message: expect.not.stringContaining("sk-secret-value") });
    expect((await testProviderKey(async () => new Response("", { status: 402 }), provider("deepseek"), "k", "deepseek-flash")).status).toBe("no-credits");
    expect((await testProviderKey(async () => { throw new TypeError("offline"); }, provider("deepseek"), "k", "deepseek-flash")).status).toBe("network");
    expect((await testProviderKey(fetcher, provider("deepseek"), "  ", "deepseek-flash")).status).toBe("invalid");
  });
  it("estimates usage when a provider returns none", async () => {
    const result = await chatComplete(async () => Response.json({ choices: [{ message: { content: "abcdefgh" } }] }), provider("moonshot"), "k", "kimi-k3", [{ role: "user", content: "Q" }], { maxTokens: 100 });
    expect(result).toMatchObject({ text: "abcdefgh", measured: false }); expect(result.usage.outputTokens).toBe(2);
  });
});

const config = (answerProvider: string, model: string, transcriptionProvider = "deepgram"): SessionConfig => ({
  sessionId: "phone-v13", endpoint: directEndpoint(answerProvider, model),
  prompt: { id: "p", version: "1", system: "Be brief.", maxResponseSentences: 2 },
  providers: { transcriptionProvider, answerProvider },
  speaker: { label: "User", role: "unknown" }, mode: "general", responseStrategy: "reactive", locale: "en-US",
  automation: { detectQuestions: true, answerQuestions: true, saveNotes: false }, memory: { readOmiContext: false, syncNotes: false },
});
function setup(fetcher: (url: string, init?: RequestInit) => Promise<Response>, options: DirectConversationOptions = {}) {
  const usage: UsageRecord[] = [], metas: AnswerMeta[] = [], events: GatewayEvent[] = [];
  const transport = new DirectConversationTransport({ fetch: fetcher, onUsage: u => usage.push(u), onAnswerMeta: m => metas.push(m), ...options });
  const client = new HelixConversationClient(transport, { vad: false, noteSink: new InMemoryNoteSink(), autoSaveSuggestedNotes: true });
  client.subscribe(event => events.push(event));
  return { transport, client, events, usage, metas };
}

describe("a session answered by a direct provider", () => {
  it("runs on a DeepSeek key plus Deepgram without any OpenAI key, with DeepSeek provenance", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => sse([{ choices: [{ delta: { content: "Ship Friday." }, finish_reason: "stop" }] }, { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 200 } }, "[DONE]"]));
    const { transport, client, events, usage, metas } = setup(fetcher);
    await client.start(config("deepseek", "deepseek-flash"), { deepseek: "sk-deepseek", deepgram: "dg" });
    await transport.injectTranscript("What is our launch plan for the robot?", { label: "Other", role: "other" });
    await settle();
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(["https://api.deepseek.com/chat/completions"]);
    expect((fetcher.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe("Bearer sk-deepseek");
    const completed = events.find(event => event.type === "answer.completed");
    expect(completed).toMatchObject({ text: "Ship Friday.", context: { endpoint: { id: "deepseek-direct", url: "https://api.deepseek.com/chat/completions", provider: "deepseek", model: "deepseek-flash" }, answerProvider: { profileId: "deepseek", model: "deepseek-flash" } } });
    expect(usage.find(item => item.kind === "answer")).toMatchObject({ model: "deepseek-flash", inputTokens: 1000, outputTokens: 200, measured: true, costUsd: 0.00054 });
    expect(metas[0]).toMatchObject({ grounded: "conversation", sources: [] });
    await client.stop();
  });
  it("explains which key is missing instead of failing vaguely", async () => {
    const start = (answerProvider: string, model: string, stt: string, credentials: Record<string, string>) => setup(async () => new Response("")).client.start(config(answerProvider, model, stt), credentials);
    await expect(start("zhipu", "glm-5.2", "deepgram", { deepgram: "dg", openai: "sk-o" })).rejects.toThrow("Enter your Zhipu GLM API key in API keys & setup.");
    await expect(start("moonshot", "kimi-k3", "openai-realtime", { moonshot: "sk-m" })).rejects.toThrow(/gpt-live-transcribe transcription needs an OpenAI API key.*Deepgram or Soniox/u);
    await expect(start("openai-responses", "gpt-6.1-terra", "deepgram", { deepgram: "dg" })).rejects.toThrow("Enter your OpenAI API key in API keys & setup.");
    await expect(start("made-up", "x", "deepgram", { deepgram: "dg" })).rejects.toThrow("Select a supported phone transcription and answer provider.");
  });
  it("replaces an OpenAI model id sent to a direct provider with the provider default", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => sse([{ choices: [{ delta: { content: "Yes." }, finish_reason: "stop" }] }, "[DONE]"]));
    const { transport, client } = setup(fetcher);
    await client.start({ ...config("qwen", "gpt-6.1-terra"), endpoint: directEndpoint("qwen", "qwen3.7-plus") }, { dashscope: "sk-q", deepgram: "dg" });
    await transport.injectTranscript("Is the budget approved for the pilot?", { label: "Other", role: "other" });
    await settle();
    expect(sent(fetcher).model).toBe("qwen3.7-plus");
    await client.stop();
  });
});

describe("copilot on a direct provider", () => {
  it("analyses in JSON mode with the schema in the prompt and the provider's copilot model", async () => {
    const summaries: CopilotSummary[] = [], usage: UsageRecord[] = [];
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => chatJson(`\`\`\`json\n${JSON.stringify({ summary: { bullets: ["Launch is Friday."], keyFacts: [] } })}\n\`\`\``));
    const copilot = new ConversationCopilot({ fetch: fetcher, key: "sk-q", sessionId: "s", provider: provider("qwen"), cooldownMs: 0, onUsage: item => usage.push(item),
      callbacks: { enabled: () => true, settings: () => ({ ...DEFAULT_COPILOT_SETTINGS, concepts: false, conflicts: false, suggestions: false, implicitAsks: false, claims: false, people: false }), onSummary: item => summaries.push(item) } });
    copilot.submit("t1", "We agreed the launch is Friday.", "Speaker");
    await settle();
    expect(fetcher.mock.calls[0]![0]).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    const body = sent(fetcher);
    expect(body).toMatchObject({ model: "qwen3.8-flash", stream: false, enable_thinking: false, max_tokens: 1500 });
    expect(body.messages[0].content).toContain("Return one JSON object and nothing else."); expect(body.messages[0].content).toContain("JSON Schema");
    expect(summaries[0]?.bullets).toEqual(["Launch is Friday."]);
    expect(usage[0]).toMatchObject({ kind: "copilot", model: "qwen3.8-flash", inputTokens: 40, outputTokens: 10, measured: true });
    copilot.cancel();
  });
});
