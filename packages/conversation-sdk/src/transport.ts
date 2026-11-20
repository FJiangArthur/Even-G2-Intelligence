import type { AudioFrame, AudioFrameCommand, ClientCommand, GatewayEvent } from "./types.js";

export type TransportState =
  | "idle"
  | "connecting"
  | "open"
  | "closing"
  | "closed"
  | "failed";

export type GatewayEventListener = (event: GatewayEvent) => void;
export type TransportStateListener = (state: TransportState) => void;

export interface ConversationTransport {
  readonly state: TransportState;
  connect(): Promise<void>;
  disconnect(code?: number, reason?: string): Promise<void>;
  send(command: ClientCommand): Promise<void>;
  /**
   * Sends an audio-frame envelope immediately followed by its PCM payload as
   * one serialized transport operation. Implementations must fail closed if
   * only one half can be sent because the wire stream is then ambiguous.
   */
  sendAudioFrame(command: AudioFrameCommand, frame: AudioFrame): Promise<void>;
  subscribe(listener: GatewayEventListener): () => void;
  subscribeState(listener: TransportStateListener): () => void;
}
