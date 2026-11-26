import {
  BinaryFormatFailure,
  BinaryReader,
} from "../domain/binaryContainer.js";
import { firstKeyed, keyedBy } from "../domain/keyedCollection.js";
import { decodeLimit } from "../domain/parseFailure.js";
/**
 * Expected ELF carrier failure, carried as a shared parser failure so the
 * provider projects its kind, offset and field through
 * `parseFailureAnalysisError`.
 */
export class SolanaElfFailure extends BinaryFormatFailure {
  constructor(
    message: string,
    facts: {
      readonly kind?: "malformed" | "truncated" | "unsupported";
      readonly offset?: number;
      readonly field?: string;
    } = {},
  ) {
    const { kind = "malformed", offset, field } = facts;
    super(kind, message, {
      format: "elf",
      ...(offset === undefined || !Number.isSafeInteger(offset)
        ? {}
        : { offset }),
      ...(field === undefined ? {} : { field }),
    });
    this.name = "SolanaElfFailure";
  }
}

/**
 * Whole-parse expansion budget, derived from the capture size: the records
 * that all symbol and relocation tables together may expand to. Tables can
 * overlap, so a per-table extent check alone does not bound the parse.
 */
interface ExpansionBudget {
  records: number;
}

/** Name of the fixed allowance on distinct decoded dynamic-symbol name bytes. */
export const SOLANA_SYMBOL_NAME_LIMIT = "solana-elf-symbol-name-bytes";
/**
 * Distinct symbol names decoded per ELF. Names that share string bytes are
 * decoded once; suffix-sharing names can still expand quadratically in the
 * string table, so the retained total is bounded by this named allowance.
 */
export const SOLANA_MAX_SYMBOL_NAME_BYTES = 16 * 1024 * 1024;

export interface SolanaElfSection {
  readonly name: string;
  readonly type: number;
  readonly flags: number;
  readonly address: number;
  readonly offset: number;
  readonly size: number;
  readonly link: number;
  readonly entrySize: number;
}

export interface SolanaElfProgramHeader {
  readonly type: number;
  readonly flags: number;
  readonly offset: number;
  readonly virtualAddress: number;
  readonly fileSize: number;
  readonly memorySize: number;
}

export interface SolanaElfSymbol {
  readonly name: string;
  readonly info: number;
  readonly sectionIndex: number;
  readonly value: number;
  readonly size: number;
}

export interface SolanaElfRelocation {
  /** Virtual address of the instruction or word the relocation applies to. */
  readonly offset: number;
  /** Index into the dynamic symbol table; 0 when the target is unnamed. */
  readonly symbolIndex: number;
  /** Relocation type (R_BPF_64_64 = 8, R_BPF_64_32 = 10 for sBPF). */
  readonly type: number;
}

export interface SolanaElfImage {
  readonly bytes: Uint8Array;
  readonly byteOrder: "little" | "big";
  readonly elfType: number;
  readonly machine: number;
  readonly entrypoint: number;
  /** e_flags; for sBPF it names the bytecode version. */
  readonly elfFlags: number;
  readonly programHeaders: readonly SolanaElfProgramHeader[];
  readonly sections: readonly SolanaElfSection[];
  readonly dynamicSymbols: readonly SolanaElfSymbol[];
  readonly relocations: readonly SolanaElfRelocation[];
  /** File size minus the end of the last extent the ELF headers declare. */
  readonly trailingBytes: number;
}

export const ELF_MACHINE_BPF = 263;

/** Relocation type whose target word is a `call` immediate (sBPF). */
export const R_BPF_64_32 = 10;

/** Human-readable machine name; the format owns the architecture claim. */
export const solanaElfMachineName = (machine: number): string => {
  if (machine === ELF_MACHINE_BPF) return "bpf (Solana sBPF)";
  if (machine === 62) return "x86-64";
  if (machine === 183) return "aarch64";
  return `unknown-${String(machine)}`;
};

const SECTION_TYPE_DYNSYM = 11;
const ELF64_PROGRAM_HEADER_SIZE = 56;
const ELF64_SECTION_HEADER_SIZE = 64;
const ELF64_SYMBOL_SIZE = 24;
const ELF64_REL_SIZE = 16;
const SECTION_TYPE_NOBITS = 8;
const SECTION_TYPE_REL = 4;
const SECTION_TYPE_RELA = 9;

interface ElfReader {
  readonly u16: (offset: number) => number;
  readonly u32: (offset: number) => number;
  readonly u64: (offset: number) => number;
}

