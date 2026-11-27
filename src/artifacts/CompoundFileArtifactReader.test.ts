import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { scanCanonicalArtifactInventory } from "../../tests/fixtures/artifactInventory.js";
import { CompoundFileArtifactReader } from "./CompoundFileArtifactReader.js";
import { ArtifactFileSource } from "../resources/ArtifactFileSource.js";
import { assertArtifactReadActive } from "../resources/ArtifactFileOperation.js";
import { awaitAcknowledgement } from "../../tests/fixtures/lifecycleAcknowledgement.js";

const SECTOR = 512;
const END = 0xffff_fffe;
const FREE = 0xffff_ffff;

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
  const facts = (logicalPath: string) =>
    inventory.occurrences.find((row) => row.logical_path === logicalPath)
      ?.format_metadata;
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
  expect(listed?.limitations).toContainEqual(
    expect.stringMatching(/object type the format does not define/u),
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
