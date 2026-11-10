import { expect, it } from "vitest";
import { GO_ANALYSIS_BUDGET_DEFAULTS } from "../domain/go/goBinary.js";
import type {
  BinaryContainer,
  FileMapping,
  ImageSection,
  LoadRegion,
} from "../native/metadata/BinaryContainer.js";
import { createGoRodataStringFixture } from "../../tests/fixtures/go/rodataStringImage.js";
import { readGoBinaryImage } from "./GoBinaryImage.js";
import { recoverGoStringLiterals } from "./GoStringLiterals.js";

const DEFAULT_AGGREGATE_BYTES = 512 * 1024;
const DEFAULT_LITERAL_BYTES = 4096;

const LITERALS = [
  "ListResourceProviders",
  "genai",
  "https://example.invalid/v1",
] as const;
const PACKED_RODATA = Buffer.concat(
  LITERALS.map((value) => Buffer.from(value, "utf8")),
);

it.each([
  { format: "elf", bits: 64, byteOrder: "little" },
  { format: "elf", bits: 32, byteOrder: "little" },
  { format: "elf", bits: 64, byteOrder: "big" },
  { format: "pe", bits: 64, byteOrder: "little" },
  { format: "pe", bits: 32, byteOrder: "little" },
  { format: "macho", bits: 64, byteOrder: "little" },
  { format: "macho", bits: 32, byteOrder: "little" },
] as const)(
  "recovers exact non-NUL-terminated slices in $format ($bits-bit $byteOrder)",
  ({ format, bits, byteOrder }) => {
    const width = bits / 8;
    const firstLen = Buffer.byteLength(LITERALS[0]);
    const secondLen = Buffer.byteLength(LITERALS[1]);
    const thirdLen = Buffer.byteLength(LITERALS[2]);
    const baseRo = 0x102000n;

    const fixture = createGoRodataStringFixture({
      format,
      bits,
      byteOrder,
      rodata: PACKED_RODATA,
      headers: [
        {
          section: "data",
          offsetInSection: width,
          ptr: baseRo + BigInt(firstLen + secondLen),
          len: BigInt(thirdLen),
        },
        {
          section: "data",
          offsetInSection: width * 4,
          ptr: baseRo,
          len: BigInt(firstLen),
        },
        {
          section: "data",
          offsetInSection: width * 7,
          ptr: baseRo + BigInt(firstLen),
          len: BigInt(secondLen),
        },
        {
          section: "data",
          offsetInSection: width * 10,
          ptr: baseRo + BigInt(firstLen),
          len: BigInt(secondLen),
        },
      ],
    });

    expect(readGoBinaryImage(fixture.bytes).string_literals).toBeUndefined();

    const recovered = readGoBinaryImage(fixture.bytes, {
      includeStringLiterals: true,
    }).string_literals;
    expect(recovered).toEqual({
      evidence_kind: "inferred",
      discovered_count: 3,
      aggregate_bytes: PACKED_RODATA.length,
      max_items: 2000,
      truncated: false,
      items: [
        {
          value: "ListResourceProviders",
          location: { offset: fixture.rodataOffset, bytes: firstLen },
          first_header_offset: fixture.dataOffset + width * 4,
          reference_count: 1,
        },
        {
          value: "genai",
          location: {
            offset: fixture.rodataOffset + firstLen,
            bytes: secondLen,
          },
          first_header_offset: fixture.dataOffset + width * 7,
          reference_count: 2,
        },
        {
          value: "https://example.invalid/v1",
          location: {
            offset: fixture.rodataOffset + firstLen + secondLen,
            bytes: thirdLen,
          },
          first_header_offset: fixture.dataOffset + width,
          reference_count: 1,
        },
      ],
    });
  },
);

