import { BinaryReader } from "./binaryContainer.js";
import { ParseFailureError, type ParseFailure } from "./parseFailure.js";
import { err, ok, type Result } from "./result.js";

/**
 * Nintendo Switch NSO and NRO executable headers (switchbrew "NSO" and "NRO",
 * all fields little-endian). Only the fixed headers and the NRO asset header
 * are interpreted here; segment bytes are never executed or patched.
 */
export const NSO_HEADER_SIZE = 0x100;
export const NRO_HEADER_SIZE = 0x80;
export const NRO_ASSET_HEADER_SIZE = 0x38;
const NRO_MAGIC_OFFSET = 0x10;

export const SWITCH_SEGMENT_NAMES = ["text", "rodata", "data"] as const;
export type SwitchSegmentName = (typeof SWITCH_SEGMENT_NAMES)[number];

/** NSO flag bits 0-5: per-segment LZ4 compression, then per-segment hash checks. */
const NSO_KNOWN_FLAGS = 0x3f;

const fail = (failure: ParseFailure): Result<never, ParseFailureError> =>
  err(new ParseFailureError(failure));

export interface SwitchExtent {
  readonly offset: number;
  readonly size: number;
}

export interface NsoSegment {
  readonly name: SwitchSegmentName;
  readonly fileOffset: number;
  readonly memoryOffset: number;
  /** Size of the segment once loaded, after any decompression. */
  readonly size: number;
  /** Bytes the segment occupies in the file. */
  readonly fileSize: number;
  readonly compressed: boolean;
  readonly hashChecked: boolean;
  /** SHA-256 the header declares over the loaded segment bytes. */
  readonly sha256: string;
  /** The stored range ends past the end of the file. */
  readonly truncated: boolean;
}

export interface NsoHeader {
  readonly format: "nso";
  readonly version: number;
  readonly flags: number;
  /** Flag bits outside the six that name compression and hash checks. */
  readonly unknownFlags: number;
  readonly moduleId: string;
  readonly bssSize: number;
  readonly embedded: SwitchExtent;
  readonly dynstr: SwitchExtent;
  readonly dynsym: SwitchExtent;
  readonly segments: readonly NsoSegment[];
}

export interface NroSegment {
  readonly name: SwitchSegmentName;
  /** NRO segments are stored uncompressed at their memory offsets. */
  readonly fileOffset: number;
  readonly size: number;
  readonly truncated: boolean;
}

export interface NroHeader {
  readonly format: "nro";
  readonly version: number;
  readonly flags: number;
  /** Total NRO image size; an asset section, when present, starts here. */
  readonly size: number;
  readonly mod0Offset: number;
  readonly moduleId: string;
  readonly bssSize: number;
  readonly embedded: SwitchExtent;
  readonly dynstr: SwitchExtent;
  readonly dynsym: SwitchExtent;
  readonly segments: readonly NroSegment[];
}

export type SwitchAssetName = "icon" | "nacp" | "romfs";

export interface NroAsset {
  readonly name: SwitchAssetName;
  /** Absolute file offset (asset-section offset plus the declared offset). */
  readonly fileOffset: number;
  readonly size: number;
  readonly truncated: boolean;
}

export interface NroAssetSection {
  readonly offset: number;
  readonly version: number;
  /** Declared assets with safe ranges and a non-zero size, in icon, NACP, RomFS order. */
  readonly assets: readonly NroAsset[];
  /** Messages for declared ranges that were skipped. */
  readonly rejected: readonly string[];
}

const ascii = (bytes: Buffer, offset: number, magic: string): boolean =>
  bytes.length >= offset + magic.length &&
  bytes.toString("latin1", offset, offset + magic.length) === magic;

export const hasNsoMagic = (prefix: Buffer): boolean =>
  ascii(prefix, 0, "NSO0");

export const hasNroMagic = (prefix: Buffer): boolean =>
  ascii(prefix, NRO_MAGIC_OFFSET, "NRO0");

const extent = (reader: BinaryReader, at: number): SwitchExtent => ({
  offset: reader.u32(at),
  size: reader.u32(at + 4),
});

