import { describe, expect, it, vi } from "vitest";
import { NO_WEB_SEARCH_MESSAGE, WebFactChecker, isTimeSensitive, verifyClaim, type FactCheckResult } from "../src/fact-check.js";
import { ANSWER_LENGTHS, answerLengthProfile, answerLengthTokens, answerSentenceLimit, cleanAnswerLength } from "../src/answer-length.js";
import { ConversationCopilot, copilotInstructions } from "../src/copilot.js";
import { resolveSearchRoute } from "../src/provider-registry.js";
import { DirectConversationTransport, type DirectConversationOptions } from "../src/direct-transport.js";
import { HelixConversationClient } from "../src/client.js";
import { InMemoryNoteSink } from "../src/notes.js";
import { DEFAULT_COPILOT_SETTINGS, type AnswerLength, type CopilotAsk, type SessionConfig, type UsageRecord, type VerificationResult } from "../src/index.js";

const NOW = Date.UTC(2026, 10, 19, 12);
const signal = () => new AbortController().signal;
const sent = (fetcher: ReturnType<typeof vi.fn>, call = 0) => JSON.parse(fetcher.mock.calls[call]![1]!.body as string);
const settle = async (ms = 30) => { await new Promise(resolve => setTimeout(resolve, ms)); };
const NASA = "https://www.nasa.gov/history/apollo-11-mission-overview/";
/** OpenAI Responses verdict with one real url_citation annotation. */
const cited = (verdict: Record<string, unknown>) => Response.json({ status: "completed", usage: { input_tokens: 500, output_tokens: 60 }, output: [
  { type: "web_search_call", id: "ws1", status: "completed" },
  { type: "message", content: [{ type: "output_text", text: JSON.stringify(verdict), annotations: [{ type: "url_citation", url: NASA, title: "NASA Apollo 11", start_index: 0, end_index: 20 }] }] }] });
const chatJson = (content: string, extra: Record<string, unknown> = {}) => Response.json({ choices: [{ message: { role: "assistant", content, ...extra }, finish_reason: "stop" }], usage: { prompt_tokens: 300, completion_tokens: 40 } });

describe("answer length profiles", () => {
  it("keeps Standard identical to the limits that were hard-coded before the setting", () => {
    expect(ANSWER_LENGTHS).toEqual(["brief", "standard", "detailed"]);
    expect(answerLengthProfile(undefined)).toMatchObject({ id: "standard", style: "", answerTokens: 600, answerReasoningTokens: 2000, lookupSentences: 3, proposeSentences: 4, lookupTokens: 400, lookupReasoningTokens: 2000, lookupChars: 1200,
      verdictSentences: "one or two sentence", verdictTokens: 500, verdictReasoningTokens: 2000, conceptSentences: "one or two sentences" });
    expect(cleanAnswerLength("huge")).toBe("standard"); expect(cleanAnswerLength("brief")).toBe("brief");
  });
  it("scales sentences and tokens for Brief and Detailed", () => {
    expect([1, 3, 10].map(base => answerSentenceLimit("brief", base))).toEqual([1, 2, 2]);
    expect([1, 3, 10, undefined].map(base => answerSentenceLimit("standard", base))).toEqual([1, 3, 10, 3]);
    expect([1, 3, 10].map(base => answerSentenceLimit("detailed", base))).toEqual([6, 6, 10]);
    expect([answerLengthTokens("brief", false), answerLengthTokens("standard", false), answerLengthTokens("detailed", false)]).toEqual([300, 600, 1200]);
    expect([answerLengthTokens("brief", true), answerLengthTokens("standard", true), answerLengthTokens("detailed", true)]).toEqual([1500, 2000, 3000]);
  });
  it("drives the concept wording of the copilot prompt and leaves the default prompt unchanged", () => {
    const standard = copilotInstructions(DEFAULT_COPILOT_SETTINGS);
    expect(standard).toContain("Explain what it is in general (one or two sentences, speech language)");
    expect(copilotInstructions({ ...DEFAULT_COPILOT_SETTINGS, answerLength: "standard" })).toBe(standard);
    expect(copilotInstructions({ ...DEFAULT_COPILOT_SETTINGS, answerLength: "brief" })).toContain("(one short sentence, speech language)");
    expect(copilotInstructions({ ...DEFAULT_COPILOT_SETTINGS, answerLength: "detailed" })).toContain("(two to four sentences, speech language)");
  });
});

