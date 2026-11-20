/** Browser-native provider calls. No Node runtime, proxy, or bundled credentials. */
import type { Citation, ReasoningEffort } from "./copilot-types.js";
import { answerModelInfo, firstAccessibleModel, liveReasoningEffort, type RawUsage } from "./model-catalog.js";
export type DirectFetch = (input: string, init?: RequestInit) => Promise<Response>;
export const OPENAI_BASE = "https://api.openai.com/v1";
export const TRANSCRIPTION_MODELS: Readonly<Record<string, string>> = {
  "openai-realtime": "gpt-live-transcribe", "openai-transcribe": "gpt-transcribe",
  "openai-whisper": "whisper-1", "openai-compatible": "gpt-4o-mini-transcribe",
  deepgram: "nova-3", soniox: "stt-rt-v5",
};
export class DirectProviderError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) { super(message); }
}
const ANSWER_OUTPUT_TOKENS = 600;
/** Reasoning tokens count against max_output_tokens; leave room for them. */
const REASONING_OUTPUT_TOKENS = 2000;
const ANSWER_FRAMING_RESERVE = 1024;
/** Verified windows for older ids that are not in the v0.7 catalog. */
const LEGACY_CONTEXT_WINDOWS: Readonly<Record<string, number>> = {
  "gpt-4o": 128_000, "gpt-4.1-nano": 1_047_576,
};
function contextWindow(model: string): number | undefined {
  const info = answerModelInfo(model);
  if (info) return info.contextWindow;
  const base = /^(.*)-\d{4}-\d{2}-\d{2}$/.exec(model)?.[1] ?? model;
  return Object.hasOwn(LEGACY_CONTEXT_WINDOWS, base) ? LEGACY_CONTEXT_WINDOWS[base] : undefined;
}
/** Responses is required for responsesOnly models and for hosted tools (web_search). */
export function usesResponsesApi(profile: string, model: string, webSearch = false): boolean {
  return profile === "openai-responses" || webSearch || answerModelInfo(model)?.responsesOnly === true;
}
export function answerOutputTokens(model: string): number {
  return liveReasoningEffort(model) === undefined ? ANSWER_OUTPUT_TOKENS : REASONING_OUTPUT_TOKENS;
}
export interface AnswerRequestOptions {
  /** Called once on successful completion. measured=false means a bytes/4 estimate. */
  readonly onUsage?: (usage: RawUsage, measured: boolean) => void;
  /** Adds the hosted web_search tool (forces the Responses API). */
  readonly webSearch?: boolean;
  /** Called once on completion with validated, deduped url_citation sources. */
  readonly onCitations?: (sources: Citation[]) => void;
  readonly reasoningEffort?: ReasoningEffort;
  readonly maxOutputTokens?: number;
}
function promptContextFailure(provisional = false): DirectProviderError {
  return new DirectProviderError("prompt-context-limit", `${provisional ? "The selected model has an unverified context window; Helix applies a provisional 4,096-token request budget. " : ""}Answer context is too large for the selected model budget. Shorten the custom prompt, turn off local memory, choose a larger supported model and reconnect, or start a new session. The captured transcript has not been discarded.`);
}
function isContextOverflow(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const error = value as { code?: unknown; message?: unknown };
  return error.code === "context_length_exceeded" || error.code === "context_window_exceeded"
    || (typeof error.message === "string" && /maximum context length|context (?:window|length).*(?:exceed|too (?:large|long))/i.test(error.message));
}

/** UTF-8 bytes conservatively bound text tokens for these byte-based models.
 * Count the entire serialized payload (including escaped context and roles),
 * plus output and extra framing reserve. This is not an exact tokenizer.
 * Only auxiliary older exchanges may be removed; the final current request
 * and all instructions, including local memory, are mandatory and remain unchanged. */
