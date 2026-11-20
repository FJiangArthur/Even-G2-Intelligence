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
  TranscriptionResult,
} from "../src/provider/types.js";
import { createGatewayServer, type GatewayServer } from "../src/server.js";

const openServers: GatewayServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(async (server) => server.close()));
});

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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

function sessionConfig(url: string, automation: SessionConfig["automation"]): SessionConfig {
  return {
    sessionId: randomUUID(),
    endpoint: { id: "gateway", url, provider: "helix", model: "configured" },
    prompt: { id: "client", version: "1", system: "Be concise." },
    audio: { encoding: "pcm_s16le", sampleRateHz: 16_000, channels: 1 },
    speaker: { label: "User", role: "self" },
    automation,
  };
}

async function connect(provider: ConversationProvider, automation: SessionConfig["automation"]): Promise<{
  server: GatewayServer;
  socket: WebSocket;
  session: SessionConfig;
  events: GatewayEvent[];
}> {
  const server = createGatewayServer({
    config: loadGatewayConfig({ HELIX_MODE: "mock", HELIX_HOST: "127.0.0.1", HELIX_PORT: "0" }),
    provider,
  });
  openServers.push(server);
  const address = await server.listen();
  const socket = new WebSocket(address.websocketUrl, ["helix.v2"]);
  const events: GatewayEvent[] = [];
  socket.on("message", (data) => events.push(JSON.parse(data.toString()) as GatewayEvent));
  await once(socket, "open");
  const session = sessionConfig(address.websocketUrl, automation);
  socket.send(JSON.stringify(command({ type: "session.start", session })));
  await waitUntil(() => events.some((event) => event.type === "session.started"));
  return { server, socket, session, events };
}

function sendAudioTurn(socket: WebSocket, session: SessionConfig, sequence: number): void {
  const samples = new Int16Array(160);
  samples.fill(sequence * 100);
  socket.send(JSON.stringify(command({
    type: "audio.frame",
    sessionId: session.sessionId,
    sequence,
    sampleCount: samples.length,
    sampleRateHz: 16_000,
    channels: 1,
  })));
  socket.send(Buffer.from(samples.buffer));
  socket.send(JSON.stringify(command({
    type: "audio.commit",
    sessionId: session.sessionId,
    sequence,
    reason: "manual",
    speaker: session.speaker,
  })));
}

class ConcurrentTurnProvider implements ConversationProvider {
  public readonly endpoint = {
    id: "controlled",
    url: "urn:helix:provider:controlled",
    provider: "test",
    model: "test",
  };
  public readonly firstTranscriptionStarted = deferred();
  public readonly releaseFirstTranscription = deferred();
  public transcriptionCalls = 0;
  public readonly answerRequests: AnswerRequest[] = [];

  public async transcribe(_request: TranscriptionRequest): Promise<TranscriptionResult> {
    this.transcriptionCalls += 1;
    const call = this.transcriptionCalls;
    if (call === 1) {
      this.firstTranscriptionStarted.resolve();
      await this.releaseFirstTranscription.promise;
    }
    return { text: call === 1 ? "First statement." : "Second statement." };
  }

  public async *streamAnswer(request: AnswerRequest): AsyncGenerator<string> {
    this.answerRequests.push(request);
    yield `Answer: ${request.question}`;
  }
}

