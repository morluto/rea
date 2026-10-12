import { Buffer } from "node:buffer";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  SNAPSHOT_HASH_LENGTH,
  SNAPSHOT_HASH_OFFSET,
  SNAPSHOT_HASH_PATTERN,
} from "./FlutterPayloadScan.js";

/** Bounds-checked little-endian reader over one loaded buffer. */
class BoundedReader {
  constructor(private readonly bytes: Buffer) {}

  u8(offset: number): number | null {
    return offset < this.bytes.length ? this.bytes.readUInt8(offset) : null;
  }

  u16(offset: number): number | null {
    return offset + 2 <= this.bytes.length
      ? this.bytes.readUInt16LE(offset)
      : null;
  }

  u32(offset: number): number | null {
    return offset + 4 <= this.bytes.length
      ? this.bytes.readUInt32LE(offset)
      : null;
  }

  u64(offset: number): number | null {
    const low = this.u32(offset);
    const high = this.u32(offset + 4);
    if (low === null || high === null || high > 0x001fffff) return null;
    return high * 0x1_0000_0000 + low;
  }

  cString(offset: number, tableEnd: number): string | null {
    if (offset < 0 || offset >= tableEnd || tableEnd > this.bytes.length)
      return null;
    const end = this.bytes
      .subarray(offset, Math.min(tableEnd, offset + 257))
      .indexOf(0);
    return end < 0
      ? null
      : this.bytes.subarray(offset, offset + end).toString("latin1");
  }
}

export interface ElfSymbol {
  readonly name: string;
  /** File offset mapped from the virtual address through PT_LOAD. */
  readonly offset: number;
  readonly size: number;
}

export interface ElfParseFailure {
  readonly reason: string;
}

const SHT_DYNSYM = 11;
const PT_LOAD = 1;
const PT_DYNAMIC = 2;
/** Position-independent executable images carry PT_DYNAMIC. */
const ET_DYN = 3;
const DT_NULL = 0;
const DT_STRTAB = 5;
const DT_SYMTAB = 6;
const DT_STRSZ = 10;
const DT_SYMENT = 11;

/** ELF32 needs 52 bytes, ELF64 needs 64; retain at most this prefix. */
export const ELF_HEADER_MAX_BYTES = 64;

/**
 * Decode the supported ELF header and validate its table extents against
 * the complete image size. The buffer may contain only the header prefix;
 * this does not validate table contents or symbol availability.
 */
export const readElfHeader = (
  bytes: Buffer,
  totalBytes: number = bytes.length,
) => {
  const reader = new BoundedReader(bytes);
  const magic = reader.u32(0);
  if (magic !== 0x464c457f) return { failure: { reason: "not an ELF image" } };
  const elfClass = reader.u8(4);
  if (elfClass !== 1 && elfClass !== 2)
    return { failure: { reason: `unsupported ELF class ${String(elfClass)}` } };
  const is64 = elfClass === 2;
  const headerBytes = is64 ? ELF_HEADER_MAX_BYTES : 52;
  if (
    bytes.length < headerBytes ||
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < headerBytes
  )
    return { failure: { reason: "ELF header is truncated" } };
  if (reader.u8(5) !== 1)
    return { failure: { reason: "unsupported ELF byte order" } };
  if (reader.u8(6) !== 1 || reader.u32(0x14) !== 1)
    return { failure: { reason: "unsupported ELF version" } };
  if (reader.u16(is64 ? 0x34 : 0x28) !== headerBytes)
    return { failure: { reason: "unsupported ELF header size" } };
  const e_type = reader.u16(0x10);
  if (e_type !== 1 && e_type !== 2 && e_type !== ET_DYN)
    return { failure: { reason: "unsupported ELF type" } };
  const e_shoff = is64 ? reader.u64(0x28) : reader.u32(0x20);
  const e_shentsize = reader.u16(is64 ? 0x3a : 0x2e);
  const e_shnum = reader.u16(is64 ? 0x3c : 0x30);
  const e_phoff = is64 ? reader.u64(0x20) : reader.u32(0x1c);
  const e_phentsize = reader.u16(is64 ? 0x36 : 0x2a);
  const e_phnum = reader.u16(is64 ? 0x38 : 0x2c);
  const tableFits = (
    offset: number | null,
    width: number | null,
    count: number | null,
    minimumWidth: number,
  ): boolean =>
    offset !== null &&
    width !== null &&
    count !== null &&
    offset >= headerBytes &&
    offset <= totalBytes &&
    width >= minimumWidth &&
    count > 0 &&
    count <= Math.floor((totalBytes - offset) / width);
  const MIN_SHENT = is64 ? 64 : 40;
  // Section-stripped ET_DYN images keep their exported symbols reachable
  // through PT_DYNAMIC instead of section headers; every other shape still
  // needs a usable section header table.
  // A nonzero shoff with shnum=0 uses extended numbering, which this
  // parser does not support; it must not masquerade as a stripped image.
  const dynamicFallback = e_type === ET_DYN && e_shoff === 0 && e_shnum === 0;
  if (
    e_shoff === null ||
    e_shentsize === null ||
    e_shnum === null ||
    (!dynamicFallback && !tableFits(e_shoff, e_shentsize, e_shnum, MIN_SHENT))
  )
    return {
      failure: {
        reason: "ELF section header table is missing or out of bounds",
      },
    };
  const MIN_PHENT = is64 ? 56 : 32;
  if (
    e_phoff === null ||
    e_phentsize === null ||
    e_phnum === null ||
    e_phnum === 0xffff ||
    !tableFits(e_phoff, e_phentsize, e_phnum, MIN_PHENT)
  )
    return {
      failure: {
        reason: "ELF program header table is missing or out of bounds",
      },
    };

  return {
    header: {
      is64,
      dynamicFallback,
      e_shoff,
      e_shentsize,
      e_shnum,
      e_phoff,
      e_phentsize,
      e_phnum,
    },
  };
};

