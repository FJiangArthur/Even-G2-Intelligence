import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type {
  HttpAnswerProfile,
  HttpTranscriptionProfile,
  SonioxTranscriptionProfile,
} from "../src/config.js";
import { loadGatewayConfig } from "../src/config.js";
import { DeepgramTranscriptionProvider } from "../src/provider/deepgram.js";
import { mapProviderFailure, providerFetch, type FetchLike } from "../src/provider/http.js";
import { OpenAIResponsesAnswerProvider } from "../src/provider/openai-responses.js";
import { ConfiguredProviderRegistry } from "../src/provider/registry.js";
import {
  SonioxTranscriptionProvider,
  type SonioxSocket,
} from "../src/provider/soniox.js";
import { ProviderError } from "../src/provider/types.js";

describe("Deepgram transcription", () => {
  it("posts raw PCM16 with the documented query and Token authentication", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const fetchImpl: FetchLike = async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({
        results: { channels: [{ alternatives: [{ transcript: "What changed?" }] }] },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const profile: HttpTranscriptionProfile = {
      id: "deepgram-fast",
      kind: "deepgram",
      model: "nova-3",
      baseUrl: "https://api.deepgram.com",
      path: "/v1/listen",
      apiKey: "server-secret",
      authHeader: "Authorization",
      authScheme: "Token",
      extraHeaders: {},
      requestTimeoutMs: 1_000,
    };
    const result = await new DeepgramTranscriptionProvider(profile, fetchImpl).transcribe({
      pcm16: Uint8Array.of(1, 2, 3, 4),
      language: "en",
    });

    const url = new URL(requestUrl);
    expect(url.pathname).toBe("/v1/listen");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      smart_format: "true",
      model: "nova-3",
      language: "en",
    });
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.headers).toEqual(expect.objectContaining({
      Authorization: "Token server-secret",
      "Content-Type": "audio/l16;rate=16000",
    }));
    expect(Array.from(new Uint8Array(requestInit?.body as ArrayBuffer))).toEqual([1, 2, 3, 4]);
    expect(result).toEqual({ text: "What changed?" });
  });
});

describe("HTTP provider errors", () => {
  it("distinguishes request timeout from rate limiting", () => {
    expect(mapProviderFailure(408)).toMatchObject({
      code: "provider-timeout",
      retryable: true,
      status: 408,
    });
    expect(mapProviderFailure(429)).toMatchObject({
      code: "provider-rate-limit",
      retryable: true,
      status: 429,
    });
  });

  it("forbids redirects for credential-bearing provider requests", async () => {
    let observed: RequestInit | undefined;
    const fetchImpl: FetchLike = async (_input, init) => {
      observed = init;
      return new Response(null, { status: 204 });
    };

    await providerFetch(fetchImpl, "https://provider.example/v1", {
      method: "POST",
      headers: { Authorization: "Bearer server-secret" },
      body: "private prompt",
    }, 1_000);

    expect(observed?.redirect).toBe("error");
  });
});

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("OpenAI Responses answering", () => {
  it("sends model, instructions, input, and stream on every request", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl: FetchLike = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return sseResponse([
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel"}\n\n',
        'data: {"type":"response.output_text.delta","delta":"ix"}\n\n',
        'data: {"type":"response.completed"}\n\n',
      ]);
    };
    const profile: HttpAnswerProfile = {
      id: "answers",
      kind: "openai-responses",
      model: "gpt-4.1-mini",
      baseUrl: "https://api.openai.com/v1",
      path: "/responses",
      apiKey: "server-secret",
      authHeader: "Authorization",
      authScheme: "Bearer",
      extraHeaders: {},
      requestTimeoutMs: 1_000,
    };
    const chunks: string[] = [];
    const stream = new OpenAIResponsesAnswerProvider(profile, fetchImpl).streamAnswer({
      question: "What should ship?",
      protectedSystemPrompt: "Answer truthfully.",
      clientPrompt: "Use one sentence.",
      memoryContext: "- The launch is Friday.",
      history: [{ role: "assistant", content: "Prior answer." }],
      trigger: "question",
    });
    for await (const chunk of stream) chunks.push(chunk);

    expect(chunks).toEqual(["Hel", "ix"]);
    expect(requestBody).toEqual(expect.objectContaining({
      model: "gpt-4.1-mini",
      stream: true,
      store: false,
    }));
    expect(requestBody?.instructions).toContain("Answer truthfully.");
    expect(requestBody?.instructions).toContain("The launch is Friday.");
    expect(requestBody?.input).toEqual([
      { role: "assistant", content: "Prior answer." },
      { role: "user", content: "What should ship?" },
    ]);
  });
});

