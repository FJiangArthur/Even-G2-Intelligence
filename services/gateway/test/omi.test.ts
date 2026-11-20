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
import {
  boundedMemoryContext,
  OmiClient,
  relevantMemoryContext,
} from "../src/omi.js";
import type { FetchLike } from "../src/provider/http.js";
import { createGatewayServer, type GatewayServer } from "../src/server.js";

const openServers: GatewayServer[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(async (server) => server.close()));
});

describe("Omi Developer API adapter", () => {
  it("fetches a bounded recent/category set using the documented plural parameter", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const config = loadGatewayConfig({
      HELIX_OMI_API_KEY: "server-only",
      HELIX_OMI_MEMORY_CATEGORY: "manual",
      HELIX_OMI_MAX_RECENT: "25",
    });
    const fetchImpl: FetchLike = async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({
        memories: [
          { id: "m1", content: "Launch date is Friday.", category: "manual" },
          { id: "m2", content: "The user prefers short answers.", category: "manual" },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const memories = await new OmiClient(config.omi, fetchImpl).fetchRecentMemories();
    const url = new URL(requestUrl);

    expect(url.pathname).toBe("/v1/dev/user/memories");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("offset")).toBe("0");
    expect(url.searchParams.get("categories")).toBe("manual");
    expect(url.searchParams.has("category")).toBe(false);
    expect(requestInit?.headers).toEqual(expect.objectContaining({
      Authorization: "Bearer server-only",
    }));
    expect(memories).toHaveLength(2);
  });

  it("ranks recent memories locally by overlap and caps injected context", () => {
    const context = relevantMemoryContext([
      { content: "The launch date is Friday and the largest launch risk is approvals." },
      { content: "The user likes jazz." },
      { content: "Friday launch approval belongs to Maya." },
      { content: "A completely unrelated long memory that should never be injected." },
    ], "What is the Friday launch risk?", {
      maxContextMemories: 2,
      maxContextCharacters: 100,
    });
    expect(context).toContain("launch date is Friday");
    expect(context).toContain("Friday launch approval");
    expect(context).not.toContain("jazz");
    expect(context).not.toContain("unrelated");
    expect(context?.length).toBeLessThanOrEqual(100);
  });

  it("does not inject a memory that overlaps only on conversational stopwords", () => {
    const context = relevantMemoryContext([
      { content: "The user likes jazz and the room is quiet." },
      { content: "Launch approvals are the largest Friday risk." },
    ], "What is the Friday launch risk?", {
      maxContextMemories: 5,
      maxContextCharacters: 500,
    });

    expect(context).toContain("Launch approvals");
    expect(context).not.toContain("jazz");
  });

  it("caps Omi writes to 500 characters", async () => {
    let posted = "";
    const config = loadGatewayConfig({
      HELIX_OMI_API_KEY: "server-only",
      HELIX_OMI_WRITE_ENABLED: "true",
    });
    const client = new OmiClient(config.omi, async (_input, init) => {
      posted = (JSON.parse(String(init?.body)) as { content: string }).content;
      return new Response(JSON.stringify({ id: "remote-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    await expect(client.writeMemory("x".repeat(800))).resolves.toEqual({ recordId: "remote-1" });
    expect(Array.from(posted)).toHaveLength(500);
  });

  it("handles a rejection that arrives after the answer deadline", async () => {
    const config = loadGatewayConfig({
      HELIX_OMI_ANSWER_WAIT_MS: "1",
    });
    const delayedFailure = new Promise<readonly never[]>((_resolve, reject) => {
      setTimeout(() => reject(new Error("late failure")), 10);
    });
    await expect(boundedMemoryContext(delayedFailure, "launch date", config.omi))
      .resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it("creates a session-scoped key override without mutating the shared Omi client", async () => {
    const config = loadGatewayConfig({ HELIX_OMI_API_KEY: "environment-omi" });
    const shared = new OmiClient(config.omi, async (_input, init) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer runtime-omi");
      return new Response(JSON.stringify({ memories: [] }), { status: 200 });
    });
    await expect(shared.withApiKey("runtime-omi").fetchRecentMemories()).resolves.toEqual([]);
    expect(shared.config.apiKey).toBe("environment-omi");
  });
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

function sessionConfig(url: string, memory: NonNullable<SessionConfig["memory"]>): SessionConfig {
  return {
    sessionId: randomUUID(),
    endpoint: { id: "gateway", url, provider: "helix", model: "configured" },
    prompt: { id: "client", version: "1", system: "Use direct answers." },
    mode: "office-discussion",
    responseStrategy: "both",
    providers: { transcriptionProvider: "mock", answerProvider: "mock" },
    memory,
    speaker: { label: "User", role: "self" },
    automation: { detectQuestions: true, answerQuestions: true, saveNotes: true },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for gateway event");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function connect(config: ReturnType<typeof loadGatewayConfig>, omiClient: OmiClient): Promise<{
  readonly socket: WebSocket;
  readonly events: GatewayEvent[];
  readonly session: SessionConfig;
}> {
  const server = createGatewayServer({ config, omiClient });
  openServers.push(server);
  const address = await server.listen();
  const socket = new WebSocket(address.websocketUrl, ["helix.v2"]);
  const events: GatewayEvent[] = [];
  socket.on("message", (data) => events.push(JSON.parse(data.toString()) as GatewayEvent));
  await once(socket, "open");
  const session = sessionConfig(address.websocketUrl, {
    readOmiContext: true,
    syncNotes: false,
  });
  socket.send(JSON.stringify(command({ type: "session.start", session })));
  await waitUntil(() => events.some((event) => event.type === "session.started"));
  return { socket, events, session };
}

describe("Omi gateway behavior", () => {
  it("accepts a BYOK-only Omi read and never echoes the runtime key", async () => {
    const observedAuthorization: string[] = [];
    const config = loadGatewayConfig({
      HELIX_MODE: "mock",
      HELIX_HOST: "127.0.0.1",
      HELIX_PORT: "0",
    });
    const omi = new OmiClient(config.omi, async (_input, init) => {
      observedAuthorization.push((init?.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify({ memories: [] }), { status: 200 });
    });
    const server = createGatewayServer({ config, omiClient: omi });
    openServers.push(server);
    const address = await server.listen();
    const socket = new WebSocket(address.websocketUrl, ["helix.v2"]);
    const events: GatewayEvent[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString()) as GatewayEvent));
    await once(socket, "open");
    const session = sessionConfig(address.websocketUrl, { readOmiContext: true, syncNotes: false });
    socket.send(JSON.stringify(command({
      type: "session.start",
      session,
      credentials: { omi: "runtime-omi-byok" },
    })));
    await waitUntil(() => events.some((event) => event.type === "session.started"));
    await waitUntil(() => observedAuthorization.length === 1);

    expect(observedAuthorization).toEqual(["Bearer runtime-omi-byok"]);
    expect(JSON.stringify(events)).not.toContain("runtime-omi-byok");
    socket.close();
  });

  it.each([
    {
      environment: { HELIX_MODE: "mock" },
      memory: { readOmiContext: true, syncNotes: false },
      code: "omi-not-configured",
    },
    {
      environment: { HELIX_MODE: "mock", HELIX_OMI_API_KEY: "server-only" },
      memory: { readOmiContext: false, syncNotes: true },
      code: "omi-write-disabled",
    },
  ])("rejects impossible memory acceptance with $code", async ({ environment, memory, code }) => {
    const config = loadGatewayConfig({
      ...environment,
      HELIX_HOST: "127.0.0.1",
      HELIX_PORT: "0",
    });
    const server = createGatewayServer({ config });
    openServers.push(server);
    const address = await server.listen();
    const socket = new WebSocket(address.websocketUrl, ["helix.v2"]);
    const events: GatewayEvent[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString()) as GatewayEvent));
    await once(socket, "open");
    const session = sessionConfig(address.websocketUrl, memory);
    socket.send(JSON.stringify(command({ type: "session.start", session })));
    await waitUntil(() => events.some((event) => event.type === "error"));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "error", code, fatal: true }),
    ]));
    expect(events.some((event) => event.type === "session.started")).toBe(false);
  });

  it("echoes actual selections and completes answers when Omi times out", async () => {
    const config = loadGatewayConfig({
      HELIX_MODE: "mock",
      HELIX_HOST: "127.0.0.1",
      HELIX_PORT: "0",
      HELIX_OMI_API_KEY: "server-only",
      HELIX_OMI_TIMEOUT_MS: "25",
      HELIX_OMI_ANSWER_WAIT_MS: "5",
    });
    const abortingFetch: FetchLike = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    const { socket, events, session } = await connect(config, new OmiClient(config.omi, abortingFetch));
    socket.send(JSON.stringify(command({
      type: "query",
      sessionId: session.sessionId,
      requestId: randomUUID(),
      text: "What is the launch risk?",
      speaker: session.speaker,
    })));
    await waitUntil(() => events.some((event) => event.type === "answer.completed"));
    await waitUntil(() => events.some((event) => event.type === "error" && event.code === "omi-read-failed"));

    const started = events.find((event): event is Extract<GatewayEvent, { type: "session.started" }> => event.type === "session.started");
    expect(started?.accepted).toEqual(expect.objectContaining({
      mode: "office-discussion",
      responseStrategy: "both",
      transcriptionProvider: { profileId: "mock", model: "mock" },
      answerProvider: { profileId: "mock", model: "mock" },
      memory: { readOmiContext: true, syncNotes: false },
    }));
    expect(JSON.stringify(events)).not.toContain("server-only");
  });

  it("emits pending before synced and never claims Omi success early", async () => {
    let resolveWrite = (_response: Response): void => undefined;
    const writeResponse = new Promise<Response>((resolve) => { resolveWrite = resolve; });
    const config = loadGatewayConfig({
      HELIX_MODE: "mock",
      HELIX_HOST: "127.0.0.1",
      HELIX_PORT: "0",
      HELIX_OMI_API_KEY: "server-only",
      HELIX_OMI_WRITE_ENABLED: "true",
    });
    const omi = new OmiClient(config.omi, async (_input, init) => {
      if (init?.method === "POST") return writeResponse;
      return new Response(JSON.stringify({ memories: [] }), { status: 200 });
    });
    const server = createGatewayServer({ config, omiClient: omi });
    openServers.push(server);
    const address = await server.listen();
    const socket = new WebSocket(address.websocketUrl, ["helix.v2"]);
    const events: GatewayEvent[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString()) as GatewayEvent));
    await once(socket, "open");
    const session = sessionConfig(address.websocketUrl, { readOmiContext: false, syncNotes: true });
    socket.send(JSON.stringify(command({ type: "session.start", session })));
    await waitUntil(() => events.some((event) => event.type === "session.started"));
    socket.send(JSON.stringify(command({
      type: "query",
      sessionId: session.sessionId,
      requestId: randomUUID(),
      text: "What should we ship first?",
      speaker: session.speaker,
    })));
    await waitUntil(() => events.some((event) =>
      event.type === "note.suggested" && event.note.persistence?.status === "pending"));
    expect(events.some((event) =>
      event.type === "note.suggested" && event.note.persistence?.status === "synced")).toBe(false);

    resolveWrite(new Response(JSON.stringify({ id: "remote-memory" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await waitUntil(() => events.some((event) =>
      event.type === "note.suggested" && event.note.persistence?.status === "synced"));
    const outcomes = events
      .filter((event): event is Extract<GatewayEvent, { type: "note.suggested" }> => event.type === "note.suggested")
      .map((event) => event.note.persistence?.status);
    expect(outcomes).toEqual(["pending", "synced"]);
    expect(events.find((event) => event.type === "note.suggested")?.type === "note.suggested"
      && events.find((event) => event.type === "note.suggested")?.note.provenance.trigger).toBe("manual");
  });

  it("keeps a local note outcome when Omi write fails", async () => {
    const config = loadGatewayConfig({
      HELIX_MODE: "mock",
      HELIX_HOST: "127.0.0.1",
      HELIX_PORT: "0",
      HELIX_OMI_API_KEY: "server-only",
      HELIX_OMI_WRITE_ENABLED: "true",
    });
    const omi = new OmiClient(config.omi, async () => new Response("unavailable", { status: 503 }));
    const server = createGatewayServer({ config, omiClient: omi });
    openServers.push(server);
    const address = await server.listen();
    const socket = new WebSocket(address.websocketUrl, ["helix.v2"]);
    const events: GatewayEvent[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString()) as GatewayEvent));
    await once(socket, "open");
    const session = sessionConfig(address.websocketUrl, { readOmiContext: false, syncNotes: true });
    socket.send(JSON.stringify(command({ type: "session.start", session })));
    await waitUntil(() => events.some((event) => event.type === "session.started"));
    socket.send(JSON.stringify(command({
      type: "query",
      sessionId: session.sessionId,
      requestId: randomUUID(),
      text: "What should we ship first?",
      speaker: session.speaker,
    })));
    await waitUntil(() => events.some((event) =>
      event.type === "note.suggested" && event.note.persistence?.status === "failed"));
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "error", code: "omi-write-failed", fatal: false }),
    ]));
  });

  it("aborts an in-flight Omi write at session end without emitting a false terminal status", async () => {
    let writeAborted = false;
    const config = loadGatewayConfig({
      HELIX_MODE: "mock",
      HELIX_HOST: "127.0.0.1",
      HELIX_PORT: "0",
      HELIX_OMI_API_KEY: "server-only",
      HELIX_OMI_WRITE_ENABLED: "true",
    });
    const omi = new OmiClient(config.omi, async (_input, init) => {
      if (init?.method !== "POST") {
        return new Response(JSON.stringify({ memories: [] }), { status: 200 });
      }
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          writeAborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    });
    const server = createGatewayServer({ config, omiClient: omi });
    openServers.push(server);
    const address = await server.listen();
    const socket = new WebSocket(address.websocketUrl, ["helix.v2"]);
    const events: GatewayEvent[] = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString()) as GatewayEvent));
    await once(socket, "open");
    const session = sessionConfig(address.websocketUrl, { readOmiContext: false, syncNotes: true });
    socket.send(JSON.stringify(command({ type: "session.start", session })));
    await waitUntil(() => events.some((event) => event.type === "session.started"));
    socket.send(JSON.stringify(command({
      type: "query",
      sessionId: session.sessionId,
      requestId: randomUUID(),
      text: "What should we ship first?",
      speaker: session.speaker,
    })));
    await waitUntil(() => events.some((event) =>
      event.type === "note.suggested" && event.note.persistence?.status === "pending"));

    socket.send(JSON.stringify(command({
      type: "session.end",
      sessionId: session.sessionId,
      reason: "user",
    })));
    await waitUntil(() => writeAborted);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const noteStatuses = events
      .filter((event): event is Extract<GatewayEvent, { type: "note.suggested" }> => event.type === "note.suggested")
      .map((event) => event.note.persistence?.status);
    expect(noteStatuses).toEqual(["pending"]);
    expect(events.some((event) => event.type === "error" && event.code === "omi-write-failed")).toBe(false);
    expect(events.some((event) => event.type === "session.ended")).toBe(true);
  });
});
