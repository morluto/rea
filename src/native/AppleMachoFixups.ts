import type { Segment } from "./AppleMachoSelection.js";
import { issue } from "./AppleDispatchDecodeFacts.js";
import type { DecodeIssue } from "./AppleDispatchDecodeFacts.js";

/** Where a Mach-O stores pointer fixups, from its load commands. */
export interface FixupCommands {
  /** Absolute file range of `LC_DYLD_CHAINED_FIXUPS` data. */
  readonly chained: { readonly offset: number; readonly size: number } | null;
  /** Absolute file ranges of `LC_DYLD_INFO(_ONLY)` rebase streams. */
  readonly rebases: readonly {
    readonly offset: number;
    readonly size: number;
  }[];
  /** Absolute file ranges of `LC_DYLD_INFO(_ONLY)` bind streams. */
  readonly binds: readonly {
    readonly offset: number;
    readonly size: number;
    readonly stream: "bind" | "weak" | "lazy";
  }[];
  /** Install names of dependent dylibs, in library-ordinal order. */
  readonly dylibs: readonly string[];
}

/** One decoded pointer: a rebase to an in-image address or a bind to a symbol. */
export type DecodedPointer =
  | { readonly kind: "rebase"; readonly target: bigint }
  | {
      readonly kind: "bind";
      readonly symbol: string;
      readonly library: string | null;
      readonly weak: boolean;
      readonly addend: bigint;
    }
  | { readonly kind: "unsupported"; readonly reason: string };

/** Pointer decoding for one Mach-O slice. */
export interface PointerFixups {
  readonly kind: "chained" | "dyld-info" | "none";
  /** Chained pointer formats in use, such as `DYLD_CHAINED_PTR_64_OFFSET`. */
  readonly formats: readonly string[];
  readonly failures: readonly string[];
  readonly issues: readonly DecodeIssue[];
  /** Fixup segments or bind streams this reader walked. */
  readonly examined: number;
  /** Fully decoded fixup segments or bind streams, in the same units as `examined`. */
  readonly decoded: number;
  /** Rebase opcode bytes present in the load command and not decoded. */
  readonly unreadRebaseBytes: number;
  /** Decode the pointer stored at `address` whose raw 64-bit value is `raw`. */
  decode(address: bigint, raw: bigint): DecodedPointer;
}

const POINTER_FORMATS: Readonly<Record<number, string>> = {
  1: "DYLD_CHAINED_PTR_ARM64E",
  2: "DYLD_CHAINED_PTR_64",
  6: "DYLD_CHAINED_PTR_64_OFFSET",
  9: "DYLD_CHAINED_PTR_ARM64E_USERLAND",
  12: "DYLD_CHAINED_PTR_ARM64E_USERLAND24",
};

const bits = (value: bigint, from: number, width: number): bigint =>
  (value >> BigInt(from)) & ((1n << BigInt(width)) - 1n);

const signed = (value: bigint, width: number): bigint =>
  value >= 1n << BigInt(width - 1) ? value - (1n << BigInt(width)) : value;

interface Import {
  readonly symbol: string;
  readonly library: string | null;
  readonly weak: boolean;
  readonly addend: bigint;
}

interface BindRun {
  readonly start: bigint;
  count: bigint;
  readonly stride: bigint;
  readonly binding: Import;
}

/** Library ordinal to install name; 0 and negative ordinals are special lookups. */
const libraryName = (
  ordinal: number,
  dylibs: readonly string[],
): string | null => {
  if (ordinal > 0) return dylibs[ordinal - 1] ?? null;
  return null;
};

const cString = (bytes: Buffer, offset: number, end: number): string => {
  const stop = bytes.indexOf(0, offset);
  if (offset < 0 || offset >= end || stop < 0 || stop >= end)
    throw new RangeError("Fixup symbol name is outside the symbol pool");
  return bytes.toString("utf8", offset, stop);
};

