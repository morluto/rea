import { crc32 } from "node:zlib";

import { BinaryReader } from "../binaryContainer.js";
import {
  ZIP_EOCD_BYTES,
  ZIP_MAX_COMMENT_BYTES,
  zip64EndUsesSingleVolume,
  zipEndOfCentralDirectoryCandidates,
  zipEndUsesSingleVolume,
} from "../zipEndOfCentralDirectory.js";
import { strictUtf8Decoder } from "../strictUtf8.js";
import { ZIP_EXTRA_FIELD, lastZipExtraField } from "../zip/zipExtraFields.js";

const CENTRAL_HEADER = 0x02014b50;
const CENTRAL_HEADER_BYTES = 46;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_END = 0x06064b50;
const ZIP64_END_BYTES = 56;
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
const directoryEnd = (view: DataView) => {
  const window = Math.max(
    0,
    view.byteLength - ZIP_EOCD_BYTES - ZIP_MAX_COMMENT_BYTES,
  );
  const found = zipEndOfCentralDirectoryCandidates(
    new Uint8Array(
      view.buffer,
      view.byteOffset + window,
      view.byteLength - window,
    ),
  ).next();
  if (found.done === true) return undefined;
  const eocd = found.value;
  const end = window + eocd.offset;
  const { totalEntries, directorySize, directoryOffset } = eocd;
  const classic = zipEndUsesSingleVolume(eocd)
    ? { end, size: directorySize, declaredOffset: directoryOffset }
    : undefined;
  const locator = end - ZIP64_LOCATOR_BYTES;
  const record = locator - ZIP64_END_BYTES;
  // Like Python's zipfile, a Zip64 locator is followed whether or not the classic record defers to it.
  if (record < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR)
    return classic;
  // Read just before its locator, where zipfile and zip.js look when the locator's own offset holds no Zip64 record.
  if (view.getUint32(record, true) === ZIP64_END) {
    if (
      !zipEndUsesSingleVolume(eocd, "zip64Classic") ||
      !zip64EndUsesSingleVolume(view, locator, record)
    )
      return undefined;
    return {
      end: record,
      size: Number(view.getBigUint64(record + 40, true)),
      declaredOffset: Number(view.getBigUint64(record + 48, true)),
    };
  }
  // Without one the classic values stand, as zip.js reads them, unless they are sentinels deferring to it.
  const deferred =
    totalEntries === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff;
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
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const located = directoryEnd(view);
  if (located === undefined) return undefined;
  const start = located.end - located.size;
  if (start < 0) return undefined;
  const reader = new BinaryReader(
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    true,
    "zip",
  );
  const records: Uint8Array[] = [];
  let count = 0;
  for (let at = start; at < located.end;) {
    if (
      at + CENTRAL_HEADER_BYTES > located.end ||
      view.getUint32(at, true) !== CENTRAL_HEADER
    )
      return undefined;
    const name = at + CENTRAL_HEADER_BYTES;
    const extra = name + view.getUint16(at + 28, true);
    const comment = extra + view.getUint16(at + 30, true);
    const next = comment + view.getUint16(at + 32, true);
    if (next > located.end) return undefined;
    const slash = endsInSlash(reader, {
      name,
      extra,
      comment,
      flags: view.getUint16(at + 8, true),
    });
    if (slash === undefined) return undefined;
    const external = view.getUint32(at + 38, true);
    const directory =
      slash ||
      ((external >>> 16) & UNIX_TYPE) === UNIX_DIRECTORY ||
      (view.getUint16(at + 4, true) >> 8 === 0 &&
        (external & MSDOS_DIRECTORY) !== 0);
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
  const tail = new Uint8Array(size + ZIP_EOCD_BYTES);
  let at = 0;
  for (const record of directory.records) {
    tail.set(record, at);
    at += record.length;
  }
  const end = new DataView(tail.buffer, size);
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, directory.records.length, true);
  end.setUint16(10, directory.records.length, true);
  end.setUint32(12, size, true);
  // A declared offset past 32 bits cannot be right for a view-sized archive; the start stands in for it.
  end.setUint32(
    16,
    directory.declaredOffset <= 0xffffffff
      ? directory.declaredOffset
      : directory.start,
    true,
  );
  return tail;
};
