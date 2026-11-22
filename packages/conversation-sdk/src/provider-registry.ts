/**
 * Answer / copilot providers the phone can call directly.
 *
 * OpenAI keeps its own code path (Responses + Chat Completions in direct-providers.ts). Every other
 * provider here is called through its OpenAI-compatible Chat Completions endpoint (chat-providers.ts)
 * with the differences written down explicitly per provider: thinking switch, token-limit parameter,
 * streaming usage option, JSON mode and web search.
 *
 * Everything below was read from each provider's official docs on PROVIDERS_CHECKED_AT. Base URLs are
 * fixed (never user-editable) so a key can only ever be sent to its own provider, and every origin
 * must also be in the `network.whitelist` of apps/g2-plugin/app.json.
 *
 * Sources (2026-11-19):
 *  DeepSeek  api-docs.deepseek.com (first call, /quick_start/pricing, /api/create-chat-completion, /guides/web_tools)
 *  Qwen      help.aliyun.com/zh/model-studio (compatibility-of-openai-with-dashscope, text-generation-model, deep-thinking, web-search)
 *  Zhipu     docs.bigmodel.cn (chat completions + web search API reference, model overview); docs.z.ai (chat completion)
 *  Moonshot  platform.kimi.ai/docs (api/overview, api/chat, pricing/chat, guide/use-reasoning-effort)
 * Prices are listed only where the provider publishes USD list prices (DeepSeek); everything else
 * shows "price n/a" rather than a converted or remembered number.
 */
import type { AnswerModelInfo } from "./copilot-types.js";
import type { ProviderCredentialName, SessionStartCredentials } from "./types.js";

export const PROVIDERS_CHECKED_AT = "2026-11-19";

/**
 * How a provider can ground a claim on the live web with citations Helix can show.
 *  openai-web-search   Responses API hosted `web_search` tool, url_citation annotations.
 *  deepseek-web-search Chat Completions server tool `deepseek_web_search` (beta), url_citation
 *                      annotations plus `published_at` on the search sources.
 *  zhipu-web-search    Zhipu Web Search API (POST /web_search) with `search_recency_filter` and
 *                      `publish_date`; GLM then judges the claim against those results.
 *  none                No search that returns sources through this API.
 */
export type SearchCapability = "openai-web-search" | "deepseek-web-search" | "zhipu-web-search" | "none";

export interface AnswerProviderInfo {
  /** Session profile id (`providers.answerProvider`). */
  readonly id: string;
  /** Short name for messages: "DeepSeek". */
  readonly label: string;
  /** Setup picker label. */
  readonly title: string;
  /** Provenance `endpoint.provider`. */
  readonly vendor: string;
  /** Which BYOK field holds this provider's key. The key is sent to `baseUrl` only. */
  readonly credential: ProviderCredentialName;
  /** Fixed API base (no trailing slash); `${baseUrl}/chat/completions` is the chat endpoint. */
  readonly baseUrl: string;
  /** "openai" = the OpenAI code path; "chat" = OpenAI-compatible Chat Completions only. */
  readonly api: "openai" | "chat";
  readonly models: readonly AnswerModelInfo[];
  readonly defaultModel: string;
  readonly defaultCopilotModel: string;
  readonly search: SearchCapability;
  /** One sentence for Setup about this provider's search. */
  readonly searchNote: string;
  /** Output limit parameter name. */
  readonly tokenParam: "max_tokens" | "max_completion_tokens";
  /** Smallest output limit worth sending (provider guidance), if any. */
  readonly minOutputTokens?: number;
  /** `stream_options` to get usage on a stream; undefined when usage arrives without it. */
  readonly streamOptions?: Readonly<Record<string, unknown>>;
  /** `response_format: { type: "json_object" }` is documented for this endpoint. When false, JSON is requested in the prompt only. */
  readonly jsonObject: boolean;
  /** Extra body fields for a low-latency reply (thinking off, or the lowest reasoning effort). */
  readonly quick: (model: string) => Readonly<Record<string, unknown>>;
  /** Where the user creates a key (shown in Setup). */
  readonly keyUrl: string;
}

