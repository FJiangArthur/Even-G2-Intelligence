/**
 * v0.16 hidden-display pop-ups: one full-canvas container, content only, centred.
 * Simulator and unit level only. How the real G2 font centres is a device check.
 */
import {
  ImageRawDataUpdateResult, StartUpPageCreateResult,
  type CreateStartUpPageContainer, type ImageRawDataUpdate, type RebuildPageContainer, type TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import type { CopilotSuggestion, GatewayEvent } from "@helix/conversation-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnswerPager, centrePage, FULL_CANVAS_PAGE, paginateAnswer } from "../src/answer-pager";
import {
  AMBIENT_LINES, AMBIENT_LINE_WIDTH, AMBIENT_MAX_BYTES, BODY_LINES, GlassesHud, HUD_AMBIENT_PANEL, HUD_LINE_HEIGHT, HUD_LINE_WIDTH,
  MODE_NOTICE_MS, centreBlock, hudGlyphWidth, hudTextWidth,
} from "../src/glasses-hud";
import { glassesMirrorModel } from "../src/glasses-mirror";
import { GlassesRenderer, type GlassesRenderBridge } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";

const SPACE = 5.2;
/** Bridge that records every page and write, and every write to a container the page on the glasses does not have. */
class PageBridge implements GlassesRenderBridge {
  public readonly creates: CreateStartUpPageContainer[] = [];
  public readonly rebuilds: RebuildPageContainer[] = [];
  public readonly updates: TextContainerUpgrade[] = [];
  /** Writes addressed to a container that is not on the current page. */
  public readonly stray: string[] = [];
  /** Longest text handed to the glasses in any page or write. */
  public longest = 0;
  public rebuildOk = true;
  private page?: Partial<RebuildPageContainer>;
  private since = 0;
  public async createStartUpPageContainer(container: CreateStartUpPageContainer) { this.creates.push(container); this.take(container); return StartUpPageCreateResult.success; }
  public async rebuildPageContainer(container: RebuildPageContainer) {
    this.rebuilds.push(container);
    if (this.rebuildOk) this.take(container);
    return this.rebuildOk;
  }
  public async textContainerUpgrade(container: TextContainerUpgrade) {
    this.updates.push(container);
    this.longest = Math.max(this.longest, (container.content ?? "").length);
    const known = (this.page?.textObject ?? []).some(text => text.containerID === container.containerID && text.containerName === container.containerName);
    if (!known) this.stray.push(`${container.containerID}:${container.containerName}`);
    return true;
  }
  public async updateImageRawData(_image: ImageRawDataUpdate) { return ImageRawDataUpdateResult.success; }
  private take(page: Partial<RebuildPageContainer>) {
    this.page = page; this.since = this.updates.length;
    for (const text of page.textObject ?? []) this.longest = Math.max(this.longest, (text.content ?? "").length);
  }
  public get current(): Partial<RebuildPageContainer> { return this.page!; }
  /** Writes since the current page was built. */
  public get pageWrites(): TextContainerUpgrade[] { return this.updates.slice(this.since); }
  /** Text of the ambient container now: the last write to it, else what the page was built with. */
  public get shown(): string {
    return this.pageWrites.filter(update => update.containerName === "hud-ambient").at(-1)?.content
      ?? this.page?.textObject?.find(text => text.containerName === "hud-ambient")?.content ?? "";
  }
}

type Role = "self" | "other" | "unknown";
const ctx = (label: string, role: Role = "unknown", trigger?: string) => ({
  prompt: { id: "p", version: "1" }, endpoint: { id: "openai-direct", url: "", provider: "openai", model: "m" },
  speaker: { label, role }, latencyMs: { totalMs: 900 }, ...(trigger ? { trigger } : {}),
});
let seq = 0;
const ev = (event: object) => ({ protocolVersion: "2.1", sessionId: "s", occurredAt: "2026-11-19T18:00:00.000Z", eventId: `v16-${++seq}`, ...event }) as unknown as GatewayEvent;
const question = (id: string, text: string, role: Role = "other") => ev({ type: "question.detected", questionId: id, text, confidence: 0.9, context: ctx(role === "self" ? "You" : "Other speaker", role, "question") });
const delta = (answerId: string, questionId: string, text: string) => ev({ type: "answer.delta", answerId, questionId, delta: text, context: ctx("Helix", "unknown", "question") });
const completed = (answerId: string, questionId: string, text: string) => ev({ type: "answer.completed", answerId, questionId, text, context: ctx("Helix", "unknown", "question") });
const at = "2026-11-19T18:00:00.000Z";
const LONG = "Jetson Orin modules currently list twelve to sixteen week lead times at major distributors, developer kits ship sooner but are allocation limited, and the x86 fallback with a discrete GPU needs a 600 W supply. ";
const suggestion = (id: string, text: string, kind?: CopilotSuggestion["kind"], why = "It moves the talk forward."): CopilotSuggestion =>
  ({ id, question: text, why, createdAt: at, ...(kind ? { kind } : {}) }) as CopilotSuggestion;

async function mount(options: ConstructorParameters<typeof GlassesHud>[1] = {}, bridge = new PageBridge()) {
  const hud = new GlassesHud(bridge, { tickMs: 0, writeGapMs: 0, ...options });
  const presentation = new ConversationPresentation();
  presentation.subscribe(snapshot => hud.render(snapshot.glasses, snapshot));
  await hud.initialize();
  return { bridge, hud, presentation };
}
/** Connected, the ambient page up, the "● listening" line and the mode notice gone. */
async function listening(options: ConstructorParameters<typeof GlassesHud>[1] = {}, bridge = new PageBridge()) {
  const mounted = await mount(options, bridge);
  mounted.presentation.setStatus("listening");
  await vi.advanceTimersByTimeAsync(6000);
  return mounted;
}

const blank = (text: string) => text.trim() === "";
const rows = (text: string) => text.split("\n");
const shownLines = (text: string) => rows(text).map(line => line.trim()).filter(Boolean);
const lead = (line: string) => hudTextWidth(line.slice(0, line.length - line.trimStart().length));
/** Headings and prefixes that no longer belong on the hidden display. */
const LABELS = /\bQ:|\bWhy:|ASK THEM|THEY MAY ASK|THEY ASKED|YOUR REPLY|ANSWER KEY|◆ ANSWER|\bCONCEPTS?\b|\bLOOKUP\b|\bFACT CHECK\b|\bCHECK\b|\bTO-DO\b|tap to close/u;
/** Kind headings and field labels of verdicts and conflicts, in any case. */
const KIND_LABELS = /web check|news check|\bverify\b|conflict:|\bwas:|\bnow:|fact check/iu;

/** Every rule a pop-up must keep, whatever it shows. */
function expectPopUp(text: string, width: number = AMBIENT_LINE_WIDTH, lines: number = AMBIENT_LINES): void {
  expect(text.length).toBeLessThan(1000);
  expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(AMBIENT_MAX_BYTES);
  expect(rows(text).length).toBeLessThanOrEqual(lines);
  for (const line of rows(text)) expect(hudTextWidth(line), JSON.stringify(line)).toBeLessThanOrEqual(width);
  expect(text).not.toMatch(LABELS);
  expect(text).not.toMatch(KIND_LABELS);
}
/** Centred: left and right margins of every line differ by at most one space, top and bottom by at most one line. */
function expectCentred(text: string, room: number = AMBIENT_LINES, width: number = AMBIENT_LINE_WIDTH): void {
  const all = rows(text);
  const first = all.findIndex(line => line.trim()), last = all.length - 1 - [...all].reverse().findIndex(line => line.trim());
  expect(first).toBeGreaterThanOrEqual(0);
  for (const line of all.slice(first, last + 1)) {
    if (!line.trim()) continue;
    const left = lead(line), right = width - hudTextWidth(line);
    expect(Math.abs(left - right), JSON.stringify(line)).toBeLessThanOrEqual(SPACE + 0.01);
  }
  expect(Math.abs(first - (room - 1 - last))).toBeLessThanOrEqual(1);
}

afterEach(() => { vi.useRealTimers(); });

describe("v0.16 centreBlock", () => {
  it("centres a short text within one space and one line, and never passes the line width", () => {
    for (const text of ["Yes.", "Mode: Interviewer", "How does this differ from futurism?", "一二三四五", "Twelve to sixteen weeks at major distributors."]) {
      const lines = centreBlock(text, AMBIENT_LINE_WIDTH, AMBIENT_LINES);
      expect(lines).toHaveLength(Math.floor((AMBIENT_LINES - 1) / 2) + 1);
      expect(lines.slice(0, -1).every(line => line === "")).toBe(true);
      expectCentred(lines.join("\n"));
      expect(hudTextWidth(lines.at(-1)!)).toBeLessThanOrEqual(AMBIENT_LINE_WIDTH);
      expect(lines.at(-1)!.trim()).toBe(text);
    }
  });

  it("wraps a long text, centres each line, and cuts at the line count with an ellipsis", () => {
    const lines = centreBlock(LONG, AMBIENT_LINE_WIDTH, AMBIENT_LINES);
    expect(lines.filter(Boolean).length).toBeGreaterThan(1);
    expectCentred(lines.join("\n"));
    for (const line of lines) expect(hudTextWidth(line)).toBeLessThanOrEqual(AMBIENT_LINE_WIDTH);
    expect(lines.map(line => line.trim()).filter(Boolean).join(" ")).toBe(LONG.trim());
    const cut = centreBlock(LONG.repeat(8), AMBIENT_LINE_WIDTH, 4);
    expect(cut).toHaveLength(4);
    expect(cut.at(-1)!.endsWith("…")).toBe(true);
    for (const line of cut) expect(hudTextWidth(line)).toBeLessThanOrEqual(AMBIENT_LINE_WIDTH);
  });

  it("takes lines that are already wrapped, keeps a blank line inside the block, and uses any width and line count", () => {
    const lines = centreBlock(["Thinking…", "", "About the last few sentences."], HUD_LINE_WIDTH.body, BODY_LINES);
    expect(lines).toEqual(["", lines[1], "", lines[3]]);
    expect(lines[1]!.trim()).toBe("Thinking…");
    expectCentred(lines.join("\n"), BODY_LINES, HUD_LINE_WIDTH.body);
    expect(centreBlock("", 300, 5)).toEqual([]);
    expect(centreBlock(["", " "], 300, 5)).toEqual([]);
    expect(centreBlock("Yes.", 300, 0)).toEqual([]);
    // A line as wide as the container gets no padding.
    const full = "W".repeat(18);
    expect(centreBlock(full, hudTextWidth(full), 1)).toEqual([full]);
    expect(centreBlock(full, hudTextWidth(full) + 4, 1)).toEqual([full]);
  });
});

describe("v0.16 hidden-display page", () => {
  it("is one text container over the canvas that captures the gestures", async () => {
    vi.useFakeTimers();
    const { bridge, hud } = await listening();
    const page = bridge.current;
    expect(page.containerTotalNum).toBe(1);
    expect(page.textObject).toHaveLength(1);
    expect(page.imageObject ?? []).toHaveLength(0);
    expect(page.listObject ?? []).toHaveLength(0);
    expect(page.menuObject).toBeDefined();
    const panel = page.textObject![0]!;
    expect(panel).toMatchObject({ containerID: 2, containerName: "hud-ambient", isEventCapture: 1, borderWidth: 0,
      xPosition: HUD_AMBIENT_PANEL.xPosition, yPosition: HUD_AMBIENT_PANEL.yPosition, width: 560, height: 272 });
    expect(AMBIENT_LINES).toBe(10);
    expect(AMBIENT_LINES * HUD_LINE_HEIGHT).toBeLessThanOrEqual(HUD_AMBIENT_PANEL.height);
    expect(blank(bridge.shown)).toBe(true);
    hud.dispose();
  });

  it("writes only to container 2 while it is up, whatever pops up", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await listening();
    const rebuilds = bridge.rebuilds.length;
    presentation.apply(ev({ type: "transcript.final", transcriptId: "t1", text: "We should decide this week.", context: ctx("Other speaker", "other") }));
    presentation.apply(question("q1", "What are the options?"));
    presentation.apply(delta("a1", "q1", LONG));
    await vi.advanceTimersByTimeAsync(700);
    presentation.apply(completed("a1", "q1", LONG.repeat(5).trim()));
    await vi.advanceTimersByTimeAsync(60_000);
    presentation.applyConcept({ id: "c1", term: "NVMe", explanation: LONG.repeat(4), createdAt: at, origin: "copilot" });
    await vi.advanceTimersByTimeAsync(40_000);
    presentation.setSuggestions([suggestion("s1", "What lead time are you seeing for the Jetson boards?")]);
    await vi.advanceTimersByTimeAsync(15_000);
    presentation.notice("n1", "Busy", "Helix is busy, try again.");
    presentation.setInteraction("HOLDING / RELEASE TO SUBMIT");
    await vi.advanceTimersByTimeAsync(8000);
    expect(bridge.updates.length).toBeGreaterThan(8);
    expect(bridge.stray).toEqual([]);
    for (const write of bridge.updates) {
      expect(write.containerID).toBe(2);
      expect(write.containerName).toBe("hud-ambient");
      expect([1, 3, 5, 6, 7]).not.toContain(write.containerID);
    }
    expect(bridge.rebuilds).toHaveLength(rebuilds); // a pop-up never swaps the page
    expect(bridge.longest).toBeLessThan(1000);
    hud.dispose();
  });

  it("swaps hidden -> awake -> hidden with the right containers each time, and writes only to the page that is up", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await listening();
    const ids = () => (bridge.current.textObject ?? []).map(text => text.containerID);
    expect(ids()).toEqual([2]);
    const before = bridge.rebuilds.length;
    // Wake: the menu page, then the full HUD page after "Close".
    hud.handleGesture("double");
    await vi.advanceTimersByTimeAsync(600);
    expect(ids()).toEqual([9, 2, 1, 5, 3, 6]);
    expect(bridge.current.listObject).toHaveLength(1);
    expect(bridge.rebuilds.length - before).toBe(1);
    const close = hud.menuItems.findIndex(item => item.action === "close");
    hud.selectListItem(close, "Close");
    await vi.advanceTimersByTimeAsync(600);
    expect(ids()).toEqual([9, 2, 1, 5, 3, 6, 7]);
    expect(bridge.current.textObject!.find(text => text.containerID === 2)).toMatchObject({ containerName: "hud-body", width: 420, isEventCapture: 1 });
    expect(bridge.rebuilds.length - before).toBe(2);
    presentation.apply(ev({ type: "transcript.final", transcriptId: "t1", text: "We should decide this week.", context: ctx("Other speaker", "other") }));
    presentation.applyConcept({ id: "c1", term: "NVMe", explanation: "PCIe storage protocol for SSDs.", createdAt: at, origin: "copilot" });
    await vi.advanceTimersByTimeAsync(3000);
    expect(bridge.pageWrites.map(write => write.containerName)).toContain("hud-caption");
    // Hide again: double-tap opens the menu, double-tap on it hides the whole HUD.
    hud.handleGesture("double");
    hud.handleGesture("double");
    expect(hud.ambient).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(ids()).toEqual([2]);
    expect(bridge.current.textObject![0]).toMatchObject({ containerName: "hud-ambient", width: 560, isEventCapture: 1 });
    expect(blank(bridge.shown)).toBe(true);
    // The hidden page takes pop-ups again, and still nothing went to a missing container.
    presentation.applyVerification({ id: "v1", target: "Orin lead time is 12 weeks", status: "supported", summary: "Distributors list 12 to 16 weeks.", sources: [], checkedAt: at, requestedBy: "auto" });
    await vi.advanceTimersByTimeAsync(400);
    expect(bridge.shown).toContain("True: Orin lead time is 12 weeks");
    expect(bridge.pageWrites.every(write => write.containerID === 2 && write.containerName === "hud-ambient")).toBe(true);
    expect(bridge.stray).toEqual([]);
    const settled = bridge.rebuilds.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bridge.rebuilds).toHaveLength(settled); // no page swap without a gesture
    hud.dispose();
  });

  it("keeps the text menu usable in the one container when the glasses reject the wake page, then recovers", async () => {
    vi.useFakeTimers();
    const { bridge, hud } = await listening();
    bridge.rebuildOk = false;
    hud.handleGesture("double");
    await vi.advanceTimersByTimeAsync(2500);
    expect(hud.menuOpen && !hud.menuNative).toBe(true);
    expect(bridge.shown).toContain("▶ Answer");
    expect(bridge.stray).toEqual([]);
    bridge.rebuildOk = true;
    await vi.advanceTimersByTimeAsync(1500);
    expect(bridge.current.textObject!.map(text => text.containerName)).toContain("hud-frame");
    await vi.advanceTimersByTimeAsync(1500);
    expect(bridge.stray).toEqual([]);
    hud.dispose();
  });

  it("does not write to the HUD panels of an older page after an unanswered write and a re-push", async () => {
    vi.useFakeTimers();
    const bridge = new PageBridge();
    const { hud, presentation } = await listening({}, bridge);
    presentation.applyConcept({ id: "c1", term: "NVMe", explanation: "PCIe storage protocol for SSDs.", createdAt: at, origin: "copilot" });
    await vi.advanceTimersByTimeAsync(400);
    expect(await hud.repush()).toBe(true);
    expect(bridge.current.textObject!.map(text => text.containerID)).toEqual([2]);
    expect(bridge.current.textObject![0]!.content).toContain("NVMe — PCIe storage protocol for SSDs.");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(bridge.stray).toEqual([]);
    hud.dispose();
  });
});

