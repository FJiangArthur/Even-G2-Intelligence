/**
 * v0.13 integration: Notes mode (to-dos + notes) together with the ambient glasses display, the
 * History rules (no record until content, resume = one session, removal, the knowledge switch,
 * OpenAI sync) and PDF documents in the knowledge base.
 */
import { StartUpPageCreateResult, type CreateStartUpPageContainer, type RebuildPageContainer, type TextContainerUpgrade } from "@evenrealities/even_hub_sdk";
import {
  DirectConversationTransport, HISTORY_INDEX_KEY, LEGACY_HISTORY_KEY, SELF_SPEAKER, applyTodoOp, historyShardKey,
  type DirectConversationOptions, type HistoryEntry, type HistorySession, type TodoItem,
} from "@helix/conversation-sdk";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, applyModePreset } from "../src/config";
import { G2ConversationController, LIFECYCLE_STORAGE_KEY, type G2BridgePort } from "../src/controller";
import { AMBIENT_IDLE_MS, GlassesHud } from "../src/glasses-hud";
import { GlassesRenderer, type GlassesRenderBridge } from "../src/glasses-renderer";
import { DOCUMENTS_GROUP, groupSessionCards, historyKnowledgeNote, isDocumentSession, recapProvenance, sessionCard, sessionDayKey } from "../src/history-panel";
import { ConversationPresentation } from "../src/presentation";

afterEach(() => { vi.useRealTimers(); });

/* ------------------------------------------------------------------ glasses */

class PageBridge implements GlassesRenderBridge {
  public creates: CreateStartUpPageContainer[] = []; public rebuilds: RebuildPageContainer[] = []; public updates: TextContainerUpgrade[] = [];
  private since = 0;
  public async createStartUpPageContainer(container: CreateStartUpPageContainer) { this.creates.push(container); return StartUpPageCreateResult.success; }
  public async rebuildPageContainer(container: RebuildPageContainer) { this.since = this.updates.length; this.rebuilds.push(container); return true; }
  public async textContainerUpgrade(container: TextContainerUpgrade) { this.updates.push(container); return true; }
  /** Text in a container now: the last write since the page was built, else what the page was built with. */
  public shown(name: string): string {
    const page = this.rebuilds.at(-1) ?? this.creates.at(-1)!;
    return this.updates.slice(this.since).filter(update => update.containerName === name).at(-1)?.content
      ?? page.textObject?.find(text => text.containerName === name)?.content ?? "";
  }
}
const PANELS = ["hud-body", "hud-header", "hud-status", "hud-caption", "hud-mode", "hud-views"];
const allBlank = (bridge: PageBridge) => PANELS.every(name => bridge.shown(name).trim() === "");
const at = "2026-11-19T13:00:00.000Z";
function todoList(): TodoItem[] {
  let n = 0, list: TodoItem[] = [];
  for (const op of [{ op: "add" as const, text: "Send the quote", owner: "Mei", due: "Friday" }, { op: "add" as const, text: "Book the room" }]) {
    list = applyTodoOp(list, op, { origin: "copilot", now: at, newId: () => `t${++n}` }).list;
  }
  return list;
}

