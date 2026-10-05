import { describe, expect, it } from "vitest";

import {
  createSeededRandom,
  createSeededRandomUint,
  normalizeXorshift32Seed,
  NON_DEGENERATE_XORSHIFT32_SEED,
} from "./seededRandom.js";

describe("seeded replay randomness", () => {
  it("does not collapse to a constant when seeded with zero", () => {
    const random = createSeededRandom(0);
    const values = [random(), random(), random()];
    expect(new Set(values).size).toBe(3);
    expect(values.every((value) => value === 0)).toBe(false);
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it("substitutes a fixed non-zero state for a zero seed", () => {
    expect(normalizeXorshift32Seed(0)).toBe(NON_DEGENERATE_XORSHIFT32_SEED);
    expect(normalizeXorshift32Seed(7)).toBe(7);
    // Deterministic: the same seed must always give the same stream.
    expect(Array.from({ length: 3 }, createSeededRandom(0))).toEqual(
      Array.from({ length: 3 }, createSeededRandom(0)),
    );
  });

  it("produces the same stream regardless of which generator is used", () => {
    const floats = createSeededRandom(11);
    const uints = createSeededRandomUint(11);
    expect([floats(), floats(), floats()]).toEqual([
      uints() / 0x1_0000_0000,
      uints() / 0x1_0000_0000,
      uints() / 0x1_0000_0000,
    ]);
  });

  it("keeps distinct seeds on distinct streams", () => {
    const first = Array.from({ length: 4 }, createSeededRandom(1));
    const second = Array.from({ length: 4 }, createSeededRandom(2));
    expect(first).not.toEqual(second);
  });
});
