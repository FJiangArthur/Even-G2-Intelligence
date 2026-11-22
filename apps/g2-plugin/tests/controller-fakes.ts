/** Shared fakes for the controller integration tests: a scripted legacy socket and a recording G2 bridge. */
import {
  AudioInputSource,
  StartUpPageCreateResult,
  type CreateStartUpPageContainer,
  type EvenHubEvent,
  type TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import { G2ConversationController, type G2BridgePort } from "../src/controller";
import { GlassesRenderer } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";
import type { SessionFormState } from "../src/config";
import { WebSocketConversationTransport } from "@helix/conversation-sdk";

// Legacy protocol adapter used only to observe controller gesture ordering.
export function testController(bridge: FakeBridge, renderer: GlassesRenderer, presentation: ConversationPresentation) {
  return new G2ConversationController(bridge, renderer, presentation, () => new WebSocketConversationTransport({
    url: "ws://127.0.0.1:8787/v2/conversations", protocols: ["helix.v2", "helix-auth.c2hvcnQtbGl2ZWQtdG9rZW4"],
  }));
}

type FakeListener = (event: { data?: unknown }) => void;

export class FakeWebSocket {
  public static latest?: FakeWebSocket;
  public readyState = 0;
  public binaryType = "blob";
  public readonly sent: Array<string | ArrayBuffer | ArrayBufferView | Blob> = [];
  public readonly protocols: string | readonly string[] | undefined;
  private readonly listeners = new Map<string, Set<FakeListener>>();

  public constructor(_url: string, protocols?: string | readonly string[]) {
    this.protocols = protocols;
    FakeWebSocket.latest = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  public addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) ?? new Set<FakeListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: FakeListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  public send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    this.sent.push(data);
    if (typeof data !== "string") return;

    const message = JSON.parse(data) as Record<string, unknown>;
    if (message.type !== "session.start") return;
    const session = message.session as {
      sessionId: string;
      endpoint: object;
      prompt: { id: string; version: string };
      mode?: "general" | "interviewee" | "interviewer" | "social" | "office-discussion" | "passive";
      responseStrategy?: "reactive" | "proactive" | "both";
      providers?: {
        transcriptionProvider?: string;
        answerProvider?: string;
      };
      memory?: {
        readOmiContext: boolean;
        syncNotes: boolean;
      };
      automation?: {
        detectQuestions: boolean;
        answerQuestions: boolean;
        saveNotes: boolean;
      };
      audio: object;
    };
    queueMicrotask(() => this.emit("message", {
      data: JSON.stringify({
        protocolVersion: "2.1",
        type: "session.started",
        eventId: "event_started",
        sessionId: session.sessionId,
        occurredAt: new Date().toISOString(),
        accepted: {
          prompt: { id: session.prompt.id, version: session.prompt.version },
          endpoint: session.endpoint,
          audio: session.audio,
          mode: session.mode,
          responseStrategy: session.responseStrategy,
          transcriptionProvider: session.providers?.transcriptionProvider
            ? { profileId: session.providers.transcriptionProvider }
            : undefined,
          answerProvider: session.providers?.answerProvider
            ? { profileId: session.providers.answerProvider }
            : undefined,
          memory: session.memory,
          automation: session.automation,
        },
      }),
    }));
  }

  public close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  private emit(type: string, event: { data?: unknown }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

export class FakeBridge implements G2BridgePort {
  public readonly calls: string[] = [];
  public readonly storage = new Map<string, string>();
  public readonly updates: TextContainerUpgrade[] = [];
  public readonly shutdownModes: number[] = [];
  private eventListener?: (event: EvenHubEvent) => void;

  public async createStartUpPageContainer(
    _container: CreateStartUpPageContainer,
  ): Promise<StartUpPageCreateResult> {
    this.calls.push("startup-page");
    return StartUpPageCreateResult.success;
  }

  public async textContainerUpgrade(container: TextContainerUpgrade): Promise<boolean> {
    this.updates.push(container);
    return true;
  }

  public async audioControl(isOpen: boolean, source?: AudioInputSource): Promise<boolean> {
    this.calls.push(`audio:${String(isOpen)}:${source ?? "default"}`);
    return true;
  }

  public async shutDownPageContainer(exitMode = 0): Promise<boolean> {
    this.shutdownModes.push(exitMode);
    return true;
  }

  public onEvenHubEvent(callback: (event: EvenHubEvent) => void): () => void {
    this.eventListener = callback;
    return () => { this.eventListener = undefined; };
  }

  public async getLocalStorage(key: string): Promise<string> {
    return this.storage.get(key) ?? "";
  }

  public async setLocalStorage(key: string, value: string): Promise<boolean> {
    this.storage.set(key, value);
    return true;
  }

  public emit(event: object): void {
    this.eventListener?.(event as EvenHubEvent);
  }
}

export const form: SessionFormState = {
  copilotModel: "gpt-6-luna", copilotSummarize: true, copilotConcepts: true, copilotConflicts: true,
  copilotSuggestions: true, copilotImplicitAsks: true, copilotWebGrounding: true,
  autoExplainTerms: true,
  useLocalMemory: true,
  liveWebFactCheck: false,
  gatewayUrl: "ws://127.0.0.1:8787/v2/conversations",
  accessToken: "short-lived-token",
  openaiApiKey: "",
  deepgramApiKey: "",
  sonioxApiKey: "",
  omiApiKey: "",
  saveApiKeysOnPhone: false,
  endpointId: "test-endpoint",
  provider: "mock",
  model: "mock-fast",
  promptId: "test-prompt",
  promptVersion: "1",
  instructions: "Answer directly.",
  locale: "en",
  maxResponseSentences: 3,
  conversationMode: "interviewer",
  responseStrategy: "proactive",
  transcriptionProvider: "soniox",
  answerProvider: "openai-responses",
  autoQuestion: true,
  autoAnswer: true,
  autoNotes: true,
  readOmiContext: true,
  syncOmiNotes: true,
};
