import { inflateSync } from "node:zlib";
import { describe, it, expect } from "vitest";
import { PIXEL_HEADER, pixelHeaderPng } from "../src/pixel-header";

describe("pixel header", () => {
  it("encodes a deterministic, bounded grayscale PNG with visible integer-pixel artwork", () => {
    const bytes = Buffer.from(pixelHeaderPng());
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(bytes.readUInt32BE(16)).toBe(PIXEL_HEADER.width);
    expect(bytes.readUInt32BE(20)).toBe(PIXEL_HEADER.height);
    expect(bytes[24]).toBe(8);
    expect(bytes[25]).toBe(0);
    const dataLength = bytes.readUInt32BE(33);
    const raw = inflateSync(bytes.subarray(41, 41 + dataLength));
    expect(raw.length).toBe((136 + 1) * 32);
    expect(new Set(raw)).toEqual(new Set([0, 85, 170, 255]));
    expect(pixelHeaderPng()).toEqual([...bytes]);
    expect(bytes.length).toBeLessThan(5000);
  });
});
