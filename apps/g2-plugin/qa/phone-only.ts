// Dev-only microphone fixture. Production main/UI/controller/provider calls are
// unchanged. Enter the key manually in the masked UI; do not save it in QA.
import { AudioEvent, AudioInputSource, AudioSpeakerRole, waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";
import { DirectConversationTransport } from "@helix/conversation-sdk";
const started = Date.now();
const log = (value: unknown) => console.info("PHONE_QA " + JSON.stringify({ elapsedMs: Date.now() - started, value }));
const actualFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (url, init) => {
  const target = String(url);
  if (target.startsWith("https://api.")) log({ request: target, model: init?.body instanceof FormData ? init.body.get("model") : undefined });
  const response = await actualFetch(url, init);
  if (target.startsWith("https://api.")) log({ response: target, status: response.status });
  return response;
};
const subscribe = DirectConversationTransport.prototype.subscribe;
DirectConversationTransport.prototype.subscribe = function(listener) {
  let firstDelta = false;
  return subscribe.call(this, event => {
    if (event.type !== "answer.delta") log(event);
    else if (!firstDelta) { firstDelta = true; log({ type: "first-answer-delta", latency: event.context.latencyMs }); }
    listener(event);
  });
};
const bridge = await waitForEvenAppBridge();
const callbacks = new Set<(event: any) => void>();
const subscribeHub = bridge.onEvenHubEvent.bind(bridge);
bridge.onEvenHubEvent = callback => {
  callbacks.add(callback); const off = subscribeHub(callback);
  return () => { callbacks.delete(callback); off(); };
};
const storage = new Map<string, string>();
bridge.getLocalStorage = async key => storage.get(key) ?? "";
bridge.setLocalStorage = async (key, value) => {
  // Never persist QA credentials, even if the save toggle is accidentally used.
  if (key.includes("provider-credentials") && value) return false;
  storage.set(key, value); return true;
};
const fixture = new URLSearchParams(location.search).get("audio");
if (!fixture) throw new Error("QA requires ?audio= pointing to a mono 16 kHz PCM16 fixture");
const audioResponse = await actualFetch(fixture);
if (!audioResponse.ok) throw new Error("QA audio fixture could not be loaded");
const pcm = new Uint8Array(await audioResponse.arrayBuffer());
if (!pcm.length || pcm.length % 2 !== 0) throw new Error("QA fixture must contain complete PCM16 samples");
let timer: ReturnType<typeof setInterval> | undefined;
bridge.audioControl = async open => {
  clearInterval(timer); log({ mic: open });
  if (open) {
    let offset = 0;
    timer = setInterval(() => {
      const audio = new Uint8Array(640); audio.set(pcm.subarray(offset, Math.min(offset + 640, pcm.length)));
      for (const callback of callbacks) callback({ audioEvent: new AudioEvent({ audioPcm: audio, source: AudioInputSource.Glasses, speakerRole: AudioSpeakerRole.Self }) });
      offset += 640;
      if (offset >= pcm.length + 32000) { clearInterval(timer); log("AUDIO_FINISHED_WITH_SILENCE"); }
    }, 20);
  }
  return true;
};
await import("../src/main");
log("PRODUCTION_MAIN_LOADED_NO_GATEWAY");
// Optional one-shot local test credential injector. Never a provider relay;
// never present in the production entrypoint or build. Used only when native
// simulator password input is unavailable to the automation harness.
const injection = new URLSearchParams(location.search).get("credentialSource");
if (injection) {
  const url = new URL(injection);
  if (url.origin !== "http://127.0.0.1:8799") throw new Error("QA credential source must be loopback-only");
  const response = await actualFetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("QA credential injection unavailable");
  let key = await response.text();
  const field = document.getElementById("openai-api-key") as HTMLInputElement;
  field.value = key; key = "";
  document.getElementById("connect-button")!.click();
}
window.addEventListener("beforeunload", () => clearInterval(timer));
