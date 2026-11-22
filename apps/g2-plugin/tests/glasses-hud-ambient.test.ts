import {
  ImageRawDataUpdateResult, OsEventTypeList, StartUpPageCreateResult,
  type CreateStartUpPageContainer, type EvenHubEvent, type ImageRawDataUpdate, type RebuildPageContainer, type TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import type { GatewayEvent } from "@helix/conversation-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { G2ConversationController, type G2BridgePort } from "../src/controller";
import {
  AMBIENT_IDLE_MS, BODY_LINES, DEFAULT_GLASSES_DISPLAY, GlassesHud, HUD_LINE_WIDTH, hudTextWidth, resolveGlassesDisplay,
} from "../src/glasses-hud";
import { glassesMirrorModel } from "../src/glasses-mirror";
import type { GlassesRenderBridge } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";

/** Bridge that can rebuild pages and draw images, with a timestamp on every write. */
class PageBridge implements GlassesRenderBridge {
  public readonly creates: CreateStartUpPageContainer[] = [];
  public readonly rebuilds: RebuildPageContainer[] = [];
  public readonly updates: (TextContainerUpgrade & { at: number })[] = [];
  public readonly images: string[] = [];
  public rebuildOk = true;
  public async createStartUpPageContainer(container: CreateStartUpPageContainer) { this.creates.push(container); return StartUpPageCreateResult.success; }
  public async rebuildPageContainer(container: RebuildPageContainer) { this.rebuilds.push(container); return this.rebuildOk; }
  public async textContainerUpgrade(container: TextContainerUpgrade) { this.updates.push(Object.assign(container, { at: Date.now() })); return true; }
  public async updateImageRawData(image: ImageRawDataUpdate) { this.images.push(image.containerName!); return ImageRawDataUpdateResult.success; }
  public writes(name: string) { return this.updates.filter(update => update.containerName === name); }
  /** Text shown in a container now: the last write, else what the last page was built with. */
  public shown(name: string): string {
    const page = this.rebuilds.at(-1) ?? this.creates.at(-1)!;
    const built = page.textObject?.find(text => text.containerName === name)?.content ?? "";
    return this.lastWrite(name) ?? built;
  }
  private lastWrite(name: string): string | undefined {
    // Writes after the last page build only: a rebuild replaces every container.
    const since = this.rebuildAt.at(-1) ?? 0;
    return this.updates.slice(since).filter(update => update.containerName === name).at(-1)?.content;
  }
  /** updates.length at each rebuild. */
  public readonly rebuildAt: number[] = [];
}
class TrackedBridge extends PageBridge {
  public override async rebuildPageContainer(container: RebuildPageContainer) { this.rebuildAt.push(this.updates.length); return super.rebuildPageContainer(container); }
}

type Role = "self" | "other" | "unknown";
const ctx = (label: string, role: Role = "unknown", trigger?: string) => ({
  prompt: { id: "p", version: "1" }, endpoint: { id: "openai-direct", url: "", provider: "openai", model: "m" },
  speaker: { label, role }, latencyMs: { totalMs: 900 }, ...(trigger ? { trigger } : {}),
});
let seq = 0;
const ev = (event: object) => ({ protocolVersion: "2.1", sessionId: "s", occurredAt: "2026-11-19T18:00:00.000Z", eventId: `a${++seq}`, ...event }) as unknown as GatewayEvent;
const question = (id: string, text: string) => ev({ type: "question.detected", questionId: id, text, confidence: 0.9, context: ctx("Other speaker", "other", "question") });
const delta = (answerId: string, questionId: string, text: string) => ev({ type: "answer.delta", answerId, questionId, delta: text, context: ctx("Helix", "unknown", "question") });
const completed = (answerId: string, questionId: string, text: string) => ev({ type: "answer.completed", answerId, questionId, text, context: ctx("Helix", "unknown", "question") });
const final = (id: string, text: string) => ev({ type: "transcript.final", transcriptId: id, text, context: ctx("Other speaker", "other") });
const at = "2026-11-19T18:00:00.000Z";
const LONG = "Jetson Orin modules currently list twelve to sixteen week lead times at major distributors, developer kits ship sooner but are allocation limited, and the x86 fallback with a discrete GPU needs a 600 W supply. ";
const verdict = (id: string, target = "Orin lead time is 12 weeks", summary = "Distributors list 12 to 16 weeks.") =>
  ({ id, target, status: "supported" as const, summary, sources: [], checkedAt: at, requestedBy: "auto" as const });

async function mount(options: ConstructorParameters<typeof GlassesHud>[1] = {}, bridge: PageBridge = new TrackedBridge()) {
  const hud = new GlassesHud(bridge, { tickMs: 0, writeGapMs: 0, ...options });
  const presentation = new ConversationPresentation();
  presentation.subscribe(snapshot => hud.render(snapshot.glasses, snapshot));
  await hud.initialize();
  return { bridge, hud, presentation };
}
/** Connects and waits until the "● listening" status cue has gone: the steady blank state. */
async function listening(options: ConstructorParameters<typeof GlassesHud>[1] = {}, bridge: PageBridge = new TrackedBridge()) {
  const mounted = await mount(options, bridge);
  mounted.presentation.setStatus("listening");
  await vi.advanceTimersByTimeAsync(6000);
  return mounted;
}
const names = (page: { textObject?: { containerName?: string }[] }) => (page.textObject ?? []).map(text => text.containerName);
const capturing = (page: Partial<RebuildPageContainer>) => [...(page.textObject ?? []), ...(page.listObject ?? [])].filter(item => item.isEventCapture === 1).map(item => item.containerName);
const blank = (text: string) => text.trim() === "";
const PANELS = ["hud-body", "hud-header", "hud-status", "hud-caption", "hud-mode", "hud-views"];
const allBlank = (bridge: PageBridge) => PANELS.every(name => blank(bridge.shown(name)));

afterEach(() => { vi.useRealTimers(); });

describe("ambient glasses display", () => {
  it("is the default; always-on is the other setting", () => {
    expect(DEFAULT_GLASSES_DISPLAY).toBe("ambient");
    expect(resolveGlassesDisplay(undefined)).toBe("ambient");
    expect(resolveGlassesDisplay("")).toBe("ambient");
    expect(resolveGlassesDisplay("anything")).toBe("ambient");
    expect(resolveGlassesDisplay("always-on")).toBe("always-on");
    expect(new GlassesHud(new PageBridge()).display).toBe("ambient");
    expect(new GlassesHud(new PageBridge(), { display: "always-on" }).display).toBe("always-on");
    expect(AMBIENT_IDLE_MS).toBe(20_000);
  });

  it("shows the start screen while not connected, then goes blank for the session with one event-capture container", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await mount();
    // Not connected: the normal start page (frame, splash, hints), so the wearer sees that Helix is up.
    expect(hud.ambient).toBe(false);
    expect(names(bridge.creates[0]!)).toContain("hud-frame");
    expect(hud.frame.title).toBe("HELIX");
    presentation.setStatus("listening");
    expect(hud.ambient).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    // The session page: no frame border, no image containers, BODY alone captures gestures.
    const page = bridge.rebuilds.at(-1)!;
    expect(names(page)).toEqual(PANELS);
    expect(page.containerTotalNum).toBe(6);
    expect(page.imageObject ?? []).toHaveLength(0);
    expect(page.listObject ?? []).toHaveLength(0);
    expect(capturing(page)).toEqual(["hud-body"]);
    expect(page.menuObject).toBeDefined(); // the OS menu stays
    // A short "● listening" confirms the mic, then nothing at all.
    expect(hud.frame.status.trim()).toBe("● listening");
    await vi.advanceTimersByTimeAsync(5000);
    expect(hud.frame.status.trim()).toBe("");
    expect(allBlank(bridge)).toBe(true);
    // Talk does not light the display: no caption, no LIVE view, no clock, no images, no page swaps.
    const rebuilds = bridge.rebuilds.length, writes = bridge.updates.length, images = bridge.images.length;
    for (let i = 0; i < 10; i++) {
      presentation.apply(ev({ type: "transcript.partial", transcriptId: "tp", revision: i, text: `word ${i}`, context: ctx("Other speaker", "other") }));
      await vi.advanceTimersByTimeAsync(300);
    }
    presentation.apply(final("t1", "We should decide this week."));
    await vi.advanceTimersByTimeAsync(70_000);
    expect(allBlank(bridge)).toBe(true);
    expect(bridge.updates).toHaveLength(writes);
    expect(bridge.rebuilds).toHaveLength(rebuilds);
    expect(bridge.images).toHaveLength(images);
    expect(hud.mirror).toMatchObject({ ambient: true, menuOpen: false });
    expect(hud.mirror.images).toBeUndefined();
    hud.dispose();
  });

  it("pops an answer up in the HUD style with text writes only, then lets it disappear", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await listening();
    const rebuilds = bridge.rebuilds.length;
    presentation.apply(question("q1", "How long is the Orin lead time?"));
    presentation.apply(completed("a1", "q1", "Twelve to sixteen weeks at major distributors."));
    expect(hud.frame.title).toBe("◆ THEY ASKED 1/1");
    expect(hud.frame.body).toBe("Q: How long is the Orin lead time?\nTwelve to sixteen weeks at major distributors.");
    expect(blank(hud.frame.caption) && blank(hud.frame.mode) && blank(hud.frame.views)).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(bridge.shown("hud-body")).toContain("Twelve to sixteen weeks");
    expect(bridge.shown("hud-header")).toBe("◆ THEY ASKED 1/1");
    expect(bridge.shown("hud-status").trim()).toBe("answer · tap to close");
    expect(blank(bridge.shown("hud-caption"))).toBe(true);
    // 8 s after the answer completed it is gone, without a gesture.
    await vi.advanceTimersByTimeAsync(8200);
    expect(allBlank(bridge)).toBe(true);
    expect(hud.ambient).toBe(true);
    expect(bridge.rebuilds).toHaveLength(rebuilds); // a pop-up never swaps the page
    // Writes to one container stay at least the 120 ms debounce apart.
    for (const name of PANELS) {
      const times = bridge.writes(name).map(write => write.at);
      for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(120);
    }
    hud.dispose();
  });

  it("pages a long answer by itself and never revives it after it expired", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await listening();
    presentation.apply(question("q1", "What are the options?"));
    presentation.apply(delta("a1", "q1", LONG.repeat(2)));
    expect(hud.frame.title).toBe("◆ THEY ASKED 1/…");
    expect(hud.frame.status.trim()).toBe("answering");
    presentation.apply(completed("a1", "q1", LONG.repeat(4).trim()));
    const pages = Number(/\/(\d+)$/u.exec(hud.frame.title)![1]);
    expect(pages).toBeGreaterThan(2);
    const seen = new Set<string>();
    for (let i = 0; i < 80 && !blank(hud.frame.body); i++) {
      seen.add(hud.frame.title);
      for (const line of hud.frame.body.split("\n")) expect(hudTextWidth(line)).toBeLessThanOrEqual(HUD_LINE_WIDTH.body);
      expect(hud.frame.body.split("\n").length).toBeLessThanOrEqual(BODY_LINES);
      await vi.advanceTimersByTimeAsync(1000);
    }
    // Every page was shown in order, then the display went blank.
    expect([...seen]).toEqual(Array.from({ length: pages }, (_, index) => `◆ THEY ASKED ${index + 1}/${pages}`));
    await vi.advanceTimersByTimeAsync(500);
    expect(allBlank(bridge)).toBe(true);
    // Nothing brings it back: later transcript events, the retained completed answer, or any old timer.
    const writes = bridge.updates.length;
    presentation.apply(final("t9", "Okay, thanks."));
    presentation.apply(completed("a1", "q1", LONG.repeat(4).trim()));
    hud.render(presentation.snapshot().glasses, presentation.snapshot());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(allBlank(bridge)).toBe(true);
    expect(bridge.updates).toHaveLength(writes);
    hud.dispose();
  });

  it("tap and swipe act on the pop-up only; a tap on the blank display asks about the last few sentences", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening();
    expect(hud.handleGesture("down")).toEqual({ type: "handled" });
    expect(hud.handleGesture("up")).toEqual({ type: "handled" });
    expect(hud.view).toBe("live"); // swipes do not browse views nobody can see
    expect(hud.ambient).toBe(true);
    expect(hud.handleGesture("click")).toEqual({ type: "askLocal" });
    presentation.apply(question("q1", "What are the options?"));
    presentation.apply(completed("a1", "q1", LONG.repeat(3).trim()));
    expect(hud.frame.title).toMatch(/THEY ASKED 1\/\d/u);
    expect(hud.handleGesture("down")).toEqual({ type: "handled" });
    expect(hud.frame.title).toMatch(/THEY ASKED 2\/\d/u);
    hud.handleGesture("up");
    expect(hud.frame.title).toMatch(/THEY ASKED 1\/\d/u);
    for (let i = 0; i < 6 && !blank(hud.frame.body); i++) expect(hud.handleGesture("click")).toEqual({ type: "handled" });
    expect(blank(hud.frame.body) && blank(hud.frame.title)).toBe(true); // tap on the last page closes it
    expect(hud.ambient).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(blank(hud.frame.body)).toBe(true);
    hud.dispose();
  });

  it("shows Thinking… for a requested answer, and gesture feedback in the status corner", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening();
    presentation.beginRequest();
    expect(presentation.snapshot().glasses.manualPending).toBe(true);
    expect(hud.frame.title).toBe("◆ ANSWER");
    expect(hud.frame.body).toMatch(/^Thinking…/u);
    expect(hud.frame.status.trim()).toBe("thinking");
    expect(hud.handleGesture("click")).toEqual({ type: "handled" }); // no second request while waiting
    presentation.setInteraction("HOLDING / RELEASE TO SUBMIT");
    expect(hud.frame.status.trim()).toContain("● HOLD · release to send");
    hud.dispose();
  });

  it("pops a fact verdict up as a cue, expires it, and gives a running answer the display first", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await listening();
    presentation.applyVerification(verdict("v1"));
    expect(hud.frame.title).toBe("CHECK");
    expect(hud.frame.body).toBe("● OK · supported · verify\nOrin lead time is 12 weeks\nDistributors list 12 to 16 weeks.");
    expect(hud.frame.status.trim()).toBe("tap to close");
    await vi.advanceTimersByTimeAsync(400);
    expect(bridge.shown("hud-body")).toContain("● OK · supported");
    await vi.advanceTimersByTimeAsync(5000);
    expect(allBlank(bridge)).toBe(true);
    // The same verdict again (snapshot re-emits) does not pop up twice.
    hud.render(presentation.snapshot().glasses, presentation.snapshot());
    presentation.apply(final("t2", "Right."));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(allBlank(bridge)).toBe(true);
    // A cue that arrives during an answer waits, shows after it, then expires.
    presentation.apply(question("q1", "How long is the lead time?"));
    presentation.apply(completed("a1", "q1", "Twelve to sixteen weeks."));
    presentation.applyFactCheck({ id: "f1", claim: "The cap is $25,000", status: "contradicted", summary: "Finance approved $40,000.", sources: [], checkedAt: at } as never);
    expect(hud.frame.title).toBe("◆ THEY ASKED 1/1");
    await vi.advanceTimersByTimeAsync(8100);
    expect(hud.frame.title).toBe("FACT CHECK");
    expect(hud.frame.body).toContain("▲ FALSE · contradicted · web check");
    await vi.advanceTimersByTimeAsync(5100);
    expect(blank(hud.frame.title) && blank(hud.frame.body)).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(allBlank(bridge)).toBe(true);
    // Concepts and finished lookups are cues too; pending lookups and summaries are not
    // (v0.14: the top suggested question is a cue as well, see v14-interview.test.ts).
    presentation.applyAsk({ id: "k1", kind: "lookup", topic: "Jetson lead time?", trigger: "lead time", status: "pending", createdAt: at });
    presentation.applySummary({ updatedAt: at, transcriptChars: 4000, bullets: ["Budget is open."], keyFacts: ["Quote due Thursday"] });
    expect(blank(hud.frame.body)).toBe(true);
    presentation.applyAsk({ id: "k1", kind: "lookup", topic: "Jetson lead time?", trigger: "lead time", status: "done", answer: "12 to 16 weeks.", createdAt: at });
    expect(hud.frame.title).toBe("LOOKUP");
    expect(hud.frame.body).toContain("Jetson lead time? 12 to 16 weeks.");
    expect(hud.handleGesture("click")).toEqual({ type: "handled" }); // tap closes a cue
    expect(blank(hud.frame.body)).toBe(true);
    presentation.applyConcept({ id: "c1", term: "NVMe", explanation: LONG.repeat(4), createdAt: at, origin: "copilot" });
    expect(hud.frame.title).toBe("CONCEPT 1/3"); // long cues page as well (at most 3 pages)
    expect(hud.frame.status.trim()).toBe("swipe ↓ more");
    await vi.advanceTimersByTimeAsync(10_100);
    expect(hud.frame.title).toBe("CONCEPT 2/3");
    await vi.advanceTimersByTimeAsync(40_000);
    expect(allBlank(bridge)).toBe(true);
    hud.dispose();
  });

  it("double-tap wakes the full HUD with the menu; double-tap on the menu hides it again", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await listening();
    presentation.apply(final("t1", "We should decide this week."));
    expect(hud.handleGesture("double")).toEqual({ type: "handled" });
    expect(hud.menuOpen).toBe(true);
    expect(hud.ambient).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    // The menu page: frame, header, caption, mode and images are back; the native list captures events.
    const menu = bridge.rebuilds.at(-1)!;
    expect(names(menu)).toEqual(["hud-frame", "hud-body", "hud-header", "hud-status", "hud-caption", "hud-mode"]);
    expect(menu.imageObject!.map(image => image.containerName)).toEqual(["hud-mascot", "hud-badge"]);
    expect(capturing(menu)).toEqual(["hud-menu"]);
    expect(hud.frame.title).toBe("MENU");
    expect(hud.frame.status.trim()).toBe("tap: select · double: hide");
    expect(hud.frame.caption).toContain("We should decide this week.");
    expect(hud.frame.mode.trim()).toBe("MEETING");
    expect(hud.mirror.ambient).toBeUndefined();
    expect(bridge.images).toContain("hud-mascot");
    // Double-tap again: straight back to the blank page.
    expect(hud.handleGesture("double")).toEqual({ type: "handled" });
    expect(hud.menuOpen).toBe(false);
    expect(hud.ambient).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(names(bridge.rebuilds.at(-1)!)).toEqual(PANELS);
    expect(capturing(bridge.rebuilds.at(-1)!)).toEqual(["hud-body"]);
    expect(allBlank(bridge)).toBe(true);
    // The idle timer of the dismissed wake is stale: it changes nothing later.
    const rebuilds = bridge.rebuilds.length;
    await vi.advanceTimersByTimeAsync(AMBIENT_IDLE_MS * 3);
    expect(bridge.rebuilds).toHaveLength(rebuilds);
    expect(allBlank(bridge)).toBe(true);
    hud.dispose();
  });

  it("a woken HUD works as before and returns to ambient after the idle time since the last gesture", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await listening({ ambientIdleMs: 10_000 });
    presentation.applyConcept({ id: "c1", term: "NVMe", explanation: "PCIe storage protocol for SSDs.", createdAt: at, origin: "copilot" });
    await vi.advanceTimersByTimeAsync(6000); // the concept cue came and went
    expect(allBlank(bridge)).toBe(true);
    hud.handleGesture("double");
    const concepts = hud.menuItems.findIndex(item => item.action === "concepts");
    expect(hud.selectListItem(concepts, hud.menuItems[concepts]!.label)).toEqual({ type: "handled" });
    expect(hud.menuOpen).toBe(false);
    expect(hud.ambient).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    // The full HUD page, as with the always-on setting.
    const page = bridge.rebuilds.at(-1)!;
    expect(names(page)).toEqual(["hud-frame", ...PANELS]);
    expect(capturing(page)).toEqual(["hud-body"]);
    expect(hud.frame.title).toBe("CONCEPTS 1/1");
    expect(hud.frame.body).toContain("NVMe");
    expect(hud.frame.views).toContain("▶ CONCEPTS");
    expect(hud.frame.status).toMatch(/● \dm/u);
    // New items do not pop up over the woken HUD, and gestures keep it awake.
    presentation.applyVerification(verdict("v1"));
    expect(hud.frame.title).toBe("CONCEPTS 1/1");
    await vi.advanceTimersByTimeAsync(7000);
    hud.handleGesture("down"); // 7 s in: restarts the idle time
    await vi.advanceTimersByTimeAsync(7000);
    expect(hud.ambient).toBe(false);
    // The phone moving the view is not a gesture on the glasses.
    hud.setView("summary");
    await vi.advanceTimersByTimeAsync(3500);
    expect(hud.ambient).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(names(bridge.rebuilds.at(-1)!)).toEqual(PANELS);
    expect(allBlank(bridge)).toBe(true);
    // The verdict that arrived while the HUD was awake was visible there: it does not pop up afterwards.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(allBlank(bridge)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    hud.dispose();
  });

  it("closes an open menu when the idle time ends, and an answer keeps showing as a pop-up", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await listening({ ambientIdleMs: 5000 });
    hud.handleGesture("double");
    await vi.advanceTimersByTimeAsync(4000);
    expect(hud.menuOpen).toBe(true);
    presentation.apply(question("q1", "How long is the lead time?"));
    presentation.apply(delta("a1", "q1", "Twelve to sixteen weeks."));
    await vi.advanceTimersByTimeAsync(1500);
    expect(hud.menuOpen).toBe(false);
    expect(hud.ambient).toBe(true);
    expect(names(bridge.rebuilds.at(-1)!)).toEqual(PANELS);
    expect(hud.frame.title).toBe("◆ THEY ASKED 1/…");
    expect(bridge.shown("hud-body")).toContain("Twelve to sixteen weeks.");
    presentation.apply(completed("a1", "q1", "Twelve to sixteen weeks."));
    await vi.advanceTimersByTimeAsync(8500);
    expect(allBlank(bridge)).toBe(true);
    hud.dispose();
  });

  it("returns to the start screen when the session ends and blanks again on the next one", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await listening();
    presentation.applyVerification(verdict("v1"));
    expect(hud.frame.title).toBe("CHECK");
    presentation.setStatus("stopped");
    expect(hud.ambient).toBe(false);
    expect(hud.frame.title).toBe("HELIX");
    await vi.advanceTimersByTimeAsync(1500);
    expect(names(bridge.rebuilds.at(-1)!)).toContain("hud-frame");
    expect(bridge.rebuilds.at(-1)!.imageObject!.map(image => image.containerName)).toContain("hud-splash");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hud.frame.title).toBe("HELIX"); // the cue of the ended session does not come back
    presentation.setStatus("connecting");
    presentation.setStatus("connected");
    await vi.advanceTimersByTimeAsync(1500);
    expect(names(bridge.rebuilds.at(-1)!)).toEqual(PANELS);
    expect(hud.frame.status.trim()).toBe("○ mic off");
    await vi.advanceTimersByTimeAsync(4000);
    expect(allBlank(bridge)).toBe(true);
    // A failed session needs attention: the HUD shows.
    presentation.setStatus("failed", "OpenAI rejected the key");
    expect(hud.ambient).toBe(false);
    expect(hud.frame.body).toContain("Problem: OpenAI rejected the key");
    hud.dispose();
  });

  it("the always-on setting keeps the previous HUD, and the Setup switch changes it live", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await listening({ display: "always-on" });
    presentation.apply(final("t1", "We should decide this week."));
    expect(hud.ambient).toBe(false);
    expect(names(bridge.rebuilds.at(-1)!)).toEqual(["hud-frame", ...PANELS]);
    expect(hud.frame.title).toBe("LIVE");
    expect(hud.frame.caption).toContain("We should decide this week.");
    expect(hud.frame.views).toContain("▶ LIVE");
    hud.handleGesture("double");
    expect(hud.frame.status.trim()).toBe("tap: select · double: close");
    hud.handleGesture("double"); // closes the menu only
    await vi.advanceTimersByTimeAsync(AMBIENT_IDLE_MS * 2);
    expect(hud.ambient).toBe(false);
    expect(hud.frame.title).toBe("LIVE");
    expect(vi.getTimerCount()).toBe(0);
    hud.setDisplay("ambient");
    expect(hud.display).toBe("ambient");
    expect(hud.ambient).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(names(bridge.rebuilds.at(-1)!)).toEqual(PANELS);
    expect(allBlank(bridge)).toBe(true);
    hud.setDisplay("always-on");
    await vi.advanceTimersByTimeAsync(600);
    expect(names(bridge.rebuilds.at(-1)!)).toEqual(["hud-frame", ...PANELS]);
    expect(bridge.shown("hud-header")).toBe("LIVE");
    hud.dispose();
  });

  it("re-pushes the blank page on foreground return, and retries a rejected page swap without looping", async () => {
    vi.useFakeTimers();
    const { bridge, hud } = await listening();
    expect(await hud.repush()).toBe(true);
    expect(names(bridge.rebuilds.at(-1)!)).toEqual(PANELS);
    // The glasses reject the wake page: the menu falls back to text in BODY, and the swap is retried once a second.
    bridge.rebuildOk = false;
    const before = bridge.rebuilds.length;
    hud.handleGesture("double");
    await vi.advanceTimersByTimeAsync(3500);
    expect(hud.menuOpen).toBe(true);
    expect(hud.frame.body).toContain("▶ Answer");
    expect(bridge.rebuilds.length - before).toBeLessThanOrEqual(5);
    bridge.rebuildOk = true;
    await vi.advanceTimersByTimeAsync(1500);
    expect(names(bridge.rebuilds.at(-1)!)).toEqual(["hud-frame", ...PANELS]);
    hud.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("works on a bridge that cannot swap pages: text blanks, the menu is the text fallback", async () => {
    vi.useFakeTimers();
    const updates: TextContainerUpgrade[] = [];
    const bridge: GlassesRenderBridge = {
      createStartUpPageContainer: async () => StartUpPageCreateResult.success,
      textContainerUpgrade: async container => { updates.push(container); return true; },
    };
    const hud = new GlassesHud(bridge, { tickMs: 0, writeGapMs: 0 });
    const presentation = new ConversationPresentation();
    presentation.subscribe(snapshot => hud.render(snapshot.glasses, snapshot));
    await hud.initialize();
    presentation.setStatus("listening");
    await vi.advanceTimersByTimeAsync(6000);
    const shown = (name: string) => updates.filter(update => update.containerName === name).at(-1)?.content ?? "";
    expect(PANELS.every(name => blank(shown(name)))).toBe(true);
    hud.handleGesture("double");
    expect(hud.menuOpen && !hud.menuNative).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(shown("hud-body")).toContain("▶ Answer");
    hud.handleGesture("double");
    await vi.advanceTimersByTimeAsync(1500); // the caption container is written at most once a second
    expect(PANELS.every(name => blank(shown(name)))).toBe(true);
    hud.dispose();
  });

  it("the phone mirror draws the ambient display without the frame box", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening();
    const model = glassesMirrorModel(hud.mirror);
    expect(model.images).toHaveLength(0);
    expect(model.lines.every(line => blank(line.text))).toBe(true);
    presentation.applyVerification(verdict("v1"));
    expect(glassesMirrorModel(hud.mirror).lines.filter(line => !blank(line.text)).map(line => line.text)).toEqual(
      ["CHECK", "tap to close", "● OK · supported · verify", "Orin lead time is 12 weeks", "Distributors list 12 to 16 weeks."]);
    hud.dispose();
  });
});

