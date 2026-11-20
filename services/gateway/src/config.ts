import type { EndpointConfig, ProviderProfileSelection } from "@helix/conversation-sdk";

export type GatewayMode = "mock" | "openai-compatible";
export type TranscriptionProviderKind = "mock" | "openai-compatible" | "deepgram" | "soniox";
export type AnswerProviderKind = "mock" | "openai-responses" | "openai-compatible";

const RESERVED_BUILTIN_PROFILE_IDS = new Set([
  "mock",
  "openai-compatible",
  "openai-transcription",
  "openai-responses",
  "deepgram",
  "soniox",
]);

interface ProfileBase {
  readonly id: string;
  readonly model: string;
  readonly requestTimeoutMs: number;
}

export interface MockTranscriptionProfile extends ProfileBase {
  readonly kind: "mock";
}

export interface HttpTranscriptionProfile extends ProfileBase {
  readonly kind: "openai-compatible" | "deepgram";
  readonly baseUrl: string;
  readonly path: string;
  readonly apiKey: string;
  readonly authHeader: string;
  readonly authScheme: string;
  readonly extraHeaders: Readonly<Record<string, string>>;
}

export interface SonioxTranscriptionProfile extends ProfileBase {
  readonly kind: "soniox";
  readonly websocketUrl: string;
  readonly apiKey: string;
}

export type TranscriptionProfileConfig =
  | MockTranscriptionProfile
  | HttpTranscriptionProfile
  | SonioxTranscriptionProfile;

export interface MockAnswerProfile extends ProfileBase {
  readonly kind: "mock";
}

export interface HttpAnswerProfile extends ProfileBase {
  readonly kind: "openai-responses" | "openai-compatible";
  readonly baseUrl: string;
  readonly path: string;
  readonly apiKey: string;
  readonly authHeader: string;
  readonly authScheme: string;
  readonly extraHeaders: Readonly<Record<string, string>>;
}

export type AnswerProfileConfig = MockAnswerProfile | HttpAnswerProfile;

/** Backward-compatible view of the original single OpenAI-compatible profile. */
export interface ProviderConfig {
  readonly id: string;
  readonly baseUrl: string;
  readonly transcriptionPath: string;
  readonly chatPath: string;
  readonly apiKey?: string;
  readonly authHeader: string;
  readonly authScheme: string;
  readonly transcriptionModel: string;
  readonly chatModel: string;
  readonly extraHeaders: Readonly<Record<string, string>>;
  readonly requestTimeoutMs: number;
}

export interface PromptConfig {
  readonly id: string;
  readonly version: string;
  readonly systemPrompt: string;
  readonly allowClientPrompt: boolean;
}

export interface OmiConfig {
  readonly apiKey?: string;
  readonly baseUrl: string;
  readonly memoriesPath: string;
  readonly category?: string;
  readonly maxRecentMemories: number;
  readonly maxContextMemories: number;
  readonly maxContextCharacters: number;
  readonly requestTimeoutMs: number;
  readonly answerWaitMs: number;
  readonly writeEnabled: boolean;
}

export interface GatewayConfig {
  readonly mode: GatewayMode;
  readonly host: string;
  readonly port: number;
  readonly maxAudioBytes: number;
  readonly mockTranscript: string;
  readonly gatewayToken?: string;
  readonly provider: ProviderConfig;
  readonly transcriptionProfiles: Readonly<Record<string, TranscriptionProfileConfig>>;
  readonly answerProfiles: Readonly<Record<string, AnswerProfileConfig>>;
  readonly allowedTranscriptionProfiles: readonly string[];
  readonly allowedAnswerProfiles: readonly string[];
  readonly defaultTranscriptionProfile: string;
  readonly defaultAnswerProfile: string;
  readonly omi: OmiConfig;
  readonly prompt: PromptConfig;
}

export class ConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  range: readonly [number, number],
): number {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < range[0] || parsed > range[1]) {
    throw new ConfigurationError(`${name} must be an integer from ${range[0]} to ${range[1]}`);
  }
  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConfigurationError(`${name} must be true or false`);
}

