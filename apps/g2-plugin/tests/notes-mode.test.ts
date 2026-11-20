import { StartUpPageCreateResult, type CreateStartUpPageContainer, type RebuildPageContainer, type TextContainerUpgrade } from "@evenrealities/even_hub_sdk";
import { DirectConversationTransport, MODE_PROFILES, PICKER_MODES, SELF_SPEAKER, OTHER_SPEAKER, applyTodoOp, type DirectConversationOptions, type TodoItem } from "@helix/conversation-sdk";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, applyModePreset, cleanModePrompts, copilotSettingsFromConfig } from "../src/config";
import { G2ConversationController, type G2BridgePort } from "../src/controller";
import { GlassesHud, HUD_LINE_WIDTH, hudTextWidth } from "../src/glasses-hud";
import { GlassesRenderer, type GlassesRenderBridge } from "../src/glasses-renderer";
import { todoProvenance } from "../src/notebook-panel";
import { modeIcon } from "../src/pixel-art";
import { ConversationPresentation } from "../src/presentation";

class Bridge implements GlassesRenderBridge {
  creates: CreateStartUpPageContainer[] = []; rebuilds: RebuildPageContainer[] = []; updates: TextContainerUpgrade[] = [];
  async createStartUpPageContainer(c: CreateStartUpPageContainer) { this.creates.push(c); return StartUpPageCreateResult.success; }
  async rebuildPageContainer(c: RebuildPageContainer) { this.rebuilds.push(c); return true; }
  async textContainerUpgrade(c: TextContainerUpgrade) { this.updates.push(c); return true; }
}
const at = "2026-11-19T13:00:00.000Z";
function todos(): TodoItem[] {
  let n = 0, list: TodoItem[] = [];
  for (const op of [{ op: "add" as const, text: "Send the quote", owner: "Mei", due: "Friday" }, { op: "add" as const, text: "Call the vendor about the pricing tiers" }, { op: "add" as const, text: "Book the room" }]) {
    list = applyTodoOp(list, op, { origin: "copilot", now: at, newId: () => `t${++n}` }).list;
  }
  return applyTodoOp(list, { op: "complete", id: "t3" }, { origin: "user", now: at }).list;
}

describe("Notes mode on the phone (mode picker, presets, prompts)", () => {
  it("is offered in the picker with its own icon and chip colour", () => {
    expect(PICKER_MODES).toContain("notes");
    expect(modeIcon("notes")).toBe("check");
    expect(new Set(PICKER_MODES.map(mode => modeIcon(mode))).size).toBe(PICKER_MODES.length);
    expect(readFileSync(new URL("../src/styles.css", import.meta.url), "utf8")).toContain('.mode-chip[data-mode="notes"]');
  });
  it("switching to Notes turns auto-answers and the answer-style lanes off and keeps the summary on", () => {
    const config = applyModePreset({ ...DEFAULT_CONFIG }, "notes");
    expect(config).toMatchObject({ conversationMode: "notes", autoAnswer: false, responseStrategy: "reactive", copilotSummarize: true, copilotConcepts: false,
      copilotConflicts: false, copilotSuggestions: false, copilotImplicitAsks: false, copilotClaims: false, copilotPeople: true });
    expect(copilotSettingsFromConfig(config).mode).toBe("notes");
    expect(cleanModePrompts({ notes: "  Answer only about owners and dates.  ", bogus: "x" })).toEqual({ notes: "Answer only about owners and dates." });
    expect(cleanModePrompts({ notes: MODE_PROFILES.notes.answer })).toBeUndefined();
  });
});

