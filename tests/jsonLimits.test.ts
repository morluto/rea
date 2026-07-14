import { describe, expect, it } from "vitest";

import { isJsonWithinLimits } from "../src/domain/jsonLimits.js";

const limits = {
  maxDepth: 3,
  maxStringLength: 8,
  maxNodes: 6,
};

describe("JSON limits", () => {
  it("traverses nested object and array values", () => {
    expect(isJsonWithinLimits({ one: ["two", { three: 3 }] }, limits)).toBe(
      true,
    );
    expect(
      isJsonWithinLimits({ one: ["two", { three: "too-long-value" }] }, limits),
    ).toBe(false);
  });

  it("enforces depth, node, and object-key limits", () => {
    expect(
      isJsonWithinLimits(
        { one: { two: { three: null } } },
        {
          ...limits,
          maxDepth: 2,
        },
      ),
    ).toBe(false);
    expect(isJsonWithinLimits([1, 2, 3], { ...limits, maxNodes: 3 })).toBe(
      false,
    );
    expect(isJsonWithinLimits({ "too-long-key": true }, limits)).toBe(false);
  });
});
