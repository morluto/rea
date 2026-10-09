import {
  access,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { ArtifactProvider } from "../../../../src/artifacts/ArtifactProvider.js";
import { artifactExtractionExecutionSchema } from "../../../../src/contracts/artifactToolContracts.js";
import { TOOL_EFFECTS } from "../../../../src/contracts/toolEffects.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../../../src/domain/artifactGraph.js";
import type { BinaryTarget } from "../../../../src/domain/binaryTarget.js";

describe("artifact extraction", () => {
  it("declares possible native mounts and fresh extraction directories", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const provider = new ArtifactProvider(platform);
      for (const operation of [
        "inventory_artifact",
        "inspect_artifact",
        "extract_artifact",
      ] as const) {
        expect(
          provider
            .capabilities()
            .find((capability) => capability.operation === operation)?.effects,
        ).toMatchObject({ launchesProcess: true, mayWriteFilesystem: true });
      }
    }
    expect(TOOL_EFFECTS.inspect_artifact).toMatchObject({
      launchesProcess: true,
      writesFilesystem: true,
      mutatesTarget: false,
    });
    expect(TOOL_EFFECTS.extract_artifact).toMatchObject({
      launchesProcess: true,
      writesFilesystem: true,
      idempotent: false,
      mutatesTarget: false,
    });
  });
  it("extracts all regular occurrences through an exclusively owned output tree", async () => {
    const root = await createTestTempDirectory("rea-extract-");
    const source = join(root, "source");
    await mkdir(join(source, "assets"), { recursive: true });
    await writeFile(join(source, "assets", "selected.js"), "selected();\n");
    await writeFile(join(source, "assets", "ignored.js"), "ignored();\n");
    const targetValue = target(source, "directory");
    const graph = await inventory(targetValue);
    expect(
      graph.occurrences.some(
        ({ logical_path }) => logical_path === "assets/selected.js",
      ),
    ).toBe(true);
    const cancelledOutput = join(root, "cancelled-output");
    const controller = new AbortController();
    controller.abort();
    const cancelled = await new ArtifactProvider()
      .createClient(targetValue)
      .execute(
        "extract_artifact",
        artifactExtractionExecutionSchema.parse({
          output_root: cancelledOutput,
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
        artifactExtractionExecutionSchema.parse({
          output_root: output,
        }),
      );
    if (!result.ok) throw result.error;
    const firstExtraction = artifactExtractionResultSchema.parse(
      result.value.result,
    );
    expect(firstExtraction).toMatchObject({
      output_root: output,
      containment_verified: true,
      artifacts: expect.arrayContaining([
        expect.objectContaining({ relative_path: "assets/selected.js" }),
      ]),
      extraction_manifest: { output_root_alias: "$OUTPUT_ROOT" },
    });
    expect(await readFile(join(output, "assets", "selected.js"), "utf8")).toBe(
      "selected();\n",
    );
    expect(await readFile(join(output, "assets", "ignored.js"), "utf8")).toBe(
      "ignored();\n",
    );

    const relocatedOutput = join(root, "relocated-output");
    const relocated = await new ArtifactProvider()
      .createClient(targetValue)
      .execute(
        "extract_artifact",
        artifactExtractionExecutionSchema.parse({
          output_root: relocatedOutput,
        }),
      );
    if (!relocated.ok) throw relocated.error;
    expect(
      artifactExtractionResultSchema.parse(relocated.value.result)
        .extraction_manifest,
    ).toEqual(firstExtraction.extraction_manifest);

    const second = await new ArtifactProvider()
      .createClient(targetValue)
      .execute(
        "extract_artifact",
        artifactExtractionExecutionSchema.parse({
          output_root: output,
        }),
      );
    expect(second).toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "path" },
    });
    expect((await readdir(root)).sort()).toEqual([
      "output",
      "relocated-output",
      "source",
    ]);
  });
  it("refuses a format without an extraction reader before inventory or output", async () => {
    const root = await createTestTempDirectory("rea-extract-dmg-");
    const image = join(root, "Image.dmg");
    await writeFile(image, "not mounted");
    // A caller-specific alias must be the path the refusal reports.
    const alias = join(root, "Alias.dmg");
    await symlink(image, alias);
    const output = join(root, "output");
    const extract = (signal?: AbortSignal) =>
      new ArtifactProvider()
        .createClient(target(alias, "dmg"))
        .execute(
          "extract_artifact",
          artifactExtractionExecutionSchema.parse({ output_root: output }),
          signal === undefined ? undefined : { signal },
        );
    expect(await extract()).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisUnsupportedTargetError",
        operation: "extract_artifact",
        path: alias,
        reason: "Artifact format has no extraction reader: dmg",
      },
    });
    const controller = new AbortController();
    controller.abort();
    expect(await extract(controller.signal)).toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "cancelled" },
    });
    await expect(access(output)).rejects.toThrow();
  });
});
const inventory = async (targetValue: BinaryTarget) => {
  const result = await new ArtifactProvider()
    .createClient(targetValue)
    .execute("inventory_artifact", {});
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
