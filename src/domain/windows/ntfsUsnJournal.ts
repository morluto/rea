import { err, ok, type Result } from "../result.js";

const COMMON_HEADER_BYTES = 8;
const V2_HEADER_BYTES = 60;

export interface UsnRecordV2 {
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
): Generator<Result<UsnRecordV2, UsnRecordIssue>> {
  let fileOffset = 0;
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
    if (major !== 2 || minor !== 0) {
      yield err({ kind: "unsupported", fileOffset, major, minor });
    } else {
      yield readV2(bytes.subarray(fileOffset, fileOffset + length), fileOffset);
    }
    fileOffset += length;
  }
  if (fileOffset < bytes.length) yield err({ kind: "truncated", fileOffset });
}

const readV2 = (
  record: Buffer,
  fileOffset: number,
): Result<UsnRecordV2, UsnRecordIssue> => {
  if (record.length < V2_HEADER_BYTES)
    return err({ kind: "malformed", fileOffset });
  const nameBytes = record.readUInt16LE(56);
  const nameOffset = record.readUInt16LE(58);
  if (
    nameOffset < V2_HEADER_BYTES ||
    nameOffset % 2 !== 0 ||
    nameBytes % 2 !== 0 ||
    nameOffset + nameBytes > record.length
  )
    return err({ kind: "malformed", fileOffset });

  return ok({
    fileOffset,
    recordBytes: record.length,
    fileReference: record.readBigUInt64LE(8),
    parentReference: record.readBigUInt64LE(16),
    usn: record.readBigInt64LE(24),
    timestampFileTime: record.readBigUInt64LE(32),
    reasonFlags: record.readUInt32LE(40),
    sourceFlags: record.readUInt32LE(44),
    securityId: record.readUInt32LE(48),
    fileAttributes: record.readUInt32LE(52),
    name: record.toString("utf16le", nameOffset, nameOffset + nameBytes),
  });
};
