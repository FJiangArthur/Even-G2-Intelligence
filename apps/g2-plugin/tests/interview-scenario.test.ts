/**
 * Interview scenarios: the two interview scripts and the provider faults, run through the production
 * controller, presentation, glasses HUD and phone transport with fake timers and the fake provider.
 * Every assertion reads the harness timeline or the per-question report (tests/interview-harness.ts).
 *
 * Plain `it`: behaviour that works today. `it.fails`: behaviour the 0.14.0 work is still building; each
 * carries one line saying what it waits for and which weakness it pins. When that work is merged the test
 * starts passing, vitest reports it as failed, and `it.fails` is changed to `it`.
 *
 * An `it.fails` test passes on ANY throw, so each scenario is arranged through `arrange()`: a throw while
 * arranging is collected and reported by the last test in this file.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODE_PROFILES, PICKER_MODES, extractQuestions } from "@helix/conversation-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REHEARSAL_SCRIPTS, rehearsalScript } from "../src/rehearsal";
import { FAULT_KINDS, INTERVIEW_SCRIPTS, VISIBLE_WITHIN_MS, visibleLimit, interviewScript, type FaultKind, type InterviewReport, type PlayOptions, type QuestionRow, type TimelineRecord } from "./interview-harness";
import { createRig, drive, type Rig, type RigOptions } from "./interview-rig";

vi.setConfig({ testTimeout: 60_000 });
const INTERVIEWER = "interview-interviewer", CANDIDATE = "interview-candidate";
const AWKWARD_CASES = ["no-question-mark", "two-questions", "repeat", "rhetorical", "topic-change", "fragment", "long-question"];

let rig: Rig | undefined;
afterEach(async () => { await rig?.dispose().catch(() => undefined); rig = undefined; vi.useRealTimers(); });

/* ---------------- helpers ---------------- */

const wrongReasons: string[] = [];
/** Everything an `it.fails` test does before its real assertion. */
async function arrange<T>(what: string, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) { wrongReasons.push(`${what}: ${error instanceof Error ? error.message : String(error)}`); throw error; }
}
async function start(options: RigOptions = {}): Promise<Rig> {
  vi.useFakeTimers();
  rig = await createRig(options);
  return rig;
}
interface Run { readonly report: InterviewReport; readonly timeline: TimelineRecord[] }
const runs = new Map<string, Promise<Run>>();
/** One whole-script run per (script, fault, path); several tests read the same run. */
function scriptRun(scriptId: string, fault?: Exclude<FaultKind, "burst">, play: PlayOptions = {}, options: RigOptions = {}): Promise<Run> {
  const key = JSON.stringify([scriptId, fault ?? "none", play, options]);
  let run = runs.get(key);
  if (!run) {
    run = arrange(`run ${key}`, async () => {
      const current = await start({ mode: "general", ...options });
      if (fault) await current.api.fault(fault);
      const report = await drive(current.api.play(scriptId, play));
      const timeline = current.api.timeline();
      await current.dispose().catch(() => undefined);
      rig = undefined;
      // The run itself must be sound, whatever the app did with it.
      const expected = interviewScript(scriptId)!.lines.length;
      if (fault !== "http-401") expect(report.summary.linesHeard, "every line reaches the pipeline").toBe(expected);
      expect(report.summary.linesExpected).toBe(expected);
      return { report, timeline };
    });
    runs.set(key, run);
  }
  return run;
}
const rowsOf = (report: InterviewReport, tag: string): QuestionRow[] => report.rows.filter(row => row.case === tag);
const describeRows = (rows: readonly QuestionRow[]) => rows.map(row => `L${row.line} ${row.case ?? "-"} ${row.expect} -> ${row.finalState} x${row.timesAnswered} "${row.question.slice(0, 40)}"`);
const ofKind = (timeline: readonly TimelineRecord[], kind: TimelineRecord["kind"]) => timeline.filter(record => record.kind === kind);

