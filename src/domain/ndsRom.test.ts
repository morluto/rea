import { describe, expect, it } from "vitest";

import {
  NDS_FIXTURE,
  ndsRomFixture,
  resealNdsHeader,
} from "./ndsRom.fixture.js";
import { recognizeArtifactFormat } from "./artifactFormatRecognition.js";
import {
  hasNdsHeader,
  NDS_LIMITATION_EXAMPLES,
  ndsCrc16,
  ndsTableReadRange,
  parseNdsHeader,
  parseNdsLayout,
  type NdsTables,
} from "./ndsRom.js";

const tablesOf = (rom: Buffer): NdsTables => {
  const header = parseNdsHeader(rom).metadata;
  const slice = (table: { offset: number; length: number }) =>
    rom.subarray(table.offset, table.offset + table.length);
  return {
    fnt: slice(header.fnt),
    fat: slice(header.fat),
    arm9Overlays: slice(header.arm9_overlay_table),
    arm7Overlays: slice(header.arm7_overlay_table),
  };
};

const layoutOf = (rom: Buffer) =>
  parseNdsLayout(parseNdsHeader(rom), tablesOf(rom), rom.length);

describe("DS cartridge header", () => {
  it("computes CRC-16/MODBUS", () => {
    expect(ndsCrc16(Buffer.from("123456789", "latin1"))).toBe(0x4b37);
  });

  it("recognizes the synthetic ROM by its logo CRC and checksum", () => {
    const rom = ndsRomFixture();
    expect(hasNdsHeader(rom)).toBe(true);
    expect(
      recognizeArtifactFormat({
        prefix: rom.subarray(0, 4096),
        fileSize: rom.length,
        // Routes that look for an ESP flash layout find none in a DS ROM.
        espFlashLayout: false,
      }),
    ).toMatchObject({ state: "recognized", format: "nds" });
  });

  it("does not claim bytes whose stored logo CRC is not 0xCF56", () => {
    const rom = ndsRomFixture();
    rom.writeUInt16LE(0x1234, 0x15c);
    expect(hasNdsHeader(resealNdsHeader(rom))).toBe(false);
    expect(hasNdsHeader(Buffer.alloc(0x200))).toBe(false);
  });

  it("reports identity, CPU binaries and table locations as declared", () => {
    const { metadata, limitations } = parseNdsHeader(ndsRomFixture());
    expect(limitations).toEqual([]);
    expect(metadata).toMatchObject({
      title: "REA TEST",
      game_code: "REAE",
      maker_code: "01",
      unit: "nds",
      rom_version: 1,
      arm9: {
        rom_offset: NDS_FIXTURE.arm9.offset,
        entry_address: NDS_FIXTURE.arm9.entry,
        ram_address: NDS_FIXTURE.arm9.ram,
        size: NDS_FIXTURE.arm9.size,
      },
      arm7: {
        rom_offset: NDS_FIXTURE.arm7.offset,
        size: NDS_FIXTURE.arm7.size,
      },
      fnt: { offset: NDS_FIXTURE.fnt, length: NDS_FIXTURE.fntSize },
      logo_crc: { declared: 0xcf56, computed: 0xcf56 },
    });
    expect(metadata.header_crc.declared).toBe(metadata.header_crc.computed);
  });

  it("reports a header CRC mismatch as a limitation, not a refusal", () => {
    const rom = ndsRomFixture();
    rom.writeUInt16LE(rom.readUInt16LE(0x15e) ^ 0xffff, 0x15e);
    expect(hasNdsHeader(rom)).toBe(true);
    const { metadata, limitations } = parseNdsHeader(rom);
    expect(metadata.header_crc.declared).not.toBe(metadata.header_crc.computed);
    expect(limitations).toEqual([
      expect.stringContaining("DS header CRC does not match"),
    ]);
    // Every region offset comes from those header fields.
    const layout = layoutOf(rom);
    expect(layout.complete).toBe(false);
    expect(layout.limitations).toEqual([
      expect.stringContaining("header fields may be corrupt"),
    ]);
  });

  it("refuses an unknown unit code as malformed", () => {
    const rom = ndsRomFixture();
    rom[0x12] = 1;
    expect(() => parseNdsHeader(rom)).toThrow(
      expect.objectContaining({
        failure: expect.objectContaining({
          kind: "malformed",
          field: "unit_code",
        }),
      }),
    );
  });
});

