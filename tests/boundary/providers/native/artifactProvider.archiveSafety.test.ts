import { lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

import { createDirectAnalysis } from "../../../../src/composition/directAnalysis.js";
import {
  ArtifactPathRegistry,
  destinationCaseCollisionMessage,
  ENGLISH_UNICODE_CASE_INVENTORY_LIMITATION,
  normalizeArtifactPath,
} from "../../../../src/artifacts/ArtifactPaths.js";
import { ArtifactProvider } from "../../../../src/artifacts/ArtifactProvider.js";
import { ArtifactReaderFailure } from "../../../../src/artifacts/ArtifactReader.js";
import { artifactExtractionExecutionSchema } from "../../../../src/contracts/artifactToolContracts.js";
import { artifactInventoryResultSchema } from "../../../../src/domain/artifactGraph.js";
import type { BinaryTarget } from "../../../../src/domain/binaryTargetTypes.js";
import { parseBinaryTarget } from "../../../../src/application/BinaryTargetResolver.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";

const { runProviderAnalysis } = createDirectAnalysis({});

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
      expect(
        result.occurrences.map(({ artifact_kind }) => artifact_kind),
      ).toEqual(expect.arrayContaining(["javascript", "native-addon"]));
      expect(
        result.occurrences.some(
          ({ logical_path: logicalPath }) => logicalPath === "Assets/main.js",
        ),
      ).toBe(true);
      const output = join(root, "output");
      const extracted = await new ArtifactProvider(process.env)
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
    expect(() => registry.add("a.js", "file")).not.toThrow();
    expect(() => registry.add("A.js", "file")).toThrow(ArtifactReaderFailure);

    for (const [filePath, childPath] of [
      ["Foo", "foo/bar"],
      ["root/Foo", "root/foo/bar"],
    ] as const) {
      const casePrefixRegistry = new ArtifactPathRegistry();
      casePrefixRegistry.add(filePath, "file");
      expect(() => casePrefixRegistry.add(childPath, "file")).not.toThrow();
    }

    const exactPrefixRegistry = new ArtifactPathRegistry();
    exactPrefixRegistry.add("Foo", "file");
    expect(() => exactPrefixRegistry.add("Foo/bar", "file")).toThrow(
      ArtifactReaderFailure,
    );

    const sameDirectoryRegistry = new ArtifactPathRegistry();
    sameDirectoryRegistry.add("Foo/one.js", "file");
    expect(() => sameDirectoryRegistry.add("Foo/two.js", "file")).not.toThrow();

    const caseVariantDirectoryRegistry = new ArtifactPathRegistry();
    caseVariantDirectoryRegistry.add("Foo/one.js", "file");
    expect(() =>
      caseVariantDirectoryRegistry.add("foo/two.js", "file"),
    ).not.toThrow();
  });

  it("names a destination case collision from the directory listing", () => {
    expect(
      destinationCaseCollisionMessage("res/2f.xml", ["2F.xml", "other.xml"]),
    ).toBe(
      "Destination filesystem cannot store both res/2f.xml and res/2F.xml; inventory retains both logical names.",
    );
    expect(
      destinationCaseCollisionMessage("res/2f.xml", ["2f.xml", "2F.xml"]),
    ).toBeUndefined();
  });
});

it("extracts case-distinct names only when the destination can preserve them", async () => {
  const root = await createTestTempDirectory("rea-case-distinct-zip-");
  await writeFile(join(root, "case-probe"), "lower");
  await writeFile(join(root, "CASE-PROBE"), "upper");
  const caseSensitive =
    (await readFile(join(root, "case-probe"), "utf8")) === "lower";
  const path = join(root, "fixture.zip");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("Main.js", new TextReader("upper"));
  await writer.add("main.js", new TextReader("lower"));
  await writeFile(path, await writer.close());
  const parsed = await parseBinaryTarget(path);
  if (!parsed.ok) throw parsed.error;
  const result = await inventory(parsed.value);
  expect(result.limitations).toContain(
    ENGLISH_UNICODE_CASE_INVENTORY_LIMITATION,
  );
  expect(
    result.occurrences
      .filter(({ logical_path }) => logical_path !== ".")
      .map(({ logical_path }) => logical_path)
      .sort(),
  ).toEqual(["Main.js", "main.js"]);
  const output = join(root, "output");
  const extracted = await new ArtifactProvider(process.env)
    .createClient(parsed.value)
    .execute(
      "extract_artifact",
      artifactExtractionExecutionSchema.parse({ output_root: output }),
    );
  if (!caseSensitive) {
    if (extracted.ok) throw new Error("expected a destination case collision");
    expect(projectAnalysisError(extracted.error)).toMatchObject({
      message:
        "Destination filesystem cannot store both main.js and Main.js; inventory retains both logical names.",
      details: { operation: "extract_artifact", reason: "path" },
    });
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
    return;
  }
  if (!extracted.ok) throw extracted.error;
  expect(await readFile(join(output, "Main.js"), "utf8")).toBe("upper");
  expect(await readFile(join(output, "main.js"), "utf8")).toBe("lower");
});
const inventory = async (targetValue: BinaryTarget) => {
  const result = await new ArtifactProvider(process.env)
    .createClient(targetValue)
    .execute("inventory_artifact", {});
  if (!result.ok) throw result.error;
  return artifactInventoryResultSchema.parse(result.value.result);
};
