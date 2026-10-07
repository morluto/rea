import { describe, expect, it } from "vitest";

import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";

describe("Unicode code-point ordering", () => {
  it("orders supplementary characters by scalar value rather than UTF-16 units", () => {
    expect(compareUnicodeCodePoints("\uE000", "\u{10000}")).toBeLessThan(0);
    expect(compareUnicodeCodePoints("\u{10000}", "\uE000")).toBeGreaterThan(0);
  });

  it.each([
    ["", "a", -1],
    ["same", "same", 0],
    ["a", "aa", -1],
    ["e\u0301", "\u00e9", -132],
    ["\uD800", "\uD801", -1],
  ])("orders %j and %j by scalar value", (left, right, expectedSign) => {
    expect(Math.sign(compareUnicodeCodePoints(left, right))).toBe(
      Math.sign(expectedSign),
    );
  });
});
