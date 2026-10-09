import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createPackageWithOptions } from "@electron/asar";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { createDirectAnalysis } from "../../../../src/composition/directAnalysis.js";
import { artifactInspectionResultSchema } from "../../../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";

const { runProviderAnalysis } = createDirectAnalysis({});

it("inspects an artifact through the direct CLI workflow without an REA grant", async () => {
  const root = await createTestTempDirectory("rea-artifact-direct-");
  const source = join(root, "source");
  const archive = join(root, "fixture.asar");
  await mkdir(source);
  await writeFile(join(source, "main.js"), "console.log('ok');\n");
  await createPackageWithOptions(source, archive, {});

  const evidence = parseEvidence(
    await runProviderAnalysis(archive, "inspect_artifact", {}),
  );
  expect(evidence.operation).toBe("inspect_artifact");
  expect(evidence.provider.id).toBe("rea-artifact-graph");
  const inspection = artifactInspectionResultSchema.parse(
    evidence.normalized_result,
  );
  expect(inspection.subject.root_format).toBe("asar");
  expect(inspection.substeps[0]?.evidence.normalized_result).toMatchObject({
    occurrences: expect.arrayContaining([
      expect.objectContaining({ logical_path: "main.js" }),
    ]),
  });
});
