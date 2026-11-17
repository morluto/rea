import {
  decompressionBombBody,
  elfCompressedBody,
  elfImage,
  type ElfSectionSpec,
  frameUnit,
  gnuZdebugBody,
  macho64,
  peImage,
  sleb,
  uleb,
} from "./DwarfUnits.fixture.js";

export {
  decompressionBombBody,
  elfCompressedBody,
  elfImage,
  frameUnit,
  gnuZdebugBody,
  macho64,
  peImage,
  sleb,
  uleb,
};

const STANDARD_OPCODE_LENGTHS_12 = [
  0, 1, 1, 1, 1, 0, 0, 0, 1, 0, 0, 1,
] as const;

const cString = (value: string): Buffer => Buffer.from(`${value}\0`, "utf8");

const putU16 = (value: number, little: boolean): Buffer => {
  const b = Buffer.alloc(2);
  if (little) b.writeUInt16LE(value, 0);
  else b.writeUInt16BE(value, 0);
  return b;
};

const putU32 = (value: number, little: boolean): Buffer => {
  const b = Buffer.alloc(4);
  if (little) b.writeUInt32LE(value >>> 0, 0);
  else b.writeUInt32BE(value >>> 0, 0);
  return b;
};

const putU64 = (value: bigint, little: boolean): Buffer => {
  const b = Buffer.alloc(8);
  if (little) b.writeBigUInt64LE(value, 0);
  else b.writeBigUInt64BE(value, 0);
  return b;
};

const putOffset = (
  value: number | bigint,
  dwarf64: boolean,
  little: boolean,
): Buffer =>
  dwarf64 ? putU64(BigInt(value), little) : putU32(Number(value), little);

export const lneEndSequence = (): Buffer => Buffer.from([0x00, 0x01, 0x01]);

export const lneSetAddress = (
  addr: bigint,
  addressSize: 2 | 4 | 8 = 8,
  little = true,
): Buffer => {
  const val =
    addressSize === 8
      ? putU64(addr, little)
      : addressSize === 4
        ? putU32(Number(addr), little)
        : putU16(Number(addr), little);
  return Buffer.concat([
    Buffer.from([0x00]),
    uleb(1 + val.length),
    Buffer.from([0x02]),
    val,
  ]);
};

export const lneDefineFile = (
  name: string,
  dirIndex = 0,
  mtime = 0,
  size = 0,
): Buffer => {
  const payload = Buffer.concat([
    Buffer.from([0x03]),
    cString(name),
    uleb(dirIndex),
    uleb(mtime),
    uleb(size),
  ]);
  return Buffer.concat([Buffer.from([0x00]), uleb(payload.length), payload]);
};

export const lneSetDiscriminator = (discriminator: number): Buffer => {
  const payload = Buffer.concat([Buffer.from([0x04]), uleb(discriminator)]);
  return Buffer.concat([Buffer.from([0x00]), uleb(payload.length), payload]);
};

export const lnsCopy = (): Buffer => Buffer.from([1]);
export const lnsAdvancePc = (ops: number): Buffer =>
  Buffer.concat([Buffer.from([2]), uleb(ops)]);
export const lnsAdvanceLine = (delta: number): Buffer =>
  Buffer.concat([Buffer.from([3]), sleb(delta)]);
export const lnsSetFile = (fileIndex: number): Buffer =>
  Buffer.concat([Buffer.from([4]), uleb(fileIndex)]);
export const lnsSetColumn = (column: number): Buffer =>
  Buffer.concat([Buffer.from([5]), uleb(column)]);
export const lnsNegateStmt = (): Buffer => Buffer.from([6]);
export const lnsSetBasicBlock = (): Buffer => Buffer.from([7]);
export const lnsConstAddPc = (): Buffer => Buffer.from([8]);
export const lnsFixedAdvancePc = (delta: number, little = true): Buffer =>
  Buffer.concat([Buffer.from([9]), putU16(delta, little)]);
export const lnsSetPrologueEnd = (): Buffer => Buffer.from([10]);
export const lnsSetEpilogueBegin = (): Buffer => Buffer.from([11]);
export const lnsSetIsa = (isa: number): Buffer =>
  Buffer.concat([Buffer.from([12]), uleb(isa)]);

export const specialOpcode = (
  lineDelta: number,
  opAdvance: number,
  lineBase = -5,
  lineRange = 14,
  opcodeBase = 13,
): Buffer => {
  const code = opcodeBase + (lineDelta - lineBase) + lineRange * opAdvance;
  return Buffer.from([code]);
};

export interface V5DirSpec {
  readonly form?: number;
  readonly inline?: string;
  readonly lineStrp?: number;
  readonly strp?: number;
  readonly strx?: number;
  readonly indirectForm?: number;
}

