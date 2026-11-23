import { DirectProviderError, directFetch, httpFailure, OPENAI_BASE, type DirectFetch } from "./direct-providers.js";

/** Minimal browser WebSocket surface so tests can inject a fake socket. */
export interface RealtimeSocketLike {
  readonly readyState: number;
  /** Bytes queued by the browser but not yet on the wire (absent in some test doubles). */
  readonly bufferedAmount?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onclose: ((event?: { code?: number }) => void) | null;
}
export type RealtimeSocketFactory = (url: string, protocols: string[]) => RealtimeSocketLike;

export const REALTIME_TRANSCRIPTION_MODEL = "gpt-live-transcribe";
export const REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const OPEN = 1;
/** Send in ~100 ms chunks (1600 input samples at 16 kHz). */
const CHUNK_SAMPLES = 1600;
/** Bound queued/replayable audio to 90 s at 24 kHz. */
const MAX_REPLAY_SAMPLES = 24_000 * 90;
/** Audio of the open (uncommitted) turn kept while disconnected: 30 s at 24 kHz, oldest dropped first. */
const MAX_OUTBOX_TURN_SAMPLES = 24_000 * 30;
/** Client-secret request and WebSocket handshake each get this long before the attempt is retried. */
const CONNECT_TIMEOUT_MS = 10_000;
/** After the back-off attempts are used up: one quiet probe per cool-down instead of one per audio batch. */
const RECONNECT_COOLDOWN_MS = 30_000;
/** A commit always gets a reply; nothing at all from the server for this long means the socket is dead. */
const COMMIT_ACK_TIMEOUT_MS = 10_000;
/** A committed turn with no result after this long is finished so later turns are not held behind it. */
const TURN_TIMEOUT_MS = 15_000;
/** Results that arrive for an item no turn claims are forgotten after this long. */
const EARLY_RESULT_TTL_MS = 60_000;
/** Above this much unsent data the uplink is not keeping up: skip audio instead of buffering more. */
const MAX_BUFFERED_BYTES = 1_000_000;
const COMMIT_MESSAGE = JSON.stringify({ type: "input_audio_buffer.commit" });

/** 16 kHz -> 24 kHz PCM16 by linear interpolation. 16000 samples -> 24000 samples. */
export function resample16kTo24k(input: Int16Array): Int16Array {
  const length = Math.floor(input.length * 3 / 2), output = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * 2 / 3, index = Math.floor(position), fraction = position - index;
    const a = input[index] ?? 0, b = input[Math.min(index + 1, input.length - 1)] ?? a;
    output[i] = Math.round(a + (b - a) * fraction);
  }
  return output;
}
export function pcm16Base64(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.length * 2), view = new DataView(bytes.buffer);
  samples.forEach((sample, i) => view.setInt16(i * 2, sample, true));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function realtimeSessionConfig(prompt?: string, locale?: string): Record<string, unknown> {
  const language = locale?.split(/[-_]/)[0]?.toLowerCase();
  const cleanPrompt = prompt?.replace(/\s+/g, " ").trim().slice(-200);
  return {
    type: "transcription",
    audio: { input: {
      format: { type: "audio/pcm", rate: 24000 },
      transcription: { model: REALTIME_TRANSCRIPTION_MODEL, delay: "low", ...(cleanPrompt ? { prompt: cleanPrompt } : {}), ...(language && /^[a-z]{2}$/.test(language) ? { languages: [language] } : {}) },
      // gpt-live-transcribe does not support server VAD; turns are committed by the client.
      turn_detection: null,
    } },
  };
}

