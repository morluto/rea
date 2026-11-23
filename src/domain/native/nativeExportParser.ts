import { invariantViolation } from "../internalInvariant.js";
import {
  BinaryFormatFailure,
  BinaryReader,
  BinaryResourceFailure,
  createFileMappingIndex,
  hasElfMagic,
  isBinaryFormatOrStringLimitFailure,
  type BinaryStringReadLimit,
} from "../binaryContainer.js";
import { architectureForElfMachine } from "./elfImage.js";
import { readElfStringBytes } from "./elfStringBytes.js";
import {
  elfSymbolExportBinding,
  elfSymbolExportVisibility,
  elfSymbolSize,
  readElfSymbol,
} from "../elfSymbol.js";
import {
  readElfDirectoryFromBuffer,
  readElfDirectoryFromReader,
  type NativeSection,
} from "./nativeSectionDirectory.js";
import type { ZstandardFramePause } from "../compression/zstandardExactFrame.js";
import {
  peDeclaredFileMappings,
  readPeImage,
  readPeImageFromReader,
} from "./peImage.js";
import {
  allKeyed,
  keyedBy,
  uniqueKeyed,
  type Keyed,
} from "../keyedCollection.js";
import {
  MAX_NATIVE_EXPORT_ROWS,
  decodeElfExportName,
  type ElfExport,
  type NativeExportIssue,
  type NativeExports,
  type PeExport,
} from "./nativeExports.js";
import {
  readElfDynamicExportTables,
  readElfDynamicExportTablesFromReader,
  type ElfExportTableSelection,
  type ElfExportTables,
} from "./elfDynamicExportTables.js";
import type { ByteSource } from "../byteSource.js";

type Artifact = NativeExports["artifact"];

const OPERATION = "inspect_native_exports";
const SHT_STRTAB = 3;
const SHT_DYNSYM = 11;
const SHT_GNU_VERDEF = 0x6ffffffd;
const SHT_GNU_VERNEED = 0x6ffffffe;
const SHT_GNU_VERSYM = 0x6fffffff;
const PE_EXPORT_DIRECTORY = 0;
const PE_EXPORT_DIRECTORY_BYTES = 40;
const MAXIMUM_NAME_BYTES = 4096;
/** Text retained across all rows; names can repeat one long string table entry. */
const MAXIMUM_RETAINED_TEXT_BYTES = 16 * 1024 * 1024;

const retainedTextBytes = (...strings: readonly (string | null)[]): number =>
  strings.reduce(
    (bytes, value) =>
      bytes + (value === null ? 0 : Buffer.byteLength(value, "utf8")),
    0,
  );

/** Which fixed export inventory allowance refused the image. */
export const NATIVE_EXPORT_LIMITS = ["rows", "retained_text"] as const;

/**
 * A fixed inventory allowance an image can exhaust. The failure's `LimitRef`
 * names it so consumers derive its units from the producer, not from text:
 * `rows` is an entry count and `retained_text` a byte budget.
 */
export type NativeExportLimit = (typeof NATIVE_EXPORT_LIMITS)[number];

const nativeExportLimit = (
  limit: NativeExportLimit,
  allowance: number,
  message: string,
): BinaryResourceFailure =>
  new BinaryResourceFailure("structure", allowance, message, limit);

const checkRetainedText = (bytes: number): void => {
  if (bytes > MAXIMUM_RETAINED_TEXT_BYTES)
    throw nativeExportLimit(
      "retained_text",
      MAXIMUM_RETAINED_TEXT_BYTES,
      `Export names exceed the ${String(MAXIMUM_RETAINED_TEXT_BYTES)}-byte retained-text allowance`,
    );
};

/** Charge retained text and rows at their owning storage boundary. */
const createRetention = () => {
  let rows = 0;
  let text = 0;
  const retainText = (...strings: readonly (string | null)[]): void => {
    text += retainedTextBytes(...strings);
    checkRetainedText(text);
  };
  return {
    text: retainText,
    row: (...strings: readonly (string | null)[]): void => {
      rows++;
      rowBudget(rows, "Export inventory");
      retainText(...strings);
    },
  };
};

const hex = (value: bigint | number) => `0x${value.toString(16)}`;

const rowBudget = (count: number, label: string): void => {
  if (count > MAX_NATIVE_EXPORT_ROWS)
    throw nativeExportLimit(
      "rows",
      MAX_NATIVE_EXPORT_ROWS,
      `${label} declares ${String(count)} entries, above the ${String(MAX_NATIVE_EXPORT_ROWS)}-entry export inventory allowance`,
    );
};

const coverage = (
  issues: readonly NativeExportIssue[],
  examined: number,
  exports: number,
): NativeExports["coverage"] =>
  issues.length === 0
    ? { status: "complete", reason: null, examined_entries: examined, exports }
    : {
        status: "partial",
        reason: `${String(issues.length)} export table issue(s) affect reported rows or metadata; see issues`,
        examined_entries: examined,
        exports,
      };

const failureMessage = (cause: unknown): string => {
  if (isBinaryFormatOrStringLimitFailure(cause)) return cause.message;
  throw cause;
};

/**
 * `.dynsym` entry 0 is the reserved undefined symbol. The gABI requires every
 * field, including `st_name`, to be zero. A nonzero name does not by itself
 * define a symbol, so the inventory continues and the deviation is recorded.
 * Any other nonzero field means the reserved slot holds a real symbol.
 */
