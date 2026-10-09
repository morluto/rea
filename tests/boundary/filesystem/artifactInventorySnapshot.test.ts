import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { translateArtifactFailure } from "../../../src/artifacts/ArtifactProvider.js";
import {
  ArtifactReaderFailure,
  type ArtifactReader,
} from "../../../src/artifacts/ArtifactReader.js";
import { DirectoryArtifactReader } from "../../../src/artifacts/DirectoryArtifactReader.js";
import { scanCanonicalArtifactInventory } from "../../../src/artifacts/inventory/scanCanonical.js";
import { scanArtifactInventory } from "../../../src/artifacts/inventory/ArtifactInventory.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";

describe("artifact inventory snapshot", () => {
  it("retains the complete scan after the source directory changes", async () => {
    const root = await createTestTempDirectory("rea-inventory-snapshot-");
    await writeFile(join(root, "a.txt"), "a");
    await writeFile(join(root, "b.txt"), "b");
    const snapshot = await scanArtifactInventory(root);

    await rm(join(root, "b.txt"));
    expect(snapshot.occurrences.map(({ logical_path: path }) => path)).toEqual([
      ".",
      "a.txt",
      "b.txt",
    ]);
    expect(snapshot.manifest.occurrence_count).toBe(3);
  });

  it("projects the complete inventory when reader cleanup fails after scanning", async () => {
    const root = await createTestTempDirectory("rea-inventory-cleanup-");
    await writeFile(join(root, "observed.txt"), "observed");
    const directory = new DirectoryArtifactReader(root);
    const reader: ArtifactReader = {
      format: directory.format,
      entries: (signal) => directory.entries(signal),
      open: (entry, signal) => directory.open(entry, signal),
      provenance: () => directory.provenance(),
      async close() {
        await directory.close();
        throw new ArtifactReaderFailure("unavailable", "mount still attached", {
          cleanup: {
            reason: "DMG detach failed",
            resources: ["/dev/disk-test", "/tmp/rea-mount-test"],
          },
        });
      },
    };
    const failure = await scanCanonicalArtifactInventory(
      root,
      {},
      async () => reader,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    if (!(failure instanceof ArtifactReaderFailure))
      throw failure instanceof Error
        ? failure
        : new Error("Expected the reader cleanup failure", { cause: failure });
    const projection = projectAnalysisError(
      translateArtifactFailure("inventory_artifact", failure),
    );
    expect(projection).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        execution_failure: "artifact_operation_failed",
        resources: ["/dev/disk-test", "/tmp/rea-mount-test"],
        partial_observation: {
          kind: "artifact-inventory",
          inventory: {
            manifest: { occurrence_count: 2 },
            occurrences: expect.arrayContaining([
              expect.objectContaining({ logical_path: "observed.txt" }),
            ]),
          },
        },
      },
    });
  });
});
