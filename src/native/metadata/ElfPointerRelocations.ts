import type {
  FileMapping,
  ZeroFillMapping,
} from "../../domain/virtualFileMapping.js";
import { readElfDynamicEntry } from "../../domain/elfDynamicEntry.js";
import { readElfRelocationEntry } from "../../domain/elfRelocation.js";
import {
  BinaryMappingFailure,
  createFileMappingIndex,
  isZeroFilledSpan,
  type ElfDynamicSegment,
} from "./BinaryContainer.js";

/** Shared loader interpretation; language adapters choose their public errors. */
export class ElfPointerRelocationFailure extends Error {
  constructor(
    readonly reason:
      | "malformed-container"
      | "unsupported-container"
      | "unsupported-pointer-encoding"
      | "native-index-capacity",
    message: string,
  ) {
    super(message);
  }
}
export interface ElfPointerRelocationSource {
  readonly encoding: "rel" | "rela" | "relr";
  readonly record_file_offset: number;
  readonly kind: number | null;
}
export interface ElfPointerWrite {
  readonly address: bigint;
  readonly width: number;
  /** null: a symbolic/indirect relocation whose value is not established. */
  readonly value: bigint | null;
  readonly file_offset: number | null;
  readonly source: ElfPointerRelocationSource;
  /** Decoded REL/RELA `r_sym`; null for RELR. */
  readonly symbol_index: number | null;
  /** Decoded RELA `r_addend`; null for REL (implicit in place) and RELR. */
  readonly addend: bigint | null;
}
export interface ElfOverlayPointer {
  readonly value: bigint;
  readonly file_offset: number | null;
  readonly relocation: ElfPointerRelocationSource | null;
}
export interface ElfPointerOverlay {
  readonly writes: readonly ElfPointerWrite[];
  readonly unresolved: ReadonlyMap<bigint, number>;
  readonly issues: readonly string[];
  readonly dynamic_present: boolean;
  readonly pointer_coverage_known: boolean;
  readonly hasWrites: (address: bigint, size: number) => boolean;
  /** Unknown/partially overwritten words are undefined, never their stored zero. */
  readonly pointerAt: (address: bigint) => ElfOverlayPointer | undefined;
}
export interface ElfPointerRelocationInput {
  readonly bits: 32 | 64;
  readonly little: boolean;
  readonly machine: number;
  readonly dynamicSegments: readonly ElfDynamicSegment[];
  readonly mappings: readonly FileMapping[];
  readonly zeroFills: readonly ZeroFillMapping[];
}

// JNI sparse consumers retain per-write provenance; streaming materializers do not.
const MAX_RELOCATION_RECORDS = 65_536;
/** Conservative logical reservation for three Map entries, boxed coordinates and
 * values, and finish-time tuples/ranges/reach/sort storage including growth slack.
 * This is allocation accounting, not a measurement of a JavaScript VM's RSS. */
const ELF_POINTER_INDEX_ENTRY_BYTES = 2 * 1024;
const DT_RELA = 7n,
  DT_RELASZ = 8n,
  DT_RELAENT = 9n;
const DT_REL = 17n,
  DT_RELSZ = 18n,
  DT_RELENT = 19n;
const DT_PLTRELSZ = 2n,
  DT_PLTREL = 20n,
  DT_JMPREL = 23n;
const DT_RELRSZ = 35n,
  DT_RELR = 36n,
  DT_RELRENT = 37n;
