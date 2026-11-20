// Dev-only production UI/controller/transport fixture; never imported by main.ts.
import { AudioEvent, AudioInputSource, AudioSpeakerRole, StartUpPageCreateResult, waitForEvenAppBridge, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { DirectConversationTransport, LocalHistoryStore } from "@helix/conversation-sdk";
import { DEFAULT_CONFIG } from "../src/config";
import { G2ConversationController, type G2BridgePort } from "../src/controller";
import { GlassesRenderer } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";
import { CompanionUi } from "../src/ui";
import "../src/styles.css";

const browser = new URLSearchParams(location.search).get("browser") === "1";
const prefix = `helix.qa.memory-facts.${browser ? "browser" : "native"}.${crypto.randomUUID()}.`;
const log = (event: string, detail: object = {}) => console.info(`MF_QA ${JSON.stringify({ event, at: Date.now(), fixtureOnly: true, browser, ...detail })}`);
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
async function until(condition: () => unknown, message: string, ms = 12000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition() && Date.now() < end) await pause(40);
  check(condition(), message);
}
document.querySelector("#qa-mode")!.textContent = browser ? "BROWSER FAKE BRIDGE — NOT NATIVE ACCEPTANCE" : "ACTUAL EVEN BRIDGE";
let listener: ((event: EvenHubEvent) => void) | undefined;
let lastDisplay = "", transcript = "The current launch budget is seventy thousand. 预算是七万元。", omiCalls = 0, webCalls = 0;
let answerCount = 0, partialBeforeCompletion = false, ragIncluded = false;
let streamOpen = false, insightDelay = 200, webDelay = 200;
let latestInsightSignal: AbortSignal | undefined, latestWebSignal: AbortSignal | undefined;
const actual = browser ? undefined : await waitForEvenAppBridge();
const port: G2BridgePort = {
  getLocalStorage: key => actual ? actual.getLocalStorage(prefix + key) : Promise.resolve(localStorage.getItem(prefix + key) ?? ""),
  setLocalStorage: async (key, value) => {
    check(!/qa-injected-fetch-only/.test(value), "Fixture credential persisted");
    if (actual) return actual.setLocalStorage(prefix + key, value);
    localStorage.setItem(prefix + key, value); return true;
  },
  createStartUpPageContainer: async page => { log("startup", { containers: page.containerTotalNum }); return actual ? actual.createStartUpPageContainer(page) : StartUpPageCreateResult.success; },
  textContainerUpgrade: async page => {
    const accepted = actual ? await actual.textContainerUpgrade(page) : true;
    lastDisplay = page.content ?? "";
    document.querySelector("#qa-display")!.textContent = browser ? `Fixture glasses: ${lastDisplay || "(blank)"}` : "";
    if (streamOpen && lastDisplay.includes("ANSWER_PARTIAL")) partialBeforeCompletion = true;
    log("display", { text: lastDisplay, accepted }); return accepted;
  },
  shutDownPageContainer: async mode => actual ? actual.shutDownPageContainer(mode) : true,
  audioControl: async () => true,
  onEvenHubEvent: callback => {
    listener = callback;
    const off = actual?.onEvenHubEvent(event => { log("native-event", { nativeEvent: event }); callback(event); });
    return () => { listener = undefined; off?.(); };
  },
};
function sse(text: string, delay = 1200): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Response(new ReadableStream<Uint8Array>({ start(c) {
    c.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text.slice(0, 35) })}\n\n`));
    timer = setTimeout(() => { c.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text.slice(35) })}\n\ndata: {"type":"response.completed"}\n\n`)); c.close(); }, delay);
  }, cancel() { clearTimeout(timer); } }), { headers: { "Content-Type": "text/event-stream" } });
}
const fetcher = async (url: string, init: RequestInit = {}): Promise<Response> => {
  if (url.includes("api.omi.me")) {
    omiCalls++; await pause(120);
    const offset = Number(new URL(url).searchParams.get("offset"));
    return Response.json(offset ? [{ id: "fixture-final", created_at: "2026-09-01T00:00:00Z", structured: { title: "Fixture title-only meeting" } }] : Array.from({ length: 25 }, (_, index) => ({
      id: `fixture-${index}`, created_at: "2026-09-01T00:00:00Z", structured: { title: index === 0 ? "Fixture budget 预算" : `Fixture archive ${index}` },
      transcript_segments: [{ id: "one", text: index === 0 ? "I approved the previous launch budget of sixty thousand. 预算六万元。" : `Synthetic archive sentence number ${index}.`, speaker_name: "Fixture Alice" }],
    })));
  }
  if (url.endsWith("transcriptions")) return Response.json({ text: transcript });
  check(url === "https://api.openai.com/v1/responses", "Unexpected fixture provider");
  const request = JSON.parse(String(init.body));
  if (request.tools) {
    webCalls++; latestWebSignal = init.signal as AbortSignal; log("web-request", { count: webCalls }); await pause(webDelay);
    return Response.json({ status: "completed", output: [{ type: "web_search_call", status: "completed" }, { type: "message", content: [{ type: "output_text", text: JSON.stringify({ status: "contradicted", summary: "Water is a compound, not an element. (Fixture verdict)" }), annotations: [{ type: "url_citation", url: "https://pubchem.ncbi.nlm.nih.gov/compound/Water", title: "Water — fixture citation", start_index: 0, end_index: 20 }] }] }] });
  }
  if (String(request.instructions).includes("strict JSON")) {
    latestInsightSignal = init.signal as AbortSignal; log("insight-request"); await pause(insightDelay);
    const quoted = JSON.stringify(request.input);
    const term = quoted.includes("quorum") ? "quorum" : quoted.includes("CRDT") ? "CRDT" : "RAG";
    return sse(JSON.stringify({ term, explanation: `${term} is a specialized concept explained by this synthetic provider fixture.` }), 100);
  }
  const id = ++answerCount; streamOpen = true;
  ragIncluded ||= String(request.instructions).includes("Fixture Alice") && String(request.instructions).includes("omi");
  log("answer-request", { id, ragIncluded, explainTerm: JSON.stringify(request.input).includes("directly explain one recent technical term") });
  const response = sse("ANSWER_PARTIAL. The current budget is seventy thousand; Fixture Alice's older record says sixty thousand.");
  setTimeout(() => { streamOpen = false; log("provider-completed", { id }); }, 1200);
  return response;
};
// Only this QA page intercepts global fetch for the real History panel import button.
// Every destination must be a recognized fixture provider; no request leaves the page.
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => fetcher(String(input), init)) as typeof fetch;
const presentation = new ConversationPresentation();
const renderer = new GlassesRenderer(port);
const controller = new G2ConversationController(port, renderer, presentation, opts => new DirectConversationTransport({ ...opts, fetch: fetcher }));
const config = { ...DEFAULT_CONFIG, autoQuestion: false, autoAnswer: false, autoNotes: false, autoExplainTerms: false, liveWebFactCheck: false };
const ui = new CompanionUi(document.querySelector<HTMLElement>("#app")!, config);
ui.attachHistory(controller);
presentation.subscribe(snapshot => { ui.render(snapshot); log("phone", { cards: [...document.querySelectorAll(".message-insight")].map(e => e.textContent), streaming: snapshot.glasses.answer?.streaming, cue: snapshot.glasses.cue?.text }); });
ui.bind({ onConnect: form => controller.connect(form), onStart: () => controller.startListening(), onTogglePause: () => controller.togglePause(), onDisconnect: () => controller.disconnect(),
  onAsk: text => controller.ask(text), onAskLocal: () => controller.askContext("local"), onAskGlobal: () => controller.askContext("global"),
  onShortcut: id => { log("phone-shortcut", { id }); return controller.runShortcut(id); }, onAutoExplainTerms: enabled => controller.setAutoExplainTermsEnabled(enabled),
  onClearProviderKeys: async () => ({ ok: true, message: "Fixture uses runtime-only synthetic credentials" }),
});
async function speech(text: string): Promise<void> {
  const before = presentation.snapshot().feed.filter(e => e.kind === "transcript").length;
  transcript = text; await controller.beginHold();
  listener?.({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array(new Int16Array(3200).fill(4000).buffer), source: AudioInputSource.Glasses, speakerRole: AudioSpeakerRole.Other }) } as EvenHubEvent);
  await controller.releaseHold();
  await until(() => presentation.snapshot().feed.filter(e => e.kind === "transcript").length > before, "Missing fixture transcript");
}
const importFixture = () => controller.importOmi({ key: "qa-injected-fetch-only", fetch: fetcher });
async function stage(name: string): Promise<void> { log("stage", { name }); await pause(browser ? 200 : 1800); }
async function run(): Promise<void> {
  await importFixture(); await importFixture();
  check(controller.listHistorySessions().filter(s => s.source === "omi").length === 26, "Import dedupe failed");
  check(controller.searchHistory("预算").length > 0 && controller.searchHistory("budget").length > 0, "Bilingual search failed");
  const reconstructed = new LocalHistoryStore(port); await reconstructed.load();
  const historyAfterReload = reconstructed.listSessions().length;
  await speech("The current launch budget is seventy thousand. 预算是七万元。");
  const webCallsWhenDisabled = webCalls;
  const beforeOmi = omiCalls; await controller.ask("What is the launch budget?");
  await until(() => partialBeforeCompletion && Boolean(document.querySelector(".message-answer")), "No partial phone/glasses answer before completion");
  await stage("partial-answer");
  await until(() => presentation.snapshot().glasses.answer?.streaming === false, "Answer not complete");
  check(ragIncluded, "RAG speaker/source not included"); const omiCallsDuringAnswer = omiCalls - beforeOmi;
  await until(() => lastDisplay.trim() === "", "Answer did not auto-hide", 20000);
  await controller.setLiveWebFactCheckEnabled(true); await speech("水是元素。");
  await until(() => lastDisplay.includes("compound"), "No sourced idle correction"); await stage("sourced-correction");
  webDelay = 1000; await controller.setLiveWebFactCheckEnabled(false); await controller.setLiveWebFactCheckEnabled(true);
  await speech("Water is always an element."); await until(() => webCalls === 2, "No pending web request");
  const factsBefore = presentation.snapshot().feed.filter(e => e.kind === "fact-check").length;
  await controller.setLiveWebFactCheckEnabled(false); check(latestWebSignal?.aborted, "Web OFF did not abort"); await pause(1300);
  check(presentation.snapshot().feed.filter(e => e.kind === "fact-check").length === factsBefore, "Late web result surfaced");
  await until(() => lastDisplay.trim() === "", "Correction did not hide", 20000);
  await controller.setAutoExplainTermsEnabled(true); await speech("The new system uses RAG for retrieval.");
  await until(() => Boolean(document.querySelector(".message-insight")) && lastDisplay.includes("RAG"), "Missing idle insight DOM/pixels"); await stage("automatic-explanation");
  const card = document.querySelector<HTMLElement>(".message-insight")!;
  card.querySelector<HTMLElement>("summary")!.click();
  check(card.querySelector("details")?.open, "Explanation did not expand"); await stage("expanded-explanation");
  [...card.querySelectorAll("button")].find(b => b.textContent === "Original transcript")!.click();
  check(document.activeElement?.classList.contains("message-transcript"), "Original transcript not focused");
  await controller.setAutoExplainTermsEnabled(false); await controller.setAutoExplainTermsEnabled(true);
  // Reconnect resets per-session insight cooldown without faking timers.
  await controller.disconnect(); await connect(true);
  insightDelay = 900; await speech("A CRDT merges concurrent changes.");
  await until(() => latestInsightSignal && !latestInsightSignal.aborted, "Missing pending insight");
  await controller.setAutoExplainTermsEnabled(false); check(latestInsightSignal?.aborted, "Insight OFF did not abort");
  await pause(1200); check(!presentation.snapshot().feed.some(e => e.kind === "insight"), "Disabled insight surfaced");
  await controller.disconnect(); await connect(true); insightDelay = 600;
  await controller.ask("Keep this answer visible."); await until(() => lastDisplay.includes("ANSWER_PARTIAL"), "Missing busy answer");
  await until(() => presentation.snapshot().glasses.answer?.streaming === false, "Busy answer completion missing");
  await speech("A quorum decides consensus.");
  await until(() => Boolean(document.querySelector(".message-insight")), "Busy insight missing on phone");
  check(!lastDisplay.includes("quorum"), "Busy insight replaced answer"); await stage("busy-answer-priority");
  await until(() => !lastDisplay.trim(), "Busy answer did not hide", 20000);
  check(!lastDisplay.includes("quorum"), "Busy cue replayed");
  const shortcuts = document.querySelector<HTMLButtonElement>("#open-shortcuts-button")!; shortcuts.click();
  check(!document.querySelector<HTMLElement>("#shortcut-panel")!.hidden, "Shortcuts did not open"); await stage("phone-shortcuts");
  for (const id of [4, 5, 5, 1, 2, 3]) { document.querySelector<HTMLButtonElement>(`#shortcut-${id}`)!.click(); await pause(300); }
  const result = { fixtureOnly: true, partialBeforeCompletion, omiCallsDuringAnswer, webCallsWhenDisabled, historyAfterReload, ragIncluded, importedSessions: 26, storeReconstructionOnly: true, browser };
  if (!partialBeforeCompletion || omiCallsDuringAnswer !== 0 || webCallsWhenDisabled !== 0 || historyAfterReload < 1) throw new Error("Memory/facts QA failed");
  document.querySelector("#qa-result")!.textContent = JSON.stringify(result); log("result", result); log("ready");
}
async function connect(insights = false): Promise<void> { await controller.connect({ ...config, autoExplainTerms: insights, accessToken: "", openaiApiKey: "qa-injected-fetch-only", deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", saveApiKeysOnPhone: false }); }
const controls: [string, () => Promise<unknown>][] = [["QA import synthetic Omi", importFixture], ["QA seed budget speech", () => speech("The current launch budget is seventy thousand. 预算是七万元。")],
  ["QA automatic RAG explanation", async () => { await controller.disconnect(); await connect(true); insightDelay = 200; await speech("The system uses RAG for retrieval."); }],
  ["QA short Chinese fact", async () => { await controller.setLiveWebFactCheckEnabled(true); webDelay = 200; await speech("水是元素。"); }],
  ["QA delayed explanation", async () => { await controller.disconnect(); await connect(true); insightDelay = 4000; await speech("A CRDT merges changes."); }], ["QA reconnect", () => connect()], ["QA run acceptance", run]];
for (const [label, action] of controls) { const button = document.createElement("button"); button.textContent = label; button.onclick = () => { void action().catch(error => log("failure", { message: String(error) })); }; document.querySelector("#qa-controls")!.append(button); }
Object.assign(window, { memoryFactsQa: { controller, presentation, speech, run, importFixture, display: () => lastDisplay } });
await controller.initialize(); await connect();
log("preview-ready");
if (new URLSearchParams(location.search).get("autorun") === "1") void run().catch(error => log("failure", { message: String(error) }));
window.addEventListener("beforeunload", () => { ui.dispose(); void controller.dispose(); });
