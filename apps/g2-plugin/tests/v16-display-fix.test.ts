/**
 * v0.16 display fix pass: findings of the independent review of the hidden-display pop-ups.
 * Unit level only. What the real glasses do with a rejected page is a device check.
 */
import {
  ImageRawDataUpdateResult, StartUpPageCreateResult,
  type CreateStartUpPageContainer, type ImageRawDataUpdate, type RebuildPageContainer, type TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import type { CopilotSuggestion, GatewayEvent } from "@helix/conversation-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnswerPager, pageReadingMs, type PageLayout } from "../src/answer-pager";
import {
  AMBIENT_LINES, AMBIENT_LINE_WIDTH, AMBIENT_MAX_BYTES, BODY_LINES, GlassesHud, HUD_LINE_WIDTH, MODE_NOTICE_MS, hudGlyphWidth, hudTextWidth,
} from "../src/glasses-hud";
import type { GlassesRenderBridge } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";

class PageBridge implements GlassesRenderBridge {
  public readonly rebuilds: RebuildPageContainer[] = [];
  public readonly updates: TextContainerUpgrade[] = [];
  public readonly stray: string[] = [];
  public rebuildOk = true;
  private page?: Partial<RebuildPageContainer>;
  private since = 0;
  public async createStartUpPageContainer(container: CreateStartUpPageContainer) { this.take(container); return StartUpPageCreateResult.success; }
  public async rebuildPageContainer(container: RebuildPageContainer) {
    this.rebuilds.push(container);
    if (this.rebuildOk) this.take(container);
    return this.rebuildOk;
  }
  public async textContainerUpgrade(container: TextContainerUpgrade) {
    this.updates.push(container);
    const known = (this.page?.textObject ?? []).some(text => text.containerID === container.containerID && text.containerName === container.containerName);
    if (!known) this.stray.push(`${container.containerID}:${container.containerName}`);
    return true;
  }
  public async updateImageRawData(_image: ImageRawDataUpdate) { return ImageRawDataUpdateResult.success; }
  private take(page: Partial<RebuildPageContainer>) { this.page = page; this.since = this.updates.length; }
  public get current(): Partial<RebuildPageContainer> { return this.page!; }
  /** Text a container of the current page shows now: the last write to it, else what the page was built with. */
  public text(name: string): string {
    return this.updates.slice(this.since).filter(update => update.containerName === name).at(-1)?.content
      ?? this.page?.textObject?.find(text => text.containerName === name)?.content ?? "";
  }
  public get names(): string[] { return (this.page?.textObject ?? []).map(text => text.containerName!); }
}

type Role = "self" | "other" | "unknown";
const ctx = (label: string, role: Role = "unknown", trigger?: string) => ({
  prompt: { id: "p", version: "1" }, endpoint: { id: "openai-direct", url: "", provider: "openai", model: "m" },
  speaker: { label, role }, latencyMs: { totalMs: 900 }, ...(trigger ? { trigger } : {}),
});
let seq = 0;
const ev = (event: object) => ({ protocolVersion: "2.1", sessionId: "s", occurredAt: "2026-11-19T18:00:00.000Z", eventId: `v16f-${++seq}`, ...event }) as unknown as GatewayEvent;
const question = (id: string, text: string) => ev({ type: "question.detected", questionId: id, text, confidence: 0.9, context: ctx("Other speaker", "other", "question") });
const completed = (answerId: string, questionId: string, text: string) => ev({ type: "answer.completed", answerId, questionId, text, context: ctx("Helix", "unknown", "question") });
const at = "2026-11-19T18:00:00.000Z";
const LONG = "Jetson Orin modules currently list twelve to sixteen week lead times at major distributors, developer kits ship sooner but are allocation limited, and the x86 fallback with a discrete GPU needs a 600 W supply. ";
const suggestion = (id: string, text: string, kind?: CopilotSuggestion["kind"]): CopilotSuggestion =>
  ({ id, question: text, why: "It moves the talk forward.", createdAt: at, ...(kind ? { kind } : {}) }) as CopilotSuggestion;

async function mount(options: ConstructorParameters<typeof GlassesHud>[1] = {}, bridge = new PageBridge()) {
  const hud = new GlassesHud(bridge, { tickMs: 0, writeGapMs: 0, ...options });
  const presentation = new ConversationPresentation();
  presentation.subscribe(snapshot => hud.render(snapshot.glasses, snapshot));
  await hud.initialize();
  return { bridge, hud, presentation };
}
async function listening(options: ConstructorParameters<typeof GlassesHud>[1] = {}, bridge = new PageBridge()) {
  const mounted = await mount(options, bridge);
  mounted.presentation.setStatus("listening");
  await vi.advanceTimersByTimeAsync(6000);
  return mounted;
}
const blank = (text: string) => text.trim() === "";
const rows = (text: string) => text.split("\n");
const shownLines = (text: string) => rows(text).map(line => line.trim()).filter(Boolean);
const bytes = (text: string) => new TextEncoder().encode(text).length;
function expectFits(text: string, width: number, lines: number): void {
  expect(rows(text).length).toBeLessThanOrEqual(lines);
  for (const line of rows(text)) expect(hudTextWidth(line), JSON.stringify(line)).toBeLessThanOrEqual(width);
  expect(bytes(text)).toBeLessThanOrEqual(AMBIENT_MAX_BYTES);
}
/** Kind headings and field labels that do not belong in a pop-up, whatever their case. */
const LABELS = /web check|news check|\bverify\b|conflict:|\bwas:|\bnow:|fact check|· (?:supported|contradicted|uncertain|unavailable)|[●▲◆] ?(?:OK|FALSE|UNSURE)|\bQ:|THEY MAY ASK/iu;

afterEach(() => { vi.useRealTimers(); });

describe("v0.16 fix: the swap to the hidden-display page is rejected or held back", () => {
  it("draws the pop-up in the BODY box of the page that is still up, then moves it to the full page once accepted", async () => {
    vi.useFakeTimers();
    const bridge = new PageBridge();
    bridge.rebuildOk = false;
    const { hud, presentation } = await mount({ images: false }, bridge);
    presentation.setStatus("listening");
    presentation.apply(question("q1", "How long is the lead time?"));
    presentation.apply(completed("a1", "q1", "Twelve to sixteen weeks."));
    await vi.advanceTimersByTimeAsync(3000);
    expect(bridge.names).toContain("hud-body"); // the HUD page is still on the glasses
    const body = bridge.text("hud-body");
    expect(body).toContain("Twelve to sixteen weeks.");
    expect(hud.frame.body).toBe(body); // phone mirror and glasses agree
    expectFits(body, HUD_LINE_WIDTH.body, BODY_LINES);
    expect(body).not.toMatch(LABELS);
    expect(bridge.stray).toEqual([]);
    expect(bridge.rebuilds.length).toBeLessThanOrEqual(5); // retried about once a second, not in a loop
    // The answer still leaves after its reading time: the retries do not restart it.
    await vi.advanceTimersByTimeAsync(7000);
    expect(blank(bridge.text("hud-body"))).toBe(true);
    expect(blank(hud.frame.body)).toBe(true);
    // The glasses take the page again: the next pop-up is centred on the full canvas.
    bridge.rebuildOk = true;
    await vi.advanceTimersByTimeAsync(1500);
    expect(bridge.names).toEqual(["hud-ambient"]);
    presentation.applyConcept({ id: "c1", term: "NVMe", explanation: "PCIe storage protocol for SSDs.", createdAt: at, origin: "copilot" });
    await vi.advanceTimersByTimeAsync(400);
    expect(shownLines(bridge.text("hud-ambient"))).toEqual(["NVMe — PCIe storage protocol for SSDs."]);
    const line = rows(bridge.text("hud-ambient")).find(row => row.trim())!;
    const left = hudTextWidth(line) - hudTextWidth(line.trimStart());
    expect(Math.abs(left - (AMBIENT_LINE_WIDTH - hudTextWidth(line)))).toBeLessThanOrEqual(hudGlyphWidth(" ") + 0.01);
    expect(bridge.stray).toEqual([]);
    hud.dispose();
  });

  it("pages a long answer for the BODY box while the page is rejected, and loses no text", async () => {
    vi.useFakeTimers();
    const bridge = new PageBridge();
    bridge.rebuildOk = false;
    const { hud, presentation } = await mount({ images: false }, bridge);
    presentation.setStatus("listening");
    await vi.advanceTimersByTimeAsync(1500);
    presentation.apply(question("q1", "What are the options?"));
    presentation.apply(completed("a1", "q1", LONG.repeat(2).trim()));
    const seen: string[] = [];
    for (let page = 0; page < 12; page += 1) {
      await vi.advanceTimersByTimeAsync(1300);
      const body = bridge.text("hud-body");
      expectFits(body, HUD_LINE_WIDTH.body, BODY_LINES);
      expect(body).not.toContain("…");
      expect(rows(body).at(-1)!).toMatch(/\d\/\d/u); // the last row is the footer with the page marker
      seen.push(shownLines(rows(body).slice(0, -1).join("\n")).join(" "));
      if (!/swipe ↓ more/u.test(body)) break;
      hud.handleGesture("down");
    }
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.join(" ").replace(/\s+/gu, " ")).toBe(LONG.repeat(2).trim().replace(/\s+/gu, " "));
    expect(bridge.stray).toEqual([]);
    hud.dispose();
  });

  it("shows a pop-up that arrives after the page was rejected", async () => {
    vi.useFakeTimers();
    const bridge = new PageBridge();
    bridge.rebuildOk = false;
    const { hud, presentation } = await mount({ images: false }, bridge);
    presentation.setStatus("listening");
    await vi.advanceTimersByTimeAsync(6000);
    presentation.applyConcept({ id: "c1", term: "NVMe", explanation: LONG.repeat(2), createdAt: at, origin: "copilot" });
    await vi.advanceTimersByTimeAsync(2500);
    const body = bridge.text("hud-body");
    expect(body).toContain("NVMe — Jetson Orin");
    expectFits(body, HUD_LINE_WIDTH.body, BODY_LINES);
    expect(rows(body).at(-1)!.trim()).toMatch(/^1\/\d · swipe ↓ more$/u);
    hud.dispose();
  });
});