/** Two questions three seconds apart; `prepare` runs between them, while the first answer is still on the glasses. */
async function twoQuestions(prepare: (current: Rig) => Promise<void>, settleMs = 20_000) {
  const current = await start({ mode: "interviewee" });
  await current.api.say("What does your pipeline look like end to end?", "other", "answer");
  await vi.advanceTimersByTimeAsync(3000);
  const first = ofKind(current.api.timeline(), "answer.completed")[0];
  expect(first, "the first answer finished").toBeDefined();
  expect(current.recorder.answerOnGlasses(), "the first answer is on the glasses").toBe(first!.id);
  await prepare(current);
  await current.api.say("How do you test a schema change before it ships?", "other", "answer");
  await vi.advanceTimersByTimeAsync(settleMs);
  return { current, firstAnswerId: first!.id!, report: current.api.report(), timeline: current.api.timeline() };
}
/** How the first answer left the glasses: "replaced" by the next answer, "expired" after its reading time, or taken away. */
const leftBecause = (timeline: readonly TimelineRecord[], answerId: string) => ofKind(timeline, "glasses.answer-hidden").find(record => record.id === answerId)?.data?.reason;

/* =============================================================================================== */

describe("interview scripts", () => {
  it("both scripts carry every awkward case and an expected outcome on every line", () => {
    for (const [id, mode] of [[INTERVIEWER, "interviewer"], [CANDIDATE, "interviewee"]] as const) {
      const script = interviewScript(id)!;
      expect(script.mode).toBe(mode);
      expect(script.lines.length).toBeGreaterThanOrEqual(18);
      expect(script.lines.length).toBeLessThanOrEqual(25);
      const raw = rehearsalScript(id)!.lines as unknown as { expect?: string }[];
      expect(raw.every(line => ["answer", "answer-key", "none"].includes(line.expect ?? "")), `${id}: every line states its outcome`).toBe(true);
      for (const tag of AWKWARD_CASES) expect(script.lines.filter(line => line.case === tag).length, `${id}: ${tag}`).toBeGreaterThanOrEqual(1);
      const repeat = script.lines.findIndex(line => line.case === "repeat"), twice = script.lines.findIndex(line => line.case === "two-questions");
      expect(repeat - twice, "the repeated question comes a few lines after the first time").toBeGreaterThanOrEqual(3);
      expect(script.lines[twice]!.text).toContain(script.lines[repeat]!.questions![0]!);
      // The rhetorical question comes from the other side, right after a question of the wearer.
      const rhetorical = script.lines.findIndex(line => line.case === "rhetorical");
      expect(script.lines[rhetorical]!.speaker).toBe("other");
      expect(script.lines[rhetorical - 1]!.speaker).toBe("self");
      expect(script.lines.find(line => line.case === "fragment")!.text.split(/\s+/u)).toHaveLength(2);
      expect(script.lines.find(line => line.case === "no-question-mark")!.text).not.toContain("?");
      expect(script.lines.find(line => line.case === "topic-change")!.text).not.toContain("?");
      expect(script.lines.find(line => line.case === "long-question")!.text.match(/[.?]/gu)!.length).toBeGreaterThanOrEqual(3);
      // Interviewer side: the wearer's questions want an answer key. Candidate side: never.
      expect(script.lines.some(line => line.expect === "answer-key")).toBe(mode === "interviewer");
    }
    // The older scripts still play through the harness, with outcomes derived from their expectations.
    expect(INTERVIEW_SCRIPTS.map(script => script.id)).toEqual(REHEARSAL_SCRIPTS.map(script => script.id));
    expect(interviewScript("mock-interview-ml")!.lines.filter(line => line.expect === "answer")).toHaveLength(6);
  });

  it("the scripts' expectations blocks say what the on-device detector finds today", () => {
    for (const id of [INTERVIEWER, CANDIDATE]) {
      const script = rehearsalScript(id)!;
      const detected = script.lines.flatMap(line => extractQuestions(line.text).map(question => question.text));
      for (const needle of [...script.expectations.questions ?? [], ...script.expectations.selfQuestions ?? []]) expect(detected.some(text => text.includes(needle)), `${id}: ${needle}`).toBe(true);
      for (const needle of script.expectations.implicitQuestions ?? []) expect(detected.some(text => text.includes(needle)), `${id}: stays implicit: ${needle}`).toBe(false);
    }
  });

  it("Candidate is a mode the wearer can pick  [waits for: mode id `interviewee` shown as \"Candidate\"; pins: the candidate side of an interview is a hidden legacy mode]", () => {
    expect(PICKER_MODES).toContain("interviewee");
    expect(MODE_PROFILES.interviewee.picker).toBe(true);
    expect(MODE_PROFILES.interviewee.label).toBe("Candidate");
  });
});

