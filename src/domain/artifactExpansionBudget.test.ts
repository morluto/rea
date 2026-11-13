import { describe, expect, it } from "vitest";
import { artifactExpansionBudgetBytes } from "./artifactExpansionBudget.js";
describe("artifactExpansionBudgetBytes", () => {
  it("grants at least the floor and grows with the encoded archive size", () => {
    expect(artifactExpansionBudgetBytes(0)).toBe(256 * 1024 * 1024);
    expect(artifactExpansionBudgetBytes(1024)).toBe(256 * 1024 * 1024);
    expect(artifactExpansionBudgetBytes(1024 * 1024)).toBe(500 * 1024 * 1024);
  });
  it("keeps cumulative byte accounting within the exact number domain", () => {
    expect(artifactExpansionBudgetBytes(Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
});
