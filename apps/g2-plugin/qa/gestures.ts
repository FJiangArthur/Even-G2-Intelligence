// Dev-only hardware boundary: real simulator display/touch, generated PCM.
// Production controller, SDK client and local mock gateway remain unchanged.
import { AudioEvent, AudioInputSource, AudioSpeakerRole, waitForEvenAppBridge, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { G2ConversationController, type G2BridgePort } from "../src/controller";
import { GlassesRenderer } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";
import { CompanionUi } from "../src/ui";
import { DEFAULT_CONFIG } from "../src/config";
import { WebSocketConversationTransport } from "@helix/conversation-sdk";
import "../src/styles.css";

const bridge = await waitForEvenAppBridge();
let listener: ((event: EvenHubEvent) => void) | undefined;
let audioTimer: ReturnType<typeof setInterval> | undefined;
const config = { ...DEFAULT_CONFIG, gatewayUrl: "ws://127.0.0.1:8787/v2/conversations", transcriptionProvider: "mock" as const, answerProvider: "mock" as const };
const port: G2BridgePort = {
  createStartUpPageContainer: (page) => bridge.createStartUpPageContainer(page),
  textContainerUpgrade: (page) => bridge.textContainerUpgrade(page),
  updateImageRawData: (data) => bridge.updateImageRawData(data),
  shutDownPageContainer: (mode) => bridge.shutDownPageContainer(mode),
  getLocalStorage: async () => "",
  setLocalStorage: async () => true,
  onEvenHubEvent: (callback) => {
    listener = callback;
    const unsubscribe = bridge.onEvenHubEvent(callback);
    return () => { listener = undefined; unsubscribe(); };
  },
  audioControl: async (open) => {
    clearInterval(audioTimer);
    console.info(`QA_MIC ${open ? "ON" : "OFF"}`);
    if (open) audioTimer = setInterval(() => {
      const pcm = new Uint8Array(3200);
      const view = new DataView(pcm.buffer);
      for (let i = 0; i < 1600; i++) view.setInt16(i * 2, Math.round(Math.sin(i * .17) * 6000), true);
      listener?.({ audioEvent: new AudioEvent({ audioPcm: pcm, source: AudioInputSource.Glasses, speakerRole: AudioSpeakerRole.Self }) } as EvenHubEvent);
    }, 100);
    return true;
  },
};
const presentation = new ConversationPresentation();
const renderer = new GlassesRenderer(port);
// Explicit legacy mock adapter, never the production phone-only transport.
const controller = new G2ConversationController(port, renderer, presentation,
  () => new WebSocketConversationTransport({ url: config.gatewayUrl }));
const ui = new CompanionUi(document.querySelector<HTMLElement>("#app")!, config);
presentation.subscribe((snapshot) => {
  ui.render(snapshot);
  console.info(`QA_STATE ${snapshot.status} ${snapshot.glasses.interaction ?? ""} answers=${snapshot.feed.filter((item) => item.kind === "answer").length}`);
});
ui.bind({
  onConnect: (form) => controller.connect(form), onStart: () => controller.startListening(),
  onTogglePause: () => controller.togglePause(), onDisconnect: () => controller.disconnect(),
  onAsk: (text) => controller.ask(text), onClearProviderKeys: async () => ({ ok: true, message: "QA stores no keys" }),
  onAskLocal: () => controller.askContext("local"), onAskGlobal: () => controller.askContext("global"),
});
await controller.initialize();
await controller.connect({ ...config, accessToken: "", openaiApiKey: "", deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", saveApiKeysOnPhone: false });
window.addEventListener("beforeunload", () => { clearInterval(audioTimer); void controller.dispose(); });