describe("Notes mode on the ambient glasses display", () => {
  async function listening() {
    const bridge = new PageBridge(), hud = new GlassesHud(bridge, { tickMs: 0, writeGapMs: 0 }), presentation = new ConversationPresentation();
    presentation.subscribe(snapshot => hud.render(snapshot.glasses, snapshot));
    await hud.initialize();
    presentation.setMode("notes");
    presentation.setStatus("listening");
    await vi.advanceTimersByTimeAsync(6000); // the "● listening" status cue has gone
    return { bridge, hud, presentation };
  }
  it("pops the TODO confirmation up like any other cue and lets it expire; nothing stays lit", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await listening();
    expect(hud.ambient).toBe(true);
    expect(allBlank(bridge)).toBe(true);
    const rebuilds = bridge.rebuilds.length, list = todoList();
    presentation.applyNotebook(list.slice(0, 1), [], "TODO + Send the quote - Mei, Fri");
    expect(hud.frame.title).toBe("TO-DO");
    expect(hud.frame.body).toBe("TODO + Send the quote - Mei, Fri");
    expect(hud.frame.status.trim()).toBe("tap to close");
    expect(hud.frame.views.trim()).toBe(""); expect(hud.frame.mode.trim()).toBe(""); // only the pop-up, not the HUD
    await vi.advanceTimersByTimeAsync(400);
    expect(bridge.shown("hud-body")).toBe("TODO + Send the quote - Mei, Fri");
    // It disappears by itself, without a gesture, and nothing re-lights the display afterwards.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(allBlank(bridge)).toBe(true);
    expect(hud.ambient).toBe(true);
    expect(bridge.rebuilds).toHaveLength(rebuilds); // a pop-up never swaps the page
    // Notes arriving without a to-do change, and a list re-sent unchanged, light nothing.
    const writes = bridge.updates.length;
    presentation.applyNotebook(list.slice(0, 1), [{ id: "n1", text: "Budget approved at 40k.", createdAt: at }]);
    hud.render(presentation.snapshot().glasses, presentation.snapshot());
    await vi.advanceTimersByTimeAsync(120_000);
    expect(allBlank(bridge)).toBe(true);
    expect(bridge.updates).toHaveLength(writes);
    expect(vi.getTimerCount()).toBe(0);
    // A second change pops up again; a tap closes it at once.
    presentation.applyNotebook(list, [], "TODO + Book the room");
    expect(hud.frame.body).toBe("TODO + Book the room");
    expect(hud.handleGesture("click")).toEqual({ type: "handled" });
    expect(hud.frame.body.trim()).toBe("");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(allBlank(bridge)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    hud.dispose();
  });
  it("reaches the TO-DO view through the menu after a wake, then goes blank again when idle", async () => {
    vi.useFakeTimers();
    const { bridge, hud, presentation } = await listening();
    presentation.applyNotebook(todoList(), [{ id: "n1", text: "Budget approved at 40k.", createdAt: at }], "TODO + Book the room");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(allBlank(bridge)).toBe(true);
    hud.handleGesture("double"); // wake: the menu opens
    expect(hud.menuOpen).toBe(true);
    const index = hud.menuItems.findIndex(item => item.action === "summary");
    expect(hud.menuItems[index]!.label).toBe("To-do"); // the SUMMARY view is the TO-DO view in this mode
    expect(hud.selectListItem(index, hud.menuItems[index]!.label)).toEqual({ type: "handled" });
    expect(hud.ambient).toBe(false);
    expect(hud.frame.title).toMatch(/^TO-DO 1\/\d/u);
    expect(hud.frame.body.split("\n").slice(0, 2)).toEqual(["[ ] Send the quote - Mei, Fri", "[ ] Book the room"]);
    expect(hud.frame.body).toContain("• Budget approved at 40k.");
    expect(hud.frame.views).toContain("▶ TO-DO");
    // A to-do captured while the HUD is awake does not pop up over it, and is not replayed once the HUD sleeps.
    presentation.applyNotebook([...todoList(), ...applyTodoOp([], { op: "add", text: "Email the summary" }, { origin: "voice", now: at, newId: () => "t9" }).list], [], "TODO + Email the summary");
    expect(hud.frame.title).toMatch(/^TO-DO/u);
    expect(hud.frame.body).toContain("[ ] Email the summary");
    await vi.advanceTimersByTimeAsync(AMBIENT_IDLE_MS + 1500);
    expect(hud.ambient).toBe(true);
    expect(allBlank(bridge)).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(allBlank(bridge)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    hud.dispose();
  });
});

/* ------------------------------------------------------------------ controller + history */

const form = { ...applyModePreset({ ...DEFAULT_CONFIG }, "notes"), accessToken: "", openaiApiKey: "session-key", deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", saveApiKeysOnPhone: false };
const DIGEST = { title: "Vendor follow-ups", overview: "The vendor call and the quote were assigned.", summary: ["Vendor call assigned."], keyFacts: [], concepts: [] };
const message = (text: string) => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 100, output_tokens: 20 } });