it.each([
  { label: "sectionless ELF", sectionless: true, corruptElfShstrtab: false },
  {
    label: "ELF with unreadable .shstrtab",
    sectionless: false,
    corruptElfShstrtab: true,
  },
])("recovers literals from $label via load regions", (mode) => {
  const baseRo = 0x102000n;
  const fixture = createGoRodataStringFixture({
    format: "elf",
    rodata: PACKED_RODATA,
    sectionless: mode.sectionless,
    corruptElfShstrtab: mode.corruptElfShstrtab,
    headers: [
      {
        section: "data",
        offsetInSection: 0,
        ptr: baseRo,
        len: BigInt(LITERALS[0].length),
      },
      {
        section: "data",
        offsetInSection: 16,
        ptr: baseRo + BigInt(LITERALS[0].length),
        len: BigInt(LITERALS[1].length),
      },
    ],
  });
  const recovered = readGoBinaryImage(fixture.bytes, {
    includeStringLiterals: true,
  }).string_literals;
  expect(recovered?.items.map((item) => item.value)).toEqual([
    "ListResourceProviders",
    "genai",
  ]);
});

it("rejects invalid candidates and reports valid ranges omitted by the string-length budget", () => {
  const validUnicode = Buffer.from("café\t日本語\n", "utf8");
  const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x41]);
  const embeddedNul = Buffer.from("bad\0str", "utf8");
  const c1Control = Buffer.from([0xc2, 0x85]);
  const noncharacter = Buffer.from([0xef, 0xbf, 0xbf]);
  const maxAllowed = Buffer.alloc(DEFAULT_LITERAL_BYTES, 0x61);
  const overMax = Buffer.alloc(DEFAULT_LITERAL_BYTES + 1, 0x62);
  const rodata = Buffer.concat([
    validUnicode,
    invalidUtf8,
    embeddedNul,
    c1Control,
    noncharacter,
    maxAllowed,
    overMax,
    Buffer.from("tail", "utf8"),
  ]);
  const secondRodata = Buffer.from("across-boundary", "utf8");
  const baseRo = 0x102000n;
  const tailOffset = rodata.length - 4;
  const badPrefixLen =
    validUnicode.length +
    invalidUtf8.length +
    embeddedNul.length +
    c1Control.length +
    noncharacter.length;

  const fixture = createGoRodataStringFixture({
    format: "elf",
    rodata,
    secondRodata,
    headers: [
      {
        section: "data",
        offsetInSection: 0,
        ptr: baseRo,
        len: BigInt(validUnicode.length),
      },
      {
        section: "data",
        offsetInSection: 16,
        ptr: baseRo + BigInt(badPrefixLen),
        len: BigInt(DEFAULT_LITERAL_BYTES),
      },
      {
        section: "data",
        offsetInSection: 32,
        ptr: baseRo + BigInt(badPrefixLen + maxAllowed.length),
        len: BigInt(DEFAULT_LITERAL_BYTES + 1),
      },
      { section: "data", offsetInSection: 48, ptr: baseRo, len: 0n },
      {
        section: "data",
        offsetInSection: 64,
        ptr: baseRo + BigInt(validUnicode.length),
        len: BigInt(invalidUtf8.length),
      },
      {
        section: "data",
        offsetInSection: 80,
        ptr: baseRo + BigInt(validUnicode.length + invalidUtf8.length),
        len: BigInt(embeddedNul.length),
      },
      {
        section: "data",
        offsetInSection: 96,
        ptr:
          baseRo +
          BigInt(validUnicode.length + invalidUtf8.length + embeddedNul.length),
        len: BigInt(c1Control.length),
      },
      {
        section: "data",
        offsetInSection: 112,
        ptr: baseRo + BigInt(badPrefixLen - noncharacter.length),
        len: BigInt(noncharacter.length),
      },
      {
        section: "data",
        offsetInSection: 128,
        ptr: baseRo + BigInt(tailOffset),
        len: 10n,
      },
      {
        section: "data",
        offsetInSection: 144,
        ptr: baseRo + BigInt(rodata.length),
        len: BigInt(secondRodata.length + 8),
      },
      {
        section: "data",
        offsetInSection: 164,
        ptr: baseRo + BigInt(tailOffset),
        len: 4n,
      },
      {
        section: "text",
        offsetInSection: 0,
        ptr: baseRo + BigInt(tailOffset),
        len: 4n,
      },
      { section: "data", offsetInSection: 192, ptr: 0x101000n, len: 4n },
    ],
  });
  fixture.bytes.write("CODE", 0x1000, "utf8");

  const recovered = readGoBinaryImage(fixture.bytes, {
    includeStringLiterals: true,
  }).string_literals;
  expect(recovered?.items.map((item) => item.value)).toEqual([
    "café\t日本語\n",
    "a".repeat(DEFAULT_LITERAL_BYTES),
  ]);
  expect(recovered?.truncated).toBe(true);
  expect(recovered?.limits_reached).toEqual(["max_string_literal_bytes"]);
});

