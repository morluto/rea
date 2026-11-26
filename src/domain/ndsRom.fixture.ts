import { NDS_LOGO_CRC, ndsCrc16 } from "./ndsRom.js";

/** Layout offsets of {@link ndsRomFixture}, for tests that corrupt a field. */
export const NDS_FIXTURE = {
  arm9: { offset: 0x4000, size: 0x100, ram: 0x0200_0000, entry: 0x0200_0800 },
  arm7: { offset: 0x4100, size: 0x80, ram: 0x0238_0000, entry: 0x0238_0000 },
  arm9OverlayTable: 0x4180,
  fnt: 0x41a0,
  fntSize: 0x40,
  fat: 0x41e0,
  files: 0x4200,
} as const;

export const NDS_FIXTURE_FILES = {
  overlay: Buffer.alloc(0x40, 0xee),
  readme: Buffer.from("hello from a synthetic DS ROM\n", "latin1"),
  asset: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
} as const;

/**
 * Two bytes after 154 zero bytes that make the logo area's CRC16 equal the
 * stored 0xCF56, so the fixture carries no copy of the real boot logo.
 */
let logoTail: number | undefined;
const solveLogoTail = (): number => {
  if (logoTail !== undefined) return logoTail;
  const area = Buffer.alloc(156);
  for (let value = 0; value <= 0xffff; value++) {
    area.writeUInt16LE(value, 154);
    if (ndsCrc16(area) === NDS_LOGO_CRC) return (logoTail = value);
  }
  throw new Error("no logo tail solves the CRC");
};

/** Recompute the header CRC after a test edits header bytes. */
export const resealNdsHeader = (rom: Buffer): Buffer => {
  rom.writeUInt16LE(ndsCrc16(rom.subarray(0, 0x15e)), 0x15e);
  return rom;
};

/**
 * A minimal synthetic DS ROM: ARM9 and ARM7 binaries, one ARM9 overlay
 * (file 0), and a filesystem holding `readme.txt` (file 1) and
 * `data/a.bin` (file 2).
 */
export const ndsRomFixture = ({
  overlays = true,
}: { readonly overlays?: boolean } = {}): Buffer => {
  const layout = NDS_FIXTURE;
  const files = [
    NDS_FIXTURE_FILES.overlay,
    NDS_FIXTURE_FILES.readme,
    NDS_FIXTURE_FILES.asset,
  ];
  const fileOffsets: number[] = [];
  let cursor: number = layout.files;
  for (const file of files) {
    fileOffsets.push(cursor);
    cursor += file.length;
  }
  const rom = Buffer.alloc(cursor);
  rom.write("REA TEST", 0, "latin1");
  rom.write("REAE", 0x0c, "latin1");
  rom.write("01", 0x10, "latin1");
  rom[0x12] = 0;
  rom[0x14] = 0;
  rom[0x1e] = 1;
  for (const [at, binary] of [
    [0x20, layout.arm9],
    [0x30, layout.arm7],
  ] as const) {
    rom.writeUInt32LE(binary.offset, at);
    rom.writeUInt32LE(binary.entry, at + 4);
    rom.writeUInt32LE(binary.ram, at + 8);
    rom.writeUInt32LE(binary.size, at + 12);
    rom.fill(
      at === 0x20 ? 0x99 : 0x77,
      binary.offset,
      binary.offset + binary.size,
    );
  }
  rom.writeUInt32LE(layout.fnt, 0x40);
  rom.writeUInt32LE(layout.fntSize, 0x44);
  rom.writeUInt32LE(layout.fat, 0x48);
  rom.writeUInt32LE(files.length * 8, 0x4c);
  rom.writeUInt32LE(overlays ? layout.arm9OverlayTable : 0, 0x50);
  rom.writeUInt32LE(overlays ? 32 : 0, 0x54);
  rom.writeUInt32LE(cursor, 0x80);
  rom.writeUInt32LE(0x4000, 0x84);
  rom.writeUInt16LE(solveLogoTail(), 0xc0 + 154);
  rom.writeUInt16LE(NDS_LOGO_CRC, 0x15c);

  if (overlays) {
    const table = layout.arm9OverlayTable;
    rom.writeUInt32LE(0, table);
    rom.writeUInt32LE(0x0210_0000, table + 4);
    rom.writeUInt32LE(0x40, table + 8);
    rom.writeUInt32LE(0x10, table + 12);
    rom.writeUInt32LE(0x0210_0020, table + 16);
    rom.writeUInt32LE(0x0210_0024, table + 20);
    rom.writeUInt32LE(0, table + 24);
  }

  // FNT main table: root (0xF000, first file 1, two directories), then
  // data (0xF001, first file 2, parent root). Subtables follow.
  const fnt = layout.fnt;
  const rootSub = 16;
  const root = Buffer.concat([
    Buffer.from([10]),
    Buffer.from("readme.txt", "latin1"),
    Buffer.from([0x80 | 4]),
    Buffer.from("data", "latin1"),
    Buffer.from([0x01, 0xf0, 0]),
  ]);
  const dataSub = rootSub + root.length;
  const data = Buffer.concat([
    Buffer.from([5]),
    Buffer.from("a.bin", "latin1"),
    Buffer.from([0]),
  ]);
  rom.writeUInt32LE(rootSub, fnt);
  rom.writeUInt16LE(1, fnt + 4);
  rom.writeUInt16LE(2, fnt + 6);
  rom.writeUInt32LE(dataSub, fnt + 8);
  rom.writeUInt16LE(2, fnt + 12);
  rom.writeUInt16LE(0xf000, fnt + 14);
  root.copy(rom, fnt + rootSub);
  data.copy(rom, fnt + dataSub);

  files.forEach((file, index) => {
    const start = fileOffsets[index]!;
    rom.writeUInt32LE(start, layout.fat + index * 8);
    rom.writeUInt32LE(start + file.length, layout.fat + index * 8 + 4);
    file.copy(rom, start);
  });
  return resealNdsHeader(rom);
};
