import { BinaryReader } from "../domain/binaryContainer.js";
import { Buffer } from "node:buffer";
import {
  absoluteOffset,
  isWindowUniform,
  sliceRegion,
  type ScanRegion,
} from "./UefiBytes.js";
import { formatGuidLittleEndian } from "./UefiGuid.js";
import {
  FV_ATTRIBUTE_ERASE_POLARITY,
  FV_HEADER_LAYOUT,
} from "./UefiCodeTables.js";

const FVH_SIGNATURE = 0x4856465f; // "_FVH" read as a little-endian word

export interface FirmwareVolumeBlockMapEntry {
  readonly numBlocks: number;
  readonly blockLength: number;
}

/** Verified-or-rejected firmware volume header observation. */
export interface FirmwareVolumeHeader {
  readonly localBase: number;
  readonly absoluteBase: number;
  readonly declaredLength: number;
  readonly headerLength: number;
  readonly attributes: number;
  readonly erasePolarity: boolean;
  readonly extHeaderOffset: number | null;
  readonly revision: number;
  readonly fileSystemGuid: string | null;
  readonly blockMap: readonly FirmwareVolumeBlockMapEntry[];
  readonly checksumValid: boolean;
  /** Plausibility findings that gate the hit; empty when fully plausible. */
  readonly implausibilities: readonly string[];
}

/**
 * Parse one header at a local position. Returns null when the position cannot
 * hold a structurally complete header (bounds or signature); returns header
 * data plus implausibility findings otherwise. Mismatched declared checksums
 * stay an observation, never a rejection.
 */
export function parseFirmwareVolumeHeader(
  region: ScanRegion,
  localHeaderBase: number,
  reserve: () => boolean = () => true,
): FirmwareVolumeHeader | null {
  const available = region.end - localHeaderBase;
  if (
    localHeaderBase < region.start ||
    available < FV_HEADER_LAYOUT.minimumLength ||
    localHeaderBase + FV_HEADER_LAYOUT.minimumLength > region.end
  ) {
    return null;
  }
  const reader = new BinaryReader(region.buffer, true, "UEFI firmware volume");
  const signature = reader.u32(
    localHeaderBase + FV_HEADER_LAYOUT.signatureOffset,
  );
  if (signature !== FVH_SIGNATURE) {
    return null;
  }
  const absoluteBase = absoluteOffset(region, localHeaderBase);
  const headerLength = reader.u16(
    localHeaderBase + FV_HEADER_LAYOUT.headerLengthOffset,
  );
  const attributes = reader.u32(
    localHeaderBase + FV_HEADER_LAYOUT.attributesOffset,
  );
  const revision =
    region.buffer[localHeaderBase + FV_HEADER_LAYOUT.revisionOffset] ?? 0;
  const extHeaderRaw = reader.u16(
    localHeaderBase + FV_HEADER_LAYOUT.extHeaderOffsetOffset,
  );
  const declaredLengthValue = reader.word(
    localHeaderBase + FV_HEADER_LAYOUT.fvLengthOffset,
    64,
  );
  const declaredLength = Number(declaredLengthValue);
  const implausibilities: string[] = [];
  if (
    !Number.isSafeInteger(declaredLength) ||
    declaredLengthValue > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return null;
  }
  if (headerLength < FV_HEADER_LAYOUT.minimumLength || headerLength % 2 !== 0) {
    implausibilities.push("header-length-implausible");
  }
  if (declaredLength < FV_HEADER_LAYOUT.minimumLength) {
    implausibilities.push("declared-length-implausible");
  }
  if (localHeaderBase + declaredLength > region.end) {
    implausibilities.push("declared-length-truncates-region");
  }
  if (
    headerLength > FV_HEADER_LAYOUT.minimumLength &&
    localHeaderBase + headerLength > region.end
  ) {
    implausibilities.push("header-length-truncates-region");
  }

  const blockMap: FirmwareVolumeBlockMapEntry[] = [];
  const blockMapCapacity = Math.floor(
    (headerLength - FV_HEADER_LAYOUT.blockMapOffset) /
      FV_HEADER_LAYOUT.blockMapEntryLength,
  );
  let blockMapTerminated = false;
  for (let index = 0; index < blockMapCapacity; index += 1) {
    const entryLocal =
      localHeaderBase +
      FV_HEADER_LAYOUT.blockMapOffset +
      index * FV_HEADER_LAYOUT.blockMapEntryLength;
    if (entryLocal + FV_HEADER_LAYOUT.blockMapEntryLength > region.end) {
      implausibilities.push("block-map-truncation");
      break;
    }
    const numBlocks = reader.u32(entryLocal);
    const blockLength = reader.u32(entryLocal + 4);
    if (numBlocks === 0 && blockLength === 0) {
      blockMapTerminated = true;
      break;
    }
    if (!reserve()) return null;
    blockMap.push({ numBlocks, blockLength });
  }
  if (!blockMapTerminated) {
    implausibilities.push("block-map-terminator-missing");
  }
  const mapped = blockMap.reduce(
    (total, entry) => total + entry.numBlocks * entry.blockLength,
    0,
  );
  if (mapped > declaredLength) {
    implausibilities.push("block-map-exceeds-volume");
  }

  const checksumValid =
    localHeaderBase + headerLength <= region.end &&
    verifyFirmwareVolumeChecksum(region.buffer, localHeaderBase, headerLength);
  const fileSystemGuidRaw = sliceRegion(
    region,
    absoluteOffset(region, localHeaderBase) +
      FV_HEADER_LAYOUT.fileSystemGuidOffset,
    16,
  );
  return {
    localBase: localHeaderBase,
    absoluteBase,
    declaredLength,
    headerLength,
    attributes,
    erasePolarity: (attributes & FV_ATTRIBUTE_ERASE_POLARITY) !== 0,
    extHeaderOffset: extHeaderRaw === 0 ? null : extHeaderRaw,
    revision,
    fileSystemGuid:
      fileSystemGuidRaw == null
        ? null
        : formatGuidLittleEndian(fileSystemGuidRaw, 0),
    blockMap,
    checksumValid,
    implausibilities,
  };
}