it("enforces maxStringLiterals and the 512 KiB aggregate byte cap deterministically", () => {
  const chunks = Array.from({ length: 130 }, (_, index) =>
    Buffer.from(
      `${String(index).padStart(4, "0")}:${"x".repeat(DEFAULT_LITERAL_BYTES - 5)}`,
      "utf8",
    ),
  );
  const rodata = Buffer.concat(chunks);
  const baseRo = 0x102000n;
  const fixture = createGoRodataStringFixture({
    format: "macho",
    machoChainedFixups: true,
    rodata,
    headers: chunks.map((chunk, index) => ({
      section: "data" as const,
      offsetInSection: index * 16,
      ptr: baseRo + BigInt(index * chunk.length),
      len: BigInt(chunk.length),
    })),
  });

  const cappedByCount = readGoBinaryImage(fixture.bytes, {
    includeStringLiterals: true,
    budgets: { max_string_literals: 2 },
  });
  expect(cappedByCount.macho_chained_fixups).toBe(true);
  expect(cappedByCount.string_literals).toMatchObject({
    discovered_count: 130,
    max_items: 2,
    truncated: true,
    aggregate_bytes: DEFAULT_LITERAL_BYTES * 2,
  });
  expect(cappedByCount.string_literals?.items).toHaveLength(2);
  expect(
    cappedByCount.string_literals?.items[0]?.value.startsWith("0000:"),
  ).toBe(true);
  expect(
    cappedByCount.string_literals?.items[1]?.value.startsWith("0001:"),
  ).toBe(true);

  const cappedByBytes = readGoBinaryImage(fixture.bytes, {
    includeStringLiterals: true,
    budgets: { max_string_literals: 500 },
  });
  expect(cappedByBytes.string_literals).toMatchObject({
    discovered_count: 130,
    max_items: 500,
    aggregate_bytes: DEFAULT_AGGREGATE_BYTES,
    truncated: true,
  });
  expect(cappedByBytes.string_literals?.items).toHaveLength(
    DEFAULT_AGGREGATE_BYTES / DEFAULT_LITERAL_BYTES,
  );
});

it.each([false, true])(
  "counts physical headers once in file order across reversed sections and overlapping PT_LOAD (corruptShstrtab=%s)",
  (corruptElfShstrtab) => {
    const baseRo = 0x102000n;
    const firstLen = Buffer.byteLength(LITERALS[0]);
    const secondLen = Buffer.byteLength(LITERALS[1]);
    const fixture = createGoRodataStringFixture({
      format: "elf",
      rodata: PACKED_RODATA,
      corruptElfShstrtab,
      elfSplitReversedDataSections: true,
      headers: [
        {
          section: "data",
          offsetInSection: 0x200,
          ptr: baseRo,
          len: BigInt(firstLen),
        },
        {
          section: "data",
          offsetInSection: 0x40,
          ptr: baseRo,
          len: BigInt(firstLen),
        },
        {
          section: "data",
          offsetInSection: 0x60,
          ptr: baseRo + BigInt(firstLen),
          len: BigInt(secondLen),
        },
      ],
    });

    const recovered = readGoBinaryImage(fixture.bytes, {
      includeStringLiterals: true,
    }).string_literals;
    expect(recovered?.items).toEqual([
      {
        value: "ListResourceProviders",
        location: { offset: fixture.rodataOffset, bytes: firstLen },
        first_header_offset: fixture.dataOffset + 0x40,
        reference_count: 2,
      },
      {
        value: "genai",
        location: {
          offset: fixture.rodataOffset + firstLen,
          bytes: secondLen,
        },
        first_header_offset: fixture.dataOffset + 0x60,
        reference_count: 1,
      },
    ]);
  },
);

