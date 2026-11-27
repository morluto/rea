import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";
import { extractArtifact } from "./extraction/ArtifactExtraction.js";
import { bfltFile } from "../domain/bfltExecutable.fixture.js";
import {
  createTestTempDirectory,
  createTestTempFile,
} from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";

const TEXT = Buffer.from("0123456789abcdef");
const DATA = Buffer.from("datadata");

it("inventories a bFLT by magic with header facts and segment ranges", async () => {
  const snapshot = await scanCanonicalArtifactInventory(
    await createTestTempFile(
      "rea-bflt-",
      "busybox",
      bfltFile({ text: TEXT, data: DATA, relocations: [0] }),
    ),
  );
  expect(snapshot.manifest.root_format).toBe("bflt");
  expect(snapshot.coverage.status).toBe("complete");
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "."),
  ).toMatchObject({
    artifact_kind: "container",
    format_metadata: { kind: "bflt", revision: 4, data_start: 80 },
  });
  expect(
    snapshot.occurrences
      .filter((row) => row.logical_path !== ".")
      .map((row) => [row.logical_path, row.source_location]),
  ).toEqual([
    ["data.bin", { offset: 80, length: 8 }],
    ["relocations.bin", { offset: 88, length: 4 }],
    ["text.bin", { offset: 0, length: 80 }],
  ]);
});

it("extracts inflated GZIP segments", async () => {
  const directory = await createTestTempDirectory("rea-bflt-extract-");
  const path = join(directory, "app.flt");
  await writeFile(path, bfltFile({ text: TEXT, data: DATA, flags: 0x05 }));
  const resourceScope = new ArtifactResourceScope();
  try {
    const extracted = await extractArtifact({
      inputPath: path,
      inputFormat: "bflt",
      outputRoot: join(directory, "out"),
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(
      (await readFile(join(extracted.output_root, "data.bin"))).toString(),
    ).toBe("datadata");
    const text = await readFile(join(extracted.output_root, "text.bin"));
    expect(text.subarray(64).toString()).toBe("0123456789abcdef");
  } finally {
    await resourceScope.close();
  }
});
