import { expect, it, vi } from "vitest";
import type { FileMapping } from "../virtualFileMapping.js";
import {
  ElfPointerRelocationFailure,
  elfAbsoluteRelocationType,
  elfCopyRelocationType,
  elfRelocationWidth,
  readElfRelocationWritesSteps,
  readElfPointerValuesSteps,
  readElfPointerRelocationsSteps,
  type ElfPointerWrite,
} from "./elfPointerRelocations.js";

const EM_X86_64 = 62;

it("applies PT_DYNAMIC capacity only to backed whole entries", () => {
  const maximum = 16 * 1024 * 1024;
  const bytes = Buffer.alloc(maximum + 16);
  const read = (file: Buffer, size: bigint) => {
    const steps = readElfRelocationWritesSteps(file, {
      bits: 64,
      little: true,
      machine: EM_X86_64,
      dynamicSegments: [{ offset: 0n, size }],
      mappings: [],
      zeroFills: [],
    });
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value;
  };

  const malformed = expect.objectContaining({
    reason: "malformed-container",
    message: "PT_DYNAMIC is truncated or outside the file",
  });
  expect(() => read(bytes.subarray(0, 16), BigInt(bytes.length))).toThrow(
    malformed,
  );
  expect(() => read(bytes, BigInt(maximum + 1))).toThrow(malformed);
  expect(() => read(bytes, BigInt(bytes.length))).toThrow(
    expect.objectContaining({
      reason: "native-index-capacity",
      failure: expect.objectContaining({
        kind: "limit",
        limit: { name: "native-index-capacity", maximum },
      }),
      unit: "bytes",
    }),
  );
  expect(read(bytes, BigInt(maximum))).toMatchObject({
    dynamic_present: true,
    pointer_coverage_known: true,
  });
});

const image = (): Buffer => {
  const bytes = Buffer.alloc(0x400);
  const dynamic: [bigint, bigint][] = [
    [7n, 0x100n],
    [8n, 72n],
    [9n, 24n],
    [17n, 0x200n],
    [18n, 16n],
    [19n, 16n],
    [0n, 0n],
  ];
  dynamic.forEach(([tag, value], index) => {
    bytes.writeBigUInt64LE(tag, index * 16);
    bytes.writeBigUInt64LE(value, index * 16 + 8);
  });
  const rela: [bigint, bigint, bigint][] = [
    [0x300n, (0n << 32n) | 8n, 0x1234n],
    [0x308n, (2n << 32n) | 1n, 0x10n],
    [0x310n, (3n << 32n) | 6n, -8n],
  ];
  rela.forEach(([offset, info, addend], index) => {
    const at = 0x100 + index * 24;
    bytes.writeBigUInt64LE(offset, at);
    bytes.writeBigUInt64LE(info, at + 8);
    bytes.writeBigInt64LE(addend, at + 16);
  });
  bytes.writeBigUInt64LE(0x318n, 0x200);
  bytes.writeBigUInt64LE((5n << 32n) | 1n, 0x208);
  bytes.writeBigUInt64LE(0x40n, 0x318);
  return bytes;
};

const drain = (bytes: Buffer): ElfPointerWrite[] => {
  const writes: ElfPointerWrite[] = [];
  const steps = readElfRelocationWritesSteps(bytes, {
    bits: 64,
    little: true,
    machine: EM_X86_64,
    dynamicSegments: [{ offset: 0n, size: 112n }],
    mappings: [{ address: 0n, offset: 0, size: bytes.length }],
    zeroFills: [],
  });
  for (let next = steps.next(); !next.done; next = steps.next())
    if (next.value !== undefined) writes.push(next.value);
  return writes;
};

const relrImage = (tags: readonly (readonly [bigint, bigint])[]): Buffer => {
  const bytes = Buffer.alloc(0x400);
  tags.forEach(([tag, value], index) => {
    bytes.writeBigUInt64LE(tag, index * 16);
    bytes.writeBigUInt64LE(value, index * 16 + 8);
  });
  bytes.writeBigUInt64LE(0x300n, 0x100);
  bytes.writeBigUInt64LE(3n, 0x108);
  bytes.writeBigUInt64LE(0x1234n, 0x300);
  bytes.writeBigUInt64LE(0x5678n, 0x308);
  return bytes;
};

