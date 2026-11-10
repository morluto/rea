import { err, ok, type Result } from "../result.js";
import type {
  RegionDecodeFailure,
  RegionFileAdmissionLimit,
  RegionDecoder,
} from "../firmware/regionDecoder.js";

/** An NTFS FILE record begins with this signature. */
export const MFT_FILE_RECORD_MAGIC = "FILE";
export const MFT_FILE_RECORD_MAGIC_BYTES = 4;
/** The shortest header worth reading: a FILE record header ends at `nextAttributeId`. */
export const NTFS_MFT_MIN_RECORD_BYTES = 48;

/**
 * The `FILE` signature at file offset 0. An MFT stream is a run of fixed-size
 * FILE records, so the first record's signature is the recognition fact;
 * whether every record parses is the reader's question, not classification's.
 */
export const hasMftFileRecordSignature = (prefix: Uint8Array): boolean =>
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
 * Whole-file ceiling used when `REA_NTFS_MFT_MAX_FILE_BYTES` is unset.
 * Headers and fixups are inventoried without attribute payloads, so the
 * default stays below a volume-sized MFT until an operator raises it.
 */
export const NTFS_MFT_MAX_FILE_SETTING = "REA_NTFS_MFT_MAX_FILE_BYTES";
/** Runtime id accepted by `update_analysis_settings`. The environment name seeds it. */
export const NTFS_MFT_MAX_FILE_SETTING_ID = "ntfs.mft_max_file_bytes" as const;
export const DEFAULT_NTFS_MFT_MAX_FILE_BYTES = 512 * 1024 * 1024;
/** A lower ceiling cannot admit one FILE record header. */
export const MINIMUM_NTFS_MFT_MAX_FILE_BYTES = NTFS_MFT_MIN_RECORD_BYTES;
/**
 * Largest configurable whole-file admission. The reader copies the admitted
 * file into one buffer. 8 GiB is an REA policy ceiling, not a measurement of
 * host memory.
 */
export const MAXIMUM_NTFS_MFT_MAX_FILE_BYTES = 8 * 1024 * 1024 * 1024;

/** Effective whole-file ceiling and where that value came from. */
export interface NtfsMftFileAdmission {
  readonly maximumBytes: number;
  readonly source: "default" | "setting" | "runtime";
}

export const NTFS_MFT_FILE_LIMIT_CODE = "ntfs_mft_file_size";

/** Structured refusal when a file is outside the effective whole-file ceiling. */
export interface NtfsMftFileLimit extends RegionFileAdmissionLimit {
  readonly code: typeof NTFS_MFT_FILE_LIMIT_CODE;
  readonly setting: typeof NTFS_MFT_MAX_FILE_SETTING_ID;
}

export const ntfsMftFileLimit = (
  fileBytes: number,
  admission: NtfsMftFileAdmission,
): NtfsMftFileLimit => ({
  code: NTFS_MFT_FILE_LIMIT_CODE,
  setting: NTFS_MFT_MAX_FILE_SETTING_ID,
  fileBytes: Number.isSafeInteger(fileBytes) ? fileBytes : null,
  maximumBytes: admission.maximumBytes,
  source: admission.source,
  defaultBytes: DEFAULT_NTFS_MFT_MAX_FILE_BYTES,
  floorBytes: MINIMUM_NTFS_MFT_MAX_FILE_BYTES,
  maximumSettingBytes: MAXIMUM_NTFS_MFT_MAX_FILE_BYTES,
  updateMode: "runtime",
  pendingRestart: false,
});

/** Name the effective ceiling, its source, the allowed range, and the runtime update. */
export const ntfsMftFileLimitMessage = (limit: NtfsMftFileLimit): string =>
  [
    `The effective ${limit.setting} value is ${String(limit.maximumBytes)} bytes (source ${limit.source}; default ${String(limit.defaultBytes)} bytes, floor ${String(limit.floorBytes)} bytes, maximum ${String(limit.maximumSettingBytes)} bytes).`,
    limit.fileBytes === null
      ? "The supplied length is not a safe integer."
      : `The file is ${String(limit.fileBytes)} bytes.`,
    `On MCP, call update_analysis_settings with setting ${limit.setting}, action set, and a value in bytes from ${String(limit.floorBytes)} to ${String(limit.maximumSettingBytes)}, then retry the original request. It applies to the next operation without restarting REA. For CLI or future REA processes, set ${NTFS_MFT_MAX_FILE_SETTING} in the launch environment.`,
  ].join(" ");

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
const RECORD_HEADER_BYTES = NTFS_MFT_MIN_RECORD_BYTES;

