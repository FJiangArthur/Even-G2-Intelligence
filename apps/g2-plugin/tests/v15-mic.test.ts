/**
 * v0.15 microphone on-time and control deadlines: a close that is refused or never answered, audio that keeps
 * arriving while the microphone is off, the idle auto-pause, the glasses link, resume ordering and page teardown.
 * The host here is a simulation, so none of this is hardware evidence.
 */
import { AudioEvent, AudioInputSource, AudioSpeakerRole } from "@evenrealities/even_hub_sdk";
import { WebSocketConversationTransport, type DirectConversationOptions } from "@helix/conversation-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installPageTeardown } from "../src/app";
import { G2ConversationController, MIC_IDLE_INTERACTION, MIC_IDLE_PAUSE_MS } from "../src/controller";
import { GlassesRenderer } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";
import { attachDiagnosticsStore, readDiagnostics, resetDiagnosticsForTest } from "../src/diagnostics";
import { resetMicProbeForTest } from "../src/mic-probe";
import { FakeBridge, FakeWebSocket, form } from "./controller-fakes";

type Reply = "ok" | "false" | "throw" | "never";

/** The Even app side: each microphone call can be answered, refused, thrown or never answered. */
class HostBridge extends FakeBridge {
  public closeReply: Reply = "ok";
  public openReply: Reply = "ok";
  public override async audioControl(isOpen: boolean, source?: AudioInputSource): Promise<boolean> {
    await super.audioControl(isOpen, source);
    const reply = isOpen ? this.openReply : this.closeReply;
    if (reply === "never") return new Promise<boolean>(() => undefined);
    if (reply === "throw") throw new Error("bridge gone");
    return reply === "ok";
  }
}

async function start(options: { listen?: boolean; source?: AudioInputSource; repush?: () => Promise<boolean> } = {}) {
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  const doc = { visibilityState: "visible" };
  vi.stubGlobal("document", doc);
  resetDiagnosticsForTest(); resetMicProbeForTest();
  const stored = new Map<string, string>();
  await attachDiagnosticsStore({ getLocalStorage: async key => stored.get(key) ?? "", setLocalStorage: async (key, value) => { stored.set(key, value); return true; } });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: Date.UTC(2026, 10, 22, 20, 0, 0) });
  const bridge = new HostBridge();
  const presentation = new ConversationPresentation();
  const renderer = new GlassesRenderer(bridge);
  if (options.repush) (renderer as unknown as { repush: () => Promise<boolean> }).repush = options.repush;
  let transportOptions: DirectConversationOptions | undefined;
  const resumeAfterSuspend = vi.fn();
  const controller = new G2ConversationController(bridge, renderer, presentation, given => {
    transportOptions = given;
    const transport = new WebSocketConversationTransport({ url: "ws://127.0.0.1:8787/v2/conversations", protocols: ["helix.v2", "helix-auth.c2hvcnQtbGl2ZWQtdG9rZW4"] });
    return Object.assign(transport, { resumeAfterSuspend });
  });
  if (options.source) controller.micSource = options.source;
  await controller.initialize();
  await controller.connect(form);
  const socket = FakeWebSocket.latest!;
  if (options.listen !== false) {
    await controller.startListening();
    await vi.waitFor(() => expect(presentation.snapshot().status).toBe("listening"));
  }
  const frame = (source: AudioInputSource = controller.micSource) =>
    bridge.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array(640).fill(7), source, speakerRole: AudioSpeakerRole.Other }) });
  /** One audio event every 24 ms (42 a second, the measured rate) for `ms`. */
  const deliver = async (ms: number): Promise<void> => {
    for (let elapsed = 0; elapsed < ms; elapsed += 24) { await vi.advanceTimersByTimeAsync(24); frame(); }
  };
  const mic = () => bridge.calls.filter(call => call.startsWith("audio:"));
  const closes = () => mic().filter(call => call.startsWith("audio:false")).length;
  const opens = () => mic().filter(call => call.startsWith("audio:true")).length;
  const log = (kind: string) => readDiagnostics().filter(event => event.kind === kind).map(event => event.detail ?? "");
  const uplink = (state: "paused" | "resumed") => transportOptions!.onUplink!(state);
  const tap = async () => { bridge.emit({ sysEvent: {} }); await vi.advanceTimersByTimeAsync(300); };
  /** Settles `work` while fake time runs, and reports how long it took (ms of fake time, 100 ms steps). */
  const timed = async (work: Promise<unknown>, limitMs = 60_000): Promise<{ ms: number; error?: unknown }> => {
    let done = false, error: unknown;
    void work.then(() => { done = true; }, reason => { done = true; error = reason; });
    let ms = 0;
    for (; !done && ms < limitMs; ms += 100) await vi.advanceTimersByTimeAsync(100);
    if (!done) throw new Error(`still pending after ${limitMs} ms`);
    return { ms, error };
  };
  return { bridge, presentation, controller, socket, doc, frame, deliver, mic, closes, opens, log, uplink, tap, timed, resumeAfterSuspend };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWebSocket.latest = undefined;
  resetDiagnosticsForTest(); resetMicProbeForTest();
});

