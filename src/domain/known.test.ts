import { expect, it } from "vitest";

import { known, knownOrNull, sumKnownCounts, unknownBecause } from "./known.js";

it("sums known counts and keeps the first unknown rather than counting it as zero", () => {
  expect(sumKnownCounts([])).toEqual(known(0));
  expect(sumKnownCounts([known(2), known(3)])).toEqual(known(5));
  expect(
    sumKnownCounts([
      known(2),
      unknownBecause("first"),
      known(3),
      unknownBecause("second"),
    ]),
  ).toEqual({ known: false, reason: "first" });
});

it("projects an unknown fact to null and a known zero to zero", () => {
  expect(knownOrNull(known(0), (count) => count)).toBe(0);
  expect(knownOrNull(unknownBecause("unread"), (count: number) => count)).toBe(
    null,
  );
});
