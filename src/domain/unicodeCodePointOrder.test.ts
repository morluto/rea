import { describe, expect, it } from "vitest";

import {
  compareUnicodeCodePoints,
  compositeKey,
} from "./unicodeCodePointOrder.js";

describe("compareUnicodeCodePoints", () => {
  it("returns zero for identical and empty strings", () => {
    expect(compareUnicodeCodePoints("", "")).toBe(0);
    expect(compareUnicodeCodePoints("abc", "abc")).toBe(0);
    expect(compareUnicodeCodePoints("🚀", "🚀")).toBe(0);
  });

  it("orders ASCII strings and respects case sensitivity", () => {
    expect(compareUnicodeCodePoints("a", "b")).toBeLessThan(0);
    expect(compareUnicodeCodePoints("b", "a")).toBeGreaterThan(0);
    expect(compareUnicodeCodePoints("apple", "banana")).toBeLessThan(0);
    expect(compareUnicodeCodePoints("banana", "apple")).toBeGreaterThan(0);
    expect(compareUnicodeCodePoints("A", "a")).toBeLessThan(0);
    expect(compareUnicodeCodePoints("a", "A")).toBeGreaterThan(0);
  });

  it("handles prefix ordering in both directions", () => {
    expect(compareUnicodeCodePoints("a", "ab")).toBe(-1);
    expect(compareUnicodeCodePoints("ab", "a")).toBe(1);
    expect(compareUnicodeCodePoints("", "nonempty")).toBe(-1);
    expect(compareUnicodeCodePoints("nonempty", "")).toBe(1);
  });

  it("preserves Unicode code-point order over UTF-16 surrogate inversion", () => {
    // In UTF-16, "\u{10000}" is encoded with a leading surrogate \uD800 (55296),
    // which standard JavaScript "<" incorrectly places before "\uE000" (57344).
    // In Unicode code-point order, U+E000 (57344) must precede U+10000 (65536).
    expect(compareUnicodeCodePoints("\uE000", "\u{10000}")).toBeLessThan(0);
    expect(compareUnicodeCodePoints("\u{10000}", "\uE000")).toBeGreaterThan(0);
  });

  it("orders strings with supplementary-plane characters", () => {
    // ✨ is U+2728 (9984), 🚀 is U+1F680 (128640), 🛸 is U+1F6F8 (128760)
    expect(compareUnicodeCodePoints("✨", "🚀")).toBeLessThan(0);
    expect(compareUnicodeCodePoints("🚀", "✨")).toBeGreaterThan(0);
    expect(compareUnicodeCodePoints("🚀", "🛸")).toBeLessThan(0);
    expect(compareUnicodeCodePoints("🛸", "🚀")).toBeGreaterThan(0);
  });

  it("advances code-unit indices correctly when astral characters precede other characters", () => {
    // 🚀 occupies two UTF-16 code units (surrogate pair); comparison must advance by 2
    expect(compareUnicodeCodePoints("🚀a", "🚀b")).toBeLessThan(0);
    expect(compareUnicodeCodePoints("🚀b", "🚀a")).toBeGreaterThan(0);
    expect(compareUnicodeCodePoints("🚀", "🚀a")).toBe(-1);
    expect(compareUnicodeCodePoints("🚀a", "🚀")).toBe(1);
  });

  it("sorts arrays deterministically across ASCII, BMP, and supplementary characters", () => {
    const unsorted = ["b", "a", "🚀", "\uE000", "ab", "✨", "A", "🚀a"];
    const sorted = [...unsorted].sort(compareUnicodeCodePoints);
    expect(sorted).toEqual(["A", "a", "ab", "b", "✨", "\uE000", "🚀", "🚀a"]);
  });
});

describe("compositeKey", () => {
  it("serializes an empty tuple", () => {
    expect(compositeKey([])).toBe("[]");
  });

  it("serializes heterogeneous primitive values", () => {
    expect(compositeKey(["scope", 42, true, null])).toBe(
      '["scope",42,true,null]',
    );
  });

  it("prevents collisions when values contain embedded NUL characters", () => {
    const keyA = compositeKey(["a\u0000b", "c"]);
    const keyB = compositeKey(["a", "b\u0000c"]);
    expect(keyA).toBe('["a\\u0000b","c"]');
    expect(keyB).toBe('["a","b\\u0000c"]');
    expect(keyA).not.toBe(keyB);
  });

  it("prevents collisions when values contain delimiters like commas", () => {
    const keyA = compositeKey(["a,b", "c"]);
    const keyB = compositeKey(["a", "b,c"]);
    expect(keyA).not.toBe(keyB);
  });

  it("distinguishes numbers from numeric strings", () => {
    expect(compositeKey([1])).toBe("[1]");
    expect(compositeKey(["1"])).toBe('["1"]');
    expect(compositeKey([1])).not.toBe(compositeKey(["1"]));
  });

  it("accepts readonly array inputs", () => {
    const parts: readonly (string | number)[] = ["entry", 123];
    expect(compositeKey(parts)).toBe('["entry",123]');
  });
});
