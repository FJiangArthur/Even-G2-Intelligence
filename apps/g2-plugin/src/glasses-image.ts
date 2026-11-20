/**
 * Glasses images (v0.10): pixel-art bitmaps rendered to 4-bit greyscale for G2 image containers.
 *
 * G2 shows 16 levels of green; black is "off" (transparent). updateImageRawData takes an encoded
 * image file which the host decodes and converts to Gray4 (simulator 0.9.5 decodes with the Rust
 * `image` crate). We send an 8-bit greyscale PNG with stored (uncompressed) deflate blocks: tiny
 * encoder, deterministic, no canvas; the SDK LZ4-compresses the bytes in transit anyway.
 */
import type { Bitmap } from "./pixel-art";

export interface GrayImage { readonly width: number; readonly height: number; readonly pixels: Uint8Array }

/* ------------------------------------------------------------------ PNG */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function adler32(bytes: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) { a = (a + bytes[i]!) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

/** 8-bit greyscale PNG (color type 0), filter 0 per row, stored deflate blocks. */
export function encodeGrayPng(image: GrayImage): Uint8Array {
  const { width, height, pixels } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || pixels.length !== width * height) throw new Error("Invalid image size");
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  // zlib stream: header, stored blocks of <= 65535 bytes, adler32.
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const zlib = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  let o = 0;
  zlib[o++] = 0x78; zlib[o++] = 0x01;
  for (let i = 0; i < blocks; i++) {
    const start = i * 65535, size = Math.min(65535, raw.length - start);
    zlib[o++] = i === blocks - 1 ? 1 : 0;
    zlib[o++] = size & 0xff; zlib[o++] = size >>> 8; zlib[o++] = ~size & 0xff; zlib[o++] = (~size >>> 8) & 0xff;
    zlib.set(raw.subarray(start, start + size), o); o += size;
  }
  const adler = adler32(raw);
  zlib[o++] = adler >>> 24; zlib[o++] = (adler >>> 16) & 0xff; zlib[o++] = (adler >>> 8) & 0xff; zlib[o++] = adler & 0xff;
  const chunks: [string, Uint8Array][] = [
    ["IHDR", new Uint8Array([width >>> 24, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff, height >>> 24, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff, 8, 0, 0, 0, 0])],
    ["IDAT", zlib],
    ["IEND", new Uint8Array(0)],
  ];
  const total = 8 + chunks.reduce((n, [, data]) => n + 12 + data.length, 0);
  const out = new Uint8Array(total);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let p = 8;
  for (const [type, data] of chunks) {
    const length = data.length;
    out[p++] = length >>> 24; out[p++] = (length >>> 16) & 0xff; out[p++] = (length >>> 8) & 0xff; out[p++] = length & 0xff;
    const typeAt = p;
    for (let i = 0; i < 4; i++) out[p++] = type.charCodeAt(i);
    out.set(data, p); p += length;
    const crc = crc32(out, typeAt, p);
    out[p++] = crc >>> 24; out[p++] = (crc >>> 16) & 0xff; out[p++] = (crc >>> 8) & 0xff; out[p++] = crc & 0xff;
  }
  return out;
}

/* ------------------------------------------------------------- drawing */

/** Gray4 level (0 = off .. 15 = brightest) per pixel-art palette char, tuned for green-on-black. */
export const GLASSES_PALETTE: Readonly<Record<string, number>> = Object.freeze({
  ".": 0, " ": 0,
  k: 15, // outline: the brightest line reads as the silhouette on a black display
  b: 5, d: 2, g: 11, e: 15, w: 15, m: 9, c: 15, r: 15, f: 13, s: 6,
  "#": 15, "+": 10, "-": 5, ":": 3,
});

export function blankImage(width: number, height: number): GrayImage {
  return { width, height, pixels: new Uint8Array(width * height) };
}

/** Draws a bitmap at integer `scale` with its top-left at (x, y). Unknown chars draw at `fallback`. */
export function drawBitmap(target: GrayImage, rows: Bitmap, x: number, y: number, scale = 1, palette = GLASSES_PALETTE, fallback = 12): void {
  rows.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      const level = palette[row[rx]!] ?? fallback;
      if (!level) continue;
      const value = Math.min(15, Math.max(0, level)) * 17;
      for (let dy = 0; dy < scale; dy++) {
        const py = y + ry * scale + dy;
        if (py < 0 || py >= target.height) continue;
        for (let dx = 0; dx < scale; dx++) {
          const px = x + rx * scale + dx;
          if (px >= 0 && px < target.width) target.pixels[py * target.width + px] = value;
        }
      }
    }
  });
}

/** Bitmap size in its own pixels. */
export function bitmapSize(rows: Bitmap): { width: number; height: number } {
  return { width: Math.max(0, ...rows.map(row => row.length)), height: rows.length };
}

/** A bitmap scaled and centred in a w×h image. */
export function centeredImage(rows: Bitmap, width: number, height: number, scale: number, palette = GLASSES_PALETTE): GrayImage {
  const image = blankImage(width, height), size = bitmapSize(rows);
  drawBitmap(image, rows, Math.floor((width - size.width * scale) / 2), Math.floor((height - size.height * scale) / 2), scale, palette);
  return image;
}

/** Number[] for updateImageRawData (the host's List<int> accepts it best). */
export function pngBytes(image: GrayImage): number[] { return Array.from(encodeGrayPng(image)); }
