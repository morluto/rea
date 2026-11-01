import { assertArtifactReadActive } from "../../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { readElfDynamicEntry } from "../../domain/elfDynamicEntry.js";
import { elfArchitecture } from "../../domain/elfFixedHeader.js";
import { admitElfLoadSegment } from "../../domain/elfProgramHeader.js";
import { readElfSymbol } from "../../domain/elfSymbol.js";
import {
  readElfGnuHashSymbolCount,
  readElfHashSymbolCount,
  type ElfGnuHashCountWalk,
  type ElfHashCountFailure,
  type ElfHashWordReader,
} from "../../domain/elfHashSymbolCount.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  type BinaryHardeningImage,
  type BinaryHardeningRow,
  ELF_HARDENING_PROPERTIES,
  MAX_BINARY_HARDENING_SYMBOL_NAME_BYTES,
  MAX_BINARY_HARDENING_SYMBOL_SCAN_BYTES,
  MAX_BINARY_HARDENING_TABLE_ENTRIES,
} from "../../domain/native/binaryHardening.js";
import { MAX_INSPECT_ELF_NOTE_ENTRIES } from "../../domain/native/elfNotes.js";
import {
  elfStringTableText,
  observeElfStringTableEntry,
} from "../../domain/elfStringTable.js";
import {
  type ElfNoteTableWalk,
  type GnuPropertyWord,
  readGnuPropertyWords,
  walkElfNoteTables,
} from "../elf/ElfNoteParser.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../metadata/BinaryContainer.js";
import {
  ELF_PT_GNU_PROPERTY,
  ELF_PT_GNU_RELRO,
  ELF_PT_GNU_STACK,
  ELF_PT_INTERP,
  ELF_PT_NOTE,
  assertElfDeclaredRangesFromBuffer,
  readElfDirectoryFromBuffer,
  type ElfProgramDeclaration,
  type NativeSection,
} from "../metadata/NativeSectionDirectory.js";

const ET_EXEC = 2;
const ET_DYN = 3;
const SHT_SYMTAB = 2;
const SHT_NOTE = 7;
const SHT_DYNSYM = 11;
const DT_NULL = 0n;
const DT_HASH = 4n;
const DT_STRTAB = 5n;
const DT_SYMTAB = 6n;
const DT_STRSZ = 10n;
const DT_SYMENT = 11n;
const DT_RPATH = 15n;
const DT_RUNPATH = 29n;
const DT_FLAGS = 30n;
const DT_GNU_HASH = 0x6ffffef5n;
const DT_FLAGS_1 = 0x6ffffffbn;
const DT_BIND_NOW = 24n;
const DF_BIND_NOW = 0x8n;
const DF_1_NOW = 0x1n;
const DF_1_PIE = 0x08000000n;
const PF_X = 1;
const GNU_PROPERTY_AARCH64_FEATURE_1_AND = 0xc0000000;
const GNU_PROPERTY_X86_FEATURE_1_AND = 0xc0000002;
const SHF_COMPRESSED = 0x800n;
/** Tags hardening reads as a single value. Repeating tags such as DT_NEEDED stay. */
const SINGULAR_DYNAMIC_TAGS = new Set<bigint>([
  DT_HASH,
  DT_STRTAB,
  DT_SYMTAB,
  DT_STRSZ,
  DT_SYMENT,
  DT_RPATH,
  DT_RUNPATH,
  DT_FLAGS,
  DT_GNU_HASH,
  DT_FLAGS_1,
  DT_BIND_NOW,
]);
const EM_386 = 3;
const EM_PPC = 20;
const EM_PPC64 = 21;
const EM_ARM = 40;
const EM_X86_64 = 62;
const EM_AARCH64 = 183;
const EM_RISCV = 243;
/** Linux treats a missing PT_GNU_STACK as read-implies-exec on these machines. */
const EXECUTABLE_STACK_DEFAULT = new Set([EM_386, EM_PPC, EM_ARM]);
const NON_EXECUTABLE_STACK_DEFAULT = new Set([
  EM_PPC64,
  EM_X86_64,
  EM_AARCH64,
  EM_RISCV,
]);

function malformed(message: string): never {
  throw new BinaryFormatFailure("malformed", message);
}

const exact = (value: bigint, label: string): number => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    malformed(`${label} exceeds exact host precision`);
  return Number(value);
};

const budgetFailure = (count: number, label: string): BinaryResourceFailure =>
  new BinaryResourceFailure(
    "structure",
    MAX_BINARY_HARDENING_TABLE_ENTRIES,
    `${label} has ${String(count)} entries, above the ${String(MAX_BINARY_HARDENING_TABLE_ENTRIES)}-entry structural budget. This release has no runtime override.`,
  );

const budget = (count: number, label: string): void => {
  if (count > MAX_BINARY_HARDENING_TABLE_ENTRIES)
    throw budgetFailure(count, label);
};

type RowInput = {
  readonly property: BinaryHardeningRow["property"];
  readonly state: BinaryHardeningRow["state"];
  readonly confidence: BinaryHardeningRow["confidence"];
  readonly basis: string;
  readonly location?: BinaryHardeningRow["location"];
  readonly note?: string | null;
};

