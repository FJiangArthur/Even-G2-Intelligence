import { randomUUID } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  HELIX_PROTOCOL_VERSION,
  normalizeSessionConfig,
  type AnswerCompletedEvent,
  type AnswerDeltaEvent,
  type AudioCommitCommand,
  type AudioFrameCommand,
  type ConversationContext,
  type GatewayErrorEvent,
  type GatewayEvent,
  type LatencyBreakdown,
  type NormalizedSessionConfig,
  type NoteCandidate,
  type QueryCommand,
  type ResponseTrigger,
  type SessionConfig,
  type SessionStartCredentials,
  type Speaker,
} from "@helix/conversation-sdk";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { authorizeWebSocket, HELIX_WEBSOCKET_PROTOCOL } from "./auth.js";
import type { GatewayConfig } from "./config.js";
import { loadGatewayConfig } from "./config.js";
import {
  modeSystemPrompt,
  proactiveInput,
  shouldAnswerDetectedQuestions,
  shouldGenerateProactiveResponse,
} from "./modes.js";
import { boundedMemoryContext, OmiClient, type OmiMemory } from "./omi.js";
import { evaluateAutomaticNote } from "./notes.js";
import { parseClientCommand } from "./protocol.js";
import { ConfiguredProviderRegistry, SingleProviderRegistry } from "./provider/registry.js";
import type {
  AnswerProvider,
  AnswerRequest,
  ChatMessage,
  ConversationProvider,
  ProviderRegistry,
  RealtimeTranscriptionSession,
  TranscriptionProvider,
} from "./provider/types.js";
import { ProviderError, supportsRealtimeTranscription } from "./provider/types.js";
import { extractQuestions, type DetectedQuestion } from "./questions.js";

const AUDIO_CONFIG = {
  encoding: "pcm_s16le",
  sampleRateHz: 16_000,
  channels: 1,
} as const;
const MAX_TEXT_COMMAND_BYTES = 64 * 1024;
const MAX_HISTORY_MESSAGES = 24;
const MAX_HISTORY_CHARACTERS = 24_000;
const MAX_ANSWER_CHARACTERS = 32_000;

interface AutomationSettings {
  readonly detectQuestions: boolean;
  readonly answerQuestions: boolean;
  readonly saveNotes: boolean;
}

interface RuntimeSession {
  readonly id: string;
  readonly input: NormalizedSessionConfig;
  readonly automation: AutomationSettings;
  readonly clientPrompt?: string;
  readonly startedAt: number;
  readonly transcriptionProvider: TranscriptionProvider;
  readonly answerProvider: AnswerProvider;
  readonly omiClient: OmiClient;
  readonly endpoint: ReturnType<ProviderRegistry["publicEndpoint"]>;
  readonly abortController: AbortController;
  active: boolean;
  omiMemories?: Promise<readonly OmiMemory[]>;
  realtimeTranscription?: RealtimeTranscriptionSession;
  audioChunks: Buffer[];
  audioBytes: number;
  receivedAudioFrames: number;
  lastCommittedSequence: number;
  pendingAudioFrame?: AudioFrameCommand;
  history: ChatMessage[];
  nextTurnSequence: number;
  nextHistorySequence: number;
  pendingHistoryTurns: Map<number, readonly ChatMessage[]>;
  acceptedNotes: string[];
}

interface AnswerResult {
  readonly sourceText: string;
  readonly questionId?: string;
  readonly trigger: ResponseTrigger;
  readonly answer: string;
  readonly completedEvent: AnswerCompletedEvent;
  readonly sourceTranscriptId?: string;
  readonly speaker: Speaker;
}

interface TimedAnswerChunk {
  readonly text: string;
  readonly receivedAt: number;
}

class BufferedAnswerStream {
  private readonly chunks: TimedAnswerChunk[] = [];
  private readonly waiters = new Set<() => void>();
  private finished = false;
  private failure?: unknown;
  private characterCount = 0;
  public completedAt?: number;

  public constructor(source: AsyncIterable<string>) {
    void this.pump(source);
  }

