import { afterEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_KEY, HEARTBEAT_MS, describePreviousExit, diagnosticsReport, readDiagnostics, watchLifecycle } from "../src/diagnostics";

/** Minimal page globals for the lifecycle watcher (node test environment). */
function page(visibility: "visible" | "hidden" = "visible") {
  const store = new Map<string, string>();
  const docListeners = new Map<string, Set<(e: unknown) => void>>(), winListeners = new Map<string, Set<(e: unknown) => void>>();
  const on = (map: typeof docListeners) => (type: string, fn: (e: unknown) => void) => { if (!map.has(type)) map.set(type, new Set()); map.get(type)!.add(fn); };
  const off = (map: typeof docListeners) => (type: string, fn: (e: unknown) => void) => map.get(type)?.delete(fn);
  const doc = { visibilityState: visibility, addEventListener: on(docListeners), removeEventListener: off(docListeners) };
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { addEventListener: on(winListeners), removeEventListener: off(winListeners) });
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15" });
  const fire = (target: "doc" | "win", type: string, event: unknown = {}) => { for (const fn of (target === "doc" ? docListeners : winListeners).get(type) ?? []) fn(event); };
  return { store, doc, fire, heartbeat: () => JSON.parse(store.get(HEARTBEAT_KEY)!) };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("v0.9.1 lifecycle heartbeat (iOS page-kill detection)", () => {
  it("writes a heartbeat at boot, every 30 s and on visibility changes, with state but no transcript", () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 12, 17, 0, 0) });
    const p = page();
    const stop = watchLifecycle({ onResume: () => {}, onHide: () => {}, describe: () => "listening 3m · dom 1200" });
    expect(p.heartbeat()).toMatchObject({ visible: true, state: "listening 3m · dom 1200" });
    const first = p.heartbeat().at;
    vi.advanceTimersByTime(HEARTBEAT_MS);
    expect(p.heartbeat().at - first).toBe(HEARTBEAT_MS);
    p.doc.visibilityState = "hidden"; p.fire("doc", "visibilitychange");
    expect(p.heartbeat()).toMatchObject({ visible: false, hiddenAt: first + HEARTBEAT_MS });
    stop();
    expect(p.heartbeat().clean).toBe(true);
  });
  it("on the next boot, a heartbeat that stopped in the background without a close is reported as a phone kill", () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 10, 12, 17, 0, 0) });
    const p = page();
    watchLifecycle({ onResume: () => {}, onHide: () => {}, describe: () => "listening 20m · dom 4000" });
    p.doc.visibilityState = "hidden"; p.fire("doc", "visibilitychange");
    vi.advanceTimersByTime(12 * 60_000); // Locked for 12 min, then iOS terminates the content process: no event.
    const killed = new Map(p.store);
    vi.advanceTimersByTime(5 * 60_000);
    vi.unstubAllGlobals();
    const q = page(); for (const [k, v] of killed) q.store.set(k, v);
    watchLifecycle({ onResume: () => {}, onHide: () => {} });
    const event = readDiagnostics().find(e => e.kind === "previous-page-killed");
    expect(event?.detail).toMatch(/last alive 5 min before this launch after 12 min in the background · listening 20m/u);
    expect(diagnosticsReport()).toMatch(/previous page: ended unexpectedly/u);
  });
  it("a reload or close (non-persisted pagehide) is a normal close; a bfcache pagehide is not", () => {
    const at = Date.UTC(2026, 10, 12, 17, 0, 0);
    expect(describePreviousExit({ at, boot: at - 60_000, visible: false, hiddenAt: at - 30_000, clean: true }, at + 1000)?.kind).toBe("previous-page-closed");
    expect(describePreviousExit({ at, boot: at - 60_000, visible: true }, at + 1000)?.kind).toBe("previous-page-killed");
    expect(describePreviousExit(undefined)).toBeUndefined();
    vi.useFakeTimers({ now: at });
    const p = page();
    watchLifecycle({ onResume: () => {}, onHide: () => {} });
    p.fire("win", "pagehide", { persisted: true });
    expect(p.heartbeat().clean).toBeUndefined();
    p.fire("win", "pagehide", { persisted: false });
    expect(p.heartbeat().clean).toBe(true);
  });
});
