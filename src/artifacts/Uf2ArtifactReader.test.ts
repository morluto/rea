import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { Uf2ArtifactReader } from "./Uf2ArtifactReader.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import { extractArtifact } from "./extraction/ArtifactExtraction.js";
import {
  RP2040_FAMILY,
  RP2XXX_ABSOLUTE_FAMILY,
  patternBytes,
  uf2Block,
  uf2File,
  uf2Image,
} from "../domain/firmware/uf2.fixture.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";

const INVENTORY_LIMITATION =
  "UF2 inventory decodes main-flash block payloads into address-contiguous regions per familyID. It does not establish CPU, byte order, memory map, or an entry point; a familyID names a target family, and gaps are unwritten, not zero.";

const writeImage = async (name: string, bytes: Uint8Array): Promise<string> => {
  const directory = await createTestTempDirectory("rea-uf2-");
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
};

const APP = patternBytes(600, 5);
const ABSOLUTE = uf2Block({
  address: 0x10ff_ff00,
  payload: new Uint8Array(256).fill(0xef),
  blockNo: 0,
  numBlocks: 2,
  familyId: RP2XXX_ABSOLUTE_FAMILY,
});
const UNNAMED = uf2Block({
  address: 0x2000_0000,
  payload: [1, 2, 3],
  blockNo: 0,
  numBlocks: 1,
  familyId: 0x1234_5678,
});

it("inventories each family's regions with family and block facts", async () => {
  const snapshot = await scanCanonicalArtifactInventory(
    await writeImage(
      "firmware.bin",
      uf2File([...uf2Image(RP2040_FAMILY, 0x1000_0000, APP), UNNAMED]),
    ),
  );
  expect(snapshot.manifest.root_format).toBe("uf2");
  expect(snapshot.coverage).toEqual({
    scope: "container-entries",
    status: "complete",
  });
  expect(snapshot.limitations).toContain(INVENTORY_LIMITATION);
  expect(
    snapshot.occurrences.find((row) => row.logical_path === "."),
  ).toMatchObject({
    artifact_kind: "container",
    artifact_format: "uf2",
    format_metadata: {
      kind: "uf2",
      block_count: 4,
      family_count: 2,
      region_count: 2,
      data_bytes: 603,
    },
  });
  expect(
    snapshot.occurrences
      .filter((row) => row.logical_path !== ".")
      .map((row) => [
        row.logical_path,
        row.declared_size,
        row.source_location,
        row.format_metadata,
      ]),
  ).toEqual([
    [
      "family-0x12345678/0x20000000-0x20000002.bin",
      3,
      null,
      {
        kind: "uf2-region",
        family_id: 0x1234_5678,
        family_name: null,
        start_address: 0x2000_0000,
        end_address: 0x2000_0002,
        length: 3,
        block_count: 1,
        first_file_block: 3,
        last_file_block: 3,
      },
    ],
    [
      "family-0xe48bff56/0x10000000-0x10000257.bin",
      600,
      null,
      {
        kind: "uf2-region",
        family_id: RP2040_FAMILY,
        family_name: "RP2040",
        start_address: 0x1000_0000,
        end_address: 0x1000_0257,
        length: 600,
        block_count: 3,
        first_file_block: 0,
        last_file_block: 2,
      },
    ],
  ]);
});

it("leaves coverage unknown when numbered blocks are absent", async () => {
  const snapshot = await scanCanonicalArtifactInventory(
    await writeImage(
      "universal.uf2",
      uf2File([ABSOLUTE, ...uf2Image(RP2040_FAMILY, 0x1000_0000, APP)]),
    ),
  );
  expect(snapshot.coverage.status).toBe("unknown");
  expect(snapshot.limitations).toContain(
    "UF2 numbering declares 1 block(s) that are absent: family 0xe48bff57 (RP2XXX_ABSOLUTE) with 2 numbered blocks has 1 of them.",
  );
  expect(
    snapshot.occurrences
      .filter((row) => row.logical_path !== ".")
      .map((row) => row.logical_path),
  ).toEqual([
    "family-0xe48bff56/0x10000000-0x10000257.bin",
    "family-0xe48bff57/0x10ffff00-0x10ffffff.bin",
  ]);
});

it("fails closed on a conflicting rewrite and leaves short files unrecognized", async () => {
  const rewrite = uf2Block({
    address: 0x1000_0010,
    payload: [0xff],
    blockNo: 0,
    numBlocks: 1,
    familyId: RP2040_FAMILY,
  });
  await expect(
    scanCanonicalArtifactInventory(
      await writeImage(
        "conflict.uf2",
        uf2File([...uf2Image(RP2040_FAMILY, 0x1000_0000, APP), rewrite]),
      ),
    ),
  ).rejects.toMatchObject({
    reason: "format",
    message:
      "UF2 is malformed: family 0xe48bff56 (RP2040) address 0x10000010 is written with different values by blocks 0-2 (0x75) and block 3 (0xff)",
  });
  const truncated = await scanCanonicalArtifactInventory(
    await writeImage("short.uf2", ABSOLUTE.subarray(0, 511)),
  );
  expect(truncated.manifest.root_format).toBe("file");
});

it("extracts byte-exact regions into family directories", async () => {
  const directory = await createTestTempDirectory("rea-uf2-extract-");
  const path = join(directory, "firmware.uf2");
  await writeFile(
    path,
    uf2File([ABSOLUTE, ...uf2Image(RP2040_FAMILY, 0x1000_0000, APP)]),
  );
  const resourceScope = new ArtifactResourceScope();
  try {
    const extracted = await extractArtifact({
      inputPath: path,
      inputFormat: "uf2",
      outputRoot: join(directory, "out"),
      environment: process.env,
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(extracted.containment_verified).toBe(true);
    expect(extracted.coverage.status).toBe("unknown");
    expect(
      Buffer.compare(
        await readFile(
          join(
            extracted.output_root,
            "family-0xe48bff56/0x10000000-0x10000257.bin",
          ),
        ),
        APP,
      ),
    ).toBe(0);
    expect(
      Buffer.compare(
        await readFile(
          join(
            extracted.output_root,
            "family-0xe48bff57/0x10ffff00-0x10ffffff.bin",
          ),
        ),
        Buffer.alloc(256, 0xef),
      ),
    ).toBe(0);
  } finally {
    await resourceScope.close();
  }
});

it("rejects a forged region entry and a changed carrier", async () => {
  const path = await writeImage(
    "identity.uf2",
    uf2File(uf2Image(RP2040_FAMILY, 0x1000_0000, APP)),
  );
  const reader = new Uf2ArtifactReader(path);
  try {
    const entries = [];
    for await (const entry of reader.entries()) entries.push(entry);
    const entry = entries[0];
    if (entry === undefined) throw new Error("Missing region");
    await expect(
      reader.open({ ...entry, adapterKey: "uf2:1" }),
    ).rejects.toMatchObject({ reason: "integrity" });
    await writeFile(path, uf2File(uf2Image(RP2040_FAMILY, 0, APP)));
    await expect(reader.open(entry)).rejects.toMatchObject({
      reason: "integrity",
    });
  } finally {
    await reader.close();
  }
});
