import { keyedBy, uniqueKeyed } from "../../domain/keyedCollection.js";
import { decodeLimit, ParseFailureError } from "../../domain/parseFailure.js";
import { errorMessage } from "../../kernel/errorMessage.js";
import {
  DT_FLAGS,
  DT_FLAGS_1,
  DT_GNU_HASH,
  DT_HASH,
  DT_NEEDED,
  DT_RPATH,
  DT_RUNPATH,
  DT_STRTAB,
  DT_STRSZ,
  DT_SYMENT,
  DT_SYMTAB,
  walkElfDynamicTable,
} from "../../domain/elfDynamicEntry.js";
import { validateElfSectionTableFields } from "../../domain/elfDeclaredRanges.js";
import { readElfFixedHeader } from "../../domain/elfFixedHeader.js";
import {
  elfHashEntryLayout,
  readElfGnuHashSymbolCountSteps,
  readElfHashSymbolCountSteps,
  type ElfHashCountSteps,
  type ElfHashEntryLayout,
} from "../../domain/elfHashSymbolCount.js";
import {
  admitElfLoadSegment,
  elfLoadSpans,
  readElfProgramHeader,
  type ElfLoadMappings,
} from "../../domain/elfProgramHeader.js";
import { readElfRawTableDeclarations } from "../../domain/elfRawTableDeclarations.js";
import { readElfSectionHeader } from "../../domain/elfSectionHeader.js";
import {
  elfStringTableText,
  observeElfStringTableWindow,
} from "../../domain/elfStringTable.js";
import {
  ELF_SYMBOL_TRUNCATED_MESSAGE,
  elfSymbolSize,
  readElfSymbolFieldsAt,
} from "../../domain/elfSymbol.js";
import { err, ok, type Result } from "../../domain/result.js";
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
  createFileMappingIndex,
  mappedFileOffset,
  type FileMappingIndex,
} from "../../domain/binaryContainer.js";
import {
  resolveMappedFileOffset,
  type FileMapping,
  type ZeroFillMapping,
} from "../../domain/virtualFileMapping.js";
import { architectureForElfMachine } from "../../domain/native/elfImage.js";
import { Budget } from "../../domain/budget.js";
import type { PrefixedByteSource } from "../../domain/byteSource.js";

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
const DT_SONAME = 14n;
const DT_VERSYM = 0x6ffffff0n;
const DT_VERDEF = 0x6ffffffcn;
const DT_VERDEFNUM = 0x6ffffffdn;
const DT_VERNEED = 0x6ffffffen;
const DT_VERNEEDNUM = 0x6fffffffn;
const VER_FLG_BASE = 1;
const VER_FLG_WEAK = 2;
/**
 * Tags whose value is a virtual address. ELF64 addresses may exceed
 * Number.MAX_SAFE_INTEGER, so they stay bigint until a PT_LOAD maps them.
 */
const ADDRESS_DYNAMIC_TAGS = new Set([
  DT_HASH,
  DT_STRTAB,
  DT_SYMTAB,
  DT_GNU_HASH,
  DT_VERSYM,
  DT_VERDEF,
  DT_VERNEED,
]);
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

interface IndexedElfLoadMappings extends ElfLoadMappings {
  readonly index: () => FileMappingIndex;
}

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

const hex = (value: number | bigint): string => `0x${value.toString(16)}`;

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

const ceilingFailure = (
  entries: string,
  ceiling: number,
  name: string,
  required: number,
) =>
  decodeLimit(
    "elf-dependencies",
    `${entries} exceed the ${String(ceiling)}-entry ceiling this operation accepts.`,
    { name, maximum: ceiling, required },
  );

