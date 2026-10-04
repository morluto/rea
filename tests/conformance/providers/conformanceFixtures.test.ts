import { describe, expect, it } from "vitest";

import { sourceDigest } from "../../../scripts/lib/conformance-fixtures.mjs";

describe("source-built conformance fixtures", () => {
  it("hashes source manifests independently of input ordering", () => {
    const left = [
      { path: "b.c", content: "b" },
      { path: "a.c", content: "a" },
    ];
    const right = [...left].reverse();

    expect(sourceDigest(left)).toBe(sourceDigest(right));
    expect(sourceDigest(left)).toMatch(/^[0-9a-f]{64}$/u);
  });
});
