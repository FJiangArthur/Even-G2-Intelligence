// Interview harness: the PRODUCTION app (bootstrap) in a plain desktop browser, on a fake G2 bridge and the
// fake provider. No key, no network, no glasses. It plays interview scripts through the real pipeline, injects
// provider faults, and reports per question whether and when an answer reached the (fake) glasses.
//
//   window.__interview   play / say / setMode / fault / burst / timeline / report (see tests/interview-harness.ts)
//   window.__interviewResult   promise of the report of an autoplay run
//
// URL flags:
//   ?script=interview-interviewer | interview-candidate | any rehearsal script id
//   ?mode=interviewer | interviewee | ...   mode to start in (a script switches to its own mode when played)
//   ?speed=4            pauses between lines divided by this (audio path: word pace too)
//   ?path=audio         fake microphone PCM + fake speech-to-text socket instead of typed lines
//   ?fault=http-500-once,slow-first-token:2500,burst:6:150     faults to inject before playing
//   ?autoplay=1         inject the faults, play the script, log INTERVIEW_DONE
//   ?writeMs=150        time one glasses write takes (default 0)
//   ?settle=12000       wait after the last line before the run counts as done
import { DirectConversationTransport, PICKER_MODES, modeProfile, type Speaker } from "@helix/conversation-sdk";
import { bootstrap } from "../src/app";
import { createFakeOpenAI } from "../tests/fake-openai";
import {
  FAULT_KINDS, InterviewRecorder, createFakeGlasses, createInterviewApi, createScriptedSpeech,
  type Expectation, type FaultKind, type FaultOptions, type InterviewReport, type InterviewRole,
} from "../tests/interview-harness";
import "../src/styles.css";

const params = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const errors: string[] = [];
window.addEventListener("error", event => errors.push(String(event.message)));
window.addEventListener("unhandledrejection", event => errors.push(String((event.reason as Error | undefined)?.message ?? event.reason)));

// ---- fakes: provider, glasses, microphone and speech-to-text ----
const fake = createFakeOpenAI({ latency: { firstTokenMs: 400, interTokenMs: 40, jsonMs: 900, webSearchMs: 1200, realtimeMs: 300 } });
const holder: { transport?: DirectConversationTransport; ambient?: () => boolean } = {};
const recorder = new InterviewRecorder({ fake, ambient: () => holder.ambient?.() ?? false });
const speech = createScriptedSpeech(event => glasses.emit(event));
const glasses = createFakeGlasses({ onScreen: recorder.onScreen, onMic: open => speech.micOpen(open), writeMs: Number(params.get("writeMs") ?? "0") || 0 });

// ---- the real app ----
const app = await bootstrap($("app"), glasses.bridge, {
  search: `?${params.toString()}`,
  transportFactory: options => {
    const transport = new DirectConversationTransport({ ...options, fetch: fake.fetch, webSocketFactory: speech.webSocketFactory as never });
    transport.subscribe(recorder.onEvent);
    holder.transport = transport;
    return transport;
  },
});
holder.ambient = () => (app.renderer as { ambient?: boolean }).ambient === true;
app.presentation.subscribe(recorder.onSnapshot);
$<HTMLInputElement>("openai-api-key").value = "qa-fake-key";
$<HTMLButtonElement>("connect-button").click();
for (let i = 0; i < 100 && $<HTMLButtonElement>("start-button").disabled; i++) await new Promise(done => setTimeout(done, 50));
$<HTMLButtonElement>("start-button").click();
await new Promise(done => setTimeout(done, 300));

const api = createInterviewApi({
  recorder, fake, speech,
  inject: (text: string, speaker: Speaker) => holder.transport ? holder.transport.injectTranscript(text, speaker) : Promise.reject(new Error("not connected")),
  setMode: id => app.controller.setMode(id as Parameters<typeof app.controller.setMode>[0]),
  runCopilot: () => app.controller.runCopilot(),
});
const startMode = params.get("mode");
recorder.reset();
recorder.noteMode(app.controller.mode);
if (startMode) await api.setMode(startMode);

