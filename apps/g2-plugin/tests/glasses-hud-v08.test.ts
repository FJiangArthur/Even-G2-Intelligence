import {
  AudioInputSource,
  OsEventTypeList,
  StartUpPageCreateResult,
  type CreateStartUpPageContainer,
  type EvenHubEvent,
  type RebuildPageContainer,
  type TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import { DirectConversationTransport, type DirectConversationOptions, type GatewayEvent, type HudMirror } from "@helix/conversation-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config";
import { G2ConversationController, LIFECYCLE_STORAGE_KEY, CONNECT_PROMPT, RESUME_PROMPT, type G2BridgePort } from "../src/controller";
import {
  BODY_LINES,
  GESTURE_HELP,
  GESTURE_MAP,
  GlassesHud,
  HUD_LINE_WIDTH,
  HUD_MENU_ITEMS,
  HUD_VIEWS,
  hudTextWidth,
  hudViewForTab,
  rollingCaption,
  tabForHudView,
  verdictLabel,
  wrapText,
  type HudFrame,
} from "../src/glasses-hud";
import { glassesMirrorModel } from "../src/glasses-mirror";
import type { GlassesRenderBridge } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";
import { createFakeOpenAI } from "./fake-openai";

class PageBridge implements GlassesRenderBridge {
  public readonly creates: CreateStartUpPageContainer[] = [];
  public readonly rebuilds: RebuildPageContainer[] = [];
  public readonly updates: (TextContainerUpgrade & { at: number })[] = [];
  public createResult = StartUpPageCreateResult.success;
  public rebuildOk = true;
  public async createStartUpPageContainer(container: CreateStartUpPageContainer): Promise<StartUpPageCreateResult> {
    this.creates.push(container);
    return this.createResult;
  }
  public async rebuildPageContainer(container: RebuildPageContainer): Promise<boolean> {
    this.rebuilds.push(container);
    return this.rebuildOk;
  }
  public async textContainerUpgrade(container: TextContainerUpgrade): Promise<boolean> {
    this.updates.push(Object.assign(container, { at: Date.now() }));
    return true;
  }
  public writes(name: string) { return this.updates.filter(update => update.containerName === name); }
}

type Role = "self" | "other" | "unknown";
const ctx = (label: string, role: Role = "unknown", trigger?: string) => ({
  prompt: { id: "p", version: "1" }, endpoint: { id: "openai-direct", url: "", provider: "openai", model: "m" },
  speaker: { label, role }, latencyMs: { totalMs: 900 }, ...(trigger ? { trigger } : {}),
});
const base = { protocolVersion: "2.1" as const, sessionId: "s", occurredAt: "2026-11-08T18:00:00.000Z" };
let eventSeq = 0;
const ev = (event: object) => ({ ...base, eventId: `e${++eventSeq}`, ...event }) as unknown as GatewayEvent;
const partial = (text: string, label = "Other speaker", role: Role = "other") => ev({ type: "transcript.partial", transcriptId: "tp", revision: 1, text, context: ctx(label, role) });
const final = (id: string, text: string, label = "Other speaker", role: Role = "other") => ev({ type: "transcript.final", transcriptId: id, text, context: ctx(label, role) });
const autoQuestion = (id: string, text: string, label: string, role: Role) => ev({ type: "question.detected", questionId: id, text, confidence: 0.92, context: ctx(label, role, "question") });
const delta = (answerId: string, questionId: string, text: string, trigger = "question") => ev({ type: "answer.delta", answerId, questionId, delta: text, context: ctx("Helix", "unknown", trigger) });
const completed = (answerId: string, questionId: string, text: string, trigger = "question") => ev({ type: "answer.completed", answerId, questionId, text, context: ctx("Helix", "unknown", trigger) });
const at = "2026-11-08T18:00:00.000Z";
const BAD_GLYPHS = /[✓✗⚠►▸]/u;

function seed(presentation: ConversationPresentation): void {
  presentation.setStatus("listening");
  presentation.applyConcept({ id: "c1", term: "CDTF", explanation: "Camera data transfer framework used by the perception team.", createdAt: at, origin: "copilot" });
  presentation.applyConcept({ id: "c2", term: "NVMe", explanation: "PCIe storage protocol for SSDs.", createdAt: at, origin: "copilot" });
  presentation.applyClaim({ id: "cl1", text: "Finance approved $40,000 for compute.", speaker: "Other speaker", scope: "conversation", createdAt: at });
  presentation.applyClaim({ id: "cl2", text: "Jetson Orin lead times are about 12 weeks.", speaker: "Other speaker", scope: "public", createdAt: at });
  presentation.setSuggestions([
    { id: "s1", question: "Who owns the purchase request?", why: "", createdAt: at },
    { id: "s2", question: "Is 16 GB enough while recording rosbags?", why: "", createdAt: at },
  ]);
}

async function mount(options: ConstructorParameters<typeof GlassesHud>[1] = {}, bridge = new PageBridge()) {
  const hud = new GlassesHud(bridge, { display: "always-on", tickMs: 0, writeGapMs: 0, captionIntervalMs: 500, ...options });
  const presentation = new ConversationPresentation();
  presentation.subscribe(snapshot => hud.render(snapshot.glasses, snapshot));
  await hud.initialize();
  return { bridge, hud, presentation };
}

function expectFits(frame: HudFrame, context: string): void {
  const rows = frame.body.split("\n");
  expect(rows.length, `${context} body lines`).toBeLessThanOrEqual(BODY_LINES);
  for (const row of rows) expect(hudTextWidth(row), `${context} width: ${row}`).toBeLessThanOrEqual(HUD_LINE_WIDTH.body);
  expect(frame.caption.split("\n").length).toBeLessThanOrEqual(2);
  for (const text of [frame.header, frame.body, frame.caption]) expect(text, `${context} glyphs`).not.toMatch(BAD_GLYPHS);
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("v0.8 glasses MENU", () => {
  it("double press swaps BODY for a native list page (OS menu re-sent); a list click runs the item and restores the HUD", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await mount();
    seed(presentation);
    await hud.flush();
    expect(hud.handleGesture("double")).toEqual({ type: "handled" });
    expect(hud.menuOpen).toBe(true);
    await hud.flush();
    const page = bridge.rebuilds.at(-1)!;
    // v0.11: the list replaces only the view list inside the box; the BODY stays.
    expect(page.containerTotalNum).toBe(7);
    expect(page.textObject!.map(item => item.containerName)).toEqual(["hud-frame", "hud-body", "hud-header", "hud-status", "hud-caption", "hud-mode"]);
    expect(page.textObject!.every(item => item.isEventCapture === 0)).toBe(true);
    const list = page.listObject![0]!;
    expect(list.isEventCapture).toBe(1);
    expect(list.yPosition! + list.height!).toBeLessThanOrEqual(232);
    const names = list.itemContainer!.itemName!;
    expect(list.itemContainer!.itemCount).toBe(names.length);
    expect(names.length).toBeLessThanOrEqual(20);
    for (const name of names) expect([...name].length).toBeLessThanOrEqual(64);
    expect(names).toEqual(["Answer", "Answer all", "Verify", "Ask them",
      "Concepts · 2", "Claims · 2", "Summary", "Checks", "Live", "Mode ▶", "Pause", "Stop", "Close"]);
    expect(list.xPosition! + list.width!).toBeLessThanOrEqual(576);
    expect(page.menuObject?.menuItems?.map(item => item.itemID)).toEqual([1, 2, 3, 4, 5]);
    expect(hud.menuNative).toBe(true);
    expect(hud.frame.header).toMatch(/^MENU · tap: select · double: close$/u);
    // While the list is up: no view-list writes (that container is gone); BODY, header + caption keep updating.
    const viewWrites = bridge.writes("hud-views").length;
    presentation.applyConcept({ id: "c3", term: "ROS 2", explanation: "Robot middleware.", createdAt: at, origin: "copilot" });
    presentation.apply(partial("still captioning while the menu is open"));
    await vi.advanceTimersByTimeAsync(600);
    expect(bridge.writes("hud-views").length).toBe(viewWrites);
    expect(bridge.writes("hud-body").at(-1)!.content).toMatch(/^ROS 2: Robot middleware/u);
    expect(bridge.writes("hud-caption").at(-1)!.content).toContain("still captioning");
    // listEvent click on index 1 = "Answer whole conversation".
    expect(hud.selectListItem(1)).toEqual({ type: "askGlobal" });
    expect(hud.menuOpen).toBe(false);
    await hud.flush();
    const back = bridge.rebuilds.at(-1)!;
    expect(back.textObject!.map(item => item.containerName)).toEqual(["hud-frame", "hud-body", "hud-header", "hud-status", "hud-caption", "hud-mode", "hud-views"]);
    expect(back.listObject ?? []).toHaveLength(0);
    expect(back.menuObject?.menuItems).toHaveLength(5);
    expect(back.textObject![1]!.content).toMatch(/^ROS 2: Robot middleware/u);
    // Back on the HUD page: BODY writes resume.
    presentation.applyConcept({ id: "c4", term: "INT8", explanation: "8-bit quantization.", createdAt: at, origin: "copilot" });
    await vi.advanceTimersByTimeAsync(300);
    expect(bridge.writes("hud-body").at(-1)!.content).toMatch(/^INT8/u);
    hud.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs every menu action: verify latest claim, views, pause/resume, close; swipes track the highlight; double closes", async () => {
    const { hud, presentation } = await mount();
    seed(presentation);
    hud.handleGesture("double");
    hud.handleGesture("down"); hud.handleGesture("down");
    expect(hud.mirror.selection).toBe(2);
    // Firmware clamps at the ends (simulator-verified); tracking does too.
    for (let step = 0; step < 15; step += 1) hud.handleGesture("down");
    expect(hud.mirror.selection).toBe(HUD_MENU_ITEMS.length - 1);
    expect(hud.handleGesture("double")).toEqual({ type: "handled" });
    expect(hud.menuOpen).toBe(false);

    hud.handleGesture("double");
    expect(hud.selectListItem(2)).toEqual({ type: "verify", target: "Jetson Orin lead times are about 12 weeks.", id: "cl2", kind: "claim" });
    expect(hud.view).toBe("claims");
    expect(hud.frame.body).toContain("Verifying…");
    for (const [index, view] of [[3, "qa"], [4, "concepts"], [5, "claims"], [6, "summary"], [7, "checks"], [8, "live"]] as const) {
      hud.handleGesture("double");
      expect(hud.selectListItem(index)).toEqual({ type: "handled" });
      expect(hud.view).toBe(view);
    }
    hud.handleGesture("double");
    expect(hud.selectListItem(0)).toEqual({ type: "askLocal" });
    hud.handleGesture("double");
    // v0.10: "Mode ▶" sits before the pause item.
    expect(hud.menuItems[9]!.label).toBe("Mode ▶");
    expect(hud.menuItems[10]!.label).toBe("Pause");
    expect(hud.selectListItem(11)).toEqual({ type: "stop" }); // v0.11: Stop from the glasses
    hud.handleGesture("double");
    expect(hud.selectListItem(10)).toEqual({ type: "togglePause" });
    presentation.setStatus("paused");
    hud.handleGesture("double");
    expect(hud.menuItems[10]!.label).toBe("Resume");
    // Name wins over index when the host sends it; out-of-range indexes clamp.
    expect(hud.selectListItem(0, "Close")).toEqual({ type: "handled" });
    expect(hud.menuOpen).toBe(false);
    hud.handleGesture("double");
    expect(hud.selectListItem(99)).toEqual({ type: "handled" });
    expect(hud.menuOpen).toBe(false);
    expect(hud.selectListItem(0)).toBeUndefined(); // no menu open
    hud.dispose();
  });

  it("falls back to a text menu in BODY when the host rejects the list page", async () => {
    const { bridge, hud, presentation } = await mount();
    seed(presentation);
    bridge.rebuildOk = false;
    hud.handleGesture("double");
    await hud.flush();
    expect(hud.menuOpen).toBe(true);
    expect(hud.menuNative).toBe(false);
    expect(hud.frame.body.split("\n")[0]).toBe("▶ Answer");
    expectFits(hud.frame, "text menu");
    hud.handleGesture("down");
    expect(hud.frame.body.split("\n")[1]).toBe("▶ Answer all");
    await hud.flush();
    expect(bridge.writes("hud-body").at(-1)!.content).toContain("▶ Answer all");
    expect(hud.handleGesture("click")).toEqual({ type: "askGlobal" });
    expect(hud.menuOpen).toBe(false);
    hud.dispose();
  });

  it("exports the gesture help and menu for the phone", () => {
    expect(GESTURE_HELP).toMatch(/Double-tap: glasses menu/u);
    expect(GESTURE_MAP.map(item => item.gesture)).toEqual(["Tap", "Double-tap", "Hold", "Swipe ↑ / ↓"]);
    expect(HUD_MENU_ITEMS.map(item => item.action)).toContain("answer-global");
    expect(HUD_VIEWS).toEqual(["live", "answer", "qa", "concepts", "claims", "summary", "checks"]);
  });
});

describe("v0.8 verify on the glasses", () => {
  it("CLAIMS: tap verifies the highlighted claim; Verifying… then the verdict in place and in CHECKS", async () => {
    const { hud, presentation } = await mount();
    seed(presentation);
    hud.setView("claims");
    expect(hud.frame.header).toMatch(/^CLAIMS 1\/2 · ● 0m · click: verify$/u);
    expect(hud.frame.body.replace(/\n/gu, " ")).toMatch(/^Them: “Jetson Orin lead times are about 12 weeks\.”/u);
    expect(hud.frame.body).toContain("▶ click: verify on the web");
    hud.handleGesture("down");
    expect(hud.frame.body).toContain("▶ click: verify against the talk");
    hud.handleGesture("up");
    expect(hud.handleGesture("click")).toEqual({ type: "verify", target: "Jetson Orin lead times are about 12 weeks.", id: "cl2", kind: "claim" });
    expect(hud.frame.header).toMatch(/verifying…$/u);
    expect(hud.frame.body).toContain("Verifying…");
    expect(hud.handleGesture("click")).toEqual({ type: "handled" }); // no duplicate request
    presentation.applyVerification({ id: "cl2", target: "Jetson Orin lead times are about 12 weeks.", status: "contradicted",
      summary: "Distributors list 12 to 16 weeks for modules; dev kits ship sooner.", sources: [{ url: "https://example.com/a", title: "A" }],
      checkedAt: at, requestedBy: "user" });
    expect(hud.frame.header).toMatch(/verified$/u);
    expect(hud.frame.body).toContain("▲ FALSE · contradicted · 1 source");
    expect(hud.frame.body).toContain("Distributors list 12 to 16 weeks");
    expect(hud.handleGesture("click")).toEqual({ type: "handled" }); // settled: no re-run
    expectFits(hud.frame, "claims verdict");
    hud.setView("checks");
    expect(hud.frame.body.split("\n")[0]).toBe("▲ FALSE · contradicted · verify");
    for (const view of HUD_VIEWS) { hud.setView(view); expectFits(hud.frame, view); }
    hud.dispose();
  });

  it("CONCEPTS: shows phone-requested pending state, OK verdicts, and retries an unavailable result", async () => {
    const { hud, presentation } = await mount();
    seed(presentation);
    hud.setView("concepts");
    expect(hud.frame.header).toMatch(/^CONCEPTS 1\/2 · .* · click: verify$/u);
    presentation.beginVerification("c2"); // e.g. the phone's Verify button
    expect(hud.frame.body).toContain("Verifying…");
    expect(presentation.snapshot().verifying).toEqual(["c2"]);
    presentation.applyVerification({ id: "c2", target: "NVMe", status: "unavailable", summary: "Verification unavailable.", sources: [], checkedAt: at, requestedBy: "user" });
    expect(presentation.snapshot().verifying).toEqual([]);
    expect(hud.frame.body).toContain("· N/A · unavailable");
    expect(hud.frame.header).toMatch(/click: retry$/u);
    expect(hud.handleGesture("click")).toEqual({ type: "verify", id: "c2", target: "NVMe: PCIe storage protocol for SSDs.", kind: "concept" });
    expect(hud.frame.body).toContain("Verifying…");
    presentation.applyVerification({ id: "c2", target: "NVMe", status: "supported", summary: "Correct.", sources: [], checkedAt: "2026-11-08T18:01:00.000Z", requestedBy: "user" });
    expect(hud.frame.body).toMatch(/NVMe\nPCIe storage protocol for SSDs\.\n● OK · supported\nCorrect\./u);
    expect([verdictLabel("supported"), verdictLabel("contradicted"), verdictLabel("uncertain")]).toEqual(["● OK", "▲ FALSE", "◆ UNSURE"]);
    hud.dispose();
  });
});

describe("v0.8 verify through the real controller", () => {
  it("a glasses tap on a claim verifies it (SDK verifyClaim, else verify(text, id)) and shows the sourced verdict in place", async () => {
    const fake = createFakeOpenAI();
    let listener: ((event: EvenHubEvent) => void) | undefined;
    const bridge: G2BridgePort & PageBridge = Object.assign(new PageBridge(), {
      getLocalStorage: async () => "", setLocalStorage: async () => true, audioControl: async () => true, shutDownPageContainer: async () => true,
      onEvenHubEvent: (callback: (event: EvenHubEvent) => void) => { listener = callback; return () => { listener = undefined; }; },
    });
    const presentation = new ConversationPresentation();
    const hud = new GlassesHud(bridge, { display: "always-on", tickMs: 0 });
    let transport: DirectConversationTransport | undefined;
    const controller = new G2ConversationController(bridge, hud, presentation,
      (options?: DirectConversationOptions) => (transport = new DirectConversationTransport({ ...options, fetch: fake.fetch } as DirectConversationOptions)));
    await controller.initialize();
    await controller.connect({ ...DEFAULT_CONFIG, model: "gpt-4.1-mini", accessToken: "", openaiApiKey: "sk-fake", deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", saveApiKeysOnPhone: false, autoExplainTerms: false, copilotSuggestions: false });
    await transport!.injectTranscript("Jetson Orin lead times are about twelve weeks at distributors.", { label: "Other speaker", role: "other" });
    fake.setLatency({ jsonMs: 400 });
    // A host-added claim (unknown to the copilot): verifyClaim falls back to verify(text, id).
    presentation.applyClaim({ id: "host-claim", text: "Jetson Orin lead times are about twelve weeks.", speaker: "Other speaker", scope: "public", createdAt: at });
    controller.setHudView("claims");
    expect(hud.frame.body).toContain("click: verify");
    listener!({ sysEvent: { eventSource: 1 } } as EvenHubEvent); // tap (after the 250 ms double-tap window)
    await vi.waitFor(() => expect(presentation.snapshot().verifying).toEqual(["host-claim"]));
    expect(hud.frame.body).toContain("Verifying…");
    await vi.waitFor(() => expect(presentation.snapshot().verifications.find(item => item.id === "host-claim")?.status).toBe("supported"), { timeout: 3000 });
    expect(presentation.snapshot().verifying).toEqual([]);
    expect(hud.frame.body).toMatch(/● OK · supported · 1 source/u);
    expect(fake.byIntent("verify").length + fake.byIntent("fact-check").length).toBeGreaterThan(0);
    await controller.dispose();
  });
});

describe("v0.8 three question kinds", () => {
  it("auto-answers a question someone else asked under ◆ THEY ASKED with the question on top", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await mount();
    presentation.setStatus("listening");
    presentation.apply(autoQuestion("q1", "How long is the Orin lead time right now?", "Other speaker", "other"));
    expect(hud.view).toBe("live"); // detection alone is phone-only
    presentation.apply(delta("a1", "q1", "Twelve to sixteen weeks"));
    expect(hud.view).toBe("answer");
    presentation.apply(completed("a1", "q1", "Twelve to sixteen weeks at major distributors."));
    expect(hud.frame.header).toMatch(/^◆ THEY ASKED 1\/1 · ● 0m · answer · tap to close$/u);
    expect(hud.frame.body).toBe("Q: How long is the Orin lead time right now?\nTwelve to sixteen weeks at major distributors.");
    expectFits(hud.frame, "they asked");
    hud.handleGesture("click");
    expect(hud.view).toBe("live");
    hud.dispose();
  });

  it("never auto-shows an answer to a question the wearer asked themself", async () => {
    const { hud, presentation } = await mount();
    presentation.setStatus("listening");
    presentation.apply(autoQuestion("q2", "What did we decide on the budget?", "You", "self"));
    presentation.apply(completed("a2", "q2", "The cap is $25,000."));
    expect(hud.view).toBe("live");
    expect(hud.frame.header).not.toMatch(/ANSWER|THEY ASKED/u);
    hud.dispose();
  });

  it("explicit requests read ◆ ANSWER; implicit asks show LOOKUP / PROPOSAL on LIVE; suggestions are ASK THEM prompts", async () => {
    const { hud, presentation } = await mount();
    seed(presentation);
    presentation.applyAsk({ id: "k1", kind: "lookup", topic: "Orin lead time", trigger: "lead time", status: "pending", createdAt: at });
    expect(hud.frame.body.split("\n")[0]).toBe("→ LOOKUP · Orin lead time…");
    presentation.applyAsk({ id: "k1", kind: "lookup", topic: "Orin lead time", trigger: "lead time", status: "done", answer: "12–16 weeks.", createdAt: at });
    presentation.applyAsk({ id: "k2", kind: "propose", topic: "16 GB RAM with 1 TB SSD", trigger: "architecture", status: "done", answer: "Fits one detector.", createdAt: at });
    expect(hud.frame.body.replace(/\n/gu, " ")).toMatch(/^→ PROPOSAL · 16 GB RAM with 1 TB SSD: Fits one detector\./u);
    expect(hud.frame.body).toContain("· → LOOKUP · Orin lead time");
    hud.setView("qa");
    expect(hud.frame.header).toMatch(/^ASK THEM 1\/2 · .* · say it · tap: answer$/u);
    expect(hud.frame.body.split("\n")[0]).toBe("▶ ① Who owns the purchase request?");
    presentation.beginRequest();
    presentation.apply(ev({ type: "question.detected", questionId: "m1", text: "help", confidence: 1, context: ctx("Local context", "self", "manual") }));
    presentation.apply(completed("am1", "m1", "Order the x86 unit now.", "manual"));
    expect(hud.frame.header).toMatch(/^◆ ANSWER 1\/1/u);
    expect(hud.frame.body).toBe("Order the x86 unit now.");
    hud.dispose();
  });
});

describe("v0.8 continuous caption", () => {
  it("flows across sentence boundaries and speaker changes instead of resetting at each final", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await mount({ captionHoldMs: 30000, tickMs: 1000 });
    presentation.setStatus("listening");
    presentation.apply(partial("We should order"));
    expect(hud.frame.caption).toBe("Them: We should order");
    presentation.apply(final("t1", "We should order the x86 box now."));
    expect(hud.frame.caption).toBe("Them: We should order the x86 box now.");
    presentation.apply(partial("The quote"));
    expect(hud.frame.caption.replace("\n", " ")).toBe("Them: We should order the x86 box now. The quote");
    presentation.apply(final("t2", "The quote is due Thursday."));
    expect(hud.frame.caption.replace("\n", " ")).toBe("Them: We should order the x86 box now. The quote is due Thursday.");
    presentation.apply(partial("Okay I will send it", "You", "self"));
    const joined = hud.frame.caption.replace("\n", " ");
    expect(joined).toMatch(/Thursday\. You: Okay I will send it$/u);
    expect(hud.frame.caption.split("\n")).toHaveLength(2);
    // Long speech: two lines, the head is cut with the speaker it belongs to.
    for (let index = 0; index < 6; index += 1) presentation.apply(final(`u${index}`, `Sentence number ${index} keeps the caption rolling forward.`, "You", "self"));
    const lines = hud.frame.caption.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^You: …/u);
    expect(lines[1]).toMatch(/rolling forward\.$/u);
    for (const line of lines) expect(hudTextWidth(line)).toBeLessThanOrEqual(HUD_LINE_WIDTH.caption);
    await vi.advanceTimersByTimeAsync(31000);
    expect(hud.frame.caption).toContain("double-tap: menu");
    hud.dispose();
  });

  it("rollingCaption keeps short text whole and dedupes a partial that repeats the last final", () => {
    expect(rollingCaption([{ tag: "Them: ", text: "Hi." }], 2, 552)).toEqual(["Them: Hi."]);
    expect(rollingCaption([{ tag: "Them: ", text: "We agreed." }, { tag: "Them: ", text: "We agreed.", partial: true }], 2, 552).join(" "))
      .toBe("Them: We agreed.");
    expect(rollingCaption([], 2, 552)).toEqual([]);
    // A cut head is attributed to the speaker whose words start the first visible line (never "Them: …You:").
    const turn = rollingCaption([{ tag: "Them: ", text: "word ".repeat(60) }, { tag: "You: ", text: "Okay, I will send the purchase request today." },
      { tag: "Them: ", text: "How long is the Jetson Orin lead time right now?" }], 2, 552);
    expect(turn).toEqual(["You: …request today. Them: How long is the Jetson Orin lead", "time right now?"]);
    // Simulator-observed case: the prefix would push the owner's only word off the line.
    expect(rollingCaption([
      { tag: "Them: ", text: "We should order the x86 box this week, the Orin modules are back ordered." },
      { tag: "Them: ", text: "The quote from the reseller is due on Thursday." },
      { tag: "You: ", text: "Okay, I will send the purchase request today." },
      { tag: "Them: ", text: "How long is the Jetson Orin lead time right now?" },
    ], 2, HUD_LINE_WIDTH.caption)).toEqual(["You: Okay, I will send the purchase request today.", "Them: How long is the Jetson Orin lead time right now?"]);
    // Everything fits: no prefix games.
    expect(rollingCaption([{ tag: "Them: ", text: "A." }, { tag: "You: ", text: "B." }], 2, 552)).toEqual(["Them: A. You: B."]);
    const long = rollingCaption([{ tag: "", text: "word ".repeat(80) }], 2, 300);
    expect(long).toHaveLength(2);
    expect(long[0]).toMatch(/^…/u);
    expect(wrapText(long.join("\n"), 300)).toHaveLength(2);
  });
});