const model = (id: string, label: string, contextWindow: number, maxOutputTokens: number, extra: Partial<AnswerModelInfo> = {}): AnswerModelInfo =>
  Object.freeze({ id, label, tier: "current" as const, contextWindow, maxOutputTokens, reasoning: false, responsesOnly: false, webSearch: false, ...extra });

/**
 * DeepSeek. USD list prices at the PEAK rate (off-peak is half; peak = 01:00-04:00 and 06:00-10:00 UTC,
 * Mon-Fri), so cost estimates are an upper bound. Thinking is on by default and is switched off
 * for live answers with `thinking: { type: "disabled" }`. Web search tool calls are not billed
 * separately (results count as input tokens).
 */
const DEEPSEEK_MODELS = [
  model("deepseek-flash", "DeepSeek Flash · fast, cheap (recommended)", 1_000_000, 393_216, { price: { input: 0.3, cachedInput: 0.006, output: 1.2 }, webSearch: true }),
  // The web tools guide only shows deepseek-flash, so search is not claimed for V4 Pro.
  model("deepseek-v4-pro", "DeepSeek V4 Pro · strongest", 1_000_000, 384_000, { price: { input: 1.32, cachedInput: 0.044, output: 3.96 } }),
];
/**
 * Qwen (Alibaba Cloud Model Studio / DashScope). Thinking is on by default for these three; `enable_thinking: false` turns it off. No USD list price read.
 * UNVERIFIED: `response_format` is not in the compatible-mode parameter list that was read, so JSON mode is not sent
 * (jsonObject: false); the copilot prompt asks for JSON and the reply is validated. The fixed dashscope*.aliyuncs.com
 * domains are the "legacy, still working" ones; the newer recommended domains are per-workspace and cannot be fixed.
 */
const QWEN_MODELS = [
  model("qwen3.7-plus", "Qwen3.7 Plus · balanced (recommended)", 1_000_000, 128_000),
  model("qwen3.8-flash", "Qwen3.8 Flash · fast, low cost", 1_000_000, 128_000),
  model("qwen4-max", "Qwen4 Max · strongest", 1_000_000, 131_072),
];
/** Zhipu GLM. GLM-5.3 can only run with thinking enabled (slower); the others accept `thinking: { type: "disabled" }`. Prices are published in CNY only. */
const GLM_52 = model("glm-5.2", "GLM-5.2 · balanced (recommended)", 1_000_000, 128_000);
const GLM_53 = model("glm-5.3", "GLM-5.3 · flagship, always thinks (slower)", 1_000_000, 128_000, { reasoning: true });
const GLM_5 = model("glm-5", "GLM-5", 200_000, 128_000);
const GLM_47 = model("glm-4.7", "GLM-4.7", 200_000, 128_000);
const ZHIPU_MODELS = [GLM_52, GLM_53, model("glm-5-turbo", "GLM-5 Turbo", 200_000, 128_000), GLM_5, GLM_47, model("glm-4.7-flash", "GLM-4.7 Flash · free tier", 200_000, 128_000)];
/** Z.ai text enum (docs.z.ai): no glm-5-turbo / glm-4.7-flash. Context windows are the bigmodel.cn figures for the same model names. */
const ZAI_MODELS = [GLM_52, GLM_53, GLM_5, GLM_47];
/** Moonshot Kimi K3: always reasons (reasoning_effort low | high | max, default max), so Helix sends "low" and a larger token budget. Price table not readable from the docs page. */
const KIMI_MODELS = [
  model("kimi-k3.1-pro", "Kimi K3.1 Pro · always reasons", 1_048_576, 1_048_576, { reasoning: true }),
  model("kimi-k3", "Kimi K3 · always reasons", 1_048_576, 1_048_576, { reasoning: true }),
];

