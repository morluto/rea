import { describe, expect, it } from "vitest";

import { inspectManagedArtifactBytes } from "./ManagedArtifactInspector.js";
import {
  buildManagedPeFixture,
  buildNativePeFixture,
  managedPeFixtureTarget,
  MANAGED_ARTIFACT_FIXTURE_LIMITS,
} from "./ManagedPe.fixture.js";

describe("managed artifact failure classification", () => {
  it("distinguishes native, malformed, unsupported, and bounded metadata", () => {
    const nativeBytes = buildNativePeFixture();
    const native = inspectManagedArtifactBytes(
      nativeBytes,
      managedPeFixtureTarget(nativeBytes),
      MANAGED_ARTIFACT_FIXTURE_LIMITS,
    );
    expect(native).toMatchObject({
      classification: { status: "not-managed" },
      metadata: { status: "absent" },
      coverage: { state: "unavailable" },
    });

    const malformedBytes = buildManagedPeFixture({
      corruptMetadataSignature: true,
    });
    const malformed = inspectManagedArtifactBytes(
      malformedBytes,
      managedPeFixtureTarget(malformedBytes),
      MANAGED_ARTIFACT_FIXTURE_LIMITS,
    );
    expect(malformed.classification.status).toBe("malformed");
    expect(malformed.coverage.issues).toEqual([
      expect.objectContaining({ code: "invalid-metadata-root" }),
    ]);

    const unsupportedTableBytes = buildManagedPeFixture({
      metadataValidMaskExtra: 1n << 50n,
    });
    const unsupportedTable = inspectManagedArtifactBytes(
      unsupportedTableBytes,
      managedPeFixtureTarget(unsupportedTableBytes),
      MANAGED_ARTIFACT_FIXTURE_LIMITS,
    );
    expect(unsupportedTable.coverage.issues).toEqual([
      expect.objectContaining({ code: "invalid-tables" }),
    ]);

    const limitedBytes = buildManagedPeFixture();
    const limited = inspectManagedArtifactBytes(
      limitedBytes,
      managedPeFixtureTarget(limitedBytes),
      { ...MANAGED_ARTIFACT_FIXTURE_LIMITS, maxMetadataBytes: 256 },
    );
    expect(limited.metadata.status).toBe("partial");
    expect(limited.coverage.issues).toEqual([
      expect.objectContaining({ code: "limit-exceeded" }),
    ]);
  });
});