/* =============================================================================================== */

describe("interviewer script: the wearer interviews a candidate", () => {
  it("every line is heard once, in order, with its speaker", async () => {
    const { timeline } = await scriptRun(INTERVIEWER);
    const script = interviewScript(INTERVIEWER)!;
    const heard = ofKind(timeline, "line.heard");
    expect(heard.map(record => record.text)).toEqual(script.lines.map(line => line.text));
    expect(heard.map(record => record.data?.speaker)).toEqual(script.lines.map(line => line.speaker));
  });

  it("plain, repeated and long questions each get exactly one answer key, the candidate's question one answer, in the order asked", async () => {
    const { report } = await scriptRun(INTERVIEWER);
    const rows = ["plain", "repeat", "long-question", "candidate-question"].flatMap(tag => rowsOf(report, tag));
    expect(rows).toHaveLength(5);
    expect(describeRows(rows.filter(row => !row.ok))).toEqual([]);
    expect(rows.filter(row => row.expect === "answer-key").every(row => row.speaker === "self")).toBe(true);
    expect(report.violations.filter(text => text.startsWith("out of order"))).toEqual([]);
  });

  it("a topic change and a two-word fragment are not answered", async () => {
    const { report } = await scriptRun(INTERVIEWER);
    const rows = [...rowsOf(report, "topic-change"), ...rowsOf(report, "fragment")];
    expect(rows).toHaveLength(2);
    expect(rows.map(row => [row.attempts, row.timesAnswered, row.finalState])).toEqual([[0, 0, "ignored"], [0, 0, "ignored"]]);
  });

  it(`every answer is readable on the glasses within ${VISIBLE_WITHIN_MS} ms of the provider's first token`, async () => {
    const { report } = await scriptRun(INTERVIEWER);
    const answered = report.rows.filter(row => row.answered && row.via === "answer");
    expect(answered.length).toBeGreaterThanOrEqual(5);
    for (const row of answered) expect(row.msTokenToVisible, `L${row.line} ${row.question}`).toBeLessThanOrEqual(visibleLimit(row));
    expect(report.violations.filter(text => /never shown on the glasses|after the first token/u.test(text))).toEqual([]);
  });

  it("suggested questions appear in interviewer mode (on the phone list)", async () => {
    const { report, timeline } = await scriptRun(INTERVIEWER);
    expect(report.mode).toBe("interviewer");
    expect(report.summary.suggestionChanges).toBeGreaterThanOrEqual(1);
    expect(ofKind(timeline, "suggestions.changed").some(record => record.text.includes("?"))).toBe(true);
  });

  it("a suggested question pops up on the glasses without waking the HUD  [waits for: display, suggestion pop-up; pins: suggestions only show after a double-tap opens the HUD]", async () => {
    const { report, timeline } = await scriptRun(INTERVIEWER);
    expect(report.summary.suggestionsOnGlassesAmbient).toBeGreaterThanOrEqual(1);
    expect(ofKind(timeline, "glasses.suggestion-shown").every(record => record.data?.ambient === true)).toBe(true);
  });

  it("the wearer's question without a question mark gets an answer key  [waits for: answer pipeline / modes, implicit questions; pins: \"I'd like to hear about...\" is not detected at all]", async () => {
    const { report } = await scriptRun(INTERVIEWER);
    const [row] = rowsOf(report, "no-question-mark");
    expect([row!.expect, row!.timesAnswered, row!.finalState]).toEqual(["answer-key", 1, "answered"]);
  });

  it("two questions in one line both get an answer key  [waits for: answer pipeline, queue; pins: only the last question of a line is answered]", async () => {
    const { report } = await scriptRun(INTERVIEWER);
    expect(describeRows(rowsOf(report, "two-questions").filter(row => !row.ok))).toEqual([]);
  });

  it("a rhetorical question from the candidate is not answered and does not cut the answer key in flight  [waits for: answer pipeline, queue and question filter; pins: any later question aborts the current answer]", async () => {
    const { report } = await scriptRun(INTERVIEWER);
    const [rhetorical] = rowsOf(report, "rhetorical");
    expect([rhetorical!.attempts, rhetorical!.timesAnswered]).toEqual([0, 0]);
    expect(report.rows.filter(row => row.finalState === "superseded").map(row => row.question)).toEqual([]);
  });

  it("the whole script runs without a single violation  [waits for: all of the above; pins: the release goal for the interviewer side]", async () => {
    const { report } = await scriptRun(INTERVIEWER);
    expect(report.violations).toEqual([]);
    expect(report.summary.answeredOnce).toBe(report.summary.expectedQuestions);
  });
});

