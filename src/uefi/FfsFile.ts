import { BinaryReader } from "../domain/binaryContainer.js";
import { Buffer } from "node:buffer";
import { byteToHex } from "../kernel/byteToHex.js";
import {
  absoluteOffset,
  alignUp,
  isWindowUniform,
  type ScanRegion,
} from "./UefiBytes.js";
import { formatGuidLittleEndian } from "./UefiGuid.js";
import type { FirmwareVolumeHeader } from "./FirmwareVolume.js";
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
  readonly bodyIssue: "data-not-valid" | null;
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

interface UnrepresentableFfsExtent {
  readonly kind: "unrepresentable";
  readonly size: bigint;
  readonly unusableState: "header-construction" | "header-invalid" | null;
}

interface UnconfirmedFfsState {
  readonly kind: "unconfirmed-state";
  readonly rawState: number;
}

/**
 * Parse one FFS header at a local position; null when framing is unconfirmed.
 * Checksum findings are observations on the header,
 * not rejections — invalid files stay in the inventory with their notes.
 */
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const ffsFileReaders = new WeakMap<Buffer, BinaryReader>();

function ffsFileReader(buffer: Buffer): BinaryReader {
  let reader = ffsFileReaders.get(buffer);
  if (reader === undefined) {
    reader = new BinaryReader(buffer, true, "FFS file");
    ffsFileReaders.set(buffer, reader);
  }
  return reader;
}

export function parseFfsFileHeader(
  region: ScanRegion,
  localBase: number,
  erasePolarity: boolean,
): FfsFileHeader | null {
  const parsed = observeFfsFileHeader(region, localBase, erasePolarity);
  return parsed !== null && !("kind" in parsed) ? parsed : null;
}