const charge = (
  count: number,
  limit: number,
  ceiling: number,
  entries: string,
  parameter: "max_needed" | "max_versions" | "max_imports",
): void => {
  if (count > ceiling)
    throw ceilingFailure(entries, ceiling, `${parameter}_ceiling`, count);
  if (count > limit)
    throw decodeLimit(
      "elf-dependencies",
      `${entries} exceed the ${String(limit)}-entry budget.`,
      { name: parameter, maximum: limit, required: count },
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

type CString =
  | {
      readonly state: "terminated";
      readonly name: string;
      readonly location: number;
    }
  | {
      readonly state: "unterminated" | "scan-limit";
      readonly name: null;
      readonly location: number;
    }
  | {
      readonly state: "outside" | "table-unavailable";
      readonly name: null;
      readonly location: null;
    };

/**
 * Longest ELF string scanned for its terminator. Each string is hashed and
 * serialized as one JSON value, so this also bounds its escaped expansion.
 */
const ELF_STRING_SCAN_BYTES = 65536;

const unreadString = (limited: boolean): string =>
  limited
    ? `has no terminator within the ${String(ELF_STRING_SCAN_BYTES)}-byte string scan limit`
    : "is unterminated";

const unreadDynamicString = (
  label: string,
  observed: CString,
  offset?: number,
): string => {
  const index = offset === undefined ? "" : ` ${String(offset)}`;
  if (observed.state === "table-unavailable")
    return `${label} string offset${index} could not be read because the dynamic string table is unavailable`;
  if (observed.state === "outside")
    return `${label} string offset${index} is outside the dynamic string table`;
  const field = `${label} string${offset === undefined ? "" : ` at offset${index}`}`;
  if (observed.state === "terminated") return `${field} is empty`;
  const table = offset === undefined ? " in the dynamic string table" : "";
  return `${field} ${unreadString(observed.state === "scan-limit")}${table}`;
};

/**
 * Dynamic string table reads share one scan and retained-text budget fixed by
 * the admitted image length. Each offset is scanned and decoded once; every
 * retained reference is charged, because each one is serialized again.
 */
class DynamicStrings {
  readonly #cache = new Map<number, CString>();
  readonly #scanned: Budget;
  readonly #retained: Budget;

  constructor(
    readonly table: LocatedTable | null,
    readonly limit: number,
    readonly window: ElfWindowReader,
  ) {
    this.#scanned = new Budget(limit);
    this.#retained = new Budget(limit);
  }

  #charge(field: "scanned" | "retained", bytes: number): void {
    (field === "scanned" ? this.#scanned : this.#retained).charge(bytes, () =>
      decodeLimit(
        "elf-dependencies",
        `ELF dependency text exceeds the ${String(this.limit)}-byte budget fixed by the admitted image length.`,
        { name: `${field}_text_bytes`, maximum: this.limit },
      ),
    );
  }

  /** Charge text a report row repeats from an already decoded string. */
  retain(...values: readonly (string | null)[]): void {
    for (const value of values)
      if (value !== null) this.#charge("retained", value.length);
  }

  *read(offset: number): ElfDependencySteps<CString> {
    if (this.table === null)
      return { state: "table-unavailable", name: null, location: null };
    const cached = this.#cache.get(offset);
    if (cached !== undefined) {
      this.retain(cached.name);
      return cached;
    }
    const remaining = this.table.size - offset;
    if (offset < 0 || remaining <= 0)
      return { state: "outside", name: null, location: null };
    const at = this.table.offset + offset;
    const first = yield* this.window.readPrefix(
      at,
      Math.min(remaining, WINDOW_READ_BYTES),
      "DT_STRTAB",
    );
    let observed = observeElfStringTableWindow(first, remaining);
    if (observed.state === "truncated" && observed.scanLimited) {
      const bytes = yield* this.window.readSlice(
        at,
        Math.min(remaining, ELF_STRING_SCAN_BYTES),
        "DT_STRTAB",
      );
      observed = observeElfStringTableWindow(bytes, remaining);
    }
    this.#charge("scanned", observed.examinedBytes);
    let entry: CString;
    if (observed.state !== "terminated")
      entry = {
        state:
          observed.state === "truncated" && observed.scanLimited
            ? "scan-limit"
            : "unterminated",
        name: null,
        location: this.table.offset + offset,
      };
    else {
      this.#charge("retained", observed.contentBytes);
      entry = {
        state: "terminated",
        name: elfStringTableText(observed),
        location: this.table.offset + offset,
      };
    }
    this.#cache.set(offset, entry);
    return entry;
  }
}

const searchPath = function* (
  strings: DynamicStrings,
  offset: number,
  issues: ElfDependencyIssue[],
  location: string,
): ElfDependencySteps<{
  raw: string;
  entries: string[];
  tokens: ReturnType<typeof elfSearchPathTokens>;
} | null> {
  const observed = yield* strings.read(offset);
  if (observed.name === null) {
    issues.push({
      code: "name_unreadable",
      location,
      message: unreadDynamicString("Search-path", observed),
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
  mappings: ElfLoadMappings,
  address: bigint,
  size: number,
): number | null => {
  try {
    return mappedFileOffset(
      mappings.fileBacked,
      address,
      size,
      mappings.zeroFills,
    );
  } catch (cause) {
    if (cause instanceof BinaryMappingFailure) return null;
    throw cause;
  }
};

/** File-offset end of the PT_LOAD mapping that contains a virtual address. */
const startingLoadFileEnd = (
  mappings: ElfLoadMappings,
  address: bigint,
): number | null => {
  const mapping = mappings.fileBacked.find(
    (range) =>
      address >= range.address && address < range.address + BigInt(range.size),
  );
  if (mapping === undefined) return null;
  return mapping.offset + mapping.size;
};

interface SectionAdmission {
  readonly declaration: SectionFacts | undefined;
  readonly table: SectionFacts | undefined;
}

/**
 * Admit the section declaration at the agreed start, then check its table
 * extent. A conflicting extent does not invalidate the section header's links.
 */
const agreedSection = (
  section: SectionFacts | undefined,
  declared: bigint | undefined,
  mappings: ElfLoadMappings,
  label: string,
  issues: ElfDependencyIssue[],
  sizeAgrees: (section: SectionFacts) => boolean = () => true,
): SectionAdmission => {
  if (section === undefined || declared === undefined)
    return { declaration: section, table: section };
  let declaration: SectionFacts | undefined;
  if (section.address === declared && sizeAgrees(section)) {
    const mapped = resolveMappedFileOffset(
      mappings.fileBacked,
      declared,
      Math.max(1, section.size),
      mappings.zeroFills,
    );
    const start = mapped.ok ? mapped.value : mapAddress(mappings, declared, 1);
    if (start === section.offset) {
      declaration = section;
      if (
        mapped.ok ||
        (mapped.error.reason === "unmapped" && !mapped.error.overlapsZeroFill)
      )
        // A plain gap still allows recovery from the section's file bytes.
        return { declaration, table: section };
    }
  }
  issues.push({
    code: "malformed_entry",
    location: hex(section.offset),
    message:
      declaration === undefined
        ? `${label} section header disagrees with its dynamic-table declaration; using the dynamic declaration`
        : `${label} section extent conflicts with its load mapping. Using the dynamic declaration`,
  });
  return { declaration, table: undefined };
};

const sectionInsideFile = (section: SectionFacts, fileBytes: number): boolean =>
  section.size <= fileBytes - section.offset;

const hashSectionInFile = (
  section: SectionFacts | undefined,
  fileBytes: number,
  label: string,
  issues: ElfDependencyIssue[],
): section is SectionFacts => {
  if (section === undefined) return false;
  if (sectionInsideFile(section, fileBytes)) return true;
  issues.push({
    code: "malformed_entry",
    location: hex(section.offset),
    message: `${label} section header declares bytes past the end of the file`,
  });
  return false;
};

/**
 * Section headers are optional and can declare bytes the file does not hold.
 * Only the part inside the file is a table or a report location. A table that
 * starts past the end has no usable part, so its dynamic declaration is used.
 */
const tableFromSection = (
  section: SectionFacts | undefined,
  fileBytes: number,
  label: string,
  issues: ElfDependencyIssue[],
): LocatedTable | null => {
  if (section === undefined) return null;
  const { offset, size } = section;
  const available = fileBytes - offset;
  if (size <= available)
    return { offset, size, location: { offset, bytes: size } };
  issues.push({
    code: "malformed_entry",
    location: hex(offset),
    message: `${label} section header declares bytes past the end of the file`,
  });
  if (available <= 0) return null;
  return { offset, size: available, location: { offset, bytes: available } };
};

const tableFromVirtual = (
  mappings: ElfLoadMappings,
  address: bigint | undefined,
  size: number,
): LocatedTable | null => {
  if (address === undefined || size < 0) return null;
  const offset = mapAddress(mappings, address, size === 0 ? 1 : size);
  if (offset === null) return null;
  return {
    offset,
    size,
    location: { offset, bytes: size },
  };
};

const GNU_VERSYM_SLOT_BYTES = 2;

/** Keep complete leading slots in one proven file translation. */
const tableFromMappedVersym = (
  mappings: IndexedElfLoadMappings,
  address: bigint | undefined,
  count: number,
): LocatedTable | null => {
  if (address === undefined) return null;
  const complete = tableFromVirtual(
    mappings,
    address,
    count * GNU_VERSYM_SLOT_BYTES,
  );
  if (complete !== null || count <= 1) return complete;

  const prefix = mappings
    .index()
    .prefix(address, count * GNU_VERSYM_SLOT_BYTES);
  if (prefix === null) return null;
  const { offset } = prefix;
  const size = prefix.size - (prefix.size % GNU_VERSYM_SLOT_BYTES);
  return size === 0
    ? null
    : { offset, size, location: { offset, bytes: size } };
};

const WINDOW_READ_BYTES = 4096;

type ElfDependencyStep =
  | { readonly kind: "yield" }
  | { readonly kind: "read"; readonly offset: number; readonly length: number };

type ElfDependencySteps<T> = Generator<
  ElfDependencyStep,
  T,
  Buffer | undefined
>;

const checkElfRange = (
  fileSize: number,
  offset: number,
  size: number,
  label: string,
): void => {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    size < 0 ||
    offset > fileSize
  )
    throw new BinaryFormatFailure(
      "malformed",
      `${label} range is truncated or outside the file`,
      {
        format: "elf",
        field: label,
        ...(Number.isSafeInteger(offset) ? { offset } : {}),
      },
    );
  if (size > fileSize - offset)
    throw new BinaryFormatFailure(
      "truncated",
      `${label} range is truncated or outside the file`,
      { format: "elf", offset, field: label },
    );
};

const readElfRange = function* (
  fileSize: number,
  offset: number,
  size: number,
  label: string,
): ElfDependencySteps<Buffer> {
  checkElfRange(fileSize, offset, size, label);
  if (size === 0) return Buffer.alloc(0);
  return (yield { kind: "read", offset, length: size }) as Buffer;
};

interface ElfWindowReader {
  readonly fileSize: number;
  readonly little: boolean;
  readSlice(
    offset: number,
    size: number,
    label: string,
  ): ElfDependencySteps<Buffer>;
  readPrefix(
    offset: number,
    maximum: number,
    label: string,
  ): ElfDependencySteps<Buffer>;
  u16(offset: number): ElfDependencySteps<number>;
  u32(offset: number): ElfDependencySteps<number>;
}

const createElfWindowReader = (
  fileSize: number,
  little: boolean,
): ElfWindowReader => {
  let windowStart = 0;
  let windowBytes: Buffer = Buffer.alloc(0);
  let windowReader = new BinaryReader(windowBytes, little, "elf");
  const ensureWindow = function* (
    offset: number,
    size: number,
    label: string,
  ): ElfDependencySteps<number> {
    checkElfRange(fileSize, offset, size, label);
    if (size === 0) return 0;
    if (
      offset >= windowStart &&
      offset + size <= windowStart + windowBytes.length
    )
      return offset - windowStart;
    const fetchSize = Math.min(
      Math.max(size, WINDOW_READ_BYTES),
      fileSize - offset,
    );
    windowStart = offset;
    windowBytes = (yield {
      kind: "read",
      offset,
      length: fetchSize,
    }) as Buffer;
    windowReader = new BinaryReader(windowBytes, little, "elf");
    return 0;
  };
  const readSlice = function* (
    offset: number,
    size: number,
    label: string,
  ): ElfDependencySteps<Buffer> {
    const rel = yield* ensureWindow(offset, size, label);
    return size === 0 ? Buffer.alloc(0) : windowBytes.subarray(rel, rel + size);
  };
  return {
    fileSize,
    little,
    readSlice,
    *readPrefix(offset, maximum, label): ElfDependencySteps<Buffer> {
      const rel = yield* ensureWindow(offset, 1, label);
      return windowBytes.subarray(rel, rel + maximum);
    },
    *u16(offset: number): ElfDependencySteps<number> {
      const rel = yield* ensureWindow(offset, 2, "16-bit field");
      return windowReader.u16(rel);
    },
    *u32(offset: number): ElfDependencySteps<number> {
      const rel = yield* ensureWindow(offset, 4, "32-bit field");
      return windowReader.u32(rel);
    },
  };
};

type HashWordStepReader = (
  offset: number,
) => ElfDependencySteps<Result<number, string>>;

const hashWordsStep = (
  window: ElfWindowReader,
  base: number,
  end: number,
): HashWordStepReader =>
  function* (offset) {
    const at = base + offset;
    if (offset < 0 || at + 4 > Math.min(end, window.fileSize))
      return err("extends past its mapped bytes");
    return ok(yield* window.u32(at));
  };

const mappedHashWordsStep = (
  window: ElfWindowReader,
  mappings: IndexedElfLoadMappings,
  address: bigint,
  coverage: "word" | "prefix" = "word",
): HashWordStepReader => {
  const index = mappings.index();
  return function* (offset) {
    if (offset < 0) return err("precedes its table");
    const start = coverage === "prefix" ? 0 : offset;
    const relative = offset - start;
    let at: number;
    try {
      at = index.offset(address + BigInt(start), relative + 4) + relative;
    } catch (cause) {
      if (cause instanceof BinaryMappingFailure)
        return err("is not mapped by PT_LOAD");
      throw cause;
    }
    if (at + 4 > window.fileSize) return err("is not mapped by PT_LOAD");
    return ok(yield* window.u32(at));
  };
};

const readHashCount = function* (
  steps: ElfHashCountSteps<number | null>,
  read: HashWordStepReader,
): ElfDependencySteps<number | null> {
  const checkpoint = ok(0);
  let next = steps.next();
  while (!next.done) {
    if (next.value === undefined) {
      yield { kind: "yield" };
      next = steps.next(checkpoint);
    } else next = steps.next(yield* read(next.value));
  }
  const count = next.value;
  if (count.ok) return count.value;
  if (count.error.kind === "budget")
    throw decodeLimit(
      "elf-dependencies",
      `${count.error.label} exceeds the fixed ELF dependency decoding allowance.`,
      {
        name: "gnu_hash_entries",
        maximum: MAX_INSPECT_ELF_DEPENDENCY_IMPORTS,
        required: count.error.count,
      },
    );
  return null;
};

const readGnuHashCount = (read: HashWordStepReader, bits: 32 | 64) =>
  readHashCount(
    readElfGnuHashSymbolCountSteps(
      bits === 64 ? 8 : 4,
      MAX_INSPECT_ELF_DEPENDENCY_IMPORTS,
    ),
    read,
  );

const locateVersionTable = (
  mappings: IndexedElfLoadMappings,
  fileBytes: number,
  section: SectionFacts | undefined,
  address: bigint | undefined,
  label: string,
  issues: ElfDependencyIssue[],
): LocatedTable | null => {
  const fromSection = tableFromSection(section, fileBytes, label, issues);
  if (fromSection !== null) return fromSection;
  if (address === undefined) return null;
  const offset = mapAddress(mappings, address, 16);
  if (offset === null) return null;
  // Without a section header the table extent is unknown; keep every later
  // record read inside the PT_LOAD mapping that admitted the table start.
  const end = startingLoadFileEnd(mappings, address);
  if (end === null) return null;
  const prefix = mappings
    .index()
    .prefix(address, Math.min(end, fileBytes) - offset);
  if (prefix === null) return null;
  const { size } = prefix;
  return { offset, size, location: { offset, bytes: size } };
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
const parseElfDependenciesCore = function* (
  fileSize: number,
  artifact: Artifact,
  input: InspectElfDependenciesInput,
): ElfDependencySteps<ElfDependencies> {
  const headerBytes = yield* readElfRange(
    fileSize,
    0,
    Math.min(fileSize, 64),
    "ELF header",
  );
  const fixed = readElfFixedHeader(headerBytes, fileSize);
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
  const raw = readElfRawTableDeclarations(headerBytes, header);
  if (!raw.ok) return fail(raw.error.message);
  const sectionTable = validateElfSectionTableFields(raw.value);
  if (!sectionTable.ok) return fail(sectionTable.error);
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
  if (phnum === 0xffff || shstrndx === 0xffff)
    throw new BinaryFormatFailure(
      "unsupported",
      "ELF extended numbering is unsupported.",
    );
  const bits = header.elfClass;
  const little = header.byteOrder === "little";
  const window = createElfWindowReader(fileSize, little);
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
  const programHeaders = yield* readElfRange(
    fileSize,
    phoff,
    phnum * phentsize,
    "ELF program headers",
  );
  const fileBacked: FileMapping[] = [];
  const zeroFills: ZeroFillMapping[] = [];
  let interp: Range | null = null;
  let dynamic: Range | null = null;
  for (let index = 0; index < phnum; index += 1) {
    const parsedProgram = readElfProgramHeader(
      programHeaders.subarray(index * phentsize, index * phentsize + phentsize),
      bits,
      little,
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
    const admitted = admitElfLoadSegment(program, bits);
    if (!admitted.ok) return fail(admitted.error.message);
    const range = fileRange(program.offset, program.fileSize, "PT_LOAD");
    if (range.bytes > 0)
      checkElfRange(fileSize, range.offset, range.bytes, "PT_LOAD");
    const spans = elfLoadSpans(program);
    if (spans.fileBacked !== undefined) fileBacked.push(spans.fileBacked);
    if (spans.zeroFill !== undefined) zeroFills.push(spans.zeroFill);
  }
  let mappingIndex: FileMappingIndex | undefined;
  const mappings: IndexedElfLoadMappings = {
    fileBacked,
    zeroFills,
    index: () =>
      (mappingIndex ??= createFileMappingIndex(fileBacked, zeroFills)),
  };
  const issues: ElfDependencyIssue[] = [];
  const interpreter = yield* parseInterpreter(fileSize, interp, issues);
  if (dynamic === null)
    return emptyInventory(artifact, identity, interpreter, issues);
  const table = yield* readElfRange(
    fileSize,
    dynamic.offset,
    dynamic.bytes,
    "PT_DYNAMIC",
  );
  const unique = new Map<bigint, number>();
  const addresses = new Map<bigint, bigint>();
  const neededEntries: {
    readonly nameOffset: number;
    readonly sourceOffset: number;
  }[] = [];
  const walked = walkElfDynamicTable<never>(
    table,
    { bits, littleEndian: little },
    UNIQUE_DYNAMIC_TAGS,
    ({ tag, value, offset, singleton }) => {
      if (tag === DT_NEEDED) {
        neededEntries.push({
          nameOffset: asNumber(value, "DT_NEEDED"),
          sourceOffset: dynamic.offset + offset,
        });
        charge(
          neededEntries.length,
          input.max_needed,
          MAX_INSPECT_ELF_DEPENDENCY_NEEDED,
          "DT_NEEDED entries",
          "max_needed",
        );
      } else if (ADDRESS_DYNAMIC_TAGS.has(tag)) addresses.set(tag, value);
      else if (singleton)
        unique.set(tag, asNumber(value, `DT tag ${hex(tag)}`));
    },
  );
  if (!walked.ok)
    return fail(
      walked.error.kind === "duplicate-singleton"
        ? `Duplicate dynamic tag ${hex(walked.error.tag)}`
        : walked.error.error,
    );
  const { terminatorOffset, trailingBytes } = walked.value;
  if (trailingBytes !== 0)
    issues.push({
      code: "malformed_entry",
      location: hex(dynamic.offset + dynamic.bytes - trailingBytes),
      message: "ELF PT_DYNAMIC size is not a whole number of entries",
    });
  else if (terminatorOffset === null)
    issues.push({
      code: "malformed_entry",
      location: hex(dynamic.offset),
      message: "Dynamic segment is not terminated by DT_NULL",
    });
  const sectionFacts = yield* readSections(
    fileSize,
    little,
    bits,
    shoff,
    shnum,
    shentsize,
  );
  const sectionsByType = keyedBy(sectionFacts, (section) => section.type);
  // A repeated section type names no single table; like a disagreeing
  // header, it leaves the dynamic-table declaration in charge.
  const sectionOfType = (type: number, label: string) => {
    const selected = uniqueKeyed(sectionsByType, type);
    if (selected.ok) return selected.value;
    issues.push({
      code: "malformed_entry",
      location: hex(shoff),
      message: `More than one ${label} section header; using the dynamic declaration`,
    });
    return undefined;
  };
  const sectionOf = (type: number, tag: bigint, label: string) =>
    agreedSection(
      sectionOfType(type, label),
      addresses.get(tag),
      mappings,
      label,
      issues,
    ).table;
  const syment = unique.get(DT_SYMENT);
  const { declaration: symbolDeclaration, table: dynsymSection } =
    agreedSection(
      sectionOfType(SHT_DYNSYM, ".dynsym"),
      addresses.get(DT_SYMTAB),
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
    symbolDeclaration === undefined
      ? undefined
      : sectionFacts[symbolDeclaration.link];
  const stringSection = linkedStrings?.type === 3 ? linkedStrings : undefined;
  const { table: dynstrSection } = agreedSection(
    stringSection,
    addresses.get(DT_STRTAB),
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
  const strtab = addresses.get(DT_STRTAB);
  const mappedStrings =
    strtab === undefined
      ? undefined
      : resolveMappedFileOffset(
          fileBacked,
          strtab,
          Math.max(1, strsz ?? dynstrSection?.size ?? 0),
          zeroFills,
        );
  const mappingFailure =
    mappedStrings?.ok === false ? mappedStrings.error : undefined;
  // A section can recover an unmapped span, but cannot provide file bytes
  // where the load mapping supplies zeros or conflicts.
  const ambiguousStrings =
    mappingFailure?.reason === "ambiguous" ||
    (mappingFailure?.reason === "unmapped" &&
      mappingFailure.overlapsZeroFill &&
      stringSection?.address === strtab);
  const dynstrTable = ambiguousStrings
    ? null
    : (tableFromSection(dynstrSection, fileSize, "Dynamic string", issues) ??
      (mappedStrings?.ok === true
        ? {
            offset: mappedStrings.value,
            size: strsz ?? 0,
            location: { offset: mappedStrings.value, bytes: strsz ?? 0 },
          }
        : null));
  if (
    dynstrTable === null &&
    (ambiguousStrings || neededEntries.length > 0 || unique.has(DT_SONAME))
  )
    issues.push({
      code: "table_unavailable",
      location: hex(dynamic.offset),
      message: ambiguousStrings
        ? "ELF dynamic string table has ambiguous file mappings"
        : "Dynamic string table could not be located from section headers or DT_STRTAB",
    });
  if (dynstrTable !== null)
    checkElfRange(fileSize, dynstrTable.offset, dynstrTable.size, "DT_STRTAB");
  const dynstr = new DynamicStrings(
    dynstrTable,
    fileSize,
    createElfWindowReader(fileSize, little),
  );
  const needed: ElfDependencyNeeded[] = [];
  for (const [index, { nameOffset, sourceOffset }] of neededEntries.entries()) {
    const observed = yield* dynstr.read(nameOffset);
    const name =
      observed.name === null || observed.name.length === 0
        ? null
        : observed.name;
    if (name === null)
      issues.push({
        code: "name_unreadable",
        location: hex(observed.location ?? sourceOffset),
        message: unreadDynamicString("DT_NEEDED", observed, nameOffset),
      });
    needed.push({ index, name, name_offset: nameOffset });
  }
  const sonameOffset = unique.get(DT_SONAME);
  const soname =
    sonameOffset === undefined
      ? null
      : {
          name: yield* namedString(dynstr, sonameOffset, issues, "DT_SONAME"),
          name_offset: sonameOffset,
        };
  const rpathOffset = unique.get(DT_RPATH);
  const runpathOffset = unique.get(DT_RUNPATH);
  const rpath =
    rpathOffset === undefined
      ? null
      : yield* searchPath(dynstr, rpathOffset, issues, "DT_RPATH");
  const runpath =
    runpathOffset === undefined
      ? null
      : yield* searchPath(dynstr, runpathOffset, issues, "DT_RUNPATH");
  const flagsRaw = unique.get(DT_FLAGS);
  const flags1Raw = unique.get(DT_FLAGS_1);
  const versionNames = new Map<
    number,
    { name: string | null; file: string | null }
  >();
  let examinedVersions = 0;
  const versionRequirements = yield* parseVerneed(
    window,
    mappings,
    dynstr,
    verneedSection,
    addresses.get(DT_VERNEED),
    unique.get(DT_VERNEEDNUM) ?? verneedSection?.info,
    dynamic.offset,
    issues,
    versionNames,
    () => {
      examinedVersions += 1;
      charge(
        examinedVersions,
        input.max_versions,
        MAX_INSPECT_ELF_DEPENDENCY_VERSIONS,
        "GNU version records",
        "max_versions",
      );
    },
  );
  const versionDefinitions = yield* parseVerdef(
    window,
    mappings,
    dynstr,
    verdefSection,
    addresses.get(DT_VERDEF),
    unique.get(DT_VERDEFNUM) ?? verdefSection?.info,
    dynamic.offset,
    issues,
    () => {
      examinedVersions += 1;
      charge(
        examinedVersions,
        input.max_versions,
        MAX_INSPECT_ELF_DEPENDENCY_VERSIONS,
        "GNU version records",
        "max_versions",
      );
    },
  );
  // Elf32_Sym and Elf64_Sym have fixed widths, so a DT_SYMENT or .dynsym
  // sh_entsize that disagrees is reported and never used to stride the table.
  const symbolEntrySize = elfSymbolSize(bits);
  if (syment !== undefined && syment !== symbolEntrySize)
    issues.push({
      code: "malformed_entry",
      location: hex(dynamic.offset),
      message: "DT_SYMENT does not match the ELF class symbol size",
    });
  if (
    dynsymSection !== undefined &&
    dynsymSection.entrySize !== 0 &&
    dynsymSection.entrySize !== symbolEntrySize
  )
    issues.push({
      code: "malformed_entry",
      location: hex(dynsymSection.offset),
      message: ".dynsym sh_entsize does not match the ELF class symbol size",
    });
  const symbolCount = yield* locateSymbolCount(
    window,
    mappings,
    dynsymSection,
    hashSection,
    gnuHashSection,
    addresses,
    bits,
    elfHashEntryLayout({ machine: header.machine, bits, little }),
    symbolEntrySize,
    issues,
  );
  const symbolBytes = symbolCount === null ? 0 : symbolCount * symbolEntrySize;
  const dynsymTable =
    tableFromSection(dynsymSection, fileSize, "Dynamic symbol", issues) ??
    (symbolCount === null
      ? null
      : tableFromVirtual(mappings, addresses.get(DT_SYMTAB), symbolBytes));
  const versymTable =
    tableFromSection(versymSection, fileSize, "GNU versym", issues) ??
    (symbolCount === null
      ? null
      : tableFromMappedVersym(mappings, addresses.get(DT_VERSYM), symbolCount));
  if (
    dynsymTable === null &&
    symbolCount !== null &&
    (dynsymSection !== undefined || addresses.has(DT_SYMTAB) || symbolCount > 0)
  )
    issues.push({
      code: "table_unavailable",
      location: hex(
        addresses.get(DT_SYMTAB) ?? dynsymSection?.offset ?? dynamic.offset,
      ),
      message:
        "Dynamic symbol table could not be located from section headers or DT_SYMTAB",
    });
  if (
    versymTable === null &&
    symbolCount !== null &&
    (versymSection !== undefined || addresses.has(DT_VERSYM))
  )
    issues.push({
      code: "table_unavailable",
      location: hex(addresses.get(DT_VERSYM) ?? versymSection?.offset ?? 0),
      message:
        "GNU versym table could not be located from section headers or DT_VERSYM",
    });
  const versymSlots =
    versymTable === null
      ? null
      : {
          offset: versymTable.offset,
          count: Math.floor(versymTable.size / GNU_VERSYM_SLOT_BYTES),
        };
  if (
    versymSlots !== null &&
    symbolCount !== null &&
    versymSlots.count < symbolCount
  )
    issues.push({
      code: "table_unavailable",
      location: hex(versymSlots.offset),
      message: `GNU versym table holds ${String(versymSlots.count)} of ${String(symbolCount)} dynamic symbol slots; later slots were not read`,
    });
  const imports = yield* parseImports(
    fileSize,
    little,
    header.machine,
    bits,
    dynsymTable,
    versymSlots,
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
          : decodeElfDynamicFlags(flagsRaw, DF_FLAG_BITS),
      flags_1:
        flags1Raw === undefined
          ? null
          : decodeElfDynamicFlags(flags1Raw, DF_1_FLAG_BITS),
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

/** Decode PT_DYNAMIC, GNU versions, and undefined .dynsym imports positionally over a handle. */
export const parseElfDependenciesFromHandle = async (
  source: PrefixedByteSource,
  artifact: Artifact,
  input: InspectElfDependenciesInput,
  onYield: () => Promise<void>,
): Promise<ElfDependencies> => {
  const steps = parseElfDependenciesCore(source.size, artifact, input);
  let next = steps.next();
  while (!next.done) {
    const step = next.value;
    if (step.kind === "yield") {
      await onYield();
      next = steps.next(undefined);
    } else {
      const slice =
        step.offset + step.length <= source.prefix.length
          ? source.prefix.subarray(step.offset, step.offset + step.length)
          : await source.readRange(step.offset, step.length);
      next = steps.next(slice);
    }
  }
  return next.value;
};

const namedString = function* (
  strings: DynamicStrings,
  offset: number,
  issues: ElfDependencyIssue[],
  label: string,
): ElfDependencySteps<string | null> {
  const observed = yield* strings.read(offset);
  if (observed.name === null || observed.name.length === 0) {
    issues.push({
      code: "name_unreadable",
      location: label,
      message: unreadDynamicString(label, observed),
    });
    return null;
  }
  return observed.name;
};

const parseInterpreter = function* (
  fileSize: number,
  interp: Range | null,
  issues: ElfDependencyIssue[],
): ElfDependencySteps<ElfDependencies["interpreter"]> {
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
    checkElfRange(fileSize, interp.offset, interp.bytes, "PT_INTERP");
    const body = yield* readElfRange(
      fileSize,
      interp.offset,
      Math.min(interp.bytes, ELF_STRING_SCAN_BYTES),
      "PT_INTERP",
    );
    const observed = observeElfStringTableWindow(body, interp.bytes);
    if (observed.state !== "terminated") {
      issues.push({
        code: "name_unreadable",
        location: hex(interp.offset),
        message: `PT_INTERP path ${unreadString(observed.state === "truncated" && observed.scanLimited)}`,
      });
      return { status: "unreadable", path: null, location: interp };
    }
    const path = elfStringTableText(observed);
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

const readSections = function* (
  fileSize: number,
  little: boolean,
  bits: 32 | 64,
  shoff: number,
  shnum: number,
  shentsize: number,
): ElfDependencySteps<SectionFacts[]> {
  if (shnum === 0) return [];
  if (shentsize < (bits === 64 ? 64 : 40))
    fail("ELF section header width is invalid.");
  const sectionHeaders = yield* readElfRange(
    fileSize,
    shoff,
    shnum * shentsize,
    "ELF section headers",
  );
  const found: SectionFacts[] = [];
  for (let index = 0; index < shnum; index += 1) {
    const parsed = readElfSectionHeader(
      sectionHeaders.subarray(index * shentsize, index * shentsize + shentsize),
      bits,
      little,
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

const locateSymbolCount = function* (
  window: ElfWindowReader,
  mappings: IndexedElfLoadMappings,
  dynsym: SectionFacts | undefined,
  hash: SectionFacts | undefined,
  gnuHash: SectionFacts | undefined,
  tags: ReadonlyMap<bigint, bigint>,
  bits: 32 | 64,
  hashEntry: ElfHashEntryLayout,
  entrySize: number,
  issues: ElfDependencyIssue[],
): ElfDependencySteps<number | null> {
  const hashAddress = tags.get(DT_HASH);
  const dynamicCount = function* (
    coverage: "word" | "prefix" = "word",
  ): ElfDependencySteps<number | null> {
    if (hashAddress === undefined) return null;
    return yield* readHashCount(
      readElfHashSymbolCountSteps(undefined, hashEntry),
      mappedHashWordsStep(window, mappings, hashAddress, coverage),
    );
  };
  if (
    dynsym !== undefined &&
    entrySize > 0 &&
    dynsym.size % entrySize === 0 &&
    sectionInsideFile(dynsym, window.fileSize)
  ) {
    const sectionCount = dynsym.size / entrySize;
    // Displacing a usable section requires the full mapped DT_HASH span.
    const declaredCount = yield* dynamicCount("prefix");
    if (declaredCount === null) return sectionCount;
    if (sectionCount > declaredCount)
      issues.push({
        code: "malformed_entry",
        location: hex(dynsym.offset),
        message: `.dynsym section declares ${String(sectionCount)} symbols, past the DT_HASH dynamic symbol count of ${String(declaredCount)}; trailing entries were not read`,
      });
    return declaredCount;
  }
  const sectionHash =
    hashSectionInFile(hash, window.fileSize, ".hash", issues) && hash.size >= 8
      ? yield* readHashCount(
          readElfHashSymbolCountSteps(undefined, hashEntry),
          hashWordsStep(window, hash.offset, hash.offset + hash.size),
        )
      : null;
  const count = sectionHash ?? (yield* dynamicCount());
  if (count !== null) return count;
  const sectionGnu =
    hashSectionInFile(gnuHash, window.fileSize, ".gnu.hash", issues) &&
    gnuHash.size >= 16
      ? yield* readGnuHashCount(
          hashWordsStep(window, gnuHash.offset, gnuHash.offset + gnuHash.size),
          bits,
        )
      : null;
  const gnuAddress = tags.get(DT_GNU_HASH);
  const gnu =
    sectionGnu ??
    (gnuAddress === undefined
      ? null
      : yield* readGnuHashCount(
          mappedHashWordsStep(window, mappings, gnuAddress),
          bits,
        ));
  if (gnu !== null) return gnu;
  issues.push({
    code: "table_unavailable",
    location: null,
    message:
      "Dynamic symbol count could not be located from SHT_DYNSYM, DT_HASH, or DT_GNU_HASH",
  });
  return null;
};

/**
 * Moves along a GNU version chain. The declared count and the links must end
 * together: the dynamic loader follows the links, so a count that stops first
 * would leave records it reads out of this report.
 */
const followVersionLink = (
  chain: string,
  offset: number,
  link: number,
  recordSize: number,
  expectsAnother: boolean,
): number => {
  if (!expectsAnother) {
    if (link !== 0) fail(`${chain} chain continues past its declared count`);
    return offset;
  }
  // A zero link ends the chain early, as it does for the loader. Links are
  // unsigned and at least one record long, so the walk only moves forward.
  if (link < recordSize) fail(`${chain} chain ends before its declared count`);
  return offset + link;
};

const parseVerneed = function* (
  window: ElfWindowReader,
  mappings: IndexedElfLoadMappings,
  dynstr: DynamicStrings,
  section: SectionFacts | undefined,
  address: bigint | undefined,
  declaredCount: number | undefined,
  dynamicOffset: number,
  issues: ElfDependencyIssue[],
  versionNames: Map<number, { name: string | null; file: string | null }>,
  chargeVersion: () => void,
): ElfDependencySteps<ElfDependencies["version_requirements"]> {
  const table = locateVersionTable(
    mappings,
    window.fileSize,
    section,
    address,
    "GNU version requirements",
    issues,
  );
  if (table === null) {
    const declaresRecords = declaredCount !== undefined && declaredCount > 0;
    if (address !== undefined)
      issues.push({
        code: "table_unavailable",
        location: hex(address),
        message: "GNU version requirements could not be located",
      });
    else if (section === undefined && declaresRecords)
      issues.push({
        code: "table_unavailable",
        location: hex(dynamicOffset),
        message:
          "GNU version requirements declare DT_VERNEEDNUM without DT_VERNEED or SHT_GNU_VERNEED",
      });
    return {
      status:
        address === undefined && section === undefined && !declaresRecords
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
    checkElfRange(
      window.fileSize,
      table.offset,
      Math.min(table.size, 16),
      "GNU verneed",
    );
    let offset = 0;
    for (let record = 0; record < count; record += 1) {
      if (offset + 16 > table.size)
        fail("GNU version requirement chain leaves its table");
      chargeVersion();
      const at = table.offset + offset;
      const revision = yield* window.u16(at);
      if (revision !== 1)
        fail(
          `GNU version requirement revision ${String(revision)} is unsupported`,
        );
      const auxiliaryCount = yield* window.u16(at + 2);
      const fileOffset = yield* window.u32(at + 4);
      const auxiliaryOffset = yield* window.u32(at + 8);
      const next = yield* window.u32(at + 12);
      const file = yield* namedString(dynstr, fileOffset, issues, "vn_file");
      if (auxiliaryCount > 0 && auxiliaryOffset < 16)
        fail(
          "GNU version requirement auxiliary chain starts inside its header",
        );
      const versions: ElfVersionNeedFile["versions"] = [];
      const pending: [number, { name: string | null; file: string | null }][] =
        [];
      let auxiliary = offset + auxiliaryOffset;
      for (let item = 0; item < auxiliaryCount; item += 1) {
        if (auxiliary + 16 > table.size)
          fail("GNU version requirement auxiliary chain leaves its table");
        chargeVersion();
        const auxAt = table.offset + auxiliary;
        const hash = yield* window.u32(auxAt);
        const flags = yield* window.u16(auxAt + 4);
        const index = (yield* window.u16(auxAt + 6)) & 0x7fff;
        const nameOffset = yield* window.u32(auxAt + 8);
        const auxiliaryNext = yield* window.u32(auxAt + 12);
        const name = yield* namedString(dynstr, nameOffset, issues, "vna_name");
        versions.push({
          name,
          hash,
          flags: { weak: (flags & VER_FLG_WEAK) !== 0 },
          index,
        });
        // A structurally observed index participates even without either string.
        pending.push([index, { name, file }]);
        auxiliary = followVersionLink(
          "GNU version requirement auxiliary",
          auxiliary,
          auxiliaryNext,
          16,
          item + 1 < auxiliaryCount,
        );
      }
      files.push({ file, versions });
      // Join imports only against records whose whole file entry was read.
      for (const [index, entry] of pending) {
        if (versionNames.has(index)) conflicts.add(index);
        else versionNames.set(index, entry);
      }
      offset = followVersionLink(
        "GNU version requirement",
        offset,
        next,
        16,
        record + 1 < count,
      );
    }
    settleConflicts();
    return { status: "present", location: table.location, files };
  } catch (cause) {
    if (cause instanceof ParseFailureError && cause.kind === "limit")
      throw cause;
    settleConflicts();
    issues.push({
      code: "version_unresolved",
      location: hex(table.offset),
      message: `GNU version requirements: ${errorMessage(cause)}`,
    });
    // Keep the records read before the failure; versionNames already joins
    // imports against exactly this prefix.
    return { status: "unreadable", location: table.location, files };
  }
};

const parseVerdef = function* (
  window: ElfWindowReader,
  mappings: IndexedElfLoadMappings,
  dynstr: DynamicStrings,
  section: SectionFacts | undefined,
  address: bigint | undefined,
  declaredCount: number | undefined,
  dynamicOffset: number,
  issues: ElfDependencyIssue[],
  chargeVersion: () => void,
): ElfDependencySteps<ElfDependencies["version_definitions"]> {
  const table = locateVersionTable(
    mappings,
    window.fileSize,
    section,
    address,
    "GNU version definitions",
    issues,
  );
  if (table === null) {
    const declaresRecords = declaredCount !== undefined && declaredCount > 0;
    if (address !== undefined)
      issues.push({
        code: "table_unavailable",
        location: hex(address),
        message: "GNU version definitions could not be located",
      });
    else if (section === undefined && declaresRecords)
      issues.push({
        code: "table_unavailable",
        location: hex(dynamicOffset),
        message:
          "GNU version definitions declare DT_VERDEFNUM without DT_VERDEF or SHT_GNU_VERDEF",
      });
    return {
      status:
        address === undefined && section === undefined && !declaresRecords
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
    let offset = 0;
    for (let record = 0; record < count; record += 1) {
      if (offset + 20 > table.size)
        fail("GNU version definition chain leaves its table");
      chargeVersion();
      const at = table.offset + offset;
      const revision = yield* window.u16(at);
      if (revision !== 1)
        fail(
          `GNU version definition revision ${String(revision)} is unsupported`,
        );
      const flags = yield* window.u16(at + 2);
      const index = (yield* window.u16(at + 4)) & 0x7fff;
      const auxiliaryCount = yield* window.u16(at + 6);
      const aux = yield* window.u32(at + 12);
      const next = yield* window.u32(at + 16);
      if (auxiliaryCount === 0)
        fail("GNU version definition has no name entry");
      if (aux < 20 || offset + aux + 8 > table.size)
        fail("GNU version definition name entry leaves its table");
      const nameOffset = yield* window.u32(table.offset + offset + aux);
      // The first auxiliary record names the definition; the rest name its
      // parents. Walk them all so a count and link mismatch is reported.
      let auxiliary = offset + aux;
      for (let item = 0; item < auxiliaryCount; item += 1) {
        if (auxiliary + 8 > table.size)
          fail("GNU version definition auxiliary chain leaves its table");
        if (item > 0) chargeVersion();
        auxiliary = followVersionLink(
          "GNU version definition auxiliary",
          auxiliary,
          yield* window.u32(table.offset + auxiliary + 4),
          8,
          item + 1 < auxiliaryCount,
        );
      }
      names.push({
        name: yield* namedString(dynstr, nameOffset, issues, "vda_name"),
        index,
        base: (flags & VER_FLG_BASE) !== 0,
      });
      offset = followVersionLink(
        "GNU version definition",
        offset,
        next,
        20,
        record + 1 < count,
      );
    }
    return { status: "present", location: table.location, names };
  } catch (cause) {
    if (cause instanceof ParseFailureError && cause.kind === "limit")
      throw cause;
    issues.push({
      code: "version_unresolved",
      location: hex(table.offset),
      message: `GNU version definitions: ${errorMessage(cause)}`,
    });
    return { status: "unreadable", location: table.location, names };
  }
};

/**
 * On SPARC (EM_SPARC, EM_SPARC32PLUS, EM_SPARCV9) symbol type 13 is
 * STT_SPARC_REGISTER: an undefined entry declares use of the global register
 * in st_value and may have an empty name (SPARC V9 ABI). It is not an import.
 */
const SPARC_MACHINES: ReadonlySet<number> = new Set([2, 18, 43]);
const STT_SPARC_REGISTER = 13;

const parseImports = function* (
  fileSize: number,
  little: boolean,
  machine: number,
  bits: 32 | 64,
  dynsym: LocatedTable | null,
  versym: { readonly offset: number; readonly count: number } | null,
  dynstr: DynamicStrings,
  declaredCount: number | null,
  entrySize: number,
  versionNames: ReadonlyMap<
    number,
    { name: string | null; file: string | null }
  >,
  maxImports: number,
  issues: ElfDependencyIssue[],
): ElfDependencySteps<ElfDependencyImport[]> {
  if (dynsym === null || declaredCount === null) return [];
  // The count can come from a hash table while the located table is a shorter
  // section; bytes past the table belong to its neighbors, not to .dynsym.
  const tableCount = Math.floor(dynsym.size / entrySize);
  const symbolCount = Math.min(declaredCount, tableCount);
  if (symbolCount < declaredCount)
    issues.push({
      code: "malformed_entry",
      location: hex(dynsym.offset),
      message: `The dynamic symbol count ${String(declaredCount)} exceeds the ${String(dynsym.size)}-byte located table; only its first ${String(symbolCount)} symbols were read`,
    });
  if (symbolCount > MAX_INSPECT_ELF_DEPENDENCY_IMPORTS)
    throw ceilingFailure(
      "Dynamic symbols",
      MAX_INSPECT_ELF_DEPENDENCY_IMPORTS,
      "dynamic_symbols",
      symbolCount,
    );
  const imports: ElfDependencyImport[] = [];
  let dynsymBytes: Buffer;
  try {
    dynsymBytes = yield* readElfRange(
      fileSize,
      dynsym.offset,
      symbolCount * entrySize,
      ".dynsym",
    );
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
    const slotCount = Math.min(symbolCount, versym.count);
    try {
      versymBytes = yield* readElfRange(
        fileSize,
        versym.offset,
        slotCount * GNU_VERSYM_SLOT_BYTES,
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
  const versymReader =
    versymBytes === null ? null : new BinaryReader(versymBytes, little, "elf");
  for (let index = 1; index < symbolCount; index += 1) {
    const rel = index * entrySize;
    const at = dynsym.offset + rel;
    const parsed = readElfSymbolFieldsAt(dynsymBytes, rel, bits, little);
    if (parsed === null) {
      issues.push({
        code: "malformed_entry",
        location: hex(at),
        message: ELF_SYMBOL_TRUNCATED_MESSAGE,
      });
      continue;
    }
    if (parsed.section_index !== 0) continue;
    if (parsed.type === STT_SPARC_REGISTER && SPARC_MACHINES.has(machine))
      continue;
    charge(
      imports.length + 1,
      maxImports,
      MAX_INSPECT_ELF_DEPENDENCY_IMPORTS,
      "Undefined dynamic symbols",
      "max_imports",
    );
    const name = yield* namedString(
      dynstr,
      parsed.name_offset,
      issues,
      `dynsym[${String(index)}]`,
    );
    let version: ElfDependencyImport["version"] = null;
    if (
      versymReader !== null &&
      (index + 1) * GNU_VERSYM_SLOT_BYTES <= versymReader.bytes.length
    ) {
      const raw = versymReader.u16(index * GNU_VERSYM_SLOT_BYTES);
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
          status: resolved?.name && resolved.file ? "resolved" : "unknown",
        };
        if (resolved === undefined)
          issues.push({
            code: "version_unresolved",
            location: hex(
              (versym?.offset ?? 0) + index * GNU_VERSYM_SLOT_BYTES,
            ),
            message: `Import ${name ?? `#${String(index)}`} references version index ${String(versionIndex)} with no matching verneed record`,
          });
      }
    }
    imports.push({
      index,
      name,
      binding: bindingName(parsed.binding),
      type: typeName(parsed.type),
      version,
    });
  }
  return imports;
};