/* =============================================================================================== */

describe("candidate script: the wearer is interviewed (mode id interviewee)", () => {
  it("every line is heard once, in order, with its speaker", async () => {
    const { report, timeline } = await scriptRun(CANDIDATE);
    const script = interviewScript(CANDIDATE)!;
    expect(report.mode).toBe("interviewee");
    expect(ofKind(timeline, "line.heard").map(record => [record.text, record.data?.speaker])).toEqual(script.lines.map(line => [line.text, line.speaker]));
  });

  it("plain, repeated and long questions are each answered exactly once, in order, and shown within 1.5 s", async () => {
    const { report } = await scriptRun(CANDIDATE);
    const rows = ["plain", "repeat", "long-question"].flatMap(tag => rowsOf(report, tag));
    expect(rows).toHaveLength(4);
    expect(describeRows(rows.filter(row => !row.ok))).toEqual([]);
    expect(report.violations.filter(text => text.startsWith("out of order"))).toEqual([]);
    for (const row of rows) expect(row.msTokenToVisible, `L${row.line}`).toBeLessThanOrEqual(visibleLimit(row));
  });

  it("the wearer's own question gets no answer key", async () => {
    const { report, timeline } = await scriptRun(CANDIDATE);
    const own = rowsOf(report, "own-question");
    expect(own).toHaveLength(2);
    expect(own.map(row => [row.speaker, row.detected, row.attempts, row.timesAnswered])).toEqual([["self", true, 0, 0], ["self", true, 0, 0]]);
    // No answer of the run was made for something the wearer said.
    const selfQuestions = new Set(ofKind(timeline, "question.detected").filter(record => record.data?.speaker === "self").map(record => record.id));
    expect(ofKind(timeline, "answer.first-token").filter(record => selfQuestions.has(String(record.data?.questionId)))).toEqual([]);
  });

  it("a topic change and a two-word fragment are not answered", async () => {
    const { report } = await scriptRun(CANDIDATE);
    expect([...rowsOf(report, "topic-change"), ...rowsOf(report, "fragment")].map(row => [row.attempts, row.timesAnswered])).toEqual([[0, 0], [0, 0]]);
  });

  it("a question without a question mark is answered like any other, within 2.5 s  [waits for: answer pipeline, implicit questions; pins: only the copilot's ask lane answers it, 4 s or more later, as a LOOKUP cue]", async () => {
    const { report } = await scriptRun(CANDIDATE);
    const [row] = rowsOf(report, "no-question-mark");
    expect(row!.timesAnswered).toBe(1);
    expect(row!.msToFirstToken).toBeLessThanOrEqual(2500);
  });

  it("two questions in one line are both answered  [waits for: answer pipeline, queue; pins: only the last question of a line is answered]", async () => {
    const { report } = await scriptRun(CANDIDATE);
    expect(describeRows(rowsOf(report, "two-questions").filter(row => !row.ok))).toEqual([]);
  });

  it("the interviewer's rhetorical question right after the wearer's own question is not answered  [waits for: answer pipeline, question filter; pins: every question-shaped sentence from the other side is answered]", async () => {
    const { report } = await scriptRun(CANDIDATE);
    const [rhetorical] = rowsOf(report, "rhetorical");
    expect([rhetorical!.attempts, rhetorical!.timesAnswered]).toEqual([0, 0]);
  });

  it("the whole script runs without a single violation  [waits for: all of the above; pins: the release goal for the candidate side]", async () => {
    const { report } = await scriptRun(CANDIDATE);
    expect(report.violations).toEqual([]);
    expect(report.summary.answeredOnce).toBe(report.summary.expectedQuestions);
  });
});

/* =============================================================================================== */

