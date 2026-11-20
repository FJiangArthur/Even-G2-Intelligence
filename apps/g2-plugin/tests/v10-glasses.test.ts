import { inflateSync } from "node:zlib";
import {
  ImageRawDataUpdateResult, StartUpPageCreateResult,
  type CreateStartUpPageContainer, type ImageRawDataUpdate, type RebuildPageContainer, type TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import { MODE_PROFILES, PICKER_MODES, type GatewayEvent } from "@helix/conversation-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, applyModePreset, loadPersistedConfig, CONFIG_STORAGE_KEY } from "../src/config";
import { G2ConversationController, type G2BridgePort } from "../src/controller";
import { GlassesHud, HUD_IMAGES, HUD_LINE_WIDTH, hudTextWidth, renderImage } from "../src/glasses-hud";
import { encodeGrayPng } from "../src/glasses-image";
import type { GlassesRenderBridge } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";

class ImageBridge implements GlassesRenderBridge {
  public readonly creates: CreateStartUpPageContainer[] = [];
  public readonly rebuilds: RebuildPageContainer[] = [];
  public readonly updates: TextContainerUpgrade[] = [];
  public readonly images: { name: string; bytes: number; at: number }[] = [];
  public imageResult: ImageRawDataUpdateResult = ImageRawDataUpdateResult.success;
  public inFlight = 0; public maxInFlight = 0;
  public async createStartUpPageContainer(container: CreateStartUpPageContainer) { this.creates.push(container); return StartUpPageCreateResult.success; }
  public async rebuildPageContainer(container: RebuildPageContainer) { this.rebuilds.push(container); return true; }
  public async textContainerUpgrade(container: TextContainerUpgrade) { this.updates.push(container); return true; }
  public async updateImageRawData(image: ImageRawDataUpdate) {
    this.maxInFlight = Math.max(this.maxInFlight, ++this.inFlight);
    await new Promise(resolve => setTimeout(resolve, 5));
    this.inFlight--;
    const data = image.imageData as Uint8Array;
    this.images.push({ name: image.containerName!, bytes: data.length, at: Date.now() });
    return this.imageResult;
  }
  public sent(name: string) { return this.images.filter(image => image.name === name); }
}
type Role = "self" | "other" | "unknown";
const ctx = (label: string, role: Role = "unknown", trigger?: string) => ({
  prompt: { id: "p", version: "1" }, endpoint: { id: "openai-direct", url: "", provider: "openai", model: "m" },
  speaker: { label, role }, latencyMs: { totalMs: 900 }, ...(trigger ? { trigger } : {}),
});
let seq = 0;
const ev = (event: object) => ({ protocolVersion: "2.1", sessionId: "s", occurredAt: "2026-11-16T18:00:00.000Z", eventId: `e${++seq}`, ...event }) as unknown as GatewayEvent;
const question = (id: string, text: string, label: string, role: Role) => ev({ type: "question.detected", questionId: id, text, confidence: 0.9, context: ctx(label, role, "question") });
const completed = (answerId: string, questionId: string, text: string) => ev({ type: "answer.completed", answerId, questionId, text, context: ctx("Helix", "unknown", "question") });

async function mount(bridge = new ImageBridge(), options: ConstructorParameters<typeof GlassesHud>[1] = {}) {
  const hud = new GlassesHud(bridge, { tickMs: 0, writeGapMs: 0, mascotIntervalMs: 1000, ...options });
  const presentation = new ConversationPresentation();
  presentation.subscribe(snapshot => hud.render(snapshot.glasses, snapshot));
  await hud.initialize();
  return { bridge, hud, presentation };
}
/** Decodes our stored-deflate greyscale PNG back to pixels. */
function decodePng(bytes: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let p = 8, width = 0, height = 0; const idat: Uint8Array[] = [];
  while (p < bytes.length) {
    const length = view.getUint32(p), type = String.fromCharCode(...bytes.slice(p + 4, p + 8)), data = bytes.slice(p + 8, p + 8 + length);
    if (type === "IHDR") { width = view.getUint32(p + 8); height = view.getUint32(p + 12); expect(data[8]).toBe(8); expect(data[9]).toBe(0); }
    if (type === "IDAT") idat.push(data);
    p += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat)), pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) { expect(raw[y * (width + 1)]).toBe(0); pixels.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width); }
  return { width, height, pixels };
}