function observeFfsFileHeader(
  region: ScanRegion,
  localBase: number,
  erasePolarity: boolean,
): FfsFileHeader | UnrepresentableFfsExtent | UnconfirmedFfsState | null {
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
  const rawState =
    region.buffer[localBase + FFS_HEADER_LAYOUT.stateOffset] ?? 0;
  const normalizedState = erasePolarity ? ~rawState & 0x3f : rawState & 0x3f;
  const stateFlags = STATE_BIT_NAMES.filter(
    ([bit]) => (normalizedState & bit) !== 0,
  ).map(([, name]) => name);
  // PI state is the highest set bit. An incomplete or invalid header supplies
  // only its fixed extent; the stored size cannot consume the next file.
  const state = stateFlags.at(-1);
  if (state === undefined) return { kind: "unconfirmed-state", rawState };
  const unusableState =
    state === "header-construction" || state === "header-invalid"
      ? state
      : null;

  let headerLength: number = FFS_HEADER_LAYOUT.length;
  let declaredLength = declaredCompact;
  if (largeFile) {
    if (!extended) return null;
    const reader = ffsFileReader(region.buffer);
    headerLength = FFS_HEADER_LAYOUT.extendedLength;
    const size = reader.word(
      localBase + FFS_HEADER_LAYOUT.extendedSizeOffset,
      64,
    );
    if (size > MAX_SAFE_INTEGER_BIGINT)
      return { kind: "unrepresentable", size, unusableState };
    declaredLength = Number(size);
    if (declaredCompact !== 0)
      implausibilities.push("large-file-compact-size-is-nonzero");
  }
  const extentIssue =
    unusableState !== null
      ? "unusable-header-state"
      : declaredLength < headerLength
        ? "declared-length-below-header"
        : declaredLength > available
          ? "declared-length-truncates-region"
          : null;
  if (extentIssue !== null) implausibilities.push(extentIssue);
  const observedLength =
    unusableState !== null
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
    bodyIssue: state === "header-valid" ? "data-not-valid" : null,
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

/** Check the file's fixed integrity marker or its declared body checksum. */
export function checkFfsFileIntegrity(
  region: ScanRegion,
  header: FfsFileHeader,
) {
  if (header.typeCode === 0xf0)
    return { verdict: "pad-file-unchecked" } as const;
  if (
    header.extentIssue !== null ||
    header.bodyIssue !== null ||
    header.body === null
  )
    return { verdict: "unchecked" } as const;
  if (!header.fileChecksumRequired) {
    if (header.fileChecksumField === 0xaa)
      return { verdict: "unchecked" } as const;
    return {
      verdict: "invalid",
      offset: header.absoluteBase + FFS_HEADER_LAYOUT.integrityCheckOffset + 1,
      length: 1,
      detail: `FFS IntegrityCheck.File is 0x${byteToHex(header.fileChecksumField)}. PI requires 0xaa when the file checksum attribute is clear.`,
    } as const;
  }
  const { start, end } = header.body;
  const length = end - start;
  if (length === 0) return { verdict: "unchecked" } as const;
  let total = header.fileChecksumField;
  const buffer = region.buffer;
  for (let i = start; i < end; i += 1) {
    total = (total + buffer[i]!) & 0xff;
  }
  return total === 0
    ? ({ verdict: "valid" } as const)
    : ({
        verdict: "invalid",
        offset: absoluteOffset(region, start),
        length,
        detail:
          "File data checksum differs from the declared IntegrityCheck.File byte.",
      } as const);
}

export interface FfsPaddingRange {
  readonly offset: number;
  readonly length: number;
}

/** Identify a bounded FFS alignment span whose bytes differ from erase polarity. */
export function unexpectedFfsPadding(
  region: ScanRegion,
  start: number,
  end: number,
  erasePolarity: boolean,
): FfsPaddingRange | null {
  const boundedEnd = Math.min(end, region.end);
  if (
    start >= boundedEnd ||
    isWindowUniform(region.buffer, start, boundedEnd, erasePolarity ? 0xff : 0)
  )
    return null;
  return { offset: absoluteOffset(region, start), length: boundedEnd - start };
}

type FfsHeaderRead =
  | { readonly kind: "end" }
  | { readonly kind: "limited" }
  | {
      readonly kind: "unparsed";
      readonly offset: number;
      readonly length: number;
      readonly detail?: string;
    }
  | {
      readonly kind: "unusable-header";
      readonly offset: number;
      readonly length: number;
      readonly nextLocal: number;
      readonly detail: string;
    }
  | {
      readonly kind: "file";
      readonly header: FfsFileHeader;
      readonly nextLocal: number;
      readonly padding: FfsPaddingRange | null;
    };

/** Read a file and its alignment within a region starting at the volume base. */
export function readFfsHeader(
  region: ScanRegion,
  local: number,
  {
    erasePolarity,
    fileSystem,
  }: Pick<FirmwareVolumeHeader, "erasePolarity" | "fileSystem">,
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
  } else if (!isWindowUniform(region.buffer, local, prefixEnd, erase ^ 0xff)) {
    if (!reserve()) return { kind: "limited" };
    const header = observeFfsFileHeader(region, local, erasePolarity);
    if (header !== null && "kind" in header) {
      const offset = absoluteOffset(region, local);
      if (header.kind === "unconfirmed-state") {
        return {
          kind: "unparsed",
          offset,
          length: region.end - local,
          detail: `FFS header at 0x${offset.toString(16)} has no recognized state bits (raw State 0x${byteToHex(header.rawState)}). Its declared extent is unconfirmed.`,
        };
      }
      const detail = `FFS ExtendedSize at 0x${offset.toString(16)} declares 0x${header.size.toString(16)} bytes, exceeding exactly representable lengths.`;
      if (header.unusableState === null)
        return { kind: "unparsed", offset, length: region.end - local, detail };
      return {
        kind: "unusable-header",
        offset,
        length: FFS_HEADER_LAYOUT.extendedLength,
        nextLocal: local + FFS_HEADER_LAYOUT.extendedLength,
        detail: `${detail} The ${header.unusableState} state permits advancing by the fixed header extent.`,
      };
    }
    if (header !== null) {
      const end = local + header.observedLength;
      const nextLocal = Math.min(
        region.end,
        region.start + alignUp(end - region.start, 8),
      );
      if (
        fileSystem === "ffs2" &&
        header.headerLength === FFS_HEADER_LAYOUT.extendedLength
      ) {
        const detail = `FFS2 volume contains an FFS3 file header at 0x${header.absoluteBase.toString(16)}.`;
        const fixedHeaderOnly = header.extentIssue === "unusable-header-state";
        if (
          !fixedHeaderOnly &&
          (header.extentIssue !== null ||
            !header.headerChecksumValid ||
            header.declaredLength <= 0xff_ffff ||
            header.implausibilities.includes(
              "large-file-compact-size-is-nonzero",
            ))
        )
          return {
            kind: "unparsed",
            offset: header.absoluteBase,
            length: region.end - local,
            detail: `${detail} Its occupied extent could not be confirmed.`,
          };
        const skipEnd = fixedHeaderOnly ? end : nextLocal;
        return {
          kind: "unusable-header",
          offset: header.absoluteBase,
          length: skipEnd - local,
          nextLocal: skipEnd,
          detail: fixedHeaderOnly
            ? `${detail} Its state permits advancing by the fixed header extent.`
            : detail,
        };
      }
      return {
        kind: "file",
        header,
        nextLocal,
        padding: unexpectedFfsPadding(region, end, nextLocal, erasePolarity),
      };
    }
  }
  return {
    kind: "unparsed",
    offset: absoluteOffset(region, local),
    length: region.end - local,
  };
}