const row = ({
  property,
  state,
  confidence,
  basis,
  location = null,
  note = null,
}: RowInput): BinaryHardeningRow => ({
  property,
  state,
  confidence,
  basis,
  location,
  note,
  next_probe: null,
});

type LinkedProperty = "nx" | "relro" | "rpath" | "runpath";
type SpanProgram = Exclude<ElfProgramDeclaration, { type: 2 }>;
type FileMapping = { readonly offset: number; readonly available: bigint };
type MapVa = (va: bigint, size: bigint) => FileMapping;

const isSpan = (program: ElfProgramDeclaration): program is SpanProgram =>
  program.type !== 2;

/** Read ELF hardening from headers, program headers, notes, and dynamic symbols. */
export const readElfHardening = (
  bytes: Buffer,
  signal?: AbortSignal,
): BinaryHardeningImage => {
  assertArtifactReadActive(signal);
  const directory = readElfDirectoryFromBuffer(bytes);
  // A report needs every declared payload, not only the tables that name them.
  assertElfDeclaredRangesFromBuffer(bytes);
  const { bits, little, machine, programs, sections } = directory;
  const headerWidth = bits === 64 ? 56 : 32;
  const symbolWidth = bits === 64 ? 24 : 16;
  const dynamicWidth = bits === 64 ? 16 : 8;
  const propertyAlign = bits === 64 ? 8 : 4;
  const loads = programs.filter(isSpan).filter((program) => program.type === 1);
  for (const load of loads) {
    const admitted = admitElfLoadSegment(
      {
        virtualAddress: load.virtual_address,
        memorySize: load.memory_size,
        fileSize: load.file_size,
      },
      bits,
    );
    if (!admitted.ok) malformed(admitted.error.message);
  }
  const mapVa: MapVa = (va, size) => mapVirtualAddress(loads, va, size);
  const one = (
    type: SpanProgram["type"],
    label: string,
  ): SpanProgram | null => {
    const found = programs.filter(
      (program): program is SpanProgram => program.type === type,
    );
    if (found.length > 1) malformed(`ELF image has more than one ${label}`);
    return found[0] ?? null;
  };
  const dynamicPrograms = programs.filter((program) => program.type === 2);
  if (dynamicPrograms.length > 1)
    malformed("ELF image has more than one PT_DYNAMIC");
  const interp = one(ELF_PT_INTERP, "PT_INTERP");
  if (interp !== null) admitInterp(bytes, interp);
  const stack = one(ELF_PT_GNU_STACK, "PT_GNU_STACK");
  const relro = one(ELF_PT_GNU_RELRO, "PT_GNU_RELRO");
  const propertyProgram = one(ELF_PT_GNU_PROPERTY, "PT_GNU_PROPERTY");
  const dynamic =
    dynamicPrograms[0] === undefined
      ? null
      : readDynamic(
          bytes,
          dynamicPrograms[0],
          bits,
          little,
          dynamicWidth,
          mapVa,
        );
  let symbols: SymbolScan;
  try {
    symbols = readSymbols(
      bytes,
      sections,
      dynamic,
      little,
      mapVa,
      bits,
      signal,
    );
  } catch (cause) {
    // One import table above the entry budget must not drop PIE, NX, or RELRO.
    // The import rows stay unknown.
    if (!(cause instanceof BinaryResourceFailure)) throw cause;
    symbols = { state: "unresolved", reason: cause.message, names: [] };
  }
  const features = readFeatureNotes(
    bytes,
    sections,
    propertyProgram,
    programs.filter(
      (program): program is SpanProgram => program.type === ELF_PT_NOTE,
    ),
    little,
    propertyAlign,
    signal,
  );
  const linkedRow = (
    property: LinkedProperty,
    build: () => BinaryHardeningRow,
  ): BinaryHardeningRow =>
    directory.elf_type !== ET_EXEC && directory.elf_type !== ET_DYN
      ? row({
          property,
          state: "not_applicable",
          confidence: "observed",
          basis: `e_type ${String(directory.elf_type)} is neither ET_EXEC nor ET_DYN, so this linked-image property does not apply.`,
          location: { offset: 16, bytes: 2 },
        })
      : programs.length === 0
        ? unreadProgramsRow(property)
        : build();
  const rows = [
    pieRow(directory.elf_type, interp, dynamic, headerWidth, programs.length),
    linkedRow("nx", () => nxRow(stack, machine, bits)),
    linkedRow("relro", () => relroRow(relro, dynamic, headerWidth)),
    symbolRow(
      "stack_protector",
      symbols,
      (name) =>
        name === "__stack_chk_fail" || name === "__stack_chk_fail_local",
      "No __stack_chk_fail symbol was found in the dynamic symbol table. A static or stripped image can omit that import while still using a stack protector.",
      "The dynamic symbol table is absent, so stack protector use is unknown.",
    ),
    symbolRow(
      "fortify",
      symbols,
      (name) =>
        name === "__fortify_fail" ||
        (name.startsWith("__") && name.endsWith("_chk")),
      "No fortify symbol was found in the dynamic symbol table. A static or stripped image can omit those imports while still using FORTIFY.",
      "The dynamic symbol table is absent, so FORTIFY use is unknown.",
    ),
    featureRow(
      "cet_ibt_shstk",
      machine === EM_386 || machine === EM_X86_64,
      features.words.get(GNU_PROPERTY_X86_FEATURE_1_AND) ?? null,
      "CET IBT and SHSTK",
      features,
    ),
    featureRow(
      "aarch64_bti_pac",
      machine === EM_AARCH64,
      features.words.get(GNU_PROPERTY_AARCH64_FEATURE_1_AND) ?? null,
      "AArch64 BTI and PAC",
      features,
    ),
    linkedRow("rpath", () => pathRow("rpath", "DT_RPATH", dynamic)),
    linkedRow("runpath", () => pathRow("runpath", "DT_RUNPATH", dynamic)),
    strippedRow(sections, bits),
  ];
  if (
    rows.map(({ property }) => property).join() !==
    ELF_HARDENING_PROPERTIES.join()
  )
    malformed("ELF hardening rows are incomplete");
  return {
    format: "elf",
    status: "parsed",
    reason: null,
    architecture: elfArchitecture(machine) ?? null,
    bits,
    byte_order: little ? "little" : "big",
    machine,
    slice: null,
    rows,
  };
};

