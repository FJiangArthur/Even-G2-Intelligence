import { describe, expect, it, vi } from "vitest";
import { StartUpPageCreateResult, type EvenHubEvent } from "@evenrealities/even_hub_sdk";
import { DirectConversationTransport, exportToOmi, type DirectConversationOptions, type HistorySession } from "@helix/conversation-sdk";
import { G2ConversationController, type G2BridgePort } from "../src/controller";
import { GlassesRenderer } from "../src/glasses-renderer";
import { ConversationPresentation } from "../src/presentation";
import { DEFAULT_CONFIG } from "../src/config";
import { cleanTranscript } from "../src/history-panel";

// Knowledge transfers run against the real SDK Markdown functions; only the Omi network call is mocked.
vi.mock("@helix/conversation-sdk", async importOriginal => ({ ...await importOriginal<typeof import("@helix/conversation-sdk")>(), exportToOmi: vi.fn() }));

const HISTORY_KEY = "helix.g2.history.v1";
const seeded = (sessions: HistorySession[], entries: object[] = []) => new Map([[HISTORY_KEY, JSON.stringify({ version: 1, sessions, entries })]]);
const helix: HistorySession = { id: "session_k1", source: "helix", title: "CDTF sync", startedAt: "2026-11-08T20:00:00.000Z", updatedAt: "2026-11-08T20:30:00.000Z",
  summary: ["Moves to CDTF."], keyFacts: ["8 weeks"], people: [{ name: "Priya", role: "Lead", mentions: 2 }], concepts: ["CDTF: depth-aware fusion"] };
const omi: HistorySession = { id: "omi:k2", source: "omi", title: "1:1 with Kan", startedAt: "2026-11-07T20:00:00.000Z", updatedAt: "2026-11-07T20:10:00.000Z", people: [{ name: "Kan" }, { name: "priya" }] };
const entries = [
  { id: "session_k1:t1", sessionId: "session_k1", kind: "transcript", text: "We're moving to CDTF, see https://wiki.example.com/x", occurredAt: "2026-11-08T20:01:00.000Z", speaker: "Other speaker",
    metadata: { model: "gpt-6.1-terra", provider: "openai", endpoint: "https://api.openai.com/v1/responses", latencyMs: "120" } },
  { id: "session_k1:a1", sessionId: "session_k1", kind: "answer", text: "Fusion before BEV pooling.", occurredAt: "2026-11-08T20:02:00.000Z", speaker: "Helix" },
];