describe("v0.16 fix: reading time follows the page size", () => {
  const big: PageLayout = { lineWidth: AMBIENT_LINE_WIDTH, lines: AMBIENT_LINES - 1, bytes: 700, measure: hudGlyphWidth, maxReadingMs: 25_000 };

  it("pageReadingMs keeps 10 s as its default ceiling and takes a higher one", () => {
    expect([pageReadingMs(10), pageReadingMs(100), pageReadingMs(546)]).toEqual([3000, 4500, 10_000]);
    expect([pageReadingMs(10, 25_000), pageReadingMs(546, 25_000), pageReadingMs(900, 25_000)]).toEqual([3000, 24_570, 25_000]);
  });

  it("a full page of the larger layout stays for its reading time, not 10 s, and so does the last page", () => {
    vi.useFakeTimers();
    const pager = new AnswerPager(() => undefined, big);
    pager.update({ id: "a", text: LONG.repeat(4).trim(), streaming: false });
    expect(pager.pageCount).toBe(2);
    const first = pageReadingMs([...pager.text.trim()].length, 25_000);
    expect(first).toBeGreaterThan(20_000);
    vi.advanceTimersByTime(first - 1);
    expect(pager.pageIndex).toBe(0);
    vi.advanceTimersByTime(1);
    expect(pager.pageIndex).toBe(1);
    const last = pageReadingMs([...pager.text.trim()].length, 25_000);
    expect(last).toBeGreaterThan(8000);
    vi.advanceTimersByTime(last - 1);
    expect(pager.text).not.toBe("");
    vi.advanceTimersByTime(1);
    expect(pager.text).toBe("");
    pager.dispose();
  });

  it("a short last page still stays 8 s", () => {
    vi.useFakeTimers();
    const pager = new AnswerPager(() => undefined, big);
    pager.update({ id: "a", text: "Twelve to sixteen weeks.", streaming: false });
    vi.advanceTimersByTime(7999);
    expect(pager.text).toBe("Twelve to sixteen weeks.");
    vi.advanceTimersByTime(1);
    expect(pager.text).toBe("");
    pager.dispose();
  });

  it("on the hidden display a long answer on one page is not gone after 8 s", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening();
    const answer = `${LONG.repeat(2).trim()} ${LONG.slice(0, 90).trim()}`;
    presentation.apply(question("q1", "What are the options?"));
    presentation.apply(completed("a1", "q1", answer));
    expect(hud.frame.body).not.toMatch(/\d\/\d/u); // one page
    const wanted = pageReadingMs([...answer].length, 25_000);
    expect(wanted).toBeGreaterThan(18_000);
    await vi.advanceTimersByTimeAsync(wanted - 500);
    expect(hud.frame.body).toContain("Jetson Orin modules");
    await vi.advanceTimersByTimeAsync(1000);
    expect(blank(hud.frame.body)).toBe(true);
    hud.dispose();
  });

  it("a full concept page on the hidden display is not turned after 10 s", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening();
    presentation.applyConcept({ id: "c1", term: "NVMe", explanation: LONG.repeat(6), createdAt: at, origin: "copilot" });
    expect(rows(hud.frame.body).at(-1)!.trim()).toMatch(/^1\/\d · swipe ↓ more$/u);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(rows(hud.frame.body).at(-1)!.trim()).toMatch(/^1\/\d · swipe ↓ more$/u);
    await vi.advanceTimersByTimeAsync(10_500);
    expect(rows(hud.frame.body).at(-1)!.trim()).toMatch(/^2\/\d/u);
    hud.dispose();
  });
});