/** Sum of 16-bit header words must reach zero (mod 2^16). */
function verifyFirmwareVolumeChecksum(
  buffer: Buffer,
  localHeaderBase: number,
  headerLength: number,
): boolean {
  if (
    headerLength % 2 !== 0 ||
    localHeaderBase + headerLength > buffer.length
  ) {
    return false;
  }
  const checksumReader = new BinaryReader(buffer, true, "UEFI firmware volume");
  let total = 0;
  for (let offset = 0; offset < headerLength; offset += 2) {
    total = (total + checksumReader.u16(localHeaderBase + offset)) & 0xffff;
  }
  return total === 0;
}

export interface FirmwareVolumeHit {
  readonly header: FirmwareVolumeHeader;
}

export interface RejectedFirmwareVolumeHit {
  readonly absoluteBase: number;
  readonly signatureLocal: number;
  readonly reason: string;
}

export interface FirmwareVolumeScanResult {
  readonly volumes: readonly FirmwareVolumeHit[];
  readonly rejected: readonly RejectedFirmwareVolumeHit[];
  readonly exhausted: boolean;
}

/**
 * Scan one region for aligned `_FVH` hits and keep structurally plausible
 * headers. Signature hits that fail plausibility return as rejections with
 * their reason; they are never silently dropped.
 */
export function scanFirmwareVolumes(
  region: ScanRegion,
  maxCandidates: number,
  options: {
    readonly reserve?: () => boolean;
    readonly skipNested?: boolean;
  } = {},
): FirmwareVolumeScanResult {
  const volumes: FirmwareVolumeHit[] = [];
  const rejected: RejectedFirmwareVolumeHit[] = [];
  const signatureText = Buffer.from("_FVH", "ascii");
  let searchFrom = region.start;
  const searchable = region.buffer.subarray(0, region.end);
  let exhausted = false;
  while (searchFrom < region.end) {
    const hitLocal = searchable.indexOf(signatureText, searchFrom);
    if (hitLocal < 0 || hitLocal + 4 > region.end) {
      break;
    }
    if (
      volumes.length + rejected.length >= maxCandidates ||
      options.reserve?.() === false
    ) {
      exhausted = true;
      break;
    }
    searchFrom = hitLocal + 1;
    const headerLocal = hitLocal - FV_HEADER_LAYOUT.signatureOffset;
    if (headerLocal < region.start) {
      rejected.push({
        absoluteBase: Math.max(
          0,
          absoluteOffset(region, hitLocal) - FV_HEADER_LAYOUT.signatureOffset,
        ),
        signatureLocal: hitLocal,
        reason: "header-precedes-region-start",
      });
      continue;
    }
    const header = parseFirmwareVolumeHeader(
      region,
      headerLocal,
      options.reserve,
    );
    if (header == null) {
      rejected.push({
        absoluteBase:
          absoluteOffset(region, hitLocal) - FV_HEADER_LAYOUT.signatureOffset,
        signatureLocal: hitLocal,
        reason: "header-unparseable",
      });
      continue;
    }
    if (header.implausibilities.length > 0) {
      rejected.push({
        absoluteBase: header.absoluteBase,
        signatureLocal: hitLocal,
        reason: header.implausibilities[0] ?? "implausible-header",
      });
      continue;
    }
    volumes.push({ header });
    if (options.skipNested) {
      // Nested search belongs to the accepted volume's file and section walkers.
      searchFrom = Math.max(searchFrom, headerLocal + header.declaredLength);
    }
  }
  return { volumes, rejected, exhausted };
}

/** Read the FFS extended header FvName GUID when an ext header pad file exists. */
export function readExtendedHeaderFvName(
  region: ScanRegion,
  header: FirmwareVolumeHeader,
): string | null {
  if (header.extHeaderOffset == null) {
    return null;
  }
  const extHeaderLocal = header.localBase + header.extHeaderOffset;
  const guidLocal = extHeaderLocal;
  if (guidLocal + 16 > region.end) {
    return null;
  }
  return formatGuidLittleEndian(
    region.buffer.subarray(guidLocal, guidLocal + 16),
    0,
  );
}

/** Erase byte implied by the volume's erase polarity. */
export function createFvEraseByte(header: FirmwareVolumeHeader): number {
  return header.erasePolarity ? 0xff : 0x00;
}

/** Erase polarity 1: erased media bits are one (0xFF); otherwise zero (0x00). */
export function createEraseByte(erasePolarity: boolean): number {
  return erasePolarity ? 0xff : 0x00;
}

/** True when the window is fully erased for the given polarity. */
export function isErasedWindow(
  buffer: Buffer,
  start: number,
  end: number,
  erasePolarity: boolean,
): boolean {
  return isWindowUniform(buffer, start, end, createEraseByte(erasePolarity));
}
