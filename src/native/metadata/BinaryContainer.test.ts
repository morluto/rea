import type {
  FileMapping,
  ZeroFillMapping,
} from "../../domain/virtualFileMapping.js";
import { readBinaryContainer } from "../../domain/native/readBinaryContainer.js";
import {
  CPU,
  fatImage,
  machoImage,
} from "../../artifacts/apple/MachoImage.fixture.js";
import { expect, it } from "vitest";
import {
  BinaryFormatFailure,
  BinaryMappingFailure,
  BinaryReader,
  isBinaryStringReadLimit,
  createFileMappingIndex,
  mappedFileOffset,
  readMappedCString,
} from "../../domain/binaryContainer.js";

it("preserves representable offsets for invalid file ranges", () => {
  const reader = new BinaryReader(Buffer.alloc(120), true, "elf");
  for (const read of [
    () => reader.range(128, 1, "segment"),
    () => reader.fileRange(128n, 1n, "segment"),
  ]) {
    try {
      read();
      throw new Error("Expected malformed range");
    } catch (error) {
      expect(error).toBeInstanceOf(BinaryFormatFailure);
      expect(error).toMatchObject({
        failure: { kind: "malformed", offset: 128, field: "segment" },
      });
    }
  }
  expect(() => reader.fileRange(2n ** 60n, 1n, "segment")).toThrow(
    BinaryFormatFailure,
  );
});

it("decodes signed and floating fields in both byte orders", () => {
  const bytes = Buffer.alloc(18);
  bytes.writeInt16LE(-2, 0);
  bytes.writeInt32LE(-3, 2);
  bytes.writeFloatLE(1.5, 6);
  bytes.writeBigInt64LE(-4n, 10);
  const little = new BinaryReader(bytes, true, "zip");
  expect([little.u8(0), little.i8(0), little.i16(0), little.i32(2)]).toEqual([
    0xfe, -2, -2, -3,
  ]);
  expect([little.f32(6), little.i64(10)]).toEqual([1.5, -4n]);
  bytes.writeDoubleBE(-0.25, 0);
  const big = new BinaryReader(bytes, false, "zip");
  expect([big.f64(0), big.i16(0), big.i32(0)]).toEqual([
    -0.25,
    bytes.readInt16BE(0),
    bytes.readInt32BE(0),
  ]);
  expect(() => little.i64(11)).toThrow(BinaryFormatFailure);
  expect(() => big.f32(15)).toThrow(BinaryFormatFailure);
});