/** Parse the 0x100-byte NSO header against the measured file size. */
export const parseNsoHeader = (
  bytes: Buffer,
  fileSize: number,
): Result<NsoHeader, ParseFailureError> => {
  if (!hasNsoMagic(bytes))
    return fail({
      kind: "malformed",
      format: "nso",
      detail: "NSO magic NSO0 is missing",
      offset: 0,
      field: "magic",
    });
  if (bytes.length < NSO_HEADER_SIZE || fileSize < NSO_HEADER_SIZE) {
    const availableBytes = Math.min(bytes.length, fileSize);
    return fail({
      kind: "truncated",
      format: "nso",
      detail: `NSO header is truncated: ${String(availableBytes)} of ${String(NSO_HEADER_SIZE)} bytes`,
      offset: 0,
      field: "header",
      extent: { availableBytes, requiredBytes: NSO_HEADER_SIZE },
    });
  }
  const reader = new BinaryReader(bytes, true, "nso");
  const flags = reader.u32(0x0c);
  const segments = SWITCH_SEGMENT_NAMES.map((name, index): NsoSegment => {
    const at = 0x10 + index * 0x10;
    const compressed = (flags & (1 << index)) !== 0;
    const size = reader.u32(at + 8);
    const fileOffset = reader.u32(at);
    const stored = compressed ? reader.u32(0x60 + index * 4) : size;
    return {
      name,
      fileOffset,
      memoryOffset: reader.u32(at + 4),
      size,
      fileSize: stored,
      compressed,
      hashChecked: (flags & (1 << (index + 3))) !== 0,
      sha256: bytes.toString("hex", 0xa0 + index * 0x20, 0xc0 + index * 0x20),
      truncated: fileOffset + stored > fileSize,
    };
  });
  for (const [index, segment] of segments.entries())
    if (segment.fileOffset < NSO_HEADER_SIZE && segment.fileSize > 0)
      return fail({
        kind: "malformed",
        format: "nso",
        detail: `NSO ${segment.name} segment offset ${String(segment.fileOffset)} overlaps the header`,
        offset: 0x10 + index * 0x10,
        field: `${segment.name}_segment.file_offset`,
      });
  return ok({
    format: "nso",
    version: reader.u32(0x04),
    flags,
    unknownFlags: (flags & ~NSO_KNOWN_FLAGS) >>> 0,
    moduleId: bytes.toString("hex", 0x40, 0x60),
    bssSize: reader.u32(0x3c),
    embedded: extent(reader, 0x88),
    dynstr: extent(reader, 0x90),
    dynsym: extent(reader, 0x98),
    segments,
  });
};

/**
 * Bytes at the start of a loaded text segment that hold the module's MOD0
 * pointer: a branch word, then the MOD0 header offset relative to text.
 */
export const SWITCH_TEXT_PREFIX_SIZE = 8;
const MOD0_MAGIC = "MOD0";

/** The MOD0 offset at text+4, or null when the loaded text is too short. */
export const parseTextMod0Offset = (textPrefix: Buffer): number | null =>
  textPrefix.length < SWITCH_TEXT_PREFIX_SIZE
    ? null
    : new BinaryReader(textPrefix, true, "nso").u32(4);

/**
 * The file range that should hold an NRO's `MOD0` magic. NRO text is stored
 * at file offset 0, so the header's MOD0 offset is a file offset. Undefined
 * when that range ends past the file.
 */
export const nroMod0MagicExtent = (
  header: NroHeader,
  fileSize: number,
): SwitchExtent | undefined =>
  header.mod0Offset + MOD0_MAGIC.length <= fileSize
    ? { offset: header.mod0Offset, size: MOD0_MAGIC.length }
    : undefined;

/** Whether bytes read at a MOD0 offset start with the `MOD0` magic. */
export const hasMod0Magic = (bytes: Buffer): boolean =>
  ascii(bytes, 0, MOD0_MAGIC);