const reservedElfDynamicSymbolNote = (
  bytes: Uint8Array,
  bits: 32 | 64,
  littleEndian: boolean,
  fileOffset: number,
): string | null => {
  const parsed = readElfSymbol(bytes, bits, littleEndian);
  if (!parsed.ok)
    throw new BinaryFormatFailure(parsed.error.kind, parsed.error.message);
  const symbol = parsed.value;
  if (
    symbol.binding !== 0 ||
    symbol.type !== 0 ||
    symbol.other !== 0 ||
    symbol.section_index !== 0 ||
    symbol.value !== 0n ||
    symbol.size !== 0n
  )
    throw new BinaryFormatFailure(
      "malformed",
      "ELF dynamic symbol table null entry has nonzero fields",
    );
  if (symbol.name_offset === 0) return null;
  return `ELF dynamic symbol 0 at file offset ${hex(fileOffset)} has nonzero st_name ${hex(symbol.name_offset)}. st_info, st_other, st_shndx, st_value and st_size are zero, so the entry was skipped and was not reported as an export.`;
};

const PE_LIMITATIONS = [
  "Rows reproduce the PE export directory; they do not establish that an export is reachable, safe to call or loaded at runtime.",
  "Forwarded exports resolve in another DLL, which is not opened; ordinal-only exports have no name in this image.",
];

const ELF_LIMITATIONS = [
  "Rows list defined default- or protected-visibility global, weak and unique dynamic symbols; local, hidden, internal and undefined symbols are not exports.",
  "A hidden symbol version is not the default version that a by-name dlsym lookup selects.",
  "Rows reproduce the dynamic symbol table; they do not establish that a symbol is reachable, safe to call or loaded at runtime.",
];

const ELF_TYPES: Readonly<Record<number, ElfExport["type"]>> = {
  1: "object",
  2: "function",
  6: "tls",
  10: "ifunc",
};
/** Version names by index, read from `.gnu.version_d` and `.gnu.version_r`. */
type DecodedElfString = ReturnType<typeof decodeElfExportName>;

class ElfVersionWorkFailure extends BinaryResourceFailure {}

/** Charge both headers and auxiliary visits, including aliased record replays. */
const versionRecordStep = (size: number, width: number): (() => boolean) => {
  const allowance = Math.min(Math.floor(size / width), MAX_NATIVE_EXPORT_ROWS);
  let visited = 0;
  return () => {
    if (++visited > allowance)
      throw new ElfVersionWorkFailure(
        "structure",
        size,
        `ELF version traversal work allowance of ${String(allowance)} record visits was exhausted; remaining version names are unknown`,
      );
    return visited % 1024 === 0;
  };
};

/** One format owner decodes each selected string-table offset at most once. */
const createVersionNameReader = () => {
  type CachedName =
    | { readonly value: DecodedElfString | null }
    | { readonly failure: BinaryFormatFailure | BinaryStringReadLimit };
  const decodedNames = new WeakMap<Buffer, Map<number, CachedName>>();
  let cacheBytes = 0;
  const chargeCache = (bytes: number): void => {
    if (cacheBytes + bytes > MAXIMUM_RETAINED_TEXT_BYTES)
      throw new ElfVersionWorkFailure(
        "structure",
        MAXIMUM_RETAINED_TEXT_BYTES,
        "ELF version name decoding exceeds its 16 MiB cache allowance; remaining version names are unknown",
      );
    cacheBytes += bytes;
  };
  const readName = (names: Buffer, offset: number): DecodedElfString | null => {
    let table = decodedNames.get(names);
    if (table === undefined) {
      table = new Map();
      decodedNames.set(names, table);
    }
    const cached = table.get(offset);
    if (cached !== undefined) {
      if ("failure" in cached) throw cached.failure;
      return cached.value;
    }
    let raw: Buffer;
    try {
      raw = readElfStringBytes(names, offset);
    } catch (cause) {
      if (!isBinaryFormatOrStringLimitFailure(cause)) throw cause;
      // Invalid offsets/unterminated aliases must not repeatedly scan strings
      // either. Account for the cached error and its stack conservatively.
      chargeCache(4096);
      table.set(offset, { failure: cause });
      throw cause;
    }
    chargeCache(512 + raw.length * 6);
    const value = raw.length === 0 ? null : decodeElfExportName(raw);
    table.set(offset, { value });
    return value;
  };
  return readName;
};

/**
 * The one GNU version section of a type: undefined when absent, null when
 * declared more than once. A repeat is recorded; neither table is chosen.
 */
const versionSection = (
  byType: Keyed<NativeSection, number>,
  type: number,
  label: string,
  issues: NativeExportIssue[],
): NativeSection | null | undefined => {
  const selected = uniqueKeyed(byType, type);
  if (selected.ok) return selected.value;
  const [first] = allKeyed(byType, type);
  issues.push({
    code: "version_unresolved",
    location: hex(first!.offset),
    message: `${label}: the ELF declares ${String(selected.error.ordinals.length)} sections of this type, so none was read`,
  });
  return null;
};

const elfExportPlan = (
  artifact: Artifact,
  directory: ReturnType<typeof readElfDirectoryFromBuffer>,
) => {
  const result = {
    artifact,
    format: "elf" as const,
    architecture: architectureForElfMachine(directory.machine),
    bits: directory.bits,
    byte_order: directory.little ? ("little" as const) : ("big" as const),
  };
  const { sections } = directory;
  const byType = keyedBy(sections, ({ type }) => type);
  const selectedDynsym = uniqueKeyed(byType, SHT_DYNSYM);
  if (!selectedDynsym.ok)
    throw new BinaryFormatFailure(
      "malformed",
      "ELF image has more than one SHT_DYNSYM",
    );
  const dynsym = selectedDynsym.value;
  if (
    dynsym === undefined &&
    sections.length > 0 &&
    !directory.programs.some(({ type }) => type === 2)
  )
    return {
      state: "empty" as const,
      result: {
        ...result,
        exports: [],
        coverage: coverage([], 0, 0),
        issues: [],
        limitations: [
          "The ELF has no dynamic symbol table, so it exports no dynamic symbols.",
          ...ELF_LIMITATIONS,
        ],
      } satisfies Extract<NativeExports, { format: "elf" }>,
    };
  return { state: "ready" as const, result, byType, dynsym };
};

