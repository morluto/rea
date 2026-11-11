import { gnuBuildIdNote } from "./ElfNotes.fixture.js";

const concat = (...parts: readonly Buffer[]): Buffer => Buffer.concat(parts);

const write16 = (
  bytes: Buffer,
  offset: number,
  value: number,
  little: boolean,
): void => {
  if (little) bytes.writeUInt16LE(value, offset);
  else bytes.writeUInt16BE(value, offset);
};

const write32 = (
  bytes: Buffer,
  offset: number,
  value: number,
  little: boolean,
): void => {
  if (little) bytes.writeUInt32LE(value, offset);
  else bytes.writeUInt32BE(value, offset);
};

const writeWord = (
  bytes: Buffer,
  offset: number,
  value: number,
  bits: 32 | 64,
  little: boolean,
): void => {
  if (bits === 64) {
    const wide = BigInt(value);
    if (little) bytes.writeBigUInt64LE(wide, offset);
    else bytes.writeBigUInt64BE(wide, offset);
    return;
  }
  write32(bytes, offset, value, little);
};

/** 20-byte GNU build-id used by the synthetic debug-link images. */
export const FIXTURE_BUILD_ID_HEX = "0123456789abcdef0123456789abcdef01234567";

/** Debuglink file name used when a fixture does not supply one. */
export const FIXTURE_DEBUG_NAME = "prog.debug";

/** xz magic plus two payload bytes. The payload is not a decoded stream. */
export const XZ_DEBUGDATA_STUB = Buffer.from([
  0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x01, 0x02,
]);

/**
 * `.gnu_debuglink` payload: NUL-terminated name, pad to 4, CRC32 in the
 * requested endianness.
 */
export const debuglinkSection = (
  name: string,
  crc: number,
  little: boolean,
): Buffer => {
  const encoded = Buffer.from(`${name}\0`, "latin1");
  const crcOffset = (encoded.length + 3) & ~3;
  const bytes = Buffer.alloc(crcOffset + 4);
  encoded.copy(bytes, 0);
  if (little) bytes.writeUInt32LE(crc >>> 0, crcOffset);
  else bytes.writeUInt32BE(crc >>> 0, crcOffset);
  return bytes;
};

/** `.gnu_debugaltlink` payload: NUL-terminated name, then raw build-id bytes. */
export const debugaltlinkSection = (name: string, buildId: Buffer): Buffer =>
  concat(Buffer.from(`${name}\0`, "latin1"), buildId);

export interface ElfDebugLinkFixtureOptions {
  readonly bits?: 32 | 64;
  readonly little?: boolean;
  readonly type?: number;
  readonly machine?: number;
  /** Null omits the section. Undefined uses the synthetic default. */
  readonly debuglink?: Buffer | null;
  readonly debugaltlink?: Buffer | null;
  readonly debugdata?: Buffer | null;
  /** Null omits the note section. Undefined uses one GNU build-id note. */
  readonly notes?: Buffer | null;
  readonly debugInfo?: Buffer | null;
  readonly symtab?: Buffer | null;
  /** When false, e_shstrndx is 0 and section names stay unreadable. */
  readonly sectionNames?: boolean;
  readonly debuglinkFlags?: number;
  readonly debuglinkType?: number;
  /** Declare a second `.gnu_debuglink` section with the same bytes. */
  readonly repeatDebuglink?: boolean;
}

interface SectionBody {
  readonly name: string;
  readonly type: number;
  readonly body: Buffer;
  readonly flags: number;
  readonly align: number;
}