afterEach(() => { vi.useRealTimers(); });

describe("v0.10 glasses images", () => {
  it("encodes valid 8-bit greyscale PNGs in 16 green levels for every image", () => {
    for (const key of ["mascot:idle", "mascot:listening", "mascot:thinking", "mascot:speaking", "mascot:error", "splash:technical", "splash:off", ...PICKER_MODES.map(mode => `badge:${mode}`)]) {
      const image = renderImage(key);
      const decoded = decodePng(encodeGrayPng(image));
      expect(decoded.pixels).toEqual(image.pixels);
      for (const value of decoded.pixels) expect(value % 17).toBe(0); // gray4 levels only
      const target = HUD_IMAGES[key.split(":")[0] as keyof typeof HUD_IMAGES];
      expect([decoded.width, decoded.height]).toEqual([target.width, target.height]);
      expect(target.width).toBeGreaterThanOrEqual(20); expect(target.width).toBeLessThanOrEqual(288);
      expect(target.height).toBeGreaterThanOrEqual(20); expect(target.height).toBeLessThanOrEqual(144);
      const lit = decoded.pixels.filter(value => value > 0).length;
      if (key === "splash:off") expect(lit).toBe(0); else expect(lit).toBeGreaterThan(20);
    }
    // Different modes draw different badges.
    expect(new Set(PICKER_MODES.map(mode => renderImage(`badge:${mode}`).pixels.join(","))).size).toBe(PICKER_MODES.length);
  });

  it("adds mascot, badge and splash containers, sends each image once, one at a time, and only on change", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await mount();
    const page = bridge.creates[0]!;
    expect(page.imageObject!.map(image => image.containerName)).toEqual(["hud-mascot", "hud-badge", "hud-splash"]);
    expect(page.containerTotalNum).toBe(10); // frame + 6 texts + 3 images
    await vi.advanceTimersByTimeAsync(200);
    expect(bridge.sent("hud-badge")).toHaveLength(1);
    expect(bridge.sent("hud-splash")).toHaveLength(1); // the splash while not connected
    expect(bridge.sent("hud-mascot")).toHaveLength(1);
    expect(hud.images).toMatchObject({ mascot: "mascot:idle", badge: "badge:general", splash: "splash:general" });
    expect(hud.frame.body.split("\n").slice(0, 5).every(line => !line.trim())).toBe(true); // text under the art
    // Connected and listening: image containers are opaque, so the page is rebuilt WITHOUT the splash;
    // the rebuilt (empty) mascot and badge containers are drawn again.
    presentation.setStatus("listening");
    await vi.advanceTimersByTimeAsync(1200);
    const active = bridge.rebuilds.at(-1)!;
    expect(active.imageObject!.map(image => image.containerName)).toEqual(["hud-mascot", "hud-badge"]);
    expect(hud.images).toMatchObject({ mascot: "mascot:listening", badge: "badge:general" });
    expect(hud.images.splash).toBeUndefined();
    expect(bridge.sent("hud-splash")).toHaveLength(1);
    expect(bridge.sent("hud-mascot")).toHaveLength(2);
    expect(bridge.sent("hud-badge")).toHaveLength(2);
    const rebuilds = bridge.rebuilds.length;
    // Steady state: caption traffic never re-sends images or rebuilds.
    for (let i = 0; i < 20; i++) { presentation.apply(ev({ type: "transcript.partial", transcriptId: "tp", revision: i, text: `word ${i}`, context: ctx("Other speaker", "other") })); await vi.advanceTimersByTimeAsync(100); }
    expect(bridge.images).toHaveLength(5);
    expect(bridge.rebuilds).toHaveLength(rebuilds);
    // Mode switch: the badge only.
    presentation.setMode("technical");
    await vi.advanceTimersByTimeAsync(100);
    expect(bridge.sent("hud-badge")).toHaveLength(3);
    expect(bridge.images).toHaveLength(6);
    // Disconnect: back to the splash page.
    presentation.setStatus("stopped");
    await vi.advanceTimersByTimeAsync(1500);
    expect(bridge.rebuilds.at(-1)!.imageObject!.map(image => image.containerName)).toEqual(["hud-mascot", "hud-badge", "hud-splash"]);
    expect(hud.images.splash).toBe("splash:technical");
    expect(bridge.maxInFlight).toBe(1);
    hud.dispose();
  });

  it("rate-limits mascot changes and keeps the latest state", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await mount();
    presentation.setStatus("listening");
    await vi.advanceTimersByTimeAsync(1500);
    const before = bridge.sent("hud-mascot").length;
    presentation.beginRequest(); // thinking
    presentation.setStatus("paused"); presentation.setStatus("listening"); presentation.setStatus("paused");
    await vi.advanceTimersByTimeAsync(300);
    expect(bridge.sent("hud-mascot").length - before).toBeLessThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(bridge.sent("hud-mascot").length - before).toBeLessThanOrEqual(2);
    hud.dispose();
  });

  it("re-sends images after a page rebuild (menu) and stops sending after repeated host failures", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await mount();
    presentation.setStatus("listening");
    await vi.advanceTimersByTimeAsync(1500);
    const count = bridge.images.length;
    hud.handleGesture("double");
    await vi.advanceTimersByTimeAsync(200);
    const menuPage = bridge.rebuilds.at(-1)!;
    expect(menuPage.imageObject!.map(image => image.containerName)).toEqual(["hud-mascot", "hud-badge"]); // no splash on the menu
    expect(bridge.images.length).toBe(count + 2);
    bridge.imageResult = ImageRawDataUpdateResult.imageToGray4Failed;
    hud.handleGesture("double");
    await vi.advanceTimersByTimeAsync(200);
    presentation.setMode("partner"); await vi.advanceTimersByTimeAsync(200);
    presentation.setMode("learning"); await vi.advanceTimersByTimeAsync(200);
    expect(hud.imagesOn).toBe(false);
    const frozen = bridge.images.length;
    presentation.setMode("social"); await vi.advanceTimersByTimeAsync(200);
    expect(bridge.images.length).toBe(frozen);
    expect(hud.frame.status).toMatch(/SOCIAL$/u); // text tag replaces the badge
    hud.dispose();
  });
});