  public async *read(): AsyncGenerator<TimedAnswerChunk> {
    let index = 0;
    while (true) {
      while (index < this.chunks.length) {
        const chunk = this.chunks[index];
        index += 1;
        if (chunk !== undefined) yield chunk;
      }
      if (this.finished) {
        if (this.failure !== undefined) throw this.failure;
        return;
      }
      await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
  }

  private async pump(source: AsyncIterable<string>): Promise<void> {
    try {
      for await (const text of source) {
        if (text === "") continue;
        this.characterCount += text.length;
        if (this.characterCount > MAX_ANSWER_CHARACTERS) {
          throw new ProviderError("provider-response", "Provider answer exceeded the gateway limit", false);
        }
        this.chunks.push({ text, receivedAt: Date.now() });
        this.wake();
      }
      this.completedAt = Date.now();
    } catch (error) {
      this.failure = error;
    } finally {
      this.finished = true;
      this.completedAt ??= Date.now();
      this.wake();
    }
  }

  private wake(): void {
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }
}

interface AnswerTaskInput {
  readonly session: RuntimeSession;
  readonly sourceText: string;
  readonly providerInput: string;
  readonly questionId?: string;
  readonly trigger: ResponseTrigger;
  readonly sourceTranscriptId?: string;
  readonly speaker: Speaker;
  readonly history: readonly ChatMessage[];
  readonly turnStartedAt: number;
  readonly latency: Omit<LatencyBreakdown, "totalMs">;
}

interface AnswerTask {
  readonly input: AnswerTaskInput;
  readonly answerId: string;
  readonly stream: BufferedAnswerStream;
}

export interface GatewayServerAddress {
  readonly host: string;
  readonly port: number;
  readonly httpUrl: string;
  readonly websocketUrl: string;
}

export interface CreateGatewayServerOptions {
  readonly config?: GatewayConfig;
  readonly provider?: ConversationProvider;
  readonly providerRegistry?: ProviderRegistry;
  readonly omiClient?: OmiClient;
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  throw new TypeError("Unsupported WebSocket frame representation");
}

function safeCloseReason(reason: string): string {
  return Buffer.byteLength(reason, "utf8") <= 123 ? reason : "session ended";
}

function trimHistory(history: readonly ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  let characters = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message === undefined) continue;
    if (result.length >= MAX_HISTORY_MESSAGES || characters + message.content.length > MAX_HISTORY_CHARACTERS) break;
    result.unshift(message);
    characters += message.content.length;
  }
  return result;
}

class GatewayConnection {
  private session?: RuntimeSession;
  private work = Promise.resolve();

  public constructor(
    private readonly socket: WebSocket,
    private readonly config: GatewayConfig,
    private readonly providers: ProviderRegistry,
    private readonly omi: OmiClient,
  ) {
    socket.on("message", (data, isBinary) => {
      const copy = rawDataBuffer(data);
      this.work = this.work
        .then(() => isBinary ? this.handleAudio(copy) : this.handleText(copy))
        .catch((error: unknown) => this.handleUnexpectedError(error));
    });
    socket.on("close", () => this.cancelSession());
  }

  private handleAudio(audio: Buffer): void {
    const session = this.session;
    if (session === undefined) {
      this.sendError("audio-before-session", "Start a session before sending audio", false, false);
      return;
    }
    const metadata = session.pendingAudioFrame;
    session.pendingAudioFrame = undefined;
    if (metadata === undefined) {
      this.sendError("audio-metadata-required", "Send audio.frame metadata immediately before each binary frame", false, false);
      return;
    }
    if (audio.byteLength === 0 || audio.byteLength % 2 !== 0 || audio.byteLength / 2 !== metadata.sampleCount) {
      this.sendError("invalid-audio", "Audio frames must contain complete little-endian PCM16 samples", false, false);
      return;
    }
    if (metadata.sequence !== session.receivedAudioFrames + 1) {
      this.sendError("audio-sequence", "audio.frame sequence must increase by one", false, false);
      return;
    }
    if (session.audioBytes + audio.byteLength > this.config.maxAudioBytes) {
      session.realtimeTranscription?.abort();
      delete session.realtimeTranscription;
      session.audioChunks = [];
      session.audioBytes = 0;
      session.receivedAudioFrames = metadata.sequence;
      session.lastCommittedSequence = metadata.sequence;
      this.sendError("audio-limit", "Uncommitted audio exceeded the configured byte limit and was cleared", false, false);
      return;
    }
    session.audioChunks.push(audio);
    session.audioBytes += audio.byteLength;
    session.receivedAudioFrames = metadata.sequence;
    if (supportsRealtimeTranscription(session.transcriptionProvider)) {
      try {
        session.realtimeTranscription ??= session.transcriptionProvider.startRealtime({
          ...(session.input.locale === undefined ? {} : { language: session.input.locale }),
          signal: session.abortController.signal,
        });
        session.realtimeTranscription.sendAudio(audio);
      } catch (error) {
        session.realtimeTranscription?.abort();
        delete session.realtimeTranscription;
        this.sendProviderError(error, session.id);
      }
    }
  }