describe("stop, pause and start never wait forever on the microphone reply", () => {
  it("Stop ends the session when the host refuses the close or the call throws, and asks once more afterwards", async () => {
    for (const reply of ["false", "throw"] as const) {
      const t = await start();
      t.bridge.closeReply = reply;
      const before = t.closes();
      const { error } = await t.timed(t.controller.disconnect());
      expect(error).toBeUndefined();
      expect(t.controller.connected).toBe(false);
      expect(t.socket.readyState).toBe(3);
      expect(t.presentation.snapshot().status).toBe("ready");
      expect(t.closes() - before).toBe(2); // the close, and one best-effort repeat after the session is gone
      expect(t.log("mic-close-unconfirmed")).toHaveLength(1);
      // Audio that still arrives is not accepted into anything.
      const sent = t.socket.sent.length;
      t.frame(); await vi.advanceTimersByTimeAsync(200);
      expect(t.socket.sent.length).toBe(sent);
      // Connect works again (it used to repeat the failing stop every time).
      t.bridge.closeReply = "ok";
      await t.controller.connect(form);
      expect(t.controller.connected).toBe(true);
      await t.controller.dispose();
      vi.useRealTimers(); vi.unstubAllGlobals();
    }
  });

  it("Stop and exit finish within about 2 s when the close is never answered", async () => {
    const t = await start();
    t.bridge.closeReply = "never";
    const stop = await t.timed(t.controller.disconnect());
    expect(stop.error).toBeUndefined();
    expect(stop.ms).toBeLessThanOrEqual(2500);
    expect(t.controller.connected).toBe(false);
    expect(t.presentation.snapshot().status).toBe("ready");
    await t.controller.dispose();

    const again = await start();
    again.bridge.closeReply = "never";
    const exit = await again.timed(again.controller.dispose());
    expect(exit.error).toBeUndefined();
    expect(exit.ms).toBeLessThanOrEqual(2500);
    expect(again.socket.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(30_000); // the diagnostics log saves the line it just got
    expect(vi.getTimerCount()).toBe(0);
  });

  it("Pause: an unanswered close keeps the microphone off and the next control runs; an explicit refusal is still reported", async () => {
    const t = await start();
    t.bridge.closeReply = "never";
    const pause = await t.timed(t.controller.togglePause());
    expect(pause.error).toBeUndefined();
    expect(pause.ms).toBeLessThanOrEqual(3500);
    expect(t.presentation.snapshot().status).toBe("paused");
    expect(t.log("mic-close-unconfirmed")).toHaveLength(1);
    // The control chain moved on: resume works.
    const resume = await t.timed(t.controller.togglePause());
    expect(resume.error).toBeUndefined();
    expect(t.presentation.snapshot().status).toBe("listening");

    t.bridge.closeReply = "false";
    const refused = await t.timed(t.controller.togglePause());
    expect(String(refused.error)).toContain("refused to stop the microphone");
    expect(t.presentation.snapshot().status).toBe("listening");
    t.bridge.closeReply = "ok";
    await t.controller.dispose();
  });

  it("Start: an unanswered open does not block; listening starts and the gap is logged", async () => {
    const t = await start({ listen: false });
    t.bridge.openReply = "never";
    const opened = await t.timed(t.controller.startListening());
    expect(opened.error).toBeUndefined();
    expect(opened.ms).toBeLessThanOrEqual(5500);
    expect(t.presentation.snapshot().status).toBe("listening");
    expect(t.log("mic-open-unconfirmed")).toHaveLength(1);
    // A refusal still fails as before.
    await t.controller.togglePause();
    t.bridge.openReply = "false";
    await expect(t.controller.startListening()).rejects.toThrow("refused to start");
    await t.controller.dispose();
  });
});

describe("audio that keeps arriving while the microphone is off", () => {
  it("re-sends the close, at most once per 5 s, with one diagnostic per episode", async () => {
    const t = await start();
    await t.controller.togglePause();
    const closed = t.closes();
    // A short tail after the close is normal: nothing is re-sent.
    await t.deliver(1000);
    expect(t.closes()).toBe(closed);
    await vi.advanceTimersByTimeAsync(5000);
    // The host never stopped: 42 events a second.
    await t.deliver(2000);
    expect(t.closes()).toBe(closed + 1);
    await t.deliver(3500);
    expect(t.closes()).toBe(closed + 1);
    await t.deliver(4000);
    expect(t.closes()).toBe(closed + 2);
    expect(t.log("mic-stray")).toHaveLength(1);
    expect(t.opens()).toBe(1);
    expect(t.mic().every(call => call.endsWith(AudioInputSource.Glasses))).toBe(true);
    await t.controller.dispose();
  });

  it("covers a microphone this page never opened, and leaves an open that is still in flight alone", async () => {
    const t = await start({ listen: false });
    await t.deliver(2000); // e.g. a reloaded page: the host is still capturing
    expect(t.closes()).toBe(1);
    await vi.advanceTimersByTimeAsync(6000);
    t.bridge.openReply = "never";
    const opening = t.controller.startListening();
    await t.deliver(3000); // audio arrives before the reply to the open
    expect(t.closes()).toBe(1);
    await t.timed(opening);
    await t.controller.dispose();
  });
});

describe("idle auto-pause", () => {
  it("pauses after 10 minutes without speech, says so on the phone and the glasses, and a tap resumes", async () => {
    expect(MIC_IDLE_PAUSE_MS).toBe(10 * 60 * 1000);
    const t = await start();
    t.uplink("paused");
    await vi.advanceTimersByTimeAsync(MIC_IDLE_PAUSE_MS - 15_000);
    expect(t.presentation.snapshot().status).toBe("listening");
    expect(t.closes()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.closes()).toBe(1);
    const snapshot = t.presentation.snapshot();
    expect(snapshot.status).toBe("paused");
    expect(snapshot.glasses.interaction).toBe(MIC_IDLE_INTERACTION);
    expect(snapshot.feed.find(item => item.id === "mic-idle")?.body).toContain("No speech for 10 minutes");
    expect(t.log("mic-idle")).toHaveLength(1);
    // Nothing keeps running while paused.
    await vi.advanceTimersByTimeAsync(MIC_IDLE_PAUSE_MS * 2);
    expect(t.mic()).toHaveLength(2);
    // Glasses tap: listening again.
    await t.tap();
    expect(t.presentation.snapshot().status).toBe("listening");
    expect(t.opens()).toBe(2);
    // Still quiet: it pauses again after another 10 minutes, counted from the resume.
    await vi.advanceTimersByTimeAsync(MIC_IDLE_PAUSE_MS - 15_000);
    expect(t.presentation.snapshot().status).toBe("listening");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.presentation.snapshot().status).toBe("paused");
    // The phone's Resume works as well.
    await t.controller.togglePause();
    expect(t.presentation.snapshot().status).toBe("listening");
    await t.controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not pause while sound keeps the uplink open, during a hold, without an idle signal, or when switched off", async () => {
    const t = await start();
    // No idle signal at all (a transcription profile without the uplink gate).
    await vi.advanceTimersByTimeAsync(MIC_IDLE_PAUSE_MS * 2);
    expect(t.presentation.snapshot().status).toBe("listening");
    // Quiet for 9 minutes, then a sound: the clock starts again at the next quiet.
    t.uplink("paused");
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    t.uplink("resumed");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    t.uplink("paused");
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(t.presentation.snapshot().status).toBe("listening");
    // Hold-to-talk is the wearer's.
    await t.controller.beginHold();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(t.closes()).toBe(0);
    await t.controller.releaseHold();
    // Switched off.
    t.controller.micIdlePauseMs = 0;
    await vi.advanceTimersByTimeAsync(MIC_IDLE_PAUSE_MS * 2);
    expect(t.presentation.snapshot().status).toBe("listening");
    expect(t.closes()).toBe(0);
    t.controller.micIdlePauseMs = MIC_IDLE_PAUSE_MS;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(t.presentation.snapshot().status).toBe("paused");
    await t.controller.dispose();
  });
});