export interface ElfSymbolInventory {
  readonly symbols: readonly ElfSymbol[];
  readonly failures: readonly ElfParseFailure[];
}

/** Decode the ELF tables once and resolve only the requested definitions. */
export const readElfSymbols = async (
  bytes: Buffer,
  symbolNames: readonly string[],
  signal?: AbortSignal,
): Promise<ElfSymbolInventory> => {
  signal?.throwIfAborted();
  const failure = (reason: string): ElfSymbolInventory => ({
    symbols: [],
    failures: [{ reason }],
  });
  const parsed = readElfHeader(bytes);
  if (parsed.failure !== undefined) return failure(parsed.failure.reason);
  const {
    is64,
    dynamicFallback,
    e_shoff,
    e_shentsize,
    e_shnum,
    e_phoff,
    e_phentsize,
    e_phnum,
  } = parsed.header;
  const reader = new BoundedReader(bytes);
  const entrySize = is64 ? 24 : 16;
  const segments: { vaddr: number; offset: number; filesz: number }[] = [];
  let dynamicSegment: { offset: number; filesz: number } | null = null;
  for (let index = 0; index < e_phnum; index += 1) {
    if (index % 4096 === 0) {
      await yieldToEventLoop();
      signal?.throwIfAborted();
    }
    const base = e_phoff + index * e_phentsize;
    const type = reader.u32(base);
    if (type !== PT_LOAD && type !== PT_DYNAMIC) continue;
    const vaddr = is64 ? reader.u64(base + 0x10) : reader.u32(base + 8);
    const offset = is64 ? reader.u64(base + 8) : reader.u32(base + 4);
    const filesz = is64 ? reader.u64(base + 0x20) : reader.u32(base + 0x10);
    if (
      vaddr === null ||
      offset === null ||
      filesz === null ||
      offset > bytes.length ||
      filesz > bytes.length - offset
    )
      return failure(`ELF segment ${String(index)} is not file-backed`);
    if (type === PT_LOAD) segments.push({ vaddr, offset, filesz });
    else if (dynamicSegment !== null)
      return failure("Multiple PT_DYNAMIC segments are ambiguous");
    else dynamicSegment = { offset, filesz };
  }
  const toOffset = (vaddr: number, size: number): number | null => {
    const segment = segments.find(
      (candidate) =>
        vaddr >= candidate.vaddr &&
        vaddr - candidate.vaddr <= candidate.filesz &&
        size <= candidate.filesz - (vaddr - candidate.vaddr),
    );
    return segment === undefined
      ? null
      : segment.offset + vaddr - segment.vaddr;
  };
  if (segments.length === 0)
    return failure("ELF image has no PT_LOAD segments");
  const tables: {
    offset: number;
    count: number;
    stringOffset: number;
    stringSize: number;
  }[] = [];
  if (!dynamicFallback) {
    for (let index = 0; index < e_shnum; index += 1) {
      if (index % 4096 === 0) {
        await yieldToEventLoop();
        signal?.throwIfAborted();
      }
      const header = e_shoff + index * e_shentsize;
      if (reader.u32(header + 4) !== SHT_DYNSYM) continue;
      const offset = is64
        ? reader.u64(header + 0x18)
        : reader.u32(header + 0x10);
      const size = is64 ? reader.u64(header + 0x20) : reader.u32(header + 0x14);
      const width = is64
        ? reader.u64(header + 0x38)
        : reader.u32(header + 0x24);
      const link = reader.u32(header + (is64 ? 0x28 : 0x18));
      if (
        offset === null ||
        size === null ||
        width !== entrySize ||
        offset > bytes.length ||
        size > bytes.length - offset ||
        size % entrySize !== 0
      )
        return failure("Dynamic symbol table is malformed");
      if (link === null || link >= e_shnum)
        return failure("Dynamic symbol string section link is invalid");
      const stringHeader = e_shoff + link * e_shentsize;
      const stringOffset = is64
        ? reader.u64(stringHeader + 0x18)
        : reader.u32(stringHeader + 0x10);
      const stringSize = is64
        ? reader.u64(stringHeader + 0x20)
        : reader.u32(stringHeader + 0x14);
      if (
        reader.u32(stringHeader + 4) !== 3 ||
        stringOffset === null ||
        stringSize === null ||
        stringOffset > bytes.length ||
        stringSize > bytes.length - stringOffset
      )
        return failure(
          "Dynamic symbol strings are out of bounds or not a string table",
        );
      tables.push({
        offset,
        count: size / entrySize,
        stringOffset,
        stringSize,
      });
    }
  } else if (dynamicSegment !== null) {
    const tags = new Map<number, number>();
    const dynamicEntrySize = is64 ? 16 : 8;
    let terminated = false;
    for (
      let base = dynamicSegment.offset;
      base + dynamicEntrySize <= dynamicSegment.offset + dynamicSegment.filesz;
      base += dynamicEntrySize
    ) {
      if ((base - dynamicSegment.offset) % (4096 * dynamicEntrySize) === 0) {
        await yieldToEventLoop();
        signal?.throwIfAborted();
      }
      const tag = is64 ? reader.u64(base) : reader.u32(base);
      const value = is64 ? reader.u64(base + 8) : reader.u32(base + 4);
      if (tag === null || value === null)
        return failure("Dynamic entry is not representable");
      if (tag === DT_NULL) {
        terminated = true;
        break;
      }
      if (
        ![DT_SYMTAB, DT_STRTAB, DT_STRSZ, DT_SYMENT, 4, 0x6ffffef5].includes(
          tag,
        )
      )
        continue;
      if (tags.has(tag) && tags.get(tag) !== value)
        return failure("Conflicting dynamic table tags");
      tags.set(tag, value);
    }
    const sym = tags.get(DT_SYMTAB);
    const str = tags.get(DT_STRTAB);
    const stringSize = tags.get(DT_STRSZ);
    if (
      !terminated ||
      sym === undefined ||
      str === undefined ||
      stringSize === undefined ||
      tags.get(DT_SYMENT) !== entrySize
    )
      return failure(
        "Stripped ELF lacks a complete dynamic symbol-table description",
      );
    // DT_HASH's nchain is the dynsym count. GNU hash instead records the
    // first hashed index and bounded buckets/chains. No payload-to-EOF walk.
    let count: number;
    const sysv = tags.get(4);
    const gnu = tags.get(0x6ffffef5);
    if (sysv !== undefined) {
      const at = toOffset(sysv, 8);
      if (at === null) return failure("DT_HASH header is not file-backed");
      const buckets = reader.u32(at)!;
      count = reader.u32(at + 4)!;
      if (toOffset(sysv, 8 + 4 * (buckets + count)) === null)
        return failure("DT_HASH table is truncated");
    } else if (gnu !== undefined) {
      const at = toOffset(gnu, 16);
      if (at === null) return failure("DT_GNU_HASH header is not file-backed");
      const buckets = reader.u32(at)!;
      const firstSymbol = reader.u32(at + 4)!;
      const bloomWords = reader.u32(at + 8)!;
      const prefixBytes = 16 + bloomWords * (is64 ? 8 : 4) + buckets * 4;
      if (
        buckets === 0 ||
        bloomWords === 0 ||
        toOffset(gnu, prefixBytes) === null
      )
        return failure("DT_GNU_HASH buckets are malformed");
      let last = 0;
      const bucketsAt = at + 16 + bloomWords * (is64 ? 8 : 4);
      for (let index = 0; index < buckets; index += 1) {
        if (index % 4096 === 0) {
          await yieldToEventLoop();
          signal?.throwIfAborted();
        }
        const value = reader.u32(bucketsAt + index * 4)!;
        if (value !== 0 && value < firstSymbol)
          return failure("DT_GNU_HASH bucket precedes its first symbol");
        last = Math.max(last, value);
      }
      count = firstSymbol;
      if (last !== 0) {
        let index = last;
        while (true) {
          if ((index - last) % 4096 === 0) {
            await yieldToEventLoop();
            signal?.throwIfAborted();
          }
          const span = prefixBytes + (index - firstSymbol + 1) * 4;
          if (toOffset(gnu, span) === null)
            return failure("DT_GNU_HASH chain is unterminated");
          const chain = reader.u32(at + span - 4)!;
          index += 1;
          if ((chain & 1) !== 0) {
            count = index;
            break;
          }
        }
      }
    } else
      return failure("Stripped ELF has no DT_HASH or DT_GNU_HASH symbol count");
    const offset = toOffset(sym, count * entrySize);
    const stringOffset = toOffset(str, stringSize);
    if (offset === null || stringOffset === null)
      return failure("Dynamic symbol or string table is not file-backed");
    tables.push({ offset, count, stringOffset, stringSize });
  }
  const wanted = new Set(symbolNames);
  const symbols = new Map<string, ElfSymbol>();
  const ambiguous = new Set<string>();
  const failures: ElfParseFailure[] = [];
  for (const table of tables) {
    for (let index = 0; index < table.count; index += 1) {
      if (index % 4096 === 0) {
        await yieldToEventLoop();
        signal?.throwIfAborted();
      }
      const base = table.offset + index * entrySize;
      const nameOffset = reader.u32(base)!;
      const sectionIndex = reader.u16(base + (is64 ? 6 : 14))!;
      const defined =
        sectionIndex === 0xfff1 ||
        (sectionIndex > 0 &&
          sectionIndex < 0xff00 &&
          (dynamicFallback || sectionIndex < e_shnum));
      if (!defined || nameOffset >= table.stringSize) continue;
      const name = reader.cString(
        table.stringOffset + nameOffset,
        table.stringOffset + table.stringSize,
      );
      if (name === null || !wanted.has(name)) continue;
      const value = is64 ? reader.u64(base + 8) : reader.u32(base + 4);
      const size = is64 ? reader.u64(base + 16) : reader.u32(base + 8);
      if (value === null || size === null) {
        failures.push({ reason: `Symbol ${name} has unrepresentable bounds` });
        continue;
      }
      const offset = toOffset(value, size);
      if (offset === null) {
        failures.push({ reason: `Symbol ${name} has no file-backed range` });
        continue;
      }
      const previous = symbols.get(name);
      if (
        previous !== undefined &&
        (previous.offset !== offset || previous.size !== size)
      )
        ambiguous.add(name);
      else symbols.set(name, { name, offset, size });
    }
  }
  for (const name of ambiguous) {
    symbols.delete(name);
    failures.push({ reason: `Symbol ${name} has conflicting definitions` });
  }
  for (const name of wanted)
    if (!symbols.has(name))
      failures.push({
        reason: `symbol ${name} is not in the dynamic symbol table`,
      });
  return { symbols: [...symbols.values()], failures };
};

