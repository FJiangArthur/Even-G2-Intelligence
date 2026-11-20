import { describe, expect, it, vi } from "vitest";
import { DirectConversationTransport, type DirectConversationOptions } from "../src/direct-transport.js";
import { HelixConversationClient } from "../src/client.js";
import { InMemoryNoteSink } from "../src/notes.js";
import { EMPTY_OPENAI_KNOWLEDGE, cleanOpenAIKnowledgeState, deleteOpenAIKnowledge, searchOpenAIKnowledge, syncOpenAIKnowledge, type AnswerMeta, type KnowledgeDocument, type SessionConfig } from "../src/index.js";
import type { RetrievedMemory } from "../src/local-history.js";

/** Minimal OpenAI Files + Vector Stores + Retrieval API. Records every call; no network. */
function fakeOpenAI(options: { searchDelayMs?: number; failUploadOf?: string } = {}) {
  let seq = 0;
  const stores = new Map<string, Map<string, { attributes: Record<string, string>; text: string; chunking: unknown }>>();
  const files = new Map<string, { name: string; text: string }>();
  const calls: { method: string; path: string; auth: string | null }[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.replace("https://api.openai.com/v1", ""), method = init.method ?? "GET";
    calls.push({ method, path, auth: new Headers(init.headers).get("Authorization") });
    expect(url.startsWith("https://api.openai.com/v1/")).toBe(true);
    if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
    let m: RegExpMatchArray | null;
    if (method === "POST" && path === "/vector_stores") { const id = `vs_${++seq}`; stores.set(id, new Map()); return Response.json({ id }); }
    if ((m = path.match(/^\/vector_stores\/(vs_\w+)$/u))) {
      if (!stores.has(m[1]!)) return Response.json({ error: { message: "not found" } }, { status: 404 });
      if (method === "DELETE") stores.delete(m[1]!);
      return Response.json({ id: m[1] });
    }
    if (method === "POST" && path === "/files") {
      const form = init.body as FormData, file = form.get("file") as File;
      expect(form.get("purpose")).toBe("assistants"); expect(file.name).toMatch(/\.md$/u);
      const text = await file.text();
      if (options.failUploadOf && text.includes(options.failUploadOf)) return Response.json({ error: { message: "server error" } }, { status: 500 });
      const id = `file-${++seq}`; files.set(id, { name: file.name, text }); return Response.json({ id });
    }
    if (method === "DELETE" && (m = path.match(/^\/files\/(file-\w+)$/u))) { files.delete(m[1]!); for (const store of stores.values()) store.delete(m[1]!); return Response.json({ deleted: true }); }
    if (method === "POST" && (m = path.match(/^\/vector_stores\/(vs_\w+)\/files$/u))) {
      const body = JSON.parse(init.body as string);
      stores.get(m[1]!)!.set(body.file_id, { attributes: body.attributes, text: files.get(body.file_id)!.text, chunking: body.chunking_strategy });
      return Response.json({ id: body.file_id, status: "in_progress" });
    }
    if (method === "POST" && (m = path.match(/^\/vector_stores\/(vs_\w+)\/search$/u))) {
      const body = JSON.parse(init.body as string);
      if (options.searchDelayMs) await new Promise((done, fail) => { const t = setTimeout(done, options.searchDelayMs); init.signal?.addEventListener("abort", () => { clearTimeout(t); fail(new DOMException("aborted", "AbortError")); }); });
      const words = String(body.query).toLowerCase().split(/\W+/u).filter(w => w.length > 3);
      const data = [...stores.get(m[1]!)!].filter(([, f]) => words.some(w => f.text.toLowerCase().includes(w)))
        .map(([file_id, f]) => ({ file_id, filename: "x.md", score: 0.8, attributes: f.attributes, content: [{ type: "text", text: f.text }] })).slice(0, body.max_num_results);
      return Response.json({ object: "vector_store.search_results.page", search_query: body.query, data, has_more: false });
    }
    return Response.json({ error: { message: `unexpected ${method} ${path}` } }, { status: 400 });
  });
  return { fetcher, stores, files, calls };
}
const doc = (id: string, text: string, stamp = "1"): KnowledgeDocument => ({ id, stamp, title: `Meeting ${id}`, date: "2026-11-01T10:00:00.000Z", markdown: `# Meeting ${id}\n\n${text}` });

