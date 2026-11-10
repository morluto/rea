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
  file.writeUInt16LE(6, 0x20);
  file.writeUInt32LE(1, 0x2c);
  file.writeUInt32LE(options.directorySector ?? 1, 0x30);
  file.writeUInt32LE(4096, 0x38);
  file.writeUInt32LE(END, 0x3c);
  file.writeUInt32LE(0, 0x40);
  file.writeUInt32LE(END, 0x44);
  file.writeUInt32LE(0, 0x48);
  for (let index = 0; index < 109; index += 1)
    file.writeUInt32LE(index === 0 ? 0 : FREE, 0x4c + index * 4);
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

const root = (
  child: number | undefined,
  extra: readonly Entry[],
): readonly Entry[] => [
  { name: "Root Entry", type: 5, start: END, size: 0, ...(child === undefined ? {} : { child }) },
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
  expect(image.entries.find((entry) => entry.name === "short")).toMatchObject({
    contiguous: false,
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

it("reports a directory tree link that leaves the entry table", () => {
  const image = parse(
    compoundFile({
      entries: root(1, [
        { name: "pointed", type: 2, start: 2, size: 512, left: 40 },
      ]),
    }),
  );
  expect(image.limitations).toContainEqual(
    expect.stringMatching(/outside the 4 entries/u),
  );
});

it("reports a link that would revisit an entry as a cycle", () => {
  const image = parse(
    compoundFile({
      entries: root(1, [
        { name: "a", type: 2, start: 2, size: 512, right: 1 },
      ]),
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

it("refuses a file above the fixed ceiling and streams a parse below it", () => {
  expect(
    createCompoundFileDecoder(COMPOUND_FILE_MAX_BYTES + 1).ok,
  ).toBe(false);
  const decoder = createCompoundFileDecoder(COMPOUND_FILE_MAX_BYTES);
  expect(decoder.ok).toBe(true);
  if (!decoder.ok) return;
  const bytes = compoundFile({ entries: root(undefined, []) });
  expect(decoder.value.write(bytes).ok).toBe(true);
  const image = decoder.value.finish();
  expect(image.ok).toBe(true);
});
