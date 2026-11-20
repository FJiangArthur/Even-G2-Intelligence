export const HELIX_PROTOCOL_VERSION = "2.1" as const;

export type ISO8601Timestamp = string;

export const CONVERSATION_MODES = [
  "general",
  "interviewee",
  "interviewer",
  "social",
  "office-discussion",
  "passive",
  // v0.10 modes
  "technical",
  "partner",
  "negotiation",
  "learning",
  // Notes mode: note-taker (action items, to-do list, running notes)
  "notes",
] as const;
export type ConversationMode = typeof CONVERSATION_MODES[number];
export type ConversationModeInput = ConversationMode | "interview";
/**
 * Prompt modes were intentionally open-ended in the 0.1 SDK. Keep that source
 * compatibility while session-level policy uses the normalized, finite
 * `ConversationMode` set.
 */
export type PromptMode = ConversationModeInput | (string & {});

export const RESPONSE_STRATEGIES = ["reactive", "proactive", "both"] as const;
export type ResponseStrategy = typeof RESPONSE_STRATEGIES[number];
export const RESPONSE_TRIGGERS = ["question", "proactive", "manual"] as const;
export type ResponseTrigger = typeof RESPONSE_TRIGGERS[number];

export const DEFAULT_CONVERSATION_MODE: ConversationMode = "general";
export const DEFAULT_RESPONSE_STRATEGY: ResponseStrategy = "reactive";

export interface Speaker {
  readonly id?: string;
  readonly label: string;
  readonly role: "self" | "other" | "unknown";
}

export interface PromptReference {
  readonly id: string;
  readonly version: string;
}

export interface PromptConfig extends PromptReference {
  readonly system: string;
  /** @deprecated Prefer the session-level `mode`. Known values are normalized; custom values are preserved. */
  readonly mode?: PromptMode;
  readonly maxResponseSentences?: number;
  readonly variables?: Readonly<Record<string, string>>;
}

/**
 * A logical gateway route. Credentials intentionally do not belong in this
 * browser-safe type; authenticate the socket out-of-band or in an injected
 * transport factory.
 */
export interface EndpointConfig {
  readonly id: string;
  readonly url: string;
  readonly provider: string;
  readonly model: string;
}

export interface AudioConfig {
  readonly encoding: "pcm_s16le";
  readonly sampleRateHz: 16000;
  readonly channels: 1;
}

/** Client preference IDs resolved against server-owned provider profiles. */
export interface ProviderProfilePreferences {
  readonly transcriptionProvider?: string;
  readonly answerProvider?: string;
}

export const PROVIDER_CREDENTIAL_NAMES = ["openai", "deepgram", "soniox", "omi"] as const;
export type ProviderCredentialName = typeof PROVIDER_CREDENTIAL_NAMES[number];
export const MAX_PROVIDER_CREDENTIAL_LENGTH = 8_192;

/**
 * Transient BYOK material sent once with `session.start`. This object is never
 * part of SessionConfig, an accepted event, provenance, or a persisted SDK model.
 */
export type SessionStartCredentials = Readonly<Partial<Record<ProviderCredentialName, string>>>;

export function normalizeSessionStartCredentials(value: unknown): SessionStartCredentials | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) throw new Error("provider credentials must be an object");
  if (!hasOnlyKeys(value, PROVIDER_CREDENTIAL_NAMES)) {
    throw new Error("provider credentials contain an unsupported field");
  }

  const normalized: Partial<Record<ProviderCredentialName, string>> = {};
  for (const name of PROVIDER_CREDENTIAL_NAMES) {
    const candidate = value[name];
    if (candidate === undefined) continue;
    if (typeof candidate !== "string") {
      throw new Error(`provider credential ${name} must be a string`);
    }
    const credential = candidate.trim();
    if (credential === "") continue;
    if (credential.length > MAX_PROVIDER_CREDENTIAL_LENGTH || /[\u0000-\u001F\u007F]/u.test(credential)) {
      throw new Error(`provider credential ${name} is invalid`);
    }
    normalized[name] = credential;
  }
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

/** Server-selected, non-secret provider provenance. URLs and keys are forbidden. */
export interface ProviderProfileSelection {
  readonly profileId: string;
  readonly model?: string;
}

export interface MemorySettings {
  readonly readOmiContext: boolean;
  readonly syncNotes: boolean;
}

export interface AutomationSettings {
  readonly detectQuestions: boolean;
  readonly answerQuestions: boolean;
  readonly saveNotes: boolean;
}

