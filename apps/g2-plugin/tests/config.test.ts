import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ANSWER_MODEL, DEFAULT_COPILOT_SETTINGS } from "@helix/conversation-sdk";
import {
  CONFIG_STORAGE_KEY,
  DEFAULT_CONFIG,
  DEFAULT_TRANSCRIPTION_PROVIDER,
  copilotSettingsFromConfig,
  PROVIDER_CREDENTIAL_STORAGE_KEY,
  clearPersistedProviderCredentials,
  loadPersistedConfig,
  loadPersistedProviderCredentials,
  persistProviderCredentials,
  providerCredentialsFromForm,
  providerCredentialsForSession,
  savePersistedConfig,
  serializePersistedConfig,
  validateGatewayUrl,
  validateProviderCredentialTransport,
  type SessionFormState,
} from "../src/config";

const form: SessionFormState = {
  autoExplainTerms: true,
  useLocalMemory: true,
  liveWebFactCheck: false,
  gatewayUrl: "wss://gateway.example.com/v2/conversations",
  accessToken: "short-lived-secret-token",
  openaiApiKey: "",
  deepgramApiKey: "",
  sonioxApiKey: "",
  omiApiKey: "",
  saveApiKeysOnPhone: false,
  endpointId: "my-endpoint",
  provider: "self-hosted",
  model: "fast-model",
  promptId: "direct",
  promptVersion: "4",
  instructions: "Answer directly.",
  locale: "en",
  maxResponseSentences: 3,
  conversationMode: "office-discussion",
  responseStrategy: "both",
  transcriptionProvider: "deepgram",
  answerProvider: "openai-responses",
  autoQuestion: true,
  autoAnswer: true,
  autoNotes: true,
  readOmiContext: true,
  syncOmiNotes: true,
  copilotModel: "gpt-6-luna",
  copilotSummarize: true,
  copilotConcepts: true,
  copilotConflicts: false,
  copilotSuggestions: true,
  copilotImplicitAsks: true,
  copilotWebGrounding: false,
};