export function* parseElfExportsFromDirectorySteps(
  bytes: Buffer,
  artifact: Artifact,
  directory: ReturnType<typeof readElfDirectoryFromBuffer>,
): Generator<void, Extract<NativeExports, { format: "elf" }>> {
  const plan = elfExportPlan(artifact, directory);
  if (plan.state === "empty") return plan.result;
  const { result, byType, dynsym } = plan;
  const { sections } = directory;
  let selection: ElfExportTableSelection;
  if (dynsym === undefined) {
    selection = yield* readElfDynamicExportTables(bytes, directory);
  } else {
    selection = yield* runBufferedElfReads(
      readElfSectionExportTableSteps(bytes.length, directory, dynsym, byType),
      bytes,
    );
  }
  if (selection.state === "unavailable")
    return unavailableElfExports(result, selection);
  const versionNames =
    dynsym === undefined
      ? new Map<number, DecodedElfString | null>()
      : yield* runBufferedElfReads(
          readVersionNamesSteps(
            bytes.length,
            directory.little,
            sections,
            selection.tables.issues,
          ),
          bytes,
        );
  return yield* projectElfExports(
    result,
    directory.little,
    selection.tables,
    versionNames,
    dynsym === undefined,
  );
}

type ElfExportIdentity = Pick<
  Extract<NativeExports, { format: "elf" }>,
  "artifact" | "format" | "architecture" | "bits" | "byte_order"
>;

const unavailableElfExports = (
  result: ElfExportIdentity,
  selection: Extract<ElfExportTableSelection, { state: "unavailable" }>,
): Extract<NativeExports, { format: "elf" }> => ({
  ...result,
  exports: [],
  coverage: {
    status: "unsupported",
    reason: selection.reason,
    examined_entries: 0,
    exports: 0,
  },
  issues: selection.issues,
  limitations: ELF_LIMITATIONS,
});

function* projectElfExports(
  result: ElfExportIdentity,
  little: boolean,
  {
    count,
    table: tableOffset,
    tableBytes: symbols,
    names,
    versionBytes,
    versionsDeclared,
    issues,
  }: ElfExportTables,
  versionNames: ReadonlyMap<number, DecodedElfString | null>,
  sectionless: boolean,
): Generator<void, Extract<NativeExports, { format: "elf" }>> {
  const directory = { bits: result.bits, little };
  const width = elfSymbolSize(directory.bits);
  const versionReader =
    versionBytes === null
      ? null
      : new BinaryReader(versionBytes, little, "elf");
  const nullSymbolNote = reservedElfDynamicSymbolNote(
    symbols.subarray(0, width),
    directory.bits,
    little,
    tableOffset,
  );
  const unresolvedVersions = new Set<number>();
  const retain = createRetention();
  const exports: ElfExport[] = [];
  for (let index = 1; index < count; index++) {
    if (index % 1024 === 0) yield;
    const at = index * width;
    const parsedSymbol = readElfSymbol(
      symbols.subarray(at, at + width),
      directory.bits,
      directory.little,
    );
    if (!parsedSymbol.ok)
      throw new BinaryFormatFailure(
        parsedSymbol.error.kind,
        parsedSymbol.error.message,
      );
    const symbol = parsedSymbol.value;
    const binding = elfSymbolExportBinding(symbol.binding);
    const visibility = elfSymbolExportVisibility(symbol.other);
    // Undefined, local and hidden/internal symbols are not exports.
    if (
      binding === undefined ||
      symbol.section_index === 0 ||
      visibility === undefined
    )
      continue;
    let version: ElfExport["version"] = null;
    if (versionsDeclared && versionReader === null) version = "unknown";
    else if (versionReader !== null) {
      const raw = versionReader.u16(index * 2);
      const versionIndex = raw & 0x7fff;
      if (versionIndex >= 2) {
        const decodedName = versionNames.get(versionIndex) ?? null;
        if (decodedName === null && !unresolvedVersions.has(versionIndex)) {
          unresolvedVersions.add(versionIndex);
          issues.push({
            code: "version_unresolved",
            location: hex(symbol.value),
            message: `Version index ${String(versionIndex)}, first used by symbol ${String(index)}, has no unambiguous version name`,
          });
        }
        version = {
          index: versionIndex,
          name: decodedName?.name ?? null,
          name_bytes_base64: decodedName?.name_bytes_base64 ?? null,
          name_utf8_decodable: decodedName?.name_utf8_decodable ?? null,
          hidden: (raw & 0x8000) !== 0,
        };
      }
    }
    let name: string;
    let nameUtf8Decodable: boolean;
    let rawNameBase64: string | null;
    try {
      const rawName = readElfStringBytes(names, symbol.name_offset);
      const decodedName = decodeElfExportName(rawName);
      nameUtf8Decodable = decodedName.name_utf8_decodable;
      name = decodedName.name;
      rawNameBase64 = decodedName.name_bytes_base64;
    } catch (cause) {
      issues.push({
        code: "name_unreadable",
        location: hex(symbol.value),
        message: `Dynamic symbol ${String(index)}: ${failureMessage(cause)}`,
      });
      continue;
    }
    if (name === "") {
      issues.push({
        code: "name_unreadable",
        location: hex(symbol.value),
        message: `Defined global dynamic symbol ${String(index)} has an empty name`,
      });
      continue;
    }
    retain.row(
      name,
      typeof version === "object" ? (version?.name ?? null) : null,
      rawNameBase64,
      typeof version === "object" ? (version?.name_bytes_base64 ?? null) : null,
    );
    exports.push({
      name,
      name_bytes_base64: rawNameBase64,
      name_utf8_decodable: nameUtf8Decodable,
      value: hex(symbol.value),
      size: symbol.size.toString(),
      type: ELF_TYPES[symbol.type] ?? "other",
      binding,
      visibility,
      version,
    });
  }
  return {
    ...result,
    exports,
    coverage: coverage(issues, count - 1, exports.length),
    issues,
    limitations: [
      ...ELF_LIMITATIONS,
      ...(sectionless && versionsDeclared
        ? [
            "GNU version names declared through PT_DYNAMIC are not decoded; readable DT_VERSYM indices and hidden flags remain available and unresolved names make coverage partial.",
          ]
        : []),
      ...(nullSymbolNote === null ? [] : [nullSymbolNote]),
    ],
  };
}

