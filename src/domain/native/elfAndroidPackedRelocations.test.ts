import { expect, it } from "vitest";
import {
  aps2Relocations,
  aps2Table,
} from "../../../tests/fixtures/elfAndroidPacked.js";
import {
  BinaryResourceFailure,
  isNativeStructureFailure,
  NATIVE_STRUCTURE_LIMIT,
} from "../binaryContainer.js";
import {
  ElfPointerRelocationFailure,
  readElfRelocationWritesSteps,
  readElfPointerRelocationsSteps,
  type ElfPointerWrite,
} from "./elfPointerRelocations.js";

const packedImage = (
  packed: Buffer,
  bits: 32 | 64 = 64,
  little = true,
  encoding: "rel" | "rela" = "rela",
) => {
  const bytes = Buffer.alloc(Math.max(0x900, 0x100 + packed.length));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const word = bits / 8;
  const put = (at: number, value: bigint) => {
    if (bits === 64) view.setBigUint64(at, value, little);
    else view.setUint32(at, Number(value), little);
  };
  const tag = encoding === "rela" ? 0x60000011n : 0x6000000fn;
  put(0, tag);
  put(word, 0x100n);
  put(word * 2, tag + 1n);
  put(word * 3, BigInt(packed.length));
  bytes.set(packed, 0x100);
  for (let index = 0; index < 3; index++)
    put(0x500 + index * word, BigInt(0x21 + index));
  return {
    bytes,
    input: {
      bits,
      little,
      machine: bits === 64 ? 62 : 3,
      dynamicSegments: [{ offset: 0n, size: BigInt(word * 6) }],
      mappings: [{ address: 0n, offset: 0, size: bytes.length }],
      zeroFills: [],
    },
  };
};

const decode = (
  packed: Buffer,
  bits: 32 | 64 = 64,
  little = true,
  encoding: "rel" | "rela" = "rela",
) => {
  const fixture = packedImage(packed, bits, little, encoding);
  const writes: ElfPointerWrite[] = [];
  let checkpoints = 0;
  const steps = readElfRelocationWritesSteps(fixture.bytes, fixture.input);
  let step = steps.next();
  while (!step.done) {
    if (step.value === undefined) checkpoints++;
    else writes.push(step.value);
    step = steps.next();
  }
  return { writes, checkpoints, result: step.value };
};

it.each([
  [32, true],
  [32, false],
  [64, true],
  [64, false],
] as const)(
  "decodes grouped RELA offsets/info/addend deltas independently of ELF byte order (%s, %s)",
  (bits, little) => {
    const word = bits / 8;
    const packed = aps2Table([3, 0x500 - word, 3, 15, word, 8, 0x20]);
    const { writes } = decode(packed, bits, little);
    expect(
      writes.map(({ address, value, addend }) => [address, value, addend]),
    ).toEqual([
      [0x500n, 0x20n, 0x20n],
      [0x500n + BigInt(word), 0x40n, 0x40n],
      [0x500n + BigInt(2 * word), 0x60n, 0x60n],
    ]);
    expect(writes.map(({ source }) => source)).toEqual(
      [0, 1, 2].map((index) => ({
        encoding: "rela",
        record_file_offset: 0x107,
        kind: 8,
        packing: { format: "aps2", group_entry_index: index },
      })),
    );
  },
);

it.each([32, 64] as const)(
  "keeps REL in-place addends and logical encoding for %s-bit APS2",
  (bits) => {
    const word = bits / 8;
    const { writes } = decode(
      aps2Table([3, 0x500 - word, 3, 3, word, 8]),
      bits,
      true,
      "rel",
    );
    expect(
      writes.map(({ value, addend, source }) => [
        value,
        addend,
        source.encoding,
      ]),
    ).toEqual([
      [0x21n, null, "rel"],
      [0x22n, null, "rel"],
      [0x23n, null, "rel"],
    ]);
  },
);

