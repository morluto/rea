import { describe, expect, it } from "vitest";
import { CoverageAccumulator, knownCoverage } from "./coverageAccumulator.js";

describe("CoverageAccumulator", () => {
  it("finalizes to unknown when no observations were recorded", () => {
    expect(new CoverageAccumulator().finalize()).toEqual({
      status: "unknown",
      reasons: [],
    });
  });

  it("finalizes to complete only when every observation is complete", () => {
    const acc = new CoverageAccumulator().recordComplete().merge("complete");
    expect(acc.finalize()).toEqual({ status: "complete", reasons: [] });
    expect(acc.finalizeKnown()).toBe("complete");
    expect(acc.finalizeCompleteOrUnknown()).toBe("complete");
  });

  it("monotonically downgrades complete to partial on omission", () => {
    const acc = new CoverageAccumulator()
      .recordComplete()
      .recordOmission("PE exception directory has 4 unexamined trailing bytes")
      .recordComplete();
    expect(acc.finalize()).toEqual({
      status: "partial",
      reasons: ["PE exception directory has 4 unexamined trailing bytes"],
    });
    expect(acc.finalizeKnown()).toBe("partial");
  });

  it("lets unknown win over partial and complete", () => {
    const acc = new CoverageAccumulator()
      .recordComplete()
      .recordOmission("missing bootloader")
      .recordUnknown("DT_SYMTAB lacks DT_HASH or DT_GNU_HASH bound");
    expect(acc.finalize()).toEqual({
      status: "unknown",
      reasons: [
        "missing bootloader",
        "DT_SYMTAB lacks DT_HASH or DT_GNU_HASH bound",
      ],
    });
    expect(acc.finalizeCompleteOrUnknown()).toBe("unknown");
  });

  it("supports single-condition knownCoverage derivation", () => {
    expect(knownCoverage(true)).toBe("complete");
    expect(knownCoverage(false, "truncated")).toBe("partial");
  });
});
