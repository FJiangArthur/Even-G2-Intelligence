const WAV_HEADER_BYTES = 44;

/** Wraps little-endian PCM16 mono samples in a WAV container for STT APIs. */
export function pcm16MonoToWav(pcm16: Uint8Array, sampleRateHz = 16_000): Uint8Array {
  if (pcm16.byteLength % 2 !== 0) {
    throw new RangeError("PCM16 data must contain complete 16-bit samples");
  }
  if (!Number.isInteger(sampleRateHz) || sampleRateHz <= 0) {
    throw new RangeError("sampleRateHz must be a positive integer");
  }

  const output = new Uint8Array(WAV_HEADER_BYTES + pcm16.byteLength);
  const view = new DataView(output.buffer);
  const writeAscii = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcm16.byteLength, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, pcm16.byteLength, true);
  output.set(pcm16, WAV_HEADER_BYTES);
  return output;
}
