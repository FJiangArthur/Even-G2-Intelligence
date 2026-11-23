/**
 * On-device lifecycle diagnostics (iOS WKWebView / Android WebView suspend and reclaim are not
 * reproducible in a simulator).
 * A small ring buffer in the WebView's own localStorage, mirrored into the Even bridge storage (v0.11.1).
 * Never records keys, transcript text or provider payloads — only lifecycle facts and error messages.
 */
import { micProbeCheck, micProbeHealth, micProbeState, micProbeWindow } from "./mic-probe";

const KEY = "helix.diagnostics.v1";
const MAX = 120;

export interface DiagnosticEvent { readonly t: string; readonly kind: string; readonly detail?: string }

function storage(): Storage | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

// ---- v0.11.1 persisted copy ----
// On iOS the Even app's WebView did not keep window.localStorage across launches (a diagnostics dump
// taken right after a freeze showed neither earlier events nor a heartbeat). Events and the heartbeat
// are therefore mirrored into the Even bridge storage, where settings already survive.
export const DIAGNOSTICS_STORE_KEY = "helix.diagnostics.v2";
export interface DiagnosticsStore { getLocalStorage(key: string): Promise<string>; setLocalStorage(key: string, value: string): Promise<boolean> }
let remote: DiagnosticsStore | undefined;
/** Authoritative once a store is attached (window.localStorage may be empty or unavailable). */
let memory: DiagnosticEvent[] | undefined;
let remoteHeartbeat: Heartbeat | undefined;
let lastHeartbeat: Heartbeat | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined, flushing = false, flushAgain = false;
// v0.15: a mirror write the bridge never answers is given up after 5 s, so later lines (the evidence of a
// hang) still go out; retries wait 5, 10, then 20 s so a backed-up bridge gets at most one write per step.
const FLUSH_DEADLINE_MS = 5000, FLUSH_BACKOFF_MAX_MS = 20_000;
let flushBatch = 0, flushTimeouts = 0, flushBlockedUntil = 0, flushDeadline: ReturnType<typeof setTimeout> | undefined;

function validEvents(parsed: unknown): DiagnosticEvent[] {
  return Array.isArray(parsed) ? parsed.filter((e): e is DiagnosticEvent => !!e && typeof (e as DiagnosticEvent).kind === "string" && typeof (e as DiagnosticEvent).t === "string") : [];
}
function readLocal(): DiagnosticEvent[] {
  try { const raw = storage()?.getItem(KEY); return validEvents(raw ? JSON.parse(raw) : []).slice(-MAX); } catch { return []; }
}
export function readDiagnostics(): DiagnosticEvent[] { return memory ? memory.slice() : readLocal(); }