const NO_SEARCH = "has no web search that returns sources through this API";
const thinkingOff = Object.freeze({ thinking: Object.freeze({ type: "disabled" }) });

export const ANSWER_PROVIDER_CATALOG: readonly AnswerProviderInfo[] = Object.freeze([
  {
    id: "openai-responses", label: "OpenAI", title: "OpenAI · Responses API", vendor: "openai", credential: "openai", baseUrl: "https://api.openai.com/v1", api: "openai",
    models: [], defaultModel: "gpt-6.1-terra", defaultCopilotModel: "gpt-6-luna", search: "openai-web-search",
    searchNote: "OpenAI web search ($10 per 1,000 searches plus tokens).",
    tokenParam: "max_completion_tokens", jsonObject: true, quick: () => ({}), keyUrl: "platform.openai.com",
  },
  {
    id: "openai-compatible", label: "OpenAI", title: "OpenAI · Chat Completions", vendor: "openai", credential: "openai", baseUrl: "https://api.openai.com/v1", api: "openai",
    models: [], defaultModel: "gpt-6.1-terra", defaultCopilotModel: "gpt-6-luna", search: "openai-web-search",
    searchNote: "OpenAI web search ($10 per 1,000 searches plus tokens).",
    tokenParam: "max_completion_tokens", jsonObject: true, quick: () => ({}), keyUrl: "platform.openai.com",
  },
  {
    id: "deepseek", label: "DeepSeek", title: "DeepSeek", vendor: "deepseek", credential: "deepseek", baseUrl: "https://api.deepseek.com", api: "chat",
    models: DEEPSEEK_MODELS, defaultModel: "deepseek-flash", defaultCopilotModel: "deepseek-flash", search: "deepseek-web-search",
    searchNote: "DeepSeek web search (beta, deepseek-flash). Searches are not billed separately; results count as input tokens.",
    tokenParam: "max_tokens", streamOptions: { include_usage: true }, jsonObject: true, quick: () => thinkingOff, keyUrl: "platform.deepseek.com",
  },
  {
    id: "qwen", label: "Qwen", title: "Alibaba Qwen · China (Beijing)", vendor: "alibaba", credential: "dashscope", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", api: "chat",
    models: QWEN_MODELS, defaultModel: "qwen3.7-plus", defaultCopilotModel: "qwen3.8-flash", search: "none",
    searchNote: `Qwen's OpenAI-compatible mode ${NO_SEARCH} (enable_search answers without citations).`,
    tokenParam: "max_tokens", streamOptions: { include_usage: true }, jsonObject: false, quick: () => ({ enable_thinking: false }), keyUrl: "bailian.console.aliyun.com",
  },
  {
    id: "qwen-intl", label: "Qwen", title: "Alibaba Qwen · International (Singapore)", vendor: "alibaba", credential: "dashscope", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", api: "chat",
    models: QWEN_MODELS, defaultModel: "qwen3.7-plus", defaultCopilotModel: "qwen3.8-flash", search: "none",
    searchNote: `Qwen's OpenAI-compatible mode ${NO_SEARCH} (enable_search answers without citations).`,
    tokenParam: "max_tokens", streamOptions: { include_usage: true }, jsonObject: false, quick: () => ({ enable_thinking: false }), keyUrl: "modelstudio.console.alibabacloud.com",
  },
  {
    id: "zhipu", label: "Zhipu GLM", title: "Zhipu GLM · China (bigmodel.cn)", vendor: "zhipu", credential: "zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "chat",
    models: ZHIPU_MODELS, defaultModel: "glm-5.2", defaultCopilotModel: "glm-4.7-flash", search: "zhipu-web-search",
    searchNote: "Zhipu Web Search API with a recency filter (search_std, ¥0.01 per search plus tokens).",
    // The API reference recommends max_tokens of at least 1024; usage arrives in the last stream chunk by default.
    tokenParam: "max_tokens", minOutputTokens: 1024, jsonObject: true, quick: id => /^glm-5\.3/u.test(id) ? {} : thinkingOff, keyUrl: "bigmodel.cn",
  },
  {
    id: "zai", label: "Z.ai GLM", title: "Zhipu GLM · International (Z.ai)", vendor: "zhipu", credential: "zhipu", baseUrl: "https://api.z.ai/api/paas/v4", api: "chat",
    // UNVERIFIED for Z.ai: its docs show a web_search chat tool (search_pro_jina) but no standalone search API, so no sourced search is claimed.
    models: ZAI_MODELS, defaultModel: "glm-5.2", defaultCopilotModel: "glm-4.7", search: "none",
    searchNote: `Z.ai ${NO_SEARCH} that Helix has verified.`,
    // UNVERIFIED for Z.ai: `thinking` and `response_format` are taken from the bigmodel.cn reference of the same API; JSON mode is not sent.
    tokenParam: "max_tokens", minOutputTokens: 1024, jsonObject: false, quick: id => /^glm-5\.3/u.test(id) ? {} : thinkingOff, keyUrl: "z.ai",
  },
  {
    id: "moonshot", label: "Moonshot Kimi", title: "Moonshot Kimi", vendor: "moonshot", credential: "moonshot", baseUrl: "https://api.moonshot.ai/v1", api: "chat",
    // Kimi's $web_search is a client-side tool loop without citation metadata; not used.
    models: KIMI_MODELS, defaultModel: "kimi-k3.1-pro", defaultCopilotModel: "kimi-k3", search: "none",
    searchNote: `Kimi ${NO_SEARCH}.`,
    tokenParam: "max_completion_tokens", streamOptions: { include_usage: true }, jsonObject: true,
    quick: id => /^kimi-k3/u.test(id) ? { reasoning_effort: "low" } : {}, keyUrl: "platform.kimi.ai",
  },
] satisfies AnswerProviderInfo[]);

