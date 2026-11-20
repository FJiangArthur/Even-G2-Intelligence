import { describe, expect, it, vi } from "vitest";
import {
  HELIX_PROTOCOL_VERSION,
  HelixConversationClient,
  HelixProtocolError,
  InMemoryNoteSink,
  type GatewayEvent,
  type NoteCandidate,
  type SessionConfig,
} from "../src/index.js";
import { FakeTransport } from "./helpers.js";

const speaker = { label: "Art", role: "self" as const };
const config: SessionConfig = {
  sessionId: "session-1",
  endpoint: {
    id: "my-endpoint",
    url: "wss://example.test/conversation",
    provider: "openai-compatible",
    model: "my-model",
  },
  prompt: {
    id: "conversation",
    version: "7",
    system: "Answer directly.",
    maxResponseSentences: 3,
  },
  speaker,
  automation: { detectQuestions: true, answerQuestions: true, saveNotes: true },
};

describe("HelixConversationClient", () => {
  it("retries a failed full-segment commit before sending further audio", async () => {
    const transport = new FakeTransport();
    const originalSend = transport.send.bind(transport);
    let failures = 2;
    vi.spyOn(transport, "send").mockImplementation(async command => {
      if (command.type === "audio.commit" && failures-- > 0) throw new Error("transient commit failure");
      await originalSend(command);
    });
    const client = new HelixConversationClient(transport, { vad: false });
    const starting = client.start(config);
    await vi.waitFor(() => expect(transport.commands).toHaveLength(1));
    transport.emit(sessionStartedEvent()); await starting;
    await expect(client.sendAudio(new Int16Array(96000).fill(4000))).rejects.toThrow("transient");
    await expect(client.sendAudio(new Int16Array(100).fill(4000))).rejects.toThrow("transient");
    expect(transport.audioFrames.map(f => f.samples.length)).toEqual([96000]);
    await client.sendAudio(new Int16Array(100).fill(4000));
    expect(transport.audioFrames.map(f => f.samples.length)).toEqual([96000, 100]);
    expect(transport.audioFrames.map(f => f.sequence)).toEqual([1, 2]);
    await client.commitAudio(); await client.dispose();
  });
  it("sends scope as an optional typed field and bounds continuous speech commits to six seconds", async () => {
    const transport = new FakeTransport();
    const client = new HelixConversationClient(transport, { vad: false });
    const starting = client.start(config);
    await vi.waitFor(() => expect(transport.commands).toHaveLength(1));
    transport.emit(sessionStartedEvent()); await starting;
    await client.askContext("local");
    expect(transport.commands.at(-1)).toMatchObject({ type: "query", contextScope: "local" });
    for (let i = 0; i < 12; i++) await client.sendAudio(new Int16Array(16000).fill(4000));
    expect(transport.commands.filter(c => c.type === "audio.commit").map(c => c.sequence)).toEqual([6, 12]);
    await expect(client.commitAudio()).rejects.toThrow("No uncommitted audio");
    await client.sendAudio(new Int16Array(16000 * 13).fill(4000));
    expect(transport.audioFrames.slice(-3).map(frame => frame.samples.length)).toEqual([96000, 96000, 16000]);
    await client.commitAudio();
    await client.dispose();
  });
  it("enforces session state and sends typed query/audio commands", async () => {
    const transport = new FakeTransport();
    let ids = 0;
    const client = new HelixConversationClient(transport, {
      idFactory: (prefix) => `${prefix}-${++ids}`,
      clock: () => new Date("2026-09-06T12:00:00.000Z"),
      vad: false,
    });
    const states: string[] = [];
    client.subscribeState((state) => states.push(state));

    await expect(client.ask("too soon")).rejects.toThrow("not active");
    const starting = client.start(config);
    await vi.waitFor(() => expect(transport.commands).toHaveLength(1));
    expect(client.state).toBe("starting");
    expect(transport.commands[0]).toMatchObject({
      type: "session.start",
      protocolVersion: HELIX_PROTOCOL_VERSION,
      session: { sessionId: "session-1" },
    });

    transport.emit(sessionStartedEvent());
    await starting;
    expect(client.state).toBe("active");
    const requestId = await client.ask(" What did we decide? ");
    expect(requestId).toMatch(/^query-/u);
    expect(transport.commands[1]).toMatchObject({
      type: "query",
      text: "What did we decide?",
      speaker,
    });

    await client.sendAudio(new Int16Array([1200, -1200]), {
      source: "glasses",
      direction: -12,
      speakerRole: "other",
    });
    await client.commitAudio();
    expect(transport.audioFrames[0]).toMatchObject({ sequence: 1, sampleRateHz: 16000, channels: 1 });
    expect(transport.commands[2]).toMatchObject({
      type: "audio.frame",
      sequence: 1,
      source: "glasses",
      direction: -12,
      speakerRole: "other",
    });
    expect(transport.commands[3]).toMatchObject({ type: "audio.commit", sequence: 1, reason: "manual" });
    await expect(client.commitAudio()).rejects.toThrow("No uncommitted audio");

    await client.stop();
    expect(transport.commands[4]).toMatchObject({ type: "session.end", reason: "user" });
    expect(client.state).toBe("stopped");
    expect(states).toEqual(["connecting", "starting", "active", "stopping", "stopped"]);
  });

  it("emits normalized Phase 1 session settings without provider credentials", async () => {
    const transport = new FakeTransport();
    const client = new HelixConversationClient(transport, { vad: false });
    const starting = client.start({
      ...config,
      prompt: { ...config.prompt, mode: "interview" },
      responseStrategy: "both",
      providers: {
        transcriptionProvider: "  fast-stt  ",
        answerProvider: "  private-answer  ",
      },
      memory: { readOmiContext: true, syncNotes: true },
    });
    await vi.waitFor(() => expect(transport.commands).toHaveLength(1));
    const command = transport.commands[0];

    expect(command).toMatchObject({
      type: "session.start",
      session: {
        mode: "interviewee",
        responseStrategy: "both",
        providers: {
          transcriptionProvider: "fast-stt",
          answerProvider: "private-answer",
        },
        memory: { readOmiContext: true, syncNotes: true },
        prompt: { mode: "interviewee" },
      },
    });
    expect(JSON.stringify(command)).not.toMatch(/apiKey|accessToken|authorization/iu);

    transport.emit(sessionStartedEvent({
      prompt: { id: config.prompt.id, version: config.prompt.version },
      endpoint: config.endpoint,
      audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 },
      mode: "interviewee",
      responseStrategy: "both",
      transcriptionProvider: { profileId: "fast-stt", model: "nova-3" },
      answerProvider: { profileId: "private-answer", model: "answer-2" },
      memory: { readOmiContext: true, syncNotes: true },
      automation: { detectQuestions: true, answerQuestions: true, saveNotes: true },
    }));
    await starting;
  });

  it("sends transient provider credentials once outside retained session configuration", async () => {
    const transport = new FakeTransport();
    const client = new HelixConversationClient(transport, { vad: false });
    const starting = client.start(config, {
      openai: "  openai-session-value  ",
      deepgram: "deepgram-session-value",
      soniox: "soniox-session-value",
      omi: "omi-session-value",
    });
    await vi.waitFor(() => expect(transport.commands).toHaveLength(1));
    expect(transport.commands[0]).toMatchObject({
      type: "session.start",
      credentials: {
        openai: "openai-session-value",
        deepgram: "deepgram-session-value",
        soniox: "soniox-session-value",
        omi: "omi-session-value",
      },
    });
    expect((transport.commands[0] as Extract<typeof transport.commands[number], { type: "session.start" }>).session)
      .not.toHaveProperty("credentials");
    transport.emit(sessionStartedEvent());
    await starting;
    await client.ask("What is next?");
    expect(transport.commands[1]).not.toHaveProperty("credentials");
    await client.stop();
    expect(transport.commands[2]).not.toHaveProperty("credentials");
  });

  it("routes only active-session events and automatically saves note suggestions", async () => {
    const transport = new FakeTransport();
    const noteSink = new InMemoryNoteSink();
    const onNoteSaved = vi.fn();
    const listener = vi.fn();
    const client = new HelixConversationClient(transport, { noteSink, onNoteSaved, vad: false });
    client.subscribe(listener);
    const starting = client.start(config);
    await vi.waitFor(() => expect(transport.commands).toHaveLength(1));
    transport.emit(sessionStartedEvent());
    await starting;

    const noteEvent = makeNoteEvent("session-1");
    transport.emit(answerCompletedEvent());
    transport.emit(noteEvent);
    transport.emit({ ...noteEvent, eventId: "other", sessionId: "another-session" });
    await Promise.resolve();

    expect(listener).toHaveBeenCalledTimes(3); // session.started + source answer + matching note
    expect(noteSink.list()).toHaveLength(1);
    expect(onNoteSaved).toHaveBeenCalledWith(noteEvent, expect.objectContaining({ status: "saved" }));
  });

  it("retains the terminal Omi outcome when note events update persistence", async () => {
    const transport = new FakeTransport();
    const noteSink = new InMemoryNoteSink();
    const client = new HelixConversationClient(transport, { noteSink, vad: false });
    const starting = client.start(config);
    await vi.waitFor(() => expect(transport.commands).toHaveLength(1));
    transport.emit(sessionStartedEvent());
    await starting;
    transport.emit(answerCompletedEvent());

    const baseNoteEvent = makeNoteEvent("session-1") as Extract<GatewayEvent, { type: "note.suggested" }>;
    transport.emit({
      ...baseNoteEvent,
      note: {
        ...baseNoteEvent.note,
        persistence: { destination: "omi", status: "pending" },
      },
    });
    transport.emit({
      ...baseNoteEvent,
      eventId: "note-event-2",
      note: {
        ...baseNoteEvent.note,
        persistence: { destination: "omi", status: "synced", recordId: "omi-record-1" },
      },
    });

    await vi.waitFor(() => expect(noteSink.list()[0]?.persistence).toEqual({
      destination: "omi",
      status: "synced",
      recordId: "omi-record-1",
    }));
  });

  it("auto-commits after VAD detects configured trailing silence", async () => {
    const transport = new FakeTransport();
    const client = new HelixConversationClient(transport, {
      vad: { speechThreshold: 0.01, minSpeechDurationMs: 20, silenceDurationMs: 40 },
    });
    const starting = client.start(config);
    await vi.waitFor(() => expect(transport.commands).toHaveLength(1));
    transport.emit(sessionStartedEvent());
    await starting;

    await client.sendAudio(new Int16Array(320).fill(5000)); // 20ms speech
    const decision = await client.sendAudio(new Int16Array(640)); // 40ms silence

    expect(decision?.shouldCommit).toBe(true);
    expect(transport.commands.at(-1)).toMatchObject({
      type: "audio.commit",
      sequence: 2,
      reason: "vad",
    });
  });

  it("accepts a server-selected prompt and redacted provider provenance", async () => {
    const transport = new FakeTransport();
    const client = new HelixConversationClient(transport, { vad: false });
    const starting = client.start(config);
    await vi.waitFor(() => expect(transport.commands).toHaveLength(1));
    transport.emit(sessionStartedEvent({
      prompt: { id: "helix-conversation", version: "server-4" },
      endpoint: {
        id: "configured-provider",
        url: "urn:helix:provider:private%20cluster",
        provider: "mock",
        model: "server-model",
      },
      audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 },
      automation: { detectQuestions: true, answerQuestions: true, saveNotes: true },
    }));

    await expect(starting).resolves.toBeUndefined();
    expect(client.state).toBe("active");
  });

  it("rejects every explicitly requested selection that the gateway does not acknowledge", async () => {
    const cases: ReadonlyArray<{
      readonly requested: Partial<SessionConfig>;
      readonly accepted: Extract<GatewayEvent, { type: "session.started" }>["accepted"];
      readonly field: string;
    }> = [
      {
        requested: { mode: "social" },
        accepted: baseAcceptance(),
        field: "accepted.mode",
      },
      {
        requested: { responseStrategy: "proactive" },
        accepted: { ...baseAcceptance(), responseStrategy: "reactive" },
        field: "accepted.responseStrategy",
      },
      {
        requested: { providers: { transcriptionProvider: "deepgram" } },
        accepted: {
          ...baseAcceptance(),
          transcriptionProvider: { profileId: "soniox" },
        },
        field: "accepted.transcriptionProvider.profileId",
      },
      {
        requested: { providers: { answerProvider: "openai-responses" } },
        accepted: {
          ...baseAcceptance(),
          answerProvider: { profileId: "mock-answer" },
        },
        field: "accepted.answerProvider.profileId",
      },
      {
        requested: { memory: { readOmiContext: true, syncNotes: true } },
        accepted: {
          ...baseAcceptance(),
          memory: { readOmiContext: true, syncNotes: false },
        },
        field: "accepted.memory.syncNotes",
      },
      {
        requested: {
          automation: { detectQuestions: true, answerQuestions: true, saveNotes: true },
        },
        accepted: {
          ...baseAcceptance(),
          automation: { detectQuestions: true, answerQuestions: false, saveNotes: true },
        },
        field: "accepted.automation.answerQuestions",
      },
    ];

    for (const testCase of cases) {
      const transport = new FakeTransport();
      const client = new HelixConversationClient(transport, { vad: false });
      const starting = client.start({ ...config, ...testCase.requested });
      await vi.waitFor(() => expect(transport.commands).toHaveLength(1));
      transport.emit(sessionStartedEvent(testCase.accepted));

      const error = await starting.catch((caught: unknown) => caught);
      expect(error, testCase.field).toBeInstanceOf(HelixProtocolError);
      expect(error, testCase.field).toMatchObject({ code: "SESSION_ACCEPTANCE_MISMATCH" });
      expect((error as Error).message, testCase.field).toContain(testCase.field);
      expect((error as Error).message, testCase.field).toContain("gateway returned");
      expect(client.state, testCase.field).toBe("failed");
    }
  });

  it("rejects start on acknowledgement timeout, fatal error, and early close", async () => {
    vi.useFakeTimers();
    try {
      const timeoutTransport = new FakeTransport();
      const timeoutClient = new HelixConversationClient(timeoutTransport, {
        vad: false,
        startAcknowledgementTimeoutMs: 25,
      });
      const timedOut = timeoutClient.start(config);
      const timeoutRejection = expect(timedOut).rejects.toThrow("acknowledgement timed out");
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(25);
      await timeoutRejection;
      expect(timeoutClient.state).toBe("failed");
      expect(timeoutTransport.state).toBe("closed");

      const fatalTransport = new FakeTransport();
      const fatalClient = new HelixConversationClient(fatalTransport, { vad: false });
      const fatalStart = fatalClient.start(config);
      await flushMicrotasks();
      fatalTransport.emit(gatewayErrorEvent("fatal-start", true));
      await expect(fatalStart).rejects.toThrow("START_REJECTED");
      expect(fatalClient.state).toBe("failed");

      const closeTransport = new FakeTransport();
      const closeClient = new HelixConversationClient(closeTransport, { vad: false });
      const closedStart = closeClient.start(config);
      await flushMicrotasks();
      closeTransport.emitState("closed");
      await expect(closedStart).rejects.toThrow("closed before session acknowledgement");
      expect(closeClient.state).toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes concurrent audio calls with unique sequence numbers", async () => {
    const transport = new FakeTransport();
    const client = new HelixConversationClient(transport, { vad: false });
    const starting = client.start(config);
    await vi.waitFor(() => expect(transport.commands).toHaveLength(1));
    transport.emit(sessionStartedEvent());
    await starting;

    await Promise.all([
      client.sendAudio(new Int16Array([1, 2]), { source: "glasses" }),
      client.sendAudio(new Int16Array([3, 4]), { source: "glasses" }),
    ]);

    expect(transport.audioFrames.map((frame) => frame.sequence)).toEqual([1, 2]);
    expect(transport.commands.filter((command) => command.type === "audio.frame")
      .map((command) => command.sequence)).toEqual([1, 2]);
  });

  it("suppresses premature, duplicate, and post-stop events", async () => {
    const transport = new FakeTransport();
    const listener = vi.fn();
    const client = new HelixConversationClient(transport, { vad: false });
    client.subscribe(listener);
    const premature = answerCompletedEvent();
    const starting = client.start(config);
    await vi.waitFor(() => expect(transport.commands).toHaveLength(1));
    transport.emit(premature);
    transport.emit(sessionStartedEvent());
    await starting;
    transport.emit(premature);
    const accepted = { ...premature, eventId: "answer-2", answerId: "answer-2" };
    transport.emit(accepted);
    transport.emit(accepted);
    await client.stop();
    transport.emit({ ...accepted, eventId: "answer-late", answerId: "answer-late" });

    expect(listener.mock.calls.map(([event]) => (event as GatewayEvent).eventId)).toEqual([
      "started-1",
      "answer-2",
    ]);
  });

  it("requires observed compatible provenance before automatic note save", async () => {
    const transport = new FakeTransport();
    const save = vi.fn(async () => ({ status: "saved" as const }));
    const onNoteSaved = vi.fn();
    const client = new HelixConversationClient(transport, {
      vad: false,
      noteSink: { save },
      onNoteSaved,
    });
    const starting = client.start(config);
    await vi.waitFor(() => expect(transport.commands).toHaveLength(1));
    transport.emit(sessionStartedEvent());
    await starting;
    const noteEvent = makeNoteEvent("session-1");
    transport.emit(noteEvent);

    expect(save).not.toHaveBeenCalled();
    expect(onNoteSaved).toHaveBeenCalledWith(noteEvent, expect.objectContaining({
      status: "rejected",
      reason: expect.stringContaining("source event was not observed"),
    }));
  });

  it("disconnects and terminalizes when disposed", async () => {
    const transport = new FakeTransport();
    const client = new HelixConversationClient(transport, { vad: false });
    const starting = client.start(config);
    await vi.waitFor(() => expect(transport.commands).toHaveLength(1));
    transport.emit(sessionStartedEvent());
    await starting;

    await client.dispose();

    expect(client.state).toBe("stopped");
    expect(transport.state).toBe("closed");
    await expect(client.ask("late")).rejects.toThrow("disposed");
  });
});

