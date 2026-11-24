import {
  CONVERSATION_MODES as SDK_CONVERSATION_MODES,
  DEFAULT_ANSWER_MODEL,
  DEFAULT_COPILOT_SETTINGS,
  DEFAULT_ANSWER_LENGTH,
  answerProviderInfo,
  cleanAnswerLength,
  modeProfile,
  normalizeSessionStartCredentials,
  type AnswerLength,
  type CopilotSettings,
  type SessionStartCredentials,
} from "@helix/conversation-sdk";

export const CONFIG_STORAGE_KEY = "helix.g2.plugin.config.v1";
export const PROVIDER_CREDENTIAL_STORAGE_KEY = "helix.g2.plugin.provider-credentials.v1";

/** Every protocol mode is loadable; the picker offers PICKER_MODES (v0.10). */
export const CONVERSATION_MODES = SDK_CONVERSATION_MODES;
export type ConversationMode = typeof CONVERSATION_MODES[number];

export const RESPONSE_STRATEGIES = ["reactive", "proactive", "both"] as const;
export type ResponseStrategy = typeof RESPONSE_STRATEGIES[number];

export const TRANSCRIPTION_PROVIDERS = [
  "gateway-default",
  "mock",
  "openai-realtime",
  "openai-transcribe",
  "openai-compatible",
  "openai-whisper",
  "deepgram",
  "soniox",
] as const;
export type TranscriptionProviderProfile = typeof TRANSCRIPTION_PROVIDERS[number];
/** Transcription profiles that use the OpenAI key. */
export const OPENAI_TRANSCRIPTION_PROFILES: readonly TranscriptionProviderProfile[] = [
  "openai-realtime", "openai-transcribe", "openai-compatible", "openai-whisper",
];
export const DEFAULT_TRANSCRIPTION_PROVIDER: TranscriptionProviderProfile = "openai-realtime";

export const ANSWER_PROVIDERS = [
  "gateway-default",
  "mock",
  "openai-responses",
  "openai-compatible",
  // Direct Chat Completions providers (SDK provider-registry.ts): own key field, fixed base URL.
  "deepseek",
  "qwen",
  "qwen-intl",
  "zhipu",
  "zai",
  "moonshot",
] as const;
export type AnswerProviderProfile = typeof ANSWER_PROVIDERS[number];

export interface PluginConfig {
  readonly gatewayUrl: string;
  readonly endpointId: string;
  readonly provider: string;
  readonly model: string;
  readonly promptId: string;
  readonly promptVersion: string;
  readonly instructions: string;
  readonly locale: string;
  readonly maxResponseSentences: number;
  readonly conversationMode: ConversationMode;
  readonly responseStrategy: ResponseStrategy;
  readonly transcriptionProvider: TranscriptionProviderProfile;
  readonly answerProvider: AnswerProviderProfile;
  readonly autoQuestion: boolean;
  readonly autoAnswer: boolean;
  readonly autoNotes: boolean;
  readonly readOmiContext: boolean;
  readonly syncOmiNotes: boolean;
  readonly useLocalMemory: boolean;
  readonly liveWebFactCheck: boolean;
  readonly autoExplainTerms: boolean;
  /** v0.7 background copilot lane. Flat fields keep old v1 records loadable. */
  readonly copilotModel: string;
  readonly copilotSummarize: boolean;
  readonly copilotConcepts: boolean;
  readonly copilotConflicts: boolean;
  readonly copilotSuggestions: boolean;
  readonly copilotImplicitAsks: boolean;
  readonly copilotWebGrounding: boolean;
  /** v0.8: checkable claims (Checks tab + glasses Verify) and People. Optional so older literals stay valid; absent = on. */
  readonly copilotClaims?: boolean;
  readonly copilotPeople?: boolean;
  /** v0.11: the user's edited system prompt per mode (absent = the built-in prompt). */
  readonly modePrompts?: Readonly<Record<string, string>>;
  /** Answer length: brief | standard | detailed. Optional so older literals stay valid; absent = standard. */
  readonly answerLength?: AnswerLength;
  /** Fact checks prefer the latest news and show dated sources. Absent = on. */
  readonly newsSearch?: boolean;
}