const config: SessionConfig = {
  sessionId: "phone-v13-length", endpoint: { id: "openai-direct", url: "https://api.openai.com/v1/responses", provider: "openai", model: "gpt-6.1-terra" },
  prompt: { id: "p", version: "1", system: "Be brief.", maxResponseSentences: 3 },
  providers: { transcriptionProvider: "openai-transcribe", answerProvider: "openai-responses" },
  speaker: { label: "User", role: "unknown" }, mode: "general", responseStrategy: "reactive", locale: "en-US",
  automation: { detectQuestions: true, answerQuestions: true, saveNotes: false }, memory: { readOmiContext: false, syncNotes: false },
};
function sse(events: unknown[]) { return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } }); }
const answered = () => sse([{ type: "response.output_text.delta", delta: "Ship Friday." }, { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 5 } } }]);
async function answerBody(length: AnswerLength | undefined, model = "gpt-6.1-terra", options: DirectConversationOptions = {}) {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => answered());
  const transport = new DirectConversationTransport({ fetch: fetcher, ...(length ? { answerLength: () => length } : {}), ...options });
  const client = new HelixConversationClient(transport, { vad: false, noteSink: new InMemoryNoteSink() });
  await client.start({ ...config, endpoint: { ...config.endpoint, model } }, { openai: "sk-o" });
  await transport.injectTranscript("What is our launch plan for the robot?", { label: "Other", role: "other" });
  await settle();
  const body = sent(fetcher);
  await client.stop();
  return body as { instructions: string; max_output_tokens: number };
}

describe("answer length in the live answer lane", () => {
  it("sends exactly the old prompt and token limits when unset or Standard", async () => {
    const unset = await answerBody(undefined), standard = await answerBody("standard");
    expect(unset.instructions).toContain("\nRespond in at most 3 sentences. Use plain speakable text");
    expect(unset.max_output_tokens).toBe(2000);
    expect(standard.instructions).toBe(unset.instructions); expect(standard.max_output_tokens).toBe(2000);
    expect((await answerBody(undefined, "gpt-4.1-mini")).max_output_tokens).toBe(600);
  });
  it("shortens and lengthens the sentence cap, wording and output tokens", async () => {
    const brief = await answerBody("brief"), detailed = await answerBody("detailed");
    expect(brief.instructions).toContain("Respond in at most 2 sentences. Be as brief as possible"); expect(brief.max_output_tokens).toBe(1500);
    expect(detailed.instructions).toContain("Respond in at most 6 sentences. Give a fuller answer"); expect(detailed.max_output_tokens).toBe(3000);
    expect((await answerBody("brief", "gpt-4.1-mini")).max_output_tokens).toBe(300);
    expect((await answerBody("detailed", "gpt-4.1-mini")).max_output_tokens).toBe(1200);
  });
  it("applies a length changed mid-session to the next answer and survives a throwing host callback", async () => {
    expect((await answerBody(undefined, "gpt-4.1-mini", { answerLength: () => { throw new Error("host"); } })).max_output_tokens).toBe(600);
  });
});

describe("answer length in lookups and verdicts", () => {
  const ask = async (answerLength: AnswerLength | undefined, text: string) => {
    const asks: CopilotAsk[] = [];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => String(init?.body).includes("helix_copilot")
      ? Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ asks: [{ kind: "propose", topic: "architecture for 16GB RAM", trigger: "The architecture is 16 GB RAM with a 1 TB SSD." }] }), annotations: [] }] }] })
      : Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text, annotations: [] }] }] }));
    const copilot = new ConversationCopilot({ fetch: fetcher, key: "k", sessionId: "s", cooldownMs: 0,
      callbacks: { enabled: () => true, settings: () => ({ ...DEFAULT_COPILOT_SETTINGS, summarize: false, concepts: false, conflicts: false, suggestions: false, claims: false, people: false, copilotModel: "gpt-4.1-mini", ...(answerLength ? { answerLength } : {}) }), onAsk: item => asks.push(item) } });
    copilot.submit("t1", "The architecture is 16 GB RAM with a 1 TB SSD.", "Speaker");
    await settle(40);
    copilot.cancel();
    return { body: sent(fetcher, 1), answer: asks.find(item => item.status === "done")?.answer ?? "" };
  };
  const seven = "One. Two. Three. Four. Five. Six. Seven.";
  it("keeps 4-sentence proposals and 400 tokens by default", async () => {
    const { body, answer } = await ask(undefined, seven);
    expect(body.instructions).toContain("At most 4 short sentences"); expect(body.max_output_tokens).toBe(400); expect(answer).toBe("One. Two. Three. Four.");
  });
  it("uses 2 sentences for Brief and 6 for Detailed", async () => {
    const brief = await ask("brief", seven), detailed = await ask("detailed", seven);
    expect(brief.body.max_output_tokens).toBe(250); expect(brief.answer).toBe("One. Two.");
    expect(detailed.body.instructions).toContain("At most 6 short sentences"); expect(detailed.body.max_output_tokens).toBe(800); expect(detailed.answer).toBe("One. Two. Three. Four. Five. Six.");
  });
  it("sizes the web-check verdict", async () => {
    const run = async (length?: AnswerLength) => {
      const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => cited({ status: "supported", summary: "True." }));
      await verifyClaim({ fetch: fetcher, key: "k", claim: "The moon landing was in 1969.", signal: signal(), model: "gpt-4.1-mini", ...(length ? { length } : {}) });
      return sent(fetcher);
    };
    const standard = await run();
    expect(standard.max_output_tokens).toBe(500); expect(standard.instructions).toContain("a one or two sentence summary");
    expect((await run("standard")).instructions).toBe(standard.instructions);
    const brief = await run("brief"), detailed = await run("detailed");
    expect(brief.max_output_tokens).toBe(350); expect(brief.instructions).toContain("a one short sentence summary");
    expect(detailed.max_output_tokens).toBe(800); expect(detailed.instructions).toContain("a three or four sentence summary");
  });
});