const elfReader = (bytes: Uint8Array, little: boolean): ElfReader => {
  const reader = new BinaryReader(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    little,
    "elf",
  );
  return {
    u16: (offset) => reader.u16(offset),
    u32: (offset) => reader.u32(offset),
    u64: (offset) => Number(reader.word(offset, 64)),
  };
};

const readString = (
  bytes: Uint8Array,
  tableOffset: number,
  tableSize: number,
  nameOffset: number,
): string => {
  if (nameOffset >= tableSize) return "";
  const start = tableOffset + nameOffset;
  let end = start;
  const limit = Math.min(tableOffset + tableSize, bytes.length);
  while (end < limit && bytes[end] !== 0) end += 1;
  return new TextDecoder("utf-8", { fatal: false }).decode(
    bytes.subarray(start, end),
  );
};

/**
 * Admit one header table before any per-entry allocation: the entry size must
 * hold the fields we read and the whole declared table must lie inside the
 * captured bytes, so a tiny file cannot expand into an unbounded loop.
 */
const assertTableExtent = (
  bytes: Uint8Array,
  label: string,
  tableOffset: number,
  entrySize: number,
  count: number,
  minimumEntrySize: number,
): void => {
  if (count === 0) return;
  if (entrySize < minimumEntrySize)
    throw new SolanaElfFailure(
      `${label} entry size ${String(entrySize)} is smaller than ${String(minimumEntrySize)} bytes.`,
      { offset: tableOffset, field: label },
    );
  if (
    !Number.isSafeInteger(tableOffset) ||
    !Number.isSafeInteger(count) ||
    tableOffset > bytes.length ||
    count > Math.floor((bytes.length - tableOffset) / entrySize)
  )
    throw new SolanaElfFailure(
      `${label} (${String(count)} entries of ${String(entrySize)} bytes at ${String(tableOffset)}) extends past the captured file.`,
      { kind: "truncated", offset: tableOffset, field: label },
    );
};

/** Bounded entry count for a section-described table that must lie inside the file. */
const sectionEntryCount = (
  bytes: Uint8Array,
  section: SolanaElfSection,
  label: string,
  minimumEntrySize: number,
  budget: ExpansionBudget,
): number => {
  if (section.entrySize < minimumEntrySize) return 0;
  const count = Math.floor(section.size / section.entrySize);
  assertTableExtent(
    bytes,
    label,
    section.offset,
    section.entrySize,
    count,
    minimumEntrySize,
  );
  if (count > budget.records)
    throw new SolanaElfFailure(
      `${label} entries across all tables exceed the ${String(Math.floor(bytes.length / ELF64_REL_SIZE))} records the captured file can hold; tables overlap.`,
      { offset: section.offset, field: label },
    );
  budget.records -= count;
  return count;
};

const readProgramHeaders = (
  bytes: Uint8Array,
  reader: ElfReader,
  tableOffset: number,
  entrySize: number,
  count: number,
): SolanaElfProgramHeader[] => {
  assertTableExtent(
    bytes,
    "Program header table",
    tableOffset,
    entrySize,
    count,
    ELF64_PROGRAM_HEADER_SIZE,
  );
  const headers: SolanaElfProgramHeader[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = tableOffset + index * entrySize;
    headers.push({
      type: reader.u32(offset),
      flags: reader.u32(offset + 4),
      offset: reader.u64(offset + 8),
      virtualAddress: reader.u64(offset + 16),
      fileSize: reader.u64(offset + 32),
      memorySize: reader.u64(offset + 40),
    });
  }
  return headers;
};

type RawSection = SolanaElfSection & { readonly nameOffset: number };

const readSectionHeader = (
  bytes: Uint8Array,
  reader: ElfReader,
  tableOffset: number,
  entrySize: number,
  index: number,
): RawSection => {
  if (entrySize < ELF64_SECTION_HEADER_SIZE)
    throw new SolanaElfFailure(
      `Section header entry size ${String(entrySize)} is smaller than ${String(ELF64_SECTION_HEADER_SIZE)} bytes.`,
    );
  const offset = tableOffset + index * entrySize;
  if (offset + ELF64_SECTION_HEADER_SIZE > bytes.length)
    throw new SolanaElfFailure("Section header table is truncated.");
  return {
    nameOffset: reader.u32(offset),
    name: "",
    type: reader.u32(offset + 4),
    flags: reader.u64(offset + 8),
    address: reader.u64(offset + 16),
    offset: reader.u64(offset + 24),
    size: reader.u64(offset + 32),
    link: reader.u32(offset + 40),
    entrySize: reader.u64(offset + 56),
  };
};

