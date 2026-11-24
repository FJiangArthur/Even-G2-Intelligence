import { describe, expect, it } from "vitest";
import { LEGACY_HISTORY_KEY, type HistoryEntry, type HistorySession } from "@helix/conversation-sdk";
import { G2ConversationController } from "../src/controller";
import { ConversationPresentation } from "../src/presentation";
import type { GlassesRenderer } from "../src/glasses-renderer";
import { cleanupDefaultTicks, cleanupPlan, cleanupPreview } from "../src/history-panel";

/* ------------------------------------------------------------------ fixtures */

const DIGEST = { title: "Vendor follow-ups", overview: "The vendor call and the quote were assigned.", summary: ["Vendor call assigned."], keyFacts: ["Quote due Friday."], concepts: [{ term: "Lead time", explanation: "Weeks from order to delivery." }] };
const message = (text: string) => ({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 100, output_tokens: 20 } });
async function rig(storage = new Map<string, string>()) {
  const bridge = {
    getLocalStorage: async (key: string) => storage.get(key) ?? "", setLocalStorage: async (key: string, value: string) => { storage.set(key, value); return true; },
    createStartUpPageContainer: async () => 0, textContainerUpgrade: async () => true,
    audioControl: async () => true, shutDownPageContainer: async () => true, onEvenHubEvent: () => () => undefined,
  };
  const api = { digests: 0 };
  const controller = new G2ConversationController(bridge as never, { initialize: async () => undefined, render: () => undefined, dispose: async () => undefined } as unknown as GlassesRenderer, new ConversationPresentation());
  controller.keyTestFetch = async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? init.body : "";
    if (String(url).endsWith("/responses") && body.includes("helix_session_digest")) { api.digests++; return Response.json(message(JSON.stringify(DIGEST))); }
    return new Response("{}", { status: 404 });
  };
  await controller.initialize();
  return { controller, storage, api };
}
const T0 = Date.parse("2026-11-10T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const helix = (id: string, start: number, extra: Partial<HistorySession> = {}): HistorySession =>
  ({ id, source: "helix", title: `Helix · ${at(start)}`, startedAt: at(start), updatedAt: at(start + 1), ...extra });
const line = (id: string, sessionId: string, text: string, extra: Partial<HistoryEntry> = {}): HistoryEntry =>
  ({ id, sessionId, kind: "transcript", text, occurredAt: at(0), speaker: "Other speaker", ...extra });
const seed = (sessions: HistorySession[], entries: HistoryEntry[] = []) => new Map([[LEGACY_HISTORY_KEY, JSON.stringify({ version: 1, sessions, entries })]]);
const LONG = "Orin lead time is twelve weeks and Kan will escalate with the distributor.";
const note = (body: string) => `# Plan\n\n${body}\n`;

/* ------------------------------------------------------------------ Markdown re-import */

describe("v0.16 fixes: Markdown re-import keeps what was added on the phone", () => {
  it("a generated summary and to-dos survive a re-import of the edited note; stale lines still go", async () => {
    const { controller } = await rig();
    const body = "The vendor call is on Monday.\n\nThe quote is due on Friday.\n\nKan owns the follow-up.";
    const first = await controller.importMarkdownFiles([{ name: "Plan.md", text: note(body) }]);
    const id = first.sessionIds[0]!;
    await controller.generateSessionKnowledge(id, "setup-key");
    expect(await controller.editTodo({ op: "add", text: "Send the quote" }, id)).toBe(true);
    expect(await controller.editTodo({ op: "add", text: "Book the room" }, id)).toBe(true);
    const before = controller.openHistorySession(id)!.session;
    expect(before).toMatchObject({ summary: DIGEST.summary, keyFacts: DIGEST.keyFacts, overview: DIGEST.overview, recap: { origin: "model" } });

    const second = await controller.importMarkdownFiles([{ name: "Plan.md", text: note(body.replace("on Friday", "on Thursday")) }]);
    expect(second.sessionIds).toEqual([id]);
    const after = controller.openHistorySession(id)!;
    expect(after.entries.map(entry => entry.text)).toEqual(["The vendor call is on Monday.", "The quote is due on Thursday.", "Kan owns the follow-up."]);
    expect(after.session).toMatchObject({ summary: DIGEST.summary, keyFacts: DIGEST.keyFacts, overview: DIGEST.overview, recap: { origin: "model" }, concepts: before.concepts });
    expect(after.session.todos?.map(item => item.text)).toEqual(["Send the quote", "Book the room"]);
    await controller.dispose();
  });
  it("what the note itself defines replaces the saved value", async () => {
    const { controller } = await rig();
    const first = await controller.importMarkdownFiles([{ name: "Plan.md", text: note("The vendor call is on Monday.\n\nThe quote is due on Friday.") }]);
    const id = first.sessionIds[0]!;
    await controller.generateSessionKnowledge(id, "setup-key");
    await controller.importMarkdownFiles([{ name: "Plan.md", text: note("The vendor call is on Monday.\n\nThe quote is due on Friday.\n\n## Summary\n\n- Written in Obsidian.") }]);
    expect(controller.openHistorySession(id)!.session).toMatchObject({ title: "Plan", summary: ["Written in Obsidian."], keyFacts: DIGEST.keyFacts });
    await controller.dispose();
  });
});

/* ------------------------------------------------------------------ clean-up */

describe("v0.16 fixes: clean-up acts on what is true when it is confirmed", () => {
  it("leaves a session that gained a to-do or a summary after the preview was opened, and says so", async () => {
    const { controller } = await rig(seed([helix("stray", 0), helix("stray-2", 60), helix("mic", 120)],
      [line("stray:1", "stray", "Okay."), line("stray-2:1", "stray-2", "Hello there."), line("mic:1", "mic", "Testing.")]));
    const proposal = controller.historyCleanupProposal();
    const plan = cleanupPlan(proposal, cleanupDefaultTicks(proposal));
    expect([...plan.remove].sort()).toEqual(["mic", "stray", "stray-2"]);
    // The wearer opens two of them from the list and adds something.
    expect(await controller.editTodo({ op: "add", text: "Call Kan back" }, "stray")).toBe(true);
    await controller.generateSessionKnowledge("stray-2", "setup-key");
    const result = await controller.applyHistoryCleanup(plan);
    expect(result).toMatchObject({ removed: 1, merged: 0, failed: 0, skipped: 2 });
    expect(result.message).toBe("Session removed from this phone and local retrieval. 2 left as they are: they changed after the list was made.");
    expect(controller.listHistorySessions().map(session => session.id).sort()).toEqual(["stray", "stray-2"]);
    await controller.dispose();
  });
  it("does not merge a pair that is no longer proposed", async () => {
    const { controller } = await rig(seed([helix("a", 0, { endedAt: at(5) }), helix("b", 8, { endedAt: at(12) })], [line("a:1", "a", LONG, { occurredAt: at(1) }), line("b:1", "b", LONG, { occurredAt: at(9) })]));
    const result = await controller.applyHistoryCleanup({ remove: [], merge: [{ fromId: "a", intoId: "b" }] }); // not a pair the preview offers
    expect(result).toMatchObject({ merged: 0, skipped: 1 });
    expect(controller.listHistorySessions()).toHaveLength(2);
    await controller.dispose();
  });
});

describe("v0.16 fixes: a clean-up merge does not throw the two summaries away", () => {
  const recapped = () => seed([
    helix("call", 100, { title: "Orin supply call", overview: "Orin boards slip to March.", recap: { origin: "model", generatedAt: at(106) }, endedAt: at(105) }),
    helix("budget", 111, { title: "Budget follow-up", overview: "The budget review moves a week.", recap: { origin: "model", generatedAt: at(118) }, endedAt: at(117) }),
  ], [line("call:1", "call", LONG, { occurredAt: at(101) }), line("budget:1", "budget", `${LONG} The budget review moves a week.`, { occurredAt: at(112) })]);

  it("without a key the surviving session shows both overviews, joined", async () => {
    const { controller, api } = await rig(recapped());
    const result = await controller.applyHistoryCleanup({ remove: [], merge: [{ fromId: "budget", intoId: "call" }] });
    expect(result).toMatchObject({ merged: 1, failed: 0 });
    await controller.recapSettled();
    expect(api.digests).toBe(0);
    const merged = controller.openHistorySession("call")!.session;
    expect(merged).toMatchObject({ title: "Orin supply call", overview: "Orin boards slip to March. The budget review moves a week.", recap: { origin: "fallback" } });
    await controller.dispose();
  });
  it("with a key a new summary of the whole session is written", async () => {
    const { controller, api } = await rig(recapped());
    await controller.applyHistoryCleanup({ remove: [], merge: [{ fromId: "budget", intoId: "call" }] }, "setup-key");
    await controller.recapSettled();
    expect(api.digests).toBe(1);
    expect(controller.openHistorySession("call")!.session).toMatchObject({ title: DIGEST.title, overview: DIGEST.overview, recap: { origin: "model" } });
    await controller.dispose();
  });
  it("with summaries turned off no call is made", async () => {
    const { controller, api } = await rig(recapped());
    controller.summarizeOnEnd = false;
    await controller.applyHistoryCleanup({ remove: [], merge: [{ fromId: "budget", intoId: "call" }] }, "setup-key");
    await controller.recapSettled();
    expect(api.digests).toBe(0);
    expect(controller.openHistorySession("call")!.session.overview).toBe("Orin boards slip to March. The budget review moves a week.");
    await controller.dispose();
  });
  it("the preview says what happens to the summaries", () => {
    const groups = cleanupPreview({ removals: [], merges: [{ fromId: "b", intoId: "a", fromTitle: "B", intoTitle: "A", fromStartedAt: at(8), intoStartedAt: at(0), gapMs: 60_000 }] });
    expect(groups.at(-1)!.note).toMatch(/cannot be undone/u);
    expect(groups.at(-1)!.note).toMatch(/summar/iu);
  });
});

/* ------------------------------------------------------------------ Omi */

describe("v0.16 fixes: Omi \"Summaries only\"", () => {
  const conversation = { id: "a", created_at: "2026-11-18T09:00:00Z", started_at: "2026-11-18T09:00:00Z", finished_at: "2026-11-18T09:05:00Z",
    structured: { title: "Standup", overview: "The calibration rig ships on Friday." },
    transcript_segments: [{ text: "The calibration rig ships on Friday.", start: 1, end: 3, speaker: "SPEAKER_00", speaker_name: "Ada" }] };
  it("an automatic summaries-only import keeps transcripts saved earlier", async () => {
    const { controller } = await rig();
    await controller.importOmi({ key: "omi-test", fetch: async () => Response.json([conversation]) });
    await controller.setOmiSummariesOnly(true);
    const { transcript_segments: _none, ...short } = conversation;
    await controller.importOmi({ key: "omi-test", fetch: async () => Response.json([short]) });
    const saved = controller.openHistorySession("omi:a")!;
    expect(saved.entries.filter(entry => entry.kind === "transcript").map(entry => entry.text)).toEqual(["The calibration rig ships on Friday."]);
    expect(saved.session.people).toEqual([{ name: "Ada" }]);
    await controller.dispose();
  });
});
