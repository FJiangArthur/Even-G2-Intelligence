import { describe, expect, it, vi } from "vitest";
import { ConversationCopilot, copilotInstructions, copilotSchema } from "../src/copilot.js";
import {
  CONVERSATION_MODES, DEFAULT_COPILOT_SETTINGS, LocalHistoryStore, MAX_TODOS, MODE_PROFILES, NOTEBOOK_PROMPT_VERSION, PICKER_MODES, SessionNotebook,
  applyTodoOp, cleanSessionNotes, cleanTodos, findTodo, isConversationMode, markdownToSession, modeProfile, modeSystemPrompt, normalizeSessionConfig, parseTodoCommand,
  sameTodoText, sessionToMarkdown, todoConfirmation, todoLine, parseTodoLine,
  type CopilotCallbacks, type HistorySession, type NotebookEvent, type TodoItem, type TodoOp,
} from "../src/index.js";

const T0 = "2026-11-19T13:00:00.000Z", T1 = "2026-11-19T13:05:00.000Z";
function ids() { let n = 0; return () => `t${++n}`; }
function build(ops: TodoOp[], now = T0): TodoItem[] {
  const newId = ids();
  let list: TodoItem[] = [];
  for (const op of ops) list = applyTodoOp(list, op, { origin: "user", now, newId }).list;
  return list;
}