const readImport = (
  data: {
    readonly bytes: Buffer;
    readonly base: number;
    readonly end: number;
    readonly dylibs: readonly string[];
  },
  header: {
    readonly offset: number;
    readonly count: number;
    readonly format: number;
    readonly symbols: number;
  },
  index: number,
): Import => {
  const { bytes, base, end, dylibs } = data;
  const size = header.format === 3 ? 16 : header.format === 2 ? 8 : 4;
  if (header.format < 1 || header.format > 3)
    throw new RangeError(`Unsupported chained import format ${header.format}`);
  if (
    !Number.isSafeInteger(header.count) ||
    base + header.offset + header.count * size > end
  )
    throw new RangeError("Chained import table exceeds the fixup data");
  if (index < 0 || index >= header.count)
    throw new RangeError("Chained import index is outside the table");
  const at = base + header.offset + index * size;
  if (header.format === 3) {
    const word = bytes.readBigUInt64LE(at);
    const encodedOrdinal = Number(bits(word, 0, 16));
    const ordinal =
      encodedOrdinal > 0xfff0 ? encodedOrdinal - 0x10000 : encodedOrdinal;
    return {
      symbol: cString(
        bytes,
        base + header.symbols + Number(bits(word, 32, 32)),
        end,
      ),
      library: libraryName(ordinal, dylibs),
      weak: bits(word, 16, 1) === 1n,
      addend: bytes.readBigInt64LE(at + 8),
    };
  }
  const word = bytes.readUInt32LE(at);
  const encodedOrdinal = word & 0xff;
  const ordinal =
    encodedOrdinal > 0xf0 ? encodedOrdinal - 0x100 : encodedOrdinal;
  return {
    symbol: cString(bytes, base + header.symbols + (word >>> 9), end),
    library: libraryName(ordinal, dylibs),
    weak: ((word >>> 8) & 1) === 1,
    addend: header.format === 2 ? BigInt(bytes.readInt32LE(at + 4)) : 0n,
  };
};

/** Decode one raw chained pointer for its segment's pointer format. */
export const decodeChainedPointer = (
  raw: bigint,
  format: number,
  baseAddress: bigint,
  imports: readonly Import[] | ((index: number) => Import),
): DecodedPointer => {
  const bind = (ordinal: bigint, addend: bigint): DecodedPointer => {
    const target =
      typeof imports === "function"
        ? imports(Number(ordinal))
        : imports[Number(ordinal)];
    if (target === undefined)
      throw new RangeError(`Chained bind ordinal ${ordinal} has no import`);
    return { kind: "bind", ...target, addend: target.addend + addend };
  };
  if (format === 2 || format === 6) {
    if (bits(raw, 63, 1) === 1n)
      return bind(bits(raw, 0, 24), bits(raw, 24, 8));
    const target = bits(raw, 0, 36) | (bits(raw, 36, 8) << 56n);
    return {
      kind: "rebase",
      target: format === 6 ? target + baseAddress : target,
    };
  }
  if (format === 1 || format === 9 || format === 12) {
    const auth = bits(raw, 63, 1) === 1n;
    if (bits(raw, 62, 1) === 1n)
      return bind(
        bits(raw, 0, format === 12 ? 24 : 16),
        auth ? 0n : signed(bits(raw, 32, 19), 19),
      );
    if (auth) return { kind: "rebase", target: bits(raw, 0, 32) + baseAddress };
    const target = bits(raw, 0, 43) | (bits(raw, 43, 8) << 56n);
    return {
      kind: "rebase",
      target: format === 1 ? target : target + baseAddress,
    };
  }
  throw new RangeError(`Unsupported chained pointer format ${format}`);
};

/** The slice bytes and load-command facts that fixup decoding reads. */
interface FixupImage {
  readonly bytes: Buffer;
  readonly segments: readonly Segment[];
  readonly dylibs: readonly string[];
  readonly baseAddress: bigint;
}

interface ChainedPage {
  /** One bit per byte offset, preserving even unaligned producer locations. */
  readonly locations: Uint8Array;
  readonly lastOffset: number | undefined;
  readonly failure: string | undefined;
}

interface ChainedSegment {
  readonly segment: Segment;
  readonly format: number;
  readonly pageSize: number;
  /** Compact producer-owned table coordinates, never one map per segment. */
  readonly pageCount: number;
  readonly pageStarts: number;
}

interface ChainedPageSource {
  readonly offset: number;
  readonly size: number;
  readonly format: number;
  readonly start: number;
}

