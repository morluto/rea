import { describe, expect, it } from "vitest";

import { compareDirectoryChildNames } from "./ArtifactGraphConstruction.js";

const tiedNames = ["a.txt", "a\u200b.txt", "a\u200c.txt", "a\u200d.txt"];

describe("directory child-name ordering", () => {
  it("orders the tied subset lexically with reflexivity and antisymmetry", () => {
    for (const left of tiedNames) {
      expect(compareDirectoryChildNames(left, left)).toBe(0);
      for (const right of tiedNames) {
        expect(left.localeCompare(right)).toBe(0);
        const compared = compareDirectoryChildNames(left, right);
        const lexical = left < right ? -1 : left > right ? 1 : 0;
        expect(compared).toBe(lexical);
        expect(compared + compareDirectoryChildNames(right, left)).toBe(0);
      }
    }
  });

  it("is transitive across the tied subset", () => {
    for (const first of tiedNames)
      for (const second of tiedNames)
        for (const third of tiedNames)
          if (
            compareDirectoryChildNames(first, second) <= 0 &&
            compareDirectoryChildNames(second, third) <= 0
          )
            expect(
              compareDirectoryChildNames(first, third),
            ).toBeLessThanOrEqual(0);
  });

  it.each([
    ["a.txt", "b.txt"],
    ["z.txt", "ä.txt"],
    ["Z", "a"],
    ["a/data.txt", "b/data.txt"],
  ])("preserves the current non-tied collation for %s / %s", (left, right) => {
    const collated = left.localeCompare(right);
    expect(collated).not.toBe(0);
    expect(compareDirectoryChildNames(left, right)).toBe(collated);
    expect(compareDirectoryChildNames(right, left)).toBe(
      right.localeCompare(left),
    );
  });
});
