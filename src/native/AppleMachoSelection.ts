import type { FixupCommands } from "./AppleMachoFixups.js";
import {
  readFatSliceDeclarations,
  validateFatSlice,
} from "../domain/apple/machoContainer.js";

/** One mapped Mach-O segment with file-backed VA range. */
export interface Segment {
  address: bigint;
  size: bigint;
  offset: number;
  executable: boolean;
}

/** Named Mach-O section within a loaded segment. */
export interface Section {
  name: string;
  address: bigint;
  size: number;
}

/** Selected thin slice bounds inside a Mach-O or FAT container. */
export interface MachoSlice {
  slice: number;
  sliceEnd: number;
  /** FAT table identity, absent for a thin image. */
  fatDeclaration?: {
    offset: number;
    size: number;
    cpuType: number;
    cpuSubtype: number;
    alignmentExponent: number;
    index: number;
    tableEnd: number;
  };
}

/** Parsed little-endian 64-bit Mach-O layout for the selected architecture slice. */
export interface MachoLayout {
  segments: Segment[];
  sections: Section[];
  /** Fixup load commands and dependent dylibs of the selected slice. */
  fixups: FixupCommands;
  /** VM address of the segment that maps file offset 0 (the preferred load address). */
  baseAddress: bigint;
  /** Map a virtual address range onto a file offset within the selected slice. */
  offset(address: bigint, size?: number): number;
}

const hex = (value: bigint) => `0x${value.toString(16)}`;

/** Classify a FAT magic word; thin Mach-O returns null. */
export const fatHeaderFormat = (
  magic: number,
): { readonly littleEndian: boolean; readonly fat64: boolean } | null => {
  switch (magic) {
    case 0xcafebabe:
      return { littleEndian: false, fat64: false };
    case 0xcafebabf:
      return { littleEndian: false, fat64: true };
    case 0xbebafeca:
      return { littleEndian: true, fat64: false };
    case 0xbfbafeca:
      return { littleEndian: true, fat64: true };
    default:
      return null;
  }
};

/** Select the thin Mach-O slice for `architecture` inside a FAT or thin container. */
export const selectMachoSlice = (
  bytes: Buffer,
  architecture: string,
): MachoSlice => {
  const magic = bytes.readUInt32BE(0);
  const header = fatHeaderFormat(magic);
  if (header === null) return { slice: 0, sliceEnd: bytes.length };
  const { littleEndian, fat64 } = header;
  const stride = fat64 ? 32 : 20;
  const readUInt32 = littleEndian
    ? (offset: number) => bytes.readUInt32LE(offset)
    : (offset: number) => bytes.readUInt32BE(offset);
  const byteOrder = littleEndian ? "little-endian" : "big-endian";
  const malformed = (reason: string) =>
    new RangeError(`${reason} (FAT header byte order: ${byteOrder})`);
  const invalid = (reason: string) =>
    new TypeError(`${reason} (FAT header byte order: ${byteOrder})`);
  if (bytes.length < 8) throw malformed("Malformed FAT architecture table");
  const count = readUInt32(4);
  const headerEnd = 8 + count * stride;
  if (count > 128 || headerEnd > bytes.length)
    throw malformed("Malformed FAT architecture table");
  const cpu = architecture === "arm64" ? 0x0100000c : 0x01000007;
  const declarations = readFatSliceDeclarations(bytes.subarray(8, headerEnd), {
    count,
    wide: fat64,
    littleEndian,
  });
  if (declarations.status !== "parsed") throw malformed(declarations.reason);
  let selected: MachoSlice | undefined;
  for (const declaration of declarations.slices) {
    const issue = validateFatSlice(declaration, bytes.length, headerEnd);
    if (issue !== null) throw malformed(issue);
    if (declaration.cpuType !== cpu) continue;
    if (selected !== undefined)
      throw invalid("Ambiguous FAT architecture slice");
    selected = {
      slice: declaration.offset,
      sliceEnd: declaration.offset + declaration.size,
      fatDeclaration: {
        ...declaration,
        tableEnd: headerEnd,
      },
    };
  }
  if (selected === undefined)
    throw invalid("Requested FAT architecture is absent");
  return selected;
};

/** Parse segments/sections for a little-endian 64-bit Mach-O architecture slice. */
export const parseMachoLayout = (
  bytes: Buffer,
  architecture: string,
): MachoLayout => {
  if (bytes.length < 4) throw new RangeError("Truncated Mach-O header");
  const selection = selectMachoSlice(bytes, architecture);
  const { slice, sliceEnd } = selection;
  if (slice === 0 && sliceEnd === bytes.length && bytes.length < 32)
    throw new RangeError("Truncated Mach-O header");
  if (slice + 32 > sliceEnd || bytes.readUInt32LE(slice) !== 0xfeedfacf)
    throw new TypeError(
      "Only little-endian 64-bit Mach-O metadata is supported",
    );
  const fat = selection.fatDeclaration;
  if (fat !== undefined) {
    const issue = validateFatSlice(fat, bytes.length, fat.tableEnd, {
      cpuType: bytes.readUInt32LE(slice + 4),
      cpuSubtype: bytes.readUInt32LE(slice + 8),
    });
    if (issue !== null) throw new TypeError(issue);
  }
  const commands = bytes.readUInt32LE(slice + 16);
  const commandEnd = slice + 32 + bytes.readUInt32LE(slice + 20);
  if (commands > 4096 || commandEnd > sliceEnd)
    throw new RangeError("Malformed Mach-O command bounds");
  const state: LayoutState = {
    slice,
    sliceEnd,
    segments: [],
    sections: [],
    dylibs: [],
    binds: [],
    chained: null,
    baseAddress: undefined,
  };
  let cursor = slice + 32;
  for (let index = 0; index < commands; index++) {
    if (cursor + 8 > commandEnd) throw new RangeError("Truncated load command");
    const command = {
      cursor,
      kind: bytes.readUInt32LE(cursor),
      size: bytes.readUInt32LE(cursor + 4),
    };
    if (command.size < 8 || cursor + command.size > commandEnd)
      throw new RangeError("Invalid load command size");
    if (command.kind === 0x19) collectSegment(bytes, command, state);
    else collectFixupCommand(bytes, command, state);
    cursor += command.size;
  }
  const { segments, sections, chained, binds, dylibs } = state;
  const offset = (address: bigint, size = 1): number => {
    const matches = segments.filter(
      (segment) =>
        address >= segment.address &&
        address + BigInt(size) <= segment.address + segment.size,
    );
    if (matches.length !== 1)
      throw new RangeError(
        `Unmapped or ambiguous metadata pointer ${hex(address)}`,
      );
    const segment = matches[0];
    if (segment === undefined) throw new RangeError("Missing metadata segment");
    return segment.offset + Number(address - segment.address);
  };
  return {
    segments,
    sections,
    offset,
    fixups: { chained, binds, dylibs },
    baseAddress: state.baseAddress ?? 0n,
  };
};

