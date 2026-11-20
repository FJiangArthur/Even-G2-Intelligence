/**
 * v0.13 integration of Notes mode with the other 0.13 areas: Chinese chat providers (schema in the
 * prompt), the "no record until content" history rule, and merging a resumed session's notebook.
 */
import { describe, expect, it, vi } from "vitest";
import { ConversationCopilot } from "../src/copilot.js";
import { answerProviderInfo } from "../src/provider-registry.js";
import {
  DEFAULT_COPILOT_SETTINGS, LocalHistoryStore, NOTEBOOK_PROMPT_VERSION, SessionNotebook, fallbackSessionRecap, sessionHasContent,
  type HistorySession, type SessionNote, type TodoItem,
} from "../src/index.js";

const T0 = "2026-11-19T17:00:00.000Z", T1 = "2026-11-19T17:10:00.000Z", T2 = "2026-11-19T17:15:00.000Z";
const session = (id: string, extra: Partial<HistorySession> = {}): HistorySession => ({ id, source: "helix", title: "Helix · 2026-11-19T17:00:00.000Z", startedAt: T0, updatedAt: "2026-11-19T17:06:00.000Z", ...extra });
const todo = (id: string, text: string, extra: Partial<TodoItem> = {}): TodoItem => ({ id, text, done: false, origin: "voice", createdAt: T0, updatedAt: T0, ...extra });
const note = (id: string, text: string, createdAt = T0): SessionNote => ({ id, text, createdAt });
function disk() {
  const values = new Map<string, string>();
  return { values, getLocalStorage: async (key: string) => values.get(key) ?? "", setLocalStorage: async (key: string, value: string) => { values.set(key, value); return true; } };
}
const settle = async (ms = 30) => { await new Promise(resolve => setTimeout(resolve, ms)); };

describe("Notes mode on a provider without strict JSON schema (Qwen, Z.ai, DeepSeek, Kimi)", () => {
  it("sends the to-do / notes schema and instructions in the prompt and applies the reply to the notebook", async () => {
    const reply = { summary: { bullets: [], keyFacts: [] }, people: [],
      todoOps: [{ op: "add", id: "", text: "Send the quote", owner: "Mei", due: "Friday", quote: "Mei will send the quote by Friday" },
        { op: "add", id: "", text: "Invented task", owner: "", due: "", quote: "nobody ever said this sentence at all" },
        { op: "complete", id: "no-such-id", text: "", owner: "", due: "", quote: "Mei will send the quote by Friday" }],
      notes: [{ text: "Pilot budget is 40k.", quote: "the pilot budget is 40k" }] };
    for (const id of ["qwen", "zai"]) {
      const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ choices: [{ message: { role: "assistant", content: `\`\`\`json\n${JSON.stringify(reply)}\n\`\`\`` }, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 10 } }));
      const provider = answerProviderInfo(id)!, notebook = new SessionNotebook();
      const copilot = new ConversationCopilot({ fetch: fetcher, key: "sk-x", sessionId: "s", provider, cooldownMs: 0,
        callbacks: { enabled: () => true, notebook: () => notebook,
          settings: () => ({ ...DEFAULT_COPILOT_SETTINGS, mode: "notes", concepts: false, conflicts: false, suggestions: false, implicitAsks: false, claims: false }) } });
      copilot.submit("t1", "Mei will send the quote by Friday, and the pilot budget is 40k.", "Other speaker");
      await settle();
      expect(String(fetcher.mock.calls[0]![0])).toBe(`${provider.baseUrl}/chat/completions`);
      const body = JSON.parse(fetcher.mock.calls[0]![1]!.body as string) as { model: string; response_format?: unknown; messages: { role: string; content: string }[] };
      const system = body.messages[0]!.content;
      // No strict schema on Chat Completions: the schema itself travels in the system prompt, with the section instructions.
      expect(system).toContain("todoOps: keep the wearer's to-do list");
      expect(system).toContain("notes: concise meeting notes");
      const schema = JSON.parse(system.slice(system.indexOf("\n{", system.indexOf("JSON Schema")) + 1)) as { properties: Record<string, { items: { properties: Record<string, unknown>; required: string[] } }>; required: string[] };
      expect(schema.required).toEqual(expect.arrayContaining(["todoOps", "notes"]));
      expect(Object.keys(schema.properties.todoOps!.items.properties)).toEqual(["op", "id", "text", "owner", "due", "quote"]);
      expect(JSON.parse(body.messages[1]!.content)).toMatchObject({ todoList: [], knownNotes: [] });
      // The reply is validated like a strict-schema one: grounded items are applied, invented ones and unknown ids are dropped.
      expect(notebook.todos).toHaveLength(1);
      expect(notebook.todos[0]).toMatchObject({ text: "Send the quote", owner: "Mei", due: "Friday", origin: "copilot",
        source: { transcriptId: "t1", quote: "Mei will send the quote by Friday", model: body.model, promptVersion: NOTEBOOK_PROMPT_VERSION } });
      expect(body.model).toBe(provider.defaultCopilotModel);
      expect(notebook.notes.map(item => item.text)).toEqual(["Pilot budget is 40k."]);
      copilot.cancel();
    }
  });
  it("leaves the notebook sections out of the prompt in other modes on the same provider", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }] }));
    const copilot = new ConversationCopilot({ fetch: fetcher, key: "sk-x", sessionId: "s", provider: answerProviderInfo("qwen")!, cooldownMs: 0,
      callbacks: { enabled: () => true, notebook: () => new SessionNotebook(), settings: () => ({ ...DEFAULT_COPILOT_SETTINGS, mode: "general" }) } });
    copilot.submit("t1", "Mei will send the quote by Friday.", "Other speaker");
    await settle();
    expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string).messages[0].content).not.toContain("todoOps");
    copilot.cancel();
  });
});

