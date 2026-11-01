import { elfNote, gnuBuildIdNote } from "../elf/ElfNotes.fixture.js";
import {
  peLoadConfigImage,
  type PeLoadConfigFixtureMalformed,
} from "../pe/PeLoadConfig.fixture.js";

const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const PT_INTERP = 3;
const PT_GNU_STACK = 0x6474e551;
const PT_GNU_RELRO = 0x6474e552;
const PT_GNU_PROPERTY = 0x6474e553;
const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_DYNAMIC = 6;
const SHT_NOTE = 7;
const SHT_DYNSYM = 11;
const DT_NULL = 0;
const DT_NEEDED = 1;
const DT_HASH = 4;
const DT_STRTAB = 5;
const DT_SYMTAB = 6;
const DT_STRSZ = 10;
const DT_SYMENT = 11;
const DT_RPATH = 15;
const DT_RUNPATH = 29;
const DT_BIND_NOW = 24;
const DT_FLAGS = 30;
const DT_FLAGS_1 = 0x6ffffffb;
const DF_BIND_NOW = 0x8;
const DF_1_NOW = 0x1;
const DF_1_PIE = 0x08000000;
const PF_R = 4;
const SHF_COMPRESSED = 0x800;

export interface ElfHardeningFixtureOptions {
  readonly bits?: 32 | 64;
  readonly little?: boolean;
  readonly machine?: number;
  readonly type?: number;
  readonly dynamic?: boolean;
  readonly interp?: boolean;
  readonly pieFlag?: boolean;
  readonly bindNow?: boolean;
  readonly rpath?: string | null;
  readonly runpath?: string | null;
  readonly stackChk?: boolean;
  readonly fortify?: boolean;
  /** Set st_shndx so the protector names are defined exports, not imports. */
  readonly exportSymbols?: boolean;
  readonly gnuStack?: { readonly flags: number } | null;
  readonly gnuRelro?: boolean;
  readonly symtab?: boolean;
  readonly sections?: boolean;
  readonly property?: {
    readonly arch: "x86" | "aarch64";
    readonly value: number;
    readonly also?: number;
  } | null;
  /** Where a GNU property note is declared. Defaults to PT_GNU_PROPERTY. */
  readonly propertyCarrier?: "pt-gnu-property" | "pt-note";
  /** Repeat one GNU property note so a section and program overlap past 256. */
  readonly propertyCopies?: number;
  readonly needed?: readonly string[];
  /** DT_BIND_NOW tag without DF_BIND_NOW or DF_1_NOW. */
  readonly bindNowTag?: boolean;
  /** Two DT_FLAGS entries. */
  readonly duplicateFlags?: boolean;
  readonly duplicateStack?: boolean;
  readonly truncateDynamic?: boolean;
  /** DT_HASH nchain above the symbol budget, with no section symbol table. */
  readonly symbolBudget?: boolean;
  /** One `.note.gnu.build-id` section, `sh_addralign` 4. */
  readonly buildId?: boolean;
  /** Build-id notes concatenated in one section. */
  readonly buildIdCount?: number;
  /** Repeated SHT_NOTE headers naming that same build-id range. */
  readonly buildIdSections?: number;
  /** 300 symbols sharing one long terminated name. */
  readonly symbolScanBudget?: boolean;
  /** One symbol whose name exceeds the per-name scan cap. */
  readonly longSymbolName?: boolean;
  /** Replace `__memcpy_chk`; bytes are written as latin1. */
  readonly fortifyName?: string;
  /** Mark `.note.gnu.property` as SHF_COMPRESSED. */
  readonly compressedPropertyNote?: boolean;
  /** Disjoint `.note.gnu.property` sections holding one empty note each. */
  readonly disjointNoteSections?: number;
  /** A property note whose name charges more text than the file holds. */
  readonly longNoteName?: boolean;
}

interface ElfProgramSpec {
  type: number;
  flags: number;
  offset: number;
  address: number;
  filesz: number;
  memsz: number;
  align: number;
}

interface ElfSectionSpec {
  name: string;
  type: number;
  offset: number;
  size: number;
  link: number;
  entry: number;
  align?: number;
  flags?: number;
}

interface ElfSymbolPayload {
  readonly dynstr: Buffer;
  readonly dynsym: Buffer;
  readonly hash: Buffer;
  readonly symbolWidth: number;
  readonly dynamicWidth: number;
  readonly stringOffset: (value: string | null | undefined) => number | null;
}

interface ElfPlacedImage {
  readonly programs: ElfProgramSpec[];
  readonly sectionTable: ElfSectionSpec[];
  readonly shstrtab: Buffer;
  readonly intern: (name: string) => number;
  readonly interpAt: number;
  readonly dynstrAt: number;
  readonly dynsymAt: number;
  readonly hashAt: number;
  readonly noteAt: number;
  readonly buildIdAt: number;
  readonly dynamicAt: number;
  readonly shstrAt: number;
  readonly shoff: number;
  readonly fileSize: number;
}

const elfProgram = (
  type: number,
  flags: number,
  filesz: number,
  memsz: number,
  align: number,
): ElfProgramSpec => ({
  type,
  flags,
  offset: 0,
  address: 0,
  filesz,
  memsz,
  align,
});

