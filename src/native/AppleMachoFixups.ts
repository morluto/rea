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
    const ordinal = Number(signed(bits(word, 0, 16), 16));
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
  const ordinal = Number(signed(BigInt(word & 0xff), 8));
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

const chainedFixups = (
  image: FixupImage,
  range: { readonly offset: number; readonly size: number },
): PointerFixups => {
  const { bytes, segments, dylibs, baseAddress } = image;
  const base = range.offset;
  const end = range.offset + range.size;
  if (range.size < 28 || end > bytes.length)
    throw new RangeError("Chained fixup header exceeds the target");
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
  if (!Number.isSafeInteger(importHeader.count) || importTableEnd > end)
    throw new RangeError("Chained import table exceeds the fixup data");
  const imports = (index: number) =>
    readImport({ bytes, base, end, dylibs }, importHeader, index);
  if (bytes.readUInt32LE(base + 24) !== 0)
    throw new RangeError(
      "Compressed chained-fixup symbol names are not supported",
    );
  const starts = base + startsOffset;
  const segmentCount = bytes.readUInt32LE(starts);
  const ranges: {
    readonly from: bigint;
    readonly to: bigint;
    readonly format: number;
  }[] = [];
  for (let index = 0; index < segmentCount; index++) {
    const infoOffset = bytes.readUInt32LE(starts + 4 + index * 4);
    if (infoOffset === 0) continue;
    const segment = segments[index];
    if (segment === undefined || starts + infoOffset + 22 > end)
      throw new RangeError("Chained fixup segment table is out of range");
    ranges.push({
      from: segment.address,
      to: segment.address + segment.size,
      format: bytes.readUInt16LE(starts + infoOffset + 6),
    });
  }
  const formats = [
    ...new Set(
      ranges.map(({ format }) => POINTER_FORMATS[format] ?? `format-${format}`),
    ),
  ];
  const issues = ranges.flatMap(({ format, from }) =>
    POINTER_FORMATS[format] === undefined
      ? [
          issue(
            "pointer_fixups",
            "unsupported_pointer_format",
            `Unsupported chained pointer format ${format}`,
            `0x${from.toString(16)}`,
          ),
        ]
      : [],
  );
  return {
    kind: "chained",
    formats,
    failures: issues.map(({ message }) => message),
    issues,
    examined: Math.max(ranges.length, 1),
    unreadRebaseBytes: 0,
    decode(address, raw) {
      const segment = ranges.find(
        ({ from, to }) => address >= from && address < to,
      );
      // Pointers outside fixup segments, such as in __TEXT, are stored plainly.
      if (segment === undefined) return { kind: "rebase", target: raw };
      if (raw === 0n) return { kind: "rebase", target: 0n };
      if (POINTER_FORMATS[segment.format] === undefined)
        return {
          kind: "unsupported",
          reason: `Unsupported chained pointer format ${segment.format}`,
        };
      return decodeChainedPointer(raw, segment.format, baseAddress, imports);
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
  binds: Map<bigint, Import>,
): void => {
  const { bytes } = image;
  const end = range.offset + range.size;
  if (end > bytes.length)
    throw new RangeError("Bind opcodes exceed the target");
  const cursor = { at: range.offset };
  const state: BindState = {
    ordinal: 0,
    symbol: "",
    weak: false,
    addend: 0n,
    address: 0n,
  };
  const bind = (skip: bigint): void => {
    binds.set(state.address, {
      symbol: state.symbol,
      library:
        range.stream === "weak"
          ? null
          : libraryName(state.ordinal, image.dylibs),
      weak: state.weak,
      addend: state.addend,
    });
    state.address += 8n + skip;
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
        bind(0n);
        break;
      case 0xa0:
        bind(uleb(bytes, cursor, end));
        break;
      case 0xb0:
        bind(BigInt(byte & 0x0f) * 8n);
        break;
      case 0xc0: {
        const count = uleb(bytes, cursor, end);
        const skip = uleb(bytes, cursor, end);
        for (let index = 0n; index < count; index++) bind(skip);
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
    const chained = chainedFixups(image, commands.chained);
    return unreadRebaseBytes === 0
      ? chained
      : { ...chained, unreadRebaseBytes };
  }
  if (commands.binds.length === 0)
    return {
      kind: "none",
      formats: [],
      failures: [],
      issues: [],
      examined: 0,
      unreadRebaseBytes,
      decode: (_address, raw) => ({ kind: "rebase", target: raw }),
    };
  const binds = new Map<bigint, Import>();
  const failures: string[] = [];
  for (const stream of commands.binds)
    try {
      readBindStream(image, stream, binds);
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
    unreadRebaseBytes,
    decode(address, raw) {
      const bound = binds.get(address);
      return bound === undefined
        ? { kind: "rebase", target: raw }
        : { kind: "bind", ...bound };
    },
  };
};
