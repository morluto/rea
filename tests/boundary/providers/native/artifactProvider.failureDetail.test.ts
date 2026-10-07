import { join } from "node:path";

import { expect, it } from "vitest";

import { writeOrderedZip } from "../../../fixtures/artifactEntryOrder.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { parseBinaryTarget } from "../../../../src/application/BinaryTargetResolver.js";
import { ArtifactProvider } from "../../../../src/artifacts/ArtifactProvider.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";

it.each([
  [
    ["Main.js", "main.js"],
    "Artifact path collision: main.js differs only in case from Main.js",
  ],
  [["a\\b.js"], 'Artifact path is absolute or unsafe: "a\\\\b.js"'],
] as const)(
  "reports the failed path constraint for %j",
  async (entries, detail) => {
    const root = await createTestTempDirectory("rea-artifact-detail-");
    const path = join(root, "fixture.zip");
    await writeOrderedZip(path, entries);
    const target = await parseBinaryTarget(path);
    if (!target.ok) throw new Error("expected a ZIP target");
    const result = await new ArtifactProvider()
      .createClient(target.value)
      .execute("inventory_artifact", {});
    if (result.ok) throw new Error("expected the path constraint to fail");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "artifact_operation_failed",
      details: { operation: "inventory_artifact", reason: "path", detail },
    });
  },
);