function parseJsonObject(value: string, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConfigurationError(`${name} must be valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConfigurationError(`${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseHeaders(value: string | undefined): Readonly<Record<string, string>> {
  if (value === undefined || value.trim() === "") return {};
  const parsed = parseJsonObject(value, "HELIX_PROVIDER_HEADERS_JSON");
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(parsed)) {
    if (typeof headerValue !== "string") {
      throw new ConfigurationError("Every HELIX_PROVIDER_HEADERS_JSON value must be a string");
    }
    if (/^(authorization|proxy-authorization|x-api-key)$/i.test(name)) {
      throw new ConfigurationError(`${name} must be configured with a server-only key variable, not extra headers`);
    }
    headers[name] = headerValue;
  }
  return headers;
}

export function parseProviderBaseUrl(value: string, name = "provider base URL"): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(`${name} must be an absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigurationError(`${name} must use HTTP or HTTPS`);
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new ConfigurationError(`${name} must use HTTPS unless it targets loopback development`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConfigurationError(`${name} cannot contain user information`);
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConfigurationError(`${name} cannot contain a query or fragment`);
  }
  return url.toString().replace(/\/$/, "");
}

export function parseWebSocketUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(`${name} must be an absolute URL`);
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new ConfigurationError(`${name} must use WS or WSS`);
  }
  if (url.protocol === "ws:" && !isLoopbackHost(url.hostname)) {
    throw new ConfigurationError(`${name} must use WSS unless it targets loopback development`);
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new ConfigurationError(`${name} cannot contain credentials, a query, or a fragment`);
  }
  return url.toString();
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLocaleLowerCase("en-US");
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function parseProviderPath(value: string, name: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("?") || value.includes("#")) {
    throw new ConfigurationError(`${name} must be an absolute path without a query or fragment`);
  }
  const decoded = value.split("/").map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      throw new ConfigurationError(`${name} contains invalid URL encoding`);
    }
  });
  if (decoded.some((segment) => segment === "." || segment === "..")) {
    throw new ConfigurationError(`${name} cannot contain relative path segments`);
  }
  return value;
}

function parseProfileId(value: string, name: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    throw new ConfigurationError(`${name} must contain only letters, digits, dot, underscore, or hyphen`);
  }
  return id;
}

function optionalString(record: Record<string, unknown>, key: string, fallback: string): string {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigurationError(`Provider profile ${key} must be a non-empty string`);
  }
  return value.trim();
}

function profileModel(record: Record<string, unknown>, fallback: string, name: string): string {
  const model = optionalString(record, "model", fallback);
  if (
    model.length > 256
    || /https?:\/\/|wss?:\/\//i.test(model)
    || /\b(?:api[_ -]?key|access[_ -]?token|password|secret)\b\s*[:=]/i.test(model)
    || /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/.test(model)
    || /\bsk-[A-Za-z0-9_-]{12,}\b/.test(model)
  ) {
    throw new ConfigurationError(`${name} model is not a safe public label`);
  }
  return model;
}

function assertProfileFields(record: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new ConfigurationError(`${name} contains unsupported field ${key}`);
    if (/key|secret|token|authorization/i.test(key)) {
      throw new ConfigurationError(`${name} cannot contain credentials`);
    }
  }
}

function profileDefinitions(value: string | undefined, name: string): Record<string, Record<string, unknown>> {
  if (value === undefined || value.trim() === "") return {};
  const parsed = parseJsonObject(value, name);
  const result: Record<string, Record<string, unknown>> = {};
  for (const [rawId, definition] of Object.entries(parsed)) {
    const id = parseProfileId(rawId, `${name} profile id`);
    if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
      throw new ConfigurationError(`${name}.${id} must be a JSON object`);
    }
    result[id] = definition as Record<string, unknown>;
  }
  return result;
}

function parseAllowlist(value: string | undefined, profiles: Readonly<Record<string, unknown>>, name: string): string[] {
  const ids = value === undefined
    ? Object.keys(profiles)
    : value.split(",").map((item) => item.trim()).filter(Boolean);
  const unique = [...new Set(ids)];
  for (const id of unique) {
    if (!(id in profiles)) throw new ConfigurationError(`${name} contains unconfigured profile ${id}`);
  }
  return unique;
}

function buildTranscriptionProfile(
  id: string,
  definition: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
  defaults: ProviderConfig,
): TranscriptionProfileConfig {
  assertProfileFields(definition, ["kind", "model", "baseUrl", "path", "websocketUrl"], `transcription profile ${id}`);
  const kind = optionalString(definition, "kind", "openai-compatible") as TranscriptionProviderKind;
  const timeout = defaults.requestTimeoutMs;
  if (kind === "mock") {
    return { id, kind, model: profileModel(definition, "mock", `transcription profile ${id}`), requestTimeoutMs: timeout };
  }
  if (kind === "soniox") {
    return {
      id,
      kind,
      model: profileModel(definition, environment.HELIX_SONIOX_MODEL?.trim() || "stt-rt-v5", `transcription profile ${id}`),
      requestTimeoutMs: timeout,
      websocketUrl: parseWebSocketUrl(
        optionalString(definition, "websocketUrl", environment.HELIX_SONIOX_WEBSOCKET_URL?.trim() || "wss://stt-rt.soniox.com/transcribe-websocket"),
        `transcription profile ${id} websocketUrl`,
      ),
      apiKey: environment.HELIX_SONIOX_API_KEY?.trim() || "",
    };
  }
  if (kind !== "deepgram" && kind !== "openai-compatible") {
    throw new ConfigurationError(`transcription profile ${id} has unsupported kind ${kind}`);
  }
  const deepgram = kind === "deepgram";
  return {
    id,
    kind,
    model: profileModel(
      definition,
      deepgram ? environment.HELIX_DEEPGRAM_MODEL?.trim() || "nova-3" : defaults.transcriptionModel,
      `transcription profile ${id}`,
    ),
    requestTimeoutMs: timeout,
    baseUrl: parseProviderBaseUrl(
      optionalString(definition, "baseUrl", deepgram ? environment.HELIX_DEEPGRAM_BASE_URL?.trim() || "https://api.deepgram.com" : defaults.baseUrl),
      `transcription profile ${id} baseUrl`,
    ),
    path: parseProviderPath(
      optionalString(definition, "path", deepgram ? "/v1/listen" : defaults.transcriptionPath),
      `transcription profile ${id} path`,
    ),
    apiKey: (deepgram ? environment.HELIX_DEEPGRAM_API_KEY : defaults.apiKey)?.trim() || "",
    authHeader: deepgram ? "Authorization" : defaults.authHeader,
    authScheme: deepgram ? "Token" : defaults.authScheme,
    extraHeaders: deepgram ? {} : defaults.extraHeaders,
  };
}

function buildAnswerProfile(
  id: string,
  definition: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
  defaults: ProviderConfig,
): AnswerProfileConfig {
  assertProfileFields(definition, ["kind", "model", "baseUrl", "path"], `answer profile ${id}`);
  const kind = optionalString(definition, "kind", "openai-compatible") as AnswerProviderKind;
  if (kind === "mock") {
    return { id, kind, model: profileModel(definition, "mock", `answer profile ${id}`), requestTimeoutMs: defaults.requestTimeoutMs };
  }
  if (kind !== "openai-responses" && kind !== "openai-compatible") {
    throw new ConfigurationError(`answer profile ${id} has unsupported kind ${kind}`);
  }
  const responses = kind === "openai-responses";
  return {
    id,
    kind,
    model: profileModel(
      definition,
      responses ? environment.HELIX_OPENAI_RESPONSE_MODEL?.trim() || "gpt-4.1-mini" : defaults.chatModel,
      `answer profile ${id}`,
    ),
    requestTimeoutMs: defaults.requestTimeoutMs,
    baseUrl: parseProviderBaseUrl(
      optionalString(definition, "baseUrl", responses ? environment.HELIX_OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1" : defaults.baseUrl),
      `answer profile ${id} baseUrl`,
    ),
    path: parseProviderPath(
      optionalString(definition, "path", responses ? "/responses" : defaults.chatPath),
      `answer profile ${id} path`,
    ),
    apiKey: defaults.apiKey?.trim() || "",
    authHeader: responses ? "Authorization" : defaults.authHeader,
    authScheme: responses ? "Bearer" : defaults.authScheme,
    extraHeaders: responses ? {} : defaults.extraHeaders,
  };
}

export function loadGatewayConfig(environment: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const rawMode = environment.HELIX_MODE ?? "mock";
  if (rawMode !== "mock" && rawMode !== "openai-compatible") {
    throw new ConfigurationError("HELIX_MODE must be mock or openai-compatible");
  }
  const openaiKey = environment.HELIX_OPENAI_API_KEY?.trim() || environment.HELIX_API_KEY?.trim();
  const systemPrompt = environment.HELIX_SYSTEM_PROMPT?.trim()
    ?? "Answer the user's question directly and concisely. State uncertainty rather than inventing facts.";
  if (systemPrompt.length === 0) throw new ConfigurationError("HELIX_SYSTEM_PROMPT cannot be empty");

  const gatewayToken = environment.HELIX_GATEWAY_TOKEN?.trim();
  const providerId = parseProfileId(environment.HELIX_PROVIDER_ID?.trim() || "openai-compatible", "HELIX_PROVIDER_ID");
  if (providerId !== "openai-compatible" && RESERVED_BUILTIN_PROFILE_IDS.has(providerId)) {
    throw new ConfigurationError(`HELIX_PROVIDER_ID cannot redefine reserved built-in profile ${providerId}`);
  }
  const requestTimeoutMs = parseInteger(environment.HELIX_REQUEST_TIMEOUT_MS, 120_000, "HELIX_REQUEST_TIMEOUT_MS", [100, 600_000]);
  const legacyProvider: ProviderConfig = {
    id: providerId,
    baseUrl: parseProviderBaseUrl(environment.HELIX_PROVIDER_BASE_URL?.trim() || "https://api.openai.com/v1", "HELIX_PROVIDER_BASE_URL"),
    transcriptionPath: parseProviderPath(environment.HELIX_TRANSCRIPTION_PATH?.trim() || "/audio/transcriptions", "HELIX_TRANSCRIPTION_PATH"),
    chatPath: parseProviderPath(environment.HELIX_CHAT_PATH?.trim() || "/chat/completions", "HELIX_CHAT_PATH"),
    ...(openaiKey === undefined ? {} : { apiKey: openaiKey }),
    authHeader: environment.HELIX_AUTH_HEADER?.trim() || "Authorization",
    authScheme: environment.HELIX_AUTH_SCHEME?.trim() ?? "Bearer",
    transcriptionModel: environment.HELIX_TRANSCRIPTION_MODEL?.trim() || "gpt-4o-mini-transcribe",
    chatModel: environment.HELIX_CHAT_MODEL?.trim() || "gpt-4o-mini",
    extraHeaders: parseHeaders(environment.HELIX_PROVIDER_HEADERS_JSON),
    requestTimeoutMs,
  };

  const transcriptionProfiles: Record<string, TranscriptionProfileConfig> = {
    mock: { id: "mock", kind: "mock", model: "mock", requestTimeoutMs },
  };
  const answerProfiles: Record<string, AnswerProfileConfig> = {
    mock: { id: "mock", kind: "mock", model: "mock", requestTimeoutMs },
  };
  // Built-in metadata is available without an environment key so an
  // allowlisted session can bind a transient BYOK key. Empty profile keys are
  // never sent upstream; provider resolution requires BYOK or env fallback.
  transcriptionProfiles["openai-compatible"] = buildTranscriptionProfile(
    "openai-compatible",
    { kind: "openai-compatible" },
    environment,
    legacyProvider,
  );
  if (providerId !== "openai-compatible") {
    transcriptionProfiles[providerId] = buildTranscriptionProfile(
      providerId,
      { kind: "openai-compatible" },
      environment,
      legacyProvider,
    );
  }
  transcriptionProfiles["openai-transcription"] = buildTranscriptionProfile("openai-transcription", {
    kind: "openai-compatible",
    baseUrl: environment.HELIX_OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
    path: "/audio/transcriptions",
    model: environment.HELIX_OPENAI_TRANSCRIPTION_MODEL?.trim() || legacyProvider.transcriptionModel,
  }, environment, legacyProvider);
  answerProfiles["openai-compatible"] = buildAnswerProfile(
    "openai-compatible",
    { kind: "openai-compatible" },
    environment,
    legacyProvider,
  );
  if (providerId !== "openai-compatible") {
    answerProfiles[providerId] = buildAnswerProfile(
      providerId,
      { kind: "openai-compatible" },
      environment,
      legacyProvider,
    );
  }
  answerProfiles["openai-responses"] = buildAnswerProfile(
    "openai-responses",
    { kind: "openai-responses" },
    environment,
    legacyProvider,
  );
  transcriptionProfiles.deepgram = buildTranscriptionProfile("deepgram", { kind: "deepgram" }, environment, legacyProvider);
  transcriptionProfiles.soniox = buildTranscriptionProfile("soniox", { kind: "soniox" }, environment, legacyProvider);
  for (const [id, definition] of Object.entries(profileDefinitions(environment.HELIX_TRANSCRIPTION_PROFILES_JSON, "HELIX_TRANSCRIPTION_PROFILES_JSON"))) {
    if (RESERVED_BUILTIN_PROFILE_IDS.has(id)) {
      throw new ConfigurationError(`HELIX_TRANSCRIPTION_PROFILES_JSON cannot redefine reserved built-in profile ${id}`);
    }
    transcriptionProfiles[id] = buildTranscriptionProfile(id, definition, environment, legacyProvider);
  }
  for (const [id, definition] of Object.entries(profileDefinitions(environment.HELIX_ANSWER_PROFILES_JSON, "HELIX_ANSWER_PROFILES_JSON"))) {
    if (RESERVED_BUILTIN_PROFILE_IDS.has(id)) {
      throw new ConfigurationError(`HELIX_ANSWER_PROFILES_JSON cannot redefine reserved built-in profile ${id}`);
    }
    answerProfiles[id] = buildAnswerProfile(id, definition, environment, legacyProvider);
  }

  const defaultTranscriptionProfile = parseProfileId(
    environment.HELIX_TRANSCRIPTION_PROVIDER?.trim() || (rawMode === "mock" ? "mock" : providerId),
    "HELIX_TRANSCRIPTION_PROVIDER",
  );
  const defaultAnswerProfile = parseProfileId(
    environment.HELIX_ANSWER_PROVIDER?.trim() || (rawMode === "mock" ? "mock" : providerId),
    "HELIX_ANSWER_PROVIDER",
  );
  if (!(defaultTranscriptionProfile in transcriptionProfiles)) {
    throw new ConfigurationError(`Default transcription profile ${defaultTranscriptionProfile} is not configured`);
  }
  if (!(defaultAnswerProfile in answerProfiles)) {
    throw new ConfigurationError(`Default answer profile ${defaultAnswerProfile} is not configured`);
  }
  const allowedTranscriptionProfiles = parseAllowlist(
    environment.HELIX_ALLOWED_TRANSCRIPTION_PROFILES,
    transcriptionProfiles,
    "HELIX_ALLOWED_TRANSCRIPTION_PROFILES",
  );
  const allowedAnswerProfiles = parseAllowlist(environment.HELIX_ALLOWED_ANSWER_PROFILES, answerProfiles, "HELIX_ALLOWED_ANSWER_PROFILES");
  if (!allowedTranscriptionProfiles.includes(defaultTranscriptionProfile)) {
    throw new ConfigurationError("Default transcription profile must be allowlisted");
  }
  if (!allowedAnswerProfiles.includes(defaultAnswerProfile)) {
    throw new ConfigurationError("Default answer profile must be allowlisted");
  }

  const omiKey = environment.HELIX_OMI_API_KEY?.trim();
  const omiCategory = environment.HELIX_OMI_MEMORY_CATEGORY?.trim();
  if (
    omiCategory !== undefined
    && omiCategory !== ""
    && omiCategory !== "interesting"
    && omiCategory !== "system"
    && omiCategory !== "manual"
  ) {
    throw new ConfigurationError("HELIX_OMI_MEMORY_CATEGORY must be interesting, system, or manual");
  }
  const omiWriteEnabled = parseBoolean(environment.HELIX_OMI_WRITE_ENABLED, false, "HELIX_OMI_WRITE_ENABLED");

  return {
    mode: rawMode,
    host: environment.HELIX_HOST ?? "127.0.0.1",
    port: parseInteger(environment.HELIX_PORT, 8787, "HELIX_PORT", [0, 65_535]),
    maxAudioBytes: parseInteger(environment.HELIX_MAX_AUDIO_BYTES, 8 * 1024 * 1024, "HELIX_MAX_AUDIO_BYTES", [2, 128 * 1024 * 1024]),
    mockTranscript: environment.HELIX_MOCK_TRANSCRIPT?.trim() || "What are the three most important next steps?",
    ...(gatewayToken === undefined || gatewayToken === "" ? {} : { gatewayToken }),
    provider: legacyProvider,
    transcriptionProfiles,
    answerProfiles,
    allowedTranscriptionProfiles,
    allowedAnswerProfiles,
    defaultTranscriptionProfile,
    defaultAnswerProfile,
    omi: {
      ...(omiKey === undefined ? {} : { apiKey: omiKey }),
      baseUrl: parseProviderBaseUrl(environment.HELIX_OMI_BASE_URL?.trim() || "https://api.omi.me", "HELIX_OMI_BASE_URL"),
      memoriesPath: parseProviderPath(environment.HELIX_OMI_MEMORIES_PATH?.trim() || "/v1/dev/user/memories", "HELIX_OMI_MEMORIES_PATH"),
      ...(omiCategory === undefined || omiCategory === "" ? {} : { category: omiCategory }),
      maxRecentMemories: parseInteger(environment.HELIX_OMI_MAX_RECENT, 25, "HELIX_OMI_MAX_RECENT", [1, 25]),
      maxContextMemories: parseInteger(environment.HELIX_OMI_MAX_CONTEXT_MEMORIES, 5, "HELIX_OMI_MAX_CONTEXT_MEMORIES", [1, 10]),
      maxContextCharacters: parseInteger(environment.HELIX_OMI_MAX_CONTEXT_CHARACTERS, 1_500, "HELIX_OMI_MAX_CONTEXT_CHARACTERS", [100, 4_000]),
      requestTimeoutMs: parseInteger(environment.HELIX_OMI_TIMEOUT_MS, 750, "HELIX_OMI_TIMEOUT_MS", [25, 10_000]),
      answerWaitMs: parseInteger(environment.HELIX_OMI_ANSWER_WAIT_MS, 50, "HELIX_OMI_ANSWER_WAIT_MS", [0, 1_000]),
      writeEnabled: omiWriteEnabled,
    },
    prompt: {
      id: environment.HELIX_PROMPT_ID?.trim() || "helix-conversation",
      version: environment.HELIX_PROMPT_VERSION?.trim() || "1",
      systemPrompt,
      allowClientPrompt: parseBoolean(environment.HELIX_ALLOW_CLIENT_PROMPT, false, "HELIX_ALLOW_CLIENT_PROMPT"),
    },
  };
}

export function profileSelection(profile: ProfileBase): ProviderProfileSelection {
  return { profileId: profile.id, model: profile.model };
}

export function publicProviderDescriptor(config: GatewayConfig, answerProfileId = config.defaultAnswerProfile): EndpointConfig {
  const profile = config.answerProfiles[answerProfileId];
  if (profile === undefined) throw new ConfigurationError(`Answer profile ${answerProfileId} is not configured`);
  return {
    id: profile.id,
    url: `urn:helix:provider:${encodeURIComponent(profile.id)}`,
    provider: profile.kind,
    model: profile.model,
  };
}
