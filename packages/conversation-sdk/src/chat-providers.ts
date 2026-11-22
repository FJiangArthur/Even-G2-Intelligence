/**
 * OpenAI-compatible Chat Completions for the non-OpenAI providers in provider-registry.ts
 * (DeepSeek, Qwen, Zhipu GLM, Moonshot Kimi), plus the two provider searches Helix has verified:
 * DeepSeek's `deepseek_web_search` server tool and Zhipu's Web Search API.
 *
 * Browser-native like direct-providers.ts: fixed URLs from the registry, no redirects, no cookies,
 * and upstream error bodies are only inspected to classify, never shown.
 */
import type { Citation } from "./copilot-types.js";
import { answerOutputTokens, DirectProviderError, httpFailure, isContextOverflow, parseChatUsage, parseCitation, parseStreamEvent, promptContextFailure, unreadableStream, type AnswerRequestOptions, type DirectFetch } from "./direct-providers.js";
import { answerModelInfo, type RawUsage } from "./model-catalog.js";
import type { AnswerProviderInfo } from "./provider-registry.js";

const FRAMING_RESERVE = 1024;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const estimateTokens = (text: string) => Math.ceil(new TextEncoder().encode(text).length / 4);
export interface ChatMessage { readonly role: string; readonly content: string }

/** Publication date from a provider or model -> "YYYY-MM-DD"; undefined when missing, unparsable, before 1990 or in the future. */
export function cleanPublishedAt(value: unknown, now = Date.now()): string | undefined {
  let time: number;
  if (typeof value === "number" && Number.isFinite(value)) time = value < 1e11 ? value * 1000 : value;
  else if (typeof value === "string" && value.trim() && value.length <= 64) {
    const text = value.trim();
    const ymd = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/u.exec(text);
    time = ymd ? Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])) : Date.parse(text);
  } else return undefined;
  if (!Number.isFinite(time) || time < Date.UTC(1990, 0, 1) || time > now + 2 * 86_400_000) return undefined;
  return new Date(time).toISOString().slice(0, 10);
}

/** One request body for a provider, with its documented differences applied. */
export function chatRequestBody(provider: AnswerProviderInfo, model: string, messages: readonly ChatMessage[], options: { stream: boolean; maxTokens: number; json?: boolean; tools?: readonly unknown[] }): Record<string, unknown> {
  return {
    model, messages, stream: options.stream,
    ...(options.stream && provider.streamOptions ? { stream_options: provider.streamOptions } : {}),
    [provider.tokenParam]: Math.max(options.maxTokens, provider.minOutputTokens ?? 0),
    ...provider.quick(model),
    // DeepSeek rejects response_format together with its web tools, so JSON mode is never combined with tools.
    ...(options.json && provider.jsonObject && !options.tools?.length ? { response_format: { type: "json_object" } } : {}),
    ...(options.tools?.length ? { tools: options.tools } : {}),
  };
}

