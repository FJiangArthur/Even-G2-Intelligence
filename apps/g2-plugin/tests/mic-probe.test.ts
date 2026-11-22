import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachDiagnosticsStore, diagnosticsReport, mainThreadPressure, monitorBridge, recordMicWindow, resetDiagnosticsForTest } from "../src/diagnostics";
import {
  installMicProbe, micEntryObserved, micHandlerBegin, micHandlerEnd, micProbeState, micProbeWindow, noteMicDropped, noteMicSend,
  resetMicProbeForTest, setSdkAudioLogQuiet,
} from "../src/mic-probe";

/** A stand-in for the page: the SDK 0.0.14 entry function, its per-event console line and its window event. */
function fakePage(clock: { now: number }, costs = { decode: 0.4, log: 0.2, ours: 0.1, after: 0.05 }) {
  const target = new EventTarget() as EventTarget & Record<string, unknown>;
  const logged: unknown[][] = [];
  const logger = { log: (...args: unknown[]) => { clock.now += costs.log; logged.push(args); } };
  const handled: number[] = [];
  let handle = true;
  // What the bridge's onEvenHubEvent listener does: hand the audio to the app.
  target.addEventListener("evenHubEvent", event => {
    const audio = (event as CustomEvent<{ audioEvent?: { audioPcm: Uint8Array } }>).detail.audioEvent;
    if (!audio || !handle) return;
    const began = micHandlerBegin(audio.audioPcm.byteLength);
    clock.now += costs.ours; handled.push(audio.audioPcm.byteLength);
    micHandlerEnd(began);
  });
  const seenByOriginal: unknown[] = [];
  const original = function (this: unknown, message: unknown): string {
    seenByOriginal.push(message);
    const parsed = (typeof message === "string" ? JSON.parse(message) : message) as { data: { jsonData: { audioPcm?: string | number[]; other?: boolean } } };
    clock.now += costs.decode;
    const pcm = parsed.data.jsonData.audioPcm;
    const detail = pcm === undefined ? { textEvent: {} } : { audioEvent: { audioPcm: typeof pcm === "string" ? Uint8Array.from(atob(pcm), c => c.charCodeAt(0)) : Uint8Array.from(pcm), source: "glasses" } };
    logger.log("[EvenAppBridge] EvenHub event:", detail);
    target.dispatchEvent(new CustomEvent("evenHubEvent", { detail }));
    clock.now += costs.after;
    return "handled";
  };
  target._listenEvenAppMessage = original;
  const audio = (bytes: number, shape: "base64" | "numbers" = "base64") => ({ type: "listen_even_app_data", method: "evenHubEvent",
    data: { type: "audioEvent", jsonData: { source: "glasses", audioPcm: shape === "base64" ? btoa(String.fromCharCode(...new Uint8Array(bytes))) : Array.from(new Uint8Array(bytes)) } } });
  const push = (message: unknown): unknown => (target._listenEvenAppMessage as (message: unknown) => unknown)(message);
  return { target, logger, logged, handled, seenByOriginal, original, audio, push, ignoreAudio: () => { handle = false; } };
}

