import { expect, it, vi } from "vitest";
import {
  isMapped,
  openImageSteps,
  readPointer,
  readSlot,
  readUInt32,
} from "../../../src/il2cpp/Il2cppBinaryImage.js";
import {
  drain,
  linkIl2cppBinary,
  readIl2cppMetadataForLinking,
} from "../../fixtures/il2cpp/readers.js";
import {
  createElfFixture,
  createIl2cppBinaryFixture,
  createIl2cppTypeScanFixture,
  FIXTURE_BINARY_BASE,
} from "../../fixtures/il2cpp/binary.js";
import { createLinkedIl2cppMetadataFixture } from "../../fixtures/il2cpp/metadata.js";

const { metadata, link: facts } = readIl2cppMetadataForLinking(
  createLinkedIl2cppMetadataFixture().bytes,
);
const link = (bytes: Buffer) => linkIl2cppBinary(bytes, metadata, facts);
const open = (bytes: Buffer) => drain(openImageSteps(bytes, undefined));

/** Replace PT_LOAD declarations, keeping the original PT_DYNAMIC and payload. */
const withLoadRanges = (
  bytes: Buffer,
  ranges: readonly {
    readonly offset: number;
    readonly size: number;
    readonly zeroFill?: number;
    readonly address?: bigint;
  }[],
): Buffer => {
  const headers: Buffer[] = [];
  const start = Number(bytes.readBigUInt64LE(32));
  const width = bytes.readUInt16LE(54);
  for (let index = 0; index < bytes.readUInt16LE(56); index++) {
    const at = start + index * width;
    if (bytes.readUInt32LE(at) !== 1)
      headers.push(bytes.subarray(at, at + width));
  }
  for (const range of ranges) {
    const header = Buffer.alloc(width);
    header.writeUInt32LE(1);
    header.writeUInt32LE(7, 4);
    header.writeBigUInt64LE(BigInt(range.offset), 8);
    const address = range.address ?? FIXTURE_BINARY_BASE + BigInt(range.offset);
    header.writeBigUInt64LE(address, 16);
    header.writeBigUInt64LE(address, 24);
    header.writeBigUInt64LE(BigInt(range.size), 32);
    header.writeBigUInt64LE(BigInt(range.size + (range.zeroFill ?? 0)), 40);
    header.writeBigUInt64LE(1n, 48);
    headers.push(header);
  }
  const result = Buffer.concat([bytes, ...headers]);
  result.writeBigUInt64LE(BigInt(bytes.length), 32);
  result.writeUInt16LE(headers.length, 56);
  return result;
};

it.each([183, 62])(
  "keeps file-backed relocation writes on their virtual owner despite physical aliases (machine %s)",
  (machine) => {
    const original = createElfFixture(createIl2cppBinaryFixture(), { machine });
    // RELA restores the zero stored at 0x308, but must not change the same
    // file bytes independently mapped at base + 0x2000. A single file copy
    // cannot represent those two different loader values.
    expect(original.readBigUInt64LE(0x308)).toBe(0n);
    for (const [offset, size] of [
      [0x308, 8],
      [0x307, 2],
      [0x30f, 2],
    ] as const) {
      const bytes = withLoadRanges(original, [
        { offset: 0, size: original.length },
        {
          offset,
          size,
          address: FIXTURE_BINARY_BASE + 0x2000n,
        },
      ]);
      const snapshot = Buffer.from(bytes);
      const image = open(bytes);
      expect(readSlot(image, FIXTURE_BINARY_BASE + 0x308n)).toBe(
        FIXTURE_BINARY_BASE + 0x200n,
      );
      if (offset === 0x308 && size === 8)
        expect(readSlot(image, FIXTURE_BINARY_BASE + 0x2000n)).toBe(0n);
      expect(Buffer.compare(bytes, snapshot)).toBe(0);
    }
  },
);