async function providerFetch(fetcher: DirectFetch, provider: AnswerProviderInfo, path: string, key: string, body: string, signal: AbortSignal | undefined, purpose: string, model?: string): Promise<Response> {
  // Fixed provider URL and no redirects: the key cannot be forwarded to another host.
  const response = await fetcher(`${provider.baseUrl}${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body, ...(signal ? { signal } : {}),
    redirect: "error", credentials: "omit", cache: "no-store",
  });
  if (response.ok) return response;
  const label = `${provider.label} ${purpose}`;
  if ([400, 403, 404].includes(response.status)) {
    // Inspect only to classify. Never surface arbitrary upstream body text.
    const detail: unknown = await response.json().catch(() => undefined);
    const error = isRecord(detail) && isRecord(detail.error) ? detail.error : detail;
    if (response.status === 400 && isContextOverflow(error)) throw promptContextFailure();
    const text = isRecord(error) ? `${String(error.code ?? "")} ${String(error.message ?? "")}` : "";
    if (/model/iu.test(text) && /not[ _]?(?:exist|found)|does not exist|invalid|unsupported|no access|不存在|无权/iu.test(text)) {
      throw new DirectProviderError("model-access", `${label}: ${model ? `model ${model}` : "the selected model"} is not available to this key. Pick another model in Setup.`);
    }
  }
  throw httpFailure(label, response.status);
}

/** url_citation annotations in either shape: OpenAI's flat one or DeepSeek's `{ type, url_citation: {...} }`. */
function annotationSource(value: unknown): Citation | undefined {
  if (!isRecord(value) || value.type !== "url_citation") return;
  return parseCitation(isRecord(value.url_citation) ? { type: "url_citation", ...value.url_citation } : value);
}

/** Citations, search-result dates and completed search count from a DeepSeek message (or final stream delta). */
export function deepseekSearchDetails(message: unknown): { sources: Citation[]; searched: Citation[]; calls: number } {
  const cited = new Map<string, Citation>(), searched = new Map<string, Citation>();
  let calls = 0;
  if (!isRecord(message)) return { sources: [], searched: [], calls };
  for (const step of Array.isArray(message.server_tool_calls) ? message.server_tool_calls : []) {
    for (const call of isRecord(step) && Array.isArray(step.calls) ? step.calls : []) {
      if (!isRecord(call) || call.type !== "deepseek_web_search" || call.status !== "completed") continue;
      calls++;
      for (const item of [...(Array.isArray(call.sources) ? call.sources : []), ...(isRecord(call.page) ? [call.page] : [])]) {
        if (!isRecord(item)) continue;
        const source = parseCitation({ type: "url_citation", url: item.url, title: item.title });
        if (!source || searched.has(source.url)) continue;
        const publishedAt = cleanPublishedAt(item.published_at);
        searched.set(source.url, { ...source, ...(publishedAt ? { publishedAt, dateSource: "search" as const } : {}) });
      }
    }
  }
  for (const annotation of Array.isArray(message.annotations) ? message.annotations : []) {
    const source = annotationSource(annotation);
    if (!source || cited.has(source.url)) continue;
    const found = searched.get(source.url);
    cited.set(source.url, found?.publishedAt ? { ...source, title: source.title === new URL(source.url).hostname ? found.title : source.title, publishedAt: found.publishedAt, dateSource: "search" } : source);
  }
  return { sources: [...cited.values()].slice(0, 8), searched: [...searched.values()], calls };
}

const DEEPSEEK_SEARCH_TOOL = Object.freeze([Object.freeze({ type: "deepseek_web_search" })]);
/** Search tools to attach to a chat request for this provider, when it has an in-request search. */
export function providerSearchTools(provider: AnswerProviderInfo): readonly unknown[] | undefined {
  return provider.search === "deepseek-web-search" ? DEEPSEEK_SEARCH_TOOL : undefined;
}

/** Streamed answer through a provider's Chat Completions endpoint. Same contract as answerDirect. */
export async function* chatAnswerStream(fetcher: DirectFetch, provider: AnswerProviderInfo, key: string, model: string, instructions: string, history: readonly ChatMessage[], signal: AbortSignal, options: AnswerRequestOptions = {}): AsyncGenerator<string> {
  const verified = answerModelInfo(model)?.contextWindow;
  // Custom ids keep the provisional budget used for unknown OpenAI ids.
  const window = verified ?? 4096;
  const output = Math.max(options.maxOutputTokens ?? answerOutputTokens(model), provider.minOutputTokens ?? 0);
  const tools = options.webSearch ? providerSearchTools(provider) : undefined;
  const retained = [...history];
  const serialize = () => JSON.stringify(chatRequestBody(provider, model, [{ role: "system", content: instructions }, ...retained], { stream: true, maxTokens: output, ...(tools ? { tools } : {}) }));
  let body = serialize();
  const fits = () => new TextEncoder().encode(body).length + output + FRAMING_RESERVE <= window;
  while (!fits() && retained.length > 1) {
    retained.shift();
    while (retained.length > 1 && retained[0]?.role === "assistant") retained.shift();
    body = serialize();
  }
  if (!fits()) throw promptContextFailure(verified === undefined);
  const response = await providerFetch(fetcher, provider, "/chat/completions", key, body, signal, "answer", model);
  if (!response.body) throw new DirectProviderError("provider-response", `${provider.label} returned no answer stream.`);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", completed = false, carriage = "", produced = "", usage: RawUsage | undefined, malformed = 0;
  let sources: Citation[] = [], searchCalls = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      let chunk = carriage + decoder.decode(value, { stream: !done });
      carriage = !done && chunk.endsWith("\r") ? "\r" : "";
      if (carriage) chunk = chunk.slice(0, -1);
      buffer += chunk.replace(/\r\n?/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        if (data === "[DONE]") { completed = true; continue; }
        // One garbled event is skipped; it must not look like a network failure.
        const event = parseStreamEvent(data);
        if (!event) { malformed++; continue; }
        if (event.error) {
          if (isContextOverflow(event.error)) throw promptContextFailure();
          throw new DirectProviderError("provider-response", `${provider.label} could not complete the answer.`);
        }
        const chatUsage = parseChatUsage(event.usage); if (chatUsage) usage = chatUsage;
        const choice = Array.isArray(event.choices) && isRecord(event.choices[0]) ? event.choices[0] : undefined;
        const delta = choice && isRecord(choice.delta) ? choice.delta : undefined;
        // `reasoning_content` (thinking text) is never shown or spoken; only `content` is the answer.
        const text = delta && typeof delta.content === "string" ? delta.content : "";
        if (text) { produced += text; yield text; }
        if (tools && delta && (Array.isArray(delta.annotations) || Array.isArray(delta.server_tool_calls))) {
          const details = deepseekSearchDetails(delta);
          if (details.sources.length) sources = details.sources;
          searchCalls = Math.max(searchCalls, details.calls);
        }
        if (choice?.finish_reason === "length") {
          // Cut at the length limit after text streamed: the text so far is the (partial) answer.
          if (!produced.trim() || !options.onIncomplete) throw new DirectProviderError("provider-response", "Answer exceeded its length limit. Ask a shorter question, or choose a longer answer length in Setup.");
          try { options.onIncomplete(); } catch { /* host callback isolation */ }
        }
        if (typeof choice?.finish_reason === "string") completed = true;
      }
      if (done) break;
    }
    if (malformed && !produced.trim()) throw unreadableStream(provider.label);
    if (!completed) throw new DirectProviderError("provider-response", `${provider.label} answer stream ended before completion.`);
    try { options.onCitations?.(sources); } catch { /* host callback isolation */ }
    try {
      if (usage) options.onUsage?.({ ...usage, webSearchCalls: searchCalls }, true);
      else options.onUsage?.({ inputTokens: estimateTokens(body), outputTokens: estimateTokens(produced), cachedInputTokens: 0, reasoningTokens: 0, webSearchCalls: searchCalls }, false);
    } catch { /* host callback isolation */ }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export interface ChatCompletion {
  readonly text: string;
  /** Provider usage when returned; otherwise a bytes/4 estimate with measured=false. */
  readonly usage: RawUsage;
  readonly measured: boolean;
  /** The assistant message object (annotations, server_tool_calls). */
  readonly message: Record<string, unknown>;
}

/** One non-streamed chat completion (copilot analysis, lookups, verdicts, key test). */
export async function chatComplete(fetcher: DirectFetch, provider: AnswerProviderInfo, key: string, model: string, messages: readonly ChatMessage[], options: { maxTokens: number; json?: boolean; tools?: readonly unknown[]; signal?: AbortSignal; purpose?: string }): Promise<ChatCompletion> {
  const body = JSON.stringify(chatRequestBody(provider, model, messages, { stream: false, maxTokens: options.maxTokens, ...(options.json ? { json: true } : {}), ...(options.tools ? { tools: options.tools } : {}) }));
  const response = await providerFetch(fetcher, provider, "/chat/completions", key, body, options.signal, options.purpose ?? "request", model);
  const value: unknown = await response.json();
  const choice = isRecord(value) && Array.isArray(value.choices) && isRecord(value.choices[0]) ? value.choices[0] : undefined;
  const message = choice && isRecord(choice.message) ? choice.message : {};
  const text = typeof message.content === "string" ? message.content : "";
  const measured = isRecord(value) ? parseChatUsage(value.usage) : undefined;
  return { text, message, measured: measured !== undefined, usage: measured ?? { inputTokens: estimateTokens(body), outputTokens: estimateTokens(text), cachedInputTokens: 0, reasoningTokens: 0 } };
}

export type SearchRecency = "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit";
export interface SearchResult extends Citation { readonly snippet: string }

/** Zhipu caps `search_query` at 70 characters. */
export function zhipuSearchQuery(text: string): string {
  return [...text.replace(/\s+/g, " ").trim()].slice(0, 70).join("");
}

/**
 * Zhipu Web Search API: POST {base}/web_search. Returns validated results with the engine's
 * `publish_date`. `search_std` is the cheapest engine (¥0.01 per search at the time of writing).
 */
export async function zhipuWebSearch(fetcher: DirectFetch, provider: AnswerProviderInfo, key: string, query: string, options: { recency?: SearchRecency; count?: number; signal?: AbortSignal } = {}): Promise<SearchResult[]> {
  const body = JSON.stringify({ search_query: zhipuSearchQuery(query), search_engine: "search_std", search_intent: false, count: options.count ?? 8, search_recency_filter: options.recency ?? "noLimit", content_size: "medium" });
  const response = await providerFetch(fetcher, provider, "/web_search", key, body, options.signal, "web search");
  const value: unknown = await response.json();
  const results = new Map<string, SearchResult>();
  for (const item of isRecord(value) && Array.isArray(value.search_result) ? value.search_result : []) {
    if (!isRecord(item)) continue;
    const source = parseCitation({ type: "url_citation", url: item.link, title: item.title });
    if (!source || results.has(source.url)) continue;
    const publishedAt = cleanPublishedAt(item.publish_date);
    const site = typeof item.media === "string" && item.media.trim() ? item.media.trim().slice(0, 80) : undefined;
    results.set(source.url, { ...source, ...(publishedAt ? { publishedAt, dateSource: "search" as const } : {}), ...(site ? { site } : {}),
      snippet: typeof item.content === "string" ? item.content.replace(/\s+/g, " ").trim().slice(0, 600) : "" });
    if (results.size >= 8) break;
  }
  return [...results.values()];
}

export type ProviderKeyTestStatus = "ok" | "invalid" | "no-credits" | "no-model-access" | "network" | "error";
export interface ProviderKeyTestResult { readonly status: ProviderKeyTestStatus; readonly message: string; readonly model: string; readonly latencyMs?: number }

/** Setup "Test key" for a chat provider: one tiny paid completion with the selected model. Never returns key material. */
export async function testProviderKey(fetcher: DirectFetch, provider: AnswerProviderInfo, key: string, model: string, signal?: AbortSignal): Promise<ProviderKeyTestResult> {
  const trimmed = key.trim();
  if (!trimmed) return { status: "invalid", message: `Enter a ${provider.label} API key first.`, model };
  const started = Date.now();
  try {
    await chatComplete(fetcher, provider, trimmed, model, [{ role: "user", content: "Reply with OK." }], { maxTokens: answerModelInfo(model)?.reasoning ? 512 : 32, ...(signal ? { signal } : {}), purpose: "key test" });
  } catch (error) {
    const code = error instanceof DirectProviderError ? error.code : "";
    if (code === "provider-authentication") return { status: "invalid", message: `${provider.label} rejected this key. Check that it was copied completely and belongs to this region.`, model };
    if (code === "provider-billing") return { status: "no-credits", message: `Key works, but the ${provider.label} account has no balance.`, model };
    if (code === "model-access") return { status: "no-model-access", message: `Key works, but it can't call ${model}.`, model };
    if (!(error instanceof DirectProviderError)) return { status: "network", message: `Could not reach ${new URL(provider.baseUrl).hostname}. Check the phone's connection.`, model };
    return { status: "error", message: error.message, model };
  }
  const latencyMs = Date.now() - started;
  return { status: "ok", message: `Key works · ${model} answered in ${latencyMs} ms.`, model, latencyMs };
}