describe("ambient display: review fixes", () => {
  it("a wake left over from an ended session does not close the Connect/Mode menu opened afterwards", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening({ ambientIdleMs: 5000 });
    hud.handleGesture("double"); // wake: idle deadline in 5 s
    hud.handleGesture("double"); // hide again, then wake once more and leave the menu via Close
    hud.handleGesture("double");
    const close = hud.menuItems.findIndex(item => item.action === "close");
    hud.selectListItem(close, hud.menuItems[close]!.label);
    expect(hud.menuOpen).toBe(false);
    presentation.setStatus("stopped");
    await vi.advanceTimersByTimeAsync(1000);
    expect(hud.handleGesture("double")).toEqual({ type: "handled" }); // the idle Connect / Mode menu
    expect(hud.menuOpen).toBe(true);
    const items = hud.menuItems.map(item => item.label);
    hud.handleGesture("down"); // a gesture on the idle menu is not an ambient "touch"
    await vi.advanceTimersByTimeAsync(30_000);
    expect(hud.menuOpen).toBe(true);
    expect(hud.menuItems.map(item => item.label)).toEqual(items);
    expect(hud.mirror.lastGesture).not.toBe("ambient:sleep");
    hud.dispose();
  });

  it("a list click that arrives after the woken menu closed itself is consumed, not turned into a tap", async () => {
    vi.useFakeTimers();
    const { hud } = await listening({ ambientIdleMs: 5000 });
    hud.handleGesture("double");
    expect(hud.menuOpen).toBe(true);
    await vi.advanceTimersByTimeAsync(5500); // idle: the menu is gone, the display is blank
    expect(hud.menuOpen).toBe(false);
    expect(hud.ambient).toBe(true);
    expect(hud.selectListItem(0, "Answer")).toEqual({ type: "handled" });
    hud.dispose();
  });
});

