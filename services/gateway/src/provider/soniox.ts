import type { RawData } from "ws";
import { WebSocket } from "ws";
import type { SonioxTranscriptionProfile } from "../config.js";
import { profileSelection } from "../config.js";
import type {
  RealtimeTranscriptionProvider,
  RealtimeTranscriptionSession,
  TranscriptionRequest,
  TranscriptionResult,
} from "./types.js";
import { ProviderError } from "./types.js";

export interface SonioxSocket {
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: RawData) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: () => void): this;
  send(data: string | Buffer): void;
  close(): void;
}

export type SonioxSocketFactory = (url: string) => SonioxSocket;

interface SonioxToken {
  readonly text?: unknown;
  readonly is_final?: unknown;
}

interface SonioxResponse {
  readonly tokens?: readonly SonioxToken[];
  readonly finished?: unknown;
  readonly error_code?: unknown;
  readonly error_message?: unknown;
}

const SONIOX_CHUNK_BYTES = 3_840;
const SONIOX_CHUNK_PACE_MS = 120;
type Pace = (milliseconds: number) => Promise<void>;

const defaultSocketFactory: SonioxSocketFactory = (url) => new WebSocket(url) as SonioxSocket;

function rawDataText(data: RawData | string): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  const view = data as ArrayBufferView;
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("utf8");
}