  private handleText(bytes: Buffer): void {
    if (bytes.byteLength > MAX_TEXT_COMMAND_BYTES) {
      this.sendError("command-too-large", "JSON commands are limited to 64 KiB", false, false);
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(bytes.toString("utf8"));
    } catch {
      this.sendError("invalid-json", "Text frames must contain valid JSON", false, false);
      return;
    }
    const parsed = parseClientCommand(payload);
    if (!parsed.ok) {
      this.sendError(parsed.code, parsed.message, false, parsed.fatal, parsed.sessionId);
      if (parsed.fatal) this.socket.close(1008, "invalid session command");
      return;
    }
    const { command } = parsed;
    if (command.type === "session.start") {
      this.startSession(command.session, command.credentials);
      return;
    }
    const session = this.session;
    if (session === undefined) {
      this.sendError("session-not-started", "Start a session before sending commands", false, false, command.sessionId);
      return;
    }
    if (command.sessionId !== session.id) {
      this.sendError("session-mismatch", "Command sessionId does not match the active session", false, false);
      return;
    }
    if (command.type === "session.end") {
      this.endSession(command.reason);
    } else if (command.type === "audio.commit") {
      this.commitAudio(command);
    } else if (command.type === "audio.frame") {
      this.prepareAudioFrame(command);
    } else {
      this.handleQuery(command);
    }
  }

  private startSession(input: SessionConfig, credentials?: SessionStartCredentials): void {
    if (this.session !== undefined) {
      this.sendError("session-already-started", "One active session is allowed per socket", false, true);
      this.socket.close(1008, "session already started");
      return;
    }
    let normalized: NormalizedSessionConfig;
    try {
      normalized = normalizeSessionConfig(input);
    } catch {
      this.sendError("invalid-session", "Session configuration could not be normalized", false, true, input.sessionId);
      this.socket.close(1008, "invalid session");
      return;
    }
    const transcriptionId = normalized.providers?.transcriptionProvider ?? this.config.defaultTranscriptionProfile;
    const answerId = normalized.providers?.answerProvider ?? this.config.defaultAnswerProfile;
    const transcriptionAllowed = this.providers.isTranscriptionProfileAllowed?.(transcriptionId) ?? true;
    const answerAllowed = this.providers.isAnswerProfileAllowed?.(answerId) ?? true;
    if (!transcriptionAllowed || !answerAllowed) {
      this.sendError(
        "provider-profile-not-allowed",
        "The requested provider profile is unavailable or not allowlisted",
        false,
        true,
        normalized.sessionId,
      );
      this.socket.close(1008, "provider profile unavailable");
      return;
    }
    const transcriptionProvider = this.providers.resolveTranscription(transcriptionId, credentials);
    const answerProvider = this.providers.resolveAnswer(answerId, credentials);
    if (transcriptionProvider === undefined || answerProvider === undefined) {
      this.sendError(
        "provider-credential-required",
        "The selected provider requires an API key on this session or Helix server",
        false,
        true,
        normalized.sessionId,
      );
      this.socket.close(1008, "provider credential required");
      return;
    }
    const usesOmi = normalized.memory.readOmiContext || normalized.memory.syncNotes;
    const omiClient = usesOmi && credentials?.omi !== undefined
      ? this.omi.withApiKey(credentials.omi)
      : this.omi;
    if (normalized.memory.readOmiContext && !omiClient.configured) {
      this.sendError(
        "omi-not-configured",
        "Omi context was requested but is not configured on this gateway",
        false,
        true,
        normalized.sessionId,
      );
      this.socket.close(1008, "Omi context unavailable");
      return;
    }
    if (normalized.memory.syncNotes && (!omiClient.configured || !this.config.omi.writeEnabled)) {
      this.sendError(
        "omi-write-disabled",
        "Omi note sync was requested but is not enabled on this gateway",
        false,
        true,
        normalized.sessionId,
      );
      this.socket.close(1008, "Omi note sync unavailable");
      return;
    }
    const automation = normalized.automation ?? {
      detectQuestions: true,
      answerQuestions: true,
      saveNotes: true,
    };
    const promptParts: string[] = [];
    if (this.config.prompt.allowClientPrompt) promptParts.push(normalized.prompt.system.trim());
    if (normalized.prompt.maxResponseSentences !== undefined) {
      promptParts.push(`Respond in at most ${normalized.prompt.maxResponseSentences} sentences.`);
    }
    const clientPrompt = promptParts.filter(Boolean).join("\n");
    const session: RuntimeSession = {
      id: normalized.sessionId,
      input: normalized,
      automation,
      ...(clientPrompt === "" ? {} : { clientPrompt }),
      startedAt: Date.now(),
      transcriptionProvider,
      answerProvider,
      omiClient,
      endpoint: this.providers.publicEndpoint(answerProvider),
      abortController: new AbortController(),
      active: true,
      audioChunks: [],
      audioBytes: 0,
      receivedAudioFrames: 0,
      lastCommittedSequence: 0,
      history: [],
      nextTurnSequence: 1,
      nextHistorySequence: 1,
      pendingHistoryTurns: new Map(),
      acceptedNotes: [],
    };
    this.session = session;
    this.send({
      ...this.envelope("session.started", session.id),
      accepted: {
        prompt: this.promptReference(),
        endpoint: session.endpoint,
        audio: AUDIO_CONFIG,
        mode: normalized.mode,
        responseStrategy: normalized.responseStrategy,
        transcriptionProvider: transcriptionProvider.selection,
        answerProvider: answerProvider.selection,
        memory: normalized.memory,
        automation,
      },
    });
    this.startOmiPrefetch(session);
  }