/** Parse one physical page; a failed tail retains established locations. */
const readChainedPage = (
  bytes: Buffer,
  source: ChainedPageSource,
): ChainedPage => {
  let locations = new Uint8Array(0);
  let lastOffset: number | undefined;
  let failure: string | undefined;
  try {
    if ((source.start & 0x8000) !== 0)
      throw new RangeError(
        "Multiple chained starts are not valid for 64-bit pointers",
      );
    if (source.start + 8 > source.size)
      throw new RangeError("Chained pointer leaves its file-backed page");
    // At most one eighth of this file-backed page, not one object per fixup.
    locations = new Uint8Array(Math.ceil(source.size / 8));
    const generic = source.format === 2 || source.format === 6;
    let at = source.start;
    while (true) {
      locations[at >>> 3] = (locations[at >>> 3] ?? 0) | (1 << (at & 7));
      lastOffset = at;
      const raw = bytes.readBigUInt64LE(source.offset + at);
      const next = Number(bits(raw, 51, generic ? 12 : 11)) * (generic ? 4 : 8);
      if (next === 0) break;
      if (at + next + 8 > source.size)
        throw new RangeError(
          "Chained pointer link leaves its file-backed page",
        );
      at += next;
    }
  } catch (cause: unknown) {
    failure = cause instanceof Error ? cause.message : String(cause);
  }
  return { locations, lastOffset, failure };
};