export interface SessionFormState extends PluginConfig {
  readonly accessToken: string;
  readonly openaiApiKey: string;
  readonly deepgramApiKey: string;
  readonly sonioxApiKey: string;
  readonly omiApiKey: string;
  readonly saveApiKeysOnPhone: boolean;
  /** Keys of the direct Chat Completions providers. Optional so older form literals stay valid. */
  readonly deepseekApiKey?: string;
  /** Alibaba Cloud Model Studio (DashScope) key for Qwen; region-bound. */
  readonly dashscopeApiKey?: string;
  readonly zhipuApiKey?: string;
  readonly moonshotApiKey?: string;
}

export interface ProviderCredentialLoadResult {
  readonly credentials: SessionStartCredentials;
  readonly saveApiKeysOnPhone: boolean;
  readonly warning?: string;
}

export interface ProviderCredentialPersistenceResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface LocalConfigStore {
  getLocalStorage(key: string): Promise<string>;
  setLocalStorage(key: string, value: string): Promise<boolean>;
}

export const DEFAULT_CONFIG: PluginConfig = Object.freeze({
  gatewayUrl: "", // Legacy field retained only for old config compatibility; never used.
  endpointId: "openai-direct",
  provider: "openai",
  model: DEFAULT_ANSWER_MODEL,
  promptId: "helix-direct",
  promptVersion: "1",
  instructions:
    "Answer the detected question directly and concisely. Preserve uncertainty and prefer useful next actions.",
  locale: "en",
  maxResponseSentences: 3,
  conversationMode: "general",
  responseStrategy: "reactive",
  transcriptionProvider: DEFAULT_TRANSCRIPTION_PROVIDER,
  answerProvider: "openai-responses",
  autoQuestion: true,
  autoAnswer: true,
  autoNotes: true,
  readOmiContext: false,
  syncOmiNotes: false,
  useLocalMemory: true,
  liveWebFactCheck: false,
  autoExplainTerms: true,
  copilotModel: DEFAULT_COPILOT_SETTINGS.copilotModel,
  copilotSummarize: DEFAULT_COPILOT_SETTINGS.summarize,
  copilotConcepts: DEFAULT_COPILOT_SETTINGS.concepts,
  copilotConflicts: DEFAULT_COPILOT_SETTINGS.conflicts,
  copilotSuggestions: DEFAULT_COPILOT_SETTINGS.suggestions,
  copilotImplicitAsks: DEFAULT_COPILOT_SETTINGS.implicitAsks,
  copilotWebGrounding: DEFAULT_COPILOT_SETTINGS.webGrounding,
  copilotClaims: true,
  copilotPeople: true,
  answerLength: DEFAULT_ANSWER_LENGTH,
  newsSearch: true,
});

/** Contract shape consumed by the SDK copilot lane. */
/**
 * v0.16 speech language. `PluginConfig.locale` is the speech language: a tag such as "en" or "zh-CN" pins
 * speech recognition to that language (the default, "en"), and SPEECH_LANGUAGE_AUTO ("auto") is the "mixed
 * languages" setting: recognition is not pinned and follows what is spoken. Answers and lines follow the
 * spoken language in both cases.
 */
export const SPEECH_LANGUAGE_AUTO = "auto";
/** True when the config (or a locale string) is set to mixed languages. */
export function isMixedSpeechLanguage(value: Pick<PluginConfig, "locale"> | string | undefined): boolean {
  const locale = typeof value === "string" ? value : value?.locale;
  return locale?.trim().toLowerCase() === SPEECH_LANGUAGE_AUTO;
}
/**
 * The `locale` to store for a "mixed languages" switch: on gives "auto"; off gives `pinned` (the language
 * the user typed), or the default language when that is blank or itself "auto".
 */