describe("resume from background", () => {
  it("checks the socket first and re-opens the microphone within 3 s when the glasses re-push never answers", async () => {
    const t = await start({ repush: () => new Promise<boolean>(() => undefined) });
    const opened = t.opens();
    const resume = t.controller.resumeFromBackground("visible");
    expect(t.resumeAfterSuspend).toHaveBeenCalledTimes(1); // before anything that waits on the glasses
    const { ms, error } = await t.timed(resume);
    expect(error).toBeUndefined();
    expect(ms).toBeLessThanOrEqual(3500);
    expect(t.opens()).toBe(opened + 1);
    await t.controller.dispose();
  });

  it("a glasses overlay event does not replace the transcription socket; a page resume does", async () => {
    const t = await start();
    await t.controller.resumeFromBackground("foreground-enter");
    await vi.advanceTimersByTimeAsync(2000);
    await t.controller.resumeFromBackground("foreground-exit");
    expect(t.resumeAfterSuspend).not.toHaveBeenCalled();
    expect(t.opens()).toBe(3); // the microphone re-open on a foreground return is unchanged
    await vi.advanceTimersByTimeAsync(2000);
    await t.controller.resumeFromBackground("timer-gap");
    expect(t.resumeAfterSuspend).toHaveBeenCalledWith(10_000);
    await t.controller.dispose();
  });
});

