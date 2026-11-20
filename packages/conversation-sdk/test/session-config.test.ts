import { describe, expect, it } from "vitest";
import {
  CONVERSATION_MODES,
  MAX_PROVIDER_CREDENTIAL_LENGTH,
  RESPONSE_STRATEGIES,
  normalizeSessionStartCredentials,
  normalizeSessionConfig,
  validateSessionConfig,
  type SessionConfig,
} from "../src/index.js";

const baseConfig: SessionConfig = {
  sessionId: "session-1",
  endpoint: {
    id: "gateway",
    url: "wss://gateway.example.test/v2/conversations",
    provider: "self-hosted",
    model: "gateway-selected",
  },
  prompt: {
    id: "helix-direct",
    version: "1",
    system: "Answer directly.",
  },
  speaker: { label: "Conversation", role: "unknown" },
};

describe("session configuration", () => {
  it("normalizes every conversation mode and response strategy", () => {
    for (const mode of CONVERSATION_MODES) {
      expect(normalizeSessionConfig({ ...baseConfig, mode }).mode).toBe(mode);
    }
    for (const responseStrategy of RESPONSE_STRATEGIES) {
      expect(normalizeSessionConfig({ ...baseConfig, responseStrategy }).responseStrategy)
        .toBe(responseStrategy);
    }
  });

  it("maps the legacy interview prompt mode and applies safe defaults", () => {
    const normalized = normalizeSessionConfig({
      ...baseConfig,
      sessionId: "  session-legacy  ",
      prompt: { ...baseConfig.prompt, mode: "interview" },
    });

    expect(normalized).toMatchObject({
      sessionId: "session-legacy",
      mode: "interviewee",
      responseStrategy: "reactive",
      prompt: { mode: "interviewee" },
      memory: { readOmiContext: false, syncNotes: false },
      audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 },
    });
  });

  it("preserves custom legacy prompt modes without widening session policy", () => {
    const customPromptConfig: SessionConfig = {
      ...baseConfig,
      prompt: { ...baseConfig.prompt, mode: "facilitated-workshop" },
    };

    expect(normalizeSessionConfig(customPromptConfig)).toMatchObject({
      mode: "general",
      prompt: { mode: "facilitated-workshop" },
    });
    expect(normalizeSessionConfig({
      ...customPromptConfig,
      mode: "social",
    })).toMatchObject({
      mode: "social",
      prompt: { mode: "facilitated-workshop" },
    });
    expect(normalizeSessionConfig({
      ...baseConfig,
      prompt: { ...baseConfig.prompt, mode: " social " },
    })).toMatchObject({
      mode: "social",
      prompt: { mode: "social" },
    });
  });

  it("normalizes provider profile preferences and Omi memory settings", () => {
    const normalized = normalizeSessionConfig({
      ...baseConfig,
      mode: "office-discussion",
      responseStrategy: "both",
      providers: {
        transcriptionProvider: "  deepgram-fast  ",
        answerProvider: "  private-llm  ",
      },
      memory: { readOmiContext: true, syncNotes: true },
    });

    expect(normalized).toMatchObject({
      mode: "office-discussion",
      responseStrategy: "both",
      providers: {
        transcriptionProvider: "deepgram-fast",
        answerProvider: "private-llm",
      },
      memory: { readOmiContext: true, syncNotes: true },
    });
  });

  it("rejects invalid modes, strategies, memory values, profile secrets, and extra fields", () => {
    const invalid: unknown[] = [
      { ...baseConfig, mode: "meeting" },
      { ...baseConfig, responseStrategy: "automatic" },
      { ...baseConfig, memory: { readOmiContext: "yes", syncNotes: true } },
      {
        ...baseConfig,
        providers: { transcriptionProvider: ["sk", "proj", "abcdefghijklmnop"].join("-") },
      },
      { ...baseConfig, providers: { answerProvider: "https://provider.example/profile" } },
      { ...baseConfig, providers: { answerProvider: "api_key=abcdefghijklmnop" } },
      { ...baseConfig, providers: { answerProvider: "answer", apiKey: "secret" } },
    ];

    for (const candidate of invalid) {
      expect(() => validateSessionConfig(candidate)).toThrow();
      expect(() => normalizeSessionConfig(candidate)).toThrow();
    }
  });

  it("normalizes the exact bounded session-start credential envelope without echoing failures", () => {
    expect(normalizeSessionStartCredentials({
      openai: "  openai-runtime  ",
      deepgram: " ",
      soniox: "soniox-runtime",
      omi: "omi-runtime",
    })).toEqual({
      openai: "openai-runtime",
      soniox: "soniox-runtime",
      omi: "omi-runtime",
    });
    expect(normalizeSessionStartCredentials({ openai: " ", deepgram: "" })).toBeUndefined();
    expect(normalizeSessionStartCredentials({ openai: "x".repeat(MAX_PROVIDER_CREDENTIAL_LENGTH) })?.openai)
      .toHaveLength(MAX_PROVIDER_CREDENTIAL_LENGTH);

    const rejected: unknown[] = [
      { openai: "x".repeat(MAX_PROVIDER_CREDENTIAL_LENGTH + 1) },
      { openai: { nested: "value" } },
      { deepgram: ["value"] },
      { soniox: "line\nbreak" },
      { unknown: "credential-material-that-must-not-echo" },
    ];
    for (const value of rejected) {
      try {
        normalizeSessionStartCredentials(value);
        throw new Error("expected credential validation to fail");
      } catch (error) {
        expect(String(error)).not.toContain("credential-material-that-must-not-echo");
      }
    }
  });
});
