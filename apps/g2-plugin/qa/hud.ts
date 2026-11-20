// Vite-only fixture, excluded from the production entry and EHPK. Runs the real
// G2ConversationController + GlassesHud on the official simulator. Substituted
// boundaries: provider fetch (tests/fake-openai.ts), microphone (none: the
// hardware-planning rehearsal is injected as transcripts, with word-by-word
// transcript.partial events so the caption behaves like realtime STT).
// Query: ?speed=3 (rehearsal speed) &autoplay=0 (wait for hudQa.play()).
//        ?scenario=v08: v0.8 flow (continuous caption, THEY ASKED, claims + verify, menu, mirror,
//        lifecycle re-push) driven by scripts/qa_hud.mjs with HUD_QA_SCENARIO=v08.
//        ?display=ambient&scenario=ambient: ambient display flow, driven by scripts/qa_ambient.mjs.
import { waitForEvenAppBridge, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { DirectConversationTransport, type DirectConversationOptions, type GatewayEvent, type Speaker } from "@helix/conversation-sdk";
import { DEFAULT_CONFIG } from "../src/config";
import { G2ConversationController, type G2BridgePort } from "../src/controller";
import { GlassesHud, tabForHudView } from "../src/glasses-hud";
import { renderGlassesMirror } from "../src/glasses-mirror";
import { ConversationPresentation } from "../src/presentation";
import { createFakeOpenAI } from "../tests/fake-openai";

const params = new URLSearchParams(location.search);
const speed = Number(params.get("speed") ?? "3");
const log = (event: string, detail: object = {}) => console.info(`HUD_QA ${JSON.stringify({ event, at: Date.now(), ...detail })}`);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const RECAP = "Recap: you are choosing compute for the second robot prototype. Jetson Orin lead times are long, so the fallback is an x86 box with a discrete GPU, 16 GB RAM and a 1 TB NVMe SSD. "
  + "The budget was first $40,000, then corrected to $25,000 including sensors, so the spare unit is dropped and both lidars stay for CDTF calibration. "
  + "Decision: order one x86 unit now. You own the purchase request and send the quote by Thursday, and you test the ROS 2 Jazzy camera driver on the bench next week. "
  + "Open risk: confirm 16 GB is enough while recording rosbags, with bags on a separate NVMe partition.";

const fake = createFakeOpenAI({ latency: { firstTokenMs: 600, interTokenMs: 45, jsonMs: 500, webSearchMs: 1200 } });
let requests = 0;
/** QA-only verdict: the false lead-time claim is contradicted, with two web sources. */
const contradicted = (): Response => {
  const text = JSON.stringify({ status: "contradicted", summary: "Distributors list 12 to 16 weeks for Orin modules; only dev kits ship sooner." });
  const annotations = [
    { type: "url_citation", url: "https://developer.nvidia.com/embedded/jetson-modules", title: "Jetson Modules | NVIDIA Developer", start_index: 0, end_index: 20 },
    { type: "url_citation", url: "https://www.example-distributor.com/jetson-orin-lead-time", title: "Jetson Orin lead times", start_index: 0, end_index: 21 },
  ];
  return Response.json({ id: "resp_qa_verify", object: "response", status: "completed", model: "fake", usage: { input_tokens: 400, output_tokens: 60, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 460 },
    output: [{ type: "web_search_call", id: "ws_qa", status: "completed", action: { type: "search", query: "Jetson Orin lead time" } },
      { type: "message", id: "msg_qa", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations }] }] });
};
const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const body = typeof init?.body === "string" ? init.body : "";
  if (url.endsWith("/responses") && body.includes("about 8 weeks") && body.includes("web_search") && !body.includes("\"stream\":true")) {
    log("verify-request", { claim: "about 8 weeks" });
    await sleep(1800);
    return contradicted();
  }
  if (url.endsWith("/responses") && body.includes("whole captured session") && body.includes("\"stream\":true")) {
    const id = ++requests;
    log("request", { id, scope: "global" });
    const encoder = new TextEncoder();
    const words = RECAP.match(/\S+\s*/gu) ?? [RECAP];
    let index = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    return new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        const write = () => {
          if (init?.signal?.aborted) { stream.close(); return; }
          if (index < words.length) {
            stream.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: words.slice(index, index + 3).join("") })}\n\n`));
            index += 3; timer = setTimeout(write, 60);
          } else {
            stream.enqueue(encoder.encode('data: {"type":"response.completed"}\n\n'));
            stream.close();
          }
        };
        timer = setTimeout(write, 700);
        init?.signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
  }
  if (url.endsWith("/responses") && body.includes("\"stream\":true")) log("request", { id: ++requests, scope: "answer" });
  return fake.fetch(input, init);
};

const bridge = await waitForEvenAppBridge();
let hud: GlassesHud;
const mirror = document.querySelector<HTMLElement>("#mirror")!;
const phoneMirror = document.querySelector<HTMLElement>("#glasses-mirror")!;
const phoneTab = document.querySelector<HTMLElement>("#phone-tab")!;
const showMirror = () => { mirror.textContent = `[${hud.view}]\n${hud.frame.header}\n────────\n${hud.frame.body}\n────────\n${hud.frame.caption}`; };
const port: G2BridgePort = {
  createStartUpPageContainer: async page => {
    const result = await bridge.createStartUpPageContainer(page);
    log("startup", { result, containers: page.containerTotalNum, capture: page.textObject?.filter(item => item.isEventCapture === 1).map(item => item.containerName) });
    return result;
  },
  textContainerUpgrade: async update => {
    const accepted = await bridge.textContainerUpgrade(update);
    log("write", { container: update.containerName, content: update.content, accepted, view: hud.view, header: hud.frame.header });
    showMirror();
    return accepted;
  },
  rebuildPageContainer: async page => {
    const ok = await bridge.rebuildPageContainer(page);
    log("rebuild", { ok, list: page.listObject?.map(item => item.itemContainer?.itemName) ?? [], text: page.textObject?.map(item => item.containerName) ?? [],
      capture: [...(page.listObject ?? []), ...(page.textObject ?? [])].filter(item => item.isEventCapture === 1).map(item => item.containerName),
      menu: page.menuObject?.menuItems?.length ?? 0, view: hud.view,
      content: Object.fromEntries((page.textObject ?? []).map(item => [item.containerName, item.content])) });
    showMirror();
    return ok;
  },
  shutDownPageContainer: async mode => bridge.shutDownPageContainer(mode),
  getLocalStorage: async () => "",
  setLocalStorage: async () => true,
  onEvenHubEvent: callback => bridge.onEvenHubEvent((event: EvenHubEvent) => {
    log("input", { text: event.textEvent?.eventType ?? null, sys: event.sysEvent ? event.sysEvent.eventType ?? 0 : null,
      list: event.listEvent ? { type: event.listEvent.eventType ?? 0, index: event.listEvent.currentSelectItemIndex ?? 0 } : null, menu: event.menuItemClickEvent?.itemID ?? null, view: hud.view });
    callback(event);
  }),
  audioControl: async (open, source) => { log("microphone", { open, source: source ?? null }); return true; },
};

const presentation = new ConversationPresentation();
// ?display=ambient: the default product setting (blank until something pops up); the older scripts pin always-on.
hud = new GlassesHud(port, { display: params.get("display") === "ambient" ? "ambient" : "always-on", onError: error => { log("hud-error", { message: error.message }); presentation.setStatus("failed", error.message); },
  onRenderError: error => console.error("HUD render error", error) });
const partial = (text: string, speaker: Speaker): GatewayEvent => ({
  protocolVersion: "2.1", type: "transcript.partial", eventId: `qa-partial-${Date.now()}`, sessionId: "qa", occurredAt: new Date().toISOString(),
  transcriptId: "qa-partial", revision: 1, text,
  context: { speaker, prompt: { id: "p", version: "1" }, endpoint: { id: "openai-direct", url: "", provider: "openai", model: "fake" }, latencyMs: { totalMs: 0 } },
} as unknown as GatewayEvent);
let currentTransport: DirectConversationTransport | undefined;
const factory = (options?: DirectConversationOptions) => {
  const transport = currentTransport = new DirectConversationTransport({ ...options, fetch: fetcher } as DirectConversationOptions);
  const inject = transport.injectTranscript.bind(transport);
  // Realtime STT streams partial captions before each final transcript.
  transport.injectTranscript = async (text: string, speaker: Speaker) => {
    const words = text.split(/\s+/u);
    for (let count = 1; count <= words.length; count += 1) {
      presentation.apply(partial(words.slice(0, count).join(" "), speaker));
      await sleep(260 / speed);
    }
    return inject(text, speaker);
  };
  return transport;
};
const controller = new G2ConversationController(port, hud, presentation, factory);
const config = { ...DEFAULT_CONFIG, model: "gpt-4.1-mini", autoQuestion: true, autoAnswer: true, autoNotes: false, liveWebFactCheck: false, autoExplainTerms: true };
const play = async (playSpeed = speed) => {
  log("rehearsal-start", { speed: playSpeed });
  const result = await controller.rehearse("hardware-planning", playSpeed);
  log("rehearsal-done", { ...result });
  return result;
};
// Phone side: the glasses mirror (v0.8) as the phone header would mount it.
presentation.subscribe(snapshot => {
  renderGlassesMirror(phoneMirror, snapshot.hud);
  phoneTab.textContent = snapshot.hud ? `phone follows glasses → tab "${tabForHudView(snapshot.hud.view)}" · menu ${snapshot.hud.menuOpen ? "open" : "closed"} · last gesture ${snapshot.hud.lastGesture ?? "–"}` : "no mirror yet";
});
const them: Speaker = { label: "Other speaker", role: "other" };
const you: Speaker = { label: "You", role: "self" };
const at = () => new Date().toISOString();
async function until(predicate: () => boolean, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return true; await sleep(100); }
  return false;
}
/** v0.8 scenario: data the script then explores with official automation inputs only. */
async function runV08(): Promise<void> {
  const transport = currentTransport!;
  log("v08-caption-start");
  await transport.injectTranscript("We should order the x86 box this week, the Orin modules are back ordered.", them);
  log("v08-caption-1");
  await transport.injectTranscript("The quote from the reseller is due on Thursday.", them);
  log("v08-caption-2");
  await transport.injectTranscript("Okay, I will send the purchase request today.", you);
  log("v08-caption-done");
  await sleep(2500);
  log("v08-question-start");
  await transport.injectTranscript("How long is the Jetson Orin lead time right now?", them);
  const answered = await until(() => { const answer = presentation.snapshot().glasses.answer; return !!answer && !answer.streaming && !!answer.questionId; }, 20000);
  log("v08-they-asked-answered", { answered, header: hud.frame.header });
  // Claims + suggestions (the SDK copilot emits these too when its lane runs; seeded for determinism).
  presentation.applyClaim({ id: "qa-claim-1", text: "Finance approved $40,000 for compute hardware.", speaker: "Other speaker", scope: "conversation", createdAt: at() });
  presentation.applyClaim({ id: "qa-claim-2", text: "Jetson Orin lead times are about 8 weeks.", speaker: "Other speaker", scope: "public", createdAt: at() });
  presentation.setSuggestions([
    { id: "qa-s1", question: "Can the reseller hold the quote price until Friday?", why: "The quote is due Thursday.", createdAt: at() },
    { id: "qa-s2", question: "Is 16 GB enough while recording rosbags?", why: "Memory risk.", createdAt: at() },
    { id: "qa-s3", question: "Who signs off on the purchase request?", why: "Ownership.", createdAt: at() },
  ]);
  log("v08-seeded");
}
/** Ambient scenario: presentation events only (no provider, no transport), so every step is deterministic. */
async function runAmbient(): Promise<void> {
  const event = (value: object): GatewayEvent => ({ protocolVersion: "2.1", eventId: `qa-${Math.random()}`, sessionId: "qa", occurredAt: at(), ...value }) as unknown as GatewayEvent;
  const context = (speaker: Speaker, trigger?: string) => ({ speaker, prompt: { id: "p", version: "1" }, endpoint: { id: "openai-direct", url: "", provider: "openai", model: "fake" }, latencyMs: { totalMs: 0 }, ...(trigger ? { trigger } : {}) });
  await sleep(5000); // the "● listening" status cue is gone
  presentation.apply(partial("We should order the x86 box this week", them));
  presentation.apply(event({ type: "transcript.final", transcriptId: "qa-t1", text: "We should order the x86 box this week, the Orin modules are back ordered.", context: context(them) }));
  await sleep(1500);
  log("ambient-talked");
  await sleep(2500);
  presentation.apply(event({ type: "question.detected", questionId: "qa-q1", text: "How long is the Jetson Orin lead time right now?", confidence: 0.9, context: context(them, "question") }));
  presentation.apply(event({ type: "answer.completed", answerId: "qa-a1", questionId: "qa-q1", text: "Twelve to sixteen weeks at major distributors; developer kits ship sooner but are allocation limited.", context: context({ label: "Helix", role: "unknown" }, "question") }));
  await sleep(1200);
  log("ambient-answer-shown", { header: hud.frame.header });
  await sleep(9500); // the answer hides 8 s after it completed
  log("ambient-answer-expired", { header: hud.frame.header, body: hud.frame.body });
  await sleep(2500);
  presentation.applyVerification({ id: "qa-v1", target: "Jetson Orin lead times are about 8 weeks.", status: "contradicted", summary: "Distributors list 12 to 16 weeks for Orin modules.", sources: [], checkedAt: at(), requestedBy: "auto" });
  await sleep(1200);
  log("ambient-verdict-shown", { header: hud.frame.header });
  await sleep(6500);
  log("ambient-verdict-expired", { header: hud.frame.header, body: hud.frame.body });
}
Object.assign(window, { hudQa: { controller, presentation, hud, play, fake, runV08, runAmbient } });

await controller.initialize();
log("initialized");
await sleep(2500);
await controller.connect({ ...config, accessToken: "", openaiApiKey: "sk-qa-fake-key", deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", saveApiKeysOnPhone: false });
await controller.startListening();
log("connected");
await sleep(2500);
if (params.get("scenario") === "v08") await runV08();
else if (params.get("scenario") === "ambient") await runAmbient();
else if (params.get("autoplay") !== "0") await play();
window.addEventListener("beforeunload", () => { void controller.dispose(); });
