/**
 * v0.16 talk scenario: the rehearsal script "talk-being-present" (a podcast the wearer listens to) played
 * through the production controller, presentation, glasses HUD and phone transport with fake timers and
 * the fake provider (tests/interview-rig.ts, tests/fake-openai.ts).
 *
 * What this proves is plumbing: which lines are answered, which kind of suggestion reaches the phone, and
 * what the requests to the provider say. The fake provider's text is templated, so nothing here says how
 * good a real model's lines are.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANSWER_KEY_PREFIX, MODE_PROFILES, MONOLOGUE_AFTER_MS, MONOLOGUE_GAP_MS, SPEECH_RECOGNITION_RULE, extractQuestions, lineRequest,
  type CopilotSuggestion,
} from "@helix/conversation-sdk";
import { defaultPauseMs, rehearsalScript } from "../src/rehearsal";
import { suggestionGroups } from "../src/ui";
import scriptData from "../src/rehearsal-scripts.json";
import type { FakeRecordedRequest } from "./fake-openai";
import { interviewScript, type InterviewReport, type TimelineRecord } from "./interview-harness";
import { createRig, drive, type Rig, type RigOptions } from "./interview-rig";

vi.setConfig({ testTimeout: 60_000 });
const TALK = "talk-being-present";
const LABELS = ["Strong answer", "Probe:", "Flag:"];
const script = interviewScript(TALK)!;
const raw = (scriptData as unknown as { id: string; kind: string; mode?: string; expectations: { sayLines?: boolean; unanswered?: string[]; forbiddenLabels?: string[] } }[]).find(item => item.id === TALK)!;

let rig: Rig | undefined;
afterEach(async () => { await rig?.dispose().catch(() => undefined); rig = undefined; vi.useRealTimers(); });
async function start(options: RigOptions = {}): Promise<Rig> {
  vi.useFakeTimers();
  rig = await createRig(options);
  return rig;
}

/** Every string in a request body, joined: instructions, system messages and the user request. */
function bodyText(value: unknown, out: string[] = []): string {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) bodyText(item, out);
  else if (value && typeof value === "object") for (const item of Object.values(value)) bodyText(item, out);
  return out.join("\n");
}
const ofKind = (timeline: readonly TimelineRecord[], kind: TimelineRecord["kind"]) => timeline.filter(record => record.kind === kind);
/** Everything the plumbing produced in a run: provider output, events, phone feed, suggestions, glasses text. */
function outputs(current: Rig): string {
  const snapshot = current.presentation.snapshot();
  return [
    ...current.fake.requests.map(request => request.output ?? ""),
    ...current.api.timeline().map(record => record.text),
    ...snapshot.feed.map(item => `${item.label}\n${item.body}`),
    ...snapshot.suggestions.map(item => `${item.question}\n${item.why}`),
    ...current.glasses.containers.values(),
  ].join("\n");
}

interface TalkRun {
  readonly report: InterviewReport; readonly timeline: TimelineRecord[]; readonly suggestions: readonly CopilotSuggestion[];
  readonly requests: FakeRecordedRequest[]; readonly produced: string;
  /** The requests of one manual tap ("last few sentences") made after the script. */
  readonly tap: FakeRecordedRequest[]; readonly tapProduced: string;
  /** Phone feed after the tap: label and body of each item. */
  readonly tapFeed: readonly { readonly kind: string; readonly label: string; readonly body: string }[];
}
let tagged: Promise<TalkRun> | undefined;
/** One run with tagged roles, shared by the tests below. */
function taggedRun(): Promise<TalkRun> {
  tagged ??= (async () => {
    const current = await start({ mode: "general" });
    const report = await drive(current.api.play(TALK));
    const timeline = current.api.timeline(), suggestions = current.presentation.snapshot().suggestions;
    const requests = [...current.fake.requests], produced = outputs(current);
    await drive(current.controller.askContext("local"));
    await vi.advanceTimersByTimeAsync(8000);
    const tap = current.fake.requests.slice(requests.length), tapProduced = outputs(current);
    const tapFeed = current.presentation.snapshot().feed.map(item => ({ kind: item.kind, label: item.label, body: item.body }));
    await current.dispose().catch(() => undefined);
    rig = undefined;
    return { report, timeline, suggestions, requests, produced, tap, tapProduced, tapFeed };
  })();
  return tagged;
}