/** Parse the 0x80-byte NRO header against the measured file size. */
export const parseNroHeader = (
  bytes: Buffer,
  fileSize: number,
): Result<NroHeader, ParseFailureError> => {
  if (!hasNroMagic(bytes))
    return fail({
      kind: "malformed",
      format: "nro",
      detail: "NRO magic NRO0 is missing",
      offset: NRO_MAGIC_OFFSET,
      field: "magic",
    });
  if (bytes.length < NRO_HEADER_SIZE || fileSize < NRO_HEADER_SIZE) {
    const availableBytes = Math.min(bytes.length, fileSize);
    return fail({
      kind: "truncated",
      format: "nro",
      detail: `NRO header is truncated: ${String(availableBytes)} of ${String(NRO_HEADER_SIZE)} bytes`,
      offset: 0,
      field: "header",
      extent: { availableBytes, requiredBytes: NRO_HEADER_SIZE },
    });
  }
  const reader = new BinaryReader(bytes, true, "nro");
  const size = reader.u32(0x18);
  if (size < NRO_HEADER_SIZE)
    return fail({
      kind: "malformed",
      format: "nro",
      detail: `NRO declares size ${String(size)}, smaller than its ${String(NRO_HEADER_SIZE)}-byte header`,
      offset: 0x18,
      field: "size",
    });
  const segments = SWITCH_SEGMENT_NAMES.map((name, index): NroSegment => {
    const at = 0x20 + index * 8;
    const fileOffset = reader.u32(at);
    const segmentSize = reader.u32(at + 4);
    return {
      name,
      fileOffset,
      size: segmentSize,
      truncated: fileOffset + segmentSize > fileSize,
    };
  });
  for (const [index, segment] of segments.entries())
    if (segment.fileOffset + segment.size > size)
      return fail({
        kind: "malformed",
        format: "nro",
        detail: `NRO ${segment.name} segment ends at ${String(segment.fileOffset + segment.size)}, past the declared image size ${String(size)}`,
        offset: 0x20 + index * 8,
        field: `${segment.name}_segment`,
      });
  return ok({
    format: "nro",
    version: reader.u32(0x14),
    flags: reader.u32(0x1c),
    size,
    mod0Offset: reader.u32(0x04),
    moduleId: bytes.toString("hex", 0x40, 0x60),
    bssSize: reader.u32(0x38),
    embedded: extent(reader, 0x68),
    dynstr: extent(reader, 0x70),
    dynsym: extent(reader, 0x78),
    segments,
  });
};

/**
 * Parse an NRO `ASET` header read at `offset`. Returns undefined when the
 * bytes there do not start with `ASET`, so a plain NRO stays asset-free.
 */
export const parseNroAssetSection = (
  bytes: Buffer,
  offset: number,
  fileSize: number,
): Result<NroAssetSection | undefined, ParseFailureError> => {
  if (!ascii(bytes, 0, "ASET")) return ok(undefined);
  if (bytes.length < NRO_ASSET_HEADER_SIZE)
    return fail({
      kind: "truncated",
      format: "nro",
      detail: `NRO asset header is truncated: ${String(bytes.length)} of ${String(NRO_ASSET_HEADER_SIZE)} bytes`,
      offset,
      field: "asset_header",
      extent: {
        availableBytes: bytes.length,
        requiredBytes: NRO_ASSET_HEADER_SIZE,
      },
    });
  const reader = new BinaryReader(bytes, true, "nro");
  const assets: NroAsset[] = [];
  const rejected: string[] = [];
  const names: readonly SwitchAssetName[] = ["icon", "nacp", "romfs"];
  for (const [index, name] of names.entries()) {
    const at = 0x08 + index * 0x10;
    const relative = reader.word(at, 64);
    const size = reader.word(at + 8, 64);
    if (size === 0n) continue;
    const absolute = BigInt(offset) + relative;
    if (absolute + size > BigInt(Number.MAX_SAFE_INTEGER)) {
      rejected.push(`NRO ${name} asset range exceeds a safe file offset`);
      continue;
    }
    const fileOffset = Number(absolute);
    const assetSize = Number(size);
    assets.push({
      name,
      fileOffset,
      size: assetSize,
      truncated: fileOffset + assetSize > fileSize,
    });
  }
  return ok({ offset, version: reader.u32(0x04), assets, rejected });
};