export interface V5FileSpec {
  readonly path?: V5DirSpec;
  readonly dirIndex?: number;
  readonly timestamp?: number;
  readonly size?: number;
  readonly md5Hex?: string;
  readonly llvmSource?: string;
}

export interface LegacyFileSpec {
  readonly name: string;
  readonly dirIndex?: number;
  readonly mtime?: number;
  readonly size?: number;
}

export interface LineProgramOptions {
  readonly version?: number;
  readonly dwarf64?: boolean;
  readonly little?: boolean;
  readonly addressSize?: number;
  readonly segmentSelectorSize?: number;
  readonly minInstLen?: number;
  readonly maxOpsPerInst?: number;
  readonly defaultIsStmt?: boolean;
  readonly lineBase?: number;
  readonly lineRange?: number;
  readonly opcodeBase?: number;
  readonly standardOpcodeLengths?: readonly number[];
  readonly legacyDirectories?: readonly string[];
  readonly legacyFiles?: readonly LegacyFileSpec[];
  readonly v5Directories?: readonly V5DirSpec[];
  readonly v5Files?: readonly V5FileSpec[];
  readonly dirUseStrx?: boolean;
  readonly includeMd5?: boolean;
  readonly includeTimestamp?: boolean;
  readonly includeSize?: boolean;
  readonly includeLlvmSource?: boolean;
  readonly extraUnknownDirForm?: number;
  readonly opcodes?: Buffer;
}

const inferV5StringForm = (spec: V5DirSpec): number =>
  spec.form ??
  (spec.lineStrp !== undefined
    ? 0x1f
    : spec.strp !== undefined
      ? 0x0e
      : spec.strx !== undefined
        ? 0x1a
        : 0x08);

const encodeV5StringCol = (
  spec: V5DirSpec,
  colForm: number,
  dwarf64: boolean,
  little: boolean,
): Buffer => {
  const actualForm =
    colForm === 0x16
      ? (spec.indirectForm ??
        (spec.form === 0x16 ? 0x08 : inferV5StringForm(spec)))
      : colForm;
  let payload: Buffer;
  if (actualForm === 0x08) payload = cString(spec.inline ?? "");
  else if (actualForm === 0x1f)
    payload = putOffset(spec.lineStrp ?? 0, dwarf64, little);
  else if (actualForm === 0x0e)
    payload = putOffset(spec.strp ?? 0, dwarf64, little);
  else if (actualForm === 0x1a) payload = uleb(spec.strx ?? 0);
  else if (actualForm === 0x25) payload = Buffer.from([spec.strx ?? 0]);
  else payload = cString(spec.inline ?? "");
  return colForm === 0x16
    ? Buffer.concat([uleb(actualForm), payload])
    : payload;
};