const PACKED_TAGS = [0x6000000fn, 0x60000010n, 0x60000011n, 0x60000012n];
const ANDROID_RELR_TAGS = [0x6fffe000n, 0x6fffe001n, 0x6fffe003n];
const UNIQUE_TAGS = new Set([
  DT_RELA,
  DT_RELASZ,
  DT_RELAENT,
  DT_REL,
  DT_RELSZ,
  DT_RELENT,
  DT_RELR,
  DT_RELRSZ,
  DT_RELRENT,
  DT_JMPREL,
  DT_PLTRELSZ,
  DT_PLTREL,
  ...PACKED_TAGS,
  ...ANDROID_RELR_TAGS,
]);
const malformed = (message: string): never => {
  throw new ElfPointerRelocationFailure("malformed-container", message);
};
const RELOCATION_KINDS = new Map([
  [
    183,
    {
      absolute: 257,
      bits: 64,
      relative: 1027,
      widths: new Map([
        [257, 8],
        [258, 4],
        [259, 2],
        [260, 8],
        [261, 4],
        [262, 2],
        [1025, 8],
        [1026, 8],
        [1028, 8],
        [1029, 8],
        [1030, 8],
        [1032, 8],
      ]),
    },
  ],
  [
    62,
    {
      absolute: 1,
      bits: 64,
      relative: 8,
      widths: new Map([
        [1, 8],
        [2, 4],
        [6, 8],
        [7, 8],
        [10, 4],
        [11, 4],
        [16, 8],
        [17, 8],
        [18, 8],
        [24, 8],
        [37, 8],
      ]),
    },
  ],
  [
    40,
    {
      absolute: 2,
      bits: 32,
      relative: 23,
      widths: new Map([
        [2, 4],
        [3, 4],
        [17, 4],
        [18, 4],
        [19, 4],
        [21, 4],
        [22, 4],
        [160, 4],
      ]),
    },
  ],
  [
    3,
    {
      absolute: 1,
      bits: 32,
      relative: 8,
      widths: new Map([
        [1, 4],
        [2, 4],
        [3, 4],
        [4, 4],
        [6, 4],
        [7, 4],
        [9, 4],
        [10, 4],
        [11, 4],
        [14, 4],
        [15, 4],
        [16, 4],
        [17, 4],
        [18, 4],
        [19, 4],
        [20, 2],
        [21, 2],
        [22, 1],
        [23, 1],
        [35, 4],
        [36, 4],
        [37, 4],
        [38, 4],
        [42, 4],
        [43, 4],
      ]),
    },
  ],
]);

/** R_*_RELATIVE type for a supported ELF machine, or undefined when unsupported. */
export const elfRelativeRelocationType = (
  machine: number,
): number | undefined => RELOCATION_KINDS.get(machine)?.relative;

/** Word-sized absolute (S + A) relocation type for a supported ELF machine. */
export const elfAbsoluteRelocationType = (
  machine: number,
): number | undefined => RELOCATION_KINDS.get(machine)?.absolute;

/** Bytes written by a relocation; type zero is a no-op and unknown types remain undefined. */
export const elfRelocationWidth = (
  machine: number,
  type: number,
): number | undefined =>
  type === 0 ? 0 : RELOCATION_KINDS.get(machine)?.widths.get(type);

function* dynamicTags(
  bytes: Buffer,
  input: ElfPointerRelocationInput,
): Generator<undefined, Map<bigint, bigint>> {
  yield;
  if (input.dynamicSegments.length > 1)
    malformed("multiple PT_DYNAMIC segments");
  const declaration = input.dynamicSegments[0];
  if (declaration === undefined) return new Map();
  const width = input.bits / 4;
  if (declaration.size > 16n * 1024n * 1024n)
    throw new ElfPointerRelocationFailure(
      "native-index-capacity",
      "ELF dynamic directory exceeds the 16 MiB structural allowance",
    );
  if (
    declaration.size % BigInt(width) !== 0n ||
    declaration.offset > BigInt(bytes.length) ||
    declaration.size > BigInt(bytes.length) - declaration.offset
  )
    malformed("PT_DYNAMIC is truncated or outside the file");
  const tags = new Map<bigint, bigint>();
  const start = Number(declaration.offset),
    end = start + Number(declaration.size);
  for (let at = start; at < end; at += width) {
    if ((at - start) % 65_536 === 0) yield;
    const parsed = readElfDynamicEntry(
      bytes.subarray(at, at + width),
      input.bits,
      input.little,
    );
    if (!parsed.ok) return malformed(parsed.error.message);
    const { tag, value } = parsed.value;
    if (tag === 0n) return tags;
    if (UNIQUE_TAGS.has(tag) && tags.has(tag))
      malformed(`duplicate dynamic tag ${tag}`);
    if (UNIQUE_TAGS.has(tag)) tags.set(tag, value);
  }
  return malformed("PT_DYNAMIC has no DT_NULL terminator");
}

export interface ElfRelocationStreamResult {
  readonly issues: readonly string[];
  readonly dynamic_present: boolean;
  readonly pointer_coverage_known: boolean;
  readonly originalValueAt: (
    address: bigint,
    width: 4 | 8,
  ) => ElfOverlayPointer | undefined;
}
type RelocationOptions = {
  readonly unsupported?: "reject" | "record";
  readonly requireDynamic?: boolean;
};