function sessionStartedEvent(
  accepted: Extract<GatewayEvent, { type: "session.started" }>["accepted"] = baseAcceptance(),
): GatewayEvent {
  return {
    protocolVersion: HELIX_PROTOCOL_VERSION,
    type: "session.started",
    eventId: "started-1",
    sessionId: "session-1",
    occurredAt: "2026-09-06T12:00:00.000Z",
    accepted,
  };
}

function baseAcceptance(): Extract<GatewayEvent, { type: "session.started" }>["accepted"] {
  return {
    prompt: { id: config.prompt.id, version: config.prompt.version },
    endpoint: config.endpoint,
    audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 },
    automation: { detectQuestions: true, answerQuestions: true, saveNotes: true },
  };
}

function answerCompletedEvent(): GatewayEvent {
  return {
    protocolVersion: HELIX_PROTOCOL_VERSION,
    type: "answer.completed",
    eventId: "answer-1",
    sessionId: "session-1",
    occurredAt: "2026-09-06T12:00:01.000Z",
    answerId: "answer-1",
    text: "Use the G2 SDK.",
    context: {
      prompt: { id: config.prompt.id, version: config.prompt.version },
      endpoint: config.endpoint,
      speaker,
      latencyMs: { totalMs: 420 },
    },
  };
}