const elfSymbolPayload = (
  options: ElfHardeningFixtureOptions,
  bits: 32 | 64,
  little: boolean,
): ElfSymbolPayload => {
  const symbolWidth = bits === 64 ? 24 : 16;
  const dynamicWidth = bits === 64 ? 16 : 8;
  if (options.symbolScanBudget === true || options.longSymbolName === true) {
    const signAfterLongName =
      options.longSymbolName === true && options.stackChk === true;
    const symbolCount =
      options.symbolScanBudget === true ? 300 : signAfterLongName ? 3 : 2;
    const dynstr =
      options.symbolScanBudget === true
        ? Buffer.alloc(65537, 0x41)
        : Buffer.concat([
            Buffer.from([0]),
            Buffer.alloc(70000, 0x41),
            Buffer.from([0]),
            Buffer.from("__stack_chk_fail\0", "latin1"),
          ]);
    if (options.symbolScanBudget === true) {
      dynstr[0] = 0;
      dynstr[65536] = 0;
    }
    const dynsym = Buffer.alloc(symbolCount * symbolWidth);
    const named = options.symbolScanBudget === true ? symbolCount : 2;
    for (let index = 1; index < named; index += 1) {
      const at = index * symbolWidth;
      if (little) dynsym.writeUInt32LE(1, at);
      else dynsym.writeUInt32BE(1, at);
    }
    if (signAfterLongName) {
      const signAt = dynstr.indexOf("__stack_chk_fail", 0, "latin1");
      if (little) dynsym.writeUInt32LE(signAt, 2 * symbolWidth);
      else dynsym.writeUInt32BE(signAt, 2 * symbolWidth);
    }
    const hash = Buffer.alloc(8);
    if (little) {
      hash.writeUInt32LE(1, 0);
      hash.writeUInt32LE(symbolCount, 4);
    } else {
      hash.writeUInt32BE(1, 0);
      hash.writeUInt32BE(symbolCount, 4);
    }
    return {
      dynstr,
      dynsym,
      hash,
      symbolWidth,
      dynamicWidth,
      stringOffset: () => null,
    };
  }
  const symbolNames: string[] = [];
  if (options.stackChk === true) symbolNames.push("__stack_chk_fail");
  if (options.fortify === true)
    symbolNames.push(options.fortifyName ?? "__memcpy_chk");
  const dynstr = Buffer.concat([
    Buffer.from([0]),
    ...[
      options.rpath,
      options.runpath,
      ...(options.needed ?? []),
      ...symbolNames,
    ]
      .filter(
        (value): value is string =>
          value !== null &&
          value !== undefined &&
          value.length >= 0 &&
          typeof value === "string",
      )
      .map((value) => Buffer.from(`${value}\0`, "latin1")),
  ]);
  const stringOffset = (value: string | null | undefined): number | null => {
    if (value === null || value === undefined) return null;
    return dynstr.indexOf(Buffer.from(`${value}\0`, "latin1"));
  };
  const symbolCount = 1 + symbolNames.length;
  const dynsym = Buffer.alloc(symbolCount * symbolWidth);
  symbolNames.forEach((name, index) => {
    const at = (index + 1) * symbolWidth;
    const nameAt = stringOffset(name) ?? 0;
    if (little) dynsym.writeUInt32LE(nameAt, at);
    else dynsym.writeUInt32BE(nameAt, at);
    if (options.exportSymbols === true) {
      const shndxAt = at + (symbolWidth === 24 ? 6 : 14);
      if (little) dynsym.writeUInt16LE(1, shndxAt);
      else dynsym.writeUInt16BE(1, shndxAt);
    }
  });
  const hash = Buffer.alloc(8);
  const nchain = options.symbolBudget === true ? 65537 : symbolCount;
  if (little) {
    hash.writeUInt32LE(1, 0);
    hash.writeUInt32LE(nchain, 4);
  } else {
    hash.writeUInt32BE(1, 0);
    hash.writeUInt32BE(nchain, 4);
  }
  return { dynstr, dynsym, hash, symbolWidth, dynamicWidth, stringOffset };
};

const elfPropertyNote = (
  options: ElfHardeningFixtureOptions,
  bits: 32 | 64,
  little: boolean,
): Buffer => {
  if (options.longNoteName === true) {
    const name = Buffer.alloc(70000, 0x41);
    const note = Buffer.alloc(12 + name.length + 1 + 3);
    if (little) {
      note.writeUInt32LE(name.length + 1, 0);
      note.writeUInt32LE(5, 8);
    } else {
      note.writeUInt32BE(name.length + 1, 0);
      note.writeUInt32BE(5, 8);
    }
    name.copy(note, 12);
    return note;
  }
  if (options.property === undefined || options.property === null)
    return Buffer.alloc(0);
  const propertyAlign = bits === 64 ? 8 : 4;
  const one = (value: number): Buffer => {
    const descriptor = Buffer.alloc(propertyAlign === 8 ? 16 : 12);
    const propertyType =
      options.property?.arch === "aarch64" ? 0xc0000000 : 0xc0000002;
    if (little) {
      descriptor.writeUInt32LE(propertyType, 0);
      descriptor.writeUInt32LE(4, 4);
      descriptor.writeUInt32LE(value, 8);
    } else {
      descriptor.writeUInt32BE(propertyType, 0);
      descriptor.writeUInt32BE(4, 4);
      descriptor.writeUInt32BE(value, 8);
    }
    return elfNote("GNU", 5, descriptor, little, propertyAlign);
  };
  const first = one(options.property.value);
  if ((options.propertyCopies ?? 0) > 1)
    return Buffer.concat(
      Array.from({ length: options.propertyCopies ?? 1 }, () => first),
    );
  return Buffer.concat([
    first,
    ...(options.property.also === undefined
      ? []
      : [one(options.property.also)]),
  ]);
};

