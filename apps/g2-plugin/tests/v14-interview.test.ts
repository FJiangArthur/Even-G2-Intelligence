import { readFileSync } from "node:fs";
import {
  StartUpPageCreateResult,
  type CreateStartUpPageContainer, type RebuildPageContainer, type TextContainerUpgrade,
} from "@evenrealities/even_hub_sdk";
import { MODE_PROFILES, PICKER_MODES, type CopilotSuggestion, type GatewayEvent } from "@helix/conversation-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnswerPager, CUT_OFF_MARK, MAX_WAITING_AGE_MS, STREAM_STALL_MS, pageReadingMs } from "../src/answer-pager";
import { BODY_LINES, GlassesHud, HUD_LINE_WIDTH, NOTICE_MS, SUGGESTION_CUE_GAP_MS, SUGGESTION_CUE_MS, hudTextWidth } from "../src/glasses-hud";
import type { GlassesRenderBridge } from "../src/glasses-renderer";
import { modeIcon } from "../src/pixel-art";
import { ConversationPresentation } from "../src/presentation";
import { CUT_OFF_NOTE, companionMarkup, suggestionGroups, suggestionWhyText } from "../src/ui";

const uiSource = readFileSync(new URL("../src/ui.ts", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

class Bridge implements GlassesRenderBridge {
  public async createStartUpPageContainer(_container: CreateStartUpPageContainer) { return StartUpPageCreateResult.success; }
  public async rebuildPageContainer(_container: RebuildPageContainer) { return true; }
  public async textContainerUpgrade(_container: TextContainerUpgrade) { return true; }
}

type Role = "self" | "other" | "unknown";
const ctx = (label: string, role: Role = "unknown", trigger?: string) => ({
  prompt: { id: "p", version: "1" }, endpoint: { id: "openai-direct", url: "", provider: "openai", model: "m" },
  speaker: { label, role }, latencyMs: { totalMs: 900 }, ...(trigger ? { trigger } : {}),
});
let seq = 0;
const ev = (event: object) => ({ protocolVersion: "2.1", sessionId: "s", occurredAt: "2026-11-22T18:00:00.000Z", eventId: `v14-${++seq}`, ...event }) as unknown as GatewayEvent;
const question = (id: string, text: string, role: Role = "other") => ev({ type: "question.detected", questionId: id, text, confidence: 0.9, context: ctx(role === "self" ? "You" : "Other speaker", role, "question") });
const delta = (answerId: string, questionId: string, text: string) => ev({ type: "answer.delta", answerId, questionId, delta: text, context: ctx("Helix", "unknown", "question") });
const completed = (answerId: string, questionId: string, text: string, partial?: boolean) =>
  ev({ type: "answer.completed", answerId, questionId, text, ...(partial ? { partial } : {}), context: ctx("Helix", "unknown", "question") });
const final = (id: string, text: string) => ev({ type: "transcript.final", transcriptId: id, text, context: ctx("Other speaker", "other") });
const problem = (message: string, fatal = false) => ev({ type: "error", code: fatal ? "provider-authentication" : "conversation-busy", message, retryable: !fatal, fatal });
const failure = (code: string, message: string) => ev({ type: "error", code, message, retryable: true, fatal: false });
const at = "2026-11-22T18:00:00.000Z";
const suggestion = (id: string, text: string, why = "", extra: object = {}) => ({ id, question: text, why, createdAt: at, ...extra }) as CopilotSuggestion;

async function mount(options: ConstructorParameters<typeof GlassesHud>[1] = {}) {
  const hud = new GlassesHud(new Bridge(), { tickMs: 0, writeGapMs: 0, ...options });
  const presentation = new ConversationPresentation();
  presentation.subscribe(snapshot => hud.render(snapshot.glasses, snapshot));
  await hud.initialize();
  return { hud, presentation };
}
/** Connected and past the "● listening" status cue: the steady blank ambient display. */
async function listening(mode = "interviewer", options: ConstructorParameters<typeof GlassesHud>[1] = {}) {
  const mounted = await mount(options);
  mounted.presentation.setMode(mode);
  mounted.presentation.setStatus("listening");
  await vi.advanceTimersByTimeAsync(6000);
  return mounted;
}
const blank = (text: string) => text.trim() === "";

afterEach(() => { vi.useRealTimers(); });

describe("v0.14 answer pager: answers back to back", () => {
  it("keeps the current answer for its first page's reading time, marks one waiting, then shows the next", () => {
    vi.useFakeTimers();
    const shown: string[] = [];
    const pager = new AnswerPager(text => shown.push(text));
    pager.update({ id: "a1", text: "First answer.", streaming: false }, 0);
    expect(pager.text).toBe("First answer.");
    vi.advanceTimersByTime(1000);
    pager.update({ id: "a2", text: "Second", streaming: true }, 1);
    expect(pager.text).toBe("First answer.");
    expect(pager.key).toBe("a1:0");
    expect(pager.waiting).toBe(1);
    // The waiting answer keeps growing off screen.
    pager.update({ id: "a2", text: "Second answer.", streaming: false }, 1);
    expect(pager.text).toBe("First answer.");
    vi.advanceTimersByTime(pageReadingMs(13) - 1000 - 1);
    expect(pager.text).toBe("First answer.");
    vi.advanceTimersByTime(1);
    expect(pager.text).toBe("Second answer.");
    expect(pager.key).toBe("a2:1");
    expect(pager.waiting).toBe(0);
    // It then lives its own normal life: 8 s after the last page it hides.
    vi.advanceTimersByTime(8000);
    expect(pager.text).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaces at once after the first page had its time, and clears everything at once for a manual ask", () => {
    vi.useFakeTimers();
    const pager = new AnswerPager(() => undefined);
    pager.update({ id: "a1", text: "First answer.", streaming: false }, 0);
    vi.advanceTimersByTime(3000);
    pager.update({ id: "a2", text: "Second answer.", streaming: false }, 1);
    expect(pager.text).toBe("Second answer.");
    pager.update({ id: "a3", text: "Third answer.", streaming: false }, 2);
    expect(pager.waiting).toBe(1);
    // A manual ask retires the answer: the display and the waiting answer go immediately.
    pager.update(undefined, 3);
    expect(pager.text).toBe("");
    expect(pager.waiting).toBe(0);
    pager.update({ id: "m1", text: "Manual answer.", streaming: false }, 3);
    expect(pager.text).toBe("Manual answer.");
    vi.advanceTimersByTime(60_000);
    expect(pager.text).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("moves to the waiting answer when the current one is dismissed or expires, and keeps at most two waiting", () => {
    vi.useFakeTimers();
    const pager = new AnswerPager(() => undefined);
    pager.update({ id: "a1", text: "One.", streaming: false }, 0);
    pager.update({ id: "a2", text: "Two.", streaming: false }, 1);
    pager.update({ id: "a3", text: "Three.", streaming: false }, 2);
    pager.update({ id: "a4", text: "Four.", streaming: false }, 3);
    expect(pager.waiting).toBe(2);
    pager.dismiss();
    expect(pager.text).toBe("Three."); // a2, the oldest waiting, was dropped
    expect(pager.waiting).toBe(1);
    vi.advanceTimersByTime(3000);
    expect(pager.text).toBe("Four.");
    pager.dismiss();
    expect(pager.text).toBe("");
  });

  it("marks a cut-off answer at its end and stops waiting for a stream that stalled", () => {
    vi.useFakeTimers();
    const pager = new AnswerPager(() => undefined);
    pager.update({ id: "a1", text: "The lead time is twelve ", streaming: true }, 0);
    expect(pager.isCutOff).toBe(false);
    pager.update({ id: "a1", text: "The lead time is twelve", streaming: false, partial: true }, 0);
    expect(pager.text).toBe(`The lead time is twelve${CUT_OFF_MARK}`);
    expect(pager.isCutOff).toBe(true);
    vi.advanceTimersByTime(8000);
    expect(pager.text).toBe("");
    // A stream that stops without a completion does not hold the display forever.
    pager.update({ id: "a2", text: "Still going", streaming: true }, 1);
    vi.advanceTimersByTime(STREAM_STALL_MS - 1);
    expect(pager.isStreaming).toBe(true);
    vi.advanceTimersByTime(1);
    expect(pager.isStreaming).toBe(false);
    expect(pager.isCutOff).toBe(true);
    vi.advanceTimersByTime(8000);
    expect(pager.text).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops a waiting answer that is older than the age limit instead of showing it late", () => {
    vi.useFakeTimers();
    const pager = new AnswerPager(() => undefined);
    const long = "Lead time detail. ".repeat(160);
    pager.update({ id: "a1", text: long, streaming: false }, 0);
    expect(pager.pageCount).toBeGreaterThan(3);
    vi.advanceTimersByTime(1000);
    pager.update({ id: "a2", text: "Second answer.", streaming: false }, 1);
    expect(pager.waiting).toBe(1);
    // The wearer keeps paging through the first answer for longer than the age limit.
    for (let elapsed = 0; elapsed <= MAX_WAITING_AGE_MS; elapsed += 2000) {
      expect(pager.next() || pager.previous()).toBe(true);
      vi.advanceTimersByTime(2000);
      expect(pager.key).toBe("a1:0");
    }
    expect(pager.waiting).toBe(0); // too old to announce
    pager.dismiss();
    expect(pager.text).toBe("");
    // The presentation still holds that answer and renders it again: it stays off the glasses.
    pager.update({ id: "a2", text: "Second answer.", streaming: false }, 1);
    expect(pager.text).toBe("");
    // A newer answer shows normally.
    pager.update({ id: "a3", text: "Third answer.", streaming: false }, 2);
    expect(pager.text).toBe("Third answer.");
    vi.advanceTimersByTime(8000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("brings the waiting answer once the wearer stops paging, without waiting for the rest of the current one", () => {
    vi.useFakeTimers();
    const pager = new AnswerPager(() => undefined);
    pager.update({ id: "a1", text: "Lead time detail. ".repeat(160), streaming: false }, 0);
    expect(pager.pageCount).toBeGreaterThan(3);
    vi.advanceTimersByTime(1000);
    pager.update({ id: "a2", text: "Second answer.", streaming: false }, 1);
    expect(pager.next()).toBe(true); // reading on: the waiting answer does not cut in on the gesture
    expect(pager.pageIndex).toBe(1);
    const reading = pageReadingMs([...pager.text.trim()].length);
    vi.advanceTimersByTime(reading - 1);
    expect(pager.key).toBe("a1:0");
    expect(pager.pageIndex).toBe(1);
    vi.advanceTimersByTime(1);
    expect(pager.text).toBe("Second answer.");
    expect(pager.waiting).toBe(0);
    vi.advanceTimersByTime(8000);
    expect(pager.text).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("v0.14 presentation: errors and cut-off answers", () => {
  it("keeps the glasses answer through a transient error and shows it as a notice", () => {
    const presentation = new ConversationPresentation();
    presentation.setStatus("listening");
    presentation.apply(question("q1", "How long is the lead time?"));
    presentation.apply(completed("a1", "q1", "Twelve to sixteen weeks."));
    presentation.apply(problem("Helix is catching up. Pause before speaking again."));
    const snapshot = presentation.snapshot();
    expect(snapshot.status).toBe("listening");
    expect(snapshot.glasses.answer?.text).toBe("Twelve to sixteen weeks.");
    expect(snapshot.glasses.error).toBeUndefined();
    expect(snapshot.glasses.notice?.text).toBe("Helix is catching up. Pause before speaking again.");
    expect(snapshot.error).toBe("Helix is catching up. Pause before speaking again."); // the phone status line
    expect(snapshot.feed.find(item => item.id === "a1")?.label).toBe("Helix · answer");
    // A second problem is a new notice; the next heard line clears it.
    const first = snapshot.glasses.notice!.id;
    presentation.setStatus("listening", "Background copilot failed.");
    expect(presentation.snapshot().glasses.notice!.id).not.toBe(first);
    expect(presentation.snapshot().glasses.answer?.id).toBe("a1");
    presentation.apply(final("t1", "Right."));
    expect(presentation.snapshot().glasses.notice).toBeUndefined();
    expect(presentation.snapshot().glasses.answer?.id).toBe("a1");
  });

  it("ends a waiting manual request on a transient error without touching the answer state", () => {
    const presentation = new ConversationPresentation();
    presentation.setStatus("listening");
    presentation.beginRequest();
    expect(presentation.snapshot().glasses.manualPending).toBe(true);
    presentation.apply(problem("Helix is catching up. Pause before speaking again."));
    expect(presentation.snapshot().glasses.manualPending).toBe(false);
  });

  it("clears the answer only for a session-ending error", () => {
    const presentation = new ConversationPresentation();
    presentation.setStatus("listening");
    presentation.apply(question("q1", "How long is the lead time?"));
    presentation.apply(completed("a1", "q1", "Twelve to sixteen weeks."));
    presentation.apply(problem("The API key was rejected.", true));
    const snapshot = presentation.snapshot();
    expect(snapshot.status).toBe("failed");
    expect(snapshot.glasses.answer).toBeUndefined();
    expect(snapshot.glasses.error).toBe("The API key was rejected.");
    expect(snapshot.glasses.notice).toBeUndefined();
  });

  it("keeps a cut-off answer on the glasses and marks it on the phone instead of calling it interrupted", () => {
    const presentation = new ConversationPresentation();
    presentation.setStatus("listening");
    presentation.apply(question("q1", "How long is the lead time?"));
    presentation.apply(delta("a1", "q1", "Twelve to sixteen "));
    presentation.apply(completed("a1", "q1", "Twelve to sixteen", true));
    const snapshot = presentation.snapshot();
    expect(snapshot.glasses.answer).toMatchObject({ id: "a1", text: "Twelve to sixteen", streaming: false, partial: true });
    const item = snapshot.feed.find(entry => entry.id === "a1")!;
    expect(item).toMatchObject({ label: "Helix · answer cut off", partial: true });
    expect(item.label).not.toContain("interrupted");
    expect(item.streaming).toBeFalsy();
    // A complete answer carries no mark.
    presentation.apply(question("q2", "And the price?"));
    presentation.apply(completed("a2", "q2", "About two thousand dollars."));
    expect(presentation.snapshot().glasses.answer?.partial).toBeUndefined();
    expect(presentation.snapshot().feed.find(entry => entry.id === "a2")?.partial).toBeUndefined();
  });

  it("ends a streaming answer as cut off when the provider fails mid-stream", () => {
    const presentation = new ConversationPresentation();
    presentation.setStatus("listening");
    presentation.apply(question("q1", "How long is the lead time?"));
    presentation.apply(delta("a1", "q1", "Twelve to sixteen "));
    presentation.apply(failure("provider-timeout", "Provider request timed out. Try again."));
    let snapshot = presentation.snapshot();
    expect(snapshot.status).toBe("listening");
    expect(snapshot.glasses.answer).toMatchObject({ id: "a1", text: "Twelve to sixteen ", streaming: false, partial: true });
    expect(snapshot.glasses.notice?.text).toBe("Provider request timed out. Try again.");
    const item = snapshot.feed.find(entry => entry.id === "a1")!;
    expect(item).toMatchObject({ label: "Helix · answer cut off", partial: true, body: "Twelve to sixteen " });
    expect(item.streaming).toBeFalsy();
    expect(snapshot.unseen.answers).toBe(1);
    // The display is free again: a contradicted web check may correct on the glasses.
    presentation.applyFactCheck({ id: "f1", sessionId: "s", transcriptId: "t1", claim: "It ships in a week.", status: "contradicted",
      summary: "It ships in twelve weeks.", checkedAt: at, sources: [{ title: "Source", url: "https://example.com/lead-time" }] } as never, true);
    snapshot = presentation.snapshot();
    expect(snapshot.glasses.answer?.text).toBe("Correction: It ships in twelve weeks.");
    expect(snapshot.feed.find(entry => entry.id === "a1")).toMatchObject({ label: "Helix · answer cut off", partial: true });
  });

  it("does not leave a broken state when the cut-off answer gets more text or completes after all", () => {
    const presentation = new ConversationPresentation();
    presentation.setStatus("listening");
    presentation.apply(question("q1", "How long is the lead time?"));
    presentation.apply(delta("a1", "q1", "Twelve "));
    presentation.apply(failure("provider-network", "Direct provider request failed."));
    expect(presentation.snapshot().glasses.answer).toMatchObject({ streaming: false, partial: true });
    // The error belonged to another request after all: the stream goes on, with no repeated text.
    presentation.apply(delta("a1", "q1", "to sixteen "));
    let snapshot = presentation.snapshot();
    expect(snapshot.glasses.answer).toMatchObject({ id: "a1", text: "Twelve to sixteen ", streaming: true });
    expect(snapshot.glasses.answer?.partial).toBeUndefined();
    expect(snapshot.feed.filter(entry => entry.id === "a1")).toHaveLength(1);
    expect(snapshot.feed.find(entry => entry.id === "a1")).toMatchObject({ label: "Helix · answering", streaming: true, body: "Twelve to sixteen " });
    expect(snapshot.feed.find(entry => entry.id === "a1")?.partial).toBeUndefined();
    presentation.apply(failure("provider-timeout", "Provider request timed out. Try again."));
    presentation.apply(completed("a1", "q1", "Twelve to sixteen weeks."));
    snapshot = presentation.snapshot();
    expect(snapshot.glasses.answer).toMatchObject({ id: "a1", text: "Twelve to sixteen weeks.", streaming: false });
    expect(snapshot.glasses.answer?.partial).toBeUndefined();
    const item = snapshot.feed.find(entry => entry.id === "a1")!;
    expect(item.label).toBe("Helix · answer");
    expect(item.partial).toBeUndefined();
    expect(item.streaming).toBeFalsy();
    expect(snapshot.unseen.answers).toBe(2); // once per cut-off; the completion adds none
  });

  it("leaves a healthy streaming answer alone for a notice that is not about it", () => {
    const presentation = new ConversationPresentation();
    presentation.setStatus("listening");
    presentation.apply(question("q1", "How long is the lead time?"));
    presentation.apply(delta("a1", "q1", "Twelve to sixteen "));
    presentation.apply(problem("Helix is catching up. Pause before speaking again.")); // conversation-busy: the transcription backlog
    presentation.setStatus("listening", "Background copilot failed."); // copilot failures arrive as a status, not as an SDK error
    const snapshot = presentation.snapshot();
    expect(snapshot.glasses.answer).toMatchObject({ id: "a1", streaming: true });
    expect(snapshot.glasses.answer?.partial).toBeUndefined();
    expect(snapshot.feed.find(entry => entry.id === "a1")).toMatchObject({ label: "Helix · answering", streaming: true });
    presentation.apply(completed("a1", "q1", "Twelve to sixteen weeks."));
    expect(presentation.snapshot().feed.find(entry => entry.id === "a1")?.label).toBe("Helix · answer");
  });

  it("does not announce a suggestion that was already asked", () => {
    const presentation = new ConversationPresentation();
    presentation.setSuggestions([suggestion("s1", "What was your own part?", "", { askedAt: at })]);
    expect(presentation.snapshot().unseen.qa).toBe(0);
    expect(presentation.snapshot().peek).toBeUndefined();
    presentation.setSuggestions([suggestion("s2", "Which numbers moved?"), suggestion("s1", "What was your own part?", "", { askedAt: at })]);
    expect(presentation.snapshot().unseen.qa).toBe(1);
    expect(presentation.snapshot().peek?.text).toBe("Which numbers moved?");
  });
});

describe("v0.14 glasses: suggested questions pop up on the ambient display", () => {
  it("pops the top new suggestion up in one glance: question first, the why when it fits", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening("interviewer");
    expect(blank(hud.frame.body)).toBe(true);
    presentation.setSuggestions([
      suggestion("s1", "What was your own contribution to the migration?", "They said 'we' throughout."),
      suggestion("s2", "Which numbers moved after the launch?", "No outcome was given."),
    ]);
    expect(hud.frame.title).toBe(MODE_PROFILES.interviewer.askLabel);
    expect(hud.frame.body).toBe("What was your own contribution to the\nmigration?\n\nWhy: They said 'we' throughout.");
    expect(hud.frame.body).not.toContain("Which numbers");
    expect(hud.frame.status.trim()).toBe("tap to close");
    for (const line of hud.frame.body.split("\n")) expect(hudTextWidth(line)).toBeLessThanOrEqual(HUD_LINE_WIDTH.body);
    // It stays long enough to be read and said, then the display is blank again.
    await vi.advanceTimersByTimeAsync(SUGGESTION_CUE_MS - 100);
    expect(hud.frame.body).toContain("What was your own contribution");
    await vi.advanceTimersByTimeAsync(200);
    expect(blank(hud.frame.title) && blank(hud.frame.body)).toBe(true);
    // The second suggestion is not the top one: it does not pop up by itself, and nothing repeats.
    hud.render(presentation.snapshot().glasses, presentation.snapshot());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(blank(hud.frame.body)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops the why when it does not fit, and never exceeds the body", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening("interviewer");
    const long = "Can you walk me through exactly how you sized the cluster, which load tests you ran, what the p99 latency was before and after, and which of those decisions were yours rather than the team's? ";
    presentation.setSuggestions([suggestion("s1", long.repeat(2), "A very long reason that will certainly not fit under a question that already fills the whole body of the display.")]);
    const lines = hud.frame.body.split("\n");
    expect(lines.length).toBeLessThanOrEqual(BODY_LINES);
    expect(hud.frame.body).not.toContain("Why:");
    expect(hud.frame.body.startsWith("Can you walk me through")).toBe(true);
    for (const line of lines) expect(hudTextWidth(line)).toBeLessThanOrEqual(HUD_LINE_WIDTH.body);
  });

  it("shows at most one suggestion every 20 s and the newest top one only", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening("interviewer");
    presentation.setSuggestions([suggestion("s1", "What was your own part?")]);
    expect(hud.frame.body).toBe("What was your own part?");
    expect(hud.handleGesture("click")).toEqual({ type: "handled" }); // tap closes it
    expect(blank(hud.frame.body)).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    presentation.setSuggestions([suggestion("s2", "Which numbers moved?"), suggestion("s1", "What was your own part?")]);
    expect(blank(hud.frame.body)).toBe(true); // inside the gap
    await vi.advanceTimersByTimeAsync(2000);
    presentation.setSuggestions([suggestion("s3", "Who made the final call?"), suggestion("s2", "Which numbers moved?")]);
    await vi.advanceTimersByTimeAsync(SUGGESTION_CUE_GAP_MS - 7000 - 100);
    expect(blank(hud.frame.body)).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(hud.frame.body).toBe("Who made the final call?"); // the top one now, not the one that was top before
    await vi.advanceTimersByTimeAsync(120_000);
    expect(blank(hud.frame.body)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not pop up an asked suggestion, removes one that gets asked, and does not repeat a question under a new id", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening("interviewer");
    presentation.setSuggestions([suggestion("s1", "What was your own part?", "", { askedAt: at }), suggestion("s2", "Which numbers moved?")]);
    expect(hud.frame.body).toBe("Which numbers moved?"); // the top one that is still open
    presentation.setSuggestions([suggestion("s2", "Which numbers moved?", "", { askedAt: at })]);
    expect(blank(hud.frame.body)).toBe(true); // said aloud: it leaves the display
    await vi.advanceTimersByTimeAsync(SUGGESTION_CUE_GAP_MS + 1000);
    presentation.setSuggestions([suggestion("s9", "Which numbers  moved?")]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(blank(hud.frame.body)).toBe(true);
  });

  it("never shows a suggestion over an answer: it waits and follows it", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening("interviewer");
    presentation.apply(question("q1", "Do you offer remote work?"));
    presentation.apply(completed("a1", "q1", "Yes, two days a week."));
    presentation.setSuggestions([suggestion("s1", "What was your own part?")]);
    expect(hud.frame.title).toBe("◆ THEY ASKED 1/1");
    expect(hud.frame.body).not.toContain("What was your own part?");
    await vi.advanceTimersByTimeAsync(8100);
    expect(hud.frame.title).toBe(MODE_PROFILES.interviewer.askLabel);
    expect(hud.frame.body).toBe("What was your own part?");
  });

  it("titles the pop-up from the mode profile, and Candidate mode names what the other side may ask", async () => {
    vi.useFakeTimers();
    const meeting = await listening("general");
    meeting.presentation.setSuggestions([suggestion("s1", "Who owns the purchase request?")]);
    expect(meeting.hud.frame.title).toBe(MODE_PROFILES.general.askLabel);
    const candidate = await listening("interviewee");
    candidate.presentation.setSuggestions([suggestion("s1", "Why are you leaving your current role?", "They may ask: you mentioned a reorg.", { kind: "they-ask" })]);
    expect(candidate.hud.frame.title).toBe("THEY MAY ASK");
    expect(candidate.hud.frame.body).toBe("Why are you leaving your current role?\n\nWhy: you mentioned a reorg.");
    candidate.hud.handleGesture("click");
    await vi.advanceTimersByTimeAsync(SUGGESTION_CUE_GAP_MS);
    candidate.presentation.setSuggestions([suggestion("s2", "How is the team's on-call set up?", "", { kind: "ask-them" })]);
    expect(candidate.hud.frame.title).toBe(MODE_PROFILES.interviewee.askLabel);
  });

  it("leaves asked suggestions out of the glasses list", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await mount({ display: "always-on" });
    presentation.setMode("interviewer");
    presentation.setStatus("listening");
    presentation.setSuggestions([suggestion("s1", "What was your own part?", "", { askedAt: at }), suggestion("s2", "Which numbers moved?")]);
    hud.setView("qa");
    expect(hud.frame.body).toContain("Which numbers moved?");
    expect(hud.frame.body).not.toContain("What was your own part?");
    expect(hud.frame.title).toBe(`${MODE_PROFILES.interviewer.askLabel} 1/1`);
    expect(hud.handleGesture("click")).toEqual({ type: "ask", text: "Which numbers moved?" });
  });
});

describe("v0.14 glasses: answers stay readable", () => {
  it("keeps the answer on screen through a transient error and shows the problem briefly", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening("interviewer");
    presentation.apply(question("q1", "Do you offer remote work?"));
    presentation.apply(completed("a1", "q1", "Yes, two days a week."));
    presentation.apply(problem("Helix is catching up."));
    expect(hud.frame.title).toBe("◆ THEY ASKED 1/1");
    expect(hud.frame.body).toContain("Yes, two days a week.");
    expect(hud.frame.status).toContain("! Helix is catching up.");
    expect(hudTextWidth(hud.frame.status.trim())).toBeLessThanOrEqual(HUD_LINE_WIDTH.status);
    await vi.advanceTimersByTimeAsync(NOTICE_MS + 100);
    expect(hud.frame.status).not.toContain("!");
    expect(hud.frame.body).toContain("Yes, two days a week.");
    // A session-ending error does clear it.
    presentation.apply(problem("The API key was rejected.", true));
    expect(hud.frame.body).not.toContain("Yes, two days a week.");
  });

  it("shows a brief notice on the blank display too, then goes blank again", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening("general");
    presentation.setStatus("listening", "Background copilot failed.");
    expect(hud.frame.status).toContain("! Background copilot failed.");
    expect(blank(hud.frame.body)).toBe(true);
    await vi.advanceTimersByTimeAsync(NOTICE_MS + 1000);
    expect(blank(hud.frame.status)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives the current answer its first page, marks the waiting one with +1, and keeps each answer with its own question", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening("general");
    presentation.apply(question("q1", "Do you offer remote work?"));
    presentation.apply(completed("a1", "q1", "Yes, two days a week."));
    await vi.advanceTimersByTimeAsync(500);
    presentation.apply(question("q2", "What is the notice period?"));
    presentation.apply(delta("a2", "q2", "Four weeks"));
    expect(hud.frame.title).toBe("◆ THEY ASKED 1/1 +1");
    expect(hud.frame.body).toBe("Q: Do you offer remote work?\nYes, two days a week.");
    expect(hud.frame.status.trim()).toBe("tap: next answer");
    expect(hudTextWidth(hud.frame.title)).toBeLessThanOrEqual(HUD_LINE_WIDTH.header);
    presentation.apply(completed("a2", "q2", "Four weeks."));
    await vi.advanceTimersByTimeAsync(2500);
    expect(hud.frame.title).toBe("◆ THEY ASKED 1/1");
    expect(hud.frame.body).toBe("Q: What is the notice period?\nFour weeks.");
    await vi.advanceTimersByTimeAsync(8100);
    expect(blank(hud.frame.body)).toBe(true);
  });

  it("a tap on the current answer brings the waiting one, and a manual ask replaces everything at once", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening("general");
    presentation.apply(question("q1", "Do you offer remote work?"));
    presentation.apply(completed("a1", "q1", "Yes, two days a week."));
    presentation.apply(question("q2", "What is the notice period?"));
    presentation.apply(completed("a2", "q2", "Four weeks."));
    expect(hud.frame.body).toContain("Yes, two days a week.");
    expect(hud.handleGesture("click")).toEqual({ type: "handled" });
    expect(hud.frame.body).toBe("Q: What is the notice period?\nFour weeks.");
    presentation.apply(question("q3", "Is there a bonus?"));
    presentation.apply(completed("a3", "q3", "Up to ten percent."));
    expect(hud.frame.title).toBe("◆ THEY ASKED 1/1 +1");
    presentation.beginRequest();
    expect(hud.frame.title).toBe("◆ ANSWER");
    expect(hud.frame.body).toContain("Thinking…");
    expect(hud.frame.body).not.toContain("Four weeks.");
  });

  it("marks a cut-off answer on the glasses and keeps it up", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening("general");
    presentation.apply(question("q1", "How long is the lead time?"));
    presentation.apply(delta("a1", "q1", "Twelve to sixteen "));
    presentation.apply(completed("a1", "q1", "Twelve to sixteen", true));
    expect(hud.frame.title).toBe("◆ THEY ASKED 1/1");
    expect(hud.frame.body).toBe(`Q: How long is the lead time?\nTwelve to sixteen${CUT_OFF_MARK}`);
    expect(hud.frame.status.trim()).toBe("cut off · tap to close");
    await vi.advanceTimersByTimeAsync(7000);
    expect(hud.frame.body).toContain("Twelve to sixteen");
  });

  it("titles a Candidate mode answer as a reply to say", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening("interviewee");
    presentation.apply(question("q1", "Why are you leaving your current role?"));
    presentation.apply(completed("a1", "q1", "I want to own a product end to end."));
    expect(hud.frame.title).toBe("◆ YOUR REPLY 1/1");
    expect(hud.frame.status.trim()).toBe("reply · tap to close");
    expect(hud.frame.body).toBe("Q: Why are you leaving your current role?\nI want to own a product end to end.");
    // Interviewer mode keeps its answer key and THEY ASKED titles.
    const other = await listening("interviewer");
    other.presentation.apply(question("q1", "Tell me about a hard migration.", "self"));
    other.presentation.apply(completed("a1", "q1", "A strong answer covers scope, their role and the outcome."));
    expect(other.hud.frame.title).toBe("§ ANSWER KEY 1/1");
  });

  it("labels a finished answer with its age when it is looked at again minutes later", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await listening("general");
    presentation.apply(question("q1", "Do you offer remote work?"));
    presentation.apply(completed("a1", "q1", "Yes, two days a week."));
    await vi.advanceTimersByTimeAsync(8100);
    expect(blank(hud.frame.body)).toBe(true); // 8 s after its last page it is gone, as before
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    hud.handleGesture("double"); // wake the HUD
    hud.setView("answer");
    expect(hud.frame.title).toBe("◆ ANSWER 1/1");
    expect(hud.frame.body).toContain("Yes, two days a week.");
    expect(hud.frame.status).toContain("last · 5m ago");
    expect(hud.frame.status).not.toContain("answering");
  });
});

describe("v0.14 phone: Q&A panel and modes", () => {
  const open = suggestion("s1", "What was your own part?", "They said 'we'.");
  const asked = suggestion("s2", "Which numbers moved?", "", { askedAt: at });

  it("heads the suggestions for the mode instead of a fixed 'Ask them'", () => {
    expect(uiSource).not.toContain('el("h3", "section-label", "Ask them")');
    expect(suggestionGroups("general", [open]).map(group => group.heading)).toEqual(["Ask them"]);
    expect(suggestionGroups("technical", [open]).map(group => group.heading)).toEqual(["Probe"]);
    expect(suggestionGroups("interviewer", [open]).map(group => group.heading)).toEqual(["Probes to ask"]);
    expect(suggestionGroups(undefined, []).map(group => group.heading)).toEqual(["Ask them"]);
    for (const group of suggestionGroups("interviewer", [])) expect(group.empty).toContain("candidate");
  });

  it("groups Candidate mode into what they may ask and what to ask them", () => {
    const theirs = suggestion("s3", "Why are you leaving?", "They may ask: you mentioned a reorg.", { kind: "they-ask" });
    const mine = suggestion("s4", "How is on-call set up?", "Ask them: it was not covered.", { kind: "ask-them" });
    const groups = suggestionGroups("interviewee", [theirs, mine]);
    expect(groups.map(group => group.heading)).toEqual(["They may ask", "Ask them"]);
    expect(groups[0]!.items).toEqual([theirs]);
    expect(groups[1]!.items).toEqual([mine]);
    expect(groups[0]!.tapLabel).toContain("reply");
    // Without kinds from the SDK everything is one sensible group; with nothing yet, both headings show.
    expect(suggestionGroups("interviewee", [open]).map(group => group.heading)).toEqual(["Ask them"]);
    expect(suggestionGroups("interviewee", []).map(group => group.heading)).toEqual(["They may ask", "Ask them"]);
    expect(suggestionWhyText("They may ask: you mentioned a reorg.")).toBe("you mentioned a reorg.");
    expect(suggestionWhyText("Ask them - it was not covered.")).toBe("it was not covered.");
    expect(suggestionWhyText("They said 'we'.")).toBe("They said 'we'.");
  });

  it("keeps asked suggestions, last and struck out, until the SDK drops them", () => {
    expect(suggestionGroups("interviewer", [asked, open])[0]!.items).toEqual([open, asked]);
    expect(suggestionGroups("interviewer", [open])[0]!.items).toEqual([open]);
    expect(uiSource).toContain('`suggestion${asked ? " is-asked" : ""}`');
    expect(styles).toMatch(/\.suggestion\.is-asked \.suggestion-text \{[^}]*line-through/u);
    expect(styles).toMatch(/\.suggestion-text \{[^}]*overflow-wrap: anywhere/u);
  });

  it("marks a cut-off answer on the phone", () => {
    expect(CUT_OFF_NOTE).toContain("Cut off");
    expect(uiSource).toContain('if (item.partial) footer.append(el("small", "cut-off-note", CUT_OFF_NOTE))');
    expect(styles).toContain(".cut-off-note");
  });

  it("offers every picker mode by its SDK label on the mode bar and the select, and no longer maps a saved mode to Meeting", () => {
    const markup = companionMarkup();
    for (const mode of PICKER_MODES) {
      expect(markup).toContain(`data-mode="${mode}"`);
      expect(markup).toContain(`<option value="${mode}">${MODE_PROFILES[mode].label}</option>`);
    }
    expect(uiSource).not.toContain('.picker ? config.conversationMode : "general"');
    expect(new Set(PICKER_MODES.map(mode => modeIcon(mode))).size).toBe(PICKER_MODES.length);
    expect(modeIcon("interviewee")).not.toBe(modeIcon("general"));
  });

  it("lists the picker modes in the glasses mode menu by their SDK labels", async () => {
    vi.useFakeTimers();
    const { hud, presentation } = await mount({ display: "always-on" });
    presentation.setStatus("listening");
    hud.handleGesture("double");
    hud.selectListItem(hud.menuItems.findIndex(item => item.action === "mode"));
    expect(hud.menuItems.map(item => item.label)).toEqual(PICKER_MODES.map(mode => MODE_PROFILES[mode].label));
    expect(hud.menuItems.map(item => item.action)).toEqual(PICKER_MODES.map(mode => `mode:${mode}`));
  });
});