function rig(storage = new Map<string, string>()) {
  let transport!: DirectConversationTransport, options!: DirectConversationOptions;
  const api = { digests: 0, uploads: 0, deleted: [] as string[], seq: 0 };
  const bridge: G2BridgePort = {
    getLocalStorage: async key => storage.get(key) ?? "",
    setLocalStorage: async (key, value) => { storage.set(key, value); return true; },
    createStartUpPageContainer: async () => StartUpPageCreateResult.success,
    textContainerUpgrade: async () => true,
    audioControl: async () => true,
    shutDownPageContainer: async () => true,
    onEvenHubEvent: () => () => undefined,
  };
  const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? "GET", path = String(url).replace("https://api.openai.com/v1", ""), body = typeof init.body === "string" ? init.body : "";
    if (path === "/responses" && body.includes("helix_session_digest")) { api.digests++; return Response.json(message(JSON.stringify(DIGEST))); }
    if (path === "/responses" && body.includes("helix_copilot")) return Response.json(message(JSON.stringify({ summary: { bullets: [], keyFacts: [] }, people: [], todoOps: [], notes: [] })));
    if (method === "POST" && path === "/vector_stores") return Response.json({ id: `vs_${++api.seq}` });
    if (method === "POST" && path === "/files") { api.uploads++; return Response.json({ id: `file-${++api.seq}` }); }
    if (method === "DELETE" && path.startsWith("/files/")) { api.deleted.push(path); return Response.json({ deleted: true }); }
    if (/^\/vector_stores\/vs_\d+(\/files)?$/u.test(path)) return Response.json({ id: "ok" });
    return new Response("{}", { status: 404 });
  };
  const presentation = new ConversationPresentation();
  const controller = new G2ConversationController(bridge, new GlassesRenderer(bridge, { debounceMs: 0 }), presentation, opts => {
    options = opts!;
    transport = new DirectConversationTransport({ ...opts, insights: undefined, factCheck: { ...opts!.factCheck!, enabled: () => false }, fetch });
    return transport;
  });
  controller.keyTestFetch = fetch;
  controller.summarizeOnEnd = false;
  const say = async (text: string) => { await transport.injectTranscript(text, SELF_SPEAKER); await new Promise(resolve => setTimeout(resolve, 5)); };
  const todos = () => presentation.snapshot().notebook?.todos ?? [];
  return { controller, presentation, storage, api, say, todos, options: () => options };
}
const helix = (id: string, extra: Partial<HistorySession> = {}): HistorySession => ({ id, source: "helix", title: "Helix · 2026-11-19T17:42:00.000Z", startedAt: "2026-11-19T17:42:00.000Z", updatedAt: "2026-11-19T17:42:00.000Z", ...extra });
const line = (id: string, sessionId: string, text: string, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({ id, sessionId, kind: "transcript", text, occurredAt: "2026-11-19T12:00:00.000Z", speaker: "Other speaker", ...extra });
const seed = (sessions: HistorySession[], entries: HistoryEntry[] = []) => new Map([[LEGACY_HISTORY_KEY, JSON.stringify({ version: 1, sessions, entries })]]);
const savedTodo = (id: string, text: string, extra: Partial<TodoItem> = {}): TodoItem => ({ id, text, done: false, origin: "voice", createdAt: at, updatedAt: at, ...extra });

describe("Notes + History: no record until content", () => {
  it("a to-do added on the phone before anything was said creates the session record and survives a relaunch", async () => {
    const f = rig();
    await f.controller.initialize();
    await f.controller.connect(form);
    const id = f.controller.liveSessionId()!;
    expect(f.controller.listHistorySessions()).toEqual([]); // connecting saves nothing
    expect(await f.controller.editTodo({ op: "add", text: "Book the demo room" })).toBe(true);
    await f.controller.flushHistory();
    const saved = f.controller.openHistorySession(id)!;
    expect(saved.entries).toEqual([]);
    expect(saved.session.todos!.map(item => [item.text, item.origin])).toEqual([["Book the demo room", "user"]]);
    expect(f.controller.historySessionHasContent(saved.session)).toBe(true);
    await f.controller.disconnect();
    await f.controller.flushHistory();
    // Relaunch: the record holds only a to-do, and the startup clean-up of empty records keeps it.
    const again = rig(new Map(f.storage));
    await again.controller.initialize();
    const record = again.controller.openHistorySession(id)!.session;
    expect(record.todos!.map(item => item.text)).toEqual(["Book the demo room"]);
    expect(record).toMatchObject({ recap: { origin: "fallback" }, endedAt: expect.any(String) });
    const card = sessionCard(record, []);
    expect(card).toMatchObject({ counts: "0 speaker turns · 0 Helix answers · 1 to-do (1 open)", summary: "1 to-do (1 open)" });
    expect(card.title).toMatch(/ conversation$/u);
    await again.controller.dispose(); await f.controller.dispose();
  });
  it("a to-do captured by voice in the very first line is saved with it, and a session with no to-do and no line saves nothing", async () => {
    const f = rig();
    await f.controller.initialize();
    await f.controller.connect(form);
    const id = f.controller.liveSessionId()!;
    await f.say("Add a to-do to call the vendor by Friday.");
    await vi.waitFor(() => expect(f.todos()).toHaveLength(1));
    await f.controller.disconnect();
    await f.controller.flushHistory();
    const saved = f.controller.openHistorySession(id)!;
    expect(saved.entries.map(entry => entry.text)).toEqual(["Add a to-do to call the vendor by Friday."]);
    expect(saved.session.todos).toMatchObject([{ text: "Call the vendor", due: "Friday", origin: "voice" }]);
    // Removing the only to-do of a session that has nothing else leaves no record behind.
    await f.controller.connect(form);
    const second = f.controller.liveSessionId()!;
    await f.controller.editTodo({ op: "add", text: "Temporary item" });
    await f.controller.editTodo({ op: "remove", id: f.todos()[0]!.id });
    await f.controller.disconnect();
    await f.controller.flushHistory();
    const again = rig(new Map(f.storage));
    await again.controller.initialize(); // startup clean-up
    expect(again.controller.listHistorySessions().map(session => session.id)).toEqual([id]);
    expect(again.controller.openHistorySession(second)).toBeUndefined();
    await again.controller.dispose(); await f.controller.dispose();
  });
});

describe("Notes + History: resume continues one notebook", () => {
  it("a resumed session starts from the saved list and merges back without lost or duplicated to-dos", async () => {
    const first = rig();
    await first.controller.initialize();
    await first.controller.connect(form);
    const id = first.controller.liveSessionId()!;
    await first.say("Add a to-do to call the vendor by Friday.");
    await first.say("Add a to-do to book the demo room.");
    await vi.waitFor(() => expect(first.todos()).toHaveLength(2));
    await first.controller.flushHistory(); // page hidden, then the phone reclaims the WebView
    await vi.waitFor(() => expect(first.storage.get(LIFECYCLE_STORAGE_KEY)).toContain(id));

    const f = rig(new Map(first.storage));
    await f.controller.initialize();
    expect(f.controller.pendingResume).toMatchObject({ connected: true, sessionId: id });
    await f.controller.connect(form); // what the resume banner runs
    const resumed = f.controller.liveSessionId()!;
    expect(resumed).not.toBe(id);
    // The list is back on the phone and the glasses, silently (no confirmation for what was already captured).
    expect(f.todos().map(item => item.text)).toEqual(["Call the vendor", "Book the demo room"]);
    expect(f.presentation.snapshot().notebook!.cues).toEqual([]);
    expect(f.controller.listHistorySessions().map(session => session.id)).toEqual([id]); // resuming alone saves nothing
    // Spoken edits address the earlier items; a repeated add is not a second item.
    await f.say("Mark the vendor call done.");
    await vi.waitFor(() => expect(f.todos()[0]!.done).toBe(true));
    await f.say("Add a to-do to book the demo room.");
    await f.say("Add a to-do to email the summary.");
    await vi.waitFor(() => expect(f.todos().map(item => item.text)).toEqual(["Call the vendor", "Book the demo room", "Email the summary"]));
    expect(await f.controller.editTodo({ op: "remove", id: f.todos()[1]!.id })).toBe(true);
    await f.controller.disconnect();
    await f.controller.flushHistory();
    // One session in History, with one notebook: the removed item stays removed, nothing is doubled.
    expect(f.controller.listHistorySessions().map(session => session.id)).toEqual([id]);
    const merged = f.controller.openHistorySession(id)!;
    expect(merged.session.todos!.map(item => [item.text, item.done])).toEqual([["Call the vendor", true], ["Email the summary", false]]);
    expect(merged.entries).toHaveLength(5);
    expect(f.controller.openHistorySession(resumed)).toBeUndefined();
    expect(f.storage.get(historyShardKey(resumed)) ?? "").toBe("");
    await f.controller.dispose(); await first.controller.dispose();
  });
});

describe("Notes + History: recap, removal and OpenAI sync", () => {
  it("shows the recap and the notebook together, and removing the session deletes its to-dos and notes", async () => {
    const f = rig();
    await f.controller.initialize();
    f.controller.summarizeOnEnd = true;
    await f.controller.connect(form);
    const id = f.controller.liveSessionId()!;
    await f.say("Add a to-do to call the vendor by Friday, the distributor still owes us the Orin quote.");
    await vi.waitFor(() => expect(f.todos()).toHaveLength(1));
    await f.controller.disconnect(); await f.controller.recapSettled();
    expect(f.api.digests).toBe(1);
    const record = f.controller.openHistorySession(id)!;
    expect(record.session).toMatchObject({ title: DIGEST.title, overview: DIGEST.overview, recap: { origin: "model", provider: "openai" } });
    expect(record.session.todos).toHaveLength(1); // the recap did not replace the notebook
    expect(sessionCard(record.session, record.entries)).toMatchObject({ title: DIGEST.title, summary: DIGEST.overview, origin: "model", counts: "1 speaker turn · 0 Helix answers · 1 to-do (1 open)" });
    expect(f.controller.sessionMarkdown(id)).toContain("## To-dos\n- [ ] ");
    await f.controller.flushHistory();
    expect([...f.storage.values()].join("\n")).toContain("the vendor");
    const result = await f.controller.removeHistorySessions([id]);
    expect(result).toMatchObject({ removed: 1, failed: 0 });
    await f.controller.flushHistory();
    expect(f.controller.openHistorySession(id)).toBeUndefined();
    expect(await f.controller.editTodo({ op: "add", text: "Ghost" }, id)).toBe(false);
    for (const key of [HISTORY_INDEX_KEY, historyShardKey(id), LEGACY_HISTORY_KEY]) expect(f.storage.get(key) ?? "").not.toContain("vendor");
    await f.controller.dispose();
  });
  it("editing to-dos in History marks the session as changed for the next OpenAI sync", async () => {
    const f = rig(seed([helix("s1", { title: "Vendor call", recap: { origin: "model", generatedAt: at }, todos: [savedTodo("a", "Call the vendor")] }), helix("s2", { title: "Standup", recap: { origin: "model", generatedAt: at } })],
      [line("s1:1", "s1", "The Orin lead time is twelve weeks."), line("s2:1", "s2", "Nothing new today.")]));
    await f.controller.initialize();
    await f.controller.syncOpenAIKnowledge("setup-key");
    expect(f.api.uploads).toBe(2);
    expect(f.controller.knowledgeBase()).toMatchObject({ synced: 2, pending: 0 });
    // Check one off: neither the lines nor updatedAt change, yet the uploaded file is now stale.
    const before = f.controller.openHistorySession("s1")!.session.updatedAt;
    expect(await f.controller.editTodo({ op: "complete", id: "a" }, "s1")).toBe(true);
    expect(f.controller.openHistorySession("s1")!.session.updatedAt).toBe(before);
    expect(f.controller.knowledgeBase()).toMatchObject({ synced: 2, pending: 1 });
    await f.controller.syncOpenAIKnowledge("setup-key");
    expect(f.api.uploads).toBe(3); // only the edited session is uploaded again
    expect(f.controller.knowledgeBase().pending).toBe(0);
    // Adding the first to-do to a session without a notebook, and removing the last one, both count as changes.
    expect(await f.controller.editTodo({ op: "add", text: "Send the notes" }, "s2")).toBe(true);
    expect(f.controller.knowledgeBase().pending).toBe(1);
    await f.controller.syncOpenAIKnowledge("setup-key");
    expect(await f.controller.editTodo({ op: "remove", id: f.controller.openHistorySession("s2")!.session.todos![0]!.id }, "s2")).toBe(true);
    expect(f.controller.knowledgeBase().pending).toBe(1);
    await f.controller.dispose();
  });
});

/* ------------------------------------------------------------------ PDF documents */

describe("History and PDF documents", () => {
  const pdf: HistorySession = { id: "pdf:orin-datasheet-1a2b", source: "obsidian", title: "Orin datasheet", startedAt: "2026-11-18T09:00:00.000Z", updatedAt: "2026-11-18T09:00:00.000Z", tags: ["pdf"],
    keyFacts: ["PDF document, 2 pages, parsed on this phone"] };
  const passages = [line("pdf:orin-datasheet-1a2b:0", pdf.id, "The Orin module draws sixty watts at peak load.", { speaker: undefined, occurredAt: "2026-11-18T09:00:00.000Z", metadata: { origin: "pdf-local", section: "Page 1" } }),
    line("pdf:orin-datasheet-1a2b:1", pdf.id, "Thermal throttling starts at ninety five degrees.", { speaker: undefined, occurredAt: "2026-11-18T09:00:01.000Z", metadata: { origin: "pdf-local", section: "Page 2" } })];
  it("lists a PDF once, under Documents, described as a document and never as an unsummarised conversation", () => {
    expect(isDocumentSession(pdf)).toBe(true);
    expect(isDocumentSession(helix("s"))).toBe(false);
    const card = sessionCard(pdf, passages);
    expect(card).toMatchObject({ title: "Orin datasheet", document: true, counts: "2 passages", summary: "PDF document, 2 pages, parsed on this phone", duration: "", source: "obsidian" });
    expect(recapProvenance(pdf)).toBe("PDF document · added in Knowledge");
    const now = new Date(2026, 10, 19, 15, 0).getTime(), local = (day: number, hour: number) => new Date(2026, 10, day, hour, 0).toISOString();
    const cards = [{ id: "talk-old", startedAt: local(17, 9), day: sessionDayKey(local(17, 9)) }, { id: "doc", startedAt: local(19, 10), day: sessionDayKey(local(19, 10)), document: true },
      { id: "talk-new", startedAt: local(19, 9), day: sessionDayKey(local(19, 9)) }];
    const groups = groupSessionCards(cards, now);
    expect(groups.map(group => [group.label, group.cards.map(item => item.id)])).toEqual([["Today", ["talk-new"]], [expect.any(String), ["talk-old"]], ["Documents", ["doc"]]]);
    expect(groups.at(-1)!.day).toBe(DOCUMENTS_GROUP);
    expect(groupSessionCards(cards.filter(item => !item.document), now).map(group => group.label)).not.toContain("Documents");
  });
  it("keeps a PDF through the startup clean-up with its own title, and a generated summary does not rename it", async () => {
    const f = rig(seed([pdf, helix("empty"), helix("talk", { title: "We agreed the launch is Friday." })], [...passages, line("talk:1", "talk", "We agreed the launch is Friday.")]));
    await f.controller.initialize();
    expect(f.controller.listHistorySessions().map(session => session.id).sort()).toEqual([pdf.id, "talk"]); // only the empty Helix record is pruned
    expect(f.controller.historyTitle(f.controller.openHistorySession(pdf.id)!.session)).toBe("Orin datasheet");
    expect(f.controller.historySessionHasContent(pdf)).toBe(true);
    await f.controller.generateSessionKnowledge(pdf.id, "setup-key");
    const summarised = f.controller.openHistorySession(pdf.id)!.session;
    expect(summarised).toMatchObject({ title: "Orin datasheet", overview: DIGEST.overview, recap: { origin: "model" }, tags: ["pdf"] });
    expect(sessionCard(summarised, passages)).toMatchObject({ title: "Orin datasheet", summary: DIGEST.overview, document: true });
    // A Helix conversation is still titled by its summary.
    await f.controller.generateSessionKnowledge("talk", "setup-key");
    expect(f.controller.openHistorySession("talk")!.session.title).toBe(DIGEST.title);
    await f.controller.dispose();
  });
  it("the one knowledge switch gates PDFs like every other saved source, and the note says so", async () => {
    const f = rig(seed([pdf, helix("talk", { title: "Launch plan", recap: { origin: "model", generatedAt: at } })], [...passages, line("talk:1", "talk", "We agreed the launch is Friday.")]));
    await f.controller.initialize();
    await f.controller.connect(form);
    const live = f.controller.liveSessionId()!, options = f.options();
    expect(options.retrieveMemory?.("Orin peak load watts", live).map(hit => hit.session.id)).toEqual([pdf.id]);
    await f.controller.setLocalMemoryEnabled(false);
    expect(options.retrieveMemory?.("Orin peak load watts", live)).toEqual([]);
    expect(options.retrieveMemory?.("launch Friday", live)).toEqual([]);
    await expect(f.controller.syncOpenAIKnowledge("setup-key")).rejects.toThrow(/Let the knowledge base read history/u);
    expect(f.api.uploads).toBe(0);
    expect(f.controller.listHistorySessions()).toHaveLength(2); // off deletes nothing
    for (const note of [historyKnowledgeNote(false, false), historyKnowledgeNote(true, false), historyKnowledgeNote(true, true)]) expect(note).toMatch(/your conversations and what you imported in Knowledge \(Omi, Obsidian notes, PDFs\)/u);
    expect(historyKnowledgeNote(false, true)).toMatch(/^Off: saved sessions are never read for answers and are not synced to OpenAI/u);
    // On again: the PDF syncs like a session, and removing it in History removes its text and its uploaded file.
    await f.controller.setLocalMemoryEnabled(true);
    await f.controller.disconnect();
    await f.controller.syncOpenAIKnowledge("setup-key");
    expect(f.api.uploads).toBe(2);
    expect(await f.controller.removeHistorySessions([pdf.id], "setup-key")).toMatchObject({ removed: 1, pendingInOpenAI: 0 });
    expect(f.api.deleted).toHaveLength(1);
    await f.controller.connect(form);
    expect(f.options().retrieveMemory?.("Orin peak load watts", f.controller.liveSessionId()!)).toEqual([]);
    await f.controller.dispose();
  });
});

/* ------------------------------------------------------------------ phone page */

describe("phone page: confirmations and one-page scrolling with the 0.13 additions", () => {
  const source = (name: string) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
  it("never opens a native dialog: Delete from OpenAI is confirmed in the page like removing a session", () => {
    for (const name of ["knowledge-panel.ts", "history-panel.ts", "notebook-panel.ts", "people-panel.ts", "ui.ts"]) expect(source(name), name).not.toMatch(/window\.confirm\(|\bconfirm\(\s*["'`]|\balert\(|\bprompt\(/u);
    const knowledge = source("knowledge-panel.ts");
    expect(knowledge).toMatch(/kbDelete\.addEventListener\("click", \(\) => \{\s*confirmSlot\.replaceChildren\(confirmBar\(/u);
    expect(knowledge).toContain("run(this.controller.deleteOpenAIKnowledge(key()))");
  });
  it("adds no container that is height-limited or scrolls vertically (Setup fields, PDF card, notebook, confirmations)", () => {
    const styles = source("styles.css").replace(/\/\*[\s\S]*?\*\//gu, "");
    const rules = [...styles.matchAll(/([^{}@;]+)\{([^{}]*)\}/gu)].map(match => ({ selectors: match[1]!.trim().split(",").map(item => item.trim()), body: match[2]! }));
    const parts = ["notebook", "todo-", "note-list", "note-row", "route-", "pdf-parser", "file-status", "provider-", "toggle-group", "answer-length", "confirm-", "history-knowledge", "history-select", "session-day", "detail-overview"];
    let checked = 0;
    for (const rule of rules) {
      if (!rule.selectors.some(selector => parts.some(part => selector.includes(`.${part}`)))) continue;
      checked++;
      for (const declaration of rule.body.split(";")) {
        const [property, value = ""] = declaration.split(":").map(part => part.trim());
        if (property === "max-height" || property === "height") expect(value, `${rule.selectors.join(", ")} { ${property} }`).toMatch(/^(auto|none|\d+px|1px)$/u);
        if (property === "overflow-y" || property === "overflow") expect(value, `${rule.selectors.join(", ")} { ${property} }`).not.toMatch(/auto|scroll/u);
        if (property === "position") expect(value, rule.selectors.join(", ")).not.toBe("fixed");
      }
    }
    expect(checked).toBeGreaterThan(20);
    // The notebook and the PDF card are plain blocks in the tab panel, which itself grows with the page.
    expect(styles).toMatch(/\.notebook \{ display: grid; gap: 8px; \}/u);
  });
});