describe("to-do list operations", () => {
  it("adds with a stable id, owner, due and provenance, without mutating the input list", () => {
    const before: TodoItem[] = [];
    const result = applyTodoOp(before, { op: "add", text: "  Send the   quote ", owner: "Mei", due: "Friday" },
      { origin: "copilot", now: T0, newId: () => "a1", source: { transcriptId: "tr-7", quote: "Mei will send the quote by Friday", speaker: "Bob", model: "gpt-6-luna", promptVersion: NOTEBOOK_PROMPT_VERSION } });
    expect(before).toEqual([]);
    expect(result.change?.kind).toBe("added");
    expect(result.list).toEqual([{ id: "a1", text: "Send the quote", owner: "Mei", due: "Friday", done: false, origin: "copilot", createdAt: T0, updatedAt: T0,
      source: { transcriptId: "tr-7", quote: "Mei will send the quote by Friday", speaker: "Bob", model: "gpt-6-luna", promptVersion: "notes-1" } }]);
  });
  it("updates only the given fields, clears owner/due with an empty string and reports no change for a no-op", () => {
    const list = build([{ op: "add", text: "Send the quote", owner: "Mei", due: "Friday" }]);
    const moved = applyTodoOp(list, { op: "update", id: "t1", due: "Monday" }, { origin: "voice", now: T1 });
    expect(moved.change).toMatchObject({ kind: "updated", item: { id: "t1", text: "Send the quote", owner: "Mei", due: "Monday", updatedAt: T1, createdAt: T0 }, previous: { due: "Friday" } });
    const cleared = applyTodoOp(moved.list, { op: "update", id: "t1", owner: "" }, { origin: "user", now: T1 });
    expect(cleared.list[0]).not.toHaveProperty("owner");
    expect(applyTodoOp(list, { op: "update", id: "t1", due: "Friday" }, { origin: "user" }).change).toBeUndefined();
    expect(applyTodoOp(list, { op: "update", id: "nope", text: "x" }, { origin: "user" }).change).toBeUndefined();
    expect(list[0]!.due).toBe("Friday");
  });
  it("completes, reopens, removes and reorders by id", () => {
    const list = build([{ op: "add", text: "Send the quote" }, { op: "add", text: "Call the vendor" }, { op: "add", text: "Book the room" }]);
    const done = applyTodoOp(list, { op: "complete", id: "t2" }, { origin: "user", now: T1 });
    expect(done.change?.kind).toBe("completed");
    expect(done.list[1]).toMatchObject({ done: true, completedAt: T1 });
    expect(applyTodoOp(done.list, { op: "complete", id: "t2" }, { origin: "user" }).change).toBeUndefined();
    const reopened = applyTodoOp(done.list, { op: "complete", id: "t2", done: false }, { origin: "user" });
    expect(reopened.change?.kind).toBe("reopened");
    expect(reopened.list[1]).not.toHaveProperty("completedAt");
    const removed = applyTodoOp(list, { op: "remove", id: "t1" }, { origin: "user" });
    expect(removed.change?.kind).toBe("removed");
    expect(removed.list.map(item => item.id)).toEqual(["t2", "t3"]);
    const moved = applyTodoOp(list, { op: "move", id: "t3", to: 0 }, { origin: "user" });
    expect(moved.list.map(item => item.id)).toEqual(["t3", "t1", "t2"]);
    expect(todoConfirmation(moved.change!)).toBeUndefined();
    expect(applyTodoOp(list, { op: "move", id: "t3", to: 99 }, { origin: "user" }).change).toBeUndefined();
  });
  it("edits instead of appending: a reworded or repeated add updates the existing item", () => {
    const list = build([{ op: "add", text: "Send the quote" }, { op: "add", text: "Call the vendor" }]);
    const reworded = applyTodoOp(list, { op: "add", text: "Send quote to the vendor", owner: "Mei", due: "Friday" }, { origin: "copilot", now: T1 });
    expect(reworded.list).toHaveLength(2);
    expect(reworded.change).toMatchObject({ kind: "updated", item: { id: "t1", text: "Send the quote", owner: "Mei", due: "Friday" } });
    expect(applyTodoOp(reworded.list, { op: "add", text: "send the quote!" }, { origin: "copilot" }).change).toBeUndefined();
    // Different tasks that share a word stay separate.
    expect(applyTodoOp(list, { op: "add", text: "Email the vendor" }, { origin: "copilot" }).list).toHaveLength(3);
    expect(sameTodoText("Send the quote", "Send the invoice")).toBe(false);
    // A finished item is not re-added by a repeat.
    const done = applyTodoOp(list, { op: "complete", id: "t1" }, { origin: "user" }).list;
    expect(applyTodoOp(done, { op: "add", text: "Send the quote" }, { origin: "copilot" }).change).toBeUndefined();
  });
  it("is bounded and rejects empty text", () => {
    let list: TodoItem[] = [];
    for (let i = 0; i < MAX_TODOS + 5; i++) list = applyTodoOp(list, { op: "add", text: `Unique task number ${i} zz${i}` }, { origin: "user" }).list;
    expect(list).toHaveLength(MAX_TODOS);
    expect(applyTodoOp([], { op: "add", text: " ... " }, { origin: "user" }).change).toBeUndefined();
    expect(applyTodoOp([], { op: "add", text: "x".repeat(500) }, { origin: "user" }).list[0]!.text).toHaveLength(200);
  });
  it("confirms changes in one short line", () => {
    const added = applyTodoOp([], { op: "add", text: "Send quote", owner: "Mei", due: "Friday" }, { origin: "copilot", newId: () => "a" });
    expect(todoConfirmation(added.change!)).toBe("TODO + Send quote - Mei, Fri");
    expect(todoConfirmation(applyTodoOp(added.list, { op: "update", id: "a", due: "next Tuesday" }, { origin: "voice" }).change!)).toBe("TODO ~ Send quote - Mei, next Tue");
    expect(todoConfirmation(applyTodoOp(added.list, { op: "complete", id: "a" }, { origin: "voice" }).change!)).toBe("TODO done: Send quote");
    expect(todoConfirmation(applyTodoOp(added.list, { op: "remove", id: "a" }, { origin: "voice" }).change!)).toBe("TODO removed: Send quote");
  });
});

