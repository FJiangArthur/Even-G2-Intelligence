export interface Pcm16VadOptions {
  /** Normalized RMS in the inclusive range 0...1. */
  readonly speechThreshold?: number;
  readonly minSpeechDurationMs?: number;
  readonly silenceDurationMs?: number;
}

export interface VadDecision {
  readonly speechDetected: boolean;
  readonly utteranceActive: boolean;
  readonly shouldCommit: boolean;
  readonly speechDurationMs: number;
  readonly silenceDurationMs: number;
}

const SAMPLE_RATE_HZ = 16000;

/**
 * Deterministic energy VAD for mono signed PCM16 at 16kHz. Feed short chunks
 * (10-40ms is recommended); a commit is emitted once per speech utterance.
 */
export class Pcm16Vad {
  private readonly threshold: number;
  private readonly minimumSpeechSamples: number;
  private readonly requiredSilenceSamples: number;
  private speechSamples = 0;
  private silenceSamples = 0;
  private utteranceActive = false;

  public constructor(options: Pcm16VadOptions = {}) {
    const threshold = options.speechThreshold ?? 0.018;
    const minSpeechDurationMs = options.minSpeechDurationMs ?? 120;
    const silenceDurationMs = options.silenceDurationMs ?? 300;
    if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
      throw new RangeError("speechThreshold must be greater than zero and at most 1");
    }
    if (!Number.isFinite(minSpeechDurationMs) || minSpeechDurationMs <= 0) {
      throw new RangeError("minSpeechDurationMs must be greater than zero");
    }
    if (!Number.isFinite(silenceDurationMs) || silenceDurationMs <= 0) {
      throw new RangeError("silenceDurationMs must be greater than zero");
    }
    this.threshold = threshold;
    this.minimumSpeechSamples = Math.ceil((minSpeechDurationMs / 1000) * SAMPLE_RATE_HZ);
    this.requiredSilenceSamples = Math.ceil((silenceDurationMs / 1000) * SAMPLE_RATE_HZ);
  }

  public process(samples: Int16Array): VadDecision {
    if (samples.length === 0) return this.decision(false, false);
    const speechDetected = normalizedRms(samples) >= this.threshold;

    if (speechDetected) {
      this.utteranceActive = true;
      this.speechSamples += samples.length;
      this.silenceSamples = 0;
      return this.decision(true, false);
    }

    if (!this.utteranceActive) return this.decision(false, false);
    this.silenceSamples += samples.length;
    if (this.silenceSamples < this.requiredSilenceSamples) {
      return this.decision(false, false);
    }

    const shouldCommit = this.speechSamples >= this.minimumSpeechSamples;
    const completed = this.decision(false, shouldCommit);
    this.reset();
    return completed;
  }

  public reset(): void {
    this.speechSamples = 0;
    this.silenceSamples = 0;
    this.utteranceActive = false;
  }

  private decision(speechDetected: boolean, shouldCommit: boolean): VadDecision {
    return {
      speechDetected,
      utteranceActive: this.utteranceActive,
      shouldCommit,
      speechDurationMs: samplesToMilliseconds(this.speechSamples),
      silenceDurationMs: samplesToMilliseconds(this.silenceSamples),
    };
  }
}

export function normalizedRms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (const sample of samples) {
    const normalized = sample / 32768;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / samples.length);
}

function samplesToMilliseconds(samples: number): number {
  return (samples / SAMPLE_RATE_HZ) * 1000;
}