/** Read one Dart snapshot section header from its file offset. */
export const readSnapshotHeader = (
  bytes: Buffer,
  offset: number,
): {
  magicValid: boolean;
  kind: number | null;
  headerLength: number | null;
  hash: string | null;
  complete: boolean;
} => {
  const reader = new BoundedReader(bytes);
  // The Dart magic bytes f5 f5 dc dc read little-endian. Kind and length
  // fields are only meaningful in data-section headers; sections without
  // the magic (instructions carry a different layout) report nulls.
  const magic = reader.u32(offset);
  if (magic !== 0xdcdcf5f5)
    return {
      magicValid: false,
      kind: null,
      headerLength: null,
      hash: null,
      complete: false,
    };
  const headerLength = reader.u64(offset + 4);
  const kind = reader.u64(offset + 12);
  const candidate = bytes
    .subarray(
      offset + SNAPSHOT_HASH_OFFSET,
      offset + SNAPSHOT_HASH_OFFSET + SNAPSHOT_HASH_LENGTH,
    )
    .toString("latin1");
  const hash = SNAPSHOT_HASH_PATTERN.test(candidate) ? candidate : null;
  // Dart's stored length excludes the four magic bytes and includes the
  // 20-byte fixed header and the version hash. Aligned data may follow it
  // inside the exported symbol, but the serialized snapshot must fit.
  // Kind 3 is FullAOT in the supported Dart 2.14 layout; enum values change
  // across SDK versions, so other kinds remain uninterpreted observations.
  const complete =
    headerLength !== null &&
    headerLength >= SNAPSHOT_HASH_OFFSET + SNAPSHOT_HASH_LENGTH - 4 &&
    headerLength <= bytes.length - offset - 4 &&
    kind === 3 &&
    hash !== null;
  return { magicValid: true, kind, headerLength, hash, complete };
};