describe("v0.16 pop-up content", () => {
  it("shows every kind of pop-up without a heading, centred, inside the container", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening();
    const seen: string[] = [];
    const check = (expected: RegExp | string) => {
      const body = hud.frame.body;
      expectPopUp(body);
      expectCentred(body);
      if (typeof expected === "string") expect(shownLines(body).join(" ")).toContain(expected); else expect(shownLines(body).join(" ")).toMatch(expected);
      // The six HUD panels do not exist on this page: nothing is composed for them.
      expect([hud.frame.title, hud.frame.status, hud.frame.caption, hud.frame.mode, hud.frame.views].every(blank)).toBe(true);
      seen.push(body);
    };
    // An answer to their question: the answer alone.
    presentation.apply(question("q1", "How long is the Orin lead time?"));
    presentation.apply(completed("a1", "q1", "Twelve to sixteen weeks at major distributors."));
    check("Twelve to sixteen weeks at major distributors.");
    expect(shownLines(hud.frame.body)).toEqual(["Twelve to sixteen weeks at major distributors."]);
    await vi.advanceTimersByTimeAsync(8200);
    expect(blank(hud.frame.body)).toBe(true);
    // A concept: "Term — explanation".
    presentation.applyConcept({ id: "c1", term: "NVMe", explanation: "PCIe storage protocol for SSDs.", createdAt: at, origin: "copilot" });
    check("NVMe — PCIe storage protocol for SSDs.");
    await vi.advanceTimersByTimeAsync(6000);
    // Verdicts: one verdict word and the claim, no kind heading.
    presentation.applyVerification({ id: "v1", target: "Orin lead time is 12 weeks", status: "supported", summary: "Distributors list 12 to 16 weeks.", sources: [], checkedAt: at, requestedBy: "auto" });
    check("True: Orin lead time is 12 weeks Distributors list 12 to 16 weeks.");
    await vi.advanceTimersByTimeAsync(6000);
    presentation.applyFactCheck({ id: "f1", claim: "The cap is $25,000", status: "uncertain", summary: "No source found.", sources: [], checkedAt: at } as never);
    check("Unsure: The cap is $25,000 No source found.");
    await vi.advanceTimersByTimeAsync(6000);
    // A contradicted fact check arrives as an answer and stays "Correction: …".
    presentation.applyFactCheck({ id: "f2", claim: "The cap is $25,000", status: "contradicted", summary: "Finance approved $40,000.", sources: [{ url: "https://example.com/budget", title: "Budget memo" }], checkedAt: at } as never, true);
    check("Correction: Finance approved $40,000.");
    expect(shownLines(hud.frame.body)).toEqual(["Correction: Finance approved $40,000."]);
    await vi.advanceTimersByTimeAsync(20_000);
    // A finished lookup, a conflict, a to-do.
    presentation.applyAsk({ id: "k1", kind: "lookup", topic: "Jetson lead time?", trigger: "lead time", status: "done", answer: "12 to 16 weeks.", createdAt: at });
    check("Jetson lead time? 12 to 16 weeks.");
    await vi.advanceTimersByTimeAsync(6000);
    presentation.applyConflict({ id: "x1", earlier: "Budget is $25,000", later: "Budget is $40,000", explanation: "The budget changed.", createdAt: at } as never);
    check("The budget changed. Was “Budget is $25,000”, now “Budget is $40,000”.");
    await vi.advanceTimersByTimeAsync(6000);
    // A suggestion of any kind: the bare sentence.
    presentation.setSuggestions([suggestion("s1", "What lead time are you seeing for the Jetson boards?")]);
    check("What lead time are you seeing for the Jetson boards?");
    expect(shownLines(hud.frame.body)).toEqual(["What lead time are you seeing for the Jetson boards?"]);
    // A requested answer.
    presentation.beginRequest();
    check("Thinking…");
    presentation.apply(ev({ type: "question.detected", questionId: "q2", text: "help", confidence: 1, context: { ...ctx("Local context"), trigger: "manual" } }));
    check("Thinking… About the last few sentences.");
    presentation.apply(completed("a2", "q2", "Ask for the quote by Thursday."));
    check("Ask for the quote by Thursday.");
    await vi.advanceTimersByTimeAsync(9000);
    expect(seen).toHaveLength(11);
    hud.dispose();
  });

  it("shows a suggestion as the bare sentence, and marks one the other side may ask inside the sentence", async () => {
    for (const kind of [undefined, "ask-them", "they-ask", "say"] as const) {
      vi.useFakeTimers();
      const { hud, presentation } = await listening();
      presentation.setMode("interviewee");
      const line = "How does this differ from futurism: is planning for the future also a way of leaving the present?";
      presentation.setSuggestions([suggestion("s1", line, kind, "They may ask: it tests depth.")]);
      expectPopUp(hud.frame.body);
      expectCentred(hud.frame.body);
      expect(shownLines(hud.frame.body).join(" ")).toBe(kind === "they-ask" ? `They may ask: ${line}` : line);
      hud.dispose();
      vi.useRealTimers();
    }
  });

  it("puts the page marker and hint on the last line, centred, and only when a pop-up has more pages", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening();
    presentation.applyConcept({ id: "c1", term: "NVMe", explanation: "PCIe storage protocol for SSDs.", createdAt: at, origin: "copilot" });
    expect(rows(hud.frame.body).length).toBeLessThan(AMBIENT_LINES); // one page: no marker line
    expect(hud.frame.body).not.toMatch(/\d\/\d/u);
    await vi.advanceTimersByTimeAsync(6000);
    presentation.applyConcept({ id: "c2", term: "Jetson", explanation: LONG.repeat(12), createdAt: at, origin: "copilot" });
    let all = rows(hud.frame.body);
    expect(all).toHaveLength(AMBIENT_LINES);
    expect(all.at(-1)!.trim()).toBe("1/3 · swipe ↓ more");
    expectCentred(all.at(-1)!, 1);
    expectPopUp(hud.frame.body);
    expect(all.slice(0, -1).filter(line => line.trim())).toHaveLength(AMBIENT_LINES - 1); // a full page uses the nine lines above it
    hud.handleGesture("down");
    hud.handleGesture("down");
    all = rows(hud.frame.body);
    expect(all.at(-1)!.trim()).toBe("3/3");
    expect(all.slice(0, -1).join(" ")).toContain("…"); // the last allowed page says that text is left over
    expectPopUp(hud.frame.body);
    expect(hud.handleGesture("click")).toEqual({ type: "handled" });
    expect(blank(hud.frame.body)).toBe(true);
    hud.dispose();
  });

  it("shows a problem and gesture feedback on the last line, with the content still centred above it", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening();
    presentation.apply(question("q1", "How long is the Orin lead time?"));
    presentation.apply(completed("a1", "q1", "Twelve to sixteen weeks at major distributors."));
    const state = presentation.snapshot();
    hud.render({ ...state.glasses, notice: { id: 7, text: "Helix is busy" } }, state);
    const all = rows(hud.frame.body);
    expect(all).toHaveLength(AMBIENT_LINES);
    expect(all.at(-1)!.trim()).toBe("! Helix is busy");
    expectCentred(all.at(-1)!, 1);
    expectCentred(all.slice(0, -1).join("\n"), AMBIENT_LINES - 1);
    expect(shownLines(hud.frame.body)[0]).toBe("Twelve to sixteen weeks at major distributors.");
    // With nothing popping up the problem still shows, alone on the last line.
    await vi.advanceTimersByTimeAsync(5000);
    hud.dispose();
    const next = await listening();
    next.presentation.setInteraction("HOLDING / RELEASE TO SUBMIT");
    expect(shownLines(next.hud.frame.body)).toEqual(["● HOLD · release to send"]);
    expect(rows(next.hud.frame.body)).toHaveLength(AMBIENT_LINES);
    expectPopUp(next.hud.frame.body);
    next.hud.dispose();
  });

  it("keeps a streaming answer top-left and centres the page once it is complete", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await listening();
    presentation.apply(question("q1", "How long is the Orin lead time?"));
    const parts = ["Twelve to sixteen weeks ", "at major distributors, ", "and developer kits ship sooner."];
    let text = "";
    for (const part of parts) {
      text += part;
      presentation.apply(delta("a1", "q1", part));
      const all = rows(hud.frame.body);
      expect(all.join(" ")).toBe(text.trim()); // from the first line of the container, no leading spaces
      expect(all.every(line => lead(line) === 0)).toBe(true);
      expect(all.length).toBeLessThanOrEqual(2);
      await vi.advanceTimersByTimeAsync(400);
      expect(bridge.shown).toBe(hud.frame.body);
    }
    const streamingWrites = bridge.updates.length;
    presentation.apply(completed("a1", "q1", text));
    const all = rows(hud.frame.body);
    expect(all[0]).toBe("");
    expectCentred(hud.frame.body);
    expect(shownLines(hud.frame.body).join(" ")).toBe(text.trim());
    expect(rows(hud.frame.body).filter(line => line.trim()).every(line => lead(line) > 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(bridge.updates.length - streamingWrites).toBe(1); // centred with one write
    expect(bridge.shown).toBe(hud.frame.body);
    hud.dispose();
  });

  it("centres a streaming answer's earlier pages, which are complete, and leaves the page still filling top-left", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening();
    presentation.apply(question("q1", "What are the options?"));
    presentation.apply(delta("a1", "q1", LONG.repeat(5)));
    let all = rows(hud.frame.body);
    expect(all.at(-1)!.trim()).toBe("1/… · swipe ↓ more");
    expect(all.slice(0, -1).every(line => line.trim())).toBe(true);
    expectCentred(all.slice(0, -1).join("\n"), AMBIENT_LINES - 1);
    expectPopUp(hud.frame.body);
    hud.handleGesture("down");
    all = rows(hud.frame.body);
    expect(lead(all[0]!)).toBe(0); // the last page is still filling
    expect(all[0]!.trim()).not.toBe("");
    expect(all.at(-1)!.trim()).toBe("2/…");
    expectPopUp(hud.frame.body);
    hud.dispose();
  });

  it("never hands the glasses 1000 characters, even for text made of the narrowest or widest glyphs", async () => {
    for (const filler of ["il! ".repeat(900), "一二三四五六七八九十".repeat(200), "👨‍👩‍👧‍👦".repeat(300), `${"i".repeat(70)}\n`.repeat(40)]) {
      vi.useFakeTimers();
      const { bridge, hud, presentation } = await listening();
      presentation.apply(question("q1", "What are the options?"));
      presentation.apply(completed("a1", "q1", filler));
      for (let i = 0; i < 40 && !blank(hud.frame.body); i++) {
        const body = hud.frame.body;
        expect(body.length).toBeLessThan(1000);
        expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(AMBIENT_MAX_BYTES);
        expect(rows(body).length).toBeLessThanOrEqual(AMBIENT_LINES);
        await vi.advanceTimersByTimeAsync(400);
        hud.handleGesture("down");
      }
      presentation.applyConcept({ id: "c1", term: "i".repeat(300), explanation: filler, createdAt: at, origin: "copilot" });
      for (let i = 0; i < 6; i++) {
        expect(hud.frame.body.length).toBeLessThan(1000);
        expect(rows(hud.frame.body).length).toBeLessThanOrEqual(AMBIENT_LINES);
        await vi.advanceTimersByTimeAsync(400);
        hud.handleGesture("down");
      }
      await hud.repush();
      await vi.advanceTimersByTimeAsync(1000);
      expect(bridge.longest).toBeLessThan(1000);
      expect(bridge.stray).toEqual([]);
      hud.dispose();
      vi.useRealTimers();
    }
  });

  it("pages an answer for the nine content lines and loses no text across its pages", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening();
    const answer = LONG.repeat(6).trim();
    presentation.apply(question("q1", "What are the options?"));
    presentation.apply(completed("a1", "q1", answer));
    const pages: string[] = [];
    for (let i = 0; i < 12; i++) {
      const all = rows(hud.frame.body);
      expect(all).toHaveLength(AMBIENT_LINES);
      expect(all.at(-1)!.trim()).toMatch(new RegExp(`^${i + 1}/\\d+`, "u"));
      expectPopUp(hud.frame.body);
      pages.push(all.slice(0, -1).map(line => line.trim()).filter(Boolean).join(" "));
      if (!/swipe/u.test(all.at(-1)!)) break;
      hud.handleGesture("down");
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.length).toBeLessThan(paginateAnswer(answer, { lineWidth: HUD_LINE_WIDTH.body, lines: BODY_LINES, measure: hudGlyphWidth }).length); // fewer pages than the small box needed
    expect(pages.join(" ")).toBe(answer);
    hud.dispose();
  });

  it("pages the answer again for the awake HUD when the wearer wakes it mid-answer, keeping the place", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening({ display: "ambient" });
    const answer = LONG.repeat(6).trim();
    presentation.apply(question("q1", "What are the options?"));
    presentation.apply(completed("a1", "q1", answer));
    hud.handleGesture("down"); // reading page 2 of the hidden display
    const reading = shownLines(hud.frame.body)[0]!;
    hud.handleGesture("double"); // wake: the menu opens, the ANSWER view is behind it
    expect(hud.ambient).toBe(false);
    const body = rows(hud.frame.body);
    expect(body.length).toBeLessThanOrEqual(BODY_LINES);
    for (const line of body) expect(hudTextWidth(line)).toBeLessThanOrEqual(HUD_LINE_WIDTH.body);
    expect(hud.frame.body).not.toMatch(/…$/u); // paged for the box, not cut to it
    expect(hud.frame.title).toBe("MENU");
    // The awake page shown holds the text that was being read.
    const close = hud.menuItems.findIndex(item => item.action === "close");
    hud.selectListItem(close, "Close");
    expect(hud.frame.title).toMatch(/THEY ASKED \d+\/\d+/u);
    const index = Number(/(\d+)\//u.exec(hud.frame.title)![1]);
    expect(index).toBeGreaterThan(1);
    const awake = paginateAnswer(answer, { lineWidth: HUD_LINE_WIDTH.body, lines: BODY_LINES - 1, bytes: 1500, measure: hudGlyphWidth });
    expect(awake[index - 1]!.includes(reading.slice(0, 24)) || awake[index - 2]!.includes(reading.slice(0, 24))).toBe(true);
    hud.dispose();
  });

  it("shows the pop-up in the BODY box, centred for that box, on a host that cannot swap pages", async () => {
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
    presentation.applyConcept({ id: "c1", term: "NVMe", explanation: LONG.repeat(3), createdAt: at, origin: "copilot" });
    await vi.advanceTimersByTimeAsync(400);
    const body = updates.filter(update => update.containerName === "hud-body").at(-1)!.content!;
    expect(body).toBe(hud.frame.body);
    expectPopUp(body, HUD_LINE_WIDTH.body, BODY_LINES);
    expect(rows(body).at(-1)!.trim()).toMatch(/^1\/\d · swipe ↓ more$/u);
    expect(updates.every(update => update.containerName !== "hud-ambient")).toBe(true);
    hud.dispose();
  });
});

