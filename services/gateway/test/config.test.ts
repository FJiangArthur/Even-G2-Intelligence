import { describe, expect, it } from "vitest";
import { ConfigurationError, loadGatewayConfig, publicProviderDescriptor } from "../src/config.js";
import { providerRequestUrl } from "../src/provider/openai-compatible.js";

describe("provider configuration security", () => {
  it("never exposes the upstream provider URL in client provenance", () => {
    const config = loadGatewayConfig({
      HELIX_MODE: "openai-compatible",
      HELIX_API_KEY: "server-only",
      HELIX_PROVIDER_ID: "private-cluster",
      HELIX_PROVIDER_BASE_URL: "https://internal.example.test/private/v1",
    });
    const publicDescriptor = publicProviderDescriptor(config);
    expect(publicDescriptor.url).toBe("urn:helix:provider:private-cluster");
    expect(JSON.stringify(publicDescriptor)).not.toContain("internal.example.test");
    expect(JSON.stringify(publicDescriptor)).not.toContain("server-only");
  });

  it.each([
    "https://user:password@example.test/v1",
    "https://example.test/v1?token=secret",
    "https://example.test/v1#private",
  ])("rejects unsafe base URL %s", (baseUrl) => {
    expect(() => loadGatewayConfig({
      HELIX_MODE: "openai-compatible",
      HELIX_API_KEY: "server-only",
      HELIX_PROVIDER_BASE_URL: baseUrl,
    })).toThrow(ConfigurationError);
  });

  it("joins provider paths beneath the configured base and rejects escape attempts", () => {
    expect(providerRequestUrl("https://example.test/private/v1", "/chat/completions"))
      .toBe("https://example.test/private/v1/chat/completions");
    expect(() => providerRequestUrl("https://example.test/private/v1", "/../outside"))
      .toThrow("escaped");
    expect(() => providerRequestUrl("https://example.test/private/v1", "//evil.test/path"))
      .toThrow("invalid");
  });

  it("builds named, independently selectable, allowlisted profiles", () => {
    const config = loadGatewayConfig({
      HELIX_MODE: "mock",
      HELIX_OPENAI_API_KEY: "openai-server-only",
      HELIX_DEEPGRAM_API_KEY: "deepgram-server-only",
      HELIX_TRANSCRIPTION_PROFILES_JSON: JSON.stringify({
        "meeting-stt": { kind: "deepgram", model: "nova-3" },
      }),
      HELIX_ANSWER_PROFILES_JSON: JSON.stringify({
        "fast-answer": { kind: "openai-responses", model: "gpt-4.1-mini" },
      }),
      HELIX_TRANSCRIPTION_PROVIDER: "meeting-stt",
      HELIX_ANSWER_PROVIDER: "fast-answer",
      HELIX_ALLOWED_TRANSCRIPTION_PROFILES: "mock,meeting-stt",
      HELIX_ALLOWED_ANSWER_PROFILES: "mock,fast-answer",
    });

    expect(config.defaultTranscriptionProfile).toBe("meeting-stt");
    expect(config.defaultAnswerProfile).toBe("fast-answer");
    expect(config.allowedTranscriptionProfiles).toEqual(["mock", "meeting-stt"]);
    expect(config.allowedAnswerProfiles).toEqual(["mock", "fast-answer"]);
    const descriptor = publicProviderDescriptor(config);
    expect(descriptor).toEqual({
      id: "fast-answer",
      url: "urn:helix:provider:fast-answer",
      provider: "openai-responses",
      model: "gpt-4.1-mini",
    });
    expect(JSON.stringify(descriptor)).not.toContain("server-only");
  });

  it.each([
    { HELIX_PROVIDER_BASE_URL: "http://provider.example/v1", HELIX_MODE: "openai-compatible", HELIX_API_KEY: "key" },
    { HELIX_OMI_BASE_URL: "http://omi.example", HELIX_OMI_API_KEY: "key" },
    { HELIX_SONIOX_WEBSOCKET_URL: "ws://soniox.example/transcribe", HELIX_SONIOX_API_KEY: "key" },
  ])("rejects provider credentials over public plaintext links", (environment) => {
    expect(() => loadGatewayConfig(environment)).toThrow(/HTTPS|WSS/);
  });

  it("permits plaintext only for loopback development", () => {
    expect(() => loadGatewayConfig({
      HELIX_MODE: "openai-compatible",
      HELIX_API_KEY: "server-only",
      HELIX_PROVIDER_BASE_URL: "http://127.0.0.1:9000/v1",
    })).not.toThrow();
  });

  it("validates Omi categories and forbids credentials inside profile JSON", () => {
    expect(() => loadGatewayConfig({ HELIX_OMI_MEMORY_CATEGORY: "private" }))
      .toThrow("interesting, system, or manual");
    expect(() => loadGatewayConfig({
      HELIX_OPENAI_API_KEY: "server-only",
      HELIX_ANSWER_PROFILES_JSON: JSON.stringify({
        unsafe: { kind: "openai-responses", apiKey: "client-visible" },
      }),
    })).toThrow(/unsupported field|credentials/);
  });

  it("uses a trimmed legacy OpenAI key when the primary variable is blank", () => {
    const config = loadGatewayConfig({
      HELIX_MODE: "openai-compatible",
      HELIX_OPENAI_API_KEY: "   ",
      HELIX_API_KEY: " legacy-server-key ",
    });

    expect(config.answerProfiles["openai-responses"]).toMatchObject({
      apiKey: "legacy-server-key",
    });
    expect(config.transcriptionProfiles["openai-compatible"]).toMatchObject({
      apiKey: "legacy-server-key",
    });
  });

  it("keeps built-in provider metadata allowlistable without environment keys for BYOK", () => {
    const config = loadGatewayConfig({
      HELIX_MODE: "mock",
      HELIX_ALLOWED_TRANSCRIPTION_PROFILES: "mock,openai-compatible,deepgram,soniox",
      HELIX_ALLOWED_ANSWER_PROFILES: "mock,openai-responses,openai-compatible",
    });

    expect(config.transcriptionProfiles.deepgram).toMatchObject({ kind: "deepgram", apiKey: "" });
    expect(config.transcriptionProfiles.soniox).toMatchObject({ kind: "soniox", apiKey: "" });
    expect(config.transcriptionProfiles["openai-compatible"]).toMatchObject({
      kind: "openai-compatible",
      apiKey: "",
    });
    expect(config.answerProfiles["openai-responses"]).toMatchObject({
      kind: "openai-responses",
      apiKey: "",
    });
  });

  it.each([
    { HELIX_PROVIDER_ID: "mock", HELIX_OPENAI_API_KEY: "server-key" },
    {
      HELIX_DEEPGRAM_API_KEY: "server-key",
      HELIX_TRANSCRIPTION_PROFILES_JSON: JSON.stringify({ mock: { kind: "deepgram" } }),
    },
    {
      HELIX_SONIOX_API_KEY: "server-key",
      HELIX_TRANSCRIPTION_PROFILES_JSON: JSON.stringify({ deepgram: { kind: "soniox" } }),
    },
    {
      HELIX_OPENAI_API_KEY: "server-key",
      HELIX_ANSWER_PROFILES_JSON: JSON.stringify({ "openai-responses": { kind: "openai-compatible" } }),
    },
  ])("prevents reserved profile IDs from being rebound", (environment) => {
    expect(() => loadGatewayConfig({ HELIX_MODE: "mock", ...environment }))
      .toThrow(/reserved built-in profile/);
  });
});
