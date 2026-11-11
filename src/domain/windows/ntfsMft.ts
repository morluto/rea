import { err, ok, type Result } from "../result.js";
import type {
  RegionDecodeFailure,
  RegionDecoder,
} from "../firmware/regionDecoder.js";

/** An NTFS FILE record begins with this signature. */
const MFT_FILE_RECORD_MAGIC = "FILE";
const MFT_FILE_RECORD_MAGIC_BYTES = 4;
/** The shortest header worth reading: a FILE record header ends at `nextAttributeId`. */
const NTFS_MFT_MIN_RECORD_BYTES = 42;

const hasMftFileRecordSignature = (prefix: Uint8Array): boolean =>
  prefix.length >= MFT_FILE_RECORD_MAGIC_BYTES &&
  text(prefix.subarray(0, MFT_FILE_RECORD_MAGIC_BYTES)) ===
    MFT_FILE_RECORD_MAGIC;

/** A record's declared size is a power of two from 512 upward; 1024 is NTFS's default. */
export const MFT_DEFAULT_RECORD_BYTES = 1024;
const MFT_MIN_RECORD_BYTES = 512;
const MFT_MAX_RECORD_BYTES = 65536;
/** An update sequence array holds at least the sequence number and one fixup word. */
const USA_MIN_ENTRIES = 2;
/** NTFS fixes up one 512-byte sector at a time. */
const FIXUP_SECTOR_BYTES = 512;
/**
 * Fixed whole-file ceiling. Records are inventoried from their headers only;
 * attributes and their payloads are not decoded, so this is deliberately
 * smaller than a volume's MFT can be.
 */
export const MFT_MAX_FILE_BYTES = 512 * 1024 * 1024;
/** Limit the inline header sample independently of full stream coverage. */
export const MFT_INLINE_HEADER_LIMIT = 32;

/** FILE record header fields; offsets are from the record start. */
const RECORD_HEADER = {
  updateSequenceOffset: 4,
  updateSequenceCount: 6,
  logFileSequenceNumber: 8,
  sequenceNumber: 16,
  hardLinkCount: 18,
  firstAttributeOffset: 20,
  flags: 22,
  usedBytes: 24,
  totalBytes: 28,
  baseRecordReference: 32,
  nextAttributeId: 40,
  recordNumber: 44,
} as const;
const RECORD_HEADER_WITH_NUMBER_BYTES = 48;

const FILE_RECORD_IN_USE = 0x0001;
const FILE_RECORD_IS_DIRECTORY = 0x0002;
const FILE_RECORD_NAMES = new Map<number, string>([
  [FILE_RECORD_IN_USE, "in-use"],
  [FILE_RECORD_IS_DIRECTORY, "directory"],
  [0x0004, "system"],
  [0x0008, "view-index"],
]);

export interface MftRecordFixups {
  /** The update sequence number the array's first entry holds, or 0 when absent. */
  readonly sequenceNumber: number;
  readonly entries: number;
  /** Sectors whose trailer held the sequence number before a mismatch. */
  readonly verifiedSectors: number;
  /** Sectors the array covers; fewer than the record's sectors leaves a tail unverified. */
  readonly coveredSectors: number;
  /** The first sector whose trailer did not hold the sequence number, if any. */
  readonly mismatchSector: number | null;
  /** The array itself is missing, misplaced or too short to cover one sector. */
  readonly malformed: boolean;
}

export interface MftFileReference {
  readonly recordNumber: number;
  readonly sequenceNumber: number;
}

const decodeMftFileReference = (reference: bigint): MftFileReference => ({
  recordNumber: Number(reference & 0xffff_ffff_ffffn),
  sequenceNumber: Number(reference >> 48n),
});