describe("DS ROM layout", () => {
  it("lists binaries, the overlay and named files with their ranges", () => {
    const layout = layoutOf(ndsRomFixture());
    expect(layout.complete).toBe(true);
    expect(layout.limitations).toEqual([]);
    expect(
      layout.regions.map(({ path, offset, length }) => ({
        path,
        offset,
        length,
      })),
    ).toEqual([
      { path: "arm9.bin", offset: 0x4000, length: 0x100 },
      { path: "arm7.bin", offset: 0x4100, length: 0x80 },
      { path: "overlays/arm9/overlay_0000.bin", offset: 0x4200, length: 0x40 },
      { path: "data/readme.txt", offset: 0x4240, length: 30 },
      { path: "data/data/a.bin", offset: 0x425e, length: 8 },
    ]);
    expect(layout.metadata).toMatchObject({
      file_count: 3,
      directory_count: 2,
      arm9_overlay_count: 1,
      arm7_overlay_count: 0,
    });
    expect(layout.regions[2]?.metadata.overlay).toMatchObject({
      overlay_id: 0,
      ram_address: 0x0210_0000,
      ram_size: 0x40,
      bss_size: 0x10,
    });
  });

  it("accepts a ROM with an empty overlay table", () => {
    const layout = layoutOf(ndsRomFixture({ overlays: false }));
    expect(layout.complete).toBe(true);
    expect(layout.metadata.arm9_overlay_count).toBe(0);
    // The unclaimed overlay file stays visible by its file ID.
    expect(layout.regions.map((region) => region.path)).toContain(
      "fat/00000.bin",
    );
  });

  it("omits a FAT entry that ends past the file and reports it", () => {
    const rom = ndsRomFixture();
    rom.writeUInt32LE(rom.length + 100, NDS_FIXTURE.fat + 2 * 8 + 4);
    const layout = layoutOf(rom);
    expect(layout.complete).toBe(false);
    expect(layout.regions.map((region) => region.path)).not.toContain(
      "data/data/a.bin",
    );
    expect(layout.limitations).toContainEqual(
      expect.stringContaining("DS FAT entry 2 spans"),
    );
    expect(layout.limitations).toHaveLength(1);
  });

  it("stops at a directory loop instead of walking it again", () => {
    const rom = ndsRomFixture();
    // Point data/'s subdirectory entry back at the root directory.
    const dataSub = NDS_FIXTURE.fnt + rom.readUInt32LE(NDS_FIXTURE.fnt + 8);
    const loop = Buffer.concat([
      Buffer.from([0x80 | 4]),
      Buffer.from("back", "latin1"),
      Buffer.from([0x00, 0xf0, 0]),
    ]);
    loop.copy(rom, dataSub);
    const layout = layoutOf(rom);
    expect(layout.complete).toBe(false);
    expect(layout.limitations).toContainEqual(
      expect.stringContaining(
        "DS FNT directory 61440 is reached more than once",
      ),
    );
    expect(layout.metadata.directory_count).toBe(2);
  });

  it("lists a file whose name is not a portable segment by its ID", () => {
    const rom = ndsRomFixture();
    const rootSub = NDS_FIXTURE.fnt + rom.readUInt32LE(NDS_FIXTURE.fnt);
    rom.write("../me", rootSub + 1, "latin1");
    const layout = layoutOf(rom);
    expect(layout.complete).toBe(false);
    expect(layout.regions.map((region) => region.path)).toContain(
      "fat/00001.bin",
    );
    expect(layout.limitations).toContainEqual(
      expect.stringContaining("is not a portable path segment"),
    );
  });

  it("leaves coverage unknown when a directory repeats a name", () => {
    const rom = ndsRomFixture();
    const fnt = NDS_FIXTURE.fnt;
    const dataSub = fnt + rom.readUInt32LE(fnt + 8);
    // The data directory's terminator sits after "a.bin"; repeat that name.
    Buffer.concat([
      Buffer.from([5]),
      Buffer.from("a.bin", "latin1"),
      Buffer.from([0]),
    ]).copy(rom, dataSub + 6);
    const layout = layoutOf(rom);
    expect(layout.complete).toBe(false);
    expect(layout.limitations).toContainEqual(
      expect.stringContaining('names "a.bin" twice'),
    );
    expect(layout.regions.map((region) => region.path)).toContain(
      "data/data/a.bin",
    );
  });

  it("leaves coverage unknown when an overlay claims an FNT file ID", () => {
    const rom = ndsRomFixture();
    // The overlay and readme.txt both name file 1.
    rom.writeUInt32LE(1, NDS_FIXTURE.arm9OverlayTable + 24);
    const layout = layoutOf(rom);
    expect(layout.complete).toBe(false);
    expect(layout.limitations).toEqual([
      expect.stringContaining(
        'DS FNT file "readme.txt" is file 1, which another entry already claimed',
      ),
    ]);
    const paths = layout.regions.map((region) => region.path);
    expect(paths).toContain("overlays/arm9/overlay_0000.bin");
    expect(paths).not.toContain("data/readme.txt");
    // File 0, which the overlay no longer names, stays visible by ID.
    expect(paths).toContain("fat/00000.bin");
    expect(paths).toContain("data/data/a.bin");
  });

  it("leaves coverage unknown when directory file ID ranges overlap", () => {
    const rom = ndsRomFixture();
    // data/ starts at file 1, the ID readme.txt already uses.
    rom.writeUInt16LE(1, NDS_FIXTURE.fnt + 12);
    const layout = layoutOf(rom);
    expect(layout.complete).toBe(false);
    expect(layout.limitations).toEqual([
      expect.stringContaining(
        'DS FNT file "data/a.bin" is file 1, which another entry already claimed',
      ),
    ]);
    const paths = layout.regions.map((region) => region.path);
    expect(paths).toContain("data/readme.txt");
    expect(paths).not.toContain("data/data/a.bin");
    // File 2, which the overlapping range no longer names, stays visible by ID.
    expect(paths).toContain("fat/00002.bin");
    expect(paths).toContain("overlays/arm9/overlay_0000.bin");
  });

  it("leaves coverage unknown when two overlays share one file ID", () => {
    const rom = ndsRomFixture();
    const tables = tablesOf(rom);
    const arm9 = Buffer.from(tables.arm9Overlays ?? Buffer.alloc(0));
    const sharedArm9 = Buffer.from(arm9);
    sharedArm9.writeUInt32LE(1, 0);
    const sharedArm7 = Buffer.from(arm9);
    sharedArm7.writeUInt32LE(7, 0);
    const layout = parseNdsLayout(
      parseNdsHeader(rom),
      {
        ...tables,
        arm9Overlays: Buffer.concat([arm9, sharedArm9]),
        arm7Overlays: sharedArm7,
      },
      rom.length,
    );
    expect(layout.complete).toBe(false);
    expect(layout.limitations).toEqual([
      expect.stringContaining(
        "DS ARM9 overlay 1 names file 0, which another entry already claimed",
      ),
      expect.stringContaining(
        "DS ARM7 overlay 7 names file 0, which another entry already claimed",
      ),
    ]);
    // The first overlay keeps the bytes; the later ARM9 and ARM7 entries do not.
    expect(layout.regions.map((region) => region.path)).toEqual([
      "arm9.bin",
      "arm7.bin",
      "overlays/arm9/overlay_0000.bin",
      "data/readme.txt",
      "data/data/a.bin",
    ]);
  });

  it("clamps table reads to the file and the ID-space ceiling", () => {
    expect(
      ndsTableReadRange("FAT", { offset: 50, length: 100 }, 120, 1000),
    ).toEqual({
      offset: 50,
      length: 70,
      limitations: [expect.stringContaining("the file ends after 70")],
    });
    expect(
      ndsTableReadRange("FAT", { offset: 200, length: 8 }, 120, 1000),
    ).toEqual({
      offset: undefined,
      limitations: [expect.stringContaining("starts past")],
    });
    expect(
      ndsTableReadRange("FAT", { offset: 0, length: 100 }, 120, 16),
    ).toEqual({
      offset: 0,
      length: 16,
      limitations: [expect.stringContaining("16-bit file ID space")],
    });
    // An empty table holds nothing, so where it claims to start is moot.
    expect(
      ndsTableReadRange("FAT", { offset: 0xffff_ffff, length: 0 }, 120, 16),
    ).toEqual({ offset: undefined, limitations: [] });
  });

  it("itemizes a bounded number of repeated limitations and counts the rest", () => {
    const rom = ndsRomFixture();
    const bad = 100;
    const fat = Buffer.alloc(bad * 8);
    for (let id = 0; id < bad; id++)
      fat.writeUInt32LE(rom.length + 1, id * 8 + 4);
    const names = Buffer.concat([
      ...Array.from({ length: bad }, (_, index) =>
        Buffer.from(`\x03${index.toString(16).padStart(2, "0")}/`, "latin1"),
      ),
      Buffer.from([0]),
    ]);
    const fnt = Buffer.alloc(8 + names.length);
    fnt.writeUInt32LE(8, 0);
    fnt.writeUInt16LE(1, 6);
    names.copy(fnt, 8);
    const layout = parseNdsLayout(
      parseNdsHeader(rom),
      { ...tablesOf(rom), fat, fnt },
      rom.length,
    );
    expect(layout.complete).toBe(false);
    const fatLines = layout.limitations.filter((line) =>
      line.startsWith("DS FAT entry "),
    );
    const nameLines = layout.limitations.filter((line) =>
      line.includes("is not a portable path segment"),
    );
    expect(fatLines).toHaveLength(NDS_LIMITATION_EXAMPLES);
    expect(nameLines).toHaveLength(NDS_LIMITATION_EXAMPLES);
    expect(layout.limitations).toContain(
      `DS FAT entry: ${String(bad - NDS_LIMITATION_EXAMPLES)} more limitations of this kind are not itemized.`,
    );
    expect(layout.limitations).toContain(
      `DS FNT name: ${String(bad - NDS_LIMITATION_EXAMPLES)} more limitations of this kind are not itemized.`,
    );
  });

  it("stops walking when directories share one subtable", () => {
    const rom = ndsRomFixture();
    const directories = 64;
    // Root lists directories 0xF001.., all pointing at one subtable of files.
    const root = Buffer.concat([
      ...Array.from({ length: directories - 1 }, (_, index) => {
        const entry = Buffer.alloc(5);
        entry[0] = 0x80 | 2;
        entry.write(index.toString(16).padStart(2, "0"), 1, "latin1");
        entry.writeUInt16LE(0xf001 + index, 3);
        return entry;
      }),
      Buffer.from([0]),
    ]);
    const shared = Buffer.concat([
      ...Array.from({ length: 40 }, () =>
        Buffer.from([4, 0x66, 0x69, 0x6c, 0x65]),
      ),
      Buffer.from([0]),
    ]);
    const main = directories * 8;
    const fnt = Buffer.alloc(main + root.length + shared.length);
    fnt.writeUInt32LE(main, 0);
    fnt.writeUInt16LE(directories, 6);
    for (let index = 1; index < directories; index++) {
      fnt.writeUInt32LE(main + root.length, index * 8);
      fnt.writeUInt16LE(0xf000, index * 8 + 6);
    }
    root.copy(fnt, main);
    shared.copy(fnt, main + root.length);
    const layout = parseNdsLayout(
      parseNdsHeader(rom),
      { ...tablesOf(rom), fnt },
      rom.length,
    );
    expect(layout.complete).toBe(false);
    expect(layout.limitations).toContainEqual(
      expect.stringContaining("DS FNT subtables overlap"),
    );
    // The scan stops after about one table's worth of bytes, not 63 rescans.
    expect(layout.metadata.directory_count).toBeLessThan(directories / 2);
  });
});
