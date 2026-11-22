// Microphone overload repro for a desktop browser: the PRODUCTION app and the REAL Even Hub SDK bridge,
// talking to a simulated Even app. Not hardware evidence - it only shows the guard reacting to the same
// numbers that were measured on a phone.
//
// The simulated host has ONE queue towards the page, like the measured one: audio events (pushed through
// window._listenEvenAppMessage as JSON with base64 PCM, 42 a second) and the replies to our bridge calls.
// Normally the queue is served as fast as it fills. "Degrade" serves one item per 40 ms (25 a second), so
// the queue grows and replies wait behind the audio, until the microphone is closed.
//   ?after=20   degrade automatically N seconds after listening starts (default 20, 0 = never)
//   ?heal=0     stay degraded after the queue drains (default: one flush cures it; 0 shows the escalation)
//   ?audio=all  no guard at all: watch the queue and the reply latency run away
//   ?burn=1     also block the main thread for the service time (page really janks)
import { EvenAppBridge } from "@evenrealities/even_hub_sdk";
import { DirectConversationTransport } from "@helix/conversation-sdk";
import { bootstrap } from "../src/app";
import { diagnosticsReport, monitorBridge } from "../src/diagnostics";
import { installMicProbe } from "../src/mic-probe";
import { createFakeOpenAI } from "../tests/fake-openai";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const afterSeconds = Number(params.get("after") ?? "20"), heal = params.get("heal") !== "0", burn = params.get("burn") === "1";
const EVENT_MS = 24, SLOW_MS = 40;

installMicProbe(); // before the bridge, as main.ts does

// ---- simulated Even app ----
type Item = { at: number; run: () => void; audio: boolean };
const queue: Item[] = [];
const state = { micOpen: false, source: "glasses", degraded: false, serviceMs: 0, produced: 0, delivered: 0, replies: 0, maxReplyMs: 0, lastReplyMs: 0, maxQueue: 0, calls: [] as string[] };
(window as unknown as { __host: typeof state }).__host = state;
const storage = new Map<string, string>();
const began = performance.now();
const stamp = () => `${((performance.now() - began) / 1000).toFixed(1)}s`;
const note = (text: string) => { state.calls.push(`${stamp()} ${text}`); if (state.calls.length > 14) state.calls.shift(); };

let pumping = false;
function pump(): void {
  if (pumping) return;
  pumping = true;
  const step = (): void => {
    const item = queue.shift();
    if (!item) { pumping = false; if (state.degraded && heal) { state.degraded = false; state.serviceMs = 0; note("queue drained: host back to normal"); } return; }
    if (burn && state.serviceMs) { const until = performance.now() + state.serviceMs - 1; while (performance.now() < until) { /* the page is busy */ } }
    item.run();
    if (item.audio) state.delivered++;
    if (state.serviceMs) setTimeout(step, burn ? 1 : state.serviceMs); else if (queue.length) queueMicrotask(step); else pumping = false;
  };
  if (state.serviceMs) setTimeout(step, 0); else step();
}
function toPage(run: () => void, audio = false): void {
  queue.push({ at: performance.now(), run, audio });
  state.maxQueue = Math.max(state.maxQueue, queue.length);
  pump();
}

// The microphone: 20 ms of 16 kHz PCM every 24 ms (42 a second, as measured), speech-like noise in bursts.
const base64 = (bytes: Uint8Array): string => { let text = ""; for (const byte of bytes) text += String.fromCharCode(byte); return btoa(text); };
let tick = 0;
setInterval(() => {
  if (!state.micOpen) return;
  const pcm = new Int16Array(320), speaking = (tick++ * EVENT_MS) % 6000 < 4200;
  if (speaking) for (let i = 0; i < pcm.length; i++) pcm[i] = (Math.random() - 0.5) * 6000;
  const message = JSON.stringify({ type: "listen_even_app_data", method: "evenHubEvent", data: { type: "audioEvent", jsonData: { source: state.source, audioPcm: base64(new Uint8Array(pcm.buffer)) } } });
  state.produced++;
  toPage(() => (window as unknown as { _listenEvenAppMessage: (message: string) => void })._listenEvenAppMessage(message), true);
}, EVENT_MS);

const answers: Record<string, (data: Record<string, unknown>) => unknown> = {
  getLocalStorage: data => storage.get(String(data.key)) ?? "",
  setLocalStorage: data => { storage.set(String(data.key), String(data.value)); return true; },
  createStartUpPageContainer: () => 0,
  updateImageRawData: () => "success",
  audioControl: data => {
    // The host acts on the call at once; only its reply waits in the queue.
    state.micOpen = data.isOpen === true; if (state.micOpen) state.source = String(data.source ?? "glasses");
    note(`audioControl(${String(data.isOpen)}, ${String(data.source)}) · queue ${queue.length}`);
    return true;
  },
};
(window as unknown as { flutter_inappwebview: unknown }).flutter_inappwebview = {
  callHandler: (_name: string, payload: string) => new Promise(resolve => {
    const call = JSON.parse(payload) as { method: string; data?: Record<string, unknown> };
    const result = (answers[call.method] ?? (() => true))(call.data ?? {});
    const asked = performance.now();
    toPage(() => { state.replies++; state.lastReplyMs = performance.now() - asked; state.maxReplyMs = Math.max(state.maxReplyMs, state.lastReplyMs); resolve(result); });
  }),
};
const degrade = (sticky: boolean): void => { state.degraded = true; state.serviceMs = SLOW_MS; note(`host degraded: one item per ${SLOW_MS} ms${sticky ? " (sticky)" : ""}`); };