describe("news-backed fact search", () => {
  it("recognises time-sensitive claims in English and Chinese", () => {
    for (const text of ["What is the latest news on the Jetson shortage?", "Nvidia just announced a new board.", "The stock price fell today.", "最新的利率是多少？", "今天发布了新模型。"]) expect(isTimeSensitive(text)).toBe(true);
    for (const text of ["The moon landing was in 1969.", "Water is an element.", "水是一种元素。"]) expect(isTimeSensitive(text)).toBe(false);
  });
  it("leaves the OpenAI request and result shape unchanged when news search is off", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => cited({ status: "contradicted", summary: "It was 1969.", sources: [{ url: NASA, publishedAt: "2026-11-01" }] }));
    const result = await verifyClaim({ fetch: fetcher, key: "k", claim: "The latest moon landing was in 1970.", signal: signal(), now: NOW });
    expect(result).toEqual({ status: "contradicted", summary: "It was 1969.", sources: [{ url: NASA, title: "NASA Apollo 11" }] });
    expect(sent(fetcher).instructions).not.toContain("Today is");
  });
  it("asks OpenAI for recent, dated evidence and keeps a reported date only for a really cited page", async () => {
    const usage: UsageRecord[] = [];
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => cited({ status: "supported", summary: "Lead times are about 12 weeks as of 17 Nov 2026.",
      sources: [{ url: NASA, publishedAt: "2026-11-17" }, { url: "https://invented.example/never-cited", publishedAt: "2026-11-18" }] }));
    const result = await verifyClaim({ fetch: fetcher, key: "k", claim: "Jetson lead times are currently about 12 weeks.", signal: signal(), news: true, now: NOW, onUsage: item => usage.push(item) });
    const body = sent(fetcher);
    expect(body.tools).toEqual([{ type: "web_search" }]);
    expect(body.instructions).toMatch(/Today is 2026-11-19\. Prefer the most recent reporting.*latest news first.*"sources" array.*Never guess a date\./u);
    expect(result).toEqual({ status: "supported", summary: "Lead times are about 12 weeks as of 17 Nov 2026.", recency: "news",
      sources: [{ url: NASA, title: "NASA Apollo 11", publishedAt: "2026-11-17", dateSource: "model" }] });
    expect(usage[0]).toMatchObject({ kind: "fact-check", webSearchCalls: 1, measured: true });
  });
  it("drops future or unparsable reported dates and marks stable claims as general", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => cited({ status: "supported", summary: "True.", sources: [{ url: NASA, publishedAt: "2031-01-01" }] }));
    const result = await verifyClaim({ fetch: fetcher, key: "k", claim: "The moon landing was in 1969.", signal: signal(), news: true, now: NOW });
    expect(result).toEqual({ status: "supported", summary: "True.", recency: "general", sources: [{ url: NASA, title: "NASA Apollo 11" }] });
    expect(sent(fetcher).instructions).toContain("If the facts changed recently, say so with the date.");
  });
  it("still refuses a verdict without a real citation when news search is on", async () => {
    const response = Response.json({ status: "completed", output: [{ type: "web_search_call", status: "completed" }, { type: "message", content: [{ type: "output_text", text: JSON.stringify({ status: "supported", summary: "Sure.", sources: [{ url: NASA, publishedAt: "2026-11-17" }] }), annotations: [] }] }] });
    expect(await verifyClaim({ fetch: async () => response, key: "k", claim: "Rates rose today.", signal: signal(), news: true, now: NOW })).toMatchObject({ status: "uncertain", sources: [] });
  });

  it("checks through DeepSeek web search with the DeepSeek key and search-result dates", async () => {
    const usage: UsageRecord[] = [];
    const route = resolveSearchRoute("deepseek", { deepseek: "sk-d", openai: "sk-o" })!;
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => chatJson("```json\n{\"status\":\"contradicted\",\"summary\":\"The rate was held, not cut, as of 18 Nov 2026.\"}\n```", {
      annotations: [{ type: "url_citation", url_citation: { url: "https://news.example.com/rates", title: "Central bank holds rates", start_index: 0, end_index: 4 } }],
      server_tool_calls: [{ index: 0, calls: [{ type: "deepseek_web_search", status: "completed", sources: [{ url: "https://news.example.com/rates", title: "Central bank holds rates", published_at: "2026-11-18" }, { url: "https://other.example/x", title: "Other" }] }] }] }));
    const result = await verifyClaim({ fetch: fetcher, key: "sk-o", claim: "The central bank cut rates today.", signal: signal(), search: route, news: true, now: NOW, onUsage: item => usage.push(item) });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer sk-d");
    const body = sent(fetcher);
    expect(body).toMatchObject({ model: "deepseek-flash", stream: false, tools: [{ type: "deepseek_web_search" }], thinking: { type: "disabled" }, max_tokens: 500 });
    expect(body).not.toHaveProperty("response_format");
    expect(body.messages[0].content).toMatch(/Today is 2026-11-19.*latest news first/u);
    expect(result).toEqual({ status: "contradicted", summary: "The rate was held, not cut, as of 18 Nov 2026.", recency: "news", via: "DeepSeek",
      sources: [{ url: "https://news.example.com/rates", title: "Central bank holds rates", publishedAt: "2026-11-18", dateSource: "search" }] });
    // DeepSeek does not bill searches per call.
    expect(usage[0]).toMatchObject({ model: "deepseek-flash", webSearchCalls: 1, inputTokens: 300, costUsd: 0.000138 });
  });
  it("returns uncertain when DeepSeek neither searched nor cited", async () => {
    const route = resolveSearchRoute("deepseek", { deepseek: "sk-d" })!;
    const result = await verifyClaim({ fetch: async () => chatJson("{\"status\":\"supported\",\"summary\":\"Trust me.\"}"), key: "", claim: "Rates rose today.", signal: signal(), search: route });
    expect(result).toEqual({ status: "uncertain", summary: "A sourced conclusion could not be established for this claim.", sources: [], via: "DeepSeek" });
  });

  it("checks through the Zhipu Web Search API with a recency filter, then lets GLM judge only those results", async () => {
    const route = resolveSearchRoute("zhipu", { zhipu: "id.secret" })!;
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith("/web_search")
      ? Response.json({ search_result: [
        { title: "央行维持利率不变", link: "https://news.example.cn/a", media: "新华网", publish_date: "2026-11-18", content: "央行今日宣布维持利率不变。" },
        { title: "旧闻", link: "https://news.example.cn/b", media: "某站", publish_date: "2025-01-02", content: "去年降息。" }] })
      : chatJson(JSON.stringify({ status: "contradicted", summary: "截至11月18日，央行维持利率不变。", used: [1, 9, 1] })));
    const result = await verifyClaim({ fetch: fetcher, key: "", claim: "央行今天降息了。", signal: signal(), search: route, news: true, now: NOW });
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(["https://open.bigmodel.cn/api/paas/v4/web_search", "https://open.bigmodel.cn/api/paas/v4/chat/completions"]);
    expect(sent(fetcher, 0)).toMatchObject({ search_query: "央行今天降息了。", search_engine: "search_std", search_recency_filter: "oneMonth" });
    const chat = sent(fetcher, 1);
    expect(chat).toMatchObject({ model: "glm-4.7-flash", response_format: { type: "json_object" }, thinking: { type: "disabled" }, max_tokens: 1024 });
    expect(JSON.parse(chat.messages[1].content)).toMatchObject({ summaryLanguage: "Chinese", results: [{ n: 1, title: "央行维持利率不变", site: "新华网", publishedAt: "2026-11-18" }, { n: 2, publishedAt: "2025-01-02" }] });
    expect(result).toEqual({ status: "contradicted", summary: "截至11月18日，央行维持利率不变。", recency: "news", via: "Zhipu GLM",
      sources: [{ url: "https://news.example.cn/a", title: "央行维持利率不变", publishedAt: "2026-11-18", dateSource: "search", site: "新华网" }] });
  });
  it("widens a Zhipu search that found nothing recent, and stays uncertain without results or used sources", async () => {
    const route = resolveSearchRoute("zhipu", { zhipu: "id.secret" })!;
    const empty = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ search_result: [] }));
    expect(await verifyClaim({ fetch: empty, key: "", claim: "Rates rose today.", signal: signal(), search: route, news: true, now: NOW })).toMatchObject({ status: "uncertain", sources: [], via: "Zhipu GLM" });
    expect(empty.mock.calls.map(call => JSON.parse(call[1]!.body as string).search_recency_filter)).toEqual(["oneMonth", "noLimit"]);
    const unused = async (url: string) => url.endsWith("/web_search") ? Response.json({ search_result: [{ title: "A", link: "https://a.example/x", content: "x" }] }) : chatJson(JSON.stringify({ status: "supported", summary: "Yes.", used: [] }));
    expect(await verifyClaim({ fetch: unused, key: "", claim: "Water is wet.", signal: signal(), search: route })).toMatchObject({ status: "uncertain", sources: [] });
  });
});