const elfDynamicTags = (
  options: ElfHardeningFixtureOptions,
  dynamic: boolean,
  symbols: ElfSymbolPayload,
): { tag: number; value: number }[] => {
  if (!dynamic) return [];
  const flags1 =
    (options.pieFlag === true ? DF_1_PIE : 0) |
    (options.bindNow === true ? DF_1_NOW : 0);
  return [
    { tag: DT_STRTAB, value: 0 },
    { tag: DT_SYMTAB, value: 0 },
    { tag: DT_STRSZ, value: symbols.dynstr.length },
    { tag: DT_SYMENT, value: symbols.symbolWidth },
    { tag: DT_HASH, value: 0 },
    ...(options.bindNow === true
      ? [{ tag: DT_FLAGS, value: DF_BIND_NOW }]
      : []),
    ...(options.duplicateFlags === true
      ? [
          { tag: DT_FLAGS, value: 0 },
          { tag: DT_FLAGS, value: DF_BIND_NOW },
        ]
      : []),
    ...(options.needed ?? []).map((name) => ({
      tag: DT_NEEDED,
      value: symbols.stringOffset(name) ?? 0,
    })),
    ...(options.bindNowTag === true ? [{ tag: DT_BIND_NOW, value: 0 }] : []),
    ...(flags1 !== 0 ? [{ tag: DT_FLAGS_1, value: flags1 }] : []),
    ...(options.rpath !== undefined && options.rpath !== null
      ? [{ tag: DT_RPATH, value: symbols.stringOffset(options.rpath) ?? 0 }]
      : []),
    ...(options.runpath !== undefined && options.runpath !== null
      ? [{ tag: DT_RUNPATH, value: symbols.stringOffset(options.runpath) ?? 0 }]
      : []),
    { tag: DT_NULL, value: 0 },
  ];
};

const elfPrograms = (
  options: ElfHardeningFixtureOptions,
  facts: {
    readonly dynamic: boolean;
    readonly interp: boolean;
    readonly headerSize: number;
    readonly dynamicWidth: number;
    readonly dynamicBytes: number;
    readonly interpBytes: number;
    readonly noteBytes: number;
    readonly propertyAlign: number;
    readonly gnuStack: { readonly flags: number } | null;
  },
): ElfProgramSpec[] => {
  const programs = [elfProgram(PT_LOAD, 5, 0, 0, 0x1000)];
  if (facts.interp)
    programs.push(
      elfProgram(PT_INTERP, PF_R, facts.interpBytes, facts.interpBytes, 1),
    );
  if (facts.dynamic)
    programs.push(
      elfProgram(
        PT_DYNAMIC,
        6,
        options.truncateDynamic === true ? 4 : facts.dynamicBytes,
        facts.dynamicBytes,
        facts.dynamicWidth,
      ),
    );
  const stackCount =
    facts.gnuStack === null ? 0 : options.duplicateStack === true ? 2 : 1;
  for (let index = 0; index < stackCount; index += 1)
    programs.push(
      elfProgram(PT_GNU_STACK, facts.gnuStack?.flags ?? 6, 0, 0, 0x10),
    );
  if (options.gnuRelro === true)
    programs.push(
      elfProgram(PT_GNU_RELRO, PF_R, facts.headerSize, facts.headerSize, 1),
    );
  if (facts.noteBytes !== 0)
    programs.push(
      elfProgram(
        options.propertyCarrier === "pt-note" ? 4 : PT_GNU_PROPERTY,
        PF_R,
        facts.noteBytes,
        facts.noteBytes,
        facts.propertyAlign,
      ),
    );
  return programs;
};

interface ElfPlacementFacts {
  readonly dynamic: boolean;
  readonly interp: boolean;
  readonly sections: boolean;
  readonly symtab: boolean;
  readonly headerSize: number;
  readonly phentsize: number;
  readonly shentsize: number;
  readonly symbolWidth: number;
  readonly dynamicWidth: number;
  readonly propertyAlign: number;
  readonly interpBytes: Buffer;
  readonly dynstr: Buffer;
  readonly dynsym: Buffer;
  readonly hash: Buffer;
  readonly note: Buffer;
  readonly buildId: Buffer;
  readonly buildIdSections: number;
  readonly compressedPropertyNote: boolean;
  readonly disjointNoteSections: number;
  readonly dynamicBytes: number;
  readonly programs: ElfProgramSpec[];
}

const elfSectionTable = (
  facts: ElfPlacementFacts,
  placed: {
    readonly interpAt: number;
    readonly dynstrAt: number;
    readonly dynsymAt: number;
    readonly dynamicAt: number;
    readonly noteAt: number;
    readonly buildIdAt: number;
    readonly disjointNotesAt: number;
    readonly symtabAt: number;
  },
): ElfSectionSpec[] => {
  const {
    interpAt,
    dynstrAt,
    dynsymAt,
    dynamicAt,
    noteAt,
    buildIdAt,
    disjointNotesAt,
    symtabAt,
  } = placed;
  const sectionTable: ElfSectionSpec[] = [
    { name: "", type: 0, offset: 0, size: 0, link: 0, entry: 0 },
  ];
  if (facts.interp)
    sectionTable.push({
      name: ".interp",
      type: SHT_PROGBITS,
      offset: interpAt,
      size: facts.interpBytes.length,
      link: 0,
      entry: 0,
    });
  if (facts.dynamic) {
    sectionTable.push({
      name: ".dynstr",
      type: SHT_STRTAB,
      offset: dynstrAt,
      size: facts.dynstr.length,
      link: 0,
      entry: 0,
    });
    sectionTable.push({
      name: ".dynsym",
      type: SHT_DYNSYM,
      offset: dynsymAt,
      size: facts.dynsym.length,
      link: 0,
      entry: facts.symbolWidth,
    });
    sectionTable.push({
      name: ".dynamic",
      type: SHT_DYNAMIC,
      offset: dynamicAt,
      size: facts.dynamicBytes,
      link: 0,
      entry: facts.dynamicWidth,
    });
  }
  if (facts.note.length !== 0)
    sectionTable.push({
      name: ".note.gnu.property",
      type: SHT_NOTE,
      offset: noteAt,
      size: facts.note.length,
      link: 0,
      entry: 0,
      ...(facts.compressedPropertyNote ? { flags: SHF_COMPRESSED } : {}),
    });
  for (let index = 0; index < facts.disjointNoteSections; index += 1)
    sectionTable.push({
      name: ".note.gnu.property",
      type: SHT_NOTE,
      offset: disjointNotesAt + index * 12,
      size: 12,
      link: 0,
      entry: 0,
      align: 4,
    });
  for (let index = 0; index < facts.buildIdSections; index += 1)
    sectionTable.push({
      name: ".note.gnu.build-id",
      type: SHT_NOTE,
      offset: buildIdAt,
      size: facts.buildId.length,
      link: 0,
      entry: 0,
      align: 4,
    });
  if (facts.symtab)
    sectionTable.push({
      name: ".symtab",
      type: SHT_SYMTAB,
      offset: symtabAt,
      size: facts.symbolWidth,
      link: 0,
      entry: facts.symbolWidth,
    });
  if (facts.sections)
    sectionTable.push({
      name: ".shstrtab",
      type: SHT_STRTAB,
      offset: 0,
      size: 0,
      link: 0,
      entry: 0,
    });
  return sectionTable;
};

