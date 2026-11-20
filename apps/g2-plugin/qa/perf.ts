// Perf harness: the PRODUCTION app (bootstrap) in a plain browser with a simulated G2 bridge,
// simulated mic speech, a fake realtime socket that streams words like gpt-live-transcribe,
// fake OpenAI answers/copilot, and a pre-seeded history archive. No network, no keys.
import { AudioEvent, AudioInputSource, AudioSpeakerRole, StartUpPageCreateResult } from "@evenrealities/even_hub_sdk";
import { DirectConversationTransport } from "@helix/conversation-sdk";
import { bootstrap } from "../src/app";
import { createFakeOpenAI } from "../tests/fake-openai";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const historyMb = Number(params.get("historyMb") ?? "2");
/** Entries per seeded session: 300 = a few long meetings; 12 = hundreds of short imported conversations. */
const perSession = Number(params.get("per") ?? "300");
const perf = { storageWrites: 0, storageBytes: 0, storageMaxBytes: 0, glassesWrites: 0, glassesBytes: 0, images: 0, imageBytes: 0, rebuilds: 0, byKey: {} as Record<string, { writes: number; bytes: number; last: number }>, emits: 0, frames: 0, socketSends: 0, started: 0, errors: [] as string[] };
(window as unknown as { __perf: typeof perf }).__perf = perf;
window.addEventListener("error", e => perf.errors.push(String(e.message)));

// --- storage seeded with a realistic archive (sessions of transcript/answer entries) ---
const storage = new Map<string, string>();
const sentences = ["We should order the Jetson boards this week.", "Finance approved the budget for compute hardware this quarter.", "The perception stack runs ROS 2 Humble with the CDTF camera nodes.", "Is sixteen gigabytes of RAM enough for the detector?", "Elaine owns the calibration rig and will send the report on Thursday.", "The lead time for Orin modules is about twelve weeks right now."];
{
  const sessions = [], entries = [];
  let bytes = 0, s = 0;
  while (bytes < historyMb * 1024 * 1024) {
    const id = `session_seed_${s}`, at = new Date(Date.now() - (s + 1) * 86_400_000).toISOString();
    sessions.push({ id, source: s % 4 === 0 ? "omi" : "helix", title: `Seed meeting ${s}`, startedAt: at, updatedAt: at, summary: ["Seeded summary bullet one.", "Seeded summary bullet two."], people: [{ name: "Elaine" }] });
    for (let i = 0; i < perSession; i++) {
      const text = `${sentences[i % sentences.length]} ${sentences[(i * 7) % sentences.length]}`;
      entries.push({ id: `${id}:e${i}`, sessionId: id, kind: i % 5 === 4 ? "answer" : "transcript", text, occurredAt: at, speaker: i % 2 ? "You" : "Other speaker", metadata: { model: "gpt-6.1-terra", provider: "openai" } });
      bytes += text.length + 160;
    }
    s++;
  }
  storage.set("helix.g2.history.v1", JSON.stringify({ version: 1, sessions, entries }));
}