/** Synthetic ELF32/ELF64 image with separate-debug sections and an optional note. */
export const elfDebugLinkFixture = (
  options: ElfDebugLinkFixtureOptions = {},
): Buffer => {
  const bits = options.bits ?? 64;
  const little = options.little ?? true;
  const chosen = (
    value: Buffer | null | undefined,
    fallback: () => Buffer,
  ): Buffer | null =>
    value === null ? null : value === undefined ? fallback() : value;
  const bodies: SectionBody[] = [];
  const add = (
    name: string,
    type: number,
    body: Buffer | null,
    flags = 0,
    align = 1,
  ): void => {
    if (body !== null) bodies.push({ name, type, body, flags, align });
  };
  add(
    ".note.gnu.build-id",
    7,
    chosen(options.notes, () => gnuBuildIdNote(FIXTURE_BUILD_ID_HEX, little)),
    0,
    4,
  );
  add(
    ".gnu_debuglink",
    options.debuglinkType ?? 1,
    chosen(options.debuglink, () =>
      debuglinkSection(FIXTURE_DEBUG_NAME, 0x12345678, little),
    ),
    options.debuglinkFlags ?? 0,
    1,
  );
  if (options.repeatDebuglink === true) {
    const first = bodies.find((section) => section.name === ".gnu_debuglink");
    if (first !== undefined)
      bodies.push({ ...first, body: Buffer.from(first.body) });
  }
  add(".gnu_debugaltlink", 1, options.debugaltlink ?? null);
  add(".gnu_debugdata", 1, options.debugdata ?? null);
  add(".debug_info", 1, options.debugInfo ?? null);
  add(".symtab", 1, options.symtab ?? null);
  const labels = [
    ...new Set([...bodies.map((section) => section.name), ".shstrtab"]),
  ];
  const nameOffsets = new Map<string, number>();
  const nameParts: Buffer[] = [Buffer.from([0])];
  for (const label of labels) {
    nameOffsets.set(
      label,
      nameParts.reduce((sum, part) => sum + part.length, 0),
    );
    nameParts.push(Buffer.from(`${label}\0`, "latin1"));
  }
  const names = concat(...nameParts);
  const headerSize = bits === 64 ? 64 : 52;
  const shentsize = bits === 64 ? 64 : 40;
  const shnum = bodies.length + 2;
  const shoff = headerSize;
  let cursor = shoff + shnum * shentsize;
  const placed = bodies.map((section) => {
    const offset = cursor;
    cursor += section.body.length;
    return { ...section, offset };
  });
  const namesOffset = cursor;
  const bytes = Buffer.alloc(cursor + names.length);
  bytes.writeUInt32LE(0x464c457f, 0);
  bytes[4] = bits === 64 ? 2 : 1;
  bytes[5] = little ? 1 : 2;
  bytes[6] = 1;
  write16(bytes, 16, options.type ?? 3, little);
  write16(bytes, 18, options.machine ?? (bits === 64 ? 62 : 20), little);
  write32(bytes, 20, 1, little);
  write16(bytes, bits === 64 ? 52 : 40, headerSize, little);
  write16(bytes, bits === 64 ? 54 : 42, bits === 64 ? 56 : 32, little);
  writeWord(bytes, bits === 64 ? 40 : 32, shoff, bits, little);
  write16(bytes, bits === 64 ? 58 : 46, shentsize, little);
  write16(bytes, bits === 64 ? 60 : 48, shnum, little);
  write16(
    bytes,
    bits === 64 ? 62 : 50,
    options.sectionNames === false ? 0 : shnum - 1,
    little,
  );
  const writeSection = (
    index: number,
    name: string,
    type: number,
    offset: number,
    size: number,
    flags: number,
    align: number,
  ): void => {
    const at = shoff + index * shentsize;
    write32(bytes, at, nameOffsets.get(name) ?? 0, little);
    write32(bytes, at + 4, type, little);
    writeWord(bytes, at + 8, flags, bits, little);
    writeWord(bytes, at + (bits === 64 ? 24 : 16), offset, bits, little);
    writeWord(bytes, at + (bits === 64 ? 32 : 20), size, bits, little);
    writeWord(bytes, at + (bits === 64 ? 48 : 32), align, bits, little);
  };
  placed.forEach((section, index) => {
    writeSection(
      index + 1,
      section.name,
      section.type,
      section.offset,
      section.body.length,
      section.flags,
      section.align,
    );
    section.body.copy(bytes, section.offset);
  });
  writeSection(shnum - 1, ".shstrtab", 3, namesOffset, names.length, 0, 1);
  names.copy(bytes, namesOffset);
  return bytes;
};

/** Separate debug file: optional GNU build-id, `.debug_info`, and `.symtab`. */
export const elfDebugCandidateFixture = (
  options: {
    readonly bits?: 32 | 64;
    readonly little?: boolean;
    readonly machine?: number;
    readonly type?: number;
    /** Null omits the build-id note. Undefined uses the fixture build-id. */
    readonly buildIdHex?: string | null;
    readonly debugInfo?: Buffer | null;
    readonly symtab?: Buffer | null;
  } = {},
): Buffer => {
  const little = options.little ?? true;
  const notes =
    options.buildIdHex === null
      ? null
      : gnuBuildIdNote(options.buildIdHex ?? FIXTURE_BUILD_ID_HEX, little);
  return elfDebugLinkFixture({
    ...(options.bits === undefined ? {} : { bits: options.bits }),
    little,
    ...(options.machine === undefined ? {} : { machine: options.machine }),
    ...(options.type === undefined ? {} : { type: options.type }),
    debuglink: null,
    notes,
    debugInfo:
      options.debugInfo === undefined
        ? Buffer.from("debug-info", "latin1")
        : options.debugInfo,
    symtab:
      options.symtab === undefined ? Buffer.alloc(16, 0x11) : options.symtab,
  });
};