describe("microphone probe", () => {
  const clock = { now: 1000 };
  beforeEach(() => { clock.now = 1000; vi.spyOn(performance, "now").mockImplementation(() => clock.now); resetMicProbeForTest(); resetDiagnosticsForTest(); });
  afterEach(() => { resetMicProbeForTest(); resetDiagnosticsForTest(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("splits one host call into SDK decode, our handler and the SDK console line, and reports gaps, payload size and drops per window", () => {
    const page = fakePage(clock);
    installMicProbe(page.target as never, page.logger);
    setSdkAudioLogQuiet(false);
    // 100 events 24 ms apart, one of them 300 ms late; 640-byte frames with one 1280-byte frame.
    for (let i = 0; i < 100; i++) {
      clock.now += (i === 60 ? 300 : 24) - 0.75; // 0.75 ms is spent inside each call (0.4 + 0.2 + 0.1 + 0.05)
      page.push(JSON.stringify(page.audio(i === 10 ? 1280 : 640)));
    }
    noteMicDropped("rate", 3); noteMicDropped("flush", 5); noteMicSend(2); noteMicSend(4);
    const report = micProbeWindow({ avg: 3, max: 12 })!;
    expect(page.handled).toHaveLength(100);
    expect(report.mic).toContain("x100");
    expect(report.mic).toContain("gap 24/24/300 ms med/p95/max");
    expect(report.mic).toContain("ours 0.10/0.10 ms avg/max");
    expect(report.mic).toContain("bytes 640/646/1280 min/avg/max");
    expect(report.mic).toContain("dropped 8 (rate 3 · flush 5 · source 0)");
    expect(report.mic).toContain("send 3.0/4.0 ms x2");
    expect(report.mic).toContain("lag 3.0/12 ms");
    // "direct 100": this page registered its listener before the probe, so the handler saw each event first; still counted once.
    expect(report.sdk).toContain("mic-entry fn (fn 100 · message 0 · event 100 · direct 100)");
    // Handler start minus entry start: the SDK's parse + decode + console line.
    expect(report.sdk).toContain("sdk-decode 0.60/0.60 ms avg/max");
    expect(report.sdk).toContain("call 0.75/0.75 ms");
    expect(report.sdk).toContain("sdk-log 0.20/0.20 ms x100");
    expect(report.sdk).toMatch(/raw string\/base64 \d+\/\d+\/\d+ min\/avg\/max/u);
    expect(report.sdk).toMatch(/busy \d+\.\d %/u);
    expect(micEntryObserved()).toBe("fn");
    // A new window starts empty.
    expect(micProbeWindow()).toBeUndefined();
  });

  it("is passive: the message, the return value, `this`, errors and every other console line pass through unchanged", () => {
    const page = fakePage(clock);
    const restore = installMicProbe(page.target as never, page.logger);
    const message = page.audio(640, "numbers");
    expect(page.push(message)).toBe("handled");
    expect(page.seenByOriginal[0]).toBe(message); // same object, not a copy
    expect(JSON.stringify(message)).toBe(JSON.stringify(page.audio(640, "numbers")));
    expect(page.handled).toEqual([640]);
    // Default: the SDK's per-frame audio line is skipped; anything else is logged as before.
    expect(page.logged).toHaveLength(0);
    page.logger.log("[EvenAppBridge] Bridge initialized");
    page.logger.log("[EvenAppBridge] EvenHub event:", { textEvent: {} });
    page.logger.log("app line", 1, { audioEvent: true });
    expect(page.logged).toEqual([["[EvenAppBridge] Bridge initialized"], ["[EvenAppBridge] EvenHub event:", { textEvent: {} }], ["app line", 1, { audioEvent: true }]]);
    const report = micProbeWindow()!;
    expect(report.sdk).toContain("sdk-log skipped x1");
    expect(report.sdk).toContain("raw object/numbers 640/640/640");
    // A non-audio push is not counted as a microphone event.
    page.push({ method: "evenHubEvent", data: { jsonData: { other: true } } });
    expect(micProbeWindow()).toBeUndefined();
    // An error thrown by the SDK is not swallowed, and the next call is measured normally.
    page.target._listenEvenAppMessage = () => { throw new Error("sdk failed"); };
    expect(() => page.push(message)).toThrow("sdk failed");
    // The SDK assigning its function again keeps the probe in place.
    page.target._listenEvenAppMessage = page.original;
    page.push(JSON.stringify(page.audio(320)));
    expect(micProbeWindow()!.sdk).toContain("mic-entry fn (fn 1");
    restore();
    expect(page.target._listenEvenAppMessage).toBe(page.original);
    page.logger.log("[EvenAppBridge] EvenHub event:", { audioEvent: {} });
    expect(page.logged.at(-1)).toEqual(["[EvenAppBridge] EvenHub event:", { audioEvent: {} }]);
  });

  it("still counts arrivals while the app ignores audio (overload flush), and reports the entry points it actually saw", () => {
    const page = fakePage(clock);
    installMicProbe(page.target as never, page.logger);
    page.ignoreAudio();
    for (let i = 0; i < 10; i++) { clock.now += 40; page.push(JSON.stringify(page.audio(640))); }
    const flushing = micProbeWindow()!;
    expect(flushing.mic).toContain("x10");
    expect(flushing.mic).toContain("ours not run");
    expect(flushing.sdk).toContain("sdk-decode not measurable");
    expect(flushing.sdk).toContain("call 0.");

    // A host that posts a window message instead of calling the global function.
    resetMicProbeForTest();
    const posted = new EventTarget() as EventTarget & Record<string, unknown>;
    installMicProbe(posted as never, { log: () => undefined });
    posted.addEventListener("message", event => {
      const data = (event as MessageEvent<{ data: { jsonData: { audioPcm: number[] } } }>).data;
      clock.now += 0.3;
      posted.dispatchEvent(new CustomEvent("evenHubEvent", { detail: { audioEvent: { audioPcm: Uint8Array.from(data.data.jsonData.audioPcm) } } }));
    });
    posted.addEventListener("evenHubEvent", event => { micHandlerEnd(micHandlerBegin((event as CustomEvent<{ audioEvent: { audioPcm: Uint8Array } }>).detail.audioEvent.audioPcm.byteLength)); });
    for (let i = 0; i < 5; i++) { clock.now += 24; posted.dispatchEvent(new MessageEvent("message", { data: page.audio(640, "numbers") })); }
    const viaMessage = micProbeWindow()!;
    expect(viaMessage.sdk).toContain("mic-entry message (fn 0 · message 5 · event 5 · direct 0)");
    expect(viaMessage.sdk).toContain("sdk-decode 0.30/0.30 ms");
    expect(micEntryObserved()).toBe("message");

    // No entry point at all (a bridge that calls the listener directly): still counted, decode not measurable.
    resetMicProbeForTest();
    installMicProbe({} as never, { log: () => undefined });
    for (let i = 0; i < 4; i++) { clock.now += 24; const began = micHandlerBegin(640); clock.now += 0.2; micHandlerEnd(began); }
    const direct = micProbeWindow()!;
    expect(direct.sdk).toContain("mic-entry none (fn 0 · message 0 · event 0 · direct 4)");
    expect(direct.sdk).toContain("sdk-decode not measurable");
    expect(direct.mic).toContain("gap 24/24/24 ms");
    expect(micEntryObserved()).toBe("none");
    expect(micProbeState()).toContain("mic-entry none (+direct listener)");
    // Installing where there is no window at all does nothing and does not throw.
    resetMicProbeForTest();
    expect(() => installMicProbe(undefined)()).not.toThrow();
  });

  it("writes the two lines to the diagnostics report like any other line, and keeps them in the Even bridge storage", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.UTC(2026, 10, 21, 20, 0, 0) });
    vi.stubGlobal("navigator", { userAgent: "test" });
    vi.stubGlobal("document", { visibilityState: "visible" });
    const stored = new Map<string, string>();
    const store = { getLocalStorage: async (key: string) => stored.get(key) ?? "", setLocalStorage: async (key: string, value: string) => { stored.set(key, value); return true; } };
    await attachDiagnosticsStore(store);
    expect(recordMicWindow()).toBeUndefined(); // nothing arrived: nothing logged
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 20; i++) { clock.now += 24; micHandlerEnd(micHandlerBegin(640)); }
      vi.setSystemTime(Date.now() + 10_000);
      expect(recordMicWindow()).toBeDefined();
    }
    const report = diagnosticsReport();
    expect(report).toContain("microphone: mic-entry none");
    expect(report.match(/ {2}mic {2}\S+\/s x20 · gap /gu)).toHaveLength(3);
    expect(report.match(/ {2}mic-sdk {2}mic-entry none/gu)).toHaveLength(3);
    expect(report).not.toMatch(/audioPcm|sk-/u);
    // Every third window goes to the bridge storage (a bridge write is load too), in its own key.
    await vi.advanceTimersByTimeAsync(500);
    expect(JSON.parse(stored.get("helix.diagnostics.mic.v2")!).events).toHaveLength(6);
    // The next page load shows the previous run's lines.
    resetDiagnosticsForTest(); resetMicProbeForTest();
    await attachDiagnosticsStore(store);
    expect(diagnosticsReport().match(/ {2}mic-sdk {2}/gu)).toHaveLength(3);
    vi.useRealTimers();
  });

  it("reports how long the oldest Even bridge call has been waiting (second signal for the microphone guard)", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 10, 21, 20, 0, 0) });
    let answer: (value: string) => void = () => undefined;
    const bridge = monitorBridge({ getLocalStorage: (_key: string) => new Promise<string>(done => { answer = done; }) });
    expect(mainThreadPressure().bridgePendingMs).toBe(0);
    const reply = bridge.getLocalStorage("helix.mic.ping");
    vi.setSystemTime(Date.now() + 4200);
    expect(mainThreadPressure().bridgePendingMs).toBe(4200);
    answer(""); await reply; await Promise.resolve();
    expect(mainThreadPressure().bridgePendingMs).toBe(0);
    vi.useRealTimers();
  });
});