export interface MftRecord {
  /** Zero-based ordinal of this record in the stream. */
  readonly index: number;
  /** File offset where the record starts. */
  readonly fileOffset: number;
  readonly sequenceNumber: number;
  /** Hard link count as recorded; a zero count marks a record with no names. */
  readonly hardLinkCount: number;
  readonly flags: {
    readonly raw: number;
    readonly names: readonly string[];
    readonly unknownMask: number;
  };
  readonly inUse: boolean;
  readonly directory: boolean;
  /** Used and allocated byte counts as declared by the FILE record. */
  readonly usedBytes: number;
  readonly totalBytes: number;
  readonly extentValid: boolean;
  /** The base record this is an extension of, or `null` for a base record. */
  readonly baseRecordReference: MftFileReference | null;
  /** The record number the header declares; `null` when the header predates the field. */
  readonly declaredRecordNumber: number | null;
  readonly recordNumberMatchesSlot: boolean | null;
  /** `$LogFile` sequence number as recorded; no log is read. */
  readonly logFileSequenceNumber: string;
  /** Declared offset of the first attribute; no attribute decoding follows yet. */
  readonly firstAttributeOffset: number;
  /** Declared id of the next attribute; no attribute decoding follows yet. */
  readonly nextAttributeId: number;
  readonly fixups: MftRecordFixups;
}

export interface MftInventory {
  readonly metadata: MftMetadata;
  /** The record size the stream declared, or the fixed default when it did not. */
  readonly recordBytes: number;
  readonly limitations: readonly string[];
}

export interface MftImage extends MftInventory {
  readonly records: readonly MftRecord[];
}

export interface MftMetadata {
  readonly kind: "ntfs-mft";
  readonly record_bytes: number;
  readonly record_count: number;
  readonly in_use_record_count: number;
  readonly directory_record_count: number;
  readonly extension_record_count: number;
  readonly fixup_mismatch_count: number;
  readonly fixup_unverified_record_count: number;
  readonly truncated_tail_bytes: number;
  readonly record_headers: readonly MftRecord[];
  readonly omitted_record_headers: number;
}

const text = (ascii: Uint8Array): string =>
  Buffer.from(ascii).toString("latin1");

const failure = (
  message: string,
  boundary?: RegionDecodeFailure["boundary"],
): RegionDecodeFailure => ({
  kind: "format",
  message,
  ...(boundary === undefined ? {} : { boundary }),
});

const limit = (
  message: string,
  boundary?: RegionDecodeFailure["boundary"],
): RegionDecodeFailure => ({
  kind: "limit",
  message,
  ...(boundary === undefined ? {} : { boundary }),
});

const parseRecordFlags = (raw: number): MftRecord["flags"] => {
  const names: string[] = [];
  let unknownMask = raw;
  for (const [bit, name] of FILE_RECORD_NAMES) {
    if ((raw & bit) !== 0) names.push(name);
    unknownMask &= ~bit;
  }
  return { raw, names, unknownMask };
};

const isRecordSize = (bytes: number): boolean =>
  bytes >= MFT_MIN_RECORD_BYTES &&
  bytes <= MFT_MAX_RECORD_BYTES &&
  (bytes & (bytes - 1)) === 0;

const updateSequenceArrayFits = (
  offset: number,
  entries: number,
  sectors: number,
): boolean =>
  entries >= USA_MIN_ENTRIES &&
  entries <= sectors + 1 &&
  offset >= NTFS_MFT_MIN_RECORD_BYTES &&
  offset % 2 === 0 &&
  offset + entries * 2 <= FIXUP_SECTOR_BYTES - 2;

/** Recognize a FILE header without requiring its trailers or attributes to verify. */
export const hasMftFileRecordHeader = (prefix: Uint8Array): boolean => {
  if (
    prefix.length < NTFS_MFT_MIN_RECORD_BYTES ||
    !hasMftFileRecordSignature(prefix)
  )
    return false;
  const view = new DataView(
    prefix.buffer,
    prefix.byteOffset,
    prefix.byteLength,
  );
  return (
    isRecordSize(view.getUint32(RECORD_HEADER.totalBytes, true)) ||
    updateSequenceArrayFits(
      view.getUint16(RECORD_HEADER.updateSequenceOffset, true),
      view.getUint16(RECORD_HEADER.updateSequenceCount, true),
      MFT_DEFAULT_RECORD_BYTES / FIXUP_SECTOR_BYTES,
    )
  );
};

