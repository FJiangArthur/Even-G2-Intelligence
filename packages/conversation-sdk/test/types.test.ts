import { describe, expect, it } from "vitest";
import {
  HELIX_PROTOCOL_VERSION,
  isBrowserSafeEndpointUrl,
  isGatewayEvent,
  type ConversationContext,
  type GatewayEvent,
  type NoteCandidate,
} from "../src/index.js";

const occurredAt = "2026-09-06T12:00:00.000Z";
const endpoint = {
  id: "provider-1",
  url: "urn:helix:provider:private%20cluster",
  provider: "openai-compatible",
  model: "custom-model",
} as const;
const context: ConversationContext = {
  prompt: { id: "server-prompt", version: "4" },
  endpoint,
  speaker: { id: "speaker-1", label: "Art", role: "self" },
  latencyMs: {
    captureMs: 20,
    transcriptionMs: 100,
    questionDetectionMs: 30,
    firstTokenMs: 140,
    completionMs: 220,
    totalMs: 370,
  },
  mode: "office-discussion",
  responseStrategy: "both",
  transcriptionProvider: { profileId: "deepgram-fast", model: "nova-3" },
  answerProvider: { profileId: "private-answer", model: "answer-2" },
  trigger: "proactive",
};

describe("gateway event validation", () => {
  it("accepts every fully validated protocol variant", () => {
    for (const event of validEvents()) {
      expect(isGatewayEvent(event), event.type).toBe(true);
    }
  });

  it("tolerates additive 2.1 event fields while validating all known fields", () => {
    const events = validEvents();
    const started = events[0] as Extract<GatewayEvent, { type: "session.started" }>;
    const partial = events[2] as Extract<GatewayEvent, { type: "transcript.partial" }>;
    const note = events[7] as Extract<GatewayEvent, { type: "note.suggested" }>;

    expect(isGatewayEvent({
      ...started,
      serverSequence: 4,
      accepted: {
        ...started.accepted,
        capabilities: ["speaker-hints"],
        transcriptionProvider: {
          ...started.accepted.transcriptionProvider,
          region: "us",
        },
      },
    })).toBe(true);
    expect(isGatewayEvent({
      ...partial,
      traceId: "trace-1",
      context: {
        ...partial.context,
        diagnostics: { queueMs: 2 },
        prompt: { ...partial.context.prompt, label: "Conversation" },
        endpoint: { ...partial.context.endpoint, region: "private" },
        speaker: { ...partial.context.speaker, confidence: 0.9 },
        latencyMs: { ...partial.context.latencyMs, queueMs: 2 },
      },
    })).toBe(true);
    expect(isGatewayEvent({
      ...note,
      note: {
        ...note.note,
        displayHint: "decision",
        persistence: { ...note.note.persistence, attempt: 1 },
        provenance: { ...note.note.provenance, pipeline: "phase-1" },
      },
    })).toBe(true);
  });

  it("rejects credential-shaped values inside inbound endpoint provenance", () => {
    const started = validEvents()[0] as Extract<GatewayEvent, { type: "session.started" }>;
    expect(isGatewayEvent({
      ...started,
      accepted: {
        ...started.accepted,
        endpoint: {
          ...started.accepted.endpoint,
          model: "Authorization: Bearer abcdefghijklmnop",
        },
      },
    })).toBe(false);
  });

  it("rejects malformed envelopes and nested values", () => {
    const events = validEvents();
    const started = events[0]!;
    const partial = events[2]!;
    const question = events[4]!;
    const note = events[7]!;
    const error = events[8]!;
    const invalid: unknown[] = [
      [],
      { ...started, occurredAt: "2026-02-31T12:00:00.000Z" },
      { ...started, accepted: [] },
      { ...started, extensions: { apiKey: "never-on-the-client" } },
      withNested(started, ["accepted", "endpoint", "url"], "wss://example.test/socket?token=secret"),
      withNested(started, ["accepted", "endpoint", "secret"], "credential"),
      withNested(started, ["accepted", "memory", "syncNotes"], "yes"),
      withNested(started, ["accepted", "transcriptionProvider", "apiKey"], "secret"),
      withNested(partial, ["context", "latencyMs", "totalMs"], Number.NaN),
      withNested(partial, ["context", "speaker", "role"], "host"),
      withNested(partial, ["context", "mode"], "meeting"),
      withNested(partial, ["context", "responseStrategy"], "automatic"),
      withNested(partial, ["context", "transcriptionProvider", "url"], "https://secret.test"),
      withNested(partial, ["context", "transcriptionProvider", "profileId"], "https%3A%2F%2Fsecret.test"),
      withNested(
        partial,
        ["context", "answerProvider", "profileId"],
        ["sk", "proj", "abcdefghijklmnop"].join("-"),
      ),
      withNested(partial, ["context", "trigger"], "timer"),
      { ...question, confidence: 1.1 },
      { ...question, sourceTranscriptId: 123 },
      withNested(note, ["note", "provenance", "sessionId"], "another-session"),
      withNested(note, ["note", "provenance", "sourceType"], "guess"),
      withNested(note, ["note", "tags"], { tag: "sdk" }),
      withNested(note, ["note", "persistence", "destination"], "local"),
      withNested(note, ["note", "persistence", "url"], "https://omi.example/note"),
      withNested(note, ["context", "latencyMs", "totalMs"], 371),
      { ...error, fatal: "yes" },
    ];

    invalid.forEach((candidate, index) => {
      expect(isGatewayEvent(candidate), `invalid candidate ${index}`).toBe(false);
    });
  });

  it("accepts only credential-free WebSocket client routes", () => {
    expect(isBrowserSafeEndpointUrl("wss://gateway.example.test/v2/conversations")).toBe(true);
    expect(isBrowserSafeEndpointUrl("ws://127.0.0.1:8787/v2/conversations")).toBe(true);
    expect(isBrowserSafeEndpointUrl("https://gateway.example.test/v2/conversations")).toBe(false);
    expect(isBrowserSafeEndpointUrl("wss://user:secret@gateway.example.test/v2/conversations")).toBe(false);
    expect(isBrowserSafeEndpointUrl("wss://gateway.example.test/v2/conversations?token=secret")).toBe(false);
    expect(isBrowserSafeEndpointUrl("wss://gateway.example.test/v2/conversations#secret")).toBe(false);
  });
});