describe("questions in quick succession", () => {
  const burst = () => arrange("burst", async () => {
    const current = await start({ mode: "interviewee" });
    await drive(current.api.burst(6, 150));
    await vi.advanceTimersByTimeAsync(30_000);
    const report = current.api.report();
    expect(report.summary.linesHeard).toBe(6);
    return report;
  });

  it("burst of 6 alternating lines 150 ms apart: nothing is answered twice and the wearer's own lines get no answer", async () => {
    const report = await burst();
    expect(report.summary.answeredTwice).toBe(0);
    expect(report.rows.filter(row => row.speaker === "self").map(row => row.attempts)).toEqual([0, 0, 0]);
    expect(report.rows.at(-2)!.finalState, "the newest question from the other side is answered").toBe("answered");
  });

  it("burst: every question from the other side is answered once, in order  [waits for: answer pipeline, queue; pins: a new question aborts the answer before it]", async () => {
    const report = await burst();
    expect(describeRows(report.rows.filter(row => !row.ok))).toEqual([]);
    expect(report.violations).toEqual([]);
  });
});

/* =============================================================================================== */

describe("provider faults", () => {
  it("slow first token: no question is lost and the answer on the glasses stays until the next one replaces it", async () => {
    const { report, timeline, firstAnswerId } = await twoQuestions(current => current.api.fault("slow-first-token", { ms: 2500 }));
    expect(describeRows(report.rows.filter(row => !row.ok))).toEqual([]);
    expect(report.rows[1]!.faults).toEqual(["slow-first-token"]);
    expect(report.rows[1]!.msToFirstToken).toBeGreaterThanOrEqual(2500);
    expect(leftBecause(timeline, firstAnswerId)).toBe("replaced");
    expect(report.summary.answersClearedByError).toBe(0);
  });

  it("bad copilot JSON: no question is lost, nothing is shown as an error, and suggestions arrive on the next pass", async () => {
    const current = await start({ mode: "interviewee" });
    await current.api.fault("bad-copilot-json");
    await current.api.say("What does your pipeline look like end to end?", "other", "answer");
    await vi.advanceTimersByTimeAsync(3000);
    expect(current.fake.requests.filter(request => request.schemaName === "helix_copilot").map(request => request.fault)).toEqual(["bad-json"]);
    expect(ofKind(current.api.timeline(), "suggestions.changed")).toEqual([]);
    await current.api.say("How do you test a schema change before it ships?", "other", "answer");
    await vi.advanceTimersByTimeAsync(20_000);
    const report = current.api.report();
    expect(describeRows(report.rows.filter(row => !row.ok))).toEqual([]);
    expect(report.summary.notices).toBe(0);
    expect(report.summary.answersClearedByError).toBe(0);
    expect(ofKind(current.api.timeline(), "notice.shown")).toEqual([]);
    expect(report.summary.suggestionChanges).toBeGreaterThanOrEqual(1);
  });

  it("HTTP 500 once: the question is answered after a retry  [waits for: answer pipeline, retry; pins: one transient failure loses the question]", async () => {
    const { report } = await arrange("500 once", () => twoQuestions(current => current.api.fault("http-500-once")));
    expect(report.rows[1]!.faults).toEqual(["http-500"]);
    expect(describeRows(report.rows.filter(row => !row.ok))).toEqual([]);
  });

  it("HTTP 500 once: the answer already on the glasses stays  [waits for: display, minor errors keep the answer; pins: any error notice clears the answer]", async () => {
    const { report, timeline, firstAnswerId } = await arrange("500 once, display", () => twoQuestions(current => current.api.fault("http-500-once")));
    expect(["replaced", "expired"]).toContain(leftBecause(timeline, firstAnswerId));
    expect(report.summary.answersClearedByError).toBe(0);
  });

  it("malformed stream event: the question is still answered, marked partial  [waits for: answer pipeline, tolerant stream parsing or retry; pins: one bad event fails the whole answer]", async () => {
    const { report } = await arrange("malformed", () => twoQuestions(current => current.api.fault("malformed-event")));
    expect(report.rows[1]!.faults).toEqual(["malformed-event"]);
    // The event was skipped after text had started, so words may be missing: shown once, as a partial answer.
    expect(report.rows.filter(row => !row.ok).map(row => [row.line, row.timesAnswered, row.finalState])).toEqual([[report.rows[1]!.line, 1, "partial"]]);
    expect(report.summary.notices).toBe(0);
  });

  it("malformed stream event: nothing is cleared from the glasses  [waits for: display, minor errors keep the answer; pins: the error wipes the answer that was showing]", async () => {
    const { report, timeline, firstAnswerId } = await arrange("malformed, display", () => twoQuestions(current => current.api.fault("malformed-event")));
    expect(["replaced", "expired"]).toContain(leftBecause(timeline, firstAnswerId));
    expect(report.summary.answersClearedByError).toBe(0);
  });

  it("cut-off answer: what arrived stays on the glasses, marked partial  [waits for: answer pipeline `answer.completed.partial` + display marker; pins: a cut-off answer is dropped with an error]", async () => {
    const current = await arrange("cut-off", async () => {
      const value = await start({ mode: "interviewee" });
      await value.api.fault("cut-off", { afterDeltas: 6 });
      await value.api.say("How do you test a schema change before it ships?", "other", "answer");
      await vi.advanceTimersByTimeAsync(5000);
      expect(value.fake.byIntent("answer").map(request => request.fault)).toEqual(["cut-off"]);
      expect(ofKind(value.api.timeline(), "answer.first-token")).toHaveLength(1);
      return value;
    });
    const timeline = current.api.timeline();
    const [partial] = ofKind(timeline, "answer.partial");
    expect(partial, "answer.completed with partial: true").toBeDefined();
    // The six words that arrived (an added marker such as "…" is fine), not the whole answer.
    expect(partial!.text.split(/\s+/u).length).toBeGreaterThanOrEqual(6);
    expect(partial!.text.split(/\s+/u).length).toBeLessThanOrEqual(8);
    // Five seconds after the cut the text is still there, and the wearer can tell it is incomplete.
    expect(current.recorder.answerOnGlasses()).toBe(partial!.id);
    expect(ofKind(timeline, "glasses.answer-hidden")).toEqual([]);
    const marks = current.recorder.partialMarks(partial!.id!);
    expect(marks.phone || marks.glasses, "marked partial on the phone feed or on the glasses").toBe(true);
    expect(current.api.report().rows[0]!.finalState).toBe("partial");
  });

  it("HTTP 500 on every request: each question fails with a notice on the phone and the glasses, and the session stays up", async () => {
    const { report, timeline, current } = await twoQuestions(value => value.api.fault("http-500-always"));
    await current.api.say("Which metric would you watch first after the release?", "other", "answer");
    await vi.advanceTimersByTimeAsync(20_000);
    const after = current.api.report();
    expect(after.summary.linesHeard).toBe(3);
    expect(after.rows.map(row => row.finalState)).toEqual(["answered", "failed", "failed"]);
    expect(after.summary.status).toBe("listening");
    expect(ofKind(timeline, "notice.shown").map(record => record.data?.where)).toEqual(expect.arrayContaining(["phone", "glasses"]));
    expect(report.summary.lostToFault).toBe(1);
    // Bounded: no retry storm against a provider that is down.
    expect(current.fake.byIntent("answer").filter(request => request.status === 500).length).toBeLessThanOrEqual(8);
  });

  it("HTTP 401: fails at once, visibly, and is not retried", async () => {
    const { report, timeline, current } = await twoQuestions(value => value.api.fault("http-401"));
    expect(report.rows[1]!.finalState).toBe("failed");
    expect(report.rows[1]!.faults).toEqual(["http-401"]);
    expect(report.summary.status).toBe("failed");
    expect(ofKind(timeline, "notice.shown").filter(record => /API key/u.test(record.text)).map(record => record.data?.where)).toContain("phone");
    expect(ofKind(timeline, "notice.shown").map(record => record.data?.where)).toContain("glasses");
    expect(current.fake.byIntent("answer").filter(request => request.status === 401)).toHaveLength(1);
    // The session is over: a later line is refused, and the harness says so instead of throwing.
    await current.api.say("Which metric would you watch first after the release?", "other", "answer");
    expect(ofKind(current.api.timeline(), "notice.shown").at(-1)?.data?.where).toBe("harness");
  });
});