/** Shared bounded checkpoints; consumers may yield/cancel without another parser. */
export function* parseNativeExportsSteps(
  bytes: Buffer,
  artifact: Artifact,
): Generator<void, NativeExports> {
  yield;
  if (hasElfMagic(bytes))
    return yield* parseElfExportsFromDirectorySteps(
      bytes,
      artifact,
      readElfDirectoryFromBuffer(bytes, OPERATION),
    );
  if (bytes.subarray(0, 2).equals(Buffer.from("MZ")))
    return yield* parsePeExports(bytes, artifact);
  throw new BinaryFormatFailure(
    "unsupported",
    "Only PE and ELF images are supported; inspect Mach-O exports with inspect_macho",
  );
}

/** Synchronous callers use exactly the same parsed facts and resource bounds. */
export const parseNativeExports = (
  bytes: Buffer,
  artifact: Artifact,
): NativeExports => finishExports(parseNativeExportsSteps(bytes, artifact));

const finishExports = (
  steps: Generator<void, NativeExports>,
): NativeExports => {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
};

const CSTRING_WINDOW_BYTES = 4096;

const createSourceReaders = (source: ByteSource) => {
  const readRange = (offset: number, length: number): Promise<Buffer> => {
    if (offset < 0 || length <= 0 || offset >= source.size)
      return Promise.resolve(Buffer.alloc(0));
    const clamped = Math.min(length, source.size - offset);
    if (source.prefix !== undefined && offset + clamped <= source.prefix.length)
      return Promise.resolve(source.prefix.subarray(offset, offset + clamped));
    return source.readRange(offset, clamped);
  };
  let window: Buffer = Buffer.alloc(0);
  let windowOffset = 0;
  const readPrefix = async (
    offset: number,
    maximum: number,
  ): Promise<Buffer> => {
    if (source.prefix !== undefined && offset < source.prefix.length)
      return source.prefix.subarray(offset, offset + maximum);
    if (offset < windowOffset || offset >= windowOffset + window.length) {
      window = await readRange(offset, CSTRING_WINDOW_BYTES);
      windowOffset = offset;
    }
    return window.subarray(
      offset - windowOffset,
      offset - windowOffset + maximum,
    );
  };
  const stringTables = new Map<string, Buffer>();
  const readStringTable = async (
    offset: number,
    length: number,
  ): Promise<Buffer> => {
    const key = `${String(offset)}:${String(length)}`;
    const existing = stringTables.get(key);
    if (existing !== undefined) return existing;
    const bytes = await readRange(offset, length);
    stringTables.set(key, bytes);
    return bytes;
  };
  return { readRange, readPrefix, readStringTable };
};

const requireElfFileRange = (
  fileSize: number,
  offset: bigint,
  size: bigint,
  label: string,
): { readonly offset: number; readonly size: number } => {
  if (offset < 0n || offset > BigInt(fileSize))
    throw new BinaryFormatFailure(
      "malformed",
      `${label} range is outside the file`,
      {
        format: "elf",
        field: label,
      },
    );
  if (size < 0n || size > BigInt(fileSize) - offset)
    throw new BinaryFormatFailure(
      "truncated",
      `${label} range is outside the file`,
      {
        format: "elf",
        field: label,
        offset: Number(offset),
      },
    );
  return { offset: Number(offset), size: Number(size) };
};

type PeExportRead =
  | { readonly kind: "range"; readonly offset: number; readonly length: number }
  | {
      readonly kind: "name";
      readonly mapping: ReturnType<typeof createFileMappingIndex>;
      readonly address: bigint;
      readonly maximum: number;
    };