describe("Notes + History: a notebook is session content", () => {
  it("counts to-dos and notes as content, so the record is neither hidden nor pruned", async () => {
    expect(sessionHasContent(session("a"), 0)).toBe(false);
    expect(sessionHasContent(session("a", { todos: [todo("1", "Book the room")] }), 0)).toBe(true);
    expect(sessionHasContent(session("a", { notes: [note("n", "Budget is 40k.")] }), 0)).toBe(true);
    expect(sessionHasContent(session("a", { todos: [], notes: [] }), 0)).toBe(false);
    const store = new LocalHistoryStore(disk()); await store.load();
    await store.upsertSession(session("empty"));
    await store.upsertSession(session("todo-only"));
    await store.updateSessionNotebook("todo-only", { todos: [todo("1", "Book the room")] });
    await store.upsertSession(session("note-only", { notes: [note("n", "Budget is 40k.")] }));
    expect(store.emptySessionIds("helix")).toEqual(["empty"]);
    // The fallback recap of such a record says what it holds instead of nothing.
    expect(fallbackSessionRecap(session("a", { todos: [todo("1", "Book the room"), todo("2", "Call Mei", { done: true })], notes: [note("n", "Budget is 40k.")] }))).toMatchObject({ overview: "2 to-dos (1 open) · 1 note" });
  });
});

describe("Notes + History: merging a resumed session", () => {
  async function merged(into: Partial<HistorySession>, from: Partial<HistorySession>) {
    const storage = disk(), store = new LocalHistoryStore(storage); await store.load();
    await store.upsertSession(session("first", into));
    await store.upsertSession(session("second", { startedAt: T1, updatedAt: T2, continues: "first", ...from }));
    await store.mergeSession("second", "first");
    const reloaded = new LocalHistoryStore(storage); await reloaded.load();
    expect(reloaded.listSessions().map(item => item.id)).toEqual(["first"]);
    return reloaded.getSession("first")!;
  }
  it("takes the continuation's list as the later state: edits win, nothing is lost and nothing is listed twice", async () => {
    const result = await merged(
      { todos: [todo("a", "Call the vendor"), todo("b", "Book the demo room"), todo("c", "Send the quote")], notes: [note("n1", "Budget is 40k.")] },
      // The resumed part started from a, b, c: it completed a, removed b, re-assigned c and added d.
      { todos: [todo("a", "Call the vendor", { done: true, completedAt: T2, updatedAt: T2 }), todo("c", "Send the quote", { owner: "Raj", updatedAt: T2 }), todo("d", "Email the summary", { createdAt: T2, updatedAt: T2 })],
        notes: [note("n1", "Budget is 40k."), note("n2", "Launch moved to March.", T2)] });
    expect(result.todos!.map(item => [item.id, item.done, item.owner])).toEqual([["a", true, undefined], ["c", false, "Raj"], ["d", false, undefined]]);
    expect(result.notes!.map(item => item.id)).toEqual(["n1", "n2"]);
  });
  it("keeps the earlier lists when the continuation never touched them", async () => {
    const result = await merged({ todos: [todo("a", "Call the vendor")], notes: [note("n1", "Budget is 40k.")] }, {});
    expect(result.todos!.map(item => item.id)).toEqual(["a"]);
    expect(result.notes!.map(item => item.id)).toEqual(["n1"]);
  });
  it("keeps a to-do added to the saved session while the continuation was live, once, even if both captured it", async () => {
    const result = await merged(
      { todos: [todo("a", "Call the vendor"), todo("late", "Order the cables", { origin: "user", createdAt: T2, updatedAt: T2 }), todo("dup", "Email the summary!", { origin: "user", createdAt: T2, updatedAt: T2 })] },
      { todos: [todo("a", "Call the vendor"), todo("d", "Email the summary", { createdAt: T2, updatedAt: T2 })] });
    expect(result.todos!.map(item => item.id)).toEqual(["late", "a", "d"]);
  });
  it("a continuation that emptied its lists stores [] (not absent), survives pruning, and the merge removes the items", async () => {
    const storage = disk(), store = new LocalHistoryStore(storage); await store.load();
    await store.upsertSession(session("first", { todos: [todo("a", "Call the vendor")] }));
    await store.upsertSession(session("second", { startedAt: T1, updatedAt: T2, continues: "first" }));
    await store.updateSessionNotebook("second", { todos: [] });
    expect(store.getSession("second")!.todos).toEqual([]);
    expect(store.emptySessionIds("helix")).toEqual([]); // not pruned before it is merged
    await store.mergeSession("second", "first");
    expect(store.getSession("first")!.todos).toBeUndefined();
    // An ordinary (not resumed) session still drops the field when its list is emptied.
    await store.updateSessionNotebook("first", { todos: [todo("z", "Book the room")] });
    await store.updateSessionNotebook("first", { todos: [] });
    expect(Object.keys(store.getSession("first")!)).not.toContain("todos");
  });
});
