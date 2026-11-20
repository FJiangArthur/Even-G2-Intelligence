import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  HELIX_PROTOCOL_VERSION,
  type ClientCommand,
  type GatewayEvent,
  type SessionConfig,
  type SessionStartCredentials,
} from "@helix/conversation-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { loadGatewayConfig } from "../src/config.js";
import type { FetchLike } from "../src/provider/http.js";
import { ConfiguredProviderRegistry } from "../src/provider/registry.js";
import { createGatewayServer, type GatewayServer } from "../src/server.js";

const openServers: GatewayServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(async (server) => server.close()));
});

function command<T extends Omit<ClientCommand, "protocolVersion" | "commandId" | "sentAt">>(value: T) {
  return {
    ...value,
    protocolVersion: HELIX_PROTOCOL_VERSION,
    commandId: randomUUID(),
    sentAt: new Date().toISOString(),
  };
}

function session(url: string, answerProvider = "openai-responses"): SessionConfig {
  return {
    sessionId: randomUUID(),
    endpoint: { id: "gateway", url, provider: "self-hosted", model: "selected" },
    prompt: { id: "direct", version: "1", system: "Answer directly." },
    providers: { transcriptionProvider: "mock", answerProvider },
    speaker: { label: "User", role: "self" },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for gateway event");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function connect(
  url: string,
  credentials?: SessionStartCredentials,
  answerProvider = "openai-responses",
): Promise<{ socket: WebSocket; events: GatewayEvent[]; config: SessionConfig }> {
  const socket = new WebSocket(url, ["helix.v2"]);
  const events: GatewayEvent[] = [];
  socket.on("message", (data) => events.push(JSON.parse(data.toString()) as GatewayEvent));
  await once(socket, "open");
  const config = session(url, answerProvider);
  socket.send(JSON.stringify(command({
    type: "session.start",
    session: config,
    ...(credentials === undefined ? {} : { credentials }),
  })));
  return { socket, events, config };
}

function answer(socket: WebSocket, config: SessionConfig, text: string): void {
  socket.send(JSON.stringify(command({
    type: "query",
    sessionId: config.sessionId,
    requestId: randomUUID(),
    text,
    speaker: config.speaker,
  })));
}

describe("session-scoped BYOK gateway integration", () => {
  it("isolates concurrent runtime keys, then returns to environment fallback", async () => {
    const observed: { authorization: string; body: string }[] = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      observed.push({
        authorization: (init?.headers as Record<string, string>).Authorization,
        body: String(init?.body),
      });
      return new Response('data: {"type":"response.output_text.delta","delta":"Direct answer"}\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };
    const gatewayConfig = loadGatewayConfig({
      HELIX_MODE: "mock",
      HELIX_HOST: "127.0.0.1",
      HELIX_PORT: "0",
      HELIX_OPENAI_API_KEY: "environment-fallback",
      HELIX_TRANSCRIPTION_PROVIDER: "mock",
      HELIX_ANSWER_PROVIDER: "openai-responses",
      HELIX_ALLOWED_TRANSCRIPTION_PROFILES: "mock",
      HELIX_ALLOWED_ANSWER_PROFILES: "openai-responses",
    });
    const server = createGatewayServer({
      config: gatewayConfig,
      providerRegistry: new ConfiguredProviderRegistry(gatewayConfig, { fetch: fetchImpl }),
    });
    openServers.push(server);
    const address = await server.listen();
    const first = await connect(address.websocketUrl, { openai: "runtime-first" });
    const second = await connect(address.websocketUrl, { openai: "runtime-second" });
    await waitUntil(() => first.events.some((event) => event.type === "session.started"));
    await waitUntil(() => second.events.some((event) => event.type === "session.started"));
    answer(first.socket, first.config, "First session question?");
    answer(second.socket, second.config, "Second session question?");
    await waitUntil(() => first.events.some((event) => event.type === "answer.completed"));
    await waitUntil(() => second.events.some((event) => event.type === "answer.completed"));
    first.socket.close();
    second.socket.close();

    const third = await connect(address.websocketUrl, { openai: "   " });
    await waitUntil(() => third.events.some((event) => event.type === "session.started"));
    answer(third.socket, third.config, "Fallback session question?");
    await waitUntil(() => third.events.some((event) => event.type === "answer.completed"));

    expect(observed.map((request) => request.authorization).sort()).toEqual([
      "Bearer environment-fallback",
      "Bearer runtime-first",
      "Bearer runtime-second",
    ].sort());
    expect(observed.find((request) => request.body.includes("First session question"))?.authorization)
      .toBe("Bearer runtime-first");
    expect(observed.find((request) => request.body.includes("Second session question"))?.authorization)
      .toBe("Bearer runtime-second");
    expect(observed.find((request) => request.body.includes("Fallback session question"))?.authorization)
      .toBe("Bearer environment-fallback");
    const clientVisible = JSON.stringify([...first.events, ...second.events, ...third.events]);
    expect(clientVisible).not.toMatch(/runtime-(?:first|second)|environment-fallback/u);

    const health = await fetch(`${address.httpUrl}/health`).then(async (response) => response.text());
    expect(health).toBe('{"ok":true,"mode":"mock"}');
    expect(health).not.toContain("runtime-");
    third.socket.close();
  });

  it("distinguishes missing credentials from a disallowed profile without echo", async () => {
    const missingConfig = loadGatewayConfig({
      HELIX_MODE: "mock",
      HELIX_HOST: "127.0.0.1",
      HELIX_PORT: "0",
      HELIX_TRANSCRIPTION_PROVIDER: "mock",
      HELIX_ANSWER_PROVIDER: "openai-responses",
      HELIX_ALLOWED_TRANSCRIPTION_PROFILES: "mock",
      HELIX_ALLOWED_ANSWER_PROFILES: "openai-responses",
    });
    const missingServer = createGatewayServer({ config: missingConfig });
    openServers.push(missingServer);
    const missingAddress = await missingServer.listen();
    const missing = await connect(missingAddress.websocketUrl);
    await waitUntil(() => missing.events.some((event) => event.type === "error"));
    expect(missing.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "error", code: "provider-credential-required", fatal: true }),
    ]));

    const disallowedConfig = loadGatewayConfig({
      HELIX_MODE: "mock",
      HELIX_HOST: "127.0.0.1",
      HELIX_PORT: "0",
      HELIX_ALLOWED_TRANSCRIPTION_PROFILES: "mock",
      HELIX_ALLOWED_ANSWER_PROFILES: "mock",
    });
    const disallowedServer = createGatewayServer({ config: disallowedConfig });
    openServers.push(disallowedServer);
    const disallowedAddress = await disallowedServer.listen();
    const disallowed = await connect(
      disallowedAddress.websocketUrl,
      { openai: "runtime-must-not-echo" },
    );
    await waitUntil(() => disallowed.events.some((event) => event.type === "error"));
    expect(disallowed.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "error", code: "provider-profile-not-allowed", fatal: true }),
    ]));
    expect(JSON.stringify(disallowed.events)).not.toContain("runtime-must-not-echo");
  });
});