it("keeps the same RELR values and record provenance for Android's tag aliases", () => {
  const standard = relrImage([
    [36n, 0x100n],
    [35n, 16n],
    [37n, 8n],
  ]);
  const android = relrImage([
    [0x6fffe000n, 0x100n],
    [0x6fffe001n, 16n],
    [0x6fffe003n, 8n],
  ]);
  expect(drain(android)).toEqual(drain(standard));
  expect(
    drain(android).map(({ address, value, source }) => ({
      address,
      value,
      source,
    })),
  ).toEqual([
    {
      address: 0x300n,
      value: 0x1234n,
      source: { encoding: "relr", record_file_offset: 0x100, kind: null },
    },
    {
      address: 0x308n,
      value: 0x5678n,
      source: { encoding: "relr", record_file_offset: 0x108, kind: null },
    },
  ]);
});

it.each([
  { tags: [[0x6fffe001n, 8n]], caseName: "size without address" },
  { tags: [[0x6fffe000n, 0x100n]], caseName: "Android address without size" },
  { tags: [[36n, 0x100n]], caseName: "standard address without size" },
  {
    tags: [
      [0x6fffe000n, 0x100n],
      [0x6fffe001n, 7n],
    ],
    caseName: "invalid size",
  },
  {
    tags: [
      [0x6fffe000n, 0x100n],
      [0x6fffe001n, 16n],
      [0x6fffe003n, 4n],
    ],
    caseName: "invalid entry width",
  },
  {
    tags: [
      [0x6fffe000n, 0x100n],
      [0x6fffe000n, 0x100n],
    ],
    caseName: "duplicate Android address",
  },
  {
    tags: [
      [0x6fffe000n, 0x100n],
      [35n, 16n],
    ],
    caseName: "mixed Android address and standard size",
  },
  {
    tags: [
      [36n, 0x100n],
      [0x6fffe000n, 0x100n],
    ],
    caseName: "mixed standard and Android addresses",
  },
] as const)("refuses malformed RELR declarations: $caseName", ({ tags }) => {
  const parse = () => drain(relrImage(tags));
  expect(parse).toThrow(ElfPointerRelocationFailure);
  expect(parse).toThrow(
    expect.objectContaining({
      reason: "malformed-container",
      failure: expect.objectContaining({ kind: "malformed" }),
    }),
  );
});

it("accepts an explicitly empty Android RELR table", () => {
  expect(
    drain(
      relrImage([
        [0x6fffe000n, 0x100n],
        [0x6fffe001n, 0n],
      ]),
    ),
  ).toEqual([]);
});

it("returns the decoded record type, symbol index and addend with each write", () => {
  const writes = drain(image());
  expect(
    writes.map((write) => ({
      address: write.address,
      value: write.value,
      encoding: write.source.encoding,
      kind: write.source.kind,
      record_file_offset: write.source.record_file_offset,
      symbol_index: write.symbol_index,
      addend: write.addend,
    })),
  ).toEqual([
    {
      address: 0x300n,
      value: 0x1234n,
      encoding: "rela",
      kind: 8,
      record_file_offset: 0x100,
      symbol_index: 0,
      addend: 0x1234n,
    },
    {
      address: 0x308n,
      value: null,
      encoding: "rela",
      kind: 1,
      record_file_offset: 0x118,
      symbol_index: 2,
      addend: 0x10n,
    },
    {
      address: 0x310n,
      value: null,
      encoding: "rela",
      kind: 6,
      record_file_offset: 0x130,
      symbol_index: 3,
      addend: -8n,
    },
    {
      address: 0x318n,
      value: null,
      encoding: "rel",
      kind: 1,
      record_file_offset: 0x200,
      symbol_index: 5,
      addend: null,
    },
  ]);
});

it("owns the word-sized absolute relocation type per machine", () => {
  expect(elfAbsoluteRelocationType(62, 64)).toBe(1);
  expect(elfAbsoluteRelocationType(3, 32)).toBe(1);
  expect(elfAbsoluteRelocationType(183, 64)).toBe(257);
  expect(elfAbsoluteRelocationType(40, 32)).toBe(2);
  expect(elfAbsoluteRelocationType(8, 64)).toBeUndefined();
});

it("owns the COPY relocation type per machine and gives it no fixed width", () => {
  expect(elfCopyRelocationType(62, 64)).toBe(5);
  expect(elfCopyRelocationType(3, 32)).toBe(5);
  expect(elfCopyRelocationType(183, 64)).toBe(1024);
  expect(elfCopyRelocationType(40, 32)).toBe(20);
  expect(elfCopyRelocationType(8, 64)).toBeUndefined();
  expect(elfRelocationWidth(62, 5, 64)).toBeUndefined();
  expect(elfRelocationWidth(183, 1024, 64)).toBeUndefined();
});