it.each([183, 62])(
  "keeps unresolved symbol writes from changing another virtual mapping (machine %s)",
  (machine) => {
    const source = createIl2cppBinaryFixture();
    source.writeBigUInt64LE(0x1234n, 0x700);
    const original = createElfFixture(source, {
      machine,
      unresolvedRelocations: [
        { offset: 0x700, kind: machine === 183 ? 257 : 1 },
      ],
    });
    const bytes = withLoadRanges(original, [
      { offset: 0, size: original.length },
      { offset: 0x700, size: 8, address: FIXTURE_BINARY_BASE + 0x2000n },
    ]);
    const image = open(bytes);
    expect(readSlot(image, FIXTURE_BINARY_BASE + 0x700n)).toBe("unknown");
    expect(readSlot(image, FIXTURE_BINARY_BASE + 0x2000n)).toBe(0x1234n);
  },
);

it("keeps consistent aliases and distinct virtual mappings of untouched file bytes", () => {
  const original = createElfFixture(createIl2cppBinaryFixture());
  for (const alias of [
    { offset: 0x300, size: 0x28 },
    { offset: 0x200, size: 0x20, address: FIXTURE_BINARY_BASE + 0x2000n },
  ]) {
    const bytes = withLoadRanges(original, [
      { offset: 0, size: original.length },
      alias,
    ]);
    expect(link(bytes)).toEqual(link(original));
  }
});

it("reuses admitted mappings for repeated file-backed loader reads", () => {
  const original = createIl2cppBinaryFixture();
  const image = open(createElfFixture(original, { zeroFilledTable: true }));
  const mappings = vi.spyOn(image.container.mappings, Symbol.iterator);
  const zeroFills = vi.spyOn(image.container.zero_fills, "some");
  try {
    for (let index = 0; index < 32; index++) {
      expect(readSlot(image, FIXTURE_BINARY_BASE + 0x900n)).toBe(
        original.readBigUInt64LE(0x900),
      );
      expect(readUInt32(image, FIXTURE_BINARY_BASE + 0x988n)).toBe(
        original.readUInt32LE(0x988),
      );
      expect(isMapped(image, FIXTURE_BINARY_BASE + 0x980n, 12)).toBe(true);
    }
    expect(mappings).not.toHaveBeenCalled();
    expect(zeroFills).not.toHaveBeenCalled();
  } finally {
    mappings.mockRestore();
    zeroFills.mockRestore();
  }
});

it("links one code-loaded type table among short runs across many mappings", () => {
  const bytes = createIl2cppTypeScanFixture(64, 128);
  const snapshot = Buffer.from(bytes);
  const result = linkIl2cppBinary(bytes, metadata, {
    ...facts,
    returnTypes: Int32Array.from(facts.returnTypes, () => 3),
  });
  expect(result.types_field).toBeNull();
  expect(result.types_count).toBe(4);
  expect(result.return_types.map((row) => row.name)).toEqual(
    Array.from({ length: 5 }, () => "int"),
  );
  expect(Buffer.compare(bytes, snapshot)).toBe(0);
});

it.each([183, 62])(
  "links agreeing split ELF RELA spans without changing input bytes (machine %s)",
  (machine) => {
    const original = createElfFixture(createIl2cppBinaryFixture(), { machine });
    // Split the first Elf64_Rela after its destination and half its info word.
    const split = withLoadRanges(original, [
      { offset: 0, size: 0x100c },
      { offset: 0x100c, size: original.length - 0x100c },
    ]);
    const snapshot = Buffer.from(split);
    expect(link(split)).toEqual(link(original));
    expect(Buffer.compare(split, snapshot)).toBe(0);
  },
);

it.each([false, true])(
  "refuses a RELA addend claimed by file bytes and zero-fill (split %s)",
  (split) => {
    const original = createElfFixture(createIl2cppBinaryFixture());
    const bytes = withLoadRanges(original, [
      ...(split
        ? [
            { offset: 0, size: 0x100c },
            { offset: 0x100c, size: original.length - 0x100c },
          ]
        : [{ offset: 0, size: original.length }]),
      { offset: 0x1010, size: 0, zeroFill: 8 },
    ]);
    const snapshot = Buffer.from(bytes);
    expect(() => link(bytes)).toThrow(
      expect.objectContaining({
        reason: "malformed-container",
        message: expect.stringContaining(
          "ambiguous file and zero-fill mappings",
        ),
      }),
    );
    expect(Buffer.compare(bytes, snapshot)).toBe(0);
  },
);