/** PIE reads this header's presence, so it must name a loadable path. */
const admitInterp = (bytes: Buffer, interp: SpanProgram): void => {
  const end = exact(interp.file_offset + interp.file_size, "PT_INTERP range");
  if (interp.file_size < 2n || bytes[end - 1] !== 0)
    malformed("ELF PT_INTERP is not a NUL-terminated path");
};

const mapVirtualAddress = (
  loads: readonly SpanProgram[],
  va: bigint,
  size: bigint,
): FileMapping => {
  const matches: FileMapping[] = [];
  for (const load of loads) {
    if (
      va < load.virtual_address ||
      va >= load.virtual_address + load.memory_size
    )
      continue;
    const delta = va - load.virtual_address;
    if (delta >= load.file_size || size > load.file_size - delta)
      malformed("ELF virtual address range is not file-backed in its PT_LOAD");
    matches.push({
      offset: exact(load.file_offset + delta, "ELF virtual address"),
      available: load.file_size - delta,
    });
  }
  if (matches.length !== 1)
    malformed("ELF virtual address does not map through exactly one PT_LOAD");
  return matches[0]!;
};

type DynamicEntry = {
  readonly value: bigint;
  readonly offset: number;
  readonly bytes: number;
};

type DynamicTable = {
  readonly flags: bigint;
  readonly flags1: bigint;
  readonly entries: ReadonlyMap<bigint, DynamicEntry>;
  readonly strings: Buffer | null;
  readonly stringFileOffset: number | null;
};

const readDynamic = (
  bytes: Buffer,
  program: Extract<ElfProgramDeclaration, { type: 2 }>,
  bits: 32 | 64,
  little: boolean,
  width: number,
  mapVa: MapVa,
): DynamicTable => {
  const offset = exact(program.offset, "PT_DYNAMIC offset");
  const size = exact(program.size, "PT_DYNAMIC size");
  if (size % width !== 0)
    malformed("ELF PT_DYNAMIC size is not a whole number of entries");
  const count = size / width;
  budget(count, "ELF dynamic table");
  if (size > bytes.length - offset)
    malformed("ELF PT_DYNAMIC extends outside the file");
  const entries = new Map<bigint, DynamicEntry>();
  let terminated = false;
  for (let index = 0; index < count; index += 1) {
    const at = offset + index * width;
    const parsed = readElfDynamicEntry(
      bytes.subarray(at, at + width),
      bits,
      little,
    );
    if (!parsed.ok) malformed(parsed.error.message);
    if (parsed.value.tag === DT_NULL) {
      terminated = true;
      break;
    }
    if (!SINGULAR_DYNAMIC_TAGS.has(parsed.value.tag)) continue;
    if (entries.has(parsed.value.tag))
      malformed(`ELF dynamic tag ${parsed.value.tag.toString()} is duplicated`);
    entries.set(parsed.value.tag, {
      value: parsed.value.value,
      offset: at,
      bytes: width,
    });
  }
  if (!terminated) malformed("ELF dynamic table has no DT_NULL terminator");
  const strtab = entries.get(DT_STRTAB);
  const strsz = entries.get(DT_STRSZ);
  if ((strtab === undefined) !== (strsz === undefined))
    malformed("ELF dynamic string table is missing DT_STRTAB or DT_STRSZ");
  let strings: Buffer | null = null;
  let stringFileOffset: number | null = null;
  if (strtab !== undefined && strsz !== undefined) {
    const stringSize = exact(strsz.value, "DT_STRSZ");
    stringFileOffset = mapVa(strtab.value, strsz.value).offset;
    if (stringSize > bytes.length - stringFileOffset)
      malformed("ELF dynamic string table extends outside the file");
    strings = bytes.subarray(stringFileOffset, stringFileOffset + stringSize);
  }
  return {
    flags: entries.get(DT_FLAGS)?.value ?? 0n,
    flags1: entries.get(DT_FLAGS_1)?.value ?? 0n,
    entries,
    strings,
    stringFileOffset,
  };
};

