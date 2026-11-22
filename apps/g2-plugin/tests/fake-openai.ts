/**
 * Deterministic fake of the OpenAI endpoints Helix calls directly from the phone.
 * Covers /audio/transcriptions, /responses (stream + JSON, json_schema, web_search),
 * /chat/completions (stream + JSON), /realtime/client_secrets and the realtime
 * transcription WebSocket. Outputs are computed from request content (never random)
 * so tests can assert on concepts, conflicts, asks and summaries.
 *
 * It deliberately inspects body fields instead of assuming one request shape so it
 * keeps working while the SDK lanes evolve. Unknown paths return 404 and are recorded.
 */

export type FakeRequestKind =
  | "transcription" | "client-secret" | "responses-stream" | "responses-json"
  | "chat-stream" | "chat-json" | "unknown";

/** What the fake decided the request was for (useful for assertions). */
export type FakeIntent =
  | "transcription" | "client-secret" | "answer" | "insight" | "fact-check" | "copilot"
  | "lookup" | "propose" | "verify" | "unknown";

export interface FakeRecordedRequest {
  readonly url: string;
  readonly path: string;
  readonly method: string;
  /** Parsed JSON body; FormData becomes a plain record (file -> { size, type, name }). */
  readonly body: Record<string, unknown>;
  readonly kind: FakeRequestKind;
  readonly intent: FakeIntent;
  readonly stream: boolean;
  readonly webSearch: boolean;
  readonly schemaName?: string;
  readonly authorization?: string;
  readonly startedAt: number;
  endedAt?: number;
  aborted?: boolean;
  /** Output text the fake produced. */
  output?: string;
  /** Fault injected into this request (see FakeOpenAI.injectFault). */
  fault?: FakeFaultKind;
  /** HTTP status the fake answered with. */
  status?: number;
}

/**
 * Fault injection (interview harness). A fault applies to the next `times` requests of its intent:
 *  - "http-error": the request is answered with `status` (default 500) before any work;
 *  - "slow-first-token": a streamed answer waits `firstTokenMs` (default 4000) before its first delta;
 *  - "malformed-event": a streamed answer carries one SSE event that is not valid JSON after `afterDeltas` deltas, then continues;
 *  - "cut-off": a streamed answer stops after `afterDeltas` deltas with response.incomplete (chat: finish_reason "length");
 *  - "bad-json": a JSON-schema response (the copilot analysis) returns text that does not parse.
 */
export type FakeFaultKind = "http-error" | "slow-first-token" | "malformed-event" | "cut-off" | "bad-json";
export interface FakeFault {
  readonly kind: FakeFaultKind;
  /** Requests it applies to. Default "answer"; "bad-json" defaults to any request that asks for a JSON schema. */
  readonly intent?: FakeIntent | "any";
  /** How many matching requests it hits. Default 1; Infinity = every request until clearFaults(). */
  readonly times?: number;
  /** Let this many matching requests through untouched first. Default 0. */
  readonly skip?: number;
  readonly status?: number;
  readonly firstTokenMs?: number;
  readonly afterDeltas?: number;
}

export interface FakeLatency {
  /** POST /audio/transcriptions round trip. */
  transcriptionMs: number;
  /** Request -> first SSE delta. */
  firstTokenMs: number;
  /** Between SSE deltas. */
  interTokenMs: number;
  /** Non-stream JSON responses (copilot, verify). */
  jsonMs: number;
  /** Extra delay when body.tools includes web_search. */
  webSearchMs: number;
  /** Realtime: commit -> completed. */
  realtimeMs: number;
}

export interface FakeOpenAIOptions {
  readonly latency?: Partial<FakeLatency>;
  /** Initial transcript queue (shared by HTTP and realtime STT). */
  readonly transcripts?: readonly string[];
  /** Used when the transcript queue is empty. Default: "". */
  readonly fallbackTranscript?: string;
  /** Force HTTP status for matching paths, e.g. { "/responses": 401 }. */
  readonly failures?: Readonly<Record<string, number>>;
  readonly now?: () => number;
}

export interface FakeOpenAI {
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Pass as DirectConversationOptions.webSocketFactory for the realtime STT path. */
  readonly webSocketFactory: (url: string, protocols?: string | string[]) => FakeRealtimeSocket;
  readonly requests: FakeRecordedRequest[];
  readonly sockets: FakeRealtimeSocket[];
  readonly latency: FakeLatency;
  setLatency(latency: Partial<FakeLatency>): void;
  queueTranscript(...texts: string[]): void;
  /** Transcripts not yet consumed. */
  pendingTranscripts(): readonly string[];
  setFailure(path: string, status: number | undefined): void;
  byIntent(intent: FakeIntent): FakeRecordedRequest[];
  reset(): void;
  /** Fault injection for the interview harness; see FakeFault. */
  injectFault(fault: FakeFault): void;
  clearFaults(): void;
  /** Faults that still have requests left to hit. */
  pendingFaults(): readonly FakeFault[];
}

const BASE = "https://api.openai.com/v1";
const ZERO_LATENCY: FakeLatency = { transcriptionMs: 0, firstTokenMs: 0, interTokenMs: 0, jsonMs: 0, webSearchMs: 0, realtimeMs: 0 };

/* ------------------------------------------------------------------ */
/* Domain analysis: deterministic "understanding" of the conversation   */
/* ------------------------------------------------------------------ */

