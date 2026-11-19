import { crc32 } from "node:zlib";

import { BinaryReader } from "../binaryContainer.js";
import {
  ZIP_CLASSIC_DIRECTORY_LIMITS,
  ZIP64_END,
  ZIP64_LOCATOR,
  ZIP_EOCD_BYTES,
  readZip64DirectoryRecord,
  zip64EndUsesSingleVolume,
  zipEndOfCentralDirectoryCandidates,
  zipEndUsesSingleVolume,
} from "../zipEndOfCentralDirectory.js";
import { strictUtf8Decoder } from "../strictUtf8.js";
import { ZIP_EXTRA_FIELD, lastZipExtraField } from "../zip/zipExtraFields.js";

const CENTRAL_HEADER = 0x02014b50;
const CENTRAL_HEADER_BYTES = 46;
const UTF8_NAME = 0x800;
const UNIX_TYPE = 0o170000;
const UNIX_DIRECTORY = 0o040000;
const MSDOS_DIRECTORY = 0x10;
const STRICT_UTF8 = strictUtf8Decoder("preserve");

/** An archive's central directory read a record at a time, bounded to the records it keeps. */
export interface ZipDirectory {
  /** Where the directory begins; the bytes before it hold the entries. */
  readonly start: number;
  /** The directory offset the end record declares, which readers compare with `start` to allow for prepended data. */
  readonly declaredOffset: number;
  /** The first file entries' records, as stored, in directory order. */
  readonly records: readonly Uint8Array[];
  /** File entries the directory lists, directories left out. */
  readonly count: number;
}

/** Where the directory ends, how long it is and the offset it declares, from the end record and any Zip64 one. */
const directoryEnd = (reader: BinaryReader) => {
  const found = zipEndOfCentralDirectoryCandidates(reader.bytes).next();
  if (found.done === true) return undefined;
  const eocd = found.value;
  const end = eocd.offset;
  const { totalEntries, directorySize, directoryOffset } = eocd;
  const classic = zipEndUsesSingleVolume(eocd)
    ? { end, size: directorySize, declaredOffset: directoryOffset }
    : undefined;
  const locator = end - ZIP64_LOCATOR.bytes;
  // Like Python's zipfile, follow a locator whether or not the classic record defers to it.
  if (locator < 0 || reader.u32(locator) !== ZIP64_LOCATOR.signature)
    return classic;
  const declared = reader.word(locator + ZIP64_LOCATOR.recordOffset, 64);
  const fallback = locator - ZIP64_END.fixedBytes;
  // Keep the fixed-record fallback for archives with an unadjusted prepended offset.
  for (const at of [
    declared <= BigInt(fallback) ? Number(declared) : -1,
    fallback,
  ]) {
    const record = readZip64DirectoryRecord(reader, at, locator);
    if (!record.ok || record.value.end !== locator) continue;
    if (
      !zipEndUsesSingleVolume(eocd, "zip64Classic") ||
      !zip64EndUsesSingleVolume(reader, locator, at)
    )
      return undefined;
    return {
      end: at,
      size: Number(record.value.directorySize),
      declaredOffset: Number(record.value.directoryOffset),
    };
  }
  // Keep the classic values for a stray locator when the classic record is complete.
  const limits = ZIP_CLASSIC_DIRECTORY_LIMITS;
  const deferred =
    totalEntries === limits.count ||
    directorySize === limits.size ||
    directoryOffset === limits.offset;
  return deferred ? undefined : classic;
};

/** Where one record's name and extra field lie in the archive, and its flags. */
interface RecordName {
  readonly name: number;
  readonly extra: number;
  readonly comment: number;
  readonly flags: number;
}

/** The usable last Unicode Path, or null when the extra block is malformed. */
const unicodePath = (
  reader: BinaryReader,
  { name, extra, comment, flags }: RecordName,
): Uint8Array | undefined | null => {
  // zip.js indexes extra fields by ID with Map.set: the last occurrence
  // replaces earlier ones, even when that last claim fails validation.
  const selected = lastZipExtraField(
    reader,
    extra,
    comment,
    ZIP_EXTRA_FIELD.unicodePath,
  );
  if (!selected.ok) return null;
  if (selected.value === undefined) return undefined;
  const { start, end } = selected.value;
  const { bytes } = reader;
  return end - start >= 5 &&
    bytes[start] === 1 &&
    (flags & UTF8_NAME) === 0 &&
    reader.u32(start + 1) === crc32(bytes.subarray(name, extra))
    ? bytes.subarray(start + 5, end)
    : undefined;
};

/**
 * Whether an entry's name, as REA decodes it, ends in a slash; undefined when
 * its extra block is malformed or its name must be UTF-8 and is not. A plain
 * CP437 name is judged by its last byte, so most records are read without allocating.
 */
