import { describe, expect, it } from "vitest";

import { boundedDecimalTokenPattern } from "../../../src/cli/options.js";

/** Values the pattern must admit or refuse for one [lo, hi] range. */
const checkRange = (
  lo: number,
  hi: number,
  admitted: readonly (number | string)[],
  refused: readonly (number | string)[],
): void => {
  const pattern = new RegExp(boundedDecimalTokenPattern(lo, hi), "u");
  for (const value of admitted)
    expect(pattern.test(String(value))).toBe(true);
  for (const value of refused)
    expect(pattern.test(String(value))).toBe(false);
};

describe("bounded decimal token pattern", () => {
  it("bounds the byte-entropy block size to 256..65536", () => {
    checkRange(
      256,
      65536,
      [256, 257, 4096, 65536, "0256", "00065536", "04096"],
      [0, 1, 255, 65537, 655360, "0x10", "1e1", "", " 256", "256 "],
    );
  });

  it("bounds the sqlite row limit to 1..MAX_SAFE_INTEGER", () => {
    checkRange(
      1,
      Number.MAX_SAFE_INTEGER,
      [1, 20, Number.MAX_SAFE_INTEGER, "01", "09007199254740991"],
      [0, "00", Number.MAX_SAFE_INTEGER + 1, "9007199254740992"],
    );
  });

  it("admits only the single value for a one-point range", () => {
    checkRange(1, 1, [1, "01", "0001"], [0, 2, 10, "11"]);
    checkRange(0, 0, [0, "00", "000"], [1, 10, "01"]);
    checkRange(5, 5, [5, "005", "05"], [4, 6, 55, "15"]);
  });

  it("crosses digit lengths without admitting neighbours", () => {
    checkRange(999, 1001, [999, 1000, 1001, "0999"], [998, 1002, 9999]);
    checkRange(99, 101, [99, 100, 101, "099"], [98, 102, "0102"]);
    checkRange(9, 11, [9, 10, 11, "09"], [8, 12]);
  });

  it("admits exactly the integers in small ranges, exhaustively", () => {
    for (const [lo, hi] of [
      [0, 9],
      [0, 150],
      [95, 205],
      [10, 99],
    ] as const) {
      const pattern = new RegExp(boundedDecimalTokenPattern(lo, hi), "u");
      for (let value = 0; value <= hi + 10; value += 1)
        expect(pattern.test(String(value))).toBe(value >= lo && value <= hi);
      for (let value = lo; value <= hi; value += 1)
        expect(pattern.test(`00${value}`)).toBe(true);
    }
  });
});