function budgetAnswerBody(responses: boolean, model: string, instructions: string, history: readonly { role: string; content: string }[], options: AnswerRequestOptions = {}): string {
  const verified = contextWindow(model);
  // Freeform IDs remain usable without claiming their actual provider capacity.
  const window = verified ?? 4096;
  const effort = options.reasoningEffort ?? liveReasoningEffort(model);
  const output = options.maxOutputTokens ?? answerOutputTokens(model);
  const retained = [...history];
  const serialize = () => JSON.stringify(responses
    ? { model, instructions, input: retained, stream: true, store: false, max_output_tokens: output, truncation: "disabled",
      ...(effort ? { reasoning: { effort } } : {}), ...(options.webSearch ? { tools: [{ type: "web_search" }] } : {}) }
    : { model, messages: [{ role: "system", content: instructions }, ...retained], stream: true, store: false, stream_options: { include_usage: true },
      ...(effort ? { max_completion_tokens: output, reasoning_effort: effort } : { max_tokens: output }) });
  let body = serialize();
  const fits = () => new TextEncoder().encode(body).length + output + ANSWER_FRAMING_RESERVE <= window;
  while (!fits() && retained.length > 1) {
    retained.shift();
    // Drop complete oldest exchanges so no orphan assistant becomes context.
    while (retained.length > 1 && retained[0]?.role === "assistant") retained.shift();
    body = serialize();
  }
  if (!fits()) throw promptContextFailure(verified === undefined);
  return body;
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
/** Validates an untrusted url_citation annotation; returns undefined for anything unsafe. */
export function parseCitation(value: unknown): Citation | undefined {
  if (!isRecord(value) || value.type !== "url_citation" || typeof value.url !== "string" || /[\u0000-\u0020\u007f]/u.test(value.url)) return;
  try {
    const url = new URL(value.url);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || !url.hostname) return;
    const title = typeof value.title === "string" && value.title.trim() ? value.title.trim().slice(0, 300) : url.hostname;
    return { url: url.href, title };
  } catch { return; }
}
/** Responses `usage` -> RawUsage. */
export function parseResponsesUsage(value: unknown): RawUsage | undefined {
  if (!isRecord(value)) return;
  const input = count(value.input_tokens), output = count(value.output_tokens);
  if (input === undefined && output === undefined) return;
  const inDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : {}, outDetails = isRecord(value.output_tokens_details) ? value.output_tokens_details : {};
  return { inputTokens: input ?? 0, outputTokens: output ?? 0, cachedInputTokens: count(inDetails.cached_tokens) ?? 0, reasoningTokens: count(outDetails.reasoning_tokens) ?? 0 };
}
/** Chat Completions `usage` -> RawUsage. */
export function parseChatUsage(value: unknown): RawUsage | undefined {
  if (!isRecord(value)) return;
  const input = count(value.prompt_tokens), output = count(value.completion_tokens);
  if (input === undefined && output === undefined) return;
  const inDetails = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : {}, outDetails = isRecord(value.completion_tokens_details) ? value.completion_tokens_details : {};
  return { inputTokens: input ?? 0, outputTokens: output ?? 0, cachedInputTokens: count(inDetails.cached_tokens) ?? 0, reasoningTokens: count(outDetails.reasoning_tokens) ?? 0 };
}
/** Final (non-streamed) Responses object: text, citations, web search calls. */
export function parseResponseOutput(value: unknown): { text: string; sources: Citation[]; webSearchCalls: number; usage?: RawUsage } {
  const sources = new Map<string, Citation>(); let text = "", webSearchCalls = 0;
  const output = isRecord(value) && Array.isArray(value.output) ? value.output : [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type === "web_search_call") webSearchCalls++;
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!isRecord(content) || content.type !== "output_text" || typeof content.text !== "string") continue;
      text += content.text;
      if (Array.isArray(content.annotations)) for (const annotation of content.annotations) { const source = parseCitation(annotation); if (source && !sources.has(source.url)) sources.set(source.url, source); }
    }
  }
  if (!text && isRecord(value) && typeof value.output_text === "string") text = value.output_text;
  const usage = isRecord(value) ? parseResponsesUsage(value.usage) : undefined;
  return { text, sources: [...sources.values()].slice(0, 8), webSearchCalls, ...(usage ? { usage } : {}) };
}
/** Removes provider citation controls and inline markdown links so text stays speakable. */
export function stripCitationMarkers(text: string): string {
  return text.replace(/\uE200[^\uE201]*\uE201/gu, "")
    .replace(/\s*\(\s*\[[^\]]{0,200}\]\(https?:\/\/[^)\s]{1,2000}\)\s*\)/gu, "")
    .replace(/\[([^\]]{0,200})\]\(https?:\/\/[^)\s]{1,2000}\)/gu, "$1")
    .replace(/[ \t]+([.,;:!?])/gu, "$1").replace(/[ \t]{2,}/gu, " ");
}
const estimateTokens = (text: string) => Math.ceil(new TextEncoder().encode(text).length / 4);
export function httpFailure(provider: string, status: number): DirectProviderError {
  if (status === 401 || status === 403) return new DirectProviderError("provider-authentication", `${provider}: check your API key and permissions.`);
  if (status === 402) return new DirectProviderError("provider-billing", `${provider}: account balance exhausted. Add funds in your provider account.`);
  if (status === 429) return new DirectProviderError("provider-rate-limit", `${provider}: rate or quota limit reached. Check usage and billing.`, true);
  return new DirectProviderError("provider-response", `${provider}: request failed (HTTP ${status}).`, status >= 500 || status === 408);
}
export async function directFetch(fetcher: DirectFetch, url: string, init: RequestInit, provider: string): Promise<Response> {
  // Fixed provider URLs and no redirects prevent credential forwarding to other hosts.
  const response = await fetcher(url, { ...init, redirect: "error", credentials: "omit", cache: "no-store" });
  if (!response.ok) {
    if (response.status === 429) {
      // Out of credits is a billing stop, not a transient rate limit: don't retry, say so plainly.
      const detail = await response.clone().json().catch(() => undefined);
      if (detail?.error?.code === "insufficient_quota" || /no credits remaining|exceeded your current quota/i.test(String(detail?.error?.message ?? ""))) {
        throw new DirectProviderError("provider-billing", `${provider}: your OpenAI project has no credits remaining. Add credits at platform.openai.com → Billing, then reconnect.`);
      }
    }
    if ((provider === "OpenAI answer" && response.status === 400) || response.status === 403 || response.status === 404) {
      // Inspect only to classify. Never surface arbitrary upstream body text.
      const detail = await response.json().catch(() => undefined);
      if (response.status === 400 && isContextOverflow(detail?.error)) throw promptContextFailure();
      if (detail?.error?.code === "model_not_found") {
        const model = /model [`'"]?([a-z0-9._-]{1,80})/i.exec(String(detail.error.message ?? ""))?.[1];
        throw new DirectProviderError("model-access", `${provider}: your OpenAI project does not have access to ${model ? `model ${model}` : "the selected model"}. Pick another model in Setup (models your key can use are marked).`);
      }
    }
    throw httpFailure(provider, response.status);
  }
  return response;
}
/** Model ids the key's project can call (GET /v1/models). Never includes key material. */
export async function listAccessibleModels(fetcher: DirectFetch, key: string, signal?: AbortSignal): Promise<string[]> {
  const response = await directFetch(fetcher, `${OPENAI_BASE}/models`, { method: "GET", headers: { Authorization: `Bearer ${key}` }, ...(signal ? { signal } : {}) }, "OpenAI models");
  const body: unknown = await response.json();
  const data = typeof body === "object" && body !== null && Array.isArray((body as { data?: unknown }).data) ? (body as { data: unknown[] }).data : [];
  return [...new Set(data.flatMap(item => typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string" ? [(item as { id: string }).id] : []))].sort();
}
export type KeyTestStatus = "ok" | "invalid" | "no-credits" | "no-model-access" | "network" | "error";
export interface KeyTestResult {
  readonly status: KeyTestStatus;
  readonly message: string;
  /** Model ids the project can call (empty when the key was rejected). */
  readonly models: readonly string[];
  /** Model actually probed: the selection, or the best accessible fallback. */
  readonly model?: string;
  /** Round trip of the probe answer request. */
  readonly latencyMs?: number;
  /** gpt-live-transcribe is available (lowest-latency transcription). */
  readonly realtime: boolean;
}
/** Setup "Test key": auth + model list + one tiny paid request (detects "no credits"). Never returns key material. */
export async function testOpenAIKey(fetcher: DirectFetch, key: string, model: string, signal?: AbortSignal): Promise<KeyTestResult> {
  const trimmed = key.trim();
  if (!trimmed) return { status: "invalid", message: "Enter an OpenAI API key first.", models: [], realtime: false };
  let models: string[];
  try { models = await listAccessibleModels(fetcher, trimmed, signal); }
  catch (error) {
    if (error instanceof DirectProviderError && error.code === "provider-authentication") return { status: "invalid", message: "OpenAI rejected this key. Check that it was copied completely and is not revoked.", models: [], realtime: false };
    return { status: "network", message: "Could not reach api.openai.com. Check the phone's connection.", models: [], realtime: false };
  }
  const realtime = models.includes("gpt-live-transcribe");
  const probe = models.includes(model) ? model : firstAccessibleModel("answer", models);
  if (!probe) return { status: "no-model-access", message: `Key works, but none of Helix's answer models are available to this project (${models.length} models listed).`, models, realtime };
  const effort = liveReasoningEffort(probe), started = Date.now();
  try {
    const response = await directFetch(fetcher, `${OPENAI_BASE}/responses`, {
      method: "POST", headers: { Authorization: `Bearer ${trimmed}`, "Content-Type": "application/json" }, ...(signal ? { signal } : {}),
      body: JSON.stringify({ model: probe, input: "Reply with OK.", max_output_tokens: 32, store: false, ...(effort ? { reasoning: { effort } } : {}) }),
    }, "OpenAI answer");
    await response.json().catch(() => undefined);
  } catch (error) {
    const code = error instanceof DirectProviderError ? error.code : "";
    if (code === "provider-billing") return { status: "no-credits", message: "Key works, but this OpenAI project has no credits. Add credits at platform.openai.com → Billing.", models, model: probe, realtime };
    if (code === "model-access") return { status: "no-model-access", message: `Key works, but it can't call ${probe}.`, models, model: probe, realtime };
    return { status: "error", message: error instanceof DirectProviderError ? error.message : "Test request failed.", models, model: probe, realtime };
  }
  const latencyMs = Date.now() - started;
  const switched = probe !== model ? ` ${model} isn't available to this key; Helix will use ${probe}.` : "";
  return { status: "ok", message: `Key works · ${probe} answered in ${latencyMs} ms · ${realtime ? "realtime transcription available" : "no realtime transcription access (use GPT Transcribe)"}.${switched}`, models, model: probe, latencyMs, realtime };
}
export function pcmWav(samples: Int16Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(44 + samples.length * 2), view = new DataView(bytes.buffer);
  const label = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  label(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); label(8, "WAVE"); label(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  label(36, "data"); view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, sample, true));
  return bytes;
}
export interface TranscribeOptions {
  /** Recent transcript context (last ~200 chars are sent) for models that accept `prompt`. */
  readonly prompt?: string;
}
export async function transcribeDirect(fetcher: DirectFetch, profile: string, key: string, samples: Int16Array, language: string | undefined, signal: AbortSignal, onPartial?: (text: string) => void, options: TranscribeOptions = {}): Promise<string> {
  if (profile === "soniox") return sonioxTranscribe(key, samples, language, signal, onPartial);
  const wav = pcmWav(samples);
  if (profile === "deepgram") {
    const response = await directFetch(fetcher, "https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true", {
      method: "POST", headers: { Authorization: `Token ${key}`, "Content-Type": "audio/wav" }, body: new Blob([wav], { type: "audio/wav" }), signal,
    }, "Deepgram");
    const result = await response.json();
    return typeof result?.results?.channels?.[0]?.alternatives?.[0]?.transcript === "string" ? result.results.channels[0].alternatives[0].transcript.trim() : "";
  }
  const body = new FormData();
  body.append("file", new Blob([wav], { type: "audio/wav" }), "speech.wav");
  const model = TRANSCRIPTION_MODELS[profile];
  if (!model || profile === "openai-realtime") throw new DirectProviderError("provider-response", "Unsupported transcription profile for file upload.");
  body.append("model", model); body.append("response_format", "json");
  if (model === "gpt-transcribe") {
    // `language` is not documented for gpt-transcribe; free-form prompt context is.
    const prompt = options.prompt?.replace(/\s+/g, " ").trim().slice(-200);
    if (prompt) body.append("prompt", prompt);
  } else {
    const hint = language?.split(/[-_]/)[0]?.toLowerCase();
    if (hint && /^[a-z]{2}$/.test(hint)) body.append("language", hint);
  }
  const response = await directFetch(fetcher, `${OPENAI_BASE}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body, signal }, "OpenAI transcription");
  const result: unknown = await response.json();
  if (typeof result !== "object" || result === null || !("text" in result) || typeof result.text !== "string") throw new DirectProviderError("provider-response", "OpenAI returned invalid transcription data.");
  return result.text.trim();
}
export async function* answerDirect(fetcher: DirectFetch, key: string, profile: string, model: string, instructions: string, history: readonly { role: string; content: string }[], signal: AbortSignal, options: AnswerRequestOptions = {}): AsyncGenerator<string> {
  const responses = usesResponsesApi(profile, model, options.webSearch);
  const body = budgetAnswerBody(responses, model, instructions, history, options);
  const response = await directFetch(fetcher, `${OPENAI_BASE}/${responses ? "responses" : "chat/completions"}`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, signal,
    body,
  }, "OpenAI answer");
  if (!response.body) throw new DirectProviderError("provider-response", "OpenAI returned no answer stream.");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", completed = false, carriage = "", produced = "", inMarker = false;
  let usage: RawUsage | undefined, finalCalls: number | undefined;
  const searchItems = new Set<string>(); let anonymousSearches = 0;
  const sources = new Map<string, Citation>();
  const addSource = (value: unknown) => { const source = parseCitation(value); if (source && !sources.has(source.url) && sources.size < 8) sources.set(source.url, source); };
  // Provider citation controls (U+E200..U+E201) may be split across deltas.
  const speakable = (delta: string) => {
    let out = "";
    for (const char of delta) {
      if (inMarker) { if (char === "\uE201") inMarker = false; continue; }
      if (char === "\uE200") { inMarker = true; continue; }
      out += char;
    }
    return out;
  };
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
        const event = JSON.parse(data);
        if (event.error || ["response.failed", "response.incomplete", "error"].includes(event.type)) {
          if (isContextOverflow(event.error) || isContextOverflow(event.response?.error) || isContextOverflow(event)) throw promptContextFailure();
          throw new DirectProviderError("provider-response", "OpenAI could not complete the answer.");
        }
        if (responses) {
          if (event.type === "response.output_text.annotation.added") addSource(event.annotation);
          if ((event.type === "response.output_item.added" || event.type === "response.output_item.done") && event.item?.type === "web_search_call") {
            if (typeof event.item.id === "string") searchItems.add(event.item.id); else if (event.type === "response.output_item.done") anonymousSearches++;
          }
          if (event.type === "response.completed") {
            completed = true;
            const final = parseResponseOutput(event.response);
            usage = final.usage ?? usage;
            for (const source of final.sources) if (!sources.has(source.url) && sources.size < 8) sources.set(source.url, source);
            if (Array.isArray(event.response?.output)) finalCalls = final.webSearchCalls;
          }
        } else {
          if (event.type === "response.completed") completed = true;
          const chatUsage = parseChatUsage(event.usage); if (chatUsage) usage = chatUsage;
        }
        const raw = responses ? (event.type === "response.output_text.delta" ? event.delta : undefined) : event.choices?.[0]?.delta?.content;
        if (!responses && event.choices?.[0]?.finish_reason === "length") throw new DirectProviderError("provider-response", "Answer exceeded its length limit. Ask a shorter question.");
        const delta = typeof raw === "string" ? speakable(raw) : "";
        if (delta) { produced += delta; yield delta; }
      }
      if (done) break;
    }
    if (!completed) throw new DirectProviderError("provider-response", "OpenAI answer stream ended before completion.");
    const webSearchCalls = finalCalls ?? searchItems.size + anonymousSearches;
    try { options.onCitations?.([...sources.values()]); } catch { /* host callback isolation */ }
    try {
      if (usage) options.onUsage?.({ ...usage, webSearchCalls }, true);
      else options.onUsage?.({ inputTokens: estimateTokens(body), outputTokens: estimateTokens(produced), cachedInputTokens: 0, reasoningTokens: 0, webSearchCalls }, false);
    } catch { /* host callback isolation */ }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
function sonioxTranscribe(key: string, samples: Int16Array, language: string | undefined, signal: AbortSignal, onPartial?: (text: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket("wss://stt-rt.soniox.com/transcribe-websocket");
    let text = "", settled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
      socket.close(); error ? reject(error) : resolve(text.trim());
    };
    const abort = () => finish(new DirectProviderError("provider-cancelled", "Soniox transcription cancelled."));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    socket.onopen = () => {
      socket.send(JSON.stringify({ api_key: key, model: "stt-rt-v5", audio_format: "pcm_s16le", sample_rate: 16000, num_channels: 1, enable_endpoint_detection: true, ...(language ? { language_hints: [language.split(/[-_]/)[0]] } : {}) }));
      const pcm = pcmWav(samples).subarray(44);
      let offset = 0;
      const send = () => {
        if (settled || socket.readyState !== WebSocket.OPEN) return;
        if (offset >= pcm.length) { socket.send(new Uint8Array(0)); return; }
        socket.send(pcm.subarray(offset, offset + 3840)); offset += 3840;
        timer = setTimeout(send, 120);
      };
      send();
    };
    socket.onmessage = event => {
      if (settled || signal.aborted) return;
      try {
        const result = JSON.parse(event.data);
        if (result.error_code || result.error_type) { finish(httpFailure("Soniox", Number(result.error_code))); return; }
        for (const token of result.tokens ?? []) if (token.is_final && typeof token.text === "string" && !/^<.*>$/.test(token.text)) text += token.text;
        const partial = (result.tokens ?? []).filter((token: { is_final?: boolean; text?: unknown }) => !token.is_final && typeof token.text === "string" && !/^<.*>$/.test(token.text)).map((token: { text: string }) => token.text).join("");
        if (!result.finished && (text || partial)) onPartial?.(text + partial);
        if (result.finished) finish();
      } catch { finish(new DirectProviderError("provider-response", "Soniox returned invalid transcription data.")); }
    };
    socket.onerror = () => finish(new DirectProviderError("provider-network", "Could not connect directly to Soniox.", true));
    socket.onclose = () => { if (!settled) finish(new DirectProviderError("provider-network", "Soniox closed before transcription completed.", true)); };
  });
}