/** v0.12.1: the heartbeat has its own small key, so the 10 s beat no longer rewrites the whole event log. */
export const HEARTBEAT_STORE_KEY = "helix.heartbeat.v2";
let eventsDirty = false, beatDirty = false, micDirty = false;
function flushRemote(): void {
  if (!remote) return;
  if (flushing) { flushAgain = true; return; }
  if (!eventsDirty && !beatDirty && !micDirty) return;
  const wait = flushBlockedUntil - Date.now();
  if (wait > 0) { flushTimer ??= setTimeout(() => { flushTimer = undefined; flushRemote(); }, wait); return; }
  flushing = true;
  const store = remote, writes: Promise<unknown>[] = [];
  const batch = ++flushBatch, had = { events: eventsDirty, beat: beatDirty, mic: micDirty };
  let settled = false;
  // Runs once per batch; a late answer of a timed-out batch must not release a newer one.
  const finish = (timedOut: boolean) => {
    if (settled) return;
    settled = true;
    if (batch !== flushBatch) return;
    clearTimeout(flushDeadline); flushDeadline = undefined;
    flushing = false;
    if (timedOut) {
      eventsDirty ||= had.events; beatDirty ||= had.beat; micDirty ||= had.mic;
      flushAgain = false;
      flushBlockedUntil = Date.now() + Math.min(FLUSH_BACKOFF_MAX_MS, FLUSH_DEADLINE_MS * 2 ** Math.min(4, flushTimeouts++));
      flushRemote(); // arms the retry timer
      return;
    }
    flushTimeouts = 0;
    if (flushAgain) { flushAgain = false; flushRemote(); }
  };
  try {
    if (eventsDirty) { eventsDirty = false; const payload = JSON.stringify({ events: readDiagnostics() }); writes.push(Promise.resolve().then(() => store.setLocalStorage(DIAGNOSTICS_STORE_KEY, payload))); }
    if (beatDirty) { beatDirty = false; const payload = JSON.stringify(lastHeartbeat ?? null); writes.push(Promise.resolve().then(() => store.setLocalStorage(HEARTBEAT_STORE_KEY, payload))); }
    if (micDirty) { micDirty = false; const payload = JSON.stringify({ events: micLog }); writes.push(Promise.resolve().then(() => store.setLocalStorage(MIC_STORE_KEY, payload))); }
  } catch { /* unserializable: skip this round */ }
  flushDeadline = setTimeout(() => finish(true), FLUSH_DEADLINE_MS);
  void Promise.all(writes.map(write => write.catch(() => false))).then(() => finish(false));
}
/** Urgent writes go out now (the next thing may be a hang); the rest are coalesced. */
function scheduleRemote(urgent: boolean, what: "events" | "beat" | "mic" = "events"): void {
  if (what === "events") { eventsDirty = true; if (urgent && micPending) { micPending = 0; micDirty = true; } } else if (what === "beat") beatDirty = true; else micDirty = true;
  if (!remote) return;
  if (urgent) { clearTimeout(flushTimer); flushTimer = undefined; flushRemote(); return; }
  flushTimer ??= setTimeout(() => { flushTimer = undefined; flushRemote(); }, 400);
}

/**
 * Loads the persisted copy (events + last heartbeat of the previous run) and mirrors every later
 * event into it. Call before watchLifecycle. Never throws and never waits more than `timeoutMs`.
 */
export async function attachDiagnosticsStore(store: DiagnosticsStore, timeoutMs = 1500): Promise<void> {
  let raw = "", rawBeat = "", rawMic = "";
  try {
    [raw, rawBeat, rawMic] = await Promise.race([Promise.all([store.getLocalStorage(DIAGNOSTICS_STORE_KEY), store.getLocalStorage(HEARTBEAT_STORE_KEY).catch(() => ""), store.getLocalStorage(MIC_STORE_KEY).catch(() => "")]),
      new Promise<[string, string, string]>(done => setTimeout(() => done(["", "", ""]), timeoutMs))]);
  } catch { /* no persisted copy */ }
  try { micLog = mergeEvents(validEvents(rawMic ? (JSON.parse(rawMic) as { events?: unknown }).events : []), micLog).slice(-MIC_MAX); } catch { /* unreadable microphone log */ }
  try {
    const hb = rawBeat ? JSON.parse(rawBeat) as Partial<Heartbeat> | null : null;
    if (hb && typeof hb.at === "number" && typeof hb.boot === "number") remoteHeartbeat = hb as Heartbeat;
  } catch { /* unreadable heartbeat */ }
  let saved: DiagnosticEvent[] = [];
  try {
    const parsed = raw ? JSON.parse(raw) as { events?: unknown; heartbeat?: Partial<Heartbeat> } : undefined;
    saved = validEvents(parsed?.events);
    const hb = parsed?.heartbeat;
    // <= 0.12.0 kept the heartbeat inside the event payload.
    if (!remoteHeartbeat && hb && typeof hb.at === "number" && typeof hb.boot === "number") remoteHeartbeat = hb as Heartbeat;
  } catch { /* unreadable copy: start fresh */ }
  memory = mergeEvents(saved, readLocal()).slice(-MAX);
  remote = store;
}
function mergeEvents(a: readonly DiagnosticEvent[], b: readonly DiagnosticEvent[]): DiagnosticEvent[] {
  const seen = new Set<string>(), merged: DiagnosticEvent[] = [];
  for (const event of [...a, ...b].sort((x, y) => x.t < y.t ? -1 : x.t > y.t ? 1 : 0)) {
    const id = `${event.t}|${event.kind}|${event.detail ?? ""}`;
    if (!seen.has(id)) { seen.add(id); merged.push(event); }
  }
  return merged;
}
/** Test hook: forget the attached store and in-memory copy. */
export function resetDiagnosticsForTest(): void {
  remote = undefined; memory = undefined; remoteHeartbeat = undefined; lastHeartbeat = undefined; previousExit = null;
  clearTimeout(flushTimer); flushTimer = undefined; flushing = false; flushAgain = false; eventsDirty = false; beatDirty = false; taps.length = 0;
  clearTimeout(flushDeadline); flushDeadline = undefined; flushBatch += 1; flushTimeouts = 0; flushBlockedUntil = 0; pending.clear(); io.clear(); slowLogged.clear();
  micLog = []; micLoaded = true; micDirty = false; micPending = 0; lagSum = 0; lagN = 0; lagMax = 0; lateAt = 0; lateMs = 0;
}