/**
 * `records` RELA records at `destination` against dynamic symbol
 * `symbolIndex` (1 unless given). Symbol 1 records `symbolSize` as its
 * `st_size`, and `symbolTags` declares where the loader finds it.
 */
const symbolicImage = (
  kind: bigint,
  symbolSize: bigint,
  layout: {
    readonly symbolTags?: readonly [bigint, bigint][];
    readonly destination?: bigint;
    readonly records?: number;
    readonly symbolIndex?: number;
    readonly definition?: {
      readonly value: bigint;
      readonly type?: number;
      readonly section?: number;
    };
    readonly addend?: bigint;
    readonly hash?: "sysv" | "gnu" | "none";
  } = {},
): Buffer => {
  const records = layout.records ?? 1;
  const bytes = Buffer.alloc(0x400);
  const dynamic: [bigint, bigint][] = [
    [7n, 0x100n],
    [8n, BigInt(24 * records)],
    [9n, 24n],
    ...(layout.symbolTags ?? [
      [6n, 0x200n],
      [11n, 24n],
      ...(layout.definition === undefined || layout.hash === "none"
        ? []
        : [
            [layout.hash === "gnu" ? 0x6ffffef5n : 4n, 0x280n] as [
              bigint,
              bigint,
            ],
          ]),
    ]),
    [0n, 0n],
  ];
  dynamic.forEach(([tag, value], index) => {
    bytes.writeBigUInt64LE(tag, index * 16);
    bytes.writeBigUInt64LE(value, index * 16 + 8);
  });
  for (let record = 0; record < records; record += 1) {
    bytes.writeBigUInt64LE(layout.destination ?? 0x300n, 0x100 + record * 24);
    bytes.writeBigUInt64LE(
      (BigInt(layout.symbolIndex ?? 1) << 32n) | kind,
      0x108 + record * 24,
    );
    bytes.writeBigInt64LE(layout.addend ?? 0n, 0x110 + record * 24);
  }
  bytes.writeBigUInt64LE(symbolSize, 0x200 + 24 + 16);
  if (layout.definition !== undefined) {
    bytes[0x200 + 24 + 4] = 0x10 | (layout.definition.type ?? 1);
    bytes.writeUInt16LE(layout.definition.section ?? 1, 0x200 + 24 + 6);
    bytes.writeBigUInt64LE(layout.definition.value, 0x200 + 24 + 8);
    const words =
      layout.hash === "gnu" ? [1, 1, 1, 0, 0, 0, 1, 1] : [1, 2, 1, 0, 0];
    words.forEach((value, index) =>
      bytes.writeUInt32LE(value, 0x280 + index * 4),
    );
  }
  return bytes;
};

/** The ELF32 REL form of {@link symbolicImage}: 8-byte records, 16-byte symbols. */
const symbolicImage32 = (kind: number, symbolSize: number): Buffer => {
  const bytes = Buffer.alloc(0x400);
  const dynamic = [
    [17, 0x100],
    [18, 8],
    [19, 8],
    [6, 0x200],
    [11, 16],
    [0, 0],
  ] as const;
  dynamic.forEach(([tag, value], index) => {
    bytes.writeInt32LE(tag, index * 8);
    bytes.writeUInt32LE(value, index * 8 + 4);
  });
  bytes.writeUInt32LE(0x300, 0x100);
  bytes.writeUInt32LE((1 << 8) | kind, 0x104);
  bytes.writeUInt32LE(symbolSize, 0x200 + 16 + 8);
  return bytes;
};

const walker =
  (wholeExtents: boolean, mappings?: readonly FileMapping[]) =>
  (
    bytes: Buffer,
    unsupported?: "record",
    machine = EM_X86_64,
    bits: 32 | 64 = 64,
    imageDefinitions = false,
  ) => {
    const writes: ElfPointerWrite[] = [];
    const steps = readElfRelocationWritesSteps(
      bytes,
      {
        bits,
        little: true,
        machine,
        dynamicSegments: [{ offset: 0n, size: 0x100n }],
        mappings: mappings ?? [{ address: 0n, offset: 0, size: bytes.length }],
        zeroFills: [],
      },
      {
        wholeExtents,
        ...(unsupported === undefined ? {} : { unsupported }),
        ...(imageDefinitions
          ? { symbolResolution: "image-definitions" as const }
          : {}),
      },
    );
    let next = steps.next();
    for (; !next.done; next = steps.next())
      if (next.value !== undefined) writes.push(next.value);
    return { writes, result: next.value };
  };
