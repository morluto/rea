import { BinaryReader } from "../binaryContainer.js";
import {
  readZip64DirectoryRecord,
  readZip64Locator,
  zip64EndUsesSingleVolume,
  zip64LocatorUsesSingleVolume,
  zipEndOfCentralDirectoryCandidates,
  zipEndUsesSingleVolume,
  ZIP_CLASSIC_DIRECTORY_LIMITS,
  ZIP_EOCD_BYTES,
  ZIP64_END,
  ZIP64_LOCATOR,
  type ZipEndOfCentralDirectory,
} from "../zipEndOfCentralDirectory.js";

/**
 * Locate and frame the APK Signing Block (APK Signature Scheme v2+). The block
 * sits between the last ZIP entry and the central directory:
 *   [ zip entries ][ APK Signing Block ][ central directory ][ EOCD ]
 * and is framed as:
 *   uint64 size | id-value pairs | uint64 size | "APK Sig Block 42"
 * where each pair is `uint64 length | uint32 id | value[length-4]`.
 *
 * Dependency-free and bounded: the end-of-central-directory record is found by a
 * bounded backward scan, every size/offset is checked against the buffer before
 * use, and a malformed or absent block yields a tagged {@link Result}, never a
 * throw. Absence of the block is `ok(null)` (the APK is v1-only or unsigned),
 * not an error. All integers are little-endian (ZIP).
 */
import { decodeLimit, type ParseFailureError } from "../parseFailure.js";
import { type Result, err, ok } from "../result.js";
import type { PrefixedByteSource } from "../byteSource.js";

/** "APK Sig Block 42" — the 16-byte block magic (JAR/APK signing block spec). */
const BLOCK_MAGIC = "APK Sig Block 42";
/** A single pair is at least 12 bytes (uint64 length + uint32 id); cap the count. */
export const APK_SIGNING_BLOCK_MAX_PAIRS = 4096;

/** Validate one size-prefixed pair without reading or allocating its value. */
export const apkSigningPairEnd = (
  length: bigint,
  offset: number,
  end: number,
): number | undefined => {
  if (length < 4n || length > BigInt(end - offset - 8)) return undefined;
  return offset + 8 + Number(length);
};

/** Well-known APK Signing Block pair IDs. */
export const APK_BLOCK_ID = {
  signatureV2: 0x7109871a,
  signatureV3: 0xf05368c0,
  signatureV31: 0x1b93ad61,
  sourceStampV1: 0x2b09189e,
  sourceStampV2: 0x6dff800d,
} as const;

export type ApkSigningBlockError =
  | { readonly kind: "not-a-zip"; readonly detail: string }
  | { readonly kind: "zip64-unsupported"; readonly detail: string }
  | { readonly kind: "multi-disk-unsupported"; readonly detail: string }
  | {
      /** A ZIP whose end-of-central-directory is damaged or inconsistent. */
      readonly kind: "malformed-zip";
      readonly offset: number;
      readonly detail: string;
    }
  | {
      readonly kind: "malformed-block";
      readonly offset: number;
      readonly detail: string;
    }
  | ParseFailureError<"limit">;

export interface ZipTail {
  readonly eocdOffset: number;
  readonly centralDirectoryOffset: number;
  readonly centralDirectorySize: number;
  readonly totalEntries: number;
  /**
   * The classic EOCD record's 16-bit entry count. apksig takes the record
   * count from this field alone (it ignores a Zip64 record), so it reads only
   * this many records when Zip64 declares more.
   */
  readonly classicEntryCount: number;
}

export interface ApkSigningBlockPair {
  readonly id: number;
  /** View over the block buffer; not copied. */
  readonly value: Uint8Array;
}

export interface ApkSigningBlock {
  readonly blockStart: number;
  readonly pairs: readonly ApkSigningBlockPair[];
}

/** Read an unsigned 64-bit little-endian value as a Number, or null if unsafe/oob. */
const u64 = (reader: BinaryReader, at: number): number | null => {
  if (at < 0 || at + 8 > reader.bytes.length) return null;
  const value = reader.word(at, 64);
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
};

/** The archive starts with a ZIP local file header (`PK\x03\x04`). */
const hasLocalFileHeader = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x50 &&
  bytes[1] === 0x4b &&
  bytes[2] === 0x03 &&
  bytes[3] === 0x04;