// ---- fake transcription socket (no network, no keys) ----
class QuietSocket {
  readyState = 0; onopen: (() => void) | null = null; onmessage: ((e: { data: string }) => void) | null = null; onerror: (() => void) | null = null; onclose: (() => void) | null = null;
  private item = 0;
  constructor() { setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 20); }
  send(data: string): void {
    const message = JSON.parse(data) as { type: string };
    if (message.type !== "input_audio_buffer.commit") return;
    const id = `item_${this.item++}`;
    this.onmessage?.({ data: JSON.stringify({ type: "input_audio_buffer.committed", item_id: id }) });
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: "Simulated speech." }) }), 300);
  }
  close(): void { this.readyState = 3; }
}

const panel = document.createElement("pre");
panel.id = "mic-guard-panel";
panel.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:9999;max-width:min(760px,96vw);max-height:70vh;overflow:auto;margin:0;padding:10px 12px;font:11px/1.45 ui-monospace,Menlo,monospace;background:#0b1220;color:#d7e3f4;border:1px solid #33415c;border-radius:8px;white-space:pre-wrap";
const buttons = document.createElement("div");
buttons.style.cssText = "position:fixed;right:8px;top:8px;z-index:9999;display:flex;gap:6px";
for (const [label, action] of [["Degrade (heals when drained)", () => { if (!heal) location.search = "?heal=1&after=0"; else degrade(false); }], ["Degrade (sticky)", () => { if (heal) location.search = "?heal=0&after=0"; else degrade(true); }], ["Normal", () => { state.degraded = false; state.serviceMs = 0; note("host back to normal (button)"); }]] as const) {
  const button = document.createElement("button");
  button.type = "button"; button.textContent = label; button.style.cssText = "font:12px system-ui;padding:4px 8px"; button.addEventListener("click", action);
  buttons.append(button);
}
document.body.append(panel, buttons);

const bridge = monitorBridge(EvenAppBridge.getInstance());
const fake = createFakeOpenAI({ latency: { firstTokenMs: 400, interTokenMs: 40, jsonMs: 900, webSearchMs: 1200 } });
const app = await bootstrap(document.getElementById("app")!, bridge as never, {
  search: `?${params.toString()}`,
  transportFactory: options => new DirectConversationTransport({ ...options, fetch: fake.fetch, webSocketFactory: () => new QuietSocket() as never }),
});
const controller = app.controller as unknown as { audioFlushingForLoad: boolean; audioPausedForLoad: boolean; micSource: string };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
$<HTMLInputElement>("openai-api-key").value = "qa-fake-key";
$<HTMLButtonElement>("connect-button").click();
for (let i = 0; i < 100 && $<HTMLButtonElement>("start-button").disabled; i++) await new Promise(done => setTimeout(done, 50));
$<HTMLButtonElement>("start-button").click();
note("listening started");
if (afterSeconds > 0) setTimeout(() => degrade(!heal), afterSeconds * 1000);

// ---- live view ----
const lines: string[] = [];
(window as unknown as { __micGuard: unknown }).__micGuard = { state, lines, report: () => diagnosticsReport() };
let lastProduced = 0, lastDelivered = 0;
setInterval(() => {
  const guard = controller.audioPausedForLoad ? "LONG PAUSE" : controller.audioFlushingForLoad ? "FLUSHING" : "listening";
  const oldest = queue[0] ? performance.now() - queue[0].at : 0;
  const line = `${stamp().padStart(6)} mic ${state.micOpen ? "open  " : "closed"} host ${state.degraded ? "DEGRADED" : "normal  "} in ${String(state.produced - lastProduced).padStart(2)}/s out ${String(state.delivered - lastDelivered).padStart(2)}/s queue ${String(queue.length).padStart(4)} (oldest ${(oldest / 1000).toFixed(1)} s) last reply ${Math.round(state.lastReplyMs)} ms guard ${guard}`;
  lastProduced = state.produced; lastDelivered = state.delivered;
  lines.push(line); if (lines.length > 400) lines.shift();
  const diag = diagnosticsReport().split("\n").filter(text => /  (?:mic|mic-sdk|audio-overload|audio-flush|audio-resume|audio-backlog|bridge-slow|bridge-stuck|stall)  /u.test(text)).slice(-16).map(text => text.slice(11));
  panel.textContent = [`Helix microphone overload repro · ${heal ? "heals when the queue drains" : "sticky"} · max queue ${state.maxQueue} · slowest reply ${Math.round(state.maxReplyMs)} ms`, ...lines.slice(-12), "", "host:", ...state.calls.slice(-8), "", "diagnostics (as in Setup → Diagnostics):", ...diag].join("\n");
}, 1000);
console.log("MIC_GUARD_READY");
