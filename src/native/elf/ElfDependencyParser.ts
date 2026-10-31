import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { readElfDynamicEntry } from "../../domain/elfDynamicEntry.js";
import { validateElfSectionTablePresence } from "../../domain/elfDeclaredRanges.js";
import { readElfFixedHeader } from "../../domain/elfFixedHeader.js";
import { readElfProgramHeader } from "../../domain/elfProgramHeader.js";
import { readElfRawTableDeclarations } from "../../domain/elfRawTableDeclarations.js";
import { readElfSectionHeader } from "../../domain/elfSectionHeader.js";
import {
  elfStringTableText,
  observeElfStringTableEntry,
} from "../../domain/elfStringTable.js";
import { readElfSymbol } from "../../domain/elfSymbol.js";
import {
  DF_1_FLAG_BITS,
  DF_FLAG_BITS,
  MAX_INSPECT_ELF_DEPENDENCY_IMPORTS,
  MAX_INSPECT_ELF_DEPENDENCY_NEEDED,
  MAX_INSPECT_ELF_DEPENDENCY_VERSIONS,
  decodeElfDynamicFlags,
  derivedElfVersionMaxima,
  elfSearchPathTokens,
  splitElfSearchPath,
  type ElfDependencies,
  type ElfDependencyImport,
  type ElfDependencyIssue,
  type ElfDependencyNeeded,
  type ElfVersionDefinition,
  type ElfVersionNeedFile,
  type InspectElfDependenciesInput,
} from "../../domain/native/elfDependencies.js";
import { elfObjectTypeName } from "../../domain/native/elfNotes.js";
import {
  BinaryFormatFailure,
  BinaryMappingFailure,
  BinaryReader,
  mappedFileOffset,
  type FileMapping,
} from "../metadata/BinaryContainer.js";
import { architectureForElfMachine } from "../metadata/ElfImage.js";

const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const PT_INTERP = 3;
const ET_REL = 1;
const ET_EXEC = 2;
const ET_DYN = 3;
const ET_CORE = 4;
const SHT_DYNSYM = 11;
const SHT_GNU_HASH = 0x6ffffff6;
const SHT_GNU_VERDEF = 0x6ffffffd;
const SHT_GNU_VERNEED = 0x6ffffffe;
const SHT_GNU_VERSYM = 0x6fffffff;
const DT_NULL = 0;
const DT_NEEDED = 1;
const DT_HASH = 4;
const DT_STRTAB = 5;
const DT_SYMTAB = 6;
const DT_STRSZ = 10;
const DT_SYMENT = 11;
const DT_SONAME = 14;
const DT_RPATH = 15;
const DT_RUNPATH = 29;
const DT_FLAGS = 30;
const DT_GNU_HASH = 0x6ffffef5;
const DT_VERSYM = 0x6ffffff0;
const DT_FLAGS_1 = 0x6ffffffb;
const DT_VERDEF = 0x6ffffffc;
const DT_VERDEFNUM = 0x6ffffffd;
const DT_VERNEED = 0x6ffffffe;
const DT_VERNEEDNUM = 0x6fffffff;
const VER_FLG_BASE = 1;
const VER_FLG_WEAK = 2;
const UNIQUE_DYNAMIC_TAGS = new Set([
  DT_HASH,
  DT_STRTAB,
  DT_SYMTAB,
  DT_STRSZ,
  DT_SYMENT,
  DT_SONAME,
  DT_RPATH,
  DT_RUNPATH,
  DT_FLAGS,
  DT_GNU_HASH,
  DT_VERSYM,
  DT_FLAGS_1,
  DT_VERDEF,
  DT_VERDEFNUM,
  DT_VERNEED,
  DT_VERNEEDNUM,
]);

const LIMITATIONS = [
  "This workflow does not execute the image, invoke the dynamic loader, or resolve DT_NEEDED paths against the host filesystem.",
  "$ORIGIN, $LIB, and $PLATFORM tokens are reported as written; they are not expanded.",
  "Derived version maxima compare GNU-style NAME_x.y strings and do not establish ABI compatibility.",
] as const;

const STATIC_LIMITATIONS = [
  "No PT_DYNAMIC program header was declared. That is an observed empty load-time dependency inventory, not proof another overlay or container carried dynamic linking metadata.",
  ...LIMITATIONS,
] as const;

type Artifact = ElfDependencies["artifact"];
type Range = { readonly offset: number; readonly bytes: number };

interface LocatedTable {
  readonly offset: number;
  readonly size: number;
  readonly location: Range;
}

interface SectionFacts {
  readonly type: number;
  readonly offset: number;
  readonly size: number;
  readonly address: bigint;
  readonly link: number;
  readonly info: number;
  readonly entrySize: number;
}

const fail = (message: string): never => {
  throw new BinaryFormatFailure("malformed", message);
};

const hex = (value: number): string => `0x${value.toString(16)}`;

/** Class-width tag value, or null when it is wider than every known DT_* tag. */
const asTag = (tag: bigint, bits: 32 | 64): number | null => {
  const word = BigInt.asUintN(bits, tag);
  return word > 0xffffffffn ? null : Number(word);
};

const asNumber = (value: bigint, label: string): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    fail(`${label} is not representable`);
  return Number(value);
};

const fileRange = (offset: bigint, size: bigint, label: string): Range => {
  if (
    offset > BigInt(Number.MAX_SAFE_INTEGER) ||
    size > BigInt(Number.MAX_SAFE_INTEGER)
  )
    fail(`${label} exceeds a safe integer`);
  return { offset: Number(offset), bytes: Number(size) };
};

