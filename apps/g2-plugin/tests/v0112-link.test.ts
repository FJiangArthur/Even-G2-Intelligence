import { ImageRawDataUpdateResult, StartUpPageCreateResult, type CreateStartUpPageContainer, type ImageRawDataUpdate, type RebuildPageContainer, type TextContainerUpgrade } from "@evenrealities/even_hub_sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describePreviousExit, monitorBridge, resetDiagnosticsForTest, watchLifecycle, HEARTBEAT_MS } from "../src/diagnostics";
import { GlassesHud, SLOW_HOLD_MS, SLOW_WRITE_MS, WRITE_GAP_MS } from "../src/glasses-hud";
import type { GlassesRenderBridge } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";

/** A glasses link with adjustable latency that records every write and how many overlap. */
class LinkBridge implements GlassesRenderBridge {
  public delay = { text: 2, image: 2, page: 2 };
  public log: string[] = []; public inFlight = 0; public maxInFlight = 0;
  /** Smallest pause between the end of one write and the start of the next. */
  public minGap = Infinity; private lastEnd = -1;
  public pages: (CreateStartUpPageContainer | RebuildPageContainer)[] = [];
  private async write<T>(kind: "text" | "image" | "page", name: string, value: T): Promise<T> {
    this.maxInFlight = Math.max(this.maxInFlight, ++this.inFlight);
    if (this.lastEnd >= 0) this.minGap = Math.min(this.minGap, Date.now() - this.lastEnd);
    await new Promise(done => setTimeout(done, this.delay[kind]));
    this.inFlight--; this.log.push(`${kind}:${name}`); this.lastEnd = Date.now();
    return value;
  }
  public async createStartUpPageContainer(page: CreateStartUpPageContainer) { this.pages.push(page); return StartUpPageCreateResult.success; }
  public rebuildPageContainer(page: RebuildPageContainer) { this.pages.push(page); return this.write("page", "rebuild", true); }
  public textContainerUpgrade(update: TextContainerUpgrade) { return this.write("text", update.containerName!, true); }
  public updateImageRawData(image: ImageRawDataUpdate) { return this.write("image", image.containerName!, ImageRawDataUpdateResult.success); }
  public count(kind: string) { return this.log.filter(entry => entry.startsWith(kind)).length; }
}
async function mount(options: ConstructorParameters<typeof GlassesHud>[1] = {}) {
  const bridge = new LinkBridge();
  const hud = new GlassesHud(bridge, { tickMs: 0, mascotIntervalMs: 50, debounceMs: 120, captionIntervalMs: 120, ...options });
  const presentation = new ConversationPresentation();
  presentation.subscribe(snapshot => hud.render(snapshot.glasses, snapshot));
  await hud.initialize();
  return { bridge, hud, presentation };
}
const settle = (ms: number) => vi.advanceTimersByTimeAsync(ms);

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); resetDiagnosticsForTest(); });

