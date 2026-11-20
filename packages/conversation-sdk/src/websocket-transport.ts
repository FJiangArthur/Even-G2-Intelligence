import type {
  ConversationTransport,
  GatewayEventListener,
  TransportState,
  TransportStateListener,
} from "./transport.js";
import {
  isBrowserSafeEndpointUrl,
  isGatewayEvent,
  type AudioFrame,
  type AudioFrameCommand,
  type ClientCommand,
} from "./types.js";

export interface WebSocketEventLike {
  readonly data?: unknown;
}

export interface WebSocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: WebSocketEventLike) => void): void;
  removeEventListener(type: "open" | "message" | "error" | "close", listener: (event: WebSocketEventLike) => void): void;
}

export type WebSocketFactory = (url: string, protocols?: string | readonly string[]) => WebSocketLike;

/**
 * Builds the browser-safe, memory-only auth negotiation used by Helix gateways.
 * Treat the token as short lived only when a trusted edge actually enforces
 * expiry; provider credentials never belong here.
 */
export function helixWebSocketProtocols(gatewayAccessToken?: string): readonly string[] {
  if (!gatewayAccessToken) return ["helix.v2"];
  return ["helix.v2", `helix-auth.${base64UrlEncode(gatewayAccessToken)}`];
}

export function browserWebSocketFactory(url: string, protocols?: string | readonly string[]): WebSocketLike {
  const WebSocketConstructor = globalThis.WebSocket;
  if (!WebSocketConstructor) {
    throw new Error("WebSocket is unavailable; inject a WebSocketFactory");
  }
  return new WebSocketConstructor(url, protocols as string | string[] | undefined);
}

export interface WebSocketConversationTransportOptions {
  readonly url: string;
  readonly protocols?: string | readonly string[];
  readonly factory?: WebSocketFactory;
  readonly connectTimeoutMs?: number;
  readonly onProtocolError?: (error: Error, payload: unknown) => void;
}

interface RuntimeListeners {
  readonly socket: WebSocketLike;
  readonly message: (event: WebSocketEventLike) => void;
  readonly close: (event: WebSocketEventLike) => void;
  readonly error: (event: WebSocketEventLike) => void;
}

const WS_OPEN = 1;

export class WebSocketConversationTransport implements ConversationTransport {
  private socket?: WebSocketLike;
  private runtimeListeners?: RuntimeListeners;
  private readonly listeners = new Set<GatewayEventListener>();
  private readonly stateListeners = new Set<TransportStateListener>();
  private currentState: TransportState = "idle";
  private connectionGeneration = 0;
  private sendTail: Promise<void> = Promise.resolve();

  public constructor(private readonly options: WebSocketConversationTransportOptions) {
    if (!isBrowserSafeEndpointUrl(options.url)) {
      throw new Error("WebSocket URL must be a credential-free ws:// or wss:// gateway URL without query or fragment data");
    }
    if (
      options.connectTimeoutMs !== undefined &&
      (!Number.isFinite(options.connectTimeoutMs) || options.connectTimeoutMs <= 0)
    ) {
      throw new RangeError("connectTimeoutMs must be greater than zero");
    }
  }

  public get state(): TransportState {
    return this.currentState;
  }

