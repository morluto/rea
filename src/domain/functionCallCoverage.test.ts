import { describe, expect, it } from "vitest";

import {
  combineFunctionRelationshipCoverage,
  isCallerOnlyUnknownCoverage,
} from "./functionCallCoverage.js";
import type { RelationshipCoverage } from "./relationshipCoverage.js";

const unknownCallers: RelationshipCoverage = {
  status: "unknown",
  reason: "Upstream xrefs do not establish direct caller relationships.",
};
const unknownCallees: RelationshipCoverage = {
  status: "unknown",
  reason: "Upstream callees are not observed in this profile.",
};
const cappedCallees: RelationshipCoverage = {
  status: "partial",
  limitations: [
    "Upstream callees capped results at 500; additional callees remain unknown.",
  ],
};
const complete: RelationshipCoverage = { status: "complete" };

describe("isCallerOnlyUnknownCoverage", () => {
  it("detects unknown callers beside complete callees", () => {
    const combined = combineFunctionRelationshipCoverage(
      unknownCallers,
      complete,
    );
    expect(combined.status).toBe("unknown");
    expect(isCallerOnlyUnknownCoverage(combined)).toBe(true);
  });

  it("rejects unknown callees beside complete callers", () => {
    const combined = combineFunctionRelationshipCoverage(
      complete,
      unknownCallees,
    );
    expect(isCallerOnlyUnknownCoverage(combined)).toBe(false);
  });

  it("rejects unknown coverage on both sides", () => {
    const combined = combineFunctionRelationshipCoverage(
      unknownCallers,
      unknownCallees,
    );
    expect(isCallerOnlyUnknownCoverage(combined)).toBe(false);
  });

  it("rejects unknown callers beside IDA-capped callees", () => {
    const combined = combineFunctionRelationshipCoverage(
      unknownCallers,
      cappedCallees,
    );
    expect(combined.status).toBe("unknown");
    expect(isCallerOnlyUnknownCoverage(combined)).toBe(false);
  });

  it("rejects complete coverage", () => {
    const combined = combineFunctionRelationshipCoverage(complete, complete);
    expect(isCallerOnlyUnknownCoverage(combined)).toBe(false);
  });
});