/** Encode one DWARF 2–5 `.debug_line` program. */
export const lineProgram = (options: LineProgramOptions = {}): Buffer => {
  const version = options.version ?? 5;
  const dwarf64 = options.dwarf64 ?? false;
  const little = options.little ?? true;
  const addressSize = options.addressSize ?? 8;
  const segmentSelectorSize = options.segmentSelectorSize ?? 0;
  const minInstLen = options.minInstLen ?? 1;
  const maxOpsPerInst = options.maxOpsPerInst ?? 1;
  const defaultIsStmt = options.defaultIsStmt ?? true;
  const lineBase = options.lineBase ?? -5;
  const lineRange = options.lineRange ?? 14;
  const opcodeBase = options.opcodeBase ?? 13;
  const stdLengths =
    options.standardOpcodeLengths ?? STANDARD_OPCODE_LENGTHS_12;

  const prologueParts: Buffer[] = [
    Buffer.from([minInstLen]),
    ...(version >= 4 ? [Buffer.from([maxOpsPerInst])] : []),
    Buffer.from([defaultIsStmt ? 1 : 0]),
    Buffer.from([lineBase & 0xff]),
    Buffer.from([lineRange]),
    Buffer.from([opcodeBase]),
    Buffer.from(stdLengths.slice(0, Math.max(0, opcodeBase - 1))),
  ];

  if (version >= 5) {
    const v5Dirs = options.v5Directories ?? [{ form: 0x08, inline: "/src" }];
    const dirFormSet = new Set(v5Dirs.map(inferV5StringForm));
    const dirForm =
      options.extraUnknownDirForm ??
      (dirFormSet.size > 1
        ? 0x16
        : v5Dirs.length > 0
          ? inferV5StringForm(v5Dirs[0]!)
          : options.dirUseStrx
            ? 0x1a
            : 0x08);
    prologueParts.push(
      Buffer.from([1]),
      uleb(1), // DW_LNCT_path
      uleb(dirForm),
      uleb(v5Dirs.length),
    );
    for (const dir of v5Dirs) {
      prologueParts.push(encodeV5StringCol(dir, dirForm, dwarf64, little));
    }

    const v5Files = options.v5Files ?? [
      { path: { form: 0x08, inline: "main.c" }, dirIndex: 0 },
    ];
    const fileFormSet = new Set(
      v5Files.map((f) => inferV5StringForm(f.path ?? { inline: "main.c" })),
    );
    const firstFileForm =
      fileFormSet.size > 1
        ? 0x16
        : v5Files.length > 0
          ? inferV5StringForm(v5Files[0]!.path ?? { inline: "main.c" })
          : 0x08;
    const cols: { readonly ct: number; readonly form: number }[] = [
      { ct: 1, form: firstFileForm }, // DW_LNCT_path
      { ct: 2, form: 0x0f }, // DW_LNCT_directory_index udata
    ];
    if (options.includeTimestamp) cols.push({ ct: 3, form: 0x0f });
    if (options.includeSize) cols.push({ ct: 4, form: 0x0f });
    if (options.includeMd5) cols.push({ ct: 5, form: 0x1e }); // data16
    if (options.includeLlvmSource) cols.push({ ct: 0x2001, form: 0x08 });

    prologueParts.push(Buffer.from([cols.length]));
    for (const col of cols) {
      prologueParts.push(uleb(col.ct), uleb(col.form));
    }
    prologueParts.push(uleb(v5Files.length));
    for (const f of v5Files) {
      prologueParts.push(
        encodeV5StringCol(
          f.path ?? { inline: "main.c" },
          firstFileForm,
          dwarf64,
          little,
        ),
        uleb(f.dirIndex ?? 0),
      );
      if (options.includeTimestamp) prologueParts.push(uleb(f.timestamp ?? 0));
      if (options.includeSize) prologueParts.push(uleb(f.size ?? 0));
      if (options.includeMd5) {
        prologueParts.push(
          Buffer.from(
            (f.md5Hex ?? "00".repeat(16)).padEnd(32, "0").slice(0, 32),
            "hex",
          ),
        );
      }
      if (options.includeLlvmSource) {
        prologueParts.push(cString(f.llvmSource ?? ""));
      }
    }
  } else {
    for (const dir of options.legacyDirectories ?? []) {
      prologueParts.push(cString(dir));
    }
    prologueParts.push(Buffer.from([0]));
    for (const f of options.legacyFiles ?? [{ name: "main.c", dirIndex: 0 }]) {
      prologueParts.push(
        cString(f.name),
        uleb(f.dirIndex ?? 0),
        uleb(f.mtime ?? 0),
        uleb(f.size ?? 0),
      );
    }
    prologueParts.push(Buffer.from([0]));
  }

  const headerBody = Buffer.concat(prologueParts);
  const preHeaderLength = Buffer.concat([
    putU16(version, little),
    ...(version >= 5 ? [Buffer.from([addressSize, segmentSelectorSize])] : []),
    putOffset(headerBody.length, dwarf64, little),
  ]);

  const payload = Buffer.concat([
    preHeaderLength,
    headerBody,
    options.opcodes ?? Buffer.alloc(0),
  ]);
  return frameUnit(payload, little, dwarf64);
};

/** Build a DWARF 5 string table with null-terminated strings and return offsets. */
export const buildStringTable = (
  strings: readonly string[],
): { readonly table: Buffer; readonly offsets: readonly number[] } => {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let cursor = 0;
  for (const s of strings) {
    offsets.push(cursor);
    const enc = cString(s);
    parts.push(enc);
    cursor += enc.length;
  }
  return { table: Buffer.concat(parts), offsets };
};

/** Build a single-table DWARF 5 `.debug_str_offsets` section. */
export const buildStrOffsetsTable = (
  offsets: readonly number[],
  dwarf64 = false,
  little = true,
): Buffer => {
  const header = Buffer.concat([
    putU16(5, little),
    putU16(0, little),
    ...offsets.map((off) => putOffset(off, dwarf64, little)),
  ]);
  return frameUnit(header, little, dwarf64);
};

/** Place `.debug_line` and helper DWARF string sections into an ELF image. */
export const elfDebugLineImage = (
  parts: {
    readonly line: Buffer;
    readonly lineStr?: Buffer;
    readonly str?: Buffer;
    readonly strOffsets?: Buffer;
  },
  options: {
    readonly bits?: 32 | 64;
    readonly little?: boolean;
    readonly machine?: number;
    readonly type?: number;
    readonly lineName?: string;
    readonly lineFlags?: bigint;
    readonly extra?: readonly ElfSectionSpec[];
  } = {},
): Buffer => {
  const sections: ElfSectionSpec[] = [
    {
      name: options.lineName ?? ".debug_line",
      body: parts.line,
      ...(options.lineFlags === undefined ? {} : { flags: options.lineFlags }),
    },
  ];
  if (parts.lineStr !== undefined)
    sections.push({ name: ".debug_line_str", body: parts.lineStr });
  if (parts.str !== undefined)
    sections.push({ name: ".debug_str", body: parts.str });
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