/**
 * Parse FILE record headers and verify their update-sequence fixups.
 *
 * Only the record structure is established: attributes, their names, the
 * filenames and the USN journal are left to later steps, so no path, timestamp
 * or file identity beyond the record itself is claimed. A record whose fixup
 * does not match keeps its header facts, because the stream still declares it,
 * and the mismatch is reported on the record and counted in the metadata.
 */
export const parseMftImage = (
  bytes: Uint8Array,
): Result<MftImage, RegionDecodeFailure> => {
  const records: MftRecord[] = [];
  const inventory = scanMft(bytes, records);
  return inventory.ok ? ok({ ...inventory.value, records }) : inventory;
};

const scanMft = (
  bytes: Uint8Array,
  retainedRecords?: MftRecord[],
): Result<MftInventory, RegionDecodeFailure> => {
  if (bytes.length < NTFS_MFT_MIN_RECORD_BYTES)
    return err(
      failure(
        `file is ${String(bytes.length)} bytes, shorter than one ${String(NTFS_MFT_MIN_RECORD_BYTES)}-byte record header`,
      ),
    );
  if (!hasMftFileRecordSignature(bytes))
    return err(failure("record 0 does not begin with the FILE signature"));

  const limitations: string[] = [];
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredRecordBytes = header.getUint32(RECORD_HEADER.totalBytes, true);
  const recordBytes = isRecordSize(declaredRecordBytes)
    ? declaredRecordBytes
    : MFT_DEFAULT_RECORD_BYTES;
  if (!isRecordSize(declaredRecordBytes))
    limitations.push(
      `record 0 declares a record size of ${String(declaredRecordBytes)} bytes, which is not a supported power of two from ${String(MFT_MIN_RECORD_BYTES)} to ${String(MFT_MAX_RECORD_BYTES)}; records were read at the ${String(MFT_DEFAULT_RECORD_BYTES)}-byte default`,
    );

  const recordHeaders: MftRecord[] = [];
  let recordCount = 0;
  let inUseCount = 0;
  let directoryCount = 0;
  let extensionCount = 0;
  let mismatchCount = 0;
  let unverifiedCount = 0;
  let invalidSlots = 0;
  let invalidExtents = 0;
  let inconsistentRecordNumbers = 0;
  let firstInvalidExtentOffset: number | undefined;
  let firstInvalidOffset: number | undefined;
  for (
    let offset = 0;
    offset + recordBytes <= bytes.length;
    offset += recordBytes
  ) {
    if (
      !hasMftFileRecordSignature(
        bytes.subarray(offset, offset + MFT_FILE_RECORD_MAGIC_BYTES),
      )
    ) {
      invalidSlots += 1;
      firstInvalidOffset ??= offset;
      if (!isRecordSize(declaredRecordBytes)) break;
      continue;
    }
    const record = readRecord(bytes, offset, offset / recordBytes, recordBytes);
    retainedRecords?.push(record);
    if (recordHeaders.length < MFT_INLINE_HEADER_LIMIT)
      recordHeaders.push(record);
    recordCount += 1;
    if (record.inUse) inUseCount += 1;
    if (record.directory) directoryCount += 1;
    if (record.baseRecordReference !== null) extensionCount += 1;
    if (record.fixups.mismatchSector !== null) mismatchCount += 1;
    if (
      record.fixups.malformed ||
      record.fixups.coveredSectors < recordBytes / FIXUP_SECTOR_BYTES
    )
      unverifiedCount += 1;
    if (record.recordNumberMatchesSlot === false)
      inconsistentRecordNumbers += 1;
    if (!record.extentValid) {
      invalidExtents += 1;
      firstInvalidExtentOffset ??= offset;
    }
  }
  if (firstInvalidOffset !== undefined)
    limitations.push(
      `record at ${String(firstInvalidOffset)} does not begin with the FILE signature; ${String(invalidSlots)} slot(s) without a FILE signature were found`,
    );

  if (firstInvalidExtentOffset !== undefined)
    limitations.push(
      `${String(invalidExtents)} FILE record(s) declare inconsistent record extents, beginning at offset ${String(firstInvalidExtentOffset)}`,
    );

  if (inconsistentRecordNumbers !== 0)
    limitations.push(
      `${String(inconsistentRecordNumbers)} FILE record(s) declare a record number that disagrees with their stream slot`,
    );

  const truncatedTailBytes = bytes.length % recordBytes;
  if (truncatedTailBytes !== 0)
    limitations.push(
      `${String(truncatedTailBytes)} trailing byte(s) do not fill a ${String(recordBytes)}-byte record and were not parsed`,
    );

  if (mismatchCount !== 0)
    limitations.push(
      `${String(mismatchCount)} record(s) hold a sector trailer that is not the update sequence number; their attributes were not read and no later step should trust them`,
    );
  if (unverifiedCount !== 0)
    limitations.push(
      `${String(unverifiedCount)} record(s) carry an invalid or incomplete update sequence array; their sector trailers were not fully verified`,
    );

  const metadata: MftMetadata = {
    kind: "ntfs-mft",
    record_bytes: recordBytes,
    record_count: recordCount,
    in_use_record_count: inUseCount,
    directory_record_count: directoryCount,
    extension_record_count: extensionCount,
    fixup_mismatch_count: mismatchCount,
    fixup_unverified_record_count: unverifiedCount,
    truncated_tail_bytes: truncatedTailBytes,
    record_headers: recordHeaders,
    omitted_record_headers: recordCount - recordHeaders.length,
  };

  return ok({ metadata, recordBytes, limitations });
};