export interface SessionConfig {
  readonly sessionId: string;
  readonly endpoint: EndpointConfig;
  readonly prompt: PromptConfig;
  readonly mode?: ConversationModeInput;
  readonly responseStrategy?: ResponseStrategy;
  readonly providers?: ProviderProfilePreferences;
  readonly memory?: MemorySettings;
  readonly audio?: AudioConfig;
  readonly locale?: string;
  readonly speaker: Speaker;
  readonly automation?: AutomationSettings;
  readonly client?: {
    readonly name: string;
    readonly version: string;
    readonly device?: string;
  };
}

export type NormalizedSessionConfig = Omit<
  SessionConfig,
  "audio" | "memory" | "mode" | "prompt" | "responseStrategy"
> & {
  readonly audio: AudioConfig;
  readonly memory: MemorySettings;
  readonly mode: ConversationMode;
  readonly prompt: Omit<PromptConfig, "mode"> & { readonly mode: PromptMode };
  readonly responseStrategy: ResponseStrategy;
};

export function isConversationMode(value: unknown): value is ConversationMode {
  return typeof value === "string" && (CONVERSATION_MODES as readonly string[]).includes(value);
}

export function isResponseStrategy(value: unknown): value is ResponseStrategy {
  return typeof value === "string" && (RESPONSE_STRATEGIES as readonly string[]).includes(value);
}

export function normalizeConversationMode(value: unknown): ConversationMode {
  if (value === undefined) return DEFAULT_CONVERSATION_MODE;
  if (value === "interview") return "interviewee";
  if (isConversationMode(value)) return value;
  throw new RangeError(`Unsupported conversation mode: ${String(value)}`);
}

export function normalizeResponseStrategy(value: unknown): ResponseStrategy {
  if (value === undefined) return DEFAULT_RESPONSE_STRATEGY;
  if (isResponseStrategy(value)) return value;
  throw new RangeError(`Unsupported response strategy: ${String(value)}`);
}

function normalizePromptMode(value: PromptMode | undefined): PromptMode | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized === "interview") return "interview";
  if (isConversationMode(normalized)) return normalized;
  return normalized;
}

/** Validates untrusted input and narrows it to the credential-free session shape. */
export function validateSessionConfig(value: unknown): asserts value is SessionConfig {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, [
    "sessionId",
    "endpoint",
    "prompt",
    "mode",
    "responseStrategy",
    "providers",
    "memory",
    "audio",
    "locale",
    "speaker",
    "automation",
    "client",
  ])) throw new Error("session configuration has unsupported fields");
  if (!isNonBlankBoundedString(value.sessionId, 128)) throw new Error("sessionId is required");
  if (!isOutboundEndpointConfig(value.endpoint)) {
    throw new Error("endpoint must contain a credential-free HTTPS provider or WebSocket URL and valid profile labels");
  }
  if (!isPromptConfig(value.prompt)) throw new Error("prompt configuration is invalid");
  if (value.mode !== undefined && !isConversationModeInput(value.mode)) {
    throw new Error("conversation mode is invalid");
  }
  if (value.responseStrategy !== undefined && !isResponseStrategy(value.responseStrategy)) {
    throw new Error("response strategy is invalid");
  }
  if (!isProviderProfilePreferences(value.providers)) throw new Error("provider profile preferences are invalid");
  if (!isOptionalMemorySettings(value.memory)) throw new Error("memory settings are invalid");
  if (value.audio !== undefined && !isAudioConfig(value.audio)) {
    throw new Error("Only mono PCM16 at 16kHz is supported");
  }
  if (value.locale !== undefined && !isNonBlankBoundedString(value.locale, 64)) {
    throw new Error("locale is invalid");
  }
  if (!isSpeaker(value.speaker)) throw new Error("speaker label and role are required");
  if (!isAutomationConfig(value.automation)) throw new Error("automation settings are invalid");
  if (!isClientDescriptor(value.client)) throw new Error("client descriptor is invalid");
}

/**
 * Produces the canonical 2.1 session payload. New fields are additive, and the
 * former `interview` prompt mode is emitted as `interviewee`.
 */
