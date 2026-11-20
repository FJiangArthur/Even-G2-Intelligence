// Vite-only fixture, excluded from the production entry and EHPK. The only
// substituted application boundaries are provider fetch and microphone PCM.
import { AudioEvent, AudioInputSource, AudioSpeakerRole, waitForEvenAppBridge, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { DirectConversationTransport } from "@helix/conversation-sdk";
import { DEFAULT_CONFIG } from "../src/config";
import { G2ConversationController, type G2BridgePort } from "../src/controller";
import { GlassesRenderer } from "../src/glasses-renderer";
import { paginateAnswer } from "../src/answer-pager";
import { ConversationPresentation } from "../src/presentation";
import { CompanionUi } from "../src/ui";
import "../src/styles.css";

const log = (event: string, detail: object = {}) => console.info(`AF_QA ${JSON.stringify({ event, at: Date.now(), ...detail })}`);
const english = "The full width answer uses the native proportional font, with room to read each sentence comfortably. ";
const fixtures = {
  long: "LOCAL_START. " + english.repeat(9) + "LOCAL_TRAILING_TEXT. This final sentence must remain readable.",
  global: "GLOBAL_REPLACEMENT. Consider the whole conversation before choosing the next step.",
  short: "SHORT_ANSWER. Read this, then the glasses become blank.",
  cjk: "中文起点。" + "这是完整宽度的中文回答，每一页都应保留全部文字并在阅读后自动翻页。".repeat(14) + "中文结尾。最后这一句也必须完整显示。",
};
type Scene = keyof typeof fixtures;
let nextScene: Scene | undefined;
let localCount = 0;
let requestCount = 0;
let transcriptCount = 0;
let listener: ((event: EvenHubEvent) => void) | undefined;
let audioTimer: ReturnType<typeof setInterval> | undefined;
let lastDisplay = "";
const bridge = await waitForEvenAppBridge();
const port: G2BridgePort = {
  createStartUpPageContainer: async page => {
    log("startup", { containers: page.containerTotalNum, text: page.textObject?.[0]?.content });
    return bridge.createStartUpPageContainer(page);
  },
  textContainerUpgrade: async page => {
    const result = await bridge.textContainerUpgrade(page);
    lastDisplay = page.content ?? "";
    log("display", { text: lastDisplay, accepted: result });
    return result;
  },
  shutDownPageContainer: async mode => { log("shutdown", { mode }); return bridge.shutDownPageContainer(mode); },
  getLocalStorage: async () => "", setLocalStorage: async () => true,
  onEvenHubEvent: callback => {
    listener = callback;
    const off = bridge.onEvenHubEvent(callback);
    return () => { listener = undefined; off(); };
  },
  audioControl: async open => {
    clearInterval(audioTimer);
    log("microphone", { open });
    if (open) audioTimer = setInterval(sendPcm, 100);
    return true;
  },
};
function sendPcm(): void {
  const pcm = new Uint8Array(3200), view = new DataView(pcm.buffer);
  for (let index = 0; index < 1600; index += 1) view.setInt16(index * 2, Math.round(Math.sin(index * .17) * 6000), true);
  listener?.({ audioEvent: new AudioEvent({ audioPcm: pcm, source: AudioInputSource.Glasses, speakerRole: AudioSpeakerRole.Other }) } as EvenHubEvent);
}
const transport = new DirectConversationTransport({ fetch: async (url, init = {}) => {
  if (url.endsWith("/audio/transcriptions")) {
    transcriptCount += 1;
    log("transcription", { count: transcriptCount });
    return Response.json({ text: `Captured conversation ${transcriptCount}. The pilot starts on Friday and the team needs a clear rollout plan. What should we do next?` });
  }
  if (!url.endsWith("/responses")) throw new Error("Unexpected fixture provider URL");
  const request = JSON.parse(String(init.body));
  const context = String(request.input.at(-1).content);
  const global = context.includes("whole captured session");
  const scene = nextScene ?? (global ? "global" : ++localCount === 1 ? "long" : "cjk");
  nextScene = undefined;
  const text = fixtures[scene];
  const id = ++requestCount;
  log("request", { id, scope: global ? "global" : "local", scene, pages: paginateAnswer(text) });
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      let cursor = 0;
      const close = () => { if (!closed) { closed = true; clearTimeout(timer); stream.close(); } };
      init.signal?.addEventListener("abort", () => { log("aborted", { id }); close(); }, { once: true });
      const write = () => {
        if (closed) return;
        const delta = text.slice(cursor, cursor + 160);
        cursor += delta.length;
        stream.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`));
        if (cursor < text.length) timer = setTimeout(write, 100);
        else {
          stream.enqueue(encoder.encode('data: {"type":"response.completed"}\n\n'));
          log("provider-completed", { id }); close();
        }
      };
      // Gives replacement tests an observable pending request.
      timer = setTimeout(write, scene === "global" ? 100 : 400);
    },
    cancel() { closed = true; clearTimeout(timer); },
  });
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
} });
const presentation = new ConversationPresentation();
const renderer = new GlassesRenderer(port);
const controller = new G2ConversationController(port, renderer, presentation, () => transport);
const config = { ...DEFAULT_CONFIG, autoQuestion: true, autoAnswer: false, autoNotes: false, readOmiContext: false, syncOmiNotes: false };
const ui = new CompanionUi(document.querySelector<HTMLElement>("#app")!, config);
let signature = "";
presentation.subscribe(snapshot => {
  ui.render(snapshot);
  const state = { status: snapshot.status, interaction: snapshot.glasses.interaction, answerId: snapshot.glasses.answer?.id,
    streaming: snapshot.glasses.answer?.streaming, transcripts: snapshot.feed.filter(item => item.kind === "transcript").length,
    requests: snapshot.feed.filter(item => item.kind === "question").map(item => item.label) };
  if (JSON.stringify(state) !== signature) { signature = JSON.stringify(state); log("state", state); }
});
ui.bind({
  onConnect: form => controller.connect(form), onStart: () => controller.startListening(),
  onTogglePause: () => controller.togglePause(), onDisconnect: () => controller.disconnect(),
  onAsk: text => controller.ask(text), onAskLocal: () => controller.askContext("local"), onAskGlobal: () => controller.askContext("global"),
  onShortcut: id => controller.runShortcut(id), onAutoExplainTerms: enabled => controller.setAutoExplainTermsEnabled(enabled),
  onClearProviderKeys: async () => ({ ok: true, message: "QA saves no keys" }),
});
async function seedTranscript(): Promise<void> {
  await controller.beginHold(); sendPcm(); await controller.releaseHold();
}
const api = {
  controller, presentation,
  scene: async (scene: Scene) => { nextScene = scene; await controller.askContext(scene === "global" ? "global" : "local"); },
  seedTranscript,
  display: () => lastDisplay,
  exit: () => controller.requestExit(),
};
Object.assign(window, { answerFirstQa: api });
for (const scene of Object.keys(fixtures) as Scene[]) {
  const button = document.createElement("button"); button.textContent = `QA ${scene}`;
  button.onclick = () => { void api.scene(scene); }; document.querySelector("#qa-controls")!.append(button);
}
for (const [label, action] of [["QA transcript", seedTranscript], ["QA exit", api.exit]] as const) {
  const button = document.createElement("button"); button.textContent = label;
  button.onclick = () => { void action(); }; document.querySelector("#qa-controls")!.append(button);
}
await controller.initialize();
log("idle-blank");
await controller.connect({ ...config, accessToken: "", openaiApiKey: "qa-injected-fetch-only", deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", saveApiKeysOnPhone: false });
await seedTranscript();
log("ready");
window.addEventListener("beforeunload", () => { clearInterval(audioTimer); void controller.dispose(); });