describe("spoken to-do commands", () => {
  const list = build([{ op: "add", text: "Call the vendor about pricing", owner: "Me" }, { op: "add", text: "Send the quote", owner: "Mei", due: "Friday" }, { op: "add", text: "Book the demo room" }]);
  it("adds a to-do with owner and due date as spoken", () => {
    expect(parseTodoCommand("Add a to-do to call the supplier by Friday.", list)).toEqual({ op: "add", text: "Call the supplier", due: "Friday" });
    expect(parseTodoCommand("Okay, add a to do for Mei to send the contract by next Tuesday", list)).toEqual({ op: "add", text: "Send the contract", owner: "Mei", due: "Next Tuesday" });
    expect(parseTodoCommand("Helix, add an action item: Raj will update the forecast", list)).toEqual({ op: "add", text: "Update the forecast", owner: "Raj" });
    expect(parseTodoCommand("add review the budget to my to-do list", list)).toEqual({ op: "add", text: "Review the budget" });
    expect(parseTodoCommand("Remind me to email the landlord tomorrow morning", list)).toEqual({ op: "add", owner: "Me", text: "Email the landlord tomorrow morning" });
    expect(parseTodoCommand("添加待办：给供应商打电话", list)).toEqual({ op: "add", text: "给供应商打电话" });
  });
  it("marks done, reopens and removes the item the phrase refers to", () => {
    expect(parseTodoCommand("Mark the vendor call done.", list)).toEqual({ op: "complete", id: "t1" });
    expect(parseTodoCommand("mark send the quote as completed", list)).toEqual({ op: "complete", id: "t2" });
    expect(parseTodoCommand("check off the demo room", list)).toEqual({ op: "complete", id: "t3" });
    expect(parseTodoCommand("mark the vendor call as not done", list)).toEqual({ op: "complete", id: "t1", done: false });
    expect(parseTodoCommand("Remove the quote to-do", list)).toEqual({ op: "remove", id: "t2" });
    expect(parseTodoCommand("delete the demo room from my to-do list", list)).toEqual({ op: "remove", id: "t3" });
    expect(parseTodoCommand("cancel the to-do to book the demo room", list)).toEqual({ op: "remove", id: "t3" });
  });
  it("changes the deadline, owner and wording", () => {
    expect(parseTodoCommand("Change the deadline to Friday", list, "t1")).toEqual({ op: "update", id: "t1", due: "Friday" });
    expect(parseTodoCommand("move the due date for the quote to next Monday", list)).toEqual({ op: "update", id: "t2", due: "Next Monday" });
    expect(parseTodoCommand("make the demo room due tomorrow", list)).toEqual({ op: "update", id: "t3", due: "Tomorrow" });
    expect(parseTodoCommand("reassign the quote to Raj", list)).toEqual({ op: "update", id: "t2", owner: "Raj" });
    expect(parseTodoCommand("rename the demo room to book the large demo room", list)).toEqual({ op: "update", id: "t3", text: "Book the large demo room" });
    expect(parseTodoCommand("mark it done", list, "t2")).toEqual({ op: "complete", id: "t2" });
  });
  it("ignores ordinary speech, unknown items and an ambiguous target", () => {
    for (const text of ["We should talk about the vendor next week.", "Cancel the meeting.", "Mark the budget review done", "Remove the banner from the homepage",
      "Change the deadline to Friday", "What is on my to-do list?", "Give the report to Mei", "I marked it done yesterday"]) {
      expect(parseTodoCommand(text, list), text).toBeUndefined();
    }
    expect(findTodo(list, "the")).toBeUndefined();
    expect(findTodo(list, "vendor call")?.id).toBe("t1");
  });
});