  private startOmiPrefetch(session: RuntimeSession): void {
    if (!session.input.memory.readOmiContext) return;
    if (!session.omiClient.configured) {
      this.sendError("omi-not-configured", "Omi context was requested but is not configured on this gateway", false, false, session.id);
      return;
    }
    session.omiMemories = session.omiClient.fetchRecentMemories(session.abortController.signal).catch(() => {
      if (this.isSessionActive(session)) {
        this.sendError("omi-read-failed", "Omi context was unavailable; answers will continue without memory", true, false, session.id);
      }
      return [] as readonly OmiMemory[];
    });
  }

  private prepareAudioFrame(command: AudioFrameCommand): void {
    const session = this.requireSession();
    if (session.pendingAudioFrame !== undefined) {
      this.sendError("audio-frame-missing", "The previous audio.frame command has no binary payload", false, false);
      return;
    }
    if (command.sequence !== session.receivedAudioFrames + 1) {
      this.sendError("audio-sequence", "audio.frame sequence must increase by one", false, false);
      return;
    }
    if (command.sampleCount * 2 > this.config.maxAudioBytes) {
      this.sendError("audio-limit", "A single audio frame exceeds the configured byte limit", false, false);
      return;
    }
    session.pendingAudioFrame = command;
  }

  private endSession(reason: string): void {
    const session = this.requireSession();
    this.send({ ...this.envelope("session.ended", session.id), reason });
    this.cancelSession();
    this.socket.close(1000, safeCloseReason(reason));
  }

  private cancelSession(): void {
    const session = this.session;
    if (session === undefined) return;
    session.active = false;
    session.abortController.abort();
    session.realtimeTranscription?.abort();
    delete session.realtimeTranscription;
    this.session = undefined;
  }

  private commitAudio(command: AudioCommitCommand): void {
    const session = this.requireSession();
    if (session.pendingAudioFrame !== undefined) {
      this.sendError("audio-frame-missing", "The latest audio.frame command has no binary payload", false, false);
      return;
    }
    if (session.audioBytes === 0) {
      this.sendError("empty-audio", "No uncommitted audio is available", false, false);
      return;
    }
    if (command.sequence !== session.receivedAudioFrames || command.sequence <= session.lastCommittedSequence) {
      this.sendError("audio-sequence", "audio.commit sequence must equal the latest received frame sequence", false, false);
      return;
    }
    const captureMs = Math.round((session.audioBytes / 2 / AUDIO_CONFIG.sampleRateHz) * 1_000);
    const pcm16 = Buffer.concat(session.audioChunks, session.audioBytes);
    const realtimeTranscription = session.realtimeTranscription;
    delete session.realtimeTranscription;
    session.audioChunks = [];
    session.audioBytes = 0;
    session.lastCommittedSequence = command.sequence;
    const turnStartedAt = Date.now();
    const turnSequence = this.reserveTurn(session);
    void this.processAudioTurn(
      session,
      command,
      pcm16,
      realtimeTranscription,
      captureMs,
      turnStartedAt,
      turnSequence,
    )
      .catch((error: unknown) => {
        this.completeHistoryTurn(session, turnSequence, []);
        this.handleUnexpectedError(error);
      });
  }