/** Decode once from immutable bytes; consumers choose streaming or sparse retention. */
export function* readElfRelocationWritesSteps(
  bytes: Buffer,
  input: ElfPointerRelocationInput,
  options: RelocationOptions = {},
): Generator<ElfPointerWrite | undefined, ElfRelocationStreamResult> {
  const kinds = RELOCATION_KINDS.get(input.machine);
  if (kinds === undefined || kinds.bits !== input.bits)
    throw new ElfPointerRelocationFailure(
      "unsupported-container",
      "ELF relative pointers require a matching AArch64, x86-64, ARM or i386 image",
    );
  const relative = kinds.relative;
  const unknownWidths = kinds.widths;
  if (options.requireDynamic === true && input.dynamicSegments.length === 0)
    throw new ElfPointerRelocationFailure(
      "unsupported-container",
      "ELF image has no PT_DYNAMIC segment",
    );
  const tags = yield* dynamicTags(bytes, input);
  const word = input.bits / 8;
  const index = createFileMappingIndex(input.mappings, input.zeroFills);
  const fileOffset = (address: bigint, width: number): number | null => {
    try {
      return index.offset(address, width);
    } catch (cause) {
      if (cause instanceof BinaryMappingFailure && cause.reason === "unmapped")
        return null;
      throw cause;
    }
  };
  const rawWord = (offset: number): bigint =>
    input.bits === 64
      ? input.little
        ? bytes.readBigUInt64LE(offset)
        : bytes.readBigUInt64BE(offset)
      : BigInt(
          input.little
            ? bytes.readUInt32LE(offset)
            : bytes.readUInt32BE(offset),
        );
  const target = (address: bigint, width: number): number | null => {
    const at = fileOffset(address, width);
    if (
      at === null &&
      !isZeroFilledSpan(input.mappings, input.zeroFills, address, width)
    )
      malformed(
        "RELATIVE relocation target is outside unambiguous loaded memory",
      );
    return at;
  };
  const issues = new Set<string>();
  let known = true;
  const unsupported = (message: string) => {
    if (options.unsupported !== "record")
      throw new ElfPointerRelocationFailure(
        "unsupported-pointer-encoding",
        message,
      );
    if (issues.size < 16) issues.add(message);
    else
      issues.add(
        "Additional unsupported relocation encodings were not individually listed",
      );
    known = false;
  };
  const write = (
    address: bigint,
    width: number,
    value: bigint | null,
    record: Pick<ElfPointerWrite, "source" | "symbol_index" | "addend">,
  ): ElfPointerWrite => ({
    address,
    width,
    value,
    file_offset:
      value === null ? fileOffset(address, width) : target(address, width),
    ...record,
  });
  if (PACKED_TAGS.some((tag) => tags.has(tag)))
    unsupported(
      "Android packed APS2 relocation write locations and addends are not decoded",
    );
  if (ANDROID_RELR_TAGS.some((tag) => tags.has(tag)))
    unsupported("Android-specific RELR dynamic tags are not decoded");

  function* standardTable(
    address: bigint,
    size: bigint | undefined,
    entry: bigint,
    encoding: "rel" | "rela",
  ): Generator<ElfPointerWrite | undefined> {
    const width = word * (encoding === "rela" ? 3 : 2);
    if (
      size === undefined ||
      size < 0n ||
      entry !== BigInt(width) ||
      size % entry !== 0n ||
      size > BigInt(bytes.length)
    )
      return malformed(
        `invalid DT_${encoding.toUpperCase()}SZ or DT_${encoding.toUpperCase()}ENT`,
      );
    if (size === 0n) return;
    const start = fileOffset(address, Number(size));
    if (start === null)
      return malformed(`${encoding.toUpperCase()} table is not file-backed`);
    for (let at = start; at < start + Number(size); at += width) {
      if ((at - start) % (width * 4096) === 0) yield;
      const parsed =
        encoding === "rela"
          ? readElfRelocationEntry(
              bytes.subarray(at, at + width),
              input.bits,
              input.little,
              "rela",
            )
          : readElfRelocationEntry(
              bytes.subarray(at, at + width),
              input.bits,
              input.little,
              "rel",
            );
      if (!parsed.ok) return malformed(parsed.error.message);
      const { type: kind, offset: destination, symbolIndex } = parsed.value;
      if (elfRelocationWidth(input.machine, kind) === 0) continue;
      const source = { encoding, record_file_offset: at, kind };
      const explicitAddend =
        "addend" in parsed.value && typeof parsed.value.addend === "bigint"
          ? parsed.value.addend
          : undefined;
      if (encoding === "rela" && explicitAddend === undefined)
        return malformed("RELA relocation has no decoded addend");
      const record = {
        source,
        symbol_index: symbolIndex,
        addend: explicitAddend ?? null,
      };
      if (kind !== relative || symbolIndex !== 0) {
        const width = unknownWidths.get(kind);
        if (width === undefined) {
          unsupported(`ELF relocation kind ${kind} is not decoded`);
          continue;
        }
        yield write(destination, width, null, record);
        continue;
      }
      const slot = target(destination, word);
      const addend = explicitAddend ?? (slot === null ? 0n : rawWord(slot));
      yield write(
        destination,
        word,
        BigInt.asUintN(input.bits, addend),
        record,
      );
    }
  }
  for (const [addressTag, sizeTag, entryTag, encoding] of [
    [DT_RELA, DT_RELASZ, DT_RELAENT, "rela"],
    [DT_REL, DT_RELSZ, DT_RELENT, "rel"],
  ] as const) {
    const address = tags.get(addressTag);
    if (address !== undefined)
      yield* standardTable(
        address,
        tags.get(sizeTag),
        tags.get(entryTag) ?? BigInt(word * (encoding === "rela" ? 3 : 2)),
        encoding,
      );
    else if ((tags.get(sizeTag) ?? 0n) !== 0n)
      malformed(
        `DT_${encoding.toUpperCase()}SZ has no DT_${encoding.toUpperCase()}`,
      );
  }
  const plt = tags.get(DT_JMPREL);
  if (plt !== undefined) {
    const encoding =
      tags.get(DT_PLTREL) === DT_RELA
        ? "rela"
        : tags.get(DT_PLTREL) === DT_REL
          ? "rel"
          : undefined;
    if (encoding === undefined)
      unsupported("PLT relocations require a declared REL or RELA encoding");
    else
      yield* standardTable(
        plt,
        tags.get(DT_PLTRELSZ),
        BigInt(word * (encoding === "rela" ? 3 : 2)),
        encoding,
      );
  } else if ((tags.get(DT_PLTRELSZ) ?? 0n) !== 0n)
    malformed("DT_PLTRELSZ has no DT_JMPREL");

  const relr = tags.get(DT_RELR),
    relrSize = tags.get(DT_RELRSZ) ?? 0n;
  if (relr === undefined) {
    if (relrSize !== 0n) malformed("DT_RELRSZ has no DT_RELR");
  } else {
    if (
      relrSize % BigInt(word) !== 0n ||
      relrSize > BigInt(bytes.length) ||
      (tags.get(DT_RELRENT) ?? BigInt(word)) !== BigInt(word)
    )
      malformed("invalid DT_RELRSZ or DT_RELRENT");
    const start = relrSize === 0n ? 0 : fileOffset(relr, Number(relrSize));
    if (start === null) return malformed("RELR table is not file-backed");
    let next: bigint | undefined;
    for (let at = start; at < start + Number(relrSize); at += word) {
      if ((at - start) % (word * 4096) === 0) yield;
      const entry = rawWord(at);
      const add = (address: bigint) => {
        if (address > (1n << BigInt(input.bits)) - BigInt(word))
          malformed("RELR destination overflows the ELF address space");
        const slot = target(address, word);
        return write(address, word, slot === null ? 0n : rawWord(slot), {
          source: { encoding: "relr", record_file_offset: at, kind: null },
          symbol_index: null,
          addend: null,
        });
      };
      if ((entry & 1n) === 0n) {
        yield add(entry);
        next = entry + BigInt(word);
      } else {
        if (next === undefined)
          return malformed("RELR bitmap has no preceding address");
        for (let bit = 1; bit < input.bits; bit++)
          if ((entry & (1n << BigInt(bit))) !== 0n)
            yield add(next + BigInt((bit - 1) * word));
        next += BigInt((input.bits - 1) * word);
        if (next > 1n << BigInt(input.bits))
          malformed("RELR bitmap overflows the ELF address space");
      }
    }
  }

  return {
    issues: [...issues],
    dynamic_present: input.dynamicSegments.length !== 0,
    pointer_coverage_known: known,
    originalValueAt: (address, width) => {
      const at = fileOffset(address, width);
      return at === null
        ? undefined
        : {
            value:
              width === word
                ? rawWord(at)
                : BigInt(
                    input.little
                      ? bytes.readUInt32LE(at)
                      : bytes.readUInt32BE(at),
                  ),
            file_offset: at,
            relocation: null,
          };
    },
  };
}