describe("v0.16 lines to say", () => {
  const SAY = "That sounds close to futurism: is planning ahead also a way of leaving the present?";

  it("a tap on a line to say on the hidden display marks it said and asks Helix nothing", async () => {
    vi.useFakeTimers();
    const said: object[] = [];
    const { hud, presentation } = await listening({ onSaid: line => said.push(line) });
    presentation.setSuggestions([suggestion("s1", SAY, "say")]);
    expect(shownLines(hud.frame.body).join(" ")).toBe(SAY);
    const command = hud.handleGesture("click");
    expect(said).toEqual([{ id: "s1", text: SAY }]); // the host is told, so the phone can mark it too
    expect(command).toEqual({ type: "handled" });
    expect(command?.type).not.toBe("ask");
    expect(blank(hud.frame.body)).toBe(true);
    expect(hud.mirror.lastGesture).toBe("said");
    // It does not come back, on the hidden display or in the woken list.
    presentation.setSuggestions([suggestion("s1", SAY, "say"), suggestion("s2", "What would you measure first?", "say")]);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(shownLines(hud.frame.body).join(" ")).toBe("What would you measure first?");
    hud.handleGesture("double");
    const ask = hud.menuItems.findIndex(item => item.action === "ask-them");
    hud.selectListItem(ask, hud.menuItems[ask]!.label);
    expect(hud.frame.body).not.toContain("futurism");
    expect(hud.frame.body).toContain("What would you measure first?");
    hud.dispose();
  });

  it("in the awake view a line to say has no Q: prefix, the status is 'say it', and selecting it does not ask", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening({ display: "always-on" });
    presentation.setSuggestions([suggestion("s1", SAY, "say"), suggestion("s2", "What lead time are you seeing?")]);
    hud.setView("qa");
    expect(hud.frame.body).not.toMatch(/Q:/u);
    expect(hud.frame.body).toContain("▶ ① That sounds close to futurism");
    expect(hud.frame.status.trim()).toMatch(/· say it$/u);
    expect(hud.frame.status).not.toContain("tap: answer");
    expect(hud.handleGesture("click")).toEqual({ type: "handled" });
    // Said: it leaves the list. The next one is a question to ask, and a tap on that still asks.
    expect(hud.frame.body).not.toContain("futurism");
    expect(hud.frame.status).toContain("say it · tap: answer");
    expect(hud.handleGesture("click")).toEqual({ type: "ask", text: "What lead time are you seeing?" });
    hud.dispose();
  });

  it("a tap on a question suggestion on the hidden display closes it without asking, as before", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening();
    presentation.setSuggestions([suggestion("s1", "What lead time are you seeing?")]);
    expect(hud.handleGesture("click")).toEqual({ type: "handled" });
    expect(blank(hud.frame.body)).toBe(true);
    hud.dispose();
  });
});