interface CentralDirectory {
  readonly offset: number;
  readonly size: number;
  readonly entries: number;
  readonly end: number;
}

/** Admit a classic directory only when its offset describes this selected disk. */
const classicDirectory = (
  eocd: ZipEndOfCentralDirectory,
): Result<CentralDirectory, ApkSigningBlockError> => {
  if (!zipEndUsesSingleVolume(eocd))
    return err({
      kind: "multi-disk-unsupported",
      detail: `classic EOCD names disk ${String(eocd.disk)} and central-directory disk ${String(eocd.directoryDisk)}`,
    });
  if (eocd.entriesOnDisk !== eocd.totalEntries)
    return err({
      kind: "malformed-zip",
      offset: eocd.offset + 8,
      detail: "single-disk ZIP entry counts disagree",
    });
  return ok({
    offset: eocd.directoryOffset,
    size: eocd.directorySize,
    entries: eocd.totalEntries,
    end: eocd.offset,
  });
};

const hasBlockMagic = (bytes: Uint8Array, cdOffset: number): boolean => {
  if (cdOffset < 16) return false;
  let magic = "";
  for (let i = 0; i < 16; i += 1)
    magic += String.fromCharCode(bytes[cdOffset - 16 + i]!);
  return magic === BLOCK_MAGIC;
};

const parseApkSigningBlockBytes = (
  blockBytes: Uint8Array,
  blockStart: number,
  trailingSize: number,
): Result<ApkSigningBlock, ApkSigningBlockError> => {
  const reader = new BinaryReader(
    Buffer.from(
      blockBytes.buffer,
      blockBytes.byteOffset,
      blockBytes.byteLength,
    ),
    true,
    "zip",
  );
  const leadingSize = u64(reader, 0);
  if (leadingSize === null || leadingSize !== trailingSize)
    return err({
      kind: "malformed-block",
      offset: blockStart,
      detail: "leading/trailing size mismatch",
    });

  const pairs: ApkSigningBlockPair[] = [];
  let cursor = 8;
  const pairsEnd = blockBytes.length - 24; // stop before trailing size + magic
  while (cursor < pairsEnd) {
    const length = u64(reader, cursor);
    const next =
      length === null
        ? undefined
        : apkSigningPairEnd(BigInt(length), cursor, pairsEnd);
    if (length === null || next === undefined)
      return err({
        kind: "malformed-block",
        offset: blockStart + cursor,
        detail: "pair length out of range",
      });
    if (pairs.length >= APK_SIGNING_BLOCK_MAX_PAIRS)
      return err(
        decodeLimit(
          "apk-signing-block",
          `APK Signing Block holds more signing-block-pairs than the ${String(APK_SIGNING_BLOCK_MAX_PAIRS)} limit.`,
          {
            name: "max_signing_block_pairs",
            maximum: APK_SIGNING_BLOCK_MAX_PAIRS,
          },
          { offset: blockStart + cursor },
        ),
      );
    const id = reader.u32(cursor + 8);
    const valueStart = cursor + 12;
    pairs.push({
      id,
      value: blockBytes.subarray(valueStart, valueStart + (length - 4)),
    });
    cursor = next;
  }
  return ok({ blockStart, pairs });
};

/** Maximum ZIP EOCD + comment + Zip64 locator + fixed Zip64 EOCD tail window. */
const ZIP_TAIL_WINDOW_BYTES =
  65535 + ZIP_EOCD_BYTES + ZIP64_LOCATOR.bytes + ZIP64_END.fixedBytes;

/**
 * Parse the ZIP end-of-central-directory from a random-access reader without
 * buffering the whole archive. Also returns the raw EOCD bytes when valid.
 */
export const parseZipTailFromReader = async (
  source: PrefixedByteSource,
): Promise<
  Result<
    { readonly tail: ZipTail; readonly eocdBytes: Uint8Array },
    ApkSigningBlockError
  >
