/**
 * v0.13.2 on-screen microphone overload guard, microphone source, and their diagnostics.
 * The numbers are the ones measured on a phone (42 audio events a second normally, 25 a second once every
 * call takes ~40 ms); the host here is a simulation, so this is not hardware evidence.
 */
import { AudioEvent, AudioInputSource, AudioSpeakerRole, OsEventTypeList } from "@evenrealities/even_hub_sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUDIO_PING_KEY } from "../src/controller";
import { GlassesRenderer } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";
import { attachDiagnosticsStore, readDiagnostics, resetDiagnosticsForTest } from "../src/diagnostics";
import { micProbeWindow, resetMicProbeForTest } from "../src/mic-probe";
import { FakeBridge, FakeWebSocket, form, testController } from "./controller-fakes";

const NORMAL_MS = 24, SLOW_MS = 40; // 42 events a second, and 25 a second = 60 %

/** The Even app side: a microphone that can be opened and closed, a queue that keeps delivering after a close, and a reply path that can be stuck behind it. */
class HostBridge extends FakeBridge {
  public micOpen = false;
  public source: AudioInputSource = AudioInputSource.Glasses;
  /** false: bridge replies are stuck behind the audio queue (the storage ping is never answered). */
  public repliesPrompt = true;
  public reopenRefused = false;
  /** The reply to the next storage ping is lost; later ones are answered. */
  public loseNextPing = false;
  /** Closing the microphone throws (bridge gone). */
  public closeThrows = false;
  /** Audio events still queued on the host when the microphone is closed. */
  public backlogOnClose = 0;
  public backlog = 0;
  public readonly micTimes: { open: boolean; at: number }[] = [];

  public override async getLocalStorage(key: string): Promise<string> {
    if (key === AUDIO_PING_KEY && (!this.repliesPrompt || this.loseNextPing)) { this.loseNextPing = false; return new Promise<string>(() => undefined); }
    return super.getLocalStorage(key);
  }
  public override async audioControl(isOpen: boolean, source?: AudioInputSource): Promise<boolean> {
    await super.audioControl(isOpen, source);
    if (!isOpen && this.closeThrows) throw new Error("bridge gone");
    this.micTimes.push({ open: isOpen, at: Date.now() });
    if (isOpen && this.reopenRefused) return false;
    if (!isOpen && this.micOpen) this.backlog = this.backlogOnClose;
    this.micOpen = isOpen; if (isOpen && source) this.source = source;
    return true;
  }
}

async function start(options: { source?: AudioInputSource } = {}) {
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  const doc = { visibilityState: "visible" };
  vi.stubGlobal("document", doc);
  resetDiagnosticsForTest(); resetMicProbeForTest();
  const stored = new Map<string, string>();
  await attachDiagnosticsStore({ getLocalStorage: async key => stored.get(key) ?? "", setLocalStorage: async (key, value) => { stored.set(key, value); return true; } });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: Date.UTC(2026, 10, 21, 20, 0, 0) });
  const bridge = new HostBridge();
  const presentation = new ConversationPresentation();
  const controller = testController(bridge, new GlassesRenderer(bridge), presentation);
  controller.audioRealtimeGuard = true;
  const pressure = { bridgePendingMs: 0, timerLateMs: 0 };
  controller.audioPressure = () => pressure;
  if (options.source) controller.micSource = options.source;
  await controller.initialize();
  await controller.connect(form);
  const socket = FakeWebSocket.latest!;
  await controller.startListening();
  await vi.waitFor(() => expect(presentation.snapshot().status).toBe("listening"));
  let emitted = 0;
  const frame = (source: AudioInputSource = bridge.source, role = AudioSpeakerRole.Other) => {
    emitted++;
    bridge.emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array(640).fill(7), source, speakerRole: role }) });
  };
  /** Runs the host for `ms`: one audio event every `gap` ms while the microphone is open, or while its queue still holds events. */
  const deliver = async (ms: number, gap: number): Promise<void> => {
    for (let elapsed = 0; elapsed < ms; elapsed += gap) {
      await vi.advanceTimersByTimeAsync(gap);
      if (bridge.micOpen) frame(); else if (bridge.backlog > 0) { bridge.backlog--; frame(); }
    }
  };
  /** Slow delivery until the guard starts a flush. */
  const overload = async (): Promise<void> => {
    for (let i = 0; i < 1000 && !controller.audioFlushingForLoad; i++) await deliver(SLOW_MS, SLOW_MS);
    expect(controller.audioFlushingForLoad).toBe(true);
  };
  const mic = () => bridge.calls.filter(call => call.startsWith("audio:"));
  const closes = () => mic().filter(call => call.startsWith("audio:false")).length;
  const opens = () => mic().filter(call => call.startsWith("audio:true")).length;
  const bytes = () => socket.sent.filter((item): item is ArrayBuffer => item instanceof ArrayBuffer).reduce((sum, item) => sum + item.byteLength, 0);
  const commits = () => socket.sent.filter((item): item is string => typeof item === "string" && item.includes('"audio.commit"')).length;
  const log = (kind: string) => readDiagnostics().filter(event => event.kind === kind).map(event => event.detail ?? "");
  const emit = (eventType: OsEventTypeList) => bridge.emit({ sysEvent: { eventType } });
  return { bridge, presentation, controller, socket, doc, pressure, frame, deliver, overload, mic, closes, opens, bytes, commits, log, emit, emitted: () => emitted };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWebSocket.latest = undefined;
  resetDiagnosticsForTest(); resetMicProbeForTest();
});