export const FAKE_GLOSSARY: Readonly<Record<string, string>> = Object.freeze({
  CDTF: "CDTF is a team-internal camera data pipeline framework here; its exact expansion was not stated, so confirm it with the team.",
  TensorRT: "TensorRT is NVIDIA's inference optimizer and runtime that compiles models into GPU engines with FP16/INT8 precision.",
  NVMe: "NVMe is a PCIe storage protocol for SSDs with far higher throughput and lower latency than SATA.",
  "ROS 2": "ROS 2 is the second-generation Robot Operating System middleware built on DDS publish/subscribe.",
  Orin: "Jetson Orin is NVIDIA's embedded GPU module family for robotics and edge AI.",
  INT8: "INT8 is 8-bit integer quantization that speeds up inference at some accuracy cost.",
  ONNX: "ONNX is an open model interchange format used to move models between frameworks and runtimes.",
});

export interface FakeConcept { term: string; explanation: string }
export interface FakeConflict { earlier: string; later: string; explanation: string }
export interface FakeAsk { kind: "lookup" | "propose" | "question"; topic: string; trigger: string }
export interface FakeAnalysis {
  concepts: FakeConcept[];
  conflicts: FakeConflict[];
  asks: FakeAsk[];
  bullets: string[];
  keyFacts: string[];
  suggestions: { question: string; why: string }[];
}

function sentences(text: string): string[] {
  return (text.replace(/\\n/g, " ").match(/[^.!?\n]+[.!?]?/gu) ?? []).map(s => s.trim()).filter(s => s.length > 3);
}
function sentenceWith(text: string, pattern: RegExp): string {
  return sentences(text).find(s => pattern.test(s)) ?? pattern.source;
}

export function analyzeConversation(raw: string): FakeAnalysis {
  const text = raw.replace(/\\"/g, "\"");
  const concepts = Object.entries(FAKE_GLOSSARY)
    .filter(([term]) => new RegExp(`(?<![\\w])${term.replace(/\s/g, "\\s")}(?![\\w])`, "u").test(text))
    .map(([term, explanation]) => ({ term, explanation }));

  const conflicts: FakeConflict[] = [];
  const distinct = (pattern: RegExp, normalize: (m: RegExpMatchArray) => string) => {
    const seen = new Map<string, string>();
    for (const sentence of sentences(text)) {
      for (const match of sentence.matchAll(pattern)) {
        const key = normalize(match);
        if (!seen.has(key)) seen.set(key, sentence);
      }
    }
    return [...seen.entries()];
  };
  const fps = distinct(/(\d+)\s*FPS/giu, m => m[1]!);
  if (fps.length >= 2) conflicts.push({ earlier: fps[0]![1], later: fps.at(-1)![1], explanation: `Frame rate stated as ${fps[0]![0]} FPS and later ${fps.at(-1)![0]} FPS.` });
  const money = distinct(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/giu, m => String(Number(m[1]!.replace(/,/g, "")) * (m[2] ? 1000 : 1)));
  if (money.length >= 2) conflicts.push({ earlier: money[0]![1], later: money.at(-1)![1], explanation: `Budget stated as $${Number(money[0]![0]).toLocaleString("en-US")} and later $${Number(money.at(-1)![0]).toLocaleString("en-US")}.` });
  const ship = distinct(/\bship(?:\s+\w+){0,4}?\s+(?:on\s+|to\s+)?((?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday))\b/giu, m => m[1]!.toLowerCase());
  if (ship.length >= 2) conflicts.push({ earlier: ship[0]![1], later: ship.at(-1)![1], explanation: `Ship date changed from ${ship[0]![0]} to ${ship.at(-1)![0]}.` });

  const asks: FakeAsk[] = [];
  if (/lead time|hard to order|backorder|in stock|availability|how much does .* cost|current price/iu.test(text)) {
    const trigger = sentenceWith(text, /lead time|hard to order|backorder|in stock|availability|current price/iu);
    asks.push({ kind: "lookup", topic: /jetson/iu.test(trigger) ? "Current Jetson Orin lead time" : "Current availability", trigger });
  }
  if (/\b\d+\s*GB\s+RAM\b|\barchitecture is\b/iu.test(text)) {
    const trigger = sentenceWith(text, /\b\d+\s*GB\s+RAM\b|\barchitecture is\b/iu);
    asks.push({ kind: "propose", topic: "Is 16 GB RAM with a 1 TB SSD sufficient?", trigger });
  }
  if (/\bI'?d like to hear about\b|\btell me about a time\b/iu.test(text)) {
    const trigger = sentenceWith(text, /\bI'?d like to hear about\b|\btell me about a time\b/iu);
    asks.push({ kind: "question", topic: trigger.replace(/^I'?d like to hear about\s*/iu, "").replace(/[.]$/u, ""), trigger });
  }

  const all = sentences(text).filter(s => !/^[{[]/.test(s));
  const bullets = all.filter((_, i) => i % 3 === 0).slice(0, 6).map(s => s.slice(0, 140));
  if (!bullets.length) bullets.push("Conversation started.");
  const keyFacts = all.filter(s => /\d|\b(?:decided|agreed|owner|own|will)\b/iu.test(s)).slice(0, 6).map(s => s.slice(0, 140));
  const suggestions = [
    ...conflicts.map(c => ({ question: `Which is correct: "${c.earlier.slice(0, 60)}" or "${c.later.slice(0, 60)}"?`, why: c.explanation })),
    ...concepts.slice(0, 2).map(c => ({ question: `How exactly is ${c.term} used here?`, why: `${c.term} came up without a definition.` })),
  ].slice(0, 5);
  if (!suggestions.length) suggestions.push({ question: "What is the next concrete step and who owns it?", why: "No owner was stated yet." });
  return { concepts, conflicts, asks, bullets, keyFacts, suggestions };
}

/* ------------------------------------------------------------------ */
/* Body inspection                                                     */
/* ------------------------------------------------------------------ */

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // Skip roles/types; keep text-bearing fields.
    for (const [key, item] of Object.entries(record)) if (!["role", "type", "id"].includes(key)) collectStrings(item, out);
  }
  return out;
}

/** Bookkeeping fields the SDK lanes send alongside speech; never treated as spoken text. */
const NON_SPEECH_KEYS = new Set(["alreadyExplainedTerms", "knownConflicts", "previousSuggestions", "existingAsks", "excludedTerms", "previousSummary", "summary", "topic"]);
function speechStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[{[]/.test(trimmed)) { try { return speechStrings(JSON.parse(trimmed), out); } catch { /* plain text */ } }
    out.push(value);
  } else if (Array.isArray(value)) for (const item of value) speechStrings(item, out);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) if (!["role", "type", "id"].includes(key) && !NON_SPEECH_KEYS.has(key)) speechStrings(item, out);
  }
  return out;
}
/** "Other speaker: text" transcript lines -> "text" so quotes stay verbatim speech. */
function stripLabels(text: string): string {
  return text.split("\n").map(line => line.replace(/^(?:You|Other speaker|Speaker|Rehearsal|Recording|G2 conversation|Helix)\s*:\s(?=\S)/u, "")).join("\n");
}
/** Conversation content only: Responses `input`, Chat non-system `messages`. Never instructions. */
export function conversationText(body: Record<string, unknown>): string {
  if (body.input !== undefined) return stripLabels(speechStrings(body.input).join("\n"));
  if (Array.isArray(body.messages)) return stripLabels(speechStrings((body.messages as { role?: string }[]).filter(m => m?.role !== "system" && m?.role !== "developer")).join("\n"));
  return "";
}
function instructionsText(body: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof body.instructions === "string") parts.push(body.instructions);
  if (Array.isArray(body.messages)) parts.push(...collectStrings((body.messages as { role?: string }[]).filter(m => m?.role === "system" || m?.role === "developer")));
  if (Array.isArray(body.input)) parts.push(...collectStrings((body.input as { role?: string }[]).filter(m => m?.role === "system" || m?.role === "developer")));
  return parts.join("\n");
}
function lastUserText(body: Record<string, unknown>): string {
  const items = Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : [body.input];
  const users = (items as unknown[]).filter(m => !(m && typeof m === "object" && "role" in m) || (m as { role?: string }).role === "user");
  const text = collectStrings(users.at(-1)).join("\n");
  const request = /REQUEST\n([\s\S]*)$/u.exec(text)?.[1];
  return (request ?? text).trim();
}
function hasWebSearch(body: Record<string, unknown>): boolean {
  return Array.isArray(body.tools) && body.tools.some(tool => tool && typeof tool === "object" && /^web_search/.test(String((tool as { type?: unknown }).type)));
}
interface JsonSchemaFormat { name?: string; schema: SchemaNode }
function schemaFormat(body: Record<string, unknown>): JsonSchemaFormat | undefined {
  const text = body.text as { format?: { type?: string; name?: string; schema?: SchemaNode } } | undefined;
  if (text?.format?.type === "json_schema" && text.format.schema) return { name: text.format.name, schema: text.format.schema };
  const chat = body.response_format as { type?: string; json_schema?: { name?: string; schema?: SchemaNode } } | undefined;
  if (chat?.type === "json_schema" && chat.json_schema?.schema) return { name: chat.json_schema.name, schema: chat.json_schema.schema };
  return undefined;
}