describe("non-blocking gateway ingestion", () => {
  it("accepts the next audio turn while STT is pending and preserves source-order history", async () => {
    const provider = new ConcurrentTurnProvider();
    const { socket, session, events } = await connect(provider, {
      detectQuestions: false,
      answerQuestions: false,
      saveNotes: false,
    });

    sendAudioTurn(socket, session, 1);
    await provider.firstTranscriptionStarted.promise;
    sendAudioTurn(socket, session, 2);
    await waitUntil(() => provider.transcriptionCalls === 2);
    provider.releaseFirstTranscription.resolve();
    await waitUntil(() => events.filter((event) => event.type === "transcript.final").length === 2);

    socket.send(JSON.stringify(command({
      type: "query",
      sessionId: session.sessionId,
      requestId: randomUUID(),
      text: "What happened?",
      speaker: session.speaker,
    })));
    await waitUntil(() => provider.answerRequests.length === 1);
    expect(provider.answerRequests[0]?.history).toEqual([
      { role: "user", content: "First statement." },
      { role: "user", content: "Second statement." },
    ]);
  });

  it("accepts audio while a manual query answer is pending", async () => {
    const answerStarted = deferred();
    const releaseAnswer = deferred();
    let transcriptionCalls = 0;
    const provider: ConversationProvider = {
      endpoint: { id: "controlled", url: "urn:helix:provider:controlled", provider: "test", model: "test" },
      async transcribe() {
        transcriptionCalls += 1;
        return { text: "No question here." };
      },
      async *streamAnswer() {
        answerStarted.resolve();
        await releaseAnswer.promise;
        yield "Manual answer.";
      },
    };
    const { socket, session } = await connect(provider, {
      detectQuestions: false,
      answerQuestions: false,
      saveNotes: false,
    });
    socket.send(JSON.stringify(command({
      type: "query",
      sessionId: session.sessionId,
      requestId: randomUUID(),
      text: "Summarize the plan",
      speaker: session.speaker,
    })));
    await answerStarted.promise;
    sendAudioTurn(socket, session, 1);
    await waitUntil(() => transcriptionCalls === 1);
    releaseAnswer.resolve();
  });
});

describe("concurrent question answering", () => {
  it("starts providers concurrently but emits completed answers in source order", async () => {
    const releaseFirst = deferred();
    const startedQuestions: string[] = [];
    const provider: ConversationProvider = {
      endpoint: { id: "controlled", url: "urn:helix:provider:controlled", provider: "test", model: "test" },
      async transcribe() {
        return { text: "What is first? What is second?" };
      },
      async *streamAnswer(request) {
        startedQuestions.push(request.question);
        if (request.question.includes("first")) await releaseFirst.promise;
        yield request.question.includes("first") ? "First answer." : "Second answer.";
      },
    };
    const { socket, session, events } = await connect(provider, {
      detectQuestions: true,
      answerQuestions: true,
      saveNotes: false,
    });
    sendAudioTurn(socket, session, 1);
    await waitUntil(() => startedQuestions.length === 2);
    expect(events.filter((event) => event.type === "answer.completed")).toHaveLength(0);
    releaseFirst.resolve();
    await waitUntil(() => events.filter((event) => event.type === "answer.completed").length === 2);
    expect(events
      .filter((event): event is Extract<GatewayEvent, { type: "answer.completed" }> => event.type === "answer.completed")
      .map((event) => event.text))
      .toEqual(["First answer.", "Second answer."]);
  });

  it("commits concurrent manual-query history in source order", async () => {
    const releaseFirst = deferred();
    const requests: AnswerRequest[] = [];
    const provider: ConversationProvider = {
      endpoint: { id: "controlled", url: "urn:helix:provider:controlled", provider: "test", model: "test" },
      async transcribe() {
        return { text: "No question here." };
      },
      async *streamAnswer(request) {
        requests.push(request);
        if (request.question === "First question") await releaseFirst.promise;
        yield `Answer to ${request.question}`;
      },
    };
    const { socket, session, events } = await connect(provider, {
      detectQuestions: true,
      answerQuestions: true,
      saveNotes: false,
    });
    const sendQuery = (text: string): void => socket.send(JSON.stringify(command({
      type: "query",
      sessionId: session.sessionId,
      requestId: randomUUID(),
      text,
      speaker: session.speaker,
    })));

    sendQuery("First question");
    sendQuery("Second question");
    await waitUntil(() => requests.length === 2);
    await waitUntil(() => events.some((event) => event.type === "answer.completed" && event.text.includes("Second")));
    releaseFirst.resolve();
    await waitUntil(() => events.filter((event) => event.type === "answer.completed").length === 2);

    sendQuery("Third question");
    await waitUntil(() => requests.length === 3);
    expect(requests[2]?.history).toEqual([
      { role: "user", content: "First question" },
      { role: "assistant", content: "Answer to First question" },
      { role: "user", content: "Second question" },
      { role: "assistant", content: "Answer to Second question" },
    ]);
  });
});