function* parsePeExportSteps(
  image: ReturnType<typeof readPeImage>,
  artifact: Artifact,
): Generator<PeExportRead | undefined, NativeExports, Buffer | undefined> {
  const base = image.image_base ?? 0n;
  const directory = image.pe_data_directories?.[PE_EXPORT_DIRECTORY];
  const result = {
    artifact,
    format: "pe" as const,
    architecture: image.architecture,
    bits: image.bits,
  };
  if (directory === undefined || directory.address === 0)
    return {
      ...result,
      export_directory: null,
      exports: [],
      coverage: coverage([], 0, 0),
      issues: [],
      limitations: [
        "The image declares no export directory, so it exports nothing by name or ordinal.",
        ...PE_LIMITATIONS,
      ],
    };
  if (directory.size < PE_EXPORT_DIRECTORY_BYTES)
    throw new BinaryFormatFailure(
      "malformed",
      `PE export directory declares ${String(directory.size)} bytes, below the ${String(PE_EXPORT_DIRECTORY_BYTES)}-byte table`,
    );
  const mappingIndex = createFileMappingIndex(
    peDeclaredFileMappings(image),
    image.zero_fills,
  );
  const map = (rva: number, size: number): number =>
    mappingIndex.offset(base + BigInt(rva), size);
  function* readRange(
    offset: number,
    length: number,
  ): Generator<PeExportRead, Buffer, Buffer | undefined> {
    const bytes = yield { kind: "range", offset, length };
    if (bytes === undefined)
      throw invariantViolation("Missing PE export range");
    return bytes;
  }
  function* cStringBytes(
    rva: number,
    maximum = MAXIMUM_NAME_BYTES,
  ): Generator<PeExportRead, Buffer, Buffer | undefined> {
    const value = yield {
      kind: "name",
      mapping: mappingIndex,
      address: base + BigInt(rva),
      maximum,
    };
    if (value === undefined) throw invariantViolation("Missing PE export name");
    if (value.length === 0)
      throw new BinaryFormatFailure(
        "malformed",
        `Export name at RVA ${hex(rva)} is empty`,
      );
    return value;
  }
  const headerOffset = map(directory.address, PE_EXPORT_DIRECTORY_BYTES);
  const headerReader = new BinaryReader(
    yield* readRange(headerOffset, PE_EXPORT_DIRECTORY_BYTES),
    true,
    "pe",
  );
  const timestamp = headerReader.u32(4);
  const dllNameRva = headerReader.u32(12);
  const ordinalBase = headerReader.u32(16);
  const functionCount = headerReader.u32(20);
  const nameCount = headerReader.u32(24);
  const functionsRva = headerReader.u32(28);
  const namesRva = headerReader.u32(32);
  const ordinalsRva = headerReader.u32(36);
  rowBudget(functionCount, "PE export address table");
  rowBudget(nameCount, "PE export name table");
  const functionsOffset =
    functionCount === 0 ? 0 : map(functionsRva, functionCount * 4);
  const namesOffset = nameCount === 0 ? 0 : map(namesRva, nameCount * 4);
  const ordinalsOffset = nameCount === 0 ? 0 : map(ordinalsRva, nameCount * 2);
  const functionsReader = new BinaryReader(
    functionCount === 0
      ? Buffer.alloc(0)
      : yield* readRange(functionsOffset, functionCount * 4),
    true,
    "pe",
  );
  const namesReader = new BinaryReader(
    nameCount === 0
      ? Buffer.alloc(0)
      : yield* readRange(namesOffset, nameCount * 4),
    true,
    "pe",
  );
  const ordinalsReader = new BinaryReader(
    nameCount === 0
      ? Buffer.alloc(0)
      : yield* readRange(ordinalsOffset, nameCount * 2),
    true,
    "pe",
  );
  const issues: NativeExportIssue[] = [];
  let dllName: string | null = null;
  try {
    dllName = (yield* cStringBytes(dllNameRva)).toString("latin1");
  } catch (cause) {
    issues.push({
      code: "name_unreadable",
      location: hex(dllNameRva),
      message: `Export directory DLL name: ${failureMessage(cause)}`,
    });
  }
  const retain = createRetention();
  const namesByFunction = new Map<number, string[]>();
  const namedFunctions = new Set<number>();
  for (let index = 0; index < nameCount; index++) {
    if (index % 1024 === 0) yield undefined;
    const functionIndex = ordinalsReader.u16(index * 2);
    const nameRva = namesReader.u32(index * 4);
    if (functionIndex >= functionCount) {
      issues.push({
        code: "malformed_entry",
        location: hex(nameRva),
        message: `Export name ${String(index)} selects address-table slot ${String(functionIndex)}, outside its ${String(functionCount)} slots`,
      });
      continue;
    }
    namedFunctions.add(functionIndex);
    try {
      const nameBytes = yield* cStringBytes(nameRva);
      if (functionsReader.u32(functionIndex * 4) === 0) continue;
      const name = nameBytes.toString("latin1");
      retain.text(name);
      const list = namesByFunction.get(functionIndex) ?? [];
      list.push(name);
      namesByFunction.set(functionIndex, list);
    } catch (cause) {
      issues.push({
        code: "name_unreadable",
        location: hex(nameRva),
        message: failureMessage(cause),
      });
    }
  }
  const forwarderEnd = directory.address + directory.size;
  const exports: PeExport[] = [];
  for (let index = 0; index < functionCount; index++) {
    if (index % 1024 === 0) yield undefined;
    const rva = functionsReader.u32(index * 4);
    if (rva === 0) continue;
    const ordinal = ordinalBase + index;
    let target: Pick<PeExport, "address" | "forwarder">;
    if (rva >= directory.address && rva < forwarderEnd) {
      try {
        target = {
          address: null,
          forwarder: (yield* cStringBytes(
            rva,
            Math.min(MAXIMUM_NAME_BYTES, forwarderEnd - rva - 1),
          )).toString("latin1"),
        };
      } catch (cause) {
        issues.push({
          code: "malformed_entry",
          location: hex(rva),
          message: `Forwarder of ordinal ${String(ordinal)}: ${failureMessage(cause)}`,
        });
        continue;
      }
    } else target = { address: hex(base + BigInt(rva)), forwarder: null };
    const exportNames = namesByFunction.get(index);
    if (exportNames !== undefined)
      for (const name of exportNames) {
        retain.row(target.forwarder);
        exports.push({ name, ordinal, rva, ...target });
      }
    else if (!namedFunctions.has(index)) {
      retain.row(target.forwarder);
      exports.push({ name: null, ordinal, rva, ...target });
    }
  }
  return {
    ...result,
    export_directory: {
      rva: directory.address,
      size: directory.size,
      dll_name: dllName,
      ordinal_base: ordinalBase,
      timestamp,
    },
    exports,
    coverage: coverage(issues, functionCount, exports.length),
    issues,
    limitations: PE_LIMITATIONS,
  };
}