it("decodes numeric fields at nonzero buffer offsets and preserves malformed and truncated range failures", () => {
  const backing = Buffer.from([
    0xff, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0xfe,
  ]);
  const window = backing.subarray(1, 9);
  const little = new BinaryReader(window, true, "zip");
  const big = new BinaryReader(window, false, "zip");

  expect(little.u16(2)).toBe(0x0403);
  expect(big.u16(2)).toBe(0x0304);
  expect(little.u32(2)).toBe(0x06050403);
  expect(big.u32(2)).toBe(0x03040506);
  expect(little.word(2, 32)).toBe(0x06050403n);
  expect(big.word(2, 32)).toBe(0x03040506n);
  expect(little.word(0, 64)).toBe(0x0807060504030201n);
  expect(big.word(0, 64)).toBe(0x0102030405060708n);

  const captureFailure = (read: () => unknown): BinaryFormatFailure => {
    try {
      read();
      throw new Error("Expected BinaryFormatFailure");
    } catch (error) {
      expect(error).toBeInstanceOf(BinaryFormatFailure);
      return error as BinaryFormatFailure;
    }
  };

  const malformed = captureFailure(() => little.u32(9));
  expect(malformed.kind).toBe("malformed");
  expect(malformed.message).toBe(
    "32-bit field range is truncated or outside the file",
  );
  expect(malformed.failure).toEqual({
    kind: "malformed",
    format: "zip",
    detail: "32-bit field range is truncated or outside the file",
    field: "32-bit field",
    offset: 9,
  });

  expect(captureFailure(() => little.u16(-1)).failure).toEqual({
    kind: "malformed",
    format: "zip",
    detail: "16-bit field range is truncated or outside the file",
    field: "16-bit field",
    offset: -1,
  });
  expect(captureFailure(() => little.u16(Number.NaN)).failure).toEqual({
    kind: "malformed",
    format: "zip",
    detail: "16-bit field range is truncated or outside the file",
    field: "16-bit field",
  });
  expect(captureFailure(() => little.range(0, -1, "span")).kind).toBe(
    "malformed",
  );
  expect(captureFailure(() => little.range(0, 1.5, "span")).kind).toBe(
    "malformed",
  );

  const truncated = captureFailure(() => little.u32(6));
  expect(truncated.kind).toBe("truncated");
  expect(truncated.message).toBe(
    "32-bit field range is truncated or outside the file",
  );
  expect(truncated.failure).toEqual({
    kind: "truncated",
    format: "zip",
    detail: "32-bit field range is truncated or outside the file",
    field: "32-bit field",
    offset: 6,
  });
  expect(captureFailure(() => little.u16(7)).failure).toEqual({
    kind: "truncated",
    format: "zip",
    detail: "16-bit field range is truncated or outside the file",
    field: "16-bit field",
    offset: 7,
  });
  expect(captureFailure(() => little.word(1, 64)).failure).toEqual({
    kind: "truncated",
    format: "zip",
    detail: "64-bit field range is truncated or outside the file",
    field: "64-bit field",
    offset: 1,
  });
});

it("distinguishes a mapped string read allowance from malformed bytes", () => {
  const bytes = Buffer.from("long-name\0");
  const index = createFileMappingIndex([
    { address: 100n, offset: 0, size: bytes.length },
  ]);
  let failure: unknown;
  try {
    index.readCString(bytes, 100n, 3);
  } catch (cause) {
    failure = cause;
  }
  expect(isBinaryStringReadLimit(failure)).toBe(true);
  expect(failure).toMatchObject({
    failure: { kind: "limit", limit: { maximum: 3 } },
  });
  expect(index.readCString(bytes, 100n, bytes.length).toString()).toBe(
    "long-name",
  );
});

const outcome = (translate: () => number): number | string => {
  try {
    return translate();
  } catch (cause) {
    if (cause instanceof BinaryMappingFailure) return cause.reason;
    if (cause instanceof BinaryFormatFailure) return cause.message;
    throw cause;
  }
};

/** Deterministic xorshift so failures replay exactly. */
const random = (seed: number) => {
  let state = seed;
  return (limit: number): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % limit;
  };
};

it("indexes exactly the spans mappedFileOffset accepts, rejects and translates", () => {
  const next = random(0x5eed);
  const seen = new Set<string>();
  for (let round = 0; round < 150; round++) {
    const mappings: FileMapping[] = Array.from({ length: 1 + next(6) }, () => ({
      address: 0x1000n + BigInt(next(96)),
      offset: next(4) === 0 ? 0x400 : next(256),
      size: next(48),
    }));
    // Some rounds alias one mapping at the same translation to cover consistent overlap.
    if (next(3) === 0 && mappings[0] !== undefined)
      mappings.push({
        address: mappings[0].address + 4n,
        offset: mappings[0].offset + 4,
        size: Math.max(0, mappings[0].size - 4),
      });
    const zeroFills: ZeroFillMapping[] = Array.from(
      { length: next(3) },
      () => ({
        address: 0x1000n + BigInt(next(160)),
        size: BigInt(next(16)),
      }),
    );
    const lookup = createFileMappingIndex(mappings, zeroFills).offset;
    const indexed: (number | string)[] = [];
    const scanned: (number | string)[] = [];
    for (let address = 0xff8n; address < 0x10a8n; address++) {
      for (const size of [1, 2, 4, 9, 20]) {
        indexed.push(outcome(() => lookup(address, size)));
        scanned.push(
          outcome(() => mappedFileOffset(mappings, address, size, zeroFills)),
        );
      }
    }
    expect(indexed, `round ${String(round)}`).toEqual(scanned);
    for (const value of scanned)
      seen.add(typeof value === "number" ? "translated" : value);
  }
  expect([...seen].sort()).toEqual(["ambiguous", "translated", "unmapped"]);
});

