import { BinaryReader } from "./binaryContainer.js";

import { decodeLimit, malformedInput, truncatedInput } from "./parseFailure.js";

/** Maximum retained record/coverage spans in the bounded logical image. */
export const MAX_RASTER_LOGICAL_SEGMENTS = 500000;

/** Explicit logical/file mappings. Logical offsets are not runtime addresses. */
export interface RasterLogicalSegment {
  logicalOffset: number;
  fileOffset: number;
  length: number;
}
/** Walk a range in the sorted, non-overlapping segment table admitted by materialization.
 * Publication callers may bound visits; full export retains table indices without allocations.
 */
export function walkRasterLogicalSegments(
  segments: readonly RasterLogicalSegment[],
  offset: number,
  length: number,
  maxSegments = Infinity,
  visit?: (
    segment: RasterLogicalSegment,
    logicalOffset: number,
    length: number,
  ) => void,
) {
  let firstSegment = 0,
    hi = segments.length;
  while (firstSegment < hi) {
    const mid = Math.floor((firstSegment + hi) / 2),
      segment = segments[mid]!;
    if (segment.logicalOffset + segment.length <= offset)
      firstSegment = mid + 1;
    else hi = mid;
  }
  const end = offset + length;
  let cursor = offset,
    segmentCount = 0;
  for (
    let i = firstSegment;
    i < segments.length && cursor < end && segmentCount < maxSegments;
    i++
  ) {
    const segment = segments[i]!;
    if (segment.logicalOffset > cursor) break;
    const take = Math.min(end, segment.logicalOffset + segment.length) - cursor;
    visit?.(segment, cursor, take);
    cursor += take;
    segmentCount++;
  }
  return { firstSegment, segmentCount, complete: cursor === end };
}
export interface RasterLogicalImage {
  bytes: Uint8Array;
  logicalBase: number;
  segments: RasterLogicalSegment[];
  coverage: { offset: number; length: number }[];
  assumptions: string[];
}
const LIMIT = 16 * 1024 * 1024;
const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
/** Materialize only a bounded logical span. Gaps remain uncovered, never evidence of zero bytes. */
export function materializeRasterSegments(
  source: Uint8Array,
  segments: readonly RasterLogicalSegment[],
  sourceOffset = 0,
): RasterLogicalImage {
  const format = "raster-logical-segments";
  if (
    !integer(sourceOffset) ||
    !Number.isSafeInteger(sourceOffset + source.length)
  )
    throw malformedInput(format, "Invalid selected source offset", {
      field: "sourceOffset",
    });
  if (source.length > LIMIT)
    throw decodeLimit(format, "Selected source exceeds 16 MiB", {
      name: "raster-materialized-source-bytes",
      maximum: LIMIT,
      required: source.length,
    });
  if (segments.length < 1)
    throw malformedInput(format, "At least one logical segment is required", {
      field: "segments",
    });
  if (segments.length > MAX_RASTER_LOGICAL_SEGMENTS)
    throw decodeLimit(format, "Logical segment budget exceeded", {
      name: "raster-logical-segment-count",
      maximum: MAX_RASTER_LOGICAL_SEGMENTS,
      required: segments.length,
    });
  const ordered = segments
    .map((s) => ({ ...s }))
    .sort((a, b) => a.logicalOffset - b.logicalOffset);
  let end = 0;
  const fileRanges = [];
  for (const s of ordered) {
    if (
      !integer(s.logicalOffset) ||
      !integer(s.fileOffset) ||
      !integer(s.length) ||
      s.length === 0 ||
      !Number.isSafeInteger(s.logicalOffset + s.length) ||
      !Number.isSafeInteger(s.fileOffset + s.length) ||
      s.fileOffset < sourceOffset ||
      s.length > source.length - (s.fileOffset - sourceOffset)
    )
      throw malformedInput(
        format,
        "Segment is outside the selected source or exact logical range",
        { field: "segments" },
      );
    if (s.logicalOffset < end)
      throw malformedInput(format, "Overlapping logical segments", {
        field: "segments",
      });
    end = s.logicalOffset + s.length;
    fileRanges.push({ offset: s.fileOffset, end: s.fileOffset + s.length });
  }
  fileRanges.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < fileRanges.length; i++)
    if (fileRanges[i]!.offset < fileRanges[i - 1]!.end)
      throw malformedInput(format, "Overlapping source segments", {
        field: "segments",
        offset: fileRanges[i]!.offset,
      });
  const logicalBase = ordered[0]!.logicalOffset;
  if (end - logicalBase > LIMIT)
    throw decodeLimit(format, "Logical span exceeds 16 MiB", {
      name: "raster-logical-span-bytes",
      maximum: LIMIT,
      required: end - logicalBase,
    });
  const bytes = new Uint8Array(end - logicalBase),
    coverage: { offset: number; length: number }[] = [];
  for (const s of ordered) {
    const offset = s.logicalOffset - logicalBase;
    bytes.set(
      source.subarray(
        s.fileOffset - sourceOffset,
        s.fileOffset - sourceOffset + s.length,
      ),
      offset,
    );
    const last = coverage.at(-1);
    if (last && last.offset + last.length === offset) last.length += s.length;
    else coverage.push({ offset, length: s.length });
  }
  return {
    bytes,
    logicalBase,
    segments: ordered,
    coverage,
    assumptions: [
      "Explicit logical offsets are caller/container coordinates, not established runtime addresses.",
      "Logical gaps are uncovered; materialized zero fill is never admissible payload evidence.",
    ],
  };
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (c >>> 8) ^ crcTable[(c ^ b) & 255]!;
  return (c ^ 0xffffffff) >>> 0;
}
/** A named record-container grammar, not firmware identification or image-layout knowledge. */
export function parseFgsRasterSegments(
  source: Uint8Array,
): RasterLogicalSegment[] {
  const format = "fgs-records";
  if (source.length > LIMIT)
    throw decodeLimit(format, "FGS source exceeds 16 MiB", {
      name: "fgs-records-input-bytes",
      maximum: LIMIT,
      required: source.length,
    });
  if (source.length < 16)
    throw truncatedInput(format, "Truncated FGS footer", {
      offset: 0,
      field: "footer",
    });
  const reader = new BinaryReader(
      Buffer.from(source.buffer, source.byteOffset, source.byteLength),
      true,
      "fgs-records",
    ),
    footer = source.length - 16;
  const magic = [0xce, 0xde, 0xad, 0xce, 0x31, 0x21, 0x52, 0x31];
  if (magic.some((v, i) => source[footer + i] !== v))
    throw malformedInput(format, "FGS footer magic mismatch", {
      offset: footer,
      field: "footer.magic",
    });
  const declaredSize = reader.u32(footer + 8);
  if (declaredSize !== source.length)
    throw (declaredSize > source.length ? truncatedInput : malformedInput)(
      format,
      "FGS declared file size mismatch",
      { offset: footer + 8, field: "footer.size" },
    );
  if (reader.u32(footer + 12) !== crc32(source.subarray(0, source.length - 4)))
    throw malformedInput(format, "FGS footer CRC32 mismatch", {
      offset: footer + 12,
      field: "footer.crc32",
    });
  const segments: RasterLogicalSegment[] = [];
  let logicalEnd = 0;
  for (let at = 0; at < footer; at++) {
    if (
      source[at] !== 255 ||
      source[at + 1] !== 255 ||
      source[at + 2] !== 255 ||
      source[at + 3] !== 0x24
    )
      continue;
    if (at + 12 > footer)
      throw truncatedInput(format, "Truncated FGS record header", {
        offset: at,
        field: "record.header",
      });
    const length = reader.u32(at + 4),
      logicalOffset = reader.u32(at + 8);
    if (
      length === 0 ||
      length > 44 ||
      length % 4 !== 0 ||
      logicalOffset % 4 !== 0 ||
      logicalOffset < logicalEnd
    )
      throw malformedInput(
        format,
        "Invalid, overlapping or nonmonotone FGS records",
        { offset: at, field: "record" },
      );
    if (at + 12 + length > footer)
      throw truncatedInput(format, "Truncated FGS record payload", {
        offset: at,
        field: "record.payload",
      });
    if (segments.length >= MAX_RASTER_LOGICAL_SEGMENTS)
      throw decodeLimit(
        format,
        "FGS record budget exceeded",
        {
          name: "fgs-record-count",
          maximum: MAX_RASTER_LOGICAL_SEGMENTS,
          required: segments.length + 1,
        },
        { offset: at, field: "record" },
      );
    segments.push({ logicalOffset, fileOffset: at + 12, length });
    logicalEnd = logicalOffset + length;
    at += 11 + length;
  }
  if (segments.length === 0)
    throw malformedInput(format, "No FGS data records", { field: "records" });
  return segments;
}