export function speechLocale(mixed: boolean, pinned?: string): string {
  if (mixed) return SPEECH_LANGUAGE_AUTO;
  const locale = pinned?.trim().slice(0, 32) ?? "";
  return locale && !isMixedSpeechLanguage(locale) ? locale : DEFAULT_CONFIG.locale;
}
/** Language tag for services that need one language (e.g. an export): undefined when mixed languages is on. */
export function pinnedSpeechLanguage(config: Pick<PluginConfig, "locale">): string | undefined {
  const locale = config.locale.trim();
  return locale && !isMixedSpeechLanguage(locale) ? locale : undefined;
}

/**
 * v0.10: a mode switch applies the mode's presets (copilot toggles, auto-answer, strategy) on top
 * of the current config; everything else (models, keys, memory, fact-check) is kept.
 */
export function applyModePreset<T extends PluginConfig>(config: T, mode: ConversationMode): T {
  const presets = modeProfile(mode).presets;
  return {
    ...config, conversationMode: mode, autoAnswer: presets.autoAnswer, responseStrategy: presets.responseStrategy,
    copilotSummarize: presets.summarize, copilotConcepts: presets.concepts, copilotConflicts: presets.conflicts,
    copilotSuggestions: presets.suggestions, copilotImplicitAsks: presets.implicitAsks, copilotWebGrounding: presets.webGrounding,
    copilotClaims: presets.claims, copilotPeople: presets.people,
  };
}

/** Keeps only known modes with a non-empty prompt (<= 4000 chars) that differs from the built-in one. */
export function cleanModePrompts(value: unknown): Record<string, string> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const result: Record<string, string> = {};
  for (const mode of CONVERSATION_MODES) {
    const text = (value as Record<string, unknown>)[mode];
    if (typeof text !== "string") continue;
    const clean = text.trim().slice(0, 4000);
    if (clean && clean !== modeProfile(mode).answer && !/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}/u.test(clean)) result[mode] = clean;
  }
  return Object.keys(result).length ? result : undefined;
}

export function copilotSettingsFromConfig(config: PluginConfig): CopilotSettings {
  return {
    mode: config.conversationMode,
    summarize: config.copilotSummarize,
    concepts: config.copilotConcepts,
    conflicts: config.copilotConflicts,
    suggestions: config.copilotSuggestions,
    implicitAsks: config.copilotImplicitAsks,
    webGrounding: config.copilotWebGrounding,
    copilotModel: config.copilotModel,
    // v0.8 lanes default on in the SDK; only an explicit opt-out is sent.
    ...(config.copilotClaims === false ? { claims: false } : {}),
    ...(config.copilotPeople === false ? { people: false } : {}),
    // Standard length and the default mode-independent prompts send nothing extra.
    ...(cleanAnswerLength(config.answerLength) === DEFAULT_ANSWER_LENGTH ? {} : { answerLength: cleanAnswerLength(config.answerLength) }),
    ...(config.newsSearch === false ? {} : { newsSearch: true }),
  };
}

const PERSISTED_STRING_FIELDS = [
  "gatewayUrl",
  "endpointId",
  "provider",
  "model",
  "promptId",
  "promptVersion",
  "instructions",
  "locale",
  "copilotModel",
] as const satisfies readonly (keyof PluginConfig)[];

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{16,}/iu,
  /\b(?:api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret|authorization)\s*[:=]\s*["']?\S{12,}/iu,
  /\b(?:sk|rk|pk)-(?:proj-)?[a-z0-9_-]{16,}\b/iu,
  /\b(?:akia|asia)[a-z0-9]{16}\b/iu,
  /\bAIza[a-z0-9_-]{20,}\b/iu,
  /\b(?:gh[opsu]_|github_pat_)[a-z0-9_]{20,}\b/iu,
  /\bxox[baprs]-[a-z0-9-]{16,}\b/iu,
  /\b[a-z0-9_-]{16,}\.[a-z0-9_-]{16,}\.[a-z0-9_-]{16,}\b/iu,
];