/* =============================================================================================== */

describe("whole scripts under a fault (the fault hits the first answer request)", () => {
  for (const scriptId of [INTERVIEWER, CANDIDATE]) {
    /** Questions that came out right without the fault must come out right with it. */
    const sameAsClean = async (fault: Exclude<FaultKind, "burst">) => {
      const [clean, faulted] = await arrange(`${scriptId} ${fault}`, async () => [await scriptRun(scriptId), await scriptRun(scriptId, fault)] as const);
      const good = (report: InterviewReport) => report.rows.filter(row => row.ok).map(row => `L${row.line} ${row.question}`);
      return { clean, faulted, cleanGood: good(clean.report), faultedGood: good(faulted.report) };
    };
    it(`${scriptId} · slow first token (4 s): no question is lost`, async () => {
      const { faulted, cleanGood, faultedGood } = await sameAsClean("slow-first-token");
      expect(faulted.report.rows.filter(row => row.faults.length).map(row => row.finalState)).toEqual(["answered"]);
      expect(faultedGood).toEqual(cleanGood);
      expect(faulted.report.summary.lostToFault).toBe(0);
    });
    it(`${scriptId} · bad copilot JSON: answers are untouched`, async () => {
      const { faulted, cleanGood, faultedGood } = await sameAsClean("bad-copilot-json");
      expect(faultedGood).toEqual(cleanGood);
      expect(faulted.report.summary.notices).toBe(0);
    });
    it(`${scriptId} · HTTP 500 once: no question is lost  [waits for: answer pipeline, retry; pins: the first question of the interview is lost to one failed request]`, async () => {
      const { faulted, cleanGood, faultedGood } = await sameAsClean("http-500-once");
      expect(faulted.report.summary.lostToFault).toBe(0);
      expect(faultedGood).toEqual(cleanGood);
    });
    it(`${scriptId} · malformed stream event: no question is lost  [waits for: answer pipeline, tolerant stream parsing or retry; pins: one bad event loses the question]`, async () => {
      const { faulted, cleanGood, faultedGood } = await sameAsClean("malformed-event");
      // The event is skipped after text started, so that one answer is kept as partial (words may be missing).
      const hit = faulted.report.rows.filter(row => row.faults.includes("malformed-event"));
      expect(hit.map(row => [row.timesAnswered, row.finalState])).toEqual([[1, "partial"]]);
      expect(faulted.report.summary.answersClearedByError).toBe(0);
      expect(faultedGood).toEqual(cleanGood.filter(label => label !== `L${hit[0]!.line} ${hit[0]!.question}`));
    });
    it(`${scriptId} · cut-off answer: kept as partial, every other question as in the clean run  [waits for: answer pipeline, partial answers; pins: the cut-off answer is discarded]`, async () => {
      const { faulted, cleanGood, faultedGood } = await sameAsClean("cut-off");
      const hit = faulted.report.rows.filter(row => row.faults.includes("cut-off"));
      expect(hit.map(row => row.finalState)).toEqual(["partial"]);
      expect(faulted.report.summary.answersClearedByError).toBe(0);
      expect(faultedGood).toEqual(cleanGood.filter(label => label !== `L${hit[0]!.line} ${hit[0]!.question}`));
    });
  }
  it("the fault names of the harness are the ones the page offers", () => {
    expect([...FAULT_KINDS]).toEqual(["slow-first-token", "http-500-once", "http-500-always", "http-401", "malformed-event", "cut-off", "bad-copilot-json", "burst"]);
  });
});

