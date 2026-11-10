import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";

const SECTOR = 512;
const END = 0xffff_fffe;
const FREE = 0xffff_ffff;

interface FixtureEntry {
  readonly name: string;
  readonly type: 0 | 1 | 2 | 5;
  readonly start: number;
  readonly size: number;
  readonly left?: number;
  readonly right?: number;
  readonly child?: number;
}

/** A minimal version-3 compound file: header, one FAT sector, one directory sector. */
const compoundFile = (options: {
  readonly entries: readonly FixtureEntry[];
  readonly fat?: readonly number[];
  readonly totalSectors?: number;
}): Buffer => {
  const fat = options.fat ?? [END, END, END, END];
  const totalSectors = options.totalSectors ?? 10;
  const file = Buffer.alloc((totalSectors + 1) * SECTOR);
  Buffer.from("d0cf11e0a1b11ae1", "hex").copy(file, 0);
  file.writeUInt16LE(0x003e, 0x18);
  file.writeUInt16LE(3, 0x1a);
  file.writeUInt16LE(0xfffe, 0x1c);
  file.writeUInt16LE(9, 0x1e);
  file.writeUInt16LE(6, 0x20);
  file.writeUInt32LE(1, 0x2c);
  file.writeUInt32LE(1, 0x30);
  file.writeUInt32LE(4096, 0x38);
  file.writeUInt32LE(END, 0x3c);
  file.writeUInt32LE(0, 0x40);
  file.writeUInt32LE(END, 0x44);
  file.writeUInt32LE(0, 0x48);
  for (let index = 0; index < 109; index += 1)
    file.writeUInt32LE(index === 0 ? 0 : FREE, 0x4c + index * 4);
  // Sector 0 holds the FAT, sector 1 the directory stream.
  for (let index = 0; index < 128; index += 1)
    file.writeUInt32LE(fat[index] ?? FREE, SECTOR + index * 4);
  options.entries.forEach((entry, index) => {
    const base = 2 * SECTOR + index * 128;
    const name = Buffer.from(`${entry.name}\0`, "utf16le");
    name.copy(file, base);
    file.writeUInt16LE(name.length, base + 0x40);
    file.writeUInt8(entry.type, base + 0x42);
    file.writeUInt32LE(entry.left ?? FREE, base + 0x44);
    file.writeUInt32LE(entry.right ?? FREE, base + 0x48);
    file.writeUInt32LE(entry.child ?? FREE, base + 0x4c);
    file.writeUInt32LE(entry.start, base + 0x74);
    file.writeBigUInt64LE(BigInt(entry.size), base + 0x78);
  });
  return file;
};

const write = async (name: string, bytes: Buffer): Promise<string> => {
  const directory = await createTestTempDirectory("rea-compound-file-");
  const path = join(directory, name);
  await writeFile(path, bytes);
  return path;
};

/** The selected file's own occurrence is the one whose declaration is its size. */
const rootMetadata = async (
  inventory: Awaited<ReturnType<typeof scanCanonicalArtifactInventory>>,
  path: string,
) => {
  const size = (await stat(path)).size;
  return inventory.occurrences.find(
    (row) => row.logical_path === "." && row.declared_size === size,
  )?.format_metadata;
};

const rootWith = (
  child: number | undefined,
  extra: readonly FixtureEntry[],
): readonly FixtureEntry[] => [
  { name: "Root Entry", type: 5, start: END, size: 0, ...(child === undefined ? {} : { child }) },
  ...extra,
];

it("lists a root storage's streams and storages as occurrences", async () => {
  const path = await write(
    "sample.automaticDestinations-ms",
    compoundFile({
      entries: rootWith(1, [
        { name: "DestList", type: 2, start: 2, size: 512, right: 2 },
        { name: "Nested", type: 1, start: 0, size: 0, child: 3 },
        { name: "inner", type: 2, start: 3, size: 3 },
      ]),
    }),
  );
  const inventory = await scanCanonicalArtifactInventory(path);
  expect(inventory.manifest.root_format).toBe("compound-file");
  expect(await rootMetadata(inventory, path)).toMatchObject({
    kind: "compound-file",
    major_version: 3,
    sector_bytes: SECTOR,
    directory_entry_count: 4,
    stream_count: 2,
    storage_count: 1,
    root_storage_count: 1,
    orphan_entry_count: 0,
    broken_chain_count: 0,
  });
  expect(
    inventory.occurrences
      .map((row) => row.logical_path)
      .filter((logicalPath) => logicalPath !== ".")
      .sort(),
  ).toEqual(["DestList", "Nested", "Nested/inner"]);
});

it("names an entry outside the root tree as an orphan with no path", async () => {
  const path = await write(
    "orphan.automaticDestinations-ms",
    compoundFile({
      // The root storage lists no child, so this entry is in no tree.
      entries: rootWith(undefined, [
        { name: "Lost", type: 2, start: 2, size: 512 },
      ]),
    }),
  );
  const inventory = await scanCanonicalArtifactInventory(path);
  expect(await rootMetadata(inventory, path)).toMatchObject({
    orphan_entry_count: 1,
  });
  expect(inventory.limitations).toContainEqual(
    expect.stringMatching(/not reachable from the root storage/u),
  );
});

it("reports a stream whose FAT chain leaves the file", async () => {
  const path = await write(
    "broken.automaticDestinations-ms",
    compoundFile({
      entries: rootWith(1, [
        { name: "Broken", type: 2, start: 2, size: 4096 },
      ]),
      // Sector 2 claims sector 99, which is outside the ten declared sectors.
      fat: [END, END, 99, END],
    }),
  );
  const inventory = await scanCanonicalArtifactInventory(path);
  expect(await rootMetadata(inventory, path)).toMatchObject({
    broken_chain_count: 1,
  });
  expect(inventory.limitations).toContainEqual(
    expect.stringMatching(/allocation chain reaches/u),
  );
});

it("refuses a version the container does not define", async () => {
  const bytes = compoundFile({ entries: rootWith(undefined, []) });
  bytes.writeUInt16LE(2, 0x1a);
  await expect(
    scanCanonicalArtifactInventory(
      await write("version-2.automaticDestinations-ms", bytes),
    ),
  ).rejects.toThrow(/only versions 3 and 4 are supported/u);
});