function fixture(storage = new Map<string, string>()) {
  let options: DirectConversationOptions | undefined;
  const bridge: G2BridgePort = {
    getLocalStorage: async key => storage.get(key) ?? "",
    setLocalStorage: async (key, value) => { storage.set(key, value); return true; },
    createStartUpPageContainer: async () => StartUpPageCreateResult.success,
    textContainerUpgrade: async () => true,
    audioControl: async () => true,
    shutDownPageContainer: async () => true,
    onEvenHubEvent: (_listener: (event: EvenHubEvent) => void) => () => {},
  };
  const presentation = new ConversationPresentation();
  const controller = new G2ConversationController(bridge, new GlassesRenderer(bridge, { debounceMs: 0 }), presentation, opts => {
    options = opts;
    return new DirectConversationTransport({ ...opts, insights: undefined, fetch: async () => new Response("{}", { status: 404 }) });
  });
  return { controller, presentation, storage, copilot: () => options!.copilot! };
}
const form = { ...DEFAULT_CONFIG, transcriptionProvider: "openai-whisper" as const, copilotSummarize: false, copilotConcepts: false, copilotConflicts: false, copilotSuggestions: false,
  copilotImplicitAsks: false, copilotWebGrounding: false, autoQuestion: false, autoAnswer: false, autoNotes: false, accessToken: "", openaiApiKey: "test-key", deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", saveApiKeysOnPhone: false };

describe("v0.8 knowledge: persistence, stats, people", () => {
  it("persists copilot summary, people and concepts into the live session so History shows them after it ends", async () => {
    const f = fixture();
    await f.controller.initialize();
    await f.controller.connect(form);
    const sessionId = f.controller.liveSessionId()!;
    expect(sessionId).toMatch(/^session_/u);
    const now = new Date().toISOString();
    f.copilot().onSummary!({ bullets: ["Team moves to CDTF."], keyFacts: ["Lead time 8 weeks"], updatedAt: now, transcriptChars: 100 });
    f.copilot().onConcept!({ id: "c1", term: "CDTF", explanation: "Depth-aware fusion.", createdAt: now, origin: "copilot" });
    f.copilot().onPerson!({ id: "p1", name: "Priya Raman", role: "Perception lead", context: "Owns CDTF.", mentions: 3, firstSeen: now, lastSeen: now });
    f.copilot().onPerson!({ id: "p1", name: "priya  raman", context: "Owns CDTF.", mentions: 4, firstSeen: now, lastSeen: now });
    expect(f.presentation.snapshot().people).toEqual([expect.objectContaining({ name: "Priya Raman", mentions: 4, role: "Perception lead" })]);
    await f.controller.disconnect(); // flushes pending knowledge before the session ends
    const saved = f.controller.listHistorySessions().find(session => session.id === sessionId)!;
    expect(saved).toMatchObject({ summary: ["Team moves to CDTF."], keyFacts: ["Lead time 8 weeks"], concepts: ["CDTF: Depth-aware fusion."],
      people: [{ name: "Priya Raman", role: "Perception lead", mentions: 4 }] });
    expect(f.controller.listPeople()).toEqual([expect.objectContaining({ name: "Priya Raman", sessionIds: [sessionId], mentions: 4 })]);
    expect(f.controller.knowledgeStats().helix).toMatchObject({ sessions: 1 });
    expect(f.controller.sessionsForPerson("PRIYA RAMAN").map(session => session.id)).toEqual([sessionId]);
    await f.controller.dispose();
  });

  it("debounces knowledge writes during a live session and skips deleted sessions", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      await f.controller.initialize();
      await f.controller.connect(form);
      const sessionId = f.controller.liveSessionId()!;
      f.copilot().onSummary!({ bullets: ["A"], keyFacts: [], updatedAt: "", transcriptChars: 1 });
      expect(f.controller.listHistorySessions()[0]?.summary).toBeUndefined();
      await vi.advanceTimersByTimeAsync(f.controller.knowledgeFlushMs + 10);
      await vi.waitFor(() => expect(f.controller.listHistorySessions().find(session => session.id === sessionId)?.summary).toEqual(["A"]));
      await f.controller.deleteHistorySession(sessionId);
      f.copilot().onSummary!({ bullets: ["B"], keyFacts: [], updatedAt: "", transcriptChars: 1 });
      await vi.advanceTimersByTimeAsync(f.controller.knowledgeFlushMs + 10);
      expect(f.controller.listHistorySessions()).toEqual([]);
      expect(f.controller.historySnapshot().status).not.toMatch(/Cannot update knowledge/u);
      await f.controller.dispose();
    } finally { vi.useRealTimers(); }
  });
});