/** A consumer that asked for whole COPY and TLS descriptor extents. */
const walk = walker(true);
/** A consumer that tracks one pointer per write. */
const walkPointers = walker(false);

it.each([
  ["AArch64 ABS64", 183, 257, 0x4020n],
  ["AArch64 GLOB_DAT", 183, 1025, 0x4020n],
  ["AArch64 JUMP_SLOT", 183, 1026, 0x4020n],
  ["x86-64 absolute", 62, 1, 0x4020n],
  ["x86-64 GLOB_DAT", 62, 6, 0x4000n],
  ["x86-64 JUMP_SLOT", 62, 7, 0x4000n],
  ["RISC-V RV64 absolute", 243, 2, 0x4020n],
] as const)(
  "derives %s from image definitions only when requested",
  (_name, machine, kind, expected) => {
    const bytes = symbolicImage(BigInt(kind), 0n, {
      definition: { value: 0x4000n },
      addend: 0x20n,
    });
    expect(walk(bytes, undefined, machine).writes[0]?.value).toBeNull();
    const { writes, result } = walk(bytes, undefined, machine, 64, true);
    expect(writes[0]).toMatchObject({
      value: expected,
      symbol_index: 1,
      addend: 0x20n,
    });
    expect(result.pointer_coverage_known).toBe(true);
  },
);

it.each(["sysv", "gnu"] as const)(
  "bounds image definitions with the %s hash table",
  (hash) => {
    const bytes = symbolicImage(1025n, 0n, {
      definition: { value: 0x4000n },
      hash,
    });
    expect(walk(bytes, undefined, 183, 64, true).writes[0]?.value).toBe(
      0x4000n,
    );
    // A mapped, plausible record beyond the declared table is not another symbol.
    bytes.writeUInt16LE(1, 0x200 + 48 + 6);
    bytes.writeBigUInt64LE(0x5000n, 0x200 + 48 + 8);
    bytes.writeBigUInt64LE((2n << 32n) | 1025n, 0x108);
    expect(walk(bytes, undefined, 183, 64, true).writes[0]?.value).toBeNull();
  },
);

it.each([
  [183, 257],
  [62, 1],
] as const)(
  "reads a 64-bit REL in-place addend for machine %d",
  (machine, kind) => {
    const bytes = symbolicImage(BigInt(kind), 0n, {
      definition: { value: 0x4000n },
    });
    for (const [at, tag, value] of [
      [0, 17n, 0x100n],
      [16, 18n, 16n],
      [32, 19n, 16n],
    ] as const) {
      bytes.writeBigUInt64LE(tag, at);
      bytes.writeBigUInt64LE(value, at + 8);
    }
    bytes.writeBigUInt64LE(0x20n, 0x300);
    expect(walk(bytes, undefined, machine, 64, true).writes[0]).toMatchObject({
      value: 0x4020n,
      addend: null,
      source: { encoding: "rel" },
    });
  },
);

it.each([
  ["undefined", 0, 1],
  ["absolute section", 0xfff1, 1],
  ["common", 0xfff2, 1],
  ["TLS", 1, 6],
  ["IFUNC", 1, 10],
] as const)("keeps %s symbol addresses unknown", (_name, section, type) => {
  const bytes = symbolicImage(1025n, 0n, {
    definition: { value: 0x4000n, section, type },
  });
  expect(walk(bytes, undefined, 183, 64, true).writes[0]?.value).toBeNull();
});

it.each([
  ["AArch64 ABS64", 183, 257, false],
  ["AArch64 GLOB_DAT", 183, 1025, false],
  ["AArch64 JUMP_SLOT", 183, 1026, false],
  ["x86-64 absolute", 62, 1, false],
  ["x86-64 GLOB_DAT", 62, 6, true],
  ["x86-64 JUMP_SLOT", 62, 7, true],
] as const)(
  "marks %s binding a valueless undefined symbol as imported",
  (_name, machine, kind, ignoresAddend) => {
    const imported = (value: bigint, addend: bigint, imageDefinitions = true) =>
      walk(
        symbolicImage(BigInt(kind), 0n, {
          definition: { value, section: 0 },
          addend,
        }),
        undefined,
        machine,
        64,
        imageDefinitions,
      ).writes[0];
    expect(imported(0n, 0n)).toMatchObject({ value: null, imported: true });
    // A loader can accept an executable's canonical PLT address for non-PLT
    // lookups, and an addend can reach any address from the binding.
    expect(imported(0x4000n, 0n)).toMatchObject({
      value: null,
      imported: false,
    });
    expect(imported(0n, 0x20n)).toMatchObject({
      value: null,
      imported: ignoresAddend,
    });
    expect(imported(0n, 0n, false)).toMatchObject({
      value: null,
      imported: false,
    });
  },
);

