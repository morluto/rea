import { expect, it } from "vitest";
import {
  MAX_GO_STRING_AGGREGATE_BYTES,
  MAX_GO_STRING_LITERAL_BYTES,
} from "../domain/go/goBinary.js";
import { createGoRodataStringFixture } from "../../tests/fixtures/go/rodataStringImage.js";
import { readGoBinaryImage } from "./GoBinaryImage.js";

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

it("rejects unaligned, code-section, cross-section, out-of-bounds and non-printable UTF-8 candidates", () => {
  const validUnicode = Buffer.from("café\t日本語\n", "utf8");
  const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x41]);
  const embeddedNul = Buffer.from("bad\0str", "utf8");
  const c1Control = Buffer.from([0xc2, 0x85]);
  const noncharacter = Buffer.from([0xef, 0xbf, 0xbf]);
  const maxAllowed = Buffer.alloc(MAX_GO_STRING_LITERAL_BYTES, 0x61);
  const overMax = Buffer.alloc(MAX_GO_STRING_LITERAL_BYTES + 1, 0x62);
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
        len: BigInt(MAX_GO_STRING_LITERAL_BYTES),
      },
      {
        section: "data",
        offsetInSection: 32,
        ptr: baseRo + BigInt(badPrefixLen + maxAllowed.length),
        len: BigInt(MAX_GO_STRING_LITERAL_BYTES + 1),
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
    "a".repeat(MAX_GO_STRING_LITERAL_BYTES),
  ]);
  expect(recovered?.truncated).toBe(false);
});

it("enforces maxStringLiterals and the 512 KiB aggregate byte cap deterministically", () => {
  const chunks = Array.from({ length: 130 }, (_, index) =>
    Buffer.from(
      `${String(index).padStart(4, "0")}:${"x".repeat(MAX_GO_STRING_LITERAL_BYTES - 5)}`,
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
    maxStringLiterals: 2,
  });
  expect(cappedByCount.macho_chained_fixups).toBe(true);
  expect(cappedByCount.string_literals).toMatchObject({
    discovered_count: 130,
    max_items: 2,
    truncated: true,
    aggregate_bytes: MAX_GO_STRING_LITERAL_BYTES * 2,
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
    maxStringLiterals: 500,
  });
  expect(cappedByBytes.string_literals).toMatchObject({
    discovered_count: 130,
    max_items: 500,
    aggregate_bytes: MAX_GO_STRING_AGGREGATE_BYTES,
    truncated: true,
  });
  expect(cappedByBytes.string_literals?.items).toHaveLength(
    MAX_GO_STRING_AGGREGATE_BYTES / MAX_GO_STRING_LITERAL_BYTES,
  );
});