type SymbolName = {
  readonly name: string;
  readonly offset: number;
  readonly bytes: number;
};
/** `unresolved` keeps the names read so far. A sign among them still counts. */
type SymbolScan =
  | {
      readonly state: "absent" | "scanned";
      readonly names: readonly SymbolName[];
    }
  | {
      readonly state: "unresolved";
      readonly reason: string;
      readonly names: readonly SymbolName[];
    };

/**
 * The loader reads DT_SYMTAB and DT_STRTAB, so section headers cannot declare
 * imports. An SHT_DYNSYM section only supplies a count DT_HASH and DT_GNU_HASH
 * leave open, and only while it names the same tables.
 */
const readSymbols = (
  bytes: Buffer,
  sections: readonly NativeSection[],
  dynamic: DynamicTable | null,
  little: boolean,
  mapVa: MapVa,
  bits: 32 | 64,
  signal?: AbortSignal,
): SymbolScan => {
  const dynsym = sections.filter((section) => section.type === SHT_DYNSYM);
  if (dynsym.length > 1) malformed("ELF image has more than one SHT_DYNSYM");
  const section = dynsym[0];
  const symtab = dynamic?.entries.get(DT_SYMTAB);
  if (dynamic === null || symtab === undefined)
    return section === undefined
      ? { state: "absent", names: [] }
      : {
          state: "unresolved",
          reason:
            "An SHT_DYNSYM section exists, but no DT_SYMTAB declares it, so its names are not established as imports.",
          names: [],
        };
  const width = bits === 64 ? 24 : 16;
  const syment = dynamic.entries.get(DT_SYMENT);
  if (syment !== undefined && syment.value !== BigInt(width))
    malformed("ELF DT_SYMENT does not match the ELF class symbol width");
  if (dynamic.strings === null || dynamic.stringFileOffset === null)
    malformed("ELF DT_SYMTAB is present without a dynamic string table");
  const count =
    symbolCount(bytes, dynamic, bits, little, mapVa, signal) ??
    agreeingSectionCount(sections, section, dynamic, symtab, width, mapVa);
  if (count === null)
    return {
      state: "unresolved",
      reason: dynamic.entries.has(DT_GNU_HASH)
        ? "DT_GNU_HASH has no hashed symbols and no agreeing SHT_DYNSYM section gives the count, so the dynamic symbol table could not be read."
        : "Neither DT_HASH nor DT_GNU_HASH is present and no agreeing SHT_DYNSYM section gives the count, so the dynamic symbol table could not be read.",
      names: [],
    };
  budget(count, "ELF dynamic symbol table");
  const base = mapVa(symtab.value, BigInt(count * width)).offset;
  if (count * width > bytes.length - base)
    malformed("ELF dynamic symbol table extends outside the file");
  return readSymbolNames(
    bytes,
    base,
    count,
    bits,
    little,
    dynamic.strings,
    dynamic.stringFileOffset,
  );
};

/** The SHT_DYNSYM count, or null unless it names the dynamic tables' bytes. */
const agreeingSectionCount = (
  sections: readonly NativeSection[],
  dynsym: NativeSection | undefined,
  dynamic: DynamicTable,
  symtab: DynamicEntry,
  width: number,
  mapVa: MapVa,
): number | null => {
  if (dynsym === undefined) return null;
  const strings = sections[dynsym.link];
  if (
    dynsym.address !== symtab.value ||
    strings?.address !== dynamic.entries.get(DT_STRTAB)?.value ||
    strings?.size !== dynamic.entries.get(DT_STRSZ)?.value ||
    strings?.offset !== BigInt(dynamic.stringFileOffset ?? -1)
  )
    return null;
  const entry = dynsym.entry_size === 0n ? BigInt(width) : dynsym.entry_size;
  if (entry !== BigInt(width))
    malformed("ELF SHT_DYNSYM entry size does not match the ELF class");
  const size = exact(dynsym.size, "SHT_DYNSYM size");
  if (size % width !== 0)
    malformed("ELF SHT_DYNSYM size is not a whole number of symbols");
  const count = size / width;
  budget(count, "ELF dynamic symbol table");
  return mapVa(symtab.value, dynsym.size).offset ===
    exact(dynsym.offset, "SHT_DYNSYM offset")
    ? count
    : null;
};