it("reports an imported word only while no other write shares it", () => {
  const values = (bytes: Buffer) => {
    const steps = readElfPointerValuesSteps(
      bytes,
      {
        bits: 64,
        little: true,
        machine: 183,
        dynamicSegments: [{ offset: 0n, size: 0x100n }],
        mappings: [{ address: 0n, offset: 0, size: bytes.length }],
        zeroFills: [],
      },
      1 << 20,
      { symbolResolution: "image-definitions" },
    );
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value;
  };
  const layout = { definition: { value: 0n, section: 0 }, records: 2 };
  const imported = values(symbolicImage(1026n, 0n, layout));
  expect(imported.importedAt(0x300n)).toBe(true);
  expect(imported.unsignedAt(0x300n, 8)).toBeUndefined();
  expect(imported.importedAt(0x308n)).toBe(false);
  // A second record at the same word, here RELATIVE, can bind this image.
  const shared = symbolicImage(1026n, 0n, layout);
  shared.writeBigUInt64LE(1027n, 0x120);
  shared.writeBigInt64LE(0x1234n, 0x128);
  expect(values(shared).importedAt(0x300n)).toBe(false);
  const overlapped = symbolicImage(1026n, 0n, layout);
  overlapped.writeBigUInt64LE(0x304n, 0x118);
  expect(values(overlapped).importedAt(0x300n)).toBe(false);
});

it("keeps an unbounded symbol table unknown without losing RELATIVE facts", () => {
  const bytes = symbolicImage(1025n, 0n, {
    definition: { value: 0x4000n },
    hash: "none",
    records: 2,
  });
  bytes.writeBigUInt64LE(1027n, 0x120);
  bytes.writeBigInt64LE(0x1234n, 0x128);
  expect(
    walk(bytes, undefined, 183, 64, true).writes.map(({ value }) => value),
  ).toEqual([null, 0x1234n]);
});

it.each(["unmapped hash", "truncated symbols", "conflicting hashes"] as const)(
  "keeps image definitions unknown for %s",
  (failure) => {
    const bytes = symbolicImage(1025n, 0n, {
      definition: { value: 0x4000n },
    });
    if (failure === "unmapped hash") {
      bytes.writeBigUInt64LE(0x400n, 5 * 16 + 8);
    } else if (failure === "truncated symbols") {
      bytes.writeUInt32LE(32, 0x280 + 4);
    } else {
      bytes.writeBigUInt64LE(0x6ffffef5n, 6 * 16);
      bytes.writeBigUInt64LE(0x2b0n, 6 * 16 + 8);
      [1, 1, 1, 0, 0, 0, 2, 0, 1].forEach((value, index) =>
        bytes.writeUInt32LE(value, 0x2b0 + index * 4),
      );
    }
    expect(walk(bytes, undefined, 183, 64, true).writes[0]?.value).toBeNull();
  },
);

it.each([4n, 0x6ffffef5n])(
  "preserves ambiguity of redeclared hash tag %s despite another hash count",
  (redeclared) => {
    const bytes = symbolicImage(1025n, 0n, {
      definition: { value: 0x4000n },
      records: 2,
      symbolTags: [
        [6n, 0x200n],
        [11n, 24n],
        [4n, 0x280n],
        [0x6ffffef5n, 0x2b0n],
        [redeclared, redeclared === 4n ? 0x280n : 0x2b0n],
      ],
    });
    // The classic table declares two symbols, the GNU table three.
    [1, 1, 1, 0, 0, 0, 2, 0, 1].forEach((value, index) =>
      bytes.writeUInt32LE(value, 0x2b0 + index * 4),
    );
    bytes.writeBigUInt64LE(1027n, 0x120);
    bytes.writeBigInt64LE(0x1234n, 0x128);
    expect(
      walk(bytes, undefined, 183, 64, true).writes.map(({ value }) => value),
    ).toEqual([null, 0x1234n]);
  },
);