const placeElfPayloads = (facts: ElfPlacementFacts): ElfPlacedImage => {
  let cursor = facts.headerSize + facts.programs.length * facts.phentsize;
  const take = (size: number, alignment = 8): number => {
    if (size === 0) return cursor;
    cursor += (alignment - (cursor % alignment)) % alignment;
    const at = cursor;
    cursor += size;
    return at;
  };
  const interpAt = facts.interp ? take(facts.interpBytes.length) : 0;
  const dynstrAt = facts.dynamic ? take(facts.dynstr.length) : 0;
  const dynsymAt = facts.dynamic ? take(facts.dynsym.length) : 0;
  const hashAt = facts.dynamic ? take(facts.hash.length) : 0;
  const noteAt =
    facts.note.length === 0 ? 0 : take(facts.note.length, facts.propertyAlign);
  const buildIdAt =
    facts.buildId.length === 0 ? 0 : take(facts.buildId.length, 4);
  const disjointNotesAt = take(facts.disjointNoteSections * 12, 4);
  const symtabAt = facts.symtab ? take(facts.symbolWidth) : 0;
  const dynamicAt = facts.dynamic
    ? take(facts.dynamicBytes, facts.dynamicWidth)
    : 0;
  const sectionNames = new Map<string, number>();
  const shstr = Buffer.alloc(256);
  let nameCursor = 1;
  const intern = (name: string): number => {
    const existing = sectionNames.get(name);
    if (existing !== undefined) return existing;
    const at = nameCursor;
    shstr.write(`${name}\0`, at, "latin1");
    nameCursor += name.length + 1;
    sectionNames.set(name, at);
    return at;
  };
  const sectionTable = elfSectionTable(facts, {
    interpAt,
    dynstrAt,
    dynsymAt,
    dynamicAt,
    noteAt,
    buildIdAt,
    disjointNotesAt,
    symtabAt,
  });
  for (const section of sectionTable)
    if (section.name !== "") intern(section.name);
  const shstrtab = shstr.subarray(0, nameCursor);
  const shstrAt = facts.sections ? take(shstrtab.length) : 0;
  const shoff = facts.sections
    ? take(sectionTable.length * facts.shentsize, 8)
    : 0;
  return {
    programs: facts.programs,
    sectionTable,
    shstrtab,
    intern,
    interpAt,
    dynstrAt,
    dynsymAt,
    hashAt,
    noteAt,
    buildIdAt,
    dynamicAt,
    shstrAt,
    shoff,
    fileSize: cursor,
  };
};

const elfWriters = (bytes: Buffer, little: boolean, bits: 32 | 64) => {
  const write16 = (at: number, value: number): void => {
    if (little) bytes.writeUInt16LE(value, at);
    else bytes.writeUInt16BE(value, at);
  };
  const write32 = (at: number, value: number): void => {
    if (little) bytes.writeUInt32LE(value, at);
    else bytes.writeUInt32BE(value, at);
  };
  const writeWord = (at: number, value: number): void => {
    if (bits === 64) {
      if (little) bytes.writeBigUInt64LE(BigInt(value), at);
      else bytes.writeBigUInt64BE(BigInt(value), at);
      return;
    }
    write32(at, value);
  };
  return { write16, write32, writeWord };
};

const writeElfHeader = (
  bytes: Buffer,
  facts: {
    readonly bits: 32 | 64;
    readonly little: boolean;
    readonly type: number;
    readonly machine: number;
    readonly sections: boolean;
    readonly headerSize: number;
    readonly phentsize: number;
    readonly shentsize: number;
    readonly programCount: number;
    readonly sectionCount: number;
    readonly shoff: number;
  },
): ReturnType<typeof elfWriters> => {
  const writers = elfWriters(bytes, facts.little, facts.bits);
  bytes.writeUInt32BE(0x7f454c46, 0);
  bytes[4] = facts.bits === 64 ? 2 : 1;
  bytes[5] = facts.little ? 1 : 2;
  bytes[6] = 1;
  writers.write16(16, facts.type);
  writers.write16(18, facts.machine);
  writers.write32(20, 1);
  const sectionCount = facts.sections ? facts.sectionCount : 0;
  if (facts.bits === 64) {
    writers.writeWord(32, facts.headerSize);
    writers.writeWord(40, facts.shoff);
    writers.write32(48, 0);
    writers.write16(52, facts.headerSize);
    writers.write16(54, facts.phentsize);
    writers.write16(56, facts.programCount);
    writers.write16(58, facts.shentsize);
    writers.write16(60, sectionCount);
    writers.write16(62, facts.sections ? facts.sectionCount - 1 : 0);
  } else {
    writers.write32(28, facts.headerSize);
    writers.write32(32, facts.shoff);
    writers.write32(36, 0);
    writers.write16(40, facts.headerSize);
    writers.write16(42, facts.phentsize);
    writers.write16(44, facts.programCount);
    writers.write16(46, facts.shentsize);
    writers.write16(48, sectionCount);
    writers.write16(50, facts.sections ? facts.sectionCount - 1 : 0);
  }
  return writers;
};

