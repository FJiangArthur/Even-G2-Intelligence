import {
  OsEventTypeList,
  StartUpPageCreateResult,
  type CreateStartUpPageContainer,
  type EvenHubEvent,
  type TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import { DirectConversationTransport, type DirectConversationOptions, type GatewayEvent } from "@helix/conversation-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config";
import { G2ConversationController, type G2BridgePort } from "../src/controller";
import {
  BODY_LINES,
  GlassesHud,
  HUD_LINE_WIDTH,
  HUD_PANELS,
  HUD_VIEWS,
  fitLines,
  hudTextWidth,
  resolveGlassesLayout,
  tailLines,
  wrapText,
  type GlassesSurface,
  type HudFrame,
} from "../src/glasses-hud";
import { GlassesRenderer, type GlassesRenderBridge } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";
import { createFakeOpenAI } from "./fake-openai";

class FakeBridge implements GlassesRenderBridge {
  public readonly creates: CreateStartUpPageContainer[] = [];
  public readonly updates: (TextContainerUpgrade & { at: number })[] = [];
  public accept = true;
  public async createStartUpPageContainer(container: CreateStartUpPageContainer): Promise<StartUpPageCreateResult> {
    this.creates.push(container);
    return StartUpPageCreateResult.success;
  }
  public async textContainerUpgrade(container: TextContainerUpgrade): Promise<boolean> {
    this.updates.push(Object.assign(container, { at: Date.now() }));
    return this.accept;
  }
  public writes(name: string) { return this.updates.filter(update => update.containerName === name); }
}

const ctx = (label: string) => ({
  prompt: { id: "p", version: "1" }, endpoint: { id: "openai-direct", url: "", provider: "openai", model: "m" },
  speaker: { label, role: "unknown" as const }, latencyMs: { totalMs: 900 },
});
const base = { protocolVersion: "2.1" as const, sessionId: "s", occurredAt: "2026-11-08T18:00:00.000Z" };
const ev = (event: object) => ({ ...base, eventId: `e${Math.random()}`, ...event }) as unknown as GatewayEvent;
const partial = (text: string, speaker = "Other speaker") => ev({ type: "transcript.partial", transcriptId: "tp", revision: 1, text, context: ctx(speaker) });
const final = (id: string, text: string, speaker = "Other speaker") => ev({ type: "transcript.final", transcriptId: id, text, context: ctx(speaker) });
const manualQuestion = (id: string, label = "Local context") => ev({ type: "question.detected", questionId: id, text: "help", confidence: 1, context: { ...ctx(label), trigger: "manual" } });
const delta = (answerId: string, questionId: string, text: string) => ev({ type: "answer.delta", answerId, questionId, delta: text, context: { ...ctx("Helix"), trigger: "manual" } });
const completed = (answerId: string, questionId: string, text: string) => ev({ type: "answer.completed", answerId, questionId, text, context: { ...ctx("Helix"), trigger: "manual" } });

const LONG = "Jetson Orin modules currently list twelve to sixteen week lead times at major distributors, developer kits ship sooner but are allocation limited, and the x86 fallback with a discrete GPU needs a 600 W supply. ";
const at = "2026-11-08T18:00:00.000Z";

function richPresentation(presentation: ConversationPresentation): void {
  presentation.setStatus("listening");
  presentation.applyConcept({ id: "c1", term: "CDTF", explanation: "Camera data transfer framework used by the perception team. " + LONG, createdAt: at, origin: "copilot" });
  presentation.applyConcept({ id: "c2", term: "NVMe", explanation: "PCIe storage protocol for SSDs.", createdAt: at, origin: "copilot" });
  presentation.applyConflict({ id: "x1", earlier: "Finance approved $40,000.", later: "The cap is $25,000 including sensors.", explanation: "Budget stated as $40,000 and later $25,000.", createdAt: at });
  presentation.applyVerification({ id: "v1", target: "Orin lead time is 12 weeks", status: "supported", summary: LONG, sources: [], checkedAt: at, requestedBy: "auto" });
  presentation.setSuggestions([
    { id: "s1", question: "What is the fallback if the Jetson order slips past the end of the quarter and the demo date stays fixed?", why: "", createdAt: at },
    { id: "s2", question: "Is 16 GB enough while recording rosbags?", why: "", createdAt: at },
    { id: "s3", question: "Who owns the purchase request?", why: "", createdAt: at },
    { id: "s4", question: "Does ROS 2 Jazzy support the camera driver?", why: "", createdAt: at },
    { id: "s5", question: "Not shown: only four fit.", why: "", createdAt: at },
  ]);
  presentation.applyAsk({ id: "k1", kind: "lookup", topic: "Jetson Orin lead time?", trigger: "lead time", status: "done", answer: LONG, createdAt: at });
  presentation.applySummary({ updatedAt: at, transcriptChars: 4000,
    bullets: Array.from({ length: 6 }, (_, index) => `Bullet ${index + 1}: ${LONG}`), keyFacts: ["Budget cap $25,000", "Quote due Thursday"] });
  presentation.apply(final("t1", "Then we should decide this week whether to wait for an Orin module or go with an x86 box.", "You"));
}

async function mount(options: ConstructorParameters<typeof GlassesHud>[1] = {}) {
  const bridge = new FakeBridge();
  const hud = new GlassesHud(bridge, { display: "always-on", tickMs: 0, writeGapMs: 0, captionIntervalMs: 500, ...options });
  const presentation = new ConversationPresentation();
  presentation.subscribe(snapshot => hud.render(snapshot.glasses, snapshot));
  await hud.initialize();
  return { bridge, hud, presentation };
}

function expectFits(frame: HudFrame, context: string): void {
  const check = (text: string, lines: number, width: number, name: string) => {
    expect(text.length, `${context} ${name} non-empty`).toBeGreaterThan(0);
    const rows = text.split("\n");
    expect(rows.length, `${context} ${name} lines: ${text}`).toBeLessThanOrEqual(lines);
    for (const row of rows) expect(hudTextWidth(row), `${context} ${name} width: ${row}`).toBeLessThanOrEqual(width);
    expect(wrapText(text, width).length, `${context} ${name} native rewrap`).toBe(rows.length);
  };
  // v0.10: the header line is two containers (title left, status right-aligned).
  check(frame.title, 1, HUD_LINE_WIDTH.header, "title");
  check(frame.status, 1, HUD_LINE_WIDTH.status, "status");
  check(frame.body, BODY_LINES, HUD_LINE_WIDTH.body, "body");
  check(frame.caption, 2, HUD_LINE_WIDTH.caption, "caption");
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("glasses HUD layout", () => {
  it("creates four non-overlapping text containers, one event capture region and the native shortcut menu", async () => {
    const { bridge, hud } = await mount();
    const page = bridge.creates[0]!;
    expect(page.containerTotalNum).toBe(7); // v0.11: frame + body + header + status + caption + mode + views
    expect(page.imageObject).toBeUndefined(); // this bridge cannot send images
    expect(page.textObject!.map(panel => panel.containerName)).toEqual(["hud-frame", "hud-body", "hud-header", "hud-status", "hud-caption", "hud-mode", "hud-views"]);
    // The frame is the one big box; everything else must not overlap, and body + rail sit inside it.
    const frame = page.textObject![0]!;
    const panels = page.textObject!.slice(1);
    for (const name of ["hud-body", "hud-mode", "hud-views"]) {
      const inner = panels.find(panel => panel.containerName === name)!;
      expect(inner.xPosition!).toBeGreaterThanOrEqual(frame.xPosition! + 2); expect(inner.xPosition! + inner.width!).toBeLessThanOrEqual(frame.xPosition! + frame.width! - 2);
      expect(inner.yPosition!).toBeGreaterThanOrEqual(frame.yPosition! + 1); expect(inner.yPosition! + inner.height!).toBeLessThanOrEqual(frame.yPosition! + frame.height! - 2);
    }
    expect(panels.filter(panel => panel.isEventCapture === 1).map(panel => panel.containerName)).toEqual(["hud-body"]);
    const overlaps = (a: typeof panels[number], b: typeof panels[number]) => a.xPosition! < b.xPosition! + b.width! && b.xPosition! < a.xPosition! + a.width!
      && a.yPosition! < b.yPosition! + b.height! && b.yPosition! < a.yPosition! + a.height!;
    panels.forEach((panel, index) => {
      expect(panel.xPosition! + panel.width!).toBeLessThanOrEqual(576);
      expect(panel.yPosition! + panel.height!).toBeLessThanOrEqual(288);
      expect(panel.content?.length).toBeGreaterThan(0);
      expect(panel.textColor).toBeGreaterThanOrEqual(0); expect(panel.textColor).toBeLessThanOrEqual(4);
      expect(new TextEncoder().encode(panel.containerName).length).toBeLessThanOrEqual(16);
      for (const other of panels.slice(index + 1)) expect(overlaps(panel, other), `${panel.containerName} / ${other.containerName}`).toBe(false);
    });
    // Body: six 27 px lines inside border + padding, so content can never scroll natively.
    const body = HUD_PANELS.body;
    expect(body.height - 2 * (body.borderWidth + body.paddingLength)).toBeGreaterThanOrEqual(BODY_LINES * 27);
    expect(HUD_PANELS.caption.height).toBeGreaterThanOrEqual(2 * 27);
    expect(page.menuObject?.menuItems?.map(item => item.itemID)).toEqual([1, 2, 3, 4, 5]);
    expect(hud.frame.header).toContain("not connected");
    expect(resolveGlassesLayout(undefined)).toBe("hud");
    expect(resolveGlassesLayout("answers-only")).toBe("answers-only");
    hud.dispose();
  });

  it("hard-wraps every view within the calibrated budget, including CJK and long words", async () => {
    const { hud, presentation } = await mount();
    richPresentation(presentation);
    presentation.applyConcept({ id: "c3", term: "中文术语", explanation: "这是一个很长的中文解释，用来检查全角字符的宽度与换行。".repeat(8), createdAt: at, origin: "copilot" });
    presentation.apply(partial("https://example.com/" + "averyveryverylongpathsegment".repeat(6)));
    const seen = new Set<string>();
    for (let step = 0; step < 30; step += 1) {
      expectFits(hud.frame, `${hud.view}#${step}`);
      seen.add(hud.view);
      hud.handleGesture("down");
    }
    expect([...seen].sort()).toEqual([...HUD_VIEWS].sort());
    expect(fitLines("word ".repeat(200), 3, 200)).toHaveLength(3);
    expect(fitLines("word ".repeat(200), 3, 200)[2]).toMatch(/…$/u);
    hud.dispose();
  });

  it("captions the streaming partial tail with the speaker, then the last final line, then gesture hints", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await mount({ captionHoldMs: 30000 });
    presentation.setStatus("listening");
    expect(hud.frame.caption).toContain("double-tap: menu");
    const words = Array.from({ length: 60 }, (_, index) => `word${index}`);
    presentation.apply(partial(words.slice(0, 5).join(" ")));
    expect(hud.frame.caption).toBe("Them: word0 word1 word2 word3 word4");
    presentation.apply(partial(words.join(" ")));
    const caption = hud.frame.caption.split("\n");
    expect(caption).toHaveLength(2);
    expect(caption[0]).toMatch(/^Them: …/u);
    expect(caption[1]).toMatch(/word59$/u);
    presentation.apply(final("t9", "Okay, we decided to drop the spare.", "You"));
    expect(hud.frame.caption).toBe("You: Okay, we decided to drop the spare.");
    await vi.advanceTimersByTimeAsync(31000);
    hud.render(presentation.snapshot().glasses, presentation.snapshot());
    expect(hud.frame.caption).toContain("swipe");
    expect(tailLines("short", 2, 500)).toEqual(["short"]);
    hud.dispose();
  });
});

describe("glasses HUD interaction", () => {
  it("walks the view ring with swipes; swipe back undoes into the previous view's last position", async () => {
    const { hud, presentation } = await mount();
    richPresentation(presentation);
    const path: string[] = [];
    for (let step = 0; step < 40 && (step === 0 || hud.view !== "live"); step += 1) {
      expect(hud.handleGesture("down")).toEqual({ type: "handled" });
      path.push(`${hud.view}:${hud.frame.header.split(" · ")[0]}`);
    }
    expect(path.at(-1)).toBe("live:LIVE");
    expect(path).toContain("qa:ASK THEM 4/4");
    expect(path.filter(item => item.startsWith("qa:"))).toHaveLength(4);
    hud.handleGesture("up");
    expect(hud.view).toBe("checks");
    expect(hud.frame.header).toMatch(/^CHECKS 2\/2/u);
    hud.handleGesture("down");
    expect(hud.view).toBe("live");
    hud.dispose();
  });

  it("taps are context sensitive; double tap opens the glasses menu instead of asking", async () => {
    const { hud, presentation } = await mount();
    richPresentation(presentation);
    expect(hud.handleGesture("click")).toEqual({ type: "askLocal" });
    expect(hud.handleGesture("double")).toEqual({ type: "handled" });
    expect(hud.menuOpen).toBe(true);
    expect(hud.handleGesture("double")).toEqual({ type: "handled" });
    expect(hud.menuOpen).toBe(false);
    while (hud.view !== "qa") hud.handleGesture("down");
    expect(hud.frame.body.split("\n")[0]).toMatch(/^▶ ① What is the fallback/u);
    hud.handleGesture("down");
    expect(hud.frame.body).toMatch(/\n▶ ② Is 16 GB enough/u);
    expect(hud.frame.body).not.toContain("Not shown");
    expect(hud.handleGesture("click")).toEqual({ type: "ask", text: "Is 16 GB enough while recording rosbags?" });
    hud.handleGesture("down"); hud.handleGesture("down"); hud.handleGesture("down");
    expect(hud.view).toBe("concepts");
    // CONCEPTS: tap verifies the highlighted concept (newest first).
    expect(hud.handleGesture("click")).toEqual({ type: "verify", id: "c2", target: "NVMe: PCIe storage protocol for SSDs.", kind: "concept" });
    hud.dispose();
  });

  it("auto-switches to ANSWER for a pending ask, pages with swipes and taps, and restores the previous view", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await mount();
    richPresentation(presentation);
    while (hud.view !== "qa") hud.handleGesture("down");
    hud.handleGesture("down"); // highlight 2
    presentation.beginRequest();
    expect(hud.view).toBe("answer");
    expect(hud.frame.body).toMatch(/^Thinking…/u);
    expect(hud.frame.header).toMatch(/^◆ ANSWER · .*thinking/u);
    expect(hud.handleGesture("click")).toEqual({ type: "handled" });
    presentation.apply(manualQuestion("q1"));
    const text = LONG.repeat(4).trim();
    presentation.apply(delta("a1", "q1", text.slice(0, 400)));
    expect(hud.frame.header).toMatch(/^◆ ANSWER 1\/… /u);
    presentation.apply(delta("a1", "q1", text.slice(400)));
    presentation.apply(completed("a1", "q1", text));
    expect(hud.frame.header).toMatch(/^◆ ANSWER 1\/[3-5] · .*swipe ↓ more/u);
    const page1 = hud.frame.body;
    hud.handleGesture("down");
    expect(hud.frame.header).toMatch(/^◆ ANSWER 2\/[3-5]/u);
    hud.handleGesture("up");
    expect(hud.frame.body).toBe(page1);
    const pages = Number(/\/(\d)/u.exec(hud.frame.header)![1]); // narrower BODY in v0.11: page count depends on the width
    for (let page = 1; page < pages; page += 1) expect(hud.handleGesture("click")).toEqual({ type: "handled" });
    expect(hud.frame.header).toMatch(new RegExp(`^◆ ANSWER ${pages}/${pages} · .*tap to close`, "u"));
    hud.handleGesture("click");
    expect(hud.view).toBe("qa");
    expect(hud.frame.header).toMatch(/^ASK THEM 2\/4/u);
    // Recall: the last answer stays readable on demand without reviving.
    hud.handleGesture("up"); hud.handleGesture("up");
    expect(hud.view).toBe("answer");
    expect(hud.frame.header).toMatch(/^◆ ANSWER \d\/\d · .*last answer/u);
    hud.dispose();
  });

  it("returns from an auto-shown answer after it expires, and leaves a failed pending ask", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await mount();
    richPresentation(presentation);
    hud.handleGesture("up"); // CHECKS
    expect(hud.view).toBe("checks");
    presentation.beginRequest();
    presentation.apply(manualQuestion("q2", "Whole conversation"));
    presentation.apply(completed("a2", "q2", "Short answer."));
    expect(hud.view).toBe("answer");
    await vi.advanceTimersByTimeAsync(8100);
    expect(hud.view).toBe("checks");
    presentation.beginRequest();
    expect(hud.view).toBe("answer");
    presentation.setStatus("failed", "Provider timed out");
    expect(hud.view).toBe("checks");
    hud.handleGesture("down");
    expect(hud.frame.header).toMatch(/^LIVE · ! ERROR/u);
    expect(hud.frame.body).toContain("Provider timed out");
    hud.dispose();
  });

  it("consumes swipes but leaves taps to the controller while not connected; resets per session", async () => {
    const { hud, presentation } = await mount();
    expect(hud.handleGesture("down")).toEqual({ type: "handled" });
    expect(hud.handleGesture("click")).toBeUndefined();
    expect(hud.handleGesture("double")).toEqual({ type: "handled" }); // v0.11: Connect / Mode menu before Connect
    expect(hud.menuItems.map(item => item.label)).toEqual(["Connect", "Mode ▶", "Close"]);
    expect(hud.selectListItem(0)).toEqual({ type: "connect" });
    expect(hud.menuOpen).toBe(false);
    richPresentation(presentation);
    hud.handleGesture("up");
    expect(hud.view).toBe("checks");
    presentation.reset();
    presentation.setStatus("connecting");
    expect(hud.view).toBe("live");
    expect(hud.frame.body).toMatch(/^Connecting…/u);
    presentation.setStatus("connected");
    expect(hud.frame.header).toMatch(/^LIVE · ○ MIC OFF$/u);
    expect(hud.frame.body).toMatch(/^Mic is off/u);
    hud.dispose();
  });

  it("shows push-to-talk feedback and the session clock in the header", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await mount({ tickMs: 1000 });
    presentation.setStatus("listening");
    await vi.advanceTimersByTimeAsync(65000);
    expect(hud.frame.header).toBe("LIVE · ● 1m");
    presentation.setInteraction("[ HOLDING ] RELEASE TO SUBMIT");
    expect(hud.frame.header).toBe("LIVE · ● HOLD · release to send");
    presentation.setInteraction("SENT / WAITING FOR RESPONSE");
    expect(hud.frame.header).toBe("LIVE · SENT");
    await vi.advanceTimersByTimeAsync(5000);
    expect(hud.frame.header).toBe("LIVE · ● 1m");
    presentation.applyConcept({ id: "n1", term: "RAG", explanation: "Retrieval.", createdAt: at, origin: "copilot" });
    expect(hud.frame.header).toBe("LIVE · ● 1m · 1 new");
    hud.handleGesture("down"); hud.handleGesture("up");
    expect(hud.frame.header).toBe("LIVE · ● 1m");
    hud.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("glasses HUD transport", () => {
  it("sends only changed containers, throttles captions to 500 ms and others to 120 ms", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await mount();
    presentation.setStatus("listening");
    await hud.flush();
    const before = bridge.updates.length;
    for (let index = 1; index <= 40; index += 1) {
      presentation.apply(partial(Array.from({ length: index }, (_, word) => `w${word}`).join(" ")));
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(400);
    const updates = bridge.updates.slice(before);
    const captions = updates.filter(update => update.containerName === "hud-caption");
    // Only the caption changed (plus the header session clock as fake time passes).
    expect(updates.filter(update => update.containerName === "hud-body")).toEqual([]);
    expect(updates.filter(update => update.containerName === "hud-header").every(update => update.content === "LIVE")).toBe(true);
    expect(updates.filter(update => update.containerName === "hud-status").every(update => /^ *● 0m$/u.test(update.content!))).toBe(true);
    // 2.4 s of streaming words -> ~2 caption writes/s (battery: BLE writes were ~3.3/s at 300 ms).
    expect(captions.length).toBeGreaterThanOrEqual(4);
    expect(captions.length).toBeLessThanOrEqual(6);
    captions.slice(1).forEach((update, index) => expect(update.at - captions[index]!.at).toBeGreaterThanOrEqual(500));
    expect(captions.at(-1)?.content).toMatch(/w39$/u);
    const bodyBefore = bridge.writes("hud-body").length;
    for (const concept of ["A", "B", "C", "D"]) presentation.applyConcept({ id: concept, term: concept, explanation: "x", createdAt: at, origin: "copilot" });
    await vi.advanceTimersByTimeAsync(119);
    expect(bridge.writes("hud-body").length).toBe(bodyBefore);
    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.writes("hud-body").length).toBe(bodyBefore + 1); // four changes coalesced into one write
    expect(bridge.writes("hud-body").at(-1)!.content).toMatch(/^D: x/u);
    expect(bridge.updates.every(update => update.content!.length > 0)).toBe(true);
    hud.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops in-flight work on dispose, backs off after a rejected write, and re-initializes", async () => {
    vi.useFakeTimers();
    const errors: string[] = [];
    const { bridge, hud, presentation } = await mount({ onError: error => errors.push(error.message) });
    bridge.accept = false;
    presentation.setStatus("listening");
    await hud.flush();
    expect(errors).toEqual(["G2 rejected the hud-body text update"]);
    const attempts = bridge.updates.length;
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(900); // one-second global back-off: no BLE hammering
    expect(bridge.updates.length).toBe(attempts);
    bridge.accept = true;
    await vi.advanceTimersByTimeAsync(400);
    expect(bridge.updates.length).toBeGreaterThan(attempts);
    presentation.applyConcept({ id: "late", term: "Late", explanation: "x", createdAt: at, origin: "copilot" });
    hud.dispose();
    const count = bridge.updates.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(bridge.updates.length).toBe(count);
    expect(vi.getTimerCount()).toBe(0);
    await hud.initialize();
    expect(bridge.creates).toHaveLength(2);
    hud.render(presentation.snapshot().glasses, presentation.snapshot());
    expect(hud.frame.body).toMatch(/^Late: x/u);
    hud.dispose();
  });

  it("never throws from render or gestures on malformed snapshots", async () => {
    const renderErrors: unknown[] = [];
    const { hud, presentation } = await mount({ onRenderError: error => renderErrors.push(error) });
    presentation.setStatus("listening");
    const snapshot = presentation.snapshot();
    const broken = { ...snapshot, concepts: [{ id: "bad" }], feed: [{ id: "transcript-partial", kind: "transcript" }] } as unknown as typeof snapshot;
    expect(() => hud.render(snapshot.glasses, broken)).not.toThrow();
    expect(renderErrors.length).toBeGreaterThan(0);
    expect(() => hud.handleGesture("down")).not.toThrow();
    hud.render(snapshot.glasses, snapshot);
    expect(hud.frame.header).toMatch(/^LIVE|^◆ ANSWER/u);
    hud.dispose();
  });

  it("keeps GlassesRenderer usable as the answers-only surface", () => {
    const surface: GlassesSurface = new GlassesRenderer(new FakeBridge());
    expect(surface.handleGesture).toBeUndefined();
    surface.dispose();
  });
});

describe("glasses HUD through the real controller", () => {
  it("routes swipes, Q&A taps and double taps from Even Hub events to asks", async () => {
    const fake = createFakeOpenAI();
    let listener: ((event: EvenHubEvent) => void) | undefined;
    const bridge: G2BridgePort & FakeBridge = Object.assign(new FakeBridge(), {
      getLocalStorage: async () => "", setLocalStorage: async () => true,
      audioControl: async () => true, shutDownPageContainer: async () => true,
      onEvenHubEvent: (callback: (event: EvenHubEvent) => void) => { listener = callback; return () => { listener = undefined; }; },
    });
    const presentation = new ConversationPresentation();
    const hud = new GlassesHud(bridge, { display: "always-on", tickMs: 0 });
    let transport: DirectConversationTransport | undefined;
    const controller = new G2ConversationController(bridge, hud, presentation,
      (options?: DirectConversationOptions) => (transport = new DirectConversationTransport({ ...options, fetch: fake.fetch } as DirectConversationOptions)));
    await controller.initialize();
    await controller.connect({ ...DEFAULT_CONFIG, model: "gpt-4.1-mini", accessToken: "", openaiApiKey: "sk-fake", deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", saveApiKeysOnPhone: false, autoExplainTerms: false, copilotSuggestions: false });
    await vi.waitFor(() => expect(presentation.snapshot().status).toBe("connected"));
    await transport!.injectTranscript("Finance approved forty thousand dollars for compute hardware.", { label: "Other speaker", role: "other" });
    expect(hud.frame.caption.replace("\n", " ")).toBe("Them: Finance approved forty thousand dollars for compute hardware.");
    presentation.setSuggestions([
      { id: "s1", question: "Who owns the purchase request?", why: "", createdAt: at },
      { id: "s2", question: "Is 16 GB enough while recording rosbags?", why: "", createdAt: at },
    ]);
    const emit = (event: object) => listener?.(event as EvenHubEvent);
    const swipeDown = { textEvent: { containerID: 2, containerName: "hud-body", eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } };
    emit(swipeDown); emit(swipeDown);
    expect(hud.view).toBe("qa");
    emit(swipeDown);
    expect(hud.frame.header).toMatch(/^ASK THEM 2\/2/u);
    emit({ textEvent: { containerID: 2, containerName: "hud-body", eventType: OsEventTypeList.SCROLL_TOP_EVENT } });
    expect(hud.frame.header).toMatch(/^ASK THEM 1\/2/u);
    emit(swipeDown);
    // Streamed answer requests only (the copilot lane uses JSON requests).
    const answers = () => fake.requests.filter(request => request.intent === "answer" && request.stream);
    emit({ sysEvent: { eventSource: 1 } }); // tap; resolved after the 250 ms double-tap window
    await vi.waitFor(() => expect(answers()).toHaveLength(1), { timeout: 2000 });
    expect(JSON.stringify(answers()[0]!.body)).toContain("Is 16 GB enough while recording rosbags?");
    await vi.waitFor(() => expect(presentation.snapshot().glasses.answer?.streaming).toBe(false), { timeout: 2000 });
    expect(hud.view).toBe("answer");
    emit({ sysEvent: { eventSource: 1 } });
    emit({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT, eventSource: 1 } });
    // Double press opens the menu (text fallback: this fake bridge cannot rebuild pages).
    expect(hud.menuOpen).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(answers()).toHaveLength(1); // the tap before the double tap was discarded; no global ask
    emit(swipeDown); // highlight "Answer whole conversation"
    emit({ sysEvent: { eventSource: 1 } });
    await vi.waitFor(() => expect(answers()).toHaveLength(2), { timeout: 2000 });
    expect(hud.menuOpen).toBe(false);
    expect(JSON.stringify(answers()[1]!.body)).toContain("whole captured session");
    await controller.dispose();
  });
});