it("requires the full hash table mapping including skipped words", () => {
  const bytes = symbolicImage(1025n, 0n, {
    definition: { value: 0x4000n },
  });
  const acrossGap = walker(true, [
    { address: 0n, offset: 0, size: 0x288 },
    { address: 0x28cn, offset: 0x28c, size: bytes.length - 0x28c },
  ]);
  expect(
    acrossGap(bytes, undefined, 183, 64, true).writes[0]?.value,
  ).toBeNull();
});

it.each([
  ["an x86-64 COPY", symbolicImage(5n, 8n), [62, 64, 5]],
  ["an x86-64 TLS descriptor", symbolicImage(36n, 0n), [62, 64, 36]],
  ["an AArch64 TLS descriptor", symbolicImage(1031n, 0n), [183, 64, 1031]],
  ["an i386 TLS descriptor", symbolicImage32(41, 0), [3, 32, 41]],
  ["an ARM TLS descriptor", symbolicImage32(13, 0), [40, 32, 13]],
] as const)(
  "leaves %s undecoded for a consumer that did not ask for whole extents",
  (_name, bytes, [machine, bits, kind]) => {
    const { writes, result } = walkPointers(bytes, "record", machine, bits);
    expect(writes).toEqual([]);
    expect(result).toMatchObject({
      issues: [`ELF relocation kind ${String(kind)} is not decoded`],
      pointer_coverage_known: false,
    });
    expect(() => walkPointers(bytes, undefined, machine, bits)).toThrow(
      ElfPointerRelocationFailure,
    );
  },
);

it.each([
  ["x86-64", 62, 64, 5],
  ["AArch64", 183, 64, 1024],
  ["i386", 3, 32, 5],
  ["ARM", 40, 32, 20],
  ["RISC-V RV32", 243, 32, 4],
  ["RISC-V RV64", 243, 64, 4],
] as const)(
  "sizes a %s COPY write from the image's own dynamic symbol",
  (_name, machine, bits, kind) => {
    const { writes, result } = walk(
      bits === 64
        ? symbolicImage(BigInt(kind), 0x28n)
        : symbolicImage32(kind, 0x28),
      undefined,
      machine,
      bits,
    );
    expect(writes).toMatchObject([
      {
        address: 0x300n,
        width: 0x28,
        value: null,
        source: { encoding: bits === 64 ? "rela" : "rel", kind },
        symbol_index: 1,
      },
    ]);
    expect(result).toMatchObject({ issues: [], pointer_coverage_known: true });
  },
);

it("writes nothing for a COPY of a zero-size symbol", () => {
  const { writes, result } = walk(symbolicImage(5n, 0n));
  expect(writes).toEqual([]);
  expect(result.pointer_coverage_known).toBe(true);
});

it.each([
  ["no DT_SYMTAB", symbolicImage(5n, 8n, { symbolTags: [[11n, 24n]] })],
  [
    "a nonstandard DT_SYMENT",
    symbolicImage(5n, 8n, {
      symbolTags: [
        [6n, 0x200n],
        [11n, 16n],
      ],
    }),
  ],
  [
    "a redeclared DT_SYMTAB",
    symbolicImage(5n, 8n, {
      symbolTags: [
        [6n, 0x200n],
        [6n, 0x200n],
        [11n, 24n],
      ],
    }),
  ],
  [
    "an unmapped symbol",
    symbolicImage(5n, 8n, {
      symbolTags: [
        [6n, 0x10000n],
        [11n, 24n],
      ],
    }),
  ],
  ["symbol index 0", symbolicImage(5n, 8n, { symbolIndex: 0 })],
  [
    "a span past the address space",
    symbolicImage(5n, 0x10n, { destination: 0xffff_ffff_ffff_fff8n }),
  ],
])("leaves coverage unknown for a COPY with %s", (_reason, bytes) => {
  const { writes, result } = walk(bytes, "record");
  expect(writes).toEqual([]);
  expect(result).toMatchObject({
    issues: ["ELF COPY relocation write size is not established"],
    pointer_coverage_known: false,
  });
  expect(() => walk(bytes)).toThrow(ElfPointerRelocationFailure);
});

it("stops sizing COPY writes once they cover more than the file byte count", () => {
  // Two COPY records of a 0x300-byte symbol in a 0x400-byte file.
  const bytes = symbolicImage(5n, 0x300n, { destination: 0x80n, records: 2 });
  const { writes, result } = walk(bytes, "record");
  expect(writes).toMatchObject([{ address: 0x80n, width: 0x300 }]);
  expect(result).toMatchObject({
    issues: ["ELF COPY relocation sizes exceed the file byte count allowance"],
    pointer_coverage_known: false,
  });
  expect(() => walk(bytes)).toThrow(ElfPointerRelocationFailure);
});