describe("v0.16 mode notice at session start", () => {
  it("names the active mode for about four seconds, centred, then the display is blank", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await mount();
    presentation.setMode("interviewer");
    presentation.setStatus("connecting");
    presentation.setStatus("listening");
    expect(hud.ambient).toBe(true);
    const all = rows(hud.frame.body);
    expect(shownLines(hud.frame.body)).toEqual(["Mode: Interviewer", "● listening"]);
    expect(all).toHaveLength(AMBIENT_LINES);
    expectCentred(all.slice(0, -1).join("\n"), AMBIENT_LINES - 1);
    expectCentred(all.at(-1)!, 1);
    expectPopUp(hud.frame.body);
    await vi.advanceTimersByTimeAsync(1000);
    expect(bridge.current.textObject!.map(text => text.containerName)).toEqual(["hud-ambient"]);
    expect(bridge.shown).toContain("Mode: Interviewer");
    await vi.advanceTimersByTimeAsync(MODE_NOTICE_MS - 1500);
    expect(hud.frame.body).toContain("Mode: Interviewer");
    await vi.advanceTimersByTimeAsync(1000);
    expect(blank(hud.frame.body)).toBe(true);
    await vi.advanceTimersByTimeAsync(400);
    expect(blank(bridge.shown)).toBe(true);
    // Pause and resume are not a session start.
    presentation.setStatus("paused");
    presentation.setStatus("listening");
    expect(hud.frame.body).not.toContain("Mode:");
    expect(shownLines(hud.frame.body)).toEqual(["● listening"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(bridge.stray).toEqual([]);
    hud.dispose();
  });

  it("shows on every new session, gives way to an answer, and a tap closes it and asks", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await mount();
    presentation.setStatus("listening");
    expect(shownLines(hud.frame.body)[0]).toBe("Mode: Meeting");
    expect(hud.handleGesture("click")).toEqual({ type: "askLocal" }); // the tap is never dropped (v0.16 fix)
    expect(hud.frame.body).not.toContain("Mode:");
    expect(hud.handleGesture("click")).toEqual({ type: "askLocal" });
    presentation.setStatus("stopped");
    presentation.setMode("interviewee");
    presentation.setStatus("connecting");
    presentation.setStatus("connected");
    expect(shownLines(hud.frame.body)).toEqual(["Mode: Candidate", "○ mic off"]);
    presentation.apply(question("q1", "How long is the Orin lead time?"));
    presentation.apply(completed("a1", "q1", "Twelve to sixteen weeks."));
    expect(shownLines(hud.frame.body)[0]).toBe("Twelve to sixteen weeks.");
    expect(hud.frame.body).not.toContain("Mode:");
    hud.dispose();
  });

  it("is not shown with the always-on display, which has the mode on screen already", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await mount({ display: "always-on" });
    presentation.setMode("interviewer");
    presentation.setStatus("listening");
    expect(hud.frame.body).not.toContain("Mode:");
    expect(hud.frame.mode.trim()).toBe("INTERVIEWER");
    hud.dispose();
  });
});

