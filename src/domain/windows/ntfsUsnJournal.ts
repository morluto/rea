import { BinaryReader } from "../binaryContainer.js";
import { err, ok, type Result } from "../result.js";

const COMMON_HEADER_BYTES = 8;
const ZERO_PADDING_BLOCK = Buffer.alloc(64 * 1024);
/** Bound extent objects in each inline event independently of source record length. */
export const USN_INLINE_EXTENT_LIMIT = 16;

export interface UsnRecord {
  readonly majorVersion: 2 | 3 | 4;
  readonly referenceBytes: 8 | 16;
  readonly fileOffset: number;
  readonly recordBytes: number;
  readonly fileReference: bigint;
  readonly parentReference: bigint;
  readonly usn: bigint;
  readonly timestampFileTime: bigint | null;
  readonly reasonFlags: number;
  readonly sourceFlags: number;
  readonly securityId: number | null;
  readonly fileAttributes: number | null;
  readonly name: string | null;
  readonly remainingExtents?: number;
  readonly extentSize?: number;
  readonly extentCount?: number;
  readonly omittedExtents?: number;
  readonly extentSample?: readonly {
    readonly fileOffset: number;
    readonly offset: bigint;
    readonly length: bigint;
  }[];
}

export type UsnRecordIssue =
  | {
      readonly kind: "padding";
      readonly fileOffset: number;
      readonly bytes: number;
    }
  | { readonly kind: "malformed" | "truncated"; readonly fileOffset: number }
  | {
      readonly kind: "unsupported";
      readonly fileOffset: number;
      readonly major: number;
      readonly minor: number;
    };

/** Walk acquired journal bytes in source order without accumulating records. */
export function* readUsnJournal(
  bytes: Buffer,
  startFileOffset = 0,
): Generator<Result<UsnRecord, UsnRecordIssue>> {
  const journal = new BinaryReader(bytes, true, "ntfs-usn");
  let fileOffset = startFileOffset;
  while (fileOffset + COMMON_HEADER_BYTES <= bytes.length) {
    const length = journal.u32(fileOffset);
    if (length === 0 && journal.u32(fileOffset + 4) === 0) {
      const start = fileOffset;
      fileOffset += COMMON_HEADER_BYTES;
      if (
        fileOffset + COMMON_HEADER_BYTES <= bytes.length &&
        journal.word(fileOffset, 64) === 0n
      ) {
        fileOffset += COMMON_HEADER_BYTES;
        // Compare long zero runs in native code, then resolve the exact end
        // on record boundaries without consuming a short trailing header.
        while (
          ZERO_PADDING_BLOCK.length <= bytes.length - fileOffset &&
          ZERO_PADDING_BLOCK.compare(
            bytes,
            fileOffset,
            fileOffset + ZERO_PADDING_BLOCK.length,
          ) === 0
        )
          fileOffset += ZERO_PADDING_BLOCK.length;
        while (
          fileOffset + COMMON_HEADER_BYTES <= bytes.length &&
          journal.word(fileOffset, 64) === 0n
        )
          fileOffset += COMMON_HEADER_BYTES;
      }
      yield err({
        kind: "padding",
        fileOffset: start,
        bytes: fileOffset - start,
      });
      continue;
    }
    if (length < COMMON_HEADER_BYTES || length % 8 !== 0) {
      yield err({ kind: "malformed", fileOffset });
      return;
    }
    if (length > bytes.length - fileOffset) {
      yield err({ kind: "truncated", fileOffset });
      return;
    }

    const major = journal.u16(fileOffset + 4);
    const minor = journal.u16(fileOffset + 6);
    if ((major !== 2 && major !== 3 && major !== 4) || minor !== 0) {
      yield err({ kind: "unsupported", fileOffset, major, minor });
    } else {
      const record = new BinaryReader(
        journal.range(fileOffset, length, "USN record"),
        journal.little,
        journal.format,
      );
      yield major === 4
        ? readExtentRecord(record, fileOffset)
        : readNamedRecord(record, fileOffset, major);
    }
    fileOffset += length;
  }
  if (fileOffset < bytes.length) yield err({ kind: "truncated", fileOffset });
}

const readReference = (
  record: BinaryReader,
  offset: number,
  width: 8 | 16,
): bigint =>
  record.word(offset, 64) |
  (width === 16 ? record.word(offset + 8, 64) << 64n : 0n);

const readNamedRecord = (
  record: BinaryReader,
  fileOffset: number,
  majorVersion: 2 | 3,
): Result<UsnRecord, UsnRecordIssue> => {
  const referenceBytes = majorVersion === 2 ? 8 : 16;
  const body = COMMON_HEADER_BYTES + referenceBytes * 2;
  const headerBytes = body + 36;
  const recordBytes = record.bytes.length;
  if (recordBytes < headerBytes) return err({ kind: "malformed", fileOffset });
  const nameBytes = record.u16(body + 32);
  const nameOffset = record.u16(body + 34);
  if (
    nameOffset < headerBytes ||
    nameOffset % 2 !== 0 ||
    nameBytes % 2 !== 0 ||
    nameOffset + nameBytes > recordBytes
  )
    return err({ kind: "malformed", fileOffset });

  return ok({
    majorVersion,
    referenceBytes,
    fileOffset,
    recordBytes,
    fileReference: readReference(record, 8, referenceBytes),
    parentReference: readReference(record, 8 + referenceBytes, referenceBytes),
    usn: BigInt.asIntN(64, record.word(body, 64)),
    timestampFileTime: record.word(body + 8, 64),
    reasonFlags: record.u32(body + 16),
    sourceFlags: record.u32(body + 20),
    securityId: record.u32(body + 24),
    fileAttributes: record.u32(body + 28),
    name: record
      .range(nameOffset, nameBytes, "USN filename")
      .toString("utf16le"),
  });
};

const readExtentRecord = (
  record: BinaryReader,
  fileOffset: number,
): Result<UsnRecord, UsnRecordIssue> => {
  const recordBytes = record.bytes.length;
  if (recordBytes < 64) return err({ kind: "malformed", fileOffset });
  const extentCount = record.u16(60),
    extentSize = record.u16(62);
  // Validate the complete declared array before allocating the fixed-size sample.
  if (
    extentSize < 16 ||
    extentSize % 8 !== 0 ||
    extentCount > Math.floor((recordBytes - 64) / extentSize)
  )
    return err({ kind: "malformed", fileOffset });
  const extentSample: { fileOffset: number; offset: bigint; length: bigint }[] =
    [];
  for (
    let index = 0;
    index < Math.min(extentCount, USN_INLINE_EXTENT_LIMIT);
    index++
  ) {
    const cursor = 64 + index * extentSize;
    extentSample.push({
      fileOffset: fileOffset + cursor,
      offset: BigInt.asIntN(64, record.word(cursor, 64)),
      length: BigInt.asIntN(64, record.word(cursor + 8, 64)),
    });
  }
  return ok({
    majorVersion: 4,
    referenceBytes: 16,
    fileOffset,
    recordBytes,
    fileReference: readReference(record, 8, 16),
    parentReference: readReference(record, 24, 16),
    usn: BigInt.asIntN(64, record.word(40, 64)),
    reasonFlags: record.u32(48),
    sourceFlags: record.u32(52),
    timestampFileTime: null,
    securityId: null,
    fileAttributes: null,
    name: null,
    remainingExtents: record.u32(56),
    extentCount,
    extentSize,
    omittedExtents: extentCount - extentSample.length,
    extentSample,
  });
};
