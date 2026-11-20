/**
 * v0.8 speaker attribution from per-frame G2 speaker roles. The G2 tags each
 * audio frame self/other/unknown; a turn's speaker is the dominant role over
 * its frames (loud frames first, all frames as fallback). Pure, no I/O.
 */
import type { Speaker } from "./types.js";

export type SpeakerRole = Speaker["role"];

export const SELF_SPEAKER: Speaker = Object.freeze({ label: "You", role: "self" as const });
export const OTHER_SPEAKER: Speaker = Object.freeze({ label: "Other speaker", role: "other" as const });

/** Speaker for a dominant role: "You" / "Other speaker" / `fallback` (session speaker) for unknown. */
export function roleSpeaker(role: SpeakerRole, fallback: Speaker): Speaker {
  if (role === "self") return SELF_SPEAKER;
  if (role === "other") return OTHER_SPEAKER;
  return fallback;
}

/**
 * True when `speaker` carries no explicit identity: the session default, any
 * unknown-role speaker, or one of the role labels produced by roleSpeaker.
 * Explicit speakers (an id, or a custom label with a known role) are kept as-is.
 */
export function isGenericSpeaker(speaker: Speaker, sessionSpeaker: Speaker): boolean {
  if (speaker.id !== undefined) return false;
  if (speaker.role === "unknown") return true;
  if (speaker.label === sessionSpeaker.label && speaker.role === sessionSpeaker.role) return true;
  return (speaker.role === "self" && speaker.label === SELF_SPEAKER.label) || (speaker.role === "other" && speaker.label === OTHER_SPEAKER.label);
}

const ROLES: readonly SpeakerRole[] = ["other", "unknown", "self"];
const isRole = (value: unknown): value is SpeakerRole => value === "self" || value === "other" || value === "unknown";

/** Sample counts per role within one turn. Ties prefer other > unknown > self (answering stays the default). */
export class SpeakerRoleTally {
  private readonly loud: Record<SpeakerRole, number> = { self: 0, other: 0, unknown: 0 };
  private readonly all: Record<SpeakerRole, number> = { self: 0, other: 0, unknown: 0 };
  /** Untagged frames (no speakerRole) are ignored: they carry no attribution. */
  add(role: unknown, samples: number, loud: boolean): void {
    if (!isRole(role) || !Number.isFinite(samples) || samples <= 0) return;
    this.all[role] += samples;
    if (loud) this.loud[role] += samples;
  }
  /** Dominant role by loud samples, else by all samples; undefined when no tagged frame was seen. */
  dominant(): SpeakerRole | undefined {
    const pick = (counts: Record<SpeakerRole, number>) => {
      let best: SpeakerRole | undefined, max = 0;
      for (const role of ROLES) if (counts[role] > max) { best = role; max = counts[role]; }
      return best;
    };
    return pick(this.loud) ?? pick(this.all);
  }
  get empty(): boolean { return this.all.self + this.all.other + this.all.unknown === 0; }
  reset(): void { for (const role of ROLES) { this.loud[role] = 0; this.all[role] = 0; } }
  /**
   * The turn speaker: an explicit `requested` speaker wins; a generic one is
   * replaced by the dominant frame role when frames were tagged.
   */
  speaker(requested: Speaker, sessionSpeaker: Speaker): Speaker {
    const role = this.dominant();
    if (role === undefined || !isGenericSpeaker(requested, sessionSpeaker)) return requested;
    return roleSpeaker(role, sessionSpeaker);
  }
}