describe("plugin config safety", () => {
  it("migrates gateway and mock defaults to the phone-only default transcription profile without an address", async () => {
    const store = { getLocalStorage: async () => JSON.stringify({ gatewayUrl: form.gatewayUrl, transcriptionProvider: "mock", answerProvider: "gateway-default" }), setLocalStorage: async () => true };
    await expect(loadPersistedConfig(store)).resolves.toMatchObject({ gatewayUrl: "", transcriptionProvider: DEFAULT_TRANSCRIPTION_PROVIDER, answerProvider: "openai-responses" });
    expect(providerCredentialsForSession({ ...form, transcriptionProvider: "openai-whisper", answerProvider: "mock", openaiApiKey: "whisper-runtime", readOmiContext: false, syncOmiNotes: false })).toEqual({ openai: "whisper-runtime" });
  });
  it("never serializes the short-lived access token", () => {
    const serialized = serializePersistedConfig(form);

    expect(serialized).not.toContain(form.accessToken);
    expect(serialized).not.toContain("accessToken");
    expect(JSON.parse(serialized)).toMatchObject({
      gatewayUrl: form.gatewayUrl,
      instructions: form.instructions,
      conversationMode: "general", // v0.10: "office-discussion" is the old name of Meeting
      responseStrategy: "both",
      transcriptionProvider: "deepgram",
      answerProvider: "openai-responses",
      autoNotes: true,
      readOmiContext: false,
      syncOmiNotes: false,
      useLocalMemory: true,
      liveWebFactCheck: false,
    });
  });

  it("persists only non-secret configuration through the Even bridge", async () => {
    const setLocalStorage = vi.fn(async (_key: string, _value: string) => true);
    const store = {
      getLocalStorage: vi.fn(async () => ""),
      setLocalStorage,
    };

    await expect(savePersistedConfig(store, form)).resolves.toBe(true);
    expect(setLocalStorage).toHaveBeenCalledOnce();
    const [key, value] = setLocalStorage.mock.calls[0] ?? [];
    expect(key).toBe(CONFIG_STORAGE_KEY);
    expect(value).not.toContain(form.accessToken);
  });

  it("ignores secret-shaped fields found in old or hostile storage", async () => {
    const store = {
      getLocalStorage: vi.fn(async () => JSON.stringify({
        ...form,
        accessToken: "persisted-by-old-build",
        apiKey: "provider-key",
        transcriptionApiKey: "transcription-key",
        answerApiKey: "answer-key",
      })),
      setLocalStorage: vi.fn(async () => true),
    };

    const loaded = await loadPersistedConfig(store);
    expect(loaded).not.toHaveProperty("accessToken");
    expect(loaded).not.toHaveProperty("apiKey");
    expect(loaded).not.toHaveProperty("transcriptionApiKey");
    expect(loaded).not.toHaveProperty("answerApiKey");
  });

  it("falls back from unsupported profile IDs and modes", async () => {
    const store = {
      getLocalStorage: vi.fn(async () => JSON.stringify({
        conversationMode: "secret-mode",
        responseStrategy: "always-on",
        transcriptionProvider: "https://provider.example/?key=secret",
        answerProvider: "custom-key-value",
        readOmiContext: "yes",
        syncOmiNotes: 1,
      })),
      setLocalStorage: vi.fn(async () => true),
    };

    await expect(loadPersistedConfig(store)).resolves.toMatchObject({
      conversationMode: "general",
      responseStrategy: "reactive",
      transcriptionProvider: DEFAULT_TRANSCRIPTION_PROVIDER,
      answerProvider: "openai-responses",
      readOmiContext: false,
      syncOmiNotes: false,
    });
  });

  it("requires proactive behavior to be selected explicitly in old configuration", async () => {
    const store = {
      getLocalStorage: vi.fn(async () => JSON.stringify({
        gatewayUrl: form.gatewayUrl,
        conversationMode: "general",
      })),
      setLocalStorage: vi.fn(async () => true),
    };

    await expect(loadPersistedConfig(store)).resolves.toMatchObject({
      responseStrategy: "reactive",
    });
  });

  it("rejects credential-shaped content in every persisted text field", () => {
    const secret = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz012345"].join("-");
    for (const field of [
      "gatewayUrl",
      "endpointId",
      "provider",
      "model",
      "promptId",
      "promptVersion",
      "instructions",
      "locale",
      "copilotModel",
    ] as const) {
      expect(() => serializePersistedConfig({ ...form, [field]: secret }), field)
        .toThrow(`${field} looks like a credential`);
    }
  });

  it("drops old persisted configuration when a safe field contains a credential", async () => {
    const store = {
      getLocalStorage: vi.fn(async () => JSON.stringify({
        ...form,
        instructions: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
      })),
      setLocalStorage: vi.fn(async () => true),
    };

    await expect(loadPersistedConfig(store)).resolves.toEqual(
      expect.objectContaining({
        instructions: expect.not.stringContaining("abcdefghijklmnopqrstuvwxyz012345"),
        responseStrategy: "reactive",
      }),
    );
  });

  it("requires encrypted WebSockets away from local development hosts", () => {
    expect(() => validateGatewayUrl("ws://gateway.example.com/v2/conversations"))
      .toThrow("must use encrypted wss://");
    expect(validateGatewayUrl("ws://127.0.0.1:8787/v2/conversations").protocol).toBe("ws:");
    expect(validateGatewayUrl("wss://gateway.example.com/v2/conversations").protocol).toBe("wss:");
  });

  it("rejects query strings and fragments so tokens cannot leak through the URL", () => {
    expect(() => validateGatewayUrl("wss://gateway.example.com/v2/conversations?token=secret"))
      .toThrow("must not contain query parameters");
    expect(() => validateGatewayUrl("wss://gateway.example.com/v2/conversations#secret"))
      .toThrow("must not contain query parameters");
  });

  it("stores provider keys only in a dedicated versioned opt-in record", async () => {
    const values = new Map<string, string>();
    const store = {
      getLocalStorage: vi.fn(async (key: string) => values.get(key) ?? ""),
      setLocalStorage: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
        return true;
      }),
    };
    const credentials = providerCredentialsFromForm({
      ...form,
      openaiApiKey: " openai-local ",
      deepgramApiKey: "deepgram-local",
      sonioxApiKey: "soniox-local",
      omiApiKey: "omi-local",
      saveApiKeysOnPhone: true,
    });
    await expect(persistProviderCredentials(store, credentials, true)).resolves.toMatchObject({ ok: true });
    expect(values.get(CONFIG_STORAGE_KEY)).toBeUndefined();
    expect(values.get(PROVIDER_CREDENTIAL_STORAGE_KEY)).not.toContain(form.accessToken);
    await expect(loadPersistedProviderCredentials(store)).resolves.toEqual({
      credentials: {
        openai: "openai-local",
        deepgram: "deepgram-local",
        soniox: "soniox-local",
        omi: "omi-local",
      },
      saveApiKeysOnPhone: true,
    });
  });

  it("clears previous local keys when saving is off or the clear action is used", async () => {
    const setLocalStorage = vi.fn(async (_key: string, _value: string) => true);
    const store = { getLocalStorage: vi.fn(async () => ""), setLocalStorage };

    await persistProviderCredentials(store, { openai: "runtime-only" }, false);
    await clearPersistedProviderCredentials(store);
    expect(setLocalStorage).toHaveBeenNthCalledWith(1, PROVIDER_CREDENTIAL_STORAGE_KEY, "");
    expect(setLocalStorage).toHaveBeenNthCalledWith(2, PROVIDER_CREDENTIAL_STORAGE_KEY, "");
  });

  it("ignores malformed, oversized, wrong-version, and hostile credential storage", async () => {
    const invalidValues = [
      "{",
      "x".repeat(40_001),
      JSON.stringify({ version: 2, optIn: true, credentials: { openai: "old" } }),
      JSON.stringify({ version: 1, optIn: false, credentials: { openai: "not-opted-in" } }),
      JSON.stringify({ version: 1, optIn: true, credentials: { unknown: "hostile" } }),
    ];
    for (const value of invalidValues) {
      const store = {
        getLocalStorage: vi.fn(async () => value),
        setLocalStorage: vi.fn(async () => true),
      };
      await expect(loadPersistedProviderCredentials(store)).resolves.toEqual({
        credentials: {},
        saveApiKeysOnPhone: false,
      });
    }
  });

  it("keeps the app usable and reports non-secret storage failures", async () => {
    const readFailure = await loadPersistedProviderCredentials({
      getLocalStorage: vi.fn(async () => { throw new Error("sensitive storage detail"); }),
      setLocalStorage: vi.fn(async () => true),
    });
    expect(readFailure.credentials).toEqual({});
    expect(readFailure.warning).not.toContain("sensitive storage detail");

    const writeFailure = await persistProviderCredentials({
      getLocalStorage: vi.fn(async () => ""),
      setLocalStorage: vi.fn(async () => false),
    }, { openai: "must-not-echo" }, true);
    expect(writeFailure).toMatchObject({ ok: false });
    expect(writeFailure.message).not.toContain("must-not-echo");
  });

  it("requires WSS for every credential-bearing start while preserving key-free local WS", () => {
    const local = validateGatewayUrl("ws://127.0.0.1:8787/v2/conversations");
    expect(() => validateProviderCredentialTransport(local, { openai: "runtime" }))
      .toThrow("require an encrypted wss://");
    expect(() => validateProviderCredentialTransport(local, undefined)).not.toThrow();
    expect(() => validateProviderCredentialTransport(
      validateGatewayUrl("wss://gateway.example.com/v2/conversations"),
      { soniox: "runtime" },
    )).not.toThrow();
  });

  it("transmits only keys consumed by explicit provider and Omi selections", () => {
    expect(providerCredentialsForSession({
      ...form,
      transcriptionProvider: "deepgram",
      answerProvider: "mock",
      readOmiContext: false,
      syncOmiNotes: false,
      openaiApiKey: "unused-openai",
      deepgramApiKey: "used-deepgram",
      sonioxApiKey: "unused-soniox",
      omiApiKey: "unused-omi",
    })).toEqual({ deepgram: "used-deepgram" });
  });

  it("defaults to the current answer/copilot models and realtime transcription", async () => {
    expect(DEFAULT_CONFIG.model).toBe(DEFAULT_ANSWER_MODEL);
    expect(DEFAULT_CONFIG.transcriptionProvider).toBe("openai-realtime");
    expect(copilotSettingsFromConfig(DEFAULT_CONFIG)).toEqual({ ...DEFAULT_COPILOT_SETTINGS, mode: "general" });
    await expect(loadPersistedConfig({ getLocalStorage: async () => "", setLocalStorage: async () => true })).resolves.toMatchObject({ model: DEFAULT_ANSWER_MODEL, copilotModel: "gpt-6-luna" });
  });

  it("loads old v1 records with their saved model and transcription choice and new copilot defaults", async () => {
    const old = { model: "gpt-4.1-mini", transcriptionProvider: "openai-whisper", answerProvider: "openai-compatible", autoExplainTerms: false };
    const loaded = await loadPersistedConfig({ getLocalStorage: async () => JSON.stringify(old), setLocalStorage: async () => true });
    expect(loaded).toMatchObject({ model: "gpt-4.1-mini", transcriptionProvider: "openai-whisper", answerProvider: "openai-compatible", autoExplainTerms: false,
      copilotModel: DEFAULT_COPILOT_SETTINGS.copilotModel, copilotSummarize: true, copilotWebGrounding: true });
  });

  it("round-trips custom model ids, new transcription profiles and copilot toggles", async () => {
    const values = new Map<string, string>();
    const store = { getLocalStorage: async (key: string) => values.get(key) ?? "", setLocalStorage: async (key: string, value: string) => { values.set(key, value); return true; } };
    await savePersistedConfig(store, { ...form, model: "gpt-6.2-nova-preview", transcriptionProvider: "openai-transcribe", copilotModel: "gpt-6.1-terra" });
    await expect(loadPersistedConfig(store)).resolves.toMatchObject({ model: "gpt-6.2-nova-preview", transcriptionProvider: "openai-transcribe", copilotModel: "gpt-6.1-terra", copilotConflicts: false, copilotWebGrounding: false });
  });

  it("sends the OpenAI key for realtime and gpt-transcribe profiles", () => {
    for (const transcriptionProvider of ["openai-realtime", "openai-transcribe"] as const) {
      expect(providerCredentialsForSession({ ...form, transcriptionProvider, answerProvider: "mock", openaiApiKey: "k-openai", deepgramApiKey: "unused" })).toEqual({ openai: "k-openai" });
    }
  });
});