it("reports a TLS descriptor as a two-word write", () => {
  const { writes, result } = walk(symbolicImage(36n, 0n));
  expect(writes).toMatchObject([{ address: 0x300n, width: 16, value: null }]);
  expect(result.pointer_coverage_known).toBe(true);
  expect(elfRelocationWidth(62, 36, 64)).toBe(16);
  expect(elfRelocationWidth(183, 1031, 64)).toBe(16);
  expect(elfRelocationWidth(40, 13, 32)).toBe(8);
  expect(elfRelocationWidth(3, 41, 32)).toBe(8);
});

it("reports a sized link-time kind in a dynamic table as a write of unknown value", () => {
  // R_X86_64_PLT32, as a text relocation would carry it.
  const { writes, result } = walk(symbolicImage(4n, 0n));
  expect(writes).toMatchObject([{ address: 0x300n, width: 4, value: null }]);
  expect(result.pointer_coverage_known).toBe(true);
});

it("sizes the link-time kinds compilers emit into x86-64 and AArch64 objects", () => {
  // Kind numbers and names were paired from clang output with llvm-objdump.
  for (const kind of [4, 9, 19, 20, 21, 22, 23, 34, 41, 42])
    expect(elfRelocationWidth(62, kind, 64)).toBe(4);
  for (const kind of [25, 27, 29])
    expect(elfRelocationWidth(62, kind, 64)).toBe(8);
  // Each of these patches one 32-bit A64 instruction.
  for (const kind of [
    273, 274, 275, 277, 278, 282, 283, 284, 285, 286, 299, 309, 311, 312, 541,
    542, 543, 549, 551, 562, 563, 564,
  ])
    expect(elfRelocationWidth(183, kind, 64)).toBe(4);
  // TLSDESC_CALL marks an instruction and has no field of its own.
  expect(elfRelocationWidth(62, 35, 64)).toBeUndefined();
  expect(elfRelocationWidth(183, 569, 64)).toBeUndefined();
  // A kind outside the table keeps no width.
  expect(elfRelocationWidth(62, 99, 64)).toBeUndefined();
});

/** Three fully decoded relative values; empty REL declarations add no state. */
const relativeValues = (duplicate = false): Buffer => {
  const bytes = image();
  bytes.writeBigUInt64LE(0n, 4 * 16 + 8);
  for (let i = 0; i < 3; i++) {
    const at = 0x100 + i * 24;
    bytes.writeBigUInt64LE(duplicate ? 0x300n : 0x300n + BigInt(i * 8), at);
    bytes.writeBigUInt64LE(8n, at + 8);
    bytes.writeBigUInt64LE(
      duplicate ? 0x1234n : 0x1234n + BigInt(i * 0x100),
      at + 16,
    );
  }
  return bytes;
};

const pointerValues = (bytes: Buffer, maximumIndexBytes: number) => {
  const steps = readElfPointerValuesSteps(
    bytes,
    {
      bits: 64,
      little: true,
      machine: EM_X86_64,
      dynamicSegments: [{ offset: 0n, size: 112n }],
      mappings: [{ address: 0n, offset: 0, size: bytes.length }],
      zeroFills: [],
    },
    maximumIndexBytes,
  );
  let next = steps.next();
  while (!next.done) next = steps.next();
  return next.value;
};

it("admits fitting pointer workspace and preserves its complete values", () => {
  const facts = pointerValues(relativeValues(), 6144);
  expect(
    [0x300n, 0x308n, 0x310n].map((address) => facts.unsignedAt(address, 8)),
  ).toEqual([0x1234n, 0x1334n, 0x1434n]);
});

it("charges repeated virtual destinations once within the pointer workspace", () => {
  const facts = pointerValues(relativeValues(true), 2048);
  expect(facts.unsignedAt(0x300n, 8)).toBe(0x1234n);
});

it("refuses pointer workspace growth before inserting the next virtual destination", () => {
  const inserted = vi.spyOn(Map.prototype, "set");
  try {
    expect(() => pointerValues(relativeValues(), 4096)).toThrow(
      expect.objectContaining({
        reason: "native-index-capacity",
        failure: expect.objectContaining({
          kind: "limit",
          format: "elf-pointer-relocations",
          limit: { name: "native-index-capacity", maximum: 4096 },
        }),
        unit: "bytes",
        message: expect.stringContaining("4096 estimated representation bytes"),
      }),
    );
    expect(inserted.mock.calls.some(([address]) => address === 0x310n)).toBe(
      false,
    );
  } finally {
    inserted.mockRestore();
  }
});

