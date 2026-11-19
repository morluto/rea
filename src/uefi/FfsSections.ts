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

/** Section data start for one section type, or null when unknown. */
function payloadStart(typeCode: number, rawHeaderLength: number): number {
  if (typeCode === 0x01) {
    return SECTION_LAYOUT.compressionHeaderLength;
  }
  return rawHeaderLength;
}

/**
 * Walk a flat section chain inside one region. Section records stay raw:
 * compression classification names the handler, nesting is resolved by the
 * orchestrator so recursion is explicit and depth-bounded.
 */
export function walkSections(
  region: ScanRegion,
  localStart: number,
  localEnd: number,
  typeNameFor: (typeCode: number) => string,
): { sections: SectionDraft[]; terminated: boolean } {
  const sections: SectionDraft[] = [];
  let cursor = localStart;
  let stopped = false;
  while (cursor + SECTION_LAYOUT.commonLength <= localEnd) {
    const sizeB0 = region.buffer[cursor] ?? 0;
    const sizeB1 = region.buffer[cursor + 1] ?? 0;
    const sizeB2 = region.buffer[cursor + 2] ?? 0;
    const typeCode = region.buffer[cursor + SECTION_LAYOUT.typeOffset] ?? 0xff;
    const typeName = typeNameFor(typeCode);
    // Compact u24 size assembled little-endian.
    const compactSize = sizeB0 | (sizeB1 << 8) | (sizeB2 << 16);

    let headerLength: number = SECTION_LAYOUT.commonLength;
    let declaredLength = compactSize;
    let truncated = compactSize < SECTION_LAYOUT.commonLength;
    if (compactSize === SECTION_LAYOUT.largeSectionMarker) {
      if (cursor + SECTION_LAYOUT.extendedLength <= localEnd) {
        headerLength = SECTION_LAYOUT.extendedLength;
        declaredLength = region.buffer.readUInt32LE(
          cursor + SECTION_LAYOUT.extendedSizeOffset,
        );
      } else {
        break;
      }
    }
    if (declaredLength < headerLength) {
      // Malformed: cannot advance a shorter-than-header section; report and stop.
      sections.push({
        absoluteBase: absoluteOffset(region, cursor),
        localBase: cursor,
        headerLength,
        declaredLength,
        observedLength: Math.max(
          0,
          Math.min(localEnd - cursor, declaredLength),
        ),
        truncated: true,
        typeCode,
        typeName,
        compression: { kind: "none" },
        payload: null,
      });
      stopped = true;
      break;
    }
    const dataStart =
      payloadStart(typeCode, headerLength) <= declaredLength
        ? payloadStart(typeCode, headerLength)
        : headerLength;
    let effectiveHeaderLength = headerLength;
    if (typeCode === 0x02) {
      const guided =
        cursor + SECTION_LAYOUT.guidedHeaderLength <= localEnd &&
        declaredLength >= SECTION_LAYOUT.guidedHeaderLength;
      if (guided) {
        const dataOffset = region.buffer.readUInt16LE(
          cursor + SECTION_LAYOUT.guidDataOffsetOffset,
        );
        const attributes = region.buffer.readUInt16LE(
          cursor + SECTION_LAYOUT.guidAttributesOffset,
        );
        effectiveHeaderLength = dataOffset;
        const guid = formatGuidLittleEndian(
          region.buffer.subarray(
            cursor + SECTION_LAYOUT.guidedSectionDefinitionGuidOffset,
            cursor + SECTION_LAYOUT.guidedSectionDefinitionGuidOffset + 16,
          ),
          0,
        );
        sections.push({
          absoluteBase: absoluteOffset(region, cursor),
          localBase: cursor,
          headerLength: effectiveHeaderLength,
          declaredLength,
          observedLength: Math.min(declaredLength, localEnd - cursor),
          truncated: cursor + declaredLength > localEnd,
          typeCode,
          typeName,
          compression: {
            kind:
              guid == null
                ? "unknown-guid"
                : (COMPRESSION_GUID_BY_DISPLAY[guid] ?? "unknown-guid"),
            guid,
            dataOffset,
            attributes,
          },
          payload: {
            start: cursor + dataOffset,
            end: Math.min(cursor + declaredLength, localEnd),
          },
        });
        cursor = alignUp(cursor + declaredLength, 4);
        continue;
      }
    }

    if (cursor + declaredLength > localEnd) {
      truncated = true;
    }
    sections.push({
      absoluteBase: absoluteOffset(region, cursor),
      localBase: cursor,
      headerLength: effectiveHeaderLength,
      declaredLength,
      observedLength: Math.min(declaredLength, localEnd - cursor),
      truncated,
      typeCode,
      typeName,
      compression: { kind: "none" },
      payload: {
        start: cursor + dataStart,
        end: Math.min(cursor + declaredLength, localEnd),
      },
    });
    if (truncated) {
      stopped = true;
      break;
    }
    cursor = alignUp(cursor + declaredLength, 4);
  }
  return { sections, terminated: stopped || cursor >= localEnd };
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

/** Read the payload window bytes for decompression workers. */
export function sectionPayloadBuffer(
  region: ScanRegion,
  section: SectionDraft,
): Buffer | null {
  if (section.payload == null) {
    return null;
  }
  const start = Math.max(region.start, section.payload.start);
  const end = Math.min(region.end, section.payload.end);
  if (start >= end) {
    return null;
  }
  return Buffer.from(region.buffer.subarray(start, end));
}