it("rejects invisible/bidi Cf format controls while keeping U+200C ZWNJ, U+200D ZWJ and visible Unicode", () => {
  const zeroWidthSpace = Buffer.from("zero\u200Bwidth", "utf8");
  const rtlOverride = Buffer.from("rtl\u202Eoverride", "utf8");
  const byteOrderMark = Buffer.from("\uFEFFbom", "utf8");
  const softHyphen = Buffer.from("soft\u00ADhyphen", "utf8");
  const persianZwnj = Buffer.from("می\u200cخواهم", "utf8");
  const zwjEmoji = Buffer.from("👩\u200d💻", "utf8");
  const visibleUnicode = Buffer.from("visible-café", "utf8");
  const slices = [
    zeroWidthSpace,
    persianZwnj,
    rtlOverride,
    zwjEmoji,
    byteOrderMark,
    softHyphen,
    visibleUnicode,
  ];
  let cursor = 0;
  const headers = slices.map((slice, index) => {
    const header = {
      section: "data" as const,
      offsetInSection: index * 16,
      ptr: 0x102000n + BigInt(cursor),
      len: BigInt(slice.length),
    };
    cursor += slice.length;
    return header;
  });
  const fixture = createGoRodataStringFixture({
    format: "elf",
    rodata: Buffer.concat(slices),
    headers,
  });

  const recovered = readGoBinaryImage(fixture.bytes, {
    includeStringLiterals: true,
  }).string_literals;
  expect(recovered?.items.map((item) => item.value)).toEqual([
    "می\u200cخواهم",
    "👩\u200d💻",
    "visible-café",
  ]);
  expect(recovered?.truncated).toBe(false);
});

it("bounds rejected-slice caching across thousands of distinct NUL slices without dropping later literals", () => {
  const rejectedCount = 6000;
  const nulBlob = Buffer.alloc(rejectedCount, 0);
  const survivor = Buffer.from("recovered-after-nul-flood", "utf8");
  const rodata = Buffer.concat([nulBlob, survivor]);
  const baseRo = 0x102000n;
  const headers = Array.from({ length: rejectedCount }, (_, index) => ({
    section: "data" as const,
    offsetInSection: index * 8,
    ptr: baseRo + BigInt(index),
    len: 1n,
  }));
  headers.push(
    {
      section: "data",
      offsetInSection: rejectedCount * 8,
      ptr: baseRo,
      len: 1n,
    },
    {
      section: "data",
      offsetInSection: (rejectedCount + 1) * 8,
      ptr: baseRo + BigInt(rejectedCount),
      len: BigInt(survivor.length),
    },
  );
  const fixture = createGoRodataStringFixture({
    format: "elf",
    bits: 32,
    rodata,
    dataSize: (rejectedCount + 8) * 8,
    headers,
  });

  const recovered = readGoBinaryImage(fixture.bytes, {
    includeStringLiterals: true,
  }).string_literals;
  expect(recovered).toEqual({
    evidence_kind: "inferred",
    discovered_count: 1,
    aggregate_bytes: survivor.length,
    max_items: 2000,
    truncated: false,
    items: [
      {
        value: "recovered-after-nul-flood",
        location: {
          offset: fixture.rodataOffset + rejectedCount,
          bytes: survivor.length,
        },
        first_header_offset: fixture.dataOffset + (rejectedCount + 1) * 8,
        reference_count: 1,
      },
    ],
  });
});