function* parsePeExports(
  bytes: Buffer,
  artifact: Artifact,
): Generator<void, NativeExports> {
  const steps = parsePeExportSteps(readPeImage(bytes), artifact);
  let step = steps.next();
  while (!step.done) {
    const read = step.value;
    if (read === undefined) {
      yield;
      step = steps.next();
      continue;
    }
    let data: Buffer;
    try {
      data =
        read.kind === "range"
          ? bytes.subarray(read.offset, read.offset + read.length)
          : read.mapping.readCString(bytes, read.address, read.maximum);
    } catch (cause) {
      step = steps.throw(cause);
      continue;
    }
    step = steps.next(data);
  }
  return step.value;
}

const parsePeExportsFromHandle = async (
  source: ByteSource,
  artifact: Artifact,
  pause: ZstandardFramePause,
): Promise<NativeExports> => {
  const { readRange, readPrefix } = createSourceReaders(source);
  const image = await readPeImageFromReader({
    size: source.size,
    prefix: await readRange(0, Math.min(64, source.size)),
    readRange,
  });
  const steps = parsePeExportSteps(image, artifact);
  let step = steps.next();
  while (!step.done) {
    const read = step.value;
    if (read === undefined) {
      await pause();
      step = steps.next();
      continue;
    }
    let data: Buffer;
    try {
      data =
        read.kind === "range"
          ? await readRange(read.offset, read.length)
          : await read.mapping.readCStringFromReader(
              readPrefix,
              read.address,
              read.maximum,
            );
    } catch (cause) {
      if (!isBinaryFormatOrStringLimitFailure(cause)) throw cause;
      step = steps.throw(cause);
      continue;
    }
    step = steps.next(data);
  }
  return step.value;
};

type ElfRangeRead = {
  readonly offset: number;
  readonly length: number;
  readonly strings: boolean;
};

function* readVersionNamesSteps(
  fileSize: number,
  little: boolean,
  sections: readonly NativeSection[],
  issues: NativeExportIssue[],
): Generator<
  ElfRangeRead | undefined,
  Map<number, DecodedElfString | null>,
  Buffer