describe("v0.12 OpenAI knowledge base", () => {
  it("sync creates the store once, uploads new and changed sessions with attributes and small chunks, and removes deleted ones", async () => {
    const api = fakeOpenAI();
    const first = await syncOpenAIKnowledge(api.fetcher, " k ", [doc("a", "Orin lead time is twelve weeks."), doc("b", "Budget approved for compute."), doc("empty", "   ")].map(d => d.id === "empty" ? { ...d, markdown: "  " } : d), EMPTY_OPENAI_KNOWLEDGE);
    expect(first.progress).toMatchObject({ uploaded: 2, removed: 0, failed: 0, total: 2 });
    expect(first.state.vectorStoreId).toBe("vs_1");
    expect(Object.keys(first.state.files).sort()).toEqual(["a", "b"]);
    const stored = [...api.stores.get("vs_1")!.values()];
    expect(stored[0]).toMatchObject({ attributes: { document_id: "a", title: "Meeting a", date: "2026-11-01T10:00:00.000Z" }, chunking: { type: "static", static: { max_chunk_size_tokens: 300 } } });
    expect(api.calls.every(call => call.auth === "Bearer k")).toBe(true);

    // Second run: a unchanged, b changed, c new, and a session deleted on the phone ("gone") is removed remotely.
    const withGone = { ...first.state, files: { ...first.state.files, gone: first.state.files.b! } };
    api.calls.length = 0;
    const states: number[] = [];
    const second = await syncOpenAIKnowledge(api.fetcher, "k", [doc("a", "Orin lead time is twelve weeks."), doc("b", "Budget approved, twice.", "2"), doc("c", "New notes.")], { ...withGone, files: { ...withGone.files, b: first.state.files.b!, gone: { fileId: "file-99", stamp: "1" } } },
      { onState: state => states.push(Object.keys(state.files).length) });
    expect(second.progress).toMatchObject({ uploaded: 2, removed: 1, failed: 0 });
    expect(api.calls.filter(call => call.method === "POST" && call.path === "/vector_stores")).toHaveLength(0);
    expect(Object.keys(second.state.files).sort()).toEqual(["a", "b", "c"]);
    expect(second.state.files.a).toEqual(first.state.files.a);
    expect(second.state.files.b!.stamp).toBe("2");
    expect(api.files.has(first.state.files.b!.fileId)).toBe(false); // the old version of b is gone
    expect(states.length).toBeGreaterThan(1);
  });
  it("a failed upload is counted and retried on the next sync; a store deleted at OpenAI is recreated", async () => {
    const api = fakeOpenAI({ failUploadOf: "BROKEN" });
    const first = await syncOpenAIKnowledge(api.fetcher, "k", [doc("a", "fine"), doc("b", "BROKEN")], EMPTY_OPENAI_KNOWLEDGE);
    expect(first.progress).toMatchObject({ uploaded: 1, failed: 1 });
    expect(Object.keys(first.state.files)).toEqual(["a"]);
    api.stores.clear(); // removed in the OpenAI dashboard
    const again = fakeOpenAI(); again.stores.clear();
    const second = await syncOpenAIKnowledge(again.fetcher, "k", [doc("a", "fine"), doc("b", "fixed")], first.state);
    expect(second.state.vectorStoreId).toBe("vs_1");
    expect(second.progress.uploaded).toBe(2);
    await expect(syncOpenAIKnowledge(again.fetcher, "  ", [], EMPTY_OPENAI_KNOWLEDGE)).rejects.toThrow(/OpenAI API key/u);
  });
  it("search returns passages with their session, delete removes every file and the store, and saved state is validated", async () => {
    const api = fakeOpenAI();
    const { state } = await syncOpenAIKnowledge(api.fetcher, "k", [doc("a", "Orin lead time is twelve weeks."), doc("b", "Budget approved.")], EMPTY_OPENAI_KNOWLEDGE);
    const hits = await searchOpenAIKnowledge(api.fetcher, "k", state.vectorStoreId!, "What is the Orin lead time?");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ documentId: "a", title: "Meeting a", score: 0.8 });
    expect(hits[0]!.text).toContain("twelve weeks");
    expect(await searchOpenAIKnowledge(api.fetcher, "k", state.vectorStoreId!, "   ")).toEqual([]);
    await deleteOpenAIKnowledge(api.fetcher, "k", state);
    expect(api.files.size).toBe(0); expect(api.stores.size).toBe(0);
    expect(cleanOpenAIKnowledgeState({ vectorStoreId: "https://evil.example/x", files: { a: { fileId: "../x", stamp: "1" }, b: { fileId: "file-abc", stamp: "2" } }, syncedAt: 5 }))
      .toEqual({ files: { b: { fileId: "file-abc", stamp: "2" } } });
    expect(cleanOpenAIKnowledgeState("junk")).toEqual(EMPTY_OPENAI_KNOWLEDGE);
  });
});