export function normalizeSessionConfig(value: unknown): NormalizedSessionConfig {
  validateSessionConfig(value);
  const promptMode = normalizePromptMode(value.prompt.mode);
  const mode = value.mode !== undefined
    ? normalizeConversationMode(value.mode)
    : promptMode !== undefined && (promptMode === "interview" || isConversationMode(promptMode))
      ? normalizeConversationMode(promptMode)
      : DEFAULT_CONVERSATION_MODE;
  const responseStrategy = normalizeResponseStrategy(value.responseStrategy);
  const providers = value.providers === undefined
    ? undefined
    : {
        ...(value.providers.transcriptionProvider === undefined
          ? {}
          : { transcriptionProvider: value.providers.transcriptionProvider.trim() }),
        ...(value.providers.answerProvider === undefined
          ? {}
          : { answerProvider: value.providers.answerProvider.trim() }),
      };
  return {
    sessionId: value.sessionId.trim(),
    endpoint: {
      id: value.endpoint.id.trim(),
      url: value.endpoint.url,
      provider: value.endpoint.provider.trim(),
      model: value.endpoint.model.trim(),
    },
    prompt: {
      id: value.prompt.id.trim(),
      version: value.prompt.version.trim(),
      system: value.prompt.system.trim(),
      mode: promptMode === undefined
        ? mode
        : promptMode === "interview"
          ? "interviewee"
          : promptMode,
      ...(value.prompt.maxResponseSentences === undefined
        ? {}
        : { maxResponseSentences: value.prompt.maxResponseSentences }),
      ...(value.prompt.variables === undefined ? {} : { variables: { ...value.prompt.variables } }),
    },
    mode,
    responseStrategy,
    ...(providers === undefined ? {} : { providers }),
    memory: {
      readOmiContext: value.memory?.readOmiContext ?? false,
      syncNotes: value.memory?.syncNotes ?? false,
    },
    audio: value.audio === undefined ? {
      encoding: "pcm_s16le",
      sampleRateHz: 16000,
      channels: 1,
    } : { ...value.audio },
    ...(value.locale === undefined ? {} : { locale: value.locale.trim() }),
    speaker: {
      ...(value.speaker.id === undefined ? {} : { id: value.speaker.id.trim() }),
      label: value.speaker.label.trim(),
      role: value.speaker.role,
    },
    ...(value.automation === undefined ? {} : { automation: { ...value.automation } }),
    ...(value.client === undefined ? {} : {
      client: {
        name: value.client.name.trim(),
        version: value.client.version.trim(),
        ...(value.client.device === undefined ? {} : { device: value.client.device.trim() }),
      },
    }),
  };
}

export interface LatencyBreakdown {
  readonly captureMs?: number;
  readonly transcriptionMs?: number;
  readonly questionDetectionMs?: number;
  readonly firstTokenMs?: number;
  readonly completionMs?: number;
  readonly totalMs: number;
}

export interface ConversationContext {
  readonly prompt: PromptReference;
  readonly endpoint: EndpointConfig;
  readonly speaker: Speaker;
  readonly latencyMs: LatencyBreakdown;
  readonly mode?: ConversationMode;
  readonly responseStrategy?: ResponseStrategy;
  readonly transcriptionProvider?: ProviderProfileSelection;
  readonly answerProvider?: ProviderProfileSelection;
  readonly trigger?: ResponseTrigger;
}

interface CommandBase {
  readonly protocolVersion: typeof HELIX_PROTOCOL_VERSION;
  readonly commandId: string;
  readonly sentAt: ISO8601Timestamp;
}

export interface SessionStartCommand extends CommandBase {
  readonly type: "session.start";
  readonly session: SessionConfig;
  readonly credentials?: SessionStartCredentials;
}

export interface SessionEndCommand extends CommandBase {
  readonly type: "session.end";
  readonly sessionId: string;
  readonly reason: "user" | "client-error" | "shutdown";
}

export interface AudioCommitCommand extends CommandBase {
  readonly type: "audio.commit";
  readonly sessionId: string;
  readonly sequence: number;
  readonly reason: "manual" | "vad";
  readonly speaker: Speaker;
}

export interface AudioFrameMetadata {
  /** Vendor-neutral source label, for example `glasses` or `phone`. */
  readonly source?: string;
  /** Raw G2 direction tag. No angle or stable identity is inferred. */
  readonly direction?: number | null;
  /** Per-frame classification only; it is not a persistent speaker identity. */
  readonly speakerRole?: Speaker["role"];
  readonly capturedAt?: ISO8601Timestamp;
}

export interface AudioFrameCommand extends CommandBase, AudioFrameMetadata {
  readonly type: "audio.frame";
  readonly sessionId: string;
  readonly sequence: number;
  readonly sampleCount: number;
  readonly sampleRateHz: 16000;
  readonly channels: 1;
}

export type ContextScope = "local" | "global";
export interface QueryCommand extends CommandBase {
  readonly type: "query";
  readonly sessionId: string;
  readonly requestId: string;
  readonly text: string;
  readonly contextScope?: ContextScope;
  readonly speaker: Speaker;
}

export type ClientCommand =
  | SessionStartCommand
  | SessionEndCommand
  | AudioFrameCommand
  | AudioCommitCommand
  | QueryCommand;

export interface AudioFrame extends AudioFrameMetadata {
  readonly sessionId: string;
  readonly sequence: number;
  readonly sampleRateHz: 16000;
  readonly channels: 1;
  readonly samples: Int16Array;
}

interface GatewayEventBase {
  readonly protocolVersion: typeof HELIX_PROTOCOL_VERSION;
  readonly eventId: string;
  readonly sessionId: string;
  readonly occurredAt: ISO8601Timestamp;
}

