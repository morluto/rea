import { BinaryReader } from "./binaryContainer.js";

/** Classic ZIP EOCD fixed record and its format-defined comment limit. */
export const ZIP_EOCD_BYTES = 22;
export const ZIP_MAX_COMMENT_BYTES = 0xffff;

export interface ZipEndOfCentralDirectory {
  /** Relative to the supplied byte window, which ends at the archive's end. */
  readonly offset: number;
  readonly disk: number;
  readonly directoryDisk: number;
  readonly entriesOnDisk: number;
  readonly totalEntries: number;
  readonly directorySize: number;
  readonly directoryOffset: number;
  readonly commentLength: number;
}

/**
 * Observe complete classic records whose declared comment ends this window,
 * latest first. Candidate recognition does not establish directory validity,
 * ambiguity policy, disk support, or the meaning of Zip64 sentinel fields.
 */
export function* zipEndOfCentralDirectoryCandidates(
  bytes: Uint8Array,
): Generator<ZipEndOfCentralDirectory> {
  const reader = new BinaryReader(
    Buffer.isBuffer(bytes)
      ? bytes
      : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    true,
    "zip",
  );
  const earliest = Math.max(
    0,
    bytes.byteLength - ZIP_EOCD_BYTES - ZIP_MAX_COMMENT_BYTES,
  );
  for (
    let offset = bytes.byteLength - ZIP_EOCD_BYTES;
    offset >= earliest;
    offset--
  ) {
    if (reader.u32(offset) !== 0x06054b50) continue;
    const commentLength = reader.u16(offset + 20);
    if (offset + ZIP_EOCD_BYTES + commentLength !== bytes.byteLength) continue;
    yield {
      offset,
      disk: reader.u16(offset + 4),
      directoryDisk: reader.u16(offset + 6),
      entriesOnDisk: reader.u16(offset + 8),
      totalEntries: reader.u16(offset + 10),
      directorySize: reader.u32(offset + 12),
      directoryOffset: reader.u32(offset + 16),
      commentLength,
    };
  }
}