describe("SessionNotebook", () => {
  it("applies spoken commands from the wearer with transcript provenance and reports a confirmation", () => {
    const events: NotebookEvent[] = [];
    const notebook = new SessionNotebook({ onChange: event => events.push(event), now: () => T0, newId: ids() });
    expect(notebook.handleTranscript("tr-1", "Okay. Add a to-do to call the vendor by Friday. Thanks.", { label: "You", role: "self" })).toHaveLength(1);
    expect(notebook.todos).toEqual([{ id: "t1", text: "Call the vendor", due: "Friday", done: false, origin: "voice", createdAt: T0, updatedAt: T0,
      source: { transcriptId: "tr-1", quote: "Add a to-do to call the vendor by Friday.", speaker: "You" } }]);
    expect(events.at(-1)?.confirmation).toBe("TODO + Call the vendor - Fri");
    // "the deadline" without a target refers to the item just touched.
    notebook.handleTranscript("tr-2", "Change the deadline to Monday.", { label: "You", role: "self" });
    expect(notebook.todos[0]!.due).toBe("Monday");
    notebook.handleTranscript("tr-3", "Mark the vendor call done", { label: "Speaker", role: "unknown" });
    expect(notebook.todos[0]!.done).toBe(true);
    expect(events.map(event => event.confirmation)).toEqual(["TODO + Call the vendor - Fri", "TODO ~ Call the vendor - Mon", "TODO done: Call the vendor"]);
    // Another speaker's words are not commands.
    expect(notebook.handleTranscript("tr-4", "Remove the vendor call.", { label: "Them", role: "other" })).toEqual([]);
    expect(notebook.todos).toHaveLength(1);
  });
  it("keeps running notes without repeats, bounded, and never stores credentials", () => {
    const notebook = new SessionNotebook({ now: () => T0, newId: ids() });
    expect(notebook.addNote("Budget approved at 40k for Q3", "tr-1")).toMatchObject({ id: "t1", transcriptId: "tr-1" });
    expect(notebook.addNote("budget approved at 40k for q3.")).toBeUndefined();
    expect(notebook.addNote("The password: hunter2hunter2")).toBeUndefined();
    expect(notebook.apply({ op: "add", text: `Rotate api_key=${"sk"}-${"abcdefghijklmnopqrstuv"}` }, { origin: "user" })).toBeUndefined();
    for (let i = 0; i < 100; i++) notebook.addNote(`Distinct decision ${i} about topic zz${i} qq${i}`);
    expect(notebook.notes).toHaveLength(80);
    expect(notebook.removeNote(notebook.notes[0]!.id)).toBe(true);
    expect(notebook.notes).toHaveLength(79);
  });
});

const message = (text: string) => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 400, output_tokens: 90 } });
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
type Body = { text: { format: { schema: { properties: Record<string, unknown> } } }; input: string; instructions: string; model: string };
function copilotHarness(responses: Record<string, unknown>[], mode = "notes", withNotebook = true) {
  const gate = { open: true };
  const notebook = new SessionNotebook({ newId: ids(), now: () => T0 });
  const bodies: Body[] = [];
  let call = 0;
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(init!.body as string) as Body);
    return Response.json(message(JSON.stringify({ summary: { bullets: [], keyFacts: [] }, people: [], todoOps: [], notes: [], ...(responses[call++] ?? {}) })));
  });
  const callbacks: CopilotCallbacks = {
    enabled: () => gate.open, settings: () => ({ ...DEFAULT_COPILOT_SETTINGS, ...MODE_PROFILES.notes.presets, mode }),
    ...(withNotebook ? { notebook: () => notebook } : {}),
  };
  const copilot = new ConversationCopilot({ fetch, key: "k", sessionId: "s", callbacks, cooldownMs: 0 });
  return { copilot, notebook, bodies, gate };
}

