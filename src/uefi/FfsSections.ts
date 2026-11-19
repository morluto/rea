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
  SECTION_LAYOUT,
} from "./UefiCodeTables.js";

const GUIDED_PROCESSING_REQUIRED = 0x01;
const GUIDED_AUTH_STATUS_VALID = 0x02;
const SIGNED_SECTION_GUID = "0f9d89e8-9259-4f76-a5af-0c89e34023df";

export type UefiDecodeFormat = "lzma" | "lzmaf86" | "zlib";

type SectionContent =
  | { kind: "leaf" | "ui" | "volume" }
  | { kind: "stored-sections"; guidedIntegrityUnchecked: boolean }
  | { kind: "decode"; format: UefiDecodeFormat }
  | {
      kind: "unsupported";
      gap: "unknown-guid-handler" | "unsupported-compression";
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
  /** Payload window in this region's buffer, or null when malformed. */
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

/** Read one PI section chain, with each child aligned relative to its stream. */
export function walkSections(
  region: ScanRegion,
  reserve: () => boolean = () => true,
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
  while (cursor + SECTION_LAYOUT.commonLength <= localEnd) {
    if (!reserve())
      return {
        sections,
        nonzeroPadding,
        remainder: { kind: "limited", start: cursor },
      };
    const header = readCommonHeader(reader, cursor, localEnd);
    if (header === null) break;
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
      malformed = observedLength < headerLength;
      if (!malformed) {
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
      malformed = observedLength < headerLength;
      if (!malformed) {
        const dataOffset = reader.u16(
          fields + SECTION_LAYOUT.guidDataOffsetFieldOffset,
        );
        malformed = dataOffset < headerLength || dataOffset > observedLength;
        if (!malformed) {
          const guid = formatGuidLittleEndian(region.buffer, fields);
          headerLength = dataOffset;
          const attributes = reader.u16(
            fields + SECTION_LAYOUT.guidAttributesFieldOffset,
          );
          const kind =
            guid === null
              ? "unknown-guid"
              : (COMPRESSION_GUID_BY_DISPLAY[guid] ?? "unknown-guid");
          compression = { kind, guid, dataOffset, attributes };
          if (
            kind === "lzma-custom" ||
            kind === "lzmaf86" ||
            kind === "ami-zlib"
          ) {
            content = {
              kind: "decode",
              format:
                kind === "ami-zlib"
                  ? "zlib"
                  : kind === "lzma-custom"
                    ? "lzma"
                    : "lzmaf86",
            };
          } else if (
            (attributes & GUIDED_PROCESSING_REQUIRED) === 0 &&
            guid !== SIGNED_SECTION_GUID &&
            (kind === "crc32-guided" ||
              (kind === "unknown-guid" &&
                hasBoundedFrame(
                  reader,
                  cursor + dataOffset,
                  cursor + observedLength,
                )))
          ) {
            content = {
              kind: "stored-sections",
              guidedIntegrityUnchecked:
                (attributes & GUIDED_AUTH_STATUS_VALID) !== 0,
            };
          } else {
            content = {
              kind: "unsupported",
              gap:
                kind === "unknown-guid"
                  ? "unknown-guid-handler"
                  : "unsupported-compression",
            };
          }
        }
      }
    } else if (typeCode === 0x14 || typeCode === 0x18) {
      headerLength += typeCode === 0x14 ? 2 : GUID_LENGTH;
      malformed = observedLength < headerLength;
    }

    sections.push({
      absoluteBase: absoluteOffset(region, cursor),
      headerLength,
      declaredLength,
      observedLength,
      truncated,
      malformed,
      content,
      typeCode,
      compression,
      payload: malformed
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