describe("v0.11.2 glasses link discipline", () => {
  it("never has two glasses writes in flight (text, image and page are one queue)", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await mount();
    bridge.delay = { text: 40, image: 60, page: 40 };
    presentation.setStatus("connected"); await settle(300);
    presentation.setStatus("listening");
    for (let i = 0; i < 12; i++) { presentation.setInteraction(i % 2 ? "LISTENING" : "THINKING"); hud.setView(i % 2 ? "concepts" : "summary"); await settle(90); }
    await settle(1500);
    expect(bridge.count("text")).toBeGreaterThan(4);
    expect(bridge.count("image")).toBeGreaterThan(0);
    expect(bridge.maxInFlight).toBe(1);
    expect(bridge.minGap).toBeGreaterThanOrEqual(WRITE_GAP_MS); // v0.11.4: every write waits for the previous one plus a gap
    await hud.dispose();
  });
  it("the write spacing is adjustable: 400 ms leaves at least 400 ms between glasses writes, and 1.2 s after a page rebuild", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await mount({ writeGapMs: 0 });
    hud.setWriteGap(400);
    expect(hud.writeGapMs).toBe(400);
    presentation.setStatus("connected"); await settle(3000); // connect swaps the page (rebuild), then text + images
    const afterPage = bridge.log.indexOf("page:rebuild");
    expect(afterPage).toBeGreaterThanOrEqual(0);
    presentation.setStatus("listening");
    for (let i = 0; i < 6; i++) { hud.setView(i % 2 ? "concepts" : "summary"); await settle(500); }
    await settle(4000);
    expect(bridge.count("text")).toBeGreaterThan(3);
    expect(bridge.minGap).toBeGreaterThanOrEqual(400);
    expect(bridge.maxInFlight).toBe(1);
    await hud.dispose();
  });
  it("slow answers from the glasses pause images and slow the captions; two slow images turn pixel art off", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await mount();
    presentation.setStatus("connected"); await settle(400);
    expect(hud.linkSlow).toBe(false);
    bridge.delay.text = SLOW_WRITE_MS + 300;
    presentation.setStatus("listening"); await settle(4 * (SLOW_WRITE_MS + 300) + 500);
    expect(hud.linkSlow).toBe(true);
    bridge.delay.text = 2;
    const images = bridge.count("image");
    hud.setView("concepts"); presentation.setStatus("paused"); await settle(3000);
    expect(bridge.count("image")).toBe(images); // paused while the link is slow
    await settle(SLOW_HOLD_MS);
    expect(hud.linkSlow).toBe(false);
    expect(bridge.count("image")).toBeGreaterThan(images); // and back once it recovered

    bridge.delay.image = SLOW_WRITE_MS + 100;
    presentation.setStatus("listening"); await settle(SLOW_WRITE_MS + 600);
    await settle(SLOW_HOLD_MS + 100);
    presentation.setStatus("paused"); await settle(SLOW_WRITE_MS + 600);
    expect(hud.imagesOn).toBe(false);
    await hud.dispose();
  });
  it("the pixel-art switch rebuilds the page without / with image containers", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await mount({ images: false });
    expect(hud.imagesOn).toBe(false);
    expect((bridge.pages[0] as { imageObject?: unknown[] }).imageObject).toBeUndefined();
    presentation.setStatus("connected"); await settle(400);
    expect(bridge.count("image")).toBe(0);
    hud.setImagesEnabled(true); await settle(600);
    expect((bridge.pages.at(-1) as { imageObject?: unknown[] }).imageObject).toHaveLength(2);
    expect(bridge.count("image")).toBeGreaterThan(0);
    hud.setImagesEnabled(false); await settle(600);
    expect((bridge.pages.at(-1) as { imageObject?: unknown[] }).imageObject).toBeUndefined();
    await hud.dispose();
  });
});

describe("v0.11.2 diagnostics: what the glasses link was doing", () => {
  it("the heartbeat carries glasses write counts and the slowest answer, and the exit line says how long ago in seconds", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 19, 3, 26, 0) });
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
    const bridge = monitorBridge({
      textContainerUpgrade: () => new Promise<boolean>(done => setTimeout(() => done(true), 700)),
      updateImageRawData: () => new Promise<string>(done => setTimeout(() => done("success"), 2100)),
    });
    watchLifecycle({ onResume: () => {}, onHide: () => {}, describe: () => "listening 1m · dom 972" });
    void bridge.textContainerUpgrade(); void bridge.textContainerUpgrade(); void bridge.updateImageRawData();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    const heartbeat = JSON.parse(store.get("helix.heartbeat.v1")!);
    expect(heartbeat.io).toBe("text 2x max 0.7s, image 1x max 2.1s");
    expect(JSON.parse(store.get("helix.diagnostics.v1")!).some((e: { kind: string; detail?: string }) => e.kind === "bridge-slow" && /updateImageRawData 2\.1 s/u.test(e.detail ?? ""))).toBe(true);
    const exit = describePreviousExit(heartbeat, heartbeat.at + 6000);
    expect(exit?.detail).toMatch(/last alive 6 s before this launch while on screen · listening 1m · dom 972 · activity in the last 10 s: text 2x max 0\.7s, image 1x max 2\.1s/u);
  });
});
