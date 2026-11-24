import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HistoryEntry, HistorySession, QuestionDetectedEvent, Speaker, TranscriptFinalEvent, TranscriptPartialEvent } from "@helix/conversation-sdk";
import { ConversationPresentation, feedBlocks, paragraphText, speakerName, type FeedItem } from "../src/presentation";
import { cleanLineText, cleanTranscript, historySpeaker, joinConcept, sessionCard, sessionDayKey, sessionKnowledge, sessionTitle, splitConcept, transcriptText } from "../src/history-panel";
import { knowledgeMapSvg, omiExportSummary, sourceOverview, zipFiles } from "../src/knowledge-panel";
import { askAboutPrompt, mergePeople } from "../src/people-panel";
import { defaultTabForHudView, shouldFollowHud } from "../src/tabs";
import { gestureHelpLines, gestureStrip, tabForHud } from "../src/ui";
import { GESTURE_HELP } from "../src/glasses-hud";
import { DEFAULT_CONFIG, copilotSettingsFromConfig, normalizePluginConfig } from "../src/config";

const uiSource = readFileSync(new URL("../src/ui.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const ctx = (label: string, role: Speaker["role"]) => ({
  prompt: { id: "p", version: "1" }, endpoint: { id: "openai-direct", url: "https://api.openai.com/v1/responses", provider: "openai", model: "gpt-6.1-terra" },
  speaker: { label, role }, latencyMs: { totalMs: 10 },
});
const base = { protocolVersion: "2.1" as const, sessionId: "s", occurredAt: "2026-11-08T20:00:00.000Z" };
const final = (id: string, label: string, role: Speaker["role"], text: string) =>
  ({ ...base, type: "transcript.final", eventId: `e-${id}`, transcriptId: id, text, context: ctx(label, role) }) as TranscriptFinalEvent;
const partial = (label: string, role: Speaker["role"], text: string) =>
  ({ ...base, type: "transcript.partial", eventId: "e-p", transcriptId: "p", revision: 1, text, context: ctx(label, role) }) as TranscriptPartialEvent;
const question = (id: string, label: string, role: Speaker["role"], text: string, trigger = "question") =>
  ({ ...base, type: "question.detected", eventId: `e-${id}`, questionId: id, text, confidence: 0.9, context: { ...ctx(label, role), trigger } }) as unknown as QuestionDetectedEvent;

function live(): ConversationPresentation { const p = new ConversationPresentation(); p.setStatus("listening"); return p; }

