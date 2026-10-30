import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";

import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { artifactInventoryResultSchema } from "../../src/domain/artifactGraph.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import {
  fatImage,
  CPU,
  machoImage,
} from "../../src/artifacts/apple/MachoImage.fixture.js";
import { javaClassFile } from "../fixtures/javaClassFile.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const cli = fileURLToPath(new URL("../../scripts/rea.mjs", import.meta.url));

const archive = async (
  entries: readonly (readonly [string, Uint8Array])[],
): Promise<Buffer> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const [name, bytes] of entries)
    await writer.add(name, new Uint8ArrayReader(bytes));
  return Buffer.from(await writer.close());
};

const inspectArchive = async (path: string) => {
  const result = await execute(process.execPath, [
    cli,
    "inspect-artifact",
    path,
    "--json",
  ]);
  const inspection = artifactInspectionResultSchema.parse(
    parseEvidence(JSON.parse(result.stdout)).normalized_result,
  );
  const evidence = inspection.substeps[0]?.evidence;
  if (evidence === undefined)
    throw new Error("CLI inspection did not retain inventory Evidence");
  return artifactInventoryResultSchema.parse(evidence.normalized_result);
};

it("keeps valid JVM classes from being classified as Mach-O while identifying FAT controls", async () => {
  const directory = await createTestTempDirectory("rea-jvm-inventory-");
  const javaEntries = [
    ["Hello.class", javaClassFile()],
    ["pkg/Big.class", javaClassFile(4000)],
  ] as const;
  const fatControls = [
    [
      "fat-be32.bin",
      fatImage([{ cpu: CPU.arm64, bytes: machoImage({ cpu: CPU.arm64 }) }]),
    ],
    [
      "fat-le32.bin",
      fatImage(
        [{ cpu: CPU.arm64, bytes: machoImage({ cpu: CPU.arm64 }) }],
        false,
        true,
      ),
    ],
    [
      "fat-be64.bin",
      fatImage(
        [{ cpu: CPU.arm64, bytes: machoImage({ cpu: CPU.arm64 }) }],
        true,
      ),
    ],
    [
      "fat-le64.bin",
      fatImage(
        [{ cpu: CPU.arm64, bytes: machoImage({ cpu: CPU.arm64 }) }],
        true,
        true,
      ),
    ],
  ] as const;

  const jarPath = join(directory, "classes.jar");
  await writeFile(
    jarPath,
    await archive([
      ["META-INF/MANIFEST.MF", Buffer.from("Manifest-Version: 1.0\n\n")],
      ...javaEntries,
    ]),
  );
  const jar = await inspectArchive(jarPath);
  expect(
    jar.occurrences
      .filter(({ logical_path }) => logical_path.endsWith(".class"))
      .map(({ logical_path, artifact_kind, artifact_format }) => ({
        logical_path,
        artifact_kind,
        artifact_format,
      })),
  ).toEqual([
    {
      logical_path: "Hello.class",
      artifact_kind: "resource",
      artifact_format: "file",
    },
    {
      logical_path: "pkg/Big.class",
      artifact_kind: "resource",
      artifact_format: "file",
    },
  ]);
  const jarClassIds = new Set(
    jar.occurrences
      .filter(({ logical_path }) => logical_path.endsWith(".class"))
      .map(({ artifact_id }) => artifact_id),
  );
  expect(
    jar.nodes
      .filter(({ artifact_id }) => jarClassIds.has(artifact_id))
      .map(({ format }) => format)
      .sort(),
  ).toEqual(["file", "file"]);

  const mixedPath = join(directory, "mixed.zip");
  await writeFile(mixedPath, await archive([...javaEntries, ...fatControls]));
  const mixed = await inspectArchive(mixedPath);
  const formatsByPath = new Map(
    mixed.occurrences.map(
      ({ logical_path, artifact_kind, artifact_format }) => [
        logical_path,
        { artifact_kind, artifact_format },
      ],
    ),
  );
  for (const [name] of javaEntries)
    expect(formatsByPath.get(name)).toEqual({
      artifact_kind: "resource",
      artifact_format: "file",
    });
  for (const [name] of fatControls)
    expect(formatsByPath.get(name)).toEqual({
      artifact_kind: "executable",
      artifact_format: "mach-o-universal",
    });
});
