import { afterEach, describe, expect, it, vi } from "vitest";
import { HISTORY_INDEX_KEY, LocalHistoryStore, historyChunkKey, historyShardKey, type HistoryEntry, type HistorySession } from "../src/index.js";

const INDEX = HISTORY_INDEX_KEY;
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 1) + seconds * 1000).toISOString();
const session = (id: string, extra: Partial<HistorySession> = {}): HistorySession => ({ id, source: "helix", title: `Title ${id}`, startedAt: at(0), updatedAt: at(0), ...extra });
const entry = (id: string, sessionId: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({ id, sessionId, kind: "transcript", text: `text ${id}`, occurredAt: at(0), ...extra });

/** Keyed phone storage that records every written key; `stuck` keys never get a reply. */
function disk(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial)), writes: string[] = [], stuck = new Set<string>(), stuckReads = new Set<string>();
  return {
    values, writes, stuck, stuckReads,
    getLocalStorage: async (key: string) => stuckReads.has(key) ? new Promise<string>(() => undefined) : values.get(key) ?? "",
    setLocalStorage: async (key: string, value: string) => {
      if (stuck.has(key)) return new Promise<boolean>(() => undefined);
      writes.push(key); values.set(key, value); return true;
    },
  };
}
/** One spoken line of a live session: the controller bumps updatedAt and adds one entry, issued together. */
const line = (store: LocalHistoryStore, id: string, n: number) =>
  Promise.all([store.upsertSession(session(id, { updatedAt: at(n) })), store.upsertEntries([entry(`${id}:e${n}`, id, { occurredAt: at(n) })])]);
const reload = async (d: ReturnType<typeof disk>) => { const store = new LocalHistoryStore(d); await store.load(); return store; };

afterEach(() => { vi.useRealTimers(); });

describe("v15 history: revision counter (findings 14, 22)", () => {
  it("changes when the saved archive changes, and only then", async () => {
    const d = disk(), store = new LocalHistoryStore(d, { writeDelayMs: 60_000 });
    const start = store.revision;
    await store.load();
    const loaded = store.revision;
    expect(loaded).not.toBe(start);
    const pending = line(store, "a", 1);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(store.revision).toBe(loaded); // pending (coalesced) writes are not visible to reads yet
    store.listSessions(); store.getSession("a"); store.stats();
    expect(store.revision).toBe(loaded);
    await store.flush(); await pending;
    const saved = store.revision;
    expect(saved).not.toBe(loaded);
    expect(store.listSessions()).toHaveLength(1);
    expect(store.revision).toBe(saved);
    const deleted = store.deleteSession("a");
    await store.flush(); await deleted;
    expect(store.revision).not.toBe(saved);
  });
  it("does not change when a save fails", async () => {
    const d = disk(), store = new LocalHistoryStore(d);
    await store.upsertSession(session("a"));
    const before = store.revision;
    d.setLocalStorage = async () => false;
    await expect(store.upsertSession(session("b"))).rejects.toThrow("Could not save local history");
    expect(store.revision).toBe(before);
  });
});