function assertPersistedStringValuesAreSafe(value: unknown): void {
  const candidate = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};

  for (const field of PERSISTED_STRING_FIELDS) {
    const fieldValue = candidate[field];
    if (
      typeof fieldValue === "string"
      && SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(fieldValue))
    ) {
      throw new Error(
        `${field} looks like a credential. Use the dedicated provider API-key fields.`,
      );
    }
  }
}

function cleanString(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : fallback;
}

function cleanBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function cleanSentenceLimit(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.min(10, Math.max(1, value))
    : DEFAULT_CONFIG.maxResponseSentences;
}

function cleanChoice<T extends string>(
  value: unknown,
  choices: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && choices.includes(value as T)
    ? value as T
    : fallback;
}

export function normalizePluginConfig(value: unknown): PluginConfig {
  const candidate = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};

  return {
    gatewayUrl: cleanString(candidate.gatewayUrl, DEFAULT_CONFIG.gatewayUrl, 2_048),
    endpointId: cleanString(candidate.endpointId, DEFAULT_CONFIG.endpointId, 100),
    provider: cleanString(candidate.provider, DEFAULT_CONFIG.provider, 100),
    model: cleanString(candidate.model, DEFAULT_CONFIG.model, 100),
    promptId: cleanString(candidate.promptId, DEFAULT_CONFIG.promptId, 100),
    promptVersion: cleanString(candidate.promptVersion, DEFAULT_CONFIG.promptVersion, 32),
    instructions: cleanString(candidate.instructions, DEFAULT_CONFIG.instructions, 8_000),
    // "Auto" / "AUTO" are the mixed-languages setting, stored in one spelling.
    locale: isMixedSpeechLanguage(typeof candidate.locale === "string" ? candidate.locale : undefined)
      ? SPEECH_LANGUAGE_AUTO : cleanString(candidate.locale, DEFAULT_CONFIG.locale, 32),
    maxResponseSentences: cleanSentenceLimit(candidate.maxResponseSentences),
    // "office-discussion" was the old name of Meeting (v0.10).
    conversationMode: cleanChoice(
      candidate.conversationMode === "office-discussion" ? "general" : candidate.conversationMode,
      CONVERSATION_MODES,
      DEFAULT_CONFIG.conversationMode,
    ),
    responseStrategy: cleanChoice(
      candidate.responseStrategy,
      RESPONSE_STRATEGIES,
      DEFAULT_CONFIG.responseStrategy,
    ),
    transcriptionProvider: cleanChoice(
      candidate.transcriptionProvider,
      TRANSCRIPTION_PROVIDERS,
      DEFAULT_CONFIG.transcriptionProvider,
    ),
    answerProvider: cleanChoice(
      candidate.answerProvider,
      ANSWER_PROVIDERS,
      DEFAULT_CONFIG.answerProvider,
    ),
    autoQuestion: cleanBoolean(candidate.autoQuestion, DEFAULT_CONFIG.autoQuestion),
    autoAnswer: cleanBoolean(candidate.autoAnswer, DEFAULT_CONFIG.autoAnswer),
    autoNotes: cleanBoolean(candidate.autoNotes, DEFAULT_CONFIG.autoNotes),
    readOmiContext: false,
    syncOmiNotes: false,
    useLocalMemory: cleanBoolean(candidate.useLocalMemory, DEFAULT_CONFIG.useLocalMemory),
    liveWebFactCheck: cleanBoolean(candidate.liveWebFactCheck, DEFAULT_CONFIG.liveWebFactCheck),
    autoExplainTerms: cleanBoolean(candidate.autoExplainTerms, DEFAULT_CONFIG.autoExplainTerms),
    copilotModel: cleanString(candidate.copilotModel, DEFAULT_CONFIG.copilotModel, 100),
    copilotSummarize: cleanBoolean(candidate.copilotSummarize, DEFAULT_CONFIG.copilotSummarize),
    copilotConcepts: cleanBoolean(candidate.copilotConcepts, DEFAULT_CONFIG.copilotConcepts),
    copilotConflicts: cleanBoolean(candidate.copilotConflicts, DEFAULT_CONFIG.copilotConflicts),
    copilotSuggestions: cleanBoolean(candidate.copilotSuggestions, DEFAULT_CONFIG.copilotSuggestions),
    copilotImplicitAsks: cleanBoolean(candidate.copilotImplicitAsks, DEFAULT_CONFIG.copilotImplicitAsks),
    copilotWebGrounding: cleanBoolean(candidate.copilotWebGrounding, DEFAULT_CONFIG.copilotWebGrounding),
    copilotClaims: cleanBoolean(candidate.copilotClaims, true),
    copilotPeople: cleanBoolean(candidate.copilotPeople, true),
    answerLength: cleanAnswerLength(candidate.answerLength),
    newsSearch: cleanBoolean(candidate.newsSearch, true),
    ...(cleanModePrompts(candidate.modePrompts) ? { modePrompts: cleanModePrompts(candidate.modePrompts)! } : {}),
  };
}

