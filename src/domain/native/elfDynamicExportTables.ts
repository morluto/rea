import { readElfDynamicEntry } from "../elfDynamicEntry.js";
import { elfSymbolSize } from "../elfSymbol.js";
import {
  readElfGnuHashSymbolCount,
  readElfHashSymbolCount,
  type ElfHashCountFailure,
  type ElfHashWordReader,
} from "../elfHashSymbolCount.js";
import {
  MAX_NATIVE_EXPORT_ROWS,
  type NativeExportIssue,
} from "./nativeExports.js";
import { err, ok, type Result } from "../result.js";
import {
  BinaryFormatFailure,
  BinaryReader,
  BinaryResourceFailure,
  createFileMappingIndex,
  type ElfDynamicSegment,
  type FileMappingIndex,
} from "../binaryContainer.js";
import {
  readElfImageFromDirectory,
  readElfImageFromDirectorySize,
} from "./elfImage.js";
import type { ZstandardFramePause } from "../compression/zstandardExactFrame.js";
import type {
  ElfProgramDeclaration,
  readElfDirectoryFromBuffer,
} from "./nativeSectionDirectory.js";

const DT_NULL = 0n;
const DT_HASH = 4n;
const DT_STRTAB = 5n;
const DT_SYMTAB = 6n;
const DT_STRSZ = 10n;
const DT_SYMENT = 11n;
const DT_GNU_HASH = 0x6ffffef5n;
const DT_VERSYM = 0x6ffffff0n;
const SELECTED_TAGS = new Set([
  DT_HASH,
  DT_STRTAB,
  DT_SYMTAB,
  DT_STRSZ,
  DT_SYMENT,
  DT_GNU_HASH,
  DT_VERSYM,
]);

/** One admitted symbol inventory, independent of section or dynamic declarations. */
export interface ElfExportTables {
  readonly table: number;
  readonly tableBytes?: Buffer;
  readonly count: number;
  readonly names: Buffer;
  readonly versions: number | null;
  readonly versionBytes?: Buffer | null;
  readonly versionsDeclared: boolean;
  readonly issues: NativeExportIssue[];
}

/** Table admission reports unavailable facts before the shared export projection. */
export type ElfExportTableSelection =
  | { readonly state: "tables"; readonly tables: ElfExportTables }
  | {
      readonly state: "unavailable";
      readonly reason: string;
      readonly issues: NativeExportIssue[];
    };

const malformed = (message: string): never => {
  throw new BinaryFormatFailure("malformed", message);
};

const exact = (value: bigint, label: string): number => {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    malformed(`${label} exceeds exact host precision`);
  return Number(value);
};

const overBudget = (label: string, count: number): never => {
  throw new BinaryResourceFailure(
    "structure",
    MAX_NATIVE_EXPORT_ROWS,
    `${label} declares ${String(count)} entries, above the ${String(MAX_NATIVE_EXPORT_ROWS)}-entry export inventory allowance`,
    "rows",
  );
};

const admitCount = (
  result: Result<number | null, ElfHashCountFailure>,
): number | null => {
  if (result.ok) return result.value;
  if (result.error.kind === "malformed") return malformed(result.error.message);
  return overBudget(result.error.label, result.error.count);
};

/** Admit singular declarations through DT_NULL without interpreting unknown tags. */
function* readDynamicEntries(
  reader: BinaryReader,
  bits: 32 | 64,
  program: ElfDynamicSegment,
): Generator<void, ReadonlyMap<bigint, bigint>> {
  const dynamicWidth = bits === 64 ? 16 : 8;
  if (program.size % BigInt(dynamicWidth) !== 0n)
    malformed("ELF PT_DYNAMIC size is not a whole number of entries");
  const dynamicCount = exact(
    program.size / BigInt(dynamicWidth),
    "PT_DYNAMIC count",
  );
  if (dynamicCount > MAX_NATIVE_EXPORT_ROWS)
    overBudget("ELF dynamic table", dynamicCount);
  const dynamicAt = reader.table(
    program.offset,
    dynamicCount,
    dynamicWidth,
    "ELF dynamic table",
  );
  const entries = new Map<bigint, bigint>();
  let terminated = false;
  for (let index = 0; index < dynamicCount; index++) {
    if (index % 1024 === 0) yield;
    const at = dynamicAt + index * dynamicWidth;
    const parsed = readElfDynamicEntry(
      reader.bytes.subarray(at, at + dynamicWidth),
      bits,
      reader.little,
    );
    if (!parsed.ok) return malformed(parsed.error.message);
    const { tag, value } = parsed.value;
    if (tag === DT_NULL) {
      terminated = true;
      break;
    }
    if (!SELECTED_TAGS.has(tag)) continue;
    if (entries.has(tag))
      malformed(`ELF dynamic tag ${tag.toString()} is duplicated`);
    entries.set(tag, value);
  }
  if (!terminated) malformed("ELF dynamic table has no DT_NULL terminator");
  return entries;
}