const charge = (
  count: number,
  limit: number,
  ceiling: number,
  label: string,
): void => {
  if (count > ceiling)
    throw new ArtifactReaderFailure(
      "limit",
      `${label} exceed the ${String(ceiling)}-entry ceiling this operation accepts.`,
      { boundary: "capacity" },
    );
  if (count > limit)
    throw new ArtifactReaderFailure(
      "limit",
      `${label} exceed the ${String(limit)}-entry budget.`,
      { boundary: "capacity" },
    );
};

const coverageOf = (
  issues: readonly ElfDependencyIssue[],
  needed: number,
  versions: number,
  imports: number,
): ElfDependencies["coverage"] =>
  issues.length === 0
    ? {
        status: "complete",
        reason: null,
        examined_needed: needed,
        examined_versions: versions,
        examined_imports: imports,
      }
    : {
        status: "partial",
        reason: `${String(issues.length)} dynamic-dependency issue(s) affect reported rows or metadata; see issues`,
        examined_needed: needed,
        examined_versions: versions,
        examined_imports: imports,
      };

const bindingName = (binding: number): ElfDependencyImport["binding"] => {
  switch (binding) {
    case 0:
      return "local";
    case 1:
      return "global";
    case 2:
      return "weak";
    case 10:
      return "unique";
    default:
      return "other";
  }
};

const typeName = (type: number): ElfDependencyImport["type"] => {
  switch (type) {
    case 1:
      return "object";
    case 2:
      return "function";
    case 6:
      return "tls";
    case 10:
      return "ifunc";
    default:
      return "other";
  }
};

interface CString {
  readonly name: string | null;
  readonly truncated: boolean;
  readonly outside: boolean;
}

/**
 * Dynamic string table reads share one scan and retained-text budget fixed by
 * the admitted image length. Each offset is scanned and decoded once; every
 * retained reference is charged, because each one is serialized again.
 */
class DynamicStrings {
  readonly #cache = new Map<number, CString>();
  #scanned = 0;
  #retained = 0;

  constructor(
    readonly table: Buffer,
    readonly limit: number,
  ) {}

  #charge(field: "scanned" | "retained", bytes: number): void {
    const used = field === "scanned" ? this.#scanned : this.#retained;
    if (bytes > this.limit - used)
      throw new ArtifactReaderFailure(
        "limit",
        `ELF dependency text exceeds the ${String(this.limit)}-byte budget fixed by the admitted image length.`,
        { boundary: "memory" },
      );
    if (field === "scanned") this.#scanned += bytes;
    else this.#retained += bytes;
  }

  /** Charge text a report row repeats from an already decoded string. */
  retain(...values: readonly (string | null)[]): void {
    for (const value of values)
      if (value !== null) this.#charge("retained", value.length);
  }

  read(offset: number): CString {
    const cached = this.#cache.get(offset);
    if (cached !== undefined) {
      this.retain(cached.name);
      return cached;
    }
    const observed = observeElfStringTableEntry(this.table, offset, 65536);
    this.#charge("scanned", observed.examinedBytes);
    let entry: CString;
    if (observed.state === "outside")
      entry = { name: null, truncated: false, outside: true };
    else if (observed.state === "truncated")
      entry = { name: null, truncated: true, outside: false };
    else {
      this.#charge("retained", observed.contentBytes);
      entry = {
        name: elfStringTableText(observed),
        truncated: false,
        outside: false,
      };
    }
    this.#cache.set(offset, entry);
    return entry;
  }
}

const searchPath = (
  strings: DynamicStrings,
  offset: number,
  issues: ElfDependencyIssue[],
  location: string,
): {
  raw: string;
  entries: string[];
  tokens: ReturnType<typeof elfSearchPathTokens>;
} | null => {
  const observed = strings.read(offset);
  if (observed.name === null) {
    issues.push({
      code: "name_unreadable",
      location,
      message: observed.outside
        ? "Search-path string offset is outside the dynamic string table"
        : "Search-path string is unterminated in the dynamic string table",
    });
    return null;
  }
  // The split entries repeat the raw string's bytes in the report.
  strings.retain(observed.name);
  return {
    raw: observed.name,
    entries: splitElfSearchPath(observed.name),
    tokens: elfSearchPathTokens(observed.name),
  };
};

const mapAddress = (
  mappings: readonly FileMapping[],
  address: bigint,
  size: number,
): number | null => {
  try {
    return mappedFileOffset(mappings, address, size);
  } catch (cause) {
    if (cause instanceof BinaryMappingFailure) return null;
    throw cause;
  }
};

/** File-offset end of the PT_LOAD mapping that contains a virtual address. */
const mappedExtentEnd = (
  mappings: readonly FileMapping[],
  address: bigint,
): number | null => {
  for (const mapping of mappings)
    if (
      address >= mapping.address &&
      address < mapping.address + BigInt(mapping.size)
    )
      return mapping.offset + mapping.size;
  return null;
};

/**
 * DT_* entries are the load-time facts. A section header describing the same
 * table is accepted only when it names the same address, maps to the same file
 * bytes, and agrees on any declared size; otherwise the dynamic declaration wins.
 */
const agreedSection = (
  section: SectionFacts | undefined,
  declared: number | undefined,
  mappings: readonly FileMapping[],
  label: string,
  issues: ElfDependencyIssue[],
  sizeAgrees: (section: SectionFacts) => boolean = () => true,
): SectionFacts | undefined => {
  if (section === undefined || declared === undefined) return section;
  if (
    section.address === BigInt(declared) &&
    mapAddress(mappings, BigInt(declared), 1) === section.offset &&
    sizeAgrees(section)
  )
    return section;
  issues.push({
    code: "malformed_entry",
    location: hex(section.offset),
    message: `${label} section header disagrees with its dynamic-table declaration; using the dynamic declaration`,
  });
  return undefined;
};

const tableFromSection = (
  section: SectionFacts | undefined,
): LocatedTable | null => {
  if (section === undefined) return null;
  return {
    offset: section.offset,
    size: section.size,
    location: { offset: section.offset, bytes: section.size },
  };
};

