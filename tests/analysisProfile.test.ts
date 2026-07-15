import { describe, expect, it } from "vitest";

import {
  analysisProfileSchema,
  analysisProfilesEqual,
  createAnalysisProfile,
} from "../src/domain/analysisProfile.js";

const PROVIDER = {
  id: "fixture",
  name: "Fixture analysis provider",
  version: "1.2.3",
} as const;

describe("analysis profile commitments", () => {
  it("canonicalizes parameter key order and validates its digest", () => {
    const first = createAnalysisProfile(PROVIDER, 1, {
      architecture: "arm64",
      analyzers: { strings: true, functions: true },
    });
    const reordered = createAnalysisProfile(PROVIDER, 1, {
      analyzers: { functions: true, strings: true },
      architecture: "arm64",
    });
    expect(reordered.digest).toBe(first.digest);
    expect(analysisProfilesEqual(first, reordered)).toBe(true);
    expect(analysisProfileSchema.parse(first)).toEqual(first);
  });

  it("separates provider builds, profile schemas, and semantic parameters", () => {
    const baseline = createAnalysisProfile(PROVIDER, 1, { loader: "default" });
    const changedBuild = createAnalysisProfile(
      { ...PROVIDER, version: "1.2.4" },
      1,
      { loader: "default" },
    );
    const changedSchema = createAnalysisProfile(PROVIDER, 2, {
      loader: "default",
    });
    const changedParameters = createAnalysisProfile(PROVIDER, 1, {
      loader: "override",
    });
    expect(
      new Set([
        baseline.digest,
        changedBuild.digest,
        changedSchema.digest,
        changedParameters.digest,
      ]).size,
    ).toBe(4);
  });

  it("rejects digest tampering and unbounded parameters", () => {
    const profile = createAnalysisProfile(PROVIDER, 1, { loader: "default" });
    expect(() =>
      analysisProfileSchema.parse({ ...profile, digest: "0".repeat(64) }),
    ).toThrow(/digest/u);
    expect(() =>
      createAnalysisProfile(PROVIDER, 1, {
        oversized: "x".repeat(65 * 1024),
      }),
    ).toThrow(/limit/u);
  });
});
