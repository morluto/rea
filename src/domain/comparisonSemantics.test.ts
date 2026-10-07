import { describe, expect, it } from "vitest";

import { absenceClaimable } from "./comparisonSemantics.js";

describe("shared comparison semantics", () => {
  it("permits absence claims only for complete, non-truncated inventories", () => {
    expect(
      absenceClaimable({
        status: "complete",
        truncated: false,
        omitted_count: 0,
      }),
    ).toBe(true);
    expect(
      absenceClaimable({
        status: "complete",
        truncated: true,
        omitted_count: 2,
      }),
    ).toBe(false);
    expect(
      absenceClaimable({
        status: "complete",
        truncated: false,
        omitted_count: 1,
      }),
    ).toBe(false);
    expect(absenceClaimable({ status: "partial" })).toBe(false);
  });
});
