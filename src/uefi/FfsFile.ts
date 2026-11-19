import { Buffer } from "node:buffer";
import {
  absoluteOffset,
  alignUp,
  isWindowUniform,
  type ScanRegion,
} from "./UefiBytes.js";
import { formatGuidLittleEndian } from "./UefiGuid.js";
import { FFS_ATTRIBUTE_MASKS, FFS_HEADER_LAYOUT } from "./UefiCodeTables.js";

const STATE_BIT_NAMES: readonly (readonly [number, string])[] = [
  [0x01, "header-construction"],
  [0x02, "header-valid"],
  [0x04, "data-valid"],
  [0x08, "marked-for-update"],
  [0x10, "deleted"],
  [0x20, "header-invalid"],
];

/** Normalized FFS file header observation before section walking. */
export interface FfsFileHeader {
  readonly absoluteBase: number;
  readonly localBase: number;
  readonly headerLength: number;
  readonly declaredLength: number;
  readonly nameGuid: string | null;
  readonly typeCode: number;
  readonly attributes: number;
  readonly alignmentExponent: number;
  readonly rawState: number;
  readonly normalizedState: number;
  readonly stateFlags: readonly string[];
  readonly headerChecksumField: number;
  readonly fileChecksumField: number;
  readonly fileChecksumRequired: boolean;
  readonly headerChecksumValid: boolean;
  readonly implausibilities: readonly string[];
}

/**
 * Parse one FFS header at a local position; null when the position cannot
 * hold the minimum header. Checksum findings are observations on the header,
 * not rejections — invalid files stay in the inventory with their notes.
 */
export function parseFfsFileHeader(
  region: ScanRegion,
  localBase: number,
  erasePolarity: boolean,
): FfsFileHeader | null {
  if (
    localBase < region.start ||
    localBase + FFS_HEADER_LAYOUT.length > region.end
  ) {
    return null;
  }
  const available = region.end - localBase;
  const extended = available >= FFS_HEADER_LAYOUT.extendedLength;
  const attributes =
    region.buffer[localBase + FFS_HEADER_LAYOUT.attributesOffset] ?? 0;
  const sizeB0 = region.buffer[localBase + FFS_HEADER_LAYOUT.sizeOffset] ?? 0;
  const sizeB1 =
    region.buffer[localBase + FFS_HEADER_LAYOUT.sizeOffset + 1] ?? 0;
  const sizeB2 =
    region.buffer[localBase + FFS_HEADER_LAYOUT.sizeOffset + 2] ?? 0;
  const declaredCompact = sizeB0 | (sizeB1 << 8) | (sizeB2 << 16);
  const largeFile = (attributes & FFS_ATTRIBUTE_MASKS.largeFile) !== 0;
  const implausibilities: string[] = [];

  let headerLength: number = FFS_HEADER_LAYOUT.length;
  let declaredLength = declaredCompact;
  if (declaredCompact === FFS_HEADER_LAYOUT.largeFileMarker) {
    if (extended && largeFile) {
      headerLength = FFS_HEADER_LAYOUT.extendedLength;
      declaredLength = region.buffer.readUInt32LE(
        localBase + FFS_HEADER_LAYOUT.extendedSizeOffset,
      );
    } else {
      implausibilities.push("large-file-undeclared");
    }
  }
  if (declaredLength < headerLength) {
    implausibilities.push("declared-length-below-header");
  }
  if (localBase + declaredLength > region.end) {
    implausibilities.push("declared-length-truncates-region");
  }

  const rawState =
    region.buffer[localBase + FFS_HEADER_LAYOUT.stateOffset] ?? 0;
  const normalizedState = erasePolarity ? ~rawState & 0x3f : rawState & 0x3f;
  const stateFlags = STATE_BIT_NAMES.filter(
    ([bit]) => (normalizedState & bit) !== 0,
  ).map(([, name]) => name);

  const headerChecksumField =
    region.buffer[localBase + FFS_HEADER_LAYOUT.integrityCheckOffset] ?? 0;
  const fileChecksumField =
    region.buffer[localBase + FFS_HEADER_LAYOUT.integrityCheckOffset + 1] ?? 0;
  const fileChecksumRequired =
    (attributes & FFS_ATTRIBUTE_MASKS.checksumValid) !== 0;
  const headerChecksumValid = verifyFfsHeaderChecksum(
    region.buffer,
    localBase,
    headerLength,
  );

  return {
    absoluteBase: absoluteOffset(region, localBase),
    localBase,
    headerLength,
    declaredLength,
    nameGuid: formatGuidLittleEndian(
      region.buffer.subarray(localBase, localBase + 16),
      0,
    ),
    typeCode: region.buffer[localBase + FFS_HEADER_LAYOUT.typeOffset] ?? 0,
    attributes,
    alignmentExponent: (attributes & FFS_ATTRIBUTE_MASKS.dataAlignment) >> 3,
    rawState,
    normalizedState,
    stateFlags,
    headerChecksumField,
    fileChecksumField,
    fileChecksumRequired,
    headerChecksumValid,
    implausibilities,
  };
}

/**
 * Header checksum: sum of all header bytes with the State byte and the
 * IntegrityCheck.File byte set to zero must reach zero (mod 256).
 */
function verifyFfsHeaderChecksum(
  buffer: Buffer,
  localBase: number,
  headerLength: number,
): boolean {
  let total = 0;
  for (let offset = 0; offset < headerLength; offset += 1) {
    let byte = buffer[localBase + offset] ?? 0;
    if (
      offset === FFS_HEADER_LAYOUT.stateOffset ||
      offset === FFS_HEADER_LAYOUT.integrityCheckOffset + 1
    ) {
      byte = 0;
    }
    total = (total + byte) & 0xff;
  }
  return total === 0;
}

/** File-data checksum applies to the payload only, (sum mod 256). */
export function verifyFfsFileChecksum(
  buffer: Buffer,
  localPayloadStart: number,
  payloadLength: number,
  expected: number,
): boolean {
  let total = 0;
  for (let offset = 0; offset < payloadLength; offset += 1) {
    total = (total + (buffer[localPayloadStart + offset] ?? 0)) & 0xff;
  }
  return total === expected;
}

/** Alignment exponent to byte alignment; capped at exponent 7. */
export function alignmentFor(exponent: number): number {
  return 1 << Math.max(0, Math.min(7, exponent));
}

export interface FfsWalkCursor {
  readonly nextLocal: number;
}

/** First aligned FFS file position after the volume header (volume-relative). */
export function firstFfsFileLocal(volume: {
  readonly localBase: number;
  readonly headerLength: number;
}): number {
  return volume.localBase + alignUp(volume.headerLength, 8);
}

/** Advance to the next 8-aligned FFS position after one file. */
export function nextFfsFileLocal(header: FfsFileHeader): number {
  return alignUp(header.localBase + header.declaredLength, 8);
}

/** True when the header window is uniform in the volume erase byte. */
export function isErasedFfsHeader(
  region: ScanRegion,
  localBase: number,
  erasePolarity: boolean,
): boolean {
  const erase = erasePolarity ? 0xff : 0x00;
  return isWindowUniform(
    region.buffer,
    localBase,
    Math.min(localBase + 24, region.end),
    erase,
  );
}
