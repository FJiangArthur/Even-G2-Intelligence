import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalHistoryStore } from "@helix/conversation-sdk";
import { DIAGNOSTICS_STORE_KEY, HEARTBEAT_MS, HEARTBEAT_STORE_KEY, STALL_TICK_MS, attachDiagnosticsStore, describePreviousExit, diagnosticsReport, markActivity, monitorBridge,
  previousPageExit, readDiagnostics, recordDiagnostic, resetDiagnosticsForTest, watchLifecycle } from "../src/diagnostics";

/** Minimal page globals (node test environment). `persistLocal: false` models the iOS WebView that forgets localStorage. */
function page() {
  const store = new Map<string, string>();
  const docListeners = new Map<string, Set<(e: unknown) => void>>(), winListeners = new Map<string, Set<(e: unknown) => void>>();
  const on = (map: typeof docListeners) => (type: string, fn: (e: unknown) => void) => { if (!map.has(type)) map.set(type, new Set()); map.get(type)!.add(fn); };
  const off = (map: typeof docListeners) => (type: string, fn: (e: unknown) => void) => map.get(type)?.delete(fn);
  const doc = { visibilityState: "visible", addEventListener: on(docListeners), removeEventListener: off(docListeners) };
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { addEventListener: on(winListeners), removeEventListener: off(winListeners) });
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)" });
  const fire = (target: "doc" | "win", type: string, event: unknown = {}) => { for (const fn of (target === "doc" ? docListeners : winListeners).get(type) ?? []) fn(event); };
  return { store, doc, fire };
}
function bridgeStore() {
  const data = new Map<string, string>();
  return { data, getLocalStorage: async (key: string) => data.get(key) ?? "", setLocalStorage: async (key: string, value: string) => { data.set(key, value); return true; } };
}
const saved = (bridge: ReturnType<typeof bridgeStore>) => ({ ...(JSON.parse(bridge.data.get(DIAGNOSTICS_STORE_KEY) ?? "{}") as { events?: { kind: string; detail?: string }[] }),
  heartbeat: JSON.parse(bridge.data.get(HEARTBEAT_STORE_KEY) ?? "null") as Record<string, unknown> | undefined });

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); resetDiagnosticsForTest(); });

describe("v0.11.1 diagnostics survive an iOS relaunch (Even bridge storage)", () => {
  it("the next launch sees the previous run's events and heartbeat even when WebView localStorage is empty", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 18, 5, 40, 0) });
    const bridge = bridgeStore();
    page();
    await attachDiagnosticsStore(bridge);
    watchLifecycle({ onResume: () => {}, onHide: () => {}, describe: () => "listening 12m · dom 2100" });
    recordDiagnostic("status:listening");
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS + 500);
    expect(saved(bridge).events?.map(e => e.kind)).toEqual(expect.arrayContaining(["boot", "status:listening"]));
    expect(saved(bridge).heartbeat).toMatchObject({ visible: true, state: "listening 12m · dom 2100" });

    // Force-quit: no pagehide. New process, and the WebView's own localStorage is empty again.
    await vi.advanceTimersByTimeAsync(3 * 60_000 - HEARTBEAT_MS - 500);
    const persisted = bridge.data.get(DIAGNOSTICS_STORE_KEY)!, persistedBeat = bridge.data.get(HEARTBEAT_STORE_KEY)!;
    vi.unstubAllGlobals(); resetDiagnosticsForTest();
    vi.setSystemTime(Date.UTC(2026, 10, 18, 5, 52, 0));
    const next = bridgeStore(); next.data.set(DIAGNOSTICS_STORE_KEY, persisted);
    next.data.set(HEARTBEAT_STORE_KEY, persistedBeat.replace(/"at":\d+/u, `"at":${Date.UTC(2026, 10, 18, 5, 43, 0)}`));
    expect(persisted.length).toBeLessThan(2000); expect(persistedBeat.length).toBeLessThan(400); // the 10 s beat is a few hundred bytes, not the whole log
    page();
    recordDiagnostic("bridge-ready", "4 ms"); // logged before the store is attached: merged, not lost
    await attachDiagnosticsStore(next);
    watchLifecycle({ onResume: () => {}, onHide: () => {} });
    const kinds = readDiagnostics().map(e => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["status:listening", "bridge-ready", "previous-page-killed"]));
    expect(previousPageExit()).toMatch(/ended unexpectedly .*while on screen · listening 12m.*the page hung or the Even app was force-closed/u);
    expect(diagnosticsReport()).toMatch(/log storage: Even bridge \+ WebView/u);
  });
  it("a slow or dead bridge never blocks startup, and secrets are still redacted in the persisted copy", async () => {
    vi.useFakeTimers();
    page();
    const bridge = bridgeStore();
    const hung = { getLocalStorage: () => new Promise<string>(() => {}), setLocalStorage: bridge.setLocalStorage };
    const attached = attachDiagnosticsStore(hung, 1500);
    await vi.advanceTimersByTimeAsync(1500);
    await attached;
    recordDiagnostic("error", "401 for sk-abcdefgh12345 Bearer xyz.123");
    await vi.advanceTimersByTimeAsync(10);
    expect(bridge.data.get(DIAGNOSTICS_STORE_KEY)).not.toMatch(/sk-abcdefgh|xyz\.123/u);
    expect(saved(bridge).events?.at(-1)?.detail).toContain("[redacted]");
  });
});

