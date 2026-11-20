import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  HELIX_PROTOCOL_VERSION,
  type ClientCommand,
  type GatewayEvent,
  type SessionConfig,
} from "@helix/conversation-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { loadGatewayConfig } from "../src/config.js";
import type {
  AnswerRequest,
  ConversationProvider,
  TranscriptionRequest,
} from "../src/provider/types.js";
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
    commandId: randomUUID(),
    sentAt: new Date().toISOString(),
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for event");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function connect(
  transcript: string,
  strategy: SessionConfig["responseStrategy"],
  detectQuestions = true,
): Promise<{
  readonly socket: WebSocket;
  readonly session: SessionConfig;
  readonly events: GatewayEvent[];
  readonly answers: AnswerRequest[];
}> {
  const answers: AnswerRequest[] = [];
  const provider: ConversationProvider = {
    endpoint: { id: "controlled", url: "urn:helix:provider:controlled", provider: "test", model: "test" },
    selection: { profileId: "controlled", model: "test" },
    async transcribe(_request: TranscriptionRequest) {
      return { text: transcript };
    },
    async *streamAnswer(request) {
      answers.push(request);
      yield "A useful answer.";
    },
  };
  const config = loadGatewayConfig({ HELIX_MODE: "mock", HELIX_HOST: "127.0.0.1", HELIX_PORT: "0" });
  const server = createGatewayServer({ config, provider });
  openServers.push(server);
  const address = await server.listen();
  const socket = new WebSocket(address.websocketUrl, ["helix.v2"]);
  const events: GatewayEvent[] = [];
  socket.on("message", (data) => events.push(JSON.parse(data.toString()) as GatewayEvent));
  await once(socket, "open");
  const session: SessionConfig = {
    sessionId: randomUUID(),
    endpoint: { id: "gateway", url: address.websocketUrl, provider: "helix", model: "configured" },
    prompt: { id: "client", version: "1", system: "Be concise." },
    mode: "office-discussion",
    responseStrategy: strategy,
    speaker: { label: "User", role: "self" },
    automation: { detectQuestions, answerQuestions: true, saveNotes: false },
  };
  socket.send(JSON.stringify(command({ type: "session.start", session })));
  await waitUntil(() => events.some((event) => event.type === "session.started"));
  return { socket, session, events, answers };
}

function sendAudioTurn(socket: WebSocket, session: SessionConfig): void {
  const samples = new Int16Array(160).fill(100);
  socket.send(JSON.stringify(command({
    type: "audio.frame",
    sessionId: session.sessionId,
    sequence: 1,
    sampleCount: samples.length,
    sampleRateHz: 16_000,
    channels: 1,
  })));
  socket.send(Buffer.from(samples.buffer));
  socket.send(JSON.stringify(command({
    type: "audio.commit",
    sessionId: session.sessionId,
    sequence: 1,
    reason: "manual",
    speaker: session.speaker,
  })));
}

describe("strategy gateway flow", () => {
  it("answers an actionable statement proactively with distinct provenance", async () => {
    const { socket, session, events, answers } = await connect(
      "We need to choose a launch date by Friday",
      "proactive",
    );
    sendAudioTurn(socket, session);
    await waitUntil(() => events.some((event) => event.type === "answer.completed"));
    const completed = events.find((event): event is Extract<GatewayEvent, { type: "answer.completed" }> =>
      event.type === "answer.completed");
    expect(completed?.questionId).toBeUndefined();
    expect(completed?.context.trigger).toBe("proactive");
    expect(answers[0]?.question).toContain("Offer one concise");
    expect(events.some((event) => event.type === "question.detected")).toBe(false);
  });

  it("does not turn an actionable question into a proactive intervention, but manual query still answers", async () => {
    const { socket, session, events, answers } = await connect(
      "Do we need to choose a launch date by Friday?",
      "proactive",
    );
    sendAudioTurn(socket, session);
    await waitUntil(() => events.some((event) => event.type === "transcript.final"));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(events.some((event) => event.type === "answer.completed")).toBe(false);
    expect(answers).toHaveLength(0);

    socket.send(JSON.stringify(command({
      type: "query",
      sessionId: session.sessionId,
      requestId: randomUUID(),
      text: "What launch date should we choose?",
      speaker: session.speaker,
    })));
    await waitUntil(() => events.some((event) =>
      event.type === "answer.completed" && event.context.trigger === "manual"));
    expect(answers).toHaveLength(1);
  });

  it("keeps proactive non-question pickup active when question detection is disabled", async () => {
    const { socket, session, events, answers } = await connect(
      "We need to choose a launch date by Friday",
      "proactive",
      false,
    );
    sendAudioTurn(socket, session);
    await waitUntil(() => events.some((event) => event.type === "answer.completed"));

    expect(events.some((event) => event.type === "question.detected")).toBe(false);
    expect(events.find((event) => event.type === "answer.completed"))
      .toMatchObject({ context: { trigger: "proactive" } });
    expect(answers).toHaveLength(1);
  });
});