const tableFromVirtual = (
  mappings: readonly FileMapping[],
  address: number | undefined,
  size: number,
): LocatedTable | null => {
  if (address === undefined || size < 0) return null;
  const offset = mapAddress(mappings, BigInt(address), size === 0 ? 1 : size);
  if (offset === null) return null;
  return {
    offset,
    size,
    location: { offset, bytes: size },
  };
};

const sysvSymbolCount = (
  reader: BinaryReader,
  mappings: readonly FileMapping[],
  address: number,
): number | null => {
  const header = mapAddress(mappings, BigInt(address), 8);
  if (header === null) return null;
  const buckets = reader.u32(header);
  const count = reader.u32(header + 4);
  const table = mapAddress(
    mappings,
    BigInt(address),
    8 + 4 * (buckets + count),
  );
  if (table === null) return null;
  return count;
};

const gnuSymbolCountAt = (
  reader: BinaryReader,
  header: number,
  limit: number,
  bits: 32 | 64,
): number | null => {
  const end = Math.min(limit, reader.bytes.length);
  if (header + 16 > end) return null;
  const buckets = reader.u32(header);
  const firstSymbol = reader.u32(header + 4);
  const bloomWords = reader.u32(header + 8);
  if (buckets === 0 || bloomWords === 0) return null;
  const prefixBytes = 16 + bloomWords * (bits === 64 ? 8 : 4) + buckets * 4;
  if (header + prefixBytes > end) return null;
  let last = 0;
  const bucketsAt = header + 16 + bloomWords * (bits === 64 ? 8 : 4);
  for (let index = 0; index < buckets; index += 1) {
    const value = reader.u32(bucketsAt + index * 4);
    if (value !== 0 && value < firstSymbol) return null;
    last = Math.max(last, value);
  }
  let count = firstSymbol;
  if (last !== 0) {
    let index = last;
    for (;;) {
      const span = prefixBytes + (index - firstSymbol + 1) * 4;
      if (header + span > end) return null;
      const chain = reader.u32(header + span - 4);
      index += 1;
      if ((chain & 1) !== 0) {
        count = index;
        break;
      }
    }
  }
  return count;
};

const gnuSymbolCount = (
  reader: BinaryReader,
  mappings: readonly FileMapping[],
  address: number,
  bits: 32 | 64,
): number | null => {
  const header = mapAddress(mappings, BigInt(address), 16);
  if (header === null) return null;
  const limit = mappedExtentEnd(mappings, BigInt(address));
  if (limit === null) return null;
  return gnuSymbolCountAt(reader, header, limit, bits);
};

const locateVersionTable = (
  mappings: readonly FileMapping[],
  fileBytes: number,
  section: SectionFacts | undefined,
  address: number | undefined,
): LocatedTable | null => {
  const fromSection = tableFromSection(section);
  if (fromSection !== null) return fromSection;
  if (address === undefined) return null;
  const offset = mapAddress(mappings, BigInt(address), 16);
  if (offset === null) return null;
  // Without a section header the table extent is unknown; keep every later
  // record read inside the PT_LOAD mapping that admitted the table start.
  const end = mappedExtentEnd(mappings, BigInt(address));
  if (end === null) return null;
  const size = Math.min(end, fileBytes) - offset;
  return {
    offset,
    size,
    location: { offset, bytes: size },
  };
};

const emptyInventory = (
  artifact: Artifact,
  header: {
    readonly format: "elf32" | "elf64";
    readonly byte_order: "little" | "big";
    readonly machine: number;
    readonly architecture: string;
    readonly type: number;
    readonly type_name: ElfDependencies["type_name"];
  },
  interpreter: ElfDependencies["interpreter"],
  issues: ElfDependencyIssue[],
): ElfDependencies => ({
  artifact,
  ...header,
  interpreter,
  dynamic: {
    status: "absent",
    location: null,
    soname: null,
    rpath: null,
    runpath: null,
    flags: null,
    flags_1: null,
  },
  needed: [],
  version_requirements: { status: "absent", location: null, files: [] },
  version_definitions: { status: "absent", location: null, names: [] },
  derived_version_maxima: [],
  imports: [],
  coverage: coverageOf(issues, 0, 0, 0),
  issues,
  limitations: [...STATIC_LIMITATIONS],
});

