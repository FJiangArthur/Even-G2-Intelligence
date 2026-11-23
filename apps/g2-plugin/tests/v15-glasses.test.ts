import { ImageRawDataUpdateResult, StartUpPageCreateResult, type CreateStartUpPageContainer, type ImageRawDataUpdate, type RebuildPageContainer, type TextContainerUpgrade } from "@evenrealities/even_hub_sdk";
import type { GatewayEvent } from "@helix/conversation-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnswerPager } from "../src/answer-pager";
import { DIAGNOSTICS_STORE_KEY, attachDiagnosticsStore, readDiagnostics, recordDiagnostic, resetDiagnosticsForTest } from "../src/diagnostics";
import { GlassesHud } from "../src/glasses-hud";
import { GlassesRenderer, type GlassesRenderBridge } from "../src/glasses-renderer";
import { ConversationPresentation, FEED_LIMIT } from "../src/presentation";

const NEVER = new Promise<never>(() => undefined);

/** A glasses link where chosen writes never get an answer. */
class HangBridge implements GlassesRenderBridge {
  /** How many of the next writes of each kind stay unanswered (Infinity = all). */
  public hang = { text: 0, image: 0, page: 0 };
  public started: { kind: string; name: string; content?: string; at: number }[] = [];
  public done: { kind: string; name: string; content?: string; at: number }[] = [];
  private write<T>(kind: "text" | "image" | "page", name: string, value: T, content?: string): Promise<T> {
    this.started.push({ kind, name, content, at: Date.now() });
    if (this.hang[kind] > 0) { this.hang[kind] -= 1; return NEVER; }
    this.done.push({ kind, name, content, at: Date.now() });
    return Promise.resolve(value);
  }
  public async createStartUpPageContainer(_page: CreateStartUpPageContainer) { return StartUpPageCreateResult.success; }
  public rebuildPageContainer(_page: RebuildPageContainer) { return this.write("page", "rebuild", true); }
  public textContainerUpgrade(update: TextContainerUpgrade) { return this.write("text", update.containerName!, true, update.content); }
  public updateImageRawData(image: ImageRawDataUpdate) { return this.write("image", image.containerName!, ImageRawDataUpdateResult.success); }
  public startedOf(kind: string, name?: string) { return this.started.filter(entry => entry.kind === kind && (!name || entry.name === name)); }
  public doneOf(kind: string, name?: string) { return this.done.filter(entry => entry.kind === kind && (!name || entry.name === name)); }
  public last(name: string) { return this.doneOf("text", name).at(-1)?.content; }
}
async function mount(options: ConstructorParameters<typeof GlassesHud>[1] = {}) {
  const bridge = new HangBridge();
  const errors: Error[] = [];
  const hud = new GlassesHud(bridge, { display: "always-on", tickMs: 0, images: false, debounceMs: 120, onError: error => errors.push(error), ...options });
  const presentation = new ConversationPresentation();
  presentation.subscribe(snapshot => hud.render(snapshot.glasses, snapshot));
  await hud.initialize();
  return { bridge, hud, presentation, errors };
}
const settle = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** Every container on the glasses holds what the HUD wants to show (by a text write or a page push). */
const inSync = (hud: GlassesHud) => (hud as unknown as { dirty(): string[] }).dirty().length === 0;
const memoryStore = () => ({ getLocalStorage: async () => "", setLocalStorage: async () => true });
/** Resolves to "pending" when `promise` has not settled after `ms` of fake time. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | "pending"> {
  let result: T | "pending" = "pending";
  void promise.then(value => { result = value; }, () => undefined);
  await settle(ms);
  return result;
}

const ctx = (label: string) => ({
  prompt: { id: "p", version: "1" }, endpoint: { id: "openai-direct", url: "", provider: "openai", model: "m" },
  speaker: { label, role: "unknown" as const }, latencyMs: { totalMs: 900 },
});
const base = { protocolVersion: "2.1" as const, sessionId: "s", occurredAt: "2026-11-08T18:00:00.000Z" };
const ev = (event: object) => ({ ...base, eventId: `e${Math.random()}`, ...event }) as unknown as GatewayEvent;
const partial = (text: string) => ev({ type: "transcript.partial", transcriptId: "tp", revision: 1, text, context: ctx("Other speaker") });
const final = (id: string, text: string) => ev({ type: "transcript.final", transcriptId: id, text, context: ctx("Other speaker") });
const manualQuestion = (id: string) => ev({ type: "question.detected", questionId: id, text: "help", confidence: 1, context: { ...ctx("Local context"), trigger: "manual" } });
const delta = (answerId: string, questionId: string, text: string) => ev({ type: "answer.delta", answerId, questionId, delta: text, context: { ...ctx("Helix"), trigger: "manual" } });
const completed = (answerId: string, questionId: string, text: string) => ev({ type: "answer.completed", answerId, questionId, text, context: { ...ctx("Helix"), trigger: "manual" } });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); resetDiagnosticsForTest(); });

describe("v15 glasses write deadline (finding 8)", () => {
  it("a text write the glasses never answer times out after 15 s; the queue goes on with the latest frame", async () => {
    vi.useFakeTimers();
    await attachDiagnosticsStore(memoryStore());
    const { bridge, hud, presentation, errors } = await mount();
    const start = Date.now();
    presentation.setStatus("connected"); await settle(1000);
    bridge.hang.text = 1;
    presentation.setStatus("listening"); await settle(1000);
    const hung = bridge.started.length - bridge.done.length;
    expect(hung).toBe(1);
    await settle(13_000);
    expect(bridge.started.length - bridge.done.length).toBe(1); // still inside the deadline: nothing else goes out
    hud.setView("summary"); // the frame changes while the write hangs
    await settle(30_000);
    expect(errors.some(error => /15 s/u.test(error.message))).toBe(true);
    expect(readDiagnostics().some(event => event.kind === "bridge-timeout")).toBe(true);
    expect(hud.linkSlow).toBe(true);
    expect(inSync(hud)).toBe(true);
    expect(bridge.doneOf("text").filter(write => write.at - start > 15_000).length).toBeGreaterThan(0);
    // The state of the glasses is unknown after an unanswered write: one full re-push once the link answers again.
    expect(bridge.doneOf("page")).toHaveLength(1);
    expect(await within(hud.flush(), 100)).toBeUndefined();
    hud.dispose();
  });

  it("retries after unanswered writes back off (5 s doubling to 30 s) instead of adding a call every deadline", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await mount();
    presentation.setStatus("connected"); await settle(1000);
    bridge.hang.text = Infinity;
    const before = bridge.started.length;
    presentation.setStatus("listening");
    await settle(120_000); // calls at about 0, 20, 45, 80 s
    const calls = bridge.started.slice(before);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.length).toBeLessThanOrEqual(5);
    const gaps = calls.slice(1).map((call, index) => call.at - calls[index]!.at);
    expect(gaps[0]).toBeGreaterThanOrEqual(20_000);
    expect(gaps[1]).toBeGreaterThanOrEqual(25_000);
    expect(gaps[2]).toBeGreaterThanOrEqual(35_000);
    hud.dispose();
  });

  it("an unanswered page rebuild does not hold the queue: repush() settles and text is written afterwards", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await mount();
    presentation.setStatus("connected"); await settle(1000);
    bridge.hang.page = 1;
    expect(await within(hud.repush(), 21_000)).toBe(false);
    presentation.setStatus("listening");
    expect(inSync(hud)).toBe(false);
    await settle(40_000);
    expect(inSync(hud)).toBe(true);
    expect(bridge.doneOf("text").length + bridge.doneOf("page").length).toBeGreaterThan(0);
    expect(await within(hud.flush(), 100)).toBeUndefined();
    hud.dispose();
  });

  it("an unanswered image write does not hold the text queue", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await mount({ images: true, mascotIntervalMs: 50 });
    bridge.hang.image = 1;
    presentation.setStatus("connected"); await settle(3000);
    expect(bridge.startedOf("image").length).toBe(1);
    const before = bridge.done.length;
    presentation.setStatus("listening");
    expect(inSync(hud)).toBe(false);
    await settle(60_000);
    expect(inSync(hud)).toBe(true);
    expect(bridge.done.length).toBeGreaterThan(before);
    hud.dispose();
  });

  it("answers-only renderer: an unanswered write times out, flush() settles and the next frame is sent after a back-off", async () => {
    vi.useFakeTimers();
    const bridge = new HangBridge();
    const errors: Error[] = [];
    const renderer = new GlassesRenderer(bridge, { onError: error => errors.push(error) });
    await renderer.initialize();
    bridge.hang.text = 1;
    renderer.render({ status: "listening", answer: { text: "First answer.", streaming: false, id: "a1" } });
    await settle(500);
    expect(bridge.startedOf("text")).toHaveLength(1);
    expect(await within(renderer.flush(), 16_000)).toBeUndefined();
    expect(errors).toHaveLength(1);
    await settle(2000);
    expect(bridge.startedOf("text")).toHaveLength(1); // backing off, not retrying every debounce
    renderer.render({ status: "listening", answer: { text: "Second answer.", streaming: false, id: "a2" } });
    await settle(1000);
    expect(bridge.startedOf("text")).toHaveLength(1);
    await settle(4000);
    expect(bridge.last("helix-main")).toBe("Second answer.");
    renderer.dispose();
  });
});

describe("v15 diagnostics mirror (finding 13)", () => {
  function hangingStore(hang: number) {
    const calls: { key: string; value: string; at: number }[] = [];
    const releases: (() => void)[] = [];
    const store = {
      getLocalStorage: async () => "",
      setLocalStorage: (key: string, value: string) => {
        calls.push({ key, value, at: Date.now() });
        if (hang > 0) { hang -= 1; return new Promise<boolean>(done => releases.push(() => done(true))); }
        return Promise.resolve(true);
      },
    };
    return { store, calls, releases };
  }

  it("a diagnostics write that is never answered does not stop later ones", async () => {
    vi.useFakeTimers();
    const { store, calls } = hangingStore(1);
    await attachDiagnosticsStore(store);
    recordDiagnostic("stall", "first"); await settle(0);
    expect(calls).toHaveLength(1);
    await settle(1000);
    recordDiagnostic("bridge-stuck", "second");
    await settle(15_000);
    const events = calls.filter(call => call.key === DIAGNOSTICS_STORE_KEY);
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)!.value).toContain("second");
  });

  it("retries back off (5, 10, 20 s) while the bridge stays silent", async () => {
    vi.useFakeTimers();
    const { store, calls } = hangingStore(Infinity);
    await attachDiagnosticsStore(store);
    recordDiagnostic("stall", "one");
    for (let second = 0; second < 60; second++) { recordDiagnostic("stall", `more ${second}`); await settle(1000); }
    // Attempts at 0, 10, 25 and 50 s: a 5 s deadline, then a growing wait.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.length).toBeLessThanOrEqual(4);
  });

  it("the late answer of a timed-out write does not release a newer write that is still in flight", async () => {
    vi.useFakeTimers();
    const { store, calls, releases } = hangingStore(2);
    await attachDiagnosticsStore(store);
    recordDiagnostic("stall", "one");
    await settle(10_500); // first timed out at 5 s, second attempt went out at 10 s and hangs too
    expect(calls).toHaveLength(2);
    releases[0]!(); await settle(10);
    recordDiagnostic("stall", "two");
    await settle(100);
    expect(calls).toHaveLength(2); // one write at a time
  });
});

describe("v15 HUD work per event (finding 16, HUD part)", () => {
  it("composes once per render, also when the answer text changed", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await mount();
    presentation.setStatus("listening");
    presentation.apply(manualQuestion("q1"));
    presentation.apply(delta("a1", "q1", "The lead time is "));
    const compose = vi.spyOn(hud as unknown as { compose(): unknown }, "compose");
    const snapshot = { ...presentation.snapshot() };
    const glasses = { ...snapshot.glasses, answer: { ...snapshot.glasses.answer!, text: `${snapshot.glasses.answer!.text}twelve weeks.` } };
    hud.render(glasses, { ...snapshot, glasses });
    expect(hud.frame.body).toContain("twelve weeks.");
    expect(compose).toHaveBeenCalledTimes(1);
    hud.dispose();
  });

  it("does not hand an unchanged answer to the pager again on unrelated events", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await mount();
    presentation.setStatus("listening");
    presentation.apply(manualQuestion("q1"));
    presentation.apply(completed("a1", "q1", "The lead time is twelve weeks."));
    const body = hud.frame.body;
    expect(body).toContain("twelve weeks.");
    const update = vi.spyOn(AnswerPager.prototype, "update");
    for (let i = 0; i < 6; i++) presentation.apply(partial(`unrelated words ${i}`));
    expect(update).not.toHaveBeenCalled();
    expect(hud.frame.body).toBe(body);
    // A changed answer and a cleared answer still reach the pager.
    presentation.apply(manualQuestion("q2"));
    presentation.apply(delta("a2", "q2", "Another answer."));
    expect(update.mock.calls.length).toBeGreaterThan(0);
    hud.dispose();
  });

  it("no answer: the pager is cleared once, not on every event", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await mount();
    presentation.setStatus("listening");
    const update = vi.spyOn(AnswerPager.prototype, "update");
    for (let i = 0; i < 6; i++) presentation.apply(partial(`words ${i}`));
    expect(update).not.toHaveBeenCalled();
    hud.dispose();
  });
});

describe("v15 answer body pacing (finding 21)", () => {
  it("while an answer streams, the body is written at most every 300 ms", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await mount();
    presentation.setStatus("listening");
    presentation.apply(manualQuestion("q1"));
    await settle(1000);
    const from = bridge.doneOf("text", "hud-body").length;
    for (let i = 0; i < 60; i++) { presentation.apply(delta("a1", "q1", `w${i} `)); await settle(30); }
    const writes = bridge.doneOf("text", "hud-body").slice(from);
    expect(writes.length).toBeGreaterThanOrEqual(3);
    const gaps = writes.slice(1).map((write, index) => write.at - writes[index]!.at);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(300);
    presentation.apply(completed("a1", "q1", Array.from({ length: 60 }, (_, i) => `w${i} `).join("")));
    await settle(600);
    expect(bridge.last("hud-body")).toBe(hud.frame.body);
    hud.dispose();
  });

  it("outside streaming the body keeps the short debounce (view changes stay immediate)", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await mount();
    presentation.setStatus("listening"); await settle(1000);
    hud.setView("summary"); await settle(210);
    expect(bridge.last("hud-body")).toBe(hud.frame.body);
    hud.setView("concepts"); await settle(210);
    expect(bridge.last("hud-body")).toBe(hud.frame.body);
    hud.dispose();
  });
});

describe("v15 caption timestamps (finding 29)", () => {
  it("with more than 200 spoken lines in the feed the caption still expires after the hold time", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await mount({ captionHoldMs: 30_000 });
    presentation.setStatus("listening");
    const lines = Math.min(FEED_LIMIT - 20, 260);
    for (let i = 0; i < lines; i++) presentation.apply(final(`t${i}`, `Spoken line number ${i}.`));
    expect(hud.frame.caption).toContain("Spoken line number");
    await settle(31_000);
    // Unrelated snapshots keep arriving (status, usage, copilot results).
    for (let i = 0; i < 5; i++) { presentation.setInteraction(i % 2 ? "LISTENING" : "THINKING"); await settle(10); }
    expect(hud.frame.caption).not.toContain("Spoken line");
    expect(hud.frame.caption).toContain("double-tap: menu");
    hud.dispose();
  });
});
