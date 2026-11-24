import { describe, expect, it } from "vitest";
import { IMPORT_STORAGE_FULL, LEGACY_HISTORY_KEY } from "@helix/conversation-sdk";
import { G2ConversationController, OMI_AUTO_IMPORT_STORAGE_KEY, type HistoryState, type MarkdownImportItem } from "../src/controller";
import { ConversationPresentation } from "../src/presentation";
import type { GlassesRenderer } from "../src/glasses-renderer";
import { readTextFile, readTextFiles } from "../src/file-transfer";
import { markdownImportText, markdownOutcomeLines, omiImportErrorText, omiImportText } from "../src/knowledge-panel";

/* ------------------------------------------------------------------ fixtures */

function bridgeWith(storage: Map<string, string>) {
  return {
    getLocalStorage: async (key: string) => storage.get(key) ?? "", setLocalStorage: async (key: string, value: string) => { storage.set(key, value); return true; },
    createStartUpPageContainer: async () => 0, textContainerUpgrade: async () => true,
    audioControl: async () => true, shutDownPageContainer: async () => true, onEvenHubEvent: () => () => undefined,
  };
}
async function controllerWith(storage = new Map<string, string>()) {
  const controller = new G2ConversationController(bridgeWith(storage) as never, { initialize: async () => undefined, render: () => undefined, dispose: async () => undefined } as unknown as GlassesRenderer, new ConversationPresentation());
  await controller.initialize();
  return { storage, controller };
}
const at = "2026-11-10T10:00:00.000Z";
/** A v1 archive (what an earlier version left on the phone). */
function archive(sessions: { id: string; source: string; title: string; startedAt?: string; lines: string[] }[]): string {
  return JSON.stringify({ version: 1,
    sessions: sessions.map(({ id, source, title, startedAt }) => ({ id, source, title, startedAt: startedAt ?? at, updatedAt: startedAt ?? at })),
    entries: sessions.flatMap(session => session.lines.map((text, i) => ({ id: `${session.id}:${i}`, sessionId: session.id, kind: "transcript", text, occurredAt: session.startedAt ?? at, speaker: "Them" }))) });
}
/** Imported notes that fill about 4.9 MiB of the 5 MiB import budget. */
const nearlyFull = () => ({ id: "obsidian:Filler", source: "obsidian", title: "Filler", lines: Array.from({ length: 1200 }, () => "calibration rig lead time ".repeat(160)) });
const note = (body: string, front = "") => `${front ? `---\n${front}\n---\n` : ""}# Untitled\n\n${body}\n`;
const omiConversation = (id: string, extra: Record<string, unknown> = {}) => ({ id, created_at: "2026-11-18T09:00:00Z", started_at: "2026-11-18T09:00:00Z", finished_at: "2026-11-18T09:05:00Z",
  structured: { title: `Standup ${id}`, overview: "The calibration rig ships on Friday.", action_items: [{ description: "Book the courier" }] },
  transcript_segments: [{ text: "The calibration rig ships on Friday.", start: 1, end: 3, speaker: "SPEAKER_00", is_user: false }, { text: "I will book the courier.", start: 4, end: 6, speaker: "SPEAKER_01", is_user: true }], ...extra });
const titles = (controller: G2ConversationController, id: string) => controller.openHistorySession(id)!.entries.map(entry => entry.text);

/* ------------------------------------------------------------------ Markdown */

