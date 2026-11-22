import { describe, expect, it, vi } from "vitest";
import { StartUpPageCreateResult } from "@evenrealities/even_hub_sdk";
import { DirectConversationTransport, LEGACY_HISTORY_KEY, LocalHistoryStore, type DirectConversationOptions } from "@helix/conversation-sdk";
import { G2ConversationController, type G2BridgePort } from "../src/controller";
import { GlassesRenderer } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";
import { DEFAULT_CONFIG } from "../src/config";
import { countDiagnostic } from "../src/diagnostics";

vi.mock("../src/diagnostics", async original => {
  const actual = await original<typeof import("../src/diagnostics")>();
  return { ...actual, countDiagnostic: vi.fn(actual.countDiagnostic) };
});

const form = { ...DEFAULT_CONFIG, transcriptionProvider: "openai-whisper" as const, copilotSummarize: false, copilotConcepts: false, copilotConflicts: false, copilotSuggestions: false,
  copilotImplicitAsks: false, copilotWebGrounding: false, autoQuestion: false, autoAnswer: false, autoNotes: false,
  accessToken: "", openaiApiKey: "session-key", deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", saveApiKeysOnPhone: false };
const at = "2026-09-01T00:00:00.000Z";

describe("saved-knowledge search in the controller", () => {
  it("hands the answer path the sliced search, warms its index before the first answer, and counts it for the phone diagnostics", async () => {
    const storage = new Map([[LEGACY_HISTORY_KEY, JSON.stringify({ version: 1,
      sessions: [{ id: "old", source: "helix", title: "Vendor call", startedAt: at, updatedAt: at }],
      entries: [{ id: "old:1", sessionId: "old", kind: "transcript", text: "The Orin lead time is twelve weeks.", occurredAt: at, speaker: "Other speaker" }] })]]);
    const bridge: G2BridgePort = {
      getLocalStorage: async key => storage.get(key) ?? "", setLocalStorage: async (key, value) => { storage.set(key, value); return true; },
      createStartUpPageContainer: async () => StartUpPageCreateResult.success, textContainerUpgrade: async () => true, audioControl: async () => true,
      shutDownPageContainer: async () => true, onEvenHubEvent: () => () => undefined,
    };
    const warm = vi.spyOn(LocalHistoryStore.prototype, "warmRetrieval"), sliced = vi.spyOn(LocalHistoryStore.prototype, "retrieveAsync"), blocking = vi.spyOn(LocalHistoryStore.prototype, "retrieveWithStats");
    let options!: DirectConversationOptions;
    const controller = new G2ConversationController(bridge, new GlassesRenderer(bridge, { debounceMs: 0 }), new ConversationPresentation(), opts => {
      options = opts!;
      return new DirectConversationTransport({ ...opts, insights: undefined, factCheck: { ...opts!.factCheck!, enabled: () => false }, fetch: async () => new Response("{}", { status: 404 }) });
    });
    await controller.initialize();
    expect(warm).toHaveBeenCalledTimes(1);                       // after the archive is loaded
    await controller.connect(form);
    expect(warm).toHaveBeenCalledTimes(2);                       // and at session start
    const live = controller.liveSessionId()!;
    vi.mocked(countDiagnostic).mockClear();
    const result = await options.retrieveMemoryAsync!("Orin lead time", live);
    expect(result).toMatchObject({ searchedEntries: 1, matched: 1, items: [{ entry: { id: "old:1" }, session: { title: "Vendor call" } }] });
    expect(sliced).toHaveBeenCalledWith("Orin lead time", expect.objectContaining({ excludeSessionId: live, deadlineMs: 2500 }));
    expect(blocking).not.toHaveBeenCalled();
    // Shown by the heartbeat as "memory-search Nx max S s".
    expect(vi.mocked(countDiagnostic).mock.calls.filter(call => call[0] === "memory-search")).toEqual([["memory-search", expect.any(Number)]]);
    expect(vi.mocked(countDiagnostic).mock.calls.some(call => call[0] === "memory-block")).toBe(false);
    // Not done by the deadline (cold index on a busy page): the answer gets no saved knowledge, the timeout is counted, nothing blocks.
    controller.knowledgeSearchDeadlineMs = 30;
    const answer = new AbortController();
    sliced.mockImplementationOnce(async (_query, options) => { expect(options).toMatchObject({ deadlineMs: 30, signal: answer.signal }); return { items: [], searchedEntries: 0, matched: 0, timedOut: true }; });
    vi.mocked(countDiagnostic).mockClear();
    expect(await options.retrieveMemoryAsync!("Orin lead time", live, answer.signal)).toEqual({ items: [], searchedEntries: 0, matched: 0, timedOut: true });
    expect(vi.mocked(countDiagnostic).mock.calls).toEqual([["memory-search-timeout", 30]]);
    expect(blocking).not.toHaveBeenCalled();
    // Switched off: nothing is searched or counted, and no index is built.
    await controller.setLocalMemoryEnabled(false);
    vi.mocked(countDiagnostic).mockClear(); sliced.mockClear();
    expect(await options.retrieveMemoryAsync!("Orin lead time", live)).toEqual({ items: [], searchedEntries: 0, matched: 0 });
    expect(sliced).not.toHaveBeenCalled(); expect(countDiagnostic).not.toHaveBeenCalled();
    await controller.dispose();
  });
});
