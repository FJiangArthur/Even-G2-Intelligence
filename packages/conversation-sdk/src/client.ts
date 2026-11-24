import {
  validateAutomaticNoteCandidate,
  type NoteSaveResult,
  type NoteSink,
} from "./notes.js";
import type { ConversationTransport, TransportState } from "./transport.js";
import {
  HELIX_PROTOCOL_VERSION,
  isConversationMode,
  isGatewayEvent,
  normalizeSessionStartCredentials,
  normalizeSessionConfig,
  type AudioFrameCommand,
  type AudioFrameMetadata,
  type ClientCommand,
  type ContextScope,
  type GatewayEvent,
  type NoteSuggestedEvent,
  type ConversationMode,
  type MemorySettings,
  type NormalizedSessionConfig,
  type ResponseStrategy,
  type SessionConfig,
  type SessionStartedEvent,
  type SessionStartCredentials,
  type Speaker,
} from "./types.js";
import { Pcm16Vad, type Pcm16VadOptions, type VadDecision } from "./vad.js";

export type ConversationClientState =
  | "idle"
  | "connecting"
  | "starting"
  | "active"
  | "stopping"
  | "stopped"
  | "failed";

export interface HelixConversationClientOptions {
  readonly vad?: Pcm16Vad | Pcm16VadOptions | false;
  readonly noteSink?: NoteSink;
  readonly autoSaveSuggestedNotes?: boolean;
  readonly startAcknowledgementTimeoutMs?: number;
  readonly clock?: () => Date;
  readonly idFactory?: (prefix: string) => string;
  readonly onListenerError?: (error: unknown) => void;
  readonly onNoteSaved?: (event: NoteSuggestedEvent, result: NoteSaveResult) => void;
  readonly onNoteError?: (event: NoteSuggestedEvent, error: unknown) => void;
}

export type ConversationEventListener = (event: GatewayEvent) => void;
export type ConversationStateListener = (state: ConversationClientState) => void;

export class HelixProtocolError extends Error {
  public override readonly name = "HelixProtocolError";