describe("v0.8 knowledge transfers", () => {
  it("Helix -> Obsidian: session Markdown and vault bundle carry knowledge + Mermaid and no URLs or provider metadata", async () => {
    const f = fixture(seeded([helix], entries));
    await f.controller.initialize();
    const markdown = f.controller.sessionMarkdown("session_k1")!;
    expect(markdown).toMatch(/^---\ntitle: "CDTF sync"/u);
    expect(markdown).toContain("## Summary\n- Moves to CDTF.");
    expect(markdown).toContain("```mermaid");
    expect(markdown).toContain("> Helix: Fusion before BEV pooling.");
    expect(markdown).not.toMatch(/https?:|api\.openai|gpt-6|latencyMs|provider/u);
    const files = f.controller.vaultFiles();
    expect(files.map(file => file.path)).toEqual(["Helix/2026-11-08 CDTF sync.md"]);
    expect(f.controller.vaultFiles(["missing"])).toEqual([]);
    expect(cleanTranscript(f.controller.openHistorySession("session_k1")!.entries).map(line => `${line.speaker}: ${line.text}`))
      .toEqual(["Them: We're moving to CDTF, see", "Helix: Fusion before BEV pooling."]);
  });

  it("Obsidian -> Helix: imports .md notes as obsidian sessions and reports failures per file", async () => {
    const f = fixture();
    await f.controller.initialize();
    const note = "---\ntitle: Edge logger\ndate: 2026-11-06\npeople:\n  - Marco\n---\n# Edge logger\n\n## Summary\n- Ring buffer on NVMe.\n\n## Transcript\n\n**Marco:** Offload at the depot.\n";
    const result = await f.controller.importMarkdownFiles([{ name: "Edge logger.md", text: note }, { name: "huge.md", text: "x".repeat(2_000_001) }]);
    expect(result.imported).toBe(1);
    expect(result.failed).toEqual([{ name: "huge.md", error: expect.stringMatching(/^huge\.md: .*too large/u) }]);
    const [session] = f.controller.listHistorySessions();
    expect(session).toMatchObject({ source: "obsidian", title: "Edge logger", summary: ["Ring buffer on NVMe."], people: [{ name: "Marco" }] });
    expect(f.controller.knowledgeStats().obsidian).toMatchObject({ sessions: 1 });
    expect(f.controller.openHistorySession(session!.id)!.entries.some(entry => entry.text === "Offload at the depot." && entry.speaker === "Marco")).toBe(true);
    expect(f.controller.historySnapshot().status).toBe("Imported 1 Obsidian note · 1 failed.");
  });

  it("Helix/Obsidian -> Omi: calls the SDK exportToOmi per session, summarizes, and stops on auth errors", async () => {
    const mocked = vi.mocked(exportToOmi);
    mocked.mockReset();
    mocked.mockResolvedValueOnce({ status: "exported", conversationId: "c1", endpoint: "from-segments", segments: 1, discarded: false })
      .mockResolvedValueOnce({ status: "skipped", reason: "This session came from Omi; exporting it back would duplicate it." });
    const f = fixture(seeded([helix, omi], entries));
    await f.controller.initialize();
    expect(f.controller.omiExportSupport()).toEqual({ supported: true, reason: "" });
    await expect(f.controller.exportSessionsToOmi(["session_k1"], "  ")).rejects.toThrow(/Omi developer API key/u);
    await expect(f.controller.exportSessionsToOmi(["nope"], "omi_dev_x")).rejects.toThrow(/saved session/u);
    const result = await f.controller.exportSessionsToOmi(["session_k1", "omi:k2"], "omi_dev_key");
    expect(result).toEqual({ exported: 1, message: "Sent 1 of 2 sessions to Omi. 1 skipped: This session came from Omi; exporting it back would duplicate it." });
    expect(mocked).toHaveBeenCalledTimes(2);
    expect(mocked.mock.calls[0]![0]).toMatchObject({ key: "omi_dev_key", session: { id: "session_k1" }, entries: [{ id: "session_k1:t1" }, { id: "session_k1:a1" }], language: "en" });
    mocked.mockReset();
    mocked.mockResolvedValue({ status: "failed", code: "auth", message: "Omi rejected the API key." });
    const failed = await f.controller.exportSessionsToOmi(["session_k1", "omi:k2"], "bad");
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(failed.message).toBe("Sent 0 of 1 session to Omi. 1 failed: Omi rejected the API key.");
    expect(f.controller.historySnapshot().status).toBe(failed.message);
  });

  it("aggregates people across sources for the People tab", async () => {
    const f = fixture(seeded([helix, omi], entries));
    await f.controller.initialize();
    expect(f.controller.listPeople().map(person => [person.name, person.sessionIds, person.mentions])).toEqual([
      ["Priya", ["session_k1", "omi:k2"], 3],
      ["Kan", ["omi:k2"], 1],
    ]);
  });
});
