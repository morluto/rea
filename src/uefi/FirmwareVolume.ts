import { Budget } from "../domain/budget.js";
import { UEFI_FIRMWARE_LIMITS } from "../domain/uefi/uefiLimits.js";
import { BinaryReader } from "../domain/binaryContainer.js";
import { Buffer } from "node:buffer";
import { absoluteOffset, alignUp, type ScanRegion } from "./UefiBytes.js";
import {
  FFS2_FILE_SYSTEM_GUID,
  FFS3_FILE_SYSTEM_GUID,
  formatGuidLittleEndian,
  GUID_LENGTH,
} from "./UefiGuid.js";
import {
  FV_ATTRIBUTE_ERASE_POLARITY,
  FV_HEADER_LAYOUT,
} from "./UefiCodeTables.js";

import { parseFfsFileHeader } from "./FfsFile.js";

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
  readonly firstFileLocal: number;
  readonly attributes: number;
  readonly erasePolarity: boolean;
  readonly extHeaderOffset: number | null;
  readonly revision: number;
  readonly fileSystemGuid: string | null;
  readonly fileSystem: "ffs2" | "ffs3" | "unsupported";
  readonly blockMap: readonly FirmwareVolumeBlockMapEntry[];
  readonly checksumValid: boolean;
  /** Plausibility findings that gate the hit; empty when fully plausible. */
  readonly implausibilities: readonly string[];
}

/** Explain the unparsed body using the exact GUID reported by the header. */
export const unsupportedVolumeBodyReason = (
  header: FirmwareVolumeHeader,
): string =>
  `Firmware volume at 0x${header.absoluteBase.toString(16)} has an unsupported file-system GUID (${header.fileSystemGuid ?? "unavailable"}); its body was not parsed.`;

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

  if (headerLength > declaredLength)
    implausibilities.push("header-exceeds-volume");
  const volumeEnd = localHeaderBase + Math.min(declaredLength, available);
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
    if (entryLocal + FV_HEADER_LAYOUT.blockMapEntryLength > volumeEnd) {
      implausibilities.push("block-map-truncation");
      break;
    }
    const numBlocks = reader.u32(entryLocal);
    const blockLength = reader.u32(entryLocal + 4);
    if (numBlocks === 0 && blockLength === 0) {
      blockMapTerminated = true;
      break;
    }
    if (numBlocks === 0 || blockLength === 0) {
      implausibilities.push("block-map-empty-run");
      break;
    }
    if (!reserve()) return null;
    blockMap.push({ numBlocks, blockLength });
  }
  if (!blockMapTerminated) {
    implausibilities.push("block-map-terminator-missing");
  }
  if (blockMapTerminated) {
    const mapped = blockMap.reduce(
      (total, entry) =>
        total + BigInt(entry.numBlocks) * BigInt(entry.blockLength),
      0n,
    );
    if (mapped !== declaredLengthValue)
      implausibilities.push(
        mapped > declaredLengthValue
          ? "block-map-exceeds-volume"
          : "block-map-shorter-than-volume",
      );
  }

  const erasePolarity = (attributes & FV_ATTRIBUTE_ERASE_POLARITY) !== 0;
  let firstFileLocal = localHeaderBase + alignUp(headerLength, 8);
  if (extHeaderRaw !== 0 && blockMapTerminated) {
    const blockMapEnd =
      FV_HEADER_LAYOUT.blockMapOffset +
      (blockMap.length + 1) * FV_HEADER_LAYOUT.blockMapEntryLength;
    const extStart = localHeaderBase + extHeaderRaw;
    const extMinimumLength = GUID_LENGTH + 4;
    if (
      extHeaderRaw < blockMapEnd ||
      extHeaderRaw % 4 !== 0 ||
      extStart + extMinimumLength > volumeEnd
    ) {
      implausibilities.push("extended-header-offset-implausible");
    } else {
      const extLength = reader.u32(extStart + GUID_LENGTH);
      const extEnd = extStart + extLength;
      if (extLength < extMinimumLength || extEnd > volumeEnd) {
        implausibilities.push("extended-header-length-implausible");
      } else if (extEnd > firstFileLocal) {
        const pad = parseFfsFileHeader(
          { ...region, end: volumeEnd },
          firstFileLocal,
          erasePolarity,
        );
        // GenFv places the extension in a pad file. Preserve that file when
        // its validated body owns the entire extension.
        if (
          pad?.typeCode !== 0xf0 ||
          !pad.headerChecksumValid ||
          pad.extentIssue !== null ||
          pad.body === null ||
          pad.body.start > extStart ||
          pad.body.end < extEnd
        ) {
          firstFileLocal =
            localHeaderBase + alignUp(extEnd - localHeaderBase, 8);
        }
      }
    }
  }
  const checksumValid =
    localHeaderBase + headerLength <= volumeEnd &&
    verifyFirmwareVolumeChecksum(region.buffer, localHeaderBase, headerLength);
  const fileSystemGuid = formatGuidLittleEndian(
    region.buffer,
    localHeaderBase + FV_HEADER_LAYOUT.fileSystemGuidOffset,
  );
  return {
    localBase: localHeaderBase,
    absoluteBase,
    declaredLength,
    headerLength,
    firstFileLocal,
    attributes,
    erasePolarity,
    extHeaderOffset: extHeaderRaw === 0 ? null : extHeaderRaw,
    revision,
    fileSystemGuid,
    fileSystem:
      fileSystemGuid === FFS2_FILE_SYSTEM_GUID
        ? "ffs2"
        : fileSystemGuid === FFS3_FILE_SYSTEM_GUID
          ? "ffs3"
          : "unsupported",
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
  readonly truncation?: {
    readonly declaredLength: number;
    readonly observedLength: number;
  };
}