export interface SessionStartedEvent extends GatewayEventBase {
  readonly type: "session.started";
  readonly accepted: {
    readonly prompt: PromptReference;
    readonly endpoint: EndpointConfig;
    readonly audio: AudioConfig;
    readonly mode?: ConversationMode;
    readonly responseStrategy?: ResponseStrategy;
    readonly transcriptionProvider?: ProviderProfileSelection;
    readonly answerProvider?: ProviderProfileSelection;
    readonly memory?: MemorySettings;
    readonly automation?: AutomationSettings;
  };
}

export interface SessionEndedEvent extends GatewayEventBase {
  readonly type: "session.ended";
  readonly reason: string;
}

export interface TranscriptPartialEvent extends GatewayEventBase {
  readonly type: "transcript.partial";
  readonly text: string;
  readonly revision: number;
  readonly context: ConversationContext;
}

export interface TranscriptFinalEvent extends GatewayEventBase {
  readonly type: "transcript.final";
  readonly transcriptId: string;
  readonly text: string;
  readonly context: ConversationContext;
}

export interface QuestionDetectedEvent extends GatewayEventBase {
  readonly type: "question.detected";
  readonly questionId: string;
  readonly text: string;
  readonly confidence: number;
  readonly sourceTranscriptId?: string;
  readonly context: ConversationContext;
}

export interface AnswerDeltaEvent extends GatewayEventBase {
  readonly type: "answer.delta";
  readonly answerId: string;
  readonly questionId?: string;
  readonly delta: string;
  readonly context: ConversationContext;
}

export interface AnswerCompletedEvent extends GatewayEventBase {
  readonly type: "answer.completed";
  readonly answerId: string;
  readonly questionId?: string;
  readonly text: string;
  readonly context: ConversationContext;
}

export interface NoteProvenance {
  readonly sessionId: string;
  readonly sourceEventId: string;
  readonly sourceType: "transcript" | "question" | "answer" | "manual";
  readonly capturedAt: ISO8601Timestamp;
  readonly prompt: PromptReference;
  readonly endpoint: EndpointConfig;
  readonly speaker: Speaker;
  readonly latencyMs: LatencyBreakdown;
  readonly mode?: ConversationMode;
  readonly responseStrategy?: ResponseStrategy;
  readonly transcriptionProvider?: ProviderProfileSelection;
  readonly answerProvider?: ProviderProfileSelection;
  readonly trigger?: ResponseTrigger;
}

export interface NotePersistenceOutcome {
  readonly destination: "omi";
  readonly status: "pending" | "synced" | "failed";
  /** Opaque remote record identifier; never a URL or credential. */
  readonly recordId?: string;
  readonly failureCode?: string;
}

export interface NoteCandidate {
  readonly id: string;
  readonly text: string;
  readonly title?: string;
  readonly tags?: readonly string[];
  readonly provenance: NoteProvenance;
  /** Absent means no remote persistence claim has been made. */
  readonly persistence?: NotePersistenceOutcome;
}

export interface NoteSuggestedEvent extends GatewayEventBase {
  readonly type: "note.suggested";
  readonly note: NoteCandidate;
  readonly context: ConversationContext;
}

export interface GatewayErrorEvent extends GatewayEventBase {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly fatal: boolean;
}

export type GatewayEvent =
  | SessionStartedEvent
  | SessionEndedEvent
  | TranscriptPartialEvent
  | TranscriptFinalEvent
  | QuestionDetectedEvent
  | AnswerDeltaEvent
  | AnswerCompletedEvent
  | NoteSuggestedEvent
  | GatewayErrorEvent;

const EVENT_TYPES = new Set<GatewayEvent["type"]>([
  "session.started",
  "session.ended",
  "transcript.partial",
  "transcript.final",
  "question.detected",
  "answer.delta",
  "answer.completed",
  "note.suggested",
  "error",
]);

const MAX_ID_LENGTH = 256;
const MAX_SHORT_TEXT_LENGTH = 1_024;
const MAX_EVENT_TEXT_LENGTH = 100_000;
const MAX_ENDPOINT_URL_LENGTH = 2_048;
const MAX_LATENCY_MS = 86_400_000;