it("applies ungrouped negative offset/addend deltas without losing group identity", () => {
  const { writes } = decode(
    aps2Table([2, 0, 2, 8, 0x508, 8, 0x30, -8, 8, -0x10]),
  );
  expect(
    writes.map(({ address, value, source }) => [
      address,
      value,
      source.record_file_offset,
      source.packing?.group_entry_index,
    ]),
  ).toEqual([
    [0x508n, 0x30n, 0x106, 0],
    [0x500n, 0x20n, 0x106, 1],
  ]);
});

it("resets RELA addends for a group that declares none", () => {
  const { writes } = decode(
    aps2Table([3, 0, 1, 8, 0x500, 8, 0x20, 1, 3, 8, 8, 1, 11, 8, 8, 5]),
  );
  expect(writes.map(({ value }) => value)).toEqual([0x20n, 0n, 5n]);
});

it("retains unknown symbolic writes and exact r_info symbol indices", () => {
  const info = (0xffffffffn << 32n) | 1n;
  const { writes } = decode(
    aps2Table([1, 0, 1, 8, 0x500, BigInt.asIntN(64, info), 7]),
  );
  expect(writes[0]).toMatchObject({
    address: 0x500n,
    value: null,
    symbol_index: 0xffffffff,
    addend: 7n,
    source: { kind: 1 },
  });
});

it("accepts LLD's zero section padding after the declared records", () => {
  expect(
    decode(aps2Table([1, 0, 1, 11, 0x500, 8, 9], 32)).writes[0]?.value,
  ).toBe(9n);
});

it("accepts an empty table without requiring or inventing a group", () => {
  const { writes, result } = decode(aps2Relocations([], "rela"));
  expect(writes).toEqual([]);
  expect(result.pointer_coverage_known).toBe(true);
});

it.each([
  { values: [-1, 0], message: "count is negative" },
  { values: [1, 0, 0, 0], message: "group count" },
  { values: [1, 0, -1, 0], message: "group count" },
  { values: [1, 0, 2, 0], message: "group count" },
  { values: [1, 0, 1, 16], message: "group flags" },
  { values: [1, 0, 1, -1], message: "group flags" },
  { values: [1, 0, 1, 4], message: "group flags" },
  { values: [1, 0, 1, 3, 8], message: "integer is truncated" },
  { values: [1, 0, 1, 8, 0x500, 8], message: "integer is truncated" },
] as const)(
  "refuses malformed APS2 groups: $message ($values)",
  ({ values, message }) => {
    expect(() => decode(aps2Table(values))).toThrow(message);
  },
);

it("refuses explicit addends in REL groups", () => {
  expect(() => decode(aps2Table([1, 0, 1, 8]), 32, true, "rel")).toThrow(
    "group flags",
  );
});

it.each([
  Buffer.from("CPS2"),
  Buffer.from([0xc1, 0xd0, 0xd3, 0xb2]),
  Buffer.concat([Buffer.from("APS2"), Buffer.alloc(11, 0x80)]),
  Buffer.concat([aps2Table([0, 0]), Buffer.from([1])]),
])(
  "refuses invalid magic, overflowing integers and nonzero trailing data (%j)",
  (packed) => {
    expect(() => decode(packed)).toThrow(ElfPointerRelocationFailure);
  },
);

it("admits equivalent expanded table work before iterating a compressed group", () => {
  expect(() => decode(aps2Table([1_000_000, 0]))).toThrow(
    "16 MiB decode-work allowance",
  );
});

