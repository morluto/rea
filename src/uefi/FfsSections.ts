import { BinaryReader } from "../domain/binaryContainer.js";
import { Buffer } from "node:buffer";
import { absoluteOffset, alignUp, type ScanRegion } from "./UefiBytes.js";
import { formatGuidLittleEndian } from "./UefiGuid.js";
import {
  COMPRESSION_GUID_BY_DISPLAY,
  SECTION_LAYOUT,
} from "./UefiCodeTables.js";

/** Raw section observation before nesting resolution. */
export interface SectionDraft {
  readonly absoluteBase: number;
  readonly headerLength: number;
  readonly declaredLength: number;
  /** Bytes actually covered inside the region (clamped on truncation). */
  readonly observedLength: number;
  readonly truncated: boolean;
  readonly malformed: boolean;
  readonly encapsulatesSections: boolean;
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
  const header = readCommonHeader(reader, region.start, region.end);
  return (
    header !== null &&
    header.declaredLength >= header.commonLength &&
    header.declaredLength <= region.end - region.start
  );
}

/** Read one PI section chain, with each child aligned relative to its stream. */
export function walkSections(
  region: ScanRegion,
  reserve: () => boolean = () => true,
): {
  sections: SectionDraft[];
  remainder: { kind: "limited" | "unparsed"; start: number } | null;
} {
  const reader = new BinaryReader(region.buffer, true, "FFS sections");
  const sections: SectionDraft[] = [];
  const { start: localStart, end: localEnd } = region;
  let cursor = localStart;
  while (cursor + SECTION_LAYOUT.commonLength <= localEnd) {
    if (!reserve())
      return { sections, remainder: { kind: "limited", start: cursor } };
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
    let encapsulatesSections = typeCode === 0x03;
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
          encapsulatesSections = true;
          malformed = reader.u32(fields) !== declaredLength - headerLength;
        } else {
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
          compression = {
            kind:
              guid === null
                ? "unknown-guid"
                : (COMPRESSION_GUID_BY_DISPLAY[guid] ?? "unknown-guid"),
            guid,
            dataOffset,
            attributes: reader.u16(
              fields + SECTION_LAYOUT.guidAttributesFieldOffset,
            ),
          };
        }
      }
    }

    sections.push({
      absoluteBase: absoluteOffset(region, cursor),
      headerLength,
      declaredLength,
      observedLength,
      truncated,
      malformed,
      encapsulatesSections,
      typeCode,
      compression,
      payload: malformed
        ? null
        : { start: cursor + headerLength, end: cursor + observedLength },
    });
    if (truncated) return { sections, remainder: null };
    if (declaredLength < commonLength) {
      cursor += commonLength;
      break;
    }
    cursor = localStart + alignUp(cursor + declaredLength - localStart, 4);
  }
  return {
    sections,
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