it("indexes 25,000 Mach-O load regions and sections without quadratic stalls and honors region and section cancellation", () => {
  const count = 25_000;
  const slotBytes = 16;
  const bytes = Buffer.alloc((count + 1) * slotBytes);
  const literal = "macho-indexed";
  const literalBytes = Buffer.from(literal, "utf8");
  literalBytes.copy(bytes, 0);

  const mappings: FileMapping[] = [];
  const loadRegions: LoadRegion[] = [];
  const sections: ImageSection[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = index * slotBytes;
    const address = 0x100000n + BigInt(index) * 0x2000n;
    const mapping: FileMapping = { address, offset, size: slotBytes };
    const readable = index !== count - 2;
    mappings.push(mapping);
    loadRegions.push({
      mapping,
      memory_size: BigInt(slotBytes),
      read: readable,
      write: index > 0,
      execute: false,
    });
    sections.push({
      format: "macho",
      name: index === 0 ? "__TEXT,__rodata" : "__DATA,__data",
      section_name: index === 0 ? "__rodata" : "__data",
      type: 0,
      flags: 0,
      address,
      declared_range: { offset: BigInt(offset), size: BigInt(slotBytes) },
      segment_mapping: mapping,
      segment_unmapped: false,
      relocations: { offset: 0, count: 0 },
      offset,
      size: slotBytes,
      file_backed: true,
      read_only: index === 0,
      compressed: false,
    });
  }

  const roAddr = 0x100000n;
  const unreadableHeaderOffset = (count - 2) * slotBytes;
  bytes.writeBigUInt64LE(roAddr, unreadableHeaderOffset);
  bytes.writeBigUInt64LE(
    BigInt(literalBytes.length),
    unreadableHeaderOffset + 8,
  );

  const validHeaderOffset = (count - 1) * slotBytes;
  bytes.writeBigUInt64LE(roAddr, validHeaderOffset);
  bytes.writeBigUInt64LE(BigInt(literalBytes.length), validHeaderOffset + 8);

  const container: BinaryContainer = {
    format: "macho",
    architecture: "arm64",
    bits: 64,
    byte_order: "little",
    mappings,
    load_regions: loadRegions,
    zero_fills: [],
    sections,
  };

  const started = performance.now();
  const recovered = recoverGoStringLiterals(bytes, container);
  const elapsedMs = performance.now() - started;

  expect(elapsedMs).toBeLessThan(500);
  expect(recovered.items).toEqual([
    {
      value: literal,
      location: { offset: 0, bytes: literalBytes.length },
      first_header_offset: validHeaderOffset,
      reference_count: 1,
    },
  ]);

  let inRegionLoop = false;
  let observedRegions = 0;
  let regionCancelChecks = 0;
  let inSectionLoop = false;
  let observedSections = 0;
  const trackedLoadRegions = new Proxy(loadRegions, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/u.test(property)) {
        inRegionLoop = true;
        observedRegions += 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const trackedSections = new Proxy(sections, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/u.test(property)) {
        inSectionLoop = true;
        observedSections += 1;
      }
      return Reflect.get(target, property, receiver);
    },
  });

  expect(() =>
    recoverGoStringLiterals(
      bytes,
      {
        ...container,
        load_regions: trackedLoadRegions,
        sections: trackedSections,
      },
      GO_ANALYSIS_BUDGET_DEFAULTS,
      () => {
        if (inRegionLoop && !inSectionLoop) {
          regionCancelChecks += 1;
          if (regionCancelChecks >= 10)
            throw new Error("cancelled during region indexing");
        }
      },
    ),
  ).toThrow("cancelled during region indexing");
  expect(observedRegions).toBeGreaterThan(0);
  expect(observedRegions).toBeLessThan(count);
  expect(observedSections).toBe(0);

  inSectionLoop = false;
  observedSections = 0;
  expect(() =>
    recoverGoStringLiterals(
      bytes,
      { ...container, sections: trackedSections },
      GO_ANALYSIS_BUDGET_DEFAULTS,
      () => {
        if (inSectionLoop) throw new Error("cancelled during section indexing");
      },
    ),
  ).toThrow("cancelled during section indexing");
  expect(observedSections).toBeLessThan(count);
});