/* =============================================================================================== */

describe("audio path: fake microphone PCM and a fake speech-to-text socket carry the script", () => {
  const audio = (speed: number) => scriptRun(CANDIDATE, undefined, { path: "audio", speed }, { audio: true });

  it("turn detection and speaker roles run: every line is heard with the role its audio frames carried", async () => {
    const { report, timeline } = await audio(1);
    const script = interviewScript(CANDIDATE)!;
    expect(report.path).toBe("audio");
    expect(report.summary.linesHeard).toBe(script.lines.length);
    for (const record of ofKind(timeline, "line.heard")) {
      const line = script.lines[Number(record.data?.line) - 1];
      if (line) expect(record.data?.speaker, record.text).toBe(line.speaker);
    }
    // In order: the pieces of every line, joined, are the script.
    const words = (text: string) => text.split(/\s+/u).filter(Boolean);
    expect(ofKind(timeline, "line.heard").flatMap(record => words(record.text))).toEqual(script.lines.flatMap(line => words(line.text)));
  });

  it("lines shorter than six seconds come out as they do when typed", async () => {
    const [{ report: spoken }, { report: typed }] = [await audio(1), await scriptRun(CANDIDATE)];
    const pick = (report: InterviewReport) => ["plain", "two-questions", "own-question", "rhetorical", "repeat", "fragment", "topic-change"].flatMap(tag => rowsOf(report, tag)).map(row => [row.line, row.question, row.timesAnswered, row.finalState]);
    expect(pick(spoken)).toEqual(pick(typed));
    for (const row of spoken.rows.filter(item => item.answered && item.via === "answer")) expect(row.msTokenToVisible).toBeLessThanOrEqual(visibleLimit(row));
  });

  it("a line spoken for longer than six seconds stays one turn  [waits for: nobody yet (reported); pins: HelixConversationClient.sendAudio commits every 6 s of audio, so long questions reach question detection in pieces]", async () => {
    const { report, timeline } = await audio(1);
    const script = interviewScript(CANDIDATE)!;
    expect(ofKind(timeline, "line.heard")).toHaveLength(script.lines.length);
    expect(describeRows(rowsOf(report, "long-question").filter(row => !row.ok))).toEqual([]);
  });
});

