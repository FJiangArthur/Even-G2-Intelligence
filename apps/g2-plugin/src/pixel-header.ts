/** Original 5x7 Helix wordmark. Integer pixels only: no canvas, font download,
 * antialiasing or animation traffic. PNG grayscale is decoded by the host. */
export const PIXEL_HEADER = { width: 136, height: 32, containerID: 8, containerName: "helix-pixels" } as const;

const LETTERS: Record<string, readonly string[]> = {
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
};

export function pixelHeaderPng(): number[] {
  const { width, height } = PIXEL_HEADER;
  const pixels = new Uint8Array(width * height);
  const rect = (x: number, y: number, w: number, h: number, shade = 255) => {
    for (let row = y; row < y + h; row++) pixels.fill(shade, row * width + x, row * width + x + w);
  };
  // Stepped helix emblem, not a battery or network-strength indicator.
  for (let row = 0; row < 7; row++) {
    const x = [0, 1, 2, 3, 2, 1, 0][row]!;
    rect(3 + x * 3, 4 + row * 3, 3, 3);
    rect(24 - x * 3, 4 + row * 3, 3, 3, 170);
  }
  [..."HELIX"].forEach((letter, index) => {
    LETTERS[letter]!.forEach((row, y) => [...row].forEach((bit, x) => {
      if (bit === "1") rect(38 + index * 18 + x * 3, 4 + y * 3, 3, 3);
    }));
  });
  rect(3, 29, 126, 2, 85);
  const raw: number[] = [];
  for (let y = 0; y < height; y++) raw.push(0, ...pixels.subarray(y * width, (y + 1) * width));
  // One uncompressed DEFLATE block; this small header is sent only on startup.
  const size = raw.length;
  let a = 1; let b = 0;
  for (const byte of raw) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  const compressed = [0x78, 0x01, 1, size & 255, size >>> 8, (~size) & 255, ((~size) >>> 8) & 255, ...raw, ...u32((b << 16) | a)];
  return [137, 80, 78, 71, 13, 10, 26, 10,
    ...chunk("IHDR", [...u32(width), ...u32(height), 8, 0, 0, 0, 0]),
    ...chunk("IDAT", compressed), ...chunk("IEND", [])];
}

function u32(value: number): number[] {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}
function chunk(type: string, data: number[]): number[] {
  const content = [...new TextEncoder().encode(type), ...data];
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return [...u32(data.length), ...content, ...u32((crc ^ 0xffffffff) >>> 0)];
}