const readSections = (
  bytes: Uint8Array,
  reader: ElfReader,
  tableOffset: number,
  entrySize: number,
  count: number,
  nameIndex: number,
): SolanaElfSection[] => {
  assertTableExtent(
    bytes,
    "Section header table",
    tableOffset,
    entrySize,
    count,
    ELF64_SECTION_HEADER_SIZE,
  );
  const raw: RawSection[] = [];
  for (let index = 0; index < count; index += 1)
    raw.push(readSectionHeader(bytes, reader, tableOffset, entrySize, index));
  const nameSection = raw[nameIndex];
  return raw.map((section) => ({
    name:
      nameSection === undefined
        ? ""
        : readString(
            bytes,
            nameSection.offset,
            nameSection.size,
            section.nameOffset,
          ),
    type: section.type,
    flags: section.flags,
    address: section.address,
    offset: section.offset,
    size: section.size,
    link: section.link,
    entrySize: section.entrySize,
  }));
};

const readDynamicSymbols = (
  bytes: Uint8Array,
  reader: ElfReader,
  sections: readonly SolanaElfSection[],
  budget: ExpansionBudget,
): SolanaElfSymbol[] => {
  const symbols: SolanaElfSymbol[] = [];
  const names = new Map<number, string>();
  let nameBytes = 0;
  for (const section of sections) {
    if (section.type !== SECTION_TYPE_DYNSYM) continue;
    const strings = sections[section.link];
    if (strings === undefined) continue;
    const count = sectionEntryCount(
      bytes,
      section,
      "Dynamic symbol table",
      ELF64_SYMBOL_SIZE,
      budget,
    );
    for (let index = 0; index < count; index += 1) {
      const offset = section.offset + index * section.entrySize;
      const nameOffset = reader.u32(offset);
      const key = strings.offset + nameOffset;
      let name = names.get(key);
      if (name === undefined) {
        name = readString(bytes, strings.offset, strings.size, nameOffset);
        names.set(key, name);
        nameBytes += name.length;
        if (nameBytes > SOLANA_MAX_SYMBOL_NAME_BYTES)
          throw decodeLimit(
            "elf",
            `Distinct dynamic symbol names exceed the ${String(SOLANA_MAX_SYMBOL_NAME_BYTES)}-byte symbol name allowance.`,
            {
              name: SOLANA_SYMBOL_NAME_LIMIT,
              maximum: SOLANA_MAX_SYMBOL_NAME_BYTES,
              required: nameBytes,
            },
            { offset: section.offset, field: "Dynamic symbol table" },
          );
      }
      symbols.push({
        name,
        info: bytes[offset + 4] ?? 0,
        sectionIndex: reader.u16(offset + 6),
        value: reader.u64(offset + 8),
        size: reader.u64(offset + 16),
      });
    }
  }
  return symbols;
};

/**
 * Read relocation entries from REL/RELA sections. sBPF captures declare
 * 16-byte entries (offset + info) even in RELA-typed sections — the addend
 * lives in the relocated word itself — so entry size comes from the section
 * header, never from the section type alone.
 */
const readRelocations = (
  bytes: Uint8Array,
  reader: ElfReader,
  little: boolean,
  sections: readonly SolanaElfSection[],
  budget: ExpansionBudget,
): SolanaElfRelocation[] => {
  const relocations: SolanaElfRelocation[] = [];
  for (const section of sections) {
    if (section.type !== SECTION_TYPE_REL && section.type !== SECTION_TYPE_RELA)
      continue;
    const count = sectionEntryCount(
      bytes,
      section,
      "Relocation table",
      ELF64_REL_SIZE,
      budget,
    );
    for (let index = 0; index < count; index += 1) {
      const offset = section.offset + index * section.entrySize;
      // r_info packs the symbol index in its high word and the type in its
      // low word; which file word is which follows the ELF byte order.
      const first = reader.u32(offset + 8);
      const second = reader.u32(offset + 12);
      relocations.push({
        offset: reader.u64(offset),
        symbolIndex: little ? second : first,
        type: little ? first : second,
      });
    }
  }
  return relocations;
};

const declaredExtentEnd = (
  programHeaders: readonly SolanaElfProgramHeader[],
  sections: readonly SolanaElfSection[],
  sectionHeaderOffset: number,
  sectionHeaderCount: number,
  sectionHeaderEntrySize: number,
): number => {
  let end = 0;
  for (const header of programHeaders)
    end = Math.max(end, header.offset + header.fileSize);
  for (const section of sections)
    if (section.type !== SECTION_TYPE_NOBITS)
      end = Math.max(end, section.offset + section.size);
  if (sectionHeaderOffset !== 0)
    end = Math.max(
      end,
      sectionHeaderOffset + sectionHeaderCount * sectionHeaderEntrySize,
    );
  return end;
};