describe("v0.16 fix: Candidate mode tells a question they may ask from a line to say", () => {
  it("marks a they-ask suggestion inside the sentence, and leaves the other kinds bare", async () => {
    const line = "Why are you leaving your current role?";
    const shown: Record<string, string> = {};
    for (const kind of ["ask-them", "they-ask", "say"] as const) {
      vi.useFakeTimers();
      const { hud, presentation } = await listening();
      presentation.setMode("interviewee");
      presentation.setSuggestions([suggestion("s1", line, kind)]);
      shown[kind] = shownLines(hud.frame.body).join(" ");
      expect(hud.frame.body).not.toMatch(/THEY MAY ASK|\bQ:/u);
      expectFits(hud.frame.body, AMBIENT_LINE_WIDTH, AMBIENT_LINES);
      hud.dispose();
      vi.useRealTimers();
    }
    expect(shown["ask-them"]).toBe(line);
    expect(shown.say).toBe(line);
    expect(shown["they-ask"]).toBe(`They may ask: ${line}`);
    expect(shown["they-ask"]).not.toBe(shown["ask-them"]);
  });

  it("a tap on a they-ask pop-up closes it and asks nothing", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening();
    presentation.setMode("interviewee");
    presentation.setSuggestions([suggestion("s1", "Why are you leaving your current role?", "they-ask")]);
    expect(hud.frame.body).toContain("They may ask:");
    expect(hud.handleGesture("click")).toEqual({ type: "handled" });
    expect(blank(hud.frame.body)).toBe(true);
    hud.dispose();
  });
});