const SECRETISH = /\b(?:sk|rk|pk|ek)-[A-Za-z0-9_-]{8,}|\bBearer\s+\S+/gu;
// audio-overload / audio-flush / audio-resume: the page may hang or be killed right after, so they go out at once.
const URGENT = /^(?:error|unhandledrejection|stall|bridge-stuck|bridge-slow|startup-failed|previous-page|audio-(?:overload|flush|resume))/u;

export function recordDiagnostic(kind: string, detail?: string): void {
  try {
    const events = readDiagnostics();
    events.push({ t: new Date().toISOString(), kind, ...(detail ? { detail: detail.replace(SECRETISH, "[redacted]").slice(0, 300) } : {}) });
    const kept = events.slice(-MAX);
    if (memory) memory = kept;
    try { storage()?.setItem(KEY, JSON.stringify(kept)); } catch { /* the persisted copy still gets it */ }
    scheduleRemote(URGENT.test(kind));
  } catch { /* diagnostics must never break the app */ }
}

export function clearDiagnostics(): void {
  if (memory) memory = [];
  micLog = []; micLoaded = true; micDirty = true; micPending = 0;
  try { storage()?.removeItem(KEY); storage()?.removeItem(MIC_KEY); } catch { /* ignore */ }
  scheduleRemote(true);
}

// ---- v0.13.2 microphone timing log ----
// Two lines per 10 s heartbeat while audio events arrive (see mic-probe.ts for what they measure). Kept in
// their own ring so three minutes of them cannot push lifecycle events out of the main log, and written to
// the Even bridge storage only every third heartbeat (a bridge write is itself load on a busy phone).
const MIC_KEY = "helix.diagnostics.mic.v1";
export const MIC_STORE_KEY = "helix.diagnostics.mic.v2";
const MIC_MAX = 40, MIC_REMOTE_EVERY = 3;
let micLog: DiagnosticEvent[] = [], micLoaded = false, micPending = 0;
function micEvents(): DiagnosticEvent[] {
  if (!micLoaded) { micLoaded = true; try { const raw = storage()?.getItem(MIC_KEY); micLog = mergeEvents(validEvents(raw ? JSON.parse(raw) : []), micLog).slice(-MIC_MAX); } catch { /* start empty */ } }
  return micLog;
}
const PRESSURE_CALL_MAX_AGE_MS = 15_000;
// Main-thread timer lateness, from the 1 s watchdog below (visible page only).
let lagSum = 0, lagN = 0, lagMax = 0, lateAt = 0, lateMs = 0;
/**
 * Closes the microphone timing window and logs it (`mic` and `mic-sdk` lines). The heartbeat calls this
 * every 10 s; returns the lines for tests. Nothing is written when no audio event arrived.
 */