describe("v0.8 continuous transcript (Answers tab)", () => {
  it("maps speaker roles to You / Them / Speaker and keeps real names for unknown roles", () => {
    expect(speakerName("You", "self")).toBe("You");
    expect(speakerName("Other speaker", "other")).toBe("Them");
    expect(speakerName("G2 conversation", "unknown")).toBe("Speaker");
    expect(speakerName("Priya", "unknown")).toBe("Priya");
    expect(speakerName("Other speaker · hearing", undefined)).toBe("Speaker");
  });

  it("merges same-speaker finals into one paragraph with the live partial appended inline", () => {
    const p = live();
    p.apply(final("t1", "Other speaker", "other", "We're moving to CDTF."));
    p.apply(final("t2", "Other speaker", "other", "That way fusion runs first,"));
    p.apply(partial("Other speaker", "other", "and lanes stay"));
    const blocks = feedBlocks(p.snapshot().feed);
    expect(blocks).toHaveLength(1);
    const [paragraph] = blocks;
    expect(paragraph).toMatchObject({ type: "paragraph", speaker: "Them", role: "other", id: "para:t1" });
    if (paragraph?.type !== "paragraph") throw new Error("expected a paragraph");
    expect(paragraphText(paragraph)).toBe("We're moving to CDTF. That way fusion runs first,");
    expect(paragraph.partial?.body).toBe("and lanes stay");
    // A final replaces the partial and stays in the same paragraph (no visual break).
    p.apply(final("t3", "Other speaker", "other", "and lanes stay consistent."));
    const after = feedBlocks(p.snapshot().feed);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: "para:t1" });
    expect(after[0]?.type === "paragraph" && after[0].partial).toBeFalsy();
  });

  it("starts a new bubble only on a speaker change or a question/answer card; side cards follow the paragraph", () => {
    const p = live();
    p.apply(final("t1", "Other speaker", "other", "One."));
    p.applyInsight({ id: "i1", sessionId: "s", transcriptId: "t1", term: "CDTF", explanation: "Fusion.", createdAt: base.occurredAt });
    p.apply(final("t2", "Other speaker", "other", "Two."));
    p.apply(final("t3", "You", "self", "Three?"));
    p.apply(question("q1", "Other speaker", "other", "How would you validate it?"));
    p.apply(final("t4", "Other speaker", "other", "Four."));
    p.apply(partial("You", "self", "fi"));
    const blocks = feedBlocks(p.snapshot().feed);
    expect(blocks.map(block => block.type === "paragraph" ? `${block.speaker}:${block.segments.map(s => s.id).join("+")}${block.partial ? "+live" : ""}` : `card:${block.id}`))
      .toEqual(["Them:t1+t2", "card:i1", "You:t3", "card:q1", "Them:t4", "You:+live"]);
  });

  it("labels question kinds: others -> They asked, the wearer -> You asked, explicit requests unchanged", () => {
    const p = live();
    p.apply(question("q1", "Other speaker", "other", "When does it ship?"));
    p.apply(question("q2", "You", "self", "What's the lead time?"));
    p.apply(question("q3", "You", "self", "Typed question", "manual"));
    const items = p.snapshot().feed.filter(item => item.kind === "question");
    expect(items.map(item => [item.questionKind, item.label])).toEqual([["they", "They asked"], ["you", "You asked"], ["request", "You · manual question"]]);
    expect(uiSource).toContain('item.questionKind === "you"');
    expect(uiSource).toContain('"Not auto-answered"');
  });

  it("renders paragraphs with stable per-final spans and a blinking inline caret for the partial", () => {
    expect(uiSource).toContain("feedBlocks(snapshot.feed)");
    expect(uiSource).toContain('el("span", "seg seg-live")');
    expect(uiSource).toMatch(/dataset\.transcriptId = segment\.id/u);
    expect(styles).toMatch(/\.seg-live::after\s*\{[^}]*animation: blink/su);
    expect(styles).toMatch(/\.message-paragraph\.role-self\s*\{[^}]*justify-self: end/su);
  });
});

describe("v0.8 People presentation", () => {
  const person = (over: Partial<Parameters<ConversationPresentation["applyPerson"]>[0]> = {}) => ({
    id: "p1", name: "Priya Raman", role: "Perception lead", context: "Owns CDTF.", mentions: 2, firstSeen: "2026-11-08T20:00:00Z", lastSeen: "2026-11-08T20:01:00Z", ...over,
  });
  it("upserts people by normalized name, keeps the larger mention count and counts new people as unseen", () => {
    const p = live();
    p.applyPerson(person());
    p.applyPerson(person({ id: "other-id", name: "  priya   RAMAN ", mentions: 1, context: "Now leads the eval.", lastSeen: "2026-11-08T20:05:00Z" }));
    p.applyPerson(person({ id: "p2", name: "Kan", role: "Procurement", mentions: 1 }));
    p.applyPerson(person({ id: "p3", name: "  " }));
    const people = p.snapshot().people;
    expect(people).toHaveLength(2);
    expect(people[0]).toMatchObject({ id: "p1", name: "Priya Raman", mentions: 2, context: "Now leads the eval.", lastSeen: "2026-11-08T20:05:00Z", firstSeen: "2026-11-08T20:00:00Z" });
    expect(p.snapshot().unseen.people).toBe(2);
    p.reset();
    expect(p.snapshot().people).toEqual([]);
  });

  it("merges live people with history aggregates without double counting the live session", () => {
    const merged = mergePeople(
      [{ ...person(), mentions: 3 }],
      [{ name: "priya raman", roles: ["Perception lead"], sessionIds: ["live", "old"], mentions: 5, lastSeen: "2026-11-07T00:00:00Z" },
        { name: "Marco", roles: [], sessionIds: ["old"], mentions: 1, lastSeen: "2026-11-01T00:00:00Z" }],
      "live",
    );
    expect(merged.map(item => [item.name, item.live, item.mentions, item.sessionIds])).toEqual([
      ["Priya Raman", true, 5, ["live", "old"]],
      ["Marco", false, 1, ["old"]],
    ]);
    expect(askAboutPrompt("Kan")).toMatch(/^Using the whole conversation so far, what do we know about Kan\?/u);
  });
});