> => {
  if (source.size < ZIP_EOCD_BYTES)
    return err({ kind: "not-a-zip", detail: "shorter than a ZIP EOCD record" });
  const tailLength = Math.min(source.size, ZIP_TAIL_WINDOW_BYTES);
  const tailStart = source.size - tailLength;
  const tailBuf = await source.readRange(tailStart, tailLength);
  const candidates = [...zipEndOfCentralDirectoryCandidates(tailBuf)].map(
    (candidate) => ({
      ...candidate,
      offset: candidate.offset + tailStart,
    }),
  );
  if (candidates.length > 1)
    return err({
      kind: "malformed-zip",
      offset: candidates[0]!.offset,
      detail: `${String(candidates.length)} end-of-central-directory records each end the archive (one inside another's comment); the central directory is ambiguous`,
    });
  const eocd = candidates[0];
  if (eocd === undefined)
    return hasLocalFileHeader(source.prefix)
      ? err({
          kind: "malformed-zip",
          offset: source.size,
          detail:
            "ZIP local headers present but no end-of-central-directory (truncated or damaged archive)",
        })
      : err({
          kind: "not-a-zip",
          detail: "no end-of-central-directory record",
        });

  const eocdOffset = eocd.offset;
  let cd: Result<CentralDirectory, ApkSigningBlockError>;
  const saturated =
    eocd.directoryOffset === ZIP_CLASSIC_DIRECTORY_LIMITS.offset ||
    eocd.directorySize === ZIP_CLASSIC_DIRECTORY_LIMITS.size ||
    eocd.totalEntries === ZIP_CLASSIC_DIRECTORY_LIMITS.count;
  if (!saturated) {
    cd = classicDirectory(eocd);
  } else {
    const locatorOffset = eocdOffset - ZIP64_LOCATOR.bytes;
    const locatorBuf =
      locatorOffset < 0
        ? new Uint8Array(0)
        : locatorOffset >= tailStart
          ? tailBuf.subarray(
              locatorOffset - tailStart,
              locatorOffset - tailStart + ZIP64_LOCATOR.bytes,
            )
          : await source.readRange(locatorOffset, ZIP64_LOCATOR.bytes);
    const locatorReader = new BinaryReader(
      Buffer.from(
        locatorBuf.buffer,
        locatorBuf.byteOffset,
        locatorBuf.byteLength,
      ),
      true,
      "zip",
    );
    const locator =
      locatorOffset < 0 ? undefined : readZip64Locator(locatorReader, 0);
    if (locator === undefined) {
      cd =
        eocd.directoryOffset !== ZIP_CLASSIC_DIRECTORY_LIMITS.offset &&
        eocd.directorySize !== ZIP_CLASSIC_DIRECTORY_LIMITS.size
          ? classicDirectory(eocd)
          : err({
              kind: "malformed-zip",
              offset: eocdOffset,
              detail: "missing Zip64 EOCD locator",
            });
    } else {
      const {
        disk: recordDisk,
        totalDisks,
        recordOffset: offsetOnDisk,
      } = locator;
      const maximumExact = BigInt(Number.MAX_SAFE_INTEGER);
      if (totalDisks === 0)
        cd = err({
          kind: "malformed-zip",
          offset: locatorOffset + ZIP64_LOCATOR.totalDisksOffset,
          detail: "Zip64 locator declares zero disks",
        });
      else if (recordDisk >= totalDisks)
        cd = err({
          kind: "malformed-zip",
          offset: locatorOffset + ZIP64_LOCATOR.diskOffset,
          detail: "Zip64 EOCD disk is outside the declared disk count",
        });
      else if (!zip64LocatorUsesSingleVolume(locator))
        cd = err({
          kind: "zip64-unsupported",
          detail: "multi-disk Zip64 archives are not supported",
        });
      else if (offsetOnDisk > maximumExact)
        cd = err({
          kind: "zip64-unsupported",
          detail: "Zip64 EOCD offset exceeds safe range",
        });
      else {
        const recordOffset = Number(offsetOnDisk);
        const available = Math.max(0, locatorOffset - recordOffset);
        const readLength = Math.min(available, ZIP64_END.fixedBytes);
        const recordBuf =
          readLength === 0
            ? new Uint8Array(0)
            : recordOffset >= tailStart &&
                recordOffset + readLength <= tailStart + tailBuf.length
              ? tailBuf.subarray(
                  recordOffset - tailStart,
                  recordOffset - tailStart + readLength,
                )
              : await source.readRange(recordOffset, readLength);
        const recordReader = new BinaryReader(
          Buffer.from(
            recordBuf.buffer,
            recordBuf.byteOffset,
            recordBuf.byteLength,
          ),
          true,
          "zip",
        );
        const record = readZip64DirectoryRecord(recordReader, 0, available);
        if (!record.ok) {
          switch (record.error) {
            case "fixed-fields":
              cd = err({
                kind: "malformed-zip",
                offset: locatorOffset + ZIP64_LOCATOR.recordOffset,
                detail: "Zip64 EOCD record extends beyond its locator",
              });
              break;
            case "signature":
              cd = err({
                kind: "malformed-zip",
                offset: recordOffset,
                detail: "invalid Zip64 EOCD signature",
              });
              break;
            case "size":
              cd = err({
                kind: "malformed-zip",
                offset: recordOffset + ZIP64_END.sizeOffset,
                detail: "invalid Zip64 EOCD record size",
              });
              break;
          }
        } else if (
          !zipEndUsesSingleVolume(eocd, "zip64Classic") ||
          !zip64EndUsesSingleVolume(record.value)
        ) {
          cd = err({
            kind: "zip64-unsupported",
            detail:
              "Zip64 end records do not describe the selected single disk",
          });
        } else if (record.value.entriesOnDisk !== record.value.totalEntries) {
          cd = err({
            kind: "malformed-zip",
            offset: recordOffset + ZIP64_END.entriesOnDiskOffset,
            detail: "single-disk Zip64 entry counts disagree",
          });
        } else if (
          record.value.directoryOffset > maximumExact ||
          record.value.directorySize > maximumExact ||
          record.value.totalEntries > maximumExact
        ) {
          cd = err({
            kind: "zip64-unsupported",
            detail: "Zip64 sizes exceed safe range",
          });
        } else {
          cd = ok({
            offset: Number(record.value.directoryOffset),
            size: Number(record.value.directorySize),
            entries: Number(record.value.totalEntries),
            end: recordOffset,
          });
        }
      }
    }
  }
  if (!cd.ok) return cd;
  if (
    cd.value.offset > cd.value.end ||
    cd.value.size > cd.value.end - cd.value.offset
  )
    return err({
      kind: "malformed-zip",
      offset: eocdOffset,
      detail:
        "central-directory extent overlaps or extends past the ZIP end records",
    });
  if (
    (cd.value.entries === 0 || cd.value.size === 0) &&
    hasLocalFileHeader(source.prefix)
  )
    return err({
      kind: "malformed-zip",
      offset: eocdOffset,
      detail:
        "end-of-central-directory declares no entries, but the archive holds local file entries",
    });
  return ok({
    tail: {
      eocdOffset,
      centralDirectoryOffset: cd.value.offset,
      centralDirectorySize: cd.value.size,
      totalEntries: cd.value.entries,
      classicEntryCount: eocd.totalEntries,
    },
    eocdBytes: tailBuf.subarray(eocdOffset - tailStart),
  });
};