it.each([
  { target: "data", mode: "single", expected: ["macho-span-check"] },
  { target: "data", mode: "touching", expected: ["macho-span-check"] },
  { target: "data", mode: "overlapping", expected: ["macho-span-check"] },
  { target: "data", mode: "gap", expected: [] },
  { target: "data", mode: "unreadable-tail", expected: [] },
  { target: "rodata", mode: "single", expected: ["macho-span-check"] },
  { target: "rodata", mode: "touching", expected: ["macho-span-check"] },
  { target: "rodata", mode: "overlapping", expected: ["macho-span-check"] },
  { target: "rodata", mode: "gap", expected: [] },
  { target: "rodata", mode: "unreadable-tail", expected: [] },
] as const)(
  "requires contiguous readable Mach-O load_regions for $target ($mode)",
  ({ target, mode, expected }) => {
    const literal = "macho-span-check";
    const bytes = Buffer.alloc(32);
    bytes.write(literal, 0, "utf8");
    const roAddr = 0x100000n;
    const dataAddr = 0x200000n;
    bytes.writeBigUInt64LE(roAddr, 16);
    bytes.writeBigUInt64LE(16n, 24);

    const buildRegions = (
      address: bigint,
      offset: number,
      write: boolean,
      kind: "single" | "touching" | "overlapping" | "gap" | "unreadable-tail",
    ): LoadRegion[] => {
      const region = (
        delta: number,
        size: number,
        read: boolean,
      ): LoadRegion => ({
        mapping: {
          address: address + BigInt(delta),
          offset: offset + delta,
          size,
        },
        memory_size: BigInt(size),
        read,
        write,
        execute: false,
      });
      if (kind === "single") return [region(0, 16, true)];
      if (kind === "touching") return [region(0, 8, true), region(8, 8, true)];
      if (kind === "overlapping")
        return [region(0, 12, true), region(4, 12, true)];
      if (kind === "gap") return [region(0, 6, true), region(10, 6, true)];
      return [region(0, 8, true), region(8, 8, false)];
    };

    const roMapping: FileMapping = { address: roAddr, offset: 0, size: 16 };
    const dataMapping: FileMapping = {
      address: dataAddr,
      offset: 16,
      size: 16,
    };
    const container: BinaryContainer = {
      format: "macho",
      architecture: "arm64",
      bits: 64,
      byte_order: "little",
      mappings: [roMapping, dataMapping],
      load_regions: [
        ...buildRegions(
          roAddr,
          0,
          false,
          target === "rodata" ? mode : "single",
        ),
        ...buildRegions(
          dataAddr,
          16,
          true,
          target === "data" ? mode : "single",
        ),
      ],
      zero_fills: [],
      sections: [
        {
          format: "macho",
          name: "__TEXT,__rodata",
          section_name: "__rodata",
          type: 0,
          flags: 0,
          address: roAddr,
          declared_range: { offset: 0n, size: 16n },
          segment_mapping: roMapping,
          segment_unmapped: false,
          relocations: { offset: 0, count: 0 },
          offset: 0,
          size: 16,
          file_backed: true,
          read_only: true,
          compressed: false,
        },
        {
          format: "macho",
          name: "__DATA,__data",
          section_name: "__data",
          type: 0,
          flags: 0,
          address: dataAddr,
          declared_range: { offset: 16n, size: 16n },
          segment_mapping: dataMapping,
          segment_unmapped: false,
          relocations: { offset: 0, count: 0 },
          offset: 16,
          size: 16,
          file_backed: true,
          read_only: false,
          compressed: false,
        },
      ],
    };

    const recovered = recoverGoStringLiterals(bytes, container);
    expect(recovered.items.map((item) => item.value)).toEqual(expected);
  },
);

it("recovers longer literals with a selected budget without conflating offset/length identities", () => {
  const fixture = createGoRodataStringFixture({
    format: "elf",
    rodata: Buffer.alloc(9000, 0x61),
    headers: [
      { section: "data", offsetInSection: 0, ptr: 0x102000n, len: 9000n },
      { section: "data", offsetInSection: 16, ptr: 0x102001n, len: 808n },
    ],
  });
  const limited = readGoBinaryImage(fixture.bytes, {
    includeStringLiterals: true,
  });
  expect(limited.string_literals).toMatchObject({
    truncated: true,
    limits_reached: ["max_string_literal_bytes"],
  });
  const recovered = readGoBinaryImage(fixture.bytes, {
    includeStringLiterals: true,
    budgets: { max_string_literal_bytes: 9000 },
  });
  expect(recovered.string_literals).toMatchObject({
    truncated: false,
    discovered_count: 2,
  });
  expect(
    recovered.string_literals?.items.map((item) => [
      item.location.bytes,
      item.reference_count,
    ]),
  ).toEqual([
    [9000, 1],
    [808, 1],
  ]);
});
