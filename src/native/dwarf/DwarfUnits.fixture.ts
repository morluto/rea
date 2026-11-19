import { deflateSync, zstdCompressSync } from "node:zlib";
import { MAX_DWARF_DECOMPRESSED_SECTION_BYTES } from "../../domain/native/dwarfUnits.js";

const concat = (...parts: Buffer[]): Buffer => Buffer.concat(parts);

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
  if (little) bytes.writeUInt32LE(value >>> 0, offset);
  else bytes.writeUInt32BE(value >>> 0, offset);
};

const write64 = (
  bytes: Buffer,
  offset: number,
  value: bigint,
  little: boolean,
): void => {
  if (little) bytes.writeBigUInt64LE(value, offset);
  else bytes.writeBigUInt64BE(value, offset);
};

const writeWord = (
  bytes: Buffer,
  offset: number,
  value: number | bigint,
  bits: 32 | 64,
  little: boolean,
): void => {
  if (bits === 64) write64(bytes, offset, BigInt(value), little);
  else write32(bytes, offset, Number(value), little);
};

/** Unsigned LEB128. Values stay inside the ten-byte DWARF cap. */
export const uleb = (value: number): Buffer => {
  const bytes: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest !== 0);
  return Buffer.from(bytes);
};

/** Signed LEB128 for small abbreviation constants. */
export const sleb = (value: number): Buffer => {
  const bytes: number[] = [];
  let rest = value;
  let more = true;
  while (more) {
    let byte = rest & 0x7f;
    rest >>= 7;
    const sign = (byte & 0x40) !== 0;
    if ((rest === 0 && !sign) || (rest === -1 && sign)) more = false;
    else byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
};

/** Frame one unit payload with a DWARF32 or DWARF64 initial length. */
export const frameUnit = (
  payload: Buffer,
  little = true,
  dwarf64 = false,
): Buffer => {
  if (!dwarf64) {
    const header = Buffer.alloc(4);
    write32(header, 0, payload.length, little);
    return concat(header, payload);
  }
  const header = Buffer.alloc(12);
  write32(header, 0, 0xffffffff, little);
  write64(header, 4, BigInt(payload.length), little);
  return concat(header, payload);
};

export interface AbbrevAttributeSpec {
  readonly name: number;
  readonly form: number;
  readonly implicit?: number;
}

export interface AbbrevEntrySpec {
  readonly code: number;
  readonly tag: number;
  readonly children: boolean;
  readonly attributes: readonly AbbrevAttributeSpec[];
}

/** One abbreviation table, including its terminating code. */
export const abbrevTable = (entries: readonly AbbrevEntrySpec[]): Buffer =>
  concat(
    ...entries.flatMap((entry) => [
      uleb(entry.code),
      uleb(entry.tag),
      Buffer.from([entry.children ? 1 : 0]),
      ...entry.attributes.flatMap((attribute) => [
        uleb(attribute.name),
        uleb(attribute.form),
        ...(attribute.implicit === undefined ? [] : [sleb(attribute.implicit)]),
      ]),
      uleb(0),
      uleb(0),
    ]),
    uleb(0),
  );

const cString = (value: string): Buffer => Buffer.from(`${value}\0`, "latin1");

export interface CompileUnitSpec {
  readonly version?: number;
  readonly unitType?: number;
  readonly addressSize?: number;
  readonly abbrevOffset?: number;
  readonly offsetSize?: 4 | 8;
  readonly little?: boolean;
  readonly dwarf64?: boolean;
  readonly code?: number;
  readonly attributes?: readonly Buffer[];
  /** When set, the framed payload is these bytes and the header fields are ignored. */
  readonly payload?: Buffer;
}

/** DWARF 2–4 or DWARF 5 unit header plus one abbreviation code and attribute bytes. */
export const compileUnit = (spec: CompileUnitSpec = {}): Buffer => {
  const little = spec.little ?? true;
  const offsetSize = spec.offsetSize ?? (spec.dwarf64 ? 8 : 4);
  const version = spec.version ?? 4;
  if (spec.payload !== undefined)
    return frameUnit(spec.payload, little, offsetSize === 8);
  const header = [put16(version, little)];
  if (version >= 5) header.push(Buffer.from([spec.unitType ?? 1]));
  if (version < 5)
    header.push(putOffset(spec.abbrevOffset ?? 0, offsetSize, little));
  header.push(Buffer.from([spec.addressSize ?? 8]));
  if (version >= 5)
    header.push(putOffset(spec.abbrevOffset ?? 0, offsetSize, little));
  const trailer =
    spec.unitType === 4 || spec.unitType === 5
      ? 8
      : spec.unitType === 2 || spec.unitType === 6
        ? 8 + offsetSize
        : 0;
  if (trailer !== 0) header.push(Buffer.alloc(trailer));
  return frameUnit(
    concat(...header, uleb(spec.code ?? 1), ...(spec.attributes ?? [])),
    little,
    offsetSize === 8,
  );
};

const put16 = (value: number, little: boolean): Buffer => {
  const bytes = Buffer.alloc(2);
  write16(bytes, 0, value, little);
  return bytes;
};

const putOffset = (
  value: number,
  offsetSize: 4 | 8,
  little: boolean,
): Buffer => {
  const bytes = Buffer.alloc(offsetSize);
  if (offsetSize === 8) write64(bytes, 0, BigInt(value), little);
  else write32(bytes, 0, value, little);
  return bytes;
};

export interface NamedUnitOptions {
  readonly name?: string;
  readonly compDir?: string;
  readonly producer?: string;
  readonly language?: number;
  readonly dwoName?: string;
  readonly version?: number;
  readonly little?: boolean;
  readonly dwarf64?: boolean;
  readonly addressSize?: number;
  readonly abbrevOffset?: number;
}

/** One compile unit whose unit DIE carries inline strings and an optional dwo_name. */
export const namedUnit = (
  options: NamedUnitOptions = {},
): {
  readonly info: Buffer;
  readonly abbrev: Buffer;
} => {
  const attributes: AbbrevAttributeSpec[] = [
    { name: 0x03, form: 0x08 },
    { name: 0x1b, form: 0x08 },
    { name: 0x25, form: 0x08 },
    { name: 0x13, form: 0x0b },
  ];
  const values = [
    cString(options.name ?? "main.c"),
    cString(options.compDir ?? "/src"),
    cString(options.producer ?? "clang"),
    Buffer.from([options.language ?? 0x0c]),
  ];
  if (options.dwoName !== undefined) {
    attributes.push({ name: 0x76, form: 0x08 });
    values.push(cString(options.dwoName));
  }
  const abbrev = abbrevTable([
    { code: 1, tag: 0x11, children: false, attributes },
  ]);
  const version = options.version ?? 4;
  const info = compileUnit({
    version,
    ...(version >= 5 ? { unitType: 1 } : {}),
    ...(options.little === undefined ? {} : { little: options.little }),
    ...(options.dwarf64 === undefined ? {} : { dwarf64: options.dwarf64 }),
    addressSize: options.addressSize ?? 8,
    ...(options.abbrevOffset === undefined
      ? {}
      : { abbrevOffset: options.abbrevOffset }),
    attributes: values,
  });
  return { info, abbrev };
};

/**
 * DWARF 5 unit whose `DW_FORM_strx` name appears before `DW_AT_str_offsets_base`.
 * The base is 8, after the DWARF32 contribution header in `.debug_str_offsets`.
 */
export const strxBeforeBase = (): {
  readonly info: Buffer;
  readonly abbrev: Buffer;
  readonly str: Buffer;
  readonly strOffsets: Buffer;
} => {
  const abbrev = abbrevTable([
    {
      code: 1,
      tag: 0x11,
      children: false,
      attributes: [
        { name: 0x03, form: 0x1a },
        { name: 0x72, form: 0x17 },
      ],
    },
  ]);
  const info = compileUnit({
    version: 5,
    unitType: 1,
    addressSize: 4,
    attributes: [uleb(0), putOffset(8, 4, true)],
  });
  return {
    info,
    abbrev,
    str: cString("hello.c"),
    strOffsets: frameUnit(
      Buffer.concat([Buffer.from([5, 0, 0, 0]), putOffset(0, 4, true)]),
    ),
  };
};

export interface ElfSectionSpec {
  readonly name: string;
  readonly body: Buffer;
  readonly flags?: bigint;
  readonly type?: number;
  readonly info?: number;
}

/** Minimal ELF32/ELF64 relocatable image with the supplied sections and `.shstrtab`. */
export const elfImage = (
  options: {
    readonly bits?: 32 | 64;
    readonly little?: boolean;
    readonly machine?: number;
    /** ELF `e_type`. Defaults to `ET_REL`. */
    readonly type?: number;
    readonly sections?: readonly ElfSectionSpec[];
  } = {},
): Buffer => {
  const bits = options.bits ?? 64;
  const little = options.little ?? true;
  const sections = options.sections ?? [];
  const nameParts: Buffer[] = [Buffer.from([0])];
  const nameOffsets: number[] = [];
  let nameCursor = 1;
  for (const section of sections) {
    nameOffsets.push(nameCursor);
    const encoded = Buffer.from(`${section.name}\0`, "latin1");
    nameParts.push(encoded);
    nameCursor += encoded.length;
  }
  const shstrName = nameCursor;
  nameParts.push(Buffer.from(".shstrtab\0", "latin1"));
  const shstrtab = concat(...nameParts);
  const header = bits === 64 ? 64 : 52;
  const shent = bits === 64 ? 64 : 40;
  const shnum = sections.length + 2;
  const shoff = header;
  let cursor = shoff + shnum * shent;
  const payloadOffsets = sections.map((section) => {
    const offset = cursor;
    cursor += section.body.length;
    return offset;
  });
  const strOff = cursor;
  const bytes = Buffer.alloc(strOff + shstrtab.length);
  bytes.writeUInt32LE(0x464c457f, 0);
  bytes[4] = bits === 64 ? 2 : 1;
  bytes[5] = little ? 1 : 2;
  bytes[6] = 1;
  write16(bytes, 0x10, options.type ?? 1, little);
  write16(bytes, 0x12, options.machine ?? (bits === 64 ? 62 : 3), little);
  write32(bytes, 0x14, 1, little);
  write16(bytes, bits === 64 ? 0x34 : 0x28, header, little);
  write16(bytes, bits === 64 ? 0x36 : 0x2a, bits === 64 ? 56 : 32, little);
  writeWord(bytes, bits === 64 ? 0x28 : 0x20, shoff, bits, little);
  write16(bytes, bits === 64 ? 0x3a : 0x2e, shent, little);
  write16(bytes, bits === 64 ? 0x3c : 0x30, shnum, little);
  write16(bytes, bits === 64 ? 0x3e : 0x32, shnum - 1, little);
  sections.forEach((section, index) => {
    const at = shoff + (index + 1) * shent;
    write32(bytes, at, nameOffsets[index] ?? 0, little);
    write32(bytes, at + 4, section.type ?? 1, little);
    write32(bytes, at + (bits === 64 ? 44 : 28), section.info ?? 0, little);
    writeWord(bytes, at + 8, section.flags ?? 0n, bits, little);
    writeWord(
      bytes,
      at + (bits === 64 ? 24 : 16),
      payloadOffsets[index] ?? 0,
      bits,
      little,
    );
    writeWord(
      bytes,
      at + (bits === 64 ? 32 : 20),
      section.body.length,
      bits,
      little,
    );
    writeWord(bytes, at + (bits === 64 ? 48 : 32), 1, bits, little);
    section.body.copy(bytes, payloadOffsets[index] ?? 0);
  });
  const strAt = shoff + (sections.length + 1) * shent;
  write32(bytes, strAt, shstrName, little);
  write32(bytes, strAt + 4, 3, little);
  writeWord(bytes, strAt + (bits === 64 ? 24 : 16), strOff, bits, little);
  writeWord(
    bytes,
    strAt + (bits === 64 ? 32 : 20),
    shstrtab.length,
    bits,
    little,
  );
  writeWord(bytes, strAt + (bits === 64 ? 48 : 32), 1, bits, little);
  shstrtab.copy(bytes, strOff);
  return bytes;
};

/** ELF `SHF_COMPRESSED` payload. The declared size is checked before inflation. */
export const elfCompressedBody = (
  plain: Buffer,
  compression: "zlib" | "zstd",
  bits: 32 | 64 = 64,
  little = true,
  declaredSize = plain.length,
): Buffer => {
  const payload =
    compression === "zstd" ? zstdCompressSync(plain) : deflateSync(plain);
  const header = Buffer.alloc(bits === 64 ? 24 : 12);
  write32(header, 0, compression === "zstd" ? 2 : 1, little);
  writeWord(header, bits === 64 ? 8 : 4, declaredSize, bits, little);
  writeWord(header, bits === 64 ? 16 : 8, 1, bits, little);
  return concat(header, payload);
};

/** Legacy GNU `.zdebug_*` payload: `ZLIB`, big-endian size, zlib stream. */
export const gnuZdebugBody = (
  plain: Buffer,
  declaredSize = plain.length,
): Buffer => {
  const header = Buffer.alloc(12);
  header.write("ZLIB", 0, "latin1");
  header.writeBigUInt64BE(BigInt(declaredSize), 4);
  return concat(header, deflateSync(plain));
};

/** Declared uncompressed size one byte past the DWARF section allowance. */
export const decompressionBombBody = (
  bits: 32 | 64 = 64,
  little = true,
): Buffer =>
  elfCompressedBody(
    Buffer.from("a"),
    "zlib",
    bits,
    little,
    MAX_DWARF_DECOMPRESSED_SECTION_BYTES + 1,
  );

export interface MachoSectionSpec {
  readonly name: string;
  readonly body: Buffer;
  /** Defaults to `__DWARF`. */
  readonly segment?: string;
}

/** Thin little-endian Mach-O 64. An empty section list is a valid object with no commands. */
export const macho64 = (options: {
  readonly cpuType: number;
  readonly cpuSubtype?: number;
  readonly sections?: readonly MachoSectionSpec[];
}): Buffer => {
  const sections = options.sections ?? [];
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(options.cpuType, 4);
  header.writeUInt32LE(options.cpuSubtype ?? 0, 8);
  header.writeUInt32LE(1, 12);
  if (sections.length === 0) return header;
  const cmdsize = 72 + sections.length * 80;
  const bodies = concat(...sections.map((section) => section.body));
  const bytes = Buffer.alloc(32 + cmdsize + bodies.length);
  header.copy(bytes);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(cmdsize, 20);
  const command = 32;
  bytes.writeUInt32LE(0x19, command);
  bytes.writeUInt32LE(cmdsize, command + 4);
  bytes.write("__DWARF", command + 8, "latin1");
  bytes.writeBigUInt64LE(BigInt(bodies.length), command + 32);
  bytes.writeBigUInt64LE(BigInt(32 + cmdsize), command + 40);
  bytes.writeBigUInt64LE(BigInt(bodies.length), command + 48);
  bytes.writeUInt32LE(1, command + 56);
  bytes.writeUInt32LE(1, command + 60);
  bytes.writeUInt32LE(sections.length, command + 64);
  let address = 0;
  let file = 32 + cmdsize;
  sections.forEach((section, index) => {
    const at = command + 72 + index * 80;
    bytes.write(section.name.slice(0, 16), at, "latin1");
    bytes.write(section.segment ?? "__DWARF", at + 16, "latin1");
    bytes.writeBigUInt64LE(BigInt(address), at + 32);
    bytes.writeBigUInt64LE(BigInt(section.body.length), at + 40);
    bytes.writeUInt32LE(file, at + 48);
    address += section.body.length;
    file += section.body.length;
  });
  bodies.copy(bytes, 32 + cmdsize);
  return bytes;
};

/** PE32+ image. Section names longer than eight bytes use the COFF string table. */
export const peImage = (
  sections: readonly { readonly name: string; readonly body: Buffer }[],
  machine = 0x8664,
  magic: 0x10b | 0x20b = 0x20b,
): Buffer => {
  const pe = 64;
  const optionalSize = 112;
  const table = pe + 24 + optionalSize;
  let data = table + sections.length * 40;
  const offsets = sections.map((section) => {
    const offset = data;
    data += section.body.length;
    return offset;
  });
  const longNames: { readonly at: number }[] = [];
  const encoded: Buffer[] = [];
  let stringCursor = 4;
  for (const section of sections) {
    if (section.name.length <= 8) {
      longNames.push({ at: -1 });
      continue;
    }
    longNames.push({ at: stringCursor });
    const bytes = Buffer.from(`${section.name}\0`, "latin1");
    encoded.push(bytes);
    stringCursor += bytes.length;
  }
  const tableSize = encoded.length === 0 ? 0 : stringCursor;
  const stringOffset = data;
  const bytes = Buffer.alloc(data + tableSize);
  bytes.write("MZ", 0, "latin1");
  bytes.writeUInt32LE(pe, 0x3c);
  bytes.write("PE\0\0", pe, "latin1");
  bytes.writeUInt16LE(machine, pe + 4);
  bytes.writeUInt16LE(sections.length, pe + 6);
  if (tableSize !== 0) bytes.writeUInt32LE(stringOffset, pe + 12);
  bytes.writeUInt16LE(optionalSize, pe + 20);
  bytes.writeUInt16LE(magic, pe + 24);
  sections.forEach((section, index) => {
    const at = table + index * 40;
    const long = longNames[index];
    if (long !== undefined && long.at >= 0)
      bytes.write(`/${String(long.at)}`, at, "latin1");
    else bytes.write(section.name, at, "latin1");
    bytes.writeUInt32LE(section.body.length, at + 8);
    bytes.writeUInt32LE((index + 1) * 0x1000, at + 12);
    bytes.writeUInt32LE(section.body.length, at + 16);
    bytes.writeUInt32LE(offsets[index] ?? 0, at + 20);
    section.body.copy(bytes, offsets[index] ?? 0);
  });
  if (tableSize !== 0) {
    bytes.writeUInt32LE(tableSize, stringOffset);
    concat(...encoded).copy(bytes, stringOffset + 4);
  }
  return bytes;
};

/** Place the standard debug sections into an ELF image. */
export const elfDebugImage = (
  parts: {
    readonly info: Buffer;
    readonly abbrev?: Buffer;
    readonly str?: Buffer;
    readonly lineStr?: Buffer;
    readonly strOffsets?: Buffer;
  },
  options: {
    readonly bits?: 32 | 64;
    readonly little?: boolean;
    readonly machine?: number;
    readonly infoName?: string;
    readonly infoFlags?: bigint;
    readonly type?: number;
    readonly extra?: readonly ElfSectionSpec[];
  } = {},
): Buffer => {
  const sections: ElfSectionSpec[] = [
    {
      name: options.infoName ?? ".debug_info",
      body: parts.info,
      ...(options.infoFlags === undefined ? {} : { flags: options.infoFlags }),
    },
  ];
  if (parts.abbrev !== undefined)
    sections.push({ name: ".debug_abbrev", body: parts.abbrev });
  if (parts.str !== undefined)
    sections.push({ name: ".debug_str", body: parts.str });
  if (parts.lineStr !== undefined)
    sections.push({ name: ".debug_line_str", body: parts.lineStr });
  if (parts.strOffsets !== undefined)
    sections.push({ name: ".debug_str_offsets", body: parts.strOffsets });
  sections.push(...(options.extra ?? []));
  return elfImage({
    ...(options.bits === undefined ? {} : { bits: options.bits }),
    ...(options.little === undefined ? {} : { little: options.little }),
    ...(options.machine === undefined ? {} : { machine: options.machine }),
    ...(options.type === undefined ? {} : { type: options.type }),
    sections,
  });
};