it("maps adjacent ranges sharing one file translation", () => {
  const lookup = createFileMappingIndex([
    { address: 0x1000n, offset: 0x400, size: 0x10 },
    { address: 0x1010n, offset: 0x410, size: 0x10 },
  ]).offset;
  expect(lookup(0x1008n, 8)).toBe(0x408);
  expect(lookup(0x100cn, 8)).toBe(0x40c);
});

it("rejects partially overlapping mappings with different file translations", () => {
  const lookup = createFileMappingIndex([
    { address: 0x1000n, offset: 0x400, size: 0x20 },
    { address: 0x1018n, offset: 0x900, size: 0x10 },
  ]).offset;
  expect(lookup(0x1000n, 0x10)).toBe(0x400);
  expect(() => lookup(0x1010n, 0x10)).toThrow(/ambiguous/u);
});

const mappings = [
  { address: 100n, offset: 0, size: 4 },
  { address: 104n, offset: 4, size: 4 },
];
it("maps a span crossing adjacent ranges with one consistent file translation", () => {
  expect(mappedFileOffset(mappings, 102n, 4)).toBe(2);
  expect(mappedFileOffset(mappings, 108n, 0)).toBe(8);
});
it.each(
  [
    [{ address: 105n, offset: 5, size: 3 }],
    [{ address: 104n, offset: 7, size: 4 }],
    [...mappings, { address: 103n, offset: 7, size: 2 }],
  ].map((ranges) => [ranges] as const),
)(
  "refuses gaps or inconsistent translations across the selected span",
  (ranges) => {
    expect(() =>
      mappedFileOffset([mappings[0]!, ...ranges], 102n, 4),
    ).toThrow();
  },
);
it("refuses a zero-fill alias inside a span spanning multiple mappings", () => {
  expect(() =>
    mappedFileOffset(mappings, 102n, 4, [{ address: 104n, size: 1n }]),
  ).toThrow(/zero-fill/);
});
it.each(["scan", "index"] as const)(
  "reads strings across discontiguous source ranges without examining bytes after NUL (%s)",
  (mode) => {
    const ranges = [mappings[0]!, { address: 104n, offset: 8, size: 4 }];
    const zeroFills = [{ address: 106n, size: 2n }];
    const bytes = Buffer.from("ABCDxxxxE\0xx");
    const result =
      mode === "scan"
        ? readMappedCString(bytes, ranges, 102n, 8, zeroFills)
        : createFileMappingIndex(ranges, zeroFills).readCString(bytes, 102n, 8);
    expect(result.toString()).toBe("CDE");
    expect(() => mappedFileOffset(ranges, 102n, 4)).toThrow(/ambiguous/);
  },
);

it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
  "preserves zero-span and invalid-size semantics for %s",
  (size) => {
    const index = createFileMappingIndex(mappings);
    expect(outcome(() => index.offset(104n, size))).toEqual(
      outcome(() => mappedFileOffset(mappings, 104n, size)),
    );
  },
);

it.each([false, true])(
  "keeps conflict classification before gap and zero-fill checks (%s)",
  (conflicting) => {
    const ranges = [
      { address: 100n, offset: 0, size: 2 },
      { address: 104n, offset: conflicting ? 8 : 4, size: 2 },
    ];
    const zeroFills = [{ address: 102n, size: 1n }];
    const index = createFileMappingIndex(ranges, zeroFills);
    expect(outcome(() => index.offset(101n, 4))).toBe(
      conflicting ? "ambiguous" : "unmapped",
    );
    expect(outcome(() => index.offset(101n, 4))).toEqual(
      outcome(() => mappedFileOffset(ranges, 101n, 4, zeroFills)),
    );
  },
);