  private async processAudioTurn(
    session: RuntimeSession,
    command: AudioCommitCommand,
    pcm16: Uint8Array,
    realtimeTranscription: RealtimeTranscriptionSession | undefined,
    captureMs: number,
    turnStartedAt: number,
    turnSequence: number,
  ): Promise<void> {
    let transcript: string;
    const transcriptionStartedAt = Date.now();
    try {
      transcript = (await (realtimeTranscription === undefined
        ? session.transcriptionProvider.transcribe({
            pcm16,
            ...(session.input.locale === undefined ? {} : { language: session.input.locale }),
            signal: session.abortController.signal,
          })
        : realtimeTranscription.finish())).text.trim();
    } catch (error) {
      if (this.isSessionActive(session)) {
        this.sendProviderError(error, session.id);
        this.completeHistoryTurn(session, turnSequence, []);
      }
      return;
    }
    if (!this.isSessionActive(session)) return;
    const transcriptionMs = Date.now() - transcriptionStartedAt;
    const transcriptId = randomUUID();
    this.send({
      ...this.envelope("transcript.final", session.id),
      transcriptId,
      text: transcript,
      context: this.context(session, command.speaker, {
        captureMs,
        transcriptionMs,
        totalMs: Date.now() - turnStartedAt,
      }),
    });

    let questionDetectionMs = 0;
    let questions: (DetectedQuestion & { readonly id: string })[] = [];
    if (session.automation.detectQuestions) {
      const detectionStartedAt = Date.now();
      const detected = extractQuestions(transcript, 3);
      questionDetectionMs = Date.now() - detectionStartedAt;
      questions = detected.map((question) => ({ ...question, id: randomUUID() }));
      for (const question of questions) {
        this.send({
          ...this.envelope("question.detected", session.id),
          questionId: question.id,
          text: question.text,
          confidence: 0.92,
          sourceTranscriptId: transcriptId,
          context: this.context(session, command.speaker, {
            captureMs,
            transcriptionMs,
            questionDetectionMs,
            totalMs: Date.now() - turnStartedAt,
          }, "question"),
        });
      }
    }

    if (!session.automation.answerQuestions) {
      this.completeHistoryTurn(session, turnSequence, [{ role: "user", content: transcript }]);
      return;
    }
    const history = trimHistory([...session.history, { role: "user", content: transcript }]);
    const answersDetectedQuestions = shouldAnswerDetectedQuestions(session.input.responseStrategy);
    const taskInputs: AnswerTaskInput[] = (answersDetectedQuestions ? questions : []).map((question) => ({
      session,
      sourceText: question.text,
      providerInput: question.text,
      questionId: question.id,
      trigger: "question",
      sourceTranscriptId: transcriptId,
      speaker: command.speaker,
      history,
      turnStartedAt,
      latency: { captureMs, transcriptionMs, questionDetectionMs },
    }));
    if (
      taskInputs.length === 0
      && questions.length === 0
      && shouldGenerateProactiveResponse(transcript, session.input.mode, session.input.responseStrategy)
    ) {
      taskInputs.push({
        session,
        sourceText: transcript,
        providerInput: proactiveInput(transcript),
        trigger: "proactive",
        sourceTranscriptId: transcriptId,
        speaker: command.speaker,
        history,
        turnStartedAt,
        latency: { captureMs, transcriptionMs, questionDetectionMs },
      });
    }
    if (taskInputs.length === 0) {
      this.completeHistoryTurn(session, turnSequence, [{ role: "user", content: transcript }]);
      return;
    }

    // Streams begin concurrently; client-visible chunks are drained in source
    // order so a faster second answer cannot leapfrog the first question.
    const tasks = taskInputs.map((input) => this.startAnswerTask(input));
    const results: (AnswerResult | undefined)[] = [];
    for (const task of tasks) results.push(await this.safeEmitAnswer(task));
    const completed = results.filter((result): result is AnswerResult => result !== undefined);
    if (!this.isSessionActive(session)) return;
    const additions: ChatMessage[] = [{ role: "user", content: transcript }];
    for (const result of completed) additions.push({ role: "assistant", content: result.answer });
    this.completeHistoryTurn(session, turnSequence, additions);
    if (session.automation.saveNotes) {
      for (const result of completed) this.suggestNote(session, result);
    }
  }