/** ELF32 RELA with an ordinary defined symbol and a SysV hash bound. */
const riscvSymbolicImage32 = (kind: number, symbol = 1): Buffer => {
  const bytes = symbolicImage32(kind, 0x28);
  bytes.writeInt32LE(7, 0); // RELA instead of REL.
  bytes.writeInt32LE(8, 8);
  bytes.writeUInt32LE(12, 12);
  bytes.writeInt32LE(9, 16);
  bytes.writeUInt32LE(12, 20);
  bytes.writeUInt32LE((symbol << 8) | kind, 0x104);
  bytes.writeInt32LE(-16, 0x108);
  bytes.writeUInt32LE(0x4000, 0x214);
  bytes[0x21c] = 0x11;
  bytes.writeUInt16LE(1, 0x21e);
  bytes.writeInt32LE(4, 40);
  bytes.writeUInt32LE(0x280, 44);
  [1, 2, 1, 0, 0].forEach((value, index) =>
    bytes.writeUInt32LE(value, 0x280 + index * 4),
  );
  return bytes;
};

it.each([32, 64] as const)(
  "keeps RV%s symbol, TLS, resolver and COPY semantics separate",
  (bits) => {
    const make = (kind: number, symbol = 1) =>
      bits === 32
        ? riscvSymbolicImage32(kind, symbol)
        : symbolicImage(BigInt(kind), 0x28n, {
            definition: { value: 0x4000n },
            addend: -16n,
            symbolIndex: symbol,
          });
    const absolute = bits === 32 ? 1 : 2;
    expect(elfAbsoluteRelocationType(243, bits)).toBe(absolute);
    expect(elfCopyRelocationType(243, bits)).toBe(4);
    expect(elfRelocationWidth(243, 12, bits)).toBe(bits / 4);
    expect(
      walk(make(absolute), undefined, 243, bits).writes[0]?.value,
    ).toBeNull();
    expect(
      walk(make(absolute), undefined, 243, bits, true).writes[0]?.value,
    ).toBe(0x3ff0n);
    // Type 6 must never inherit x86 GLOB_DAT semantics, even for a defined
    // symbol, and JUMP_SLOT (5) is not derived from image definitions.
    for (const [kind, width] of [
      [5, bits / 8],
      [6, 4],
      [12, bits / 4],
      [58, bits / 8],
    ]) {
      const { writes, result } = walk(make(kind!), undefined, 243, bits, true);
      expect(writes[0]).toMatchObject({ value: null, width });
      expect(result.pointer_coverage_known).toBe(true);
    }
    const relative = walk(make(3, 0), undefined, 243, bits);
    expect(relative.writes[0]?.value).toBe(BigInt.asUintN(bits, -16n));
    const input = {
      bits,
      little: true,
      machine: 243,
      dynamicSegments: [{ offset: 0n, size: 0x100n }],
      mappings: [{ address: 0n, offset: 0, size: 0x400 }],
      zeroFills: [],
    };
    const sparse = readElfPointerRelocationsSteps(make(3, 0), input);
    let sparseNext = sparse.next();
    while (!sparseNext.done) sparseNext = sparse.next();
    expect(sparseNext.value.pointerAt(0x300n)).toMatchObject({
      value: BigInt.asUintN(bits, -16n),
      relocation: { encoding: "rela", kind: 3, record_file_offset: 0x100 },
    });
    const values = readElfPointerValuesSteps(
      make(absolute),
      input,
      1024 * 1024,
      {
        symbolResolution: "image-definitions",
      },
    );
    let valuesNext = values.next();
    while (!valuesNext.done) valuesNext = values.next();
    expect(valuesNext.value.unsignedAt(0x300n, bits === 64 ? 8 : 4)).toBe(
      0x3ff0n,
    );
    const unknown = walk(make(0x7f), "record", 243, bits, true);
    expect(unknown.result.pointer_coverage_known).toBe(false);
    expect(unknown.writes).toEqual([]);
  },
);

it("does not apply a machine's pointer rules to a different ELF class", () => {
  expect(elfAbsoluteRelocationType(183, 32)).toBeUndefined();
  expect(elfAbsoluteRelocationType(40, 64)).toBeUndefined();
});
