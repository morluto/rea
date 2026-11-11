import { expect, it, vi } from "vitest";
import {
  ElfPointerRelocationFailure,
  elfAbsoluteRelocationType,
  elfCopyRelocationType,
  elfRelocationWidth,
  readElfRelocationWritesSteps,
  readElfPointerValuesSteps,
  type ElfPointerWrite,
} from "./ElfPointerRelocations.js";

const EM_X86_64 = 62;

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
  expect(elfAbsoluteRelocationType(62)).toBe(1);
  expect(elfAbsoluteRelocationType(3)).toBe(1);
  expect(elfAbsoluteRelocationType(183)).toBe(257);
  expect(elfAbsoluteRelocationType(40)).toBe(2);
  expect(elfAbsoluteRelocationType(8)).toBeUndefined();
});

it("owns the COPY relocation type per machine and gives it no fixed width", () => {
  expect(elfCopyRelocationType(62)).toBe(5);
  expect(elfCopyRelocationType(3)).toBe(5);
  expect(elfCopyRelocationType(183)).toBe(1024);
  expect(elfCopyRelocationType(40)).toBe(20);
  expect(elfCopyRelocationType(8)).toBeUndefined();
  expect(elfRelocationWidth(62, 5)).toBeUndefined();
  expect(elfRelocationWidth(183, 1024)).toBeUndefined();
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
  }
  bytes.writeBigUInt64LE(symbolSize, 0x200 + 24 + 16);
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
  (wholeExtents: boolean) =>
  (
    bytes: Buffer,
    unsupported?: "record",
    machine = EM_X86_64,
    bits: 32 | 64 = 64,
  ) => {
    const writes: ElfPointerWrite[] = [];
    const steps = readElfRelocationWritesSteps(
      bytes,
      {
        bits,
        little: true,
        machine,
        dynamicSegments: [{ offset: 0n, size: 0x100n }],
        mappings: [{ address: 0n, offset: 0, size: bytes.length }],
        zeroFills: [],
      },
      { wholeExtents, ...(unsupported === undefined ? {} : { unsupported }) },
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
  expect(elfRelocationWidth(62, 36)).toBe(16);
  expect(elfRelocationWidth(183, 1031)).toBe(16);
  expect(elfRelocationWidth(40, 13)).toBe(8);
  expect(elfRelocationWidth(3, 41)).toBe(8);
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