/** "http-500-once", "slow-first-token:2500", "burst:6:150", "cut-off:4" -> a fault() call. */
function applyFault(spec: string): Promise<void> {
  const [kind, first, second] = spec.split(":");
  if (kind !== "none" && !(FAULT_KINDS as readonly string[]).includes(kind ?? "")) throw new Error(`Unknown fault: ${spec}`);
  const a = first === undefined ? undefined : Number(first), b = second === undefined ? undefined : Number(second);
  const options: FaultOptions = kind === "slow-first-token" ? { ...(a ? { ms: a } : {}) }
    : kind === "burst" ? { ...(a ? { n: a } : {}), ...(b ? { gapMs: b } : {}) }
      : kind === "malformed-event" || kind === "cut-off" ? { ...(a ? { afterDeltas: a } : {}) } : {};
  return api.fault(kind as FaultKind | "none", options);
}

// ---- test-only panel ----
const scriptSelect = $<HTMLSelectElement>("iv-script"), modeSelect = $<HTMLSelectElement>("iv-mode");
for (const script of api.scripts) scriptSelect.add(new Option(`${script.title} (${script.lines} lines)`, script.id));
scriptSelect.value = api.scripts.some(script => script.id === params.get("script")) ? params.get("script")! : "interview-interviewer";
for (const mode of [...new Set([...PICKER_MODES, "interviewee"])]) modeSelect.add(new Option(`${modeProfile(mode).label} (${mode})`, mode));
const speedSelect = $<HTMLSelectElement>("iv-speed"), pathSelect = $<HTMLSelectElement>("iv-path");
if (params.get("speed")) { if (![...speedSelect.options].some(option => option.value === params.get("speed"))) speedSelect.add(new Option(params.get("speed")!, params.get("speed")!)); speedSelect.value = params.get("speed")!; }
if (params.get("path") === "audio") pathSelect.value = "audio";
const settleMs = params.get("settle") ? Number(params.get("settle")) : undefined;
const play = () => api.play(scriptSelect.value, { speed: Number(speedSelect.value) || 1, path: pathSelect.value === "audio" ? "audio" : "typed", ...(settleMs !== undefined ? { settleMs } : {}) });
const note = (text: string) => { $("iv-state").textContent = text; };
$("iv-play").addEventListener("click", () => { void play().catch(error => note(String(error instanceof Error ? error.message : error))); });
$("iv-stop").addEventListener("click", () => api.stop());
modeSelect.addEventListener("change", () => { void api.setMode(modeSelect.value); });
const sayLine = () => {
  const input = $<HTMLInputElement>("iv-text"), text = input.value.trim();
  if (!text) return;
  input.value = "";
  void api.say(text, $<HTMLSelectElement>("iv-speaker").value as InterviewRole);
};
$("iv-say").addEventListener("click", sayLine);
$("iv-text").addEventListener("keydown", event => { if (event.key === "Enter") sayLine(); });
const FAULT_LABELS: Readonly<Record<FaultKind | "none", string>> = {
  "slow-first-token": "Slow first token (4 s)", "http-500-once": "HTTP 500 once", "http-500-always": "HTTP 500 always", "http-401": "HTTP 401",
  "malformed-event": "Malformed stream event", "cut-off": "Cut-off answer", "bad-copilot-json": "Bad copilot JSON", burst: "Burst 6 × 150 ms", none: "Clear faults",
};
for (const kind of [...FAULT_KINDS, "none"] as const) {
  const button = document.createElement("button");
  button.type = "button"; button.textContent = FAULT_LABELS[kind]; button.dataset.fault = kind;
  button.addEventListener("click", () => { void api.fault(kind).catch(error => note(String(error instanceof Error ? error.message : error))); });
  $("iv-faults").append(button);
}
const copy = (value: unknown) => { void navigator.clipboard?.writeText(JSON.stringify(value, null, 1)).then(() => note("copied"), () => note("copy failed: use __interview.report() in the console")); };
$("iv-copy").addEventListener("click", () => copy(api.report()));
$("iv-copy-timeline").addEventListener("click", () => copy(api.timeline()));