function classify(body: Record<string, unknown>, path: string): FakeIntent {
  const instructions = instructionsText(body).toLowerCase();
  const format = schemaFormat(body);
  const name = (format?.name ?? "").toLowerCase();
  const user = lastUserText(body).toLowerCase();
  if (/verif/.test(name) || /\bverif(?:y|ication)\b/.test(instructions)) return "verify";
  if (/lookup/.test(name) || (/\blook\s?up\b/.test(instructions) && hasWebSearch(body))) return "lookup";
  if (/propos/.test(name) || /\bpropos(?:e|ed|al)\b/.test(instructions)) return format && /copilot|summary|concept/.test(name) ? "copilot" : "propose";
  if (format) return "copilot";
  if (/"term"/.test(instructions) && /explanation/.test(instructions)) return "insight";
  if (hasWebSearch(body) && /\bstatus\b/.test(instructions) && /supported|contradicted/.test(instructions)) return "fact-check";
  if (hasWebSearch(body) && /lead time|price|availability|hard to order/.test(user)) return "lookup";
  if (path.endsWith("/responses") || path.endsWith("/chat/completions")) return "answer";
  return "unknown";
}

/* ------------------------------------------------------------------ */
/* JSON-schema filler                                                  */
/* ------------------------------------------------------------------ */

interface SchemaNode {
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  anyOf?: SchemaNode[];
  oneOf?: SchemaNode[];
  maxItems?: number;
  maxLength?: number;
}

function primaryType(node: SchemaNode): string | undefined {
  if (Array.isArray(node.type)) return node.type.find(t => t !== "null") ?? "null";
  if (node.type) return node.type;
  if (node.properties) return "object";
  if (node.items) return "array";
  return undefined;
}
function pickVariant(node: SchemaNode): SchemaNode {
  const variants = node.anyOf ?? node.oneOf;
  if (!variants) return node;
  return variants.find(v => primaryType(v) !== "null") ?? variants[0]!;
}

