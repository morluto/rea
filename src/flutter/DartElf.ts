import { Buffer } from "node:buffer";

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

  cString(offset: number, max: number): string | null {
    const end = this.bytes.indexOf(0, offset);
    if (end === -1 || end - offset > max || end > this.bytes.length)
      return null;
    return this.bytes.subarray(offset, end).toString("latin1");
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

/**
 * Parse one snapshot symbol's file offset and size from a little-endian
 * ELF32 or ELF64 libapp.so image. Only the dynamic symbol table is walked;
 * every read is bounds-checked and any structural surprise is a refusal,
 * never a guess.
 */
export const readElfSymbol = (
  bytes: Buffer,
  symbolName: string,
): { symbol: ElfSymbol } | { failure: ElfParseFailure } => {
  const reader = new BoundedReader(bytes);
  const magic = reader.u32(0);
  if (magic !== 0x464c457f) return { failure: { reason: "not an ELF image" } };
  const elfClass = reader.u8(4);
  if (elfClass !== 1 && elfClass !== 2)
    return { failure: { reason: `unsupported ELF class ${String(elfClass)}` } };
  const is64 = elfClass === 2;
  const e_shoff = is64 ? reader.u64(0x28) : reader.u32(0x20);
  const e_shentsize = reader.u16(is64 ? 0x3a : 0x2e);
  const e_shnum = reader.u16(is64 ? 0x3c : 0x30);
  const e_phoff = is64 ? reader.u64(0x20) : reader.u32(0x1c);
  const e_phentsize = reader.u16(is64 ? 0x36 : 0x2a);
  const e_phnum = reader.u16(is64 ? 0x38 : 0x2c);
  if (
    e_shoff === null ||
    e_shentsize === null ||
    e_shnum === null ||
    e_shnum === 0 ||
    e_shoff + e_shentsize * e_shnum > bytes.length
  )
    return {
      failure: {
        reason: "ELF section header table is missing or out of bounds",
      },
    };
  if (
    e_phoff === null ||
    e_phentsize === null ||
    e_phnum === null ||
    e_phoff + e_phentsize * e_phnum > bytes.length
  )
    return {
      failure: {
        reason: "ELF program header table is missing or out of bounds",
      },
    };

  const segments: { readonly vaddr: number; readonly offset: number }[] = [];
  for (let index = 0; index < e_phnum; index += 1) {
    const base = e_phoff + index * e_phentsize;
    const type = reader.u32(base);
    if (type !== PT_LOAD) continue;
    const vaddr = is64 ? reader.u64(base + 0x10) : reader.u32(base + 8);
    const offset = is64 ? reader.u64(base + 0x08) : reader.u32(base + 4);
    if (vaddr === null || offset === null)
      return {
        failure: { reason: `PT_LOAD segment ${String(index)} is truncated` },
      };
    segments.push({ vaddr, offset });
  }
  if (segments.length === 0)
    return { failure: { reason: "ELF image has no PT_LOAD segments" } };
  const toOffset = (vaddr: number): number | null => {
    let best: { vaddr: number; offset: number } | null = null;
    for (const segment of segments)
      if (
        segment.vaddr <= vaddr &&
        (best === null || segment.vaddr > best.vaddr)
      )
        best = segment;
    return best === null ? null : best.offset + (vaddr - best.vaddr);
  };

  for (let index = 0; index < e_shnum; index += 1) {
    const header = e_shoff + index * e_shentsize;
    const type = reader.u32(is64 ? header + 4 : header + 4);
    if (type !== SHT_DYNSYM) continue;
    const offset = is64 ? reader.u64(header + 0x18) : reader.u32(header + 0x10);
    const size = is64 ? reader.u64(header + 0x20) : reader.u32(header + 0x14);
    const link = reader.u32(is64 ? header + 0x28 : header + 0x18);
    if (offset === null || size === null)
      return { failure: { reason: "dynamic symbol table is truncated" } };
    const entrySize = is64 ? 24 : 16;
    if (offset + size > bytes.length || size % entrySize !== 0)
      return { failure: { reason: "dynamic symbol table is malformed" } };
    if (link === null || link >= e_shnum)
      return {
        failure: {
          reason: "dynamic symbol table string section link is invalid",
        },
      };
    const stringHeader = e_shoff + link * e_shentsize;
    const stringOffset = is64
      ? reader.u64(stringHeader + 0x18)
      : reader.u32(stringHeader + 0x10);
    const stringSize = is64
      ? reader.u64(stringHeader + 0x20)
      : reader.u32(stringHeader + 0x14);
    if (
      stringOffset === null ||
      stringSize === null ||
      stringOffset + stringSize > bytes.length
    )
      return {
        failure: { reason: "dynamic symbol strings are out of bounds" },
      };
    for (let entry = 0; entry < size / entrySize; entry += 1) {
      const base = offset + entry * entrySize;
      const nameOffset = reader.u32(base);
      const stValue = is64 ? reader.u64(base + 8) : reader.u32(base + 4);
      const stSize = is64 ? reader.u64(base + 16) : reader.u32(base + 8);
      if (nameOffset === null || stValue === null || stSize === null) continue;
      const name = reader.cString(stringOffset + nameOffset, 256);
      if (name !== symbolName) continue;
      const fileOffset = toOffset(stValue);
      if (fileOffset === null)
        return {
          failure: { reason: `symbol ${symbolName} has no loadable address` },
        };
      if (fileOffset + stSize > bytes.length)
        return {
          failure: { reason: `symbol ${symbolName} extends past the image` },
        };
      return { symbol: { name, offset: fileOffset, size: stSize } };
    }
  }
  return {
    failure: {
      reason: `symbol ${symbolName} is not in the dynamic symbol table`,
    },
  };
};

/** Read one Dart snapshot section header from its file offset. */
export const readSnapshotHeader = (
  bytes: Buffer,
  offset: number,
): {
  magicValid: boolean;
  kind: number | null;
  headerLength: number | null;
} => {
  const reader = new BoundedReader(bytes);
  // The Dart magic bytes f5 f5 dc dc read little-endian. Kind and length
  // fields are only meaningful in data-section headers; sections without
  // the magic (instructions carry a different layout) report nulls.
  const magic = reader.u32(offset);
  if (magic !== 0xdcdcf5f5)
    return { magicValid: false, kind: null, headerLength: null };
  const headerLength = reader.u64(offset + 4);
  const kind = reader.u32(offset + 12);
  return { magicValid: true, kind, headerLength };
};