describe("v15 history: live saves do not rewrite the whole index every time (findings 15, 25)", () => {
  async function liveStore(d = disk(), options: ConstructorParameters<typeof LocalHistoryStore>[1] = {}) {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 1) });
    const store = new LocalHistoryStore(d, { writeDelayMs: 10_000, ...options });
    await store.load();
    // Other saved sessions: their metadata is what makes the index large.
    store.writeDelayMs = 0;
    for (let i = 0; i < 3; i++) await store.replaceSession(session(`old${i}`, { summary: ["Saved earlier."] }), [entry(`old${i}:e0`, `old${i}`)]);
    store.writeDelayMs = 10_000;
    return { d, store };
  }
  /** One line, then the coalescing timer fires and the save completes. */
  async function speak(store: LocalHistoryStore, id: string, n: number) {
    const saved = line(store, id, n);
    await vi.advanceTimersByTimeAsync(10_000);
    await saved;
  }
  it("writes the index with the session's first line, then only the changed chunk for the next saves", async () => {
    const { d, store } = await liveStore();
    d.writes.length = 0;
    await speak(store, "live", 1);
    expect(d.writes).toEqual([historyShardKey("live"), INDEX]); // new session: the index is the commit point
    d.writes.length = 0;
    await speak(store, "live", 2);
    await speak(store, "live", 3);
    await speak(store, "live", 4);
    expect(d.writes).toEqual([historyShardKey("live"), historyShardKey("live"), historyShardKey("live")]);
    // Reads see every saved line and the latest update time.
    expect(store.getEntries("live").map(e => e.id)).toEqual(["live:e1", "live:e2", "live:e3", "live:e4"]);
    expect(store.getSession("live")?.updatedAt).toBe(at(4));
  });
  it("a page kill inside the window loses no saved line (the stored index is only behind on updatedAt)", async () => {
    const { d, store } = await liveStore();
    await speak(store, "live", 1);
    await speak(store, "live", 2);
    await speak(store, "live", 3);
    expect(JSON.parse(d.values.get(INDEX)!).shards.live.entries).toBe(1); // stale meta in the stored index
    vi.useRealTimers();
    const copyDisk = disk(Object.fromEntries(d.values)), again = await reload(copyDisk);
    expect(again.getEntries("live").map(e => e.id)).toEqual(["live:e1", "live:e2", "live:e3"]);
    expect(again.corruptSessionIds()).toEqual([]);
    expect(again.getSession("live")?.updatedAt).toBe(at(1));
    // The reloaded store keeps saving on top of it.
    await again.upsertEntries([entry("live:e4", "live")]);
    expect((await reload(disk(Object.fromEntries(copyDisk.values)))).getEntries("live")).toHaveLength(4);
  });
  it("flush() writes the held-back index, also when no mutation is pending", async () => {
    const { d, store } = await liveStore();
    await speak(store, "live", 1);
    await speak(store, "live", 2);
    d.writes.length = 0;
    await store.flush();
    expect(d.writes).toEqual([INDEX]);
    const stored = JSON.parse(d.values.get(INDEX)!);
    expect(stored.shards.live.entries).toBe(2);
    expect(stored.sessions.find((s: HistorySession) => s.id === "live").updatedAt).toBe(at(2));
    d.writes.length = 0;
    await store.flush();
    expect(d.writes).toEqual([]); // nothing held back any more
  });
  it("flush() with a pending line writes the chunk and the index together", async () => {
    const { d, store } = await liveStore();
    await speak(store, "live", 1);
    d.writes.length = 0;
    const saved = line(store, "live", 2);
    await store.flush(); await saved;
    expect(d.writes).toEqual([historyShardKey("live"), INDEX]);
  });
  it("turning coalescing off (session end) writes the held-back index", async () => {
    const { d, store } = await liveStore();
    await speak(store, "live", 1);
    await speak(store, "live", 2);
    d.writes.length = 0;
    store.writeDelayMs = 0;
    await store.flush();
    expect(d.writes).toEqual([INDEX]);
    expect(JSON.parse(d.values.get(INDEX)!).shards.live.entries).toBe(2);
  });
  it("writes the index at most once a minute while only lines are added", async () => {
    const { d, store } = await liveStore();
    await speak(store, "live", 1); // t = 10 s: index written
    d.writes.length = 0;
    for (let n = 2; n <= 6; n++) await speak(store, "live", n); // t = 20 .. 60 s
    expect(d.writes.filter(key => key === INDEX)).toHaveLength(0);
    await speak(store, "live", 7); // t = 70 s: a minute after the last index write
    expect(d.writes.filter(key => key === INDEX)).toHaveLength(1);
    expect(JSON.parse(d.values.get(INDEX)!).shards.live.entries).toBe(7);
    d.writes.length = 0;
    await speak(store, "live", 8);
    expect(d.writes).toEqual([historyShardKey("live")]);
  });
  it("writes the index at once when a chunk is added (a reload reads chunks by the stored count)", async () => {
    const { d, store } = await liveStore(disk(), { chunkEntries: 2 });
    await speak(store, "live", 1);
    await speak(store, "live", 2);
    d.writes.length = 0;
    await speak(store, "live", 3); // third entry opens chunk 1
    expect(d.writes).toEqual([historyChunkKey("live", 1), INDEX]);
    expect(JSON.parse(d.values.get(INDEX)!).shards.live).toMatchObject({ entries: 3, chunks: 2 });
    vi.useRealTimers();
    expect((await reload(disk(Object.fromEntries(d.values)))).getEntries("live")).toHaveLength(3);
  });
  it("writes the index at once when a session gets its first entry (a reload skips shards recorded as empty)", async () => {
    const { d, store } = await liveStore();
    const first = store.upsertSession(session("live", { summary: ["Knowledge came first."] }));
    await vi.advanceTimersByTimeAsync(10_000); await first;
    d.writes.length = 0;
    await speak(store, "live", 1);
    expect(d.writes).toEqual([historyShardKey("live"), INDEX]);
    vi.useRealTimers();
    expect((await reload(disk(Object.fromEntries(d.values)))).getEntries("live")).toHaveLength(1);
  });
  it("writes the index at once for any other change: session fields, a new session, a removed one", async () => {
    const { d, store } = await liveStore();
    await speak(store, "live", 1);
    d.writes.length = 0;
    const knowledge = store.updateSessionKnowledge("live", { summary: ["Budget approved."] });
    await vi.advanceTimersByTimeAsync(10_000); await knowledge;
    expect(d.writes).toEqual([INDEX]);
    d.writes.length = 0;
    const added = store.upsertSession(session("other"));
    await vi.advanceTimersByTimeAsync(10_000); await added;
    expect(d.writes).toEqual([INDEX]);
    await speak(store, "live", 2); // held back
    d.writes.length = 0;
    const removed = store.deleteSession("old0");
    await vi.advanceTimersByTimeAsync(10_000); await removed;
    expect(d.writes[0]).toBe(INDEX);
    const stored = JSON.parse(d.values.get(INDEX)!);
    expect(stored.sessions.map((s: HistorySession) => s.id)).not.toContain("old0");
    expect(stored.shards.live.entries).toBe(2); // the held-back part went out with it
  });
  it("write-through saves (no coalescing window) still write the index with every change", async () => {
    const d = disk(), store = new LocalHistoryStore(d);
    await line(store, "live", 1);
    d.writes.length = 0;
    await store.upsertSession(session("live", { updatedAt: at(2) }));
    await store.upsertEntries([entry("live:e2", "live")]);
    expect(d.writes).toEqual([INDEX, historyShardKey("live"), INDEX]);
  });
  it("still enforces the 5 MiB cap on a save that holds the index back", async () => {
    const { store } = await liveStore();
    await speak(store, "live", 1);
    const big = Promise.all([store.upsertSession(session("live", { updatedAt: at(2) })),
      store.upsertEntries(Array.from({ length: 60 }, (_, i) => entry(`live:big${i}`, "live", { text: "x".repeat(100_000) })))]);
    const outcome = expect(big).rejects.toThrow(/5 MiB|too large|limit/iu);
    await vi.advanceTimersByTimeAsync(10_000);
    await outcome;
    expect(store.getEntries("live")).toHaveLength(1);
  });
});

