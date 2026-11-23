/**
 * v0.15 microphone review fixes: a slow (not refused) re-open after the overload guard, an open that is
 * never confirmed and never delivers audio, a late refusal, one re-open per return from background, and an
 * idle clock that short sounds do not restart. The host here is a simulation, so none of this is hardware evidence.
 */
import { AudioEvent, AudioInputSource, AudioSpeakerRole } from "@evenrealities/even_hub_sdk";
import { WebSocketConversationTransport, type DirectConversationOptions } from "@helix/conversation-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { G2ConversationController, MIC_IDLE_PAUSE_MS } from "../src/controller";
import { GlassesRenderer } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";
import { attachDiagnosticsStore, readDiagnostics, resetDiagnosticsForTest } from "../src/diagnostics";
import { resetMicProbeForTest } from "../src/mic-probe";
import { FakeBridge, FakeWebSocket, form } from "./controller-fakes";

type Reply = "ok" | "false" | "throw" | "never";

/** The Even app side: the reply to an open can be late (it waits behind queued audio events), refused, thrown or missing. */
class SlowHost extends FakeBridge {
  public openReply: Reply = "ok";
  public openDelayMs = 0;
  public override async audioControl(isOpen: boolean, source?: AudioInputSource): Promise<boolean> {
    await super.audioControl(isOpen, source);
    if (!isOpen) return true;
    const reply = this.openReply, delay = this.openDelayMs;
    if (reply === "never") return new Promise<boolean>(() => undefined);
    if (delay > 0) await new Promise<void>(done => { setTimeout(done, delay); });
    if (reply === "throw") throw new Error("bridge gone");
    return reply === "ok";
  }
}

async function start(options: { listen?: boolean; repush?: () => Promise<boolean> } = {}) {
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  const doc = { visibilityState: "visible" };
  vi.stubGlobal("document", doc);
  resetDiagnosticsForTest(); resetMicProbeForTest();
  const stored = new Map<string, string>();
  await attachDiagnosticsStore({ getLocalStorage: async key => stored.get(key) ?? "", setLocalStorage: async (key, value) => { stored.set(key, value); return true; } });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: Date.UTC(2026, 10, 22, 20, 0, 0) });
  const bridge = new SlowHost();
  const presentation = new ConversationPresentation();
  const renderer = new GlassesRenderer(bridge);
  if (options.repush) (renderer as unknown as { repush: () => Promise<boolean> }).repush = options.repush;
  let transportOptions: DirectConversationOptions | undefined;
  const controller = new G2ConversationController(bridge, renderer, presentation, given => {
    transportOptions = given;
    return new WebSocketConversationTransport({ url: "ws://127.0.0.1:8787/v2/conversations", protocols: ["helix.v2", "helix-auth.c2hvcnQtbGl2ZWQtdG9rZW4"] });
  });
  await controller.initialize();
  await controller.connect(form);
  const socket = FakeWebSocket.latest!;
  let listeningAt = 0;
  if (options.listen !== false) {
    await controller.startListening();
    listeningAt = Date.now();
    await vi.waitFor(() => expect(presentation.snapshot().status).toBe("listening"));
  }
  const frame = () => bridge.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array(640).fill(7), source: controller.micSource, speakerRole: AudioSpeakerRole.Other }) });
  /** One audio event every 24 ms (42 a second, the measured rate) for `ms`. */
  const deliver = async (ms: number): Promise<void> => {
    for (let elapsed = 0; elapsed < ms; elapsed += 24) { await vi.advanceTimersByTimeAsync(24); frame(); }
  };
  const opens = () => bridge.calls.filter(call => call.startsWith("audio:true")).length;
  const closes = () => bridge.calls.filter(call => call.startsWith("audio:false")).length;
  const log = (kind: string) => readDiagnostics().filter(event => event.kind === kind).map(event => event.detail ?? "");
  const uplink = (state: "paused" | "resumed") => transportOptions!.onUplink!(state);
  /** Puts the overload guard into its long pause, as trackAudioLoad does on a phone that cannot keep up. */
  const overload = () => (controller as unknown as { suspendAudioForLoad(hidden: boolean, detail: string): void }).suspendAudioForLoad(false, "test overload");
  /** Settles `work` while fake time runs, and reports how long it took (ms of fake time, 100 ms steps). */
  const timed = async (work: Promise<unknown>, limitMs = 60_000): Promise<{ ms: number; error?: unknown }> => {
    let done = false, error: unknown;
    void work.then(() => { done = true; }, reason => { done = true; error = reason; });
    let ms = 0;
    for (; !done && ms < limitMs; ms += 100) await vi.advanceTimersByTimeAsync(100);
    if (!done) throw new Error(`still pending after ${limitMs} ms`);
    return { ms, error };
  };
  /** Advances fake time to `beforeMs` before the next 10 s microphone check. */
  const untilWatch = async (beforeMs: number): Promise<void> => {
    const phase = (Date.now() - listeningAt) % 10_000;
    await vi.advanceTimersByTimeAsync((20_000 - phase - beforeMs) % 10_000);
  };
  return { bridge, presentation, controller, socket, doc, frame, deliver, opens, closes, log, uplink, overload, timed, untilWatch };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWebSocket.latest = undefined;
  resetDiagnosticsForTest(); resetMicProbeForTest();
});