const assignElfProgramSpans = (
  programs: ElfProgramSpec[],
  facts: {
    readonly interp: boolean;
    readonly dynamic: boolean;
    readonly truncateDynamic: boolean;
    readonly noteBytes: number;
    readonly interpAt: number;
    readonly interpBytes: number;
    readonly dynamicAt: number;
    readonly dynamicBytes: number;
    readonly noteAt: number;
    readonly propertyType: number;
    readonly fileSize: number;
  },
): void => {
  const programAt = (typeId: number, payload: number, size: number): void => {
    const program = programs.find((candidate) => candidate.type === typeId);
    if (program === undefined) return;
    program.offset = payload;
    program.address = payload;
    program.filesz = size;
    program.memsz = size;
  };
  if (facts.interp) programAt(PT_INTERP, facts.interpAt, facts.interpBytes);
  if (facts.dynamic)
    programAt(
      PT_DYNAMIC,
      facts.dynamicAt,
      facts.truncateDynamic ? 4 : facts.dynamicBytes,
    );
  if (facts.noteBytes !== 0)
    programAt(facts.propertyType, facts.noteAt, facts.noteBytes);
  const load = programs[0];
  if (load === undefined) return;
  load.filesz = facts.fileSize;
  load.memsz = facts.fileSize;
};

const writeElfProgramHeaders = (
  programs: readonly ElfProgramSpec[],
  facts: {
    readonly bits: 32 | 64;
    readonly headerSize: number;
    readonly phentsize: number;
    readonly write32: (at: number, value: number) => void;
    readonly writeWord: (at: number, value: number) => void;
  },
): void => {
  programs.forEach((program, index) => {
    const at = facts.headerSize + index * facts.phentsize;
    facts.write32(at, program.type);
    if (facts.bits === 64) {
      facts.write32(at + 4, program.flags);
      facts.writeWord(at + 8, program.offset);
      facts.writeWord(at + 16, program.address);
      facts.writeWord(at + 24, program.address);
      facts.writeWord(at + 32, program.filesz);
      facts.writeWord(at + 40, program.memsz);
      facts.writeWord(at + 48, program.align);
      return;
    }
    facts.write32(at + 4, program.offset);
    facts.write32(at + 8, program.address);
    facts.write32(at + 12, program.address);
    facts.write32(at + 16, program.filesz);
    facts.write32(at + 20, program.memsz);
    facts.write32(at + 24, program.flags);
    facts.write32(at + 28, program.align);
  });
};

const writeElfDynamic = (
  bytes: Buffer,
  tags: readonly { tag: number; value: number }[],
  facts: {
    readonly bits: 32 | 64;
    readonly little: boolean;
    readonly dynamic: boolean;
    readonly interp: boolean;
    readonly dynamicAt: number;
    readonly dynamicWidth: number;
    readonly dynstrAt: number;
    readonly dynsymAt: number;
    readonly hashAt: number;
    readonly interpAt: number;
    readonly interpBytes: Buffer;
    readonly dynstr: Buffer;
    readonly dynsym: Buffer;
    readonly hash: Buffer;
  },
): void => {
  if (facts.interp) facts.interpBytes.copy(bytes, facts.interpAt);
  if (!facts.dynamic) return;
  facts.dynstr.copy(bytes, facts.dynstrAt);
  facts.dynsym.copy(bytes, facts.dynsymAt);
  facts.hash.copy(bytes, facts.hashAt);
  const valueFor = (tag: number, current: number): number => {
    if (tag === DT_STRTAB) return facts.dynstrAt;
    if (tag === DT_SYMTAB) return facts.dynsymAt;
    if (tag === DT_HASH) return facts.hashAt;
    return current;
  };
  tags.forEach((entry, index) => {
    const at = facts.dynamicAt + index * facts.dynamicWidth;
    const value = valueFor(entry.tag, entry.value);
    if (facts.bits === 64) {
      if (facts.little) {
        bytes.writeBigInt64LE(BigInt(entry.tag), at);
        bytes.writeBigUInt64LE(BigInt(value), at + 8);
      } else {
        bytes.writeBigInt64BE(BigInt(entry.tag), at);
        bytes.writeBigUInt64BE(BigInt(value), at + 8);
      }
      return;
    }
    if (facts.little) {
      bytes.writeInt32LE(entry.tag, at);
      bytes.writeUInt32LE(value, at + 4);
      return;
    }
    bytes.writeInt32BE(entry.tag, at);
    bytes.writeUInt32BE(value, at + 4);
  });
};

