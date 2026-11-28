import { expect, it } from "vitest";

import {
  COMPOUND_FILE_MAX_BYTES,
  createCompoundFileDecoder,
  hasCompoundFileSignature,
  parseCompoundFile,
} from "./compoundFile.js";

const SECTOR = 512;
const END = 0xffff_fffe;
const FREE = 0xffff_ffff;
const MAGIC = Buffer.from("d0cf11e0a1b11ae1", "hex");

interface Entry {
  readonly name: string;
  readonly type: number;
  readonly start: number;
  readonly size: number;
  readonly left?: number;
  readonly right?: number;
  readonly child?: number;
}

/** A version-3 container with one FAT sector and one directory sector. */
const compoundFile = (options: {
  readonly entries: readonly Entry[];
  readonly fat?: readonly number[];
  readonly totalSectors?: number;
  readonly version?: number;
  readonly sectorShift?: number;
  readonly miniSectorShift?: number;
  readonly byteOrder?: number;
  readonly directorySector?: number;
}): Buffer => {
  // Sector 2's chain is contiguous for the length most fixtures declare.
  // Sector 0 holds this table, so it ends its own chain.
  const fat = options.fat ?? [END, END, 3, 4, 5, 6, 7, 8, 9, END];
  const sectors = options.totalSectors ?? 10;
  const file = Buffer.alloc((sectors + 1) * SECTOR);
  MAGIC.copy(file, 0);
  file.writeUInt16LE(0x003e, 0x18);
  file.writeUInt16LE(options.version ?? 3, 0x1a);
  file.writeUInt16LE(options.byteOrder ?? 0xfffe, 0x1c);
  file.writeUInt16LE(options.sectorShift ?? 9, 0x1e);
  file.writeUInt16LE(options.miniSectorShift ?? 6, 0x20);
  file.writeUInt32LE(1, 0x2c);
  file.writeUInt32LE(options.directorySector ?? 1, 0x30);
  file.writeUInt32LE(4096, 0x38);
  file.writeUInt32LE(END, 0x3c);
  file.writeUInt32LE(0, 0x40);
  file.writeUInt32LE(END, 0x44);
  file.writeUInt32LE(0, 0x48);
  // Each directory sector is 4 entries; a longer table chains them.
  const directorySectors = Math.max(
    1,
    Math.ceil((options.entries.length * 128) / SECTOR),
  );
  for (let index = 0; index < 109; index += 1)
    file.writeUInt32LE(index === 0 ? 0 : FREE, 0x4c + index * 4);
  for (let index = 0; index < 128; index += 1)
    file.writeUInt32LE(
      fat[index] ?? (index < directorySectors ? 1 + index : FREE),
      SECTOR + index * 4,
    );
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
 * A version-3 container sized for a large directory: the directory chain, the
 * FAT sectors that describe it, and the sector count all grow with `entries`.
 * `compoundFile` fixes those at the one-sector layout its small fixtures need.
 * A sector's offset is `512 * (id + 1)`; the header occupies the first 512 bytes.
 */
const sprawlingCompoundFile = (
  entries: readonly Entry[],
  trailingStreamSectors = 0,
): Buffer => {
  const directorySectors = Math.max(
    1,
    Math.ceil((entries.length * 128) / SECTOR),
  );
  // Each FAT sector describes 128 sectors, and the FAT itself is part of what
  // must be described, so the count is the least one that covers both.
  let fatSectors = 1;
  while (
    fatSectors * 128 <
    directorySectors + trailingStreamSectors + fatSectors
  )
    fatSectors += 1;
  if (fatSectors > 109)
    throw new Error("sprawling fixture needs a DIFAT chain");
  const firstDirectorySector = fatSectors;
  const firstStreamSector = fatSectors + directorySectors;
  const totalSectors = firstStreamSector + trailingStreamSectors;
  const file = Buffer.alloc((totalSectors + 1) * SECTOR);
  MAGIC.copy(file, 0);
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
  // The directory sectors form one contiguous chain after the FAT sectors.
  const cells: number[] = [];
  for (let sector = 0; sector < totalSectors; sector += 1)
    cells.push(
      sector < firstDirectorySector
        ? FREE
        : sector + 1 < totalSectors && sector + 1 !== firstStreamSector
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

const root = (
  child: number | undefined,
  extra: readonly Entry[],
): readonly Entry[] => [
  {
    name: "Root Entry",
    type: 5,
    start: END,
    size: 0,
    ...(child === undefined ? {} : { child }),
  },
  ...extra,
];

const parse = (bytes: Buffer) => {
  const result = parseCompoundFile(bytes);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

it("recognizes the compound file signature", () => {
  expect(hasCompoundFileSignature(MAGIC)).toBe(true);
  expect(hasCompoundFileSignature(Buffer.from("d0cf11e0a1b11ae"))).toBe(false);
  expect(hasCompoundFileSignature(Buffer.from("PK\u0003\u0004"))).toBe(false);
});

it("lists a storage's children by their full path and a stream's allocation", () => {
  const image = parse(
    compoundFile({
      entries: root(1, [
        { name: "Storage", type: 1, start: 0, size: 0, child: 2 },
        { name: "big", type: 2, start: 2, size: 4096, right: 3 },
        { name: "small", type: 2, start: 3, size: 100 },
      ]),
    }),
  );
  expect(image.entries.map((entry) => entry.path)).toEqual([
    "",
    "Storage",
    "Storage/big",
    "Storage/small",
  ]);
  const big = image.entries.find((entry) => entry.name === "big");
  expect(big).toMatchObject({
    storage: "fat",
    contiguous: true,
    byteOffset: 3 * SECTOR,
    chainProblem: null,
  });
  // Below the 4096-byte cutoff, bytes live in the root storage's mini stream.
  expect(image.entries.find((entry) => entry.name === "small")).toMatchObject({
    storage: "mini",
    byteOffset: null,
  });
  expect(image.metadata).toMatchObject({
    kind: "compound-file",
    major_version: 3,
    sector_bytes: SECTOR,
    stream_count: 2,
    storage_count: 1,
    broken_chain_count: 0,
  });
});

it("reports a chain that reaches the directory sector as an unresolved range", () => {
  // Sectors 1-8 hold the directory stream, so a stream that declares 4096
  // bytes from sector 1 has a complete, contiguous chain that is nevertheless
  // container structure rather than its own content.
  const image = parse(
    compoundFile({
      entries: root(1, [
        { name: "directory-bytes", type: 2, start: 1, size: 4096 },
      ]),
      fat: [END, 2, 3, 4, 5, 6, 7, 8, END],
    }),
  );
  expect(
    image.entries.find((entry) => entry.name === "directory-bytes"),
  ).toMatchObject({
    contiguous: true,
    structuralOverlap: true,
    byteOffset: null,
  });
  expect(image.limitations).toContainEqual(
    expect.stringMatching(/already owns/u),
  );
});

it("reports a chain that revisits a sector as broken", () => {
  const image = parse(
    compoundFile({
      entries: root(1, [{ name: "loop", type: 2, start: 2, size: 4096 }]),
      // Sector 2 points at itself.
      fat: [END, END, 2, END],
    }),
  );
  expect(image.metadata.broken_chain_count).toBe(1);
  expect(image.entries.find((entry) => entry.name === "loop")).toMatchObject({
    contiguous: false,
    byteOffset: null,
  });
  expect(image.limitations).toContainEqual(
    expect.stringMatching(/allocation chain reaches/u),
  );
});

it("reports a chain that is contiguous but shorter than the declared size", () => {
  const image = parse(
    compoundFile({
      entries: root(1, [{ name: "short", type: 2, start: 2, size: 12288 }]),
    }),
  );
  expect(image.metadata.broken_chain_count).toBe(1);
  // The three sectors the chain does reach are consecutive, so contiguity is
  // reported as a fact separate from the chain being too short; the stream has
  // no complete byte range, so no offset is published.
  expect(image.entries.find((entry) => entry.name === "short")).toMatchObject({
    contiguous: true,
    byteOffset: null,
    chainProblem: "incomplete",
  });
});

it("classifies a stream that starts at a marker with bytes as a broken chain", () => {
  const image = parse(
    compoundFile({
      entries: root(1, [{ name: "marker", type: 2, start: FREE, size: 8192 }]),
    }),
  );
  expect(image.metadata.broken_chain_count).toBe(1);
  expect(image.entries.find((entry) => entry.name === "marker")).toMatchObject({
    storage: "fat",
    startingSector: null,
    contiguous: null,
    byteOffset: null,
    chainProblem: "marker-start",
  });
});

it("keeps an entry outside the root's tree as an orphan with no path", () => {
  const image = parse(
    compoundFile({
      entries: root(undefined, [
        { name: "Lost", type: 2, start: 2, size: 512 },
      ]),
    }),
  );
  expect(image.metadata.orphan_entry_count).toBe(1);
  expect(image.entries.find((entry) => entry.name === "Lost")?.path).toBeNull();
  expect(image.limitations).toContainEqual(
    expect.stringMatching(/not reachable from the root storage/u),
  );
});

it("does not let an unallocated slot's stale child link adopt an entry", () => {
  // Entry 1 is type 0 (unallocated) yet names entry 2 as its child. Only a
  // storage owns a child tree, so entry 2 must stay an orphan.
  const image = parse(
    compoundFile({
      entries: root(1, [
        { name: "", type: 0, start: END, size: 0, child: 2 },
        { name: "live", type: 2, start: 2, size: 512 },
      ]),
    }),
  );
  expect(image.metadata.orphan_entry_count).toBe(1);
  expect(image.entries.find((entry) => entry.name === "live")?.path).toBeNull();
});

it("does not let an unallocated slot's sibling links name an entry", () => {
  // Entry 1 is type 0 and links to entry 2 as a sibling. A free record's links
  // are stale, so entry 2 must stay an orphan rather than be presented under
  // the root's hierarchy.
  const image = parse(
    compoundFile({
      entries: root(1, [
        { name: "", type: 0, start: END, size: 0, right: 2 },
        { name: "live", type: 2, start: 2, size: 512 },
      ]),
    }),
  );
  expect(image.metadata.orphan_entry_count).toBe(1);
  expect(image.entries.find((entry) => entry.name === "live")?.path).toBeNull();
});

it("leaves a chain that reaches a sector another stream owns unresolved", () => {
  // Both streams start at sector 2, so the second would publish the first's
  // bytes under its own identity.
  const image = parse(
    compoundFile({
      entries: root(1, [
        { name: "first", type: 2, start: 2, size: 4096 },
        { name: "second", type: 2, start: 2, size: 4096 },
      ]),
    }),
  );
  expect(image.entries.find((entry) => entry.name === "first")).toMatchObject({
    byteOffset: expect.any(Number) as unknown,
    sharedOverlap: false,
  });
  expect(image.entries.find((entry) => entry.name === "second")).toMatchObject({
    byteOffset: null,
    sharedOverlap: true,
  });
  expect(image.limitations).toContainEqual(
    expect.stringMatching(/another stream already owns/u),
  );
});

it("counts header-declared FAT sectors the DIFAT never lists", () => {
  // The header declares two FAT sectors but lists only sector 0, so the gap is
  // an unlisted sector: the field is meant to count header-declared sectors the
  // allocation tables do not name.
  const bytes = compoundFile({ entries: root(undefined, []) });
  bytes.writeUInt32LE(2, 0x2c);
  const image = parse(bytes);
  expect(image.metadata.unlisted_fat_sector_count).toBe(1);
  expect(image.limitations).toContainEqual(
    expect.stringMatching(/absent from the DIFAT/u),
  );
});

it("stops collecting FAT ids once the DIFAT names more than the file holds", () => {
  // A DIFAT sector whose 126 slots all name sector 1 would keep growing the
  // collection to 109 + 126 * chain-length ids if the bound only ran after the
  // whole chain. The file holds 12 sectors, so the collection is refused as
  // soon as it passes that.
  const bytes = compoundFile({
    entries: root(undefined, []),
    fat: [END, END, END, END],
    totalSectors: 12,
  });
  bytes.writeUInt32LE(9, 0x44);
  bytes.writeUInt32LE(1, 0x48);
  for (let index = 0; index < 127; index += 1)
    bytes.writeUInt32LE(1, 10 * SECTOR + index * 4);
  bytes.writeUInt32LE(END, 10 * SECTOR + 127 * 4);
  const result = parseCompoundFile(bytes);
  expect(!result.ok && result.error.message).toMatch(
    /FAT sector\(s\) the file holds/u,
  );
});

it("rejects a directory chain that reuses a FAT sector", () => {
  // Sector 0 is the FAT; naming it as the directory stream would read
  // allocation cells as directory entries.
  const result = parseCompoundFile(
    compoundFile({ entries: root(undefined, []), directorySector: 0 }),
  );
  expect(!result.ok && result.error.message).toMatch(
    /reuses a FAT or DIFAT sector/u,
  );
});

it("leaves a stream whose chain reaches the mini FAT unresolved", () => {
  // The header names sector 2 as the first mini FAT sector, and a stream also
  // starts there; its bytes are allocation cells, not content.
  const file = compoundFile({
    entries: root(1, [{ name: "big", type: 2, start: 2, size: 4096 }]),
  });
  file.writeUInt32LE(2, 0x3c);
  file.writeUInt32LE(1, 0x40);
  const image = parse(file);
  const big = image.entries.find((entry) => entry.name === "big");
  expect(big).toMatchObject({ structuralOverlap: true, byteOffset: null });
  expect(image.limitations).toContainEqual(
    expect.stringContaining("FAT, DIFAT, mini FAT or directory already owns"),
  );
});

it.each([
  { allocationTable: "FAT", miniFatStart: 0 },
  { allocationTable: "DIFAT", miniFatStart: 2 },
])(
  "reports a mini FAT that aliases the $allocationTable",
  ({ allocationTable, miniFatStart }) => {
    const fixture = compoundFile({
      entries: root(undefined, []),
      fat: [END, END, END],
    });
    if (allocationTable === "DIFAT") {
      fixture.writeUInt32LE(miniFatStart, 0x44);
      fixture.writeUInt32LE(1, 0x48);
      const offset = (miniFatStart + 1) * SECTOR;
      fixture.fill(0xff, offset, offset + SECTOR);
      fixture.writeUInt32LE(END, offset + SECTOR - 4);
    }
    fixture.writeUInt32LE(miniFatStart, 0x3c);
    fixture.writeUInt32LE(1, 0x40);
    expect(parse(fixture).limitations).toContain(
      "the mini FAT chain shares sectors with a FAT or DIFAT allocation table; those sectors cannot establish mini stream contents",
    );
  },
);

it.each([
  { start: 1000, count: 1, next: END, reached: 0, broken: true },
  { start: 2, count: 4, next: END, reached: 1, broken: false },
  { start: 2, count: 1, next: 2, reached: 1, broken: true },
])(
  "reports a mini FAT that holds $reached of $count declared sectors (broken=$broken)",
  ({ start, count, next, reached, broken }) => {
    const file = compoundFile({
      entries: root(undefined, []),
      fat: [END, END, next],
    });
    file.writeUInt32LE(start, 0x3c);
    file.writeUInt32LE(count, 0x40);
    const { limitations } = parse(file);
    expect(
      limitations.some((text) => text.includes("mini FAT chain starting")),
    ).toBe(broken);
    if (reached !== count)
      expect(limitations).toContain(
        `header declares ${count} mini FAT sector(s) but the chain holds ${reached}`,
      );
  },
);

it("keeps zero-length allocation distinct from a stream with an unknown cutoff", () => {
  const file = compoundFile({
    entries: root(1, [
      { name: "nonempty", type: 2, start: 2, size: 4096, right: 2 },
      { name: "empty", type: 2, start: END, size: 0 },
    ]),
  });
  file.writeUInt32LE(0, 0x38);
  const { entries } = parse(file);
  expect(entries[1]).toMatchObject({
    streamSize: 4096,
    storage: null,
    byteOffset: null,
  });
  expect(entries[2]).toMatchObject({ streamSize: 0, storage: "empty" });
});

it("charges repeated inspection of an aliased FAT chain", () => {
  const aliases = 48;
  const streamSectors = 8;
  const directorySectors = Math.ceil((aliases + 1) / 4);
  const firstStream = 1 + directorySectors; // This fixture fits one FAT sector.
  const streams = Array.from({ length: aliases }, (_, index) => ({
    name: `stream-${index}`,
    type: 2,
    start: firstStream,
    size: 4096,
    ...(index + 1 === aliases ? {} : { right: index + 2 }),
  }));
  const image = parse(sprawlingCompoundFile(root(1, streams), streamSectors));
  expect(image.entries[1]).toMatchObject({
    byteOffset: (firstStream + 1) * SECTOR,
    chainProblem: null,
  });
  expect(image.entries[2]).toMatchObject({
    sharedOverlap: true,
    byteOffset: null,
  });
  expect(image.entries[aliases]).toMatchObject({
    chainProblem: "budget",
    byteOffset: null,
    contiguous: null,
  });
  expect(image.metadata.broken_chain_count).toBe(0);
  expect(image.limitations).toContainEqual(
    expect.stringContaining("walk and inspection budget"),
  );
});

it("reports a directory tree link that leaves the entry table", () => {
  const image = parse(
    compoundFile({
      entries: root(1, [
        { name: "pointed", type: 2, start: 2, size: 512, left: 40 },
      ]),
    }),
  );
  expect(image.limitations).toContain(
    "directory entry 1 links to entry 40, which is outside the 4 entries the directory stream holds",
  );
});

it("reports a link that would revisit an entry as a cycle", () => {
  const image = parse(
    compoundFile({
      entries: root(1, [{ name: "a", type: 2, start: 2, size: 512, right: 1 }]),
    }),
  );
  expect(image.limitations).toContainEqual(
    expect.stringMatching(/lead back to an entry already listed/u),
  );
});

it("rejects a file shorter than the header", () => {
  const result = parseCompoundFile(MAGIC);
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(result.error.message).toMatch(/shorter than the 512-byte header/u);
});

it("rejects a signature-less file and a non-version-3/4 header", () => {
  const noMagic = compoundFile({ entries: root(undefined, []) });
  noMagic.write("nope", 0, "latin1");
  const wrongMagic = parseCompoundFile(noMagic);
  expect(!wrongMagic.ok && wrongMagic.error.message).toMatch(
    /does not begin with the compound file signature/u,
  );
  const version = parseCompoundFile(
    compoundFile({ entries: root(undefined, []), version: 2 }),
  );
  expect(!version.ok && version.error.message).toMatch(
    /only versions 3 and 4 are supported/u,
  );
});

it("rejects a sector shift that does not match the declared version", () => {
  const result = parseCompoundFile(
    compoundFile({ entries: root(undefined, []), sectorShift: 12 }),
  );
  expect(!result.ok && result.error.message).toMatch(/uses 9/u);
});

it("rejects a byte order other than the 0xfffe mark", () => {
  const result = parseCompoundFile(
    compoundFile({ entries: root(undefined, []), byteOrder: 0xfeff }),
  );
  expect(!result.ok && result.error.message).toMatch(/byte order/u);
});

it("rejects a directory chain that leaves the declared file", () => {
  const result = parseCompoundFile(
    compoundFile({
      entries: root(undefined, []),
      // The header's directory sector lies beyond the two sectors the file holds.
      directorySector: 40,
      totalSectors: 2,
    }),
  );
  expect(!result.ok && result.error.message).toMatch(
    /directory chain starting at sector 40 is broken/u,
  );
});

it("caches the tail a later stream starts at, not the earlier chain's prefix", () => {
  // One chain 2 -> 3 -> ... -> 19. The first stream declares more than it
  // reaches and is unresolved; the second starts partway along the same chain
  // at sector 10 and covers the rest exactly. Its share of the walk must be the
  // tail 10-19 with that tail's real outcome, not the earlier chain's prefix
  // reported as broken.
  const fat = Array.from({ length: 20 }, (_, index) =>
    index < 2 ? END : index === 19 ? END : index + 1,
  );
  const image = parse(
    compoundFile({
      entries: root(1, [
        { name: "earlier", type: 2, start: 2, size: 24 * SECTOR, right: 2 },
        { name: "later", type: 2, start: 10, size: 10 * SECTOR },
      ]),
      fat,
      totalSectors: 20,
    }),
  );
  expect(image.entries.find((entry) => entry.name === "earlier")).toMatchObject(
    { byteOffset: null },
  );
  // The tail reached from sector 10 is consecutive, which the old prefix cache
  // reported as broken; the earlier chain still owns those sectors, so the
  // bytes stay shared rather than published twice.
  expect(image.entries.find((entry) => entry.name === "later")).toMatchObject({
    contiguous: true,
    sharedOverlap: true,
    byteOffset: null,
  });
});

it("refuses streamed bytes beyond the admitted length and parses several chunks", () => {
  const bytes = compoundFile({ entries: root(undefined, []) });
  const decoder = createCompoundFileDecoder(bytes.length);
  expect(decoder.ok).toBe(true);
  if (!decoder.ok) return;
  expect(decoder.value.write(bytes.subarray(0, 100)).ok).toBe(true);
  expect(decoder.value.write(bytes.subarray(100)).ok).toBe(true);
  const image = decoder.value.finish();
  expect(image.ok).toBe(true);
  const overrun = createCompoundFileDecoder(bytes.length);
  if (!overrun.ok) return;
  expect(overrun.value.write(bytes.subarray(0, 10)).ok).toBe(true);
  const tooMany = overrun.value.write(new Uint8Array(bytes.length - 10 + 1));
  expect(tooMany).toMatchObject({ ok: false });
});

it("refuses a file above the fixed ceiling and streams a parse below it", () => {
  expect(createCompoundFileDecoder(COMPOUND_FILE_MAX_BYTES + 1).ok).toBe(false);
  const decoder = createCompoundFileDecoder(COMPOUND_FILE_MAX_BYTES);
  expect(decoder.ok).toBe(true);
  if (!decoder.ok) return;
  const bytes = compoundFile({ entries: root(undefined, []) });
  expect(decoder.value.write(bytes).ok).toBe(true);
  const image = decoder.value.finish();
  expect(image.ok).toBe(true);
});

it("refuses a DIFAT that names more FAT sectors than the file holds", () => {
  // Every header DIFAT slot names sector 1, so the ids are neither free nor
  // unique; the table must be bounded by the file, not by that count.
  const file = compoundFile({ entries: root(undefined, []) });
  for (let index = 0; index < 109; index += 1)
    file.writeUInt32LE(1, 0x4c + index * 4);
  const result = parseCompoundFile(file);
  expect(!result.ok && result.error.message).toMatch(
    /DIFAT names .* FAT sector/u,
  );
});

it("refuses a FAT block that the DIFAT chain already owns", () => {
  // One 512-byte DIFAT sector that names itself as the first FAT sector. Its
  // last word is simultaneously a FAT cell, so reading it as FAT cells would
  // let an ENDOFCHAIN pointer make an arbitrary sector look complete.
  const bytes = compoundFile({
    entries: root(undefined, []),
    fat: [END, END, END, END],
    totalSectors: 12,
  });
  // firstDifatSector = 9 (past the fixture's directory), one DIFAT sector.
  bytes.writeUInt32LE(9, 0x44);
  bytes.writeUInt32LE(1, 0x48);
  // The DIFAT sector lists sector 9 (itself) as FAT, then ENDOFCHAIN, and
  // fills the remaining 126 words with FREE so only that one block is named.
  bytes.writeUInt32LE(9, 10 * SECTOR);
  bytes.writeUInt32LE(END, 10 * SECTOR + 4);
  for (let index = 2; index < 128; index += 1)
    bytes.writeUInt32LE(FREE, 10 * SECTOR + index * 4);
  const image = parseCompoundFile(bytes);
  expect(image.ok).toBe(true);
  if (!image.ok) return;
  expect(image.value.limitations).toContainEqual(
    expect.stringMatching(/already owned by the DIFAT chain/u),
  );
});

it("keeps a FAT sector at its declared slot ordinal across a free DIFAT slot", () => {
  // Inline DIFAT slots 0, 1, 2 name sector 0, FREE, sector 3. Sector 0 holds
  // the FAT block that describes this 10-sector file, and sector 3 is a second
  // declared block past what the file can address. Compacting the free slot
  // away would read sector 3's bytes as block 1; the gap must instead be
  // reported and its slot left with markers.
  const bytes = compoundFile({ entries: root(undefined, []) });
  bytes.writeUInt32LE(0, 0x4c);
  bytes.writeUInt32LE(FREE, 0x50);
  bytes.writeUInt32LE(3, 0x54);
  const image = parseCompoundFile(bytes);
  if (!image.ok) throw new Error(image.error.message);
  // The directory chain still resolves from block 0, so the gap did not move
  // the block that names it.
  expect(image.value.metadata.directory_entry_count).toBe(4);
  // One FAT sector is listed; the free slot occupies a block ordinal but is
  // not a sector, so the count must not gain one the file does not hold.
  expect(image.value.metadata.fat_sector_count).toBe(1);
  expect(image.value.limitations).toContainEqual(
    expect.stringMatching(/free slot\(s\) before a listed FAT sector/u),
  );
});

it("refuses a chain the gap left unresolved instead of using the shifted block", () => {
  // Slots 0 and 1 name FREE and sector 0. Nothing declares block 0, so the
  // directory chain has no FAT cells to follow; the parse refuses it rather
  // than reading sector 0's bytes at an ordinal the header did not give it.
  const bytes = compoundFile({ entries: root(undefined, []) });
  bytes.writeUInt32LE(FREE, 0x4c);
  bytes.writeUInt32LE(0, 0x50);
  const result = parseCompoundFile(bytes);
  expect(result).toMatchObject({
    ok: false,
    error: { message: expect.stringMatching(/directory chain .* is broken/u) },
  });
});

it("caps FAT cells at the blocks that can describe a sector", () => {
  // A 20-sector file indexes 20 * 4 = 80 cells in a single 512-byte block, so
  // only one block can describe any of its sectors. Naming a second readable
  // block must not reserve another 128 cells for a chain nothing can reach.
  const entriesPerSector = SECTOR / 4;
  const blockLimit = Math.ceil(20 / entriesPerSector);
  const bytes = compoundFile({
    entries: root(undefined, []),
    totalSectors: 20,
  });
  bytes.writeUInt32LE(0, 0x4c);
  bytes.writeUInt32LE(3, 0x50);
  const image = parseCompoundFile(bytes);
  if (!image.ok) throw new Error(image.error.message);
  expect(image.value.metadata.fat_sector_count).toBe(blockLimit);
  expect(image.value.limitations).toContainEqual(
    expect.stringMatching(/beyond the 1 block\(s\) that can describe/u),
  );
});

it("counts listed FAT sectors, not the block span a free DIFAT slot leaves", () => {
  // A 300-sector file admits 3 FAT blocks. DIFAT slots [0, FREE, 3] fill two of
  // them; the free slot only holds block 1's ordinal open so block 2 is not
  // read as block 1. Counting the span would report 3 sectors where the file
  // holds 2, which is the header's own declaration in the reported case.
  const entriesPerSector = SECTOR / 4;
  const blockLimit = Math.ceil(300 / entriesPerSector);
  const bytes = compoundFile({
    entries: root(undefined, []),
    totalSectors: 300,
  });
  bytes.writeUInt32LE(0, 0x4c);
  bytes.writeUInt32LE(FREE, 0x50);
  bytes.writeUInt32LE(3, 0x54);
  const image = parseCompoundFile(bytes);
  if (!image.ok) throw new Error(image.error.message);
  expect(blockLimit).toBe(3);
  expect(image.value.metadata.fat_sector_count).toBe(2);
});

it("refuses a directory whose root storage is not entry 0", () => {
  const bytes = compoundFile({
    entries: [
      { name: "NotRoot", type: 1, start: END, size: 0, right: 1 },
      { name: "Root Entry", type: 5, start: END, size: 0 },
    ],
  });
  const result = parseCompoundFile(bytes);
  expect(result).toMatchObject({
    ok: false,
    error: {
      message: expect.stringMatching(/entry 0 is not the root storage/u),
    },
  });
});

it("reports a representable mini sector size above the 30-bit shift", () => {
  // A shift of 31 names a 2 GiB mini sector. `<<` would wrap it negative and
  // the old guard published 0, a fabricated size; Math.pow keeps it exact.
  const image = parse(
    compoundFile({ entries: root(undefined, []), miniSectorShift: 31 }),
  );
  expect(image.metadata.mini_sector_bytes).toBe(2 ** 31);
});

it("reports an unrepresentable mini sector shift as unknown, not zero", () => {
  // A shift past the safe-integer bound cannot name a representable size; the
  // field stays null and a limitation explains it instead of publishing 0.
  const image = parse(
    compoundFile({ entries: root(undefined, []), miniSectorShift: 60 }),
  );
  expect(image.metadata.mini_sector_bytes).toBeNull();
  expect(image.limitations).toContainEqual(
    expect.stringMatching(/mini sector size is unknown/u),
  );
});

it("leaves paths past the cumulative allowance unnamed instead of retaining them", () => {
  // Deep nesting alone is capped at 64 levels, but every descendant path repeats
  // its ancestors: 64 levels of maximum-length names describe about 2 KiB per
  // leaf, so a wide leaf set retains gigabytes of strings the metadata is not
  // worth. The allowance must be charged as each path is built, so the text
  // held never exceeds it, and an entry past it must keep its facts without a
  // path rather than carrying the oversized string.
  const DEPTH = 64;
  const NAME = "s".repeat(31);
  const LEAVES = 16_385;
  // Storage i owns storage i+1; the last storage owns the sibling stream chain.
  const chain: Entry[] = [];
  for (let level = 0; level < DEPTH; level += 1)
    chain.push({
      name: NAME,
      type: 1,
      start: 0,
      size: 0,
      child: level === DEPTH - 1 ? 1 + DEPTH : 2 + level,
    });
  const leaves: Entry[] = [];
  for (let leaf = 0; leaf < LEAVES; leaf += 1)
    leaves.push({
      name: NAME,
      type: 2,
      start: END,
      size: 0,
      ...(leaf === LEAVES - 1 ? {} : { right: 2 + DEPTH + leaf }),
    });
  const image = parse(sprawlingCompoundFile(root(1, [...chain, ...leaves])));
  // The allowance bounds what is retained: every named path together stays at
  // or under it, and some entries past it are unnamed rather than oversized.
  const retained = image.entries.reduce(
    (total, entry) => total + (entry.path?.length ?? 0),
    0,
  );
  expect(retained).toBeLessThanOrEqual(32 * 1024 * 1024);
  expect(image.entries.some((entry) => entry.path === null)).toBe(true);
  expect(image.limitations).toContainEqual(
    expect.stringMatching(/exceeded the 33554432-character allowance/u),
  );
  // An entry past the allowance is not silently dropped: it keeps the name and
  // facts it declares, only its logical path is withheld.
  const unnamed = image.entries.find(
    (entry) => entry.path === null && entry.type === "stream",
  );
  expect(unnamed?.name).toBe(NAME);
});
