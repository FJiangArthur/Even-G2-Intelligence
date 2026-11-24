import { afterEach, describe, expect, it, vi } from "vitest";
import { HISTORY_CHUNK_ENTRIES, HISTORY_INDEX_KEY, LEGACY_HISTORY_KEY, LocalHistoryStore, historyChunkKey, historyShardKey, type HistoryEntry, type HistorySession } from "../src/index.js";
import { LocalHistoryStore as V1Store } from "./fixtures/local-history-v1.js";

const INDEX = HISTORY_INDEX_KEY, V1 = LEGACY_HISTORY_KEY;
const session = (id: string, extra: Partial<HistorySession> = {}): HistorySession => ({ id, source: "helix", title: `Title ${id}`, startedAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z", ...extra });
const entry = (id: string, sessionId: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({ id, sessionId, kind: "transcript", text: `text ${id}`, occurredAt: "2026-09-01T00:00:00Z", ...extra });
const SENTENCES = ["We should order the Jetson boards this week.", "Finance approved the budget for compute hardware this quarter.", "The perception stack runs ROS 2 Humble with the CDTF camera nodes.",
  "Is sixteen gigabytes of RAM enough for the detector?", "Elaine owns the calibration rig and will send the report on Thursday.", "The lead time for Orin modules is about twelve weeks right now.",
  "发布计划改到十月。", "预算给了六万元，下周确认。", "October发布计划改到十月"];

/** Keyed phone storage that records every write (key, value length) and the bridge calls in flight. */
function disk(initial: Record<string, string> = {}, latencyMs = 0) {
  const values = new Map(Object.entries(initial));
  const writes: { key: string; bytes: number }[] = [];
  const io = { reads: 0, writes: 0, maxReads: 0, maxWrites: 0 };
  const wait = () => latencyMs ? new Promise(resolve => setTimeout(resolve, latencyMs)) : Promise.resolve();
  return {
    values, writes, io,
    getLocalStorage: vi.fn(async (key: string) => {
      io.maxReads = Math.max(io.maxReads, ++io.reads);
      try { await wait(); return values.get(key) ?? ""; } finally { io.reads--; }
    }),
    setLocalStorage: vi.fn(async (key: string, value: string) => {
      io.maxWrites = Math.max(io.maxWrites, ++io.writes);
      try { await wait(); writes.push({ key, bytes: value.length }); values.set(key, value); return true; } finally { io.writes--; }
    }),
  };
}
/** A v1 archive of roughly `mb` MiB in the perf harness shape (sessions of 300 entries). */
function archive(mb: number): { sessions: HistorySession[]; entries: HistoryEntry[]; raw: string } {
  const sessions: HistorySession[] = [], entries: HistoryEntry[] = [];
  for (let s = 0, bytes = 0; bytes < mb * 1024 * 1024; s++) {
    const id = `session_seed_${s}`, at = new Date(Date.UTC(2026, 0, 1) + s * 86_400_000).toISOString();
    sessions.push(session(id, { source: s % 4 === 0 ? "omi" : "helix", startedAt: at, updatedAt: at, summary: ["Seeded summary bullet one."], people: [{ name: s % 2 ? "Elaine" : "Bob" }] }));
    for (let i = 0; i < 300; i++) {
      const text = `${SENTENCES[i % SENTENCES.length]} ${SENTENCES[(i * 7) % SENTENCES.length]}`;
      entries.push(entry(`${id}:e${i}`, id, { kind: i % 5 === 4 ? "answer" : "transcript", text, occurredAt: at, speaker: i % 2 ? "You" : "Other speaker", metadata: { model: "gpt-6.1-terra", provider: "openai" } }));
      bytes += text.length + 160;
    }
  }
  return { sessions, entries, raw: JSON.stringify({ version: 1, sessions, entries }) };
}
/** Loads, then waits for the background v1 -> v2 migration. */
async function migrated(d: ReturnType<typeof disk>, options?: ConstructorParameters<typeof LocalHistoryStore>[1]) {
  const db = new LocalHistoryStore(d, options); await db.load(); await db.flush(); return db;
}
const bytesTo = (d: ReturnType<typeof disk>, key: string) => d.writes.filter(w => w.key === key).reduce((n, w) => n + w.bytes, 0);
const reads = (db: LocalHistoryStore) => ({ sessions: db.listSessions(), entries: db.listSessions().map(s => db.getEntries(s.id)), people: db.listPeople(), stats: db.stats() });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("LocalHistoryStore v2 shards: write volume", () => {
  it("a live session over a 2 MB archive writes only its own shard and the small index, proportional to the session", async () => {
    const seed = archive(2);
    expect(seed.raw.length).toBeGreaterThan(2 * 1024 * 1024);
    const d = disk({ [V1]: seed.raw }), db = await migrated(d);
    d.writes.length = 0; d.setLocalStorage.mockClear();
    const live = session("session_live");
    await db.upsertSession(live);
    const N = 60;
    for (let i = 0; i < N; i++) {
      const at = new Date(Date.UTC(2026, 10, 10, 9, 0, i)).toISOString();
      await db.upsertSession({ ...live, updatedAt: at });
      await db.upsertEntries([entry(`session_live:t${i}`, live.id, { text: SENTENCES[i % SENTENCES.length]!, occurredAt: at, metadata: { model: "gpt-6.1-terra" } })]);
    }
    const shard = historyShardKey(live.id), shardSize = d.values.get(shard)!.length, indexSize = d.values.get(INDEX)!.length;
    expect(new Set(d.writes.map(w => w.key))).toEqual(new Set([INDEX, shard]));
    expect(d.writes.filter(w => w.key === shard)).toHaveLength(N); // One per upsertEntries; session upserts touch only the index.
    expect(Math.max(...d.writes.map(w => w.bytes))).toBeLessThanOrEqual(Math.max(shardSize, indexSize));
    expect(indexSize).toBeLessThan(20_000);
    expect(bytesTo(d, shard)).toBeLessThanOrEqual(N * shardSize);
    const total = d.writes.reduce((n, w) => n + w.bytes, 0);
    expect(total).toBeLessThan(2 * N * (shardSize + indexSize));
    // The same mutations through the v1 store rewrite the whole archive every time.
    const v1 = disk({ [V1]: seed.raw }), old = new V1Store(v1); await old.load();
    await old.upsertSession(live);
    for (let i = 0; i < 5; i++) { await old.upsertSession({ ...live, updatedAt: new Date(Date.UTC(2026, 10, 10, 9, 0, i)).toISOString() }); await old.upsertEntries([entry(`session_live:t${i}`, live.id)]); }
    expect(bytesTo(v1, V1) / 11).toBeGreaterThan(2 * 1024 * 1024);
    expect(total).toBeLessThan(bytesTo(v1, V1) / 11); // 121 v2 writes < one v1 write
    const restarted = new LocalHistoryStore(disk(Object.fromEntries(d.values))); await restarted.load();
    expect(reads(restarted)).toEqual(reads(db));
  });
  it("skips unchanged shards and an unchanged index", async () => {
    const d = disk(), db = new LocalHistoryStore(d); await db.load();
    await db.upsertSession(session("a")); await db.upsertEntries([entry("e1", "a"), entry("e2", "a")]);
    d.writes.length = 0;
    await db.upsertEntries([entry("e2", "a")]); await db.upsertSession(session("a"));
    await db.updateSessionKnowledge("a", {}); await db.deleteSession("missing");
    expect(d.writes).toEqual([]);
    await db.upsertEntries([entry("e2", "a", { text: "changed" })]); // Same size and count: the index is identical.
    expect(d.writes.map(w => w.key)).toEqual([historyShardKey("a")]);
    await db.upsertEntries([entry("e2", "a", { text: "changed again" })]);
    expect(d.writes.map(w => w.key)).toEqual([historyShardKey("a"), historyShardKey("a"), INDEX]);
  });
  it("writes the shard before the index, and on deletion the index before clearing the shard", async () => {
    const d = disk(), db = new LocalHistoryStore(d); await db.load();
    await db.upsertSession(session("a"));
    expect(d.writes.map(w => w.key)).toEqual([INDEX]); // An empty session has no shard.
    d.writes.length = 0; await db.upsertEntries([entry("e1", "a")]);
    expect(d.writes.map(w => w.key)).toEqual([historyShardKey("a"), INDEX]);
    d.writes.length = 0; await db.deleteSession("a");
    expect(d.writes.map(w => w.key)).toEqual([INDEX, historyShardKey("a")]);
    expect(d.values.get(historyShardKey("a"))).toBe("");
    expect(JSON.parse(d.values.get(INDEX)!)).toEqual({ version: 2, sessions: [], shards: {} });
  });
  it("loads only non-empty shards, with bounded concurrency", async () => {
    const d = disk({}, 2), db = new LocalHistoryStore(d); await db.load();
    for (let i = 0; i < 30; i++) { await db.upsertSession(session(`s${i}`)); if (i % 3) await db.upsertEntries([entry(`e${i}`, `s${i}`)]); }
    const cold = disk(Object.fromEntries(d.values), 3), restarted = new LocalHistoryStore(cold); await restarted.load();
    expect(cold.getLocalStorage).toHaveBeenCalledTimes(1 + 20);
    expect(cold.getLocalStorage).not.toHaveBeenCalledWith(historyShardKey("s0"));
    expect(cold.io.maxReads).toBeGreaterThan(1); expect(cold.io.maxReads).toBeLessThanOrEqual(8);
    expect(reads(restarted)).toEqual(reads(db));
  });
  it("encodes any session id into a distinct shard key and round-trips it", async () => {
    const ids = ["omi:abc:def", "obsidian:Helix%2F2026 Launch", "obsidian:Helix/2026 Launch", "__proto__", "constructor", "a\ud800b", "会议:十月", "x y?&=#"];
    expect(new Set(ids.map(historyShardKey)).size).toBe(ids.length);
    const d = disk(), db = new LocalHistoryStore(d); await db.load();
    for (const id of ids) { await db.upsertSession(session(id)); await db.upsertEntries([entry(`${id}#1`, id)]); }
    const restarted = new LocalHistoryStore(disk(Object.fromEntries(d.values))); await restarted.load();
    expect(restarted.listSessions().map(s => s.id).sort()).toEqual([...ids].sort());
    for (const id of ids) expect(restarted.getEntries(id).map(e => e.id)).toEqual([`${id}#1`]);
  });
});

describe("LocalHistoryStore v1 -> v2 migration", () => {
  it("serves v1 data at once, migrates in the background with bounded concurrency, then clears v1", async () => {
    const seed = archive(0.5), d = disk({ [V1]: seed.raw }, 3), db = new LocalHistoryStore(d);
    await db.load();
    expect(db.listSessions()).toHaveLength(seed.sessions.length); // Before any shard write completed.
    expect(d.values.has(INDEX)).toBe(false);
    await db.flush();
    expect(d.io.maxWrites).toBeGreaterThan(1); expect(d.io.maxWrites).toBeLessThanOrEqual(8);
    const keys = d.writes.map(w => w.key);
    // 300 entries per seeded session = 3 chunks of HISTORY_CHUNK_ENTRIES (v0.9.1).
    const chunkKeys = seed.sessions.flatMap(s => [0, 1, 2].map(k => historyChunkKey(s.id, k)));
    expect(keys.slice(0, chunkKeys.length).sort()).toEqual(chunkKeys.sort());
    expect(keys.slice(chunkKeys.length)).toEqual([INDEX, V1]); // Index after every chunk, v1 cleared last.
    expect(d.values.get(V1)).toBe("");
    const old = new V1Store(disk({ [V1]: seed.raw })); await old.load();
    const restarted = new LocalHistoryStore(disk(Object.fromEntries(d.values))); await restarted.load();
    expect(reads(restarted)).toEqual(reads(old as unknown as LocalHistoryStore));
    expect(JSON.parse(restarted.exportJson())).toEqual(JSON.parse(old.exportJson()));
  });
  it("keeps serving v1 when migration fails and migrates with the next save", async () => {
    const seed = archive(0.2), d = disk({ [V1]: seed.raw });
    let fail = true;
    d.setLocalStorage.mockImplementation(async (key, value) => { if (fail && key !== V1) return false; d.values.set(key, value); d.writes.push({ key, bytes: value.length }); return true; });
    const db = await migrated(d);
    expect(d.values.has(INDEX)).toBe(false); expect(d.values.get(V1)).toBe(seed.raw);
    expect(db.listSessions()).toHaveLength(seed.sessions.length);
    fail = false;
    await db.upsertSession(session("new"));
    expect(d.values.get(V1)).toBe("");
    const restarted = new LocalHistoryStore(disk(Object.fromEntries(d.values))); await restarted.load();
    expect(restarted.listSessions()).toHaveLength(seed.sessions.length + 1);
    expect(reads(restarted)).toEqual(reads(db));
  });
  it("falls back to v1 saves while migration keeps failing, retrying at most once a minute", async () => {
    const seed = archive(0.1), d = disk({ [V1]: seed.raw });
    d.setLocalStorage.mockImplementation(async (key, value) => { if (key !== V1) return false; d.values.set(key, value); d.writes.push({ key, bytes: value.length }); return true; });
    const db = await migrated(d);
    let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    d.setLocalStorage.mockClear();
    await db.upsertSession(session("a")); // Retries v2 (fails), saves v1.
    expect(d.setLocalStorage.mock.calls.some(([key]) => key !== V1)).toBe(true);
    expect(JSON.parse(d.values.get(V1)!).sessions).toHaveLength(seed.sessions.length + 1);
    d.setLocalStorage.mockClear();
    await db.upsertSession(session("b"));
    expect(d.setLocalStorage.mock.calls.map(([key]) => key)).toEqual([V1]);
    expect(db.listSessions()).toHaveLength(seed.sessions.length + 2);
    now += 60_000; d.setLocalStorage.mockImplementation(async (key, value) => { d.values.set(key, value); return true; });
    await db.upsertSession(session("c"));
    expect(d.values.get(V1)).toBe("");
    const restarted = new LocalHistoryStore(disk(Object.fromEntries(d.values))); await restarted.load();
    expect(reads(restarted)).toEqual(reads(db));
  });
  it("retries clearing the v1 key, also after a restart", async () => {
    const seed = archive(0.1), d = disk({ [V1]: seed.raw });
    let clearV1 = false;
    d.setLocalStorage.mockImplementation(async (key, value) => { if (key === V1 && !clearV1) return false; d.values.set(key, value); return true; });
    await migrated(d);
    expect(JSON.parse(d.values.get(INDEX)!).legacyV1).toBe(true);
    expect(d.values.get(V1)).toBe(seed.raw); // Ignored from now on: the v2 index exists.
    clearV1 = true;
    const restarted = new LocalHistoryStore(d); await restarted.load();
    expect(restarted.listSessions()).toHaveLength(seed.sessions.length);
    await restarted.upsertSession(session("x"));
    expect(d.values.get(V1)).toBe("");
    await restarted.upsertSession(session("y"));
    expect(JSON.parse(d.values.get(INDEX)!).legacyV1).toBeUndefined();
  });
  it("leaves invalid v1 data and an invalid index untouched", async () => {
    for (const initial of [{ [V1]: '{"version":1,"sessions":[{}],"entries":[]}' }, { [INDEX]: "{bad" }, { [INDEX]: '{"version":3,"sessions":[],"shards":{}}' }, { [INDEX]: '{"version":2,"sessions":[{"id":"x"}],"shards":{}}' }]) {
      const d = disk(initial), db = new LocalHistoryStore(d);
      await expect(db.load()).rejects.toThrow("Existing storage has not been replaced");
      await expect(db.upsertSession(session("a"))).rejects.toThrow(/history/i);
      expect(d.setLocalStorage).not.toHaveBeenCalled();
    }
  });
});

describe("LocalHistoryStore v2 failure semantics", () => {
  it.each(["shard", "index"])("keeps the last saved state when the %s write fails, and heals storage on the next save", async target => {
    const d = disk(), db = new LocalHistoryStore(d); await db.load();
    await db.upsertSession(session("a")); await db.upsertSession(session("b"));
    await db.upsertEntries([entry("a1", "a"), entry("b1", "b")]);
    const before = reads(db), stored = Object.fromEntries(d.values);
    const failKey = target === "shard" ? historyShardKey("b") : INDEX;
    d.setLocalStorage.mockImplementationOnce(async (key, value) => { if (key === failKey) throw new Error("secret bridge detail"); d.values.set(key, value); return true; });
    if (target === "index") d.setLocalStorage.mockImplementationOnce(async (key, value) => { d.values.set(key, value); return true; }).mockImplementationOnce(async () => { throw new Error("secret"); });
    // Moving a1 to b and adding a2 dirties both shards.
    const failed = db.upsertEntries([entry("a1", "b"), entry("a2", "a")]);
    await expect(failed).rejects.toThrow("Could not save local history. Storage may be full or unavailable.");
    await expect(failed).rejects.not.toThrow(/secret/);
    expect(reads(db)).toEqual(before);
    expect(d.values.get(INDEX)).toBe(stored[INDEX]);
    // An unrelated save rewrites the shards that may have diverged, so storage matches the cache again.
    await db.upsertSession(session("c"));
    const restarted = new LocalHistoryStore(disk(Object.fromEntries(d.values))); await restarted.load();
    expect(reads(restarted)).toEqual(reads(db));
    expect(restarted.getEntries("a").map(e => e.id)).toEqual(["a1"]);
  });
  it("does not resurrect a deleted session when clearing its shard fails, and retries the clear", async () => {
    const d = disk(), db = new LocalHistoryStore(d); await db.load();
    await db.upsertSession(session("a")); await db.upsertEntries([entry("a1", "a")]);
    d.setLocalStorage.mockImplementation(async (key, value) => { if (key === historyShardKey("a") && value === "") return false; d.values.set(key, value); return true; });
    await db.deleteSession("a");
    expect(db.listSessions()).toEqual([]);
    expect(d.values.get(historyShardKey("a"))).not.toBe("");
    d.setLocalStorage.mockImplementation(async (key, value) => { d.values.set(key, value); return true; });
    await db.upsertSession(session("a")); // Same id again: the stale shard must not come back.
    expect(d.values.get(historyShardKey("a"))).toBe("");
    const restarted = new LocalHistoryStore(disk(Object.fromEntries(d.values))); await restarted.load();
    expect(restarted.getEntries("a")).toEqual([]);
  });
  it("keeps the session when the deletion index write fails, without touching its shard", async () => {
    const d = disk(), db = new LocalHistoryStore(d); await db.load();
    await db.upsertSession(session("a")); await db.upsertEntries([entry("a1", "a")]);
    const shard = d.values.get(historyShardKey("a"));
    d.setLocalStorage.mockResolvedValueOnce(false);
    await expect(db.deleteSession("a")).rejects.toThrow(/save/i);
    expect(d.values.get(historyShardKey("a"))).toBe(shard);
    expect(db.getEntries("a")).toHaveLength(1);
    const restarted = new LocalHistoryStore(disk(Object.fromEntries(d.values))); await restarted.load();
    expect(restarted.getEntries("a")).toHaveLength(1);
  });
  it("enforces the 5 MiB cap across shards with the v1 message and no write", async () => {
    const d = disk(), db = new LocalHistoryStore(d); await db.load();
    await db.upsertSession(session("a")); await db.upsertSession(session("b"));
    await db.upsertEntries([entry("big-a", "a", { text: "语".repeat(900_000) })]); // ~2.7 MB UTF-8
    const before = Object.fromEntries(d.values);
    d.writes.length = 0;
    await expect(db.upsertEntries([entry("big-b", "b", { text: "语".repeat(900_000) })])).rejects.toThrow("Local history exceeds the 5 MiB storage limit. Export or delete sessions before retrying.");
    expect(d.writes).toEqual([]); expect(Object.fromEntries(d.values)).toEqual(before);
    expect(db.getEntries("b")).toEqual([]);
    await db.deleteSession("a");
    await db.upsertEntries([entry("big-b", "b", { text: "语".repeat(900_000) })]);
    expect(db.getEntries("b")).toHaveLength(1);
  });
});

describe("LocalHistoryStore v2 corrupt shards", () => {
  function corruptDisk() {
    const sessions = ["ok", "bad-json", "missing", "wrong-session", "bad-entry", "unreadable"].map(id => session(id));
    const shard = (id: string, list: unknown) => [historyShardKey(id), JSON.stringify(list)] as const;
    const meta = { bytes: 10, entries: 1 };
    const d = disk({
      [INDEX]: JSON.stringify({ version: 2, sessions, shards: Object.fromEntries(sessions.map(s => [s.id, meta])) }),
      ...Object.fromEntries([shard("ok", [entry("ok1", "ok")]), shard("wrong-session", [entry("w1", "ok")]), shard("bad-entry", [{ id: "x" }]), shard("unreadable", [entry("u1", "unreadable")])]),
      [historyShardKey("bad-json")]: "[{bad",
    });
    const read = d.getLocalStorage.getMockImplementation()!;
    d.getLocalStorage.mockImplementation(async key => { if (key === historyShardKey("unreadable")) throw new Error("bridge"); return read(key); });
    return d;
  }
  it("loads the rest, lists corrupt sessions without entries and protects their stored shards", async () => {
    const d = corruptDisk(), db = new LocalHistoryStore(d); await db.load();
    expect(db.listSessions()).toHaveLength(6);
    expect(db.getEntries("ok").map(e => e.id)).toEqual(["ok1"]);
    expect(db.corruptSessionIds().sort()).toEqual(["bad-entry", "bad-json", "missing", "unreadable", "wrong-session"]);
    expect(db.search("text")).toHaveLength(1);
    const badJson = d.values.get(historyShardKey("bad-json"));
    await expect(db.upsertEntries([entry("b1", "bad-json")])).rejects.toThrow("Existing storage has not been replaced");
    await db.upsertSession(session("bad-json", { title: "Renamed" })); // Index-only changes are fine.
    await db.upsertEntries([entry("ok2", "ok")]);
    expect(d.values.get(historyShardKey("bad-json"))).toBe(badJson);
    const index = JSON.parse(d.values.get(INDEX)!);
    expect(index.shards["bad-json"]).toEqual({ bytes: 10, entries: 1 }); // Stored meta kept, so a later load retries it.
    const restarted = new LocalHistoryStore(corruptDiskFrom(d)); await restarted.load();
    expect(restarted.listSessions().find(s => s.id === "bad-json")?.title).toBe("Renamed");
    expect(restarted.getEntries("unreadable").map(e => e.id)).toEqual(["u1"]); // Transient read failure.
    expect(restarted.getEntries("ok")).toHaveLength(2);
    await db.deleteSession("bad-json");
    expect(d.values.get(historyShardKey("bad-json"))).toBe("");
    expect(db.corruptSessionIds()).not.toContain("bad-json");
  });
  function corruptDiskFrom(d: ReturnType<typeof disk>) { return disk(Object.fromEntries(d.values)); }
});

describe("LocalHistoryStore write coalescing", () => {
  it("merges mutations in the window into one shard write and one index write; reads see them only after the save", async () => {
    vi.useFakeTimers();
    const d = disk(), db = new LocalHistoryStore(d, { writeDelayMs: 3000 }); await db.load();
    const settled: string[] = [];
    const calls = [db.upsertSession(session("live")), ...Array.from({ length: 10 }, (_, i) => [db.upsertSession(session("live", { updatedAt: `2026-09-01T00:00:${String(i).padStart(2, "0")}Z` })), db.upsertEntries([entry(`t${i}`, "live")])]).flat(),
      db.updateSessionKnowledge("live", { summary: ["Coalesced."] })];
    calls.forEach((call, i) => void call.then(() => settled.push(`ok${i}`), () => settled.push(`err${i}`)));
    await vi.advanceTimersByTimeAsync(2999);
    expect(d.writes).toEqual([]); expect(db.listSessions()).toEqual([]); expect(settled).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(calls);
    expect(d.writes.map(w => w.key)).toEqual([historyShardKey("live"), INDEX]);
    expect(settled).toHaveLength(calls.length);
    expect(db.getEntries("live")).toHaveLength(10);
    expect(db.listSessions()[0]).toMatchObject({ updatedAt: "2026-09-01T00:00:09Z", summary: ["Coalesced."] });
  });
  it("rejects every caller of a failed batch, keeps the cache, and rejects invalid mutations alone", async () => {
    vi.useFakeTimers();
    const d = disk(), db = new LocalHistoryStore(d, { writeDelayMs: 1000 }); await db.load();
    const orphan = db.upsertEntries([entry("o", "nope")]);
    await expect(orphan).rejects.toThrow(/without their session/);
    d.setLocalStorage.mockResolvedValueOnce(false);
    const batch = [db.upsertSession(session("a")), db.upsertEntries([entry("a1", "a")])];
    const outcomes = Promise.allSettled(batch);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await outcomes).map(o => o.status)).toEqual(["rejected", "rejected"]);
    expect(db.listSessions()).toEqual([]);
    const retry = [db.upsertSession(session("a")), db.upsertEntries([entry("a1", "a")])];
    await vi.advanceTimersByTimeAsync(1000); await Promise.all(retry);
    expect(db.getEntries("a")).toHaveLength(1);
  });
  it("flush() saves now; flush() rejects with a failed batch; writeDelayMs = 0 saves pending mutations", async () => {
    const d = disk(), db = new LocalHistoryStore(d, { writeDelayMs: 60_000 }); await db.load();
    const first = db.upsertSession(session("a")), second = db.upsertEntries([entry("a1", "a")]);
    await db.flush();
    await Promise.all([first, second]);
    expect(d.writes.map(w => w.key)).toEqual([historyShardKey("a"), INDEX]);
    d.setLocalStorage.mockResolvedValueOnce(false);
    const failed = db.upsertEntries([entry("a2", "a")]);
    await expect(db.flush()).rejects.toThrow(/save/i); await expect(failed).rejects.toThrow(/save/i);
    await expect(db.flush()).resolves.toBeUndefined(); // Nothing pending.
    const pending = db.upsertEntries([entry("a3", "a")]);
    expect(db.writeDelayMs).toBe(60_000);
    db.writeDelayMs = 0;
    await pending;
    expect(db.getEntries("a").map(e => e.id)).toEqual(["a1", "a3"]);
    await db.upsertEntries([entry("a4", "a")]); // Delay 0: saved before resolving, no flush needed.
    expect(d.values.get(historyShardKey("a"))).toContain("a4");
  });
  it("orders coalesced deletions after earlier writes and keeps the deleted shard cleared", async () => {
    const d = disk(), db = new LocalHistoryStore(d, { writeDelayMs: 60_000 }); await db.load();
    const ops = [db.upsertSession(session("a")), db.upsertEntries([entry("a1", "a")]), db.deleteSession("a"), db.upsertSession(session("b")), db.upsertEntries([entry("b1", "b")])];
    await db.flush(); await Promise.all(ops);
    expect(db.listSessions().map(s => s.id)).toEqual(["b"]);
    expect(d.values.get(historyShardKey("a")) ?? "").toBe("");
    const restarted = new LocalHistoryStore(disk(Object.fromEntries(d.values))); await restarted.load();
    expect(reads(restarted)).toEqual(reads(db));
  });
});

describe("LocalHistoryStore v2 matches the v1 store", () => {
  /** Deterministic random archive operations: sessions with ":"/"%" ids, replacements, cross-session moves, knowledge, deletions. */
  function operations(seed: number) {
    let state = seed;
    const random = () => { state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
    const ids = ["session_a", "omi:conv:1", "obsidian:Helix%2FLaunch", "session_b", "omi:conv:2", "session_c"];
    const ops: ((db: LocalHistoryStore | V1Store) => Promise<void>)[] = [];
    for (let i = 0; i < 160; i++) {
      const sessionId = pick(ids), at = new Date(Date.UTC(2026, 8, 1) + Math.floor(random() * 90) * 86_400_000).toISOString(), roll = random();
      if (roll < 0.25) {
        const s = session(sessionId, { source: sessionId.startsWith("omi") ? "omi" : sessionId.startsWith("obsidian") ? "obsidian" : "helix", title: pick(["Launch", "Budget review", "预算", "Jetson sync"]), updatedAt: at,
          ...(random() < 0.3 ? { people: [{ name: pick(["Elaine", "elaine", "Bob", "Priya Raman"]), ...(random() < 0.5 ? { role: pick(["PM", "CTO"]) } : {}), ...(random() < 0.5 ? { mentions: 1 + Math.floor(random() * 4) } : {}) }] } : {}) });
        ops.push(db => db.upsertSession(s));
      } else if (roll < 0.85) {
        const list = Array.from({ length: 1 + Math.floor(random() * 3) }, () => entry(`e${Math.floor(random() * 120)}`, sessionId, {
          kind: pick(["transcript", "transcript", "answer", "fact-check", "question"] as const), text: `${pick(SENTENCES)} ${pick(SENTENCES)}${random() < 0.1 ? ` ${"filler words. ".repeat(80)}` : ""}`,
          occurredAt: at, speaker: pick(["You", "Other speaker", "assistant", "Bob"]),
          ...(random() < 0.2 ? { metadata: { origin: "omi-summary" } } : {}) }));
        ops.push(db => db.upsertEntries(list));
      } else if (roll < 0.95) {
        // v0.16: the summary of an imported session is searched as a record of its own, which the v1 store never did;
        // the stores are compared on live sessions' summaries and on imported sessions' tags.
        const text = pick(SENTENCES), live = sessionId.startsWith("session_");
        const patch = { ...(live ? { summary: [text] } : {}), ...(random() < 0.5 ? { people: [{ name: pick(["Elaine", "Kan"]), mentions: 2 }] } : { tags: live ? [] : [text.slice(0, 20)] }) };
        ops.push(db => db.updateSessionKnowledge(sessionId, patch));
      } else ops.push(db => db.deleteSession(sessionId));
    }
    return ops;
  }
  const QUERIES = ["Jetson lead time", "budget", "发布计划", "十", "calibration report Thursday", "October launch", "RAM detector", "Launch", "the and is", "filler"];
  function results(db: LocalHistoryStore | V1Store) {
    const sessions = db.listSessions();
    return { ...reads(db as LocalHistoryStore),
      search: QUERIES.map(q => db.search(q)), retrieve: QUERIES.map(q => db.retrieve(q)),
      stats: QUERIES.map(q => db.retrieveWithStats(q, { excludeSessionId: sessions[0]?.id, limit: 8, maxChars: 900 })), kb: db.stats() };
  }
  it.each([1, 2, 3, 4])("search/retrieve/listPeople/stats are identical for the same operations (seed %i), sequential and coalesced, before and after restart", async seed => {
    const ops = operations(seed);
    const v1 = new V1Store(disk()); await v1.load();
    const d = disk(), v2 = new LocalHistoryStore(d); await v2.load();
    for (const op of ops) {
      const [a, b] = await Promise.allSettled([op(v1), op(v2)]);
      expect(b.status).toBe(a.status);
      if (a.status === "rejected" && b.status === "rejected") expect(String(b.reason)).toBe(String(a.reason));
    }
    const expected = results(v1);
    expect(results(v2)).toEqual(expected);
    expect(JSON.parse(v2.exportJson()).entries.sort((x: HistoryEntry, y: HistoryEntry) => x.id.localeCompare(y.id)))
      .toEqual(JSON.parse(v1.exportJson()).entries.sort((x: HistoryEntry, y: HistoryEntry) => x.id.localeCompare(y.id)));
    const restarted = new LocalHistoryStore(disk(Object.fromEntries(d.values))); await restarted.load();
    expect(results(restarted)).toEqual(expected);
    // Same operations issued at once into one coalesced batch.
    const c = disk(), coalesced = new LocalHistoryStore(c, { writeDelayMs: 60_000 }); await coalesced.load();
    const pending = ops.map(op => op(coalesced).catch(() => undefined));
    await coalesced.flush(); await Promise.all(pending);
    expect(results(coalesced)).toEqual(expected);
    expect(c.writes.filter(w => w.key === INDEX)).toHaveLength(1);
    // And through v1 storage + migration.
    const m = await migrated(disk({ [V1]: v1.exportJson() }));
    expect(results(m)).toEqual(expected);
  });
});

describe("LocalHistoryStore v0.9.1 chunked shards", () => {
  const live = (n: number, sessionId = "live") => Array.from({ length: n }, (_, i) => entry(`${sessionId}:t${i}`, sessionId, { text: SENTENCES[i % SENTENCES.length]!, occurredAt: new Date(Date.UTC(2026, 10, 12, 9, 0, i)).toISOString() }));
  it("a long live session rewrites only its last chunk: save size stays flat however long the meeting runs", async () => {
    expect(HISTORY_CHUNK_ENTRIES).toBe(100);
    const d = disk(), db = new LocalHistoryStore(d); await db.load();
    await db.upsertSession(session("live"));
    const all = live(1000), perSave: number[] = [];
    for (let i = 0; i < all.length; i += 10) {
      const before = d.writes.length;
      await db.upsertEntries(all.slice(i, i + 10));
      perSave.push(d.writes.slice(before).filter(w => w.key !== INDEX).reduce((n, w) => n + w.bytes, 0));
      expect(d.writes.slice(before).filter(w => w.key !== INDEX)).toHaveLength(1); // One chunk per save.
    }
    // The 100th save writes no more than the 10th (one partly filled chunk), not 10x more as with one shard.
    expect(Math.max(...perSave)).toBeLessThanOrEqual(perSave[9]! * 1.05);
    expect(JSON.parse(d.values.get(INDEX)!).shards.live).toMatchObject({ entries: 1000, chunks: 10 });
    const restarted = new LocalHistoryStore(disk(Object.fromEntries(d.values))); await restarted.load();
    expect(restarted.getEntries("live").map(e => e.id)).toEqual(all.map(e => e.id));
    expect(reads(restarted)).toEqual(reads(db));
  });
  it("rewrites an earlier chunk only when one of its entries changed, and keeps every chunk readable", async () => {
    const d = disk(), db = new LocalHistoryStore(d, { chunkEntries: 4 }); await db.load();
    await db.upsertSession(session("a")); await db.upsertEntries(live(10, "a"));
    expect(d.values.has(historyChunkKey("a", 2))).toBe(true);
    d.writes.length = 0;
    await db.upsertEntries([entry("a:t1", "a", { text: "corrected" })]);
    expect(d.writes.map(w => w.key)).toEqual([historyChunkKey("a", 0), INDEX]);
    const restarted = new LocalHistoryStore(disk(Object.fromEntries(d.values)), { chunkEntries: 4 }); await restarted.load();
    expect(restarted.getEntries("a").find(e => e.id === "a:t1")?.text).toBe("corrected");
    expect(restarted.getEntries("a")).toHaveLength(10);
  });
  it("moving entries out shrinks the shard and clears the surplus chunk keys after the index", async () => {
    const d = disk(), db = new LocalHistoryStore(d, { chunkEntries: 4 }); await db.load();
    await db.upsertSession(session("a")); await db.upsertSession(session("b"));
    await db.upsertEntries(live(10, "a"));
    d.writes.length = 0;
    await db.upsertEntries(live(10, "a").slice(4).map(e => ({ ...e, sessionId: "b" }))); // 6 entries move a -> b
    const keys = d.writes.map(w => w.key);
    expect(keys.indexOf(INDEX)).toBeLessThan(keys.indexOf(historyChunkKey("a", 1)));
    expect(d.values.get(historyChunkKey("a", 1))).toBe(""); expect(d.values.get(historyChunkKey("a", 2))).toBe("");
    expect(JSON.parse(d.values.get(INDEX)!).shards.a).toEqual({ bytes: expect.any(Number), entries: 4 });
    const restarted = new LocalHistoryStore(disk(Object.fromEntries(d.values)), { chunkEntries: 4 }); await restarted.load();
    expect(restarted.getEntries("a")).toHaveLength(4); expect(restarted.getEntries("b")).toHaveLength(6);
    expect(reads(restarted)).toEqual(reads(db));
  });
  it("deleting a chunked session clears every chunk key", async () => {
    const d = disk(), db = new LocalHistoryStore(d, { chunkEntries: 4 }); await db.load();
    await db.upsertSession(session("a")); await db.upsertEntries(live(9, "a"));
    await db.deleteSession("a");
    for (const k of [0, 1, 2]) expect(d.values.get(historyChunkKey("a", k))).toBe("");
    expect(JSON.parse(d.values.get(INDEX)!)).toEqual({ version: 2, sessions: [], shards: {} });
  });
  it("a missing chunk marks the session unreadable and protects its stored chunks", async () => {
    const d = disk(), db = new LocalHistoryStore(d, { chunkEntries: 4 }); await db.load();
    await db.upsertSession(session("a")); await db.upsertEntries(live(9, "a"));
    await db.upsertSession(session("b")); await db.upsertEntries(live(3, "b"));
    const values = Object.fromEntries(d.values); values[historyChunkKey("a", 1)] = "";
    const cold = disk(values), restarted = new LocalHistoryStore(cold, { chunkEntries: 4 }); await restarted.load();
    expect(restarted.corruptSessionIds()).toEqual(["a"]);
    expect(restarted.getEntries("b")).toHaveLength(3);
    await restarted.upsertEntries([entry("b:new", "b")]);
    expect(cold.values.get(historyChunkKey("a", 0))).toBe(values[historyChunkKey("a", 0)]);
    expect(cold.values.get(historyChunkKey("a", 2))).toBe(values[historyChunkKey("a", 2)]);
  });
  it("a duplicate left by an interrupted save is read once and the shard is rewritten clean", async () => {
    const d = disk(), db = new LocalHistoryStore(d, { chunkEntries: 4 }); await db.load();
    await db.upsertSession(session("a")); await db.upsertEntries(live(8, "a"));
    const values = Object.fromEntries(d.values);
    values[historyChunkKey("a", 1)] = JSON.stringify([...JSON.parse(values[historyChunkKey("a", 1)]!), JSON.parse(values[historyChunkKey("a", 0)]!)[0]]);
    const cold = disk(values), restarted = new LocalHistoryStore(cold, { chunkEntries: 4 }); await restarted.load();
    expect(restarted.getEntries("a").map(e => e.id)).toEqual(live(8, "a").map(e => e.id));
    await restarted.upsertEntries([entry("a:t8", "a")]);
    expect(JSON.parse(cold.values.get(historyChunkKey("a", 1))!)).toHaveLength(4);
    expect(JSON.parse(cold.values.get(historyChunkKey("a", 2))!)).toHaveLength(1);
  });
  it("reads a v0.9.0 single-shard session and splits it into chunks on its next save", async () => {
    const entries = live(250, "old");
    const values = { [INDEX]: JSON.stringify({ version: 2, sessions: [session("old")], shards: { old: { bytes: JSON.stringify(entries).length, entries: 250 } } }), [historyShardKey("old")]: JSON.stringify(entries) };
    const d = disk(values), db = new LocalHistoryStore(d); await db.load();
    expect(db.getEntries("old")).toHaveLength(250);
    await db.upsertEntries([entry("old:new", "old")]);
    expect(JSON.parse(d.values.get(INDEX)!).shards.old).toMatchObject({ entries: 251, chunks: 3 });
    const restarted = new LocalHistoryStore(disk(Object.fromEntries(d.values))); await restarted.load();
    expect(restarted.getEntries("old")).toHaveLength(251);
  });
});
