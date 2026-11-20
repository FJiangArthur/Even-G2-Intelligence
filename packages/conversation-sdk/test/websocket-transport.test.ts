import { describe, expect, it, vi } from "vitest";
import {
  HELIX_PROTOCOL_VERSION,
  WebSocketConversationTransport,
  helixWebSocketProtocols,
  type GatewayEvent,
  type AudioFrameCommand,
  type WebSocketEventLike,
  type WebSocketLike,
} from "../src/index.js";

class FakeSocket implements WebSocketLike {
  public readyState = 0;
  public binaryType = "blob";
  public readonly sent: (string | ArrayBuffer | ArrayBufferView)[] = [];
  public readonly closeCalls: { code?: number; reason?: string }[] = [];
  public throwOnSendNumber?: number;
  private readonly listeners = new Map<string, Set<(event: WebSocketEventLike) => void>>();

  public send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.sent.length + 1 === this.throwOnSendNumber) throw new Error("injected send failure");
    this.sent.push(data);
  }

  public close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.emit("close", {});
  }

  public addEventListener(type: string, listener: (event: WebSocketEventLike) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: (event: WebSocketEventLike) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  public open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  public emit(type: string, event: WebSocketEventLike): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("WebSocketConversationTransport", () => {
  it("negotiates the Helix protocol by default", async () => {
    const socket = new FakeSocket();
    const factory = vi.fn((_url: string, protocols?: string | readonly string[]) => {
      expect(protocols).toEqual(["helix.v2"]);
      return socket;
    });
    const transport = new WebSocketConversationTransport({
      url: "ws://local",
      factory,
    });

    const connecting = transport.connect();
    socket.open();
    await connecting;

    expect(factory).toHaveBeenCalledWith("ws://local", ["helix.v2"]);
  });

  it("uses an injected browser-compatible socket and routes valid events", async () => {
    const socket = new FakeSocket();
    const protocolError = vi.fn();
    const transport = new WebSocketConversationTransport({
      url: "wss://example.test",
      protocols: helixWebSocketProtocols("temporary token"),
      factory: () => socket,
      onProtocolError: protocolError,
    });
    const eventListener = vi.fn();
    transport.subscribe(eventListener);
    const connecting = transport.connect();
    socket.open();
    await connecting;

    const event: GatewayEvent = {
      protocolVersion: HELIX_PROTOCOL_VERSION,
      type: "session.ended",
      eventId: "event-1",
      sessionId: "session-1",
      occurredAt: "2026-09-06T12:00:00.000Z",
      reason: "done",
    };
    socket.emit("message", { data: JSON.stringify(event) });
    socket.emit("message", { data: "not json" });

    expect(eventListener).toHaveBeenCalledWith(event);
    expect(protocolError).toHaveBeenCalledTimes(1);
    expect(socket.binaryType).toBe("arraybuffer");
    expect(helixWebSocketProtocols("temporary token")).toEqual([
      "helix.v2",
      "helix-auth.dGVtcG9yYXJ5IHRva2Vu",
    ]);
  });

  it("sends exact PCM view bytes without leaking its backing buffer", async () => {
    const socket = new FakeSocket();
    const transport = new WebSocketConversationTransport({ url: "ws://local", factory: () => socket });
    const connecting = transport.connect();
    socket.open();
    await connecting;
    const backing = new Int16Array([111, 222, 333]);
    const view = new Int16Array(backing.buffer, 2, 1);

    const command = audioCommand(1, 1);
    await transport.sendAudioFrame(command, {
      sessionId: "session-1",
      sequence: 1,
      sampleRateHz: 16000,
      channels: 1,
      samples: view,
    });

    expect(socket.sent).toHaveLength(2);
    expect(JSON.parse(socket.sent[0] as string)).toEqual(command);
    expect(new Int16Array(socket.sent[1] as ArrayBuffer)).toEqual(new Int16Array([222]));
  });

  it("serializes concurrent metadata and PCM pairs without interleaving commands", async () => {
    const socket = new FakeSocket();
    const transport = new WebSocketConversationTransport({ url: "ws://local", factory: () => socket });
    const connecting = transport.connect();
    socket.open();
    await connecting;

    const first = transport.sendAudioFrame(audioCommand(1, 1), audioFrame(1, [11]));
    const second = transport.sendAudioFrame(audioCommand(2, 1), audioFrame(2, [22]));
    const ending = transport.send({
      protocolVersion: HELIX_PROTOCOL_VERSION,
      commandId: "end-1",
      sentAt: "2026-09-06T12:00:00.000Z",
      type: "session.end",
      sessionId: "session-1",
      reason: "user",
    });
    await Promise.all([first, second, ending]);

    expect(socket.sent).toHaveLength(5);
    expect(JSON.parse(socket.sent[0] as string)).toMatchObject({ type: "audio.frame", sequence: 1 });
    expect(new Int16Array(socket.sent[1] as ArrayBuffer)).toEqual(new Int16Array([11]));
    expect(JSON.parse(socket.sent[2] as string)).toMatchObject({ type: "audio.frame", sequence: 2 });
    expect(new Int16Array(socket.sent[3] as ArrayBuffer)).toEqual(new Int16Array([22]));
    expect(JSON.parse(socket.sent[4] as string)).toMatchObject({ type: "session.end" });
  });

  it("fails closed when PCM send fails after its metadata envelope", async () => {
    const socket = new FakeSocket();
    const transport = new WebSocketConversationTransport({ url: "ws://local", factory: () => socket });
    const states: string[] = [];
    transport.subscribeState((state) => states.push(state));
    const connecting = transport.connect();
    socket.open();
    await connecting;
    socket.throwOnSendNumber = 2;

    await expect(transport.sendAudioFrame(audioCommand(1, 1), audioFrame(1, [11])))
      .rejects.toThrow("injected send failure");

    expect(socket.sent).toHaveLength(1);
    expect(transport.state).toBe("failed");
    expect(socket.closeCalls.at(-1)).toMatchObject({ code: 4001 });
    await expect(transport.send({
      protocolVersion: HELIX_PROTOCOL_VERSION,
      commandId: "late",
      sentAt: "2026-09-06T12:00:00.000Z",
      type: "session.end",
      sessionId: "session-1",
      reason: "client-error",
    })).rejects.toThrow("not open");
    expect(states).toContain("failed");
  });

  it("closes timed-out sockets and ignores their late events after retry", async () => {
    vi.useFakeTimers();
    try {
      const firstSocket = new FakeSocket();
      const secondSocket = new FakeSocket();
      const sockets = [firstSocket, secondSocket];
      const transport = new WebSocketConversationTransport({
        url: "ws://local",
        connectTimeoutMs: 25,
        factory: () => sockets.shift()!,
      });
      const listener = vi.fn();
      transport.subscribe(listener);
      const firstConnect = transport.connect();
      const firstConnectRejection = expect(firstConnect).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(25);
      await firstConnectRejection;
      expect(firstSocket.closeCalls).toHaveLength(1);

      const secondConnect = transport.connect();
      secondSocket.open();
      await secondConnect;
      firstSocket.open();
      firstSocket.emit("message", { data: JSON.stringify(sessionEndedEvent("late")) });
      secondSocket.emit("message", { data: JSON.stringify(sessionEndedEvent("current")) });

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ eventId: "current" }));
    } finally {
      vi.useRealTimers();
    }
  });
});

function audioCommand(sequence: number, sampleCount: number): AudioFrameCommand {
  return {
    protocolVersion: HELIX_PROTOCOL_VERSION,
    commandId: `command-${sequence}`,
    sentAt: "2026-09-06T12:00:00.000Z",
    type: "audio.frame",
    sessionId: "session-1",
    sequence,
    sampleCount,
    sampleRateHz: 16000,
    channels: 1,
  };
}

function audioFrame(sequence: number, samples: readonly number[]) {
  return {
    sessionId: "session-1",
    sequence,
    sampleRateHz: 16000 as const,
    channels: 1 as const,
    samples: new Int16Array(samples),
  };
}

function sessionEndedEvent(eventId: string): GatewayEvent {
  return {
    protocolVersion: HELIX_PROTOCOL_VERSION,
    type: "session.ended",
    eventId,
    sessionId: "session-1",
    occurredAt: "2026-09-06T12:00:00.000Z",
    reason: "done",
  };
}