/** Decode PT_DYNAMIC, GNU versions, and undefined .dynsym imports from one ELF image. */
export const parseElfDependencies = (
  bytes: Buffer,
  artifact: Artifact,
  input: InspectElfDependenciesInput,
): ElfDependencies => {
  const fixed = readElfFixedHeader(bytes);
  if (!fixed.ok) return fail(fixed.error);
  const header = fixed.value;
  const type = header.type;
  if (type === ET_REL)
    fail(
      "Relocatable ELF objects are not a loadable dynamic-dependency inventory. Use inspect_kernel_module for Linux kernel modules.",
    );
  if (type === ET_CORE)
    fail(
      "Core dump images are not a loadable dynamic-dependency inventory. Use inspect_recorded_crash for recorded crashes.",
    );
  if (type !== ET_EXEC && type !== ET_DYN)
    fail(`ELF type ${String(type)} is not a loadable ET_EXEC or ET_DYN image.`);
  const raw = readElfRawTableDeclarations(bytes, header);
  if (!raw.ok) return fail(raw.error.message);
  const presence = validateElfSectionTablePresence(raw.value);
  if (!presence.ok) return fail(presence.error);
  const { programs, sections } = raw.value;
  if (
    programs.offset > BigInt(Number.MAX_SAFE_INTEGER) ||
    sections.offset > BigInt(Number.MAX_SAFE_INTEGER)
  )
    fail("ELF offset or size exceeds a safe integer.");
  const phoff = Number(programs.offset);
  const shoff = Number(sections.offset);
  const phentsize = programs.width;
  const phnum = programs.count;
  const shentsize = sections.width;
  const shnum = sections.count;
  const shstrndx = sections.namesIndex;
  if (phnum === 0xffff || shnum === 0xffff || shstrndx === 0xffff)
    throw new BinaryFormatFailure(
      "unsupported",
      "ELF extended numbering is unsupported.",
    );
  const bits = header.elfClass;
  const reader = new BinaryReader(bytes, header.byteOrder === "little");
  const identity = {
    format: (bits === 64 ? "elf64" : "elf32") as "elf32" | "elf64",
    byte_order: header.byteOrder,
    machine: header.machine,
    architecture: architectureForElfMachine(header.machine),
    type,
    type_name: elfObjectTypeName(type),
  };
  if (phnum === 0) fail("ELF image has no program headers.");
  if (phentsize < (bits === 64 ? 56 : 32))
    fail("ELF program header width is invalid.");
  reader.range(phoff, phnum * phentsize, "ELF program headers");
  const mappings: FileMapping[] = [];
  let interp: Range | null = null;
  let dynamic: Range | null = null;
  for (let index = 0; index < phnum; index += 1) {
    const parsedProgram = readElfProgramHeader(
      bytes.subarray(
        phoff + index * phentsize,
        phoff + index * phentsize + phentsize,
      ),
      bits,
      reader.little,
    );
    if (!parsedProgram.ok) return fail(parsedProgram.error.message);
    const program = parsedProgram.value;
    if (program.type === PT_INTERP) {
      if (interp !== null) fail("Multiple PT_INTERP segments are ambiguous");
      interp = fileRange(program.offset, program.fileSize, "PT_INTERP");
      continue;
    }
    if (program.type === PT_DYNAMIC) {
      if (dynamic !== null) fail("Multiple PT_DYNAMIC segments are ambiguous");
      dynamic = fileRange(program.offset, program.fileSize, "PT_DYNAMIC");
      continue;
    }
    if (program.type !== PT_LOAD) continue;
    const range = fileRange(program.offset, program.fileSize, "PT_LOAD");
    if (range.bytes === 0) continue;
    reader.range(range.offset, range.bytes, "PT_LOAD");
    mappings.push({
      address: program.virtualAddress,
      offset: range.offset,
      size: range.bytes,
    });
  }
  const issues: ElfDependencyIssue[] = [];
  const interpreter = parseInterpreter(reader, interp, issues);
  if (dynamic === null)
    return emptyInventory(artifact, identity, interpreter, issues);
  reader.range(dynamic.offset, dynamic.bytes, "PT_DYNAMIC");
  const entrySize = bits === 64 ? 16 : 8;
  const unique = new Map<number, number>();
  const neededOffsets: number[] = [];
  let terminated = false;
  for (
    let base = dynamic.offset;
    base + entrySize <= dynamic.offset + dynamic.bytes;
    base += entrySize
  ) {
    const parsedEntry = readElfDynamicEntry(
      bytes.subarray(base, base + entrySize),
      bits,
      reader.little,
    );
    if (!parsedEntry.ok) return fail(parsedEntry.error.message);
    const tag = asTag(parsedEntry.value.tag, bits);
    if (tag === null) continue;
    if (tag === DT_NULL) {
      terminated = true;
      break;
    }
    if (tag === DT_NEEDED) {
      neededOffsets.push(asNumber(parsedEntry.value.value, "DT_NEEDED"));
      charge(
        neededOffsets.length,
        input.max_needed,
        MAX_INSPECT_ELF_DEPENDENCY_NEEDED,
        "DT_NEEDED entries",
      );
      continue;
    }
    if (!UNIQUE_DYNAMIC_TAGS.has(tag)) continue;
    const value = asNumber(parsedEntry.value.value, `DT tag ${hex(tag)}`);
    if (unique.has(tag)) fail(`Duplicate dynamic tag ${hex(tag)}`);
    unique.set(tag, value);
  }
  if (!terminated)
    issues.push({
      code: "malformed_entry",
      location: hex(dynamic.offset),
      message: "Dynamic segment is not terminated by DT_NULL",
    });
  const sectionFacts = readSections(
    bytes,
    reader,
    bits,
    shoff,
    shnum,
    shentsize,
  );
  const sectionOf = (type: number, tag: number, label: string) =>
    agreedSection(
      sectionFacts.find((section) => section.type === type),
      unique.get(tag),
      mappings,
      label,
      issues,
    );
  const syment = unique.get(DT_SYMENT);
  const dynsymSection = agreedSection(
    sectionFacts.find((section) => section.type === SHT_DYNSYM),
    unique.get(DT_SYMTAB),
    mappings,
    ".dynsym",
    issues,
    (section) =>
      syment === undefined ||
      section.entrySize === 0 ||
      section.entrySize === syment,
  );
  const strsz = unique.get(DT_STRSZ);
  const linkedStrings =
    dynsymSection === undefined ? undefined : sectionFacts[dynsymSection.link];
  const dynstrSection = agreedSection(
    linkedStrings?.type === 3 ? linkedStrings : undefined,
    unique.get(DT_STRTAB),
    mappings,
    ".dynstr",
    issues,
    (section) => strsz === undefined || section.size === strsz,
  );
  const versymSection = sectionOf(SHT_GNU_VERSYM, DT_VERSYM, ".gnu.version");
  const verneedSection = sectionOf(
    SHT_GNU_VERNEED,
    DT_VERNEED,
    ".gnu.version_r",
  );
  const verdefSection = sectionOf(SHT_GNU_VERDEF, DT_VERDEF, ".gnu.version_d");
  const hashSection = sectionOf(5, DT_HASH, ".hash");
  const gnuHashSection = sectionOf(SHT_GNU_HASH, DT_GNU_HASH, ".gnu.hash");
  const dynstrTable =
    tableFromSection(dynstrSection) ??
    tableFromVirtual(mappings, unique.get(DT_STRTAB), strsz ?? 0);
  if (
    dynstrTable === null &&
    (neededOffsets.length > 0 || unique.has(DT_SONAME))
  )
    issues.push({
      code: "table_unavailable",
      location: hex(dynamic.offset),
      message:
        "Dynamic string table could not be located from section headers or DT_STRTAB",
    });
  const dynstr = new DynamicStrings(
    dynstrTable === null
      ? Buffer.alloc(0)
      : reader.range(dynstrTable.offset, dynstrTable.size, "DT_STRTAB"),
    bytes.length,
  );
  const needed: ElfDependencyNeeded[] = neededOffsets.map(
    (name_offset, index) => {
      const observed = dynstr.read(name_offset);
      const name =
        observed.name === null || observed.name.length === 0
          ? null
          : observed.name;
      if (name === null)
        issues.push({
          code: "name_unreadable",
          location: hex((dynstrTable?.offset ?? 0) + name_offset),
          message: observed.outside
            ? `DT_NEEDED string offset ${String(name_offset)} is outside the dynamic string table`
            : observed.truncated || observed.name === null
              ? `DT_NEEDED string at offset ${String(name_offset)} is unterminated`
              : `DT_NEEDED string at offset ${String(name_offset)} is empty`,
        });
      return { index, name, name_offset };
    },
  );
  const sonameOffset = unique.get(DT_SONAME);
  const soname =
    sonameOffset === undefined
      ? null
      : {
          name: namedString(dynstr, sonameOffset, issues, "DT_SONAME"),
          name_offset: sonameOffset,
        };
  const rpathOffset = unique.get(DT_RPATH);
  const runpathOffset = unique.get(DT_RUNPATH);
  const rpath =
    rpathOffset === undefined
      ? null
      : searchPath(dynstr, rpathOffset, issues, "DT_RPATH");
  const runpath =
    runpathOffset === undefined
      ? null
      : searchPath(dynstr, runpathOffset, issues, "DT_RUNPATH");
  const flagsRaw = unique.get(DT_FLAGS);
  const flags1Raw = unique.get(DT_FLAGS_1);
  const versionNames = new Map<
    number,
    { name: string | null; file: string | null }
  >();
  let examinedVersions = 0;
  const versionRequirements = parseVerneed(
    reader,
    bytes,
    mappings,
    dynstr,
    verneedSection,
    unique.get(DT_VERNEED),
    unique.get(DT_VERNEEDNUM) ?? verneedSection?.info,
    issues,
    versionNames,
    () => {
      examinedVersions += 1;
      charge(
        examinedVersions,
        input.max_versions,
        MAX_INSPECT_ELF_DEPENDENCY_VERSIONS,
        "GNU version records",
      );
    },
  );
  const versionDefinitions = parseVerdef(
    reader,
    bytes,
    mappings,
    dynstr,
    verdefSection,
    unique.get(DT_VERDEF),
    unique.get(DT_VERDEFNUM) ?? verdefSection?.info,
    issues,
    () => {
      examinedVersions += 1;
      charge(
        examinedVersions,
        input.max_versions,
        MAX_INSPECT_ELF_DEPENDENCY_VERSIONS,
        "GNU version records",
      );
    },
  );
  const classEntrySize = bits === 64 ? 24 : 16;
  const declaredEntrySize = syment ?? (dynsymSection?.entrySize || undefined);
  const symbolEntrySize =
    declaredEntrySize === undefined || declaredEntrySize === 0
      ? classEntrySize
      : declaredEntrySize;
  if (syment !== undefined && syment !== classEntrySize)
    issues.push({
      code: "malformed_entry",
      location: hex(dynamic.offset),
      message: "DT_SYMENT does not match the ELF class symbol size",
    });
  const symbolCount = locateSymbolCount(
    reader,
    mappings,
    dynsymSection,
    hashSection,
    gnuHashSection,
    unique,
    bits,
    symbolEntrySize,
    issues,
  );
  const symbolBytes = symbolCount === null ? 0 : symbolCount * symbolEntrySize;
  const dynsymTable =
    tableFromSection(dynsymSection) ??
    (symbolCount === null
      ? null
      : tableFromVirtual(mappings, unique.get(DT_SYMTAB), symbolBytes));
  const versymTable =
    tableFromSection(versymSection) ??
    (symbolCount === null
      ? null
      : tableFromVirtual(mappings, unique.get(DT_VERSYM), symbolCount * 2));
  if (
    dynsymTable === null &&
    symbolCount !== null &&
    (dynsymSection !== undefined || unique.has(DT_SYMTAB))
  )
    issues.push({
      code: "table_unavailable",
      location: hex(unique.get(DT_SYMTAB) ?? dynsymSection?.offset ?? 0),
      message:
        "Dynamic symbol table could not be located from section headers or DT_SYMTAB",
    });
  if (
    versymTable === null &&
    symbolCount !== null &&
    (versymSection !== undefined || unique.has(DT_VERSYM))
  )
    issues.push({
      code: "table_unavailable",
      location: hex(unique.get(DT_VERSYM) ?? versymSection?.offset ?? 0),
      message:
        "GNU versym table could not be located from section headers or DT_VERSYM",
    });
  const imports = parseImports(
    reader,
    bytes,
    bits,
    dynsymTable,
    versymTable,
    dynstr,
    symbolCount,
    symbolEntrySize,
    versionNames,
    input.max_imports,
    issues,
  );
  const requirementNames = versionRequirements.files.flatMap((file) =>
    file.versions.flatMap((version) =>
      version.name === null ? [] : [version.name],
    ),
  );
  return {
    artifact,
    ...identity,
    interpreter,
    dynamic: {
      status: "present",
      location: dynamic,
      soname,
      rpath,
      runpath,
      flags:
        flagsRaw === undefined
          ? null
          : decodeElfDynamicFlags(flagsRaw >>> 0, DF_FLAG_BITS),
      flags_1:
        flags1Raw === undefined
          ? null
          : decodeElfDynamicFlags(flags1Raw >>> 0, DF_1_FLAG_BITS),
    },
    needed,
    version_requirements: versionRequirements,
    version_definitions: versionDefinitions,
    derived_version_maxima: derivedElfVersionMaxima(requirementNames),
    imports,
    coverage: coverageOf(
      issues,
      needed.length,
      examinedVersions,
      imports.length,
    ),
    issues,
    limitations: [...LIMITATIONS],
  };
};