const readSymbolNames = (
  bytes: Buffer,
  offset: number,
  count: number,
  bits: 32 | 64,
  little: boolean,
  strings: Buffer,
  stringFileOffset: number,
): SymbolScan => {
  const width = bits === 64 ? 24 : 16;
  const names: SymbolName[] = [];
  let scanned = 0;
  let unterminated = false;
  for (let index = 0; index < count; index += 1) {
    const at = offset + index * width;
    const symbol = readElfSymbol(bytes.subarray(at, at + width), bits, little);
    if (!symbol.ok) malformed(symbol.error.message);
    const nameOffset = symbol.value.name_offset;
    if (nameOffset === 0) continue;
    // SHN_UNDEF is an import. A defined export of the same name is not a sign
    // that this image references the protector.
    if (symbol.value.section_index !== 0) continue;
    const observed = observeElfStringTableEntry(
      strings,
      nameOffset,
      MAX_BINARY_HARDENING_SYMBOL_NAME_BYTES,
    );
    scanned += observed.examinedBytes;
    if (scanned > MAX_BINARY_HARDENING_SYMBOL_SCAN_BYTES)
      return {
        state: "unresolved",
        reason: `ELF symbol name scans examined more than the ${String(MAX_BINARY_HARDENING_SYMBOL_SCAN_BYTES)}-byte structural budget, so this import sign is unknown.`,
        names,
      };
    if (observed.state === "outside")
      malformed("ELF dynamic symbol name offset is outside the string table");
    // A name past the window is unresolved. Later symbols can still carry the sign.
    if (observed.state === "truncated") {
      unterminated = true;
      continue;
    }
    names.push({
      name: elfStringTableText(observed) ?? "",
      offset: stringFileOffset + nameOffset,
      bytes: observed.contentBytes,
    });
  }
  return unterminated
    ? {
        state: "unresolved",
        reason: `An undefined dynamic symbol name has no NUL within the string table or the ${String(MAX_BINARY_HARDENING_SYMBOL_NAME_BYTES)}-byte name budget, so this import sign is unknown.`,
        names,
      }
    : { state: "scanned", names };
};

const hashWords = (
  bytes: Buffer,
  va: bigint,
  mapVa: MapVa,
  little: boolean,
): ElfHashWordReader => {
  const mapping = mapVa(va, 4n);
  return (relative) => {
    // Hash readers may jump over bloom filters or chains. Validate the whole
    // prefix, including skipped bytes, in the same file-backed mapping.
    if (BigInt(relative + 4) > mapping.available)
      return err("is not file-backed in its PT_LOAD");
    const at = mapping.offset + relative;
    if (at > bytes.length - 4) return err("extends outside the file");
    return ok(little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at));
  };
};

const finishGnuHashCount = (
  walk: ElfGnuHashCountWalk,
  signal: AbortSignal | undefined,
): Result<number | null, ElfHashCountFailure> => {
  for (let step = walk.next(); ; step = walk.next()) {
    if (step.done === true) return step.value;
    assertArtifactReadActive(signal);
  }
};

const admitHashCount = (
  counted: Result<number | null, ElfHashCountFailure>,
): number | null => {
  if (counted.ok) return counted.value;
  if (counted.error.kind === "budget")
    throw budgetFailure(counted.error.count, `ELF ${counted.error.label}`);
  return malformed(`ELF ${counted.error.message}`);
};

const symbolCount = (
  bytes: Buffer,
  dynamic: DynamicTable,
  bits: 32 | 64,
  little: boolean,
  mapVa: MapVa,
  signal?: AbortSignal,
): number | null => {
  const hash = dynamic.entries.get(DT_HASH);
  const gnu = dynamic.entries.get(DT_GNU_HASH);
  const classic =
    hash === undefined
      ? null
      : admitHashCount(
          readElfHashSymbolCount(
            hashWords(bytes, hash.value, mapVa, little),
            MAX_BINARY_HARDENING_TABLE_ENTRIES,
          ),
        );
  const gnuCount =
    gnu === undefined
      ? null
      : admitHashCount(
          finishGnuHashCount(
            readElfGnuHashSymbolCount(
              hashWords(bytes, gnu.value, mapVa, little),
              bits === 64 ? 8 : 4,
              MAX_BINARY_HARDENING_TABLE_ENTRIES,
            ),
            signal,
          ),
        );
  if (classic !== null && gnuCount !== null && classic !== gnuCount)
    malformed("ELF DT_HASH and DT_GNU_HASH report different symbol counts");
  return classic ?? gnuCount;
};

interface FeatureNotes {
  readonly words: Map<number, GnuPropertyWord>;
  /** True when section headers or PT_GNU_PROPERTY were available to search. */
  readonly searched: boolean;
  /** Why the search stopped short, so an absent word is not an absent feature. */
  readonly incomplete: string | null;
}

const noteTable = (
  bytes: Buffer,
  offset: number,
  size: number,
  alignment: number | bigint,
  label: string,
): ElfNoteTableWalk => {
  if (size > bytes.length - offset)
    malformed(`ELF ${label} extends outside the file`);
  return { offset, size, alignment };
};

type NoteSpan = { readonly offset: number; readonly size: number };

const byOffset = <T extends NoteSpan>(spans: readonly T[]): T[] =>
  spans.filter(({ size }) => size > 0).toSorted((a, b) => a.offset - b.offset);

