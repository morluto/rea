import { expect, it } from "vitest";

import { godotPckDataStartsAfterHeader } from "./godotPckFormat.js";

it.each([
  [1, 84],
  [2, 96],
  [3, 104],
  [4, 104],
] as const)("admits data at the format %i header boundary", (version, size) => {
  const packStart = 23;
  expect(
    godotPckDataStartsAfterHeader(packStart, version, packStart + size - 1),
  ).toBe(false);
  expect(
    godotPckDataStartsAfterHeader(packStart, version, packStart + size),
  ).toBe(true);
});