function gatewayErrorEvent(eventId: string, fatal: boolean): GatewayEvent {
  return {
    protocolVersion: HELIX_PROTOCOL_VERSION,
    type: "error",
    eventId,
    sessionId: "session-1",
    occurredAt: "2026-09-06T12:00:01.000Z",
    code: "START_REJECTED",
    message: "Gateway rejected the session",
    retryable: false,
    fatal,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function makeNoteEvent(sessionId: string): GatewayEvent {
  const note: NoteCandidate = {
    id: "note-1",
    text: "Use the G2 SDK.",
    provenance: {
      sessionId,
      sourceEventId: "answer-1",
      sourceType: "answer",
      capturedAt: "2026-09-06T12:00:01.000Z",
      prompt: { id: config.prompt.id, version: config.prompt.version },
      endpoint: config.endpoint,
      speaker,
      latencyMs: { totalMs: 420 },
    },
  };
  return {
    protocolVersion: HELIX_PROTOCOL_VERSION,
    type: "note.suggested",
    eventId: "note-event-1",
    sessionId,
    occurredAt: "2026-09-06T12:00:01.000Z",
    note,
    context: {
      prompt: note.provenance.prompt,
      endpoint: note.provenance.endpoint,
      speaker,
      latencyMs: note.provenance.latencyMs,
    },
  };
}
