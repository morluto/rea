import { describe, expect, it } from "vitest";
import {
  ARTIFACT_EXPANSION_RATIO,
  artifactExpansionBudgetBytes,
  MINIMUM_ARTIFACT_EXPANDED_BYTES,
} from "./artifactExpansionBudget.js";
describe("artifactExpansionBudgetBytes", () => {
  it("grants at least the floor and grows with the encoded archive size", () => {
    expect(artifactExpansionBudgetBytes(0)).toBe(
      MINIMUM_ARTIFACT_EXPANDED_BYTES,
    );
    expect(artifactExpansionBudgetBytes(1024)).toBe(
      MINIMUM_ARTIFACT_EXPANDED_BYTES,
    );
    const large = MINIMUM_ARTIFACT_EXPANDED_BYTES * 4;
    expect(artifactExpansionBudgetBytes(large)).toBe(
      large * ARTIFACT_EXPANSION_RATIO,
    );
  });
  it("keeps cumulative byte accounting within the exact number domain", () => {
    expect(artifactExpansionBudgetBytes(Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
  it("pins the documented ZIP expansion policy constants", () => {
    expect(ARTIFACT_EXPANSION_RATIO).toBe(500);
    expect(MINIMUM_ARTIFACT_EXPANDED_BYTES).toBe(256 * 1024 * 1024);
  });
  it("truncates fractional archive sizes to whole bytes before scaling", () => {
    const large = MINIMUM_ARTIFACT_EXPANDED_BYTES * 4;
    expect(artifactExpansionBudgetBytes(large + 0.9)).toBe(
      large * ARTIFACT_EXPANSION_RATIO,
    );
  });
  it("holds the floor until the scaled size strictly exceeds it", () => {
    const justBelow = Math.floor(
      MINIMUM_ARTIFACT_EXPANDED_BYTES / ARTIFACT_EXPANSION_RATIO,
    );
    expect(artifactExpansionBudgetBytes(justBelow)).toBe(
      MINIMUM_ARTIFACT_EXPANDED_BYTES,
    );
    expect(artifactExpansionBudgetBytes(justBelow + 1)).toBe(
      (justBelow + 1) * ARTIFACT_EXPANSION_RATIO,
    );
  });
});
