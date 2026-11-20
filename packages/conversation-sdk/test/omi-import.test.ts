import { describe, expect, it, vi } from "vitest";
import { LocalHistoryStore, importOmiConversations } from "../src/index.js";

const key = "test-only-placeholder";
function conversation(id: string) { return { id, created_at: "2026-09-01T00:00:00Z", started_at: "2026-09-01T00:00:00Z", finished_at: "2026-09-01T00:01:00Z", structured: { title: `Launch ${id}`, overview: "Launch plan overview" }, transcript_segments: [{ id: "seg-0", text: "发布计划改到十月。 October launch.", start: 12, end: 15, speaker_id: 2, speaker_name: "Ada" }] }; }
async function setup() { const disk = { getLocalStorage: async () => "", setLocalStorage: vi.fn(async () => true) }; const store = new LocalHistoryStore(disk); await store.load(); return { store, disk }; }

describe("explicit Omi conversation import", () => {
  it("imports two pages repeatably, retaining timestamps/speakers and using fixed direct requests", async () => {
    const { store } = await setup(), progress = vi.fn();
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => Response.json(new URL(url).searchParams.get("offset") === "0" ? Array.from({ length: 25 }, (_, i) => conversation(String(i))) : [conversation("last")]));
    const args = { key, store, fetch: fetcher, startDate: "2026-09-01", endDate: "2026-09-10", onProgress: progress };
    await expect(importOmiConversations(args)).resolves.toEqual({ imported: 26, pages: 2 });
    await importOmiConversations(args); expect(store.listSessions()).toHaveLength(26);
    const passages = store.getEntries("omi:0").filter(x => x.kind === "transcript");
    expect(passages).toHaveLength(1); expect(passages[0]).toMatchObject({ speaker: "Ada", occurredAt: "2026-09-01T00:00:12.000Z" });
    expect(store.retrieve("发布计划")[0]?.session.source).toBe("omi");
    for (const [url, init] of fetcher.mock.calls) {
      expect(new URL(url).origin + new URL(url).pathname).toBe("https://api.omi.me/v1/dev/user/conversations");
      expect(new URL(url).searchParams.get("include_transcript")).toBe("true"); expect(new URL(url).searchParams.get("limit")).toBe("25");
      expect(new URL(url).searchParams.get("start_date")).toBe("2026-09-01T00:00:00.000Z");
      expect(init).toMatchObject({ redirect: "error", headers: { Authorization: `Bearer ${key}` } });
    }
    expect(progress).toHaveBeenLastCalledWith({ imported: 26, pages: 2 }); expect(store.exportJson()).not.toContain(key);
  });
  it("retains titles and overviews with no fabricated transcript or summary retrieval", async () => {
    const { store } = await setup(); const c = { ...conversation("summary"), transcript_segments: null };
    await importOmiConversations({ key, store, fetch: async () => Response.json([c]) });
    expect(store.listSessions()[0]?.title).toBe("Launch summary");
    expect(store.getEntries("omi:summary").some(x => x.kind === "transcript")).toBe(false);
    expect(store.search("overview")[0]?.entry.text).toContain("Launch plan overview");
    expect(store.retrieve("overview")).toEqual([]);
  });
  it("preserves earlier pages when cancelled and discards a late response", async () => {
    const { store } = await setup(); const abort = new AbortController();
    const fetcher = vi.fn(async (url: string) => { if (new URL(url).searchParams.get("offset") === "0") return Response.json(Array.from({ length: 25 }, (_, i) => conversation(String(i)))); abort.abort(); return Response.json([conversation("late")]); });
    await expect(importOmiConversations({ key, store, fetch: fetcher, signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(store.listSessions()).toHaveLength(25); expect(store.getEntries("omi:late")).toEqual([]);
    await expect(importOmiConversations({ key, store, fetch: fetcher, signal: abort.signal })).rejects.toMatchObject({ name: "AbortError" }); expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("rejects repeated page IDs explicitly and keeps already saved records", async () => {
    const { store } = await setup(); const fetcher = vi.fn(async () => Response.json(Array.from({ length: 25 }, (_, i) => conversation(String(i)))));
    await expect(importOmiConversations({ key, store, fetch: fetcher })).rejects.toThrow(/repeat|duplicate|incomplete/i);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(store.listSessions()).toHaveLength(25);
  });
  it.each([{ key: "" }, { key: "bad\nheader" }, { startDate: "not-a-date" }, { startDate: "2026-02-30" }, { startDate: "2026-09-10", endDate: "2026-09-01" }])("rejects invalid inputs before dispatch: %o", async invalid => {
    const { store } = await setup(), fetcher = vi.fn();
    await expect(importOmiConversations({ key, store, fetch: fetcher, ...invalid })).rejects.toThrow(/key|date/i);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([null, {}, [null], [{ id: "bad" }], [{ ...conversation("bad"), transcript_segments: [{ text: 42 }] }]])("rejects invalid response schemas: %o", async body => {
    const { store } = await setup(); await expect(importOmiConversations({ key, store, fetch: async () => Response.json(body) })).rejects.toThrow(/response/i);
    expect(store.listSessions()).toEqual([]);
  });
  it("sanitizes failed provider and JSON errors", async () => {
    const { store } = await setup();
    for (const fetcher of [async () => new Response(`private ${key}`, { status: 401 }), async () => new Response(`private ${key}`), async () => { throw new Error(`private ${key}`); }]) {
      try { await importOmiConversations({ key, store, fetch: fetcher }); expect.fail("must fail"); } catch (error) { expect(String(error)).not.toContain(key); expect(String(error)).not.toContain("private"); }
    }
  });
  it("reports storage failure without counting a conversation as imported", async () => {
    const { store, disk } = await setup(); const progress = vi.fn(); disk.setLocalStorage.mockResolvedValueOnce(false);
    await expect(importOmiConversations({ key, store, onProgress: progress, fetch: async () => Response.json([conversation("a")]) })).rejects.toThrow(/sav|storage/i);
    expect(store.listSessions()).toEqual([]); expect(progress).not.toHaveBeenCalledWith(expect.objectContaining({ imported: 1 }));
  });
  it("ends explicitly incomplete at the 200-page cap", async () => {
    const { store } = await setup(), progress = vi.fn();
    vi.spyOn(store, "upsertSession").mockResolvedValue(); vi.spyOn(store, "upsertEntries").mockResolvedValue();
    const fetcher = vi.fn(async (url: string) => { const offset = Number(new URL(url).searchParams.get("offset")); return Response.json(Array.from({ length: 25 }, (_, i) => conversation(String(offset + i)))); });
    await expect(importOmiConversations({ key, store, fetch: fetcher, onProgress: progress })).rejects.toThrow(/incomplete.*200-page/i);
    expect(fetcher).toHaveBeenCalledTimes(200); expect(progress).toHaveBeenLastCalledWith({ imported: 5000, pages: 200 });
  });
  it("keeps completed pages on provider failure and rejects redirected responses", async () => {
    const { store } = await setup(); let calls = 0;
    await expect(importOmiConversations({ key, store, fetch: async () => ++calls === 1 ? Response.json(Array.from({ length: 25 }, (_, i) => conversation(String(i)))) : new Response("private", { status: 503 }) })).rejects.toThrow(/failed/i);
    expect(store.listSessions()).toHaveLength(25);
    const redirected = Response.json([conversation("redirect")]); Object.defineProperty(redirected, "redirected", { value: true });
    await expect(importOmiConversations({ key, store, fetch: async () => redirected })).rejects.toThrow(/failed/i);
    expect(store.listSessions()).toHaveLength(25);
  });
  it("namespaces unusual IDs without collision and falls back to created time and speaker ID", async () => {
    const { store } = await setup();
    const c = { ...conversation("a:transcript/id"), started_at: null, finished_at: null, transcript_segments: [{ text: "A launch note", speaker_id: 4, start: 0 }] };
    await importOmiConversations({ key, store, fetch: async () => Response.json([c]) });
    expect(store.listSessions()[0]?.id).toBe("omi:a%3Atranscript%2Fid");
    expect(store.retrieve("launch")[0]?.entry).toMatchObject({ speaker: "Speaker 4", occurredAt: "2026-09-01T00:00:00.000Z" });
  });
});