describe("v0.8 glasses -> phone mirror", () => {
  it("publishes a HudMirror for every visible change (async, deduped), including menu and selection", async () => {
    const mirrors: HudMirror[] = [];
    const { hud, presentation } = await mount({ onMirror: mirror => mirrors.push(mirror) });
    seed(presentation);
    await Promise.resolve();
    const first = mirrors.at(-1)!;
    expect(first).toMatchObject({ view: "live", menuOpen: false });
    expect(first.header).toBe(hud.frame.header);
    const count = mirrors.length;
    hud.render(presentation.snapshot().glasses, presentation.snapshot());
    await Promise.resolve();
    expect(mirrors.length).toBe(count); // unchanged frame: no publish
    hud.handleGesture("down");
    await Promise.resolve();
    expect(mirrors.at(-1)).toMatchObject({ view: "answer", lastGesture: "down" });
    hud.handleGesture("double");
    hud.handleGesture("down");
    await Promise.resolve();
    const menu = mirrors.at(-1)!;
    expect(menu).toMatchObject({ menuOpen: true, selection: 1, lastGesture: "menu:down" });
    expect(menu.body.split("\n")).toHaveLength(HUD_MENU_ITEMS.length);
    const model = glassesMirrorModel(menu);
    expect(model.menuOpen).toBe(true);
    expect(model.highlight).toBeDefined();
    expect(model.lines.find(line => line.highlight)?.text).toBe("Answer all");
    hud.dispose();
  });

  it("maps HUD views to phone tabs and back; the controller stores the mirror and moves the HUD from the phone", async () => {
    expect(HUD_VIEWS.map(tabForHudView)).toEqual(["answers", "answers", "qa", "concepts", "checks", "summary", "checks"]);
    expect(["answers", "qa", "concepts", "summary", "checks", "setup"].map(hudViewForTab)).toEqual(["live", "qa", "concepts", "summary", "checks", undefined]);
    const bridge = Object.assign(new PageBridge(), {
      getLocalStorage: async () => "", setLocalStorage: async () => true, audioControl: async () => true,
      shutDownPageContainer: async () => true, onEvenHubEvent: () => () => undefined,
    });
    const presentation = new ConversationPresentation();
    const hud = new GlassesHud(bridge, { display: "always-on", tickMs: 0 });
    const controller = new G2ConversationController(bridge, hud, presentation);
    await controller.initialize();
    await vi.waitFor(() => expect(presentation.snapshot().hud?.view).toBe("live"));
    presentation.setStatus("connected");
    controller.setHudView("concepts");
    expect(hud.view).toBe("concepts");
    await vi.waitFor(() => expect(presentation.snapshot().hud).toMatchObject({ view: "concepts", lastGesture: "phone:concepts" }));
    const model = glassesMirrorModel(presentation.snapshot().hud!);
    expect(model.tab).toBe("concepts");
    expect(model.lines[0]!.text).toMatch(/^CONCEPTS/u);
    await controller.dispose();
  });
});

