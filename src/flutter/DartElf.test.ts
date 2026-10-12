import { describe, expect, it } from "vitest";

import { readElfSymbols, readSnapshotHeader } from "./DartElf.js";
import {
  REFERENCE_HASH,
  buildElf64Image,
  buildStrippedElf64Image,
  snapshotSection,
} from "./FlutterBuild.fixture.js";

const readElfSymbol = async (bytes: Buffer, name: string) => {
  const result = await readElfSymbols(bytes, [name]);
  return result.symbols[0] === undefined
    ? { failure: result.failures[0]! }
    : { symbol: result.symbols[0] };
};

/**
 * Build a synthetic ELF64 little-endian image with one PT_LOAD segment
 * and a dynamic symbol table naming the Dart snapshot sections. This keeps
 * the golden tests self-contained instead of reading the author's disk.
 */
const GALLERY_HASH = REFERENCE_HASH;

const imageWithSections = (): Buffer => {
  const elf = buildElf64Image([
    { name: "_kDartVmSnapshotData", value: 0x400, size: 52 },
    { name: "_kDartIsolateSnapshotData", value: 0x800, size: 52 },
  ]);
  const section = snapshotSection(GALLERY_HASH);
  return Buffer.concat([
    elf,
    Buffer.alloc(0x400 - elf.length),
    section,
    Buffer.alloc(0x800 - 0x400 - section.length),
    section,
  ]);
};

/** The same layout without section headers: symbols live in PT_DYNAMIC. */
const strippedImageWithSections = (): Buffer => {
  const elf = buildStrippedElf64Image([
    { name: "_kDartVmSnapshotData", value: 0x400, size: 52 },
    { name: "_kDartIsolateSnapshotData", value: 0x800, size: 52 },
  ]);
  const section = snapshotSection(GALLERY_HASH);
  return Buffer.concat([
    elf,
    Buffer.alloc(0x400 - elf.length),
    section,
    Buffer.alloc(0x800 - 0x400 - section.length),
    section,
  ]);
};

describe("readElfSymbol", () => {
  it("locates snapshot symbols in a synthetic ELF64 image", async () => {
    const image = imageWithSections();
    const isolateData = await readElfSymbol(image, "_kDartIsolateSnapshotData");
    if ("failure" in isolateData) throw new Error(isolateData.failure.reason);
    expect(isolateData.symbol.offset).toBe(0x800);
    expect(isolateData.symbol.size).toBe(52);
    const header = readSnapshotHeader(image, isolateData.symbol.offset);
    expect(header.magicValid).toBe(true);
    expect(header.kind).toBe(3);
  });

  it("refuses a non-ELF image instead of guessing", async () => {
    const result = await readElfSymbol(Buffer.from("not an elf at all"), "x");
    expect("failure" in result && result.failure.reason).toBe(
      "not an ELF image",
    );
  });

  it("refuses an unknown symbol", async () => {
    const result = await readElfSymbol(buildElf64Image([]), "_kDartAbsent");
    expect("failure" in result).toBe(true);
  });

  it("locates snapshot symbols in a section-stripped ET_DYN image", async () => {
    const image = strippedImageWithSections();
    const isolateData = await readElfSymbol(image, "_kDartIsolateSnapshotData");
    if ("failure" in isolateData) throw new Error(isolateData.failure.reason);
    expect(isolateData.symbol.offset).toBe(0x800);
    expect(isolateData.symbol.size).toBe(52);
    const header = readSnapshotHeader(image, isolateData.symbol.offset);
    expect(header.magicValid).toBe(true);
    expect(header.kind).toBe(3);
  });

  it("refuses a stripped image whose PT_DYNAMIC carries no symbols", async () => {
    // Drop the PT_DYNAMIC program header by leaving only PT_LOAD.
    const image = strippedImageWithSections();
    image.writeUInt16LE(1, 0x38); // e_phnum
    const result = await readElfSymbol(image, "_kDartVmSnapshotData");
    expect("failure" in result && result.failure.reason).toBe(
      "symbol _kDartVmSnapshotData is not in the dynamic symbol table",
    );
  });

  it("keeps refusing a stripped image that is not ET_DYN", async () => {
    const image = buildStrippedElf64Image([]);
    image.writeUInt16LE(1, 0x10); // ET_REL: the dynamic fallback must not apply
    const result = await readElfSymbol(image, "_kDartVmSnapshotData");
    expect("failure" in result && result.failure.reason).toBe(
      "ELF section header table is missing or out of bounds",
    );
  });

  it.each([false, true])(
    "ignores undefined entries with loadable values (stripped: %s)",
    async (stripped) => {
      const image = stripped
        ? strippedImageWithSections()
        : imageWithSections();
      const table = stripped
        ? Number(
            image.readBigUInt64LE(
              Number(image.readBigUInt64LE(64 + 56 + 8)) + 8,
            ),
          )
        : Number(
            image.readBigUInt64LE(
              Number(image.readBigUInt64LE(0x28)) + 64 + 0x18,
            ),
          );
      for (const sectionIndex of [
        0,
        0xfff2,
        0xffff,
        ...(stripped ? [] : [0x1234]),
      ]) {
        image.writeUInt16LE(sectionIndex, table + 6);
        expect(
          await readElfSymbol(image, "_kDartVmSnapshotData"),
        ).toHaveProperty("failure");
        expect(
          await readElfSymbol(image, "_kDartIsolateSnapshotData"),
        ).toMatchObject({ symbol: { offset: 0x800, size: 52 } });
      }
    },
  );
});

