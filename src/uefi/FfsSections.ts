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
  readonly localBase: number;
  readonly headerLength: number;
  readonly declaredLength: number;
  /** Bytes actually covered inside the region (clamped on truncation). */
  readonly observedLength: number;
  readonly truncated: boolean;
  readonly malformed?: boolean;
  readonly encapsulatesSections?: boolean;
  readonly typeCode: number;
  readonly typeName: string;
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
  /** Payload window in this region's buffer, or null for outer frames. */
  readonly payload: { readonly start: number; readonly end: number } | null;
}

/** Read one PI section chain, with each child aligned relative to its stream. */
export function walkSections(
  region: ScanRegion,
  localStart: number,
  localEnd: number,
  typeNameFor: (typeCode: number) => string,
  reserve: () => boolean = () => true,
): { sections: SectionDraft[]; terminated: boolean } {
  const sections: SectionDraft[] = [];
  let cursor = localStart;
  while (cursor + SECTION_LAYOUT.commonLength <= localEnd && reserve()) {
    const compactSize = region.buffer.readUIntLE(cursor, 3);
    const typeCode = region.buffer.readUInt8(
      cursor + SECTION_LAYOUT.typeOffset,
    );
    const extended = compactSize === SECTION_LAYOUT.largeSectionMarker;
    const commonLength = extended
      ? SECTION_LAYOUT.extendedLength
      : SECTION_LAYOUT.commonLength;
    if (cursor + commonLength > localEnd) break;
    const declaredLength = extended
      ? region.buffer.readUInt32LE(cursor + SECTION_LAYOUT.extendedSizeOffset)
      : compactSize;
    const observedLength = Math.min(declaredLength, localEnd - cursor);
    const truncated = observedLength < declaredLength;
    let headerLength: number = commonLength;
    let compression: SectionDraft["compression"] = { kind: "none" };
    let encapsulatesSections = typeCode === 0x03;
    let malformed = observedLength < commonLength;
    const fields = cursor + commonLength;

    if (typeCode === 0x01) {
      headerLength += SECTION_LAYOUT.compressionFieldsLength;
      malformed = observedLength < headerLength;
      if (!malformed) {
        const compressionType = region.buffer.readUInt8(
          fields + SECTION_LAYOUT.compressionTypeFieldOffset,
        );
        if (compressionType === 0) {
          encapsulatesSections = true;
          malformed =
            region.buffer.readUInt32LE(fields) !==
            declaredLength - headerLength;
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
        const dataOffset = region.buffer.readUInt16LE(
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
            attributes: region.buffer.readUInt16LE(
              fields + SECTION_LAYOUT.guidAttributesFieldOffset,
            ),
          };
        }
      }
    }

    sections.push({
      absoluteBase: absoluteOffset(region, cursor),
      localBase: cursor,
      headerLength,
      declaredLength,
      observedLength,
      truncated,
      ...(malformed ? { malformed: true } : {}),
      ...(encapsulatesSections ? { encapsulatesSections: true } : {}),
      typeCode,
      typeName: typeNameFor(typeCode),
      compression,
      payload: malformed
        ? null
        : { start: cursor + headerLength, end: cursor + observedLength },
    });
    if (declaredLength < commonLength || truncated) {
      return { sections, terminated: false };
    }
    cursor = localStart + alignUp(cursor + declaredLength - localStart, 4);
  }
  return { sections, terminated: cursor >= localEnd };
}

/** Payload window of one section as a sub-region; null when empty. */
export function sectionPayloadRegion(
  region: ScanRegion,
  section: SectionDraft,
): ScanRegion | null {
  if (section.payload == null) {
    return null;
  }
  const start = Math.min(section.payload.start, region.end);
  const end = Math.min(section.payload.end, region.end);
  if (start >= end) {
    return null;
  }
  return {
    buffer: region.buffer,
    start,
    end,
    origin: absoluteOffset(region, start),
    ...(region.sourceStream === undefined
      ? {}
      : { sourceStream: region.sourceStream }),
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
  return {
    stream: payload.subarray(AMD_ZLIB_HEADER_LENGTH),
    declaredCompressedSize: payload.readUInt32LE(0x14),
  };
}
