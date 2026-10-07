import { describe, expect, it } from "vitest";

import {
  bundleClassificationToCanonical,
  comparisonConclusionSchema,
  comparisonStatusSchema,
  functionStatusToCanonical,
  scenarioArtifactStatusToCanonical,
  sourceToBundleStatusToCanonical,
} from "./comparisonStatus.js";

describe("comparison status vocabulary", () => {
  it("owns the canonical unchanged/changed/unknown triple", () => {
    expect(comparisonStatusSchema.options).toEqual([
      "unchanged",
      "changed",
      "unknown",
    ]);
    expect(comparisonConclusionSchema.options).toEqual([
      "observed_change",
      "derived_relationship",
      "contradiction",
      "unresolved_branch",
    ]);
  });

  it("projects every bundle classification", () => {
    expect(
      (
        [
          "added",
          "removed",
          "changed",
          "unknown",
          "history_advanced",
          "history_diverged",
        ] as const
      ).map(bundleClassificationToCanonical),
    ).toEqual([
      "changed",
      "changed",
      "changed",
      "unknown",
      "changed",
      "changed",
    ]);
  });

  it("projects every source-to-bundle item status", () => {
    expect(
      (
        [
          "unchanged",
          "modified",
          "removed",
          "split",
          "merged",
          "duplicated",
          "unknown",
        ] as const
      ).map(sourceToBundleStatusToCanonical),
    ).toEqual([
      "unchanged",
      "changed",
      "changed",
      "changed",
      "changed",
      "changed",
      "unknown",
    ]);
  });

  it("projects every function dimension status without claiming truncated work", () => {
    expect(
      (["unchanged", "changed", "truncated", "unknown"] as const).map(
        functionStatusToCanonical,
      ),
    ).toEqual(["unchanged", "changed", "unknown", "unknown"]);
  });

  it("projects every scenario artifact status", () => {
    expect(
      (["changed", "unknown"] as const).map(scenarioArtifactStatusToCanonical),
    ).toEqual(["changed", "unknown"]);
  });
});
