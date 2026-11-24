import { describe, expect, it } from "vitest";
import {
  calculateChunkEntropy,
  calculateShannonEntropy,
  isLikelyPackedOrEncrypted,
} from "./ShannonEntropy.js";

describe("ShannonEntropy", () => {
  it("calculates 0 entropy for uniform byte arrays", () => {
    const zeros = new Uint8Array(100).fill(0);
    expect(calculateShannonEntropy(zeros)).toBe(0);

    const empty = new Uint8Array(0);
    expect(calculateShannonEntropy(empty)).toBe(0);
  });

  it("calculates high entropy for pseudorandom / uniform distribution", () => {
    // 256 unique bytes exactly once has theoretical entropy of 8.0
    const fullByteRange = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) fullByteRange[i] = i;
    const entropy = calculateShannonEntropy(fullByteRange);
    expect(entropy).toBeCloseTo(8.0, 4);
    expect(isLikelyPackedOrEncrypted(entropy)).toBe(true);
  });

  it("identifies plain ascii text as low entropy", () => {
    const text = Buffer.from(
      "The quick brown fox jumps over the lazy dog. Repetitive text has low entropy.",
    );
    const entropy = calculateShannonEntropy(text);
    expect(entropy).toBeLessThan(5.0);
    expect(isLikelyPackedOrEncrypted(entropy)).toBe(false);
  });

  it("calculates chunked entropy across blocks", () => {
    const block1 = new Uint8Array(64).fill(0xaa); // 0 entropy
    const block2 = new Uint8Array(64); // some entropy
    for (let i = 0; i < 64; i += 1) block2[i] = i;

    const combined = new Uint8Array(128);
    combined.set(block1, 0);
    combined.set(block2, 64);

    const chunks = calculateChunkEntropy(combined, 64);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(0);
    expect(chunks[1]).toBeGreaterThan(5.0);

    expect(calculateChunkEntropy(combined, 0.5)).toEqual([]);
    expect(calculateChunkEntropy(combined, -1)).toEqual([]);
    expect(calculateChunkEntropy(combined, Number.NaN)).toEqual([]);
  });
});