it("refuses a RELATIVE destination claimed by both file bytes and zero-fill", () => {
  const original = createElfFixture(createIl2cppBinaryFixture());
  const bytes = withLoadRanges(original, [
    { offset: 0, size: original.length },
    { offset: 0x304, size: 0, zeroFill: 4 },
  ]);
  expect(() => link(bytes)).toThrow(
    expect.objectContaining({
      reason: "malformed-container",
      message: expect.stringContaining("ambiguous file and zero-fill mappings"),
    }),
  );
});

it("refuses an unresolved count relocation with conflicting file/zero-fill owners", () => {
  const original = createElfFixture(createIl2cppBinaryFixture(), {
    unresolvedRelocations: [{ offset: 0x600, kind: 258 }], // R_AARCH64_ABS32
  });
  const bytes = withLoadRanges(original, [
    { offset: 0, size: original.length },
    { offset: 0x600, size: 0, zeroFill: 4 },
  ]);
  const snapshot = Buffer.from(bytes);
  expect(() => link(bytes)).toThrow(
    expect.objectContaining({
      reason: "malformed-container",
      message: expect.stringContaining("ambiguous file and zero-fill mappings"),
    }),
  );
  expect(Buffer.compare(bytes, snapshot)).toBe(0);
});

it("clears a file-backed unresolved count before scanning registration candidates", () => {
  const control = createElfFixture(createIl2cppBinaryFixture());
  const bytes = createElfFixture(createIl2cppBinaryFixture(), {
    unresolvedRelocations: [{ offset: 0x600, kind: 258 }],
  });
  const snapshot = Buffer.from(bytes);
  expect(link(control).code_gen_modules_field).toBe(
    FIXTURE_BINARY_BASE + 0x600n,
  );
  expect(() => link(bytes)).toThrow(
    expect.objectContaining({ reason: "code-registration-not-found" }),
  );
  expect(Buffer.compare(bytes, snapshot)).toBe(0);
});

it.each([false, true])(
  "retains unrelated unresolved targets without file bytes (zero-fill %s)",
  (zeroFill) => {
    const control = createElfFixture(createIl2cppBinaryFixture());
    const original = createElfFixture(createIl2cppBinaryFixture(), {
      unresolvedRelocations: [{ offset: 0x2000, kind: 258 }],
    });
    const bytes = withLoadRanges(original, [
      { offset: 0, size: original.length },
      ...(zeroFill ? [{ offset: 0x2000, size: 0, zeroFill: 4 }] : []),
    ]);
    expect(link(bytes)).toEqual(link(control));
    expect(readSlot(open(bytes), FIXTURE_BINARY_BASE + 0x2000n)).toBe(
      "unknown",
    );
  },
);

it("keeps mapped-span admission consistent with pointer reads across zero-fill aliases", () => {
  const original = createElfFixture(createIl2cppBinaryFixture());
  const ranges = [
    { offset: 0, size: 0xc08 },
    { offset: 0xc08, size: original.length - 0xc08 },
  ];
  for (const conflict of [false, true]) {
    const bytes = withLoadRanges(original, [
      ...ranges,
      ...(conflict ? [{ offset: 0xc08, size: 0, zeroFill: 4 }] : []),
    ]);
    const image = open(bytes);
    const address = FIXTURE_BINARY_BASE + 0xc04n;
    expect(isMapped(image, address, 8)).toBe(!conflict);
    expect(readPointer(image, address)).toBe(conflict ? null : 0n);
    expect(isMapped(image, FIXTURE_BINARY_BASE + 0xc00n, 4)).toBe(true);
  }
});