describe("v0.16 fix: verdict and conflict pop-ups carry no kind heading", () => {
  it("a contradiction is a correction; other verdicts are one word and the claim; a conflict is sentences", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening();
    const pop = () => { expect(hud.frame.body).not.toMatch(LABELS); return shownLines(hud.frame.body); };
    presentation.applyFactCheck({ id: "f1", claim: "The cap is $25,000", status: "contradicted", summary: "Finance approved $40,000.", sources: [], checkedAt: at } as never);
    expect(pop()).toEqual(["Correction: Finance approved $40,000."]);
    await vi.advanceTimersByTimeAsync(6000);
    presentation.applyFactCheck({ id: "f2", claim: "The cap is $30,000", status: "contradicted", summary: "", sources: [], checkedAt: at } as never);
    expect(pop()).toEqual(["Not true: The cap is $30,000"]);
    await vi.advanceTimersByTimeAsync(6000);
    presentation.applyVerification({ id: "v1", target: "Orin lead time is 12 weeks", status: "supported", summary: "Distributors list 12 to 16 weeks.", sources: [], checkedAt: at, requestedBy: "auto" });
    expect(pop()).toEqual(["True: Orin lead time is 12 weeks", "Distributors list 12 to 16 weeks."]);
    await vi.advanceTimersByTimeAsync(6000);
    presentation.applyFactCheck({ id: "f3", claim: "The rate was cut this week", status: "uncertain", summary: "No source found.", recency: "news",
      sources: [{ url: "https://news.example.org/a", title: "A", publishedAt: "2026-11-17" }], checkedAt: at } as never);
    expect(pop()).toEqual(["Unsure: The rate was cut this week", "No source found.", "Src: news.example.org · 2026-11-17"]);
    await vi.advanceTimersByTimeAsync(6000);
    presentation.applyVerification({ id: "v2", target: "The fab is in Arizona", status: "unavailable", summary: "", sources: [], checkedAt: at, requestedBy: "auto" });
    expect(pop()).toEqual(["Not checked: The fab is in Arizona"]);
    await vi.advanceTimersByTimeAsync(6000);
    presentation.applyConflict({ id: "x1", earlier: "Budget is $25,000", later: "Budget is $40,000", explanation: "The budget changed.", createdAt: at } as never);
    expect(pop()).toEqual(["The budget changed.", "Was “Budget is $25,000”, now “Budget is $40,000”."]);
    await vi.advanceTimersByTimeAsync(6000);
    presentation.applyConflict({ id: "x2", earlier: "Ship date is May", later: "Ship date is July", explanation: "", createdAt: at } as never);
    expect(pop()).toEqual(["Ship date is July", "Was “Ship date is May”."]);
    hud.dispose();
  });

  it("the woken CHECKS view keeps its verdict heading", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening({ display: "always-on" });
    presentation.applyFactCheck({ id: "f1", claim: "The cap is $25,000", status: "contradicted", summary: "Finance approved $40,000.", sources: [], checkedAt: at } as never);
    hud.setView("checks");
    expect(rows(hud.frame.body)[0]).toBe("▲ FALSE · contradicted · web check");
    hud.dispose();
  });
});

