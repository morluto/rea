import { BinaryReader } from "../domain/binaryContainer.js";
import { Buffer } from "node:buffer";
import {
  absoluteOffset,
  alignUp,
  isWindowUniform,
  type ScanRegion,
} from "./UefiBytes.js";
import { formatGuidLittleEndian, GUID_LENGTH } from "./UefiGuid.js";
import {
  COMPRESSION_GUID_BY_DISPLAY,
  OPAQUE_GUIDED_SECTION_GUIDS,
  SECTION_LAYOUT,
} from "./UefiCodeTables.js";

const GUIDED_PROCESSING_REQUIRED = 0x01;
const GUIDED_AUTH_STATUS_VALID = 0x02;
const GUIDED_KNOWN_ATTRIBUTES =
  GUIDED_PROCESSING_REQUIRED | GUIDED_AUTH_STATUS_VALID;

export type UefiDecodeFormat = "lzma" | "lzmaf86" | "zlib";

type SectionContent =
  | { kind: "leaf" | "ui" | "volume" }
  | { kind: "stored-sections"; guidedIntegrityUnchecked: boolean }
  | { kind: "decode"; format: UefiDecodeFormat }
  | {
      kind: "unsupported";
      gap:
        | "unknown-guid-handler"
        | "unsupported-compression"
        | "unparsed-region";
      detail?: string;
    };

/** Raw section observation before nesting resolution. */
export interface SectionDraft {
  readonly absoluteBase: number;
  readonly headerLength: number;
  readonly declaredLength: number;
  /** Bytes actually covered inside the region (clamped on truncation). */
  readonly observedLength: number;
  readonly truncated: boolean;
  readonly malformed: boolean;
  readonly framingIssue?: string;
  readonly content: SectionContent;
  readonly typeCode: number;
  readonly compression:
    | { readonly kind: "none" }
    | {
        readonly kind:
          | "lzma-custom"
          | "lzmaf86"
          | "ami-zlib"
          | "tiano"
          | "unknown-compression"
          | "efi-standard"
          | "crc32-guided"
          | "unknown-guid";
        readonly guid: string | null;
        readonly dataOffset: number;
        readonly attributes: number | null;
      };
  /** Observed payload window, if the complete header has a valid extent. */
  readonly payload: { readonly start: number; readonly end: number } | null;
}

function readCommonHeader(reader: BinaryReader, start: number, end: number) {
  if (start + SECTION_LAYOUT.commonLength > end) return null;
  const compactSize = reader.u16(start) | (reader.u8(start + 2) << 16);
  const extended = compactSize === SECTION_LAYOUT.largeSectionMarker;
  const commonLength = extended
    ? SECTION_LAYOUT.extendedLength
    : SECTION_LAYOUT.commonLength;
  if (start + commonLength > end) return null;
  return {
    commonLength,
    declaredLength: extended
      ? reader.u32(start + SECTION_LAYOUT.extendedSizeOffset)
      : compactSize,
    typeCode: reader.u8(start + SECTION_LAYOUT.typeOffset),
  };
}

/** A bounded first frame establishes a section chain regardless of payload validity. */
export function startsWithSectionFrame(region: ScanRegion): boolean {
  const reader = new BinaryReader(region.buffer, true, "FFS sections");
  return hasBoundedFrame(reader, region.start, region.end);
}

function hasBoundedFrame(
  reader: BinaryReader,
  start: number,
  end: number,
): boolean {
  const header = readCommonHeader(reader, start, end);
  return (
    header !== null &&
    header.declaredLength >= header.commonLength &&
    header.declaredLength <= end - start
  );
}

function guidedSectionContent(
  reader: BinaryReader,
  {
    kind,
    guid,
    attributes,
  }: {
    kind: (typeof COMPRESSION_GUID_BY_DISPLAY)[string] | "unknown-guid";
    guid: string | null;
    attributes: number;
  },
  start: number,
  end: number,
): SectionContent {
  const reservedAttributes = attributes & ~GUIDED_KNOWN_ATTRIBUTES;
  if (reservedAttributes !== 0)
    return {
      kind: "unsupported",
      gap: "unparsed-region",
      detail: `GUID-defined header uses reserved attribute bits 0x${reservedAttributes.toString(16)}.`,
    };

  if (kind === "lzma-custom") return { kind: "decode", format: "lzma" };
  if (kind === "lzmaf86") return { kind: "decode", format: "lzmaf86" };
  if (kind === "ami-zlib") return { kind: "decode", format: "zlib" };

  if (
    (attributes & GUIDED_PROCESSING_REQUIRED) === 0 &&
    (kind === "crc32-guided" ||
      (kind === "unknown-guid" &&
        guid !== null &&
        !OPAQUE_GUIDED_SECTION_GUIDS.has(guid) &&
        hasBoundedFrame(reader, start, end)))
  )
    return {
      kind: "stored-sections",
      guidedIntegrityUnchecked:
        kind === "crc32-guided" ||
        (attributes & GUIDED_AUTH_STATUS_VALID) !== 0,
    };

  return {
    kind: "unsupported",
    gap:
      kind === "unknown-guid"
        ? "unknown-guid-handler"
        : "unsupported-compression",
  };
}

