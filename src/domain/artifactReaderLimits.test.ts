import { expect, it } from "vitest";

import {
  DEFAULT_ANDROID_VBMETA_READER_LIMITS,
  artifactReaderLimitsInputSchema,
  artifactReaderLimitsSchema,
  resolveArtifactReaderLimits,
} from "./artifactReaderLimits.js";

it("resolves vbmeta admission and still parses Evidence recorded before it", () => {
  const resolved = resolveArtifactReaderLimits({
    android_vbmeta: { descriptor_count: 4097 },
  });
  expect(resolved.android_vbmeta).toEqual({
    ...DEFAULT_ANDROID_VBMETA_READER_LIMITS,
    descriptor_count: 4097,
  });
  expect(artifactReaderLimitsSchema.parse(resolved)).toEqual(resolved);

  const { android_vbmeta: _omitted, ...recorded } =
    resolveArtifactReaderLimits();
  expect(artifactReaderLimitsSchema.parse(recorded)).toEqual(recorded);

  expect(
    artifactReaderLimitsInputSchema.safeParse({
      android_vbmeta: { descriptor_count: 0 },
    }).success,
  ).toBe(false);
  expect(
    artifactReaderLimitsInputSchema.safeParse({
      android_vbmeta: { signature_bytes: 1 },
    }).success,
  ).toBe(false);
});
