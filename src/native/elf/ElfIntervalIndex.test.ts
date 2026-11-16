import { expect, it } from "vitest";

import { buildIntervalIndex } from "./ElfIntervalIndex.js";

it("returns the preferred overlapping interval and nothing in gaps", () => {
  const lookup = buildIntervalIndex(
    [
      { low: 0n, high: 100n, value: "wide" },
      { low: 10n, high: 20n, value: "narrow" },
      { low: 200n, high: 210n, value: "far" },
      { low: 5n, high: 5n, value: "empty" },
    ],
    (left, right) =>
      left === "narrow"
        ? -1
        : right === "narrow"
          ? 1
          : left.localeCompare(right),
  );
  expect(lookup(0n)).toBe("wide");
  expect(lookup(9n)).toBe("wide");
  expect(lookup(10n)).toBe("narrow");
  expect(lookup(19n)).toBe("narrow");
  expect(lookup(20n)).toBe("wide");
  expect(lookup(99n)).toBe("wide");
  expect(lookup(100n)).toBeUndefined();
  expect(lookup(205n)).toBe("far");
  expect(lookup(210n)).toBeUndefined();
  expect(lookup(-1n)).toBeUndefined();
});

it("answers many lookups over many overlapping intervals", () => {
  const intervals = Array.from({ length: 65535 }, (_, index) => ({
    low: BigInt(index * 16),
    high: BigInt(index * 16 + 32),
    value: index,
  }));
  const lookup = buildIntervalIndex(intervals, (left, right) => left - right);
  expect(lookup(0n)).toBe(0);
  expect(lookup(16n)).toBe(0);
  expect(lookup(32n)).toBe(1);
  expect(lookup(BigInt(65534 * 16 + 31))).toBe(65534);
});
