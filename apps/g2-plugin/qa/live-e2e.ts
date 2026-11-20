// Dev-only live E2E fixture for the official simulator. Production main/UI/controller/SDK are
// unchanged. The key comes from a loopback-only server and is never persisted (storage refuses it).
// ?mode=live      : Test key -> Connect -> Listen; fixture audio streams into the G2 mic in real time.
// ?mode=rehearsal : Test key -> Play rehearsal while NOT connected (must auto-connect).
import { AudioEvent, AudioInputSource, AudioSpeakerRole, waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";
import { DirectConversationTransport } from "@helix/conversation-sdk";
const SOURCE = "http://127.0.0.1:8799";
const started = Date.now();
const log = (value: unknown) => console.info("E2E " + JSON.stringify({ t: Date.now() - started, value }));
const params = new URLSearchParams(location.search), mode = params.get("mode") ?? "live";
const role = params.get("role") === "self" ? AudioSpeakerRole.Self : AudioSpeakerRole.Other;
const subscribe = DirectConversationTransport.prototype.subscribe;
DirectConversationTransport.prototype.subscribe = function (listener) {
  let partials = 0;
  return subscribe.call(this, event => {
    if (event.type === "transcript.partial") { if (++partials % 4 === 1) log({ partial: event.text }); }
    else if (event.type === "transcript.final") log({ final: event.text });
    else if (event.type === "question.detected") log({ question: event.text });
    else if (event.type === "answer.completed") log({ answer: event.text, ms: event.context.latencyMs.totalMs });
    else if (event.type === "error") log({ error: event.code, message: event.message });
    listener(event);
  });
};
const bridge = await waitForEvenAppBridge();
const callbacks = new Set<(event: unknown) => void>();
const subscribeHub = bridge.onEvenHubEvent.bind(bridge);
bridge.onEvenHubEvent = callback => { callbacks.add(callback as never); const off = subscribeHub(callback); return () => { callbacks.delete(callback as never); off(); }; };
const storage = new Map<string, string>();
bridge.getLocalStorage = async key => storage.get(key) ?? "";
bridge.setLocalStorage = async (key, value) => { if (key.includes("provider-credentials") && value) return false; storage.set(key, value); return true; };
const pcm = new Uint8Array(await (await fetch(`${SOURCE}/audio.pcm`, { cache: "no-store" })).arrayBuffer());
let timer: ReturnType<typeof setInterval> | undefined;
bridge.audioControl = async open => {
  clearInterval(timer); log({ mic: open });
  if (open) {
    let offset = 0;
    timer = setInterval(() => {
      // 20 ms frames (640 bytes @16 kHz s16le), then continuous room silence like a real mic.
      const audio = new Uint8Array(640); if (offset < pcm.length) audio.set(pcm.subarray(offset, Math.min(offset + 640, pcm.length)));
      for (const callback of callbacks) callback({ audioEvent: new AudioEvent({ audioPcm: audio, source: AudioInputSource.Glasses, speakerRole: role }) });
      offset += 640; if (offset === pcm.length + 640 * 50) log("AUDIO_FIXTURE_DONE");
    }, 20);
  }
  return true;
};
await import("../src/main");
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const until = async (check: () => boolean, ms = 20000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) return false; await new Promise(r => setTimeout(r, 100)); } return true; };
await until(() => !!$("openai-api-key"));
let key = await (await fetch(`${SOURCE}/key`, { cache: "no-store" })).text();
const field = $<HTMLInputElement>("openai-api-key"); field.value = key; key = "";
$<HTMLButtonElement>("test-openai-key").click();
const status = $("key-test-status");
await until(() => ["ok", "error"].includes(status.dataset.state ?? ""), 30000);
log({ keyTest: status.dataset.state, message: status.textContent });
if (mode === "rehearsal") {
  $<HTMLSelectElement>("rehearsal-script").value = params.get("script") ?? "hardware-planning";
  $<HTMLSelectElement>("rehearsal-speed").value = params.get("speed") ?? "2";
  $<HTMLButtonElement>("rehearse-play").click();
  let last = "";
  const watch = setInterval(() => { const text = $("rehearsal-status").textContent ?? ""; if (text !== last) { last = text; log({ rehearsal: text }); } if (/^(Finished|Stopped)/.test(text) || text.includes("first")) clearInterval(watch); }, 200);
} else {
  $<HTMLButtonElement>("connect-button").click();
  await until(() => !$<HTMLButtonElement>("start-button").disabled, 30000);
  log({ connected: $("session-status").textContent });
  $<HTMLButtonElement>("start-button").click();
}
