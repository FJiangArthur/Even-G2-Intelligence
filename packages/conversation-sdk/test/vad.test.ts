import { describe, expect, it } from "vitest";
import { Pcm16Vad, normalizedRms } from "../src/index.js";

describe("Pcm16Vad", () => {
  it("commits one valid utterance after the configured silence", () => {
    const vad = new Pcm16Vad({
      speechThreshold: 0.02,
      minSpeechDurationMs: 100,
      silenceDurationMs: 200,
    });

    expect(vad.process(new Int16Array(1600).fill(4000))).toMatchObject({
      speechDetected: true,
      shouldCommit: false,
      speechDurationMs: 100,
    });
    expect(vad.process(new Int16Array(1600))).toMatchObject({
      shouldCommit: false,
      silenceDurationMs: 100,
    });
    expect(vad.process(new Int16Array(1600))).toMatchObject({
      shouldCommit: true,
      silenceDurationMs: 200,
    });
    expect(vad.process(new Int16Array(3200)).shouldCommit).toBe(false);
  });

  it("uses a 300ms default trailing-silence target", () => {
    const vad = new Pcm16Vad({ speechThreshold: 0.02, minSpeechDurationMs: 100 });
    vad.process(new Int16Array(1600).fill(4000));
    expect(vad.process(new Int16Array(4799))).toMatchObject({ shouldCommit: false });
    expect(vad.process(new Int16Array(1))).toMatchObject({
      shouldCommit: true,
      silenceDurationMs: 300,
    });
  });

  it("rejects a zero threshold that would classify silence as speech", () => {
    expect(() => new Pcm16Vad({ speechThreshold: 0 })).toThrow("greater than zero");
  });

  it("rejects a short noise impulse and reports normalized RMS", () => {
    const vad = new Pcm16Vad({
      speechThreshold: 0.01,
      minSpeechDurationMs: 100,
      silenceDurationMs: 100,
    });
    vad.process(new Int16Array(160).fill(32767));
    expect(vad.process(new Int16Array(1600)).shouldCommit).toBe(false);
    expect(normalizedRms(new Int16Array([32767, -32768]))).toBeCloseTo(1, 4);
  });
});