describe("copilot lane in Notes mode", () => {
  it("captures action items with owner, due date and the transcript passage, then edits them instead of duplicating", async () => {
    const h = copilotHarness([
      { todoOps: [
        { op: "add", id: "", text: "Send the quote", owner: "Mei", due: "Friday", quote: "Mei will send the quote by Friday" },
        { op: "add", id: "", text: "Hire three engineers", owner: "", due: "", quote: "we are going to hire three engineers on the moon" },
        { op: "complete", id: "ghost", text: "", owner: "", due: "", quote: "Mei will send the quote by Friday" },
      ], notes: [{ text: "Vendor pricing is the main open issue.", quote: "pricing is still the open issue with the vendor" }, { text: "Invented note.", quote: "nothing like this was ever said at all" }] },
      { todoOps: [
        { op: "add", id: "", text: "Send quote to the vendor", owner: "Raj", due: "", quote: "Raj will take the quote instead" },
        { op: "update", id: "t1", text: "", owner: "", due: "Monday", quote: "let's push it to Monday" },
      ], notes: [{ text: "Vendor pricing is the main open issue", quote: "Raj will take the quote instead" }] },
      { todoOps: [{ op: "complete", id: "t1", text: "", owner: "", due: "", quote: "the quote went out this morning" }] },
    ]);
    // Both lines land in one analysis run.
    h.gate.open = false;
    h.copilot.submit("tr-1", "Mei will send the quote by Friday.", { label: "Bob", role: "other" });
    h.copilot.submit("tr-2", "Pricing is still the open issue with the vendor.", { label: "You", role: "self" });
    h.gate.open = true; h.copilot.runNow();
    await settle();
    expect(h.notebook.todos).toHaveLength(1);
    expect(h.notebook.todos[0]).toMatchObject({ id: "t1", text: "Send the quote", owner: "Mei", due: "Friday", done: false, origin: "copilot",
      source: { transcriptId: "tr-1", speaker: "Bob", quote: "Mei will send the quote by Friday", model: DEFAULT_COPILOT_SETTINGS.copilotModel, promptVersion: "notes-1" } });
    expect(h.notebook.notes).toMatchObject([{ text: "Vendor pricing is the main open issue.", transcriptId: "tr-2" }]);

    h.copilot.submit("tr-3", "Actually Raj will take the quote instead, and let's push it to Monday.", { label: "Bob", role: "other" });
    await settle();
    expect(h.notebook.todos).toHaveLength(1);
    expect(h.notebook.todos[0]).toMatchObject({ id: "t1", text: "Send the quote", owner: "Raj", due: "Monday", source: { transcriptId: "tr-3" } });
    expect(h.notebook.notes).toHaveLength(1);
    // The current list and notes are sent back so the model edits by id.
    const input = JSON.parse(h.bodies[1]!.input) as { todoList: unknown[]; knownNotes: string[] };
    expect(input.todoList).toEqual([{ id: "t1", text: "Send the quote", owner: "Mei", due: "Friday", done: false }]);
    expect(input.knownNotes).toEqual(["Vendor pricing is the main open issue."]);

    h.copilot.submit("tr-4", "Good news, the quote went out this morning.", { label: "Bob", role: "other" });
    await settle();
    expect(h.notebook.todos[0]).toMatchObject({ id: "t1", done: true });
  });
  it("adds the notebook sections to schema and prompt only in Notes mode with a notebook", async () => {
    const settings = { ...DEFAULT_COPILOT_SETTINGS, mode: "notes" };
    expect(Object.keys(copilotSchema(settings, true).properties as object)).toEqual(expect.arrayContaining(["todoOps", "notes"]));
    expect(Object.keys(copilotSchema(settings).properties as object)).not.toContain("todoOps");
    expect(Object.keys(copilotSchema({ ...DEFAULT_COPILOT_SETTINGS, mode: "general" }, true).properties as object)).not.toContain("todoOps");
    expect(copilotInstructions(settings, true)).toMatch(/^todoOps: keep the wearer's to-do list/mu);
    expect(copilotInstructions(settings, true)).toContain("Conversation mode: Notes.");
    expect(copilotInstructions(settings)).not.toMatch(/^todoOps:/mu);
    const other = copilotHarness([{ todoOps: [{ op: "add", id: "", text: "Send the quote", owner: "", due: "", quote: "Mei will send the quote" }] }], "general");
    other.copilot.submit("tr-1", "Mei will send the quote.", "Bob");
    await settle();
    expect(other.notebook.todos).toEqual([]);
    expect(Object.keys(other.bodies[0]!.text.format.schema.properties)).not.toContain("todoOps");
    expect(JSON.parse(other.bodies[0]!.input).todoList).toBeUndefined();
  });
});

describe("Notes mode profile", () => {
  it("is a protocol mode in the picker with a short glasses tag and quiet presets", () => {
    expect(CONVERSATION_MODES).toContain("notes");
    expect(isConversationMode("notes")).toBe(true);
    expect(PICKER_MODES.at(-1)).toBe("notes");
    const profile = modeProfile("notes");
    expect(profile).toMatchObject({ id: "notes", label: "Notes", short: "NOTES", picker: true, selfQuestions: "ignore" });
    expect(profile.short.length).toBeLessThanOrEqual(6);
    expect(profile.presets).toEqual({ summarize: true, concepts: false, conflicts: false, suggestions: false, implicitAsks: false, webGrounding: true, claims: false, people: true,
      autoAnswer: false, responseStrategy: "reactive", noteTaking: true });
    for (const mode of PICKER_MODES) expect(MODE_PROFILES[mode].presets.noteTaking === true).toBe(mode === "notes");
    for (const field of ["blurb", "answer", "copilot", "suggestions", "summary", "askLabel"] as const) expect(profile[field].length).toBeGreaterThan(0);
  });
  it("uses the built-in answer prompt, or the user's own prompt for the mode", () => {
    expect(modeSystemPrompt("Base.", "notes", "reactive")).toContain(MODE_PROFILES.notes.answer);
    const custom = modeSystemPrompt("Base.", "notes", "reactive", "Only answer in Spanish.");
    expect(custom).toContain("Protected conversation mode: notes. Only answer in Spanish.");
    expect(custom).not.toContain(MODE_PROFILES.notes.answer);
    expect(normalizeSessionConfig({ sessionId: "s", endpoint: { id: "e", url: "https://api.openai.com/v1/responses", provider: "openai", model: "m" },
      prompt: { id: "p", version: "1", system: "x" }, speaker: { label: "S", role: "unknown" }, mode: "notes" }).mode).toBe("notes");
  });
});

function storage() {
  const values = new Map<string, string>();
  return { values, getLocalStorage: async (key: string) => values.get(key) ?? "", setLocalStorage: async (key: string, next: string) => { values.set(key, next); return true; } };
}
const session = (extra: Partial<HistorySession> = {}): HistorySession => ({ id: "s1", source: "helix", title: "Afternoon sync", startedAt: T0, updatedAt: T0, ...extra });

describe("notebook persistence", () => {
  it("round-trips to-dos and notes through storage (a new store instance = relaunch)", async () => {
    const phone = storage();
    const db = new LocalHistoryStore(phone); await db.load();
    await db.upsertSession(session());
    const notebook = new SessionNotebook({ now: () => T0, newId: ids() });
    notebook.apply({ op: "add", text: "Send the quote", owner: "Mei", due: "Friday" }, { origin: "copilot", source: { transcriptId: "tr-1", quote: "Mei will send the quote by Friday", speaker: "Bob", model: "gpt-6-luna", promptVersion: "notes-1" } });
    notebook.apply({ op: "add", text: "Call the vendor" }, { origin: "voice" });
    notebook.apply({ op: "complete", id: "t2" }, { origin: "user" });
    notebook.addNote("Budget approved at 40k.", "tr-2");
    await db.updateSessionNotebook("s1", { todos: [...notebook.todos], notes: [...notebook.notes] });
    // A later session upsert (every transcript line does one) keeps the notebook.
    await db.upsertSession(session({ updatedAt: T1, title: "Renamed" }));

    const relaunched = new LocalHistoryStore(phone); await relaunched.load();
    const saved = relaunched.getSession("s1")!;
    expect(saved.title).toBe("Renamed");
    expect(saved.todos).toEqual(notebook.todos);
    expect(saved.notes).toEqual(notebook.notes);
    expect(saved.todos![0]!.source).toEqual({ transcriptId: "tr-1", quote: "Mei will send the quote by Friday", speaker: "Bob", model: "gpt-6-luna", promptVersion: "notes-1" });
    // The saved list keeps editing through the same operations.
    const edited = applyTodoOp(saved.todos!, { op: "complete", id: "t1" }, { origin: "user", now: T1 });
    await relaunched.updateSessionNotebook("s1", { todos: edited.list });
    expect(relaunched.getSession("s1")!.todos!.map(item => item.done)).toEqual([true, true]);
    expect(relaunched.getSession("s1")!.notes).toHaveLength(1);
    await relaunched.updateSessionNotebook("s1", { todos: [] });
    expect(relaunched.getSession("s1")).not.toHaveProperty("todos");
    await expect(relaunched.updateSessionNotebook("missing", { todos: [] })).rejects.toThrow(/not saved/u);
  });
  it("validates stored notebook data and leaves sessions without one unchanged", async () => {
    expect(cleanTodos([{ id: "a", text: "Ok task", done: true, completedAt: T1, origin: "weird", source: { transcriptId: 5, quote: "q" } }, { id: "a", text: "dup id" }, { id: "b", text: " " }, "x", null]))
      .toEqual([{ id: "a", text: "Ok task", done: true, origin: "copilot", source: { quote: "q" }, createdAt: "1970-01-01T00:00:00.000Z", updatedAt: "1970-01-01T00:00:00.000Z", completedAt: T1 }]);
    expect(cleanTodos("nope")).toBeUndefined();
    expect(cleanSessionNotes(["Plain note", { id: "n", text: "Other", createdAt: T0 }, { text: "" }, 7])).toMatchObject([{ id: "note-1", text: "Plain note" }, { id: "n", text: "Other", createdAt: T0 }]);
    const phone = storage();
    const db = new LocalHistoryStore(phone); await db.load();
    await db.upsertSession(session());
    expect(Object.keys(db.getSession("s1")!)).toEqual(["id", "source", "title", "startedAt", "updatedAt"]);
  });
});

describe("Markdown export of the notebook", () => {
  const todos = build([{ op: "add", text: "Send the quote", owner: "Mei", due: "Friday" }, { op: "add", text: "Call the vendor" }, { op: "add", text: "Book room %% hidden", owner: "Raj" }]);
  const withDone = applyTodoOp(todos, { op: "complete", id: "t2" }, { origin: "user", now: T1 }).list;
  const saved = session({ summary: ["Quote and vendor follow-ups."], todos: withDone, notes: [{ id: "n1", text: "Budget approved at 40k.", createdAt: T0 }, { id: "n2", text: "Launch moves to March.", createdAt: T0 }] });
  it("writes to-dos as task checkboxes and notes as bullets", () => {
    const markdown = sessionToMarkdown(saved, []);
    expect(markdown).toContain("## To-dos\n- [ ] Send the quote (Mei, due Friday)\n- [x] Call the vendor\n- [ ] Book room % % hidden (Raj)\n");
    expect(markdown).toContain("## Notes\n- Budget approved at 40k.\n- Launch moves to March.\n");
    expect(markdown.indexOf("## Summary")).toBeLessThan(markdown.indexOf("## To-dos"));
    expect(markdown.indexOf("## Notes")).toBeLessThan(markdown.indexOf("## Diagram"));
    expect(sessionToMarkdown(session(), [])).not.toMatch(/## To-dos|## Notes/u);
    expect(todoLine({ text: "Send the quote", due: "Friday" })).toBe("Send the quote (due Friday)");
    expect(parseTodoLine("Send the quote (Mei, due Friday)")).toEqual({ text: "Send the quote", owner: "Mei", due: "Friday" });
  });
  it("reads the checkboxes back as the session's to-do list", () => {
    const imported = markdownToSession(sessionToMarkdown(saved, []), "2026-11-19 Afternoon sync.md");
    expect(imported.session.todos?.map(({ text, owner, due, done }) => ({ text, owner, due, done }))).toEqual([
      { text: "Send the quote", owner: "Mei", due: "Friday", done: false },
      { text: "Call the vendor", owner: undefined, due: undefined, done: true },
      { text: "Book room % % hidden", owner: "Raj", due: undefined, done: false },
    ]);
    // Notes come back as searchable note lines of the imported session.
    expect(imported.entries.map(entry => entry.text)).toEqual(expect.arrayContaining(["Budget approved at 40k.", "Launch moves to March."]));
  });
});