export interface RealtimeTranscriberOptions<T> {
  readonly fetch: DirectFetch;
  readonly key: string;
  readonly locale?: string;
  readonly webSocketFactory?: RealtimeSocketFactory;
  /** Recent transcript context; last 200 chars are sent as the transcription prompt. */
  readonly prompt?: () => string;
  readonly onPartial: (turn: T, text: string) => void;
  /** Live words for the item still being spoken (before commit). gpt-live-transcribe streams
   * these ~200-400 ms behind the audio; they are the continuous caption. */
  readonly onLive?: (itemId: string, text: string) => void;
  /** Called in commit order, even when the provider completes items out of order. */
  readonly onCompleted: (turn: T, text: string, completedAt: number) => void;
  readonly onError: (error: DirectProviderError, turn?: T) => void;
  readonly reconnectBaseMs?: number;
  readonly maxReconnects?: number;
}
interface Turn<T> { meta: T; itemId?: string; text?: string; partial: string; failed?: boolean; completedAt?: number; committedAt: number }
interface Queued { readonly data: string; readonly samples: number }

/**
 * One persistent OpenAI Realtime transcription socket per session. Audio is
 * streamed as it arrives; each turn is committed by the client.
 */
export class RealtimeTranscriber<T> {
  private socket?: RealtimeSocketLike;
  private connecting?: Promise<void>;
  private closed = false;
  private outbox: Queued[] = [];
  private outboxSamples = 0;
  private pendingInput: Int16Array[] = [];
  private pendingInputSamples = 0;
  /** Resampled audio of the current uncommitted turn, replayed after a reconnect. */
  private replay: Queued[] = [];
  private replaySamples = 0;
  private turns: Turn<T>[] = [];
  private byItem = new Map<string, Turn<T>>();
  private awaitingCommit: Turn<T>[] = [];
  private earlyResults = new Map<string, { text?: string; failed?: boolean; completedAt: number }>();
  /** Pre-commit text per server item id (live caption). */
  private live = new Map<string, string>();
  private attempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private sentPrompt = "";
  /** Last time the server sent anything; a suspended WebView can leave a dead-but-"open" socket. */
  private lastServerEventAt = 0;
  private ready = false;
  /** When the current socket became ready; deadlines of turns committed while disconnected start here. */
  private readyAt = 0;
  /** Code of the connect failure already reported for the current outage (one report per outage). */
  private reportedDown?: string;
  private coolingDown = false;
  private connectAbort?: AbortController;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private watchTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly options: RealtimeTranscriberOptions<T>) {}

  /** 16 kHz s16le mono samples. Opens the socket lazily on first audio. */
  append(samples: Int16Array): void {
    if (this.closed || !samples.length) return;
    this.ensureConnected();
    this.pendingInput.push(samples); this.pendingInputSamples += samples.length;
    if (this.pendingInputSamples >= CHUNK_SAMPLES) this.flushInput();
  }
  /** Ends the current turn. Returns false (and clears server audio) when nothing was appended. */
  commit(meta: T): boolean {
    if (this.closed) return false;
    this.flushInput();
    if (!this.replaySamples) return false;
    // No session.update here: verified live (2026-11-08) that updating the session right
    // before a commit makes gpt-live-transcribe complete that item with an empty transcript.
    // The context prompt is sent once when the socket opens.
    this.sendRaw(COMMIT_MESSAGE, 0);
    const turn: Turn<T> = { meta, partial: "", committedAt: Date.now() };
    this.turns.push(turn); this.awaitingCommit.push(turn);
    this.replay = []; this.replaySamples = 0;
    this.armWatch();
    return true;
  }
  /** Drops uncommitted audio (e.g. a silence-only hold). */
  clear(): void {
    this.pendingInput = []; this.pendingInputSamples = 0;
    if (this.replaySamples) {
      const socket = this.socket;
      if (socket && this.ready && socket.readyState === OPEN) this.send({ type: "input_audio_buffer.clear" });
      else {
        // Not connected: the server has none of this audio. Drop it from the queue instead of sending it
        // followed by a clear. Turns committed while disconnected (up to the last queued commit) stay.
        this.outbox.length = this.outboxTurnStart();
        this.outboxSamples = this.outbox.reduce((sum, item) => sum + item.samples, 0);
      }
    }
    this.replay = []; this.replaySamples = 0;
  }
  close(): void {
    this.closed = true; ++this.generation; clearTimeout(this.reconnectTimer);
    clearTimeout(this.connectTimer); clearTimeout(this.watchTimer); this.watchTimer = undefined;
    this.connectAbort?.abort(); this.connectAbort = undefined;
    const socket = this.socket; this.socket = undefined; this.ready = false;
    if (socket) { socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null; try { socket.close(1000, "session ended"); } catch { /* already closed */ } }
    this.outbox = []; this.replay = []; this.turns = []; this.byItem.clear(); this.awaitingCommit = []; this.earlyResults.clear(); this.pendingInput = []; this.live.clear();
  }

  /**
   * After the app returns from the background (Android may suspend the WebView), a socket can look
   * open but be dead. If nothing arrived for idleMs, drop it and let the normal reconnect-with-replay run.
   * Returns true when a reconnect was forced.
   */
  resumeAfterSuspend(idleMs = 10_000): boolean {
    if (this.closed) return false;
    if (!this.socket) {
      // Waiting out the cool-down after repeated connect failures: the page is back, so retry now.
      if (!this.coolingDown) return false;
      clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined;
      this.coolingDown = false; this.attempts = 0; this.reportedDown = undefined;
      this.ensureConnected();
      return true;
    }
    if (Date.now() - this.lastServerEventAt < idleMs) return false;
    this.attempts = 0; this.reportedDown = undefined;
    this.forceReconnect(4000, "resume after suspend");
    return true;
  }
  /** Replaces a socket that is open but not answering; the normal reconnect-with-replay follows. */
  private forceReconnect(code: number, reason: string): void {
    const socket = this.socket;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
    try { socket.close(code, reason); } catch { /* already dead */ }
    this.socket = undefined; this.ready = false;
    this.dropped();
  }
  private flushInput(): void {
    if (!this.pendingInputSamples) return;
    const merged = new Int16Array(this.pendingInputSamples); let offset = 0;
    for (const part of this.pendingInput) { merged.set(part, offset); offset += part.length; }
    this.pendingInput = []; this.pendingInputSamples = 0;
    const resampled = resample16kTo24k(merged);
    const message = JSON.stringify({ type: "input_audio_buffer.append", audio: pcm16Base64(resampled) });
    if (this.replaySamples + resampled.length <= MAX_REPLAY_SAMPLES) { this.replay.push({ data: message, samples: resampled.length }); this.replaySamples += resampled.length; }
    this.sendRaw(message, resampled.length);
  }
  private send(message: unknown): void { this.sendRaw(JSON.stringify(message), 0); }
  private sendRaw(message: string, samples: number): void {
    const socket = this.socket;
    if (socket && this.ready && socket.readyState === OPEN) {
      // Slow or dead uplink: do not pile more audio into the socket buffer. Control messages still go,
      // so a commit keeps its acknowledgement deadline and a dead socket is still found.
      if (samples && (socket.bufferedAmount ?? 0) > MAX_BUFFERED_BYTES) return;
      try { socket.send(message); return; } catch { /* fall through to queue */ }
    }
    if (samples) {
      // Bound the open turn to its newest 30 s; committed turns ahead of it are left alone.
      const start = this.outboxTurnStart();
      let turnSamples = 0;
      for (let i = start; i < this.outbox.length; i++) turnSamples += this.outbox[i]!.samples;
      while (start < this.outbox.length && turnSamples + samples > MAX_OUTBOX_TURN_SAMPLES) {
        const [oldest] = this.outbox.splice(start, 1);
        turnSamples -= oldest!.samples; this.outboxSamples -= oldest!.samples;
      }
    }
    if (this.outboxSamples + samples > MAX_REPLAY_SAMPLES) return;
    this.outbox.push({ data: message, samples }); this.outboxSamples += samples;
  }
  /** Index of the first queued message after the last queued commit (start of the open turn). */
  private outboxTurnStart(): number {
    let start = this.outbox.length;
    while (start > 0 && this.outbox[start - 1]!.data !== COMMIT_MESSAGE) start--;
    return start;
  }
  private ensureConnected(): void {
    if (this.socket || this.connecting || this.closed || this.reconnectTimer) return;
    const generation = this.generation;
    this.connecting = this.open(generation).catch(error => {
      if (generation !== this.generation || this.closed) return;
      const safe = error instanceof DirectProviderError ? error : new DirectProviderError("provider-network", "Could not connect to OpenAI Realtime transcription.", true);
      // Transient failures retry quietly; scheduleReconnect reports once attempts are exhausted.
      // Anything else is reported once and then waits out the cool-down, so it cannot repeat per audio batch.
      if (safe.retryable) this.scheduleReconnect(); else this.coolDown(safe);
    }).finally(() => { if (generation === this.generation) this.connecting = undefined; });
  }
  private async mint(signal: AbortSignal): Promise<string> {
    try {
      const response = await directFetch(this.options.fetch, `${OPENAI_BASE}/realtime/client_secrets`, {
        method: "POST", headers: { Authorization: `Bearer ${this.options.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ session: realtimeSessionConfig(undefined, this.options.locale) }), signal,
      }, "OpenAI realtime");
      const value: unknown = await response.json();
      const record = typeof value === "object" && value !== null ? value as { value?: unknown; client_secret?: { value?: unknown } } : {};
      const token = typeof record.value === "string" ? record.value : typeof record.client_secret?.value === "string" ? record.client_secret.value : undefined;
      if (!token) throw new DirectProviderError("provider-response", "OpenAI returned no realtime client secret.");
      return token;
    } catch (error) {
      // Accounts/endpoints without client secret minting: fall back to the key in the same subprotocol.
      if (error instanceof DirectProviderError && /HTTP (?:400|404)\b/.test(error.message)) return this.options.key;
      throw error;
    }
  }
  private async open(generation: number): Promise<void> {
    const abort = new AbortController();
    this.connectAbort = abort;
    let token: string;
    try {
      // The race settles even when the fetch ignores its signal.
      token = await Promise.race([this.mint(abort.signal), new Promise<never>((_, reject) => {
        this.connectTimer = setTimeout(() => { reject(new DirectProviderError("provider-timeout", "OpenAI Realtime did not answer in time.", true)); abort.abort(); }, CONNECT_TIMEOUT_MS);
      })]);
    } finally { clearTimeout(this.connectTimer); if (this.connectAbort === abort) this.connectAbort = undefined; }
    if (generation !== this.generation || this.closed) return;
    const factory = this.options.webSocketFactory ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as RealtimeSocketLike);
    const socket = factory(REALTIME_URL, ["realtime", `openai-insecure-api-key.${token}`]);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let opened = false;
      // Handshake deadline: close the half-open socket and let the back-off retry.
      const timer = this.connectTimer = setTimeout(() => {
        if (opened) return;
        if (this.socket === socket) {
          socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
          try { socket.close(4001, "connect timeout"); } catch { /* already dead */ }
          this.socket = undefined; this.ready = false;
        }
        reject(new DirectProviderError("provider-timeout", "OpenAI Realtime did not open in time.", true));
      }, CONNECT_TIMEOUT_MS);
      socket.onopen = () => {
        if (this.socket !== socket) return;
        // The back-off counter is reset by the first server message, not here: a socket that opens
        // and closes straight away must keep backing off.
        opened = true; clearTimeout(timer); this.reportedDown = undefined; this.lastServerEventAt = this.readyAt = Date.now();
        const prompt = this.options.prompt?.().replace(/\s+/g, " ").trim().slice(-200) ?? "";
        this.sentPrompt = prompt;
        try {
          socket.send(JSON.stringify({ type: "session.update", session: realtimeSessionConfig(prompt, this.options.locale) }));
          const queued = this.outbox; this.outbox = []; this.outboxSamples = 0;
          for (const message of queued) socket.send(message.data);
        } catch { /* close handler reconnects */ }
        this.ready = true;
        this.rearmWatch();
        resolve();
      };
      socket.onmessage = event => { if (this.socket === socket) { this.attempts = 0; this.lastServerEventAt = Date.now(); this.message(event.data); } };
      socket.onerror = () => { /* close follows */ };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = undefined; this.ready = false;
        if (!opened) { clearTimeout(timer); reject(new DirectProviderError("provider-network", "OpenAI Realtime closed before opening.", true)); return; }
        if (!this.closed) this.dropped();
      };
    });
  }
  private dropped(): void {
    // Committed turns on the old socket are lost; report them in order and keep going.
    clearTimeout(this.watchTimer); this.watchTimer = undefined;
    const lost = this.turns.filter(turn => turn.text === undefined && !turn.failed);
    this.turns = []; this.byItem.clear(); this.awaitingCommit = []; this.earlyResults.clear();
    for (const turn of lost) this.options.onError(new DirectProviderError("provider-network", "Realtime transcription connection dropped; one turn was lost.", true), turn.meta);
    // Replay the current uncommitted turn on the new socket.
    this.outbox = [...this.replay]; this.outboxSamples = this.replaySamples;
    this.scheduleReconnect();
  }
  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    if (this.attempts >= (this.options.maxReconnects ?? 5)) {
      this.coolDown(new DirectProviderError("provider-network", "OpenAI Realtime transcription is unavailable. Check your connection.", true));
      return;
    }
    const delay = Math.min(10_000, (this.options.reconnectBaseMs ?? 500) * 2 ** this.attempts++);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.ensureConnected(); }, delay);
  }
  /** Reports a connect failure once per outage, then arms one slow probe; appends in between do not connect. */
  private coolDown(error: DirectProviderError): void {
    if (this.reportedDown !== error.code) { this.reportedDown = error.code; this.options.onError(error); }
    if (this.closed || this.reconnectTimer) return;
    this.coolingDown = true;
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.coolingDown = false; this.ensureConnected(); }, RECONNECT_COOLDOWN_MS);
  }
  /** One timer for the oldest unfinished turn; a timer because append() is not called during silence. */
  private armWatch(): void {
    if (this.closed || this.watchTimer || !this.ready) return;
    const head = this.turns[0];
    if (!head) return;
    const since = Math.max(head.committedAt, this.readyAt);
    const silent = !head.itemId && this.lastServerEventAt <= since;
    const due = since + (silent ? COMMIT_ACK_TIMEOUT_MS : TURN_TIMEOUT_MS);
    this.watchTimer = setTimeout(() => { this.watchTimer = undefined; this.checkHead(); }, Math.max(0, due - Date.now()));
  }
  private rearmWatch(): void { clearTimeout(this.watchTimer); this.watchTimer = undefined; this.armWatch(); }
  private checkHead(): void {
    const head = this.turns[0];
    if (this.closed || !this.ready || !head) return;
    const now = Date.now(), since = Math.max(head.committedAt, this.readyAt);
    if (!head.itemId && this.lastServerEventAt <= since && now - since >= COMMIT_ACK_TIMEOUT_MS) {
      // A commit is always answered. Silence since then means the socket is open but dead.
      this.forceReconnect(4001, "no commit acknowledgement");
      return;
    }
    if (now - since < TURN_TIMEOUT_MS) { this.armWatch(); return; }
    // The server is alive but this turn never finished: keep the streamed words, or report it, and move on.
    if (!head.itemId) this.awaitingCommit = this.awaitingCommit.filter(turn => turn !== head);
    const partial = head.partial.trim();
    if (partial) { head.text = partial; head.completedAt = now; } else head.failed = true;
    this.flush();
  }
  private early(itemId: string, result: { text?: string; failed?: boolean; completedAt: number }): void {
    for (const [id, old] of this.earlyResults) if (result.completedAt - old.completedAt > EARLY_RESULT_TTL_MS) this.earlyResults.delete(id);
    this.earlyResults.set(itemId, result);
  }
  private message(data: unknown): void {
    let event: Record<string, unknown>;
    try { const parsed: unknown = JSON.parse(String(data)); if (typeof parsed !== "object" || parsed === null) return; event = parsed as Record<string, unknown>; } catch { return; }
    const itemId = typeof event.item_id === "string" ? event.item_id : undefined;
    switch (event.type) {
      case "input_audio_buffer.committed": {
        const turn = this.awaitingCommit.shift();
        if (!turn) return;
        // Without an item id no result can ever be matched to this turn: fail it instead of holding the queue.
        if (!itemId) { turn.failed = true; this.flush(); return; }
        turn.itemId = itemId; this.byItem.set(itemId, turn);
        // Words streamed before the commit belong to this turn.
        turn.partial = this.live.get(itemId) ?? turn.partial; this.live.delete(itemId);
        const early = this.earlyResults.get(itemId);
        if (early) { this.earlyResults.delete(itemId); turn.text = early.text; turn.failed = early.failed; turn.completedAt = early.completedAt; this.flush(); }
        return;
      }
      case "conversation.item.input_audio_transcription.delta": {
        const turn = itemId ? this.byItem.get(itemId) : undefined;
        if (!turn && itemId && typeof event.delta === "string") {
          // Not committed yet: the item is still being spoken. Keep it as a live caption.
          const text = (this.live.get(itemId) ?? "") + event.delta;
          this.live.delete(itemId); this.live.set(itemId, text);
          while (this.live.size > 4) this.live.delete(this.live.keys().next().value!);
          try { this.options.onLive?.(itemId, text.trim()); } catch { /* host isolation */ }
          return;
        }
        if (!turn || typeof event.delta !== "string" || turn.text !== undefined) return;
        turn.partial += event.delta;
        try { this.options.onPartial(turn.meta, turn.partial.trim()); } catch { /* host isolation */ }
        return;
      }
      case "conversation.item.input_audio_transcription.completed": {
        if (!itemId) return;
        let text = typeof event.transcript === "string" ? event.transcript.trim() : "";
        const completedAt = Date.now();
        const turn = this.byItem.get(itemId);
        // Never lose words the wearer already saw: fall back to the streamed text.
        if (!text) text = (turn?.partial ?? this.live.get(itemId) ?? "").trim();
        if (!turn) { this.early(itemId, { text, completedAt }); return; }
        turn.text = text; turn.completedAt = completedAt; this.flush();
        return;
      }
      case "conversation.item.input_audio_transcription.failed": {
        if (!itemId) return;
        const turn = this.byItem.get(itemId);
        if (!turn) { this.early(itemId, { failed: true, completedAt: Date.now() }); return; }
        turn.failed = true; this.flush();
        return;
      }
      case "error": {
        const error = typeof event.error === "object" && event.error !== null ? event.error as { type?: unknown; code?: unknown } : {};
        if (error.code === "input_audio_buffer_commit_empty") {
          // The server rejected an empty commit: drop the oldest awaiting turn silently.
          const turn = this.awaitingCommit.shift(); if (turn) { this.turns = this.turns.filter(t => t !== turn); }
          return;
        }
        const auth = error.type === "authentication_error" || error.code === "invalid_api_key" || error.code === "unauthorized";
        this.options.onError(auth ? httpFailure("OpenAI realtime", 401) : new DirectProviderError("provider-response", "OpenAI Realtime reported a transcription error.", true));
        if (auth) this.close();
        return;
      }
    }
  }
  /** Delivers finished turns strictly in commit order. */
  private flush(): void {
    while (this.turns.length) {
      const turn = this.turns[0]!;
      if (turn.text === undefined && !turn.failed) break;
      this.turns.shift(); if (turn.itemId) this.byItem.delete(turn.itemId);
      if (turn.failed) this.options.onError(new DirectProviderError("provider-response", "OpenAI could not transcribe one speech turn.", true), turn.meta);
      else if (turn.text) { try { this.options.onCompleted(turn.meta, turn.text, turn.completedAt ?? Date.now()); } catch { /* host isolation */ } }
    }
    // The deadline follows whichever turn is now the oldest unfinished one.
    this.rearmWatch();
  }
}
