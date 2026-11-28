import { readFile, stat, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";

import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import { CompoundFileArtifactReader } from "./CompoundFileArtifactReader.js";
import {
  COMPOUND_FILE_FIXED_LIMITS,
  COMPOUND_FILE_MAX_BYTES,
} from "../domain/windows/compoundFile.js";
import { ArtifactFileSource } from "../resources/ArtifactFileSource.js";
import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";
import { assertArtifactReadActive } from "../resources/ArtifactFileOperation.js";
import { openRegularFile } from "../filesystem/RegularFile.js";
import { awaitAcknowledgement } from "../../tests/fixtures/lifecycleAcknowledgement.js";
import { extractArtifact } from "./extraction/ArtifactExtraction.js";

const SECTOR = 512;
const END = 0xffff_fffe;
const FREE = 0xffff_ffff;

const acknowledgement = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

interface FixtureEntry {
  readonly name: string;
  /** A declared type byte; values past the defined ones are modeled records. */
  readonly type: number;
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

/**
 * A version-3 container whose directory spans as many sectors as `entries`
 * need. `compoundFile` fixes the layout its small fixtures use; a directory
 * past one 512-byte sector needs its own FAT sector and sector count.
 */
const sprawlingFixture = (
  entries: readonly FixtureEntry[],
  directorySlots = entries.length,
): Buffer => {
  const directorySectors = Math.max(
    1,
    Math.ceil((directorySlots * 128) / SECTOR),
  );
  let fatSectors = 1;
  while (fatSectors * 128 < directorySectors + fatSectors) fatSectors += 1;
  if (fatSectors > 109)
    throw new Error("sprawling fixture needs a DIFAT chain");
  const firstDirectorySector = fatSectors;
  const totalSectors = fatSectors + directorySectors;
  const file = Buffer.alloc((totalSectors + 1) * SECTOR);
  Buffer.from("d0cf11e0a1b11ae1", "hex").copy(file, 0);
  file.writeUInt16LE(0x003e, 0x18);
  file.writeUInt16LE(3, 0x1a);
  file.writeUInt16LE(0xfffe, 0x1c);
  file.writeUInt16LE(9, 0x1e);
  file.writeUInt16LE(6, 0x20);
  file.writeUInt32LE(fatSectors, 0x2c);
  file.writeUInt32LE(firstDirectorySector, 0x30);
  file.writeUInt32LE(4096, 0x38);
  file.writeUInt32LE(END, 0x3c);
  file.writeUInt32LE(0, 0x40);
  file.writeUInt32LE(END, 0x44);
  file.writeUInt32LE(0, 0x48);
  for (let index = 0; index < 109; index += 1)
    file.writeUInt32LE(index < fatSectors ? index : FREE, 0x4c + index * 4);
  const cells: number[] = [];
  for (let sector = 0; sector < totalSectors; sector += 1)
    cells.push(
      sector < firstDirectorySector
        ? FREE
        : sector + 1 < totalSectors
          ? sector + 1
          : END,
    );
  for (let sector = 0; sector < fatSectors; sector += 1)
    for (let index = 0; index < 128; index += 1)
      file.writeUInt32LE(
        cells[sector * 128 + index] ?? FREE,
        (1 + sector) * SECTOR + index * 4,
      );
  entries.forEach((entry, index) => {
    const base = (1 + firstDirectorySector) * SECTOR + index * 128;
    const entryName = Buffer.from(`${entry.name}\0`, "utf16le");
    entryName.copy(file, base);
    file.writeUInt16LE(entryName.length, base + 0x40);
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
  {
    name: "Root Entry",
    type: 5,
    start: END,
    size: 0,
    ...(child === undefined ? {} : { child }),
  },
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

it("publishes each entry's directory facts as format metadata", async () => {
  const path = await write(
    "facts.automaticDestinations-ms",
    compoundFile({
      entries: rootWith(1, [
        { name: "Nested", type: 1, start: 0, size: 0, child: 2 },
        // Two mini-stream-sized members: the format keeps their declared start
        // and size, which the inventory entry has no other place to carry.
        { name: "inner", type: 2, start: 3, size: 3, right: 3 },
        { name: "other", type: 2, start: 4, size: 4 },
      ]),
    }),
  );
  const inventory = await scanCanonicalArtifactInventory(path);
  const row = (logicalPath: string) =>
    inventory.occurrences.find(
      (occurrence) => occurrence.logical_path === logicalPath,
    );
  const facts = (logicalPath: string) => row(logicalPath)?.format_metadata;
  expect(facts("Nested")).toMatchObject({
    kind: "compound-file-entry",
    index: 1,
    role: "storage",
    parent_index: 0,
    child: 2,
    starting_sector: null,
    stream_size: null,
    storage: null,
  });
  // A mini stream has no byte range in the inventory, so its declared
  // allocation is the only surviving statement of where its bytes are.
  expect(facts("Nested/inner")).toMatchObject({
    kind: "compound-file-entry",
    index: 2,
    role: "stream",
    parent_index: 1,
    right_sibling: 3,
    starting_sector: 3,
    stream_size: 3,
    storage: "mini",
    contiguous: null,
  });
  expect(row("Nested/inner")).toMatchObject({
    parent_occurrence_id: row("Nested")?.occurrence_id,
    entry_kind: "metadata",
    source_location: null,
  });
  const empty = await scanCanonicalArtifactInventory(
    await write(
      "empty-storage.automaticDestinations-ms",
      compoundFile({
        entries: rootWith(1, [{ name: "Nested", type: 1, start: 0, size: 0 }]),
      }),
    ),
  );
  const emptyStorage = empty.occurrences.find(
    (entry) => entry.logical_path === "Nested",
  );
  expect(row("Nested")?.artifact_id).not.toBe(emptyStorage?.artifact_id);
});

it("publishes unknown allocation separately from an empty stream", async () => {
  const fixture = compoundFile({
    entries: rootWith(1, [
      { name: "Bytes", type: 2, start: 2, size: 4096, right: 2 },
      { name: "Empty", type: 2, start: END, size: 0 },
    ]),
  });
  fixture.writeUInt32LE(0, 0x38);
  const inventory = await scanCanonicalArtifactInventory(
    await write("unknown-cutoff.automaticDestinations-ms", fixture),
  );
  expect(
    inventory.occurrences.find((row) => row.logical_path === "Bytes"),
  ).toMatchObject({
    entry_kind: "metadata",
    source_location: null,
    format_metadata: { stream_size: 4096, storage: null },
    limitations: [expect.stringContaining("allocation is unresolved")],
  });
  expect(
    inventory.occurrences.find((row) => row.logical_path === "Empty"),
  ).toMatchObject({
    entry_kind: "file",
    format_metadata: { stream_size: 0, storage: "empty" },
  });
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
  // The orphan keeps its declared facts; it is listed under a derived path
  // because the tree gives it none.
  const listed = inventory.occurrences.find(
    (row) => row.logical_path === "entry-1",
  );
  expect(listed).toMatchObject({ logical_path: "entry-1" });
  expect(listed?.limitations).toContainEqual(
    expect.stringMatching(/not reachable from the root storage/u),
  );
});

it("reports a stream whose FAT chain leaves the file", async () => {
  const path = await write(
    "broken.automaticDestinations-ms",
    compoundFile({
      entries: rootWith(1, [{ name: "Broken", type: 2, start: 2, size: 4096 }]),
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
  // The entry itself says why it carries no bytes, rather than publishing a
  // metadata-only occurrence with an empty limitation list.
  const listed = inventory.occurrences.find(
    (row) => row.logical_path === "Broken",
  );
  expect(listed?.limitations).toContainEqual(
    expect.stringMatching(/FAT chain ends before the declared size/u),
  );
});

it("keeps an unsafe name as a source path instead of aborting the inventory", async () => {
  const path = await write(
    "unsafe.automaticDestinations-ms",
    compoundFile({
      entries: rootWith(1, [
        { name: "../escape", type: 2, start: 2, size: 512 },
      ]),
    }),
  );
  const inventory = await scanCanonicalArtifactInventory(path);
  const listed = inventory.occurrences.find((row) => row.logical_path !== ".");
  // The name reads as two components, so it cannot name a logical path; the
  // entry is still listed under its source ordinal and the raw name is kept.
  expect(listed?.logical_path).toBe("entry-1");
  expect(listed?.source_path).toBe("../escape");
});

it("keeps a descendant of an unusable name under its storage", async () => {
  // The storage's own name cannot name a path, so the parser leaves it and its
  // child unnamed. The child is still listed under the storage rather than at
  // the root, which would claim a member the directory never declared there.
  const path = await write(
    "unsafe-parent.automaticDestinations-ms",
    compoundFile({
      entries: rootWith(1, [
        { name: "bad/name", type: 1, start: 0, size: 0, child: 2 },
        { name: "payload", type: 2, start: 2, size: 512 },
      ]),
    }),
  );
  const inventory = await scanCanonicalArtifactInventory(path);
  const paths = inventory.occurrences
    .map((row) => row.logical_path)
    .filter((row) => row !== ".");
  expect(paths).toContain("entry-1");
  expect(paths).toContain("entry-1/payload");
  expect(paths).not.toContain("payload");
  expect(await rootMetadata(inventory, path)).toMatchObject({
    orphan_entry_count: 0,
  });
  for (const occurrence of inventory.occurrences.filter(
    (row) => row.logical_path !== ".",
  )) {
    expect(occurrence.limitations).toContainEqual(
      expect.stringContaining("This entry is reachable"),
    );
    expect(occurrence.limitations).not.toContainEqual(
      expect.stringContaining("not reachable"),
    );
  }
});

it("does not rebuild a rejected name into a path under its parent", async () => {
  // The storage is named safely; only the stream's own name reads as two
  // components. The parser refuses that name, so the member has no logical
  // path. Projecting it onto its parent by concatenating the raw name would
  // invent an intermediate directory the directory never declared.
  const path = await write(
    "rejected-member.automaticDestinations-ms",
    compoundFile({
      entries: rootWith(1, [
        { name: "Nested", type: 1, start: 0, size: 0, child: 2 },
        { name: "bad/name", type: 2, start: 2, size: 512 },
      ]),
    }),
  );
  const inventory = await scanCanonicalArtifactInventory(path);
  const paths = inventory.occurrences
    .map((row) => row.logical_path)
    .filter((row) => row !== ".");
  expect(paths).not.toContain("Nested/bad/name");
  expect(paths.some((row) => row.includes("bad"))).toBe(false);
  // The member is still listed, under its source ordinal, with its raw name.
  const listed = inventory.occurrences.find(
    (row) => row.source_path === "bad/name",
  );
  expect(listed?.logical_path).toBe("Nested/entry-2");
  expect(listed?.parent_occurrence_id).toBe(
    inventory.occurrences.find((row) => row.logical_path === "Nested")
      ?.occurrence_id,
  );
});

it("keeps an entry that declares no usable name", async () => {
  const bytes = compoundFile({
    entries: rootWith(1, [
      { name: "PLACEHOLDER", type: 2, start: 2, size: 512 },
    ]),
  });
  // A zero name length is a valid declaration but names nothing; the entry
  // still carries an ordinal, a type, a size and an allocation.
  bytes.writeUInt16LE(0, 2 * SECTOR + 128 + 0x40);
  const inventory = await scanCanonicalArtifactInventory(
    await write("unnamed.automaticDestinations-ms", bytes),
  );
  const listed = inventory.occurrences.find(
    (row) => row.logical_path === "entry-1",
  );
  expect(listed).toMatchObject({ logical_path: "entry-1" });
  expect(listed?.limitations).toContainEqual(
    expect.stringMatching(/declares no valid name/u),
  );
});

it("lists an entry whose declared type is not defined as metadata", async () => {
  const inventory = await scanCanonicalArtifactInventory(
    await write(
      "odd-type.automaticDestinations-ms",
      compoundFile({
        entries: rootWith(1, [{ name: "Odd", type: 3, start: 2, size: 512 }]),
      }),
    ),
  );
  // The parser counts this record as one the format does not define, so it must
  // be listed rather than silently dropped at the inventory boundary.
  const listed = inventory.occurrences.find(
    (row) => row.logical_path === "Odd",
  );
  expect(listed?.format_metadata).toMatchObject({
    role: "undefined-type",
    declared_type: 3,
  });
  expect(listed?.limitations).toContainEqual(
    expect.stringMatching(/object type the format does not define/u),
  );
});

it("retains a second root record without letting it own a subtree", async () => {
  const inventory = await scanCanonicalArtifactInventory(
    await write(
      "extra-root.automaticDestinations-ms",
      compoundFile({
        entries: rootWith(1, [
          { name: "Extra", type: 5, start: END, size: 0, child: 2 },
          { name: "Detached", type: 2, start: END, size: 0 },
        ]),
      }),
    ),
  );
  expect(
    inventory.occurrences.find((row) => row.logical_path === "Extra"),
  ).toMatchObject({
    entry_kind: "metadata",
    format_metadata: {
      index: 1,
      role: "root-storage",
      declared_type: 5,
      child: 2,
      stream_size: null,
    },
  });
  expect(
    inventory.occurrences.find((row) => row.logical_path === "entry-2")
      ?.limitations,
  ).toContainEqual(
    expect.stringMatching(/not reachable from the root storage/u),
  );
});

it("does not reuse a fallback path a member already claimed", async () => {
  // Entry 1 is literally named `entry-2`, and entry 2 is unreachable, so it
  // also needs the `entry-2` fallback. The second projection must not take the
  // member's own path.
  const path = await write(
    "collide.automaticDestinations-ms",
    compoundFile({
      entries: rootWith(1, [
        { name: "entry-2", type: 2, start: 2, size: 512 },
        { name: "Lost", type: 2, start: 3, size: 512 },
      ]),
    }),
  );
  const inventory = await scanCanonicalArtifactInventory(path);
  const paths = inventory.occurrences
    .map((row) => row.logical_path)
    .filter((row) => row !== ".");
  expect(paths).toContain("entry-2");
  expect(paths).toContain("entry-2-2");
  expect(new Set(paths).size).toBe(paths.length);
});

it("keeps a storage's children under the path it was listed at", async () => {
  // Two entries are both named `item`: the stream is listed first and keeps
  // the path, so the storage behind it is projected to `entry-2`. Its child
  // must move with it — leaving it at `item/child` would put a file named
  // `item` in front of a path under it, which the registry rejects.
  const path = await write(
    "renamed-storage.automaticDestinations-ms",
    compoundFile({
      entries: rootWith(1, [
        { name: "item", type: 2, start: 2, size: 512, right: 2 },
        { name: "item", type: 1, start: 0, size: 0, child: 3 },
        { name: "child", type: 2, start: 3, size: 3 },
      ]),
    }),
  );
  const inventory = await scanCanonicalArtifactInventory(path);
  const paths = inventory.occurrences
    .map((row) => row.logical_path)
    .filter((row) => row !== ".");
  expect(paths).toContain("entry-2");
  expect(paths).toContain("entry-2/child");
  expect(paths).not.toContain("item/child");
});

it("moves a projected storage's child under the path it was listed at", async () => {
  // The child is listed before the storage that owns it (ordinal 1, parent 3),
  // so placing it by directory order would claim `foo/child` before the storage
  // is projected to `entry-3`. The parent must be placed first.
  const path = await write(
    "prefix-conflict.automaticDestinations-ms",
    compoundFile({
      entries: rootWith(2, [
        // Ordinal 1 is the storage's child; the storage itself is ordinal 3.
        { name: "child", type: 2, start: 3, size: 3 },
        { name: "foo", type: 2, start: 2, size: 512, right: 3 },
        { name: "foo", type: 1, start: 0, size: 0, child: 1 },
      ]),
    }),
  );
  const inventory = await scanCanonicalArtifactInventory(path);
  const paths = inventory.occurrences
    .map((row) => row.logical_path)
    .filter((row) => row !== ".");
  expect(paths).toContain("foo");
  // The storage is projected to its ordinal and its child follows it, so no
  // path in the result would be rejected as a prefix conflict.
  expect(paths).toContain("entry-3");
  expect(paths).toContain("entry-3/child");
  expect(paths).not.toContain("foo/child");
  expect(new Set(paths).size).toBe(paths.length);
});

it.each([
  {
    name: "unique",
    depth: 60,
    leaves: 40_000,
    leafName: (ordinal: number) => `leaf-${ordinal}`,
    expectLimit: true,
  },
  {
    name: "colliding",
    depth: 60,
    leaves: 17_200,
    leafName: (ordinal: number) =>
      ordinal === 17_199 ? "payload" : "n".repeat(31),
    expectLimit: false,
  },
  {
    name: "unique beneath unused directory capacity",
    depth: 63,
    leaves: 16_150,
    directorySlots: 52_000,
    leafName: (ordinal: number) =>
      ordinal === 16_149 ? "payload" : `leaf-${ordinal}`.padEnd(31, "x"),
    expectLimit: false,
  },
])(
  "accounts for the paths it keeps with $name names",
  async ({ depth, leaves, directorySlots, leafName, expectLimit }) => {
    // The parser's allowance covers the paths it can name, but a member of a
    // storage whose own name cannot name a path is placed here, and those
    // rebuilt paths are charged against the same ceiling. Unique leaves exhaust
    // it; repeated leaves need only short ordinal components, and unused
    // directory slots reserve no paths.
    const name = "s".repeat(31);
    const entries: FixtureEntry[] = [
      // Ordinal 1 is the unusable storage; the remaining storages nest below it.
      { name: "bad/name", type: 1, start: 0, size: 0, child: 2 },
    ];
    for (let level = 0; level < depth; level += 1)
      entries.push({
        name,
        type: 1,
        start: 0,
        size: 0,
        child: level === depth - 1 ? 2 + depth : 3 + level,
      });
    const firstLeaf = 2 + depth;
    for (let leaf = 0; leaf < leaves; leaf += 1)
      entries.push({
        name: leafName(leaf),
        type: 2,
        start: END,
        size: 0,
        ...(leaf === leaves - 1 ? {} : { right: firstLeaf + leaf + 1 }),
      });
    const path = await write(
      "path-allowance.automaticDestinations-ms",
      sprawlingFixture(rootWith(1, entries), directorySlots),
    );
    const reader = new CompoundFileArtifactReader(path);
    try {
      let count = 0;
      let retained = 0;
      let limited = false;
      let flatOrdinal = false;
      let placedPayload = false;
      let destinationCoverageGap = false;
      for await (const entry of reader.entries(undefined, {
        onCoverage: ({ limitations }) => {
          destinationCoverageGap = limitations.some((text) =>
            text.includes("some extraction destinations"),
          );
        },
      })) {
        count += 1;
        retained += entry.path.length;
        limited ||= entry.limitations.some((text) =>
          text.includes("paths exceeded the cumulative allowance"),
        );
        if (
          entry.observedParentPath !== undefined &&
          !entry.path.includes("/")
        ) {
          flatOrdinal = true;
          expect(entry.kind).toBe("metadata");
          expect(entry.byteOffset).toBeNull();
        }
        placedPayload ||= entry.path.endsWith("/payload");
      }
      expect(count).toBe(leaves + depth + 1);
      expect(retained).toBeLessThanOrEqual(32 * 1024 * 1024);
      expect(limited).toBe(expectLimit);
      expect(flatOrdinal).toBe(expectLimit);
      expect(destinationCoverageGap).toBe(expectLimit);
      expect(placedPayload).toBe(!expectLimit);
    } finally {
      await reader.close();
    }
  },
);

it("keeps an NFC-colliding readable stream inside its storage when extracting", async () => {
  const bytes = compoundFile({
    entries: rootWith(1, [
      { name: "Nested", type: 1, start: 0, size: 0, child: 2 },
      { name: "é", type: 2, start: 2, size: 4096, right: 3 },
      { name: "e\u0301", type: 2, start: 10, size: 4096 },
    ]),
    fat: [END, END, 3, 4, 5, 6, 7, 8, 9, END, 11, 12, 13, 14, 15, 16, 17, END],
    totalSectors: 18,
  });
  const second = Buffer.alloc(4096, 0x22);
  second.copy(bytes, (10 + 1) * SECTOR);
  const directory = await createTestTempDirectory("rea-compound-extract-");
  const source = join(directory, "names.cfb");
  const outputRoot = join(directory, "out");
  await writeFile(source, bytes);
  const inventory = await scanCanonicalArtifactInventory(source);
  const storage = inventory.occurrences.find(
    (entry) => entry.logical_path === "Nested",
  );
  expect(
    inventory.occurrences.find(
      (entry) => entry.logical_path === "Nested/entry-3",
    ),
  ).toMatchObject({
    entry_kind: "file",
    parent_occurrence_id: storage?.occurrence_id,
    source_location: { offset: (10 + 1) * SECTOR, length: 4096 },
  });
  const resourceScope = new ArtifactResourceScope();
  try {
    await extractArtifact({
      inputPath: source,
      inputFormat: "compound-file",
      outputRoot,
      environment: {},
      integrityPolicy: "fail",
      resourceScope,
    });
    expect(
      (await readFile(join(outputRoot, "Nested", "entry-3"))).equals(second),
    ).toBe(true);
    await expect(stat(join(outputRoot, "entry-3"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await resourceScope.close();
  }
});

it("claims a canonically equivalent name as one path", async () => {
  // `é` (U+00E9) and `e` + U+0301 normalize to the same NFC path. Claiming
  // raw spellings would let both through and the inventory registry would
  // abort on the collision instead of projecting the second to its ordinal.
  const path = await write(
    "nfc.automaticDestinations-ms",
    compoundFile({
      entries: rootWith(1, [
        { name: "é", type: 2, start: 2, size: 512, right: 2 },
        { name: "é", type: 2, start: 3, size: 512 },
      ]),
    }),
  );
  const inventory = await scanCanonicalArtifactInventory(path);
  const listed = inventory.occurrences.filter(
    (row) => row.logical_path !== ".",
  );
  expect(listed).toHaveLength(2);
  expect(new Set(listed.map((row) => row.logical_path)).size).toBe(2);
  // The first spelling keeps its declared path; the second is projected.
  expect(listed.map((row) => row.logical_path).sort()).toEqual([
    "entry-2",
    "é",
  ]);
});

it("does not publish a clamped size as the declared size", async () => {
  // A version-4 entry can declare more bytes than a JavaScript number carries
  // exactly; the parse clamps it, and the inventory must not report the clamp
  // as an observed declaration. Version 4 requires 4096-byte sectors.
  const sector = 4096;
  const file = Buffer.alloc((10 + 1) * sector);
  Buffer.from("d0cf11e0a1b11ae1", "hex").copy(file, 0);
  file.writeUInt16LE(0x003c, 0x18);
  file.writeUInt16LE(4, 0x1a);
  file.writeUInt16LE(0xfffe, 0x1c);
  file.writeUInt16LE(12, 0x1e);
  file.writeUInt16LE(6, 0x20);
  file.writeUInt32LE(1, 0x2c);
  file.writeUInt32LE(1, 0x30);
  file.writeUInt32LE(1, 0x34);
  file.writeUInt32LE(4096, 0x38);
  file.writeUInt32LE(END, 0x3c);
  file.writeUInt32LE(0, 0x40);
  file.writeUInt32LE(END, 0x44);
  file.writeUInt32LE(0, 0x48);
  for (let index = 0; index < 109; index += 1)
    file.writeUInt32LE(index === 0 ? 0 : FREE, 0x4c + index * 4);
  for (let index = 0; index < sector / 4; index += 1)
    file.writeUInt32LE([END, END, END, END][index] ?? FREE, sector + index * 4);
  const rootName = Buffer.from("Root Entry\0", "utf16le");
  const base = 2 * sector;
  rootName.copy(file, base);
  file.writeUInt16LE(rootName.length, base + 0x40);
  file.writeUInt8(5, base + 0x42);
  file.writeUInt32LE(FREE, base + 0x44);
  file.writeUInt32LE(FREE, base + 0x48);
  file.writeUInt32LE(1, base + 0x4c);
  file.writeUInt32LE(END, base + 0x74);
  file.writeBigUInt64LE(0n, base + 0x78);
  const name = Buffer.from("Huge\0", "utf16le");
  const streamBase = base + 128;
  name.copy(file, streamBase);
  file.writeUInt16LE(name.length, streamBase + 0x40);
  file.writeUInt8(2, streamBase + 0x42);
  file.writeUInt32LE(FREE, streamBase + 0x44);
  file.writeUInt32LE(FREE, streamBase + 0x48);
  file.writeUInt32LE(FREE, streamBase + 0x4c);
  file.writeUInt32LE(END, streamBase + 0x74);
  file.writeBigUInt64LE(2n ** 53n, streamBase + 0x78);
  const inventory = await scanCanonicalArtifactInventory(
    await write("huge.automaticDestinations-ms", file),
  );
  const listed = inventory.occurrences.find(
    (row) => row.logical_path === "Huge",
  );
  expect(listed).toMatchObject({ entry_kind: "metadata", declared_size: null });
  // The clamp that stands in for the unrepresentable size must not be
  // published either: inventing an observed size next to a limitation that
  // says the size is unknown would present a fact the file never declared.
  expect(listed?.format_metadata).toMatchObject({
    kind: "compound-file-entry",
    stream_size: null,
  });
  expect(listed?.limitations).toContainEqual(
    expect.stringMatching(/more bytes than a JavaScript number carries/u),
  );
});

it("leaves a stream whose chain reaches the directory unresolved", async () => {
  const path = await write(
    "overlap.automaticDestinations-ms",
    compoundFile({
      // Sector 1 is the directory stream itself, so these bytes are structure
      // rather than this member's content.
      entries: rootWith(1, [
        { name: "Structure", type: 2, start: 1, size: 4096 },
      ]),
      fat: [END, 2, 3, 4, 5, 6, 7, 8, END],
    }),
  );
  const inventory = await scanCanonicalArtifactInventory(path);
  expect(await rootMetadata(inventory, path)).toMatchObject({
    kind: "compound-file",
  });
  expect(inventory.limitations.length).toBeGreaterThan(0);
  const listed = inventory.occurrences.find(
    (row) => row.logical_path === "Structure",
  );
  expect(listed).toMatchObject({ entry_kind: "metadata" });
  expect(listed?.limitations).toContainEqual(
    expect.stringMatching(/already owns/u),
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

it("refuses a file above the whole-file ceiling with its ceiling named", async () => {
  const path = await write(
    "oversized.automaticDestinations-ms",
    compoundFile({ entries: rootWith(undefined, []) }),
  );
  // A sparse file: the size is beyond the fixed ceiling without writing it all.
  await truncate(path, COMPOUND_FILE_MAX_BYTES + 1);
  const reader = new CompoundFileArtifactReader(path);
  try {
    await expect(
      reader.entries()[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({
      reason: "limit",
      fixedAllowance: {
        name: COMPOUND_FILE_FIXED_LIMITS.get("file-size")?.name,
        limit: COMPOUND_FILE_MAX_BYTES,
        unit: "bytes",
      },
    });
  } finally {
    await reader.close();
  }
});

it("keeps a cancelled waiter from restarting a shared preparation", async () => {
  const reader = new CompoundFileArtifactReader(
    await write(
      "shared-stays.automaticDestinations-ms",
      compoundFile({
        entries: rootWith(1, [
          { name: "Stream", type: 2, start: 2, size: 512 },
        ]),
      }),
    ),
  );
  const read = ArtifactFileSource.prototype.read;
  let reads = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The first read parks, so a preparation that is discarded has to start a
  // second read while the first is still in flight.
  const spy = vi
    .spyOn(ArtifactFileSource.prototype, "read")
    .mockImplementation(function (this: ArtifactFileSource, signal) {
      reads += 1;
      if (reads === 1) return gate.then(() => read.call(this, signal));
      return read.call(this, signal);
    });
  const collect = async (signal?: AbortSignal): Promise<string[]> => {
    const paths: string[] = [];
    for await (const entry of reader.entries(signal)) paths.push(entry.path);
    return paths;
  };
  const starter = new AbortController();
  const cancelling = new AbortController();
  let started: Promise<string[]> | undefined;
  let abandoned: Promise<string[]> | undefined;
  let joined: Promise<string[]> | undefined;
  try {
    started = collect(starter.signal);
    // A caller that joins the in-flight preparation and then cancels must end
    // only its own wait: discarding the preparation here would make every later
    // caller read and parse the file again.
    abandoned = collect(cancelling.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    cancelling.abort("cancelled after joining");
    await expect(abandoned).rejects.toMatchObject({ reason: "cancelled" });
    joined = collect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The read the cancelled caller borrowed is still the only one.
    expect(reads).toBe(1);
    release();
    await expect(joined).resolves.toContain("Stream");
    await expect(started).resolves.toContain("Stream");
  } finally {
    release();
    starter.abort();
    cancelling.abort();
    for (const pending of [started, abandoned, joined])
      await pending?.catch(() => undefined);
    spy.mockRestore();
    await reader.close();
  }
});

it("joins an abandoned preparation before closing a borrowed carrier", async () => {
  const path = await write(
    "close-while-preparing.automaticDestinations-ms",
    compoundFile({ entries: rootWith(undefined, []) }),
  );
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new CompoundFileArtifactReader(path, admitted);
  const controller = new AbortController();
  const entered = acknowledgement();
  const release = acknowledgement();
  const read = admitted.handle.read.bind(admitted.handle);
  const calls = vi
    .spyOn(admitted.handle, "read")
    .mockImplementationOnce((async (...args: Parameters<typeof read>) => {
      entered.resolve();
      await release.promise;
      return read(...args);
    }) as typeof read);
  let closing: Promise<void> | undefined;
  const listing = reader
    .entries(controller.signal)
    [Symbol.asyncIterator]()
    .next();
  try {
    await awaitAcknowledgement(
      entered.promise,
      listing,
      "admitted compound file read",
    );
    controller.abort("released by the listing caller");
    await expect(listing).rejects.toMatchObject({ reason: "cancelled" });
    const closed = vi.fn();
    closing = reader.close().then(closed);
    await setImmediate();
    expect(closed).not.toHaveBeenCalled();
    release.resolve();
    await closing;
  } finally {
    controller.abort();
    release.resolve();
    await listing.catch(() => undefined);
    await closing;
    await reader.close();
    calls.mockRestore();
    await admitted.handle.close();
  }
});

it("checks carrier identity before reporting a decoder failure", async () => {
  const path = await write(
    "truncated-while-preparing.automaticDestinations-ms",
    compoundFile({ entries: rootWith(undefined, []) }),
  );
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new CompoundFileArtifactReader(path, admitted);
  const read = admitted.handle.read.bind(admitted.handle);
  const calls = vi
    .spyOn(admitted.handle, "read")
    .mockImplementationOnce((async (...args: Parameters<typeof read>) => {
      await truncate(path, SECTOR);
      return read(...args);
    }) as typeof read);
  try {
    await expect(
      reader.entries()[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({
      reason: "integrity",
      integrityCheck: "container-identity",
    });
  } finally {
    await reader.close();
    calls.mockRestore();
    await admitted.handle.close();
  }
});

it("retries a shared preparation cancelled by another traversal", async () => {
  const reader = new CompoundFileArtifactReader(
    await write(
      "shared.automaticDestinations-ms",
      compoundFile({
        entries: rootWith(1, [
          { name: "Stream", type: 2, start: 2, size: 512 },
        ]),
      }),
    ),
  );
  const controller = new AbortController();
  let entered: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const read = ArtifactFileSource.prototype.read;
  const spy = vi
    .spyOn(ArtifactFileSource.prototype, "read")
    .mockImplementationOnce(async function (this: ArtifactFileSource, signal) {
      entered();
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      assertArtifactReadActive(signal);
      return read.call(this, signal);
    });
  let cancelled: Promise<unknown> | undefined;
  let other: Promise<string[]> | undefined;
  try {
    cancelled = reader
      .entries(controller.signal)
      [Symbol.asyncIterator]()
      .next();
    const cancelledResult = expect(cancelled).rejects.toMatchObject({
      reason: "cancelled",
    });
    // If the first traversal fails before reaching the mocked read, waiting on
    // `started` alone would hide that failure until the test timed out.
    await awaitAcknowledgement(started, cancelled, "shared preparation");
    const collect = async (): Promise<string[]> => {
      const paths: string[] = [];
      for await (const entry of reader.entries()) paths.push(entry.path);
      return paths;
    };
    other = collect();
    controller.abort("cancelled first traversal");
    await cancelledResult;
    await expect(other).resolves.toContain("Stream");
  } finally {
    controller.abort();
    // Both traversals must be joined before the mock goes away, or a read the
    // second one still needs would run against the restored implementation.
    await cancelled?.catch(() => undefined);
    await other?.catch(() => undefined);
    spy.mockRestore();
    await reader.close();
  }
});

it("rechecks the carrier before yielding cached entries again", async () => {
  const path = await write(
    "cached.automaticDestinations-ms",
    compoundFile({
      entries: rootWith(1, [{ name: "Stream", type: 2, start: 2, size: 512 }]),
    }),
  );
  const reader = new CompoundFileArtifactReader(path);
  try {
    const first: string[] = [];
    for await (const entry of reader.entries()) first.push(entry.path);
    expect(first).toContain("Stream");
    // The cached listing is reused, but it must not be reported for a carrier
    // that no longer matches the one it was built from.
    await writeFile(path, Buffer.alloc(0));
    const again = async (): Promise<string[]> => {
      const paths: string[] = [];
      for await (const entry of reader.entries()) paths.push(entry.path);
      return paths;
    };
    await expect(again()).rejects.toMatchObject({ reason: "integrity" });
  } finally {
    await reader.close();
  }
});

it("verifies the carrier before returning an empty stream", async () => {
  const path = await write(
    "empty-rewritten.automaticDestinations-ms",
    compoundFile({
      entries: rootWith(1, [{ name: "Empty", type: 2, start: END, size: 0 }]),
    }),
  );
  const reader = new CompoundFileArtifactReader(path);
  try {
    let entry: Parameters<typeof reader.open>[0] | undefined;
    for await (const member of reader.entries())
      if (member.path === "Empty") entry = member;
    if (entry === undefined) throw new Error("Missing Empty entry");
    // An empty member has no range to read, so the carrier check is the only
    // thing that can tell a rewritten source from the inventoried one.
    await writeFile(path, Buffer.alloc(0));
    await expect(reader.open(entry)).rejects.toMatchObject({
      reason: "integrity",
    });
  } finally {
    await reader.close();
  }
});

it("rejects a stream whose carrier shrank while it was being delivered", async () => {
  const path = await write(
    "late-truncate.automaticDestinations-ms",
    compoundFile({
      entries: rootWith(1, [{ name: "Stream", type: 2, start: 2, size: 4096 }]),
      fat: [END, END, 3, 4, 5, 6, 7, 8, 9, END],
      totalSectors: 12,
    }),
  );
  const reader = new CompoundFileArtifactReader(path);
  try {
    let entry: Parameters<typeof reader.open>[0] | undefined;
    for await (const member of reader.entries())
      if (member.path === "Stream") entry = member;
    if (entry === undefined) throw new Error("Missing Stream entry");
    const stream = await reader.open(entry);
    // Truncate only after open() admitted the carrier and started the pump, so
    // the failure has to come from the delivered-length check rather than from
    // the pre-read identity check that already ran.
    await writeFile(path, Buffer.alloc(0));
    const consumed = (async (): Promise<number> => {
      let delivered = 0;
      for await (const chunk of stream) delivered += chunk.length;
      return delivered;
    })();
    await expect(consumed).rejects.toMatchObject({ reason: "integrity" });
  } finally {
    await reader.close();
  }
});

it("keeps final carrier verification primary when cancellation arrives late", async () => {
  const path = await write(
    "abort-final-verification.automaticDestinations-ms",
    compoundFile({
      entries: rootWith(1, [{ name: "Stream", type: 2, start: 2, size: 4096 }]),
      fat: [END, END, 3, 4, 5, 6, 7, 8, 9, END],
      totalSectors: 12,
    }),
  );
  const admitted = await openRegularFile(path, { symlinks: "reject" });
  const reader = new CompoundFileArtifactReader(path, admitted);
  const controller = new AbortController();
  const finalCheck = acknowledgement();
  const release = acknowledgement();
  try {
    let entry: Parameters<typeof reader.open>[0] | undefined;
    for await (const member of reader.entries())
      if (member.path === "Stream") entry = member;
    if (entry === undefined) throw new Error("Missing Stream entry");
    const stat = admitted.handle.stat.bind(admitted.handle);
    const calls = vi
      .spyOn(admitted.handle, "stat")
      .mockImplementationOnce(stat)
      .mockImplementationOnce(async () => {
        finalCheck.resolve();
        await release.promise;
        return stat();
      });
    const stream = await reader.open(entry, controller.signal);
    const consumed = (async (): Promise<number> => {
      let bytes = 0;
      for await (const chunk of stream) bytes += chunk.length;
      return bytes;
    })();
    try {
      await awaitAcknowledgement(
        finalCheck.promise,
        consumed,
        "compound file final verification",
      );
      await truncate(path, 0);
      controller.abort("stopped during verification");
      release.resolve();
      await expect(consumed).rejects.toMatchObject({
        reason: "integrity",
        integrityCheck: "container-identity",
      });
    } finally {
      release.resolve();
      await consumed.catch(() => undefined);
      calls.mockRestore();
    }
  } finally {
    await reader.close();
    await admitted.handle.close();
  }
});