describe("v15 history: a lost storage reply does not stop saving for good (finding 12)", () => {
  it("fails the save after the deadline and saves again once storage answers", async () => {
    vi.useFakeTimers();
    const d = disk(), store = new LocalHistoryStore(d, { storageTimeoutMs: 30_000 });
    await store.upsertSession(session("a"));
    d.stuck.add(INDEX);
    const lost = store.upsertSession(session("b"));
    const outcome = expect(lost).rejects.toThrow("Could not save local history");
    await vi.advanceTimersByTimeAsync(29_000);
    let settled = false; void lost.catch(() => undefined).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false); // a late reply is not a lost one
    await vi.advanceTimersByTimeAsync(1_000);
    await outcome;
    expect(store.listSessions().map(s => s.id)).toEqual(["a"]);
    d.stuck.clear();
    await store.upsertSession(session("c"));
    expect(store.listSessions().map(s => s.id).sort()).toEqual(["a", "c"]);
  });
  it("flush() settles when a chunk write is never answered", async () => {
    vi.useFakeTimers();
    const d = disk(), store = new LocalHistoryStore(d, { storageTimeoutMs: 30_000, writeDelayMs: 10_000 });
    await store.load();
    d.stuck.add(historyShardKey("a"));
    const saved = line(store, "a", 1); void saved.catch(() => undefined);
    const flushed = expect(store.flush()).rejects.toThrow("Could not save local history");
    await vi.advanceTimersByTimeAsync(30_000);
    await flushed;
    d.stuck.clear();
    const retried = line(store, "a", 2);
    await store.flush(); await retried;
    await saved; // the line whose reply was lost is kept and saved with the next save
    expect(store.getEntries("a").map(e => e.id)).toEqual(["a:e1", "a:e2"]);
  });
  it("load() rejects instead of hanging when a read is never answered, and a later load works", async () => {
    vi.useFakeTimers();
    const seed = disk(), first = new LocalHistoryStore(seed);
    await first.replaceSession(session("a"), [entry("a:e0", "a")]);
    for (const key of [INDEX, historyShardKey("a")]) {
      const d = disk(Object.fromEntries(seed.values)), store = new LocalHistoryStore(d, { storageTimeoutMs: 30_000 });
      d.stuckReads.add(key);
      const loading = expect(store.load()).rejects.toThrow("Could not load local history");
      await vi.advanceTimersByTimeAsync(30_000);
      await loading;
      // A timed-out shard read is not treated as a damaged shard.
      expect(store.corruptSessionIds()).toEqual([]);
      d.stuckReads.clear();
      await store.load();
      expect(store.getEntries("a")).toHaveLength(1);
    }
  });
  it("has a default deadline long enough for late replies (at least 30 s)", async () => {
    vi.useFakeTimers();
    const d = disk(), store = new LocalHistoryStore(d);
    await store.load();
    d.stuck.add(INDEX);
    let settled = false;
    void store.upsertSession(session("a")).catch(() => undefined).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(settled).toBe(true);
  });
});