describe("Notes mode on the glasses", () => {
  async function mount() {
    const bridge = new Bridge(), hud = new GlassesHud(bridge, { tickMs: 0 }), presentation = new ConversationPresentation();
    presentation.subscribe(snapshot => hud.render(snapshot.glasses, snapshot));
    await hud.initialize();
    return { hud, presentation };
  }
  it("shows only a short confirmation when a to-do is captured or changed, and the list in the TO-DO view", async () => {
    const { hud, presentation } = await mount();
    presentation.setMode("notes");
    presentation.setStatus("listening");
    expect(hud.frame.mode).toBe("NOTES");
    expect(hud.frame.views.split("\n")).toEqual(["▶ LIVE", "ANSWER", "ASK THEM", "CONCEPTS", "TO-DO", "CHECKS"]);
    expect(hud.frame.body).toContain("Listening");
    const list = todos();
    presentation.applyNotebook(list.slice(0, 1), [], "TODO + Send the quote - Mei, Fri");
    expect(hud.view).toBe("live"); // no view switch, no answer
    expect(hud.frame.body.split("\n")[0]).toBe("TODO + Send the quote - Mei, Fri");
    expect(hud.frame.views.split("\n")[4]).toBe("TO-DO ●");
    presentation.applyNotebook(list, [{ id: "n1", text: "Budget approved at 40k.", createdAt: at }], "TODO done: Book the room");
    expect(hud.frame.body.split("\n")[0]).toBe("TODO done: Book the room");
    expect(hud.frame.body).toContain("· TODO + Send the quote - Mei, Fri");

    hud.setView("summary");
    expect(hud.frame.title).toMatch(/^TO-DO 1\/\d/u);
    const lines = hud.frame.body.split("\n");
    expect(lines[0]).toBe("[ ] Send the quote - Mei, Fri");
    expect(lines.filter(line => line.startsWith("[ ]"))).toHaveLength(2);
    expect(lines.some(line => line.startsWith("[x] Book the room"))).toBe(true);
    expect(hud.frame.body).toContain("• Budget approved at 40k.");
    for (const line of lines) expect(hudTextWidth(line)).toBeLessThanOrEqual(HUD_LINE_WIDTH.body);
    expect(hud.frame.views.split("\n")[4]).toBe("▶ TO-DO");
    hud.dispose();
  });
  it("keeps the SUMMARY view as before in other modes and says so when the notebook is empty", async () => {
    const { hud, presentation } = await mount();
    presentation.setMode("general"); presentation.setStatus("listening");
    hud.setView("summary");
    expect(hud.frame.title).toBe("SUMMARY");
    expect(hud.frame.body).toContain("No summary yet.");
    presentation.setMode("notes");
    expect(hud.frame.title).toBe("TO-DO");
    expect(hud.frame.body).toContain("No to-dos or notes yet.");
    hud.dispose();
  });
  it("the answers-only layout gets the confirmation as a cue; nothing is shown while not connected", () => {
    const presentation = new ConversationPresentation();
    presentation.applyNotebook(todos(), [], "TODO + Send the quote - Mei, Fri");
    expect(presentation.snapshot().glasses.cue).toBeUndefined();
    presentation.setStatus("listening");
    presentation.applyNotebook(todos(), [], "TODO ~ Send the quote - Raj, Mon");
    expect(presentation.snapshot().glasses.cue?.text).toBe("TODO ~ Send the quote - Raj, Mon");
    expect(presentation.snapshot().notebook?.cues.map(cue => cue.text)).toEqual(["TODO + Send the quote - Mei, Fri", "TODO ~ Send the quote - Raj, Mon"]);
    for (let i = 0; i < 8; i++) presentation.applyNotebook(todos(), [], `TODO + item ${i}`);
    expect(presentation.snapshot().notebook?.cues).toHaveLength(5);
    presentation.reset();
    expect(presentation.snapshot().notebook).toBeUndefined();
  });
});

