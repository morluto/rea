import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import {
  RP2040_FAMILY,
  RP2XXX_ABSOLUTE_FAMILY,
  UF2_FLAGS,
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

type Block = readonly [blockNo: number, address: number, kind?: "comment"];
const flash = (blockNo: number, address: number): Block => [blockNo, address];
const comment = (blockNo: number, address: number): Block => [
  blockNo,
  address,
  "comment",
];

const first = flash(0, 0x1000);
const firstComment = comment(0, 0xffff_ffff);
const secondCopies = [flash(1, 0x3000), flash(1, 0x4000)];
const twice = flash(0, 0x2000);

it.each([
  {
    label: "one flash address and repeated comments",
    input: [first, comment(1, 0), comment(1, 0xffff_ffff)],
    regions: 1,
    ambiguous: 0,
    repeats: 1,
  },
  {
    label: "two flash addresses and one comment",
    input: [first, twice, comment(1, 0)],
    regions: 2,
    ambiguous: 0,
    repeats: 1,
  },
  {
    label: "leading shared-number comment and two copies",
    input: [firstComment, first, twice, ...secondCopies],
    regions: 4,
    ambiguous: 0,
    repeats: 3,
  },
  {
    label: "trailing shared-number comment and two copies",
    input: [first, firstComment, twice, ...secondCopies],
    regions: 4,
    ambiguous: 0,
    repeats: 3,
  },
  {
    label: "leading shared-number comment and missing copy",
    input: [firstComment, first, first, ...secondCopies],
    regions: 3,
    ambiguous: 1,
    repeats: 3,
  },
  {
    label: "trailing shared-number comment and missing copy",
    input: [first, firstComment, first, ...secondCopies],
    regions: 3,
    ambiguous: 1,
    repeats: 3,
  },
])(
  "reports exact physical coverage with $label",
  async ({ input, regions, ambiguous, repeats }) => {
    const blocks = input.map(([blockNo, address, kind]) =>
      uf2Block({
        address,
        blockNo,
        numBlocks: 2,
        payload: kind === "comment" ? [9, 9] : [1, 2, 3, 4],
        flags: kind === "comment" ? UF2_FLAGS.notMainFlash : 0,
      }),
    );
    const snapshot = await scanCanonicalArtifactInventory(
      await writeImage("numbered.uf2", uf2File(blocks)),
    );
    expect(snapshot.coverage).toEqual({
      scope: "container-entries",
      status: ambiguous === 0 ? "complete" : "unknown",
    });
    const comments = input.filter(([, , kind]) => kind === "comment").length;
    expect(
      snapshot.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      kind: "uf2",
      ambiguous_numbering_group_count: ambiguous,
      missing_block_count: 0,
      repeated_block_count: repeats,
      not_main_flash_block_count: comments,
      flash_block_count: input.length - comments,
      region_count: regions,
      data_bytes: 4 * regions,
    });
  },
);

it("leaves short files unrecognized", async () => {
  const truncated = await scanCanonicalArtifactInventory(
    await writeImage("short.uf2", ABSOLUTE.subarray(0, 511)),
  );
  expect(truncated.manifest.root_format).toBe("file");
});