const namedString = (
  strings: DynamicStrings,
  offset: number,
  issues: ElfDependencyIssue[],
  label: string,
): string | null => {
  const observed = strings.read(offset);
  if (observed.name === null || observed.name.length === 0) {
    issues.push({
      code: "name_unreadable",
      location: label,
      message: observed.outside
        ? `${label} string offset is outside the dynamic string table`
        : observed.truncated || observed.name === null
          ? `${label} string is unterminated in the dynamic string table`
          : `${label} string is empty`,
    });
    return null;
  }
  return observed.name;
};

const parseInterpreter = (
  reader: BinaryReader,
  interp: Range | null,
  issues: ElfDependencyIssue[],
): ElfDependencies["interpreter"] => {
  if (interp === null) return { status: "absent", path: null, location: null };
  if (interp.bytes === 0) {
    issues.push({
      code: "name_unreadable",
      location: hex(interp.offset),
      message: "PT_INTERP segment is empty",
    });
    return { status: "unreadable", path: null, location: interp };
  }
  try {
    const body = reader.range(interp.offset, interp.bytes, "PT_INTERP");
    const observed = observeElfStringTableEntry(body, 0, interp.bytes);
    if (observed.state !== "terminated" || observed.bytes === null) {
      issues.push({
        code: "name_unreadable",
        location: hex(interp.offset),
        message: "PT_INTERP path is unterminated",
      });
      return { status: "unreadable", path: null, location: interp };
    }
    const path = observed.bytes.toString("latin1");
    if (path.length === 0) {
      issues.push({
        code: "name_unreadable",
        location: hex(interp.offset),
        message: "PT_INTERP path is empty",
      });
      return { status: "unreadable", path: null, location: interp };
    }
    return { status: "present", path, location: interp };
  } catch (cause) {
    if (cause instanceof BinaryFormatFailure) {
      issues.push({
        code: "table_unavailable",
        location: hex(interp.offset),
        message: cause.message,
      });
      // The declared range is outside the file, so it is not a report location.
      return { status: "unreadable", path: null, location: null };
    }
    throw cause;
  }
};

