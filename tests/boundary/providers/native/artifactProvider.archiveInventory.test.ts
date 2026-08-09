import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createPackage, createPackageWithOptions } from "@electron/asar";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { runProviderAnalysis } from "../../../../src/application/DirectAnalysis.js";
import { ArtifactProvider } from "../../../../src/artifacts/ArtifactProvider.js";
import {
  artifactInspectionInputSchema,
  artifactInventoryInputSchema,
} from "../../../../src/contracts/artifactToolContracts.js";
import { artifactInventoryResultSchema } from "../../../../src/domain/artifactGraph.js";
import { artifactInspectionResultSchema } from "../../../../src/domain/artifactInspection.js";
import type { BinaryTarget } from "../../../../src/domain/binaryTarget.js";
import { parseBinaryTarget } from "../../../../src/domain/binaryTarget.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";

describe("artifact archive inventory", () => {
  it("streams ZIP and official ASAR inventories within shared limits", async () => {
    const root = await createTestTempDirectory("rea-containers-");
    const zipPath = join(root, "fixture.apk");
    const zipWriter = new ZipWriter(new Uint8ArrayWriter());
    await zipWriter.add("assets/index.js", new TextReader("export default 1;"));
    await zipWriter.add("lib/arm64-v8a/addon.so", new TextReader("native"));
    await writeFile(zipPath, await zipWriter.close());
    const parsed = await parseBinaryTarget(zipPath);
    expect(parsed.ok && parsed.value.format).toBe("apk");
    if (!parsed.ok) return;
    const zipResult = await inventory(parsed.value);
    expect(zipResult.occurrences.total).toBe(3);
    expect(zipResult.nodes.items.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["javascript", "dynamic-library"]),
    );
    const cliEvidence = parseEvidence(
      await runProviderAnalysis(zipPath, "inventory_artifact", {}),
    );
    expect(cliEvidence).toMatchObject({
      operation: "inventory_artifact",
      provider: { id: "rea-artifact-graph" },
      subject: { format: "apk" },
    });
    const inspectionEvidence = parseEvidence(
      await runProviderAnalysis(zipPath, "inspect_artifact", {
        max_observations: 2,
        max_relationships: 1,
      }),
    );
    const inspection = artifactInspectionResultSchema.parse(
      inspectionEvidence.normalized_result,
    );
    expect(inspection).toMatchObject({
      substeps: [
        {
          operation: "inventory_artifact",
          status: "completed",
          evidence_id: expect.stringMatching(/^ev_[a-f0-9]{64}$/u),
        },
      ],
      coverage: { status: "truncated", substeps_completed: 1 },
    });
    expect(inspectionEvidence.evidence_links).toEqual(
      inspection.evidence_links,
    );
    const cancellation = new AbortController();
    cancellation.abort();
    await expect(
      runProviderAnalysis(
        zipPath,
        "inventory_artifact",
        {},
        undefined,
        cancellation.signal,
      ),
    ).resolves.toMatchObject({ code: "cancelled" });
    await expect(
      runProviderAnalysis(
        zipPath,
        "inspect_artifact",
        {},
        undefined,
        cancellation.signal,
      ),
    ).resolves.toMatchObject({ code: "cancelled" });

    const source = join(root, "asar-source");
    await mkdir(source);
    await writeFile(join(source, "main.js"), "console.log('ok');\n");
    const asarPath = join(root, "app.asar");
    await createPackage(source, asarPath);
    const asarResult = await inventory(target(asarPath, "asar"));
    expect(asarResult.occurrences.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ logical_path: "main.js" }),
      ]),
    );

    const unpackedPath = join(root, "unpacked.asar");
    await createPackageWithOptions(source, unpackedPath, { unpack: "*.js" });
    const unpackedResult = await inventory(target(unpackedPath, "asar"));
    expect(unpackedResult.occurrences.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          logical_path: "main.js",
          hash_status: "verified",
        }),
      ]),
    );
    await writeFile(
      join(`${unpackedPath}.unpacked`, "main.js"),
      "changed();\n",
    );
    const corrupted = await new ArtifactProvider()
      .createClient(target(unpackedPath, "asar"))
      .execute("inventory_artifact", artifactInventoryInputSchema.parse({}));
    expect(corrupted).toMatchObject({
      ok: false,
      error: {
        _tag: "ArtifactOperationError",
        reason: "integrity",
        artifactDetails: {
          logicalPath: "main.js",
          unpacked: true,
        },
      },
    });
    const failedInspection = await new ArtifactProvider()
      .createClient(target(unpackedPath, "asar"))
      .execute("inspect_artifact", artifactInspectionInputSchema.parse({}));
    expect(failedInspection).toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "integrity" },
    });
  });
});
const inventory = async (targetValue: BinaryTarget) => {
  const result = await new ArtifactProvider().createClient(targetValue).execute(
    "inventory_artifact",
    artifactInventoryInputSchema.parse({
      node_limit: 500,
      occurrence_limit: 500,
      edge_limit: 500,
    }),
  );
  if (!result.ok) throw result.error;
  return artifactInventoryResultSchema.parse(result.value.result);
};

const target = (
  path: string,
  format: Extract<BinaryTarget, { kind: "archive" }>["format"] | "directory",
): BinaryTarget => ({
  path,
  sourcePath: path,
  sha256: "0".repeat(64),
  kind: "archive",
  format: format === "directory" ? "asar" : format,
});