describe("session-scoped provider resolution", () => {
  it("uses a runtime OpenAI key before the environment fallback without mutating shared config", async () => {
    const authorizations: string[] = [];
    const config = loadGatewayConfig({
      HELIX_MODE: "mock",
      HELIX_OPENAI_API_KEY: "environment-openai",
      HELIX_ALLOWED_ANSWER_PROFILES: "openai-responses",
      HELIX_ANSWER_PROVIDER: "openai-responses",
    });
    const registry = new ConfiguredProviderRegistry(config, {
      fetch: async (_input, init) => {
        authorizations.push((init?.headers as Record<string, string>).Authorization);
        return sseResponse(['data: {"type":"response.output_text.delta","delta":"ok"}\n\n']);
      },
    });
    for (const provider of [
      registry.resolveAnswer("openai-responses", { openai: "runtime-openai" }),
      registry.resolveAnswer("openai-responses"),
    ]) {
      if (provider === undefined) throw new Error("expected provider");
      for await (const _chunk of provider.streamAnswer({
        question: "What next?",
        protectedSystemPrompt: "Answer.",
        history: [],
      })) {
        // Consume the mocked stream.
      }
    }

    expect(authorizations).toEqual(["Bearer runtime-openai", "Bearer environment-openai"]);
    expect(config.answerProfiles["openai-responses"]?.apiKey).toBe("environment-openai");
  });

  it("resolves BYOK-only built-ins by matching vendor and consumes no irrelevant key", () => {
    const config = loadGatewayConfig({
      HELIX_MODE: "mock",
      HELIX_TRANSCRIPTION_PROVIDER: "deepgram",
      HELIX_ANSWER_PROVIDER: "openai-responses",
      HELIX_ALLOWED_TRANSCRIPTION_PROFILES: "deepgram,soniox,openai-compatible",
      HELIX_ALLOWED_ANSWER_PROFILES: "openai-responses",
    });
    const registry = new ConfiguredProviderRegistry(config);

    expect(registry.resolveTranscription("deepgram", { deepgram: "dg-runtime" })?.selection.profileId)
      .toBe("deepgram");
    expect(registry.resolveTranscription("soniox", { soniox: "sx-runtime" })?.selection.profileId)
      .toBe("soniox");
    expect(registry.resolveTranscription("openai-compatible", { openai: "oa-runtime" })?.selection.profileId)
      .toBe("openai-compatible");
    expect(registry.resolveAnswer("openai-responses", { openai: "oa-runtime" })?.selection.profileId)
      .toBe("openai-responses");
    expect(registry.resolveTranscription("deepgram", { openai: "irrelevant" })).toBeUndefined();
    expect(registry.resolveAnswer("openai-responses", { deepgram: "irrelevant" })).toBeUndefined();
  });
});

class FakeSonioxSocket extends EventEmitter {
  public readonly sent: (string | Buffer)[] = [];

  public send(data: string | Buffer): void {
    this.sent.push(data);
    if (Buffer.isBuffer(data) && data.byteLength === 0) {
      queueMicrotask(() => {
        this.emit("message", Buffer.from(JSON.stringify({
          tokens: [{ text: "Hel", is_final: false }],
        })));
        this.emit("message", Buffer.from(JSON.stringify({
          tokens: [{ text: "Hello ", is_final: true }, { text: "wor", is_final: false }],
        })));
        this.emit("message", Buffer.from(JSON.stringify({
          tokens: [{ text: "world", is_final: true }],
          finished: true,
        })));
      });
    }
  }

