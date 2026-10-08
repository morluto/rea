import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { runProviderAnalysis } from "../../../../src/composition/directAnalysis.js";
import {
  ArtifactPathRegistry,
  normalizeArtifactPath,
} from "../../../../src/artifacts/ArtifactPaths.js";
import { ArtifactProvider } from "../../../../src/artifacts/ArtifactProvider.js";
import { ArtifactReaderFailure } from "../../../../src/artifacts/ArtifactReader.js";
import { artifactExtractionExecutionSchema } from "../../../../src/contracts/artifactToolContracts.js";
import { artifactInventoryResultSchema } from "../../../../src/domain/artifactGraph.js";
import type { BinaryTarget } from "../../../../src/domain/binaryTarget.js";
import { parseBinaryTarget } from "../../../../src/application/BinaryTargetResolver.js";
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
      expect(result.nodes.map(({ kind }) => kind)).toEqual(
        expect.arrayContaining(["javascript", "native-addon"]),
      );
      expect(
        result.occurrences.some(
          ({ logical_path: logicalPath }) => logicalPath === "Assets/main.js",
        ),
      ).toBe(true);
      const output = join(root, "output");
      const extracted = await new ArtifactProvider()
        .createClient(parsed.value)
        .execute(
          "extract_artifact",
          artifactExtractionExecutionSchema.parse({
            output_root: output,
          }),
        );
      expect(extracted.ok).toBe(true);
      expect(await readFile(join(output, "Assets", "main.js"), "utf8")).toBe(
        "export default 'windows';",
      );
      expect(
        parseEvidence(
          await runProviderAnalysis(path, "inventory_artifact", {}),
        ),
      ).toMatchObject({
        operation: "inventory_artifact",
        subject: { format },
      });
    },
  );

  it("rejects unsafe paths and collisions", async () => {
    let unsafePathError: unknown;
    try {
      normalizeArtifactPath("../escape");
    } catch (error: unknown) {
      unsafePathError = error;
    }
    expect(unsafePathError).toBeInstanceOf(ArtifactReaderFailure);
    expect(unsafePathError).toMatchObject({
      reason: "path",
      message: 'Artifact path is not normalized: "../escape"',
    });
    const registry = new ArtifactPathRegistry();
    registry.add("A.js", "file");
    let collisionError: unknown;
    try {
      registry.add("a.js", "file");
    } catch (error: unknown) {
      collisionError = error;
    }
    expect(collisionError).toBeInstanceOf(ArtifactReaderFailure);
    expect(collisionError).toMatchObject({
      reason: "path",
      message: "Artifact path collision: a.js differs only in case from A.js",
    });

    for (const [filePath, childPath] of [
      ["Foo", "foo/bar"],
      ["root/Foo", "root/foo/bar"],
    ] as const) {
      const casePrefixRegistry = new ArtifactPathRegistry();
      casePrefixRegistry.add(filePath, "file");
      expect(() => casePrefixRegistry.add(childPath, "file")).toThrow(
        ArtifactReaderFailure,
      );
    }

    const sameDirectoryRegistry = new ArtifactPathRegistry();
    sameDirectoryRegistry.add("Foo/one.js", "file");
    expect(() => sameDirectoryRegistry.add("Foo/two.js", "file")).not.toThrow();

    const caseVariantDirectoryRegistry = new ArtifactPathRegistry();
    caseVariantDirectoryRegistry.add("Foo/one.js", "file");
    expect(() =>
      caseVariantDirectoryRegistry.add("foo/two.js", "file"),
    ).toThrow(ArtifactReaderFailure);
  });
});
const inventory = async (targetValue: BinaryTarget) => {
  const result = await new ArtifactProvider()
    .createClient(targetValue)
    .execute("inventory_artifact", {});
  if (!result.ok) throw result.error;
  return artifactInventoryResultSchema.parse(result.value.result);
};