const endsInSlash = (
  reader: BinaryReader,
  record: RecordName,
): boolean | undefined => {
  const unicode =
    record.comment > record.extra ? unicodePath(reader, record) : undefined;
  if (unicode === null) return undefined;
  const { bytes } = reader;
  const utf8 =
    unicode ??
    ((record.flags & UTF8_NAME) === 0
      ? undefined
      : bytes.subarray(record.name, record.extra));
  if (utf8 === undefined)
    return record.extra > record.name && bytes[record.extra - 1] === 0x2f;
  try {
    return STRICT_UTF8.decode(utf8).endsWith("/");
  } catch {
    return undefined;
  }
};

/**
 * Read an archive's central directory a record at a time, keeping the first
 * `keep` file entries' records and counting the rest, so no more than those is
 * ever parsed into entries. Directories are told apart as zip.js tells them: a
 * final slash, a Unix directory mode, or the MS-DOS attribute. Undefined when
 * the directory cannot be found or a record in it is malformed.
 */
export const scanZipDirectory = (
  bytes: Uint8Array,
  keep: number,
): ZipDirectory | undefined => {
  const reader = new BinaryReader(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    true,
    "zip",
  );
  const located = directoryEnd(reader);
  if (located === undefined) return undefined;
  const start = located.end - located.size;
  if (start < 0) return undefined;
  const records: Uint8Array[] = [];
  let count = 0;
  for (let at = start; at < located.end;) {
    if (
      at + CENTRAL_HEADER_BYTES > located.end ||
      reader.u32(at) !== CENTRAL_HEADER
    )
      return undefined;
    const name = at + CENTRAL_HEADER_BYTES;
    const extra = name + reader.u16(at + 28);
    const comment = extra + reader.u16(at + 30);
    const next = comment + reader.u16(at + 32);
    if (next > located.end) return undefined;
    const slash = endsInSlash(reader, {
      name,
      extra,
      comment,
      flags: reader.u16(at + 8),
    });
    if (slash === undefined) return undefined;
    const external = reader.u32(at + 38);
    const directory =
      slash ||
      ((external >>> 16) & UNIX_TYPE) === UNIX_DIRECTORY ||
      (reader.u16(at + 4) >> 8 === 0 && (external & MSDOS_DIRECTORY) !== 0);
    if (!directory) {
      count += 1;
      if (records.length < keep) records.push(bytes.subarray(at, next));
    }
    at = next;
  }
  return { start, declaredOffset: located.declaredOffset, records, count };
};

/** The kept records and an end record for them alone, which follow the entries in the archive a reader is given. */
export const boundedDirectoryTail = (directory: ZipDirectory): Uint8Array => {
  const size = directory.records.reduce(
    (total, record) => total + record.length,
    0,
  );
  const {
    count: maxCount,
    size: maxSize,
    offset: maxOffset,
  } = ZIP_CLASSIC_DIRECTORY_LIMITS;
  const count = directory.records.length;
  // A declared offset past 32 bits cannot be right for a view-sized archive.
  const offset =
    directory.declaredOffset <= maxOffset
      ? directory.declaredOffset
      : directory.start;
  const wide = count >= maxCount || size >= maxSize || offset >= maxOffset;
  const wideBytes = wide ? ZIP64_END.fixedBytes + ZIP64_LOCATOR.bytes : 0;
  const tail = new Uint8Array(size + wideBytes + ZIP_EOCD_BYTES);
  let at = 0;
  for (const record of directory.records) {
    tail.set(record, at);
    at += record.length;
  }
  if (wide) {
    const record = new DataView(tail.buffer, size, ZIP64_END.fixedBytes);
    record.setUint32(0, ZIP64_END.signature, true);
    record.setBigUint64(
      ZIP64_END.sizeOffset,
      BigInt(ZIP64_END.fixedBytes - ZIP64_END.sizePrefixBytes),
      true,
    );
    record.setUint16(12, 45, true);
    record.setUint16(14, 45, true);
    record.setBigUint64(ZIP64_END.entriesOnDiskOffset, BigInt(count), true);
    record.setBigUint64(ZIP64_END.totalEntriesOffset, BigInt(count), true);
    record.setBigUint64(ZIP64_END.directorySizeOffset, BigInt(size), true);
    record.setBigUint64(ZIP64_END.directoryOffset, BigInt(offset), true);
    const locator = new DataView(
      tail.buffer,
      size + ZIP64_END.fixedBytes,
      ZIP64_LOCATOR.bytes,
    );
    locator.setUint32(0, ZIP64_LOCATOR.signature, true);
    locator.setBigUint64(
      ZIP64_LOCATOR.recordOffset,
      BigInt(offset) + BigInt(size),
      true,
    );
    locator.setUint32(16, 1, true);
  }
  const end = new DataView(tail.buffer, size + wideBytes, ZIP_EOCD_BYTES);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Math.min(count, maxCount), true);
  end.setUint16(10, Math.min(count, maxCount), true);
  end.setUint32(12, Math.min(size, maxSize), true);
  end.setUint32(16, Math.min(offset, maxOffset), true);
  return tail;
};