> {
  function* readData(
    section: NativeSection,
    label: string,
  ): Generator<
    ElfRangeRead,
    { readonly tableBytes: Buffer; readonly names: Buffer },
    Buffer
  > {
    if (section.compressed)
      throw new BinaryFormatFailure(
        "unsupported",
        `${label} are SHF_COMPRESSED and were not decompressed`,
      );
    const strings = sections[section.link];
    if (strings?.type !== SHT_STRTAB)
      throw new BinaryFormatFailure(
        "malformed",
        `${label} do not link to a string table`,
      );
    if (strings.compressed)
      throw new BinaryFormatFailure(
        "unsupported",
        `${label} strings are SHF_COMPRESSED and were not decompressed`,
      );
    const names = requireElfFileRange(
      fileSize,
      strings.offset,
      strings.size,
      `${label} strings`,
    );
    const table = requireElfFileRange(
      fileSize,
      section.offset,
      section.size,
      label,
    );
    return {
      tableBytes: yield {
        offset: table.offset,
        length: table.size,
        strings: false,
      },
      names: yield { offset: names.offset, length: names.size, strings: true },
    };
  }
  const namesByIndex = new Map<number, DecodedElfString | null>();
  const readName = createVersionNameReader();
  let textBytes = 0;
  const addName = (index: number, decoded: DecodedElfString | null): void => {
    const previous = namesByIndex.get(index);
    if (previous === decoded) return;
    const nextTextBytes =
      textBytes -
      retainedTextBytes(
        previous?.name ?? null,
        previous?.name_bytes_base64 ?? null,
      ) +
      retainedTextBytes(
        decoded?.name ?? null,
        decoded?.name_bytes_base64 ?? null,
      );
    checkRetainedText(nextTextBytes);
    namesByIndex.set(index, decoded);
    textBytes = nextTextBytes;
  };
  const clearNames = (): void => {
    namesByIndex.clear();
    textBytes = 0;
  };
  const installName = (
    index: number,
    strings: Buffer,
    offset: number,
    location: bigint,
    label: string,
  ): void => {
    let decoded: DecodedElfString | null;
    try {
      decoded = readName(strings, offset);
    } catch (cause) {
      if (!isBinaryFormatOrStringLimitFailure(cause)) throw cause;
      issues.push({
        code: "version_unresolved",
        location: hex(location),
        message: `${label}: ${cause.message}`,
      });
      decoded = null;
    }
    addName(index, decoded);
  };
  const byType = keyedBy(sections, ({ type }) => type);
  const verneed = versionSection(
    byType,
    SHT_GNU_VERNEED,
    "Version requirements",
    issues,
  );
  if (verneed !== undefined && verneed !== null && verneed.info !== 0) {
    try {
      const { tableBytes, names } = yield* readData(
        verneed,
        "Version requirements",
      );
      const reader = new BinaryReader(tableBytes, little, "elf");
      const visit = versionRecordStep(tableBytes.length, 16);
      let offset = 0;
      for (let record = 0; record < verneed.info; record++) {
        if (offset + 16 > tableBytes.length)
          throw new BinaryFormatFailure(
            "malformed",
            "Version requirement chain leaves its section",
          );
        if (visit()) yield undefined;
        const auxiliaryCount = reader.u16(offset + 2);
        const auxiliaryOffset = reader.u32(offset + 8);
        const next = reader.u32(offset + 12);
        if (auxiliaryCount > 0 && auxiliaryOffset < 16)
          throw new BinaryFormatFailure(
            "malformed",
            "Version requirement auxiliary chain starts inside its header",
          );
        let auxiliary = offset + auxiliaryOffset;
        for (let item = 0; item < auxiliaryCount; item++) {
          if (auxiliary + 16 > tableBytes.length)
            throw new BinaryFormatFailure(
              "malformed",
              "Version requirement auxiliary chain leaves its section",
            );
          if (visit()) yield undefined;
          const versionIndex = reader.u16(auxiliary + 6) & 0x7fff;
          const auxiliaryNext = reader.u32(auxiliary + 12);
          installName(
            versionIndex,
            names,
            reader.u32(auxiliary + 8),
            verneed.offset + BigInt(auxiliary),
            "Version requirement name",
          );
          if (item + 1 < auxiliaryCount) {
            if (auxiliaryNext < 16)
              throw new BinaryFormatFailure(
                "malformed",
                "Version requirement auxiliary chain ends before its declared count",
              );
            auxiliary += auxiliaryNext;
          }
        }
        if (record + 1 < verneed.info) {
          if (next < 16)
            throw new BinaryFormatFailure(
              "malformed",
              "Version requirement chain ends before its declared count",
            );
          offset += next;
        }
      }
    } catch (cause) {
      if (
        !(cause instanceof BinaryFormatFailure) &&
        !(cause instanceof ElfVersionWorkFailure)
      )
        throw cause;
      clearNames();
      issues.push({
        code: "version_unresolved",
        location: hex(verneed.offset),
        message: `Version requirements: ${cause instanceof ElfVersionWorkFailure ? cause.message : failureMessage(cause)}`,
      });
    }
  }
  const verdef = versionSection(
    byType,
    SHT_GNU_VERDEF,
    "Version definitions",
    issues,
  );
  if (verdef === null) clearNames();
  if (verdef !== undefined && verdef !== null && verdef.info !== 0) {
    try {
      const { tableBytes, names } = yield* readData(
        verdef,
        "Version definitions",
      );
      const reader = new BinaryReader(tableBytes, little, "elf");
      const visit = versionRecordStep(tableBytes.length, 8);
      let offset = 0;
      for (let index = 0; index < verdef.info; index++) {
        if (offset + 20 > tableBytes.length)
          throw new BinaryFormatFailure(
            "malformed",
            "Version definition chain leaves its section",
          );
        if (visit()) yield undefined;
        const versionIndex = reader.u16(offset + 4) & 0x7fff;
        const aux = reader.u32(offset + 12);
        const next = reader.u32(offset + 16);
        const auxiliaryCount = reader.u16(offset + 6);
        try {
          if (
            auxiliaryCount === 0 ||
            aux < 20 ||
            offset + aux + 8 > tableBytes.length
          ) {
            addName(versionIndex, null);
            throw new BinaryFormatFailure(
              "malformed",
              "Version definition name entry leaves its section",
            );
          }
          let auxiliary = offset + aux;
          installName(
            versionIndex,
            names,
            reader.u32(auxiliary),
            verdef.offset + BigInt(auxiliary),
            "Version definition name",
          );
          for (let item = 0; item < auxiliaryCount; item++) {
            if (auxiliary + 8 > tableBytes.length)
              throw new BinaryFormatFailure(
                "malformed",
                "Version definition auxiliary chain leaves its section",
              );
            if (visit()) yield undefined;
            if (item + 1 < auxiliaryCount) {
              const auxiliaryNext = reader.u32(auxiliary + 4);
              if (auxiliaryNext < 8)
                throw new BinaryFormatFailure(
                  "malformed",
                  "Version definition auxiliary chain ends before its declared count",
                );
              auxiliary += auxiliaryNext;
            }
          }
        } catch (cause) {
          if (!(cause instanceof BinaryFormatFailure)) throw cause;
          issues.push({
            code: "version_unresolved",
            location: hex(verdef.offset + BigInt(offset)),
            message: `Version definitions: ${cause.message}`,
          });
        }
        if (index + 1 < verdef.info) {
          if (next < 20)
            throw new BinaryFormatFailure(
              "malformed",
              "Version definition chain ends before its declared count",
            );
          offset += next;
        }
      }
    } catch (cause) {
      if (
        !(cause instanceof BinaryFormatFailure) &&
        !(cause instanceof ElfVersionWorkFailure)
      )
        throw cause;
      clearNames();
      issues.push({
        code: "version_unresolved",
        location: hex(verdef.offset),
        message: `Version definitions: ${cause instanceof ElfVersionWorkFailure ? cause.message : failureMessage(cause)}`,
      });
    }
  }
  return namesByIndex;
}

function* runBufferedElfReads<T>(
  steps: Generator<ElfRangeRead | undefined, T, Buffer>,
  bytes: Buffer,
): Generator<void, T> {
  const tables = new Map<string, Buffer>();
  let step = steps.next();
  while (!step.done) {
    const read = step.value;
    if (read === undefined) {
      yield;
      step = steps.next(Buffer.alloc(0));
      continue;
    }
    const key = `${String(read.offset)}:${String(read.length)}`;
    let data = read.strings ? tables.get(key) : undefined;
    if (data === undefined) {
      data = bytes.subarray(read.offset, read.offset + read.length);
      if (read.strings) tables.set(key, data);
    }
    step = steps.next(data);
  }
  return step.value;
}

const runPositionalElfReads = async <T>(
  steps: Generator<ElfRangeRead | undefined, T, Buffer>,
  readers: ReturnType<typeof createSourceReaders>,
  pause: ZstandardFramePause,
): Promise<T> => {
  let step = steps.next();
  while (!step.done) {
    const read = step.value;
    if (read === undefined) {
      await pause();
      step = steps.next(Buffer.alloc(0));
    } else {
      const load = read.strings ? readers.readStringTable : readers.readRange;
      step = steps.next(await load(read.offset, read.length));
    }
  }
  return step.value;
};