const writeElfSections = (
  bytes: Buffer,
  placed: ElfPlacedImage,
  facts: {
    readonly bits: 32 | 64;
    readonly sections: boolean;
    readonly shentsize: number;
    readonly write32: (at: number, value: number) => void;
    readonly writeWord: (at: number, value: number) => void;
  },
): void => {
  if (!facts.sections) return;
  placed.shstrtab.copy(bytes, placed.shstrAt);
  const dynstrIndex = placed.sectionTable.findIndex(
    (section) => section.name === ".dynstr",
  );
  const shstrIndex = placed.sectionTable.length - 1;
  placed.sectionTable.forEach((section, index) => {
    const at = placed.shoff + index * facts.shentsize;
    const link =
      section.name === ".dynsym" || section.name === ".dynamic"
        ? Math.max(dynstrIndex, 0)
        : section.name === ".symtab"
          ? shstrIndex
          : section.link;
    const offset =
      section.name === ".shstrtab" ? placed.shstrAt : section.offset;
    const size =
      section.name === ".shstrtab" ? placed.shstrtab.length : section.size;
    facts.write32(at, section.name === "" ? 0 : placed.intern(section.name));
    facts.write32(at + 4, section.type);
    facts.writeWord(at + 8, section.flags ?? 0);
    if (facts.bits === 64) {
      facts.writeWord(at + 16, offset);
      facts.writeWord(at + 24, offset);
      facts.writeWord(at + 32, size);
      facts.write32(at + 40, link);
      facts.writeWord(at + 48, section.align ?? 1);
      facts.writeWord(at + 56, section.entry);
      return;
    }
    facts.write32(at + 12, offset);
    facts.write32(at + 16, offset);
    facts.write32(at + 20, size);
    facts.write32(at + 24, link);
    facts.write32(at + 32, section.align ?? 1);
    facts.write32(at + 36, section.entry);
  });
};

/** Synthetic little- or big-endian ELF image with only the requested hardening facts. */
export const elfHardeningFixture = (
  options: ElfHardeningFixtureOptions = {},
): Buffer => {
  const bits = options.bits ?? 64;
  const little = options.little ?? true;
  const dynamic = options.dynamic ?? true;
  const interp = options.interp ?? false;
  const gnuStack =
    options.gnuStack === undefined ? { flags: 6 } : options.gnuStack;
  const sections = options.sections !== false && options.symbolBudget !== true;
  const symtab = (options.symtab ?? true) && sections;
  const headerSize = bits === 64 ? 64 : 52;
  const phentsize = bits === 64 ? 56 : 32;
  const shentsize = bits === 64 ? 64 : 40;
  const propertyAlign = bits === 64 ? 8 : 4;
  const symbols = elfSymbolPayload(options, bits, little);
  const note = elfPropertyNote(options, bits, little);
  const buildIdCount =
    options.buildIdCount ??
    (options.buildId === true || (options.buildIdSections ?? 0) > 0 ? 1 : 0);
  const buildId =
    buildIdCount === 0
      ? Buffer.alloc(0)
      : Buffer.concat(
          Array.from({ length: buildIdCount }, () =>
            gnuBuildIdNote(undefined, little),
          ),
        );
  const buildIdSections =
    buildId.length === 0 ? 0 : (options.buildIdSections ?? 1);
  const propertyType =
    options.propertyCarrier === "pt-note" ? 4 : PT_GNU_PROPERTY;
  const interpBytes = interp
    ? Buffer.from("/lib/interp\0", "latin1")
    : Buffer.alloc(0);
  const dynamicTags = elfDynamicTags(options, dynamic, symbols);
  const dynamicBytes = dynamicTags.length * symbols.dynamicWidth;
  const programs = elfPrograms(options, {
    dynamic,
    interp,
    headerSize,
    dynamicWidth: symbols.dynamicWidth,
    dynamicBytes,
    interpBytes: interpBytes.length,
    noteBytes: note.length,
    propertyAlign,
    gnuStack,
  });
  const placed = placeElfPayloads({
    dynamic,
    interp,
    sections,
    symtab,
    headerSize,
    phentsize,
    shentsize,
    symbolWidth: symbols.symbolWidth,
    dynamicWidth: symbols.dynamicWidth,
    propertyAlign,
    interpBytes,
    dynstr: symbols.dynstr,
    dynsym: symbols.dynsym,
    hash: symbols.hash,
    note,
    buildId,
    buildIdSections,
    compressedPropertyNote: options.compressedPropertyNote === true,
    disjointNoteSections: options.disjointNoteSections ?? 0,
    dynamicBytes,
    programs,
  });
  const bytes = Buffer.alloc(placed.fileSize);
  const writers = writeElfHeader(bytes, {
    bits,
    little,
    type: options.type ?? 3,
    machine: options.machine ?? (bits === 64 ? 62 : 3),
    sections,
    headerSize,
    phentsize,
    shentsize,
    programCount: programs.length,
    sectionCount: placed.sectionTable.length,
    shoff: placed.shoff,
  });
  assignElfProgramSpans(programs, {
    interp,
    dynamic,
    truncateDynamic: options.truncateDynamic === true,
    noteBytes: note.length,
    interpAt: placed.interpAt,
    interpBytes: interpBytes.length,
    dynamicAt: placed.dynamicAt,
    dynamicBytes,
    noteAt: placed.noteAt,
    propertyType,
    fileSize: placed.fileSize,
  });
  writeElfProgramHeaders(programs, {
    bits,
    headerSize,
    phentsize,
    write32: writers.write32,
    writeWord: writers.writeWord,
  });
  writeElfDynamic(bytes, dynamicTags, {
    bits,
    little,
    dynamic,
    interp,
    dynamicAt: placed.dynamicAt,
    dynamicWidth: symbols.dynamicWidth,
    dynstrAt: placed.dynstrAt,
    dynsymAt: placed.dynsymAt,
    hashAt: placed.hashAt,
    interpAt: placed.interpAt,
    interpBytes,
    dynstr: symbols.dynstr,
    dynsym: symbols.dynsym,
    hash: symbols.hash,
  });
  if (note.length !== 0) note.copy(bytes, placed.noteAt);
  if (buildId.length !== 0) buildId.copy(bytes, placed.buildIdAt);
  writeElfSections(bytes, placed, {
    bits,
    sections,
    shentsize,
    write32: writers.write32,
    writeWord: writers.writeWord,
  });
  return bytes;
};