export function recordMicWindow(): { mic: string; sdk: string } | undefined {
  try {
    const before = micProbeHealth(), health = micProbeCheck();
    // The probe or the log skip stopped working since the last heartbeat: say so once, in the main log.
    if (health !== before && health !== "ok") recordDiagnostic("mic-probe", health);
    const report = micProbeWindow(lagN ? { avg: lagSum / lagN, max: lagMax } : undefined);
    lagSum = 0; lagN = 0; lagMax = 0;
    if (!report) return undefined;
    const t = new Date().toISOString();
    micLog = [...micEvents(), { t, kind: "mic", detail: report.mic.slice(0, 300) }, { t, kind: "mic-sdk", detail: report.sdk.slice(0, 300) }].slice(-MIC_MAX);
    try { storage()?.setItem(MIC_KEY, JSON.stringify(micLog)); } catch { /* the persisted copy still gets it */ }
    if (++micPending >= MIC_REMOTE_EVERY) { micPending = 0; scheduleRemote(false, "mic"); }
    return report;
  } catch { return undefined; /* diagnostics must never break the app */ }
}
/**
 * Evidence that the main thread or the Even bridge is backed up right now: the age of the oldest
 * unanswered bridge call, and the worst timer lateness in the last 6 s. Used by the microphone guard
 * as a second signal next to the audio delivery rate.
 */
export function mainThreadPressure(now = Date.now()): { bridgePendingMs: number; timerLateMs: number } {
  let oldest = now;
  // Only calls issued in the last 15 s: the guard acts within seconds of a backlog, so an older unanswered
  // call is a hung call (a display write the glasses never acknowledged), not evidence of queued audio.
  for (const call of pending.values()) if (call.at < oldest && now - call.at <= PRESSURE_CALL_MAX_AGE_MS) oldest = call.at;
  return { bridgePendingMs: now - oldest, timerLateMs: now - lateAt <= 6000 ? lateMs : 0 };
}

// ---- v0.11.1 hang evidence: last taps, main-thread stalls, Even bridge calls that never return ----
const taps: { at: number; label: string }[] = [];
/** A control was used. Labels are ids/classes only, never on-screen text. */
export function markActivity(label: string, now = Date.now()): void {
  taps.push({ at: now, label: label.slice(0, 40) });
  if (taps.length > 4) taps.shift();
}
function tapTrail(now = Date.now()): string | undefined {
  return taps.length ? taps.map(tap => `${tap.label} ${Math.max(0, Math.round((now - tap.at) / 1000))}s`).join(" > ") : undefined;
}
function describeTarget(target: unknown): string | undefined {
  const node = target as { closest?: (selector: string) => { id?: string; dataset?: Record<string, string | undefined>; className?: unknown; tagName?: string } | null } | null;
  const control = node?.closest?.("button,[role=tab],a,summary,select,input,textarea");
  if (!control) return undefined;
  const data = control.dataset ?? {};
  return control.id || (data.detailTab && `detail-tab:${data.detailTab}`) || (data.mode && `mode:${data.mode}`) || (data.sessionId && "session-row")
    || (typeof control.className === "string" && control.className.split(/\s+/u).filter(Boolean).slice(0, 2).join(".")) || control.tagName?.toLowerCase();
}

