/** Distinguish corrupt recognized binaries from containers outside parser coverage. */
export class GoBinaryFormatFailure extends Error {
  constructor(
    readonly kind: "malformed" | "unsupported",
    message: string,
  ) {
    super(message);
    this.name = "GoBinaryFormatFailure";
  }
}

/** Resource boundary exceeded while decoding metadata or native container structure. */
export class GoBinaryResourceFailure extends Error {
  constructor(
    readonly boundary: "build-info" | "structure",
    readonly maximum_bytes: number,
    message: string,
  ) {
    super(message);
    this.name = "GoBinaryResourceFailure";
  }
}

/** One file-backed virtual range; addresses stay exact until mapped to file offsets. */
export interface GoFileMapping {
  readonly address: bigint;
  readonly offset: number;
  readonly size: number;
}

/** Declared zero-initialized virtual memory with no corresponding file bytes. */
export interface GoZeroFillMapping {
  readonly address: bigint;
  readonly size: bigint;
}

/** Native container facts and its producer-defined build-info search area. */
export interface GoBinaryContainer {
  readonly format: "elf" | "pe" | "macho";
  readonly architecture: string;
  readonly bits: 32 | 64;
  readonly byte_order: "little" | "big";
  readonly mappings: readonly GoFileMapping[];
  readonly zero_fills: readonly GoZeroFillMapping[];
  readonly search: GoFileMapping | null;
}

/** Reader that checks every structural range before decoding numeric fields. */
export class GoBinaryReader {
  constructor(
    readonly bytes: Buffer,
    readonly little: boolean,
  ) {}

  range(offset: number, size: number, label: string): Buffer {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      offset > this.bytes.length ||
      size > this.bytes.length - offset
    )
      throw new GoBinaryFormatFailure(
        "malformed",
        `${label} range is truncated or outside the file`,
      );
    return this.bytes.subarray(offset, offset + size);
  }

  u16(offset: number): number {
    const value = this.range(offset, 2, "16-bit field");
    return this.little ? value.readUInt16LE() : value.readUInt16BE();
  }

  u32(offset: number): number {
    const value = this.range(offset, 4, "32-bit field");
    return this.little ? value.readUInt32LE() : value.readUInt32BE();
  }

  word(offset: number, bits: 32 | 64): bigint {
    if (bits === 32) return BigInt(this.u32(offset));
    const value = this.range(offset, 8, "64-bit field");
    return this.little ? value.readBigUInt64LE() : value.readBigUInt64BE();
  }

  fileRange(offset: bigint, size: bigint, label: string): GoFileMapping {
    if (
      offset > BigInt(this.bytes.length) ||
      size > BigInt(this.bytes.length) - offset
    )
      throw new GoBinaryFormatFailure(
        "malformed",
        `${label} range is outside the file`,
      );
    const result = { address: 0n, offset: Number(offset), size: Number(size) };
    this.range(result.offset, result.size, label);
    return result;
  }

  table(offset: bigint, count: number, width: number, label: string): number {
    const size = BigInt(count) * BigInt(width);
    if (size > 16n * 1024n * 1024n)
      throw new GoBinaryResourceFailure(
        "structure",
        16 * 1024 * 1024,
        `${label} exceeds the 16 MiB structural decoding budget`,
      );
    return this.fileRange(offset, size, label).offset;
  }
}

/** Map a virtual span without losing precision or selecting an ambiguous alias. */
export const mappedFileOffset = (
  mappings: readonly GoFileMapping[],
  address: bigint,
  size: number,
  zeroFills: readonly GoZeroFillMapping[] = [],
): number => {
  let found: number | undefined;
  for (const mapping of mappings) {
    const delta = address - mapping.address;
    if (
      delta < 0n ||
      delta > BigInt(mapping.size) ||
      BigInt(size) > BigInt(mapping.size) - delta
    )
      continue;
    const offset = mapping.offset + Number(delta);
    if (found !== undefined && found !== offset)
      throw new GoBinaryFormatFailure(
        "malformed",
        "Virtual address has ambiguous file mappings",
      );
    found = offset;
  }
  if (found === undefined)
    throw new GoBinaryFormatFailure(
      "malformed",
      "Virtual address or string range is not file mapped",
    );
  for (const zeroFill of zeroFills) {
    if (spansOverlap(address, BigInt(size), zeroFill.address, zeroFill.size))
      throw new GoBinaryFormatFailure(
        "malformed",
        "Virtual address has ambiguous file and zero-fill mappings",
      );
  }
  const end = address + BigInt(size);
  for (const mapping of mappings) {
    const start = address > mapping.address ? address : mapping.address;
    const mappingEnd = mapping.address + BigInt(mapping.size);
    const overlapEnd = end < mappingEnd ? end : mappingEnd;
    if (start >= overlapEnd) continue;
    if (
      BigInt(found) + start - address !==
      BigInt(mapping.offset) + start - mapping.address
    )
      throw new GoBinaryFormatFailure(
        "malformed",
        "Virtual address has ambiguous file mappings",
      );
  }
  return found;
};

/** Recognize a wholly zero-filled span while refusing even partial file aliases. */
export const isZeroFilledSpan = (
  mappings: readonly GoFileMapping[],
  zeroFills: readonly GoZeroFillMapping[],
  address: bigint,
  size: number,
): boolean => {
  const bytes = BigInt(size);
  if (
    !zeroFills.some(
      (mapping) =>
        address >= mapping.address &&
        address + bytes <= mapping.address + mapping.size,
    )
  )
    return false;
  for (const mapping of mappings) {
    if (spansOverlap(address, bytes, mapping.address, BigInt(mapping.size)))
      throw new GoBinaryFormatFailure(
        "malformed",
        "Virtual address has ambiguous file and zero-fill mappings",
      );
  }
  return true;
};

const spansOverlap = (
  address: bigint,
  size: bigint,
  otherAddress: bigint,
  otherSize: bigint,
): boolean =>
  size > 0n &&
  otherSize > 0n &&
  address < otherAddress + otherSize &&
  otherAddress < address + size;

/** Decode metadata text without replacing invalid bytes or stripping an initial BOM. */
export const goUtf8 = (bytes: Buffer, label: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (cause) {
    throw new GoBinaryFormatFailure(
      "malformed",
      `${label} contains malformed UTF-8: ${String(cause)}`,
    );
  }
};