describe("v0.10 glasses modes", () => {
  it("Mode ▶ opens a list of modes; a click returns the mode command", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await mount();
    presentation.setStatus("listening");
    presentation.setMode("general");
    hud.handleGesture("double");
    const modeIndex = hud.menuItems.findIndex(item => item.action === "mode");
    expect(hud.menuItems[modeIndex]!.label).toBe("Mode ▶");
    expect(hud.selectListItem(modeIndex)).toEqual({ type: "handled" });
    await vi.advanceTimersByTimeAsync(100);
    expect(hud.menuOpen).toBe(true);
    expect(hud.menuItems.map(item => item.label)).toEqual(PICKER_MODES.map(mode => MODE_PROFILES[mode].label));
    expect(bridge.rebuilds.at(-1)!.listObject![0]!.itemContainer!.itemName).toEqual(hud.menuItems.map(item => item.label));
    expect(hud.frame.title).toBe("MODE");
    expect(hud.selectListItem(PICKER_MODES.indexOf("interviewer"))).toEqual({ type: "mode", mode: "interviewer" });
    expect(hud.menuOpen).toBe(false);
    hud.dispose();
  });

  it("labels the suggestions view per mode and shows the interviewer's answer key", async () => {
    const { hud, presentation } = await mount();
    presentation.setStatus("listening");
    presentation.setMode("interviewer");
    while (hud.view !== "qa") hud.handleGesture("down");
    expect(hud.frame.title).toBe("PROBE");
    // Interviewer: the wearer's own question gets an answer key on the glasses.
    presentation.apply(question("q1", "How did you scale the ingestion pipeline?", "You", "self"));
    presentation.apply(completed("a1", "q1", "Strong answer: sharding; backpressure; numbers. Probe: what broke first? Flag: only team credit."));
    expect(hud.view).toBe("answer");
    expect(hud.frame.title).toMatch(/^§ ANSWER KEY 1\/1/u);
    expect(hud.frame.body.split("\n")[0]).toBe("You: How did you scale the ingestion pipeline?");
    for (const row of hud.frame.body.split("\n")) expect(hudTextWidth(row)).toBeLessThanOrEqual(HUD_LINE_WIDTH.body);
    // Meeting: the wearer's own questions stay off the glasses (v0.8 behaviour).
    presentation.setMode("general");
    presentation.apply(question("q2", "What is the budget?", "You", "self"));
    presentation.apply(completed("a2", "q2", "Forty thousand."));
    expect(hud.frame.body).not.toContain("Forty thousand");
    presentation.setMode("partner");
    while (hud.view !== "qa") hud.handleGesture("down");
    expect(hud.frame.title).toBe("CHECK IN");
    hud.dispose();
  });
});