const message = (text: string) => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 100, output_tokens: 20 } });
function fixture(storage = new Map<string, string>()) {
  const bridge: G2BridgePort = {
    getLocalStorage: async key => storage.get(key) ?? "",
    setLocalStorage: async (key, value) => { storage.set(key, value); return true; },
    createStartUpPageContainer: async () => StartUpPageCreateResult.success,
    textContainerUpgrade: async () => true,
    audioControl: async () => true,
    shutDownPageContainer: async () => true,
    onEvenHubEvent: () => () => undefined,
  };
  const requests: { schema?: string; instructions: string; input: string }[] = [];
  let transport!: DirectConversationTransport;
  let copilotReply: Record<string, unknown> = {};
  const presentation = new ConversationPresentation();
  const controller = new G2ConversationController(bridge, new GlassesRenderer(bridge, { debounceMs: 0 }), presentation, (options?: DirectConversationOptions) => {
    transport = new DirectConversationTransport({ ...options, insights: undefined, fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: { format?: { name?: string } }; instructions?: string; input?: unknown };
      requests.push({ schema: body.text?.format?.name, instructions: String(body.instructions ?? ""), input: typeof body.input === "string" ? body.input : JSON.stringify(body.input ?? "") });
      if (body.text?.format?.name === "helix_copilot") return Response.json(message(JSON.stringify({ summary: { bullets: [], keyFacts: [] }, people: [], todoOps: [], notes: [], ...copilotReply })));
      return new Response('data: {"type":"response.output_text.delta","delta":"An answer."}\n\ndata: {"type":"response.completed"}\n\n', { headers: { "content-type": "text/event-stream" } });
    } });
    return transport;
  });
  return { controller, presentation, storage, requests, transport: () => transport, reply: (value: Record<string, unknown>) => { copilotReply = value; } };
}
const form = { ...applyModePreset({ ...DEFAULT_CONFIG }, "notes"), accessToken: "", openaiApiKey: "test-key", deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", saveApiKeysOnPhone: false };

describe("Notes mode end to end (controller, history, Markdown)", () => {
  it("captures by voice and from the conversation, stays quiet, saves with the session and survives a relaunch", async () => {
    const f = fixture();
    await f.controller.initialize();
    await f.controller.connect(form);
    const sessionId = f.controller.liveSessionId()!;
    // The wearer adds a to-do by voice: applied at once, no model call needed.
    await f.transport().injectTranscript("Add a to-do to call the vendor by Friday.", SELF_SPEAKER);
    await vi.waitFor(() => expect(f.presentation.snapshot().notebook?.todos).toHaveLength(1));
    expect(f.presentation.snapshot().notebook?.todos[0]).toMatchObject({ text: "Call the vendor", due: "Friday", origin: "voice", done: false });
    expect(f.presentation.snapshot().notebook?.cues.at(-1)?.text).toBe("TODO + Call the vendor - Fri");
    // The conversation adds an owned item and a note through the copilot lane.
    f.reply({ todoOps: [{ op: "add", id: "", text: "Send the quote", owner: "Mei", due: "Monday", quote: "Mei will send the quote on Monday" }],
      notes: [{ text: "The pilot budget is 40k.", quote: "the pilot budget is forty thousand, 40k" }] });
    await f.transport().injectTranscript("Mei will send the quote on Monday, and the pilot budget is forty thousand, 40k.", OTHER_SPEAKER);
    f.controller.runCopilot();
    await vi.waitFor(() => expect(f.presentation.snapshot().notebook?.todos).toHaveLength(2));
    f.reply({});
    const live = f.presentation.snapshot().notebook!;
    expect(live.todos[1]).toMatchObject({ text: "Send the quote", owner: "Mei", due: "Monday", origin: "copilot", source: { speaker: expect.any(String), quote: "Mei will send the quote on Monday", promptVersion: "notes-1" } });
    expect(live.notes.map(note => note.text)).toEqual(["The pilot budget is 40k."]);
    const copilot = f.requests.find(request => request.schema === "helix_copilot" && request.input.includes("Mei will send"))!;
    expect(copilot.instructions).toContain("todoOps:");
    expect(JSON.parse(copilot.input).todoList).toEqual([{ id: live.todos[0]!.id, text: "Call the vendor", owner: "", due: "Friday", done: false }]);
    // Quiet: a question in the room is not auto-answered in this mode.
    await f.transport().injectTranscript("What is the lead time for the new boards right now?", OTHER_SPEAKER);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.presentation.snapshot().feed.some(item => item.kind === "answer")).toBe(false);
    // Phone edits and a spoken completion edit the same list.
    expect(await f.controller.editTodo({ op: "update", id: live.todos[1]!.id, owner: "Raj" })).toBe(true);
    await f.transport().injectTranscript("Mark the vendor call done.", SELF_SPEAKER);
    await vi.waitFor(() => expect(f.presentation.snapshot().notebook?.todos[0]?.done).toBe(true));
    expect(f.presentation.snapshot().notebook?.todos).toHaveLength(2);
    await f.controller.disconnect();
    await f.controller.flushHistory();

    // Relaunch: a new controller over the same phone storage.
    const again = fixture(f.storage);
    await again.controller.initialize();
    await vi.waitFor(() => expect(again.controller.openHistorySession(sessionId)?.session.todos).toHaveLength(2));
    const saved = again.controller.openHistorySession(sessionId)!.session;
    expect(saved.todos!.map(({ text, owner, due, done }) => ({ text, owner, due, done }))).toEqual([
      { text: "Call the vendor", owner: undefined, due: "Friday", done: true }, { text: "Send the quote", owner: "Raj", due: "Monday", done: false }]);
    expect(saved.notes!.map(note => note.text)).toEqual(["The pilot budget is 40k."]);
    const markdown = again.controller.sessionMarkdown(sessionId)!;
    expect(markdown).toContain("## To-dos\n- [x] Call the vendor (due Friday)\n- [ ] Send the quote (Raj, due Monday)\n");
    expect(markdown).toContain("## Notes\n- The pilot budget is 40k.\n");
    // History: check off, add and delete on the saved session.
    expect(await again.controller.editTodo({ op: "complete", id: saved.todos![1]!.id }, sessionId)).toBe(true);
    expect(await again.controller.editTodo({ op: "add", text: "Email the summary" }, sessionId)).toBe(true);
    expect(await again.controller.editTodo({ op: "remove", id: saved.todos![0]!.id }, sessionId)).toBe(true);
    expect(await again.controller.editTodo({ op: "remove", id: "missing" }, sessionId)).toBe(false);
    expect(again.controller.sessionMarkdown(sessionId)).toContain("## To-dos\n- [x] Send the quote (Raj, due Monday)\n- [ ] Email the summary\n");
    expect(again.controller.vaultFiles([sessionId])[0]!.content).toContain("- [ ] Email the summary");
    await again.controller.dispose(); await f.controller.dispose();
  });
  it("leaves spoken to-do phrases alone outside Notes mode", async () => {
    const f = fixture();
    await f.controller.initialize();
    await f.controller.connect({ ...form, ...applyModePreset({ ...DEFAULT_CONFIG }, "passive") });
    await f.transport().injectTranscript("Add a to-do to call the vendor by Friday.", SELF_SPEAKER);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.presentation.snapshot().notebook).toBeUndefined();
    expect(f.requests.every(request => !request.instructions.includes("todoOps:"))).toBe(true);
    // Switching to Notes live starts capturing without reconnecting.
    await f.controller.setMode("notes");
    await f.transport().injectTranscript("Add a to-do to book the demo room.", SELF_SPEAKER);
    await vi.waitFor(() => expect(f.presentation.snapshot().notebook?.todos.map(item => item.text)).toEqual(["Book the demo room"]));
    await f.controller.dispose();
  });
});

describe("to-do provenance on the phone", () => {
  it("shows the quoted passage and speaker, or how the item was added", () => {
    const [first] = todos();
    expect(todoProvenance({ ...first!, source: { quote: "Mei will send the quote by Friday", speaker: "Bob", transcriptId: "tr-1" } })).toBe("Bob: “Mei will send the quote by Friday”");
    expect(todoProvenance({ ...first!, origin: "user" })).toBe("Added on phone");
    expect(todoProvenance({ ...first!, origin: "voice" })).toBe("Added by voice");
  });
});