describe("talk-being-present: the script", () => {
  it("is a monologue in Meeting mode with short wearer turns, garbled lines and mixed-language fragments", () => {
    expect(raw.mode).toBe("general");
    // Kind "talk": neither an interview nor a meeting, so the live harness defaults it to Meeting (general) too.
    expect(raw.kind).toBe("talk");
    expect(script.mode).toBe("general");
    expect(MODE_PROFILES.general.sayLines).toBe(true);
    const wearer = script.lines.filter(line => line.speaker === "self"), host = script.lines.filter(line => line.speaker === "other");
    expect(wearer.map(line => line.text)).toEqual(["Yeah.", "And", "Yeah"]);
    expect(host.length).toBeGreaterThanOrEqual(18);
    expect(script.lines.every(line => line.expect === "none"), "no line of a talk asks for an answer").toBe(true);
    expect(script.lines.filter(line => line.case === "garbled" || line.case === "cut-off").length).toBeGreaterThanOrEqual(3);
    const mixed = script.lines.filter(line => line.case === "mixed-language").map(line => line.text).join(" ");
    expect(mixed).toMatch(/\p{Script=Han}/u);
    expect(mixed).toMatch(/\p{Script=Hangul}/u);
    expect(host.map(line => line.text).join(" ")).toContain("Is there anything we can do in this moment?");
    // Several minutes of speech at the script's own pace.
    const total = script.lines.reduce((sum, line) => sum + (line.pauseMs ?? defaultPauseMs(line.text)), 0);
    expect(total).toBeGreaterThanOrEqual(180_000);
    // The shipped rehearsal list has it, in the format the other scripts use.
    expect(rehearsalScript(TALK)?.lines).toHaveLength(script.lines.length);
    expect(raw.expectations.forbiddenLabels).toEqual(LABELS);
    expect(raw.expectations.sayLines).toBe(true);
  });

  it("places each guarded rhetorical question after the monologue guard applies, and nothing else needs the guard", () => {
    let at = 0, floor: number | undefined, last = 0;
    const guarded: string[] = [];
    for (const line of script.lines) {
      const detected = extractQuestions(line.text).map(question => question.text);
      if (line.speaker === "self") { floor = undefined; expect(detected, `the wearer's turn is not a question: ${line.text}`).toEqual([]); }
      else {
        if (floor !== undefined) expect(at - last, "no pause long enough to start a new floor").toBeLessThanOrEqual(MONOLOGUE_GAP_MS);
        floor ??= at; last = at;
        if (line.case === "rhetorical-guarded") {
          expect(detected.length, `the detector alone would answer this: ${line.text}`).toBeGreaterThan(0);
          expect(at - floor, `guard applies at: ${line.text}`).toBeGreaterThanOrEqual(MONOLOGUE_AFTER_MS);
          guarded.push(line.text);
        } else expect(detected, `the rhetorical filter already skips: ${line.text}`).toEqual([]);
      }
      at += line.pauseMs ?? defaultPauseMs(line.text);
    }
    expect(guarded).toHaveLength(2);
    for (const needle of raw.expectations.unanswered ?? []) expect(guarded.some(text => text.includes(needle)), needle).toBe(true);
    expect(raw.expectations.unanswered).toHaveLength(2);
  });
});

describe("talk-being-present with tagged roles", () => {
  it("every line is heard with its speaker and none of the host's questions is answered", async () => {
    const { report, timeline, requests } = await taggedRun();
    expect(ofKind(timeline, "line.heard").map(record => [record.data?.speaker, record.text])).toEqual(script.lines.map(line => [line.speaker, line.text]));
    expect(report.violations).toEqual([]);
    expect(report.summary.unexpectedAnswers).toBe(0);
    expect(ofKind(timeline, "answer.completed")).toEqual([]);
    expect(ofKind(timeline, "answer.first-token")).toEqual([]);
    expect(requests.filter(request => request.intent === "answer"), "no answer request reached the provider").toEqual([]);
    // The guarded questions were detected (the phone lists them) and left alone by the monologue guard.
    const guarded = report.rows.filter(row => row.case === "rhetorical-guarded");
    expect(guarded.map(row => [row.detected, row.attempts, row.timesAnswered, row.finalState])).toEqual([[true, 0, 0, "ignored"], [true, 0, 0, "ignored"]]);
  });

  it("the phone gets lines to say, headed 'Say next'", async () => {
    const { suggestions, report } = await taggedRun();
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(3);
    expect(suggestions.map(item => item.kind)).toEqual(suggestions.map(() => "say"));
    expect(report.summary.suggestionChanges).toBeGreaterThan(0);
    const groups = suggestionGroups("general", suggestions);
    expect(groups.map(group => [group.heading, group.action])).toEqual([["Say next", "said"]]);
  });

  it("no output carries the interviewer answer-key labels", async () => {
    const { produced, tapProduced } = await taggedRun();
    expect(produced.length).toBeGreaterThan(200);
    for (const label of LABELS) { expect(produced).not.toContain(label); expect(tapProduced).not.toContain(label); }
  });

  it("the copilot request carries the speech-recognition rule and asks for lines to say", async () => {
    const { requests } = await taggedRun();
    const copilot = requests.filter(request => request.schemaName !== undefined && /lines the WEARER can say next/u.test(bodyText(request.body)));
    expect(copilot.length).toBeGreaterThan(0);
    for (const request of copilot) expect(bodyText(request.body)).toContain(SPEECH_RECOGNITION_RULE);
    for (const request of requests.filter(item => item.schemaName !== undefined)) for (const label of LABELS) expect(bodyText(request.body)).not.toContain(label);
  });

  it("a manual tap asks for the one thing to say next, with the speech-recognition rule and no answer key", async () => {
    const { tap, timeline, tapFeed } = await taggedRun();
    const answers = tap.filter(request => request.intent === "answer");
    expect(answers).toHaveLength(1);
    const text = bodyText(answers[0]!.body);
    expect(text).toContain(lineRequest("local"));
    expect(text).toContain("single best thing to say next");
    expect(text).toContain(SPEECH_RECOGNITION_RULE);
    expect(text).not.toContain(ANSWER_KEY_PREFIX);
    for (const label of LABELS) expect(text).not.toContain(label);
    expect(answers[0]!.output?.trim()).toBeTruthy();
    // The phone feed names it for what it is: a line to say, not an answer to a question.
    expect(tapFeed.filter(item => item.kind === "question").map(item => item.body)).toContain("A line to say about the last few sentences.");
    const replies = tapFeed.filter(item => item.kind === "answer");
    expect(replies.map(item => item.label)).toEqual(["Helix · say next"]);
    expect(replies[0]!.body).toBe(answers[0]!.output);
    // It was the only answer of the whole run.
    expect(ofKind(timeline, "answer.completed")).toEqual([]);
  });
});