  public constructor(
    public readonly code: "SESSION_ACCEPTANCE_MISMATCH",
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

interface PendingStart {
  readonly generation: number;
  readonly sessionId: string;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  timer?: ReturnType<typeof globalThis.setTimeout>;
  settled: boolean;
}

interface SessionAcceptanceExpectations {
  readonly mode?: ConversationMode;
  readonly responseStrategy?: ResponseStrategy;
  readonly transcriptionProvider?: string;
  readonly answerProvider?: string;
  readonly memory?: MemorySettings;
  readonly automation?: NonNullable<SessionConfig["automation"]>;
}

const DEFAULT_START_ACKNOWLEDGEMENT_TIMEOUT_MS = 10_000;
const MAX_SEEN_EVENT_IDS = 4_096;

let fallbackIdCounter = 0;

export class HelixConversationClient {
  private clientState: ConversationClientState = "idle";
  private config?: NormalizedSessionConfig;
  private acceptanceExpectations: SessionAcceptanceExpectations = {};
  private audioSequence = 0;
  private lastCommittedSequence = 0;
  private uncommittedSamples = 0;
  private acceptingOperations = false;
  private lifecycleGeneration = 0;
  private pendingStart?: PendingStart;
  private audioTail: Promise<void> = Promise.resolve();
  private readonly seenEventIds = new Set<string>();
  private readonly seenEventTypes = new Map<string, GatewayEvent["type"]>();
  private readonly seenEventIdOrder: string[] = [];
  private disposed = false;
  private disposePromise?: Promise<void>;
  private readonly eventListeners = new Set<ConversationEventListener>();
  private readonly stateListeners = new Set<ConversationStateListener>();
  private readonly vad?: Pcm16Vad;
  private readonly clock: () => Date;
  private readonly idFactory: (prefix: string) => string;
  private readonly startAcknowledgementTimeoutMs: number;
  private readonly unsubscribeTransportEvent: () => void;
  private readonly unsubscribeTransportState: () => void;

  public constructor(
    private readonly transport: ConversationTransport,
    private readonly options: HelixConversationClientOptions = {},
  ) {
    this.vad = options.vad === false
      ? undefined
      : options.vad instanceof Pcm16Vad
        ? options.vad
        : new Pcm16Vad(options.vad);
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.startAcknowledgementTimeoutMs = options.startAcknowledgementTimeoutMs ??
      DEFAULT_START_ACKNOWLEDGEMENT_TIMEOUT_MS;
    if (!Number.isFinite(this.startAcknowledgementTimeoutMs) || this.startAcknowledgementTimeoutMs <= 0) {
      throw new RangeError("startAcknowledgementTimeoutMs must be greater than zero");
    }
    this.unsubscribeTransportEvent = transport.subscribe(this.handleGatewayEvent);
    this.unsubscribeTransportState = transport.subscribeState(this.handleTransportState);
  }

  public get state(): ConversationClientState {
    return this.clientState;
  }

  public get sessionId(): string | undefined {
    return this.config?.sessionId;
  }

  /** Resolves only after a matching, schema-valid `session.started` event. */
  public async start(config: SessionConfig, credentials?: SessionStartCredentials): Promise<void> {
    this.requireNotDisposed();
    if (!["idle", "stopped", "failed"].includes(this.clientState)) {
      throw new Error(`Cannot start a conversation while client is ${this.clientState}`);
    }
    const normalizedConfig = normalizeSessionConfig(config);
    const normalizedCredentials = normalizeSessionStartCredentials(credentials);
    const generation = this.lifecycleGeneration + 1;
    this.lifecycleGeneration = generation;
    this.config = normalizedConfig;
    this.acceptanceExpectations = createSessionAcceptanceExpectations(config, normalizedConfig);
    this.audioSequence = 0;
    this.lastCommittedSequence = 0;
    this.uncommittedSamples = 0;
    this.seenEventIds.clear();
    this.seenEventTypes.clear();
    this.seenEventIdOrder.length = 0;
    this.acceptingOperations = false;
    this.audioTail = Promise.resolve();
    this.vad?.reset();
    const acknowledgement = this.createPendingStart(generation, normalizedConfig.sessionId);
    // A close/fatal event may reject before connect() settles. Mark it handled
    // immediately while preserving the original promise for the await below.
    void acknowledgement.catch(() => undefined);
    this.setState("connecting");

    try {
      await this.transport.connect();
      this.ensureCurrentStart(generation);
      this.setState("starting");
      await this.transport.send(this.command({
        type: "session.start",
        session: this.config,
        ...(normalizedCredentials === undefined ? {} : { credentials: normalizedCredentials }),
      }));
      this.armStartAcknowledgementTimeout(generation);
      await acknowledgement;
    } catch (error) {
      const normalized = asError(error, "Conversation start failed");
      await this.failStart(generation, normalized);
      throw normalized;
    }
  }

  public async stop(reason: "user" | "client-error" | "shutdown" = "user"): Promise<void> {
    if (this.clientState === "idle" || this.clientState === "stopped") return;
    this.acceptingOperations = false;
    this.lifecycleGeneration += 1;
    this.rejectPendingStart(new Error("Conversation start was cancelled"));
    this.setState("stopping");
    await this.audioTail.catch(() => undefined);
    const config = this.config;
    let sendError: unknown;
    if (config && this.transport.state === "open") {
      try {
        await this.transport.send(this.command({
          type: "session.end",
          sessionId: config.sessionId,
          reason,
        }));
      } catch (error) {
        sendError = error;
      }
    }
    try {
      await this.transport.disconnect(1000, reason);
    } finally {
      this.vad?.reset();
      this.setState("stopped");
    }
    if (sendError) throw sendError;
  }

  public async ask(text: string, speaker?: Speaker): Promise<string> {
    return this.submitQuery(text, speaker);
  }

  public async askContext(scope: ContextScope, speaker?: Speaker): Promise<string> {
    if (scope !== "local" && scope !== "global") throw new Error("Invalid context scope");
    // v0.16: the reply is a line the wearer can read aloud (the transport builds the request: modes.ts lineRequest).
    return this.submitQuery(scope === "local" ? "Give me a line to say about the last few sentences." : "Give me a line to say from the whole conversation.", speaker, scope);
  }

  private async submitQuery(text: string, speaker?: Speaker, contextScope?: ContextScope): Promise<string> {
    this.requireActive();
    const normalized = text.trim();
    if (!normalized) throw new Error("Question text is required");
    const config = this.requireConfig();
    const requestId = this.idFactory("query");
    await this.transport.send(this.command({
      type: "query",
      sessionId: config.sessionId,
      requestId,
      text: normalized,
      ...(contextScope ? { contextScope } : {}),
      speaker: speaker ?? config.speaker,
    }));
    return requestId;
  }

  /** Sends audio and automatically commits when the configured VAD sees silence. */
  public sendAudio(
    samples: Int16Array,
    metadata: AudioFrameMetadata = {},
  ): Promise<VadDecision | undefined> {
    this.requireActive();
    if (!(samples instanceof Int16Array) || samples.length === 0) {
      return Promise.reject(new Error("Audio must be a non-empty Int16Array"));
    }
    validateAudioMetadata(metadata);
    const copiedSamples = new Int16Array(samples);
    const copiedMetadata = { ...metadata };
    const generation = this.lifecycleGeneration;
    return this.enqueueAudio(async () => {
      this.ensureActiveGeneration(generation);
      const config = this.requireConfig();
      let decision: VadDecision | undefined;
      for (let offset = 0; offset < copiedSamples.length;) {
        this.ensureActiveGeneration(generation);
        // A rejected commit leaves its audio intact. Retry it before accepting
        // another frame so a full segment can never produce an empty slice.
        if (this.uncommittedSamples >= 16000 * 6) await this.commitAudioNow("vad", config.speaker);
        const part = copiedSamples.subarray(offset, offset + 16000 * 6 - this.uncommittedSamples);
        offset += part.length;
        const sequence = this.audioSequence + 1;
        const command: AudioFrameCommand = this.command({
          type: "audio.frame",
          sessionId: config.sessionId,
          sequence,
          sampleCount: part.length,
          sampleRateHz: 16000,
          channels: 1,
          ...copiedMetadata,
        });
        await this.transport.sendAudioFrame(command, {
          sessionId: config.sessionId,
          sequence,
          sampleRateHz: 16000,
          channels: 1,
          samples: part,
          ...copiedMetadata,
        });
        this.audioSequence = sequence;
        this.uncommittedSamples += part.length;
        decision = this.vad?.process(part);
        if (decision?.shouldCommit || this.uncommittedSamples >= 16000 * 6) await this.commitAudioNow("vad", config.speaker);
      }
      return decision;
    });
  }

  public commitAudio(reason: "manual" | "vad" = "manual", speaker?: Speaker): Promise<void> {
    this.requireActive();
    const generation = this.lifecycleGeneration;
    return this.enqueueAudio(async () => {
      this.ensureActiveGeneration(generation);
      await this.commitAudioNow(reason, speaker ?? this.requireConfig().speaker);
    });
  }

  public subscribe(listener: ConversationEventListener): () => void {
    this.requireNotDisposed();
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  public subscribeState(listener: ConversationStateListener): () => void {
    this.requireNotDisposed();
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Closes the transport and terminalizes the client; safe to await repeatedly. */
  public dispose(): Promise<void> {
    this.disposePromise ??= this.disposeInternal();
    return this.disposePromise;
  }

  private async disposeInternal(): Promise<void> {
    this.disposed = true;
    let disposalError: unknown;
    try {
      await this.stop("shutdown");
      if (this.clientState === "idle") this.setState("stopped");
    } catch (error) {
      disposalError = error;
      try {
        await this.transport.disconnect(1000, "shutdown");
      } catch {
        // Preserve the first error while still terminalizing locally.
      }
      this.setState("stopped");
    } finally {
      this.unsubscribeTransportEvent();
      this.unsubscribeTransportState();
      this.eventListeners.clear();
      this.stateListeners.clear();
    }
    if (disposalError) throw disposalError;
  }

  private readonly handleGatewayEvent = (event: GatewayEvent): void => {
    if (!isGatewayEvent(event) || !this.config || event.sessionId !== this.config.sessionId) return;
    if (this.seenEventIds.has(event.eventId)) return;
    this.rememberEventId(event.eventId);

    if (this.clientState === "connecting" || this.clientState === "starting") {
      if (event.type === "error" && event.fatal) {
        this.acceptingOperations = false;
        this.setState("failed");
        this.rejectPendingStart(new Error(`${event.code}: ${event.message}`), this.lifecycleGeneration);
        this.emitEvent(event);
        void this.transport.disconnect(4002, "fatal start error").catch(() => undefined);
        return;
      }
      if (event.type !== "session.started" || this.clientState !== "starting") return;
      const acceptanceMismatch = this.sessionAcceptanceMismatch(event);
      if (acceptanceMismatch) {
        const error = new HelixProtocolError("SESSION_ACCEPTANCE_MISMATCH", acceptanceMismatch);
        this.acceptingOperations = false;
        this.setState("failed");
        this.rejectPendingStart(error, this.lifecycleGeneration);
        void this.transport.disconnect(4002, "invalid acknowledgement").catch(() => undefined);
        return;
      }
      this.acceptingOperations = true;
      this.setState("active");
      this.resolvePendingStart(this.lifecycleGeneration);
      this.emitEvent(event);
      return;
    }

    if (this.clientState === "active") {
      if (event.type === "session.started") return;
      if (event.type === "session.ended") {
        this.acceptingOperations = false;
        this.lifecycleGeneration += 1;
        this.vad?.reset();
        this.setState("stopped");
        this.emitEvent(event);
        void this.transport.disconnect(1000, "server ended session").catch(() => undefined);
        return;
      }
      if (event.type === "error" && event.fatal) {
        this.acceptingOperations = false;
        this.lifecycleGeneration += 1;
        this.setState("failed");
        this.emitEvent(event);
        void this.transport.disconnect(4002, "fatal gateway error").catch(() => undefined);
        return;
      }
      this.emitEvent(event);
      this.maybeAutoSaveNote(event);
      return;
    }

    if (this.clientState === "stopping" && (event.type === "session.ended" || event.type === "error")) {
      this.emitEvent(event);
    }
  };

  private readonly handleTransportState = (state: TransportState): void => {
    if (state !== "failed" && state !== "closed") return;
    if (this.clientState === "connecting" || this.clientState === "starting") {
      this.acceptingOperations = false;
      this.setState("failed");
      this.rejectPendingStart(
        new Error(state === "closed" ? "Transport closed before session acknowledgement" : "Transport failed before session acknowledgement"),
        this.lifecycleGeneration,
      );
      return;
    }
    if (!["idle", "stopping", "stopped", "failed"].includes(this.clientState)) {
      this.acceptingOperations = false;
      this.lifecycleGeneration += 1;
      this.setState("failed");
    }
  };

  private async commitAudioNow(reason: "manual" | "vad", speaker: Speaker): Promise<void> {
    if (this.audioSequence <= this.lastCommittedSequence) {
      throw new Error("No uncommitted audio is available");
    }
    const config = this.requireConfig();
    const sequence = this.audioSequence;
    await this.transport.send(this.command({
      type: "audio.commit",
      sessionId: config.sessionId,
      sequence,
      reason,
      speaker,
    }));
    this.lastCommittedSequence = sequence;
    this.uncommittedSamples = 0;
    if (reason === "manual") this.vad?.reset();
  }

  private enqueueAudio<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.audioTail.then(operation);
    this.audioTail = queued.then(() => undefined, () => undefined);
    return queued;
  }

  private command<T extends Omit<ClientCommand, "protocolVersion" | "commandId" | "sentAt">>(
    body: T,
  ): T & Pick<ClientCommand, "protocolVersion" | "commandId" | "sentAt"> {
    return {
      protocolVersion: HELIX_PROTOCOL_VERSION,
      commandId: this.idFactory("command"),
      sentAt: this.clock().toISOString(),
      ...body,
    };
  }

  private createPendingStart(generation: number, sessionId: string): Promise<void> {
    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    this.pendingStart = {
      generation,
      sessionId,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      settled: false,
    };
    return promise;
  }

  private armStartAcknowledgementTimeout(generation: number): void {
    const pending = this.pendingStart;
    if (!pending || pending.generation !== generation || pending.settled) return;
    pending.timer = globalThis.setTimeout(() => {
      const error = new Error(
        `Gateway session acknowledgement timed out after ${this.startAcknowledgementTimeoutMs}ms`,
      );
      this.acceptingOperations = false;
      this.setState("failed");
      this.rejectPendingStart(error, generation);
      void this.transport.disconnect(4002, "acknowledgement timeout").catch(() => undefined);
    }, this.startAcknowledgementTimeoutMs);
  }

  private resolvePendingStart(generation: number): void {
    const pending = this.pendingStart;
    if (!pending || pending.generation !== generation || pending.settled) return;
    pending.settled = true;
    if (pending.timer !== undefined) globalThis.clearTimeout(pending.timer);
    this.pendingStart = undefined;
    pending.resolve();
  }

  private rejectPendingStart(error: Error, generation?: number): void {
    const pending = this.pendingStart;
    if (!pending || pending.settled || (generation !== undefined && pending.generation !== generation)) return;
    pending.settled = true;
    if (pending.timer !== undefined) globalThis.clearTimeout(pending.timer);
    this.pendingStart = undefined;
    pending.reject(error);
  }

  private async failStart(generation: number, error: Error): Promise<void> {
    if (generation !== this.lifecycleGeneration) return;
    this.acceptingOperations = false;
    this.rejectPendingStart(error, generation);
    if (!this.disposed) this.setState("failed");
    try {
      await this.transport.disconnect(4002, "start failed");
    } catch {
      // The original start error remains the useful failure.
    }
    if (this.disposed) this.setState("stopped");
  }

  private ensureCurrentStart(generation: number): void {
    if (this.disposed || generation !== this.lifecycleGeneration || !this.pendingStart) {
      throw new Error("Conversation start was superseded");
    }
  }

  private ensureActiveGeneration(generation: number): void {
    if (generation !== this.lifecycleGeneration || this.clientState !== "active") {
      throw new Error("Conversation is no longer active");
    }
  }

  private sessionAcceptanceMismatch(event: SessionStartedEvent): string | undefined {
    const config = this.requireConfig();
    if (event.sessionId !== config.sessionId) {
      return `expected sessionId "${config.sessionId}" but received "${event.sessionId}"`;
    }
    if (
      event.accepted.audio.encoding !== config.audio.encoding ||
      event.accepted.audio.sampleRateHz !== config.audio.sampleRateHz ||
      event.accepted.audio.channels !== config.audio.channels
    ) {
      return "accepted.audio must acknowledge mono pcm_s16le at 16000 Hz";
    }

    const expected = this.acceptanceExpectations;
    if (expected.mode !== undefined && event.accepted.mode !== expected.mode) {
      return acceptanceFieldMismatch("accepted.mode", expected.mode, event.accepted.mode);
    }
    if (
      expected.responseStrategy !== undefined &&
      event.accepted.responseStrategy !== expected.responseStrategy
    ) {
      return acceptanceFieldMismatch(
        "accepted.responseStrategy",
        expected.responseStrategy,
        event.accepted.responseStrategy,
      );
    }
    if (
      expected.transcriptionProvider !== undefined &&
      event.accepted.transcriptionProvider?.profileId !== expected.transcriptionProvider
    ) {
      return acceptanceFieldMismatch(
        "accepted.transcriptionProvider.profileId",
        expected.transcriptionProvider,
        event.accepted.transcriptionProvider?.profileId,
      );
    }
    if (
      expected.answerProvider !== undefined &&
      event.accepted.answerProvider?.profileId !== expected.answerProvider
    ) {
      return acceptanceFieldMismatch(
        "accepted.answerProvider.profileId",
        expected.answerProvider,
        event.accepted.answerProvider?.profileId,
      );
    }
    if (expected.memory !== undefined) {
      if (event.accepted.memory === undefined) {
        return acceptanceFieldMismatch("accepted.memory", expected.memory, undefined);
      }
      if (event.accepted.memory.readOmiContext !== expected.memory.readOmiContext) {
        return acceptanceFieldMismatch(
          "accepted.memory.readOmiContext",
          expected.memory.readOmiContext,
          event.accepted.memory.readOmiContext,
        );
      }
      if (event.accepted.memory.syncNotes !== expected.memory.syncNotes) {
        return acceptanceFieldMismatch(
          "accepted.memory.syncNotes",
          expected.memory.syncNotes,
          event.accepted.memory.syncNotes,
        );
      }
    }
    if (expected.automation !== undefined) {
      if (event.accepted.automation === undefined) {
        return acceptanceFieldMismatch("accepted.automation", expected.automation, undefined);
      }
      for (const field of ["detectQuestions", "answerQuestions", "saveNotes"] as const) {
        if (event.accepted.automation[field] !== expected.automation[field]) {
          return acceptanceFieldMismatch(
            `accepted.automation.${field}`,
            expected.automation[field],
            event.accepted.automation[field],
          );
        }
      }
    }
    return undefined;
  }

  private emitEvent(event: GatewayEvent): void {
    this.seenEventTypes.set(event.eventId, event.type);
    for (const listener of [...this.eventListeners]) {
      try {
        listener(event);
      } catch (error) {
        this.options.onListenerError?.(error);
      }
    }
  }

  private maybeAutoSaveNote(event: GatewayEvent): void {
    if (
      event.type !== "note.suggested" ||
      !this.options.noteSink ||
      this.config?.automation?.saveNotes === false ||
      this.options.autoSaveSuggestedNotes === false
    ) return;

    const rejection = validateAutomaticNoteCandidate(event.note, event.sessionId);
    const provenanceRejection = this.validateObservedNoteProvenance(event);
    if (rejection || provenanceRejection) {
      this.options.onNoteSaved?.(event, {
        status: "rejected",
        reason: rejection ?? provenanceRejection,
      });
      return;
    }
    void this.options.noteSink.save(event.note).then(
      (result) => this.options.onNoteSaved?.(event, result),
      (error: unknown) => this.options.onNoteError?.(event, error),
    );
  }

  private rememberEventId(eventId: string): void {
    this.seenEventIds.add(eventId);
    this.seenEventIdOrder.push(eventId);
    if (this.seenEventIdOrder.length <= MAX_SEEN_EVENT_IDS) return;
    const removed = this.seenEventIdOrder.shift();
    if (removed !== undefined) {
      this.seenEventIds.delete(removed);
      this.seenEventTypes.delete(removed);
    }
  }

  private validateObservedNoteProvenance(event: NoteSuggestedEvent): string | undefined {
    const sourceType = this.seenEventTypes.get(event.note.provenance.sourceEventId);
    if (!sourceType) return "note source event was not observed in this session";
    const compatible = event.note.provenance.sourceType === "transcript"
      ? sourceType === "transcript.final"
      : event.note.provenance.sourceType === "question"
        ? sourceType === "question.detected"
        : event.note.provenance.sourceType === "answer"
          ? sourceType === "answer.completed"
          : sourceType !== "note.suggested" && sourceType !== "error";
    return compatible ? undefined : "note source type does not match the observed event";
  }

  private requireConfig(): NormalizedSessionConfig {
    if (!this.config) throw new Error("Conversation is not configured");
    return this.config;
  }

  private requireActive(): void {
    this.requireNotDisposed();
    if (this.clientState !== "active" || !this.acceptingOperations) {
      throw new Error(`Conversation is not active (state: ${this.clientState})`);
    }
  }

  private requireNotDisposed(): void {
    if (this.disposed) throw new Error("Conversation client is disposed");
  }

  private setState(state: ConversationClientState): void {
    if (state === this.clientState) return;
    this.clientState = state;
    for (const listener of [...this.stateListeners]) {
      try {
        listener(state);
      } catch (error) {
        this.options.onListenerError?.(error);
      }
    }
  }
}

function defaultIdFactory(prefix: string): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return `${prefix}_${randomUuid}`;
  fallbackIdCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${fallbackIdCounter.toString(36)}`;
}

function createSessionAcceptanceExpectations(
  requested: SessionConfig,
  normalized: NormalizedSessionConfig,
): SessionAcceptanceExpectations {
  const promptMode = requested.prompt.mode?.trim();
  const explicitlyRequestedKnownMode = requested.mode !== undefined ||
    promptMode === "interview" ||
    isConversationMode(promptMode);

  return {
    ...(explicitlyRequestedKnownMode ? { mode: normalized.mode } : {}),
    ...(requested.responseStrategy === undefined
      ? {}
      : { responseStrategy: normalized.responseStrategy }),
    ...(normalized.providers?.transcriptionProvider === undefined
      ? {}
      : { transcriptionProvider: normalized.providers.transcriptionProvider }),
    ...(normalized.providers?.answerProvider === undefined
      ? {}
      : { answerProvider: normalized.providers.answerProvider }),
    ...(requested.memory === undefined ? {} : { memory: { ...normalized.memory } }),
    ...(requested.automation === undefined
      ? {}
      : { automation: { ...requested.automation } }),
  };
}

function acceptanceFieldMismatch(
  field: string,
  expected: unknown,
  actual: unknown,
): string {
  const renderedActual = actual === undefined ? "omitted" : JSON.stringify(actual);
  return `${field} must acknowledge ${JSON.stringify(expected)}; gateway returned ${renderedActual}`;
}

function validateAudioMetadata(metadata: AudioFrameMetadata): void {
  if (
    metadata.direction !== undefined &&
    metadata.direction !== null &&
    (!Number.isInteger(metadata.direction) || metadata.direction < -32768 || metadata.direction > 32767)
  ) {
    throw new Error("Audio direction must be a signed 16-bit integer or null");
  }
  if (metadata.speakerRole !== undefined &&
    metadata.speakerRole !== "self" &&
    metadata.speakerRole !== "other" &&
    metadata.speakerRole !== "unknown") {
    throw new Error("Audio speakerRole is invalid");
  }
  if (metadata.capturedAt !== undefined && Number.isNaN(Date.parse(metadata.capturedAt))) {
    throw new Error("Audio capture timestamp is invalid");
  }
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}