describe("glasses link and a silent microphone", () => {
  it("re-opens the glasses microphone once when the link comes back, and never for the phone microphone or a paused session", async () => {
    const t = await start();
    t.controller.setGlassesLink({ connectType: "connected" }); // first report: no transition
    expect(t.opens()).toBe(1);
    t.controller.setGlassesLink({ connectType: "disconnected", isInCase: true, isWearing: false });
    expect(t.mic()).toHaveLength(1); // away / in case / not worn: logged only, nothing is paused
    expect(t.presentation.snapshot().status).toBe("listening");
    t.controller.setGlassesLink({ connectType: "connected" });
    expect(t.opens()).toBe(2);
    expect(t.log("mic-relink")).toHaveLength(1);
    // A flapping link within 2 s does not repeat it.
    t.controller.setGlassesLink({ connectType: "disconnected" });
    t.controller.setGlassesLink({ connectType: "connected" });
    expect(t.opens()).toBe(2);
    await t.controller.togglePause();
    await vi.advanceTimersByTimeAsync(3000);
    t.controller.setGlassesLink({ connectType: "disconnected" });
    t.controller.setGlassesLink({ connectType: "connected" });
    expect(t.opens()).toBe(2);
    await t.controller.dispose();

    const phone = await start({ source: AudioInputSource.Phone });
    phone.controller.setGlassesLink({ connectType: "disconnected" });
    phone.controller.setGlassesLink({ connectType: "connected" });
    expect(phone.opens()).toBe(1);
    await phone.controller.dispose();
  });

  it("tries one re-open when audio stops for more than 10 s while listening on a visible page", async () => {
    const t = await start();
    await vi.advanceTimersByTimeAsync(60_000); // nothing was ever heard (simulator, tests): left alone
    expect(t.opens()).toBe(1);
    await t.deliver(3000);
    t.doc.visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(30_000); // a hidden page is the resume path's business
    expect(t.opens()).toBe(1);
    t.doc.visibilityState = "visible";
    await vi.advanceTimersByTimeAsync(21_000);
    expect(t.opens()).toBe(2);
    expect(t.log("mic-silent")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(120_000); // one attempt per silence, not a loop
    expect(t.opens()).toBe(2);
    await t.deliver(12_000); // audio is back: armed again
    await vi.advanceTimersByTimeAsync(21_000);
    expect(t.opens()).toBe(3);
    expect(t.closes()).toBe(0);
    await t.controller.dispose();
  });
});

describe("page teardown", () => {
  it("runs once from pagehide or beforeunload, and not for a page kept in the back/forward cache", () => {
    const listeners = new Map<string, (event: { persisted?: boolean }) => void>();
    const target = { addEventListener: (type: string, listener: (event: { persisted?: boolean }) => void) => { listeners.set(type, listener); } };
    const teardown = vi.fn();
    installPageTeardown(target, teardown);
    listeners.get("pagehide")!({ persisted: true });
    expect(teardown).not.toHaveBeenCalled();
    listeners.get("pagehide")!({ persisted: false });
    expect(teardown).toHaveBeenCalledTimes(1);
    listeners.get("beforeunload")!({});
    listeners.get("pagehide")!({ persisted: false });
    expect(teardown).toHaveBeenCalledTimes(1);
  });
});