describe("ambient display through the real controller", () => {
  it("a deferred MENU click does not ask a question when the menu has idled away in the meantime", async () => {
    let listener: ((event: EvenHubEvent) => void) | undefined;
    const bridge: G2BridgePort & TrackedBridge = Object.assign(new TrackedBridge(), {
      getLocalStorage: async () => "", setLocalStorage: async () => true,
      audioControl: async () => true, shutDownPageContainer: async () => true,
      onEvenHubEvent: (callback: (event: EvenHubEvent) => void) => { listener = callback; return () => { listener = undefined; }; },
    });
    const presentation = new ConversationPresentation();
    const hud = new GlassesHud(bridge, { tickMs: 0, writeGapMs: 0, ambientIdleMs: 1000 });
    const controller = new G2ConversationController(bridge, hud, presentation);
    await controller.initialize();
    const asked = vi.spyOn(controller, "askContext").mockResolvedValue(undefined as never);
    presentation.setStatus("listening");
    await vi.waitFor(() => expect(names(bridge.rebuilds.at(-1) ?? {})).toEqual(PANELS));
    const emit = (event: object) => listener?.(event as EvenHubEvent);
    emit({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT, eventSource: 1 } });
    expect(hud.menuOpen).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 850));
    // The click lands just before the idle time ends; its 250 ms deferral outlives the menu.
    emit({ listEvent: { containerID: 4, containerName: "hud-menu", currentSelectItemIndex: 0, eventType: OsEventTypeList.CLICK_EVENT } });
    await vi.waitFor(() => expect(hud.ambient).toBe(true), { timeout: 2000 });
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(asked).not.toHaveBeenCalled();
    await controller.dispose();
  });


  it("captures Even Hub gestures on the blank page: double press wakes the menu, a list click runs it", async () => {
    let listener: ((event: EvenHubEvent) => void) | undefined;
    const bridge: G2BridgePort & TrackedBridge = Object.assign(new TrackedBridge(), {
      getLocalStorage: async () => "", setLocalStorage: async () => true,
      audioControl: async () => true, shutDownPageContainer: async () => true,
      onEvenHubEvent: (callback: (event: EvenHubEvent) => void) => { listener = callback; return () => { listener = undefined; }; },
    });
    const presentation = new ConversationPresentation();
    const hud = new GlassesHud(bridge, { tickMs: 0, writeGapMs: 0 });
    const controller = new G2ConversationController(bridge, hud, presentation);
    await controller.initialize();
    presentation.setStatus("listening");
    await vi.waitFor(() => expect(names(bridge.rebuilds.at(-1) ?? {})).toEqual(PANELS));
    const emit = (event: object) => listener?.(event as EvenHubEvent);
    // Swipes on the blank BODY container are consumed and change nothing.
    emit({ textEvent: { containerID: 2, containerName: "hud-body", eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT } });
    expect(hud.view).toBe("live");
    expect(hud.ambient).toBe(true);
    emit({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT, eventSource: 1 } });
    expect(hud.menuOpen).toBe(true);
    await vi.waitFor(() => expect(capturing(bridge.rebuilds.at(-1)!)).toEqual(["hud-menu"]));
    const close = hud.menuItems.findIndex(item => item.action === "close");
    emit({ listEvent: { containerID: 4, containerName: "hud-menu", currentSelectItemIndex: close, currentSelectItemName: "Close", eventType: OsEventTypeList.CLICK_EVENT } });
    await vi.waitFor(() => expect(hud.menuOpen).toBe(false), { timeout: 2000 });
    expect(hud.ambient).toBe(false); // "Close" keeps the HUD; idle or double-tap on the menu hides it
    await vi.waitFor(() => expect(names(bridge.rebuilds.at(-1)!)).toEqual(["hud-frame", ...PANELS]));
    emit({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT, eventSource: 1 } });
    emit({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT, eventSource: 1 } });
    expect(hud.ambient).toBe(true);
    await vi.waitFor(() => expect(names(bridge.rebuilds.at(-1)!)).toEqual(PANELS));
    await controller.dispose();
  });
});
