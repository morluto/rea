import { BinaryReader } from "../domain/binaryContainer.js";
import { Buffer } from "node:buffer";
import {
  absoluteOffset,
  alignUp,
  isWindowUniform,
  type ScanRegion,
} from "./UefiBytes.js";
import { formatGuidLittleEndian } from "./UefiGuid.js";
import { FFS_ATTRIBUTE_MASKS, FFS_HEADER_LAYOUT } from "./UefiCodeTables.js";

const FFS_DATA_ALIGNMENT_EXPONENTS = [0, 4, 7, 9, 10, 12, 15, 16] as const;

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
  readonly observedLength: number;
  readonly body: { readonly start: number; readonly end: number } | null;
  readonly extentIssue:
    | "unusable-header-state"
    | "declared-length-below-header"
    | "declared-length-truncates-region"
    | null;
  readonly nameGuid: string | null;
  readonly typeCode: number;
  readonly attributes: number;
  readonly dataAlignment: number;
  readonly rawState: number;
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
  if (largeFile) {
    const reader = new BinaryReader(region.buffer, true, "FFS file");
    if (!extended) return null;
    headerLength = FFS_HEADER_LAYOUT.extendedLength;
    const size = reader.word(
      localBase + FFS_HEADER_LAYOUT.extendedSizeOffset,
      64,
    );
    if (size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    declaredLength = Number(size);
    if (declaredCompact !== 0)
      implausibilities.push("large-file-compact-size-is-nonzero");
  }
  const rawState =
    region.buffer[localBase + FFS_HEADER_LAYOUT.stateOffset] ?? 0;
  const normalizedState = erasePolarity ? ~rawState & 0x3f : rawState & 0x3f;
  const stateFlags = STATE_BIT_NAMES.filter(
    ([bit]) => (normalizedState & bit) !== 0,
  ).map(([, name]) => name);
  // PI state is the highest set bit. An incomplete or invalid header supplies
  // only its fixed extent; the stored size cannot consume the next file.
  const state = stateFlags.at(-1);
  const unusableState =
    state === "header-construction" || state === "header-invalid";
  const extentIssue = unusableState
    ? "unusable-header-state"
    : declaredLength < headerLength
      ? "declared-length-below-header"
      : declaredLength > available
        ? "declared-length-truncates-region"
        : null;
  if (extentIssue !== null) implausibilities.push(extentIssue);
  const observedLength = unusableState
    ? headerLength
    : Math.min(Math.max(declaredLength, headerLength), available);

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
    observedLength,
    body:
      extentIssue === null || extentIssue === "declared-length-truncates-region"
        ? { start: localBase + headerLength, end: localBase + observedLength }
        : null,
    extentIssue,
    nameGuid: formatGuidLittleEndian(
      region.buffer.subarray(localBase, localBase + 16),
      0,
    ),
    typeCode: region.buffer[localBase + FFS_HEADER_LAYOUT.typeOffset] ?? 0,
    attributes,
    dataAlignment:
      2 **
      ((attributes & FFS_ATTRIBUTE_MASKS.dataAlignment2) !== 0
        ? 17 + ((attributes & FFS_ATTRIBUTE_MASKS.dataAlignment) >> 3)
        : (FFS_DATA_ALIGNMENT_EXPONENTS[
            (attributes & FFS_ATTRIBUTE_MASKS.dataAlignment) >> 3
          ] ?? 0)),
    rawState,
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

/** Check the declared checksum only when the full file body is available. */
export function checkFfsFileData(region: ScanRegion, header: FfsFileHeader) {
  if (header.typeCode === 0xf0)
    return { verdict: "pad-file-unchecked" } as const;
  if (
    header.extentIssue !== null ||
    !header.fileChecksumRequired ||
    header.body === null
  )
    return { verdict: "unchecked" } as const;
  const { start, end } = header.body;
  const length = end - start;
  if (length === 0) return { verdict: "unchecked" } as const;
  let total = header.fileChecksumField;
  for (const byte of region.buffer.subarray(start, end)) {
    total = (total + byte) & 0xff;
  }
  return total === 0
    ? ({ verdict: "valid" } as const)
    : ({
        verdict: "invalid",
        offset: absoluteOffset(region, start),
        length,
      } as const);
}

/** Advance to the next 8-aligned FFS position after the observed extent. */
export function nextFfsFileLocal(
  header: FfsFileHeader,
  volumeBase: number,
): number {
  return (
    volumeBase +
    alignUp(header.localBase + header.observedLength - volumeBase, 8)
  );
}

type FfsHeaderRead =
  | { readonly kind: "end" }
  | { readonly kind: "limited" }
  | {
      readonly kind: "unparsed";
      readonly offset: number;
      readonly length: number;
    }
  | { readonly kind: "file"; readonly header: FfsFileHeader };

/** Distinguish an erased tail from bytes the FFS walk cannot interpret. */
export function readFfsHeader(
  region: ScanRegion,
  local: number,
  erasePolarity: boolean,
  reserve: () => boolean = () => true,
): FfsHeaderRead {
  if (local >= region.end) return { kind: "end" };
  const erase = erasePolarity ? 0xff : 0;
  const prefixEnd = Math.min(local + FFS_HEADER_LAYOUT.length, region.end);
  if (isWindowUniform(region.buffer, local, prefixEnd, erase)) {
    if (
      prefixEnd === region.end ||
      isWindowUniform(region.buffer, prefixEnd, region.end, erase)
    )
      return { kind: "end" };
  } else {
    if (!reserve()) return { kind: "limited" };
    const header = parseFfsFileHeader(region, local, erasePolarity);
    if (header !== null) return { kind: "file", header };
  }
  return {
    kind: "unparsed",
    offset: absoluteOffset(region, local),
    length: region.end - local,
  };
}
