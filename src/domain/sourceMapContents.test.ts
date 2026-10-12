import { expect, it } from "vitest";

import { hasValidSourceMapContents } from "./sourceMapContents.js";

it("accepts absent map-level source contents and aligned nullable slots", () => {
  expect(hasValidSourceMapContents(2, undefined)).toBe(true);
  expect(hasValidSourceMapContents(2, null)).toBe(true);
  expect(hasValidSourceMapContents(2, [null, "retained source"])).toBe(true);
  expect(hasValidSourceMapContents(2, ["retained source"])).toBe(false);
  expect(hasValidSourceMapContents(2, [null, 42])).toBe(false);
});