const readRecord = (
  bytes: Uint8Array,
  fileOffset: number,
  index: number,
  recordBytes: number,
): MftRecord => {
  const record = bytes.subarray(fileOffset, fileOffset + recordBytes);
  const view = new DataView(
    record.buffer,
    record.byteOffset,
    record.byteLength,
  );

  const flags = view.getUint16(RECORD_HEADER.flags, true);
  const baseRecordReference = view.getBigUint64(
    RECORD_HEADER.baseRecordReference,
    true,
  );

  const usaOffset = view.getUint16(RECORD_HEADER.updateSequenceOffset, true);
  const fixups = verifyFixups(record, view, usaOffset);
  const usedBytes = view.getUint32(RECORD_HEADER.usedBytes, true);
  const totalBytes = view.getUint32(RECORD_HEADER.totalBytes, true);
  const firstAttributeOffset = view.getUint16(
    RECORD_HEADER.firstAttributeOffset,
    true,
  );

  const usaLayoutValid = updateSequenceArrayFits(
    usaOffset,
    fixups.entries,
    recordBytes / FIXUP_SECTOR_BYTES,
  );
  const declaredRecordNumber =
    usaLayoutValid && usaOffset >= RECORD_HEADER_WITH_NUMBER_BYTES
      ? view.getUint32(RECORD_HEADER.recordNumber, true)
      : null;

  return {
    index,
    fileOffset,
    sequenceNumber: view.getUint16(RECORD_HEADER.sequenceNumber, true),
    hardLinkCount: view.getUint16(RECORD_HEADER.hardLinkCount, true),
    flags: parseRecordFlags(flags),
    inUse: (flags & FILE_RECORD_IN_USE) !== 0,
    directory: (flags & FILE_RECORD_IS_DIRECTORY) !== 0,
    usedBytes,
    totalBytes,
    extentValid:
      totalBytes === recordBytes &&
      usedBytes >= NTFS_MFT_MIN_RECORD_BYTES &&
      usedBytes % 8 === 0 &&
      usedBytes <= totalBytes &&
      firstAttributeOffset % 8 === 0 &&
      firstAttributeOffset >= NTFS_MFT_MIN_RECORD_BYTES &&
      firstAttributeOffset + 4 <= usedBytes &&
      (!usaLayoutValid ||
        firstAttributeOffset >= usaOffset + fixups.entries * 2),
    baseRecordReference:
      baseRecordReference === 0n
        ? null
        : decodeMftFileReference(baseRecordReference),
    declaredRecordNumber,
    recordNumberMatchesSlot:
      declaredRecordNumber === null ? null : declaredRecordNumber === index,
    logFileSequenceNumber: view
      .getBigUint64(RECORD_HEADER.logFileSequenceNumber, true)
      .toString(),
    firstAttributeOffset,
    nextAttributeId: view.getUint16(RECORD_HEADER.nextAttributeId, true),
    fixups,
  };
};