export function persistedConfigFromForm(form: SessionFormState): PluginConfig {
  assertPersistedStringValuesAreSafe(form);
  return normalizePluginConfig(form);
}

export function serializePersistedConfig(form: SessionFormState): string {
  return JSON.stringify(persistedConfigFromForm(form));
}

export async function loadPersistedConfig(store: LocalConfigStore): Promise<PluginConfig> {
  const raw = await store.getLocalStorage(CONFIG_STORAGE_KEY);
  if (!raw) return DEFAULT_CONFIG;

  try {
    const stored: unknown = JSON.parse(raw);
    assertPersistedStringValuesAreSafe(stored);
    const normalized = normalizePluginConfig(stored);
    return {
      ...normalized,
      gatewayUrl: "",
      // Gateway/mock profiles cannot run phone-only; real saved choices are kept as-is.
      transcriptionProvider: ["gateway-default", "mock"].includes(normalized.transcriptionProvider) ? DEFAULT_TRANSCRIPTION_PROVIDER : normalized.transcriptionProvider,
      answerProvider: ["gateway-default", "mock"].includes(normalized.answerProvider) ? "openai-responses" : normalized.answerProvider,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function savePersistedConfig(
  store: LocalConfigStore,
  form: SessionFormState,
): Promise<boolean> {
  return store.setLocalStorage(CONFIG_STORAGE_KEY, serializePersistedConfig(form));
}

export function providerCredentialsFromForm(form: SessionFormState): SessionStartCredentials | undefined {
  return normalizeSessionStartCredentials({
    openai: form.openaiApiKey,
    deepgram: form.deepgramApiKey,
    soniox: form.sonioxApiKey,
    omi: form.omiApiKey,
    ...(form.deepseekApiKey === undefined ? {} : { deepseek: form.deepseekApiKey }),
    ...(form.dashscopeApiKey === undefined ? {} : { dashscope: form.dashscopeApiKey }),
    ...(form.zhipuApiKey === undefined ? {} : { zhipu: form.zhipuApiKey }),
    ...(form.moonshotApiKey === undefined ? {} : { moonshot: form.moonshotApiKey }),
  });
}

/** Sends only credentials that the selected session can consume. */
export function providerCredentialsForSession(form: SessionFormState): SessionStartCredentials | undefined {
  const available = providerCredentialsFromForm(form);
  if (available === undefined) return undefined;
  const selected: Partial<Record<keyof SessionStartCredentials, string>> = {};
  if (form.transcriptionProvider === "gateway-default") {
    if (available.openai !== undefined) selected.openai = available.openai;
    if (available.deepgram !== undefined) selected.deepgram = available.deepgram;
    if (available.soniox !== undefined) selected.soniox = available.soniox;
  } else if (form.transcriptionProvider === "deepgram" && available.deepgram !== undefined) {
    selected.deepgram = available.deepgram;
  } else if (form.transcriptionProvider === "soniox" && available.soniox !== undefined) {
    selected.soniox = available.soniox;
  } else if (OPENAI_TRANSCRIPTION_PROFILES.includes(form.transcriptionProvider) && available.openai !== undefined) {
    selected.openai = available.openai;
  }
  if (
    form.answerProvider !== "mock"
    && available.openai !== undefined
  ) selected.openai = available.openai;
  // A direct provider's key joins the session only when that provider is selected for answers.
  const answer = answerProviderInfo(form.answerProvider);
  if (answer && answer.api !== "openai" && available[answer.credential] !== undefined) selected[answer.credential] = available[answer.credential]!;
  return normalizeSessionStartCredentials(selected);
}

export function hasProviderCredentials(credentials: SessionStartCredentials | undefined): boolean {
  return credentials !== undefined && Object.keys(credentials).length > 0;
}

export async function loadPersistedProviderCredentials(
  store: LocalConfigStore,
): Promise<ProviderCredentialLoadResult> {
  let raw: string;
  try {
    raw = await store.getLocalStorage(PROVIDER_CREDENTIAL_STORAGE_KEY);
  } catch {
    return {
      credentials: {},
      saveApiKeysOnPhone: false,
      warning: "Saved API keys could not be read. You can enter them again for this session.",
    };
  }
  if (!raw) return { credentials: {}, saveApiKeysOnPhone: false };
  if (raw.length > 40_000) return { credentials: {}, saveApiKeysOnPhone: false };

  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid record");
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).some((key) => !["version", "optIn", "credentials"].includes(key))
      || record.version !== 1
      || record.optIn !== true
    ) throw new Error("invalid record");
    const credentials = normalizeSessionStartCredentials(record.credentials) ?? {};
    return { credentials, saveApiKeysOnPhone: true };
  } catch {
    return { credentials: {}, saveApiKeysOnPhone: false };
  }
}

