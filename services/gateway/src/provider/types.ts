import type {
  EndpointConfig,
  ProviderProfileSelection,
  ResponseTrigger,
  SessionStartCredentials,
} from "@helix/conversation-sdk";

export interface TranscriptionRequest {
  readonly pcm16: Uint8Array;
  readonly language?: string;
  readonly signal?: AbortSignal;
}

export interface TranscriptionResult {
  readonly text: string;
}

export interface ChatMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface AnswerRequest {
  readonly question: string;
  readonly protectedSystemPrompt: string;
  readonly clientPrompt?: string;
  readonly memoryContext?: string;
  readonly trigger?: ResponseTrigger;
  readonly history: readonly ChatMessage[];
  readonly signal?: AbortSignal;
}

export interface TranscriptionProvider {
  readonly selection: ProviderProfileSelection;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

export interface RealtimeTranscriptionSession {
  sendAudio(pcm16: Uint8Array): void;
  finish(): Promise<TranscriptionResult>;
  abort(): void;
}

export interface RealtimeTranscriptionProvider extends TranscriptionProvider {
  startRealtime(request: Omit<TranscriptionRequest, "pcm16">): RealtimeTranscriptionSession;
}

export function supportsRealtimeTranscription(
  provider: TranscriptionProvider,
): provider is RealtimeTranscriptionProvider {
  return "startRealtime" in provider && typeof provider.startRealtime === "function";
}

export interface AnswerProvider {
  readonly selection: ProviderProfileSelection;
  streamAnswer(request: AnswerRequest): AsyncIterable<string>;
}

/** Compatibility shape for callers that inject one provider for both operations. */
export interface ConversationProvider extends TranscriptionProvider, AnswerProvider {
  readonly endpoint: EndpointConfig;
}

export interface ProviderRegistry {
  resolveTranscription(profileId?: string, credentials?: SessionStartCredentials): TranscriptionProvider | undefined;
  resolveAnswer(profileId?: string, credentials?: SessionStartCredentials): AnswerProvider | undefined;
  isTranscriptionProfileAllowed?(profileId: string): boolean;
  isAnswerProfileAllowed?(profileId: string): boolean;
  publicEndpoint(answerProvider: AnswerProvider): EndpointConfig;
}

export type ProviderErrorCode =
  | "provider-authentication"
  | "provider-rate-limit"
  | "provider-timeout"
  | "provider-unavailable"
  | "provider-response"
  | "provider-profile-not-allowed";

export class ProviderError extends Error {
  public constructor(
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
