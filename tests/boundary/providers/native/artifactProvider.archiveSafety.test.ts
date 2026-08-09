import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { runProviderAnalysis } from "../../../../src/application/DirectAnalysis.js";
import {
  ArtifactPathRegistry,
  normalizeArtifactPath,
} from "../../../../src/artifacts/ArtifactPaths.js";
import { ArtifactProvider } from "../../../../src/artifacts/ArtifactProvider.js";
import {
  artifactExtractionInputSchema,
  artifactInventoryInputSchema,
} from "../../../../src/contracts/artifactToolContracts.js";
import { artifactInventoryResultSchema } from "../../../../src/domain/artifactGraph.js";
import type { BinaryTarget } from "../../../../src/domain/binaryTarget.js";
import { parseBinaryTarget } from "../../../../src/domain/binaryTarget.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";

describe("artifact archive safety", () => {
  it.each([
    ["fixture.msix", "msix"],
    ["fixture.appxbundle", "appx"],
  ] as const)(
    "reuses the hardened ZIP reader for %s package inventory",
    async (name, format) => {
      const root = await createTestTempDirectory("rea-windows-package-");
      const path = join(root, name);
      const writer = new ZipWriter(new Uint8ArrayWriter());
      await writer.add(
        "Assets/main.js",
        new TextReader("export default 'windows';"),
      );
      await writer.add(
        "VFS/ProgramFilesX64/App/addon.node",
        new TextReader("native"),
      );
      await writeFile(path, await writer.close());

      const parsed = await parseBinaryTarget(path);
      expect(parsed.ok && parsed.value).toMatchObject({
        kind: "archive",
        format,
      });
      if (!parsed.ok) return;
      const result = await inventory(parsed.value);
      expect(result.manifest.root_format).toBe(format);
      expect(result.nodes.items.map(({ kind }) => kind)).toEqual(
        expect.arrayContaining(["javascript", "native-addon"]),
      );
      const selected = result.occurrences.items.find(
        ({ logical_path: logicalPath }) => logicalPath === "Assets/main.js",
      );
      expect(selected).toBeDefined();
      if (selected === undefined) return;
      const output = join(root, "output");
      const extracted = await new ArtifactProvider()
        .createClient(parsed.value)
        .execute(
          "extract_artifact",
          artifactExtractionInputSchema.parse({
            approved: true,
            output_root: output,
            occurrence_ids: [selected.occurrence_id],
          }),
        );
      expect(extracted.ok).toBe(true);
      expect(await readFile(join(output, "Assets", "main.js"), "utf8")).toBe(
        "export default 'windows';",
      );
      expect(
        parseEvidence(
          await runProviderAnalysis(path, "inventory_artifact", {
            node_limit: 10,
            occurrence_limit: 10,
            edge_limit: 10,
          }),
        ),
      ).toMatchObject({
        operation: "inventory_artifact",
        subject: { format },
      });
    },
  );

  it("rejects unsafe, colliding, and over-ratio entries", async () => {
    expect(() => normalizeArtifactPath("../escape", limits())).toThrow(
      /normalized/u,
    );
    const registry = new ArtifactPathRegistry();
    registry.add("A.js", "file");
    expect(() => registry.add("a.js", "file")).toThrow(/collision/u);

    const root = await createTestTempDirectory("rea-bomb-");
    const zipPath = join(root, "bomb.zip");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("zeros", new TextReader("0".repeat(100_000)));
    await writeFile(zipPath, await writer.close());
    const client = new ArtifactProvider().createClient(target(zipPath, "zip"));
    const result = await client.execute(
      "inventory_artifact",
      artifactInventoryInputSchema.parse({ max_compression_ratio: 2 }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "limit" },
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

const limits = () => ({ maxDepth: 20, maxPathBytes: 4_096 });