it.each([
  { magic: 0xfeedface, bits: 32, headerSize: 28 },
  { magic: 0xfeedfacf, bits: 64, headerSize: 32 },
  { magic: 0xcefaedfe, bits: 32, headerSize: 28 },
  { magic: 0xcffaedfe, bits: 64, headerSize: 32 },
])(
  "retains thin-header truncation after recognizing magic $magic",
  ({ magic, bits, headerSize }) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(magic);
    expect(() => readBinaryContainer(bytes, "elf-directory")).toThrow(
      new BinaryFormatFailure(
        "malformed",
        `truncated Mach-O header: a ${bits}-bit header needs ${headerSize} bytes; the file has 4`,
      ),
    );
  },
);

it("keeps a JVM-sized FAT count unconfirmed while rejecting malformed zero-count FAT", () => {
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32BE(0xcafebabe);
  bytes.writeUInt32BE(0x0000003d, 4); // JVM major version 61; no FAT table follows.
  expect(() => readBinaryContainer(bytes, "elf-directory")).toThrow(
    new BinaryFormatFailure(
      "unsupported",
      "Only ELF, PE, and thin Mach-O native images are supported",
    ),
  );
  bytes.writeUInt32BE(0, 4);
  expect(() => readBinaryContainer(bytes, "elf-directory")).toThrow(
    new BinaryFormatFailure(
      "malformed",
      "FAT header declares no architectures",
    ),
  );
});

it("requires an observed thin slice before identifying a FAT image", () => {
  const cpu = CPU.arm64;
  const thin = machoImage({ cpu, wide: true });
  const read = (bytes: Uint8Array) =>
    readBinaryContainer(
      Buffer.from(fatImage([{ cpu, bytes }])),
      "elf-directory",
    );

  expect(() => read(thin)).toThrow(
    new BinaryFormatFailure(
      "unsupported",
      "Universal/fat Mach-O containers require selecting a thin slice",
    ),
  );
  expect(() => read(Buffer.alloc(thin.length))).toThrow(
    new BinaryFormatFailure(
      "unsupported",
      "Only ELF, PE, and thin Mach-O native images are supported",
    ),
  );
});

/** An x86-64 ELF executable with one PT_LOAD declaring `fileSize` bytes. */
const elfWithLoadSegment = (fileSize: bigint): Buffer => {
  const bytes = Buffer.alloc(64 + 56);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(2, 16); // ET_EXEC
  bytes.writeUInt16LE(0x3e, 18); // EM_X86_64
  bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(64n, 32); // e_phoff
  bytes.writeUInt16LE(64, 52);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(1, 56); // e_phnum
  bytes.writeUInt16LE(64, 58);
  bytes.writeUInt32LE(1, 64); // PT_LOAD
  bytes.writeUInt32LE(5, 68);
  bytes.writeBigUInt64LE(0x400000n, 80);
  bytes.writeBigUInt64LE(0x400000n, 88);
  bytes.writeBigUInt64LE(fileSize, 96);
  bytes.writeBigUInt64LE(fileSize, 104);
  bytes.writeBigUInt64LE(0x1000n, 112);
  return bytes;
};

it("names a load segment that runs past the end of the file as truncated", () => {
  expect(
    readBinaryContainer(elfWithLoadSegment(120n), "elf-directory").mappings,
  ).toHaveLength(1);
  expect(() =>
    readBinaryContainer(elfWithLoadSegment(0x1000n), "elf-directory"),
  ).toThrow(
    expect.objectContaining({
      failure: {
        kind: "truncated",
        format: "elf",
        detail: "ELF load segment range is outside the file",
        offset: 0,
        field: "ELF load segment",
      },
    }),
  );
});