function sonioxFailure(code: unknown): ProviderError {
  const status = typeof code === "number"
    ? code
    : typeof code === "string" && /^\d{3}$/.test(code) ? Number(code) : undefined;
  if (status === 401 || status === 403) {
    return new ProviderError("provider-authentication", "Soniox rejected its server credential", false, status);
  }
  if (status === 408) return new ProviderError("provider-timeout", "Soniox transcription timed out", true, status);
  if (status === 429) return new ProviderError("provider-rate-limit", "Soniox is temporarily rate limited", true, status);
  if (status !== undefined && status >= 500) {
    return new ProviderError("provider-unavailable", "Soniox is temporarily unavailable", true, status);
  }
  return new ProviderError("provider-response", "Soniox rejected the transcription request", false, status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSonioxResponse(data: RawData | string): SonioxResponse {
  let value: unknown;
  try {
    value = JSON.parse(rawDataText(data)) as unknown;
  } catch {
    throw new ProviderError("provider-response", "Soniox returned malformed transcription data", false);
  }
  if (!isRecord(value)) {
    throw new ProviderError("provider-response", "Soniox returned invalid transcription data", false);
  }
  if (value.tokens !== undefined) {
    if (!Array.isArray(value.tokens) || !value.tokens.every((token) =>
      isRecord(token)
      && (token.text === undefined || typeof token.text === "string")
      && (token.is_final === undefined || typeof token.is_final === "boolean"))) {
      throw new ProviderError("provider-response", "Soniox returned invalid transcription tokens", false);
    }
  }
  if (value.finished !== undefined && typeof value.finished !== "boolean") {
    throw new ProviderError("provider-response", "Soniox returned an invalid completion flag", false);
  }
  return value as SonioxResponse;
}

class SonioxRealtimeSession implements RealtimeTranscriptionSession {
  private readonly result: Promise<TranscriptionResult>;
  private readonly queuedAudio: Buffer[] = [];
  private resolveResult!: (result: TranscriptionResult) => void;
  private rejectResult!: (error: ProviderError) => void;
  private settled = false;
  private opened = false;
  private finishing = false;
  private finalText = "";
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly abortSignal?: AbortSignal;
  private readonly handleAbort = (): void => this.abort();

  public constructor(
    private readonly profile: SonioxTranscriptionProfile,
    language: string | undefined,
    private readonly socket: SonioxSocket,
    signal?: AbortSignal,
  ) {
    this.abortSignal = signal;
    this.result = new Promise<TranscriptionResult>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    // A live session can fail before its owner reaches finish(). Keep that
    // early rejection handled while preserving the same promise for awaiters.
    void this.result.catch(() => undefined);
    this.timer = setTimeout(() => {
      this.settle(new ProviderError("provider-timeout", "Soniox transcription timed out", true));
    }, profile.requestTimeoutMs);

    socket.on("open", () => {
      if (this.settled) return;
      this.opened = true;
      try {
        socket.send(JSON.stringify({
          api_key: profile.apiKey,
          model: profile.model,
          audio_format: "pcm_s16le",
          sample_rate: 16_000,
          num_channels: 1,
          enable_endpoint_detection: true,
          ...(language === undefined || language.trim() === ""
            ? {}
            : { language_hints: [language.trim()] }),
        }));
        for (const chunk of this.queuedAudio.splice(0)) socket.send(chunk);
        if (this.finishing) socket.send(Buffer.alloc(0));
      } catch {
        this.settle(new ProviderError("provider-unavailable", "Soniox transcription send failed", true));
      }
    });
    socket.on("message", (data) => {
      if (this.settled) return;
      try {
        const response = parseSonioxResponse(data);
        if (response.error_code !== undefined || response.error_message !== undefined) {
          this.settle(sonioxFailure(response.error_code));
          return;
        }
        for (const token of response.tokens ?? []) {
          if (token.is_final === true && typeof token.text === "string") this.finalText += token.text;
        }
        if (response.finished === true) {
          if (this.finalText.trim() === "") {
            this.settle(new ProviderError("provider-response", "Soniox returned an empty transcription", false));
          } else {
            this.settle();
          }
        }
      } catch (error) {
        this.settle(error instanceof ProviderError
          ? error
          : new ProviderError("provider-response", "Soniox returned invalid transcription data", false));
      }
    });
    socket.on("error", () => {
      this.settle(new ProviderError("provider-unavailable", "Soniox transcription connection failed", true));
    });
    socket.on("close", () => {
      if (!this.settled) {
        this.settle(new ProviderError(
          "provider-unavailable",
          this.opened
            ? "Soniox closed before transcription finished"
            : "Soniox connection could not be opened",
          true,
        ));
      }
    });
    if (signal?.aborted) this.abort();
    else signal?.addEventListener("abort", this.handleAbort, { once: true });
  }

  public sendAudio(pcm16: Uint8Array): void {
    if (this.settled || this.finishing) {
      throw new ProviderError("provider-unavailable", "Soniox transcription session is not writable", true);
    }
    if (pcm16.byteLength === 0 || pcm16.byteLength % 2 !== 0) {
      throw new ProviderError("provider-response", "Soniox audio must contain complete PCM16 samples", false);
    }
    const copy = Buffer.from(pcm16);
    try {
      if (this.opened) this.socket.send(copy);
      else this.queuedAudio.push(copy);
    } catch {
      this.settle(new ProviderError("provider-unavailable", "Soniox transcription send failed", true));
    }
  }

  public finish(): Promise<TranscriptionResult> {
    if (!this.finishing && !this.settled) {
      this.finishing = true;
      if (this.opened) {
        try {
          this.socket.send(Buffer.alloc(0));
        } catch {
          this.settle(new ProviderError("provider-unavailable", "Soniox transcription send failed", true));
        }
      }
    }
    return this.result;
  }

  public abort(): void {
    this.settle(new ProviderError("provider-unavailable", "Soniox transcription was cancelled", true));
  }

  private settle(error?: ProviderError): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    this.queuedAudio.length = 0;
    this.abortSignal?.removeEventListener("abort", this.handleAbort);
    try { this.socket.close(); } catch { /* already closed */ }
    if (error !== undefined) this.rejectResult(error);
    else this.resolveResult({ text: this.finalText.trim() });
  }
}

/**
 * One Soniox real-time socket is used for each committed turn. Only final
 * tokens are appended: Soniox guarantees those are sent once, while interim
 * tokens can be repeated or replaced.
 */
export class SonioxTranscriptionProvider implements RealtimeTranscriptionProvider {
  public readonly selection;

  public constructor(
    private readonly profile: SonioxTranscriptionProfile,
    private readonly socketFactory: SonioxSocketFactory = defaultSocketFactory,
    private readonly pace: Pace = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {
    this.selection = profileSelection(profile);
  }

  public startRealtime(request: Omit<TranscriptionRequest, "pcm16">): RealtimeTranscriptionSession {
    return new SonioxRealtimeSession(
      this.profile,
      request.language,
      this.socketFactory(this.profile.websocketUrl),
      request.signal,
    );
  }

  public async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const session = this.startRealtime({
      ...(request.language === undefined ? {} : { language: request.language }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    for (let offset = 0; offset < request.pcm16.byteLength; offset += SONIOX_CHUNK_BYTES) {
      const end = Math.min(request.pcm16.byteLength, offset + SONIOX_CHUNK_BYTES);
      session.sendAudio(request.pcm16.subarray(offset, end));
      if (end < request.pcm16.byteLength) await this.pace(SONIOX_CHUNK_PACE_MS);
    }
    return session.finish();
  }
}