describe("re-open after the overload guard when the host answers late", () => {
  it("a reply later than 5 s is not a refusal: audio is accepted when it comes and no second open is sent", async () => {
    const t = await start();
    t.overload();
    expect(t.controller.audioPausedForLoad).toBe(true);
    const opened = t.opens();
    t.bridge.openDelayMs = 8000; // the open is queued in the host and does open the microphone
    const resume = await t.timed(t.controller.resumeFromBackground("visible"));
    expect(resume.error).toBeUndefined();
    expect(resume.ms).toBeLessThanOrEqual(5500); // the caller is still not held for longer than the deadline
    expect(t.controller.audioPausedForLoad).toBe(false);
    expect(t.log("audio-resume").join("\n")).not.toContain("refused");
    await vi.advanceTimersByTimeAsync(3000); // the host opens the microphone at 8 s
    const sent = t.socket.sent.length;
    await t.deliver(2000);
    expect(t.socket.sent.length).toBeGreaterThan(sent); // live audio, not discarded as backlog
    await t.deliver(60_000); // past the 5 s and 30 s retries a refusal would have scheduled
    expect(t.opens()).toBe(opened + 1);
    expect(t.controller.audioPausedForLoad).toBe(false);
    await t.controller.dispose();
  });

  it("a hold during the pause is not left with its audio discarded when the open is slow", async () => {
    const t = await start();
    t.overload();
    t.bridge.openDelayMs = 8000;
    const hold = await t.timed(t.controller.beginHold());
    expect(hold.error).toBeUndefined();
    expect(t.controller.audioPausedForLoad).toBe(false);
    const sent = t.socket.sent.length;
    await t.deliver(2000);
    expect(t.socket.sent.length).toBeGreaterThan(sent);
    await t.controller.dispose();
  });

  it("a refusal is still retried, also when it arrives after the deadline", async () => {
    for (const delay of [0, 8000]) {
      const t = await start();
      t.overload();
      const opened = t.opens();
      t.bridge.openReply = "false"; t.bridge.openDelayMs = delay;
      await t.timed(t.controller.resumeFromBackground("visible"));
      await vi.advanceTimersByTimeAsync(4000); // past the late answer
      expect(t.controller.audioPausedForLoad).toBe(true);
      expect(t.log("audio-resume").join("\n")).toContain("re-open refused");
      t.bridge.openReply = "ok"; t.bridge.openDelayMs = 0;
      await vi.advanceTimersByTimeAsync(6000); // the 5 s retry
      expect(t.controller.audioPausedForLoad).toBe(false);
      expect(t.opens()).toBe(opened + 2);
      await t.controller.dispose();
      vi.useRealTimers(); vi.unstubAllGlobals();
    }
  });
});

describe("an open that is never confirmed", () => {
  it("is tried once more when no audio arrives, and then the user is told", async () => {
    const t = await start({ listen: false });
    t.bridge.openReply = "never";
    await t.timed(t.controller.startListening());
    expect(t.presentation.snapshot().status).toBe("listening");
    expect(t.opens()).toBe(1);
    await vi.advanceTimersByTimeAsync(26_000);
    expect(t.opens()).toBe(2); // one more open, not a loop
    expect(t.log("mic-silent")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(t.presentation.snapshot().feed.find(item => item.id === "mic-silent")?.body).toContain("No audio");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.opens()).toBe(2);
    expect(t.log("mic-silent")).toHaveLength(2); // the retry and the warning, once each
    await t.controller.dispose();
  });

  it("is left alone when audio arrives or the reply comes late", async () => {
    const audio = await start({ listen: false });
    audio.bridge.openReply = "never";
    await audio.timed(audio.controller.startListening());
    await audio.deliver(40_000);
    expect(audio.opens()).toBe(1);
    expect(audio.log("mic-silent")).toHaveLength(0);
    await audio.controller.dispose();
    vi.useRealTimers(); vi.unstubAllGlobals();

    const late = await start({ listen: false });
    late.bridge.openDelayMs = 8000; // confirmed at 8 s: as after any confirmed open, a microphone never heard is left alone
    await late.timed(late.controller.startListening());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(late.opens()).toBe(1);
    expect(late.log("mic-silent")).toHaveLength(0);
    expect(late.presentation.snapshot().status).toBe("listening");
    await late.controller.dispose();
  });

  it("a refusal or failure that arrives after the deadline ends listening and says so; Resume works again", async () => {
    for (const reply of ["false", "throw"] as const) {
      const t = await start({ listen: false });
      t.bridge.openReply = reply; t.bridge.openDelayMs = 7000;
      await t.timed(t.controller.startListening());
      expect(t.presentation.snapshot().status).toBe("listening");
      await vi.advanceTimersByTimeAsync(3000);
      const snapshot = t.presentation.snapshot();
      expect(snapshot.status).toBe("paused");
      expect(snapshot.feed.find(item => item.id === "mic-open")?.body).toContain("did not start");
      expect(t.log("mic-open-refused")).toHaveLength(1);
      // Nothing keeps running for a microphone that is off.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(t.opens()).toBe(1);
      t.bridge.openReply = "ok"; t.bridge.openDelayMs = 0;
      await t.controller.togglePause();
      expect(t.presentation.snapshot().status).toBe("listening");
      await t.controller.dispose();
      vi.useRealTimers(); vi.unstubAllGlobals();
    }
  });

  it("a late refusal is not believed once audio is arriving", async () => {
    const t = await start({ listen: false });
    t.bridge.openReply = "false"; t.bridge.openDelayMs = 7000;
    await t.timed(t.controller.startListening());
    await t.deliver(4000);
    expect(t.presentation.snapshot().status).toBe("listening");
    await t.controller.dispose();
  });
});