function* readElfSectionExportTableSteps(
  fileSize: number,
  directory: ReturnType<typeof readElfDirectoryFromBuffer>,
  dynsym: NativeSection,
  byType: Keyed<NativeSection, number>,
): Generator<ElfRangeRead, ElfExportTableSelection, Buffer> {
  const { sections } = directory;
  const width = elfSymbolSize(directory.bits);
  const strings = sections[dynsym.link];
  const compressed = dynsym.compressed
    ? dynsym
    : strings?.type === SHT_STRTAB && strings.compressed
      ? strings
      : null;
  if (compressed !== null) {
    const reason = `The ELF ${compressed === dynsym ? "dynamic symbol table" : "dynamic string table"} is SHF_COMPRESSED and was not decompressed; export identities remain unknown`;
    return {
      state: "unavailable",
      reason,
      issues: [
        {
          code: "table_unavailable",
          location: hex(compressed.offset),
          message: reason,
        },
      ],
    };
  }
  if (
    dynsym.entry_size !== BigInt(width) ||
    dynsym.size % BigInt(width) !== 0n ||
    dynsym.size < BigInt(width) ||
    strings?.type !== SHT_STRTAB
  )
    throw new BinaryFormatFailure(
      "malformed",
      "ELF dynamic symbol table entry size, length, null entry or string-table link is invalid",
    );
  const { offset: table, size } = requireElfFileRange(
    fileSize,
    dynsym.offset,
    dynsym.size,
    "ELF dynamic symbols",
  );
  const count = size / width;
  rowBudget(count, "ELF dynamic symbol table");
  const nameRange = requireElfFileRange(
    fileSize,
    strings.offset,
    strings.size,
    "ELF dynamic strings",
  );
  const tableBytes = yield { offset: table, length: size, strings: false };
  const names = yield {
    offset: nameRange.offset,
    length: nameRange.size,
    strings: true,
  };
  const issues: NativeExportIssue[] = [];
  const linkedVersym = allKeyed(byType, SHT_GNU_VERSYM).filter(
    ({ link }) => link === dynsym.index,
  );
  const versym = linkedVersym[0];
  let versionBytes: Buffer | null = null;
  if (versym !== undefined) {
    try {
      if (linkedVersym.length > 1)
        throw new BinaryFormatFailure(
          "malformed",
          `${String(linkedVersym.length)} symbol version tables link to the dynamic symbol table`,
        );
      if (versym.compressed)
        throw new BinaryFormatFailure(
          "unsupported",
          "ELF symbol versions are SHF_COMPRESSED and were not decompressed",
        );
      if (versym.size !== BigInt(count * 2))
        throw new BinaryFormatFailure(
          "malformed",
          `Symbol version table has ${String(versym.size)} bytes for ${String(count)} symbols`,
        );
      const versymRange = requireElfFileRange(
        fileSize,
        versym.offset,
        BigInt(count * 2),
        "ELF symbol versions",
      );
      versionBytes = yield {
        offset: versymRange.offset,
        length: count * 2,
        strings: false,
      };
    } catch (cause) {
      if (!(cause instanceof BinaryFormatFailure)) throw cause;
      issues.push({
        code: "version_unresolved",
        location: hex(versym.offset),
        message: failureMessage(cause),
      });
    }
  }
  return {
    state: "tables",
    tables: {
      table,
      tableBytes,
      count,
      names,
      versionBytes,
      versionsDeclared: versym !== undefined,
      issues,
    },
  };
}

const parseElfExportsFromHandle = async (
  source: ByteSource,
  artifact: Artifact,
  pause: ZstandardFramePause,
): Promise<Extract<NativeExports, { format: "elf" }>> => {
  const readers = createSourceReaders(source);
  const { readRange } = readers;
  const directory = await readElfDirectoryFromReader(source, pause, OPERATION);
  const plan = elfExportPlan(artifact, directory);
  if (plan.state === "empty") return plan.result;
  const { result, byType, dynsym } = plan;
  const { sections } = directory;
  const selection =
    dynsym === undefined
      ? await readElfDynamicExportTablesFromReader(
          readRange,
          source.size,
          directory,
          pause,
        )
      : await runPositionalElfReads(
          readElfSectionExportTableSteps(
            source.size,
            directory,
            dynsym,
            byType,
          ),
          readers,
          pause,
        );
  if (selection.state === "unavailable")
    return unavailableElfExports(result, selection);
  const versionNames =
    dynsym === undefined
      ? new Map<number, DecodedElfString | null>()
      : await runPositionalElfReads(
          readVersionNamesSteps(
            source.size,
            directory.little,
            sections,
            selection.tables.issues,
          ),
          readers,
          pause,
        );
  const steps = projectElfExports(
    result,
    directory.little,
    selection.tables,
    versionNames,
    dynsym === undefined,
  );
  let step = steps.next();
  while (!step.done) {
    await pause();
    step = steps.next();
  }
  return step.value;
};

/** Same PE/ELF export inspection over a random-access handle without buffering the full image. */
export const parseNativeExportsFromHandle = async (
  source: ByteSource,
  artifact: Artifact,
  pause: ZstandardFramePause,
): Promise<NativeExports> => {
  await pause();
  const magic =
    source.prefix !== undefined && source.prefix.length >= 4
      ? source.prefix.subarray(0, 4)
      : await source.readRange(0, Math.min(4, source.size));
  if (hasElfMagic(magic))
    return parseElfExportsFromHandle(source, artifact, pause);
  if (magic.length >= 2 && magic[0] === 0x4d && magic[1] === 0x5a)
    return parsePeExportsFromHandle(source, artifact, pause);
  throw new BinaryFormatFailure(
    "unsupported",
    "Only PE and ELF images are supported; inspect Mach-O exports with inspect_macho",
  );
};
