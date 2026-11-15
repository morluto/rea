import { expect, it } from "vitest";
import { inesInventorySchema, parseInesLayout } from "./inesContainer.js";

const header = (): Buffer => {
  const bytes = Buffer.alloc(16);
  bytes.write("NES\x1a", "latin1");
  bytes[4] = 1;
  return bytes;
};

/** NES 2.0 identifier in byte 7 plus caller-selected header bytes. */
const nes2Header = (bytes: Readonly<Record<number, number>> = {}): Buffer => {
  const prefix = header();
  prefix[7] = 0x08;
  for (const [index, value] of Object.entries(bytes))
    prefix[Number(index)] = value;
  return prefix;
};

const layout = (prefix: Buffer, size: number) => {
  const parsed = parseInesLayout(prefix, size);
  if (!parsed.ok) throw new Error(parsed.error.detail);
  expect(inesInventorySchema.shape.header.parse(parsed.value.header)).toEqual(
    parsed.value.header,
  );
  return parsed.value;
};

it("bounds the complete classic header count without inventing RAM regions", () => {
  const bytes = header();
  bytes[4] = 255;
  bytes[5] = 255;
  bytes[6] = 0xfe;
  bytes[7] = 0xf3;
  const parsed = parseInesLayout(bytes, 16 + 512 + 255 * (16_384 + 8_192));
  if (!parsed.ok) throw new Error(parsed.error.detail);
  expect(parsed.value.header).toMatchObject({
    mapper: 255,
    trainer_present: true,
    battery_flag: true,
    mirroring: "four-screen",
  });
  expect(parsed.value.regions).toHaveLength(512);
  expect(parsed.value.regions.at(-1)).toMatchObject({
    path: "chr/254.bin",
    length: 8_192,
  });
});

it("keeps the classic header serialization unchanged", () => {
  const bytes = header();
  bytes[4] = 2;
  bytes[5] = 1;
  bytes[6] = 0x31;
  bytes[7] = 0x10;
  const parsed = layout(bytes, 16 + 2 * 16_384 + 8_192 + 3);
  expect(JSON.stringify(parsed.header)).toBe(
    `{"format":"ines","header_hex":"${bytes.toString("hex")}","prg_rom_units_16k":2,"chr_rom_units_8k":1,"mapper":19,"flags_6":49,"flags_7":16,"trainer_present":false,"battery_flag":false,"mirroring":"vertical"}`,
  );
  expect(parsed.regions.map(({ path }) => path)).toEqual([
    "header.bin",
    "prg/000.bin",
    "prg/001.bin",
    "chr/000.bin",
    "trailing.bin",
  ]);
});

it("reports 12-bit NES 2.0 sizes and mapper with declared memory and timing", () => {
  const bytes = nes2Header({
    4: 0x02,
    5: 0x01,
    6: 0x53,
    7: 0x48,
    8: 0x31,
    9: 0x01,
    10: 0x97,
    11: 0x07,
    12: 0x01,
    15: 0x01,
  });
  const prgBytes = 0x102 * 16_384;
  const parsed = layout(bytes, 16 + prgBytes + 8_192 + 5);
  expect(parsed.header).toEqual({
    format: "nes-2.0",
    header_hex: bytes.toString("hex"),
    prg_rom_units_16k: 0x102,
    chr_rom_units_8k: 1,
    prg_rom_bytes: prgBytes,
    chr_rom_bytes: 8_192,
    mapper: 0x145,
    submapper: 3,
    flags_6: 0x53,
    flags_7: 0x48,
    trainer_present: false,
    battery_flag: true,
    mirroring: "vertical",
    console_type: "nes-famicom",
    cpu_ppu_timing: "pal",
    prg_ram_bytes: 8_192,
    prg_nvram_bytes: 32_768,
    chr_ram_bytes: 8_192,
    chr_nvram_bytes: 0,
    misc_rom_count: 0,
    default_expansion_device: 1,
  });
  // Declared RAM sizes are facts about the header, never file regions.
  expect(parsed.regions).toHaveLength(1 + 0x102 + 1 + 1);
  expect(parsed.regions.at(-3)).toEqual({
    path: "prg/257.bin",
    offset: 16 + 257 * 16_384,
    length: 16_384,
  });
  expect(parsed.regions.slice(-2)).toEqual([
    { path: "chr/000.bin", offset: 16 + prgBytes, length: 8_192 },
    { path: "trailing.bin", offset: 16 + prgBytes + 8_192, length: 5 },
  ]);
});

it("sizes exponent-multiplier ROM areas as single regions without unit counts", () => {
  // PRG 2^10 * 3 bytes and CHR 2^9 * 1 bytes.
  const bytes = nes2Header({ 4: (10 << 2) | 1, 5: 9 << 2, 9: 0xff });
  const parsed = layout(bytes, 16 + 3_072 + 512);
  expect(parsed.header).toMatchObject({
    format: "nes-2.0",
    prg_rom_bytes: 3_072,
    chr_rom_bytes: 512,
  });
  expect(parsed.header).not.toHaveProperty("prg_rom_units_16k");
  expect(parsed.header).not.toHaveProperty("chr_rom_units_8k");
  expect(parsed.regions).toEqual([
    { path: "header.bin", offset: 0, length: 16 },
    { path: "prg.bin", offset: 16, length: 3_072 },
    { path: "chr.bin", offset: 3_088, length: 512 },
  ]);
});

