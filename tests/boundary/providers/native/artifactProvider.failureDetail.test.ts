import { join } from "node:path";

import { expect, it } from "vitest";

import { writeOrderedZip } from "../../../fixtures/artifactEntryOrder.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { parseBinaryTarget } from "../../../../src/application/BinaryTargetResolver.js";
import {
  destinationCaseCollisionMessage,
  ENGLISH_UNICODE_CASE_INVENTORY_LIMITATION,
} from "../../../../src/artifacts/ArtifactPaths.js";
import { ArtifactProvider } from "../../../../src/artifacts/ArtifactProvider.js";
import { artifactInventoryResultSchema } from "../../../../src/domain/artifactGraph.js";
import { ArtifactOperationError } from "../../../../src/domain/artifactOperationError.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";

it("keeps logical names that differ only in case and records the limitation", async () => {
  const root = await createTestTempDirectory("rea-artifact-detail-");
  const path = join(root, "fixture.zip");
  await writeOrderedZip(path, ["Main.js", "main.js"]);
  const target = await parseBinaryTarget(path);
  if (!target.ok) throw new Error("expected a ZIP target");
  const result = await new ArtifactProvider(process.env)
    .createClient(target.value)
    .execute("inventory_artifact", {});
  if (!result.ok) throw result.error;
  const inventory = artifactInventoryResultSchema.parse(result.value.result);
  expect(inventory.occurrences.map(({ logical_path }) => logical_path)).toEqual(
    expect.arrayContaining(["Main.js", "main.js"]),
  );
  expect(inventory.limitations).toContain(
    ENGLISH_UNICODE_CASE_INVENTORY_LIMITATION,
  );
  for (const logicalPath of ["Main.js", "main.js"]) {
    expect(
      inventory.occurrences
        .find((occurrence) => occurrence.logical_path === logicalPath)
        ?.limitations.join("\n"),
    ).toContain("English (en-US) Unicode case folding");
  }
});

it("reports an unsafe path as a hostile artifact path", async () => {
  const root = await createTestTempDirectory("rea-artifact-detail-");
  const path = join(root, "fixture.zip");
  await writeOrderedZip(path, ["a\\b.js"]);
  const target = await parseBinaryTarget(path);
  if (!target.ok) throw new Error("expected a ZIP target");
  const result = await new ArtifactProvider(process.env)
    .createClient(target.value)
    .execute("inventory_artifact", {});
  if (result.ok) throw new Error("expected the path constraint to fail");
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "artifact_operation_failed",
    message:
      "Artifact contains an unsafe internal path. Inspect the reported path and correct the artifact before retrying.",
    details: {
      operation: "inventory_artifact",
      reason: "path",
      detail: 'Artifact path is absolute or unsafe: "a\\\\b.js"',
    },
  });
});

it("returns a destination case collision as the user-facing path message", () => {
  const detail = destinationCaseCollisionMessage("res/2f.xml", ["2F.xml"]);
  expect(detail).toEqual(expect.any(String));
  if (detail === undefined) return;
  expect(
    projectAnalysisError(
      new ArtifactOperationError("extract_artifact", "path", undefined, detail),
    ),
  ).toMatchObject({
    message: detail,
    details: { reason: "path", detail },
  });
});