/** Catalog models of the non-OpenAI providers (model-catalog.ts merges them into its id lookup). */
export const PROVIDER_ANSWER_MODELS: readonly AnswerModelInfo[] = Object.freeze(
  [...new Map(ANSWER_PROVIDER_CATALOG.flatMap(provider => provider.models).map(item => [item.id, item])).values()]);

const BY_ID = new Map(ANSWER_PROVIDER_CATALOG.map(provider => [provider.id, provider]));

export function answerProviderInfo(id: string | undefined): AnswerProviderInfo | undefined { return id === undefined ? undefined : BY_ID.get(id); }

/** Provider profile ids that use a non-OpenAI key. */
export const CHAT_PROVIDER_IDS: readonly string[] = Object.freeze(ANSWER_PROVIDER_CATALOG.filter(provider => provider.api === "chat").map(provider => provider.id));

/** Every origin a provider call can reach (for the app.json network whitelist test). */
export function providerOrigins(): string[] { return [...new Set(ANSWER_PROVIDER_CATALOG.map(provider => new URL(provider.baseUrl).origin))]; }

/**
 * The model a provider should actually be sent. OpenAI passes the selection through unchanged. For a
 * chat provider an id from another provider's catalog (e.g. a saved gpt-* copilot model) is
 * replaced by the provider default; an unknown custom id is sent as-is.
 */
export function providerModel(provider: AnswerProviderInfo, requested: string | undefined, kind: "answer" | "copilot"): string {
  const fallback = kind === "answer" ? provider.defaultModel : provider.defaultCopilotModel;
  const id = requested?.trim();
  if (!id) return fallback;
  if (provider.api === "openai") return id;
  if (provider.models.some(item => item.id === id)) return id;
  const foreign = /^(?:gpt-|o\d|chatgpt)/iu.test(id) || ANSWER_PROVIDER_CATALOG.some(other => other.models.some(item => item.id === id));
  return foreign ? fallback : id;
}