const chainedFixups = (
  image: FixupImage,
  range: { readonly offset: number; readonly size: number },
  unreadRebaseBytes: number,
): PointerFixups => {
  const { bytes, segments, dylibs, baseAddress } = image;
  const base = range.offset;
  const end = range.offset + range.size;
  if (
    !Number.isSafeInteger(base) ||
    base < 0 ||
    !Number.isSafeInteger(range.size) ||
    range.size < 28 ||
    end > bytes.length
  )
    throw new RangeError("Chained fixup header exceeds the target");
  if (bytes.readUInt32LE(base) !== 0)
    throw new RangeError("Unsupported chained fixup header version");
  const startsOffset = bytes.readUInt32LE(base + 4);
  const importHeader = {
    offset: bytes.readUInt32LE(base + 8),
    symbols: bytes.readUInt32LE(base + 12),
    count: bytes.readUInt32LE(base + 16),
    format: bytes.readUInt32LE(base + 20),
  };
  const importSize =
    importHeader.format === 3 ? 16 : importHeader.format === 2 ? 8 : 4;
  const importTableEnd =
    base + importHeader.offset + importHeader.count * importSize;
  if (importHeader.format < 1 || importHeader.format > 3)
    throw new RangeError(
      `Unsupported chained import format ${importHeader.format}`,
    );
  if (
    importHeader.offset < 28 ||
    importHeader.symbols < importHeader.offset ||
    importTableEnd > base + importHeader.symbols ||
    base + importHeader.symbols > end
  )
    throw new RangeError("Chained import table exceeds the fixup data");
  const imports = (index: number) =>
    readImport({ bytes, base, end, dylibs }, importHeader, index);
  if (bytes.readUInt32LE(base + 24) !== 0)
    throw new RangeError(
      "Compressed chained-fixup symbol names are not supported",
    );
  const starts = base + startsOffset;
  const startsEnd = base + importHeader.offset;
  const requireStartsRange = (at: number, size: number): void => {
    if (at < base + 28 || at > startsEnd - size)
      throw new RangeError("Chained starts table exceeds its fixup data");
  };
  requireStartsRange(starts, 4);
  const segmentCount = bytes.readUInt32LE(starts);
  if (segmentCount > segments.length)
    throw new RangeError(
      "Chained starts segment count exceeds the Mach-O layout",
    );
  requireStartsRange(starts, 4 + segmentCount * 4);
  const ranges: ChainedSegment[] = [];
  // A non-overlapping file view has at most file-size/minimum-page-size
  // pages plus two partial pages per segment. Keep both metadata entries and
  // bitmap bytes within that format-derived working set. Aliased/exhausted
  // views remain readable by transient recomputation, not input rejection.
  const maximumCachedPages =
    Math.ceil(bytes.length / 0x1000) + 2 * segmentCount;
  let remainingLocationBytes = Math.ceil(bytes.length / 8);
  const cachedPages = new Map<string, ChainedPage>();
  const pageFacts = (
    chain: ChainedSegment,
    page: number,
    start: number,
  ): ChainedPage => {
    const pageOffset = page * chain.pageSize;
    const source = {
      offset: chain.segment.offset + pageOffset,
      size: Math.min(
        chain.pageSize,
        Number(chain.segment.size) - pageOffset,
        bytes.length - chain.segment.offset - pageOffset,
      ),
      format: chain.format,
      start,
    };
    const key = `${source.offset}:${source.size}:${source.format}:${source.start}`;
    const cached = cachedPages.get(key);
    if (cached !== undefined) return cached;
    // Decide retention before allocating the page facts. An exhausted cache
    // uses only one transient, format-bounded page, preserving decode behavior.
    const retain =
      cachedPages.size < maximumCachedPages &&
      Math.ceil(Math.max(source.size, 0) / 8) <= remainingLocationBytes;
    const facts = readChainedPage(bytes, source);
    if (retain) {
      remainingLocationBytes -= facts.locations.byteLength;
      cachedPages.set(key, facts);
    }
    return facts;
  };
  for (let index = 0; index < segmentCount; index++) {
    const infoOffset = bytes.readUInt32LE(starts + 4 + index * 4);
    if (infoOffset === 0) continue;
    const segment = segments[index];
    if (segment === undefined)
      throw new RangeError("Chained fixup segment table is out of range");
    const info = starts + infoOffset;
    requireStartsRange(info, 22);
    const infoSize = bytes.readUInt32LE(info);
    const pageSize = bytes.readUInt16LE(info + 4);
    const pageCount = bytes.readUInt16LE(info + 20);
    if (infoSize < 22 + pageCount * 2)
      throw new RangeError("Chained page starts exceed the segment table size");
    requireStartsRange(info, infoSize);
    if (pageSize !== 0x1000 && pageSize !== 0x4000)
      throw new RangeError("Chained page size must be 4096 or 16384 bytes");
    if (bytes.readBigUInt64LE(info + 8) !== segment.address - baseAddress)
      throw new RangeError(
        "Chained segment offset disagrees with its Mach-O layout",
      );
    ranges.push({
      segment,
      format: bytes.readUInt16LE(info + 6),
      pageSize,
      pageCount,
      pageStarts: info + 22,
    });
  }
  const formats = [
    ...new Set(
      ranges.map(({ format }) => POINTER_FORMATS[format] ?? `format-${format}`),
    ),
  ];
  const issues = ranges.flatMap(({ format, segment }) =>
    POINTER_FORMATS[format] === undefined
      ? [
          issue(
            "pointer_fixups",
            "unsupported_pointer_format",
            `Unsupported chained pointer format ${format}`,
            `0x${segment.address.toString(16)}`,
          ),
        ]
      : [],
  );
  const examinedViews = new Map<string, boolean>();
  const decodedRanges = new Set<number>();
  for (const [chainIndex, chain] of ranges.entries()) {
    // Unknown formats retain their compact starts table; only a queried page
    // needs its NONE/presence value. Do not expand unsupported declarations.
    if (POINTER_FORMATS[chain.format] === undefined) continue;
    const view = `${chain.pageStarts}:${chain.segment.offset}:${chain.segment.size}:${chain.segment.address}:${chain.format}:${chain.pageSize}:${chain.pageCount}`;
    const prior = examinedViews.get(view);
    if (prior !== undefined) {
      if (prior) decodedRanges.add(chainIndex);
      continue;
    }
    let complete = true;
    for (let page = 0; page < chain.pageCount; page++) {
      const start = bytes.readUInt16LE(chain.pageStarts + page * 2);
      if (start === 0xffff) continue;
      const facts = pageFacts(chain, page, start);
      if (facts.failure !== undefined) {
        complete = false;
        issues.push(
          issue(
            "pointer_fixups",
            "chained_pointer_walk_failed",
            facts.failure,
            `0x${(chain.segment.address + BigInt(page * chain.pageSize)).toString(16)}`,
          ),
        );
        // Coverage is partial after this failure, not exhaustive. Keep the
        // unexpanded descriptor: later pages are still independently readable
        // through pageFacts when metadata requests them.
        break;
      }
    }
    examinedViews.set(view, complete);
    if (complete) decodedRanges.add(chainIndex);
  }
  const failures = issues.map(({ message }) => message);
  return {
    kind: "chained",
    formats,
    failures,
    issues,
    examined: Math.max(ranges.length, 1),
    get decoded() {
      return ranges.length === 0 ? 1 : decodedRanges.size;
    },
    unreadRebaseBytes,
    decode(address, raw) {
      const chainIndex = ranges.findIndex(
        ({ segment }) =>
          address >= segment.address &&
          address < segment.address + segment.size,
      );
      const chain = ranges[chainIndex];
      // Pointers outside fixup segments, such as in __TEXT, are stored plainly.
      if (chain === undefined) return { kind: "rebase", target: raw };
      const within = Number(address - chain.segment.address);
      const page = Math.floor(within / chain.pageSize);
      if (page >= chain.pageCount) return { kind: "rebase", target: raw };
      const start = bytes.readUInt16LE(chain.pageStarts + page * 2);
      if (start === 0xffff) return { kind: "rebase", target: raw };
      if (POINTER_FORMATS[chain.format] === undefined)
        return {
          kind: "unsupported",
          reason: `Unsupported chained pointer format ${chain.format}`,
        };
      try {
        const facts = pageFacts(chain, page, start);
        const at = within % chain.pageSize;
        const locations = facts.locations;
        if (((locations[at >>> 3] ?? 0) & (1 << (at & 7))) !== 0)
          return decodeChainedPointer(raw, chain.format, baseAddress, imports);
        if (
          facts.failure !== undefined &&
          (facts.lastOffset === undefined || at > facts.lastOffset)
        )
          throw new RangeError(facts.failure);
        return { kind: "rebase", target: raw };
      } catch (cause: unknown) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        const location = `0x${address.toString(16)}`;
        if (
          !issues.some(
            (entry) =>
              entry.code === "chained_pointer_decode_failed" &&
              entry.location === location,
          )
        ) {
          issues.push(
            issue(
              "pointer_fixups",
              "chained_pointer_decode_failed",
              reason,
              location,
            ),
          );
          failures.push(reason);
        }
        decodedRanges.delete(chainIndex);
        return { kind: "unsupported", reason };
      }
    },
  };
};