describe("v0.16 Markdown import through the controller", () => {
  it("re-import of a shortened note leaves no stale lines", async () => {
    const { controller } = await controllerWith();
    const first = await controller.importMarkdownFiles([{ name: "Plan.md", text: note("Line one.\n\nLine two.\n\nLine three.") }]);
    const [id] = first.sessionIds;
    expect(titles(controller, id!)).toEqual(["Line one.", "Line two.", "Line three."]);
    const second = await controller.importMarkdownFiles([{ name: "Plan.md", text: note("Line one, rewritten.") }]);
    expect(second.sessionIds).toEqual([id]);
    expect(titles(controller, id!)).toEqual(["Line one, rewritten."]);
    expect(controller.searchHistory("three")).toEqual([]);
    expect(controller.listHistorySessions()).toHaveLength(1);
    await controller.dispose();
  });

  it("two notes with the same file name both survive, with or without something to tell them apart", async () => {
    const { controller } = await controllerWith();
    const result = await controller.importMarkdownFiles([
      { name: "Untitled.md", text: note("Work note."), path: "Vault/Work/Untitled.md" },
      { name: "Untitled.md", text: note("Home note."), path: "Vault/Home/Untitled.md" },
      { name: "Untitled.md", text: note("Bare note A.") },
      { name: "Untitled.md", text: note("Bare note B.") },
      { name: "Untitled.md", text: note("Bare note A.") }, // the same text again
    ]);
    expect(result.imported).toBe(4); expect(new Set(result.sessionIds).size).toBe(4);
    expect(result.skipped).toEqual([{ name: "Untitled.md", reason: "The same note is in this import twice" }]);
    expect(result.sessionIds.map(id => titles(controller, id)[0])).toEqual(["Work note.", "Home note.", "Bare note A.", "Bare note B."]);
    expect(result.files.map(file => file.state)).toEqual(["imported", "imported", "imported", "imported", "skipped"]);
    expect(result.message).toBe("Imported 4 of 5 notes · 1 skipped: The same note is in this import twice.");
    // The same import again: the four notes are replaced in place.
    await controller.importMarkdownFiles([
      { name: "Untitled.md", text: note("Work note, edited."), path: "Vault/Work/Untitled.md" },
      { name: "Untitled.md", text: note("Home note."), path: "Vault/Home/Untitled.md" },
    ]);
    expect(controller.listHistorySessions()).toHaveLength(4);
    expect(titles(controller, result.sessionIds[0]!)).toEqual(["Work note, edited."]);
    // Two pasted notes with one title are two notes; pasting the same text again is not a third.
    for (const text of ["# Ideas\n\nFirst idea.\n", "# Ideas\n\nSecond idea.\n", "# Ideas\n\nFirst idea.\n"]) await controller.importMarkdownFiles([{ name: "Ideas.md", text, pasted: true }]);
    expect(controller.listHistorySessions().filter(session => session.title === "Ideas")).toHaveLength(2);
    await controller.dispose();
  });

  it("a note saved under its old id by an earlier version is replaced, not doubled", async () => {
    const storage = new Map([[LEGACY_HISTORY_KEY, archive([{ id: "obsidian:Untitled", source: "obsidian", title: "Untitled", lines: ["Old line.", "A line removed since."] }, { id: "session_live", source: "helix", title: "Live", lines: ["Spoken."] }])]]);
    const { controller } = await controllerWith(storage);
    const result = await controller.importMarkdownFiles([{ name: "Untitled.md", text: note("Old line.", "created: 2026-10-01"), lastModified: Date.parse("2026-10-02T08:00:00Z") }]);
    expect(result.imported).toBe(1);
    const notes = controller.listHistorySessions().filter(session => session.source === "obsidian");
    expect(notes.map(session => session.id)).toEqual(result.sessionIds);
    expect(result.sessionIds[0]).toMatch(/^obsidian:Untitled:h[0-9a-f]{8}$/u);
    expect(titles(controller, result.sessionIds[0]!)).toEqual(["Old line."]);
    expect(controller.openHistorySession("obsidian:Untitled")).toBeUndefined();
    expect(controller.openHistorySession("session_live")).toBeDefined();
    await controller.dispose();
  });

  it("reads files one at a time with progress per note, and dates an undated note by its file", async () => {
    const { controller } = await controllerWith();
    let open = 0, most = 0;
    const files: MarkdownImportItem[] = Array.from({ length: 40 }, (_, i) => ({ name: `note-${i}.md`, lastModified: Date.parse("2026-03-04T05:06:07.000Z"),
      text: async () => { most = Math.max(most, ++open); await new Promise(resolve => setTimeout(resolve, 0)); open--; if (i === 7) throw new Error("The file is empty."); return `# Note ${i}\n\nBody ${i}`; } }));
    const seen: string[] = [];
    const result = await controller.importMarkdownFiles(files, { onProgress: progress => seen.push(`${progress.done + 1} / ${progress.total}`) });
    expect(most).toBe(1);
    expect(seen).toHaveLength(40); expect(seen[2]).toBe("3 / 40"); expect(seen.at(-1)).toBe("40 / 40");
    expect(result.imported).toBe(39); expect(result.failed).toEqual([{ name: "note-7.md", error: "The file is empty." }]);
    expect(result.message).toBe("Imported 39 of 40 notes · 1 failed: The file is empty.");
    // Not under today: the note is as old as its file.
    expect(controller.listHistorySessions().every(session => session.startedAt === "2026-03-04T05:06:07.000Z")).toBe(true);
    await controller.dispose();
  });

  it("reports notes that the import limits shortened", async () => {
    const { controller } = await controllerWith();
    const long = `# Long\n\n## Transcript\n\n**Ada:** ${"word ".repeat(1200)}\n`;
    const result = await controller.importMarkdownFiles([{ name: "Long.md", text: long }, { name: "Short.md", text: "# Short\n\nBody." }]);
    expect(result.truncated).toEqual([{ name: "Long.md", detail: "1 long line cut to 4,000 characters." }]);
    expect(markdownOutcomeLines(result.files)).toEqual([
      { name: "Long.md", state: "done", detail: "Imported. Shortened: 1 long line cut to 4,000 characters." },
      { name: "Short.md", state: "done", detail: "Imported" },
    ]);
    expect(result.message).toBe("Imported 2 of 2 notes. 1 note shortened by the import limits (see below).");
    await controller.dispose();
  });

  it("when imported knowledge is full the old copy stays and the card says why", async () => {
    const storage = new Map([[LEGACY_HISTORY_KEY, archive([nearlyFull(), { id: "obsidian:Plan", source: "obsidian", title: "Plan", lines: ["The earlier plan."] }])]]);
    const { controller } = await controllerWith(storage);
    const huge = `# Plan\n\n## Transcript\n\n${Array.from({ length: 400 }, (_, i) => `**Ada:** ${"A much longer plan. ".repeat(40)}${i}`).join("\n\n")}\n`;
    const result = await controller.importMarkdownFiles([{ name: "Plan.md", text: huge }, { name: "Tiny.md", text: "# Tiny\n\nFits." }]);
    expect(result.failed).toEqual([{ name: "Plan.md", error: IMPORT_STORAGE_FULL }]);
    expect(result.imported).toBe(1);
    expect(titles(controller, "obsidian:Plan")).toEqual(["The earlier plan."]);
    expect(result.message).toBe(`Imported 1 of 2 notes · 1 failed: ${IMPORT_STORAGE_FULL}`);
    expect(markdownOutcomeLines(result.files)[0]).toEqual({ name: "Plan.md", state: "failed", detail: `Failed: ${IMPORT_STORAGE_FULL}` });
    expect(controller.historySnapshot().status).toBe(result.message);
    await controller.dispose();
  });
});

