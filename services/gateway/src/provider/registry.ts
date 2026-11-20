import type { EndpointConfig, SessionStartCredentials } from "@helix/conversation-sdk";
import type { GatewayConfig } from "../config.js";
import { publicProviderDescriptor } from "../config.js";
import { DeepgramTranscriptionProvider } from "./deepgram.js";
import { defaultFetch, type FetchLike } from "./http.js";
import { MockConversationProvider } from "./mock.js";
import {
  OpenAICompatibleAnswerProvider,
  OpenAICompatibleTranscriptionProvider,
} from "./openai-compatible.js";
import { OpenAIResponsesAnswerProvider } from "./openai-responses.js";
import { SonioxTranscriptionProvider, type SonioxSocketFactory } from "./soniox.js";
import type {
  AnswerProvider,
  ConversationProvider,
  ProviderRegistry,
  TranscriptionProvider,
} from "./types.js";

export interface ProviderRegistryOptions {
  readonly fetch?: FetchLike;
  readonly sonioxSocketFactory?: SonioxSocketFactory;
}

export class ConfiguredProviderRegistry implements ProviderRegistry {
  private readonly fetchImpl: FetchLike;
  private readonly sonioxSocketFactory?: SonioxSocketFactory;

  public constructor(
    private readonly config: GatewayConfig,
    options: ProviderRegistryOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? defaultFetch;
    this.sonioxSocketFactory = options.sonioxSocketFactory;
  }

  public resolveTranscription(
    profileId = this.config.defaultTranscriptionProfile,
    credentials?: SessionStartCredentials,
  ): TranscriptionProvider | undefined {
    if (!this.isTranscriptionProfileAllowed(profileId)) return undefined;
    const profile = this.config.transcriptionProfiles[profileId];
    if (profile === undefined) return undefined;
    if (profile.kind === "mock") {
      return new MockConversationProvider(
        this.config.mockTranscript,
        publicProviderDescriptor(this.config),
        { profileId, model: profile.model },
      );
    }
    if (profile.kind === "openai-compatible") {
      const apiKey = credentials?.openai ?? (profile.apiKey.trim() || undefined);
      return apiKey === undefined
        ? undefined
        : new OpenAICompatibleTranscriptionProvider({ ...profile, apiKey }, this.fetchImpl);
    }
    if (profile.kind === "deepgram") {
      const apiKey = credentials?.deepgram ?? (profile.apiKey.trim() || undefined);
      return apiKey === undefined
        ? undefined
        : new DeepgramTranscriptionProvider({ ...profile, apiKey }, this.fetchImpl);
    }
    if (profile.kind === "soniox") {
      const apiKey = credentials?.soniox ?? (profile.apiKey.trim() || undefined);
      return apiKey === undefined
        ? undefined
        : new SonioxTranscriptionProvider({ ...profile, apiKey }, this.sonioxSocketFactory);
    }
    return undefined;
  }

  public resolveAnswer(
    profileId = this.config.defaultAnswerProfile,
    credentials?: SessionStartCredentials,
  ): AnswerProvider | undefined {
    if (!this.isAnswerProfileAllowed(profileId)) return undefined;
    const profile = this.config.answerProfiles[profileId];
    if (profile === undefined) return undefined;
    if (profile.kind === "mock") {
      return new MockConversationProvider(this.config.mockTranscript, publicProviderDescriptor(this.config, profileId));
    }
    const apiKey = credentials?.openai ?? (profile.apiKey.trim() || undefined);
    if (apiKey === undefined) return undefined;
    const resolved = { ...profile, apiKey };
    return resolved.kind === "openai-compatible"
      ? new OpenAICompatibleAnswerProvider(resolved, this.fetchImpl)
      : new OpenAIResponsesAnswerProvider(resolved, this.fetchImpl);
  }

  public isTranscriptionProfileAllowed(profileId: string): boolean {
    return this.config.allowedTranscriptionProfiles.includes(profileId)
      && this.config.transcriptionProfiles[profileId] !== undefined;
  }

  public isAnswerProfileAllowed(profileId: string): boolean {
    return this.config.allowedAnswerProfiles.includes(profileId)
      && this.config.answerProfiles[profileId] !== undefined;
  }

  public publicEndpoint(answerProvider: AnswerProvider): EndpointConfig {
    return publicProviderDescriptor(this.config, answerProvider.selection.profileId);
  }
}

export class SingleProviderRegistry implements ProviderRegistry {
  public constructor(private readonly provider: ConversationProvider) {}

  public resolveTranscription(_profileId?: string, _credentials?: SessionStartCredentials): TranscriptionProvider {
    return this.provider;
  }

  public resolveAnswer(_profileId?: string, _credentials?: SessionStartCredentials): AnswerProvider {
    return this.provider;
  }

  public publicEndpoint(_answerProvider: AnswerProvider): EndpointConfig {
    return this.provider.endpoint;
  }

  public isTranscriptionProfileAllowed(_profileId: string): boolean { return true; }

  public isAnswerProfileAllowed(_profileId: string): boolean { return true; }
}