const readSections = (
  bytes: Buffer,
  reader: BinaryReader,
  bits: 32 | 64,
  shoff: number,
  shnum: number,
  shentsize: number,
): SectionFacts[] => {
  if (shnum === 0) return [];
  if (shentsize < (bits === 64 ? 64 : 40))
    fail("ELF section header width is invalid.");
  reader.range(shoff, shnum * shentsize, "ELF section headers");
  const found: SectionFacts[] = [];
  for (let index = 0; index < shnum; index += 1) {
    const parsed = readElfSectionHeader(
      bytes.subarray(
        shoff + index * shentsize,
        shoff + index * shentsize + shentsize,
      ),
      bits,
      reader.little,
    );
    if (!parsed.ok) return fail(parsed.error.message);
    const section = parsed.value;
    if (
      section.offset > BigInt(Number.MAX_SAFE_INTEGER) ||
      section.size > BigInt(Number.MAX_SAFE_INTEGER) ||
      section.entrySize > BigInt(Number.MAX_SAFE_INTEGER)
    )
      fail("ELF section offset or size exceeds a safe integer.");
    found.push({
      type: section.type,
      offset: Number(section.offset),
      size: Number(section.size),
      address: section.address,
      link: section.link,
      info: section.info,
      entrySize: Number(section.entrySize),
    });
  }
  return found;
};

const locateSymbolCount = (
  reader: BinaryReader,
  mappings: readonly FileMapping[],
  dynsym: SectionFacts | undefined,
  hash: SectionFacts | undefined,
  gnuHash: SectionFacts | undefined,
  tags: ReadonlyMap<number, number>,
  bits: 32 | 64,
  entrySize: number,
  issues: ElfDependencyIssue[],
): number | null => {
  if (dynsym !== undefined && entrySize > 0 && dynsym.size % entrySize === 0)
    return dynsym.size / entrySize;
  const sysv =
    hash !== undefined && hash.size >= 8
      ? reader.u32(hash.offset + 4)
      : tags.has(DT_HASH)
        ? sysvSymbolCount(reader, mappings, tags.get(DT_HASH)!)
        : null;
  if (sysv !== null) return sysv;
  const gnu =
    gnuHash !== undefined && gnuHash.size >= 16
      ? gnuSymbolCountAt(
          reader,
          gnuHash.offset,
          gnuHash.offset + gnuHash.size,
          bits,
        )
      : tags.has(DT_GNU_HASH)
        ? gnuSymbolCount(reader, mappings, tags.get(DT_GNU_HASH)!, bits)
        : null;
  if (gnu !== null) return gnu;
  issues.push({
    code: "table_unavailable",
    location: null,
    message:
      "Dynamic symbol count could not be located from SHT_DYNSYM, DT_HASH, or DT_GNU_HASH",
  });
  return null;
};

