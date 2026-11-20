import { once } from "node:events";
import {
  HELIX_PROTOCOL_VERSION,
  HelixConversationClient,
  InMemoryNoteSink,
  WebSocketConversationTransport,
  type ClientCommand,
  type GatewayEvent,
  type SessionConfig,
  type WebSocketLike,
} from "@helix/conversation-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { loadGatewayConfig } from "../src/config.js";
import { createGatewayServer, type GatewayServer } from "../src/server.js";

const openServers: GatewayServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(async (server) => server.close()));
});

function command<T extends Omit<ClientCommand, "protocolVersion" | "commandId" | "sentAt">>(
  value: T,
): T & Pick<ClientCommand, "protocolVersion" | "commandId" | "sentAt"> {
  return {
    ...value,
    protocolVersion: HELIX_PROTOCOL_VERSION,
    commandId: crypto.randomUUID(),
    sentAt: new Date().toISOString(),
  };
}

async function waitForEvent(
  events: GatewayEvent[],
  type: GatewayEvent["type"],
  timeoutMs = 3_000,
): Promise<GatewayEvent> {
  const existing = events.find((event) => event.type === type);
  if (existing !== undefined) return existing;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const event = events.find((candidate) => candidate.type === type);
    if (event !== undefined) return event;
  }
  throw new Error(`Timed out waiting for ${type}`);
}