describe("v0.16 fix: cue pages keep to the byte ceiling", () => {
  const THAI = "โมดูลนี้ใช้โปรโตคอลจัดเก็บข้อมูลความเร็วสูงสำหรับเอสเอสดี";
  const HINDI = "यह मॉड्यूल एसएसडी के लिए तेज़ भंडारण प्रोटोकॉल का उपयोग करता है। ";

  for (const [name, sentence] of [["Thai", THAI], ["Hindi", HINDI]] as const) {
    it(`pages a ${name} concept by bytes: every page keeps its footer and no text is lost between pages`, async () => {
      vi.useFakeTimers();
      const { hud, presentation } = await listening({ answerLength: "detailed" });
      const explanation = sentence.repeat(14).trim();
      presentation.applyConcept({ id: "c1", term: "NVMe", explanation, createdAt: at, origin: "copilot" });
      const pages: string[] = [];
      for (let page = 0; page < 6; page += 1) {
        const body = hud.frame.body;
        expectFits(body, AMBIENT_LINE_WIDTH, AMBIENT_LINES);
        expect(rows(body)).toHaveLength(AMBIENT_LINES);
        const footer = rows(body).at(-1)!.trim();
        expect(footer).toMatch(new RegExp(`^${page + 1}/\\d`, "u"));
        pages.push(rows(body).slice(0, -1).map(row => row.trim()).join(""));
        if (!/swipe ↓ more/u.test(footer)) break;
        hud.handleGesture("down");
      }
      expect(pages.length).toBeGreaterThan(1);
      const strip = (text: string) => text.replace(/\s+/gu, "");
      expect(strip(pages.join(""))).toBe(strip(`NVMe — ${explanation}`));
      hud.dispose();
    });
  }
});

describe("v0.16 fix: the mode notice belongs to the session start", () => {
  it("does not come back when the link reconnects mid-session, and a tap then asks Helix", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening();
    presentation.setStatus("connecting");
    presentation.setStatus("connected");
    presentation.setStatus("listening");
    expect(hud.frame.body).not.toContain("Mode:");
    expect(hud.handleGesture("click")).toEqual({ type: "askLocal" });
    hud.dispose();
  });

  it("shows again for a new session after a stop, with the same mode", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening();
    presentation.setStatus("stopped");
    presentation.setStatus("connecting");
    presentation.setStatus("listening");
    expect(shownLines(hud.frame.body)[0]).toBe("Mode: Meeting");
    await vi.advanceTimersByTimeAsync(MODE_NOTICE_MS + 100);
    expect(hud.frame.body).not.toContain("Mode:");
    hud.dispose();
  });

  it("a tap while the notice is up closes it and still asks about the last few sentences", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await mount();
    presentation.setStatus("listening");
    expect(shownLines(hud.frame.body)[0]).toBe("Mode: Meeting");
    expect(hud.handleGesture("click")).toEqual({ type: "askLocal" });
    expect(hud.frame.body).not.toContain("Mode:");
    hud.dispose();
  });
});

describe("v0.16 fix: a rejected page swap at session start is retried with a delay", () => {
  for (const display of ["ambient", "always-on"] as const) {
    it(`does not retry in a loop with images on (${display} display), and recovers`, async () => {
      vi.useFakeTimers();
      const bridge = new PageBridge();
      bridge.rebuildOk = false;
      const { hud, presentation } = await mount({ display }, bridge);
      presentation.setStatus("listening");
      await vi.advanceTimersByTimeAsync(500);
      expect(bridge.rebuilds.length).toBeLessThanOrEqual(2);
      await vi.advanceTimersByTimeAsync(4000);
      expect(bridge.rebuilds.length).toBeGreaterThan(2); // still retried
      expect(bridge.rebuilds.length).toBeLessThanOrEqual(7);
      bridge.rebuildOk = true;
      await vi.advanceTimersByTimeAsync(2500);
      if (display === "ambient") expect(bridge.names).toEqual(["hud-ambient"]); else expect(bridge.names).toContain("hud-body");
      expect((bridge.current.imageObject ?? []).map(image => image.containerName)).not.toContain("hud-splash");
      const settled = bridge.rebuilds.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(bridge.rebuilds).toHaveLength(settled);
      hud.dispose();
    });
  }
});