export interface FirmwareVolumeScanResult {
  readonly volumes: readonly FirmwareVolumeHit[];
  readonly rejected: readonly RejectedFirmwareVolumeHit[];
  readonly limit: "candidates" | "structural-records" | null;
}

/**
 * Scan for `_FVH` hits with a shared reservation for candidate and block-map
 * records. Keep plausible headers and distinguish rejected candidates from a
 * stopped scan. Format admission applies its own alignment check.
 */
export function scanFirmwareVolumes(
  region: ScanRegion,
  maxCandidates: number,
  options: {
    /** Charge a record against the caller's operation-wide budget when supplied. */
    readonly reserve?: () => boolean;
    readonly checkpoint?: () => void;
    readonly skipNested?: boolean;
    readonly signatureEnd?: number;
  } = {},
): FirmwareVolumeScanResult {
  const volumes: FirmwareVolumeHit[] = [];
  const rejected: RejectedFirmwareVolumeHit[] = [];
  const signatureText = Buffer.from("_FVH", "ascii");
  let searchFrom = region.start;
  const signatureEnd = Math.min(region.end, options.signatureEnd ?? region.end);
  const searchable = region.buffer.subarray(0, signatureEnd);
  const budget = new Budget(UEFI_FIRMWARE_LIMITS.scanRecords);
  let limit: FirmwareVolumeScanResult["limit"] = null;
  const reserve = (): boolean => {
    options.checkpoint?.();
    if (options.reserve?.() ?? budget.tryCharge(1)) return true;
    limit = "structural-records";
    return false;
  };
  while (searchFrom < signatureEnd) {
    const hitLocal = searchable.indexOf(signatureText, searchFrom);
    if (hitLocal < 0 || hitLocal + 4 > signatureEnd) {
      break;
    }
    if (volumes.length + rejected.length >= maxCandidates) {
      limit = "candidates";
      break;
    }
    if (!reserve()) break;
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
    const header = parseFirmwareVolumeHeader(region, headerLocal, reserve);
    if (header === null) {
      if (limit !== null) break;
      rejected.push({
        absoluteBase:
          absoluteOffset(region, hitLocal) - FV_HEADER_LAYOUT.signatureOffset,
        signatureLocal: hitLocal,
        reason: "header-unparseable",
      });
      continue;
    }
    const reason = header.implausibilities[0];
    if (reason !== undefined) {
      const truncated =
        reason === "declared-length-truncates-region" ||
        reason === "header-length-truncates-region";
      rejected.push({
        absoluteBase: header.absoluteBase,
        signatureLocal: hitLocal,
        reason,
        ...(truncated
          ? {
              truncation: {
                declaredLength: Math.max(
                  header.declaredLength,
                  header.headerLength,
                ),
                observedLength: region.end - headerLocal,
              },
            }
          : {}),
      });
      continue;
    }
    volumes.push({ header });
    if (options.skipNested || header.fileSystem === "unsupported") {
      // Only supported volume bodies can supply nested candidates.
      searchFrom = Math.max(searchFrom, headerLocal + header.declaredLength);
    }
  }
  return { volumes, rejected, limit };
}