export interface FillContext { analysis: FakeAnalysis; intent: FakeIntent; answer: string; target: string }

function arrayFor(key: string, ctx: FillContext): unknown[] {
  const k = key.toLowerCase();
  const a = ctx.analysis;
  if (/concept|term|glossary/.test(k)) return a.concepts;
  if (/conflict|contradiction|inconsisten/.test(k)) return a.conflicts;
  if (/suggest|follow/.test(k)) return a.suggestions;
  if (/ask|need|implicit|request/.test(k)) return a.asks;
  if (/fact/.test(k)) return a.keyFacts;
  if (/bullet|summary|point|highlight/.test(k)) return a.bullets;
  if (/source|citation|url/.test(k)) return [];
  if (/question/.test(k)) return a.suggestions.map(s => s.question);
  return [];
}
function stringFor(key: string, ctx: FillContext, item?: Record<string, unknown>): string {
  if (item && typeof item[key] === "string") return item[key] as string;
  const k = key.toLowerCase(), a = ctx.analysis;
  if (/^(?:summary|verdict)$/.test(k)) return ctx.intent === "verify" ? `Checked: ${ctx.target.slice(0, 120)}` : a.bullets.join(" ");
  if (/answer|proposal|response|text|content/.test(k)) return ctx.answer;
  if (/term/.test(k)) return a.concepts[0]?.term ?? "";
  if (/explanation|reason|why/.test(k)) return a.concepts[0]?.explanation ?? a.conflicts[0]?.explanation ?? "No explanation.";
  if (/earlier/.test(k)) return a.conflicts[0]?.earlier ?? "";
  if (/later/.test(k)) return a.conflicts[0]?.later ?? "";
  if (/topic/.test(k)) return a.asks[0]?.topic ?? "";
  if (/trigger|quote/.test(k)) return a.asks[0]?.trigger ?? "";
  if (/question/.test(k)) return a.suggestions[0]?.question ?? "";
  if (/target|claim/.test(k)) return ctx.target;
  if (/query/.test(k)) return a.asks[0]?.topic ?? ctx.target;
  return "";
}
function enumFor(key: string, options: unknown[], ctx: FillContext, item?: Record<string, unknown>): unknown {
  if (item && options.includes(item[key])) return item[key];
  const prefer = /status|verdict/.test(key.toLowerCase())
    ? (ctx.intent === "verify" || ctx.intent === "fact-check" ? ["supported", "done", "completed"] : ["done", "supported", "completed"])
    : [];
  return prefer.find(p => options.includes(p)) ?? options[0];
}

export function fillSchema(input: SchemaNode, key: string, ctx: FillContext, item?: Record<string, unknown>): unknown {
  const node = pickVariant(input);
  if (node.const !== undefined) return node.const;
  if (node.enum) return enumFor(key, node.enum, ctx, item);
  switch (primaryType(node)) {
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(node.properties ?? {})) out[name] = fillSchema(child, name, ctx, item);
      return out;
    }
    case "array": {
      const source = item && Array.isArray(item[key]) ? item[key] as unknown[] : arrayFor(key, ctx);
      const limited = source.slice(0, node.maxItems ?? source.length);
      const childNode = node.items ? pickVariant(node.items) : {};
      return limited.map(entry => primaryType(childNode) === "object"
        ? fillSchema(childNode, key, ctx, (entry && typeof entry === "object" ? entry : { value: entry }) as Record<string, unknown>)
        : typeof entry === "string" ? entry : entry && typeof entry === "object" ? Object.values(entry).find(v => typeof v === "string") ?? "" : String(entry));
    }
    case "string": {
      const value = stringFor(key, ctx, item);
      return node.maxLength ? value.slice(0, node.maxLength) : value;
    }
    case "number": case "integer": return item && typeof item[key] === "number" ? item[key] : /confidence|score/.test(key) ? 0.9 : 1;
    case "boolean": return item && typeof item[key] === "boolean" ? item[key] : /conflict/.test(key) ? ctx.analysis.conflicts.length > 0 : true;
    case "null": return null;
    default: return stringFor(key, ctx, item);
  }
}

/* ------------------------------------------------------------------ */
/* Output text                                                         */
/* ------------------------------------------------------------------ */

const LOOKUP_SOURCES = [
  { url: "https://developer.nvidia.com/embedded/jetson-modules", title: "Jetson Modules | NVIDIA Developer" },
  { url: "https://www.example-distributor.com/jetson-orin-lead-time", title: "Jetson Orin availability and lead times" },
];
const VERIFY_SOURCES = [{ url: "https://en.wikipedia.org/wiki/Fact-checking", title: "Fact-checking - Wikipedia" }];