/**
 * Overlap queries over spans sorted once. A section table can hold hundreds of
 * thousands of headers, so a query must not rescan the spans.
 */
const overlapIndex = (spans: readonly NoteSpan[]) => {
  const sorted: NoteSpan[] = [];
  for (const span of byOffset(spans)) {
    const previous = sorted.at(-1);
    if (
      previous !== undefined &&
      span.offset <= previous.offset + previous.size
    )
      sorted[sorted.length - 1] = {
        offset: previous.offset,
        size: Math.max(
          previous.size,
          span.offset + span.size - previous.offset,
        ),
      };
    else sorted.push(span);
  }
  return ({ offset, size }: NoteSpan): "none" | "covered" | "partial" => {
    if (size <= 0) return "none";
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((sorted[middle]?.offset ?? 0) < offset + size) low = middle + 1;
      else high = middle;
    }
    const span = sorted[low - 1];
    if (span === undefined || span.offset + span.size <= offset) return "none";
    return span.offset <= offset && span.offset + span.size >= offset + size
      ? "covered"
      : "partial";
  };
};

/**
 * A section and a program header often name the same bytes with different
 * alignment, and walking both charges every note twice. Earlier tiers win, and
 * the lowest offset wins within a tier.
 */
const admitDisjointTables = (
  accepted: readonly ElfNoteTableWalk[],
  candidates: readonly ElfNoteTableWalk[],
  unresolvedOverlap: () => void,
): ElfNoteTableWalk[] => {
  const overlapsAccepted = overlapIndex(accepted);
  const admitted = [...accepted];
  let end = -1;
  for (const candidate of byOffset(candidates)) {
    const overlap = overlapsAccepted(candidate);
    if (overlap !== "none" || candidate.offset < end) {
      // Only fully covered aliases establish that no notes were omitted.
      // A cut through a table need not be a note boundary; do not interpret it
      // as an independent stream or claim that its uncovered notes are absent.
      if (overlap !== "covered" && candidate.offset + candidate.size > end)
        unresolvedOverlap();
      continue;
    }
    admitted.push(candidate);
    end = candidate.offset + candidate.size;
  }
  return admitted;
};

const readFeatureNotes = (
  bytes: Buffer,
  sections: readonly NativeSection[],
  program: SpanProgram | null,
  notePrograms: readonly SpanProgram[],
  little: boolean,
  propertyAlign: number,
  signal?: AbortSignal,
): FeatureNotes => {
  assertArtifactReadActive(signal);
  const searched = sections.length > 0 || program !== null;
  const propertyProgram =
    program === null
      ? []
      : [
          noteTable(
            bytes,
            exact(program.file_offset, "PT_GNU_PROPERTY offset"),
            exact(program.file_size, "PT_GNU_PROPERTY size"),
            program.alignment,
            "PT_GNU_PROPERTY",
          ),
        ];
  const propertySections: ElfNoteTableWalk[] = [];
  const otherSpans: NoteSpan[] = [];
  let incomplete: string | null = null;
  for (const section of sections) {
    if (section.type !== SHT_NOTE) continue;
    const compressed = (section.flags & SHF_COMPRESSED) !== 0n;
    if (compressed)
      incomplete ??=
        "A compressed SHT_NOTE section may hold GNU property notes, and its descriptors were not read.";
    if (compressed) {
      if (!section.file_backed) continue;
      otherSpans.push({
        offset: exact(section.offset, "SHT_NOTE offset"),
        size: exact(section.size, "SHT_NOTE size"),
      });
      continue;
    }
    if (!section.file_backed) malformed("ELF SHT_NOTE is not file-backed");
    propertySections.push(
      noteTable(
        bytes,
        exact(section.offset, "SHT_NOTE offset"),
        exact(section.size, "SHT_NOTE size"),
        section.alignment,
        "SHT_NOTE",
      ),
    );
  }
  const overlapsProperty = overlapIndex([
    ...propertyProgram,
    ...propertySections,
  ]);
  const overlapsOther = overlapIndex(otherSpans);
  const programTables: ElfNoteTableWalk[] = [];
  for (const noteProgram of notePrograms) {
    const span = {
      offset: exact(noteProgram.file_offset, "PT_NOTE offset"),
      size: exact(noteProgram.file_size, "PT_NOTE size"),
    };
    const property = overlapsProperty(span) !== "none";
    // Do not reinterpret compressed section bytes through a program alias.
    if (overlapsOther(span) !== "none" && !property) continue;
    programTables.push(
      noteTable(
        bytes,
        span.offset,
        span.size,
        noteProgram.alignment,
        "PT_NOTE",
      ),
    );
  }
  const unresolvedOverlap = (): void => {
    incomplete ??=
      "Overlapping ELF note tables leave uncovered bytes whose note boundaries were not resolved.";
  };
  const tables = admitDisjointTables(
    admitDisjointTables(
      byOffset(propertyProgram),
      propertySections,
      unresolvedOverlap,
    ),
    programTables,
    unresolvedOverlap,
  );
  try {
    return {
      words: readGnuPropertyWords(
        walkElfNoteTables(
          bytes,
          little,
          tables,
          MAX_INSPECT_ELF_NOTE_ENTRIES,
          signal,
        ),
        little,
        propertyAlign,
      ),
      searched,
      incomplete,
    };
  } catch (cause) {
    if (!(cause instanceof ArtifactReaderFailure)) throw cause;
    if (cause.reason === "cancelled") throw cause;
    // A note budget must not drop PIE, NX, or RELRO. The walker names the
    // budget it hit, entry or text, and the feature rows stay unknown.
    if (cause.reason === "limit")
      return { words: new Map(), searched, incomplete: cause.message };
    throw new BinaryFormatFailure("malformed", cause.message);
  }
};