describe("mock gateway turn", () => {
  it("runs the published SDK client through transcription, answering, and automatic notes", async () => {
    const server = createGatewayServer({
      config: loadGatewayConfig({
        HELIX_MODE: "mock",
        HELIX_HOST: "127.0.0.1",
        HELIX_PORT: "0",
        HELIX_MOCK_TRANSCRIPT: "What should we ship first?",
      }),
    });
    openServers.push(server);
    const address = await server.listen();
    const notes = new InMemoryNoteSink();
    const events: GatewayEvent[] = [];
    const client = new HelixConversationClient(
      new WebSocketConversationTransport({
        url: address.websocketUrl,
        factory: (url, protocols) => new WebSocket(
          url,
          protocols as string | string[] | undefined,
        ) as unknown as WebSocketLike,
      }),
      {
        vad: false,
        noteSink: notes,
        autoSaveSuggestedNotes: true,
      },
    );
    client.subscribe((event) => events.push(event));

    const requestedSession: SessionConfig = {
      ...sessionConfig(address.websocketUrl, "sdk-session"),
      mode: "office-discussion",
      responseStrategy: "both",
      providers: { transcriptionProvider: "mock", answerProvider: "mock" },
      memory: { readOmiContext: false, syncNotes: false },
    };
    await client.start(requestedSession);
    await client.sendAudio(new Int16Array(320).fill(500), {
      source: "test",
      direction: 0,
      speakerRole: "self",
    });
    await client.commitAudio("manual", { label: "User", role: "self" });
    await waitForEvent(events, "note.suggested");
    await vi.waitFor(() => expect(notes.list()).toHaveLength(1));

    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "session.started",
      "transcript.final",
      "question.detected",
      "answer.delta",
      "answer.completed",
      "note.suggested",
    ]));
    const started = events.find(
      (event): event is Extract<GatewayEvent, { type: "session.started" }> =>
        event.type === "session.started",
    );
    expect(started?.accepted).toEqual(expect.objectContaining({
      mode: "office-discussion",
      responseStrategy: "both",
      transcriptionProvider: { profileId: "mock", model: "mock" },
      answerProvider: { profileId: "mock", model: "mock" },
      memory: { readOmiContext: false, syncNotes: false },
      automation: { detectQuestions: true, answerQuestions: true, saveNotes: true },
    }));
    expect(notes.list()[0]?.provenance.endpoint.url).toBe("urn:helix:provider:mock");

    await client.stop("user");
    await client.dispose();
  });

  it("transcribes PCM, detects a question, streams an answer, and suggests a note", async () => {
    const server = createGatewayServer({
      config: loadGatewayConfig({
        HELIX_MODE: "mock",
        HELIX_HOST: "127.0.0.1",
        HELIX_PORT: "0",
        HELIX_MOCK_TRANSCRIPT: "What should we ship first?",
      }),
    });
    openServers.push(server);
    const address = await server.listen();
    const socket = new WebSocket(address.websocketUrl, ["helix.v2"]);
    const events: GatewayEvent[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString()) as GatewayEvent));
    await once(socket, "open");

    const session = sessionConfig(address.websocketUrl, "session-1");
    socket.send(JSON.stringify(command({ type: "session.start", session })));
    await waitForEvent(events, "session.started");

    const samples = new Int16Array(320);
    samples.fill(500);
    socket.send(JSON.stringify(command({
      type: "audio.frame",
      sessionId: session.sessionId,
      sequence: 1,
      sampleCount: samples.length,
      sampleRateHz: 16_000,
      channels: 1,
      source: "test",
      speakerRole: "self",
    })));
    socket.send(Buffer.from(samples.buffer));
    socket.send(JSON.stringify(command({
      type: "audio.commit",
      sessionId: session.sessionId,
      sequence: 1,
      reason: "manual",
      speaker: session.speaker,
    })));

    await waitForEvent(events, "note.suggested");
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "session.started",
      "transcript.final",
      "question.detected",
      "answer.delta",
      "answer.completed",
      "note.suggested",
    ]));
    const noteEvent = events.find((event) => event.type === "note.suggested");
    expect(noteEvent?.type === "note.suggested" && noteEvent.note.provenance).toEqual(
      expect.objectContaining({ sessionId: session.sessionId, sourceType: "answer" }),
    );

    const closePromise = once(socket, "close");
    socket.send(JSON.stringify(command({
      type: "session.end",
      sessionId: session.sessionId,
      reason: "user",
    })));
    await waitForEvent(events, "session.ended");
    await closePromise;
  });

  it("resolves requested profile IDs only from the server allowlist", async () => {
    const server = createGatewayServer({
      config: loadGatewayConfig({
        HELIX_MODE: "mock",
        HELIX_HOST: "127.0.0.1",
        HELIX_PORT: "0",
        HELIX_TRANSCRIPTION_PROFILES_JSON: JSON.stringify({
          "demo-stt": { kind: "mock", model: "mock-stt-v2" },
        }),
        HELIX_ANSWER_PROFILES_JSON: JSON.stringify({
          "demo-answer": { kind: "mock", model: "mock-answer-v2" },
        }),
        HELIX_ALLOWED_TRANSCRIPTION_PROFILES: "mock,demo-stt",
        HELIX_ALLOWED_ANSWER_PROFILES: "mock,demo-answer",
      }),
    });
    openServers.push(server);
    const address = await server.listen();
    const socket = new WebSocket(address.websocketUrl, ["helix.v2"]);
    const events: GatewayEvent[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString()) as GatewayEvent));
    await once(socket, "open");
    const session: SessionConfig = {
      ...sessionConfig(address.websocketUrl, "profile-session"),
      providers: { transcriptionProvider: "demo-stt", answerProvider: "demo-answer" },
      mode: "social",
      responseStrategy: "both",
      memory: { readOmiContext: false, syncNotes: false },
    };
    socket.send(JSON.stringify(command({ type: "session.start", session })));
    const event = await waitForEvent(events, "session.started");
    expect(event.type === "session.started" && event.accepted).toEqual(expect.objectContaining({
      mode: "social",
      responseStrategy: "both",
      transcriptionProvider: { profileId: "demo-stt", model: "mock-stt-v2" },
      answerProvider: { profileId: "demo-answer", model: "mock-answer-v2" },
      memory: { readOmiContext: false, syncNotes: false },
    }));
  });
});

function sessionConfig(websocketUrl: string, sessionId: string): SessionConfig {
  return {
    sessionId,
    endpoint: { id: "gateway", url: websocketUrl, provider: "helix", model: "configured" },
    prompt: { id: "client", version: "1", system: "Use short direct answers." },
    audio: { encoding: "pcm_s16le", sampleRateHz: 16_000, channels: 1 },
    speaker: { label: "User", role: "self" },
    automation: { detectQuestions: true, answerQuestions: true, saveNotes: true },
  };
}
