import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { ArtifactProvider } from "../../../../src/artifacts/ArtifactProvider.js";
import { artifactExtractionExecutionSchema } from "../../../../src/contracts/artifactToolContracts.js";
import { artifactExtractionResultSchema } from "../../../../src/domain/artifactGraph.js";
import type { BinaryTarget } from "../../../../src/domain/binaryTarget.js";

describe("artifact extraction identity", () => {
  it("uses code-point order for path-independent extraction identities", async () => {
    const root = await createTestTempDirectory("rea-extract-order-");
    const source = join(root, "source");
    await mkdir(source);
    for (const name of ["ä.js", "a.js", "Z.js"])
      await writeFile(join(source, name), `${name}\n`);
    const result = await new ArtifactProvider(process.env)
      .createClient(directoryTarget(source))
      .execute(
        "extract_artifact",
        artifactExtractionExecutionSchema.parse({
          output_root: join(root, "output"),
        }),
      );
    if (!result.ok) throw result.error;
    const extracted = artifactExtractionResultSchema.parse(result.value.result);
    expect(
      extracted.artifacts.map(({ relative_path }) => relative_path),
    ).toEqual(["Z.js", "a.js", "ä.js"]);
    expect(extracted.extraction_manifest.selected_occurrence_ids).toEqual(
      [...extracted.extraction_manifest.selected_occurrence_ids].sort(),
    );
  });
});

const directoryTarget = (path: string): BinaryTarget => ({
  path,
  sourcePath: path,
  sha256: "0".repeat(64),
  kind: "archive",
  format: "asar",
});