export function isGatewayEvent(value: unknown): value is GatewayEvent {
  if (!isPlainRecord(value)) return false;
  const candidate = value;
  if (!(
    !containsCredentialNamedProperty(candidate) &&
    candidate.protocolVersion === HELIX_PROTOCOL_VERSION &&
    typeof candidate.type === "string" &&
    EVENT_TYPES.has(candidate.type as GatewayEvent["type"]) &&
    isIdentifier(candidate.eventId) &&
    isIdentifier(candidate.sessionId) &&
    isISO8601Timestamp(candidate.occurredAt)
  )) return false;

  switch (candidate.type) {
    case "session.started":
      return isSessionAcceptance(candidate.accepted);
    case "session.ended":
      return isBoundedString(candidate.reason, 1, MAX_SHORT_TEXT_LENGTH);
    case "transcript.partial":
      return isBoundedString(candidate.text, 0, MAX_EVENT_TEXT_LENGTH) &&
        isNonNegativeInteger(candidate.revision) && isConversationContext(candidate.context);
    case "transcript.final":
      return isIdentifier(candidate.transcriptId) &&
        isBoundedString(candidate.text, 1, MAX_EVENT_TEXT_LENGTH) &&
        isConversationContext(candidate.context);
    case "question.detected":
      return isIdentifier(candidate.questionId) &&
        isBoundedString(candidate.text, 1, MAX_EVENT_TEXT_LENGTH) &&
        typeof candidate.confidence === "number" && Number.isFinite(candidate.confidence) &&
        candidate.confidence >= 0 && candidate.confidence <= 1 &&
        isOptionalIdentifier(candidate.sourceTranscriptId) &&
        isConversationContext(candidate.context);
    case "answer.delta":
      return isIdentifier(candidate.answerId) &&
        isOptionalIdentifier(candidate.questionId) &&
        isBoundedString(candidate.delta, 1, MAX_EVENT_TEXT_LENGTH) &&
        isConversationContext(candidate.context);
    case "answer.completed":
      return isIdentifier(candidate.answerId) &&
        isOptionalIdentifier(candidate.questionId) &&
        isBoundedString(candidate.text, 1, MAX_EVENT_TEXT_LENGTH) &&
        isConversationContext(candidate.context);
    case "note.suggested":
      return isNoteCandidate(candidate.note) &&
        candidate.note.provenance.sessionId === candidate.sessionId &&
        isConversationContext(candidate.context) &&
        noteContextMatches(candidate.note.provenance, candidate.context);
    case "error":
      return isBoundedString(candidate.code, 1, MAX_ID_LENGTH) &&
        isBoundedString(candidate.message, 1, MAX_EVENT_TEXT_LENGTH) &&
        typeof candidate.retryable === "boolean" &&
        typeof candidate.fatal === "boolean";
    default:
      return false;
  }
}

/**
 * Accepts only a credential-free WebSocket route suitable for browser code.
 * Provider API keys belong on the gateway, never in this URL.
 */
export function isBrowserSafeEndpointUrl(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length === 0 ||
    value.length > MAX_ENDPOINT_URL_LENGTH ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) return false;

  try {
    const parsed = new URL(value);
    return (parsed.protocol === "ws:" || parsed.protocol === "wss:") &&
      parsed.hostname.length > 0 &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === "";
  } catch {
    return false;
  }
}

/** A browser route or the gateway's deliberately non-routable provider label. */
export function isSafeEndpointReference(value: unknown): value is string {
  return isBrowserSafeEndpointUrl(value) || isDirectProviderUrl(value) || (
    typeof value === "string" &&
    value.length <= MAX_ENDPOINT_URL_LENGTH &&
    /^urn:helix:provider:(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2}){1,256}$/u.test(value)
  );
}

/** HTTPS provenance for direct provider calls; never credentials in URLs. */
export function isDirectProviderUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("https://")) return false;
  return isBrowserSafeEndpointUrl(value.replace(/^https:/, "wss:"));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

const CREDENTIAL_PROPERTY_NAMES = new Set([
  "apikey",
  "accesstoken",
  "authorization",
  "bearertoken",
  "clientsecret",
  "credential",
  "credentials",
  "password",
  "privatekey",
  "secret",
  "token",
]);

/**
 * Additive event extensions are allowed, but an extension must not turn the
 * browser-facing protocol into a credential transport. The traversal is
 * cycle-safe and bounded so an untrusted event cannot make validation hang.
 */
function containsCredentialNamedProperty(root: unknown): boolean {
  const pending: unknown[] = [root];
  const seen = new WeakSet<object>();
  let visited = 0;

  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    visited += 1;
    if (visited > 10_000) return true;

    let entries: [string, unknown][];
    try {
      entries = Object.entries(value);
    } catch {
      return true;
    }
    for (const [key, entry] of entries) {
      const normalizedKey = key.replace(/[\s_-]/gu, "").toLowerCase();
      if (CREDENTIAL_PROPERTY_NAMES.has(normalizedKey)) return true;
      pending.push(entry);
    }
  }
  return false;
}

function hasNoneOfKeys(value: Record<string, unknown>, forbidden: readonly string[]): boolean {
  const forbiddenKeys = new Set(forbidden.map((key) => key.toLowerCase()));
  return Object.keys(value).every((key) => !forbiddenKeys.has(key.toLowerCase()));
}