const cell = (text: string, className = "") => { const td = document.createElement("td"); td.textContent = text; if (className) td.className = className; return td; };
const EXPECT_LABEL: Readonly<Record<Expectation | "unspecified", string>> = { answer: "answer", "answer-key": "key", none: "none", unspecified: "–" };
function render(): void {
  const report = api.report(), summary = report.summary;
  if (document.activeElement !== modeSelect) modeSelect.value = report.mode;
  $("iv-summary").textContent = `${report.script ?? "no script"} · mode ${report.mode} · ${summary.linesHeard}/${summary.linesExpected} lines · ${summary.answeredOnce}/${summary.expectedQuestions} answered once · missed ${summary.missed} · twice ${summary.answeredTwice} · unexpected ${summary.unexpectedAnswers} · lost to fault ${summary.lostToFault}`
    + ` · median to glasses ${summary.medianMsToVisible ?? "–"} ms · suggestions on glasses ${summary.suggestionsOnGlassesAmbient}${report.faults.length ? ` · faults: ${report.faults.join(", ")}` : ""}`;
  $("iv-rows").replaceChildren(...report.rows.map(row => {
    const tr = document.createElement("tr");
    if (!row.ok) tr.className = "bad";
    const question = cell(row.question, "q");
    if (row.case) { const tag = document.createElement("small"); tag.textContent = row.case; question.append(tag); }
    tr.append(cell(String(row.line || "–")), question, cell(row.speaker), cell(EXPECT_LABEL[row.expect]), cell(String(row.timesAnswered), "n"),
      cell(row.msToFirstToken === undefined ? "–" : String(row.msToFirstToken), "n"), cell(row.msToVisible === undefined ? "–" : String(row.msToVisible), "n"),
      cell(`${row.finalState.replace("-", " ")}${row.via === "copilot-ask" ? " (ask)" : ""}${row.faults.length ? ` · ${row.faults.join(" + ").replace(/-/gu, " ")}` : ""}`, "s"));
    return tr;
  }));
  $("iv-violations").replaceChildren(...report.violations.map(text => { const li = document.createElement("li"); li.textContent = text; return li; }));
  if (api.state === "playing") note(`playing ${report.script ?? ""} · ${summary.linesHeard}/${summary.linesExpected}`);
  else if (api.state === "done") note(`done · ${report.violations.length} violation(s)`);
}
note("ready");
setInterval(render, 1000);
render();

// ---- window API and autoplay ----
const harness = Object.assign(api, { fake, recorder, errors, glasses: () => Object.fromEntries(glasses.containers) });
(window as unknown as { __interview: typeof harness }).__interview = harness;
const autoplay = async (): Promise<InterviewReport> => {
  const faults = (params.get("fault") ?? "").split(",").map(item => item.trim()).filter(Boolean);
  const bursts = faults.filter(item => item.startsWith("burst"));
  for (const item of faults.filter(item => !item.startsWith("burst"))) await applyFault(item);
  for (const item of bursts) await applyFault(item);
  if (params.get("script")) return play();
  await new Promise(done => setTimeout(done, settleMs ?? 12_000));
  return api.report();
};
if (params.get("autoplay") === "1") {
  const result = autoplay();
  (window as unknown as { __interviewResult: Promise<InterviewReport> }).__interviewResult = result;
  void result.then(report => { render(); console.log("INTERVIEW_DONE", JSON.stringify(report.summary)); }, error => { note(String(error)); console.log("INTERVIEW_FAILED", String(error)); });
} else {
  for (const item of (params.get("fault") ?? "").split(",").map(value => value.trim()).filter(value => value && !value.startsWith("burst"))) await applyFault(item);
}
console.log("INTERVIEW_READY");