describe("v0.10 controller modes", () => {
  it("setMode applies presets, saves, updates phone and glasses, and feeds the live transport", async () => {
    const storage = new Map<string, string>();
    const bridge: G2BridgePort = {
      getLocalStorage: async (key: string) => storage.get(key) ?? "",
      setLocalStorage: async (key: string, value: string) => { storage.set(key, value); return true; },
      createStartUpPageContainer: async () => StartUpPageCreateResult.success,
      textContainerUpgrade: async () => true,
      rebuildPageContainer: async () => true,
      audioControl: async () => true,
      onEvenHubEvent: () => () => undefined,
    } as unknown as G2BridgePort;
    const presentation = new ConversationPresentation();
    const hud = new GlassesHud(bridge as unknown as GlassesRenderBridge, { tickMs: 0 });
    let options: { mode?: () => unknown; automation?: () => unknown } | undefined;
    const controller = new G2ConversationController(bridge, hud, presentation, opts => { options = opts as never; return { state: "idle" } as never; });
    await controller.initialize();
    const seen: string[] = [];
    controller.subscribeMode(config => seen.push(config.conversationMode));
    await controller.setMode("partner");
    expect(controller.mode).toBe("partner");
    expect(presentation.snapshot().glasses.mode).toBe("partner");
    expect(seen).toEqual(["partner"]);
    const saved = await loadPersistedConfig({ getLocalStorage: async key => storage.get(key) ?? "", setLocalStorage: async () => true });
    expect(saved).toMatchObject({ conversationMode: "partner", autoAnswer: false, copilotConcepts: false, copilotClaims: false, copilotWebGrounding: false, liveWebFactCheck: false, autoExplainTerms: false });
    expect(JSON.parse(storage.get(CONFIG_STORAGE_KEY)!).conversationMode).toBe("partner");
    await controller.setMode("technical");
    expect(applyModePreset(DEFAULT_CONFIG, "technical")).toMatchObject({ autoAnswer: true, copilotConcepts: true, copilotClaims: true });
    await controller.setMode("bogus" as never);
    expect(controller.mode).toBe("technical");
    void options;
    await controller.dispose();
  });
});

describe("v0.10 phone mirror of the glasses display", () => {
  it("mirrors title, right-aligned status, mascot and badge images, and the splash only while not connected", async () => {
    vi.useFakeTimers();
    const { glassesMirrorModel, mirrorImageMarkup } = await import("../src/glasses-mirror");
    const { hud, presentation } = await mount();
    await vi.advanceTimersByTimeAsync(200);
    let mirror = hud.mirror;
    expect(mirror.title).toBe("HELIX");
    expect(mirror.images).toMatchObject({ mascot: "mascot:idle", badge: "badge:general", splash: "splash:general" });
    presentation.setStatus("listening");
    presentation.setMode("partner");
    await vi.advanceTimersByTimeAsync(1500);
    mirror = hud.mirror;
    expect(mirror.images).toEqual({ mascot: "mascot:listening", badge: "badge:partner" });
    const model = glassesMirrorModel(mirror);
    expect(model.lines[0]).toMatchObject({ text: "LIVE", level: 4 });
    expect(model.lines[1]).toMatchObject({ level: 2, anchor: "end" });
    expect(model.lines[1]!.text).toMatch(/● 0m$/u);
    expect(model.images.map(image => image.slot)).toEqual(["mascot", "badge"]);
    const markup = mirrorImageMarkup("badge:partner");
    expect(markup).toMatch(/^<path fill="rgb\(/u);
    expect(mirrorImageMarkup("badge:partner")).toBe(markup); // cached
    hud.dispose();
  });
});