describe("v0.8 glasses lifecycle", () => {
  it("takes over the existing page when createStartUpPageContainer reports invalid after a WebView restart", async () => {
    const bridge = new PageBridge();
    bridge.createResult = StartUpPageCreateResult.invalid;
    const { hud, presentation } = await mount({}, bridge);
    expect(bridge.creates).toHaveLength(1);
    expect(bridge.rebuilds).toHaveLength(1);
    expect(bridge.rebuilds[0]!.textObject!.map(item => item.containerName)).toEqual(["hud-frame", "hud-body", "hud-header", "hud-status", "hud-caption", "hud-mode", "hud-views"]);
    expect(bridge.rebuilds[0]!.menuObject?.menuItems).toHaveLength(5);
    presentation.setStatus("listening");
    await hud.flush();
    expect(bridge.writes("hud-body").at(-1)!.content).toMatch(/^Listening/u);
    hud.dispose();
    const failing = new PageBridge();
    failing.createResult = StartUpPageCreateResult.invalid;
    failing.rebuildOk = false;
    await expect(new GlassesHud(failing, { display: "always-on", tickMs: 0 }).initialize()).rejects.toThrow(/startup page creation failed with result 1/u);
  });

  it("re-push redraws the current page (HUD or MENU) with the OS menu", async () => {
    const { bridge, hud, presentation } = await mount();
    seed(presentation);
    await hud.flush();
    expect(await hud.repush()).toBe(true);
    expect(bridge.rebuilds.at(-1)!.textObject!.map(item => item.content)).toEqual([" ", hud.frame.body, hud.frame.title, hud.frame.status, hud.frame.caption, hud.frame.mode, hud.frame.views]);
    expect(bridge.rebuilds.at(-1)!.menuObject?.menuItems).toHaveLength(5);
    hud.handleGesture("double");
    await hud.flush();
    const rebuilds = bridge.rebuilds.length;
    expect(await hud.repush()).toBe(true);
    expect(bridge.rebuilds.length).toBe(rebuilds + 1);
    expect(bridge.rebuilds.at(-1)!.listObject).toHaveLength(1);
    expect(hud.lastRebuildAt).toBeGreaterThan(0);
    hud.dispose();
  });

  it("controller: foreground return re-pushes and re-opens the mic with the same source; echoes and bursts are ignored", async () => {
    const fake = createFakeOpenAI();
    let listener: ((event: EvenHubEvent) => void) | undefined;
    const audio: [boolean, AudioInputSource | undefined][] = [];
    const storage = new Map<string, string>();
    const bridge: G2BridgePort & PageBridge = Object.assign(new PageBridge(), {
      getLocalStorage: async (key: string) => storage.get(key) ?? "",
      setLocalStorage: async (key: string, value: string) => { storage.set(key, value); return true; },
      audioControl: async (open: boolean, source?: AudioInputSource) => { audio.push([open, source]); return true; },
      shutDownPageContainer: async () => true,
      onEvenHubEvent: (callback: (event: EvenHubEvent) => void) => { listener = callback; return () => { listener = undefined; }; },
    });
    const presentation = new ConversationPresentation();
    const hud = new GlassesHud(bridge, { display: "always-on", tickMs: 0 });
    let transport: DirectConversationTransport | undefined;
    const controller = new G2ConversationController(bridge, hud, presentation,
      (options?: DirectConversationOptions) => (transport = new DirectConversationTransport({ ...options, fetch: fake.fetch } as DirectConversationOptions)));
    await controller.initialize();
    await controller.connect({ ...DEFAULT_CONFIG, model: "gpt-4.1-mini", accessToken: "", openaiApiKey: "sk-fake-secret", deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", saveApiKeysOnPhone: false, autoExplainTerms: false, copilotSuggestions: false });
    await controller.startListening();
    await vi.waitFor(() => expect(JSON.parse(storage.get(LIFECYCLE_STORAGE_KEY) ?? "{}")).toMatchObject({ connected: true, listening: true }));
    expect(storage.get(LIFECYCLE_STORAGE_KEY)).not.toContain("sk-");
    const opens = () => audio.filter(([open]) => open);
    expect(opens()).toEqual([[true, AudioInputSource.Glasses]]);
    const rebuilds = bridge.rebuilds.length;
    listener!({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT } } as EvenHubEvent);
    await vi.waitFor(() => expect(opens()).toHaveLength(2));
    expect(opens()[1]).toEqual([true, AudioInputSource.Glasses]);
    expect(bridge.rebuilds.length).toBe(rebuilds + 1);
    expect(bridge.rebuilds.at(-1)!.textObject).toHaveLength(7);
    // An immediate second signal (our own rebuild echo / visibility + foreground burst) is ignored.
    listener!({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT } } as EvenHubEvent);
    await controller.resumeFromBackground("visible");
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(bridge.rebuilds.length).toBe(rebuilds + 1);
    expect(opens()).toHaveLength(2);
    // A short OS overlay (context menu) closing does not re-push.
    listener!({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT } } as EvenHubEvent);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(bridge.rebuilds.length).toBe(rebuilds + 1);
    // Double press -> native menu page; list click on "Answer whole conversation" asks globally.
    await transport!.injectTranscript("Finance approved forty thousand dollars for compute hardware.", { label: "Other speaker", role: "other" });
    listener!({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } } as EvenHubEvent);
    await vi.waitFor(() => expect(bridge.rebuilds.at(-1)!.listObject).toHaveLength(1));
    listener!({ listEvent: { containerID: 4, containerName: "hud-menu", currentSelectItemIndex: 1 } } as EvenHubEvent);
    await vi.waitFor(() => expect(fake.requests.filter(request => request.intent === "answer" && request.stream)).toHaveLength(1), { timeout: 2000 });
    expect(JSON.stringify(fake.requests.filter(request => request.intent === "answer" && request.stream)[0]!.body)).toContain("whole captured session");
    await vi.waitFor(() => expect(bridge.rebuilds.at(-1)!.textObject).toHaveLength(7));
    await controller.disconnect();
    await vi.waitFor(() => expect(storage.get(LIFECYCLE_STORAGE_KEY)).toBe(""));
    await controller.dispose();
  });

  it("cold start after a reclaimed WebView offers tap-to-resume on phone and glasses; a glasses tap resumes", async () => {
    const storage = new Map<string, string>([[LIFECYCLE_STORAGE_KEY, JSON.stringify({ connected: true, listening: true, at: Date.now() - 60_000 })]]);
    let listener: ((event: EvenHubEvent) => void) | undefined;
    const bridge: G2BridgePort & PageBridge = Object.assign(new PageBridge(), {
      getLocalStorage: async (key: string) => storage.get(key) ?? "",
      setLocalStorage: async (key: string, value: string) => { storage.set(key, value); return true; },
      audioControl: async () => true, shutDownPageContainer: async () => true,
      onEvenHubEvent: (callback: (event: EvenHubEvent) => void) => { listener = callback; return () => { listener = undefined; }; },
    });
    bridge.createResult = StartUpPageCreateResult.invalid; // the page survived the reclaim
    const presentation = new ConversationPresentation();
    const hud = new GlassesHud(bridge, { display: "always-on", tickMs: 0 });
    const controller = new G2ConversationController(bridge, hud, presentation);
    const resumed: unknown[] = [];
    controller.setResumeHandler(flag => { resumed.push(flag); });
    await controller.initialize();
    expect(presentation.snapshot().glasses.resumePrompt).toBe(RESUME_PROMPT);
    expect(controller.pendingResume).toMatchObject({ connected: true, listening: true });
    expect(hud.frame.header).toBe("HELIX · paused");
    expect(hud.frame.body.replace(/\n(?!\n)(?<!\n\n)/gu, " ")).toMatch(/^Session paused while Helix was in the background\.\s+▶ Tap to resume\.$/u);
    listener!({ sysEvent: { eventSource: 1 } } as EvenHubEvent); // tap
    await vi.waitFor(() => expect(resumed).toHaveLength(1));
    expect(resumed[0]).toMatchObject({ listening: true });
    controller.dismissResume();
    expect(presentation.snapshot().glasses.resumePrompt).toBeUndefined();
    await vi.waitFor(() => expect(storage.get(LIFECYCLE_STORAGE_KEY)).toBe(""));
    await controller.dispose();
    // Stale or missing flags offer nothing.
    storage.set(LIFECYCLE_STORAGE_KEY, JSON.stringify({ connected: true, listening: false, at: Date.now() - 13 * 3600_000 }));
    const fresh = new ConversationPresentation();
    const again = new G2ConversationController(bridge, new GlassesHud(bridge, { display: "always-on", tickMs: 0 }), fresh);
    await again.initialize();
    expect(fresh.snapshot().glasses.resumePrompt).toBeUndefined();
    // v0.11.1: an action while not connected offers the one-tap connect instead of only failing.
    const connects: unknown[] = [];
    again.setResumeHandler(flag => { connects.push(flag); });
    await expect(again.startListening()).rejects.toThrow(/Connect Helix/u);
    expect(fresh.snapshot().glasses.resumePrompt).toBe(CONNECT_PROMPT);
    await again.requestResume();
    expect(connects[0]).toMatchObject({ connected: true, listening: false });
    await again.dispose();
  });

  it("system exit clears the flag; an abnormal exit keeps it", async () => {
    for (const [eventType, expected] of [[OsEventTypeList.SYSTEM_EXIT_EVENT, ""], [OsEventTypeList.ABNORMAL_EXIT_EVENT, "kept"]] as const) {
      const storage = new Map<string, string>([[LIFECYCLE_STORAGE_KEY, "kept"]]);
      let listener: ((event: EvenHubEvent) => void) | undefined;
      const bridge: G2BridgePort & PageBridge = Object.assign(new PageBridge(), {
        getLocalStorage: async (key: string) => storage.get(key) ?? "",
        setLocalStorage: async (key: string, value: string) => { storage.set(key, value); return true; },
        audioControl: async () => true, shutDownPageContainer: async () => true,
        onEvenHubEvent: (callback: (event: EvenHubEvent) => void) => { listener = callback; return () => { listener = undefined; }; },
      });
      const controller = new G2ConversationController(bridge, new GlassesHud(bridge, { display: "always-on", tickMs: 0 }), new ConversationPresentation());
      await controller.initialize();
      listener!({ sysEvent: { eventType } } as EvenHubEvent);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(storage.get(LIFECYCLE_STORAGE_KEY)).toBe(expected);
    }
  });
});
