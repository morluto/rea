import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createPackage, createPackageWithOptions } from "@electron/asar";
import { expect, it } from "vitest";

import { ArtifactProvider } from "../../../../src/artifacts/ArtifactProvider.js";
import { materializeArtifactInventory } from "../../../../src/artifacts/extraction/ArtifactExtraction.js";
import { scanArtifactInventory } from "../../../../src/artifacts/inventory/ArtifactInventory.js";
import { artifactExtractionResultSchema } from "../../../../src/domain/artifactGraph.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

it.each(["file", "directory"] as const)(
  "rolls back when an inventoried %s disappears before extraction",
  async (removedKind) => {
    const root = await createTestTempDirectory("rea-extract-missing-");
    const source = join(root, "source");
    await mkdir(join(source, "z"), { recursive: true });
    // Equal bytes share an artifact node, but both occurrences must be copied.
    const bytes = Buffer.from("same bytes\n");
    await writeFile(join(source, "a.txt"), bytes);
    await writeFile(join(source, "z", "missing.txt"), bytes);
    const output = join(root, "output");
    const materialize = await inventoriedExtraction(source, output);
    await rm(
      removedKind === "file"
        ? join(source, "z", "missing.txt")
        : join(source, "z"),
      { recursive: removedKind === "directory" },
    );
    await expect(materialize()).rejects.toMatchObject({
      reason: "integrity",
      message:
        "Inventoried regular artifact entries were not materialized: z/missing.txt",
    });
    await expect(access(output)).rejects.toThrow();
    expect(
      createHash("sha256")
        .update(await readFile(join(source, "a.txt")))
        .digest("hex"),
    ).toBe(createHash("sha256").update(bytes).digest("hex"));
  },
);

it("still refuses a regular file added after inventory and rolls back", async () => {
  const root = await createTestTempDirectory("rea-extract-added-");
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "a.txt"), "original\n");
  const output = join(root, "output");
  const materialize = await inventoriedExtraction(source, output);
  await writeFile(join(source, "z.txt"), "new\n");
  await expect(materialize()).rejects.toMatchObject({
    reason: "integrity",
    message: "Regular artifact entry is missing from inventory: z.txt",
  });
  await expect(access(output)).rejects.toThrow();
});

it("preserves every equal-content occurrence and copies a nested ASAR as its containing file", async () => {
  const root = await createTestTempDirectory("rea-extract-nested-");
  const source = join(root, "source");
  const nested = join(root, "nested");
  await mkdir(source);
  await mkdir(join(nested, "assets"), { recursive: true });
  await writeFile(join(nested, "assets", "main.js"), "export default 1;\n");
  await createPackage(nested, join(source, "app.asar"));
  await writeFile(join(source, "a.txt"), "same bytes\n");
  await writeFile(join(source, "b.txt"), "same bytes\n");
  const output = join(root, "output");
  const result = await extract(source, output);
  if (!result.ok) throw result.error;
  const extracted = artifactExtractionResultSchema.parse(result.value.result);
  expect(extracted.artifacts.map(({ relative_path }) => relative_path)).toEqual(
    ["a.txt", "app.asar", "b.txt"],
  );
  expect(extracted.extraction_manifest.selected_occurrence_ids).toHaveLength(3);
  expect(extracted.artifacts[0]?.artifact_id).toBe(
    extracted.artifacts[2]?.artifact_id,
  );
  for (const path of ["a.txt", "b.txt", "app.asar"])
    expect(await readFile(join(output, path))).toEqual(
      await readFile(join(source, path)),
    );
});

it("ignores unavailable members of a nested ASAR but refuses them as active entries", async () => {
  const root = await createTestTempDirectory("rea-extract-nested-unpacked-");
  const contents = join(root, "contents");
  await mkdir(join(contents, "native"), { recursive: true });
  await writeFile(join(contents, "main.js"), "export default 1;\n");
  await writeFile(join(contents, "native", "addon.node"), "native bytes\n");

  const source = join(root, "bundle");
  await mkdir(source);
  const archive = join(source, "app.asar");
  await createPackageWithOptions(contents, archive, { unpack: "**/*.node" });
  await rm(join(`${archive}.unpacked`, "native", "addon.node"));

  const nestedOutput = join(root, "nested-output");
  const nestedResult = await extract(source, nestedOutput);
  if (!nestedResult.ok) throw nestedResult.error;
  const nestedExtraction = artifactExtractionResultSchema.parse(
    nestedResult.value.result,
  );
  expect(
    nestedExtraction.extraction_manifest.selected_occurrence_ids,
  ).toHaveLength(1);
  expect(
    nestedExtraction.artifacts.map(({ relative_path }) => relative_path),
  ).toEqual(["app.asar"]);
  expect(await readFile(join(nestedOutput, "app.asar"))).toEqual(
    await readFile(archive),
  );

  const activeOutput = join(root, "active-output");
  const activeResult = await extract(archive, activeOutput);
  if (activeResult.ok)
    throw new Error("Unavailable active ASAR member must fail extraction");
  expect(projectAnalysisError(activeResult.error)).toMatchObject({
    code: "artifact_operation_failed",
    category: "unavailable",
    details: { logical_path: "native/addon.node", unpacked: true },
  });
  await expect(access(activeOutput)).rejects.toThrow();
});

const inventoriedExtraction = async (source: string, output: string) => {
  const snapshot = await scanArtifactInventory(source);
  return () =>
    materializeArtifactInventory(
      {
        inputPath: source,
        inputFormat: "asar",
        outputRoot: output,
        environment: process.env,
        integrityPolicy: "fail",
      },
      source,
      snapshot,
    );
};

const extract = (source: string, output: string) =>
  new ArtifactProvider(process.env)
    .createClient({
      path: source,
      sourcePath: source,
      sha256: "0".repeat(64),
      kind: "archive",
      format: "asar",
    })
    .execute("extract_artifact", { output_root: output });
