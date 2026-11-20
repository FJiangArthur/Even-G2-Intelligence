import type {
  AudioFrame,
  AudioFrameCommand,
  ClientCommand,
  ConversationTransport,
  GatewayEvent,
  GatewayEventListener,
  TransportState,
  TransportStateListener,
} from "../src/index.js";

export class FakeTransport implements ConversationTransport {
  public state: TransportState = "idle";
  public readonly commands: ClientCommand[] = [];
  public readonly audioFrames: AudioFrame[] = [];
  private readonly listeners = new Set<GatewayEventListener>();
  private readonly stateListeners = new Set<TransportStateListener>();

  public async connect(): Promise<void> {
    this.setState("connecting");
    this.setState("open");
  }

  public async disconnect(): Promise<void> {
    this.setState("closed");
  }

  public async send(command: ClientCommand): Promise<void> {
    this.commands.push(command);
  }

  public async sendAudioFrame(command: AudioFrameCommand, frame: AudioFrame): Promise<void> {
    this.commands.push(command);
    this.audioFrames.push(frame);
  }

  public subscribe(listener: GatewayEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public subscribeState(listener: TransportStateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  public emit(event: GatewayEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  public emitState(state: TransportState): void {
    this.setState(state);
  }

  private setState(state: TransportState): void {
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }
}