it("retains declared miscellaneous ROM bytes after a trainer and CHR-ROM", () => {
  const bytes = nes2Header({ 5: 0, 6: 0x04, 14: 2 });
  const parsed = layout(bytes, 16 + 512 + 16_384 + 700);
  expect(parsed.header).toMatchObject({
    trainer_present: true,
    chr_rom_units_8k: 0,
    chr_rom_bytes: 0,
    misc_rom_count: 2,
  });
  expect(parsed.regions).toEqual([
    { path: "header.bin", offset: 0, length: 16 },
    { path: "trainer.bin", offset: 16, length: 512 },
    { path: "prg/000.bin", offset: 528, length: 16_384 },
    { path: "misc-rom.bin", offset: 16_912, length: 700 },
  ]);
});

it.each([
  {
    flags7: 0x09,
    byte13: 0x52,
    facts: {
      console_type: "vs-system",
      vs_ppu_type: 2,
      vs_hardware_type: 5,
    },
  },
  {
    flags7: 0x0b,
    byte13: 0x0a,
    facts: { console_type: "extended", extended_console_type: 10 },
  },
  { flags7: 0x0a, byte13: 0, facts: { console_type: "playchoice-10" } },
])(
  "reports byte 13 only for the declared $facts.console_type console",
  ({ flags7, byte13, facts }) => {
    const parsed = layout(nes2Header({ 7: flags7, 13: byte13 }), 16_400);
    expect(parsed.header).toMatchObject(facts);
    for (const field of [
      "vs_ppu_type",
      "vs_hardware_type",
      "extended_console_type",
    ])
      if (!(field in facts)) expect(parsed.header).not.toHaveProperty(field);
  },
);

it.each([
  {
    label: "short header",
    modify: (bytes: Buffer) => bytes.subarray(0, 8),
    size: 8,
    reason: "truncated iNES header",
    kind: "truncated",
  },
  {
    label: "short payload",
    modify: (bytes: Buffer) => bytes,
    size: 16,
    reason: "truncated iNES payload",
    kind: "truncated",
  },
  {
    label: "dirty legacy header",
    modify: (bytes: Buffer) => {
      bytes[12] = 1;
      return bytes;
    },
    size: 16_400,
    reason: "ambiguous iNES mapper",
    kind: "malformed",
  },
  {
    label: "empty PRG",
    modify: (bytes: Buffer) => {
      bytes[4] = 0;
      return bytes;
    },
    size: 16,
    reason: "at least one PRG",
    kind: "malformed",
  },
  {
    label: "unsupported variant",
    modify: (bytes: Buffer) => {
      bytes[7] = 4;
      return bytes;
    },
    size: 16_400,
    reason: "unsupported iNES header variant",
    kind: "unsupported",
  },
  {
    label: "unsafe extent",
    modify: (bytes: Buffer) => bytes,
    size: Number.MAX_SAFE_INTEGER + 1,
    reason: "invalid iNES file extent",
    kind: "malformed",
  },
  {
    label: "UNIF",
    modify: () => Buffer.from("UNIF"),
    size: 16_400,
    reason: "unif",
    kind: "unsupported",
  },
  {
    label: "oversized NES 2.0 PRG-ROM",
    modify: () => nes2Header({ 9: 0x01 }),
    size: 16_400,
    reason: `truncated NES 2.0 payload: header declares ${16 + 0x101 * 16_384} bytes; file has 16400`,
    kind: "truncated",
  },
  {
    label: "NES 2.0 exponent beyond safe integers",
    // 2^63 * 7 bytes is exact as a declaration and never truncated to a number.
    modify: () => nes2Header({ 4: 0xff, 9: 0x0f }),
    size: 16_400,
    reason: `header declares ${16n + 2n ** 63n * 7n} bytes`,
    kind: "truncated",
  },
  {
    label: "empty NES 2.0 PRG",
    modify: () => nes2Header({ 4: 0 }),
    size: 16,
    reason: "NES 2.0 requires at least one PRG-ROM unit",
    kind: "malformed",
  },
  {
    label: "absent NES 2.0 miscellaneous ROM bytes",
    modify: () => nes2Header({ 14: 1 }),
    size: 16_400,
    reason: "declares 1 miscellaneous ROM but no bytes follow CHR-ROM",
    kind: "truncated",
  },
  ...(
    [
      [12, 0x04],
      [13, 0x01],
      [14, 0x04],
      [15, 0x40],
    ] as const
  ).map(([index, value]) => ({
    label: `reserved NES 2.0 byte ${index} bits`,
    modify: () => nes2Header({ [index]: value }),
    size: 16_400,
    reason: `reserved NES 2.0 header bits are nonzero in byte ${index}`,
    kind: "malformed",
  })),
  {
    label: "reserved NES 2.0 extended console bits",
    modify: () => nes2Header({ 7: 0x0b, 13: 0x10 }),
    size: 16_400,
    reason: "reserved NES 2.0 header bits are nonzero in byte 13",
    kind: "malformed",
  },
])(
  "refuses $label before producing regions",
  ({ modify, size, reason, kind }) => {
    expect(parseInesLayout(modify(header()), size)).toMatchObject({
      ok: false,
      error: { kind, format: "ines", detail: expect.stringContaining(reason) },
    });
  },
);
