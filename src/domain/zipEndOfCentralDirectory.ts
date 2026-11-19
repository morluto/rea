import { BinaryReader } from "./binaryContainer.js";
import { err, ok, type Result } from "./result.js";

/** Classic ZIP EOCD fixed record and its format-defined comment limit. */
export const ZIP_EOCD_BYTES = 22;
export const ZIP_MAX_COMMENT_BYTES = 0xffff;

/** Saturated classic directory fields defer to the Zip64 end record. */
export const ZIP_CLASSIC_DIRECTORY_LIMITS = {
  count: 0xffff,
  size: 0xffffffff,
  offset: 0xffffffff,
} as const;

/** ZIP APPNOTE §§4.3.14–15. Shared fixed fields within the variable-size frame. */
export const ZIP64_END = {
  signature: 0x06064b50,
  fixedBytes: 56,
  sizePrefixBytes: 12,
  sizeOffset: 4,
  diskOffset: 16,
  directoryDiskOffset: 20,
  entriesOnDiskOffset: 24,
  totalEntriesOffset: 32,
  directorySizeOffset: 40,
  directoryOffset: 48,
} as const;

export const ZIP64_LOCATOR = {
  signature: 0x07064b50,
  bytes: 20,
  diskOffset: 4,
  recordOffset: 8,
  totalDisksOffset: 16,
} as const;

type Zip64Locator = {
  readonly disk: number;
  readonly totalDisks: number;
  readonly recordOffset: bigint;
};

export const readZip64Locator = (
  reader: BinaryReader,
  offset: number,
): Zip64Locator | undefined => {
  if (
    offset < 0 ||
    offset + ZIP64_LOCATOR.bytes > reader.bytes.length ||
    reader.u32(offset) !== ZIP64_LOCATOR.signature
  )
    return undefined;
  return {
    disk: reader.u32(offset + ZIP64_LOCATOR.diskOffset),
    totalDisks: reader.u32(offset + ZIP64_LOCATOR.totalDisksOffset),
    recordOffset: reader.word(offset + ZIP64_LOCATOR.recordOffset, 64),
  };
};

type Zip64DirectoryRecord = {
  readonly end: number;
  readonly disk: number;
  readonly directoryDisk: number;
  readonly entriesOnDisk: bigint;
  readonly totalEntries: bigint;
  readonly directorySize: bigint;
  readonly directoryOffset: bigint;
};

/** Observe one complete Zip64 end record inside its declared carrier. */
export const readZip64DirectoryRecord = (
  reader: BinaryReader,
  offset: number,
  limit: number,
): Result<Zip64DirectoryRecord, "fixed-fields" | "signature" | "size"> => {
  const room = Math.min(limit, reader.bytes.length) - offset;
  if (offset < 0 || room < ZIP64_END.fixedBytes) return err("fixed-fields");
  if (reader.u32(offset) !== ZIP64_END.signature) return err("signature");
  const bodyBytes = reader.word(offset + ZIP64_END.sizeOffset, 64);
  if (
    bodyBytes < BigInt(ZIP64_END.fixedBytes - ZIP64_END.sizePrefixBytes) ||
    bodyBytes > BigInt(room - ZIP64_END.sizePrefixBytes)
  )
    return err("size");
  return ok({
    end: offset + ZIP64_END.sizePrefixBytes + Number(bodyBytes),
    disk: reader.u32(offset + ZIP64_END.diskOffset),
    directoryDisk: reader.u32(offset + ZIP64_END.directoryDiskOffset),
    entriesOnDisk: reader.word(offset + ZIP64_END.entriesOnDiskOffset, 64),
    totalEntries: reader.word(offset + ZIP64_END.totalEntriesOffset, 64),
    directorySize: reader.word(offset + ZIP64_END.directorySizeOffset, 64),
    directoryOffset: reader.word(offset + ZIP64_END.directoryOffset, 64),
  });
};

const EOCD_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

export const ZIP_CLASSIC_DISK_OFFSETS = { disk: 4, directoryDisk: 6 } as const;

/**
 * APPNOTE §§4.3.14–16 and §§4.4.19–20. The classic disk numbers can
 * defer to Zip64 only after a Zip64 end record has been located. The two
 * Zip64 layouts list 32-bit offsets and their required single-volume values.
 * The exported desktop reader consumes the same rules in Python.
 */
export const ZIP_SINGLE_VOLUME = {
  classic: [0],
  zip64Classic: [0, 0xffff],
  zip64Locator: [
    [ZIP64_LOCATOR.diskOffset, 0],
    [ZIP64_LOCATOR.totalDisksOffset, 1],
  ],
  zip64End: [
    [ZIP64_END.diskOffset, 0],
    [ZIP64_END.directoryDiskOffset, 0],
  ],
} as const;

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

/** Whether the observed classic end record admits the selected single volume. */
export const zipEndUsesSingleVolume = (
  {
    disk,
    directoryDisk,
  }: Pick<ZipEndOfCentralDirectory, "disk" | "directoryDisk">,
  layout: "classic" | "zip64Classic" = "classic",
): boolean => {
  const allowed: readonly number[] = ZIP_SINGLE_VOLUME[layout];
  return allowed.includes(disk) && allowed.includes(directoryDisk);
};

export const zip64LocatorUsesSingleVolume = ({
  disk,
  totalDisks,
}: Zip64Locator): boolean =>
  disk === ZIP_SINGLE_VOLUME.zip64Locator[0][1] &&
  totalDisks === ZIP_SINGLE_VOLUME.zip64Locator[1][1];

export const zip64EndUsesSingleVolume = ({
  disk,
  directoryDisk,
}: Zip64DirectoryRecord): boolean =>
  disk === ZIP_SINGLE_VOLUME.zip64End[0][1] &&
  directoryDisk === ZIP_SINGLE_VOLUME.zip64End[1][1];

/**
 * Observe complete classic records whose declared comment ends this window,
 * latest first. Candidate recognition does not establish directory validity,
 * ambiguity policy, disk support, or the meaning of Zip64 sentinel fields.
 */
export function* zipEndOfCentralDirectoryCandidates(
  bytes: Uint8Array,
): Generator<ZipEndOfCentralDirectory> {
  const earliest = Math.max(
    0,
    bytes.byteLength - ZIP_EOCD_BYTES - ZIP_MAX_COMMENT_BYTES,
  );
  const tail = Buffer.from(
    bytes.buffer,
    bytes.byteOffset + earliest,
    bytes.byteLength - earliest,
  );
  const reader = new BinaryReader(tail, true, "zip");
  for (let searchFrom = tail.length - ZIP_EOCD_BYTES; searchFrom >= 0;) {
    const offset = tail.lastIndexOf(EOCD_SIGNATURE, searchFrom);
    if (offset < 0) break;
    searchFrom = offset - 1;
    const commentLength = reader.u16(offset + 20);
    if (offset + ZIP_EOCD_BYTES + commentLength !== tail.length) continue;
    yield {
      offset: earliest + offset,
      disk: reader.u16(offset + ZIP_CLASSIC_DISK_OFFSETS.disk),
      directoryDisk: reader.u16(
        offset + ZIP_CLASSIC_DISK_OFFSETS.directoryDisk,
      ),
      entriesOnDisk: reader.u16(offset + 8),
      totalEntries: reader.u16(offset + 10),
      directorySize: reader.u32(offset + 12),
      directoryOffset: reader.u32(offset + 16),
      commentLength,
    };
  }
}
