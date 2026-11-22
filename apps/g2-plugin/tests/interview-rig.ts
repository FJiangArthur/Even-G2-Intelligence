/**
 * Vitest rig for the interview scenarios: the production controller, presentation, glasses HUD and phone
 * transport wired as src/app.ts wires them (bootstrap itself needs a DOM), on a fake G2 bridge and the
 * fake provider. Use with vi.useFakeTimers(); `drive()` moves the clock until a run has finished.
 */
import { DirectConversationTransport, type Speaker } from "@helix/conversation-sdk";
import { vi } from "vitest";
import { DEFAULT_CONFIG, type SessionFormState } from "../src/config";
import { G2ConversationController, LIVE_HISTORY_WRITE_DELAY_MS } from "../src/controller";
import { GlassesHud, type GlassesDisplay } from "../src/glasses-hud";
import { ConversationPresentation } from "../src/presentation";
import { createFakeOpenAI } from "./fake-openai";
import { createFakeGlasses, createInterviewApi, createScriptedSpeech, InterviewRecorder } from "./interview-harness";

export interface RigOptions {
  /** Conversation mode id to start in (default "interviewer"). */
  readonly mode?: string;
  /** Run the fake microphone and the scripted speech-to-text socket (needed for play(..., { path: "audio" })). */
  readonly audio?: boolean;
  readonly display?: GlassesDisplay;
  /** Time one glasses write takes (default 0). */
  readonly writeMs?: number;
}
/** Latency of the fake provider: the same numbers as qa/perf.ts and qa/interview.ts. */
export const RIG_LATENCY = Object.freeze({ firstTokenMs: 400, interTokenMs: 40, jsonMs: 900, webSearchMs: 1200, realtimeMs: 300 });
const form: SessionFormState = { ...DEFAULT_CONFIG, accessToken: "", openaiApiKey: "qa-fake-key", deepgramApiKey: "", sonioxApiKey: "", omiApiKey: "", saveApiKeysOnPhone: false };

/** Moves the fake clock in one-second steps until the promise settles. */
export async function drive<T>(promise: Promise<T>, maxMs = 900_000): Promise<T> {
  let settled = false, value: T | undefined, failure: unknown, failed = false;
  promise.then(result => { value = result; settled = true; }, error => { failure = error; failed = true; settled = true; });
  for (let elapsed = 0; !settled && elapsed < maxMs; elapsed += 1000) await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(0);
  if (!settled) throw new Error(`The run did not finish within ${maxMs} ms of fake time.`);
  if (failed) throw failure;
  return value as T;
}

export async function createRig(options: RigOptions = {}) {
  const mode = options.mode ?? "interviewer";
  const fake = createFakeOpenAI({ latency: RIG_LATENCY });
  const presentation = new ConversationPresentation();
  const holder: { hud?: GlassesHud; transport?: DirectConversationTransport } = {};
  const recorder = new InterviewRecorder({ fake, ambient: () => holder.hud?.ambient ?? false });
  const speech = createScriptedSpeech(event => glasses.emit(event));
  const glasses = createFakeGlasses({ onScreen: recorder.onScreen, ...(options.writeMs ? { writeMs: options.writeMs } : {}), onMic: open => { if (options.audio) speech.micOpen(open); } });
  // As bootstrap(): the interactive HUD with the saved defaults (ambient display, images on, 80 ms between writes).
  const hud = new GlassesHud(glasses.bridge, { onError: error => presentation.setStatus("failed", error.message), display: options.display ?? "ambient" });
  holder.hud = hud;
  const controller = new G2ConversationController(glasses.bridge, hud, presentation, transportOptions => {
    const transport = new DirectConversationTransport({ ...transportOptions, fetch: fake.fetch, webSocketFactory: (options.audio ? speech.webSocketFactory : fake.webSocketFactory) as never });
    transport.subscribe(recorder.onEvent);
    holder.transport = transport;
    return transport;
  });
  controller.liveHistoryWriteDelayMs = LIVE_HISTORY_WRITE_DELAY_MS;
  controller.audioRealtimeGuard = true;
  presentation.subscribe(recorder.onSnapshot);
  await drive(controller.initialize());
  await drive(controller.connect({ ...form, conversationMode: mode as SessionFormState["conversationMode"] }));
  await drive(controller.setMode(mode as SessionFormState["conversationMode"]));
  recorder.noteMode(mode);
  await drive(controller.startListening());
  // Let the "listening" status cue leave the display: the steady state an interview starts from.
  await vi.advanceTimersByTimeAsync(6000);
  recorder.reset();
  recorder.noteMode(mode);
  const api = createInterviewApi({
    recorder, fake, speech,
    inject: (text: string, speaker: Speaker) => holder.transport!.injectTranscript(text, speaker),
    setMode: id => controller.setMode(id as SessionFormState["conversationMode"]),
    runCopilot: () => controller.runCopilot(),
  });
  return {
    api, fake, recorder, controller, presentation, hud, glasses, speech,
    get transport() { return holder.transport!; },
    /** Text in the glasses BODY container right now. */
    body: () => glasses.containers.get("hud-body") ?? "",
    async dispose() { await drive(controller.dispose()); },
  };
}
export type Rig = Awaited<ReturnType<typeof createRig>>;