/** Read one PI section chain, with each child aligned relative to its stream. */
export function walkSections(
  region: ScanRegion,
  reserve: () => boolean = () => true,
  largeFile = true,
): {
  sections: SectionDraft[];
  nonzeroPadding: { start: number; end: number }[];
  remainder: { kind: "limited" | "unparsed"; start: number } | null;
} {
  const reader = new BinaryReader(region.buffer, true, "FFS sections");
  const sections: SectionDraft[] = [];
  const nonzeroPadding: { start: number; end: number }[] = [];
  const { start: localStart, end: localEnd } = region;
  let cursor = localStart;
  while (cursor < localEnd) {
    const header = readCommonHeader(reader, cursor, localEnd);
    if (header === null) break;
    if (!reserve())
      return {
        sections,
        nonzeroPadding,
        remainder: { kind: "limited", start: cursor },
      };
    const { commonLength, declaredLength, typeCode } = header;
    // Even an undersized declaration has a common header we already observed.
    const observedLength = Math.max(
      commonLength,
      Math.min(declaredLength, localEnd - cursor),
    );
    const truncated = observedLength < declaredLength;
    let headerLength: number = commonLength;
    let compression: SectionDraft["compression"] = { kind: "none" };
    let content: SectionContent = { kind: "leaf" };
    if (typeCode === 0x03)
      content = { kind: "stored-sections", guidedIntegrityUnchecked: false };
    else if (typeCode === 0x15) content = { kind: "ui" };
    else if (typeCode === 0x17) content = { kind: "volume" };
    let malformed = declaredLength < commonLength;
    const fields = cursor + commonLength;

    if (typeCode === 0x01) {
      headerLength += SECTION_LAYOUT.compressionFieldsLength;
      malformed = declaredLength < headerLength;
      if (observedLength >= headerLength) {
        const compressionType = reader.u8(
          fields + SECTION_LAYOUT.compressionTypeFieldOffset,
        );
        if (compressionType === 0) {
          content = {
            kind: "stored-sections",
            guidedIntegrityUnchecked: false,
          };
          malformed = reader.u32(fields) !== declaredLength - headerLength;
        } else {
          content = { kind: "unsupported", gap: "unsupported-compression" };
          compression = {
            kind:
              compressionType === 1 ? "efi-standard" : "unknown-compression",
            guid: null,
            dataOffset: headerLength,
            attributes: null,
          };
        }
      }
    } else if (typeCode === 0x02) {
      headerLength += SECTION_LAYOUT.guidedFieldsLength;
      malformed = declaredLength < headerLength;
      if (observedLength >= headerLength) {
        const dataOffset = reader.u16(
          fields + SECTION_LAYOUT.guidDataOffsetFieldOffset,
        );
        const guid = formatGuidLittleEndian(region.buffer, fields);
        const attributes = reader.u16(
          fields + SECTION_LAYOUT.guidAttributesFieldOffset,
        );
        const kind =
          guid === null
            ? "unknown-guid"
            : (COMPRESSION_GUID_BY_DISPLAY[guid] ?? "unknown-guid");
        compression = { kind, guid, dataOffset, attributes };
        if (kind === "crc32-guided") {
          headerLength += SECTION_LAYOUT.guidedCrc32Length;
        }
        malformed = dataOffset < headerLength || dataOffset > declaredLength;
        if (!malformed) {
          headerLength = dataOffset;
          content = guidedSectionContent(
            reader,
            { kind, guid, attributes },
            cursor + dataOffset,
            cursor + observedLength,
          );
        }
      }
    } else if (typeCode === 0x14 || typeCode === 0x18) {
      headerLength += typeCode === 0x14 ? 2 : GUID_LENGTH;
      malformed = declaredLength < headerLength;
    }

    let framingIssue: string | undefined;
    if (typeCode === 0)
      framingIssue = "Section type 0x00 is a section retrieval wildcard.";
    if (commonLength === SECTION_LAYOUT.extendedLength) {
      // The marker is reserved in the compact header and cannot encode a length.
      if (declaredLength < SECTION_LAYOUT.largeSectionMarker)
        framingIssue = "Extended section size fits in the compact PI header.";
      else if (!largeFile)
        framingIssue = "Extended section header requires a large FFS file.";
    }
    malformed ||= framingIssue !== undefined;

    sections.push({
      absoluteBase: absoluteOffset(region, cursor),
      headerLength,
      declaredLength,
      observedLength,
      truncated,
      malformed,
      ...(framingIssue === undefined ? {} : { framingIssue }),
      content,
      typeCode,
      compression,
      payload:
        malformed || headerLength > observedLength
          ? null
          : { start: cursor + headerLength, end: cursor + observedLength },
    });
    if (truncated) return { sections, nonzeroPadding, remainder: null };
    if (declaredLength < commonLength) {
      cursor += commonLength;
      break;
    }
    const end = cursor + declaredLength;
    cursor = localStart + alignUp(end - localStart, 4);
    const paddingEnd = Math.min(cursor, localEnd);
    if (end < paddingEnd && !isWindowUniform(region.buffer, end, paddingEnd, 0))
      nonzeroPadding.push({ start: end, end: paddingEnd });
  }
  return {
    sections,
    nonzeroPadding,
    remainder: cursor < localEnd ? { kind: "unparsed", start: cursor } : null,
  };
}

/**
 * EFI_AMD_ZLIB_SECTION_HEADER (UEFITool ffs.h): a 0x100-byte header —
 * 0x14 zero bytes, CompressedSize u32 LE, 0xE8 zero footer — sits between the
 * GUID-defined header and the zlib-wrapped stream at payload offset 0x100.
 */
export const AMD_ZLIB_HEADER_LENGTH = 0x100;

/** Peel the 0x100-byte AMD header off one ami-zlib payload, or null when short. */
export function peelAmiZlibPayload(
  payload: Buffer,
): { stream: Buffer; declaredCompressedSize: number } | null {
  if (payload.length < AMD_ZLIB_HEADER_LENGTH) {
    return null;
  }
  const payloadReader = new BinaryReader(payload, true, "AMD zlib section");
  return {
    stream: payload.subarray(AMD_ZLIB_HEADER_LENGTH),
    declaredCompressedSize: payloadReader.u32(0x14),
  };
}