describe("return from background sends one microphone open", () => {
  it("the overdue check that fires as the page thaws leaves the re-open to resumeFromBackground", async () => {
    const t = await start({ repush: () => new Promise<boolean>(done => { setTimeout(() => done(true), 2000); }) });
    await t.deliver(3000);
    const opened = t.opens();
    t.doc.visibilityState = "hidden";
    vi.setSystemTime(Date.now() + 30_000); // locked: the page is suspended, no timer runs
    t.doc.visibilityState = "visible";
    await t.untilWatch(0); // the overdue check runs first
    await vi.advanceTimersByTimeAsync(1);
    expect(t.opens()).toBe(opened);
    await t.timed(t.controller.resumeFromBackground("visible"));
    await vi.advanceTimersByTimeAsync(9000);
    expect(t.opens()).toBe(opened + 1);
    expect(t.log("mic-silent")).toHaveLength(0);
    // Still no audio after the re-open: the check does act then.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.opens()).toBe(opened + 2);
    await t.controller.dispose();
  });

  it("a check that runs while the glasses re-push is awaited does not open as well", async () => {
    const t = await start({ repush: () => new Promise<boolean>(() => undefined) });
    await t.deliver(3000);
    const opened = t.opens();
    t.doc.visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(30_000); // hidden but not suspended: timers still run
    await t.untilWatch(1000);
    t.doc.visibilityState = "visible";
    const resume = t.controller.resumeFromBackground("visible"); // waits up to 3 s for the re-push
    await vi.advanceTimersByTimeAsync(1500); // the 10 s check fires in between
    expect(t.opens()).toBe(opened);
    await t.timed(resume);
    expect(t.opens()).toBe(opened + 1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.opens()).toBe(opened + 1);
    expect(t.log("mic-silent")).toHaveLength(0);
    await t.controller.dispose();
  });
});

describe("idle auto-pause in a room that is not perfectly silent", () => {
  it("a short sound every few minutes does not restart the 10 minutes", async () => {
    const t = await start();
    t.uplink("paused");
    // A door, a keyboard, a phone buzz: one frame above the gate, which closes again 3 s later.
    for (let minute = 3; minute <= 9; minute += 3) {
      await vi.advanceTimersByTimeAsync(3 * 60_000 - 3000);
      t.uplink("resumed");
      await vi.advanceTimersByTimeAsync(3000);
      t.uplink("paused");
    }
    expect(t.presentation.snapshot().status).toBe("listening");
    await vi.advanceTimersByTimeAsync(75_000);
    expect(t.presentation.snapshot().status).toBe("paused");
    expect(t.log("mic-idle")).toHaveLength(1);
    await t.controller.dispose();
  });

  it("sound that keeps the uplink open for a while still does, and so does a transcript", async () => {
    const t = await start();
    t.uplink("paused");
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    t.uplink("resumed");
    await vi.advanceTimersByTimeAsync(30_000); // half a minute of sound
    t.uplink("paused");
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(t.presentation.snapshot().status).toBe("listening");
    expect(t.closes()).toBe(0);
    await vi.advanceTimersByTimeAsync(75_000);
    expect(t.presentation.snapshot().status).toBe("paused");
    expect(MIC_IDLE_PAUSE_MS).toBe(600_000);
    await t.controller.dispose();
  });
});