const session = (over: Partial<HistorySession> = {}): HistorySession => ({ id: "session_a", source: "helix", title: "Helix · 2026-11-08T20:00:00.000Z", startedAt: "2026-11-08T20:00:00.000Z", updatedAt: "2026-11-08T20:30:00.000Z", ...over });
const entry = (index: number, kind: HistoryEntry["kind"], speaker: string, text: string, metadata?: Record<string, string>): HistoryEntry =>
  ({ id: `session_a:e${index}`, sessionId: "session_a", kind, speaker, text, occurredAt: new Date(Date.parse("2026-11-08T20:00:00.000Z") + index * 60_000).toISOString(), ...(metadata ? { metadata } : {}) });

describe("v0.8 History cleanup", () => {
  const meta = { model: "gpt-6.1-terra", provider: "openai", endpoint: "https://api.openai.com/v1/responses", latencyMs: "2412", promptVersion: "1" };
  const entries = [
    entry(0, "transcript", "Other speaker", "We're moving to CDTF", meta),
    entry(1, "transcript", "Other speaker", "We're moving to CDTF for the mapping head.", meta),
    entry(2, "transcript", "Other speaker", "See https://wiki.example.com/cdtf?x=1 for details.", meta),
    entry(3, "transcript", "You", "What's the lead time on Thor?", meta),
    entry(4, "question", "Other speaker", "What's the lead time on Thor?", meta),
    entry(5, "question", "Whole conversation", "Using the whole captured conversation, answer {\"scope\":\"global\",\"maxChars\":12000}", meta),
    entry(6, "answer", "Helix", "Dev kits ship in 6–10 weeks (https://arrow.com/thor) model: gpt-6.1-terra latencyMs: 2412 [1]", meta),
    entry(7, "fact-check", "Helix", "Thor ships in 8 weeks\nDistributors list 6–10 weeks. https://nvidia.com", { status: "supported" }),
    entry(8, "answer", "Omi summary", "Vendor overview that must not appear as a line.", { origin: "omi-summary" }),
    entry(9, "question", "You", "Typed question to Helix", meta),
  ];

  it("produces Speaker: text lines without URLs, endpoints, model/provider/latency metadata, JSON or duplicate partials", () => {
    const lines = cleanTranscript(entries);
    expect(lines.map(line => [line.kind, line.speaker, line.text])).toEqual([
      ["speech", "Them", "We're moving to CDTF for the mapping head. See for details."],
      ["speech", "You", "What's the lead time on Thor?"],
      // v0.16: the tap is no line of its own; the answer carries the "you asked" mark (asserted below).
      ["helix", "Helix", "Dev kits ship in 6–10 weeks"],
      ["check", "Check", "Thor ships in 8 weeks (supported): Distributors list 6–10 weeks."],
      ["request", "You", "Typed question to Helix"],
    ]);
    const text = transcriptText(lines);
    expect(text).not.toMatch(/https?:|www\.|api\.openai|gpt-6|latency|provider|endpoint|[{}]|\[1\]/iu);
    expect(lines[2]!.asked).toBe("whole");
    expect(text.split("\n")[2]).toBe("    Helix (you asked · whole conversation): Dev kits ship in 6–10 weeks");
    expect(text).not.toMatch(/asked Helix about/u);
    expect(lines[0]!.entryIds).toEqual(["session_a:e0", "session_a:e1", "session_a:e2"]);
  });

  it("strips metadata patterns but keeps ordinary speech", () => {
    expect(cleanLineText("The model: we picked ResNet because latency matters.")).toBe("The model: we picked ResNet because latency matters.");
    expect(cleanLineText("ok model=gpt-6.1-terra provider: openai latency_ms: 120 (240 ms) [link](https://x.io/a) done")).toBe("ok link done");
    expect(historySpeaker("Speaker 0")).toBe("Speaker 0");
    expect(historySpeaker("Other speaker")).toBe("Them");
    expect(historySpeaker("G2 conversation")).toBe("Speaker");
  });

  it("reads session knowledge and builds list cards with title, date, duration, summary, people and counts", () => {
    const knowledge = sessionKnowledge(session({ summary: ["Moves to CDTF."], keyFacts: ["8 weeks"], people: [{ name: "Priya", role: "Lead", mentions: 3 }, { name: "priya" }], concepts: ["CDTF: depth-aware fusion", "BEV"], tags: ["perception"] }), entries);
    expect(knowledge).toEqual({ summary: ["Moves to CDTF."], keyFacts: ["8 weeks"], people: [{ name: "Priya", role: "Lead", mentions: 3 }],
      concepts: [{ term: "CDTF", explanation: "depth-aware fusion" }, { term: "BEV", explanation: "" }], tags: ["perception"] });
    expect(splitConcept(joinConcept("NVMe ring buffer", "Overwrites the oldest data."))).toEqual({ term: "NVMe ring buffer", explanation: "Overwrites the oldest data." });
    const card = sessionCard(session({ people: [{ name: "Priya" }, { name: "Kan" }] }), entries.filter(item => item.speaker !== "Omi summary"));
    expect(card).toMatchObject({ source: "helix", duration: "9 min", people: ["Priya", "Kan"], lines: 2, answers: 1 });
    // v0.13: a placeholder title becomes a title derived on the phone (topic words), never the first utterance;
    // the summary line says it is not an AI summary; the counts say what they count.
    expect(card.title).toBe("About CDTF");
    expect(card.summary).toBe("Not summarised yet · mentions CDTF. Opens with “We're moving to CDTF for the mapping head.”");
    expect(card).toMatchObject({ origin: "fallback", counts: "2 speaker turns · 1 Helix answer", day: sessionDayKey("2026-11-08T20:00:00.000Z") });
    expect(sessionTitle(session({ title: "Kickoff https://x.io/a" }))).toBe("Kickoff");
    // Omi overviews stand in for a missing summary.
    expect(sessionKnowledge(session({ source: "omi" }), entries).summary).toEqual(["Vendor overview that must not appear as a line."]);
  });
});