/** Provenance endpoint for direct provider calls (never contains credentials). */
export function directEndpoint(providerId: string | undefined, modelId: string, responses = true): { id: string; url: string; provider: string; model: string } {
  const provider = answerProviderInfo(providerId);
  if (!provider || provider.api === "openai") return { id: "openai-direct", url: `https://api.openai.com/v1/${responses ? "responses" : "chat/completions"}`, provider: "openai", model: modelId };
  return { id: `${provider.id}-direct`, url: `${provider.baseUrl}/chat/completions`, provider: provider.vendor, model: modelId };
}

/** Where web checks for a session are sent: a provider, its key, and a model that supports the search. */
export interface SearchRoute {
  readonly capability: Exclude<SearchCapability, "none">;
  readonly provider: AnswerProviderInfo;
  readonly key: string;
  readonly model: string;
  /** True when the answer provider has no search and the OpenAI key is used instead. */
  readonly fallback: boolean;
}

/**
 * Picks the search for a session: the answer provider's own verified search, else OpenAI web search
 * when an OpenAI key is present (it usually is, for transcription), else none. Each key is only
 * ever paired with its own provider.
 */
export function resolveSearchRoute(answerProviderId: string | undefined, credentials: SessionStartCredentials, preferredModel?: string): SearchRoute | undefined {
  const provider = answerProviderInfo(answerProviderId) ?? BY_ID.get("openai-responses")!;
  const key = credentials[provider.credential];
  if (provider.search !== "none" && key) {
    const wanted = providerModel(provider, preferredModel, "copilot");
    const info = provider.models.find(item => item.id === wanted);
    // DeepSeek: only models with verified search; others: any provider model can read the results.
    const searchModel = provider.search === "deepseek-web-search" && !info?.webSearch ? provider.models.find(item => item.webSearch)?.id ?? provider.defaultCopilotModel : wanted;
    return { capability: provider.search, provider, key, model: searchModel, fallback: false };
  }
  const openai = BY_ID.get("openai-responses")!;
  if (provider.api !== "openai" && credentials.openai) {
    return { capability: "openai-web-search", provider: openai, key: credentials.openai, model: openai.defaultCopilotModel, fallback: true };
  }
  return undefined;
}

/** Setup: one plain sentence about where fact checks search, for the selected provider and the keys entered. */
export function searchAvailability(answerProviderId: string | undefined, has: Partial<Record<ProviderCredentialName, boolean>>): { available: boolean; via?: string; message: string } {
  const provider = answerProviderInfo(answerProviderId) ?? BY_ID.get("openai-responses")!;
  if (provider.search !== "none") {
    return has[provider.credential]
      ? { available: true, via: provider.label, message: `Web and news checks use ${provider.searchNote}` }
      : { available: false, message: `Web and news checks need your ${provider.label} API key. ${provider.searchNote}` };
  }
  if (has.openai) return { available: true, via: "OpenAI", message: `${provider.searchNote} Web and news checks use OpenAI web search with your OpenAI key instead ($10 per 1,000 searches plus tokens).` };
  return { available: false, message: `${provider.searchNote} Web and news checks are off for this provider. Add an OpenAI key, or pick OpenAI, DeepSeek or Zhipu GLM (China) for answers, to turn them on.` };
}

/** Setup: OpenAI-only features that are reduced with the selected provider. Empty for OpenAI. */
export function providerLimitations(answerProviderId: string | undefined, has: Partial<Record<ProviderCredentialName, boolean>>): string[] {
  const provider = answerProviderInfo(answerProviderId);
  if (!provider || provider.api === "openai") return [];
  const notes = [`${provider.label} is called through Chat Completions: the OpenAI Responses API and its model list check are not used.`];
  notes.push(has.openai
    ? "OpenAI realtime transcription and the OpenAI knowledge base (vector store) keep using your OpenAI key."
    : "Without an OpenAI key: OpenAI transcription (Realtime, GPT Transcribe, Whisper) is unavailable, so pick Deepgram or Soniox; the OpenAI knowledge base is off and answers use the knowledge saved on this phone.");
  return notes;
}