function validEvents(): GatewayEvent[] {
  const note: NoteCandidate = {
    id: "note-1",
    text: "Use the G2 SDK.",
    title: "G2 decision",
    tags: ["g2", "sdk"],
    provenance: {
      sessionId: "session-1",
      sourceEventId: "answer-completed-1",
      sourceType: "answer",
      capturedAt: occurredAt,
      ...context,
    },
    persistence: {
      destination: "omi",
      status: "synced",
      recordId: "omi-note-1",
    },
  };
  const base = {
    protocolVersion: HELIX_PROTOCOL_VERSION,
    sessionId: "session-1",
    occurredAt,
  } as const;
  return [
    {
      ...base,
      type: "session.started",
      eventId: "started-1",
      accepted: {
        prompt: context.prompt,
        endpoint,
        audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 },
        mode: context.mode,
        responseStrategy: context.responseStrategy,
        transcriptionProvider: context.transcriptionProvider,
        answerProvider: context.answerProvider,
        memory: { readOmiContext: true, syncNotes: true },
      },
    },
    { ...base, type: "session.ended", eventId: "ended-1", reason: "user" },
    { ...base, type: "transcript.partial", eventId: "partial-1", text: "What", revision: 1, context },
    {
      ...base,
      type: "transcript.final",
      eventId: "transcript-1",
      transcriptId: "transcript-1",
      text: "What did we decide?",
      context,
    },
    {
      ...base,
      type: "question.detected",
      eventId: "question-1",
      questionId: "question-1",
      text: "What did we decide?",
      confidence: 0.98,
      sourceTranscriptId: "transcript-1",
      context,
    },
    {
      ...base,
      type: "answer.delta",
      eventId: "delta-1",
      answerId: "answer-1",
      questionId: "question-1",
      delta: "Use",
      context,
    },
    {
      ...base,
      type: "answer.completed",
      eventId: "answer-completed-1",
      answerId: "answer-1",
      questionId: "question-1",
      text: "Use the G2 SDK.",
      context,
    },
    { ...base, type: "note.suggested", eventId: "note-event-1", note, context },
    {
      ...base,
      type: "error",
      eventId: "error-1",
      code: "UPSTREAM_TIMEOUT",
      message: "Upstream timed out",
      retryable: true,
      fatal: false,
    },
  ];
}

function withNested(source: unknown, path: readonly string[], value: unknown): unknown {
  const copy = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
  let cursor = copy;
  for (const key of path.slice(0, -1)) {
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path.at(-1)!] = value;
  return copy;
}