it("reads both halves of a relocated word without changing a physical alias's UInt32 fields", () => {
  const original = createElfFixture(createIl2cppBinaryFixture());
  const bytes = withLoadRanges(original, [
    { offset: 0, size: original.length },
    { offset: 0x304, size: 16, address: FIXTURE_BINARY_BASE + 0x2000n },
  ]);
  const image = open(bytes);
  expect(readUInt32(image, FIXTURE_BINARY_BASE + 0x308n)).toBe(0x200);
  expect(readUInt32(image, FIXTURE_BINARY_BASE + 0x30cn)).toBe(1);
  expect(readUInt32(image, FIXTURE_BINARY_BASE + 0x2004n)).toBe(0);
  expect(readUInt32(image, FIXTURE_BINARY_BASE + 0x2008n)).toBe(0);
  expect(image.bytes.equals(bytes)).toBe(true);
});

it.each([183, 62])(
  "retains independent relocated values for two virtual aliases (machine %s)",
  (machine) => {
    const original = createElfFixture(createIl2cppBinaryFixture(), { machine });
    // Redirect a separate existing RELA record to the alias, retaining the write
    // to the original 0x308 slot and the same immutable source word.
    const dynamic = Number(original.readBigUInt64LE(128));
    const count = Number(original.readBigUInt64LE(dynamic + 24)) / 24;
    for (let i = 0; i < count; i++) {
      const at = 0x1000 + i * 24;
      if (original.readBigUInt64LE(at) === FIXTURE_BINARY_BASE + 0x308n)
        continue;
      original.writeBigUInt64LE(FIXTURE_BINARY_BASE + 0x2000n, at);
      original.writeBigUInt64LE(FIXTURE_BINARY_BASE + 0x333n, at + 16);
      break;
    }
    const bytes = withLoadRanges(original, [
      { offset: 0, size: original.length },
      { offset: 0x308, size: 8, address: FIXTURE_BINARY_BASE + 0x2000n },
    ]);
    const image = open(bytes);
    expect(readSlot(image, FIXTURE_BINARY_BASE + 0x308n)).toBe(
      FIXTURE_BINARY_BASE + 0x200n,
    );
    expect(readSlot(image, FIXTURE_BINARY_BASE + 0x2000n)).toBe(
      FIXTURE_BINARY_BASE + 0x333n,
    );
    expect(image.bytes.equals(bytes)).toBe(true);
  },
);

it.each([183, 62])(
  "keeps an untouched UInt32 half known after a same-start narrow unknown write (machine %s)",
  (machine) => {
    const bytes = createElfFixture(createIl2cppBinaryFixture(), {
      machine,
      unresolvedRelocations: [
        { offset: 0x308, kind: machine === 183 ? 258 : 10 },
      ],
    });
    const image = open(bytes);
    expect(readSlot(image, FIXTURE_BINARY_BASE + 0x308n)).toBe("unknown");
    expect(readUInt32(image, FIXTURE_BINARY_BASE + 0x308n)).toBe("unknown");
    expect(readUInt32(image, FIXTURE_BINARY_BASE + 0x30cn)).toBe(1);
  },
);

it("composes a UInt32 crossing a known relocation edge with unchanged source bytes", () => {
  const source = createIl2cppBinaryFixture();
  source.writeUInt32LE(0xaabbccdd, 0x310);
  const bytes = createElfFixture(source);
  const image = open(bytes);
  expect(readUInt32(image, FIXTURE_BINARY_BASE + 0x306n)).toBe(
    bytes.readUInt16LE(0x306) + 0x02000000,
  );
  // The relocated word at 0x308 is 0x0000000100000200. Its final two
  // bytes are followed by the original dd cc bytes at 0x310.
  expect(readUInt32(image, FIXTURE_BINARY_BASE + 0x30en)).toBe(0xccdd0000);
  expect(readUInt32(image, FIXTURE_BINARY_BASE + 0x30cn)).toBe(1);
});
