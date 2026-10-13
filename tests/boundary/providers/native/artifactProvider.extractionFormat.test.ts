import { access, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeOrderedZip } from "../../../fixtures/artifactEntryOrder.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { ArtifactProvider } from "../../../../src/artifacts/ArtifactProvider.js";
import { artifactExtractionExecutionSchema } from "../../../../src/contracts/artifactToolContracts.js";
import { artifactExtractionResultSchema } from "../../../../src/domain/artifactGraph.js";
import type { BinaryTarget } from "../../../../src/domain/binaryTargetTypes.js";

describe("artifact extraction format support", () => {
  it("refuses unsupported formats before inventory or output", async () => {
    const root = await createTestTempDirectory("rea-extract-format-");
    const image = join(root, "Image.dmg");
    await writeFile(image, "not mounted");
    const alias = join(root, "Alias.dmg");
    await symlink(image, alias);
    const output = join(root, "output");
    const extract = (signal?: AbortSignal) =>
      new ArtifactProvider(process.env)
        .createClient(archiveTarget(alias, "dmg"))
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

  it.each(["zip", "hap", "hsp", "app-pack"] as const)(
    "extracts the ZIP-backed %s package family that inventory already supports",
    async (format) => {
      const root = await createTestTempDirectory("rea-extract-zip-family-");
      const archive = join(
        root,
        `Payload.${format === "app-pack" ? "app" : format}`,
      );
      await writeOrderedZip(archive, ["payload.txt"]);
      const result = await new ArtifactProvider(process.env)
        .createClient(archiveTarget(archive, format))
        .execute(
          "extract_artifact",
          artifactExtractionExecutionSchema.parse({
            output_root: join(root, "output"),
          }),
        );
      if (!result.ok) throw result.error;
      const extracted = artifactExtractionResultSchema.parse(
        result.value.result,
      );
      expect(
        extracted.artifacts.map(({ relative_path }) => relative_path),
      ).toEqual(["payload.txt"]);
    },
  );
});

const archiveTarget = (
  path: string,
  format: Extract<BinaryTarget, { kind: "archive" }>["format"],
): BinaryTarget => ({
  path,
  sourcePath: path,
  sha256: "0".repeat(64),
  kind: "archive",
  format,
});