export interface MachoHardeningFixtureOptions {
  readonly bits?: 32 | 64;
  readonly cpuType?: number;
  readonly cpuSubtype?: number;
  readonly flags?: number;
  readonly restrict?: boolean;
  /** Segment name, including an embedded NUL, instead of plain __RESTRICT. */
  readonly restrictName?: string;
  readonly codeSignature?: boolean;
  /** `null` omits the encryption command. `false` keeps cryptid 0. */
  readonly encrypted?: boolean | null;
  /** `null` omits LC_SYMTAB. `false` scans an empty symbol. */
  readonly stackChk?: boolean | null;
  readonly symbolName?: string;
  readonly nsyms?: number;
  readonly brokenStrx?: boolean;
  readonly bigEndian?: boolean;
  /** Mach-O filetype. Defaults to MH_EXECUTE. */
  readonly fileType?: number;
  /** Two encryption commands, so the slice status is malformed. */
  readonly duplicateEncryption?: boolean;
  /** 300 symbols sharing one long terminated name. */
  readonly symbolScanBudget?: boolean;
  /** One symbol whose name exceeds the per-name scan cap. */
  readonly longSymbolName?: boolean;
  /** N_SECT|N_EXT instead of an undefined external. */
  readonly definedSymbol?: boolean;
}

const MH_EXECUTE = 2;

const machoSymbolPayload = (
  options: MachoHardeningFixtureOptions,
  wide: boolean,
) => {
  const symbolName =
    options.symbolName ??
    (options.stackChk === true ? "___stack_chk_fail" : "");
  const wantSymtab =
    options.stackChk !== null && options.stackChk !== undefined
      ? true
      : options.nsyms !== undefined ||
        options.brokenStrx === true ||
        options.symbolScanBudget === true ||
        options.longSymbolName === true;
  const strings = options.symbolScanBudget
    ? Buffer.alloc(65537, 0x41)
    : options.longSymbolName === true
      ? Buffer.concat([
          Buffer.from([0]),
          Buffer.alloc(70000, 0x41),
          Buffer.from([0]),
        ])
      : Buffer.concat([
          Buffer.from([0]),
          Buffer.from(symbolName === "" ? "" : `${symbolName}\0`, "latin1"),
        ]);
  if (options.symbolScanBudget === true) {
    strings[0] = 0;
    strings[65536] = 0;
  }
  const nlistWidth = wide ? 16 : 12;
  const declaredSymbols = options.symbolScanBudget
    ? 300
    : (options.nsyms ??
      (options.brokenStrx === true ||
      symbolName !== "" ||
      options.longSymbolName === true
        ? 1
        : options.stackChk === false
          ? 1
          : 0));
  const storedSymbols =
    options.nsyms !== undefined && options.nsyms > 4096 ? 0 : declaredSymbols;
  const symbolBytes = Buffer.alloc(Math.max(storedSymbols, 0) * nlistWidth);
  const symbolType = options.definedSymbol === true ? 0x0f : 0x01;
  const writeSymbol = (index: number, nameOffset: number): void => {
    const at = index * nlistWidth;
    symbolBytes.writeUInt32LE(nameOffset, at);
    symbolBytes.writeUInt8(symbolType, at + 4);
  };
  if (options.symbolScanBudget === true) {
    for (let index = 0; index < storedSymbols; index += 1)
      writeSymbol(index, 1);
  } else if (options.brokenStrx === true && symbolBytes.length >= 4)
    writeSymbol(0, 50);
  else if (
    (symbolName !== "" || options.longSymbolName === true) &&
    symbolBytes.length >= 4
  )
    writeSymbol(0, 1);
  return { wantSymtab, strings, declaredSymbols, symbolBytes };
};