describe("on-screen microphone overload guard", () => {
  it("flushes at ~60 % delivery with bridge replies stuck, and not on jitter, a stream's first seconds, a pause or hold-to-talk gaps", async () => {
    const t = await start();
    const { bridge, controller } = t;
    // A stream that starts slowly (first 1.5 s) and then runs at this phone's normal 42 events a second.
    await t.deliver(1500, 60);
    await t.deliver(8000, NORMAL_MS);
    // From here the bridge would not answer a ping: the cases below must not even ask.
    bridge.repliesPrompt = false;
    // BLE jitter: nothing for 250 ms, then the 11 held frames at once (same average rate).
    for (let i = 0; i < 30; i++) { await vi.advanceTimersByTimeAsync(250); for (let n = 0; n < 11; n++) { await vi.advanceTimersByTimeAsync(2); t.frame(); } }
    // Worse: 700 ms stalls. A 2 s window can then hold too little audio, but it is not continuous delivery.
    for (let i = 0; i < 12; i++) { await vi.advanceTimersByTimeAsync(700); for (let n = 0; n < 30; n++) { await vi.advanceTimersByTimeAsync(1); t.frame(); } }
    // A pause on the phone, and listening again.
    await controller.togglePause();
    await vi.advanceTimersByTimeAsync(3000);
    await controller.togglePause();
    await t.deliver(4000, NORMAL_MS);
    expect(t.closes()).toBe(1); // the pause itself
    await controller.togglePause();
    // Hold-to-talk: 1.2 s of audio, 1.2 s of nothing, five times.
    for (let i = 0; i < 5; i++) {
      await controller.beginHold();
      await t.deliver(1200, NORMAL_MS);
      await controller.releaseHold();
      await vi.advanceTimersByTimeAsync(1200);
    }
    await controller.togglePause();
    await t.deliver(6000, NORMAL_MS);
    expect(controller.audioFlushingForLoad).toBe(false);
    expect(controller.audioPausedForLoad).toBe(false);
    expect(t.log("audio-overload")).toEqual([]);
    const before = t.closes();
    // The measured failure: every call takes ~40 ms, so 25 of 42 events a second get through, back to back.
    await t.deliver(3900, SLOW_MS);
    expect(controller.audioFlushingForLoad).toBe(false); // one slow window is not enough
    await t.deliver(400, SLOW_MS);
    expect(controller.audioFlushingForLoad).toBe(true);
    expect(t.closes()).toBe(before + 1);
    expect(t.mic().at(-1)).toBe(`audio:false:${AudioInputSource.Glasses}`);
    const [overload] = t.log("audio-overload");
    expect(overload).toMatch(/audio at 6\d % of this phone's normal rate \(0\.5\d of 0\.8\d\) for 2 windows · ping \d{4} ms/u);
    expect(overload).toContain("on screen · backlog confirmed · flushing");
    await controller.dispose();
  });

  it("waits until audio events have stopped, ignores the queued ones at no cost, settles the turn, then re-opens without replaying anything", async () => {
    const t = await start();
    const { bridge, controller } = t;
    await t.deliver(8000, NORMAL_MS);
    bridge.repliesPrompt = false;
    bridge.backlogOnClose = 50; // two more seconds of queued events at 25 a second
    const commitsBefore = t.commits();
    await t.overload();
    const closedAt = bridge.micTimes.at(-1)!.at;
    // What was captured before the gap went to the session and the turn was ended, not left half open.
    await vi.waitFor(() => expect(t.commits()).toBe(commitsBefore + 1));
    const sent = t.bytes();
    micProbeWindow(); // start a clean timing window
    await t.deliver(1900, SLOW_MS);
    expect(controller.audioFlushingForLoad).toBe(true); // 1.9 s in: events are still arriving
    expect(t.opens()).toBe(1);
    // The queued events never reached the handler: no conversion, no batch, no timing sample, nothing sent.
    expect(micProbeWindow()).toBeUndefined();
    expect(t.bytes()).toBe(sent);
    await t.deliver(80, SLOW_MS); // the last two queued events; from here it is quiet
    expect(bridge.backlog).toBe(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(controller.audioFlushingForLoad).toBe(true); // quiet for less than 0.5 s
    await vi.advanceTimersByTimeAsync(400);
    expect(controller.audioFlushingForLoad).toBe(false);
    expect(t.mic().at(-1)).toBe(`audio:true:${AudioInputSource.Glasses}`);
    const reopened = bridge.micTimes.at(-1)!;
    expect(reopened.at - closedAt).toBeGreaterThanOrEqual(2400);
    expect(reopened.at - closedAt).toBeLessThanOrEqual(2800);
    expect(t.log("audio-flush")).toEqual([expect.stringMatching(/^microphone closed 2\.\d s · 50 queued audio events discarded · quiet for 5\d\d ms$/u)]);
    expect(t.log("audio-resume")).toEqual(["flush · microphone re-opened"]);
    expect(t.bytes()).toBe(sent);
    // Live audio flows again, each event once.
    const emitted = t.emitted();
    bridge.repliesPrompt = true;
    await t.deliver(2400, NORMAL_MS);
    await controller.togglePause();
    expect(t.bytes() - sent).toBe((t.emitted() - emitted) * 640);
    expect(micProbeWindow()!.mic).toContain("(rate 0 · flush 50 · source 0)");
    await controller.dispose();
  });

  it("re-opens after one second when nothing was queued, and at the latest stops trying after ten seconds of events that never stop", async () => {
    const t = await start();
    const { bridge, controller } = t;
    await t.deliver(8000, NORMAL_MS);
    t.pressure.timerLateMs = 900; // second signal: the 1 s watchdog timer ran 0.9 s late
    await t.overload();
    expect(t.log("audio-overload")[0]).toContain("timer late 900 ms");
    const closedAt = bridge.micTimes.at(-1)!.at;
    await vi.advanceTimersByTimeAsync(900);
    expect(controller.audioFlushingForLoad).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(controller.audioFlushingForLoad).toBe(false);
    expect(bridge.micTimes.at(-1)).toEqual({ open: true, at: closedAt + 1000 });

    // A host that keeps delivering after the close (queue far longer than a flush): close repeated at 3 s, long pause at 10 s.
    t.pressure.timerLateMs = 0; t.pressure.bridgePendingMs = 5000;
    await t.deliver(3800, SLOW_MS);
    expect(controller.audioFlushingForLoad).toBe(false); // no new flush within 4 s of the re-open
    await t.overload();
    const closes = t.closes();
    bridge.backlog = 100_000;
    await t.deliver(3200, SLOW_MS);
    expect(t.closes()).toBe(closes + 1);
    await t.deliver(7000, SLOW_MS);
    expect(controller.audioFlushingForLoad).toBe(false);
    expect(controller.audioPausedForLoad).toBe(true);
    expect(t.log("audio-flush").at(-1)).toMatch(/^not quiet after 10 s · \d+ audio events still arrived/u);
    expect(t.presentation.snapshot().glasses.interaction).toBe("PHONE CAN'T KEEP UP · MIC PAUSED 30 S");
    // During the long pause late events are still ignored, and nothing re-opens early.
    const opens = t.opens(), sent = t.bytes();
    await t.deliver(20_000, SLOW_MS);
    expect(t.opens()).toBe(opens);
    expect(t.bytes()).toBe(sent);
    await controller.dispose();
  });

  it("escalates: the third flush within a minute becomes a 30 s pause with a message on the phone and the glasses, never an open/close loop", async () => {
    const t = await start();
    const { bridge, controller } = t;
    await t.deliver(8000, NORMAL_MS);
    bridge.repliesPrompt = false;
    bridge.backlogOnClose = 10;
    const began = Date.now();
    // The phone stays overloaded: every re-open is followed by slow delivery again.
    for (let i = 0; i < 2000 && !controller.audioPausedForLoad; i++) await t.deliver(SLOW_MS, SLOW_MS);
    expect(controller.audioPausedForLoad).toBe(true);
    expect(Date.now() - began).toBeLessThan(60_000);
    const guardCloses = bridge.micTimes.filter(call => !call.open).map(call => call.at);
    expect(guardCloses).toHaveLength(3);
    // Bounded: at least 4 s of listening between a re-open and the next flush.
    const reopens = bridge.micTimes.filter(call => call.open).map(call => call.at).slice(1);
    expect(reopens).toHaveLength(2);
    expect(guardCloses[1]! - reopens[0]!).toBeGreaterThanOrEqual(4000);
    expect(guardCloses[2]! - reopens[1]!).toBeGreaterThanOrEqual(4000);
    expect(t.log("audio-overload").at(-1)).toMatch(/flush 3 within 60 s · microphone paused · retry in 30 s$/u);
    expect(t.presentation.snapshot().glasses.interaction).toBe("PHONE CAN'T KEEP UP · MIC PAUSED 30 S");
    const notice = t.presentation.snapshot().feed.find(item => item.id === "audio-overload");
    expect(notice?.body).toContain("not keeping up with the microphone audio");
    // A glasses event (or any "page is visible" signal) does not undo a pause that began on screen.
    await vi.advanceTimersByTimeAsync(2000);
    await controller.resumeFromBackground("foreground-enter");
    expect(controller.audioPausedForLoad).toBe(true);
    await vi.advanceTimersByTimeAsync(27_000);
    expect(t.opens()).toBe(3);
    await vi.advanceTimersByTimeAsync(1500);
    expect(controller.audioPausedForLoad).toBe(false);
    expect(t.mic().at(-1)).toBe(`audio:true:${AudioInputSource.Glasses}`);
    expect(t.log("audio-resume").at(-1)).toBe("retry · microphone re-opened");
    await controller.dispose();
  });

  it("without a second signal, flushes only after 16 s of slow continuous delivery and at most once a minute", async () => {
    const t = await start();
    const { controller } = t;
    await t.deliver(8000, NORMAL_MS);
    // Slow and continuous, but the bridge answers at once (a weak glasses link looks like this).
    await t.deliver(15_500, SLOW_MS);
    expect(t.closes()).toBe(0);
    await t.deliver(1000, SLOW_MS);
    expect(controller.audioFlushingForLoad).toBe(true);
    expect(t.log("audio-overload")).toEqual([expect.stringContaining("for 8 windows · ping 0 ms · bridge pending 0 ms · timer late 0 ms · on screen · no second signal · flushing")]);
    await t.deliver(45_000, SLOW_MS);
    expect(t.closes()).toBe(1);
    expect(controller.audioPausedForLoad).toBe(false);
    // Still slow a minute later with no second signal at any point: this is how the link is, and the
    // baseline has followed it down. No further flush, and unconfirmed flushes never escalate.
    await t.deliver(60_000, SLOW_MS);
    expect(t.closes()).toBe(1);
    expect(controller.audioPausedForLoad).toBe(false);
    await controller.dispose();
  });

  it("baseline: a burst after opening teaches nothing, a slower healthy stream is followed down, and a slide with a backlog signal is not", async () => {
    // (a) The host hands over buffered frames after the open: 6 s at 125 % of real time, then the normal 42 a second.
    const burst = await start();
    burst.pressure.timerLateMs = 900; // an unrelated late timer must not turn a wrong baseline into flushes
    await burst.deliver(6000, 16);
    await burst.deliver(40_000, NORMAL_MS);
    expect(burst.closes()).toBe(0);
    expect(burst.log("audio-overload")).toEqual([]);
    await burst.controller.dispose();
    vi.useRealTimers(); FakeWebSocket.latest = undefined;

    // (b) Healthy at 42 a second, later healthy at 34 a second (no second signal): that is the new normal,
    // so an overload is then measured against it.
    const slower = await start();
    await slower.deliver(8000, NORMAL_MS);
    await slower.deliver(30_000, 29);
    expect(slower.closes()).toBe(0);
    slower.bridge.repliesPrompt = false;
    for (let i = 0; i < 400 && !slower.controller.audioFlushingForLoad; i++) await slower.deliver(50, 50); // 60 % of the new normal
    expect(slower.controller.audioFlushingForLoad).toBe(true);
    expect(slower.log("audio-overload")[0]).toMatch(/\(0\.\d\d of 0\.(?:6[6-9]|70)\)/u);
    await slower.controller.dispose();
    vi.useRealTimers(); FakeWebSocket.latest = undefined;

    // (c) Delivery sliding down step by step while bridge calls are stuck: never learned as normal.
    const slide = await start();
    await slide.deliver(8000, NORMAL_MS);
    slide.pressure.bridgePendingMs = 5000;
    for (const gap of [27, 30, 34]) await slide.deliver(6000, gap);
    expect(slide.closes()).toBe(1);
    expect(slide.log("audio-overload")[0]).toMatch(/of 0\.8\d\)/u);
    await slide.controller.dispose();
  });

  it("a lost ping reply is one bad sample, not permanent proof of a backlog", async () => {
    const t = await start();
    const { bridge, controller } = t;
    await t.deliver(8000, NORMAL_MS);
    // Slow link, and the first ping's reply never comes: that one counts, and the flush uses it up.
    bridge.loseNextPing = true;
    await t.overload();
    await vi.advanceTimersByTimeAsync(1200);
    expect(controller.audioFlushingForLoad).toBe(false);
    // The next pings are answered at once, so the same slow delivery is no longer "confirmed".
    await t.deliver(12_000, SLOW_MS);
    expect(t.closes()).toBe(1);
    expect(controller.audioPausedForLoad).toBe(false);

    // Lost while no flush can happen (a hold): it times out after 10 s and a new ping is sent.
    await t.deliver(70_000, NORMAL_MS);
    await controller.beginHold();
    bridge.loseNextPing = true;
    await t.deliver(13_000, SLOW_MS);
    expect(bridge.loseNextPing).toBe(false); // it was asked, and lost
    await controller.releaseHold();
    await t.deliver(8000, NORMAL_MS);
    await t.deliver(6000, SLOW_MS);
    expect(t.closes()).toBe(1);
    expect(controller.audioFlushingForLoad).toBe(false);
    await controller.dispose();
  });

  it("dispose stops the guard even when closing the microphone throws, and a flush poll never outlives the controller", async () => {
    const t = await start();
    const { bridge, controller } = t;
    await t.deliver(8000, NORMAL_MS);
    bridge.repliesPrompt = false;
    bridge.backlogOnClose = 100_000;
    await t.overload();
    bridge.closeThrows = true;
    await controller.dispose().catch(() => undefined);
    expect(controller.audioFlushingForLoad).toBe(false);
    const calls = t.mic().length;
    await t.deliver(15_000, SLOW_MS); // the host keeps delivering; past the 3 s repeat and the 10 s limit
    expect(t.mic().length).toBe(calls);
    expect(controller.audioPausedForLoad).toBe(false);
  });

  it("re-opens once the session is active again when it was not at the end of a flush", async () => {
    const t = await start();
    const { bridge, controller } = t;
    await t.deliver(8000, NORMAL_MS);
    bridge.repliesPrompt = false;
    await t.overload();
    const client = (controller as unknown as { client: { state: string } }).client;
    let state = "connecting";
    Object.defineProperty(client, "state", { configurable: true, get: () => state });
    const opens = t.opens();
    await vi.advanceTimersByTimeAsync(1500);
    expect(controller.audioFlushingForLoad).toBe(false);
    expect(t.opens()).toBe(opens);
    expect(t.log("audio-resume").at(-1)).toBe("flush · session not active · retry in 5 s");
    await vi.advanceTimersByTimeAsync(5500); // first retry: still not active, tried again later (not dropped)
    expect(t.opens()).toBe(opens);
    expect(controller.audioPausedForLoad).toBe(true);
    state = "active";
    await vi.advanceTimersByTimeAsync(31_000);
    expect(t.opens()).toBe(opens + 1);
    expect(bridge.micOpen).toBe(true);
    expect(controller.audioPausedForLoad).toBe(false);
    await controller.dispose();
  });

  it("an on-screen pause ends when the page comes back from hidden (unlock), not on a glasses event, and tolerates an event without PCM", async () => {
    const t = await start();
    const { bridge, controller } = t;
    await t.deliver(8000, NORMAL_MS);
    bridge.repliesPrompt = false;
    bridge.backlogOnClose = 10;
    for (let i = 0; i < 2000 && !controller.audioPausedForLoad; i++) await t.deliver(SLOW_MS, SLOW_MS);
    expect(controller.audioPausedForLoad).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    await controller.resumeFromBackground("foreground-enter");
    expect(controller.audioPausedForLoad).toBe(true);
    // Locked and unlocked.
    t.doc.visibilityState = "hidden";
    await vi.advanceTimersByTimeAsync(3000);
    t.doc.visibilityState = "visible";
    const opens = t.opens();
    await controller.resumeFromBackground("visible");
    expect(controller.audioPausedForLoad).toBe(false);
    expect(t.opens()).toBe(opens + 1);
    expect(t.log("audio-resume").at(-1)).toMatch(/^visible · .*microphone re-opened$/u);
    // Still overloaded: caught again, but not within 4 s of that re-open.
    const reopenedAt = bridge.micTimes.at(-1)!.at;
    for (let i = 0; i < 2000 && !controller.audioFlushingForLoad && !controller.audioPausedForLoad; i++) await t.deliver(SLOW_MS, SLOW_MS);
    expect(bridge.micTimes.at(-1)!.open).toBe(false);
    expect(bridge.micTimes.at(-1)!.at - reopenedAt).toBeGreaterThanOrEqual(4000);
    expect(() => (controller as unknown as { receiveAudio: (audio: object) => void }).receiveAudio({ source: AudioInputSource.Glasses })).not.toThrow();
    await controller.dispose();
  });

  it("explicit pause, start, hold and stop win over the guard, a refused re-open is retried slowly, and dispose leaves no timer behind", async () => {
    const t = await start();
    const { bridge, controller, presentation } = t;
    await t.deliver(8000, NORMAL_MS);
    bridge.repliesPrompt = false;
    const flush = t.overload;

    // Pause during a flush: paused, and the guard never re-opens the microphone.
    await flush();
    await controller.togglePause();
    expect(presentation.snapshot().status).toBe("paused");
    expect(controller.audioFlushingForLoad).toBe(false);
    const opens = t.opens();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.opens()).toBe(opens);

    // Resume, overload again, then a hold on the glasses: the microphone opens at once and stays open for the hold.
    await controller.togglePause();
    await t.deliver(4000, NORMAL_MS);
    await flush();
    t.emit(OsEventTypeList.LONG_PRESS_EVENT);
    await vi.waitFor(() => expect(presentation.snapshot().glasses.interaction).toContain("HOLDING"));
    expect(controller.audioFlushingForLoad).toBe(false);
    expect(t.mic().at(-1)).toBe(`audio:true:${AudioInputSource.Glasses}`);
    expect(t.log("audio-resume").at(-1)).toBe("hold · microphone re-opened");
    const duringHold = t.closes();
    await t.deliver(12_000, SLOW_MS); // slow for the whole hold: the turn is the wearer's
    expect(t.closes()).toBe(duringHold);
    t.emit(OsEventTypeList.LONG_PRESS_RELEASE_EVENT);
    await vi.waitFor(() => expect(presentation.snapshot().glasses.interaction).toMatch(/SENT|NO NEW AUDIO/u));

    // A refused re-open: one retry after 5 s, not a loop.
    await flush();
    bridge.reopenRefused = true;
    const tries = t.opens();
    await vi.advanceTimersByTimeAsync(1200);
    expect(t.opens()).toBe(tries + 1);
    expect(controller.audioPausedForLoad).toBe(true);
    expect(t.log("audio-resume").at(-1)).toBe("flush · re-open refused · retry in 5 s");
    await vi.advanceTimersByTimeAsync(4000);
    expect(t.opens()).toBe(tries + 1);
    // Start pressed while the guard holds the microphone closed: opened now.
    bridge.reopenRefused = false;
    await controller.startListening();
    expect(controller.audioPausedForLoad).toBe(false);
    expect(t.log("audio-resume").at(-1)).toBe("start · microphone re-opened");
    expect(bridge.micOpen).toBe(true);

    // Stop during a flush: nothing re-opens afterwards, and the next session starts clean.
    await t.deliver(9000, NORMAL_MS);
    await flush();
    await controller.disconnect();
    expect(controller.audioFlushingForLoad).toBe(false);
    const afterStop = bridge.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bridge.calls.filter(call => call.startsWith("audio:")).length).toBe(bridge.calls.slice(0, afterStop).filter(call => call.startsWith("audio:")).length);

    // Dispose during a flush clears the guard's timers.
    await controller.connect(form);
    await controller.startListening();
    bridge.repliesPrompt = false;
    await t.deliver(8000, NORMAL_MS);
    await flush();
    await controller.dispose();
    const micCalls = t.mic().length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.mic().length).toBe(micCalls);
    expect(t.mic().at(-1)).toBe(`audio:false:${AudioInputSource.Glasses}`);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("microphone source", () => {
  it("uses the selected microphone at every open and close, ignores the other one's frames, and labels phone audio as an unknown speaker", async () => {
    const t = await start({ source: AudioInputSource.Phone });
    const { bridge, controller, socket } = t;
    expect(t.mic()).toEqual([`audio:true:${AudioInputSource.Phone}`]);
    // Glasses frames still arriving (or a host that never switched): ignored.
    for (let i = 0; i < 50; i++) { await vi.advanceTimersByTimeAsync(NORMAL_MS); t.frame(AudioInputSource.Glasses); }
    await vi.advanceTimersByTimeAsync(300);
    expect(t.bytes()).toBe(0);
    // Phone frames carry no speaker direction: accepted, speaker "unknown".
    for (let i = 0; i < 50; i++) { await vi.advanceTimersByTimeAsync(NORMAL_MS); t.frame(AudioInputSource.Phone, AudioSpeakerRole.Unknown); }
    await vi.waitFor(() => expect(t.bytes()).toBe(50 * 640));
    const frames = socket.sent.filter((item): item is string => typeof item === "string").map(item => JSON.parse(item) as { type: string; source?: string; speakerRole?: string }).filter(item => item.type === "audio.frame");
    expect(new Set(frames.map(item => item.source))).toEqual(new Set(["phone"]));
    expect(new Set(frames.map(item => item.speakerRole))).toEqual(new Set(["unknown"]));
    expect(micProbeWindow()!.mic).toContain("(rate 0 · flush 0 · source 50)");
    // Pause and resume, the overload flush, and its re-open all name the phone microphone.
    await controller.togglePause();
    await controller.togglePause();
    await t.deliver(8000, NORMAL_MS);
    bridge.repliesPrompt = false;
    await t.deliver(4300, SLOW_MS);
    expect(controller.audioFlushingForLoad).toBe(true);
    await vi.advanceTimersByTimeAsync(1200);
    expect(t.mic()).toEqual(["audio:true:phone", "audio:false:phone", "audio:true:phone", "audio:false:phone", "audio:true:phone"]);
    // Switching while listening closes the old microphone and opens the new one.
    bridge.repliesPrompt = true;
    await controller.setMicSource(AudioInputSource.Glasses);
    expect(t.mic().slice(-2)).toEqual(["audio:false:phone", "audio:true:glasses"]);
    expect(controller.micSource).toBe(AudioInputSource.Glasses);
    expect(t.log("mic-source")).toEqual(["glasses"]);
    const sent = t.bytes();
    for (let i = 0; i < 10; i++) { await vi.advanceTimersByTimeAsync(NORMAL_MS); t.frame(AudioInputSource.Phone); } // late phone frames
    await vi.advanceTimersByTimeAsync(300);
    expect(t.bytes()).toBe(sent);
    await t.deliver(1000, NORMAL_MS);
    await vi.waitFor(() => expect(t.bytes()).toBeGreaterThan(sent));
    await controller.dispose();
    expect(t.mic().at(-1)).toBe("audio:false:glasses");
  });

  it("says so when only the other microphone's audio arrives", async () => {
    const t = await start({ source: AudioInputSource.Phone });
    for (let i = 0; i < 160; i++) { await vi.advanceTimersByTimeAsync(NORMAL_MS); t.frame(AudioInputSource.Glasses); }
    expect(t.log("mic-source-mismatch")).toEqual(["selected phone, but 150 audio events tagged glasses and none tagged phone"]);
    expect(t.presentation.snapshot().feed.find(item => item.id === "mic-source")?.body).toContain("No audio from the phone microphone");
    expect(t.bytes()).toBe(0);
    await t.controller.dispose();
  });
});
