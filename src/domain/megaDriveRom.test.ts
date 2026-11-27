import { expect, it } from "vitest";

import {
  interleaveMegaDriveSmd,
  megaDriveExternalRam,
  megaDriveRom,
} from "./megaDriveRom.fixture.js";
import {
  createMegaDriveRomDecoder,
  decodeMegaDriveRom,
  MEGA_DRIVE_MAX_ROM_BYTES,
  MEGA_DRIVE_MAX_SMD_BLOCKS,
  MEGA_DRIVE_SMD_BLOCK_BYTES,
  MEGA_DRIVE_SMD_HEADER_BYTES,
  megaDriveFileCeiling,
  megaDriveWordSum,
  recognizeMegaDriveRom,
  type MegaDriveRom,
} from "./megaDriveRom.js";

const decoded = (bytes: Uint8Array): MegaDriveRom => {
  const result = decodeMegaDriveRom(bytes);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const program = (rom: MegaDriveRom): Uint8Array => {
  const bytes = rom.regions.find((region) => region.path === "program.bin");
  if (bytes === undefined) throw new Error("missing program.bin");
  return bytes.bytes;
};

const withoutLayout = (rom: MegaDriveRom) => {
  const { layout, smd_blocks, ...metadata } = rom.metadata;
  return {
    metadata,
    limitations: rom.limitations,
    complete: rom.complete,
    layout,
    smd_blocks,
  };
};

it("reports the same header facts for a plain image and its SMD dump", () => {
  const plain = megaDriveRom({ imageBytes: MEGA_DRIVE_SMD_BLOCK_BYTES });
  const smd = interleaveMegaDriveSmd(plain);
  // Pin the fixture to the published layout rather than to this decoder:
  // each 16 KiB block stores the odd image bytes in its first 8 KiB and the
  // even ones in its second (Genesis Plus GX deinterleave_block). "SEGA" at
  // image 0x100 is therefore E, A at file 512 + 0x80 and S, G at
  // 512 + 0x2000 + 0x80.
  expect([...smd.subarray(512 + 0x80, 512 + 0x82)]).toEqual([0x45, 0x41]);
  expect([...smd.subarray(512 + 0x2080, 512 + 0x2082)]).toEqual([0x53, 0x47]);
  const plainRom = decoded(plain);
  const smdRom = decoded(smd);

  expect(plainRom.complete).toBe(true);
  expect(plainRom.limitations).toEqual([]);
  expect(plainRom.metadata).toMatchObject({
    kind: "mega-drive-rom",
    layout: "plain",
    system_kind: "mega-drive",
    system: { text: "SEGA MEGA DRIVE" },
    domestic_title: { text: "SYNTHETIC DOMESTIC" },
    overseas_title: { text: "SYNTHETIC OVERSEAS" },
    serial: { text: "GM 00000000" },
    revision: { text: "00" },
    devices: ["J"],
    unknown_device_characters: "",
    region_style: "letters",
    region_characters: ["J", "U", "E"],
    region_mask: null,
    initial_ssp: 0x00ff_0000,
    reset_pc: 0x200,
    smd_blocks: null,
    image_bytes: plain.length,
    checksum: { matches: true },
    rom: {
      start: 0,
      end: plain.length - 1,
      bus_start: 0,
      bus_end: plain.length - 1,
    },
    ram: {
      start: 0x00ff_0000,
      end: 0x00ff_ffff,
      bus_start: 0x00ff_0000,
      bus_end: 0x00ff_ffff,
    },
    external_ram: { present: false },
  });
  expect(plainRom.metadata.vectors).toHaveLength(64);
  expect(plainRom.metadata.vectors[1]).toMatchObject({
    name: "reset_pc",
    value: 0x200,
  });
  expect(plainRom.metadata.vectors[14]?.name).toBe("reserved");
  expect(plainRom.metadata.vectors[25]?.name).toBe("interrupt_level_1");
  expect(plainRom.metadata.vectors[32]?.name).toBe("trap_0");
  expect(plainRom.metadata.vectors[47]?.name).toBe("trap_15");
  expect(plainRom.metadata.vectors[63]?.name).toBe("reserved");
  expect(plainRom.metadata.system.raw_hex).toHaveLength(32);
  expect(plainRom.metadata.system.raw_hex.endsWith("20")).toBe(true);

  const plainFacts = withoutLayout(plainRom);
  const smdFacts = withoutLayout(smdRom);
  expect(smdFacts.metadata).toEqual(plainFacts.metadata);
  expect(smdFacts.limitations).toEqual(plainFacts.limitations);
  expect(smdRom.metadata.layout).toBe("smd");
  expect(smdRom.metadata.smd_blocks).toBe(1);
  expect(Buffer.from(program(smdRom)).equals(program(plainRom))).toBe(true);
  expect(Buffer.from(program(plainRom)).equals(plain)).toBe(true);
  expect(
    plainRom.regions.map((region) => [region.path, region.fileOffset]),
  ).toEqual([
    ["vectors.bin", 0],
    ["header.bin", 0x100],
    ["program.bin", 0],
  ]);
  expect(smdRom.regions.every((region) => region.fileOffset === null)).toBe(
    true,
  );
});

it("names Genesis, 32X and Sega CD from the system string", () => {
  expect(
    decoded(megaDriveRom({ system: "SEGA GENESIS" })).metadata.system_kind,
  ).toBe("genesis");
  const thirtyTwoX = decoded(megaDriveRom({ system: "SEGA 32X" }));
  expect(thirtyTwoX.metadata.system_kind).toBe("32x");
  expect(thirtyTwoX.limitations.join("\n")).toContain("32X");
  expect(thirtyTwoX.complete).toBe(false);
  const cd = decoded(megaDriveRom({ system: "SEGA MEGA-CD" }));
  expect(cd.metadata.system_kind).toBe("sega-cd");
  expect(cd.limitations.join("\n")).toContain("Sega CD");
  const other = decoded(megaDriveRom({ system: "SEGA SOMETHING" }));
  expect(other.metadata.system_kind).toBe("other");
  expect(other.limitations.join("\n")).not.toContain("32X");
});

it("sums big-endian words through the inclusive ROM end with 16-bit wraparound", () => {
  const image = new Uint8Array(0x208);
  image.set([0x12, 0x34, 0x00, 0x01, 0xff, 0xff, 0xab, 0xcd], 0x200);
  // 0x1234 + 0x0001 + 0xffff wraps mod 2^16 back to 0x1234.
  expect(megaDriveWordSum(image, 0x205)).toEqual({
    computed: 0x1234,
    summedBytes: 6,
    empty: false,
    bounded: false,
  });
  // Half word at the end is skipped.
  expect(megaDriveWordSum(image, 0x206).computed).toBe(0x1234);
  expect(megaDriveWordSum(image, 0x207).computed).toBe(0xbe01);
  expect(megaDriveWordSum(image, 0x2ff)).toEqual({
    computed: 0xbe01,
    summedBytes: 8,
    empty: false,
    bounded: true,
  });
  expect(megaDriveWordSum(image, 0x1ff)).toEqual({
    computed: 0,
    summedBytes: 0,
    empty: true,
    bounded: false,
  });
});

it("reports a checksum mismatch and keeps a matching bounded sum", () => {
  const baseline = decoded(megaDriveRom());
  expect(baseline.metadata.checksum.computed).toBe(0x8000);
  expect(baseline.metadata.checksum.declared).toBe(0x8000);

  const mismatch = decoded(megaDriveRom({ checksum: 0x1234 }));
  expect(mismatch.metadata.checksum.matches).toBe(false);
  expect(mismatch.metadata.checksum.declared).toBe(0x1234);
  expect(mismatch.limitations.join("\n")).toContain("does not match");
  expect(mismatch.complete).toBe(false);

  const past = decoded(megaDriveRom({ romEnd: 0x1_0000 }));
  expect(past.metadata.checksum.matches).toBe(true);
  expect(past.metadata.checksum.summed_bytes).toBe(0x400 - 0x200);
  expect(past.limitations.join("\n")).toContain("past the image");
  expect(past.limitations.join("\n")).toContain("longer than");
});

it("flags ROM and RAM ranges that disagree with the image", () => {
  const reversed = decoded(megaDriveRom({ romStart: 0x1000, romEnd: 0x10 }));
  const text = reversed.limitations.join("\n");
  expect(text).toContain("before ROM start");
  expect(text).not.toContain("longer than");
  expect(text).toContain("below 0x200");
  expect(reversed.metadata.checksum.computed).toBe(0);

  const ram = decoded(megaDriveRom({ ramStart: 0xff, ramEnd: 0x10 }));
  expect(ram.limitations.join("\n")).toContain("before RAM start");
  expect(ram.limitations.join("\n")).not.toContain("64 KiB work RAM");

  // RAM endpoints with different top-byte aliases order on the bus: this is
  // the 0xFF0000-0xFFFFFF work RAM. The declared values are kept.
  const aliasedRam = decoded(
    megaDriveRom({ ramStart: 0xe0ff_0000, ramEnd: 0x00ff_ffff }),
  );
  expect(aliasedRam.limitations.join("\n")).not.toContain("before RAM start");
  expect(aliasedRam.limitations.join("\n")).not.toContain("64 KiB work RAM");
  expect(aliasedRam.metadata.ram).toMatchObject({
    start: 0xe0ff_0000,
    end: 0x00ff_ffff,
  });

  const oversizedRam = decoded(
    megaDriveRom({ ramStart: 0, ramEnd: 0xffff_ffff }),
  );
  expect(oversizedRam.complete).toBe(false);
  expect(oversizedRam.limitations.join("\n")).toContain("64 KiB work RAM");
  expect(oversizedRam.metadata.ram).toMatchObject({
    start: 0,
    end: 0xffff_ffff,
  });

  // SGDK declares work RAM with a nonzero top byte, which the 68000's 24-bit
  // bus ignores; the declared values are kept as written.
  const sgdkRam = decoded(
    megaDriveRom({ ramStart: 0xe0ff_0000, ramEnd: 0xe0ff_ffff }),
  );
  expect(sgdkRam.limitations.join("\n")).not.toContain("64 KiB work RAM");
  expect(sgdkRam.metadata.ram).toMatchObject({
    start: 0xe0ff_0000,
    end: 0xe0ff_ffff,
  });
  // Work RAM is mirrored every 64 KiB through 0xE00000-0xFFFFFF (Genesis
  // Plus GX gen_init), so a lower mirror is the same RAM; a range larger
  // than the 64 KiB RAM still is not.
  const mirroredRam = decoded(
    megaDriveRom({ ramStart: 0x00e0_0000, ramEnd: 0x00e0_ffff }),
  );
  expect(mirroredRam.limitations.join("\n")).not.toContain("64 KiB work RAM");
  expect(mirroredRam.metadata.ram).toMatchObject({
    start: 0x00e0_0000,
    end: 0x00e0_ffff,
  });
  const wholeMirror = decoded(
    megaDriveRom({ ramStart: 0x00e0_0000, ramEnd: 0x00ff_ffff }),
  );
  expect(wholeMirror.limitations.join("\n")).toContain("64 KiB work RAM");

  const wrappedRam = decoded(
    megaDriveRom({ ramStart: 0x00ff_0000, ramEnd: 0x0100_0000 }),
  );
  // 0x01000000 drives bus address 0x000000, below the start.
  expect(wrappedRam.limitations.join("\n")).toContain("before RAM start");

  const wrongRam = decoded(megaDriveRom({ ramStart: 0, ramEnd: 0xffff }));
  expect(wrongRam.complete).toBe(false);
  expect(wrongRam.limitations.join("\n")).toContain("64 KiB work RAM");
  expect(wrongRam.metadata.ram).toMatchObject({ start: 0, end: 0xffff });

  const trailing = decoded(megaDriveRom({ romEnd: 0x2ff }));
  expect(trailing.metadata.checksum.matches).toBe(true);
  expect(trailing.metadata.checksum.computed).toBe(0xc000);
  expect(trailing.limitations.join("\n")).toContain("stay in program.bin");
  expect(trailing.limitations.join("\n")).not.toContain("past the image");

  const shifted = decoded(megaDriveRom({ romStart: 0x200 }));
  expect(shifted.limitations.join("\n")).toContain("file offset 0 is mapped");
});

it("keeps raw bytes for an unprintable field and an unknown device letter", () => {
  const image = megaDriveRom({ devices: "JZ" });
  image[0x120] = 0x01;
  const rom = decoded(image);
  expect(rom.metadata.domestic_title.text.startsWith("?")).toBe(true);
  expect(rom.metadata.domestic_title.raw_hex.startsWith("01")).toBe(true);
  expect(rom.metadata.devices).toEqual(["J"]);
  expect(rom.metadata.unknown_device_characters).toBe("Z");
  const text = rom.limitations.join("\n");
  expect(text).toContain("domestic title");
  expect(text).toContain("outside the known set (Z)");
});

it("structures a known external RAM descriptor and reports an unknown type", () => {
  const present = decoded(
    megaDriveRom({
      externalRam: megaDriveExternalRam(0xf8, 0x20_0000, 0x20_ffff),
    }),
  );
  expect(present.metadata.external_ram).toEqual({
    present: true,
    raw_hex: present.metadata.external_ram.raw_hex,
    type: 0xf8,
    battery_backed: true,
    access: "byte-odd",
    start: 0x20_0000,
    end: 0x20_ffff,
  });
  expect(present.metadata.external_ram.raw_hex).toHaveLength(24);
  expect(present.complete).toBe(true);

  const unknown = decoded(
    megaDriveRom({
      externalRam: megaDriveExternalRam(0x11, 0x20_0000, 0x20_0000),
    }),
  );
  expect(unknown.metadata.external_ram).toMatchObject({
    present: true,
    type: 0x11,
    battery_backed: null,
    access: null,
    start: 0x20_0000,
    end: 0x20_0000,
  });
  expect(unknown.limitations.join("\n")).toContain("type byte 0x11");

  const backwards = decoded(
    megaDriveRom({
      externalRam: megaDriveExternalRam(0xa0, 0x20_00ff, 0x20_0000),
    }),
  );
  expect(backwards.limitations.join("\n")).toContain("External RAM end");

  // Endpoints that alias through different top bytes are ordered on the
  // 68000's 24-bit bus, as the cartridge sees them.
  const aliased = decoded(
    megaDriveRom({
      externalRam: megaDriveExternalRam(0xf8, 0xff20_0000, 0x0020_ffff),
    }),
  );
  expect(aliased.limitations.join("\n")).not.toContain("External RAM end");
  expect(aliased.metadata.external_ram).toMatchObject({
    start: 0xff20_0000,
    end: 0x0020_ffff,
  });
});

it("classifies region letters, one hex digit and other text", () => {
  expect(decoded(megaDriveRom({ regions: "JA" })).metadata).toMatchObject({
    region_style: "letters",
    region_mask: null,
    region_characters: ["J", "A"],
  });
  // A, B and E are both a classic letter and a one-digit mask (Genesis Plus
  // GX reads a lone E as Europe and a lone A or B as a mask), so a lone one
  // keeps both readings and is not reported as decoded.
  for (const [letter, mask] of [
    ["A", 0xa],
    ["B", 0xb],
    ["E", 0xe],
  ] as const) {
    const ambiguous = decoded(megaDriveRom({ regions: letter }));
    expect(ambiguous.metadata).toMatchObject({
      region_style: "ambiguous",
      region_mask: mask,
      region_characters: [letter],
    });
    expect(ambiguous.complete).toBe(false);
    expect(ambiguous.limitations.join("\n")).toContain(
      `reads either as the classic region letter ${letter}`,
    );
  }
  expect(decoded(megaDriveRom({ regions: "U" })).metadata).toMatchObject({
    region_style: "letters",
    region_mask: null,
  });
  expect(decoded(megaDriveRom({ regions: "F" })).metadata).toMatchObject({
    region_style: "hex",
    region_mask: 15,
    region_characters: ["F"],
  });
  expect(decoded(megaDriveRom({ regions: "" })).metadata.region_style).toBe(
    "empty",
  );
  expect(decoded(megaDriveRom({ regions: "Z" })).metadata.region_style).toBe(
    "other",
  );
});

it("compares the reset PC with the ROM range on the 68000's 24-bit bus", () => {
  // The top byte is not driven, so 0xFF000200 fetches from 0x200, inside
  // the default 0x0-0x3FF ROM range. The declared vector is kept as written.
  const highByte = decoded(megaDriveRom({ resetPc: 0xff00_0200 }));
  expect(highByte.limitations.join("\n")).not.toContain(
    "outside the declared ROM range",
  );
  expect(highByte.complete).toBe(true);
  expect(highByte.metadata.reset_pc).toBe(0xff00_0200);
  expect(highByte.metadata.reset_pc_bus).toBe(0x200);
  // An aliased ROM start: the bus start is where a raw m68k load maps
  // file offset 0, and the reset PC lands inside that loaded range.
  const aliasedRom = decoded(
    megaDriveRom({ romStart: 0xff00_0000, romEnd: 0xff00_03ff }),
  );
  expect(aliasedRom.metadata.rom).toEqual({
    start: 0xff00_0000,
    end: 0xff00_03ff,
    bus_start: 0,
    bus_end: 0x3ff,
  });
  expect(aliasedRom.metadata.reset_pc_bus).toBe(0x200);
  expect(
    decoded(megaDriveRom({ resetPc: 0xff00_0400 })).limitations.join("\n"),
  ).toContain("outside the declared ROM range");
});

it("reads the ROM range and checksum window on the 68000's 24-bit bus", () => {
  // 0xFF000000-0xFF0002FF is bus 0x0-0x2FF, so the checksum stops at image
  // offset 0x2FF, exactly as with the zero-top-byte form.
  const highEnd = decoded(
    megaDriveRom({
      romStart: 0xff00_0000,
      romEnd: 0xff00_02ff,
      checksum: 0xc000,
    }),
  );
  expect(highEnd.metadata.checksum.computed).toBe(0xc000);
  expect(highEnd.metadata.checksum.matches).toBe(true);
  expect(highEnd.metadata.checksum.summed_bytes).toBe(0x100);
  expect(highEnd.metadata.rom).toEqual({
    start: 0xff00_0000,
    end: 0xff00_02ff,
    bus_start: 0,
    bus_end: 0x2ff,
  });
  const highEndText = highEnd.limitations.join("\n");
  expect(highEndText).toContain("stay in program.bin");
  expect(highEndText).not.toContain("past the image");
  expect(highEndText).not.toContain("file offset 0 is mapped");

  const fullAlias = decoded(
    megaDriveRom({ romStart: 0xff00_0000, romEnd: 0xff00_03ff }),
  );
  expect(fullAlias.limitations).toEqual([]);
  expect(fullAlias.complete).toBe(true);
  expect(fullAlias.metadata.checksum.summed_bytes).toBe(0x200);

  expect(
    decoded(megaDriveRom({ romStart: 0xff00_0200 })).limitations.join("\n"),
  ).toContain("file offset 0 is mapped");
});

it("flags an odd reset PC and a reset PC outside the ROM range", () => {
  expect(
    decoded(megaDriveRom({ resetPc: 0x201 })).limitations.join("\n"),
  ).toContain("odd");
  expect(
    decoded(megaDriveRom({ resetPc: 0x10_0000 })).limitations.join("\n"),
  ).toContain("outside the declared ROM range");
});

it("notes an SMD split flag and still returns one image", () => {
  const plain = megaDriveRom({ imageBytes: MEGA_DRIVE_SMD_BLOCK_BYTES });
  const intact = interleaveMegaDriveSmd(plain);
  expect(intact[1]).toBe(0x03);
  expect(intact[2]).toBe(0x00);
  expect(decoded(intact).limitations).toEqual([]);
  expect(decoded(interleaveMegaDriveSmd(plain, 0x01)).limitations).toEqual([]);
  const splitFile = interleaveMegaDriveSmd(plain, 0x40);
  expect(splitFile[1]).toBe(0x03);
  expect(splitFile[2]).toBe(0x40);
  const smd = decoded(splitFile);
  expect(smd.limitations).toEqual([
    "SMD copier header byte 2 is 0x40, so more split parts follow; the file is still read as one image.",
  ]);
  expect(smd.complete).toBe(false);
  expect(Buffer.from(program(smd)).equals(plain)).toBe(true);
});

it("refuses a truncated plain header", () => {
  const bytes = megaDriveRom().subarray(0, 0x180);
  expect(recognizeMegaDriveRom(bytes, bytes.length)).toBe("plain");
  const result = decodeMegaDriveRom(bytes);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatchObject({
    kind: "truncated",
    extent: { availableBytes: 0x180, requiredBytes: 0x200 },
  });
});

it("recognizes SMD from the prefix bytes classification can see", () => {
  const smd = interleaveMegaDriveSmd(
    megaDriveRom({ imageBytes: MEGA_DRIVE_SMD_BLOCK_BYTES }),
  );
  expect(recognizeMegaDriveRom(smd.subarray(0, 4096), smd.length)).toBe("smd");
  expect(recognizeMegaDriveRom(smd.subarray(0, 8192), smd.length)).toBe("smd");
  expect(
    recognizeMegaDriveRom(smd.subarray(0, 512), smd.length),
  ).toBeUndefined();
  const wrongCount = Buffer.from(smd);
  wrongCount[0] = 0;
  expect(recognizeMegaDriveRom(wrongCount, wrongCount.length)).toBeUndefined();
  const plain = megaDriveRom({
    imageBytes: MEGA_DRIVE_SMD_HEADER_BYTES + MEGA_DRIVE_SMD_BLOCK_BYTES,
  });
  plain[0] = 1;
  plain[8] = 0xaa;
  plain[9] = 0xbb;
  expect(recognizeMegaDriveRom(plain, plain.length)).toBe("plain");
  const unaligned = Buffer.alloc(
    MEGA_DRIVE_SMD_HEADER_BYTES + MEGA_DRIVE_SMD_BLOCK_BYTES + 1,
  );
  unaligned[0] = 1;
  unaligned[8] = 0xaa;
  unaligned[9] = 0xbb;
  unaligned[640] = 0x45;
  unaligned[641] = 0x41;
  expect(recognizeMegaDriveRom(unaligned, unaligned.length)).toBeUndefined();
  const oversizeBlocks = MEGA_DRIVE_MAX_SMD_BLOCKS + 1;
  const oversizePrefix = Buffer.alloc(4096);
  oversizePrefix[0] = oversizeBlocks & 0xff;
  oversizePrefix[8] = 0xaa;
  oversizePrefix[9] = 0xbb;
  oversizePrefix[640] = 0x45;
  oversizePrefix[641] = 0x41;
  expect(
    recognizeMegaDriveRom(
      oversizePrefix,
      MEGA_DRIVE_SMD_HEADER_BYTES + oversizeBlocks * MEGA_DRIVE_SMD_BLOCK_BYTES,
    ),
  ).toBe("smd");
});

const smdMaxFileBytes = (): number =>
  MEGA_DRIVE_SMD_HEADER_BYTES +
  MEGA_DRIVE_MAX_SMD_BLOCKS * MEGA_DRIVE_SMD_BLOCK_BYTES;

it("rejects oversize files before allocating them", () => {
  const smdMax = smdMaxFileBytes();
  expect(megaDriveFileCeiling(MEGA_DRIVE_MAX_ROM_BYTES)).toBeUndefined();
  expect(megaDriveFileCeiling(smdMax)).toMatchObject({
    ceiling: "rom-bytes",
  });
  expect(megaDriveFileCeiling(smdMax, "plain")).toMatchObject({
    ceiling: "rom-bytes",
  });
  expect(megaDriveFileCeiling(smdMax, "smd")).toBeUndefined();
  const rom = createMegaDriveRomDecoder(MEGA_DRIVE_MAX_ROM_BYTES + 1);
  expect(rom.ok).toBe(false);
  if (!rom.ok)
    expect(rom.error).toMatchObject({
      kind: "limit",
      boundary: "file-size",
      ceiling: "rom-bytes",
    });
  const blocks = createMegaDriveRomDecoder(
    MEGA_DRIVE_SMD_HEADER_BYTES +
      (MEGA_DRIVE_MAX_SMD_BLOCKS + 1) * MEGA_DRIVE_SMD_BLOCK_BYTES,
  );
  expect(blocks.ok).toBe(false);
  if (!blocks.ok)
    expect(blocks.error).toMatchObject({
      kind: "limit",
      boundary: "file-size",
      ceiling: "smd-blocks",
    });
  const candidate = createMegaDriveRomDecoder(smdMax);
  expect(candidate.ok).toBe(true);
  if (!candidate.ok) return;
  const plainPrefix = new Uint8Array(4096);
  plainPrefix.set([0x53, 0x45, 0x47, 0x41], 0x100);
  const refused = candidate.value.write(plainPrefix);
  expect(refused.ok).toBe(false);
  if (!refused.ok)
    expect(refused.error).toMatchObject({
      kind: "limit",
      boundary: "file-size",
      ceiling: "rom-bytes",
    });
});

it("holds a plain image of SMD size to the ROM byte ceiling", () => {
  const bytes = new Uint8Array(smdMaxFileBytes());
  bytes.set([0x53, 0x45, 0x47, 0x41], 0x100);
  const result = decodeMegaDriveRom(bytes);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatchObject({
    kind: "limit",
    boundary: "file-size",
    ceiling: "rom-bytes",
  });
});

it("keeps an SMD-sized file once the header is an SMD dump", () => {
  const decoder = createMegaDriveRomDecoder(smdMaxFileBytes());
  expect(decoder.ok).toBe(true);
  if (!decoder.ok) return;
  const prefix = new Uint8Array(4096);
  prefix[0] = MEGA_DRIVE_MAX_SMD_BLOCKS & 0xff;
  prefix[1] = 0x03;
  prefix[8] = 0xaa;
  prefix[9] = 0xbb;
  prefix[640] = 0x45;
  prefix[641] = 0x41;
  const written = decoder.value.write(prefix);
  expect(written.ok).toBe(true);
  if (!written.ok) return;
  // The prefix is a real SMD header, so the plain ceiling does not apply.
  // The rest of the image is absent, which is a malformed ROM, not a limit.
  const finished = decoder.value.finish();
  expect(finished.ok).toBe(false);
  if (finished.ok) return;
  expect(finished.error.kind).toBe("malformed");
});
