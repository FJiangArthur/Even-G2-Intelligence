/**
 * Microphone event probe: where does the time of one host -> page audio call go?
 *
 * Measured on an iPhone over USB (system log, 2026-11-21): ~42 audio calls a second at 0.5-1 ms each for
 * the first ~20 s of listening, then one call of 0.27-0.47 s, and from then on 36-47 ms for EVERY call
 * (25 served a second against 42 arriving), so the host queue never drains. Reading our handler found no
 * 40 ms path, so this splits one call into its parts and reports them per 10 s heartbeat.
 *
 * How SDK 0.0.14 receives a host push (found by loading the obfuscated bundle in Node against a recording
 * `window`, not from the docs): the host calls the global `window._listenEvenAppMessage(message)` with an
 * object or a JSON string; there is NO window "message" listener. The SDK parses it, builds the event
 * (base64 or number array -> Uint8Array), calls `console.log("[EvenAppBridge] EvenHub event:", event)`
 * for every event including every audio frame, then `window.dispatchEvent(new CustomEvent("evenHubEvent"))`,
 * which is what `bridge.onEvenHubEvent` listens to.
 *
 * Passive: messages and events are never changed, stopped or copied. Aggregates only - no audio, no text.
 * The one thing that can be switched off is the SDK's own per-frame console line (see `setSdkAudioLogQuiet`).
 */
export type MicEntryKind = "fn" | "message" | "event" | "none";
export type MicDropKind = "rate" | "flush" | "source";

const ENTRY_FN = "_listenEvenAppMessage", HUB_EVENT = "evenHubEvent", SDK_AUDIO_LOG = "[EvenAppBridge] EvenHub event";
const GAP_SAMPLES = 1024;
const clock = (): number => performance.now();

interface Window_ {
  startedAt: number;
  n: number; gaps: Float32Array; gapN: number; gapMax: number;
  ours: number; oursMax: number; oursN: number;
  decode: number; decodeMax: number; decodeN: number;
  call: number; callMax: number; callN: number;
  log: number; logMax: number; logN: number; logSkipped: number;
  bytesMin: number; bytesMax: number; bytesSum: number; bytesN: number;
  rawMin: number; rawMax: number; rawSum: number; rawN: number; rawShape: string;
  send: number; sendMax: number; sendN: number;
  fn: number; message: number; event: number; direct: number;
  rate: number; flush: number; source: number;
}
function fresh(at = clock()): Window_ {
  return { startedAt: at, n: 0, gaps: windowGaps, gapN: 0, gapMax: 0, ours: 0, oursMax: 0, oursN: 0, decode: 0, decodeMax: 0, decodeN: 0, call: 0, callMax: 0, callN: 0,
    log: 0, logMax: 0, logN: 0, logSkipped: 0, bytesMin: Infinity, bytesMax: 0, bytesSum: 0, bytesN: 0, rawMin: Infinity, rawMax: 0, rawSum: 0, rawN: 0, rawShape: "",
    send: 0, sendMax: 0, sendN: 0, fn: 0, message: 0, event: 0, direct: 0, rate: 0, flush: 0, source: 0 };
}
/** One buffer for the whole page: 42 events a second for 10 s is 420 gaps; past 1024 only count and max keep going. */
const windowGaps = new Float32Array(GAP_SAMPLES);
let w = fresh();

// Per-call state (plain numbers; nothing is allocated per event).
let entryAt = 0, entryDepth = 0, entryRaw: unknown, callAudio = false, callCounted = false;
let messageAt = 0, messageRaw: unknown;
let eventPending = false, lastArrival = 0, quiet = true, installed = false;
let restore: (() => void) | undefined;
/** Entry points seen since the page loaded (for the report header). */
const seen = { fn: 0, message: 0, event: 0, direct: 0 };

function arrival(at: number, bytes: number): void {
  w.n += 1;
  if (lastArrival) {
    const gap = at - lastArrival;
    if (w.gapN < GAP_SAMPLES) w.gaps[w.gapN] = gap;
    w.gapN += 1; if (gap > w.gapMax) w.gapMax = gap;
  }
  lastArrival = at;
  if (bytes >= 0) { w.bytesN += 1; w.bytesSum += bytes; if (bytes < w.bytesMin) w.bytesMin = bytes; if (bytes > w.bytesMax) w.bytesMax = bytes; }
}