const pending = new Map<number, { method: string; at: number }>();
/** Glasses writes since the last heartbeat: count and slowest answer per kind. */
const IO_NAMES: Record<string, string> = { textContainerUpgrade: "text", updateImageRawData: "image", rebuildPageContainer: "page", createStartUpPageContainer: "page", audioControl: "mic" };
const io = new Map<string, { n: number; max: number }>();
const slowLogged = new Map<string, number>();
/** Counts something per heartbeat window (e.g. "uplink-pause", "render"); shows up beside the glasses writes. */
export function countDiagnostic(name: string, ms = 0): void {
  const stat = io.get(name) ?? { n: 0, max: 0 }; stat.n += 1; stat.max = Math.max(stat.max, ms); io.set(name, stat);
}
function ioSummary(): string | undefined {
  if (!io.size) return undefined;
  const text = [...io].map(([name, stat]) => stat.max ? `${name} ${stat.n}x max ${(stat.max / 1000).toFixed(1)}s` : `${name} ${stat.n}x`).join(", ");
  io.clear();
  return text;
}
let callId = 0;
const BRIDGE_SLOW_MS = 1500, BRIDGE_STUCK_MS = 8000;
function bridgeHealth(now = Date.now()): string | undefined {
  let oldest: { method: string; at: number } | undefined;
  for (const call of pending.values()) if (!oldest || call.at < oldest.at) oldest = call;
  return oldest && now - oldest.at > 1000 ? `${pending.size} pending, oldest ${oldest.method} ${Math.round((now - oldest.at) / 1000)}s` : undefined;
}
/**
 * Wraps the Even bridge so calls that take long or never return are logged: when the phone screen
 * stops responding but timers keep running, the hang is on the native side of this boundary.
 */
export function monitorBridge<T extends object>(bridge: T): T {
  return new Proxy(bridge, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== "function" || typeof property !== "string") return value;
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (!result || typeof (result as PromiseLike<unknown>).then !== "function" || args[0] === DIAGNOSTICS_STORE_KEY || args[0] === HEARTBEAT_STORE_KEY || args[0] === MIC_STORE_KEY) return result;
        const id = ++callId, at = Date.now();
        pending.set(id, { method: property, at });
        const settle = () => {
          pending.delete(id);
          const took = Date.now() - at, name = IO_NAMES[property];
          if (name) { const stat = io.get(name) ?? { n: 0, max: 0 }; stat.n += 1; stat.max = Math.max(stat.max, took); io.set(name, stat); }
          // At most one line per method every 5 s, so a bad link cannot push everything else out of the log.
          if (took >= BRIDGE_SLOW_MS && Date.now() - (slowLogged.get(property) ?? 0) > 5000) {
            slowLogged.set(property, Date.now());
            recordDiagnostic("bridge-slow", `${property} ${(took / 1000).toFixed(1)} s`);
          }
        };
        (result as PromiseLike<unknown>).then(settle, settle);
        return result;
      };
    },
  });
}

// ---- v0.9.1 heartbeat: tells "the phone killed the page" apart from a normal close ----
// iOS terminates a backgrounded WKWebView content process under memory pressure without any page
// event, so the only trace is a heartbeat that stopped without a clean pagehide. One ~150-byte write
// every 10 s (and on visibility changes, taps and stalls), also mirrored into the Even bridge storage.
export const HEARTBEAT_KEY = "helix.heartbeat.v1";
export const HEARTBEAT_MS = 10_000;
export const STALL_TICK_MS = 1000, STALL_MIN_MS = 1500, SUSPEND_GAP_MS = 15_000;
interface Heartbeat { at: number; boot: number; visible: boolean; hiddenAt?: number; clean?: boolean; state?: string; taps?: string; stalls?: number; maxStall?: number; bridge?: string; io?: string }
/** Verdict on the previous page load; null until read (the UI may ask before watchLifecycle runs). */
let previousExit: string | undefined | null = null;
function readPreviousExit(): { kind: string; detail: string } | undefined {
  const exit = describePreviousExit(readHeartbeat());
  previousExit = exit ? `${exit.kind === "previous-page-killed" ? "ended unexpectedly" : "closed normally"} · ${exit.detail}` : undefined;
  return exit;
}