const uleb = (bytes: Buffer, cursor: { at: number }, end: number): bigint => {
  let value = 0n;
  let shift = 0n;
  for (;;) {
    if (cursor.at >= end) throw new RangeError("Truncated bind opcode operand");
    const byte = bytes[cursor.at++] ?? 0;
    value |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if ((byte & 0x80) === 0) return value;
    if (shift > 63n) throw new RangeError("Oversized bind opcode operand");
  }
};

const sleb = (bytes: Buffer, cursor: { at: number }, end: number): bigint => {
  let value = 0n;
  let shift = 0n;
  let byte = 0;
  do {
    if (cursor.at >= end) throw new RangeError("Truncated bind opcode operand");
    byte = bytes[cursor.at++] ?? 0;
    value |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
  } while ((byte & 0x80) !== 0 && shift <= 63n);
  return (byte & 0x40) !== 0 ? value - (1n << shift) : value;
};

/** Registers of the `LC_DYLD_INFO` bind state machine. */
interface BindState {
  ordinal: number;
  segmentIndex: number;
  symbol: string;
  weak: boolean;
  addend: bigint;
  address: bigint;
}

/** Apply a bind opcode that sets a register; false when the opcode is not one. */
const setBindRegister = (
  image: FixupImage,
  stream: { readonly cursor: { at: number }; readonly end: number },
  state: BindState,
  byte: number,
): boolean => {
  const { bytes } = image;
  const { cursor, end } = stream;
  const immediate = byte & 0x0f;
  switch (byte & 0xf0) {
    case 0x10:
      state.ordinal = immediate;
      return true;
    case 0x20:
      state.ordinal = Number(uleb(bytes, cursor, end));
      return true;
    case 0x30:
      state.ordinal = immediate === 0 ? 0 : immediate - 16;
      return true;
    case 0x40: {
      const stop = bytes.indexOf(0, cursor.at);
      if (stop < 0 || stop >= end)
        throw new RangeError("Unterminated bind symbol");
      state.symbol = bytes.toString("utf8", cursor.at, stop);
      state.weak = (immediate & 0x1) !== 0;
      cursor.at = stop + 1;
      return true;
    }
    case 0x50:
      return true;
    case 0x60:
      state.addend = sleb(bytes, cursor, end);
      return true;
    case 0x70: {
      const segment = image.segments[immediate];
      if (segment === undefined)
        throw new RangeError("Bind segment index is out of range");
      state.segmentIndex = immediate;
      state.address = segment.address + uleb(bytes, cursor, end);
      return true;
    }
    case 0x80:
      // ULEB deltas wrap at 64 bits to encode negative steps.
      state.address =
        (state.address + uleb(bytes, cursor, end)) & 0xffffffffffffffffn;
      return true;
    default:
      return false;
  }
};