/* ------------------------------------------------------------------ Omi */

describe("v0.16 Omi import through the controller", () => {
  it("labels the wearer \"You\" and unnamed voices \"Speaker 1\"; the card shows its own progress and outcome", async () => {
    const { controller } = await controllerWith();
    const states: HistoryState[] = [];
    controller.subscribeHistory(state => states.push(state));
    await controller.importOmi({ key: "omi-test", fetch: async () => Response.json([omiConversation("a")]) });
    expect(controller.openHistorySession("omi:a")!.entries.filter(entry => entry.kind === "transcript").map(entry => [entry.speaker, entry.text]))
      .toEqual([["Speaker 1", "The calibration rig ships on Friday."], ["You", "I will book the courier."]]);
    expect(states.some(state => state.omiImport.running && state.omiImport.message === "Importing Omi conversations…")).toBe(true);
    expect(controller.historySnapshot().omiImport).toEqual({ running: false, imported: 1, skipped: 0, failed: 0, message: "Import complete: 1 conversation processed. Repeated imports update existing records." });
    await controller.dispose();
  });

  it("a storage-full error reaches the card text, with counts, and the earlier copy stays", async () => {
    const storage = new Map([[LEGACY_HISTORY_KEY, archive([nearlyFull()])]]);
    const { controller } = await controllerWith(storage);
    await controller.importOmi({ key: "omi-test", fetch: async () => Response.json([omiConversation("a")]) });
    const long = Array.from({ length: 400 }, (_, i) => ({ text: "A much longer version of the standup. ".repeat(20), start: i }));
    await controller.importOmi({ key: "omi-test", fetch: async () => Response.json([omiConversation("a", { transcript_segments: long }), omiConversation("b", { transcript_segments: long })]) });
    const view = controller.historySnapshot().omiImport;
    // The message names neither "Omi" nor "conversations" in its reason: before v0.16 the card did not show it.
    expect(view).toMatchObject({ running: false, imported: 0, failed: 2 });
    expect(view.message).toBe("Import stopped: 0 conversations processed · 2 failed: Imported knowledge is full (5 MiB for Omi, notes and PDFs). Remove imported sessions or import summaries only, then try again. What was saved before stays as it was.");
    expect(controller.openHistorySession("omi:a")!.entries.filter(entry => entry.kind === "transcript")).toHaveLength(2);
    expect(controller.openHistorySession("omi:b")).toBeUndefined();
    // Any other failure also lands on the card, with what had been saved by then.
    await controller.importOmi({ key: "omi-test", fetch: async () => new Response("no", { status: 401 }) });
    expect(controller.historySnapshot().omiImport.message).toMatch(/^Omi import request failed\. Check the API key/u);
    await controller.dispose();
  });

  it("skips a conversation that Helix sent to Omi and says so on the card", async () => {
    const storage = new Map([[LEGACY_HISTORY_KEY, archive([{ id: "session_talk", source: "helix", title: "Standup a", startedAt: "2026-11-18T09:00:00.000Z", lines: ["The calibration rig ships on Friday."] }])]]);
    const { controller } = await controllerWith(storage);
    await controller.importOmi({ key: "omi-test", fetch: async () => Response.json([omiConversation("a"), omiConversation("marked", { started_at: "2026-11-17T09:00:00Z", external_data: { client_session_id: "helix-session_x" } }), omiConversation("kept", { started_at: "2026-11-16T09:00:00Z" }), { id: "odd" }]) });
    expect(controller.listHistorySessions().map(session => session.id).sort()).toEqual(["omi:kept", "session_talk"]);
    expect(controller.historySnapshot().omiImport).toMatchObject({ imported: 1, skipped: 3, failed: 0,
      message: "Import complete: 1 conversation processed · 1 skipped (Omi returned them in a form Helix cannot read) · 2 skipped (sent to Omi by Helix, already in History). Repeated imports update existing records." });
    await controller.dispose();
  });

  it("\"Summaries only\" is saved with the auto-import settings and used by manual and automatic imports", async () => {
    const { storage, controller } = await controllerWith();
    const urls: string[] = [];
    controller.omiImportFetch = async url => { urls.push(url); return Response.json([omiConversation("a")]); };
    controller.configureAutoImport(() => "omi_dev_secret", 3_600_000);
    expect(controller.autoImportView().summariesOnly).toBeUndefined();
    await controller.setOmiSummariesOnly(true);
    expect(JSON.parse(storage.get(OMI_AUTO_IMPORT_STORAGE_KEY)!)).toMatchObject({ summariesOnly: true });
    expect(await controller.setAutoImportEnabled(true)).toBe("imported");
    expect(new URL(urls[0]!).searchParams.get("include_transcript")).toBe("false");
    const entries = controller.openHistorySession("omi:a")!.entries;
    expect(entries.filter(entry => entry.kind === "transcript")).toEqual([]);
    expect(controller.openHistorySession("omi:a")!.session).toMatchObject({ summary: ["The calibration rig ships on Friday."], keyFacts: ["Book the courier"] });
    await controller.dispose();
    // The setting survives a restart; an explicit request can still ask for transcripts.
    const restarted = await controllerWith(storage);
    expect(restarted.controller.autoImportView()).toMatchObject({ enabled: true, summariesOnly: true });
    await restarted.controller.importOmi({ key: "omi-test", summariesOnly: false, fetch: async url => { urls.push(url); return Response.json([omiConversation("a")]); } });
    expect(new URL(urls.at(-1)!).searchParams.get("include_transcript")).toBe("true");
    expect(restarted.controller.openHistorySession("omi:a")!.entries.filter(entry => entry.kind === "transcript")).toHaveLength(2);
    await restarted.controller.setOmiSummariesOnly(false);
    expect(restarted.controller.autoImportView().summariesOnly).toBeUndefined();
    await restarted.controller.dispose();
  });

  it("an automatic import that could not save records the reason", async () => {
    const storage = new Map([[LEGACY_HISTORY_KEY, archive([nearlyFull()])]]);
    const { controller } = await controllerWith(storage);
    const long = Array.from({ length: 400 }, (_, i) => ({ text: "A much longer version of the standup. ".repeat(20), start: i }));
    controller.omiImportFetch = async () => Response.json([omiConversation("a", { transcript_segments: long })]);
    controller.configureAutoImport(() => "omi_dev_secret", 3_600_000);
    expect(await controller.setAutoImportEnabled(true)).toBe("failed");
    expect(controller.autoImportView().lastError).toMatch(/1 failed: Imported knowledge is full/u);
    await controller.dispose();
  });
});