describe("talk-being-present when the wearer never speaks", () => {
  // Fix pass: the guard must not depend on a turn from the wearer. Same script, every wearer line left out.
  it("none of the host's questions is answered, and they are still listed", async () => {
    const current = await start({ mode: "general" });
    const host = script.lines.filter(line => line.speaker === "other");
    await drive((async () => {
      for (const line of host) {
        await current.api.say(line.text, "other", "none", line.case);
        await new Promise(done => setTimeout(done, line.pauseMs ?? defaultPauseMs(line.text)));
      }
      await new Promise(done => setTimeout(done, 12_000));
    })());
    const report = current.api.report(), timeline = current.api.timeline();
    expect(ofKind(timeline, "line.heard").map(record => record.data?.speaker)).toEqual(host.map(() => "other"));
    expect(current.fake.byIntent("answer"), "no answer request reached the provider").toEqual([]);
    expect(ofKind(timeline, "answer.completed")).toEqual([]);
    const rows = report.rows.filter(row => row.case === "rhetorical-guarded");
    expect(rows.map(row => [row.detected, row.timesAnswered, row.finalState])).toEqual([[true, 0, "ignored"], [true, 0, "ignored"]]);
    expect(current.presentation.snapshot().suggestions.every(item => item.kind === "say")).toBe(true);
  });
});

describe("talk-being-present without speaker tags", () => {
  it("still answers the questions: the monologue guard needs tagged roles", async () => {
    const current = await start({ mode: "general" });
    await drive((async () => {
      for (const line of script.lines) {
        await current.api.say(line.text, "unknown", undefined, line.case);
        await new Promise(done => setTimeout(done, line.pauseMs ?? defaultPauseMs(line.text)));
      }
      await new Promise(done => setTimeout(done, 12_000));
    })());
    const report = current.api.report(), timeline = current.api.timeline();
    expect(ofKind(timeline, "line.heard").map(record => record.data?.speaker)).toEqual(script.lines.map(() => "unknown"));
    const rows = report.rows.filter(row => row.case === "rhetorical-guarded");
    expect(rows.map(row => [row.detected, row.timesAnswered, row.finalState])).toEqual([[true, 1, "answered"], [true, 1, "answered"]]);
    const answers = current.fake.byIntent("answer");
    expect(answers.length).toBeGreaterThanOrEqual(2);
    for (const request of answers) {
      const text = bodyText(request.body);
      expect(text).toContain(SPEECH_RECOGNITION_RULE);
      expect(text).not.toContain(ANSWER_KEY_PREFIX);
    }
    for (const label of LABELS) expect(outputs(current)).not.toContain(label);
  });
});

describe("a manual tap in Interviewer mode", () => {
  it("asks for a line to say, never an answer key; the wearer's own spoken question still gets one", async () => {
    const current = await start({ mode: "interviewer" });
    await current.api.say("I owned the payments ledger service and kept the latency low.", "other", "none");
    await vi.advanceTimersByTimeAsync(3000);
    const before = current.fake.requests.length;
    await drive(current.controller.askContext("local"));
    await vi.advanceTimersByTimeAsync(8000);
    const tapped = current.fake.requests.slice(before).filter(request => request.intent === "answer");
    expect(tapped).toHaveLength(1);
    const tapText = bodyText(tapped[0]!.body);
    expect(tapText).toContain(lineRequest("local"));
    expect(tapText).toContain(SPEECH_RECOGNITION_RULE);
    expect(tapText).not.toContain(ANSWER_KEY_PREFIX);
    for (const label of LABELS) expect(tapText).not.toContain(label);
    // Control: the answer key is still asked for where it belongs.
    const mark = current.fake.requests.length;
    await current.api.say("How do you make a write idempotent?", "self", "answer-key");
    await vi.advanceTimersByTimeAsync(8000);
    const keyed = current.fake.requests.slice(mark).filter(request => request.intent === "answer");
    expect(keyed).toHaveLength(1);
    expect(bodyText(keyed[0]!.body)).toContain(ANSWER_KEY_PREFIX);
  });
});