/** Interpret one `LC_DYLD_INFO` bind opcode stream into address -> import. */
const readBindStream = (
  image: FixupImage,
  range: FixupCommands["binds"][number],
  binds: BindRun[],
): void => {
  const { bytes } = image;
  const end = range.offset + range.size;
  if (end > bytes.length)
    throw new RangeError("Bind opcodes exceed the target");
  const cursor = { at: range.offset };
  const state: BindState = {
    ordinal: 0,
    segmentIndex: -1,
    symbol: "",
    weak: false,
    addend: 0n,
    address: 0n,
  };
  const preflightRun = (count: bigint, skip: bigint): void => {
    if (count === 0n) return;
    const segment = image.segments[state.segmentIndex];
    if (segment === undefined)
      throw new RangeError("Bind location has no selected segment");
    const stride = 8n + skip;
    const end = state.address + (count - 1n) * stride + 8n;
    if (state.address < segment.address || end > segment.address + segment.size)
      throw new RangeError("Bind expansion leaves its file-backed segment");
  };
  const bind = (count: bigint, skip: bigint): void => {
    if (count === 0n) return;
    preflightRun(count, skip);
    const stride = 8n + skip;
    const binding: Import = {
      symbol: state.symbol,
      library:
        range.stream === "weak"
          ? null
          : libraryName(state.ordinal, image.dylibs),
      weak: state.weak,
      addend: state.addend,
    };
    const previous = binds.at(-1);
    if (
      previous !== undefined &&
      previous.stride === stride &&
      previous.start + previous.count * stride === state.address &&
      previous.binding.symbol === binding.symbol &&
      previous.binding.library === binding.library &&
      previous.binding.weak === binding.weak &&
      previous.binding.addend === binding.addend
    ) {
      previous.count += count;
    } else {
      binds.push({ start: state.address, count, stride, binding });
    }
    state.address += count * stride;
  };
  while (cursor.at < end) {
    const byte = bytes[cursor.at++] ?? 0;
    if (setBindRegister(image, { cursor, end }, state, byte)) continue;
    switch (byte & 0xf0) {
      case 0x00:
        // DONE separates lazy-bind entries; other streams end here.
        if (range.stream !== "lazy") return;
        break;
      case 0x90:
        bind(1n, 0n);
        break;
      case 0xa0:
        bind(1n, uleb(bytes, cursor, end));
        break;
      case 0xb0:
        bind(1n, BigInt(byte & 0x0f) * 8n);
        break;
      case 0xc0: {
        if (range.stream === "lazy")
          throw new RangeError(
            "Lazy bind streams do not support repeated bind opcodes",
          );
        const count = uleb(bytes, cursor, end);
        const skip = uleb(bytes, cursor, end);
        bind(count, skip);
        break;
      }
      default:
        throw new RangeError(`Unsupported bind opcode 0x${byte.toString(16)}`);
    }
  }
};

/** Build pointer decoding for one slice from its fixup load commands. */
export const parsePointerFixups = (
  bytes: Buffer,
  commands: FixupCommands,
  segments: readonly Segment[],
  baseAddress: bigint,
): PointerFixups => {
  const image = { bytes, segments, dylibs: commands.dylibs, baseAddress };
  const unreadRebaseBytes = commands.rebases.reduce(
    (total, rebase) => total + rebase.size,
    0,
  );
  if (commands.chained !== null) {
    return chainedFixups(image, commands.chained, unreadRebaseBytes);
  }
  if (commands.binds.length === 0)
    return {
      kind: "none",
      formats: [],
      failures: [],
      issues: [],
      examined: 0,
      decoded: 0,
      unreadRebaseBytes,
      decode: (_address, raw) => ({ kind: "rebase", target: raw }),
    };
  const binds: BindRun[] = [];
  const failures: string[] = [];
  let decoded = 0;
  for (const stream of commands.binds)
    try {
      readBindStream(image, stream, binds);
      decoded++;
    } catch (cause: unknown) {
      failures.push(
        `${stream.stream} bind opcodes: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  return {
    kind: "dyld-info",
    formats: [],
    failures,
    issues: failures.map((message) =>
      issue("pointer_fixups", "bind_stream_decode_failed", message),
    ),
    examined: commands.binds.length,
    decoded,
    unreadRebaseBytes,
    decode(address, raw) {
      let match: BindRun | undefined;
      for (const run of binds) {
        const { start, count, stride } = run;
        const distance = address - start;
        if (
          distance >= 0n &&
          distance % stride === 0n &&
          distance / stride < count
        ) {
          if (match !== undefined)
            return {
              kind: "unsupported",
              reason: `Ambiguous bind records target pointer location 0x${address.toString(16)}`,
            };
          match = run;
        }
      }
      return match === undefined
        ? { kind: "rebase", target: raw }
        : { kind: "bind", ...match.binding };
    },
  };
};