/**
 * Each sector's last two bytes are replaced on disk by the update sequence
 * number; the array's first entry is that number and the rest are the saved
 * trailer words. A sector whose trailer is not the sequence number was not
 * cleanly written, so the record's attributes cannot be trusted.
 */
const verifyFixups = (
  record: Uint8Array,
  view: DataView,
  usaOffset: number,
): MftRecordFixups => {
  const usaCount = view.getUint16(RECORD_HEADER.updateSequenceCount, true);
  const sectors = Math.floor(record.length / FIXUP_SECTOR_BYTES);
  // Entry 0 holds the sequence number, so sector n's saved trailer is entry n+1.
  const coveredSectors = Math.max(0, usaCount - 1);

  if (!updateSequenceArrayFits(usaOffset, usaCount, sectors))
    return {
      sequenceNumber: 0,
      entries: usaCount,
      verifiedSectors: 0,
      coveredSectors: 0,
      mismatchSector: null,
      malformed: true,
    };

  const sequenceNumber = view.getUint16(usaOffset, true);
  if (sequenceNumber === 0 || sequenceNumber === 0xffff)
    return {
      sequenceNumber,
      entries: usaCount,
      verifiedSectors: 0,
      coveredSectors,
      mismatchSector: null,
      malformed: true,
    };
  for (let sector = 0; sector < coveredSectors; sector += 1) {
    const trailerOffset = sector * FIXUP_SECTOR_BYTES + FIXUP_SECTOR_BYTES - 2;
    if (view.getUint16(trailerOffset, true) !== sequenceNumber)
      return {
        sequenceNumber,
        entries: usaCount,
        verifiedSectors: sector,
        coveredSectors,
        mismatchSector: sector,
        malformed: false,
      };
  }

  return {
    sequenceNumber,
    entries: usaCount,
    verifiedSectors: coveredSectors,
    coveredSectors,
    mismatchSector: null,
    malformed: false,
  };
};

/** Buffer the admitted input once while accepting arbitrary chunk boundaries. */
class StreamingMftDecoder implements RegionDecoder<MftInventory> {
  readonly #bytes: Uint8Array;
  #written = 0;

  constructor(fileBytes: number) {
    this.#bytes = new Uint8Array(fileBytes);
  }

  write(chunk: Uint8Array): Result<void, RegionDecodeFailure> {
    if (chunk.length > this.#bytes.length - this.#written)
      return err(failure("received more bytes than the admitted file length"));
    this.#bytes.set(chunk, this.#written);
    this.#written += chunk.length;
    return ok(undefined);
  }

  finish(): Result<MftInventory, RegionDecodeFailure> {
    if (this.#written !== this.#bytes.length)
      return err(failure("stream ended before the admitted file length"));
    return scanMft(this.#bytes);
  }
}

export const createMftDecoder = (
  fileBytes: number,
): Result<RegionDecoder<MftInventory>, RegionDecodeFailure> =>
  Number.isSafeInteger(fileBytes) &&
  fileBytes >= 0 &&
  fileBytes <= MFT_MAX_FILE_BYTES
    ? ok(new StreamingMftDecoder(fileBytes))
    : err(
        limit(
          `file is ${String(fileBytes)} bytes, exceeding the fixed ${String(MFT_MAX_FILE_BYTES)}-byte (512 MiB) ceiling`,
          "file-size",
        ),
      );