describe("v0.16 phone mirror of the hidden display", () => {
  it("draws the one container: ten lines at a 27 px pitch, each line where its centring puts it", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening();
    expect(glassesMirrorModel(hud.mirror).lines).toHaveLength(0);
    presentation.applyConcept({ id: "c1", term: "Jetson", explanation: LONG.repeat(6), createdAt: at, origin: "copilot" });
    const mirror = hud.mirror;
    expect(mirror).toMatchObject({ ambient: true, menuOpen: false, content: hud.frame.body });
    const model = glassesMirrorModel(mirror);
    expect(model.images).toHaveLength(0);
    expect(model.lines).toHaveLength(AMBIENT_LINES);
    const source = rows(hud.frame.body);
    model.lines.forEach((line, row) => {
      expect(line.y).toBe(HUD_AMBIENT_PANEL.yPosition + 21 + row * HUD_LINE_HEIGHT);
      expect(line.text).toBe(source[row]!.trim());
      expect(line.x).toBeCloseTo(HUD_AMBIENT_PANEL.xPosition + lead(source[row]!), 5);
      expect(line.x + line.width).toBeLessThanOrEqual(HUD_AMBIENT_PANEL.xPosition + AMBIENT_LINE_WIDTH + 0.01);
      expect(line.level).toBe(4);
      // Centred on the canvas within one space.
      expect(Math.abs((line.x + line.width / 2) - (HUD_AMBIENT_PANEL.xPosition + AMBIENT_LINE_WIDTH / 2))).toBeLessThanOrEqual(SPACE);
    });
    expect(model.lines.at(-1)!.text).toBe("1/3 · swipe ↓ more");
    expect(model.label).toContain("Jetson —");
    expect(model.label).not.toMatch(LABELS);
    hud.dispose();
  });

  it("a short pop-up sits in the middle of the canvas", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening();
    presentation.setSuggestions([suggestion("s1", "What would you measure first?", "say")]);
    const lines = glassesMirrorModel(hud.mirror).lines;
    expect(lines).toHaveLength(1);
    const middle = lines[0]!.y - 21 + HUD_LINE_HEIGHT / 2;
    expect(Math.abs(middle - 144)).toBeLessThanOrEqual(HUD_LINE_HEIGHT);
    expect(Math.abs(lines[0]!.x + lines[0]!.width / 2 - (HUD_AMBIENT_PANEL.xPosition + AMBIENT_LINE_WIDTH / 2))).toBeLessThanOrEqual(SPACE);
    hud.dispose();
  });
});