function isBoundedString(value: unknown, minimumLength: number, maximumLength: number): value is string {
  return typeof value === "string" &&
    value.length >= minimumLength &&
    value.length <= maximumLength;
}

function isNonBlankBoundedString(value: unknown, maximumLength: number): value is string {
  return isBoundedString(value, 1, maximumLength) && value.trim().length > 0;
}

function isIdentifier(value: unknown): value is string {
  return isNonBlankBoundedString(value, MAX_ID_LENGTH);
}

function isOptionalIdentifier(value: unknown): value is string | undefined {
  return value === undefined || isIdentifier(value);
}

function isISO8601Timestamp(value: unknown): value is ISO8601Timestamp {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  const canonical = value.includes(".") ? value : value.replace(/Z$/u, ".000Z");
  return new Date(milliseconds).toISOString() === canonical;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isConversationModeInput(value: unknown): value is ConversationModeInput {
  return value === "interview" || isConversationMode(value);
}

export function isResponseTrigger(value: unknown): value is ResponseTrigger {
  return typeof value === "string" && (RESPONSE_TRIGGERS as readonly string[]).includes(value);
}

function isOutboundEndpointConfig(value: unknown): value is EndpointConfig {
  return isPlainRecord(value) &&
    hasOnlyKeys(value, ["id", "url", "provider", "model"]) &&
    isNonSecretProfileLabel(value.id, 128) &&
    (isBrowserSafeEndpointUrl(value.url) || isDirectProviderUrl(value.url)) &&
    isNonSecretProfileLabel(value.provider, 128) &&
    isNonSecretProfileLabel(value.model, 256);
}

function isPromptConfig(value: unknown): value is PromptConfig {
  return isPlainRecord(value) &&
    hasOnlyKeys(value, ["id", "version", "system", "mode", "maxResponseSentences", "variables"]) &&
    isNonBlankBoundedString(value.id, 128) &&
    isNonBlankBoundedString(value.version, 128) &&
    isNonBlankBoundedString(value.system, 8_000) &&
    (value.mode === undefined || isNonSecretProfileLabel(value.mode, 128)) &&
    (value.maxResponseSentences === undefined || (
      Number.isSafeInteger(value.maxResponseSentences) &&
      (value.maxResponseSentences as number) >= 1 &&
      (value.maxResponseSentences as number) <= 10
    )) &&
    isPromptVariables(value.variables);
}

function isPromptVariables(value: unknown): value is Readonly<Record<string, string>> | undefined {
  if (value === undefined) return true;
  if (!isPlainRecord(value) || Object.keys(value).length > 64) return false;
  return Object.entries(value).every(([key, entry]) =>
    isNonBlankBoundedString(key, 128) && isBoundedString(entry, 0, 4_000));
}

function isProviderProfilePreferences(value: unknown): value is ProviderProfilePreferences | undefined {
  return value === undefined || (
    isPlainRecord(value) &&
    hasOnlyKeys(value, ["transcriptionProvider", "answerProvider"]) &&
    (value.transcriptionProvider === undefined || isNonSecretProfileLabel(value.transcriptionProvider, 128)) &&
    (value.answerProvider === undefined || isNonSecretProfileLabel(value.answerProvider, 128))
  );
}

function isOptionalMemorySettings(value: unknown): value is MemorySettings | undefined {
  return value === undefined || (
    isPlainRecord(value) &&
    hasOnlyKeys(value, ["readOmiContext", "syncNotes"]) &&
    typeof value.readOmiContext === "boolean" &&
    typeof value.syncNotes === "boolean"
  );
}

function isAutomationConfig(value: unknown): value is SessionConfig["automation"] {
  return value === undefined || (
    isPlainRecord(value) &&
    hasOnlyKeys(value, ["detectQuestions", "answerQuestions", "saveNotes"]) &&
    typeof value.detectQuestions === "boolean" &&
    typeof value.answerQuestions === "boolean" &&
    typeof value.saveNotes === "boolean"
  );
}

function isClientDescriptor(value: unknown): value is SessionConfig["client"] {
  return value === undefined || (
    isPlainRecord(value) &&
    hasOnlyKeys(value, ["name", "version", "device"]) &&
    isNonBlankBoundedString(value.name, 128) &&
    isNonBlankBoundedString(value.version, 128) &&
    (value.device === undefined || isNonBlankBoundedString(value.device, 128))
  );
}

function isOptionalProviderProfileSelection(value: unknown): value is ProviderProfileSelection | undefined {
  return value === undefined || (
    isPlainRecord(value) &&
    hasNoneOfKeys(value, ["url", "baseUrl", "endpointUrl"]) &&
    isNonSecretProfileLabel(value.profileId, 128) &&
    (value.model === undefined || isNonSecretProfileLabel(value.model, 256))
  );
}

function isNonSecretProfileLabel(value: unknown, maximumLength: number): value is string {
  if (!isNonBlankBoundedString(value, maximumLength)) return false;
  const decoded = decodePercentEncoding(value);
  return !(
    /[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/u.test(decoded) ||
    /:\/\//u.test(decoded) ||
    /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/u.test(decoded) ||
    /\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/iu.test(decoded) ||
    /\bAKIA[A-Z0-9]{16}\b/u.test(decoded) ||
    /\b(?:api[ _-]?key|access[ _-]?token|auth(?:orization)?|bearer|password|secret)\s*(?::|=)\s*\S{8,}/iu.test(decoded) ||
    /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}\b/iu.test(decoded)
  );
}

function decodePercentEncoding(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isOptionalNotePersistenceOutcome(value: unknown): value is NotePersistenceOutcome | undefined {
  if (value === undefined) return true;
  if (!isPlainRecord(value) ||
    !hasNoneOfKeys(value, ["url", "uri"]) ||
    value.destination !== "omi" ||
    (value.status !== "pending" && value.status !== "synced" && value.status !== "failed") ||
    !isOptionalOpaqueIdentifier(value.recordId) ||
    !isOptionalOpaqueIdentifier(value.failureCode)) return false;
  if (value.status === "pending") return value.recordId === undefined && value.failureCode === undefined;
  if (value.status === "synced") return value.failureCode === undefined;
  return value.recordId === undefined;
}

function isOptionalOpaqueIdentifier(value: unknown): value is string | undefined {
  return value === undefined || (
    isNonSecretProfileLabel(value, MAX_ID_LENGTH) &&
    !/:\/\//u.test(value)
  );
}

function isConversationContext(value: unknown): value is ConversationContext {
  if (!isPlainRecord(value)) return false;
  return isPromptReference(value.prompt) &&
    isEndpointConfig(value.endpoint) &&
    isInboundSpeaker(value.speaker) &&
    isLatency(value.latencyMs) &&
    (value.mode === undefined || isConversationMode(value.mode)) &&
    (value.responseStrategy === undefined || isResponseStrategy(value.responseStrategy)) &&
    isOptionalProviderProfileSelection(value.transcriptionProvider) &&
    isOptionalProviderProfileSelection(value.answerProvider) &&
    (value.trigger === undefined || isResponseTrigger(value.trigger));
}

function isPromptReference(value: unknown): value is PromptReference {
  return isPlainRecord(value) &&
    isIdentifier(value.id) &&
    isIdentifier(value.version);
}

function isEndpointConfig(value: unknown): value is EndpointConfig {
  return isPlainRecord(value) &&
    isNonSecretProfileLabel(value.id, MAX_SHORT_TEXT_LENGTH) &&
    isSafeEndpointReference(value.url) &&
    isNonSecretProfileLabel(value.provider, MAX_SHORT_TEXT_LENGTH) &&
    isNonSecretProfileLabel(value.model, MAX_SHORT_TEXT_LENGTH);
}

function isSpeaker(value: unknown): value is Speaker {
  return isPlainRecord(value) &&
    hasOnlyKeys(value, ["id", "label", "role"]) &&
    isOptionalIdentifier(value.id) &&
    isNonBlankBoundedString(value.label, MAX_SHORT_TEXT_LENGTH) &&
    (value.role === "self" || value.role === "other" || value.role === "unknown");
}

function isInboundSpeaker(value: unknown): value is Speaker {
  return isPlainRecord(value) &&
    isOptionalIdentifier(value.id) &&
    isNonBlankBoundedString(value.label, MAX_SHORT_TEXT_LENGTH) &&
    (value.role === "self" || value.role === "other" || value.role === "unknown");
}

function isLatency(value: unknown): value is LatencyBreakdown {
  if (!isPlainRecord(value)) return false;
  return isLatencyValue(value.totalMs) &&
    isOptionalLatencyValue(value.captureMs) &&
    isOptionalLatencyValue(value.transcriptionMs) &&
    isOptionalLatencyValue(value.questionDetectionMs) &&
    isOptionalLatencyValue(value.firstTokenMs) &&
    isOptionalLatencyValue(value.completionMs);
}

function isNoteCandidate(value: unknown): value is NoteCandidate {
  if (!isPlainRecord(value) ||
    !isPlainRecord(value.provenance)) return false;
  const provenance = value.provenance;
  return isIdentifier(value.id) &&
    isBoundedString(value.text, 1, MAX_EVENT_TEXT_LENGTH) &&
    (value.title === undefined || isBoundedString(value.title, 1, 240)) &&
    isTags(value.tags) &&
    isIdentifier(provenance.sessionId) &&
    isIdentifier(provenance.sourceEventId) &&
    (provenance.sourceType === "transcript" ||
      provenance.sourceType === "question" ||
      provenance.sourceType === "answer" ||
      provenance.sourceType === "manual") &&
    isISO8601Timestamp(provenance.capturedAt) &&
    isPromptReference(provenance.prompt) &&
    isEndpointConfig(provenance.endpoint) &&
    isInboundSpeaker(provenance.speaker) &&
    isLatency(provenance.latencyMs) &&
    (provenance.mode === undefined || isConversationMode(provenance.mode)) &&
    (provenance.responseStrategy === undefined || isResponseStrategy(provenance.responseStrategy)) &&
    isOptionalProviderProfileSelection(provenance.transcriptionProvider) &&
    isOptionalProviderProfileSelection(provenance.answerProvider) &&
    (provenance.trigger === undefined || isResponseTrigger(provenance.trigger)) &&
    isOptionalNotePersistenceOutcome(value.persistence);
}

function isSessionAcceptance(value: unknown): boolean {
  return isPlainRecord(value) &&
    isPromptReference(value.prompt) &&
    isEndpointConfig(value.endpoint) &&
    isInboundAudioConfig(value.audio) &&
    (value.mode === undefined || isConversationMode(value.mode)) &&
    (value.responseStrategy === undefined || isResponseStrategy(value.responseStrategy)) &&
    isOptionalProviderProfileSelection(value.transcriptionProvider) &&
    isOptionalProviderProfileSelection(value.answerProvider) &&
    isOptionalAcceptedMemorySettings(value.memory) &&
    isOptionalAcceptedAutomationSettings(value.automation);
}

function isOptionalAcceptedMemorySettings(value: unknown): value is MemorySettings | undefined {
  return value === undefined || (
    isPlainRecord(value) &&
    typeof value.readOmiContext === "boolean" &&
    typeof value.syncNotes === "boolean"
  );
}

function isOptionalAcceptedAutomationSettings(value: unknown): value is AutomationSettings | undefined {
  return value === undefined || (
    isPlainRecord(value) &&
    typeof value.detectQuestions === "boolean" &&
    typeof value.answerQuestions === "boolean" &&
    typeof value.saveNotes === "boolean"
  );
}

function isInboundAudioConfig(value: unknown): value is AudioConfig {
  return isPlainRecord(value) &&
    value.encoding === "pcm_s16le" &&
    value.sampleRateHz === 16000 &&
    value.channels === 1;
}

function isAudioConfig(value: unknown): value is AudioConfig {
  return isPlainRecord(value) &&
    hasOnlyKeys(value, ["encoding", "sampleRateHz", "channels"]) &&
    value.encoding === "pcm_s16le" &&
    value.sampleRateHz === 16000 &&
    value.channels === 1;
}

function isTags(value: unknown): value is readonly string[] | undefined {
  return value === undefined || (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every((tag) => isNonBlankBoundedString(tag, 64))
  );
}

function isLatencyValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_LATENCY_MS;
}

function isOptionalLatencyValue(value: unknown): value is number | undefined {
  return value === undefined || isLatencyValue(value);
}

function noteContextMatches(provenance: NoteProvenance, context: ConversationContext): boolean {
  return provenance.prompt.id === context.prompt.id &&
    provenance.prompt.version === context.prompt.version &&
    provenance.endpoint.id === context.endpoint.id &&
    provenance.endpoint.url === context.endpoint.url &&
    provenance.endpoint.provider === context.endpoint.provider &&
    provenance.endpoint.model === context.endpoint.model &&
    provenance.speaker.id === context.speaker.id &&
    provenance.speaker.label === context.speaker.label &&
    provenance.speaker.role === context.speaker.role &&
    provenance.latencyMs.captureMs === context.latencyMs.captureMs &&
    provenance.latencyMs.transcriptionMs === context.latencyMs.transcriptionMs &&
    provenance.latencyMs.questionDetectionMs === context.latencyMs.questionDetectionMs &&
    provenance.latencyMs.firstTokenMs === context.latencyMs.firstTokenMs &&
    provenance.latencyMs.completionMs === context.latencyMs.completionMs &&
    provenance.latencyMs.totalMs === context.latencyMs.totalMs &&
    provenance.mode === context.mode &&
    provenance.responseStrategy === context.responseStrategy &&
    providerSelectionMatches(provenance.transcriptionProvider, context.transcriptionProvider) &&
    providerSelectionMatches(provenance.answerProvider, context.answerProvider) &&
    provenance.trigger === context.trigger;
}

function providerSelectionMatches(
  left: ProviderProfileSelection | undefined,
  right: ProviderProfileSelection | undefined,
): boolean {
  return left?.profileId === right?.profileId && left?.model === right?.model;
}