  public async connect(): Promise<void> {
    if (this.currentState === "open") return;
    if (this.currentState === "connecting") throw new Error("Transport is already connecting");

    const generation = this.connectionGeneration + 1;
    this.connectionGeneration = generation;
    this.sendTail = Promise.resolve();
    this.setState("connecting");
    const factory = this.options.factory ?? browserWebSocketFactory;

    let socket: WebSocketLike;
    try {
      socket = factory(
        this.options.url,
        this.options.protocols ?? helixWebSocketProtocols(),
      );
    } catch (error) {
      this.setState("failed");
      throw error;
    }
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timeoutMs = this.options.connectTimeoutMs ?? 10_000;
      let settled = false;
      const timeout = globalThis.setTimeout(() => {
        fail(new Error(`WebSocket connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const cleanupHandshake = () => {
        globalThis.clearTimeout(timeout);
        socket.removeEventListener("open", handleOpen);
        socket.removeEventListener("error", handleError);
        socket.removeEventListener("close", handleEarlyClose);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanupHandshake();
        if (this.isCurrent(socket, generation)) {
          this.socket = undefined;
          safeClose(socket, 4000, "connection failed");
          this.setState("failed");
        }
        reject(error);
      };
      const handleOpen = () => {
        if (settled || !this.isCurrent(socket, generation)) return;
        settled = true;
        cleanupHandshake();
        this.installRuntimeListeners(socket, generation);
        this.setState("open");
        resolve();
      };
      const handleError = () => fail(new Error("WebSocket connection failed"));
      const handleEarlyClose = () => fail(new Error("WebSocket closed before opening"));

      socket.addEventListener("open", handleOpen);
      socket.addEventListener("error", handleError);
      socket.addEventListener("close", handleEarlyClose);
    });
  }

  public async disconnect(code = 1000, reason = "client disconnect"): Promise<void> {
    const socket = this.socket;
    this.connectionGeneration += 1;
    this.socket = undefined;
    if (!socket) {
      this.setState("closed");
      return;
    }

    this.setState("closing");
    this.removeRuntimeListeners(socket);
    safeClose(socket, code, reason);
    this.setState("closed");
  }

  public send(command: ClientCommand): Promise<void> {
    let serialized: string;
    try {
      serialized = JSON.stringify(command);
    } catch (error) {
      return Promise.reject(error);
    }
    const generation = this.connectionGeneration;
    return this.enqueueSend(() => {
      const socket = this.requireOpenSocket(generation);
      try {
        socket.send(serialized);
      } catch (error) {
        this.failSocket(socket, generation, "WebSocket command send failed");
        throw asError(error, "WebSocket command send failed");
      }
    });
  }

  public sendAudioFrame(command: AudioFrameCommand, frame: AudioFrame): Promise<void> {
    let payload: ArrayBuffer;
    try {
      validateAudioPair(command, frame);
      payload = encodePcm16LittleEndian(frame.samples);
    } catch (error) {
      return Promise.reject(error);
    }
    const serialized = JSON.stringify(command);
    const generation = this.connectionGeneration;
    return this.enqueueSend(() => {
      const socket = this.requireOpenSocket(generation);
      try {
        socket.send(serialized);
        socket.send(payload);
      } catch (error) {
        // Once either half throws, the peer's frame boundary is unknowable.
        this.failSocket(socket, generation, "WebSocket audio frame send failed");
        throw asError(error, "WebSocket audio frame send failed");
      }
    });
  }

  public subscribe(listener: GatewayEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public subscribeState(listener: TransportStateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private installRuntimeListeners(socket: WebSocketLike, generation: number): void {
    const message = (event: WebSocketEventLike) => {
      if (!this.isCurrent(socket, generation)) return;
      this.handleMessage(event);
    };
    const close = () => {
      if (!this.isCurrent(socket, generation)) return;
      this.removeRuntimeListeners(socket);
      this.socket = undefined;
      this.setState("closed");
    };
    const error = () => {
      if (!this.isCurrent(socket, generation)) return;
      this.failSocket(socket, generation, "WebSocket connection failed");
    };
    this.runtimeListeners = { socket, message, close, error };
    socket.addEventListener("message", message);
    socket.addEventListener("close", close);
    socket.addEventListener("error", error);
  }

  private handleMessage(event: WebSocketEventLike): void {
    if (typeof event.data !== "string") {
      this.reportProtocolError(new Error("Gateway events must be JSON text"), event.data);
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      this.reportProtocolError(new Error("Gateway event is not valid JSON"), event.data);
      return;
    }

    if (!isGatewayEvent(payload)) {
      this.reportProtocolError(new Error("Gateway event has an invalid envelope"), payload);
      return;
    }
    for (const listener of [...this.listeners]) listener(payload);
  }

  private enqueueSend(operation: () => void): Promise<void> {
    const queued = this.sendTail.then(operation);
    this.sendTail = queued.catch(() => undefined);
    return queued;
  }

  private requireOpenSocket(generation: number): WebSocketLike {
    if (
      generation !== this.connectionGeneration ||
      this.currentState !== "open" ||
      !this.socket ||
      this.socket.readyState !== WS_OPEN
    ) {
      throw new Error("WebSocket transport is not open");
    }
    return this.socket;
  }

  private failSocket(socket: WebSocketLike, generation: number, reason: string): void {
    if (!this.isCurrent(socket, generation)) return;
    this.removeRuntimeListeners(socket);
    this.socket = undefined;
    this.connectionGeneration += 1;
    safeClose(socket, 4001, reason);
    this.setState("failed");
  }

  private isCurrent(socket: WebSocketLike, generation: number): boolean {
    return this.socket === socket && this.connectionGeneration === generation;
  }

  private removeRuntimeListeners(socket: WebSocketLike): void {
    const listeners = this.runtimeListeners;
    if (!listeners || listeners.socket !== socket) return;
    socket.removeEventListener("message", listeners.message);
    socket.removeEventListener("close", listeners.close);
    socket.removeEventListener("error", listeners.error);
    this.runtimeListeners = undefined;
  }

  private reportProtocolError(error: Error, payload: unknown): void {
    this.options.onProtocolError?.(error, payload);
  }

  private setState(state: TransportState): void {
    if (state === this.currentState) return;
    this.currentState = state;
    for (const listener of [...this.stateListeners]) listener(state);
  }
}

function validateAudioPair(command: AudioFrameCommand, frame: AudioFrame): void {
  if (
    command.type !== "audio.frame" ||
    command.sampleRateHz !== 16000 ||
    command.channels !== 1 ||
    frame.sampleRateHz !== 16000 ||
    frame.channels !== 1
  ) {
    throw new Error("Only mono PCM16 at 16kHz is supported");
  }
  if (!(frame.samples instanceof Int16Array) || frame.samples.length === 0) {
    throw new Error("Audio must be a non-empty Int16Array");
  }
  if (
    command.sessionId !== frame.sessionId ||
    command.sequence !== frame.sequence ||
    command.sampleCount !== frame.samples.length ||
    command.source !== frame.source ||
    command.direction !== frame.direction ||
    command.speakerRole !== frame.speakerRole ||
    command.capturedAt !== frame.capturedAt
  ) {
    throw new Error("Audio metadata does not match its PCM payload");
  }
}

function encodePcm16LittleEndian(samples: Int16Array): ArrayBuffer {
  const encoded = new ArrayBuffer(samples.length * Int16Array.BYTES_PER_ELEMENT);
  const view = new DataView(encoded);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * Int16Array.BYTES_PER_ELEMENT, samples[index] ?? 0, true);
  }
  return encoded;
}

function safeClose(socket: WebSocketLike, code: number, reason: string): void {
  try {
    socket.close(code, reason.slice(0, 123));
  } catch {
    // The socket is already unusable; local state is authoritative here.
  }
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/=/gu, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}