function answerText(intent: FakeIntent, body: Record<string, unknown>, analysis: FakeAnalysis): string {
  const request = lastUserText(body).replace(/\s+/g, " ");
  const all = conversationText(body);
  if (intent === "fact-check" || intent === "verify") {
    const raw = collectStrings(body.input ?? body.messages).join("\n");
    const claim = (() => { try { return String((JSON.parse(raw) as { claim?: unknown }).claim ?? request); } catch { return request; } })();
    return JSON.stringify({ status: "supported", summary: `Public sources are consistent with: ${claim.slice(0, 160)}` });
  }
  if (intent === "lookup" || (intent === "answer" && /lead time|hard to order/i.test(request))) {
    return "Jetson Orin modules currently list 12 to 16 week lead times at major distributors; developer kits ship sooner but are allocation-limited.";
  }
  if (intent === "propose" || (intent === "answer" && /16 GB RAM/i.test(request))) {
    return "16 GB RAM with a 1 TB NVMe SSD fits one detector plus bag recording; budget 32 GB if you add a second model or mapping.";
  }
  if (intent === "insight") {
    const raw = collectStrings(body.input ?? body.messages).join("\n");
    const latest = (() => { try { return String((JSON.parse(raw) as { latestSpeech?: unknown }).latestSpeech ?? all); } catch { return all; } })();
    const concept = analyzeConversation(latest).concepts[0];
    return concept ? JSON.stringify(concept) : "null";
  }
  const question = (/[^.!?]*\?/u.exec(request)?.[0] ?? request).trim().slice(0, 100);
  return `Short answer for "${question}": state the concrete number, the trade-off, and one follow-up.${analysis.conflicts.length ? " Note the earlier figure conflicts." : ""}`;
}

function usageFor(body: Record<string, unknown>, output: string, priorSamePrefix: boolean, webSearch: boolean) {
  const inputTokens = Math.max(8, Math.ceil(JSON.stringify(body).length / 4));
  const cached = priorSamePrefix ? Math.floor(inputTokens / 2) : 0;
  const effort = (body.reasoning as { effort?: string } | undefined)?.effort;
  const reasoning = effort && effort !== "none" ? 64 : 0;
  const outputTokens = Math.max(1, Math.ceil(output.length / 4)) + reasoning;
  return { inputTokens: inputTokens + (webSearch ? 400 : 0), cached, outputTokens, reasoning };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function abortError(): Error { return new DOMException("The operation was aborted.", "AbortError"); }
function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
function chunkText(text: string): string[] {
  return text.match(/\S+\s*/gu) ?? [text];
}
function sse(event: unknown): string { return `data: ${JSON.stringify(event)}\n\n`; }
let counter = 0;
const nextId = (prefix: string) => `${prefix}_fake_${(++counter).toString(36)}`;

async function parseBody(init?: RequestInit): Promise<Record<string, unknown>> {
  const body = init?.body;
  if (body === undefined || body === null) return {};
  if (typeof body === "string") { try { return JSON.parse(body) as Record<string, unknown>; } catch { return { raw: body }; } }
  if (body instanceof FormData) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of body.entries()) {
      out[key] = typeof value === "string" ? value : { size: value.size, type: value.type, name: (value as File).name };
    }
    return out;
  }
  if (body instanceof Blob) return { blob: { size: body.size, type: body.type } };
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) return { bytes: (body as ArrayBuffer).byteLength };
  return {};
}
function headerValue(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) return headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  const entry = Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

/* ------------------------------------------------------------------ */
/* Fake realtime transcription socket                                  */
/* ------------------------------------------------------------------ */

type Listener = (event: { data?: unknown; code?: number; reason?: string; wasClean?: boolean }) => void;

