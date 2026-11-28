import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import {
  createTestTempDirectory,
  createTestTempFile,
} from "../../tests/fixtures/temporaryDirectory.js";
import { parseBinaryTarget } from "../application/BinaryTargetResolver.js";
import {
  interleaveMegaDriveSmd,
  megaDriveRom,
} from "../domain/megaDriveRom.fixture.js";
import { MEGA_DRIVE_SMD_BLOCK_BYTES } from "../domain/megaDriveRom.js";
import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";
import { extractArtifact } from "./extraction/ArtifactExtraction.js";

const plainImage = () =>
  megaDriveRom({ imageBytes: MEGA_DRIVE_SMD_BLOCK_BYTES });

it("inventories a plain ROM and an SMD dump as the same program", async () => {
  const plain = plainImage();
  const plainPath = await createTestTempFile(
    "rea-mega-drive-",
    "game.bin",
    plain,
  );
  const smdPath = await createTestTempFile(
    "rea-mega-drive-",
    "game.smd",
    interleaveMegaDriveSmd(plain),
  );
  const plainSnapshot = await scanCanonicalArtifactInventory(plainPath);
  const smdSnapshot = await scanCanonicalArtifactInventory(smdPath);
  expect(await parseBinaryTarget(plainPath)).toMatchObject({
    ok: true,
    value: { kind: "archive", format: "mega-drive-rom" },
  });
  expect(await parseBinaryTarget(smdPath)).toMatchObject({
    ok: true,
    value: { kind: "archive", format: "mega-drive-rom" },
  });

  expect(plainSnapshot.manifest.root_format).toBe("mega-drive-rom");
  expect(smdSnapshot.manifest.root_format).toBe("mega-drive-rom");
  expect(plainSnapshot.coverage.status).toBe("complete");
  expect(smdSnapshot.coverage.status).toBe("complete");
  expect(
    plainSnapshot.occurrences.find((row) => row.logical_path === "."),
  ).toMatchObject({
    artifact_kind: "container",
    format_metadata: {
      kind: "mega-drive-rom",
      layout: "plain",
      system_kind: "mega-drive",
      reset_pc: 0x200,
      checksum: { matches: true },
    },
  });
  const smdRoot = smdSnapshot.occurrences.find(
    (row) => row.logical_path === ".",
  );
  expect(smdRoot?.format_metadata).toMatchObject({
    kind: "mega-drive-rom",
    layout: "smd",
    smd_blocks: 1,
    domestic_title: { text: "SYNTHETIC DOMESTIC" },
    reset_pc: 0x200,
  });
  expect(
    plainSnapshot.occurrences
      .filter((row) => row.logical_path !== ".")
      .map((row) => [
        row.logical_path,
        row.source_location,
        row.format_metadata,
      ]),
  ).toEqual([
    [
      "header.bin",
      { offset: 0x100, length: 256 },
      { kind: "mega-drive-rom-entry", role: "header", image_offset: 0x100 },
    ],
    [
      "program.bin",
      { offset: 0, length: plain.length },
      { kind: "mega-drive-rom-entry", role: "program", image_offset: 0 },
    ],
    [
      "vectors.bin",
      { offset: 0, length: 256 },
      { kind: "mega-drive-rom-entry", role: "vectors", image_offset: 0 },
    ],
  ]);
  expect(
    smdSnapshot.occurrences
      .filter((row) => row.logical_path !== ".")
      .map((row) => [row.logical_path, row.source_location]),
  ).toEqual([
    ["header.bin", null],
    ["program.bin", null],
    ["vectors.bin", null],
  ]);
});

it("extracts the same program.bin from a plain image and an SMD dump", async () => {
  const plain = plainImage();
  const directory = await createTestTempDirectory("rea-mega-drive-extract-");
  const plainPath = join(directory, "game.bin");
  const smdPath = join(directory, "game.smd");
  await writeFile(plainPath, plain);
  await writeFile(smdPath, interleaveMegaDriveSmd(plain));
  const resourceScope = new ArtifactResourceScope();
  try {
    const plainOut = await extractArtifact({
      inputPath: plainPath,
      inputFormat: "mega-drive-rom",
      outputRoot: join(directory, "plain"),
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope,
    });
    const smdOut = await extractArtifact({
      inputPath: smdPath,
      inputFormat: "mega-drive-rom",
      outputRoot: join(directory, "smd"),
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope,
    });
    const plainProgram = await readFile(
      join(plainOut.output_root, "program.bin"),
    );
    const smdProgram = await readFile(join(smdOut.output_root, "program.bin"));
    expect(plainProgram.equals(plain)).toBe(true);
    expect(smdProgram.equals(plainProgram)).toBe(true);
  } finally {
    await resourceScope.close();
  }
});
