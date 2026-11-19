import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { lz4DistanceFixture } from "../../fixtures/lz4Distance.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { buildUnityFs } from "../../fixtures/unityfs.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "preserves a liblz4 long-distance block's bytes and identity through UnityFS CLI inspection and extraction",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-unity-lz4-distance-");
    const path = join(root, "bundle");
    const { source, encoded, sha256 } = await lz4DistanceFixture();
    const bytes = buildUnityFs([{ path: "payload.bin", data: source }], {
      blockCompression: 2,
      blocksInfoCompression: 0,
      encodeBlock: (input) => {
        expect(input.equals(source)).toBe(true);
        return encoded;
      },
    });
    await writeFile(path, bytes);
    const inspected = await cli.run({
      arguments: ["inspect-artifact", path, "--json"],
    });
    expect(inspected.exitCode, inspected.stderr).toBe(0);
    const inventory = artifactInspectionResultSchema.parse(
      parseEvidence(inspected.json).normalized_result,
    ).substeps[0]!.evidence.normalized_result;
    const occurrence = inventory.occurrences.find(
      ({ logical_path }) => logical_path === "payload.bin",
    );
    expect(occurrence).toMatchObject({
      hash_status: "verified",
      source_location: null,
    });
    expect(
      inventory.nodes.find(
        ({ artifact_id }) => artifact_id === occurrence?.artifact_id,
      ),
    ).toMatchObject({ sha256, size: source.length });

    const outputRoot = join(root, "extracted");
    const extracted = await cli.run({
      arguments: [
        "extract-artifact",
        path,
        "--output-root",
        outputRoot,
        "--json",
      ],
    });
    expect(extracted.exitCode, extracted.stderr).toBe(0);
    const output = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.json).normalized_result,
    );
    expect(output.artifacts).toContainEqual(
      expect.objectContaining({
        artifact_id: occurrence?.artifact_id,
        relative_path: "payload.bin",
        sha256,
        bytes_written: source.length,
      }),
    );
    expect(
      (await readFile(join(outputRoot, "payload.bin"))).equals(source),
    ).toBe(true);
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);
