import { err, ok, type Result } from "../result.js";

const COMMON_HEADER_BYTES = 8;
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
  let fileOffset = startFileOffset;
  while (fileOffset + COMMON_HEADER_BYTES <= bytes.length) {
    const length = bytes.readUInt32LE(fileOffset);
    if (length === 0 && bytes.readUInt32LE(fileOffset + 4) === 0) {
      const start = fileOffset;
      do {
        fileOffset += COMMON_HEADER_BYTES;
      } while (
        fileOffset + COMMON_HEADER_BYTES <= bytes.length &&
        bytes.readBigUInt64LE(fileOffset) === 0n
      );
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

    const major = bytes.readUInt16LE(fileOffset + 4);
    const minor = bytes.readUInt16LE(fileOffset + 6);
    if ((major !== 2 && major !== 3 && major !== 4) || minor !== 0) {
      yield err({ kind: "unsupported", fileOffset, major, minor });
    } else if (major === 4) {
      yield readExtentRecord(
        bytes.subarray(fileOffset, fileOffset + length),
        fileOffset,
      );
    } else {
      yield readNamedRecord(
        bytes.subarray(fileOffset, fileOffset + length),
        fileOffset,
        major,
      );
    }
    fileOffset += length;
  }
  if (fileOffset < bytes.length) yield err({ kind: "truncated", fileOffset });
}

const readReference = (record: Buffer, offset: number, width: 8 | 16): bigint =>
  record.readBigUInt64LE(offset) |
  (width === 16 ? record.readBigUInt64LE(offset + 8) << 64n : 0n);

const readNamedRecord = (
  record: Buffer,
  fileOffset: number,
  majorVersion: 2 | 3,
): Result<UsnRecord, UsnRecordIssue> => {
  const referenceBytes = majorVersion === 2 ? 8 : 16;
  const body = COMMON_HEADER_BYTES + referenceBytes * 2;
  const headerBytes = body + 36;
  if (record.length < headerBytes)
    return err({ kind: "malformed", fileOffset });
  const nameBytes = record.readUInt16LE(body + 32);
  const nameOffset = record.readUInt16LE(body + 34);
  if (
    nameOffset < headerBytes ||
    nameOffset % 2 !== 0 ||
    nameBytes % 2 !== 0 ||
    nameOffset + nameBytes > record.length
  )
    return err({ kind: "malformed", fileOffset });

  return ok({
    majorVersion,
    referenceBytes,
    fileOffset,
    recordBytes: record.length,
    fileReference: readReference(record, 8, referenceBytes),
    parentReference: readReference(record, 8 + referenceBytes, referenceBytes),
    usn: record.readBigInt64LE(body),
    timestampFileTime: record.readBigUInt64LE(body + 8),
    reasonFlags: record.readUInt32LE(body + 16),
    sourceFlags: record.readUInt32LE(body + 20),
    securityId: record.readUInt32LE(body + 24),
    fileAttributes: record.readUInt32LE(body + 28),
    name: record.toString("utf16le", nameOffset, nameOffset + nameBytes),
  });
};

const readExtentRecord = (
  record: Buffer,
  fileOffset: number,
): Result<UsnRecord, UsnRecordIssue> => {
  if (record.length < 64) return err({ kind: "malformed", fileOffset });
  const extentCount = record.readUInt16LE(60),
    extentSize = record.readUInt16LE(62);
  // Validate the complete declared array before allocating the fixed-size sample.
  if (
    extentSize < 16 ||
    extentCount > Math.floor((record.length - 64) / extentSize)
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
      offset: record.readBigInt64LE(cursor),
      length: record.readBigInt64LE(cursor + 8),
    });
  }
  return ok({
    majorVersion: 4,
    referenceBytes: 16,
    fileOffset,
    recordBytes: record.length,
    fileReference: readReference(record, 8, 16),
    parentReference: readReference(record, 24, 16),
    usn: record.readBigInt64LE(40),
    reasonFlags: record.readUInt32LE(48),
    sourceFlags: record.readUInt32LE(52),
    timestampFileTime: null,
    securityId: null,
    fileAttributes: null,
    name: null,
    remainingExtents: record.readUInt32LE(56),
    extentCount,
    extentSize,
    omittedExtents: extentCount - extentSample.length,
    extentSample,
  });
};