const unreadProgramsRow = (
  property: LinkedProperty | "pie",
): BinaryHardeningRow =>
  row({
    property,
    state: "unknown",
    confidence: "observed",
    basis: "The image declares no program headers this inspection reads.",
    note: "Missing program headers do not establish that this property is absent.",
  });

const pieRow = (
  elfType: number,
  interp: SpanProgram | null,
  dynamic: DynamicTable | null,
  headerWidth: number,
  programCount: number,
): BinaryHardeningRow => {
  const pieFlag = dynamic?.entries.get(DT_FLAGS_1);
  const pie = pieFlag !== undefined && (pieFlag.value & DF_1_PIE) !== 0n;
  if (elfType === ET_EXEC)
    return row({
      property: "pie",
      state: "disabled",
      confidence: "observed",
      basis: "e_type is ET_EXEC.",
      location: { offset: 16, bytes: 2 },
    });
  if (elfType === ET_DYN && (interp !== null || pie))
    return row({
      property: "pie",
      state: "enabled",
      confidence: "derived",
      basis: pie
        ? "e_type is ET_DYN and DF_1_PIE is set."
        : "e_type is ET_DYN and PT_INTERP is present.",
      location:
        pie && pieFlag !== undefined
          ? { offset: pieFlag.offset, bytes: pieFlag.bytes }
          : interp === null
            ? { offset: 16, bytes: 2 }
            : { offset: interp.header_offset, bytes: headerWidth },
    });
  if (elfType === ET_DYN && programCount === 0) return unreadProgramsRow("pie");
  if (elfType === ET_DYN)
    return row({
      property: "pie",
      state: "not_applicable",
      confidence: "observed",
      basis:
        "e_type is ET_DYN without PT_INTERP or DF_1_PIE, so this is a shared object rather than a PIE executable.",
      location: { offset: 16, bytes: 2 },
    });
  return row({
    property: "pie",
    state: "not_applicable",
    confidence: "observed",
    basis: `e_type ${String(elfType)} is neither ET_EXEC nor ET_DYN.`,
    location: { offset: 16, bytes: 2 },
  });
};

const nxRow = (
  stack: SpanProgram | null,
  machine: number,
  bits: 32 | 64,
): BinaryHardeningRow => {
  if (stack === null)
    return row({
      property: "nx",
      state: "unknown",
      confidence: "observed",
      basis: "PT_GNU_STACK is absent.",
      note: EXECUTABLE_STACK_DEFAULT.has(machine)
        ? "PT_GNU_STACK is absent. Linux treats that as read-implies-exec on this architecture, so the usual default is an executable stack. This inspection does not apply that default."
        : NON_EXECUTABLE_STACK_DEFAULT.has(machine)
          ? "PT_GNU_STACK is absent. The usual Linux default for this architecture is a non-executable stack. This inspection does not apply that default."
          : "PT_GNU_STACK is absent. This inspection does not apply an architecture default.",
    });
  const executable = (stack.flags & PF_X) !== 0;
  return row({
    property: "nx",
    state: executable ? "disabled" : "enabled",
    confidence: "observed",
    basis: executable
      ? "PT_GNU_STACK p_flags includes PF_X."
      : "PT_GNU_STACK p_flags does not include PF_X.",
    location: {
      offset: stack.header_offset + (bits === 64 ? 4 : 24),
      bytes: 4,
    },
  });
};

const relroRow = (
  relro: SpanProgram | null,
  dynamic: DynamicTable | null,
  headerWidth: number,
): BinaryHardeningRow => {
  if (relro === null)
    return row({
      property: "relro",
      state: "disabled",
      confidence: "observed",
      basis: "PT_GNU_RELRO is absent.",
    });
  const bindNow =
    dynamic !== null &&
    (dynamic.entries.has(DT_BIND_NOW) ||
      (dynamic.flags & DF_BIND_NOW) !== 0n ||
      (dynamic.flags1 & DF_1_NOW) !== 0n);
  return row({
    property: "relro",
    state: bindNow ? "enabled" : "partial",
    confidence: "derived",
    basis: bindNow
      ? "PT_GNU_RELRO is present and BIND_NOW is set."
      : "PT_GNU_RELRO is present and BIND_NOW is not set.",
    location: { offset: relro.header_offset, bytes: headerWidth },
  });
};

