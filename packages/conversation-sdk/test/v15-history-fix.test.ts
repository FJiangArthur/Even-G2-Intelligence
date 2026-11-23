import { afterEach, describe, expect, it, vi } from "vitest";
import { HISTORY_INDEX_KEY, LocalHistoryStore, historyShardKey, type HistoryEntry, type HistorySession } from "../src/index.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 1) + seconds * 1000).toISOString();
const session = (id: string, extra: Partial<HistorySession> = {}): HistorySession => ({ id, source: "helix", title: `Title ${id}`, startedAt: at(0), updatedAt: at(0), ...extra });
const entry = (id: string, sessionId: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({ id, sessionId, kind: "transcript", text: `text ${id}`, occurredAt: at(0), ...extra });

/** Keyed phone storage; writes to `stuck` keys get no reply until release() answers them (the value is stored then). */
function disk() {
  const values = new Map<string, string>(), writes: string[] = [], stuck = new Set<string>(), held: (() => void)[] = [];
  return {
    values, writes, stuck,
    release: () => { stuck.clear(); for (const answer of held.splice(0)) answer(); },
    getLocalStorage: async (key: string) => values.get(key) ?? "",
    setLocalStorage: (key: string, value: string) => new Promise<boolean>(resolve => {
      const answer = () => { writes.push(key); values.set(key, value); resolve(true); };
      if (stuck.has(key)) held.push(answer); else answer();
    }),
  };
}
/** One spoken line of a live session: the controller bumps updatedAt and adds one entry, issued together. */
const line = (store: LocalHistoryStore, id: string, n: number) =>
  Promise.all([store.upsertSession(session(id, { updatedAt: at(n) })), store.upsertEntries([entry(`${id}:e${n}`, id, { occurredAt: at(n) })])]);
const reload = async (d: ReturnType<typeof disk>) => { const store = new LocalHistoryStore(d); await store.load(); return store; };
const ids = (store: LocalHistoryStore, id: string) => store.getEntries(id).map(e => e.id);

afterEach(() => { vi.useRealTimers(); });

describe("v15 history fix: a lost storage reply does not drop the live session's pending lines", () => {
  it("keeps the coalesced lines and saves them with the next save", async () => {
    vi.useFakeTimers();
    const d = disk(), store = new LocalHistoryStore(d, { storageTimeoutMs: 30_000, writeDelayMs: 10_000 });
    await store.load();
    d.stuck.add(historyShardKey("a"));
    let first = "pending";
    void line(store, "a", 1).then(() => { first = "saved"; }, () => { first = "failed"; });
    const flushed = expect(store.flush()).rejects.toThrow("Could not save local history");
    await vi.advanceTimersByTimeAsync(30_000);
    await flushed; // the queue moves on
    expect(first).toBe("pending"); // neither saved nor given up
    d.stuck.clear(); // the lost reply never comes; storage answers new writes
    const second = line(store, "a", 2);
    await store.flush(); await second;
    expect(first).toBe("saved");
    expect(ids(store, "a")).toEqual(["a:e1", "a:e2"]);
    expect(ids(await reload(d), "a")).toEqual(["a:e1", "a:e2"]);
  });
  it("retries on its own when nothing else is written", async () => {
    vi.useFakeTimers();
    const d = disk(), store = new LocalHistoryStore(d, { storageTimeoutMs: 30_000, writeDelayMs: 10_000 });
    await store.load();
    d.stuck.add(historyShardKey("a"));
    const saved = line(store, "a", 1);
    await vi.advanceTimersByTimeAsync(10_000 + 30_000); // the coalescing window, then the deadline
    expect(ids(store, "a")).toEqual([]);
    d.stuck.clear();
    await vi.advanceTimersByTimeAsync(10_000);
    await saved;
    expect(ids(store, "a")).toEqual(["a:e1"]);
    expect(ids(await reload(d), "a")).toEqual(["a:e1"]);
  });
  it("the retried save rewrites the chunk with every line even when the lost write did reach storage", async () => {
    vi.useFakeTimers();
    const d = disk(), store = new LocalHistoryStore(d, { storageTimeoutMs: 30_000, writeDelayMs: 10_000 });
    const earlier = line(store, "a", 0);
    await store.flush(); await earlier;
    d.stuck.add(historyShardKey("a"));
    const saved = line(store, "a", 1);
    const flushed = expect(store.flush()).rejects.toThrow("Could not save local history");
    await vi.advanceTimersByTimeAsync(30_000);
    await flushed;
    d.release(); // the write lands after it was given up on
    const next = line(store, "a", 2);
    await store.flush(); await saved; await next;
    expect(ids(await reload(d), "a")).toEqual(["a:e0", "a:e1", "a:e2"]);
  });
  it("gives up after repeated lost replies: the writers are told and the store keeps working", async () => {
    vi.useFakeTimers();
    const d = disk(), store = new LocalHistoryStore(d, { storageTimeoutMs: 30_000, writeDelayMs: 10_000 });
    await store.load();
    d.stuck.add(historyShardKey("a"));
    const lost = expect(line(store, "a", 1)).rejects.toThrow("Could not save local history");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await lost;
    d.stuck.clear();
    const later = line(store, "b", 1);
    await store.flush(); await later;
    expect(ids(store, "a")).toEqual([]);
    expect(ids(store, "b")).toEqual(["b:e1"]);
  });
  it("a write that goes straight to storage still fails for good, so a failed deletion or import is not applied later", async () => {
    vi.useFakeTimers();
    const d = disk(), store = new LocalHistoryStore(d, { storageTimeoutMs: 30_000 });
    await store.upsertSession(session("a"));
    d.stuck.add(HISTORY_INDEX_KEY);
    const lost = expect(store.upsertSession(session("b"))).rejects.toThrow("Could not save local history");
    await vi.advanceTimersByTimeAsync(30_000);
    await lost;
    d.stuck.clear();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await store.upsertSession(session("c"));
    expect(store.listSessions().map(s => s.id).sort()).toEqual(["a", "c"]);
  });
  it("a storage refusal (not a lost reply) still fails the coalesced save at once", async () => {
    const d = disk(), store = new LocalHistoryStore(d, { writeDelayMs: 60_000 });
    await store.load();
    d.setLocalStorage = async () => false as unknown as boolean;
    const saved = expect(line(store, "a", 1)).rejects.toThrow("Could not save local history");
    await expect(store.flush()).rejects.toThrow("Could not save local history");
    await saved;
  });
});

describe("v15 history fix: time spent suspended does not count towards the storage deadline", () => {
  it("a reply delivered after the page resumes saves normally", async () => {
    vi.useFakeTimers();
    const d = disk(), store = new LocalHistoryStore(d, { storageTimeoutMs: 30_000, writeDelayMs: 10_000 });
    await store.load();
    d.stuck.add(historyShardKey("a"));
    const saved = line(store, "a", 1);
    let outcome = "pending";
    void store.flush().then(() => { outcome = "saved"; }, () => { outcome = "failed"; });
    await vi.advanceTimersByTimeAsync(20_000);
    vi.setSystemTime(Date.now() + 120_000); // suspended for two minutes: the clock moved, timers did not run
    await vi.advanceTimersByTimeAsync(10_000); // the overdue deadline timer fires before the queued reply
    expect(outcome).toBe("pending");
    d.release();
    await vi.advanceTimersByTimeAsync(0);
    await saved;
    expect(outcome).toBe("saved");
    expect(ids(store, "a")).toEqual(["a:e1"]);
  });
  it("a reply that is still missing a full deadline after the resume counts as lost", async () => {
    vi.useFakeTimers();
    const d = disk(), store = new LocalHistoryStore(d, { storageTimeoutMs: 30_000 });
    await store.load();
    d.stuck.add(HISTORY_INDEX_KEY);
    const lost = expect(store.upsertSession(session("a"))).rejects.toThrow("Could not save local history");
    await vi.advanceTimersByTimeAsync(20_000);
    vi.setSystemTime(Date.now() + 120_000);
    await vi.advanceTimersByTimeAsync(10_000 + 30_000);
    await lost;
  });
});
