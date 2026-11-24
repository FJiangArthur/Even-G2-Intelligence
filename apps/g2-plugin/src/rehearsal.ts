/**
 * Rehearsal mode: scripted conversations played through the real pipeline
 * (transport.injectTranscript in-app, audio/STT in scripts/live-rehearsal.mjs).
 * Script text lives in rehearsal-scripts.json so the Node live harness shares
 * one source. Pure module: no DOM, no network, no timers except the injected sleep.
 */
import type { Speaker } from "@helix/conversation-sdk";
import scriptData from "./rehearsal-scripts.json";

export type RehearsalKind = "interview" | "technical" | "meeting" | "talk";

export interface RehearsalLine {
  readonly speaker: "self" | "other";
  readonly text: string;
  /** Pause after this line at speed 1. Default derives from word count (~150 wpm). */
  readonly pauseMs?: number;
}

export interface RehearsalExpectations {
  /** Questions the wearer (speaker \"self\") asks the other party: detected, never auto-answered (v0.8 policy). */
  readonly selfQuestions?: readonly string[];
  /** Terms the concept channel should explain. */
  readonly concepts?: readonly string[];
  /** The script contains at least one contradiction the copilot should flag. */
  readonly conflict?: boolean;
  /** Substrings of lines that should raise a web lookup ask. */
  readonly lookups?: readonly string[];
  /** Substrings of lines that should raise a propose ask. */
  readonly proposes?: readonly string[];
  /** Substrings of explicit questions (detected by extractQuestions) that must each get an answer. */
  readonly questions?: readonly string[];
  /** Substrings of question-intent lines not phrased as questions (copilot ask kind "question"). */
  readonly implicitQuestions?: readonly string[];
  /** v0.16 talk scripts: suggestions of kind "say" must appear. */
  readonly sayLines?: boolean;
  /** v0.16: substrings of the speaker's rhetorical questions that must NOT be answered. */
  readonly unanswered?: readonly string[];
  /** v0.16: labels that must not appear in any output (e.g. the interviewer answer key). */
  readonly forbiddenLabels?: readonly string[];
}

export interface RehearsalScript {
  readonly id: string;
  readonly title: string;
  readonly kind: RehearsalKind;
  readonly lines: readonly RehearsalLine[];
  readonly expectations: RehearsalExpectations;
}

export const REHEARSAL_SCRIPTS: readonly RehearsalScript[] = Object.freeze(scriptData as RehearsalScript[]);

export function rehearsalScript(id: string): RehearsalScript | undefined {
  return REHEARSAL_SCRIPTS.find(script => script.id === id);
}

export const REHEARSAL_SPEAKERS: Readonly<Record<RehearsalLine["speaker"], Speaker>> = Object.freeze({
  self: Object.freeze({ label: "You", role: "self" as const }),
  other: Object.freeze({ label: "Other speaker", role: "other" as const }),
});

export function speakerForLine(line: RehearsalLine): Speaker { return REHEARSAL_SPEAKERS[line.speaker]; }

/** Spoken duration at ~150 wpm plus a short turn gap, used when a line has no pauseMs. */
export function defaultPauseMs(text: string): number {
  const words = text.trim().split(/\s+/u).filter(Boolean).length;
  return Math.round(words * 400 + 600);
}

export type RehearsalState = "idle" | "playing" | "stopped" | "completed" | "failed";

export interface RehearsalResult {
  readonly scriptId: string;
  readonly completed: boolean;
  /** Lines whose inject resolved. */
  readonly lines: number;
  readonly total: number;
  readonly durationMs: number;
  readonly error?: string;
}

export interface RehearsalPlayerOptions {
  readonly inject: (text: string, speaker: Speaker) => Promise<void>;
  readonly onProgress?: (index: number, total: number, line: RehearsalLine) => void;
  readonly onDone?: (result: RehearsalResult) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export class RehearsalPlayer {
  private current: RehearsalState = "idle";
  private run = 0;
  private wake?: () => void;

  public constructor(private readonly options: RehearsalPlayerOptions) {}

  public get state(): RehearsalState { return this.current; }

  /** Plays lines serially; each inject is awaited before the pause. Resolves when finished or stopped. */
  public async play(script: RehearsalScript, speed = 1): Promise<RehearsalResult> {
    if (this.current === "playing") throw new Error("A rehearsal is already playing.");
    if (!Number.isFinite(speed) || speed <= 0) throw new Error("Rehearsal speed must be a positive number.");
    const run = ++this.run;
    const now = this.options.now ?? (() => Date.now());
    const started = now();
    const total = script.lines.length;
    let lines = 0, error: string | undefined;
    this.current = "playing";
    const live = () => run === this.run && this.current === "playing";
    try {
      for (const [index, line] of script.lines.entries()) {
        if (!live()) break;
        this.options.onProgress?.(index, total, line);
        await this.options.inject(line.text, speakerForLine(line));
        if (!live()) break;
        lines++;
        if (index < total - 1) await this.pause((line.pauseMs ?? defaultPauseMs(line.text)) / speed);
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      if (run === this.run) this.current = "failed";
    }
    const completed = !error && lines === total;
    if (run === this.run && this.current === "playing") this.current = completed ? "completed" : "stopped";
    const result: RehearsalResult = { scriptId: script.id, completed, lines, total, durationMs: now() - started, ...(error ? { error } : {}) };
    if (run === this.run) { try { this.options.onDone?.(result); } catch { /* host callback must not break the player */ } }
    return result;
  }

  public stop(): void {
    if (this.current !== "playing") return;
    this.current = "stopped";
    this.wake?.();
  }

  private pause(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    const sleep = this.options.sleep ?? (value => new Promise<void>(resolve => setTimeout(resolve, value)));
    // stop() resolves an in-flight pause immediately.
    return new Promise<void>(resolve => {
      this.wake = resolve;
      void sleep(ms).then(resolve, resolve);
    }).finally(() => { this.wake = undefined; });
  }
}
