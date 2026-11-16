/** Explicit logical/file mappings. Logical offsets are not runtime addresses. */
export interface RasterLogicalSegment {
  logicalOffset: number;
  fileOffset: number;
  length: number;
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
  if (
    !integer(sourceOffset) ||
    !Number.isSafeInteger(sourceOffset + source.length) ||
    source.length > LIMIT ||
    segments.length < 1 ||
    segments.length > 500000
  )
    throw new RangeError("Invalid source or segment budget");
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
      throw new RangeError(
        "Segment is outside the selected source or exact logical range",
      );
    if (s.logicalOffset < end)
      throw new RangeError("Overlapping logical segments");
    end = s.logicalOffset + s.length;
    fileRanges.push({ offset: s.fileOffset, end: s.fileOffset + s.length });
  }
  fileRanges.sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < fileRanges.length; i++)
    if (fileRanges[i]!.offset < fileRanges[i - 1]!.end)
      throw new RangeError("Overlapping source segments");
  const logicalBase = ordered[0]!.logicalOffset;
  if (end - logicalBase > LIMIT)
    throw new RangeError("Logical span exceeds 16 MiB");
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
  if (source.length < 16 || source.length > LIMIT)
    throw new RangeError(
      "FGS records require a complete file of 16 bytes..16 MiB",
    );
  const view = new DataView(
      source.buffer,
      source.byteOffset,
      source.byteLength,
    ),
    footer = source.length - 16;
  const magic = [0xce, 0xde, 0xad, 0xce, 0x31, 0x21, 0x52, 0x31];
  if (
    magic.some((v, i) => source[footer + i] !== v) ||
    view.getUint32(footer + 8, true) !== source.length ||
    view.getUint32(footer + 12, true) !==
      crc32(source.subarray(0, source.length - 4))
  )
    throw new RangeError("FGS footer, declared size or CRC32 mismatch");
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
    if (at + 12 > footer) throw new RangeError("Truncated FGS record header");
    const length = view.getUint32(at + 4, true),
      logicalOffset = view.getUint32(at + 8, true);
    if (
      length === 0 ||
      length > 44 ||
      length % 4 !== 0 ||
      logicalOffset % 4 !== 0 ||
      at + 12 + length > footer ||
      logicalOffset < logicalEnd
    )
      throw new RangeError("Invalid, overlapping or nonmonotone FGS records");
    if (segments.length >= 500000)
      throw new RangeError("FGS record budget exceeded");
    segments.push({ logicalOffset, fileOffset: at + 12, length });
    logicalEnd = logicalOffset + length;
    at += 11 + length;
  }
  if (segments.length === 0) throw new RangeError("No FGS data records");
  return segments;
}