/** Both hash formats use the same complete-range mapping and count allowance. */
function* readDynamicSymbolCount(
  reader: BinaryReader,
  mapping: FileMappingIndex,
  entries: ReadonlyMap<bigint, bigint>,
  bits: 32 | 64,
): Generator<void, number | null> {
  const hashWords =
    (address: bigint): ElfHashWordReader =>
    (relative) => {
      try {
        // Hash walkers jump over bloom filters and buckets. Admit that entire
        // prefix, so a readable last word cannot hide a gap or conflicting load.
        const at = mapping.offset(address, relative + 4);
        return ok(reader.u32(at + relative));
      } catch (cause) {
        if (cause instanceof BinaryFormatFailure) return err(cause.message);
        throw cause;
      }
    };
  const hash = entries.get(DT_HASH);
  const gnu = entries.get(DT_GNU_HASH);
  const classicCount =
    hash === undefined
      ? null
      : admitCount(
          readElfHashSymbolCount(hashWords(hash), MAX_NATIVE_EXPORT_ROWS),
        );
  const gnuCount =
    gnu === undefined
      ? null
      : admitCount(
          yield* readElfGnuHashSymbolCount(
            hashWords(gnu),
            bits === 64 ? 8 : 4,
            MAX_NATIVE_EXPORT_ROWS,
          ),
        );
  if (classicCount !== null && gnuCount !== null && classicCount !== gnuCount)
    malformed("ELF DT_HASH and DT_GNU_HASH report different symbol counts");
  return classicCount ?? gnuCount;
}

/** Locate sectionless symbols through bounded, unambiguous PT_LOAD mappings. */
export function* readElfDynamicExportTables(
  bytes: Buffer,
  directory: ReturnType<typeof readElfDirectoryFromBuffer>,
): Generator<void, ElfExportTableSelection> {
  const programs = directory.programs.filter(
    (program): program is Extract<ElfProgramDeclaration, { type: 2 }> =>
      program.type === 2,
  );
  if (programs.length > 1)
    malformed("ELF image has more than one PT_DYNAMIC segment");
  const program = programs[0];
  if (program === undefined || program.size === 0n)
    return {
      state: "unavailable",
      reason:
        "No readable dynamic segment establishes a dynamic symbol table or its symbol count",
      issues: [],
    };
  const reader = new BinaryReader(bytes, directory.little, "elf");
  const entries = yield* readDynamicEntries(reader, directory.bits, program);
  const symbols = entries.get(DT_SYMTAB);
  if (symbols === undefined)
    return {
      state: "unavailable",
      reason:
        "The dynamic segment does not declare DT_SYMTAB, so its export inventory is unavailable",
      issues: [],
    };
  const width = elfSymbolSize(directory.bits);
  if (entries.get(DT_SYMENT) !== BigInt(width))
    malformed(
      "ELF DT_SYMENT is missing or does not match its class symbol width",
    );
  const strings = entries.get(DT_STRTAB);
  const stringBytes = entries.get(DT_STRSZ);
  if (strings === undefined || stringBytes === undefined)
    return malformed("ELF DT_SYMTAB is present without DT_STRTAB and DT_STRSZ");
  const image = readElfImageFromDirectory(bytes, directory);
  const mapping = createFileMappingIndex(image.mappings, image.zero_fills);
  const count = yield* readDynamicSymbolCount(
    reader,
    mapping,
    entries,
    directory.bits,
  );
  if (count === null)
    return {
      state: "unavailable",
      reason:
        "The dynamic segment has no hash table establishing the complete symbol count; empty GNU buckets do not establish an empty inventory",
      issues: [],
    };
  if (count === 0)
    malformed("ELF dynamic symbol table is missing its null entry");
  const table = mapping.offset(symbols, count * width);
  reader.table(BigInt(table), count, width, "ELF dynamic symbols");
  const nameBytes = exact(stringBytes, "DT_STRSZ");
  const namesAt = mapping.offset(strings, nameBytes);
  const names = reader.range(namesAt, nameBytes, "ELF dynamic strings");
  const issues: NativeExportIssue[] = [];
  const versionAddress = entries.get(DT_VERSYM);
  let versions: number | null = null;
  if (versionAddress !== undefined) {
    try {
      versions = mapping.offset(versionAddress, count * 2);
      reader.table(BigInt(versions), count, 2, "ELF symbol versions");
    } catch (cause) {
      if (!(cause instanceof BinaryFormatFailure)) throw cause;
      versions = null;
      issues.push({
        code: "version_unresolved",
        location: `0x${versionAddress.toString(16)}`,
        message: cause.message,
      });
    }
  }
  return {
    state: "tables",
    tables: {
      table,
      count,
      names,
      versions,
      versionsDeclared: versionAddress !== undefined,
      issues,
    },
  };
}