/** Loader values and overlap ownership, independent of retained relocation provenance. */
export interface ElfVirtualPointerWrites {
  readonly hasWrites: (address: bigint, size: number) => boolean;
  /** Undefined when a write leaves the selected field unresolved or partly overwritten. */
  readonly unsignedAt: (address: bigint, width: 4 | 8) => bigint | undefined;
}

/** Both sparse consumers use virtual coordinates; physical aliases never merge writes. */
class ElfVirtualWriteIndex {
  readonly #values = new Map<bigint, bigint>();
  readonly #widths = new Map<bigint, number>();
  readonly #unresolved = new Map<bigint, number>();
  #reservedBytes = 0;
  constructor(
    readonly word: 4 | 8,
    readonly little: boolean,
    readonly maximumBytes: number,
  ) {}
  add({
    address,
    width,
    value,
  }: Pick<ElfPointerWrite, "address" | "width" | "value">): void {
    if (!this.#widths.has(address)) {
      // Reserve retained containers and finish-time lookup expansion before
      // the first insertion. Repeated declarations of one VA share its charge.
      if (
        ELF_POINTER_INDEX_ENTRY_BYTES >
        this.maximumBytes - this.#reservedBytes
      )
        throw new ElfPointerRelocationFailure(
          "native-index-capacity",
          `ELF virtual pointer index exceeds ${this.maximumBytes} estimated representation bytes (${ELF_POINTER_INDEX_ENTRY_BYTES} reserved per virtual address, including lookup workspace)`,
        );
      this.#reservedBytes += ELF_POINTER_INDEX_ENTRY_BYTES;
    }
    this.#widths.set(address, Math.max(this.#widths.get(address) ?? 0, width));
    if (
      value === null ||
      (this.#values.has(address) && this.#values.get(address) !== value)
    )
      this.#unresolved.set(
        address,
        Math.max(this.#unresolved.get(address) ?? 0, width),
      );
    if (value !== null) this.#values.set(address, value);
  }
  get unresolvedSize(): number {
    return this.#unresolved.size;
  }
  finish() {
    const ranges = [...this.#widths]
      .map(([address, width]) => ({ address, end: address + BigInt(width) }))
      .sort((a, b) =>
        a.address < b.address ? -1 : a.address > b.address ? 1 : 0,
      );
    const reach: bigint[] = [];
    for (const range of ranges)
      reach.push(
        range.end > (reach.at(-1) ?? 0n) ? range.end : (reach.at(-1) ?? 0n),
      );
    let previousEnd: bigint | undefined;
    let previousBefore = 0;
    const before = (end: bigint): number => {
      // Sequential field scans reuse the immutable interval cursor. Large or
      // backward jumps keep binary lookup, so random queries cannot rescan it.
      if (
        previousEnd !== undefined &&
        end >= previousEnd &&
        end - previousEnd <= 16n
      ) {
        while (
          previousBefore < ranges.length &&
          ranges[previousBefore]!.address < end
        )
          previousBefore++;
        previousEnd = end;
        return previousBefore;
      }
      let low = 0,
        high = ranges.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (ranges[mid]!.address < end) low = mid + 1;
        else high = mid;
      }
      previousEnd = end;
      previousBefore = low;
      return low;
    };
    const unsignedAt = (
      address: bigint,
      width: 4 | 8,
      original?: bigint,
    ): bigint | undefined => {
      if (width > this.word) return undefined;
      const end = address + BigInt(width);
      const complete = (1n << BigInt(width * 8)) - 1n;
      let covered = original === undefined ? 0n : complete;
      let assigned = 0n;
      let result = original ?? 0n;
      let owner: bigint | undefined;
      for (
        let at = before(end) - 1;
        at >= 0 && (reach[at] ?? 0n) > address;
        at--
      ) {
        const range = ranges[at]!;
        if (range.end <= address) continue;
        const unknownWidth = this.#unresolved.get(range.address);
        if (
          unknownWidth !== undefined &&
          range.address + BigInt(unknownWidth) > address
        )
          return undefined;
        const value = this.#values.get(range.address);
        if (
          value === undefined ||
          range.end - range.address !== BigInt(this.word) ||
          (width === this.word &&
            (range.address !== address || range.end !== end))
        )
          return undefined;
        owner = range.address;
        if (width === this.word) {
          if (assigned !== 0n) return undefined;
          result = value;
          assigned = complete;
          covered = complete;
          continue;
        }
        const start = range.address > address ? range.address : address;
        const stop = range.end < end ? range.end : end;
        for (let byte = start; byte < stop; byte++) {
          const sourceShift = this.little
            ? byte - range.address
            : range.end - byte - 1n;
          const targetShift = this.little ? byte - address : end - byte - 1n;
          const mask = 0xffn << (targetShift * 8n);
          if ((assigned & mask) !== 0n) return undefined;
          result =
            (result & ~mask) |
            (((value >> (sourceShift * 8n)) & 0xffn) << (targetShift * 8n));
          assigned |= mask;
          covered |= mask;
        }
      }
      return owner !== undefined && covered === complete ? result : undefined;
    };
    return {
      unsignedAt,
      unresolved: this.#unresolved,
      hasWrites: (address: bigint, size: number): boolean => {
        const low = before(address + BigInt(size));
        return low > 0 && (reach[low - 1] ?? 0n) > address;
      },
    };
  }
}

/** Retain provenance-bearing facts for bounded metadata queries. */
export function* readElfPointerRelocationsSteps(
  bytes: Buffer,
  input: ElfPointerRelocationInput,
  options: RelocationOptions = {},
): Generator<void, ElfPointerOverlay> {
  const writes: ElfPointerWrite[] = [];
  const values = new Map<bigint, ElfPointerWrite>();
  const index = new ElfVirtualWriteIndex(
    input.bits === 64 ? 8 : 4,
    input.little,
    MAX_RELOCATION_RECORDS * ELF_POINTER_INDEX_ENTRY_BYTES,
  );
  const steps = readElfRelocationWritesSteps(bytes, input, options);
  let next = steps.next();
  while (!next.done) {
    const write = next.value;
    if (write === undefined) yield;
    else {
      if (writes.length >= MAX_RELOCATION_RECORDS)
        throw new ElfPointerRelocationFailure(
          "native-index-capacity",
          `ELF sparse relocation index exceeds ${MAX_RELOCATION_RECORDS} retained writes`,
        );
      writes.push(write);
      index.add(write);
      if (write.value !== null) values.set(write.address, write);
    }
    next = steps.next();
  }
  const facts = index.finish();
  const { issues, dynamic_present, pointer_coverage_known, originalValueAt } =
    next.value;
  const unsignedAt = (
    address: bigint,
    width: 4 | 8,
  ): ElfOverlayPointer | undefined => {
    if (!pointer_coverage_known || width > input.bits / 8) return undefined;
    if (!facts.hasWrites(address, width))
      return originalValueAt(address, width);
    const resolved = facts.unsignedAt(address, width);
    if (resolved === undefined) return undefined;
    const source = values.get(address)!;
    return {
      value: resolved,
      file_offset: source.file_offset,
      relocation: source.source,
    };
  };
  return {
    writes,
    unresolved: facts.unresolved,
    issues,
    dynamic_present,
    pointer_coverage_known,
    pointerAt: (address) => unsignedAt(address, input.bits === 64 ? 8 : 4),
    hasWrites: facts.hasWrites,
  };
}

/** Value-only consumers keep input-bounded file-backed writes without per-record
 * provenance, with a separate allowance for unresolved and zero-fill state.
 */
export function* readElfPointerValuesSteps(
  bytes: Buffer,
  input: ElfPointerRelocationInput,
  maximumIndexBytes: number,
): Generator<void, ElfVirtualPointerWrites> {
  const index = new ElfVirtualWriteIndex(
    input.bits === 64 ? 8 : 4,
    input.little,
    maximumIndexBytes,
  );
  const zeroFill = new Set<bigint>();
  const steps = readElfRelocationWritesSteps(bytes, input, {
    requireDynamic: true,
  });
  let next = steps.next();
  while (!next.done) {
    const write = next.value;
    if (write === undefined) yield;
    else {
      index.add(write);
      if (write.value !== null && write.file_offset === null)
        zeroFill.add(write.address);
      if (index.unresolvedSize + zeroFill.size > MAX_RELOCATION_RECORDS)
        throw new ElfPointerRelocationFailure(
          "native-index-capacity",
          "ELF unresolved and zero-fill overlay exceeds 65536 entries",
        );
    }
    next = steps.next();
  }
  const facts = index.finish();
  const { originalValueAt } = next.value;
  return {
    hasWrites: facts.hasWrites,
    unsignedAt: (address, width) => {
      if (!facts.hasWrites(address, width)) return undefined;
      return facts.unsignedAt(
        address,
        width,
        width === 4 && input.bits === 64
          ? originalValueAt(address, width)?.value
          : undefined,
      );
    },
  };
}
