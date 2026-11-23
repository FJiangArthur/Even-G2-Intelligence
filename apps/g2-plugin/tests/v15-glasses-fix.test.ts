import { ImageRawDataUpdateResult, StartUpPageCreateResult, type CreateStartUpPageContainer, type ImageRawDataUpdate, type RebuildPageContainer, type TextContainerUpgrade } from "@evenrealities/even_hub_sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachDiagnosticsStore, readDiagnostics, resetDiagnosticsForTest } from "../src/diagnostics";
import { GlassesHud } from "../src/glasses-hud";
import type { GlassesRenderBridge } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); resetDiagnosticsForTest(); });

/** A glasses link that answers every text write, but only after `textLatency` ms (0 = at once, Infinity = never). */
class LateBridge implements GlassesRenderBridge {
  public textLatency = 0;
  public started: { kind: string; name: string; content?: string; at: number }[] = [];
  public async createStartUpPageContainer(_page: CreateStartUpPageContainer) { return StartUpPageCreateResult.success; }
  public async rebuildPageContainer(_page: RebuildPageContainer) {
    this.started.push({ kind: "page", name: "rebuild", at: Date.now() });
    return true;
  }
  public textContainerUpgrade(update: TextContainerUpgrade): Promise<boolean> {
    this.started.push({ kind: "text", name: update.containerName!, content: update.content, at: Date.now() });
    const latency = this.textLatency;
    if (!latency) return Promise.resolve(true);
    if (latency === Infinity) return new Promise<boolean>(() => undefined);
    return new Promise<boolean>(done => setTimeout(() => done(true), latency));
  }
  public async updateImageRawData(_image: ImageRawDataUpdate) { return ImageRawDataUpdateResult.success; }
  public texts(from = 0) { return this.started.slice(from).filter(entry => entry.kind === "text"); }
  public pages(from = 0) { return this.started.slice(from).filter(entry => entry.kind === "page"); }
}
async function mount() {
  const bridge = new LateBridge();
  const errors: Error[] = [];
  const hud = new GlassesHud(bridge, { display: "always-on", tickMs: 0, images: false, debounceMs: 120, onError: error => errors.push(error) });
  const presentation = new ConversationPresentation();
  presentation.subscribe(snapshot => hud.render(snapshot.glasses, snapshot));
  await hud.initialize();
  return { bridge, hud, presentation, errors };
}
const settle = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const dirty = (hud: GlassesHud) => (hud as unknown as { dirty(): string[] }).dirty();

describe("v15 glasses-fix: text writes answered after the deadline", () => {
  it("a link whose answers take 22 s still gets every changed container, each sent once and without page re-pushes", async () => {
    vi.useFakeTimers();
    await attachDiagnosticsStore({ getLocalStorage: async () => "", setLocalStorage: async () => true });
    const { bridge, hud, presentation, errors } = await mount();
    presentation.setStatus("connected"); await settle(1000);
    expect(dirty(hud)).toEqual([]);
    const from = bridge.started.length;
    bridge.textLatency = 22_000;
    presentation.setStatus("listening");
    hud.setView("summary");
    const wanted = dirty(hud);
    expect(wanted.length).toBeGreaterThanOrEqual(2); // more than one container is behind
    await settle(wanted.length * 22_000 + 50_000);
    expect(dirty(hud)).toEqual([]);
    const texts = bridge.texts(from);
    for (const key of wanted) expect(texts.some(write => write.name === `hud-${key}`)).toBe(true);
    // Nothing is sent twice (the status line may get a second write with new text: its clock moved on).
    expect(new Set(texts.map(write => `${write.name}\n${write.content}`)).size).toBe(texts.length);
    expect(texts.length).toBeLessThanOrEqual(wanted.length + 1);
    expect(bridge.pages(from)).toHaveLength(0); // every late answer was taken: the state of the glasses is known
    expect(errors.filter(error => /15 s/u.test(error.message)).length).toBe(texts.length);
    expect(readDiagnostics().some(event => event.kind === "bridge-timeout" && /answered late/u.test(event.detail ?? ""))).toBe(true);
    // The link recovers: later changes go out as usual.
    bridge.textLatency = 0;
    const before = bridge.started.length;
    hud.setView("live");
    await settle(40_000);
    expect(dirty(hud)).toEqual([]);
    expect(bridge.started.length).toBeGreaterThan(before);
    hud.dispose();
  });

  it("an answer that comes during the back-off ends it and the write is not repeated", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await mount();
    presentation.setStatus("connected"); await settle(1000);
    const from = bridge.started.length;
    bridge.textLatency = 16_000;
    presentation.setStatus("listening");
    hud.setView("summary");
    const wanted = dirty(hud).length;
    expect(wanted).toBeGreaterThanOrEqual(2);
    await settle(15_500);
    expect(bridge.texts(from)).toHaveLength(1);
    expect(dirty(hud).length).toBe(wanted); // deadline passed, nothing counted as sent yet
    bridge.textLatency = 0;
    await settle(1500); // the answer came at 16 s, inside the 5 s back-off; the rest follows at once
    expect(dirty(hud)).toEqual([]);
    const names = bridge.texts(from).map(write => write.name);
    expect(names).toHaveLength(wanted);
    expect(new Set(names).size).toBe(wanted);
    expect(bridge.pages(from)).toHaveLength(0);
    hud.dispose();
  });

  it("text that changed while its write was unanswered is sent anew and ends up on the glasses", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await mount();
    presentation.setStatus("connected"); await settle(1000);
    const from = bridge.started.length;
    bridge.textLatency = 22_000;
    presentation.setStatus("listening");
    await settle(16_000); // first write timed out, its answer is due at 22 s
    const first = bridge.texts(from)[0]!;
    bridge.textLatency = 0;
    presentation.setStatus("connected"); // the same container wants different text again
    await settle(60_000);
    expect(dirty(hud)).toEqual([]);
    const last = bridge.started.slice(from).at(-1)!;
    // The newest thing the glasses got is not the stale text: a newer text write or a full page.
    expect(last.kind === "page" || last.content !== first.content).toBe(true);
    expect(bridge.started.slice(from).length).toBeGreaterThan(1);
    hud.dispose();
  });

  it("a write that is never answered does not stop the queue: the HUD is in sync once the link answers again", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await mount();
    presentation.setStatus("connected"); await settle(1000);
    const from = bridge.started.length;
    bridge.textLatency = Infinity;
    presentation.setStatus("listening");
    await settle(16_000);
    expect(bridge.texts(from)).toHaveLength(1);
    bridge.textLatency = 0;
    await settle(60_000);
    expect(dirty(hud)).toEqual([]);
    expect(bridge.started.length - from).toBeGreaterThan(1);
    hud.dispose();
  });
});