/** One little-endian Mach-O slice, or a big-endian header when requested. */
export const machoHardeningFixture = (
  options: MachoHardeningFixtureOptions = {},
): Buffer => {
  const bits = options.bits ?? 64;
  const wide = bits === 64;
  const headerSize = wide ? 32 : 28;
  const cpuType = options.cpuType ?? (wide ? 0x0100000c : 7);
  const cpuSubtype = options.cpuSubtype ?? 0;
  const flags = options.flags ?? 0x200000 | 0x1000000;
  const commands: Buffer[] = [];
  const segment = (name: string): Buffer => {
    const size = wide ? 72 : 56;
    const body = Buffer.alloc(size);
    body.writeUInt32LE(wide ? 0x19 : 0x1, 0);
    body.writeUInt32LE(size, 4);
    body.write(name, 8, "latin1");
    return body;
  };
  commands.push(segment("__TEXT"));
  if (options.restrict === true) commands.push(segment("__RESTRICT"));
  if (options.restrictName !== undefined)
    commands.push(segment(options.restrictName));
  const { wantSymtab, strings, declaredSymbols, symbolBytes } =
    machoSymbolPayload(options, wide);
  const commandSize = commands.reduce(
    (sum, command) => sum + command.length,
    0,
  );
  const symtabSize = wantSymtab ? 24 : 0;
  const signatureSize = options.codeSignature === true ? 16 : 0;
  const encryptionCopies =
    options.encrypted === undefined || options.encrypted === null
      ? 0
      : options.duplicateEncryption === true
        ? 2
        : 1;
  const encryptionSize = encryptionCopies === 0 ? 0 : wide ? 24 : 20;
  const tableSize =
    commandSize +
    symtabSize +
    signatureSize +
    encryptionSize * encryptionCopies;
  let cursor = headerSize + tableSize;
  cursor += (8 - (cursor % 8)) % 8;
  const symoff = cursor;
  cursor += symbolBytes.length;
  const stroff = cursor;
  const strsize = options.brokenStrx === true ? 4 : strings.length;
  cursor += options.brokenStrx === true ? 4 : strings.length;
  const bytes = Buffer.alloc(cursor);
  // Magic is identified by a big-endian read: little-endian images store CIGAM.
  bytes.writeUInt32BE(
    options.bigEndian === true
      ? wide
        ? 0xfeedfacf
        : 0xfeedface
      : wide
        ? 0xcffaedfe
        : 0xcefaedfe,
    0,
  );
  if (options.bigEndian === true) return bytes;
  bytes.writeUInt32LE(cpuType, 4);
  bytes.writeUInt32LE(cpuSubtype, 8);
  bytes.writeUInt32LE(options.fileType ?? MH_EXECUTE, 12);
  const pieces = [...commands];
  if (wantSymtab) {
    const body = Buffer.alloc(24);
    body.writeUInt32LE(0x2, 0);
    body.writeUInt32LE(24, 4);
    body.writeUInt32LE(symoff, 8);
    body.writeUInt32LE(declaredSymbols, 12);
    body.writeUInt32LE(stroff, 16);
    body.writeUInt32LE(strsize, 20);
    pieces.push(body);
  }
  if (options.codeSignature === true) {
    const body = Buffer.alloc(16);
    body.writeUInt32LE(0x1d, 0);
    body.writeUInt32LE(16, 4);
    pieces.push(body);
  }
  if (encryptionCopies !== 0) {
    for (let index = 0; index < encryptionCopies; index += 1) {
      const body = Buffer.alloc(encryptionSize);
      body.writeUInt32LE(wide ? 0x2c : 0x21, 0);
      body.writeUInt32LE(encryptionSize, 4);
      body.writeUInt32LE(options.encrypted ? 1 : 0, 16);
      pieces.push(body);
    }
  }
  bytes.writeUInt32LE(pieces.length, 16);
  bytes.writeUInt32LE(
    pieces.reduce((sum, piece) => sum + piece.length, 0),
    20,
  );
  bytes.writeUInt32LE(flags, 24);
  let at = headerSize;
  for (const piece of pieces) {
    piece.copy(bytes, at);
    at += piece.length;
  }
  symbolBytes.copy(bytes, symoff);
  if (options.brokenStrx === true) bytes.writeUInt32LE(0, stroff);
  else strings.copy(bytes, stroff);
  return bytes;
};

export interface FatSliceInput {
  readonly bytes: Buffer;
  readonly cpuType: number;
  readonly cpuSubtype: number;
  readonly fatCpuType?: number;
  readonly fatCpuSubtype?: number;
  /** Declared slice size. Larger than the payload extends past EOF. */
  readonly declaredSize?: number;
  /** When false, the payload is not copied and does not extend the file. */
  readonly includePayload?: boolean;
}

/** Universal Mach-O with alignment 2^0 so any slice offset after the table is valid. */
export const fatMachoHardeningFixture = (
  slices: readonly FatSliceInput[],
): Buffer => {
  const tableEnd = 8 + slices.length * 20;
  let cursor = tableEnd;
  const placed = slices.map((slice) => {
    const offset = cursor;
    const payload = slice.includePayload === false ? 0 : slice.bytes.length;
    cursor += payload;
    return { ...slice, offset, payload };
  });
  const bytes = Buffer.alloc(cursor);
  bytes.writeUInt32BE(0xcafebabe, 0);
  bytes.writeUInt32BE(slices.length, 4);
  placed.forEach((slice, index) => {
    const at = 8 + index * 20;
    bytes.writeUInt32BE(slice.fatCpuType ?? slice.cpuType, at);
    bytes.writeUInt32BE(slice.fatCpuSubtype ?? slice.cpuSubtype, at + 4);
    bytes.writeUInt32BE(slice.offset, at + 8);
    bytes.writeUInt32BE(slice.declaredSize ?? slice.bytes.length, at + 12);
    bytes.writeUInt32BE(0, at + 16);
    if (slice.payload !== 0) slice.bytes.copy(bytes, slice.offset);
  });
  return bytes;
};

export interface PeHardeningFixtureOptions {
  readonly bits?: 32 | 64;
  readonly characteristics?: number;
  readonly loadConfig?: boolean;
  readonly loadConfigSize?: number;
  readonly malformed?: PeLoadConfigFixtureMalformed;
  readonly certificate?: {
    readonly address: number;
    readonly size: number;
  } | null;
  readonly debug?: { readonly address: number; readonly size: number } | null;
}

/** PE load-config fixture with DllCharacteristics and optional certificate or debug directories. */
export const peHardeningImage = (
  options: PeHardeningFixtureOptions = {},
): Buffer => {
  const bytes = peLoadConfigImage({
    ...(options.bits === undefined ? {} : { bits: options.bits }),
    ...(options.loadConfig === undefined
      ? {}
      : { loadConfig: options.loadConfig }),
    ...(options.loadConfigSize === undefined
      ? {}
      : { loadConfigSize: options.loadConfigSize }),
    ...(options.malformed === undefined
      ? {}
      : { malformed: options.malformed }),
  });
  const pe = bytes.readUInt32LE(0x3c);
  const optional = pe + 24;
  bytes.writeUInt16LE(options.characteristics ?? 0x4160, optional + 70);
  const wide = bytes.readUInt16LE(optional) === 0x20b;
  const directories = optional + (wide ? 112 : 96);
  const writeDirectory = (
    index: number,
    entry:
      | { readonly address: number; readonly size: number }
      | null
      | undefined,
  ): void => {
    if (entry === undefined || entry === null) return;
    bytes.writeUInt32LE(entry.address, directories + index * 8);
    bytes.writeUInt32LE(entry.size, directories + index * 8 + 4);
  };
  writeDirectory(4, options.certificate);
  writeDirectory(6, options.debug);
  return bytes;
};
