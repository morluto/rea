import { describe, expect, it } from "vitest";

import { compareCodePoints, uniqueSorted } from "./canonicalOrdering.js";

const REPLACEMENT = "\uFFFD";
const GRINNING = "\u{1F600}";

describe("compareCodePoints", () => {
  it("orders by Unicode code point, not UTF-16 code unit", () => {
    // U+FFFD < U+1F600, but the astral character's lead surrogate 0xD83D is
    // numerically below U+FFFD, so a code-unit comparison inverts this pair.
    expect(compareCodePoints(REPLACEMENT, GRINNING)).toBeLessThan(0);
    expect(compareCodePoints(GRINNING, REPLACEMENT)).toBeGreaterThan(0);
  });

  it("keeps a prefix before its own extension", () => {
    expect(compareCodePoints("ab", "abc")).toBe(-1);
    expect(compareCodePoints("abc", "ab")).toBe(1);
  });

  it("orders astral characters by code point against the BMP tail", () => {
    const ordered = ["\uFFFD", "\uFFFF", "\u{1F600}"];
    for (const [index, left] of ordered.entries())
      for (const right of ordered.slice(index + 1))
        expect(compareCodePoints(left, right)).toBeLessThan(0);
  });
});

describe("uniqueSorted", () => {
  it("deduplicates and orders astral values by code point", () => {
    expect(uniqueSorted([GRINNING, REPLACEMENT, GRINNING])).toEqual([
      REPLACEMENT,
      GRINNING,
    ]);
  });
});
