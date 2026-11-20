import type { AnswerModelInfo, ReasoningEffort, TranscriptionModelInfo, UsageKind, UsageRecord } from "./copilot-types.js";
import { PROVIDER_ANSWER_MODELS } from "./provider-registry.js";

/**
 * Prices: USD per 1M tokens, OpenAI pricing page (developers.openai.com/api/docs/pricing),
 * read 2026-11-07. Context/effort: developers.openai.com/api/docs/models, same date.
 * Update both together; costs are estimates from provider usage x list price.
 */
export const PRICING_CHECKED_AT = "2026-11-07";

export const ANSWER_MODELS: readonly AnswerModelInfo[] = Object.freeze([
  { id: "gpt-6.1-terra", label: "GPT-6.1 Terra · balanced (recommended)", tier: "current", contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoning: true, liveEffort: "none",
    price: { input: 1.0, cachedInput: 0.05, output: 5.0 }, responsesOnly: true, webSearch: true },
  { id: "gpt-6-luna", label: "GPT-6 Luna · fastest, cheapest", tier: "current", contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoning: true, liveEffort: "none",
    price: { input: 0.1, cachedInput: 0.01, output: 0.5 }, responsesOnly: true, webSearch: true },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol · stronger reasoning", tier: "current", contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoning: true, liveEffort: "low",
    price: { input: 2.0, cachedInput: 0.1, output: 10.0 }, responsesOnly: true, webSearch: true },
  { id: "gpt-6-astra", label: "GPT-6 Astra · flagship (slow, $$$)", tier: "current", contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoning: true, liveEffort: "low",
    price: { input: 10.0, cachedInput: 1.0, output: 50.0 }, responsesOnly: true, webSearch: true },
  // GPT-5.6 / 5.4: prices from each model page on developers.openai.com, read 2026-11-07
  // (Sol is promotional pricing until 2026-11-30). Effort "none" listed on each page.
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra · balanced", tier: "legacy", contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoning: true, liveEffort: "none",
    price: { input: 2.0, cachedInput: 0.2, output: 12.0 }, responsesOnly: true, webSearch: true },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna · fast, cheap", tier: "legacy", contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoning: true, liveEffort: "none",
    price: { input: 0.2, cachedInput: 0.02, output: 1.2 }, responsesOnly: true, webSearch: true },
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol · strongest 5.6", tier: "legacy", contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoning: true, liveEffort: "none",
    price: { input: 4.0, cachedInput: 0.4, output: 20.0 }, responsesOnly: true, webSearch: true },
  { id: "gpt-5.5", label: "GPT-5.5", tier: "legacy", contextWindow: 1_050_000, maxOutputTokens: 128_000, reasoning: true, liveEffort: "low",
    price: { input: 5.0, cachedInput: 0.5, output: 30.0 }, responsesOnly: true, webSearch: true },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini", tier: "legacy", contextWindow: 400_000, maxOutputTokens: 128_000, reasoning: true, liveEffort: "none",
    price: { input: 0.75, cachedInput: 0.075, output: 4.5 }, responsesOnly: true, webSearch: true },
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini · legacy", tier: "legacy", contextWindow: 1_047_576, maxOutputTokens: 32_768, reasoning: false,
    price: { input: 0.8, cachedInput: 0.2, output: 3.2 }, responsesOnly: false, webSearch: true },
  { id: "gpt-4.1", label: "GPT-4.1 · legacy", tier: "legacy", contextWindow: 1_047_576, maxOutputTokens: 32_768, reasoning: false,
    price: { input: 3.0, cachedInput: 0.75, output: 12.0 }, responsesOnly: false, webSearch: true },
  { id: "gpt-4o-mini", label: "GPT-4o mini · legacy (price unpublished)", tier: "legacy", contextWindow: 128_000, maxOutputTokens: 16_384, reasoning: false,
    responsesOnly: false, webSearch: true },
]);

export const DEFAULT_ANSWER_MODEL = "gpt-6.1-terra";
export const DEFAULT_COPILOT_MODEL = "gpt-6-luna";

/** Preference order when the selected model is not accessible to the key's project. */
export const MODEL_FALLBACKS: Readonly<Record<"answer" | "copilot", readonly string[]>> = Object.freeze({
  answer: ["gpt-6.1-terra", "gpt-5.6-terra", "gpt-6-luna", "gpt-5.6-luna", "gpt-6.1-sol", "gpt-5.6-sol", "gpt-5.5", "gpt-4.1-mini", "gpt-4.1"],
  copilot: ["gpt-6-luna", "gpt-5.6-luna", "gpt-6.1-terra", "gpt-5.6-terra", "gpt-4.1-mini"],
});

/** First catalog model the project can call, in preference order. */
export function firstAccessibleModel(kind: "answer" | "copilot", accessible: readonly string[]): string | undefined {
  const set = new Set(accessible);
  return MODEL_FALLBACKS[kind].find(id => set.has(id));
}