describe("fact-check lane with a search route", () => {
  it("stays silent when the provider has no search and no OpenAI key, and says why on a user request", async () => {
    const fetcher = vi.fn(), onResult = vi.fn();
    const checker = new WebFactChecker({ key: "", sessionId: "s", fetch: fetcher, enabled: () => true, onResult, search: () => resolveSearchRoute("qwen", { dashscope: "sk-q" }) });
    checker.submit("t", "The moon landing was in 1970.");
    await settle();
    expect(fetcher).not.toHaveBeenCalled(); expect(onResult).not.toHaveBeenCalled();
    expect(await checker.verifyNow("The moon landing was in 1970.")).toEqual({ status: "unavailable", summary: NO_WEB_SEARCH_MESSAGE, sources: [] });
    expect(NO_WEB_SEARCH_MESSAGE).toContain("No web search is available for the selected answer provider");
    checker.cancel();
  });
  it("falls back to OpenAI web search for a provider without search when an OpenAI key is present", async () => {
    const results: FactCheckResult[] = [];
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => cited({ status: "contradicted", summary: "It was 1969." }));
    const checker = new WebFactChecker({ key: "", sessionId: "s", fetch: fetcher, enabled: () => true, onResult: item => results.push(item), search: () => resolveSearchRoute("moonshot", { moonshot: "sk-m", openai: "sk-o" }) });
    checker.submit("t", "The moon landing was in 1970.");
    await settle();
    expect(fetcher.mock.calls[0]![0]).toBe("https://api.openai.com/v1/responses");
    expect((fetcher.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe("Bearer sk-o");
    expect(results[0]).toMatchObject({ status: "contradicted", via: "OpenAI" });
    checker.cancel();
  });
  it("also checks statements about current events when news search is on", async () => {
    const run = async (news: boolean) => {
      const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => cited({ status: "supported", summary: "Yes." }));
      const checker = new WebFactChecker({ key: "k", sessionId: "s", fetch: fetcher, enabled: () => true, onResult: () => undefined, news: () => news });
      checker.submit("t", "Nvidia just announced another Jetson board.");
      await settle();
      checker.cancel();
      return fetcher.mock.calls.length;
    };
    expect(await run(false)).toBe(0); expect(await run(true)).toBe(1);
  });
  it("passes news bias and length from copilot settings to a user verification, and reports a missing route", async () => {
    const results: VerificationResult[] = [];
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => cited({ status: "supported", summary: "Yes." }));
    const make = (search?: () => undefined) => new ConversationCopilot({ fetch: fetcher, key: "k", sessionId: "s", ...(search ? { search } : {}),
      callbacks: { enabled: () => true, settings: () => ({ ...DEFAULT_COPILOT_SETTINGS, copilotModel: "gpt-4.1-mini", newsSearch: true, answerLength: "brief" as const }), onVerification: item => results.push(item) } });
    make().verify("Rates rose today.", "v1");
    await settle();
    expect(sent(fetcher)).toMatchObject({ max_output_tokens: 350 }); expect(sent(fetcher).instructions).toContain("Today is");
    expect(results[0]).toMatchObject({ id: "v1", status: "supported", recency: "news", requestedBy: "user" });
    make(() => undefined).verify("Rates rose today.", "v2");
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(results[1]).toMatchObject({ id: "v2", status: "unavailable", summary: NO_WEB_SEARCH_MESSAGE });
  });
});