describe("v0.11.1 hang evidence", () => {
  it("records a main-thread stall with the last taps, but not a late timer after a background stay", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 18, 6, 0, 0) });
    const p = page(), bridge = bridgeStore();
    await attachDiagnosticsStore(bridge);
    watchLifecycle({ onResume: () => {}, onHide: () => {}, describe: () => "listening 4m · dom 9000" });
    p.fire("doc", "click", { target: { closest: () => ({ id: "tab-history" }) } });
    await vi.advanceTimersByTimeAsync(3 * STALL_TICK_MS);
    expect(readDiagnostics().some(e => e.kind === "stall")).toBe(false);
    vi.setSystemTime(Date.now() + 6200); // the main thread was blocked: no timer ran for 6.2 s
    await vi.advanceTimersByTimeAsync(STALL_TICK_MS);
    const stall = readDiagnostics().find(e => e.kind === "stall");
    expect(stall?.detail).toMatch(/^6\.2 s main thread blocked · listening 4m · dom 9000 · taps: tab-history \d+s$/u);
    expect(saved(bridge).heartbeat).toMatchObject({ stalls: 1, maxStall: 6200 });
    expect(describePreviousExit(saved(bridge).heartbeat as never, Date.now() + 60_000)?.detail).toMatch(/taps: tab-history .* 1 stall, longest 6\.2 s/u);

    p.doc.visibilityState = "hidden"; p.fire("doc", "visibilitychange");
    vi.setSystemTime(Date.now() + 5 * 60_000); // suspended in the background
    p.doc.visibilityState = "visible"; p.fire("doc", "visibilitychange");
    await vi.advanceTimersByTimeAsync(STALL_TICK_MS);
    expect(readDiagnostics().filter(e => e.kind === "stall")).toHaveLength(1);
  });
  it("tap labels come from ids and data attributes, never from on-screen text", () => {
    vi.useFakeTimers();
    const p = page();
    watchLifecycle({ onResume: () => {}, onHide: () => {} });
    p.fire("doc", "click", { target: { closest: () => ({ dataset: { sessionId: "session_1" }, className: "card session-row", textContent: "Offer call with Dana" }) } });
    p.fire("doc", "click", { target: { closest: () => null } });
    expect(JSON.parse(p.store.get("helix.heartbeat.v1")!).taps).toMatch(/^session-row \d+s$/u);
    markActivity("x".repeat(100));
  });
  it("logs Even bridge calls that are slow or never return", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 18, 6, 0, 0) });
    page();
    let release: (() => void) | undefined;
    class Bridge { tag = "g2"; fast() { return Promise.resolve(this.tag); } slow() { return new Promise<void>(done => { release = done; }); } sync() { return 7; } }
    const bridge = monitorBridge(new Bridge());
    watchLifecycle({ onResume: () => {}, onHide: () => {} });
    expect(await bridge.fast()).toBe("g2");
    expect(bridge.sync()).toBe(7);
    void bridge.slow();
    await vi.advanceTimersByTimeAsync(9000);
    expect(readDiagnostics().find(e => e.kind === "bridge-stuck")?.detail).toMatch(/1 pending, oldest slow [89]s/u);
    release!(); await vi.advanceTimersByTimeAsync(1);
    expect(readDiagnostics().find(e => e.kind === "bridge-slow")?.detail).toMatch(/^slow 9\.\d s$/u);
  });
});

describe("v0.11.1 history lookups do not clone the archive", () => {
  it("getSession, entryCount and sessionIdOfEntry answer for one session", async () => {
    const data = new Map<string, string>();
    const store = new LocalHistoryStore({ getLocalStorage: async (key: string) => data.get(key) ?? "", setLocalStorage: async (key: string, value: string) => { data.set(key, value); return true; } });
    await store.load();
    const at = "2026-11-18T06:00:00.000Z";
    for (let s = 0; s < 3; s++) {
      await store.upsertSession({ id: `session_${s}`, source: "helix", title: `Meeting ${s}`, startedAt: at, updatedAt: at });
      await store.upsertEntries([0, 1].map(i => ({ id: `session_${s}:e${i}`, sessionId: `session_${s}`, kind: "transcript" as const, text: `line ${i}`, occurredAt: at })));
    }
    expect(store.getSession("session_1")?.title).toBe("Meeting 1");
    expect(store.getSession("missing")).toBeUndefined();
    expect(store.entryCount("session_2")).toBe(2);
    expect(store.entryCount("missing")).toBe(0);
    expect(store.sessionIdOfEntry("session_2:e1")).toBe("session_2");
    expect(store.sessionIdOfEntry("nope")).toBeUndefined();
  });
});