export const TRANSCRIPTION_CATALOG: readonly TranscriptionModelInfo[] = Object.freeze([
  { profileId: "openai-realtime", model: "gpt-live-transcribe", label: "OpenAI Realtime · gpt-live-transcribe (lowest latency)", pricePerMinute: 0.017 },
  { profileId: "openai-transcribe", model: "gpt-transcribe", label: "OpenAI GPT Transcribe (recommended)", pricePerMinute: 0.0045 },
  { profileId: "openai-compatible", model: "gpt-4o-mini-transcribe", label: "OpenAI GPT-4o mini transcribe", pricePerMinute: 0.003, deprecated: "Shuts down 2027-02-26" },
  { profileId: "openai-whisper", model: "whisper-1", label: "OpenAI Whisper · whisper-1", pricePerMinute: 0.006, deprecated: "Shuts down 2027-02-26" },
  { profileId: "deepgram", model: "nova-3", label: "Deepgram Nova-3" },
  { profileId: "soniox", model: "stt-rt-v5", label: "Soniox stt-rt-v5" },
]);

/** $10 per 1k web_search calls; search content tokens bill at model rates (already in usage). */
export const WEB_SEARCH_USD_PER_CALL = 0.01;

// OpenAI ids win; DeepSeek / Qwen / GLM / Kimi ids (provider-registry.ts) resolve for context windows and cost.
const BY_ID = new Map([...PROVIDER_ANSWER_MODELS, ...ANSWER_MODELS].map(model => [model.id, model]));
const PROVIDER_MODEL_IDS = new Set(PROVIDER_ANSWER_MODELS.map(model => model.id));

/** Exact id first, then dated snapshot prefix (e.g. gpt-4.1-mini-2025-04-14). */
export function answerModelInfo(id: string): AnswerModelInfo | undefined {
  const exact = BY_ID.get(id);
  if (exact) return exact;
  const snapshot = /^(.*)-\d{4}-\d{2}-\d{2}$/.exec(id)?.[1];
  return snapshot ? BY_ID.get(snapshot) : undefined;
}

export function isKnownAnswerModel(id: string): boolean { return answerModelInfo(id) !== undefined; }

export function liveReasoningEffort(id: string): ReasoningEffort | undefined {
  const info = answerModelInfo(id);
  if (info) return info.reasoning ? info.liveEffort ?? "low" : undefined;
  // Unknown future gpt-5+/gpt-6+/o-series ids are treated as reasoning models.
  return /^(?:gpt-[5-9]|o\d)/.test(id) ? "low" : undefined;
}

export function transcriptionInfo(profileId: string): TranscriptionModelInfo | undefined {
  return TRANSCRIPTION_CATALOG.find(item => item.profileId === profileId);
}

export interface RawUsage {
  inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; reasoningTokens?: number;
  webSearchCalls?: number; audioSeconds?: number;
}

/** Cost from provider usage. Returns undefined when any needed price is unpublished. */
export function estimateCostUsd(model: string, usage: RawUsage): number | undefined {
  const audio = usage.audioSeconds ?? 0;
  if (audio > 0) {
    const stt = TRANSCRIPTION_CATALOG.find(item => item.model === model);
    return stt?.pricePerMinute === undefined ? undefined : round((audio / 60) * stt.pricePerMinute);
  }
  const info = answerModelInfo(model);
  if (!info?.price) return undefined;
  const input = usage.inputTokens ?? 0, cached = Math.min(input, usage.cachedInputTokens ?? 0);
  // Reasoning tokens are already included in output_tokens by the provider.
  const output = usage.outputTokens ?? 0;
  const tokens = ((input - cached) * info.price.input + cached * info.price.cachedInput + output * info.price.output) / 1_000_000;
  // The per-call search fee is OpenAI's; DeepSeek does not bill searches separately.
  return round(tokens + (PROVIDER_MODEL_IDS.has(info.id) ? 0 : (usage.webSearchCalls ?? 0) * WEB_SEARCH_USD_PER_CALL));
}

export function usageRecord(kind: UsageKind, model: string, usage: RawUsage, measured: boolean, relatedId?: string): UsageRecord {
  const cost = estimateCostUsd(model, usage);
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`, kind, model,
    inputTokens: usage.inputTokens ?? 0, cachedInputTokens: usage.cachedInputTokens ?? 0, outputTokens: usage.outputTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0, webSearchCalls: usage.webSearchCalls ?? 0, audioSeconds: usage.audioSeconds ?? 0,
    ...(cost === undefined ? {} : { costUsd: cost }), measured, at: new Date().toISOString(), ...(relatedId ? { relatedId } : {}),
  };
}

/** $0.0012 style: never rounds a nonzero cost to $0.0000. */
export function formatUsd(value: number | undefined): string {
  if (value === undefined) return "price n/a";
  if (value === 0) return "$0";
  if (value < 0.0001) return "<$0.0001";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(3)}`;
}

export function formatMs(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "–";
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

function round(value: number): number { return Math.round(value * 1e8) / 1e8; }