/* ------------------------------------------------------------------ card text and file reading */

describe("v0.16 import card text", () => {
  it("Omi: counts imported / skipped / failed with the reason for each", () => {
    expect(omiImportText({ imported: 10, pages: 0, skipped: 2 }, false)).toBe("Imported 10 conversations · 0 pages · 2 skipped");
    expect(omiImportText({ imported: 26, pages: 2 }, true)).toBe("Import complete: 26 conversations processed. Repeated imports update existing records.");
    expect(omiImportText({ imported: 3, pages: 1, skipped: 4, skippedHelix: 3 }, true))
      .toBe("Import complete: 3 conversations processed · 1 skipped (Omi returned them in a form Helix cannot read) · 3 skipped (sent to Omi by Helix, already in History). Repeated imports update existing records.");
    expect(omiImportText({ imported: 12, pages: 0, failed: 1, failReason: IMPORT_STORAGE_FULL, storageFull: true }, true))
      .toBe(`Import stopped: 12 conversations processed · 1 failed: ${IMPORT_STORAGE_FULL.replace(/\.$/u, "")}. What was saved before stays as it was.`);
    expect(omiImportErrorText("Could not reach Omi. Import is incomplete; earlier saved records remain available.", { imported: 25, pages: 1 }))
      .toBe("Could not reach Omi. Import is incomplete; earlier saved records remain available. 25 conversations had been saved before that.");
    expect(omiImportErrorText("Enter a valid Omi API key before importing.")).toBe("Enter a valid Omi API key before importing.");
  });

  it("notes: one row per file even when names repeat, and the main reason in the summary", () => {
    const files = [
      { name: "Untitled.md", state: "imported" as const },
      { name: "Untitled.md", state: "failed" as const, detail: "Too large (2.4 MB; the limit is 1.9 MB)." },
      { name: "a.md", state: "failed" as const, detail: IMPORT_STORAGE_FULL }, { name: "b.md", state: "failed" as const, detail: IMPORT_STORAGE_FULL },
      { name: "c.md", state: "skipped" as const, detail: "The same note is in this import twice" },
    ];
    expect(markdownOutcomeLines(files).map(line => [line.name, line.state, line.detail.split(":")[0]])).toEqual([["Untitled.md", "done", "Imported"], ["Untitled.md", "failed", "Failed"], ["a.md", "failed", "Failed"], ["b.md", "failed", "Failed"], ["c.md", "failed", "Skipped"]]);
    expect(markdownImportText(files)).toBe(`Imported 1 of 5 notes · 1 skipped: The same note is in this import twice · 3 failed: ${IMPORT_STORAGE_FULL.replace(/\.$/u, "")} (and other reasons, see below).`);
    expect(markdownImportText([{ name: "a.md", state: "imported" }])).toBe("Imported 1 of 1 note.");
  });

  it("reads picked files one after another, reporting each", async () => {
    let open = 0, most = 0;
    const file = (name: string, text: string, size = text.length) => ({ name, size, text: async () => { most = Math.max(most, ++open); await new Promise(resolve => setTimeout(resolve, 0)); open--; return text; } });
    const seen: string[] = [];
    const results = await readTextFiles([file("a.md", "# A"), file("big.md", "x", 3_000_000), file("empty.md", "  "), file("b.md", "# B")], 2_000_000, (done, total, name) => seen.push(`${done + 1} / ${total} ${name}`));
    expect(most).toBe(1);
    expect(seen).toEqual(["1 / 4 a.md", "2 / 4 big.md", "3 / 4 empty.md", "4 / 4 b.md"]);
    expect(results.map(result => result.ok)).toEqual([true, false, false, true]);
    await expect(readTextFile(file("bin.md", "ab\u0000cd"))).rejects.toThrow("Not a text file.");
  });
});