/** Load commands and fixup ranges collected while walking one slice. */
interface LayoutState {
  readonly slice: number;
  readonly sliceEnd: number;
  readonly segments: Segment[];
  readonly sections: Section[];
  readonly dylibs: string[];
  readonly binds: FixupCommands["binds"][number][];
  chained: FixupCommands["chained"];
  baseAddress: bigint | undefined;
}

/** One load command header inside the selected slice. */
interface LoadCommand {
  readonly cursor: number;
  readonly kind: number;
  readonly size: number;
}

/** Record an `LC_SEGMENT_64` and its section table. */
const collectSegment = (
  bytes: Buffer,
  { cursor, size }: LoadCommand,
  state: LayoutState,
): void => {
  if (size < 72) throw new RangeError("Truncated segment command");
  const address = bytes.readBigUInt64LE(cursor + 24),
    fileSize = bytes.readBigUInt64LE(cursor + 48),
    fileOffset = bytes.readBigUInt64LE(cursor + 40);
  if (fileOffset + fileSize > BigInt(state.sliceEnd - state.slice))
    throw new RangeError("Segment file range exceeds target bytes");
  state.segments.push({
    address,
    size: fileSize,
    offset: state.slice + Number(fileOffset),
    executable: (bytes.readUInt32LE(cursor + 60) & 4) !== 0,
  });
  if (fileOffset === 0n && fileSize > 0n) state.baseAddress ??= address;
  const count = bytes.readUInt32LE(cursor + 64);
  if (72 + count * 80 > size) throw new RangeError("Truncated section table");
  for (let section = 0; section < count; section++) {
    const position = cursor + 72 + section * 80;
    const sectionSize = bytes.readBigUInt64LE(position + 40);
    if (sectionSize > BigInt(Number.MAX_SAFE_INTEGER))
      throw new RangeError("Section size exceeds exact numeric range");
    state.sections.push({
      name: bytes
        .subarray(position, position + 16)
        .toString("ascii")
        .replace(/\0.*$/u, ""),
      address: bytes.readBigUInt64LE(position + 32),
      size: Number(sectionSize),
    });
  }
};

const LC_DYLD_INFO = 0x22;
const LC_DYLD_INFO_ONLY = 0x80000022;
const LC_DYLD_CHAINED_FIXUPS = 0x80000034;
const DYLIB_COMMANDS: readonly number[] = [
  0xc, 0x80000018, 0x8000001f, 0x20, 0x80000023,
];

/** Record fixup data ranges and dylib install names from one load command. */
const collectFixupCommand = (
  bytes: Buffer,
  { cursor, kind, size }: LoadCommand,
  state: LayoutState,
): void => {
  const range = (at: number): { offset: number; size: number } => {
    const offset = state.slice + bytes.readUInt32LE(at);
    const length = bytes.readUInt32LE(at + 4);
    if (offset + length > state.sliceEnd)
      throw new RangeError("Fixup data exceeds the Mach-O slice");
    return { offset, size: length };
  };
  if (kind === LC_DYLD_CHAINED_FIXUPS) {
    if (size < 16) throw new RangeError("Truncated chained-fixups command");
    state.chained = range(cursor + 8);
  } else if (kind === LC_DYLD_INFO || kind === LC_DYLD_INFO_ONLY) {
    if (size < 48) throw new RangeError("Truncated dyld-info command");
    for (const [at, stream] of [
      [cursor + 16, "bind"],
      [cursor + 24, "weak"],
      [cursor + 32, "lazy"],
    ] as const) {
      const bound = range(at);
      if (bound.size > 0) state.binds.push({ ...bound, stream });
    }
  } else if (DYLIB_COMMANDS.includes(kind)) {
    if (size < 24) throw new RangeError("Truncated dylib command");
    const nameOffset = bytes.readUInt32LE(cursor + 8);
    if (nameOffset < 24 || nameOffset >= size)
      throw new RangeError("Dylib install name is outside its load command");
    const end = bytes.indexOf(0, cursor + nameOffset);
    if (end < 0 || end >= cursor + size)
      throw new RangeError("Unterminated dylib install name");
    state.dylibs.push(bytes.toString("utf8", cursor + nameOffset, end));
  }
};
