import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { createPackage, createPackageWithOptions } from "@electron/asar";
import { expect, it, onTestFinished } from "vitest";

import { ArtifactProvider } from "../../../../src/artifacts/ArtifactProvider.js";
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
    const bytes = Buffer.alloc(8 * 1024 * 1024, "same bytes\n");
    await writeFile(join(source, "a.txt"), bytes);
    await writeFile(join(source, "z", "missing.txt"), bytes);
    const output = join(root, "output");
    const changed = afterInventory(output, async () => {
      await rm(
        removedKind === "file"
          ? join(source, "z", "missing.txt")
          : join(source, "z"),
        { recursive: removedKind === "directory" },
      );
    });

    const result = await extract(source, output);
    await changed();
    if (result.ok) throw new Error("Incomplete extraction must fail");
    const projected = projectAnalysisError(result.error);
    expect(projected).toMatchObject({
      code: "artifact_operation_failed",
      details: {
        operation: "extract_artifact",
      },
    });
    // A directory already returned by readdir can disappear before its stat.
    // That earlier reader failure retains ENOENT instead of reaching the final
    // completeness check. Both paths must reject publication and roll back.
    if (removedKind === "directory" && projected.details?.reason === "io") {
      expect(projected.details).toMatchObject({
        reason: "io",
        detail: `Could not inspect entry at ${join(source, "z")} (ENOENT)`,
      });
    } else {
      expect(projected.details).toMatchObject({
        reason: "integrity",
        detail:
          "Inventoried regular artifact entries were not materialized: z/missing.txt",
      });
    }
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
  await writeFile(
    join(source, "a.txt"),
    Buffer.alloc(8 * 1024 * 1024, "original\n"),
  );
  const output = join(root, "output");
  const changed = afterInventory(output, async () => {
    await writeFile(join(source, "z.txt"), "new\n");
  });
  const result = await extract(source, output);
  await changed();
  if (result.ok) throw new Error("Changed inventory must fail");
  expect(projectAnalysisError(result.error)).toMatchObject({
    details: {
      reason: "integrity",
      detail: "Regular artifact entry is missing from inventory: z.txt",
    },
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
    details: {
      operation: "extract_artifact",
      reason: "format",
      detail: expect.stringContaining("native/addon.node"),
    },
  });
  await expect(access(activeOutput)).rejects.toThrow();
});

// The real destination is created only after inventory. A streamed first file
// leaves time to mutate a later entry without replacing any production method.
const afterInventory = (output: string, change: () => Promise<void>) => {
  let mutation:
    | Promise<{ ok: true } | { ok: false; cause: unknown }>
    | undefined;
  const watcher = watch(dirname(output), (_event, filename) => {
    if (filename !== basename(output) || mutation !== undefined) return;
    watcher.close();
    mutation = change().then(
      () => ({ ok: true as const }),
      (cause: unknown) => ({ ok: false as const, cause }),
    );
  });
  onTestFinished(() => watcher.close());
  return async () => {
    if (mutation === undefined)
      throw new Error("Extraction destination was not observed");
    const result = await mutation;
    if (!result.ok) throw result.cause;
  };
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