function readHeartbeat(): Heartbeat | undefined {
  let local: Heartbeat | undefined;
  try {
    const raw = storage()?.getItem(HEARTBEAT_KEY), parsed: unknown = raw ? JSON.parse(raw) : undefined;
    const hb = parsed as Partial<Heartbeat> | undefined;
    if (hb && typeof hb.at === "number" && typeof hb.boot === "number") local = hb as Heartbeat;
  } catch { /* fall back to the persisted copy */ }
  return local && remoteHeartbeat ? (local.at >= remoteHeartbeat.at ? local : remoteHeartbeat) : local ?? remoteHeartbeat;
}
function writeHeartbeat(hb: Heartbeat, urgent = false): void {
  lastHeartbeat = hb;
  try { storage()?.setItem(HEARTBEAT_KEY, JSON.stringify(hb)); } catch { /* ignore */ }
  scheduleRemote(urgent, "beat");
}
/** Seconds under two minutes: tells an automatic reload (a few seconds) from a manual relaunch. */
function ago(ms: number): string { return ms < 120_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : minutes(ms); }
function minutes(ms: number): string { const m = Math.max(0, Math.round(ms / 60_000)); return m < 1 ? "<1 min" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; }

/** How the previous page load ended, judged from its last heartbeat (undefined on the first run). */
export function describePreviousExit(previous: Heartbeat | undefined, now = Date.now()): { kind: string; detail: string } | undefined {
  if (!previous) return undefined;
  const ran = minutes(previous.at - previous.boot), since = ago(now - previous.at);
  const where = previous.visible ? "while on screen" : `after ${minutes(previous.at - (previous.hiddenAt ?? previous.at))} in the background`;
  const state = (previous.state ? ` · ${previous.state}` : "") + (previous.taps ? ` · taps: ${previous.taps}` : "")
    + (previous.stalls ? ` · ${previous.stalls} stall${previous.stalls === 1 ? "" : "s"}, longest ${((previous.maxStall ?? 0) / 1000).toFixed(1)} s` : "")
    + (previous.bridge ? ` · Even bridge: ${previous.bridge}` : "") + (previous.io ? ` · activity in the last ${HEARTBEAT_MS / 1000} s: ${previous.io}` : "");
  if (previous.clean) return { kind: "previous-page-closed", detail: `ran ${ran}, closed normally ${since} ago${state}` };
  return { kind: "previous-page-killed", detail: `ran ${ran}, last alive ${since} before this launch ${where}${state} · ended with no close event: ${previous.visible ? "the page hung or the Even app was force-closed" : "iOS reclaimed the page (memory pressure) or the Even app closed it"}` };
}
/** Summary line for the report and Setup → Diagnostics. */
export function previousPageExit(): string | undefined {
  if (previousExit === null) readPreviousExit();
  return previousExit ?? undefined;
}

