import { describe, expect, it } from "vitest";
import { executableFormatHintSchema, validateDosComLength } from "./dosCom.js";

describe("explicit DOS COM interpretation", () => {
  it.each([1, 0xff00])("admits the segment extent %i", (length) => {
    expect(validateDosComLength(length).ok).toBe(true);
  });
  it.each([0, -1, 0xff01, 1.5, NaN, Infinity])(
    "rejects invalid extent %i",
    (length) => {
      expect(validateDosComLength(length).ok).toBe(false);
    },
  );
  it("does not turn arbitrary format names into raw COM", () => {
    expect(executableFormatHintSchema.safeParse("dos-com").success).toBe(true);
    expect(executableFormatHintSchema.safeParse("raw").success).toBe(false);
  });
});
