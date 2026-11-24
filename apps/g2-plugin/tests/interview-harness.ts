/**
 * Interview scenario harness, shared by qa/interview.ts (the real app in a desktop browser) and
 * tests/interview-scenario.test.ts (vitest, fake timers). Test-only: nothing here ships in the plugin.
 *
 * It has four parts:
 *  - INTERVIEW_SCRIPTS: the scripts of src/rehearsal-scripts.json with their per-line expectations;
 *  - createFakeGlasses(): a G2 bridge that keeps what every text container shows right now;
 *  - createScriptedSpeech(): fake microphone PCM plus a fake realtime speech-to-text socket that carries
 *    a script line word by word, so turn detection and speaker roles run;
 *  - InterviewRecorder: builds the timeline and the per-question report from what the app did;
 *  - createInterviewApi(): play / say / setMode / fault / burst on top of the above.
 *
 * No DOM, no network, no key. The fake provider's answers are templated, so the harness measures
 * whether and when a question was answered and shown, never how good the answer is.
 */
import {
  AudioEvent, AudioInputSource, AudioSpeakerRole, ImageRawDataUpdateResult, StartUpPageCreateResult, type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import type { GatewayEvent, Speaker } from "@helix/conversation-sdk";
import type { G2BridgePort } from "../src/controller";
import type { PresentationSnapshot } from "../src/presentation";
import { defaultPauseMs } from "../src/rehearsal";
import scriptData from "../src/rehearsal-scripts.json";
import type { FakeFault, FakeOpenAI } from "./fake-openai";

/* ------------------------------------------------------------------ */
/* Scripts                                                             */
/* ------------------------------------------------------------------ */

export type InterviewRole = "self" | "other" | "unknown";
/** What should happen to a line: one answer per expected question, an answer key for the wearer's own question, or nothing. */
export type Expectation = "answer" | "answer-key" | "none";
export interface InterviewLine {
  readonly speaker: InterviewRole;
  readonly text: string;
  readonly pauseMs?: number;
  /** Awkward case this line stands for, e.g. "two-questions", "rhetorical", "repeat". */
  readonly case?: string;
  /** Undefined only for ad-hoc `say()` lines: reported, never a violation. */
  readonly expect?: Expectation;
  /** Substrings of the questions this line should be answered for (one answer each). */
  readonly questions?: readonly string[];
}
export interface InterviewScript {
  readonly id: string;
  readonly title: string;
  /** Conversation mode id the script is written for ("interviewer", "interviewee" = Candidate, ...). */
  readonly mode: string;
  readonly lines: readonly InterviewLine[];
}
interface RawScript {
  id: string; title: string; kind: string; mode?: string;
  lines: { speaker: string; text: string; pauseMs?: number; case?: string; expect?: string; questions?: string[] }[];
  expectations: { questions?: string[] };
}
const role = (value: string): InterviewRole => value === "self" || value === "other" ? value : "unknown";

/** Every rehearsal script. The older ones carry no per-line outcome: it is derived from `expectations.questions`. */
export const INTERVIEW_SCRIPTS: readonly InterviewScript[] = Object.freeze((scriptData as unknown as RawScript[]).map(raw => ({
  id: raw.id, title: raw.title,
  mode: raw.mode ?? (raw.kind === "interview" ? "interviewee" : "general"),
  lines: raw.lines.map((line): InterviewLine => {
    if (line.expect === "answer" || line.expect === "answer-key" || line.expect === "none") {
      return { speaker: role(line.speaker), text: line.text, expect: line.expect, ...(line.pauseMs ? { pauseMs: line.pauseMs } : {}), ...(line.case ? { case: line.case } : {}), ...(line.questions ? { questions: line.questions } : {}) };
    }
    const needles = line.speaker === "other" ? (raw.expectations.questions ?? []).filter(needle => line.text.includes(needle)) : [];
    return { speaker: role(line.speaker), text: line.text, expect: needles.length ? "answer" : "none", ...(line.pauseMs ? { pauseMs: line.pauseMs } : {}), ...(needles.length ? { questions: needles } : {}) };
  }),
})));
export function interviewScript(id: string): InterviewScript | undefined { return INTERVIEW_SCRIPTS.find(script => script.id === id); }

export const SPEAKERS: Readonly<Record<InterviewRole, Speaker>> = Object.freeze({
  self: Object.freeze({ label: "You", role: "self" as const }),
  other: Object.freeze({ label: "Other speaker", role: "other" as const }),
  unknown: Object.freeze({ label: "Speaker", role: "unknown" as const }),
});

/** Letters and digits only, lower case: survives wrapping, paging, quotes and trimmed punctuation. */
export const alnum = (text: string): string => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/* ------------------------------------------------------------------ */
/* Fake glasses                                                        */
/* ------------------------------------------------------------------ */

export interface FakeGlassesOptions {
  /** Time one glasses write takes (a real G2 link needs roughly 100 to 300 ms). Default 0. */
  readonly writeMs?: number;
  /** After every accepted page or text write: container name -> text it shows now. */
  readonly onScreen?: (containers: ReadonlyMap<string, string>) => void;
  readonly onMic?: (open: boolean) => void;
}
export interface FakeGlasses {
  readonly bridge: G2BridgePort & { rebuildPageContainer(page: unknown): Promise<boolean> };
  readonly storage: Map<string, string>;
  readonly containers: ReadonlyMap<string, string>;
  /** Text writes and page builds so far. */
  readonly writes: { text: number; pages: number; images: number };
  /** Deliver an Even Hub event (audio, gesture) to the app. */
  emit(event: object): void;
}
export function createFakeGlasses(options: FakeGlassesOptions = {}): FakeGlasses {
  const storage = new Map<string, string>(), containers = new Map<string, string>();
  const listeners = new Set<(event: EvenHubEvent) => void>();
  const writes = { text: 0, pages: 0, images: 0 };
  const wait = () => options.writeMs ? new Promise<void>(done => setTimeout(done, options.writeMs)) : Promise.resolve();
  const page = async (value: unknown) => {
    await wait();
    writes.pages++;
    containers.clear();
    for (const text of (value as { textObject?: { containerName?: string; content?: string }[] }).textObject ?? []) if (text.containerName) containers.set(text.containerName, text.content ?? "");
    options.onScreen?.(containers);
  };
  const bridge = {
    getLocalStorage: async (key: string) => storage.get(key) ?? "",
    setLocalStorage: async (key: string, value: string) => { storage.set(key, value); return true; },
    createStartUpPageContainer: async (value: unknown) => { await page(value); return StartUpPageCreateResult.success; },
    rebuildPageContainer: async (value: unknown) => { await page(value); return true; },
    textContainerUpgrade: async (update: { containerName?: string; content?: string }) => {
      await wait();
      writes.text++;
      if (update.containerName) containers.set(update.containerName, update.content ?? "");
      options.onScreen?.(containers);
      return true;
    },
    updateImageRawData: async () => { writes.images++; return ImageRawDataUpdateResult.success; },
    shutDownPageContainer: async () => true,
    onEvenHubEvent: (callback: (event: EvenHubEvent) => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; },
    audioControl: async (open: boolean) => { options.onMic?.(open); return true; },
  };
  return { bridge: bridge as unknown as FakeGlasses["bridge"], storage, containers, writes, emit: event => { for (const listener of [...listeners]) listener(event as EvenHubEvent); } };
}

/* ------------------------------------------------------------------ */
/* Scripted speech: fake microphone + fake realtime speech-to-text     */
/* ------------------------------------------------------------------ */

export interface ScriptedSpeech {
  /** Pass as the transport's webSocketFactory. */
  readonly webSocketFactory: () => unknown;
  /** Wire to the fake bridge's onMic: 20 ms PCM frames flow while the microphone is open. */
  micOpen(open: boolean): void;
  /** Speak one line: loud PCM with the speaker's role while its words arrive one by one, then silence until the turn is transcribed. */
  speak(text: string, speaker: InterviewRole, wordMs?: number): Promise<void>;
  readonly stats: { frames: number; commits: number };
}
export function createScriptedSpeech(emit: (event: object) => void, sleep: (ms: number) => Promise<void> = ms => new Promise(done => setTimeout(done, ms))): ScriptedSpeech {
  const state = { speaking: false, role: undefined as AudioSpeakerRole | undefined };
  const stats = { frames: 0, commits: 0 };
  let timer: ReturnType<typeof setInterval> | undefined, said = "", item = 0, seed = 12345;
  let transcribed: (() => void) | undefined;
  const sockets = new Set<SttSocket>();
  // Deterministic noise (the app only looks at loudness): same frames on every run.
  const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  class SttSocket {
    public readyState = 0;
    public onopen: (() => void) | null = null;
    public onmessage: ((event: { data: string }) => void) | null = null;
    public onerror: (() => void) | null = null;
    public onclose: (() => void) | null = null;
    public constructor() { sockets.add(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 20); }
    public emit(event: object): void { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(event) }); }
    public send(data: string): void {
      const message = JSON.parse(data) as { type?: string };
      if (message.type !== "input_audio_buffer.commit") return;
      stats.commits++;
      const id = `item_${item++}`, text = said.trim();
      said = "";
      // Never answer inside send(): a real socket replies later, and the transcriber registers the turn
      // only after its commit was sent (a synchronous reply would pair every transcript with the next turn).
      setTimeout(() => this.emit({ type: "input_audio_buffer.committed", item_id: id }), 5);
      setTimeout(() => {
        this.emit({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: text });
        const done = transcribed; transcribed = undefined; done?.();
      }, 300);
    }
    public close(): void { this.readyState = 3; sockets.delete(this); }
  }
  const frame = () => {
    const pcm = new Int16Array(320);
    // Speech has short gaps (60 ms in every 400 ms here). Without them the app's noise floor rises to the
    // steady level after about 8 s and it takes the rest of a long line for background noise.
    if (state.speaking && stats.frames % 20 < 17) for (let i = 0; i < pcm.length; i++) pcm[i] = noise() * 6000;
    stats.frames++;
    emit({ audioEvent: new AudioEvent({ audioPcm: new Uint8Array(pcm.buffer), source: AudioInputSource.Glasses, ...(state.role === undefined ? {} : { speakerRole: state.role }) }) });
  };
  return {
    webSocketFactory: () => new SttSocket(),
    stats,
    micOpen(open) { clearInterval(timer); timer = open ? setInterval(frame, 20) : undefined; },
    async speak(text, speaker, wordMs = 400) {
      const words = text.trim().split(/\s+/u).filter(Boolean);
      if (!words.length) return;
      state.role = speaker === "self" ? AudioSpeakerRole.Self : speaker === "other" ? AudioSpeakerRole.Other : undefined;
      state.speaking = true;
      // A two-word fragment still needs enough loud audio to count as speech.
      const pace = Math.max(wordMs, 700 / words.length);
      for (const word of words) {
        await sleep(pace);
        said += ` ${word}`;
        for (const socket of sockets) socket.emit({ type: "conversation.item.input_audio_transcription.delta", item_id: `item_${item}`, delta: ` ${word}` });
      }
      state.speaking = false;
      // Silence now: the app's own turn detection commits; the socket answers with the whole line.
      await new Promise<void>(resolve => {
        const giveUp = setTimeout(() => { transcribed = undefined; resolve(); }, 6000);
        transcribed = () => { clearTimeout(giveUp); resolve(); };
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* Timeline and report                                                 */
/* ------------------------------------------------------------------ */

export type TimelineKind =
  | "line.heard" | "question.detected"
  | "answer.first-token" | "answer.completed" | "answer.partial" | "answer.failed"
  | "glasses.answer-visible" | "glasses.answer-hidden"
  | "suggestions.changed" | "glasses.suggestion-shown"
  | "notice.shown" | "ask.answered" | "fault.injected" | "mode.changed";
export interface TimelineRecord {
  /** Milliseconds since the recorder started. */
  readonly t: number;
  readonly kind: TimelineKind;
  readonly text: string;
  /** Transcript, question, answer or suggestion id, depending on the kind. */
  readonly id?: string;
  readonly data?: Readonly<Record<string, string | number | boolean>>;
}
export type FinalState = "answered" | "partial" | "failed" | "superseded" | "streaming" | "not-answered" | "not-detected" | "ignored";
export interface QuestionRow {
  /** 1-based line number in the run (0 when the question belongs to no spoken line). */
  readonly line: number;
  readonly case?: string;
  readonly question: string;
  readonly speaker: InterviewRole;
  readonly expect: Expectation | "unspecified";
  readonly detected: boolean;
  readonly answered: boolean;
  /** Answers that finished (complete or cut off) for this question. */
  readonly timesAnswered: number;
  /** Answer requests that produced at least one token. */
  readonly attempts: number;
  /** "copilot-ask": not detected as a question, answered later through the copilot's implicit-ask lane. */
  readonly via?: "answer" | "copilot-ask";
  /** Line heard -> first answer token. */
  readonly msToFirstToken?: number;
  /** Line heard -> answer text on the glasses. */
  readonly msToVisible?: number;
  /** First answer token -> answer text on the glasses. */
  readonly msTokenToVisible?: number;
  /** The display was showing an earlier answer when this one started arriving, so it waited its turn. */
  readonly heldBehindAnswer?: boolean;
  readonly finalState: FinalState;
  /** Injected faults that hit an answer request for this question. */
  readonly faults: readonly string[];
  readonly ok: boolean;
}
export interface InterviewReport {
  readonly script?: string;
  readonly mode: string;
  readonly path: "typed" | "audio" | "mixed";
  readonly speed: number;
  readonly faults: readonly string[];
  readonly rows: readonly QuestionRow[];
  readonly violations: readonly string[];
  readonly summary: {
    readonly linesExpected: number; readonly linesHeard: number;
    readonly expectedQuestions: number; readonly answeredOnce: number; readonly missed: number; readonly answeredTwice: number;
    readonly unexpectedAnswers: number; readonly lostToFault: number;
    readonly medianMsToFirstToken?: number; readonly medianMsToVisible?: number; readonly maxMsTokenToVisible?: number;
    readonly answersClearedByError: number; readonly partialAnswers: number;
    readonly suggestionChanges: number; readonly suggestionsOnGlasses: number; readonly suggestionsOnGlassesAmbient: number;
    readonly notices: number; readonly status: string;
    readonly providerRequests: number; readonly answerRequests: number;
  };
}


interface TrackedLine extends InterviewLine { readonly index: number; heardAt?: number; transcripts: string[]; heard: string }
interface TrackedQuestion { readonly id: string; readonly text: string; readonly t: number; readonly role: InterviewRole; readonly transcriptId?: string; readonly trigger?: string }
interface TrackedAnswer {
  readonly id: string; readonly questionId?: string; readonly role: InterviewRole; readonly trigger?: string; readonly firstTokenAt: number;
  text: string; completedAt?: number; partial?: boolean; failedAt?: number;
}
interface ScreenEntry { readonly t: number; readonly body: string; readonly title: string; readonly status: string; readonly ambient: boolean; readonly answerId?: string }
/** What the fake provider did with the answer requests of one question. */
interface RequestInfo { readonly faults: Set<string>; failedAt?: number; failure?: string; requests: number }

/** The answer must be readable this soon after the provider's first token. */
export const VISIBLE_WITHIN_MS = 1500;
/** An answer that arrives while an earlier one is still being read waits for it; it must still appear within this. */
export const HELD_WITHIN_MS = 12_000;
export function visibleLimit(row: { readonly heldBehindAnswer?: boolean }): number { return row.heldBehindAnswer ? HELD_WITHIN_MS : VISIBLE_WITHIN_MS; }
/** How a cut-off answer may be marked (phone label / meta, glasses title / status / body). */
export const PARTIAL_WORDING = /\b(?:partial|cut[ -]?off|cut short|incomplete|interrupted|unfinished)\b/iu;
const BODY_CONTAINERS = ["hud-body", "helix-main"];
/** Lines of the one container of the hidden-display page (glasses-hud.ts AMBIENT_LINES). */
const AMBIENT_ROWS = 10;
const median = (values: number[]): number | undefined => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
};

export interface InterviewRecorderOptions {
  readonly now?: () => number;
  /** True while the glasses show the blank ambient page (GlassesHud.ambient). */
  readonly ambient?: () => boolean;
  /** The fake provider: its request log says which question a failed or faulted request belonged to. Must share the recorder's clock. */
  readonly fake?: Pick<FakeOpenAI, "requests">;
}

export class InterviewRecorder {
  public mode = "general";
  public script?: string;
  public speed = 1;
  private readonly now: () => number;
  private started: number;
  private lines: TrackedLine[] = [];
  private readonly transcriptLine = new Map<string, number>();
  private questions: TrackedQuestion[] = [];
  private answers: TrackedAnswer[] = [];
  private errors: { t: number; code: string; message: string; fatal: boolean }[] = [];
  private screens: ScreenEntry[] = [];
  private raw: TimelineRecord[] = [];
  private readonly suggestionText = new Map<string, { text: string; t: number }>();
  private suggestionKey = "";
  private suggestionChanges = 0;
  private readonly asksDone = new Map<string, { id: string; t: number; trigger: string; kind: string; answer: string }>();
  private readonly markedPartial = new Set<string>();
  private readonly paths = new Set<"typed" | "audio">();
  private readonly faultNames: string[] = [];
  private presentationAnswerId?: string;
  private lastError?: string;
  private status = "ready";

  public constructor(private readonly options: InterviewRecorderOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.started = this.now();
    this.onEvent = this.onEvent.bind(this);
    this.onSnapshot = this.onSnapshot.bind(this);
    this.onScreen = this.onScreen.bind(this);
  }

  private t(): number { return Math.round(this.now() - this.started); }
  private add(kind: TimelineKind, text: string, id?: string, data?: TimelineRecord["data"]): void {
    this.raw.push({ t: this.t(), kind, text, ...(id ? { id } : {}), ...(data ? { data } : {}) });
  }

  /** Forget everything recorded so far (a new run on the same page). */
  public reset(): void {
    this.started = this.now();
    this.lines = []; this.transcriptLine.clear(); this.questions = []; this.answers = []; this.errors = []; this.screens = []; this.raw = [];
    this.suggestionText.clear(); this.suggestionKey = ""; this.suggestionChanges = 0; this.asksDone.clear(); this.markedPartial.clear();
    this.paths.clear(); this.faultNames.length = 0; this.script = undefined;
  }

  /** A line that is about to be said, with what should happen to it. Lines are matched to transcripts in this order. */
  public expectLine(line: InterviewLine, path: "typed" | "audio" = "typed"): number {
    this.paths.add(path);
    this.lines.push({ ...line, index: this.lines.length + 1, transcripts: [], heard: "" });
    return this.lines.length;
  }
  public noteFault(name: string, detail = ""): void { this.faultNames.push(name); this.add("fault.injected", detail ? `${name} ${detail}` : name); }
  public noteMode(mode: string): void { if (mode !== this.mode) this.add("mode.changed", mode); this.mode = mode; }
  /** A line the app refused (for example after a fatal error ended the session). */
  public noteUndelivered(text: string, reason: string): void { this.add("notice.shown", `line not delivered (${reason}): ${text.slice(0, 60)}`, undefined, { where: "harness" }); }

  /* ---------------- inputs ---------------- */

  /** The expected line a transcript belongs to: the next unheard line with this text, else a line it is a piece of (a split turn), else a line it contains (merged turns). */
  private lineFor(text: string): TrackedLine | undefined {
    const key = alnum(text);
    if (!key) return undefined;
    return this.lines.find(line => line.heard !== alnum(line.text) && alnum(line.text) === key)
      ?? (key.length > 3 ? this.lines.find(line => line.heard !== alnum(line.text) && alnum(line.text).includes(key) && !line.heard.includes(key)) : undefined)
      ?? this.lines.find(line => line.heardAt === undefined && alnum(line.text).length > 8 && key.includes(alnum(line.text)));
  }

  public onEvent(event: GatewayEvent): void {
    switch (event.type) {
      case "transcript.final": {
        const line = this.lineFor(event.text);
        if (line) {
          line.heardAt ??= this.t(); line.transcripts.push(event.transcriptId);
          line.heard = alnum(line.text) === alnum(event.text) ? alnum(line.text) : line.heard + alnum(event.text);
          this.transcriptLine.set(event.transcriptId, line.index);
        }
        this.add("line.heard", event.text, event.transcriptId, { speaker: event.context.speaker.role, line: line?.index ?? 0 });
        return;
      }
      case "question.detected": {
        if (this.questions.some(question => question.id === event.questionId)) return;
        this.questions.push({ id: event.questionId, text: event.text, t: this.t(), role: event.context.speaker.role, ...(event.sourceTranscriptId ? { transcriptId: event.sourceTranscriptId } : {}), ...(event.context.trigger ? { trigger: event.context.trigger } : {}) });
        this.add("question.detected", event.text, event.questionId, { speaker: event.context.speaker.role, line: event.sourceTranscriptId ? this.transcriptLine.get(event.sourceTranscriptId) ?? 0 : 0 });
        return;
      }
      case "answer.delta": {
        this.answerFor(event.answerId, event.questionId, event.context.speaker.role, event.context.trigger).text += event.delta;
        return;
      }
      case "answer.completed": {
        const answer = this.answerFor(event.answerId, event.questionId, event.context.speaker.role, event.context.trigger);
        answer.text = event.text; answer.completedAt = this.t(); answer.partial = event.partial === true;
        this.add(answer.partial ? "answer.partial" : "answer.completed", event.text, event.answerId, event.questionId ? { questionId: event.questionId } : undefined);
        return;
      }
      case "error": {
        const t = this.t();
        this.errors.push({ t, code: event.code, message: event.message, fatal: event.fatal === true });
        // Errors carry no answer id. One that arrives while an answer is streaming ended that answer;
        // a request that failed before its first token is taken from the fake provider's log instead.
        const streaming = this.answers.at(-1);
        if (streaming && streaming.completedAt === undefined && streaming.failedAt === undefined) {
          streaming.failedAt = t;
          this.add("answer.failed", `${event.code}: ${event.message}`, streaming.id, { ...(streaming.questionId ? { questionId: streaming.questionId } : {}), afterTokens: true });
        }
        return;
      }
      default: return;
    }
  }
  private answerFor(id: string, questionId: string | undefined, speaker: InterviewRole, trigger?: string): TrackedAnswer {
    let answer = this.answers.find(candidate => candidate.id === id);
    if (!answer) {
      answer = { id, role: speaker, firstTokenAt: this.t(), text: "", ...(questionId ? { questionId } : {}), ...(trigger ? { trigger } : {}) };
      this.answers.push(answer);
      const question = this.questions.find(candidate => candidate.id === questionId);
      this.add("answer.first-token", question?.text ?? "", id, { ...(questionId ? { questionId } : {}), ...(trigger ? { trigger } : {}) });
    }
    return answer;
  }

  public onSnapshot(snapshot: PresentationSnapshot): void {
    this.status = snapshot.status;
    this.presentationAnswerId = snapshot.glasses.answer?.id;
    if (snapshot.error !== this.lastError) {
      this.lastError = snapshot.error;
      if (snapshot.error) this.add("notice.shown", snapshot.error, undefined, { where: "phone", status: snapshot.status });
    }
    const key = snapshot.suggestions.map(item => item.id).join("|");
    if (key !== this.suggestionKey) {
      this.suggestionKey = key; this.suggestionChanges++;
      for (const item of snapshot.suggestions) if (!this.suggestionText.has(item.id)) this.suggestionText.set(item.id, { text: item.question, t: this.t() });
      this.add("suggestions.changed", snapshot.suggestions.map(item => item.question).join(" | "), undefined, { count: snapshot.suggestions.length });
    }
    for (const ask of snapshot.asks) {
      if (ask.status !== "done" || this.asksDone.has(ask.id)) continue;
      this.asksDone.set(ask.id, { id: ask.id, t: this.t(), trigger: ask.trigger, kind: ask.kind, answer: ask.answer ?? "" });
      this.add("ask.answered", ask.trigger, ask.id, { kind: ask.kind, topic: ask.topic });
    }
    // A cut-off answer that the phone marks as such (a field or the wording; the display work decides which).
    for (const item of snapshot.feed) {
      if (item.kind !== "answer" || this.markedPartial.has(item.id)) continue;
      if ((item as { partial?: boolean }).partial === true || PARTIAL_WORDING.test(`${item.label} ${item.meta ?? ""}`)) this.markedPartial.add(item.id);
    }
  }

  public onScreen(containers: ReadonlyMap<string, string>): void {
    // v0.16: the hidden display is one container. Its last line (of AMBIENT_ROWS) carries what the status
    // corner carried before: a problem, the page marker, a hint. The lines above it are the pop-up.
    const hidden = containers.get("hud-ambient")?.split("\n");
    const footer = hidden && hidden.length >= AMBIENT_ROWS ? hidden[AMBIENT_ROWS - 1]!.trim() : "";
    const body = hidden ? hidden.slice(0, AMBIENT_ROWS - 1).join("\n") : BODY_CONTAINERS.map(name => containers.get(name)).find(text => text !== undefined) ?? "";
    const entry: ScreenEntry = { t: this.t(), body, title: containers.get("hud-header") ?? "", status: hidden ? footer : containers.get("hud-status") ?? "",
      ambient: this.options.ambient?.() ?? false, ...(this.presentationAnswerId ? { answerId: this.presentationAnswerId } : {}) };
    const last = this.screens.at(-1);
    if (last && last.body === entry.body && last.title === entry.title && last.status === entry.status && last.ambient === entry.ambient) return;
    this.screens.push(entry);
  }

  /* ---------------- derived ---------------- */

  /** The answer whose text the glasses body shows, if any. A question line may sit above the answer page. */
  private answerOnScreen(entry: ScreenEntry): TrackedAnswer | undefined {
    // The display appends a mark to an answer the provider cut short; it is not part of the answer text.
    const lines = entry.body.replace(/\s*…\s*\(cut off\)\s*$/u, "").split("\n");
    for (let skip = 0; skip < Math.min(2, lines.length); skip++) {
      const page = alnum(lines.slice(skip).join(" "));
      if (!page) return undefined;
      const probe = page.slice(0, 40);
      const candidates = this.answers.filter(answer => answer.firstTokenAt <= entry.t && alnum(answer.text).includes(probe));
      if (candidates.length) return candidates.find(answer => answer.id === entry.answerId) ?? candidates.at(-1);
    }
    return undefined;
  }

  /** Answer requests in the fake provider's log, by the question they were for. */
  private requestInfo(): { byQuestion: Map<string, RequestInfo>; records: TimelineRecord[]; total: number; answers: number } {
    const byQuestion = new Map<string, RequestInfo>(), records: TimelineRecord[] = [];
    const requests = this.options.fake?.requests ?? [];
    for (const request of requests) {
      if (request.intent !== "answer") continue;
      const startedAt = request.startedAt - this.started;
      const serialized = JSON.stringify(request.body), tail = alnum(serialized.slice(Math.max(0, serialized.lastIndexOf("REQUEST"))));
      // The newest question asked before the request whose text the request quotes (a repeated question has two).
      const question = [...this.questions].reverse().find(candidate => candidate.t <= startedAt + 5 && alnum(candidate.text).length > 3 && tail.includes(alnum(candidate.text)));
      if (!question) continue;
      const info = byQuestion.get(question.id) ?? { faults: new Set<string>(), requests: 0 };
      byQuestion.set(question.id, info);
      info.requests++;
      const failed = (request.status ?? 200) >= 400;
      if (request.fault) info.faults.add(request.fault === "http-error" ? `http-${request.status ?? 500}` : request.fault);
      if (failed) {
        const t = Math.round((request.endedAt ?? request.startedAt) - this.started);
        info.failedAt = t; info.failure = `HTTP ${request.status}`;
        records.push({ t, kind: "answer.failed", text: `HTTP ${request.status} before the first token`, id: question.id, data: { questionId: question.id, afterTokens: false } });
      }
    }
    return { byQuestion, records, total: requests.length, answers: requests.filter(request => request.intent === "answer").length };
  }

  private glassesRecords(): { records: TimelineRecord[]; held: Set<string>; visibleAt: Map<string, number>; clearedByError: Set<string>; onScreenAtEnd?: string; partialOnGlasses: Set<string> } {
    const records: TimelineRecord[] = [], visibleAt = new Map<string, number>(), clearedByError = new Set<string>(), partialOnGlasses = new Set<string>(), held = new Set<string>();
    const suggestionsShown = new Set<string>();
    let current: TrackedAnswer | undefined, lastNotice = "";
    for (const entry of this.screens) {
      const shown = this.answerOnScreen(entry);
      if (shown?.id !== current?.id) {
        if (current) {
          const error = this.errors.find(item => item.t <= entry.t && entry.t - item.t <= 2000);
          // A finished answer leaves by itself after its reading time (8 s on the last page); sooner than that, something took it away.
          const reason = shown ? "replaced" : current.completedAt !== undefined && entry.t - current.completedAt >= 7900 ? "expired" : error ? "error" : "cleared";
          if (reason === "error") clearedByError.add(current.id);
          records.push({ t: entry.t, kind: "glasses.answer-hidden", text: reason === "error" ? `${error!.code}: ${error!.message}` : reason, id: current.id, data: { reason } });
        }
        if (shown) {
          if (!visibleAt.has(shown.id)) {
            visibleAt.set(shown.id, entry.t);
            // Held: it replaced an answer, and some answer was already on screen when its first token arrived.
            if (current && [...visibleAt].some(([id, at]) => id !== shown.id && at <= shown.firstTokenAt + 150)) held.add(shown.id);
          }
          records.push({ t: entry.t, kind: "glasses.answer-visible", text: entry.body.replace(/\s+/gu, " ").trim().slice(0, 80), id: shown.id, data: { ambient: entry.ambient } });
        }
        current = shown;
      }
      if (shown && PARTIAL_WORDING.test(`${entry.title} ${entry.status} ${entry.body}`)) partialOnGlasses.add(shown.id);
      const body = alnum(entry.body);
      // The copilot's answer to an implicit ask pops up as a cue, not as an answer.
      for (const ask of this.asksDone.values()) {
        if (visibleAt.has(ask.id) || ask.t > entry.t || !ask.answer || !body.includes(alnum(ask.answer).slice(0, 40))) continue;
        visibleAt.set(ask.id, entry.t);
        records.push({ t: entry.t, kind: "glasses.answer-visible", text: entry.body.replace(/\s+/gu, " ").trim().slice(0, 80), id: ask.id, data: { ambient: entry.ambient, via: "copilot-ask" } });
      }
      for (const [id, suggestion] of this.suggestionText) {
        const key = `${id}:${entry.ambient}`;
        if (suggestion.t > entry.t || suggestionsShown.has(key) || !body.includes(alnum(suggestion.text).slice(0, 28))) continue;
        suggestionsShown.add(key);
        records.push({ t: entry.t, kind: "glasses.suggestion-shown", text: suggestion.text, id, data: { ambient: entry.ambient } });
      }
      const notice = /(?:^|[·\s])!\s(.+)$/u.exec(entry.status.trim())?.[1] ?? "";
      if (notice && notice !== lastNotice) records.push({ t: entry.t, kind: "notice.shown", text: notice, data: { where: "glasses" } });
      lastNotice = notice;
    }
    return { records, held, visibleAt, clearedByError, partialOnGlasses, ...(current ? { onScreenAtEnd: current.id } : {}) };
  }

  /** Everything that happened, oldest first. */
  public timeline(): TimelineRecord[] {
    const all = [...this.raw, ...this.requestInfo().records, ...this.glassesRecords().records];
    const order = new Map(all.map((record, index) => [record, index]));
    return all.sort((a, b) => a.t - b.t || order.get(a)! - order.get(b)!);
  }

  /** Whether an answer was shown as cut off: on the phone feed, on the glasses, or both. */
  public partialMarks(answerId: string): { phone: boolean; glasses: boolean } {
    return { phone: this.markedPartial.has(answerId), glasses: this.glassesRecords().partialOnGlasses.has(answerId) };
  }
  /** Id of the answer on the glasses right now. */
  public answerOnGlasses(): string | undefined { return this.glassesRecords().onScreenAtEnd; }

  public report(): InterviewReport {
    const glasses = this.glassesRecords(), provider = this.requestInfo();
    const built: { row: QuestionRow; question?: TrackedQuestion }[] = [], violations: string[] = [];
    const used = new Set<string>();
    const add = (line: TrackedLine | undefined, question: TrackedQuestion | undefined, label: string, expect: QuestionRow["expect"]): void => {
      const answers = question ? this.answers.filter(answer => answer.questionId === question.id) : [];
      const finished = answers.filter(answer => answer.completedAt !== undefined);
      // Not detected as a question: the copilot's implicit-ask lane may still have answered the line.
      const ask = !question && line ? [...this.asksDone.values()].find(item => item.kind === "question" && alnum(line.text).includes(alnum(item.trigger).slice(0, 40))) : undefined;
      const info = question ? provider.byQuestion.get(question.id) : undefined;
      const first = answers[0], last = answers.at(-1);
      const heardAt = line?.heardAt ?? question?.t;
      const visibleFor = answers.find(answer => glasses.visibleAt.has(answer.id));
      const visible = visibleFor ? glasses.visibleAt.get(visibleFor.id) : ask ? glasses.visibleAt.get(ask.id) : undefined;
      const timesAnswered = finished.length + (ask ? 1 : 0), attempts = answers.length;
      const finalState: FinalState = finished.length ? (finished.at(-1)!.partial ? "partial" : "answered")
        : ask ? "answered"
          : last ? (last.failedAt !== undefined ? "failed" : this.answers.at(-1) === last ? "streaming" : "superseded")
            : info?.failedAt !== undefined ? "failed"
              : !question ? (expect === "answer" || expect === "answer-key" ? "not-detected" : "ignored")
                : expect === "answer" || expect === "answer-key" ? "not-answered" : "ignored";
      const ok = expect === "unspecified" ? true
        : expect === "none" ? attempts === 0 && !ask && !info?.requests
          : timesAnswered === 1 && finalState === "answered";
      built.push({ ...(question ? { question } : {}), row: {
        line: line?.index ?? 0, ...(line?.case ? { case: line.case } : {}), question: label, speaker: question?.role ?? line?.speaker ?? "unknown", expect,
        detected: !!question, answered: timesAnswered > 0, timesAnswered, attempts,
        ...(attempts ? { via: "answer" as const } : ask ? { via: "copilot-ask" as const } : {}),
        ...(first && heardAt !== undefined ? { msToFirstToken: first.firstTokenAt - heardAt } : ask && heardAt !== undefined ? { msToFirstToken: ask.t - heardAt } : {}),
        ...(visible !== undefined && heardAt !== undefined ? { msToVisible: visible - heardAt } : {}),
        ...(visible !== undefined && visibleFor ? { msTokenToVisible: visible - visibleFor.firstTokenAt } : {}),
        ...(visibleFor && glasses.held.has(visibleFor.id) ? { heldBehindAnswer: true } : {}),
        finalState, faults: [...(info?.faults ?? [])], ok,
      } });
    };
    for (const line of this.lines) {
      const detected = this.questions.filter(question => question.transcriptId !== undefined && line.transcripts.includes(question.transcriptId));
      const expect: QuestionRow["expect"] = line.expect ?? "unspecified";
      const needles = line.expect && line.expect !== "none" ? line.questions ?? [line.text] : [];
      for (const needle of needles) {
        // One detected question may carry two expected ones ("How did you detect it, and how long did it take?"):
        // an answer to it then counts for both rows.
        const question = detected.find(candidate => !used.has(candidate.id) && alnum(candidate.text).includes(alnum(needle)))
          ?? detected.find(candidate => alnum(candidate.text).includes(alnum(needle)));
        if (question) used.add(question.id);
        add(line, question, question?.text ?? (needles.length > 1 ? needle : line.text), expect);
      }
      const rest = detected.filter(question => !used.has(question.id));
      for (const question of rest) { used.add(question.id); add(line, question, question.text, line.expect === undefined ? "unspecified" : "none"); }
      // A tagged awkward line with nothing detected still gets its row, so the report can name it.
      if (!needles.length && !rest.length && (line.case || line.expect === undefined)) add(line, undefined, line.text, line.expect === undefined ? "unspecified" : "none");
    }
    // Questions from speech outside the script, manual requests and proactive answers.
    for (const question of this.questions) if (!used.has(question.id)) add(undefined, question, question.text, "unspecified");
    const orphanAnswers = this.answers.filter(answer => !answer.questionId || !this.questions.some(question => question.id === answer.questionId));
    const rows = built.map(entry => entry.row);

    for (const item of rows) {
      if (item.ok) continue;
      const where = `L${item.line}${item.case ? ` [${item.case}]` : ""} "${item.question.slice(0, 70)}"`;
      if (item.expect === "none") violations.push(`${where}: expected no answer, ${item.timesAnswered ? `answered ${item.timesAnswered}x` : `answer ${item.finalState}`}${item.via === "copilot-ask" ? " (copilot ask)" : ""}`);
      else violations.push(`${where}: expected ${item.expect === "answer-key" ? "one answer key" : "one answer"}, got ${item.timesAnswered} (${item.finalState}${item.attempts > 1 ? `, ${item.attempts} attempts` : ""}${item.faults.length ? `, fault ${item.faults.join("+")}` : ""})`);
    }
    for (const answer of orphanAnswers) violations.push(`answer without a detected question (${answer.trigger ?? "unknown trigger"}): "${answer.text.slice(0, 60)}"`);
    for (const line of this.lines) if (line.heardAt === undefined) violations.push(`L${line.index} was never heard: "${line.text.slice(0, 60)}"`);

    // Order: expected answers finish in the order their questions were asked.
    const expected = built.filter(entry => entry.row.expect === "answer" || entry.row.expect === "answer-key");
    let latest: { at: number; row: QuestionRow } | undefined;
    for (const entry of expected) {
      const times = this.answers.filter(answer => answer.questionId !== undefined && answer.questionId === entry.question?.id && answer.completedAt !== undefined).map(answer => answer.completedAt!);
      if (!times.length) continue;
      const at = Math.min(...times);
      if (latest && at < latest.at) violations.push(`out of order: L${entry.row.line} "${entry.row.question.slice(0, 40)}" was answered before L${latest.row.line} "${latest.row.question.slice(0, 40)}"`);
      else latest = { at, row: entry.row };
    }
    // Visibility: every finished answer is readable on the glasses soon after its first token.
    for (const item of rows) {
      if (!item.answered || item.via !== "answer") continue;
      if (item.msTokenToVisible === undefined) violations.push(`L${item.line} "${item.question.slice(0, 50)}": answered but never shown on the glasses`);
      else if (item.msTokenToVisible > visibleLimit(item)) violations.push(`L${item.line} "${item.question.slice(0, 50)}": on the glasses ${item.msTokenToVisible} ms after the first token (limit ${visibleLimit(item)}${item.heldBehindAnswer ? ", waited behind the answer before it" : ""})`);
    }
    for (const id of glasses.clearedByError) {
      const answer = this.answers.find(candidate => candidate.id === id);
      violations.push(`an error cleared the answer on the glasses: "${answer?.text.slice(0, 60) ?? id}"`);
    }
    const shown = glasses.records.filter(record => record.kind === "glasses.suggestion-shown");
    const heard = this.lines.filter(line => line.heardAt !== undefined).length;
    if (this.mode === "interviewer" && heard >= 8) {
      if (!this.suggestionText.size) violations.push("interviewer mode: no suggested question was produced");
      else if (!shown.some(record => record.data?.ambient === true)) violations.push(`interviewer mode: ${this.suggestionText.size} suggested question(s) on the phone, none popped up on the glasses`);
    }

    const firstToken = rows.flatMap(item => item.via === "answer" && item.msToFirstToken !== undefined ? [item.msToFirstToken] : []);
    const toVisible = rows.flatMap(item => item.msToVisible !== undefined ? [item.msToVisible] : []);
    const tokenToVisible = rows.flatMap(item => item.msTokenToVisible !== undefined ? [item.msTokenToVisible] : []);
    const paths = [...this.paths], m1 = median(firstToken), m2 = median(toVisible);
    const expectedRows = expected.map(entry => entry.row);
    return {
      ...(this.script ? { script: this.script } : {}), mode: this.mode, path: paths.length === 1 ? paths[0]! : paths.length ? "mixed" : "typed", speed: this.speed,
      faults: [...this.faultNames], rows, violations,
      summary: {
        linesExpected: this.lines.length, linesHeard: heard,
        expectedQuestions: expectedRows.length, answeredOnce: expectedRows.filter(item => item.ok).length,
        missed: expectedRows.filter(item => item.timesAnswered === 0).length, answeredTwice: rows.filter(item => item.timesAnswered > 1).length,
        unexpectedAnswers: rows.filter(item => item.expect === "none" && !item.ok).length + orphanAnswers.length,
        lostToFault: expectedRows.filter(item => item.faults.length > 0 && item.finalState !== "answered").length,
        ...(m1 === undefined ? {} : { medianMsToFirstToken: m1 }), ...(m2 === undefined ? {} : { medianMsToVisible: m2 }),
        ...(tokenToVisible.length ? { maxMsTokenToVisible: Math.max(...tokenToVisible) } : {}),
        answersClearedByError: glasses.clearedByError.size, partialAnswers: this.answers.filter(answer => answer.partial).length,
        suggestionChanges: this.suggestionChanges, suggestionsOnGlasses: new Set(shown.map(record => record.id)).size,
        suggestionsOnGlassesAmbient: new Set(shown.filter(record => record.data?.ambient === true).map(record => record.id)).size,
        notices: this.errors.length, status: this.status,
        providerRequests: provider.total, answerRequests: provider.answers,
      },
    };
  }
}

/* ------------------------------------------------------------------ */
/* window.__interview API                                              */
/* ------------------------------------------------------------------ */

export const FAULT_KINDS = ["slow-first-token", "http-500-once", "http-500-always", "http-401", "malformed-event", "cut-off", "bad-copilot-json", "burst"] as const;
export type FaultKind = typeof FAULT_KINDS[number];
export interface FaultOptions {
  /** slow-first-token: delay before the first token (default 4000). */
  readonly ms?: number;
  /** malformed-event / cut-off: how many text deltas arrive first. */
  readonly afterDeltas?: number;
  /** How many requests the fault hits (default 1; "always" kinds: all). */
  readonly times?: number;
  /** Let this many answer requests through first (default 0). */
  readonly skip?: number;
  /** burst: number of lines and gap between them. */
  readonly n?: number;
  readonly gapMs?: number;
}
export interface PlayOptions {
  readonly speed?: number;
  /** "typed": lines are injected as text (no speech-to-text). "audio": fake microphone + fake speech-to-text socket. */
  readonly path?: "typed" | "audio";
  /** Wait after the last line for answers, the copilot and the display to settle (default 12000 ms, not scaled by speed). */
  readonly settleMs?: number;
  /** Keep the current mode instead of switching to the script's. */
  readonly keepMode?: boolean;
}
export interface InterviewParts {
  readonly recorder: InterviewRecorder;
  readonly fake: FakeOpenAI;
  /** Feeds a typed line into the live pipeline (DirectConversationTransport.injectTranscript). */
  readonly inject: (text: string, speaker: Speaker) => Promise<void>;
  readonly setMode: (mode: string) => Promise<void>;
  /** Flushes the copilot instead of waiting out its cooldown (controller.runCopilot). */
  readonly runCopilot?: () => void;
  readonly speech?: ScriptedSpeech;
  readonly sleep?: (ms: number) => Promise<void>;
}
export interface InterviewApi {
  readonly state: "idle" | "playing" | "done";
  /** Resolves with the report of the current / last play(). */
  readonly done: Promise<InterviewReport> | undefined;
  readonly scripts: readonly { id: string; title: string; mode: string; lines: number }[];
  play(scriptId: string, options?: PlayOptions): Promise<InterviewReport>;
  stop(): void;
  say(text: string, speaker?: InterviewRole, expect?: Expectation, tag?: string): Promise<void>;
  setMode(id: string): Promise<void>;
  fault(kind: FaultKind | "none", options?: FaultOptions): Promise<void>;
  burst(n?: number, gapMs?: number): Promise<void>;
  timeline(): TimelineRecord[];
  report(): InterviewReport;
}
const BURST_TOPICS = ["caching", "retries", "schema changes", "backpressure", "monitoring", "rollbacks", "capacity planning", "data retention", "access control", "cost limits"];

export function createInterviewApi(parts: InterviewParts): InterviewApi {
  const { recorder, fake } = parts;
  const sleep = parts.sleep ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
  let state: InterviewApi["state"] = "idle", stopped = false, done: Promise<InterviewReport> | undefined;
  const setMode = async (id: string) => { await parts.setMode(id); recorder.noteMode(id); };
  // A fatal error ends the session; later lines are refused. The run goes on so the report shows them as never heard.
  const inject = async (text: string, speaker: InterviewRole) => {
    try { await parts.inject(text, SPEAKERS[speaker]); }
    catch (error) { recorder.noteUndelivered(text, error instanceof Error ? error.message : String(error)); }
  };
  const say = async (text: string, speaker: InterviewRole = "other", expect?: Expectation, tag?: string) => {
    recorder.expectLine({ speaker, text, ...(expect ? { expect } : {}), ...(tag ? { case: tag } : {}) });
    await inject(text, speaker);
  };
  const burst = async (n = 6, gapMs = 150) => {
    recorder.noteFault("burst", `${n} lines, ${gapMs} ms apart`);
    for (let index = 0; index < n; index++) {
      const speaker: InterviewRole = index % 2 ? "self" : "other";
      const text = `What is your approach to ${BURST_TOPICS[index % BURST_TOPICS.length]}${index >= BURST_TOPICS.length ? ` in round ${Math.floor(index / BURST_TOPICS.length) + 1}` : ""}?`;
      // Other side: one answer each. The wearer: an answer key when interviewing, nothing as the candidate.
      const expect: Expectation = speaker === "other" ? "answer" : recorder.mode === "interviewer" ? "answer-key" : "none";
      recorder.expectLine({ speaker, text, expect, case: "burst", questions: [text.slice(0, -1)] });
      await inject(text, speaker);
      if (index < n - 1) await sleep(gapMs);
    }
  };
  const fault = async (kind: FaultKind | "none", options: FaultOptions = {}) => {
    if (kind === "none") { fake.clearFaults(); return; }
    if (kind === "burst") { await burst(options.n, options.gapMs); return; }
    const skip = options.skip === undefined ? {} : { skip: options.skip };
    const injected: FakeFault = kind === "slow-first-token" ? { kind: "slow-first-token", firstTokenMs: options.ms ?? 4000, times: options.times ?? 1, ...skip }
      : kind === "http-500-once" ? { kind: "http-error", status: 500, times: options.times ?? 1, ...skip }
        : kind === "http-500-always" ? { kind: "http-error", status: 500, times: Infinity, ...skip }
          : kind === "http-401" ? { kind: "http-error", status: 401, times: Infinity, ...skip }
            : kind === "malformed-event" ? { kind: "malformed-event", times: options.times ?? 1, ...(options.afterDeltas === undefined ? {} : { afterDeltas: options.afterDeltas }), ...skip }
              : kind === "cut-off" ? { kind: "cut-off", times: options.times ?? 1, ...(options.afterDeltas === undefined ? {} : { afterDeltas: options.afterDeltas }), ...skip }
                : { kind: "bad-json", times: options.times ?? 1, ...skip };
    fake.injectFault(injected);
    recorder.noteFault(kind, [options.ms ? `${options.ms} ms` : "", options.skip ? `after ${options.skip} request(s)` : "", options.times && options.times > 1 ? `x${options.times}` : ""].filter(Boolean).join(" "));
  };
  const play = (scriptId: string, options: PlayOptions = {}): Promise<InterviewReport> => {
    const script = interviewScript(scriptId);
    if (!script) return Promise.reject(new Error(`Unknown interview script: ${scriptId}`));
    if (state === "playing") return Promise.reject(new Error("A script is already playing."));
    const speed = options.speed && options.speed > 0 ? options.speed : 1, path = options.path ?? "typed";
    if (path === "audio" && !parts.speech) return Promise.reject(new Error("This rig has no audio path."));
    state = "playing"; stopped = false;
    recorder.script = script.id; recorder.speed = speed;
    done = (async () => {
      try {
        if (!options.keepMode) await setMode(script.mode);
        for (const [index, line] of script.lines.entries()) {
          if (stopped) break;
          recorder.expectLine(line, path);
          if (path === "audio") {
            await parts.speech!.speak(line.text, line.speaker, 400 / speed);
            if (index < script.lines.length - 1) await sleep(600 / speed);
          } else {
            await inject(line.text, line.speaker);
            if (index < script.lines.length - 1) await sleep((line.pauseMs ?? defaultPauseMs(line.text)) / speed);
          }
        }
        // As controller.rehearse does: trailing speech goes through the copilot without waiting for its cooldown.
        if (!stopped) { try { parts.runCopilot?.(); } catch { /* session ended */ } }
        await sleep(options.settleMs ?? 12_000);
        return recorder.report();
      } finally { state = "done"; }
    })();
    return done;
  };
  return {
    get state() { return state; },
    get done() { return done; },
    scripts: INTERVIEW_SCRIPTS.map(script => ({ id: script.id, title: script.title, mode: script.mode, lines: script.lines.length })),
    play, stop: () => { stopped = true; }, say, setMode, fault, burst,
    timeline: () => recorder.timeline(),
    report: () => recorder.report(),
  };
}