  private handleQuery(command: QueryCommand): void {
    const session = this.requireSession();
    const turnStartedAt = Date.now();
    const turnSequence = this.reserveTurn(session);
    const sourceText = command.text.trim();
    this.send({
      ...this.envelope("question.detected", session.id),
      questionId: command.requestId,
      text: sourceText,
      confidence: 1,
      context: this.context(session, command.speaker, { totalMs: 0 }, "manual"),
    });
    const task = this.startAnswerTask({
      session,
      sourceText,
      providerInput: sourceText,
      questionId: command.requestId,
      trigger: "manual",
      speaker: command.speaker,
      history: session.history,
      turnStartedAt,
      latency: {},
    });
    void this.finishQuery(session, command, task, turnSequence).catch((error: unknown) => {
      this.completeHistoryTurn(session, turnSequence, []);
      this.handleUnexpectedError(error);
    });
  }

  private async finishQuery(
    session: RuntimeSession,
    command: QueryCommand,
    task: AnswerTask,
    turnSequence: number,
  ): Promise<void> {
    const result = await this.safeEmitAnswer(task);
    if (!this.isSessionActive(session)) return;
    const additions: ChatMessage[] = [{ role: "user", content: command.text.trim() }];
    if (result !== undefined) additions.push({ role: "assistant", content: result.answer });
    this.completeHistoryTurn(session, turnSequence, additions);
    if (result !== undefined && session.automation.saveNotes) this.suggestNote(session, result);
  }

  private reserveTurn(session: RuntimeSession): number {
    const sequence = session.nextTurnSequence;
    session.nextTurnSequence += 1;
    return sequence;
  }

  private completeHistoryTurn(
    session: RuntimeSession,
    sequence: number,
    messages: readonly ChatMessage[],
  ): void {
    if (
      !this.isSessionActive(session)
      || sequence < session.nextHistorySequence
      || session.pendingHistoryTurns.has(sequence)
    ) return;

    session.pendingHistoryTurns.set(sequence, [...messages]);
    while (session.pendingHistoryTurns.has(session.nextHistorySequence)) {
      const completed = session.pendingHistoryTurns.get(session.nextHistorySequence) ?? [];
      session.pendingHistoryTurns.delete(session.nextHistorySequence);
      session.nextHistorySequence += 1;
      if (completed.length > 0) session.history = trimHistory([...session.history, ...completed]);
    }
  }

  private startAnswerTask(input: AnswerTaskInput): AnswerTask {
    return {
      input,
      answerId: randomUUID(),
      stream: new BufferedAnswerStream(this.answerSource(input)),
    };
  }

  private async *answerSource(input: AnswerTaskInput): AsyncGenerator<string> {
    if (!this.isSessionActive(input.session)) return;
    const memoryContext = input.session.omiMemories === undefined
      ? undefined
      : await boundedMemoryContext(input.session.omiMemories, input.sourceText, this.config.omi);
    const request: AnswerRequest = {
      question: input.providerInput,
      protectedSystemPrompt: modeSystemPrompt(
        this.config.prompt.systemPrompt,
        input.session.input.mode,
        input.session.input.responseStrategy,
      ),
      ...(input.session.clientPrompt === undefined ? {} : { clientPrompt: input.session.clientPrompt }),
      ...(memoryContext === undefined ? {} : { memoryContext }),
      trigger: input.trigger,
      history: input.history,
      signal: input.session.abortController.signal,
    };
    yield* input.session.answerProvider.streamAnswer(request);
  }

  private async safeEmitAnswer(task: AnswerTask): Promise<AnswerResult | undefined> {
    try {
      return await this.emitAnswer(task);
    } catch (error) {
      if (this.isSessionActive(task.input.session)) {
        this.sendProviderError(error, task.input.session.id);
      }
      return undefined;
    }
  }

  private async emitAnswer(task: AnswerTask): Promise<AnswerResult> {
    const { input, answerId } = task;
    let text = "";
    let firstTokenMs: number | undefined;
    for await (const chunk of task.stream.read()) {
      if (!this.isSessionActive(input.session)) {
        throw new ProviderError("provider-unavailable", "Conversation ended before the answer completed", true);
      }
      text += chunk.text;
      firstTokenMs ??= chunk.receivedAt - input.turnStartedAt;
      const event: AnswerDeltaEvent = {
        ...this.envelope("answer.delta", input.session.id),
        answerId,
        ...(input.questionId === undefined ? {} : { questionId: input.questionId }),
        delta: chunk.text,
        context: this.context(input.session, input.speaker, {
          ...input.latency,
          firstTokenMs,
          totalMs: Date.now() - input.turnStartedAt,
        }, input.trigger),
      };
      this.send(event);
    }
    if (!this.isSessionActive(input.session)) {
      throw new ProviderError("provider-unavailable", "Conversation ended before the answer completed", true);
    }
    const answer = text.trim();
    if (answer === "") throw new ProviderError("provider-response", "Provider completed without answer text", false);
    const completionMs = (task.stream.completedAt ?? Date.now()) - input.turnStartedAt;
    const completedEvent: AnswerCompletedEvent = {
      ...this.envelope("answer.completed", input.session.id),
      answerId,
      ...(input.questionId === undefined ? {} : { questionId: input.questionId }),
      text: answer,
      context: this.context(input.session, input.speaker, {
        ...input.latency,
        ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
        completionMs,
        totalMs: completionMs,
      }, input.trigger),
    };
    this.send(completedEvent);
    return {
      sourceText: input.sourceText,
      ...(input.questionId === undefined ? {} : { questionId: input.questionId }),
      trigger: input.trigger,
      answer,
      completedEvent,
      ...(input.sourceTranscriptId === undefined ? {} : { sourceTranscriptId: input.sourceTranscriptId }),
      speaker: input.speaker,
    };
  }

