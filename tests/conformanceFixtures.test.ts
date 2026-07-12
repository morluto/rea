import { describe, expect, it } from "vitest";

import {
  generateLargeFixture,
  LARGE_FIXTURE_COUNT,
  sha256,
  sourceDigest,
} from "../scripts/lib/conformance-fixtures.mjs";

describe("source-built conformance fixtures", () => {
  it("generates a deterministic large pagination fixture", () => {
    const first = generateLargeFixture();
    const second = generateLargeFixture();

    expect(first).toBe(second);
    expect(first.match(/int rea_page_/gu)).toHaveLength(LARGE_FIXTURE_COUNT);
    expect(first).toContain("rea_page_0000");
    expect(first).toContain("rea_page_1204");
    expect(() => generateLargeFixture(0)).toThrow(/positive integer/u);
  });

  it("hashes source manifests independently of input ordering", () => {
    const left = [
      { path: "b.c", content: "b" },
      { path: "a.c", content: "a" },
    ];
    const right = [...left].reverse();

    expect(sourceDigest(left)).toBe(sourceDigest(right));
    expect(sourceDigest(left)).toMatch(/^[0-9a-f]{64}$/u);
    expect(sha256("fixture")).not.toBe(sha256("changed"));
  });
});