export async function persistProviderCredentials(
  store: LocalConfigStore,
  credentials: SessionStartCredentials | undefined,
  saveApiKeysOnPhone: boolean,
): Promise<ProviderCredentialPersistenceResult> {
  const value = saveApiKeysOnPhone
    ? JSON.stringify({ version: 1, optIn: true, credentials: credentials ?? {} })
    : "";
  try {
    const saved = await store.setLocalStorage(PROVIDER_CREDENTIAL_STORAGE_KEY, value);
    if (!saved) {
      return { ok: false, message: "API-key storage was not updated. The current session can continue in memory." };
    }
    return {
      ok: true,
      message: saveApiKeysOnPhone
        ? "API keys saved in Even App plugin local storage on this phone."
        : "Saved API keys cleared. Current values are memory-only.",
    };
  } catch {
    return { ok: false, message: "API-key storage could not be updated. The current session can continue in memory." };
  }
}

export async function clearPersistedProviderCredentials(
  store: LocalConfigStore,
): Promise<ProviderCredentialPersistenceResult> {
  return persistProviderCredentials(store, undefined, false);
}

function isLocalDevelopmentHost(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]"
    || /^10\./.test(hostname)
    || /^192\.168\./.test(hostname)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
}

export function validateGatewayUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Gateway URL must be a valid ws:// or wss:// URL");
  }

  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Gateway URL must use ws:// or wss://");
  }
  if (url.username || url.password) {
    throw new Error("Put the gateway token in the token field, not in the gateway URL");
  }
  if (url.search || url.hash) {
    throw new Error("Gateway URL must not contain query parameters or a fragment");
  }
  if (url.protocol === "ws:" && !isLocalDevelopmentHost(url.hostname)) {
    throw new Error("Non-local gateways must use encrypted wss://");
  }
  return url;
}

export function validateProviderCredentialTransport(
  gatewayUrl: URL,
  credentials: SessionStartCredentials | undefined,
): void {
  if (hasProviderCredentials(credentials) && gatewayUrl.protocol !== "wss:") {
    throw new Error("Provider API keys require an encrypted wss:// Helix server connection");
  }
}