/** Size and shape of the raw audio payload as the host sent it (string length, or array length). */
function noteRaw(raw: unknown): void {
  let size = -1;
  if (typeof raw === "string") {
    size = raw.length;
    if (!w.rawShape) { // one look per heartbeat window: is the PCM base64 text or a number array?
      const at = raw.indexOf("audioPcm"), next = at < 0 ? "" : raw.slice(at + 8, at + 16).replace(/[\\":\s]/gu, "").charAt(0);
      w.rawShape = `string/${next === "[" ? "numbers" : next ? "base64" : "?"}`;
    }
  } else if (raw && typeof raw === "object") {
    const data = (raw as { data?: unknown; payload?: unknown }).data ?? (raw as { payload?: unknown }).payload;
    const inner = Array.isArray(data) ? data[1] : (data as { jsonData?: unknown; data?: unknown } | undefined)?.jsonData ?? (data as { data?: unknown } | undefined)?.data ?? data;
    const pcm = (inner as { audioPcm?: unknown; audio_pcm?: unknown } | undefined)?.audioPcm ?? (inner as { audio_pcm?: unknown } | undefined)?.audio_pcm;
    if (typeof pcm === "string") { size = pcm.length; w.rawShape ||= "object/base64"; }
    else if (pcm && typeof (pcm as ArrayLike<number>).length === "number") { size = (pcm as ArrayLike<number>).length; w.rawShape ||= Array.isArray(pcm) ? "object/numbers" : "object/bytes"; }
    else w.rawShape ||= "object/?";
  }
  if (size >= 0) { w.rawN += 1; w.rawSum += size; if (size < w.rawMin) w.rawMin = size; if (size > w.rawMax) w.rawMax = size; }
}

/**
 * Controller: the audio handler starts. Returns the start time for `micHandlerEnd`.
 * `handlerStart - entryStart` is what the SDK spent on this event before we saw it.
 */
export function micHandlerBegin(bytes: number): number {
  const at = clock();
  if (eventPending) eventPending = false; // arrival already counted where the SDK dispatched it
  else { w.direct += 1; seen.direct += 1; arrival(entryAt || at, bytes); if (entryAt) { callAudio = true; callCounted = true; } } // no window event seen (yet): count here
  const from = entryAt || (messageAt && at - messageAt < 250 ? messageAt : 0);
  if (from) { const took = at - from; w.decode += took; w.decodeN += 1; if (took > w.decodeMax) w.decodeMax = took; }
  return at;
}
export function micHandlerEnd(began: number): void {
  const took = clock() - began;
  w.ours += took; w.oursN += 1; if (took > w.oursMax) w.oursMax = took;
}
/** Audio events the guard discarded (token bucket, overload flush, wrong microphone). */
export function noteMicDropped(kind: MicDropKind, count = 1): void { w[kind] += count; }
/** One ~100 ms batch handed to the session: time until the session accepted it. */
export function noteMicSend(ms: number): void { w.send += ms; w.sendN += 1; if (ms > w.sendMax) w.sendMax = ms; }

/** Default on: the SDK's `console.log` of every audio frame (payload included) is skipped. Everything else is logged as before. */
export function setSdkAudioLogQuiet(on: boolean): void { quiet = on; }
export function sdkAudioLogQuiet(): boolean { return quiet; }

function isAudioLog(first: unknown, second: unknown): boolean {
  return typeof first === "string" && first.charCodeAt(0) === 91 && first.startsWith(SDK_AUDIO_LOG) && !!(second as { audioEvent?: unknown } | null | undefined)?.audioEvent;
}

type Target = { addEventListener?: (type: string, listener: (event: never) => void, capture?: boolean) => void; removeEventListener?: (type: string, listener: (event: never) => void, capture?: boolean) => void } & Record<string, unknown>;

/**
 * Installs the probes. Call once, before the bridge is used. Safe when an entry point is missing (a host
 * that pushes differently just shows up as `mic-entry none`), and never throws.
 */
export function installMicProbe(target: Target | undefined = typeof window === "undefined" ? undefined : window as unknown as Target, logger: { log: (...args: unknown[]) => void } = console): () => void {
  if (installed || !target) return () => undefined;
  installed = true;
  const undo: (() => void)[] = [];
  // 1. Timing wrapper around the SDK's global entry function. An accessor keeps the wrapper in place
  //    if the SDK assigns the function again later.
  try {
    let original = target[ENTRY_FN] as ((this: unknown, message: unknown) => unknown) | undefined;
    const wrapper = function (this: unknown, message: unknown): unknown {
      if (!original) return undefined;
      if (entryDepth++) { try { return original.call(this, message); } finally { entryDepth--; } }
      entryAt = clock(); callAudio = false; callCounted = false; entryRaw = message;
      try { return original.call(this, message); }
      finally {
        entryDepth = 0;
        if (callAudio) {
          const took = clock() - entryAt;
          w.fn += 1; seen.fn += 1; w.call += took; w.callN += 1; if (took > w.callMax) w.callMax = took;
          noteRaw(entryRaw);
        }
        entryAt = 0; entryRaw = undefined; eventPending = false;
      }
    };
    const had = Object.getOwnPropertyDescriptor(target, ENTRY_FN);
    if (!had || had.configurable) {
      Object.defineProperty(target, ENTRY_FN, { configurable: true, enumerable: true, get: () => original ? wrapper : undefined, set: (next: unknown) => { original = typeof next === "function" ? next as typeof original : undefined; } });
      undo.push(() => { try { Object.defineProperty(target, ENTRY_FN, { configurable: true, enumerable: true, writable: true, value: original }); } catch { /* leave it */ } });
    }
  } catch { /* entry function not wrappable on this host: reported as not observed */ }
  // 2. Hosts (or a simulator) that post a window message instead. Capture phase, registered before the bridge exists.
  const onMessage = (event: { data?: unknown }): void => {
    const data = event.data;
    if (typeof data === "string" ? data.length > 40 && data.includes(HUB_EVENT) : !!data && (data as { method?: unknown }).method === HUB_EVENT) { messageAt = clock(); messageRaw = data; }
  };
  // 3. The SDK's own dispatch: tells an audio event from the rest, and counts it even while the app ignores audio.
  const onHubEvent = (event: { detail?: { audioEvent?: { audioPcm?: { length?: number } } } }): void => {
    const audio = event.detail?.audioEvent;
    if (!audio) return;
    const at = clock(), viaMessage = !entryAt && messageAt > 0 && at - messageAt < 250;
    w.event += 1; seen.event += 1;
    if (entryAt && callCounted) return; // the app's listener ran first (it was registered before the probe) and counted this one
    eventPending = true;
    if (entryAt) callAudio = true;
    else if (viaMessage) { w.message += 1; seen.message += 1; noteRaw(messageRaw); messageRaw = undefined; }
    arrival(entryAt || (viaMessage ? messageAt : at), audio.audioPcm?.length ?? -1);
  };
  try {
    target.addEventListener?.("message", onMessage as (event: never) => void, true);
    target.addEventListener?.(HUB_EVENT, onHubEvent as (event: never) => void, true);
    undo.push(() => { target.removeEventListener?.("message", onMessage as (event: never) => void, true); target.removeEventListener?.(HUB_EVENT, onHubEvent as (event: never) => void, true); });
  } catch { /* no event target */ }
  // 4. The SDK logs every event with its payload. In the Even app's WebView console.log is forwarded to the
  //    native side, so this line is timed (or skipped) here; any other console line passes through untouched.
  try {
    const log = logger.log;
    const timed = function (this: unknown, ...args: unknown[]): void {
      if (!isAudioLog(args[0], args[1])) { log.apply(this, args); return; }
      if (quiet) { w.logSkipped += 1; return; }
      const at = clock();
      try { log.apply(this, args); } finally { const took = clock() - at; w.log += took; w.logN += 1; if (took > w.logMax) w.logMax = took; }
    };
    logger.log = timed;
    undo.push(() => { if (logger.log === timed) logger.log = log; });
  } catch { /* console not writable */ }
  restore = () => { for (const step of undo.reverse()) { try { step(); } catch { /* best effort */ } } installed = false; restore = undefined; };
  return restore;
}

const ms = (value: number): string => !Number.isFinite(value) ? "?" : value < 1 ? value.toFixed(2) : value < 10 ? value.toFixed(1) : value.toFixed(0);
const pair = (sum: number, n: number, max: number): string => `${ms(n ? sum / n : 0)}/${ms(max)} ms`;

/** Which host entry points carried audio so far, e.g. "fn" (0.0.14 in the Even app), "message", "event", "none". */
export function micEntryObserved(): MicEntryKind {
  return seen.fn ? "fn" : seen.message ? "message" : seen.event ? "event" : "none";
}
export function micProbeState(): string {
  return `mic-entry ${micEntryObserved()}${seen.direct ? " (+direct listener)" : ""} · probe ${installed ? "installed" : "not installed"} · SDK audio log ${quiet ? "skipped" : "left on"}`;
}

export interface MicWindowReport { readonly mic: string; readonly sdk: string }
/**
 * Closes the current window (the 10 s diagnostics heartbeat calls this) and returns two lines, or
 * undefined when no microphone event arrived. `lag` is the main-thread timer lateness over the same window.
 */
export function micProbeWindow(lag?: { avg: number; max: number }, at = clock()): MicWindowReport | undefined {
  const done = w, seconds = Math.max(0.001, (at - done.startedAt) / 1000);
  const dropped = done.rate + done.flush + done.source;
  if (!done.n && !dropped) { w = fresh(at); return undefined; }
  const kept = Math.min(done.gapN, GAP_SAMPLES), gaps = Array.from(done.gaps.subarray(0, kept)).sort((a, b) => a - b);
  const at_ = (q: number): number => gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))]! : 0;
  const heap = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize;
  const mic = [
    `${(done.n / seconds).toFixed(1)}/s x${done.n}`,
    `gap ${ms(at_(0.5))}/${ms(at_(0.95))}/${ms(done.gapMax)} ms med/p95/max`,
    done.oursN ? `ours ${pair(done.ours, done.oursN, done.oursMax)} avg/max` : "ours not run",
    done.bytesN ? `bytes ${done.bytesMin}/${Math.round(done.bytesSum / done.bytesN)}/${done.bytesMax} min/avg/max` : "bytes ?",
    `dropped ${dropped}${dropped ? ` (rate ${done.rate} · flush ${done.flush} · source ${done.source})` : ""}`,
    ...(done.sendN ? [`send ${pair(done.send, done.sendN, done.sendMax)} x${done.sendN}`] : []),
    ...(lag ? [`lag ${ms(lag.avg)}/${ms(lag.max)} ms`] : []),
    ...(typeof heap === "number" ? [`heap ${(heap / 1048576).toFixed(1)} MB`] : []),
  ].join(" · ");
  const entry: MicEntryKind = done.fn ? "fn" : done.message ? "message" : done.event ? "event" : "none";
  const busy = done.callN ? done.call : done.ours;
  const sdk = [
    `mic-entry ${entry} (fn ${done.fn} · message ${done.message} · event ${done.event} · direct ${done.direct})`,
    done.decodeN ? `sdk-decode ${pair(done.decode, done.decodeN, done.decodeMax)} avg/max` : "sdk-decode not measurable",
    ...(done.callN ? [`call ${pair(done.call, done.callN, done.callMax)}`] : []),
    done.logSkipped ? `sdk-log skipped x${done.logSkipped}` : done.logN ? `sdk-log ${pair(done.log, done.logN, done.logMax)} x${done.logN}` : "sdk-log none seen",
    ...(done.rawN ? [`raw ${done.rawShape || "?"} ${done.rawMin}/${Math.round(done.rawSum / done.rawN)}/${done.rawMax} min/avg/max`] : []),
    `busy ${(busy / (seconds * 10)).toFixed(1)} %`,
  ].join(" · ");
  w = fresh(at);
  return { mic, sdk };
}

/** Test hook: remove the probes and forget everything. */
export function resetMicProbeForTest(): void {
  restore?.();
  w = fresh(); entryAt = 0; entryDepth = 0; entryRaw = undefined; callAudio = false; callCounted = false; messageAt = 0; messageRaw = undefined; eventPending = false; lastArrival = 0; quiet = true; installed = false;
  seen.fn = 0; seen.message = 0; seen.event = 0; seen.direct = 0;
}