/** Browser-shaped WebSocket for wss://api.openai.com/v1/realtime?intent=transcription. */
export class FakeRealtimeSocket {
  public static readonly CONNECTING = 0;
  public static readonly OPEN = 1;
  public static readonly CLOSING = 2;
  public static readonly CLOSED = 3;
  public readyState = 0;
  public binaryType = "blob";
  public protocol = "";
  public readonly received: Record<string, unknown>[] = [];
  public readonly sent: Record<string, unknown>[] = [];
  public onopen: Listener | null = null;
  public onmessage: Listener | null = null;
  public onclose: Listener | null = null;
  public onerror: Listener | null = null;
  /** Bytes of base64-decoded PCM in the current (uncommitted) buffer. */
  public bufferedBytes = 0;
  /** Commit timestamps (ms) for latency assertions. */
  public readonly commits: { itemId: string; at: number; bytes: number; completedAt?: number }[] = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  public constructor(
    public readonly url: string,
    public readonly protocols: string[],
    private readonly host: { takeTranscript: () => string; latency: () => FakeLatency; now: () => number },
  ) {
    this.protocol = protocols.includes("realtime") ? "realtime" : protocols[0] ?? "";
    queueMicrotask(() => {
      const authorized = protocols.some(p => p.startsWith("openai-insecure-api-key."));
      if (!/^wss:\/\/api\.openai\.com\/v1\/realtime\b/.test(url) || !authorized) {
        this.dispatch("error", {}); this.finish(1008, "unauthorized"); return;
      }
      this.readyState = 1; this.dispatch("open", {});
      this.serverEvent({ type: "session.created", session: { id: nextId("sess"), type: "transcription" } });
    });
  }
  public get authToken(): string | undefined {
    return this.protocols.find(p => p.startsWith("openai-insecure-api-key."))?.slice("openai-insecure-api-key.".length);
  }
  public addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>(); set.add(listener); this.listeners.set(type, set);
  }
  public removeEventListener(type: string, listener: Listener): void { this.listeners.get(type)?.delete(listener); }
  public send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    if (this.readyState !== 1) throw new DOMException("WebSocket is not open", "InvalidStateError");
    if (typeof data !== "string") { this.serverEvent({ type: "error", error: { type: "invalid_request_error", code: "binary_not_supported", message: "Send JSON events." } }); return; }
    let event: Record<string, unknown>;
    try { event = JSON.parse(data) as Record<string, unknown>; } catch { this.serverEvent({ type: "error", error: { type: "invalid_request_error", message: "Invalid JSON" } }); return; }
    this.received.push(event);
    switch (event.type) {
      case "session.update": case "transcription_session.update":
        this.serverEvent({ type: event.type === "session.update" ? "session.updated" : "transcription_session.updated", session: (event as { session?: unknown }).session ?? {} });
        break;
      case "input_audio_buffer.append": {
        const audio = typeof event.audio === "string" ? event.audio : "";
        this.bufferedBytes += Math.floor(audio.length * 3 / 4) - (audio.endsWith("==") ? 2 : audio.endsWith("=") ? 1 : 0);
        break;
      }
      case "input_audio_buffer.clear": this.bufferedBytes = 0; this.serverEvent({ type: "input_audio_buffer.cleared" }); break;
      case "input_audio_buffer.commit": this.commit(); break;
      default: break;
    }
  }
  public close(code = 1000, reason = ""): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    queueMicrotask(() => this.finish(code, reason));
  }
  /** Server-initiated drop, for reconnect tests. */
  public serverClose(code = 1006, reason = "abnormal"): void { this.finish(code, reason); }

  private commit(): void {
    // 24 kHz PCM16: 100 ms = 4800 bytes; the real API rejects smaller commits.
    if (this.bufferedBytes < 4800) {
      this.serverEvent({ type: "error", error: { type: "invalid_request_error", code: "input_audio_buffer_commit_empty", message: "buffer too small" } });
      this.bufferedBytes = 0; return;
    }
    const itemId = nextId("item"), bytes = this.bufferedBytes;
    this.bufferedBytes = 0;
    const record: { itemId: string; at: number; bytes: number; completedAt?: number } = { itemId, at: this.host.now(), bytes };
    this.commits.push(record);
    this.serverEvent({ type: "input_audio_buffer.committed", item_id: itemId, previous_item_id: null });
    const transcript = this.host.takeTranscript();
    const words = chunkText(transcript);
    const total = this.host.latency().realtimeMs;
    // Absolute deadlines so integer timer rounding never shortens the configured latency.
    const until = async (fraction: number) => {
      const deadline = record.at + total * fraction;
      while (this.host.now() < deadline) await delay(Math.max(1, Math.ceil(deadline - this.host.now())));
    };
    void (async () => {
      for (const [index, word] of words.entries()) {
        await until((index + 1) / (words.length + 1));
        if (this.readyState !== 1) return;
        if (transcript) this.serverEvent({ type: "conversation.item.input_audio_transcription.delta", item_id: itemId, content_index: 0, delta: word });
      }
      await until(1);
      if (this.readyState !== 1) return;
      record.completedAt = this.host.now();
      this.serverEvent({ type: "conversation.item.input_audio_transcription.completed", item_id: itemId, content_index: 0, transcript,
        usage: { type: "duration", seconds: Math.round(bytes / 48000 * 100) / 100 } });
    })();
  }
  private serverEvent(event: Record<string, unknown>): void {
    const full = { event_id: nextId("event"), ...event };
    this.sent.push(full);
    queueMicrotask(() => { if (this.readyState === 1) this.dispatch("message", { data: JSON.stringify(full) }); });
  }
  private finish(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatch("close", { code, reason, wasClean: code === 1000 });
  }
  private dispatch(type: string, event: { data?: unknown; code?: number; reason?: string; wasClean?: boolean }): void {
    const handler = (this as unknown as Record<string, Listener | null>)[`on${type}`];
    try { handler?.(event); } catch { /* listener isolation */ }
    for (const listener of [...(this.listeners.get(type) ?? [])]) { try { listener(event); } catch { /* listener isolation */ } }
  }
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export function createFakeOpenAI(options: FakeOpenAIOptions = {}): FakeOpenAI {
  const latency: FakeLatency = { ...ZERO_LATENCY, ...options.latency };
  const transcripts: string[] = [...(options.transcripts ?? [])];
  const failures = new Map(Object.entries(options.failures ?? {}));
  const requests: FakeRecordedRequest[] = [];
  const sockets: FakeRealtimeSocket[] = [];
  const now = options.now ?? (() => Date.now());
  const seenPrefixes = new Set<string>();
  const takeTranscript = () => transcripts.shift() ?? options.fallbackTranscript ?? "";
  const faults: { fault: FakeFault; left: number; skip: number }[] = [];
  /** The first pending fault that applies to this request, used up once. */
  const takeFault = (intent: FakeIntent, stream: boolean, schema: boolean): FakeFault | undefined => {
    for (const [index, entry] of faults.entries()) {
      // The copilot analysis is the request with a JSON schema; its classified intent varies with its instructions.
      const fault = entry.fault, target = fault.intent ?? (fault.kind === "bad-json" ? "any" : "answer");
      if (target !== "any" && target !== intent) continue;
      if (fault.kind === "bad-json" ? !schema : fault.kind !== "http-error" && !stream) continue;
      if (entry.skip > 0) { entry.skip--; continue; }
      if (--entry.left <= 0) faults.splice(index, 1);
      return fault;
    }
    return undefined;
  };

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const signal = init?.signal ?? undefined;
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.startsWith(BASE) ? url.slice(BASE.length).split("?")[0]! : new URL(url).pathname;
    const body = await parseBody(init);
    const stream = body.stream === true;
    const webSearch = hasWebSearch(body);
    const format = schemaFormat(body);
    const kind: FakeRequestKind = path === "/audio/transcriptions" ? "transcription"
      : path === "/realtime/client_secrets" ? "client-secret"
      : path === "/responses" ? (stream ? "responses-stream" : "responses-json")
      : path === "/chat/completions" ? (stream ? "chat-stream" : "chat-json") : "unknown";
    const intent: FakeIntent = kind === "transcription" ? "transcription" : kind === "client-secret" ? "client-secret" : kind === "unknown" ? "unknown" : classify(body, path);
    const record: FakeRecordedRequest = { url, path, method, body, kind, intent, stream, webSearch, ...(format?.name ? { schemaName: format.name } : {}),
      ...(headerValue(init, "authorization") ? { authorization: headerValue(init, "authorization") } : {}), startedAt: now() };
    requests.push(record);
    signal?.addEventListener("abort", () => { record.aborted = true; }, { once: true });
    const done = (response: Response) => { record.endedAt ??= now(); record.status = response.status; return response; };

    if (!url.startsWith(BASE)) return done(new Response("not found", { status: 404 }));
    const forced = failures.get(path);
    if (forced) return done(Response.json({ error: { message: "forced failure", code: forced === 401 ? "invalid_api_key" : "fake" } }, { status: forced }));
    if (!/^Bearer \S+/.test(record.authorization ?? "")) return done(Response.json({ error: { message: "missing key" } }, { status: 401 }));

    if (kind === "transcription") {
      await delay(latency.transcriptionMs, signal);
      const text = takeTranscript();
      record.output = text;
      const file = body.file as { size?: number } | undefined;
      const seconds = file?.size ? Math.max(0, (file.size - 44) / 32000) : 0;
      return done(Response.json({ text, usage: { type: "duration", seconds: Math.round(seconds * 100) / 100 } }));
    }
    if (kind === "client-secret") {
      await delay(latency.jsonMs, signal);
      return done(Response.json({ value: `ek_fake_${(++counter).toString(36)}`, expires_at: Math.floor(now() / 1000) + 600, session: body.session ?? {} }));
    }
    if (kind === "unknown") return done(Response.json({ error: { message: "unknown path" } }, { status: 404 }));
    const fault = takeFault(intent, stream, format !== undefined);
    if (fault) record.fault = fault.kind;
    if (fault?.kind === "http-error") {
      const status = fault.status ?? 500;
      return done(Response.json({ error: { message: "injected failure", code: status === 401 ? "invalid_api_key" : "fake" } }, { status }));
    }

    const model = typeof body.model === "string" ? body.model : "unknown";
    const conversation = conversationText(body);
    const analysis = analyzeConversation(conversation);
    const answer = answerText(intent, body, analysis);
    const ctx: FillContext = { analysis, intent, answer, target: lastUserText(body) };
    const output = fault?.kind === "bad-json" ? "{\"summary\": {\"bullets\": [\"cut"
      : format ? JSON.stringify(fillSchema(format.schema, format.name ?? "root", ctx)) : answer;
    record.output = output;
    const prefix = `${path}|${model}|${instructionsText(body).slice(0, 200)}`;
    const usage = usageFor(body, output, seenPrefixes.has(prefix), webSearch);
    seenPrefixes.add(prefix);
    const sources = webSearch ? (intent === "lookup" ? LOOKUP_SOURCES : VERIFY_SOURCES) : [];
    const annotations = sources.map((s, i) => ({ type: "url_citation", url: s.url, title: s.title, start_index: 0, end_index: Math.min(output.length, 20 + i) }));
    const responseId = nextId("resp"), messageId = nextId("msg");
    const searchItem = webSearch ? [{ type: "web_search_call", id: nextId("ws"), status: "completed", action: { type: "search", query: ctx.analysis.asks[0]?.topic ?? ctx.target.slice(0, 80) } }] : [];
    const messageItem = { type: "message", id: messageId, role: "assistant", status: "completed", content: [{ type: "output_text", text: output, annotations }] };
    const responsesUsage = { input_tokens: usage.inputTokens, input_tokens_details: { cached_tokens: usage.cached }, output_tokens: usage.outputTokens,
      output_tokens_details: { reasoning_tokens: usage.reasoning }, total_tokens: usage.inputTokens + usage.outputTokens };
    const completedResponse = { id: responseId, object: "response", status: "completed", model, output: [...searchItem, messageItem], usage: responsesUsage };
    const chatUsage = { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens,
      prompt_tokens_details: { cached_tokens: usage.cached }, completion_tokens_details: { reasoning_tokens: usage.reasoning } };

    if (!stream) {
      await delay(latency.jsonMs + (webSearch ? latency.webSearchMs : 0), signal);
      if (kind === "responses-json") return done(Response.json(completedResponse));
      return done(Response.json({ id: responseId, object: "chat.completion", model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: output, ...(annotations.length ? { annotations: annotations.map(a => ({ type: "url_citation", url_citation: a })) } : {}) } }], usage: chatUsage }));
    }

    const encoder = new TextEncoder();
    const firstTokenMs = fault?.kind === "slow-first-token" ? fault.firstTokenMs ?? 4000 : latency.firstTokenMs;
    const allPieces = chunkText(output);
    const cutAt = fault?.kind === "cut-off" ? Math.max(1, Math.min(allPieces.length - 1, fault.afterDeltas ?? 6)) : undefined;
    const pieces = cutAt === undefined ? allPieces : allPieces.slice(0, cutAt);
    const malformedAt = fault?.kind === "malformed-event" ? Math.max(1, Math.min(pieces.length, fault.afterDeltas ?? 2)) : undefined;
    const malformed = { wait: 0, data: "data: {\"type\":\"response.output_text.delta\",\"delta\":\"oop\n\n" };
    const events: { wait: number; data: string }[] = [];
    if (cutAt !== undefined) {
      // The provider stopped early: what arrived is all there is.
      const partial = pieces.join("");
      record.output = partial;
      if (kind === "responses-stream") {
        events.push({ wait: 0, data: sse({ type: "response.created", response: { id: responseId, status: "in_progress", model } }) });
        pieces.forEach((delta, index) => events.push({ wait: index === 0 ? firstTokenMs : latency.interTokenMs,
          data: sse({ type: "response.output_text.delta", item_id: messageId, output_index: 0, content_index: 0, delta }) }));
        events.push({ wait: 0, data: sse({ type: "response.incomplete", response: { id: responseId, object: "response", status: "incomplete", model,
          incomplete_details: { reason: "max_output_tokens" },
          output: [{ type: "message", id: messageId, role: "assistant", status: "incomplete", content: [{ type: "output_text", text: partial, annotations: [] }] }], usage: responsesUsage } }) });
      } else {
        const base = { id: responseId, object: "chat.completion.chunk", model };
        pieces.forEach((content, index) => events.push({ wait: index === 0 ? firstTokenMs : latency.interTokenMs,
          data: sse({ ...base, choices: [{ index: 0, delta: index === 0 ? { role: "assistant", content } : { content }, finish_reason: null }] }) }));
        events.push({ wait: 0, data: sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "length" }] }) });
        events.push({ wait: 0, data: "data: [DONE]\n\n" });
      }
    } else if (kind === "responses-stream") {
      events.push({ wait: 0, data: sse({ type: "response.created", response: { id: responseId, status: "in_progress", model } }) });
      for (const item of searchItem) events.push({ wait: latency.webSearchMs, data: sse({ type: "response.output_item.done", output_index: 0, item }) });
      pieces.forEach((delta, index) => {
        if (index === malformedAt) events.push(malformed);
        events.push({ wait: index === 0 ? firstTokenMs : latency.interTokenMs,
          data: sse({ type: "response.output_text.delta", item_id: messageId, output_index: searchItem.length, content_index: 0, delta }) });
      });
      if (malformedAt === pieces.length) events.push(malformed);
      annotations.forEach((annotation, index) => events.push({ wait: 0, data: sse({ type: "response.output_text.annotation.added", item_id: messageId, output_index: searchItem.length, content_index: 0, annotation_index: index, annotation }) }));
      events.push({ wait: 0, data: sse({ type: "response.output_text.done", item_id: messageId, output_index: searchItem.length, content_index: 0, text: output }) });
      events.push({ wait: 0, data: sse({ type: "response.completed", response: completedResponse }) });
    } else {
      const base = { id: responseId, object: "chat.completion.chunk", model };
      pieces.forEach((content, index) => {
        if (index === malformedAt) events.push(malformed);
        events.push({ wait: index === 0 ? firstTokenMs : latency.interTokenMs,
          data: sse({ ...base, choices: [{ index: 0, delta: index === 0 ? { role: "assistant", content } : { content }, finish_reason: null }] }) });
      });
      if (malformedAt === pieces.length) events.push(malformed);
      events.push({ wait: 0, data: sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) });
      const includeUsage = (body.stream_options as { include_usage?: boolean } | undefined)?.include_usage === true;
      if (includeUsage) events.push({ wait: 0, data: sse({ ...base, choices: [], usage: chatUsage }) });
      events.push({ wait: 0, data: "data: [DONE]\n\n" });
    }
    let index = 0;
    const streamBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = events[index++];
        if (!next) { record.endedAt ??= now(); controller.close(); return; }
        try { await delay(next.wait, signal); }
        catch (error) { controller.error(error); return; }
        controller.enqueue(encoder.encode(next.data));
      },
      cancel() { record.endedAt ??= now(); },
    });
    record.status = 200;
    return new Response(streamBody, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  const webSocketFactory = (url: string, protocols?: string | string[]) => {
    const socket = new FakeRealtimeSocket(url, protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols], { takeTranscript, latency: () => latency, now });
    sockets.push(socket);
    return socket;
  };

  return {
    fetch, webSocketFactory, requests, sockets, latency,
    setLatency(next) { Object.assign(latency, next); },
    queueTranscript(...texts) { transcripts.push(...texts); },
    pendingTranscripts: () => [...transcripts],
    setFailure(path, status) { if (status === undefined) failures.delete(path); else failures.set(path, status); },
    byIntent: intent => requests.filter(request => request.intent === intent),
    reset() { requests.length = 0; sockets.length = 0; transcripts.length = 0; seenPrefixes.clear(); faults.length = 0; Object.assign(latency, ZERO_LATENCY, options.latency); },
    injectFault(fault) { const left = fault.times ?? 1; if (left > 0) faults.push({ fault, left, skip: Math.max(0, fault.skip ?? 0) }); },
    clearFaults() { faults.length = 0; },
    pendingFaults: () => faults.map(entry => entry.fault),
  };
}

/** Synthetic 16 kHz mono PCM16 tone (loud enough for the SDK's RMS speech gate). */
export function synthSpeechPcm(durationMs: number, amplitude = 6000, frequencyHz = 220): Int16Array {
  const samples = new Int16Array(Math.round(16 * durationMs));
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(amplitude * Math.sin(2 * Math.PI * frequencyHz * i / 16000));
  return samples;
}