  private suggestNote(session: RuntimeSession, result: AnswerResult): void {
    if (!this.isSessionActive(session)) return;
    const note: NoteCandidate = {
      id: randomUUID(),
      text: result.answer,
      title: result.sourceText.replace(/[?？؟]$/, "").slice(0, 120),
      tags: ["helix", "automatic", result.trigger],
      provenance: {
        sessionId: session.id,
        sourceEventId: result.completedEvent.eventId,
        sourceType: "answer",
        capturedAt: new Date().toISOString(),
        prompt: this.promptReference(),
        endpoint: session.endpoint,
        speaker: result.speaker,
        latencyMs: result.completedEvent.context.latencyMs,
        mode: session.input.mode,
        responseStrategy: session.input.responseStrategy,
        transcriptionProvider: session.transcriptionProvider.selection,
        answerProvider: session.answerProvider.selection,
        trigger: result.trigger,
      },
    };
    const decision = evaluateAutomaticNote({
      id: note.id,
      content: note.text,
      provenance: note.provenance,
      existingNotes: session.acceptedNotes,
    });
    if (!decision.accepted) return;
    session.acceptedNotes.push(decision.proposal.text);

    const shouldSync = session.input.memory.syncNotes && this.config.omi.writeEnabled && session.omiClient.configured;
    const proposal: NoteCandidate = {
      ...decision.proposal,
      title: note.title,
      tags: note.tags,
      ...(shouldSync ? { persistence: { destination: "omi", status: "pending" } as const } : {}),
    };
    this.sendNote(session, proposal, result.completedEvent.context);
    if (shouldSync) {
      void this.syncNote(session, proposal, result.completedEvent.context);
    }
  }

  private async syncNote(
    session: RuntimeSession,
    note: NoteCandidate,
    context: ConversationContext,
  ): Promise<void> {
    if (!this.isSessionActive(session)) return;
    try {
      const result = await session.omiClient.writeMemory(note.text, session.abortController.signal);
      if (!this.isSessionActive(session)) return;
      this.sendNote(session, {
        ...note,
        persistence: {
          destination: "omi",
          status: "synced",
          ...(result.recordId === undefined ? {} : { recordId: result.recordId }),
        },
      }, context);
    } catch {
      if (!this.isSessionActive(session)) return;
      this.sendNote(session, {
        ...note,
        persistence: { destination: "omi", status: "failed", failureCode: "omi-write-failed" },
      }, context);
      this.sendError("omi-write-failed", "Omi note sync failed; the local suggestion remains available", true, false, session.id);
    }
  }

  private sendNote(session: RuntimeSession, note: NoteCandidate, context: ConversationContext): void {
    if (!this.isSessionActive(session)) return;
    this.send({
      ...this.envelope("note.suggested", session.id),
      note,
      context,
    });
  }

  private promptReference(): { id: string; version: string } {
    return { id: this.config.prompt.id, version: this.config.prompt.version };
  }

  private context(
    session: RuntimeSession,
    speaker: Speaker,
    latencyMs: LatencyBreakdown,
    trigger?: ResponseTrigger,
  ): ConversationContext {
    return {
      prompt: this.promptReference(),
      endpoint: session.endpoint,
      speaker,
      latencyMs,
      mode: session.input.mode,
      responseStrategy: session.input.responseStrategy,
      transcriptionProvider: session.transcriptionProvider.selection,
      answerProvider: session.answerProvider.selection,
      ...(trigger === undefined ? {} : { trigger }),
    };
  }