/**
 * Parse one ELF64 image with Node stdlib only. Solana sBPF programs are
 * ELF64 little-endian shared objects (ET_DYN, EM_BPF); big-endian headers are
 * parsed for completeness but rejected later by machine checks if foreign.
 */
export const parseSolanaElf = (bytes: Uint8Array): SolanaElfImage => {
  if (bytes.length < 64)
    throw new SolanaElfFailure(
      "File is shorter than an ELF64 header (64 bytes).",
      { kind: "truncated", offset: 0, field: "ELF header" },
    );
  if (
    bytes[0] !== 0x7f ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0x4c ||
    bytes[3] !== 0x46
  )
    throw new SolanaElfFailure("File does not start with the ELF magic.");
  if (bytes[4] !== 2)
    throw new SolanaElfFailure(
      `Expected a 64-bit ELF (EI_CLASS 2), found class ${String(bytes[4])}.`,
      { kind: "unsupported", offset: 4, field: "EI_CLASS" },
    );
  const encoding = bytes[5];
  if (encoding !== 1 && encoding !== 2)
    throw new SolanaElfFailure(
      `Unknown ELF data encoding ${String(encoding)}.`,
      { offset: 5, field: "EI_DATA" },
    );
  const reader = elfReader(bytes, encoding === 1);
  const programHeaderOffset = reader.u64(32);
  const sectionHeaderOffset = reader.u64(40);
  const programHeaderEntrySize = reader.u16(54);
  const programHeaderCount = reader.u16(56);
  const sectionHeaderEntrySize = reader.u16(58);
  let sectionHeaderCount = reader.u16(60);
  const sectionNameIndex = reader.u16(62);

  const programHeaders = readProgramHeaders(
    bytes,
    reader,
    programHeaderOffset,
    programHeaderEntrySize,
    programHeaderCount,
  );
  // Extended numbering stores the real section count in section header zero;
  // readSections admits that expanded count against the file before looping.
  if (sectionHeaderCount === 0 && sectionHeaderOffset !== 0)
    sectionHeaderCount = readSectionHeader(
      bytes,
      reader,
      sectionHeaderOffset,
      sectionHeaderEntrySize,
      0,
    ).size;
  const sections = readSections(
    bytes,
    reader,
    sectionHeaderOffset,
    sectionHeaderEntrySize,
    sectionHeaderCount,
    sectionNameIndex,
  );
  const budget: ExpansionBudget = {
    records: Math.floor(bytes.length / ELF64_REL_SIZE),
  };
  const declaredEnd = declaredExtentEnd(
    programHeaders,
    sections,
    sectionHeaderOffset,
    sectionHeaderCount,
    sectionHeaderEntrySize,
  );
  return {
    bytes,
    byteOrder: encoding === 1 ? "little" : "big",
    elfType: reader.u16(16),
    machine: reader.u16(18),
    entrypoint: reader.u64(24),
    programHeaders,
    sections,
    elfFlags: reader.u32(48),
    dynamicSymbols: readDynamicSymbols(bytes, reader, sections, budget),
    relocations: readRelocations(
      bytes,
      reader,
      encoding === 1,
      sections,
      budget,
    ),
    trailingBytes: Math.max(0, bytes.length - declaredEnd),
  };
};

/**
 * The sBPF bytecode version an ELF declares in e_flags: 0 through 4 as
 * written, the legacy EF_SBPF_V2 flag (0x20) as version 2, and null for any
 * declaration this reader does not recognize (never silently version 0).
 */
export const solanaSbpfVersion = (elfFlags: number): number | null =>
  elfFlags === 0x20 ? 2 : elfFlags >= 0 && elfFlags <= 4 ? elfFlags : null;

/** The executable code section: `.text` when named, else the first executable PROGBITS section. */
export const solanaTextSection = (
  image: SolanaElfImage,
): SolanaElfSection | undefined =>
  firstKeyed(
    keyedBy(image.sections, (section) => section.name),
    ".text",
    "the loader maps the first section named .text as program code",
  ) ??
  firstKeyed(
    keyedBy(image.sections, (section) =>
      section.type === 1 && (section.flags & 0x4) !== 0 ? "code" : null,
    ),
    "code",
    "without a .text section, the first executable PROGBITS section is code",
  );