const symbolRow = (
  property: "stack_protector" | "fortify",
  symbols: SymbolScan,
  match: (name: string) => boolean,
  missing: string,
  absent: string,
): BinaryHardeningRow => {
  const found = symbols.names.find(({ name }) => match(name));
  if (found !== undefined)
    return row({
      property,
      state: "enabled",
      confidence: "observed",
      basis: `Undefined dynamic symbol ${found.name} is present.`,
      location: { offset: found.offset, bytes: found.bytes },
    });
  const reason =
    symbols.state === "unresolved"
      ? symbols.reason
      : symbols.state === "absent"
        ? absent
        : missing;
  return row({
    property,
    state: "unknown",
    confidence: "observed",
    basis: reason,
    note: reason,
  });
};

const featureRow = (
  property: "cet_ibt_shstk" | "aarch64_bti_pac",
  applicable: boolean,
  feature: GnuPropertyWord | null,
  label: string,
  { searched, incomplete }: FeatureNotes,
): BinaryHardeningRow => {
  if (!applicable)
    return row({
      property,
      state: "not_applicable",
      confidence: "observed",
      basis: `${label} notes apply to a different architecture.`,
    });
  if (incomplete !== null)
    return row({
      property,
      state: "unknown",
      confidence: "observed",
      basis: `${label} GNU property notes were not fully read.`,
      note: incomplete,
    });
  if (feature?.conflict === true)
    return row({
      property,
      state: "unknown",
      confidence: "observed",
      basis: `${label} GNU property notes disagree.`,
      location: { offset: feature.offset, bytes: 4 },
    });
  if (feature === null && !searched)
    return row({
      property,
      state: "unknown",
      confidence: "observed",
      basis: `${label} GNU property note is unknown because section headers and PT_GNU_PROPERTY are absent.`,
      note: `${label} GNU property note is unknown because section headers and PT_GNU_PROPERTY are absent.`,
    });
  if (feature === null || (feature.value & 0b11) === 0)
    return row({
      property,
      state: "disabled",
      confidence: "observed",
      basis:
        feature === null
          ? `${label} GNU property note is absent. These bits are opt-in.`
          : `${label} GNU property word has neither feature bit set.`,
      ...(feature === null
        ? {}
        : { location: { offset: feature.offset, bytes: 4 } }),
    });
  const both = (feature.value & 0b11) === 0b11;
  return row({
    property,
    state: both ? "enabled" : "partial",
    confidence: "derived",
    basis: `${label} GNU property word is 0x${feature.value.toString(16)}.`,
    location: { offset: feature.offset, bytes: 4 },
  });
};

const pathRow = (
  property: "rpath" | "runpath",
  tag: "DT_RPATH" | "DT_RUNPATH",
  dynamic: DynamicTable | null,
): BinaryHardeningRow => {
  const entry = dynamic?.entries.get(
    tag === "DT_RPATH" ? DT_RPATH : DT_RUNPATH,
  );
  if (entry === undefined || dynamic === null)
    return row({
      property,
      state: "disabled",
      confidence: "observed",
      basis: `${tag} is absent.`,
    });
  if (dynamic.strings === null)
    malformed(`${tag} is present without a dynamic string table`);
  const stringOffset = exact(entry.value, tag);
  const observed = observeElfStringTableEntry(
    dynamic.strings,
    stringOffset,
    MAX_BINARY_HARDENING_SYMBOL_NAME_BYTES,
  );
  if (observed.state === "outside")
    malformed(`${tag} string offset is outside the dynamic string table`);
  if (observed.state !== "terminated")
    return row({
      property,
      state: "unknown",
      confidence: "observed",
      basis: `${tag} is present, but its string is not a terminated name within the symbol-name budget.`,
      note: `${tag} string has no NUL within the string table or the ${String(MAX_BINARY_HARDENING_SYMBOL_NAME_BYTES)}-byte name budget.`,
    });
  const text = elfStringTableText(observed) ?? "";
  return row({
    property,
    state: "enabled",
    confidence: "observed",
    basis: `${tag} is present.`,
    location: { offset: entry.offset, bytes: entry.bytes },
    note: text.length === 0 ? `${tag} value is an empty string.` : text,
  });
};

const strippedRow = (
  sections: readonly NativeSection[],
  bits: 32 | 64,
): BinaryHardeningRow => {
  if (sections.length === 0)
    return row({
      property: "stripped",
      state: "unknown",
      confidence: "observed",
      basis: "Section headers are absent, so SHT_SYMTAB presence is unknown.",
      note: "A missing section header table does not establish that the image was stripped.",
    });
  const symtab = sections.find((section) => section.type === SHT_SYMTAB);
  if (symtab === undefined)
    return row({
      property: "stripped",
      state: "enabled",
      confidence: "observed",
      basis: "Section headers are present and none has type SHT_SYMTAB.",
    });
  return row({
    property: "stripped",
    state: "disabled",
    confidence: "observed",
    basis: "A section header has type SHT_SYMTAB.",
    location: { offset: symtab.header_offset, bytes: bits === 64 ? 64 : 40 },
  });
};