  private envelope<T extends GatewayEvent["type"]>(type: T, sessionId = this.session?.id ?? "unbound"): {
    protocolVersion: typeof HELIX_PROTOCOL_VERSION;
    type: T;
    eventId: string;
    sessionId: string;
    occurredAt: string;
  } {
    return {
      protocolVersion: HELIX_PROTOCOL_VERSION,
      type,
      eventId: randomUUID(),
      sessionId,
      occurredAt: new Date().toISOString(),
    };
  }

  private sendError(
    code: string,
    message: string,
    retryable: boolean,
    fatal: boolean,
    sessionId?: string,
  ): void {
    const event: GatewayErrorEvent = {
      ...this.envelope("error", sessionId),
      code,
      message,
      retryable,
      fatal,
    };
    this.send(event);
  }

  private sendProviderError(error: unknown, sessionId?: string): void {
    if (error instanceof ProviderError) {
      this.sendError(error.code, error.message, error.retryable, false, sessionId);
      return;
    }
    this.sendError("provider-unavailable", "Conversation provider failed unexpectedly", true, false, sessionId);
  }

  private handleUnexpectedError(_error: unknown): void {
    this.sendError("internal-error", "Gateway could not process the command", true, false);
  }

  private requireSession(): RuntimeSession {
    if (this.session === undefined) throw new Error("No active session");
    return this.session;
  }

  private isSessionActive(session: RuntimeSession): boolean {
    return session.active && this.session === session && !session.abortController.signal.aborted;
  }

  private send(event: GatewayEvent): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(event));
  }
}

export class GatewayServer {
  private readonly httpServer: HttpServer;
  private readonly websocketServer: WebSocketServer;
  private readonly providers: ProviderRegistry;
  private readonly omi: OmiClient;

  public constructor(
    private readonly config: GatewayConfig,
    providers: ProviderRegistry | ConversationProvider,
    omiClient = new OmiClient(config.omi),
  ) {
    this.providers = "resolveTranscription" in providers
      ? providers
      : new SingleProviderRegistry(providers);
    this.omi = omiClient;
    this.httpServer = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ ok: true, mode: config.mode }));
        return;
      }
      response.writeHead(404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ error: "not-found" }));
    });
    this.websocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: config.maxAudioBytes + MAX_TEXT_COMMAND_BYTES,
      handleProtocols: (protocols) => protocols.has(HELIX_WEBSOCKET_PROTOCOL)
        ? HELIX_WEBSOCKET_PROTOCOL
        : false,
    });
    this.websocketServer.on("connection", (socket) => {
      new GatewayConnection(socket, config, this.providers, this.omi);
    });
    this.httpServer.on("upgrade", (request, socket, head) => {
      const path = new URL(request.url ?? "/", "http://gateway.local").pathname;
      if (path !== "/v2/conversations") {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const authorization = authorizeWebSocket(request.headers, config.gatewayToken);
      if (!authorization.accepted) {
        const response = authorization.status === 426
          ? "HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Protocol: helix.v2\r\nConnection: close\r\n\r\n"
          : "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n";
        socket.write(response);
        socket.destroy();
        return;
      }
      this.websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        this.websocketServer.emit("connection", websocket, request);
      });
    });
  }

  public async listen(): Promise<GatewayServerAddress> {
    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error): void => reject(error);
      this.httpServer.once("error", handleError);
      this.httpServer.listen(this.config.port, this.config.host, () => {
        this.httpServer.off("error", handleError);
        resolve();
      });
    });
    const address = this.httpServer.address() as AddressInfo;
    const host = address.address.includes(":") ? `[${address.address}]` : address.address;
    return {
      host: address.address,
      port: address.port,
      httpUrl: `http://${host}:${address.port}`,
      websocketUrl: `ws://${host}:${address.port}/v2/conversations`,
    };
  }

  public async close(): Promise<void> {
    for (const client of this.websocketServer.clients) client.close(1001, "gateway shutdown");
    await Promise.all([
      new Promise<void>((resolve) => this.websocketServer.close(() => resolve())),
      new Promise<void>((resolve, reject) => {
        this.httpServer.close((error) => error ? reject(error) : resolve());
      }),
    ]);
  }
}

export function createGatewayServer(options: CreateGatewayServerOptions = {}): GatewayServer {
  const config = options.config ?? loadGatewayConfig();
  const providers = options.providerRegistry
    ?? (options.provider === undefined
      ? new ConfiguredProviderRegistry(config)
      : new SingleProviderRegistry(options.provider));
  return new GatewayServer(config, providers, options.omiClient ?? new OmiClient(config.omi));
}