  public close(): void {}
}

function sonioxProfile(): SonioxTranscriptionProfile {
  return {
    id: "soniox",
    kind: "soniox",
    model: "stt-rt-v5",
    websocketUrl: "wss://stt-rt.soniox.com/transcribe-websocket",
    apiKey: "server-secret",
    requestTimeoutMs: 1_000,
  };
}

describe("Soniox transcription", () => {
  it("sends the exact v5 start config and concatenates final tokens only through finished", async () => {
    const socket = new FakeSonioxSocket();
    const provider = new SonioxTranscriptionProvider(
      sonioxProfile(),
      () => socket as unknown as SonioxSocket,
    );
    const transcription = provider.transcribe({
      pcm16: Uint8Array.of(1, 2, 3, 4),
      language: "en",
    });
    queueMicrotask(() => socket.emit("open"));
    await expect(transcription).resolves.toEqual({ text: "Hello world" });

    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      api_key: "server-secret",
      model: "stt-rt-v5",
      audio_format: "pcm_s16le",
      sample_rate: 16_000,
      num_channels: 1,
      enable_endpoint_detection: true,
      language_hints: ["en"],
    });
    expect(socket.sent[1]).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(socket.sent[2]).toEqual(Buffer.alloc(0));
  });

  it("maps stable Soniox error codes to typed provider failures", async () => {
    const socket = new FakeSonioxSocket();
    socket.send = (data: string | Buffer): void => {
      socket.sent.push(data);
      if (Buffer.isBuffer(data) && data.byteLength === 0) {
        queueMicrotask(() => socket.emit("message", Buffer.from(JSON.stringify({
          error_code: 429,
          error_message: "upstream detail must not escape",
        }))));
      }
    };
    const promise = new SonioxTranscriptionProvider(
      sonioxProfile(),
      () => socket as unknown as SonioxSocket,
    ).transcribe({ pcm16: Uint8Array.of(1, 2) });
    queueMicrotask(() => socket.emit("open"));
    await expect(promise).rejects.toMatchObject<Partial<ProviderError>>({
      code: "provider-rate-limit",
      retryable: true,
      message: "Soniox is temporarily rate limited",
    });
  });

  it.each([
    { tokens: {} },
    { tokens: [null] },
  ])("rejects malformed token payloads without throwing from the socket callback", async (payload) => {
    const socket = new FakeSonioxSocket();
    socket.send = (data: string | Buffer): void => {
      socket.sent.push(data);
      if (Buffer.isBuffer(data) && data.byteLength === 0) {
        queueMicrotask(() => socket.emit("message", Buffer.from(JSON.stringify(payload))));
      }
    };
    const transcription = new SonioxTranscriptionProvider(
      sonioxProfile(),
      () => socket as unknown as SonioxSocket,
    ).transcribe({ pcm16: Uint8Array.of(1, 2) });
    queueMicrotask(() => socket.emit("open"));

    await expect(transcription).rejects.toMatchObject<Partial<ProviderError>>({
      code: "provider-response",
      retryable: false,
      message: "Soniox returned invalid transcription tokens",
    });
  });

  it("paces committed fallback audio in Soniox-sized real-time chunks", async () => {
    const socket = new FakeSonioxSocket();
    const delays: number[] = [];
    const provider = new SonioxTranscriptionProvider(
      sonioxProfile(),
      () => socket as unknown as SonioxSocket,
      async (milliseconds) => { delays.push(milliseconds); },
    );
    const transcription = provider.transcribe({ pcm16: new Uint8Array(8_000) });
    queueMicrotask(() => socket.emit("open"));

    await expect(transcription).resolves.toEqual({ text: "Hello world" });
    const audioChunks = socket.sent.filter((item): item is Buffer =>
      Buffer.isBuffer(item) && item.byteLength > 0);
    expect(audioChunks.map((chunk) => chunk.byteLength)).toEqual([3_840, 3_840, 320]);
    expect(audioChunks.every((chunk) => chunk.byteLength <= 3_840)).toBe(true);
    expect(delays).toEqual([120, 120]);
  });
});