const config: SessionConfig = {
  sessionId: "live", endpoint: { id: "openai-direct", url: "https://api.openai.com/v1/responses", provider: "openai", model: "gpt-6.1-terra" },
  prompt: { id: "p", version: "1", system: "Be brief.", maxResponseSentences: 2 },
  providers: { transcriptionProvider: "openai-transcribe", answerProvider: "openai-responses" },
  speaker: { label: "User", role: "unknown" }, mode: "office-discussion", responseStrategy: "reactive", locale: "en-US",
  automation: { detectQuestions: true, answerQuestions: true, saveNotes: false }, memory: { readOmiContext: false, syncNotes: false },
};
function answerStream(text: string) {
  const encoder = new TextEncoder();
  const events = [{ type: "response.output_text.delta", delta: text }, { type: "response.completed", response: { status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 5 } } }];
  return new Response(new ReadableStream<Uint8Array>({ start(c) { for (const event of events) c.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); c.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
}
async function ask(api: ReturnType<typeof fakeOpenAI>, options: DirectConversationOptions, question: string) {
  const metas: AnswerMeta[] = [], memories: RetrievedMemory[][] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => url.endsWith("/responses") ? answerStream("About twelve weeks [M1].") : api.fetcher(url, init));
  const transport = new DirectConversationTransport({ fetch: fetcher, onAnswerMeta: m => metas.push(m), onMemoryRetrieved: items => memories.push(items), ...options });
  const client = new HelixConversationClient(transport, { vad: false, noteSink: new InMemoryNoteSink(), autoSaveSuggestedNotes: true });
  await client.start(config, { openai: "k" }); await client.ask(question);
  await vi.waitFor(() => expect(metas).toHaveLength(1), { timeout: 4000 });
  const answerCall = fetcher.mock.calls.find(call => (call[0] as string).endsWith("/responses"))!;
  const instructions = JSON.parse((answerCall[1] as RequestInit).body as string).instructions as string;
  await client.dispose();
  return { meta: metas[0]!, memories: memories.at(-1) ?? [], instructions, calls: api.calls };
}

describe("v0.12 answers reference the knowledge base", () => {
  const localHit: RetrievedMemory = { entry: { id: "l1", sessionId: "old", kind: "transcript", text: "LOCAL: lead time was ten weeks.", occurredAt: "2026-09-01T00:00:00Z" },
    session: { id: "old", source: "helix", title: "Old", startedAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" }, score: 1 };
  const local = () => ({ items: [localHit], searchedEntries: 40, matched: 1 });

  it("OpenAI source: the passages from the vector store are quoted to the model and cited, with the saved session attached", async () => {
    const api = fakeOpenAI();
    const { state } = await syncOpenAIKnowledge(api.fetcher, "k", [doc("a", "Orin lead time is twelve weeks."), doc("live", "This live session mentions Orin lead time too.")], EMPTY_OPENAI_KNOWLEDGE);
    const resolveSession = vi.fn((id: string) => id === "a" ? { id: "a", source: "omi" as const, title: "Vendor call", startedAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" } : undefined);
    const result = await ask(api, { retrieveMemoryWithStats: local, openaiKnowledge: () => ({ vectorStoreId: state.vectorStoreId!, resolveSession }) }, "What is the Orin lead time?");
    expect(result.instructions).toContain("twelve weeks"); expect(result.instructions).toContain("[M1]");
    expect(result.instructions).not.toContain("LOCAL:");
    expect(result.instructions).not.toContain("This live session"); // the current session is never its own evidence
    expect(result.meta).toMatchObject({ grounded: "memory", retrieval: { matched: 1, knowledge: "openai" } });
    expect(result.memories[0]).toMatchObject({ session: { id: "a", title: "Vendor call", source: "omi" }, entry: { sessionId: "a", metadata: { origin: "openai-knowledge" } } });
    expect(result.calls.filter(call => call.path.endsWith("/search"))).toHaveLength(1);
  });
  it("falls back to the phone when the store has no match, when the search fails, and when it is too slow", async () => {
    const empty = fakeOpenAI();
    const { state } = await syncOpenAIKnowledge(empty.fetcher, "k", [doc("a", "Unrelated notes about lunch.")], EMPTY_OPENAI_KNOWLEDGE);
    const noMatch = await ask(empty, { retrieveMemoryWithStats: local, openaiKnowledge: () => ({ vectorStoreId: state.vectorStoreId! }) }, "Orin delivery?");
    expect(noMatch.instructions).toContain("LOCAL:");
    expect(noMatch.meta.retrieval).toEqual({ searchedEntries: 40, matched: 1, webUsed: false });

    const missing = await ask(fakeOpenAI(), { retrieveMemoryWithStats: local, openaiKnowledge: () => ({ vectorStoreId: "vs_404" }) }, "Orin delivery?");
    expect(missing.instructions).toContain("LOCAL:");

    const slow = fakeOpenAI({ searchDelayMs: 400 });
    const slowState = (await syncOpenAIKnowledge(slow.fetcher, "k", [doc("a", "Orin lead time is twelve weeks.")], EMPTY_OPENAI_KNOWLEDGE)).state;
    const began = Date.now();
    const timedOut = await ask(slow, { retrieveMemoryWithStats: local, knowledgeTimeoutMs: 60, openaiKnowledge: () => ({ vectorStoreId: slowState.vectorStoreId! }) }, "Orin lead time?");
    expect(timedOut.instructions).toContain("LOCAL:");
    expect(Date.now() - began).toBeLessThan(350);
  });
  it("local source (the default): no request to the knowledge base at all", async () => {
    const api = fakeOpenAI();
    const result = await ask(api, { retrieveMemoryWithStats: local, openaiKnowledge: () => undefined }, "Orin lead time?");
    expect(result.instructions).toContain("LOCAL:");
    expect(api.calls).toHaveLength(0);
  });
});