describe("Even Hub SDK 0.0.14 host entry point (the installed bundle, loaded against a recording window)", () => {
  afterEach(() => { resetMicProbeForTest(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.resetModules(); });

  it("receives host pushes through window._listenEvenAppMessage, logs every audio event to the console, and dispatches a window event", async () => {
    const page = new EventTarget() as EventTarget & Record<string, unknown>;
    const registered: string[] = [];
    const add = page.addEventListener.bind(page);
    page.addEventListener = ((type: string, ...rest: [EventListener]) => { registered.push(type); add(type, ...rest); }) as typeof page.addEventListener;
    for (const name of ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] as const) page[name] = globalThis[name];
    page.flutter_inappwebview = { callHandler: () => new Promise(() => undefined) };
    vi.stubGlobal("window", page);
    vi.stubGlobal("document", { readyState: "complete", addEventListener: () => undefined, visibilityState: "visible" });
    const lines: unknown[][] = [];
    const logger = { log: (...args: unknown[]) => { lines.push(args); } };
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => logger.log(...args));
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    vi.resetModules();
    const sdk = await import("@evenrealities/even_hub_sdk");
    const bridge = sdk.EvenAppBridge.getInstance();
    expect(typeof page._listenEvenAppMessage).toBe("function");
    expect(registered).not.toContain("message"); // 0.0.14 has no window "message" listener
    expect(sdk.AudioInputSource.Phone).toBe("phone");

    const got: { bytes: number; source: string }[] = [];
    bridge.onEvenHubEvent(event => { if (event.audioEvent) got.push({ bytes: event.audioEvent.audioPcm.byteLength, source: event.audioEvent.source }); });
    expect(registered).toContain("evenHubEvent");
    const pcm = Array.from({ length: 640 }, (_, i) => i & 255);
    const push = (jsonData: object, asString: boolean) => {
      const message = { type: "listen_even_app_data", method: "evenHubEvent", data: { type: "audioEvent", jsonData } };
      (page._listenEvenAppMessage as (message: unknown) => void)(asString ? JSON.stringify(message) : message);
    };
    push({ source: "glasses", audioPcm: pcm }, false);
    push({ source: "phone", audioPcm: Buffer.from(Uint8Array.from(pcm)).toString("base64") }, true);
    push({ audioPcm: pcm }, true); // untagged: the SDK calls it "glasses"
    expect(got).toEqual([{ bytes: 640, source: "glasses" }, { bytes: 640, source: "phone" }, { bytes: 640, source: "glasses" }]);
    // One console line per audio event, carrying the decoded event (and so the audio) as its second argument.
    const audioLines = lines.filter(args => String(args[0]).startsWith("[EvenAppBridge] EvenHub event") && !!(args[1] as { audioEvent?: unknown }).audioEvent);
    expect(audioLines).toHaveLength(3);

    // With the probe installed the same pushes are measured, and that console line is skipped by default.
    lines.length = 0;
    installMicProbe(page as never, logger);
    push({ source: "glasses", audioPcm: pcm }, true);
    push({ source: "glasses", audioPcm: pcm }, false);
    expect(got).toHaveLength(5);
    expect(lines.filter(args => String(args[0]).startsWith("[EvenAppBridge] EvenHub event"))).toHaveLength(0);
    const report = micProbeWindow()!;
    expect(report.sdk).toContain("mic-entry fn (fn 2 · message 0 · event 2 · direct 0)");
    expect(report.sdk).toContain("sdk-log skipped x2");
  });
});
