import { describe, expect, it } from "vitest";
import { LEGACY_HISTORY_KEY } from "@helix/conversation-sdk";
import { G2ConversationController, OPENAI_KNOWLEDGE_STORAGE_KEY } from "../src/controller";
import { ConversationPresentation } from "../src/presentation";
import type { GlassesRenderer } from "../src/glasses-renderer";

function bridgeWith(storage: Map<string, string>) {
  return {
    getLocalStorage: async (key: string) => storage.get(key) ?? "", setLocalStorage: async (key: string, value: string) => { storage.set(key, value); return true; },
    createStartUpPageContainer: async () => 0, textContainerUpgrade: async () => true,
    audioControl: async () => true, shutDownPageContainer: async () => true, onEvenHubEvent: () => () => undefined,
  };
}
/** Files + vector store endpoints; counts uploads and deletes. */
function fakeOpenAI() {
  let seq = 0; const uploads: string[] = [], deleted: string[] = []; let stores = 0;
  const fetch = async (url: string, init: RequestInit = {}) => {
    const path = url.replace("https://api.openai.com/v1", ""), method = init.method ?? "GET";
    if (method === "POST" && path === "/vector_stores") { stores++; return Response.json({ id: `vs_${++seq}` }); }
    if (method === "POST" && path === "/files") { uploads.push(await ((init.body as FormData).get("file") as File).text()); return Response.json({ id: `file-${++seq}` }); }
    if (method === "DELETE") { deleted.push(path); return Response.json({ deleted: true }); }
    return Response.json({ id: "ok" });
  };
  return { fetch, uploads, deleted, get stores() { return stores; } };
}
async function seeded() {
  const storage = new Map<string, string>(), at = "2026-11-10T10:00:00.000Z";
  const sessions = ["s1", "s2"].map(id => ({ id, source: "helix", title: `Vendor call ${id}`, startedAt: at, updatedAt: at }));
  storage.set(LEGACY_HISTORY_KEY, JSON.stringify({ version: 1, sessions, entries: sessions.map(session => ({ id: `${session.id}:e1`, sessionId: session.id, kind: "transcript", text: `Orin lead time is twelve weeks (${session.id}).`, occurredAt: at, speaker: "Them" })) }));
  const controller = new G2ConversationController(bridgeWith(storage) as never, { initialize: async () => undefined, render: () => undefined, dispose: async () => undefined } as unknown as GlassesRenderer, new ConversationPresentation());
  await controller.initialize();
  return { storage, controller };
}

describe("v0.12 knowledge base in the controller", () => {
  it("local is the default; sync uploads each saved session once, persists ids only, and reports what is pending", async () => {
    const { storage, controller } = await seeded(), api = fakeOpenAI();
    controller.keyTestFetch = api.fetch;
    if (controller.listHistorySessions().length !== 2) return expect(controller.listHistorySessions()).toHaveLength(2);
    expect(controller.knowledgeBase()).toMatchObject({ source: "local", synced: 0, hasStore: false });
    await controller.setKnowledgeSource("openai");
    expect(controller.knowledgeBase()).toMatchObject({ source: "openai", synced: 0, pending: 2 });
    const views: string[] = [];
    controller.subscribeHistory(state => views.push(state.knowledge.syncing ? "syncing" : "idle"));
    const progress = await controller.syncOpenAIKnowledge("test-key");
    expect(progress).toMatchObject({ uploaded: 2, failed: 0 });
    expect(views).toContain("syncing"); expect(views.at(-1)).toBe("idle");
    expect(api.uploads.join("\n")).toContain("Orin lead time is twelve weeks (s1)");
    expect(api.uploads[0]).toMatch(/^# Vendor call s\d\n\nSession date: 2026-11-10 · source: helix/u);
    expect(api.uploads.join("\n")).not.toMatch(/mermaid|helix_session_id/u); // no front matter or diagram noise in the search index
    expect(controller.knowledgeBase()).toMatchObject({ source: "openai", synced: 2, pending: 0, hasStore: true, notice: "Synced: 2 uploaded, 0 removed." });
    const saved = storage.get(OPENAI_KNOWLEDGE_STORAGE_KEY)!;
    expect(JSON.parse(saved)).toMatchObject({ source: "openai", state: { vectorStoreId: "vs_1" } });
    expect(saved).not.toMatch(/test-key|twelve weeks/u); // ids only: no key, no text
    // Nothing changed: a second sync uploads nothing and reuses the store.
    expect(await controller.syncOpenAIKnowledge("test-key")).toMatchObject({ uploaded: 0, removed: 0 });
    expect(api.stores).toBe(1); expect(api.uploads).toHaveLength(2);
    // A session deleted on the phone is removed from OpenAI on the next sync.
    await controller.deleteHistorySession("s2");
    expect(await controller.syncOpenAIKnowledge("test-key")).toMatchObject({ removed: 1 });
    expect(controller.knowledgeBase().synced).toBe(1);
    await controller.dispose();
  });
  it("the choice and the store survive a restart; delete removes the files and the store and returns to local", async () => {
    const { storage, controller } = await seeded(), api = fakeOpenAI();
    controller.keyTestFetch = api.fetch;
    await controller.setKnowledgeSource("openai"); await controller.syncOpenAIKnowledge("test-key");
    await controller.dispose();
    const again = new G2ConversationController(bridgeWith(storage) as never, { initialize: async () => undefined, render: () => undefined, dispose: async () => undefined } as unknown as GlassesRenderer, new ConversationPresentation());
    await again.initialize();
    again.keyTestFetch = api.fetch;
    expect(again.knowledgeBase()).toMatchObject({ source: "openai", synced: 2, hasStore: true });
    await again.deleteOpenAIKnowledge("test-key");
    expect(api.deleted.filter(path => path.startsWith("/files/"))).toHaveLength(2);
    expect(api.deleted).toContain("/vector_stores/vs_1");
    expect(again.knowledgeBase()).toMatchObject({ source: "local", synced: 0, hasStore: false });
    await expect(again.syncOpenAIKnowledge("  ")).rejects.toThrow(/OpenAI API key/u);
    expect(again.knowledgeBase().notice).toMatch(/OpenAI API key/u);
    await again.dispose();
  });
});