/** Human-readable report for Setup → Diagnostics (copyable). */
export function diagnosticsReport(): string {
  const nav = (() => { try { return (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type ?? "unknown"; } catch { return "unknown"; } })();
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  const lines = [
    `Helix ${typeof __HELIX_VERSION__ === "string" ? __HELIX_VERSION__ : "dev"} diagnostics · ${new Date().toISOString()}`,
    `ua: ${navigator.userAgent}`,
    `this page load: ${nav} · visible: ${document.visibilityState}`,
    ...(previousExit ? [`previous page: ${previousExit}`] : []),
    `log storage: ${remote ? "Even bridge + WebView" : "WebView only"}${lastHeartbeat?.stalls ? ` · stalls this run: ${lastHeartbeat.stalls}, longest ${((lastHeartbeat.maxStall ?? 0) / 1000).toFixed(1)} s` : ""}${bridgeHealth() ? ` · Even bridge: ${bridgeHealth()}` : ""}`,
    ...(memory ? [`js heap: ${(memory.usedJSHeapSize / 1048576).toFixed(1)} MB of ${(memory.jsHeapSizeLimit / 1048576).toFixed(0)} MB`] : []),
    `microphone: ${micProbeState()}`,
    "",
    // The `mic` / `mic-sdk` lines (one pair per 10 s while audio arrives) are merged in by time.
    ...mergeEvents(readDiagnostics(), micEvents()).map(e => `${e.t}  ${e.kind}${e.detail ? `  ${e.detail}` : ""}`),
  ];
  return lines.join("\n");
}

/**
 * Wires page-lifecycle + error listeners. `onResume` runs when the page comes back after being hidden
 * or frozen (Chromium Page Lifecycle `resume`, `pageshow` from bfcache, `visibilitychange` to visible);
 * `onHide` runs when it may be frozen or discarded next (flush state there).
 */
export function watchLifecycle(handlers: { onResume: (reason: string) => void; onHide: (reason: string) => void; describe?: () => string }): () => void {
  const nav = (() => { try { return (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type ?? "unknown"; } catch { return "unknown"; } })();
  const wasDiscarded = (document as Document & { wasDiscarded?: boolean }).wasDiscarded;
  recordDiagnostic("boot", `navigation=${nav}${wasDiscarded ? " wasDiscarded=true (Chromium discarded the page in the background)" : ""}`);
  const exit = readPreviousExit(); // Before this load's first heartbeat overwrites it.
  if (exit) recordDiagnostic(exit.kind, exit.detail);
  const boot = Date.now();
  let hiddenAt = document.visibilityState === "visible" ? undefined : boot;
  let stalls = 0, maxStall = 0;
  const beat = (clean?: boolean, urgent = false) => {
    let state: string | undefined; try { state = handlers.describe?.().slice(0, 120); } catch { /* optional */ }
    const trail = tapTrail(), bridge = bridgeHealth(), glassesIo = urgent ? lastHeartbeat?.io : ioSummary() ?? undefined;
    writeHeartbeat({ at: Date.now(), boot, visible: document.visibilityState === "visible", ...(hiddenAt !== undefined ? { hiddenAt } : {}), ...(clean ? { clean } : {}), ...(state ? { state } : {}),
      ...(trail ? { taps: trail } : {}), ...(stalls ? { stalls, maxStall } : {}), ...(bridge ? { bridge } : {}), ...(glassesIo ? { io: glassesIo } : {}) }, urgent);
  };
  beat();
  const heartbeat = setInterval(() => { recordMicWindow(); beat(); }, HEARTBEAT_MS);
  // Main-thread stall timer: a 1 s tick that arrives late while the page is on screen means the page
  // could not handle taps or scrolling for that long. Late ticks after a background stay are ignored.
  let lastSuspendResume = 0;
  let lastTick = Date.now(), visibleSince = document.visibilityState === "visible" ? boot : Number.POSITIVE_INFINITY, stuckReported = 0;
  const watchdog = setInterval(() => {
    const now = Date.now(), late = now - lastTick - STALL_TICK_MS, since = lastTick;
    lastTick = now;
    // No timer for 15 s or more: the WebView was suspended (phone locked, app in the background). Sockets and
    // the glasses page may be stale, so run the resume path even if no visibility event arrives. Once a minute at most.
    if (late >= SUSPEND_GAP_MS && now - lastSuspendResume > 60_000) {
      lastSuspendResume = now;
      recordDiagnostic("suspended", `${Math.round(late / 1000)} s without running · ${document.visibilityState}`);
      try { handlers.onResume("timer-gap"); } catch { /* resume is best effort */ }
    }
    // Every on-screen tick's lateness feeds the microphone timing line and the microphone guard.
    if (late < SUSPEND_GAP_MS && document.visibilityState === "visible" && visibleSince <= since) {
      const lag = Math.max(0, late);
      lagSum += lag; lagN += 1; if (lag > lagMax) lagMax = lag;
      if (lag >= 200 && (now - lateAt > 6000 || lag >= lateMs)) { lateAt = now; lateMs = lag; }
    }
    // Timers arriving 0.2-1.5 s late: the page is struggling (heavy work, or the phone is throttling a hot app).
    if (late >= 200 && late < STALL_MIN_MS && document.visibilityState === "visible" && visibleSince <= since) countDiagnostic("timer-late", late);
    if (late >= STALL_MIN_MS && document.visibilityState === "visible" && visibleSince <= since) {
      stalls += 1; maxStall = Math.max(maxStall, late);
      let state = ""; try { state = handlers.describe?.().slice(0, 80) ?? ""; } catch { /* optional */ }
      recordDiagnostic("stall", `${(late / 1000).toFixed(1)} s main thread blocked${state ? ` · ${state}` : ""}${tapTrail(now) ? ` · taps: ${tapTrail(now)}` : ""}`);
      beat(false, true);
    }
    const health = bridgeHealth(now), oldest = [...pending.values()].reduce((min, call) => Math.min(min, call.at), now);
    if (health && now - oldest >= BRIDGE_STUCK_MS && now - stuckReported > 60_000) { stuckReported = now; recordDiagnostic("bridge-stuck", health); beat(false, true); }
  }, STALL_TICK_MS);
  // Written before the control's own handler runs, so a tap that hangs the page still leaves its name.
  let lastTapBeat = 0;
  const tap = (event: Event) => {
    const label = describeTarget(event.target);
    if (!label) return;
    markActivity(label);
    if (Date.now() - lastTapBeat > 1000) { lastTapBeat = Date.now(); beat(false, true); }
  };
  document.addEventListener("click", tap, true);
  const visibility = () => {
    recordDiagnostic(`visibility:${document.visibilityState}`);
    hiddenAt = document.visibilityState === "visible" ? undefined : Date.now();
    visibleSince = document.visibilityState === "visible" ? Date.now() : Number.POSITIVE_INFINITY;
    beat();
    if (document.visibilityState === "visible") handlers.onResume("visible"); else handlers.onHide("hidden");
  };
  const freeze = () => { recordDiagnostic("freeze"); handlers.onHide("freeze"); };
  const resume = () => { recordDiagnostic("resume"); visibleSince = Date.now(); handlers.onResume("resume"); };
  const pageshow = (event: PageTransitionEvent) => { recordDiagnostic("pageshow", event.persisted ? "persisted" : undefined); if (event.persisted) handlers.onResume("pageshow"); };
  // A non-persisted pagehide is a real close or reload; a persisted one may come back from bfcache.
  const pagehide = (event: PageTransitionEvent) => { recordDiagnostic("pagehide", event.persisted ? "persisted" : undefined); beat(!event.persisted, true); handlers.onHide("pagehide"); };
  const error = (event: ErrorEvent) => recordDiagnostic("error", event.message);
  const rejection = (event: PromiseRejectionEvent) => recordDiagnostic("unhandledrejection", event.reason instanceof Error ? event.reason.message : String(event.reason));
  document.addEventListener("visibilitychange", visibility);
  document.addEventListener("freeze", freeze);
  document.addEventListener("resume", resume);
  window.addEventListener("pageshow", pageshow);
  window.addEventListener("pagehide", pagehide);
  window.addEventListener("error", error);
  window.addEventListener("unhandledrejection", rejection);
  return () => {
    clearInterval(heartbeat); clearInterval(watchdog);
    document.removeEventListener("click", tap, true);
    beat(true, true);
    document.removeEventListener("visibilitychange", visibility);
    document.removeEventListener("freeze", freeze);
    document.removeEventListener("resume", resume);
    window.removeEventListener("pageshow", pageshow);
    window.removeEventListener("pagehide", pagehide);
    window.removeEventListener("error", error);
    window.removeEventListener("unhandledrejection", rejection);
  };
}