describe("v0.16 answers-only layout", () => {
  class OneBridge implements GlassesRenderBridge {
    public content = "";
    public writes = 0;
    public async createStartUpPageContainer(container: CreateStartUpPageContainer) { this.content = container.textObject?.[0]?.content ?? ""; return StartUpPageCreateResult.success; }
    public async textContainerUpgrade(container: TextContainerUpgrade) { this.content = container.content ?? ""; this.writes += 1; return true; }
  }

  it("centrePage centres a page, keeps its words, and leaves a page it cannot centre alone", () => {
    const page = centrePage("Twelve to sixteen weeks.");
    const all = page.split("\n");
    expect(all).toHaveLength(Math.floor((FULL_CANVAS_PAGE.lines - 1) / 2) + 1);
    expect(all.slice(0, -1).every(line => line === "")).toBe(true);
    expect(all.at(-1)!.trim()).toBe("Twelve to sixteen weeks.");
    expect(all.at(-1)!.startsWith("   ")).toBe(true);
    // With the measured font the padding is exact to one space.
    const layout = { lineWidth: AMBIENT_LINE_WIDTH, lines: AMBIENT_LINES, measure: hudGlyphWidth };
    expectCentred(centrePage("Twelve to sixteen weeks.", layout));
    const long = paginateAnswer(LONG.repeat(3), layout)[0]!;
    const centred = centrePage(long, layout);
    expect(centred.split("\n").map(line => line.trim()).filter(Boolean).join(" ")).toBe(long.trim());
    for (const line of centred.split("\n")) expect(hudTextWidth(line)).toBeLessThanOrEqual(AMBIENT_LINE_WIDTH);
    // Too many lines for the layout, or over its byte ceiling with the padding: unchanged.
    expect(centrePage("a\nb\nc", { ...layout, lines: 2 })).toBe("a\nb\nc");
    expect(centrePage("i", { ...layout, bytes: 20 })).toBe("i");
    expect(centrePage("")).toBe("");
    // The built-in measure reads the font narrow; its padding still never pushes a line past the width
    // (a line that is already too wide gets no padding at all).
    for (const text of ["MMMMMMMMMMMMMMMMMMMMMMMM", "mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm", "Wide words: MMMM WWWW @@@@ %%%% and more of them here", "abdghnopqu ".repeat(4)]) {
      for (const line of centrePage(text).split("\n")) expect(hudTextWidth(line)).toBeLessThanOrEqual(Math.max(FULL_CANVAS_PAGE.lineWidth, hudTextWidth(line.trim())));
    }
  });

  it("the pager's pages still join to the exact answer; centring is only what is drawn", () => {
    const pager = new AnswerPager(() => undefined);
    pager.update({ id: "a1", text: LONG.repeat(8), streaming: false });
    const pages: string[] = [];
    do pages.push(pager.text); while (pager.next());
    expect(pages.join("")).toBe(LONG.repeat(8));
    pager.dispose();
  });

  it("keeps a streaming answer top-left and centres it when it completes; a cue is centred", async () => {
    vi.useFakeTimers();
    const bridge = new OneBridge();
    const renderer = new GlassesRenderer(bridge);
    await renderer.initialize();
    renderer.render({ status: "listening", answer: { id: "a1", text: "Twelve to sixteen", streaming: true } });
    await renderer.flush();
    expect(bridge.content).toBe("Twelve to sixteen");
    renderer.render({ status: "listening", answer: { id: "a1", text: "Twelve to sixteen weeks.", streaming: true } });
    await renderer.flush();
    expect(bridge.content).toBe("Twelve to sixteen weeks.");
    renderer.render({ status: "listening", answer: { id: "a1", text: "Twelve to sixteen weeks.", streaming: false } });
    await renderer.flush();
    const all = bridge.content.split("\n");
    expect(all.slice(0, -1).every(line => line === "")).toBe(true);
    expect(all).toHaveLength(5);
    expect(all.at(-1)!.trim()).toBe("Twelve to sixteen weeks.");
    expect(all.at(-1)!.length).toBeGreaterThan("Twelve to sixteen weeks.".length + 20);
    expect(bridge.content.length).toBeLessThan(1000);
    // The centred page is written once: the same state again writes nothing.
    const writes = bridge.writes;
    renderer.render({ status: "listening", answer: { id: "a1", text: "Twelve to sixteen weeks.", streaming: false } });
    await renderer.flush();
    expect(bridge.writes).toBe(writes);
    await vi.advanceTimersByTimeAsync(9000);
    await renderer.flush();
    expect(bridge.content.trim()).toBe("");
    renderer.render({ status: "listening", cue: { id: "cue1", text: "Budget changed to $40,000." } });
    await renderer.flush();
    expect(bridge.content.trim()).toBe("Budget changed to $40,000.");
    expect(bridge.content.startsWith("\n\n\n\n ")).toBe(true);
    renderer.dispose();
  });

  it("long pages of a multi-page answer stay under 1000 characters when centred", async () => {
    vi.useFakeTimers();
    const bridge = new OneBridge();
    const renderer = new GlassesRenderer(bridge);
    await renderer.initialize();
    for (const text of [LONG.repeat(10), "il! ".repeat(900), "一二三四五六七八九十".repeat(200)]) {
      renderer.render({ status: "listening", answer: { id: text.slice(0, 8), text, streaming: false } });
      for (let i = 0; i < 30; i++) {
        await renderer.flush();
        expect(new TextEncoder().encode(bridge.content).length).toBeLessThan(1000);
        await vi.advanceTimersByTimeAsync(10_000);
      }
    }
    renderer.dispose();
  });
});