it("bounds Android packed relocation input and expanded work with caller structureBytes", () => {
  // 100 RELA64 records = 2400 expanded bytes.
  const expandedFixture = packedImage(aps2Table([100, 0]));
  let expandedFailure: unknown;
  try {
    [
      ...readElfRelocationWritesSteps(expandedFixture.bytes, {
        ...expandedFixture.input,
        structureBytes: 1024,
      }),
    ];
  } catch (cause) {
    expandedFailure = cause;
  }
  expect(expandedFailure).toBeInstanceOf(BinaryResourceFailure);
  expect(isNativeStructureFailure(expandedFailure)).toBe(true);
  expect(expandedFailure).toMatchObject({
    maximum_bytes: 1024,
    failure: {
      limit: {
        name: NATIVE_STRUCTURE_LIMIT,
        maximum: 1024,
        required: 2400,
      },
    },
  });

  // Non-APS2 garbage exceeding structureBytes stays malformed, not a budget refusal.
  const nonAps2Fixture = packedImage(Buffer.alloc(2048, 0x58));
  expect(() => [
    ...readElfRelocationWritesSteps(nonAps2Fixture.bytes, {
      ...nonAps2Fixture.input,
      structureBytes: 1024,
    }),
  ]).toThrow("lacks an APS2 header");

  // Packed input bytes exceeding structureBytes fails before decoding APS2 header.
  const oversizedPacked = Buffer.concat([
    Buffer.from("APS2"),
    Buffer.alloc(2048, 0),
  ]);
  const packedFixture = packedImage(oversizedPacked);
  let packedFailure: unknown;
  try {
    [
      ...readElfRelocationWritesSteps(packedFixture.bytes, {
        ...packedFixture.input,
        structureBytes: 1024,
      }),
    ];
  } catch (cause) {
    packedFailure = cause;
  }
  expect(packedFailure).toBeInstanceOf(BinaryResourceFailure);
  expect(isNativeStructureFailure(packedFailure)).toBe(true);
  expect(packedFailure).toMatchObject({
    maximum_bytes: 1024,
    failure: {
      limit: {
        name: NATIVE_STRUCTURE_LIMIT,
        maximum: 1024,
        required: 2052,
      },
    },
  });

  // Raising structureBytes above expanded bytes admits the table.
  const validPacked = aps2Table([3, 0x500 - 8, 3, 15, 8, 8, 0x20]);
  const validFixture = packedImage(validPacked);
  expect(() => [
    ...readElfRelocationWritesSteps(validFixture.bytes, {
      ...validFixture.input,
      structureBytes: 64,
    }),
  ]).toThrow(BinaryResourceFailure);
  const steps = readElfRelocationWritesSteps(validFixture.bytes, {
    ...validFixture.input,
    structureBytes: 128,
  });
  const writes: ElfPointerWrite[] = [];
  for (const step of steps) {
    if (step !== undefined) writes.push(step);
  }
  expect(writes).toHaveLength(3);
});

it.each([
  {
    name: "size without address",
    at: 0,
    value: 21n,
    error: "size has no table address",
  },
  {
    name: "address without size",
    at: 16,
    value: 21n,
    error: "no valid byte size",
  },
  { name: "unmapped source", at: 8, value: 0x10000n, error: "not file-backed" },
  {
    name: "duplicate declaration",
    at: 16,
    value: 0x60000011n,
    error: "duplicate dynamic tag",
  },
])("refuses incomplete APS2 declarations: $name", ({ at, value, error }) => {
  const fixture = packedImage(aps2Table([0, 0]));
  fixture.bytes.writeBigUInt64LE(value, at);
  expect(() => [
    ...readElfRelocationWritesSteps(fixture.bytes, fixture.input),
  ]).toThrow(error);
});

it("keeps conflicting members at one destination unresolved with separate provenance", () => {
  const fixture = packedImage(aps2Table([2, 0x500, 2, 15, 0, 8, 5]));
  const steps = readElfPointerRelocationsSteps(fixture.bytes, fixture.input);
  let step = steps.next();
  while (!step.done) step = steps.next();
  expect(step.value.pointerAt(0x500n)).toBeUndefined();
  expect(step.value.unresolved.has(0x500n)).toBe(true);
  expect(
    step.value.writes.map(({ value, source }) => [
      value,
      source.packing?.group_entry_index,
    ]),
  ).toEqual([
    [5n, 0],
    [10n, 1],
  ]);
});

it("yields cooperatively inside a fully grouped run with no per-record bytes", () => {
  const { checkpoints, writes } = decode(aps2Table([8192, 0, 8192, 3, 0, 0]));
  expect(writes).toEqual([]);
  expect(checkpoints).toBeGreaterThanOrEqual(3);
});