/**
 * Locate and frame the APK Signing Block from a random-access reader without
 * buffering the whole archive.
 */
export const locateApkSigningBlockFromReader = async (
  source: PrefixedByteSource,
  tail: ZipTail,
): Promise<Result<ApkSigningBlock | null, ApkSigningBlockError>> => {
  const cdOffset = tail.centralDirectoryOffset;
  if (cdOffset < 16) return ok(null);
  const footerStart = Math.max(0, cdOffset - 24);
  const footer = await source.readRange(footerStart, cdOffset - footerStart);
  if (!hasBlockMagic(footer, footer.length)) return ok(null);
  if (cdOffset < 24)
    return err({
      kind: "malformed-block",
      offset: cdOffset - 24,
      detail: "bad trailing size",
    });
  const footerReader = new BinaryReader(
    Buffer.from(footer.buffer, footer.byteOffset, footer.byteLength),
    true,
    "zip",
  );
  const trailingSize = u64(footerReader, 0);
  if (trailingSize === null || trailingSize < 24)
    return err({
      kind: "malformed-block",
      offset: cdOffset - 24,
      detail: "bad trailing size",
    });
  const blockStart = cdOffset - trailingSize - 8;
  if (blockStart < 0)
    return err({
      kind: "malformed-block",
      offset: cdOffset,
      detail: "block extends before file start",
    });
  const blockBytes = await source.readRange(blockStart, cdOffset - blockStart);
  return parseApkSigningBlockBytes(blockBytes, blockStart, trailingSize);
};
