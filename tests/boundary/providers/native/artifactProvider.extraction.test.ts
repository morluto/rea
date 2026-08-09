import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { ArtifactProvider } from "../../../../src/artifacts/ArtifactProvider.js";
import {
  artifactExtractionInputSchema,
  artifactInventoryInputSchema,
} from "../../../../src/contracts/artifactToolContracts.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../../../src/domain/artifactGraph.js";
import type { BinaryTarget } from "../../../../src/domain/binaryTarget.js";

describe("artifact extraction", () => {
  it("extracts only selected occurrences through an exclusively owned output tree", async () => {
    const root = await createTestTempDirectory("rea-extract-");
    const source = join(root, "source");
    await mkdir(join(source, "assets"), { recursive: true });
    await writeFile(join(source, "assets", "selected.js"), "selected();\n");
    await writeFile(join(source, "assets", "ignored.js"), "ignored();\n");
    const targetValue = target(source, "directory");
    const graph = await inventory(targetValue);
    const selected = graph.occurrences.items.find(
      ({ logical_path: path }) => path === "assets/selected.js",
    );
    expect(selected).toBeDefined();
    if (selected === undefined) return;
    const cancelledOutput = join(root, "cancelled-output");
    const controller = new AbortController();
    controller.abort();
    const cancelled = await new ArtifactProvider()
      .createClient(targetValue)
      .execute(
        "extract_artifact",
        artifactExtractionInputSchema.parse({
          approved: true,
          output_root: cancelledOutput,
          occurrence_ids: [selected.occurrence_id],
        }),
        { signal: controller.signal },
      );
    expect(cancelled).toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "cancelled" },
    });
    await expect(access(cancelledOutput)).rejects.toThrow();
    const output = join(root, "output");
    const result = await new ArtifactProvider()
      .createClient(targetValue)
      .execute(
        "extract_artifact",
        artifactExtractionInputSchema.parse({
          approved: true,
          output_root: output,
          occurrence_ids: [selected.occurrence_id],
        }),
      );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const firstExtraction = artifactExtractionResultSchema.parse(
      result.value.result,
    );
    expect(firstExtraction).toMatchObject({
      output_root: "$OUTPUT_ROOT",
      containment_verified: true,
      artifacts: { total: 1 },
      extraction_manifest: { output_root_alias: "$OUTPUT_ROOT" },
    });
    expect(await readFile(join(output, "assets", "selected.js"), "utf8")).toBe(
      "selected();\n",
    );
    await expect(
      access(join(output, "assets", "ignored.js")),
    ).rejects.toThrow();

    const relocatedOutput = join(root, "relocated-output");
    const relocated = await new ArtifactProvider()
      .createClient(targetValue)
      .execute(
        "extract_artifact",
        artifactExtractionInputSchema.parse({
          approved: true,
          output_root: relocatedOutput,
          occurrence_ids: [selected.occurrence_id],
        }),
      );
    expect(relocated.ok).toBe(true);
    if (!relocated.ok) return;
    expect(
      artifactExtractionResultSchema.parse(relocated.value.result)
        .extraction_manifest,
    ).toEqual(firstExtraction.extraction_manifest);

    const second = await new ArtifactProvider()
      .createClient(targetValue)
      .execute(
        "extract_artifact",
        artifactExtractionInputSchema.parse({
          approved: true,
          output_root: output,
          occurrence_ids: [selected.occurrence_id],
        }),
      );
    expect(second).toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "path" },
    });
    expect(await readdir(root)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^\.output\.rea-/u)]),
    );
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