const FILE_RECORD_IN_USE = 0x0001;
const FILE_RECORD_IS_DIRECTORY = 0x0002;
const FILE_RECORD_NAMES = new Map<number, string>([
  [FILE_RECORD_IN_USE, "in-use"],
  [FILE_RECORD_IS_DIRECTORY, "directory"],
  [0x0004, "extension"],
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

export interface MftRecord {
  /** Zero-based ordinal of this record in the stream. */
  readonly index: number;
  /** File offset where the record starts. */
  readonly fileOffset: number;
  readonly sequenceNumber: number;
  /** Hard link count as recorded; a zero count marks a record with no names. */
  readonly hardLinkCount: number;
  readonly flags: { readonly raw: number; readonly names: readonly string[] };
  readonly inUse: boolean;
  readonly directory: boolean;
  /** Bytes the record claims it uses, and the record size it was parsed at. */
  readonly usedBytes: number;
  readonly totalBytes: number;
  /** The base record this is an extension of, or `null` for a base record. */
  readonly baseRecordReference: number | null;
  /** The record number the header declares; `null` when the header predates the field. */
  readonly declaredRecordNumber: number | null;
  /** `$LogFile` sequence number as recorded; no log is read. */
  readonly logFileSequenceNumber: number;
  /** Declared offset of the first attribute; no attribute decoding follows yet. */
  readonly firstAttributeOffset: number;
  /** Declared id of the next attribute; no attribute decoding follows yet. */
  readonly nextAttributeId: number;
  readonly fixups: MftRecordFixups;
}

export interface MftImage {
  readonly metadata: MftMetadata;
  /** The record size the stream declared, or the fixed default when it did not. */
  readonly recordBytes: number;
  readonly records: readonly MftRecord[];
  readonly limitations: readonly string[];
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
  fileAdmission?: RegionDecodeFailure["fileAdmission"],
): RegionDecodeFailure => ({
  kind: "limit",
  message,
  ...(boundary === undefined ? {} : { boundary }),
  ...(fileAdmission === undefined ? {} : { fileAdmission }),
});

const namesOf = (raw: number): readonly string[] => {
  const names: string[] = [];
  for (const [bit, name] of FILE_RECORD_NAMES)
    if ((raw & bit) !== 0) names.push(name);
  return names;
};

const isRecordSize = (bytes: number): boolean =>
  bytes >= MFT_MIN_RECORD_BYTES &&
  bytes <= MFT_MAX_RECORD_BYTES &&
  (bytes & (bytes - 1)) === 0;

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

  const records: MftRecord[] = [];
  for (
    let offset = 0;
    offset + recordBytes <= bytes.length;
    offset += recordBytes
  ) {
    if (
      text(bytes.subarray(offset, offset + MFT_FILE_RECORD_MAGIC_BYTES)) !==
      MFT_FILE_RECORD_MAGIC
    ) {
      limitations.push(
        `record at ${String(offset)} does not begin with the FILE signature; ${String(records.length)} record(s) were examined`,
      );
      break;
    }
    records.push(readRecord(bytes, offset, records.length, recordBytes));
  }

  const truncatedTailBytes = bytes.length % recordBytes;
  if (truncatedTailBytes !== 0)
    limitations.push(
      `${String(truncatedTailBytes)} trailing byte(s) do not fill a ${String(recordBytes)}-byte record and were not parsed`,
    );

  const mismatchCount = records.filter(
    (record) => record.fixups.mismatchSector !== null,
  ).length;
  if (mismatchCount !== 0)
    limitations.push(
      `${String(mismatchCount)} record(s) hold a sector trailer that is not the update sequence number; their attributes were not read and no later step should trust them`,
    );
  const unverifiedCount = records.filter(
    (record) =>
      record.fixups.mismatchSector === null &&
      (record.fixups.malformed ||
        record.fixups.coveredSectors < recordBytes / FIXUP_SECTOR_BYTES),
  ).length;
  if (unverifiedCount !== 0)
    limitations.push(
      `${String(unverifiedCount)} record(s) carry an update sequence array that does not cover every sector; those trailers were neither restored nor verified`,
    );

  const metadata: MftMetadata = {
    kind: "ntfs-mft",
    record_bytes: recordBytes,
    record_count: records.length,
    in_use_record_count: records.filter((record) => record.inUse).length,
    directory_record_count: records.filter((record) => record.directory).length,
    extension_record_count: records.filter(
      (record) => record.baseRecordReference !== null,
    ).length,
    fixup_mismatch_count: mismatchCount,
    fixup_unverified_record_count: unverifiedCount,
    truncated_tail_bytes: truncatedTailBytes,
  };

  return ok({ metadata, recordBytes, records, limitations });
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

  return {
    index,
    fileOffset,
    sequenceNumber: view.getUint16(RECORD_HEADER.sequenceNumber, true),
    hardLinkCount: view.getUint16(RECORD_HEADER.hardLinkCount, true),
    flags: { raw: flags, names: namesOf(flags) },
    inUse: (flags & FILE_RECORD_IN_USE) !== 0,
    directory: (flags & FILE_RECORD_IS_DIRECTORY) !== 0,
    usedBytes: view.getUint32(RECORD_HEADER.usedBytes, true),
    totalBytes: view.getUint32(RECORD_HEADER.totalBytes, true),
    baseRecordReference:
      baseRecordReference === 0n
        ? null
        : Number(baseRecordReference & 0xffff_ffff_ffffn),
    declaredRecordNumber:
      recordBytes >= RECORD_HEADER.recordNumber + 4
        ? view.getUint32(RECORD_HEADER.recordNumber, true)
        : null,
    logFileSequenceNumber: Number(
      view.getBigUint64(RECORD_HEADER.logFileSequenceNumber, true),
    ),
    firstAttributeOffset: view.getUint16(
      RECORD_HEADER.firstAttributeOffset,
      true,
    ),
    nextAttributeId: view.getUint16(RECORD_HEADER.nextAttributeId, true),
    fixups: verifyFixups(record, view),
  };
};

/**
 * Each sector's last two bytes are replaced on disk by the update sequence
 * number; the array's first entry is that number and the rest are the saved
 * trailer words. A sector whose trailer is not the sequence number was not
 * cleanly written, so the record's attributes cannot be trusted.
 */
const verifyFixups = (record: Uint8Array, view: DataView): MftRecordFixups => {
  const usaOffset = view.getUint16(RECORD_HEADER.updateSequenceOffset, true);
  const usaCount = view.getUint16(RECORD_HEADER.updateSequenceCount, true);
  const sectors = Math.floor(record.length / FIXUP_SECTOR_BYTES);
  // Entry 0 holds the sequence number, so sector n's saved trailer is entry n+1.
  const coveredSectors = Math.min(sectors, Math.max(0, usaCount - 1));

  if (
    usaCount < USA_MIN_ENTRIES ||
    usaOffset < RECORD_HEADER_BYTES ||
    usaOffset + usaCount * 2 > record.length ||
    coveredSectors === 0
  )
    return {
      sequenceNumber: 0,
      entries: usaCount,
      verifiedSectors: 0,
      coveredSectors: 0,
      mismatchSector: null,
      malformed: true,
    };

  const sequenceNumber = view.getUint16(usaOffset, true);
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

/** Streaming form of the same parse: the whole admitted file is buffered once. */
class StreamingMftDecoder implements RegionDecoder<MftImage> {
  readonly #chunks: Uint8Array[] = [];
  #length = 0;

  constructor(readonly fileBytes: number) {}

  write(chunk: Uint8Array): Result<void, RegionDecodeFailure> {
    this.#chunks.push(chunk);
    this.#length += chunk.length;
    return ok(undefined);
  }

  finish(): Result<MftImage, RegionDecodeFailure> {
    const bytes = new Uint8Array(this.#length);
    let written = 0;
    for (const chunk of this.#chunks) {
      bytes.set(chunk, written);
      written += chunk.length;
    }
    return parseMftImage(bytes);
  }
}

export const createMftDecoder = (
  fileBytes: number,
  admission: NtfsMftFileAdmission = {
    maximumBytes: DEFAULT_NTFS_MFT_MAX_FILE_BYTES,
    source: "default",
  },
): Result<RegionDecoder<MftImage>, RegionDecodeFailure> => {
  if (
    Number.isSafeInteger(fileBytes) &&
    fileBytes >= 0 &&
    fileBytes <= admission.maximumBytes
  )
    return ok(new StreamingMftDecoder(fileBytes));
  const fileLimit = ntfsMftFileLimit(fileBytes, admission);
  return err(limit(ntfsMftFileLimitMessage(fileLimit), "file-size", fileLimit));
};
