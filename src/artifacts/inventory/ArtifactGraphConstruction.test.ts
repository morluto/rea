import { expect, it } from "vitest";

import { compareDirectoryChildNames } from "./ArtifactGraphConstruction.js";

it("breaks locale-collation ties deterministically by code unit", () => {
  const names = ["a\u200d.txt", "a.txt", "a\u200b.txt", "a\u200c.txt"];
  expect("a\u200d.txt".localeCompare("a.txt")).toBe(0);
  expect(names.sort(compareDirectoryChildNames)).toEqual([
    "a.txt",
    "a\u200b.txt",
    "a\u200c.txt",
    "a\u200d.txt",
  ]);
});
