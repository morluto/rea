import type { FakeKunaFunction, FakeKunaInventoryEntry } from "./fakeKuna.js";

/** One `section_64` record: `[segment, section, address, size, flags]`. */
type SectionRow = readonly [string, string, bigint, bigint, number];

interface SegmentRow {
  readonly name: string;
  readonly address: bigint;
  readonly memorySize: bigint;
  readonly fileOffset: bigint;
  readonly fileSize: bigint;
  readonly protection: number;
  readonly sections: readonly SectionRow[];
}

const S_ATTR_CODE = 0x80000400;
const S_SYMBOL_STUBS_CODE = 0x80000408;
const S_NON_LAZY_SYMBOL_POINTERS = 0x6;
const S_ZEROFILL = 0x1;

/**
 * The layout ld64 gives the reproduction in #8168: code and stubs in
 * `__TEXT`, a GOT slot in `__DATA_CONST`, globals in `__DATA`, and the
 * Mach-O header at the start of the executable `__TEXT` segment.
 */
const SEGMENTS: readonly SegmentRow[] = [
  {
    name: "__PAGEZERO",
    address: 0n,
    memorySize: 0x100000000n,
    fileOffset: 0n,
    fileSize: 0n,
    protection: 0,
    sections: [],
  },
  {
    name: "__TEXT",
    address: 0x100000000n,
    memorySize: 0x4000n,
    fileOffset: 0n,
    fileSize: 0x4000n,
    protection: 5,
    sections: [
      ["__TEXT", "__text", 0x100000400n, 0x80n, S_ATTR_CODE],
      ["__TEXT", "__stubs", 0x100000480n, 0xcn, S_SYMBOL_STUBS_CODE],
      ["__TEXT", "__const", 0x1000004a0n, 0x10n, 0],
    ],
  },
  {
    name: "__DATA_CONST",
    address: 0x100004000n,
    memorySize: 0x4000n,
    fileOffset: 0x4000n,
    fileSize: 0x4000n,
    protection: 3,
    sections: [
      ["__DATA_CONST", "__got", 0x100004000n, 0x8n, S_NON_LAZY_SYMBOL_POINTERS],
    ],
  },
  {
    name: "__DATA",
    address: 0x100008000n,
    memorySize: 0x4000n,
    fileOffset: 0x8000n,
    fileSize: 0x4000n,
    protection: 3,
    sections: [
      ["__DATA", "__data", 0x100008000n, 0x10n, 0],
      ["__DATA", "__bss", 0x100008010n, 0x10n, S_ZEROFILL],
    ],
  },
  {
    name: "__LINKEDIT",
    address: 0x10000c000n,
    memorySize: 0x4000n,
    fileOffset: 0xc000n,
    fileSize: 0x100n,
    protection: 1,
    sections: [],
  },
];

const writeName = (bytes: Buffer, offset: number, name: string) => {
  bytes.write(name, offset, 16, "latin1");
};

/** A thin arm64 `MH_EXECUTE` image with that segment and section table. */
export const machoInventoryImage = (): Buffer => {
  const commands = SEGMENTS.map((segment) => {
    const command = Buffer.alloc(72 + segment.sections.length * 80);
    command.writeUInt32LE(0x19, 0);
    command.writeUInt32LE(command.length, 4);
    writeName(command, 8, segment.name);
    command.writeBigUInt64LE(segment.address, 24);
    command.writeBigUInt64LE(segment.memorySize, 32);
    command.writeBigUInt64LE(segment.fileOffset, 40);
    command.writeBigUInt64LE(segment.fileSize, 48);
    command.writeUInt32LE(segment.protection, 56);
    command.writeUInt32LE(segment.protection, 60);
    command.writeUInt32LE(segment.sections.length, 64);
    segment.sections.forEach(([segmentName, name, address, size, flags], i) => {
      const at = 72 + i * 80;
      writeName(command, at, name);
      writeName(command, at + 16, segmentName);
      command.writeBigUInt64LE(address, at + 32);
      command.writeBigUInt64LE(size, at + 40);
      const fileOffset =
        (flags & 0xff) === S_ZEROFILL
          ? 0
          : Number(address - segment.address + segment.fileOffset);
      command.writeUInt32LE(fileOffset, at + 48);
      command.writeUInt32LE(flags, at + 64);
      if (name === "__stubs") command.writeUInt32LE(12, at + 72);
    });
    return command;
  });
  const commandBytes = commands.reduce(
    (total, { length }) => total + length,
    0,
  );
  const image = Buffer.alloc(0xc100);
  image.writeUInt32LE(0xfeedfacf, 0);
  image.writeUInt32LE(0x0100000c, 4);
  image.writeUInt32LE(0, 8);
  image.writeUInt32LE(2, 12);
  image.writeUInt32LE(commands.length, 16);
  image.writeUInt32LE(commandBytes, 20);
  Buffer.concat(commands).copy(image, 32);
  return image;
};

/** Functions the fake export decompiles, at addresses inside `__TEXT,__text`. */
export const MACHO_FUNCTIONS: readonly FakeKunaFunction[] = [
  { name: "main", addr: "0x100000400" },
  { name: "helper", addr: "0x100000440" },
];

/**
 * Rows Kuna lists without bodies: a `puts` stub and its GOT slot, exported
 * data in four non-instruction regions, and one address outside every
 * section and the header.
 */
export const MACHO_INVENTORY_ENTRIES: readonly FakeKunaInventoryEntry[] = [
  { name: "puts", addr: "0x100000480", size: 0 },
  { name: "puts", addr: "0x100004000", size: 0 },
  { name: "_mh_execute_header", addr: "0x100000000", size: 0 },
  { name: "table", addr: "0x1000004a0", size: 0 },
  { name: "global_count", addr: "0x100008000", size: 0 },
  { name: "message", addr: "0x100008008", size: 0 },
  { name: "counter", addr: "0x100008010", size: 0 },
  { name: "linkedit_entry", addr: "0x10000c010", size: 0 },
];
