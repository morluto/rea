import { err, ok, type Result } from "../result.js";

const COMMON_HEADER_BYTES = 8;

export interface UsnRecord {
  readonly majorVersion: 2 | 3;
  readonly referenceBytes: 8 | 16;
  readonly fileOffset: number;
  readonly recordBytes: number;
  readonly fileReference: bigint;
  readonly parentReference: bigint;
  readonly usn: bigint;
  readonly timestampFileTime: bigint;
  readonly reasonFlags: number;
  readonly sourceFlags: number;
  readonly securityId: number;
  readonly fileAttributes: number;
  readonly name: string;
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
    if ((major !== 2 && major !== 3) || minor !== 0) {
      yield err({ kind: "unsupported", fileOffset, major, minor });
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