describe("v0.8 Knowledge model", () => {
  const sessions: HistorySession[] = [
    session({ id: "h", title: "CDTF <sync>", people: [{ name: "Priya" }], concepts: ["CDTF: fusion"], updatedAt: "2026-11-08T21:00:00Z" }),
    session({ id: "o", source: "omi", title: "1:1 with Kan", people: [{ name: "Kan" }], updatedAt: "2026-11-07T21:00:00Z" }),
    session({ id: "b", source: "obsidian", title: "Edge logger", concepts: ["CDTF"], updatedAt: "2026-11-06T21:00:00Z" }),
  ];
  it("draws a pixel knowledge map: sources -> sessions -> people/concepts, escaped and theme-classed", () => {
    const svg = knowledgeMapSvg({ stats: { helix: { sessions: 1, entries: 4 }, omi: { sessions: 1, entries: 2 }, obsidian: { sessions: 1, entries: 1 } }, sessions,
      people: [{ name: "Priya", roles: [], sessionIds: ["h"], mentions: 2, lastSeen: "" }, { name: "Kan", roles: [], sessionIds: ["o"], mentions: 1, lastSeen: "" }] });
    expect(svg).toMatch(/^<svg class="knowledge-map"[^>]*shape-rendering="crispEdges" role="img" aria-label="Knowledge map: Omi 1 sessions, Obsidian 1 sessions, Helix 1 sessions; 3 recent sessions; 2 people; 1 concepts"/u);
    expect(svg).toContain("CDTF &lt;sync&gt;");
    expect(svg).not.toContain("<sync>");
    for (const tone of ["km-helix", "km-omi", "km-obsidian", "km-person", "km-concept"]) expect(svg).toContain(tone);
    // Source->session edges (3) + person edges (2) + concept edges (CDTF in 2 sessions).
    expect(svg.match(/class="km-edge/gu)).toHaveLength(7);
    expect(sourceOverview(undefined).map(item => [item.source, item.sessions])).toEqual([["omi", 0], ["obsidian", 0], ["helix", 0]]);
  });

  it("zips vault files (store) with valid local headers and an end record", () => {
    const zip = zipFiles([{ path: "Helix/a.md", content: "# A\n" }, { path: "Helix/b.md", content: "# Bé\n" }]);
    const view = new DataView(zip.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);
    expect(new TextDecoder().decode(zip.slice(30, 40))).toBe("Helix/a.md");
  });

  it("summarizes Omi export results", () => {
    expect(omiExportSummary([
      { status: "exported", conversationId: "c", endpoint: "from-segments", segments: 3, discarded: false },
      { status: "skipped", reason: "This session came from Omi; exporting it back would duplicate it." },
      { status: "failed", code: "rate-limited", message: "Omi's write limit was reached." },
    ])).toEqual({ exported: 1, message: "Sent 1 of 3 sessions to Omi. 1 skipped: This session came from Omi; exporting it back would duplicate it. 1 failed: Omi's write limit was reached." });
  });
});

describe("v0.8 glasses mirror follow + gesture help", () => {
  const hud = (over: Partial<{ view: string; updatedAt: number; lastGesture: string }> = {}) => ({ view: "qa", updatedAt: 2000, lastGesture: "down", ...over });
  it("follows a glasses gesture only when it changed the view/gesture, is mapped, idle for 8 s and on another tab", () => {
    const input = { hud: hud(), previous: { view: "live", lastGesture: "up" }, lastTouchAt: 0, now: 20_000, currentTab: "answers" as const, target: tabForHud("qa") };
    expect(input.target).toBe("qa");
    expect(shouldFollowHud(input)).toBe(true);
    expect(shouldFollowHud({ ...input, previous: undefined })).toBe(true);
    expect(shouldFollowHud({ ...input, lastTouchAt: 15_000 })).toBe(false); // touched 5 s ago
    expect(shouldFollowHud({ ...input, previous: { view: "qa", lastGesture: "down" } })).toBe(false); // caption-only update
    expect(shouldFollowHud({ ...input, hud: { view: "qa", updatedAt: 3000 } })).toBe(false); // not a gesture
    expect(shouldFollowHud({ ...input, hud: hud({ lastGesture: "phone:qa" }) })).toBe(false); // phone-initiated
    expect(shouldFollowHud({ ...input, hud: hud({ lastGesture: "repush" }) })).toBe(false); // lifecycle
    expect(shouldFollowHud({ ...input, currentTab: "qa" })).toBe(false);
    expect(shouldFollowHud({ ...input, target: undefined })).toBe(false);
    expect(shouldFollowHud({ ...input, hud: hud({ view: "checks", lastGesture: "menu:verify" }), target: tabForHud("checks") })).toBe(true);
    expect(defaultTabForHudView("live")).toBe("answers");
    expect(defaultTabForHudView("checks")).toBe("checks");
    expect(defaultTabForHudView("menu")).toBeUndefined();
    expect(tabForHud("summary")).toBe("summary");
    expect(uiSource).toContain("idleMs: FOLLOW_IDLE_MS");
    expect(uiSource).toContain('import.meta.glob<GlassesMirrorModule>("./glasses-mirror.ts", { eager: true })');
  });

  it("shows GESTURE_HELP split into rows without breaking parenthesised lists", () => {
    const lines = gestureHelpLines(GESTURE_HELP);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) expect((line.match(/\(/gu) ?? []).length).toBe((line.match(/\)/gu) ?? []).length);
    expect(lines.some(line => /^double/iu.test(line) && /menu/iu.test(line))).toBe(true);
    expect(gestureHelpLines("Tap: a (x · y) · Hold: b")).toEqual(["Tap: a (x · y)", "Hold: b"]);
    expect(gestureHelpLines([{ gesture: "Tap", action: "select" }, ["Hold", "talk"]])).toEqual(["Tap: select", "Hold: talk"]);
    expect(gestureStrip(["Tap: context action (next page)", "Double-tap: glasses menu (answer)"])).toBe("Tap context action · Double-tap glasses menu");
  });
});

describe("v0.8 setup toggles", () => {
  it("sends claims/people opt-outs to the copilot only when switched off", () => {
    expect(copilotSettingsFromConfig(DEFAULT_CONFIG)).not.toHaveProperty("claims");
    expect(copilotSettingsFromConfig({ ...DEFAULT_CONFIG, copilotClaims: false, copilotPeople: false })).toMatchObject({ claims: false, people: false });
    expect(normalizePluginConfig({ copilotPeople: false })).toMatchObject({ copilotClaims: true, copilotPeople: false });
    expect(uiSource).toContain('toggle("copilot-claims"');
    expect(uiSource).toContain('toggle("copilot-people"');
  });
});

describe("v0.8 tab structure", () => {
  it("feed items without v0.8 fields still group by label", () => {
    const legacy: FeedItem[] = [{ id: "a", kind: "transcript", label: "Priya · transcript", body: "One." }, { id: "b", kind: "transcript", label: "Priya · transcript", body: "Two." }];
    expect(feedBlocks(legacy)).toHaveLength(1);
  });
});