// --- fake G2 bridge ---
const listeners = new Set<(event: unknown) => void>();
let micTimer: ReturnType<typeof setInterval> | undefined;
export const speech = { speaking: false, role: AudioSpeakerRole.Other };
const bridge = {
  getLocalStorage: async (key: string) => storage.get(key) ?? "",
  setLocalStorage: async (key: string, value: string) => { perf.storageWrites++; perf.storageBytes += value.length; perf.storageMaxBytes = Math.max(perf.storageMaxBytes, value.length); { const k = key.replace(/session_[A-Za-z0-9_%-]+/u, "<id>"); const b = perf.byKey[k] ??= { writes: 0, bytes: 0, last: 0 }; b.writes++; b.bytes += value.length; b.last = value.length; } storage.set(key, value); return true; },
  createStartUpPageContainer: async (page: { textObject?: { content?: string }[] }) => { perf.glassesWrites++; perf.glassesBytes += JSON.stringify(page).length; return StartUpPageCreateResult.success; },
  rebuildPageContainer: async (page: unknown) => { perf.rebuilds++; perf.glassesBytes += JSON.stringify(page).length; return true; },
  textContainerUpgrade: async (update: { content?: string }) => { perf.glassesWrites++; perf.glassesBytes += (update.content ?? "").length; return true; },
  updateImageRawData: async (image: { imageData?: Uint8Array }) => { perf.images++; perf.imageBytes += image.imageData?.length ?? 0; return "success"; },
  shutDownPageContainer: async () => true,
  onEvenHubEvent: (callback: (event: unknown) => void) => { listeners.add(callback); return () => listeners.delete(callback); },
  audioControl: async (open: boolean) => {
    clearInterval(micTimer);
    if (open) {
      let t = 0;
      micTimer = setInterval(() => {
        // 4.2 s speech / 1.3 s pause cycles; speaker alternates per utterance.
        const phase = t % 5500; t += 20;
        const wasSpeaking = speech.speaking; speech.speaking = phase < 4200;
        if (speech.speaking && !wasSpeaking) speech.role = speech.role === AudioSpeakerRole.Other ? AudioSpeakerRole.Self : AudioSpeakerRole.Other;
        const pcm = new Int16Array(320);
        if (speech.speaking) for (let i = 0; i < 320; i++) pcm[i] = (Math.random() - 0.5) * 6000;
        perf.frames++;
        const event = { audioEvent: new AudioEvent({ audioPcm: new Uint8Array(pcm.buffer), source: AudioInputSource.Glasses, speakerRole: speech.role }) };
        for (const listener of listeners) listener(event);
      }, 20);
    }
    return true;
  },
};

// --- fake realtime socket: words ~250 ms behind speech, sentence punctuation, finals on commit ---
let item = 0, words: string[] = [], said = "", sentenceIndex = 0;
class PerfSocket {
  readyState = 0; onopen: (() => void) | null = null; onmessage: ((e: { data: string }) => void) | null = null; onerror: (() => void) | null = null; onclose: (() => void) | null = null;
  private timer = setInterval(() => this.tick(), 250);
  constructor() { setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 20); }
  private emit(event: object) { this.onmessage?.({ data: JSON.stringify(event) }); }
  private tick() {
    if (this.readyState !== 1) return;
    if (speech.speaking) {
      if (!words.length) { words = sentences[sentenceIndex++ % sentences.length]!.split(" "); said = ""; }
      const word = words.shift()!; said += ` ${word}`;
      this.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: `item_${item}`, delta: ` ${word}` });
    }
  }
  send(data: string) {
    perf.socketSends++;
    const message = JSON.parse(data);
    if (message.type === "input_audio_buffer.commit") {
      const id = `item_${item++}`, text = said.trim() || "Okay."; said = ""; words = [];
      this.emit({ type: "input_audio_buffer.committed", item_id: id });
      setTimeout(() => this.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: text }), 300);
    }
  }
  close() { this.readyState = 3; clearInterval(this.timer); }
}

const fake = createFakeOpenAI({ latency: { firstTokenMs: 400, interTokenMs: 40, jsonMs: 900, webSearchMs: 1200 } });
const app = await bootstrap(document.getElementById("app")!, bridge as never, {
  search: `?${params.toString()}`,
  transportFactory: options => new DirectConversationTransport({ ...options, fetch: fake.fetch, webSocketFactory: () => new PerfSocket() as never }),
});
app.presentation.subscribe(() => { perf.emits++; });
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
$<HTMLInputElement>("openai-api-key").value = "sk-perf-fake";
$<HTMLButtonElement>("connect-button").click();
for (let i = 0; i < 100 && $<HTMLButtonElement>("start-button").disabled; i++) await new Promise(r => setTimeout(r, 50));
$<HTMLButtonElement>("start-button").click();
const tab = params.get("tab"); if (tab) document.getElementById(`tab-${tab}`)?.click();
perf.started = performance.now();
console.log("PERF_READY");