const parseVerneed = (
  reader: BinaryReader,
  bytes: Buffer,
  mappings: readonly FileMapping[],
  dynstr: DynamicStrings,
  section: SectionFacts | undefined,
  address: number | undefined,
  declaredCount: number | undefined,
  issues: ElfDependencyIssue[],
  versionNames: Map<number, { name: string | null; file: string | null }>,
  chargeVersion: () => void,
): ElfDependencies["version_requirements"] => {
  const table = locateVersionTable(mappings, bytes.length, section, address);
  if (table === null) {
    if (address !== undefined)
      issues.push({
        code: "table_unavailable",
        location: hex(address),
        message: "GNU version requirements could not be located",
      });
    return {
      status:
        address === undefined && section === undefined
          ? "absent"
          : "unreadable",
      location: null,
      files: [],
    };
  }
  const count = declaredCount ?? section?.info;
  if (count === undefined) {
    issues.push({
      code: "table_unavailable",
      location: hex(table.offset),
      message:
        "GNU version requirements have no DT_VERNEEDNUM or section record count",
    });
    return { status: "unreadable", location: table.location, files: [] };
  }
  if (count === 0)
    return { status: "present", location: table.location, files: [] };
  const files: ElfVersionNeedFile[] = [];
  const conflicts = new Set<number>();
  const settleConflicts = () => {
    for (const index of conflicts) {
      versionNames.set(index, { name: null, file: null });
      issues.push({
        code: "version_unresolved",
        location: hex(table.offset),
        message: `GNU version requirements assign version index ${String(index)} more than once; imports using it stay unresolved`,
      });
    }
  };
  try {
    reader.range(table.offset, Math.min(table.size, 16), "GNU verneed");
    const seen = new Set<number>();
    let offset = 0;
    for (let record = 0; record < count; record += 1) {
      if (seen.has(offset)) fail("GNU version requirement chain is cyclic");
      seen.add(offset);
      if (offset + 16 > table.size)
        fail("GNU version requirement chain leaves its table");
      chargeVersion();
      const at = table.offset + offset;
      const auxiliaryCount = reader.u16(at + 2);
      const fileOffset = reader.u32(at + 4);
      const auxiliaryOffset = reader.u32(at + 8);
      const next = reader.u32(at + 12);
      const file = namedString(dynstr, fileOffset, issues, "vn_file");
      if (auxiliaryCount > 0 && auxiliaryOffset < 16)
        fail(
          "GNU version requirement auxiliary chain starts inside its header",
        );
      const versions: ElfVersionNeedFile["versions"] = [];
      const pending: [number, { name: string | null; file: string | null }][] =
        [];
      let auxiliary = offset + auxiliaryOffset;
      const auxSeen = new Set<number>();
      for (let item = 0; item < auxiliaryCount; item += 1) {
        if (auxSeen.has(auxiliary))
          fail("GNU version requirement auxiliary chain is cyclic");
        auxSeen.add(auxiliary);
        if (auxiliary + 16 > table.size)
          fail("GNU version requirement auxiliary chain leaves its table");
        chargeVersion();
        const auxAt = table.offset + auxiliary;
        const hash = reader.u32(auxAt);
        const flags = reader.u16(auxAt + 4);
        const index = reader.u16(auxAt + 6) & 0x7fff;
        const nameOffset = reader.u32(auxAt + 8);
        const auxiliaryNext = reader.u32(auxAt + 12);
        const name = namedString(dynstr, nameOffset, issues, "vna_name");
        versions.push({
          name,
          hash,
          flags: { weak: (flags & VER_FLG_WEAK) !== 0 },
          index,
        });
        if (name !== null || file !== null)
          pending.push([index, { name, file }]);
        if (item + 1 < auxiliaryCount) {
          if (auxiliaryNext === 0 || auxiliary + auxiliaryNext <= auxiliary)
            fail("GNU version requirement auxiliary chain is cyclic");
          if (auxiliaryNext < 16)
            fail(
              "GNU version requirement auxiliary chain ends before its declared count",
            );
          auxiliary += auxiliaryNext;
        }
      }
      files.push({ file, versions });
      // Join imports only against records whose whole file entry was read.
      for (const [index, entry] of pending) {
        if (versionNames.has(index) || conflicts.has(index))
          conflicts.add(index);
        else versionNames.set(index, entry);
      }
      if (record + 1 < count) {
        if (next === 0 || offset + next <= offset)
          fail("GNU version requirement chain is cyclic");
        if (next < 16)
          fail("GNU version requirement chain ends before its declared count");
        offset += next;
      }
    }
    settleConflicts();
    return { status: "present", location: table.location, files };
  } catch (cause) {
    if (cause instanceof ArtifactReaderFailure) throw cause;
    if (cause instanceof BinaryFormatFailure && /cyclic/u.test(cause.message))
      throw cause;
    settleConflicts();
    issues.push({
      code: "version_unresolved",
      location: hex(table.offset),
      message: `GNU version requirements: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
    // Keep the records read before the failure; versionNames already joins
    // imports against exactly this prefix.
    return { status: "unreadable", location: table.location, files };
  }
};

const parseVerdef = (
  reader: BinaryReader,
  bytes: Buffer,
  mappings: readonly FileMapping[],
  dynstr: DynamicStrings,
  section: SectionFacts | undefined,
  address: number | undefined,
  declaredCount: number | undefined,
  issues: ElfDependencyIssue[],
  chargeVersion: () => void,
): ElfDependencies["version_definitions"] => {
  const table = locateVersionTable(mappings, bytes.length, section, address);
  if (table === null) {
    if (address !== undefined)
      issues.push({
        code: "table_unavailable",
        location: hex(address),
        message: "GNU version definitions could not be located",
      });
    return {
      status:
        address === undefined && section === undefined
          ? "absent"
          : "unreadable",
      location: null,
      names: [],
    };
  }
  const count = declaredCount ?? section?.info;
  if (count === undefined) {
    issues.push({
      code: "table_unavailable",
      location: hex(table.offset),
      message:
        "GNU version definitions have no DT_VERDEFNUM or section record count",
    });
    return { status: "unreadable", location: table.location, names: [] };
  }
  if (count === 0)
    return { status: "present", location: table.location, names: [] };
  const names: ElfVersionDefinition[] = [];
  try {
    const seen = new Set<number>();
    let offset = 0;
    for (let record = 0; record < count; record += 1) {
      if (seen.has(offset)) fail("GNU version definition chain is cyclic");
      seen.add(offset);
      if (offset + 20 > table.size)
        fail("GNU version definition chain leaves its table");
      chargeVersion();
      const at = table.offset + offset;
      const flags = reader.u16(at + 2);
      const index = reader.u16(at + 4) & 0x7fff;
      const aux = reader.u32(at + 12);
      const next = reader.u32(at + 16);
      if (aux < 20 || offset + aux + 8 > table.size)
        fail("GNU version definition name entry leaves its table");
      const nameOffset = reader.u32(table.offset + offset + aux);
      names.push({
        name: namedString(dynstr, nameOffset, issues, "vda_name"),
        index,
        base: (flags & VER_FLG_BASE) !== 0,
      });
      if (record + 1 < count) {
        if (next === 0 || offset + next <= offset)
          fail("GNU version definition chain is cyclic");
        if (next < 20)
          fail("GNU version definition chain ends before its declared count");
        offset += next;
      }
    }
    return { status: "present", location: table.location, names };
  } catch (cause) {
    if (cause instanceof ArtifactReaderFailure) throw cause;
    if (cause instanceof BinaryFormatFailure && /cyclic/u.test(cause.message))
      throw cause;
    issues.push({
      code: "version_unresolved",
      location: hex(table.offset),
      message: `GNU version definitions: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
    return { status: "unreadable", location: table.location, names };
  }
};

const parseImports = (
  reader: BinaryReader,
  bytes: Buffer,
  bits: 32 | 64,
  dynsym: LocatedTable | null,
  versym: LocatedTable | null,
  dynstr: DynamicStrings,
  symbolCount: number | null,
  entrySize: number,
  versionNames: ReadonlyMap<
    number,
    { name: string | null; file: string | null }
  >,
  maxImports: number,
  issues: ElfDependencyIssue[],
): ElfDependencyImport[] => {
  if (dynsym === null || symbolCount === null) return [];
  if (symbolCount > MAX_INSPECT_ELF_DEPENDENCY_IMPORTS)
    throw new ArtifactReaderFailure(
      "limit",
      `Dynamic symbols exceed the ${String(MAX_INSPECT_ELF_DEPENDENCY_IMPORTS)}-entry ceiling this operation accepts.`,
      { boundary: "capacity" },
    );
  const imports: ElfDependencyImport[] = [];
  try {
    reader.range(dynsym.offset, symbolCount * entrySize, ".dynsym");
  } catch (cause) {
    if (cause instanceof BinaryFormatFailure) {
      issues.push({
        code: "table_unavailable",
        location: hex(dynsym.offset),
        message: cause.message,
      });
      return [];
    }
    throw cause;
  }
  let versymBytes: Buffer | null = null;
  if (versym !== null) {
    if (versym.size < symbolCount * 2)
      issues.push({
        code: "table_unavailable",
        location: hex(versym.offset),
        message: "GNU versym table is shorter than the dynamic symbol count",
      });
    else {
      try {
        versymBytes = reader.range(
          versym.offset,
          symbolCount * 2,
          "GNU versym",
        );
      } catch (cause) {
        if (!(cause instanceof BinaryFormatFailure)) throw cause;
        issues.push({
          code: "table_unavailable",
          location: hex(versym.offset),
          message: cause.message,
        });
      }
    }
  }
  for (let index = 1; index < symbolCount; index += 1) {
    const at = dynsym.offset + index * entrySize;
    const parsed = readElfSymbol(
      bytes.subarray(at, at + entrySize),
      bits,
      reader.little,
    );
    if (!parsed.ok) {
      issues.push({
        code: "malformed_entry",
        location: hex(at),
        message: parsed.error.message,
      });
      continue;
    }
    if (parsed.value.section_index !== 0) continue;
    charge(
      imports.length + 1,
      maxImports,
      MAX_INSPECT_ELF_DEPENDENCY_IMPORTS,
      "Undefined dynamic symbols",
    );
    const name = namedString(
      dynstr,
      parsed.value.name_offset,
      issues,
      `dynsym[${String(index)}]`,
    );
    let version: ElfDependencyImport["version"] = null;
    if (versymBytes !== null) {
      const raw = reader.little
        ? versymBytes.readUInt16LE(index * 2)
        : versymBytes.readUInt16BE(index * 2);
      const versionIndex = raw & 0x7fff;
      const hidden = (raw & 0x8000) !== 0;
      if (versionIndex <= 1)
        version = {
          index: versionIndex,
          hidden,
          name: null,
          file: null,
          status: "unversioned",
        };
      else {
        const resolved = versionNames.get(versionIndex);
        dynstr.retain(resolved?.name ?? null, resolved?.file ?? null);
        version = {
          index: versionIndex,
          hidden,
          name: resolved?.name ?? null,
          file: resolved?.file ?? null,
          status: resolved?.name ? "resolved" : "unknown",
        };
        if (resolved === undefined)
          issues.push({
            code: "version_unresolved",
            location: hex((versym?.offset ?? 0) + index * 2),
            message: `Import ${name ?? `#${String(index)}`} references version index ${String(versionIndex)} with no matching verneed record`,
          });
      }
    }
    imports.push({
      index,
      name,
      binding: bindingName(parsed.value.binding),
      type: typeName(parsed.value.type),
      version,
    });
  }
  return imports;
};