const requireRangeWithin = (
  fileSize: number,
  offset: bigint,
  count: number,
  width: number,
  label: string,
): number => {
  const bytes = BigInt(count) * BigInt(width);
  if (offset < 0n || offset > BigInt(fileSize))
    throw new BinaryFormatFailure(
      "malformed",
      `${label} range is outside the file`,
      {
        format: "elf",
        field: label,
      },
    );
  if (bytes > BigInt(fileSize) - offset)
    throw new BinaryFormatFailure(
      "truncated",
      `${label} range is outside the file`,
      {
        format: "elf",
        field: label,
        offset: Number(offset),
      },
    );
  return Number(offset);
};

/** Locate sectionless symbols over a random-access range reader without buffering the full image. */
export const readElfDynamicExportTablesFromReader = async (
  readRange: (offset: number, length: number) => Promise<Buffer>,
  fileSize: number,
  directory: ReturnType<typeof readElfDirectoryFromBuffer>,
  pause: ZstandardFramePause,
): Promise<ElfExportTableSelection> => {
  const programs = directory.programs.filter(
    (program): program is Extract<ElfProgramDeclaration, { type: 2 }> =>
      program.type === 2,
  );
  if (programs.length > 1)
    malformed("ELF image has more than one PT_DYNAMIC segment");
  const program = programs[0];
  if (program === undefined || program.size === 0n)
    return {
      state: "unavailable",
      reason:
        "No readable dynamic segment establishes a dynamic symbol table or its symbol count",
      issues: [],
    };
  const dynamicWidth = directory.bits === 64 ? 16 : 8;
  if (program.size % BigInt(dynamicWidth) !== 0n)
    malformed("ELF PT_DYNAMIC size is not a whole number of entries");
  const dynamicCount = exact(
    program.size / BigInt(dynamicWidth),
    "PT_DYNAMIC count",
  );
  if (dynamicCount > MAX_NATIVE_EXPORT_ROWS)
    overBudget("ELF dynamic table", dynamicCount);
  const dynamicAt = requireRangeWithin(
    fileSize,
    program.offset,
    dynamicCount,
    dynamicWidth,
    "ELF dynamic table",
  );
  const dynamicBytes = await readRange(dynamicAt, dynamicCount * dynamicWidth);
  const entries = new Map<bigint, bigint>();
  let terminated = false;
  for (let index = 0; index < dynamicCount; index++) {
    if (index % 1024 === 0) await pause();
    const at = index * dynamicWidth;
    const parsed = readElfDynamicEntry(
      dynamicBytes.subarray(at, at + dynamicWidth),
      directory.bits,
      directory.little,
    );
    if (!parsed.ok) return malformed(parsed.error.message);
    const { tag, value } = parsed.value;
    if (tag === DT_NULL) {
      terminated = true;
      break;
    }
    if (!SELECTED_TAGS.has(tag)) continue;
    if (entries.has(tag))
      malformed(`ELF dynamic tag ${tag.toString()} is duplicated`);
    entries.set(tag, value);
  }
  if (!terminated) malformed("ELF dynamic table has no DT_NULL terminator");
  const symbols = entries.get(DT_SYMTAB);
  if (symbols === undefined)
    return {
      state: "unavailable",
      reason:
        "The dynamic segment does not declare DT_SYMTAB, so its export inventory is unavailable",
      issues: [],
    };
  const width = elfSymbolSize(directory.bits);
  if (entries.get(DT_SYMENT) !== BigInt(width))
    malformed(
      "ELF DT_SYMENT is missing or does not match its class symbol width",
    );
  const strings = entries.get(DT_STRTAB);
  const stringBytes = entries.get(DT_STRSZ);
  if (strings === undefined || stringBytes === undefined)
    return malformed("ELF DT_SYMTAB is present without DT_STRTAB and DT_STRSZ");
  const image = readElfImageFromDirectorySize(fileSize, directory);
  const mapping = createFileMappingIndex(image.mappings, image.zero_fills);
  const hash = entries.get(DT_HASH);
  const gnu = entries.get(DT_GNU_HASH);
  let classicCount: number | null = null;
  if (hash !== undefined) {
    let headerBuf: Buffer = Buffer.alloc(0);
    let headerAt = -1;
    try {
      headerAt = mapping.offset(hash, 8);
      headerBuf = await readRange(headerAt, 8);
    } catch {
      headerAt = -1;
    }
    const headerReader = new BinaryReader(headerBuf, directory.little, "elf");
    const readHashWord: ElfHashWordReader = (relative) => {
      try {
        mapping.offset(hash, relative + 4);
        if (headerAt >= 0 && relative >= 0 && relative + 4 <= headerBuf.length)
          return ok(headerReader.u32(relative));
        return ok(0);
      } catch (cause) {
        if (cause instanceof BinaryFormatFailure) return err(cause.message);
        throw cause;
      }
    };
    classicCount = admitCount(
      readElfHashSymbolCount(readHashWord, MAX_NATIVE_EXPORT_ROWS),
    );
  }
  let gnuCount: number | null = null;
  if (gnu !== undefined) {
    const wordBytes = directory.bits === 64 ? 8 : 4;
    let headerBuf: Buffer = Buffer.alloc(0);
    let headerAt = -1;
    try {
      headerAt = mapping.offset(gnu, 16);
      headerBuf = await readRange(headerAt, 16);
    } catch {
      headerAt = -1;
    }
    const headerReader = new BinaryReader(headerBuf, directory.little, "elf");
    let tailStart = 0;
    let tailBuf: Buffer = Buffer.alloc(0);
    let tailReader = new BinaryReader(tailBuf, directory.little, "elf");
    if (headerAt >= 0 && headerBuf.length >= 16) {
      const buckets = headerReader.u32(0);
      const bloomWords = headerReader.u32(8);
      if (
        buckets > 0 &&
        buckets <= MAX_NATIVE_EXPORT_ROWS &&
        bloomWords > 0 &&
        bloomWords <= MAX_NATIVE_EXPORT_ROWS
      ) {
        tailStart = 16 + bloomWords * wordBytes;
        const maxTail = (buckets + MAX_NATIVE_EXPORT_ROWS) * 4;
        // Probe how much of the tail is contiguously mapped without reading the bloom filter.
        const available = Math.min(
          maxTail,
          Math.max(0, fileSize - (headerAt + tailStart)),
        );
        if (available > 0) {
          tailBuf = await readRange(headerAt + tailStart, available);
          tailReader = new BinaryReader(tailBuf, directory.little, "elf");
        }
      }
    }
    const readGnuWord: ElfHashWordReader = (relative) => {
      try {
        const at = mapping.offset(gnu, relative + 4);
        if (
          relative >= 0 &&
          relative + 4 <= headerBuf.length &&
          at === headerAt
        )
          return ok(headerReader.u32(relative));
        const local = relative - tailStart;
        if (
          headerAt >= 0 &&
          at === headerAt &&
          local >= 0 &&
          local + 4 <= tailBuf.length
        )
          return ok(tailReader.u32(local));
        return err("extends outside the file");
      } catch (cause) {
        if (cause instanceof BinaryFormatFailure) return err(cause.message);
        throw cause;
      }
    };
    const walk = readElfGnuHashSymbolCount(
      readGnuWord,
      wordBytes,
      MAX_NATIVE_EXPORT_ROWS,
    );
    let step = walk.next();
    while (!step.done) {
      await pause();
      step = walk.next();
    }
    gnuCount = admitCount(step.value);
  }
  if (classicCount !== null && gnuCount !== null && classicCount !== gnuCount)
    malformed("ELF DT_HASH and DT_GNU_HASH report different symbol counts");
  const count = classicCount ?? gnuCount;
  if (count === null)
    return {
      state: "unavailable",
      reason:
        "The dynamic segment has no hash table establishing the complete symbol count; empty GNU buckets do not establish an empty inventory",
      issues: [],
    };
  if (count === 0)
    malformed("ELF dynamic symbol table is missing its null entry");
  const table = mapping.offset(symbols, count * width);
  requireRangeWithin(
    fileSize,
    BigInt(table),
    count,
    width,
    "ELF dynamic symbols",
  );
  const tableBytes = await readRange(table, count * width);
  const nameBytes = exact(stringBytes, "DT_STRSZ");
  const namesAt = mapping.offset(strings, nameBytes);
  requireRangeWithin(
    fileSize,
    BigInt(namesAt),
    nameBytes,
    1,
    "ELF dynamic strings",
  );
  const names = await readRange(namesAt, nameBytes);
  const issues: NativeExportIssue[] = [];
  const versionAddress = entries.get(DT_VERSYM);
  let versions: number | null = null;
  let versionBytes: Buffer | null = null;
  if (versionAddress !== undefined) {
    try {
      versions = mapping.offset(versionAddress, count * 2);
      requireRangeWithin(
        fileSize,
        BigInt(versions),
        count,
        2,
        "ELF symbol versions",
      );
      versionBytes = await readRange(versions, count * 2);
    } catch (cause) {
      if (!(cause instanceof BinaryFormatFailure)) throw cause;
      versions = null;
      versionBytes = null;
      issues.push({
        code: "version_unresolved",
        location: `0x${versionAddress.toString(16)}`,
        message: cause.message,
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
      versions,
      versionBytes,
      versionsDeclared: versionAddress !== undefined,
      issues,
    },
  };
};