/* =============================================================================================== */

describe("harness", () => {
  it("say() lines without an expectation are reported and never counted as violations", async () => {
    const current = await start({ mode: "interviewee" });
    await current.api.say("Could you describe your on-call setup?", "unknown");
    await vi.advanceTimersByTimeAsync(4000);
    await current.api.setMode("interviewer");
    await current.api.say("What was the hardest incident you handled?", "self");
    await vi.advanceTimersByTimeAsync(12_000);
    const report = current.api.report(), timeline = current.api.timeline();
    expect(report.rows.map(row => [row.speaker, row.expect, row.finalState])).toEqual([["unknown", "unspecified", "answered"], ["self", "unspecified", "answered"]]);
    expect(report.violations).toEqual([]);
    expect(report.mode).toBe("interviewer");
    // Ordered records of every kind the report is built from.
    expect(timeline.map(record => record.t)).toEqual([...timeline.map(record => record.t)].sort((a, b) => a - b));
    expect([...new Set(timeline.map(record => record.kind))]).toEqual(expect.arrayContaining(["line.heard", "question.detected", "answer.first-token", "answer.completed", "glasses.answer-visible", "glasses.answer-hidden", "mode.changed"]));
    const visible = ofKind(timeline, "glasses.answer-visible")[0]!, token = ofKind(timeline, "answer.first-token")[0]!;
    expect(visible.id).toBe(token.id);
    expect(visible.t).toBeGreaterThanOrEqual(token.t);
  });

  it("the answer is still on the glasses within 1.5 s when every glasses write takes 250 ms", async () => {
    const current = await start({ mode: "interviewee", writeMs: 250 });
    await current.api.say("What does your pipeline look like end to end?", "other", "answer");
    await vi.advanceTimersByTimeAsync(6000);
    const [row] = current.api.report().rows;
    expect(row!.finalState).toBe("answered");
    expect(row!.msTokenToVisible).toBeGreaterThanOrEqual(250);
    expect(row!.msTokenToVisible).toBeLessThanOrEqual(VISIBLE_WITHIN_MS);
  });

  // INTERVIEW_BASELINE_DIR=/some/dir npx vitest run tests/interview-scenario.test.ts -t "baseline"
  it.runIf(!!process.env.INTERVIEW_BASELINE_DIR)("writes the baseline reports (both scripts, clean and under each fault, typed and audio)", async () => {
    const directory = process.env.INTERVIEW_BASELINE_DIR!;
    mkdirSync(directory, { recursive: true });
    for (const scriptId of [INTERVIEWER, CANDIDATE]) {
      for (const fault of [undefined, ...FAULT_KINDS.filter(kind => kind !== "burst")] as const) {
        const { report, timeline } = await scriptRun(scriptId, fault as Exclude<FaultKind, "burst"> | undefined);
        writeFileSync(join(directory, `vitest-${scriptId}-${fault ?? "clean"}.json`), JSON.stringify({ report, timeline }, null, 1));
      }
      const spoken = await scriptRun(scriptId, undefined, { path: "audio", speed: 1 }, { audio: true });
      writeFileSync(join(directory, `vitest-${scriptId}-audio.json`), JSON.stringify(spoken, null, 1));
    }
  });

  it("no it.fails test above failed while it was still being arranged", () => {
    expect(wrongReasons).toEqual([]);
  });
});
