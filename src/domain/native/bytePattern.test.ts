import { describe, expect, it } from "vitest";
import { parseBytePattern } from "./bytePattern.js";

describe("masked byte patterns", () => {
  it("preserves whole-byte wildcards and combines explicit bit masks", () => {
    const parsed = parseBytePattern("48 8b\t??89", "ff f0 ff 0f");
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value).toEqual({
      bytes: [0x48, 0x8b, 0, 0x89],
      masks: [255, 240, 0, 15],
    });
    const exact = parseBytePattern("Aa\u00a000");
    if (!exact.ok) throw exact.error;
    expect(exact.value).toEqual({ bytes: [170, 0], masks: [255, 255] });
  });

  it.each([
    ["", undefined, "pattern"],
    ["4", undefined, "pattern"],
    ["4?", undefined, "pattern"],
    ["gg", undefined, "pattern"],
    ["?? ??", undefined, "pattern"],
    ["ff", "00", "pattern"],
    ["ffff", "ff", "mask"],
    ["ff", "??", "mask"],
  ])("rejects invalid pattern %s with typed issues", (pattern, mask, field) => {
    const parsed = parseBytePattern(pattern, mask);
    if (parsed.ok) throw new Error("Expected a rejected pattern");
    expect(parsed.error.issues).toMatchObject([
      { path: [field], reason: "invalid_value" },
    ]);
  });
});