describe("ELF symbol-table ownership", () => {
  it.each([false, true])(
    "keeps a symbol terminator inside dynstr (stripped: %s)",
    async (stripped) => {
      const image = stripped
        ? strippedImageWithSections()
        : imageWithSections();
      const name = "_kDartVmSnapshotData";
      if (stripped) {
        const dynamic = Number(image.readBigUInt64LE(64 + 56 + 8));
        image.writeBigUInt64LE(BigInt(name.length + 1), dynamic + 2 * 16 + 8); // DT_STRSZ, leading NUL included.
      } else {
        const shoff = Number(image.readBigUInt64LE(0x28));
        image.writeBigUInt64LE(BigInt(name.length + 1), shoff + 2 * 64 + 0x20);
      }
      expect((await readElfSymbols(image, [name])).symbols).toEqual([]);
    },
  );

  it("uses DT_HASH's count when strings precede symbols instead of reading following payload", async () => {
    const image = strippedImageWithSections();
    const dynamic = Number(image.readBigUInt64LE(64 + 56 + 8));
    const symbols = Number(image.readBigUInt64LE(dynamic + 8));
    image.copy(image, 0x300, symbols, symbols + 48);
    image.writeBigUInt64LE(0x300n, dynamic + 8);
    const hash = Number(image.readBigUInt64LE(dynamic + 4 * 16 + 8));
    image.writeUInt32LE(1, hash + 4); // Only the VM entry belongs to dynsym.
    const result = await readElfSymbols(image, [
      "_kDartVmSnapshotData",
      "_kDartIsolateSnapshotData",
    ]);
    expect(result.symbols).toEqual([
      { name: "_kDartVmSnapshotData", offset: 0x400, size: 52 },
    ]);
    expect(result.failures).toContainEqual({
      reason:
        "symbol _kDartIsolateSnapshotData is not in the dynamic symbol table",
    });
    image.writeBigUInt64LE(0x60000001n, dynamic + 4 * 16); // No recognized count table.
    expect(
      (await readElfSymbols(image, ["_kDartVmSnapshotData"])).failures,
    ).toContainEqual({
      reason: "Stripped ELF has no DT_HASH or DT_GNU_HASH symbol count",
    });
  });

  it("bounds GNU hash chains and resolves both requested symbols in one inventory", async () => {
    const image = strippedImageWithSections();
    const dynamic = Number(image.readBigUInt64LE(64 + 56 + 8));
    const hash = Number(image.readBigUInt64LE(dynamic + 4 * 16 + 8));
    image.writeBigUInt64LE(0x6ffffef5n, dynamic + 4 * 16);
    image.fill(0, hash, hash + 32);
    image.writeUInt32LE(1, hash); // nbuckets
    image.writeUInt32LE(1, hash + 4); // symoffset
    image.writeUInt32LE(1, hash + 8); // bloom words
    image.writeUInt32LE(1, hash + 24); // bucket: last chain begins at symbol 1
    image.writeUInt32LE(1, hash + 28); // chain terminator; count is 2
    const names = ["_kDartVmSnapshotData", "_kDartIsolateSnapshotData"];
    expect(
      (await readElfSymbols(image, names)).symbols.map((symbol) => symbol.name),
    ).toEqual(names);
    image.writeUInt32LE(0xffffffff, hash + 24);
    expect((await readElfSymbols(image, names)).symbols).toEqual([]);
  });
});

describe("readSnapshotHeader", () => {
  it("reads a synthesized data header", async () => {
    const header = readSnapshotHeader(snapshotSection(GALLERY_HASH), 0);
    expect(header.magicValid).toBe(true);
    expect(header.kind).toBe(3);
  });

  it("reports nulls for sections without the data magic", async () => {
    const header = readSnapshotHeader(Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]), 0);
    expect(header).toEqual({
      magicValid: false,
      kind: null,
      headerLength: null,
      hash: null,
      complete: false,
    });
  });
});
