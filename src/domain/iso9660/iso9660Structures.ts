import { BinaryReader } from "../binaryContainer.js";
import {
  DEFAULT_ISO9660_READER_LIMITS,
  type ArtifactReaderLimitParameter,
} from "../artifactReaderLimits.js";
import { decodeIso9660RecordDate } from "./iso9660Dates.js";
import type { Result } from "../result.js";
import {
  captureParseFailure,
  decodeLimit,
  malformedInput,
  truncatedInput,
  unsupportedInput,
  type LimitRef,
  type ParseFailureError,
} from "../parseFailure.js";

/**
 * ISO 9660 (ECMA-119) directory records and the bounds shared with the
 * volume descriptor parser. Both-endian fields are decoded from both halves
 * and must agree. Rock Ridge (SUSP) system-use fields are not decoded.
 */
export const ISO9660_FORMAT = "iso9660";
export const ISO9660_SECTOR_BYTES = 2048;
/** Sectors 0-15 are the system area; the descriptor set starts at sector 16. */
export const ISO9660_DESCRIPTOR_OFFSET = 16 * ISO9660_SECTOR_BYTES;
/** Descriptor type, `CD001`, and descriptor version. */
export const ISO9660_SIGNATURE_BYTES = 7;
/**
 * Content routing needs only the first descriptor's signature; an image that
 * ends inside that sector is recognized and then fails parsing as truncated.
 */
export const ISO9660_RECOGNITION_BYTES =
  ISO9660_DESCRIPTOR_OFFSET + ISO9660_SIGNATURE_BYTES;
/** Parsing needs at least one whole descriptor sector. */
export const ISO9660_MINIMUM_IMAGE_BYTES =
  ISO9660_DESCRIPTOR_OFFSET + ISO9660_SECTOR_BYTES;

export const ISO9660_STANDARD_IDENTIFIER = Buffer.from("CD001", "latin1");
export const ISO9660_DIRECTORY_RECORD_HEADER_BYTES = 33;

export const ISO9660_FLAG_DIRECTORY = 0x02;
export const ISO9660_FLAG_MULTI_EXTENT = 0x80;

type Iso9660LimitSpec = LimitRef & {
  readonly parameter: ArtifactReaderLimitParameter;
  readonly maximum: number;
  readonly unit: "bytes" | "count";
};

/** Descriptors read before the set terminator; real images use a handful. */
const DESCRIPTOR_LIMIT: Iso9660LimitSpec = {
  name: "ISO 9660 volume descriptor count",
  parameter: "artifact_limits.iso9660.descriptor_count",
  maximum: DEFAULT_ISO9660_READER_LIMITS.descriptor_count,
  unit: "count",
};
const DEPTH_LIMIT: Iso9660LimitSpec = {
  name: "ISO 9660 directory depth",
  parameter: "artifact_limits.iso9660.directory_depth",
  maximum: DEFAULT_ISO9660_READER_LIMITS.directory_depth,
  unit: "count",
};
const RECORD_LIMIT: Iso9660LimitSpec = {
  name: "ISO 9660 directory record count",
  parameter: "artifact_limits.iso9660.record_count",
  maximum: DEFAULT_ISO9660_READER_LIMITS.record_count,
  unit: "count",
};
/** Directory extents are read whole; their sum bounds retained record bytes. */
const DIRECTORY_BYTES_LIMIT: Iso9660LimitSpec = {
  name: "ISO 9660 directory extent bytes",
  parameter: "artifact_limits.iso9660.directory_bytes",
  maximum: DEFAULT_ISO9660_READER_LIMITS.directory_bytes,
  unit: "bytes",
};

/**
 * Every entry retains its full path and source path, so a deep tree of short
 * records expands far past its directory bytes; the UTF-8 sum is bounded.
 */
const PATH_BYTES_LIMIT: Iso9660LimitSpec = {
  name: "ISO 9660 expanded path bytes",
  parameter: "artifact_limits.iso9660.path_bytes",
  maximum: DEFAULT_ISO9660_READER_LIMITS.path_bytes,
  unit: "bytes",
};

export const ISO9660_LIMITS = {
  descriptors: DESCRIPTOR_LIMIT,
  depth: DEPTH_LIMIT,
  records: RECORD_LIMIT,
  directoryBytes: DIRECTORY_BYTES_LIMIT,
  pathBytes: PATH_BYTES_LIMIT,
} as const;

/**
 * Whether the bytes at {@link ISO9660_DESCRIPTOR_OFFSET} open a volume
 * descriptor. Recognition routes on the standard identifier alone; the
 * descriptor parser owns version support, so an unsupported version is
 * diagnosed the same way whichever descriptor comes first.
 */
export const hasIso9660Signature = (descriptor: Uint8Array): boolean =>
  descriptor.length >= ISO9660_SIGNATURE_BYTES &&
  Buffer.from(descriptor.subarray(1, 6)).equals(ISO9660_STANDARD_IDENTIFIER);

export interface Iso9660DirectoryRecord {
  /** Absolute image offset of the record. */
  readonly offset: number;
  readonly extendedAttributeLength: number;
  readonly extentLocation: number;
  readonly dataLength: number;
  readonly recordingDate: string | null;
  readonly flags: number;
  readonly fileUnitSize: number;
  readonly interleaveGapSize: number;
  readonly volumeSequenceNumber: number;
  readonly identifier: Buffer;
}

export type Iso9660ExtentLayout = "contiguous" | "fragmented" | "interleaved";

export interface Iso9660Extent {
  /** Absolute image offset of the directory record that declares this extent. */
  readonly recordOffset: number;
  readonly location: number;
  readonly extendedAttributeLength: number;
  readonly dataLength: number;
  /** Absolute image offset of the extent's data, after any extended attribute record. */
  readonly dataOffset: number;
  readonly fileUnitSize: number;
  readonly interleaveGapSize: number;
  /**
   * Bytes stored contiguously from `dataOffset`: the whole extent, or only
   * its first file unit when the extent is interleaved.
   */
  readonly leadingRunBytes: number;
}

export const iso9660Malformed = (
  detail: string,
  offset: number,
  field: string,
): ParseFailureError<"malformed"> =>
  malformedInput(ISO9660_FORMAT, `ISO 9660 image is malformed: ${detail}`, {
    offset,
    field,
  });

/** A decode allowance, reported with the effective limit and required value. */
export const iso9660LimitFailure = (
  limit: Iso9660LimitSpec,
  required: number,
  maximum = limit.maximum,
): ParseFailureError<"limit"> =>
  decodeLimit(
    ISO9660_FORMAT,
    `ISO 9660 image exceeds the ${limit.name} allowance of ${String(maximum)} ${limit.unit}`,
    { name: limit.name, maximum, required },
  );

/** Read a both-endian field: a little-endian half, then a big-endian copy. */
const readBothEndian = (
  bytes: Buffer,
  at: number,
  width: 2 | 4,
  base: number,
  field: string,
): number => {
  const little = new BinaryReader(bytes, true, ISO9660_FORMAT);
  const big = new BinaryReader(bytes, false, ISO9660_FORMAT);
  const value = width === 4 ? little.u32(at) : little.u16(at);
  const copy = width === 4 ? big.u32(at + width) : big.u16(at + width);
  if (value !== copy)
    throw iso9660Malformed(
      `both-endian ${field} halves disagree`,
      base + at,
      field,
    );
  return value;
};

export const readBothEndian32 = (
  bytes: Buffer,
  at: number,
  base: number,
  field: string,
): number => readBothEndian(bytes, at, 4, base, field);

export const readBothEndian16 = (
  bytes: Buffer,
  at: number,
  base: number,
  field: string,
): number => readBothEndian(bytes, at, 2, base, field);

/**
 * Decode one directory record that must end by `limit`.
 *
 * `fixedExtent.extent` is the record's bound when the caller has one the
 * length byte does not describe. `fixedExtent.identifierLength` is the
 * identifier's length when the caller has established it and the
 * identifier-length byte names a different stored length. Other callers
 * leave `fixedExtent` unset, so the record's own bytes stay the bound.
 */
export const iso9660DirectoryRecordAt = (
  bytes: Buffer,
  at: number,
  base: number,
  limit: number,
  fixedExtent?: {
    readonly extent: number;
    readonly identifierLength?: number;
  },
): Iso9660DirectoryRecord => {
  const length = fixedExtent?.extent ?? bytes[at] ?? 0;
  if (length < ISO9660_DIRECTORY_RECORD_HEADER_BYTES + 1)
    throw iso9660Malformed(
      `directory record length ${String(length)} is shorter than its fixed fields`,
      base + at,
      "length",
    );
  if (at + length > limit)
    throw iso9660Malformed(
      "directory record crosses a sector boundary",
      base + at,
      "length",
    );
  const identifierLength = fixedExtent?.identifierLength ?? bytes[at + 32] ?? 0;
  // An even-length identifier is followed by one zero padding byte.
  const padded = identifierLength % 2 === 0;
  const identifierEnd =
    at + ISO9660_DIRECTORY_RECORD_HEADER_BYTES + identifierLength;
  if (identifierLength === 0 || identifierEnd + (padded ? 1 : 0) > at + length)
    throw iso9660Malformed(
      `directory record identifier length ${String(identifierLength)} does not fit its record`,
      base + at + 32,
      "identifier_length",
    );
  if (padded && bytes[identifierEnd] !== 0)
    throw iso9660Malformed(
      "directory record padding byte after an even-length identifier is not zero",
      base + identifierEnd,
      "padding_field",
    );
  if (length % 2 !== 0)
    throw iso9660Malformed(
      "directory record length must be even",
      base + at,
      "length",
    );
  const flags = bytes[at + 25] ?? 0;
  if ((flags & 0x60) !== 0)
    throw iso9660Malformed(
      "directory record has reserved file flags set",
      base + at + 25,
      "file_flags",
    );
  if ((flags & ISO9660_FLAG_DIRECTORY) !== 0 && (flags & 0x0c) !== 0)
    throw iso9660Malformed(
      "directory record has an associated-file or record-format flag set",
      base + at + 25,
      "file_flags",
    );
  if (
    (flags & ISO9660_FLAG_DIRECTORY) !== 0 &&
    (flags & ISO9660_FLAG_MULTI_EXTENT) !== 0
  )
    throw iso9660Malformed(
      "a directory record cannot be part of a multi-extent file",
      base + at + 25,
      "file_flags",
    );
  const fileUnitSize = bytes[at + 26] ?? 0;
  const interleaveGapSize = bytes[at + 27] ?? 0;
  if (fileUnitSize === 0 && interleaveGapSize !== 0)
    throw iso9660Malformed(
      `interleave gap size ${String(interleaveGapSize)} is declared without a file unit size`,
      base + at + 27,
      "interleave_gap_size",
    );
  const extendedAttributeLength = bytes[at + 1] ?? 0;
  if (extendedAttributeLength === 0 && (flags & 0x18) !== 0)
    throw iso9660Malformed(
      "record-format and protection flags require an extended attribute record",
      base + at + 25,
      "file_flags",
    );
  if (
    fileUnitSize &&
    extendedAttributeLength &&
    extendedAttributeLength !== fileUnitSize
  )
    throw iso9660Malformed(
      "interleaved extended attributes must occupy the entire first file unit",
      base + at + 1,
      "extended_attribute_length",
    );
  return {
    offset: base + at,
    extendedAttributeLength,
    extentLocation: readBothEndian32(bytes, at + 2, base, "extent_location"),
    dataLength: readBothEndian32(bytes, at + 10, base, "data_length"),
    recordingDate: decodeIso9660RecordDate(bytes, at + 18),
    flags,
    fileUnitSize,
    interleaveGapSize,
    volumeSequenceNumber: readBothEndian16(
      bytes,
      at + 28,
      base,
      "volume_sequence_number",
    ),
    identifier: Buffer.from(
      bytes.subarray(at + ISO9660_DIRECTORY_RECORD_HEADER_BYTES, identifierEnd),
    ),
  };
};

/** The self (`.`, identifier 0x00) and parent (`..`, 0x01) records every directory opens with. */
export const ISO9660_MANDATORY_RECORDS = 2;

const special = (identifier: Buffer): boolean =>
  identifier.length === 1 && (identifier[0] === 0 || identifier[0] === 1);

const missingMandatoryRecord = (
  index: number,
  offset: number,
): ParseFailureError<"malformed"> =>
  iso9660Malformed(
    `directory extent lacks its ${index === 0 ? "self (.)" : "parent (..)"} record`,
    offset,
    "directory_record",
  );

/** The directory extents the opening `.` and `..` records must describe. */
export type Iso9660DirectoryLink = Pick<
  Iso9660DirectoryRecord,
  "extentLocation" | "dataLength" | "extendedAttributeLength"
>;

export interface Iso9660DirectoryLinks {
  /** The record that admitted this directory. */
  readonly self: Iso9660DirectoryLink;
  /** The record that admitted the parent directory; the root's parent is the root. */
  readonly parent: Iso9660DirectoryLink;
  /**
   * Also accept a `..` record that describes the directory itself. libisofs
   * (xorriso, mkisofs emulation) writes every Joliet `..` record that way.
   */
  readonly parentMayBeSelf?: boolean;
}

const assertMandatoryLink = (
  record: Iso9660DirectoryRecord,
  index: number,
  links: Iso9660DirectoryLinks,
): void => {
  const role = index === 0 ? "self (.)" : "parent (..)";
  const expected =
    index === 0 ||
    (links.parentMayBeSelf === true &&
      record.extentLocation === links.self.extentLocation)
      ? links.self
      : links.parent;
  if (iso9660DirectoryIsInterleaved(record))
    throw iso9660Malformed(
      `the ${role} record declares interleaving for a contiguous directory`,
      record.offset + 26,
      "file_unit_size",
    );
  if (record.extentLocation !== expected.extentLocation)
    throw iso9660Malformed(
      `the ${role} record references block ${String(record.extentLocation)}, not the ${index === 0 ? "directory's own" : "parent directory's"} extent at block ${String(expected.extentLocation)}`,
      record.offset + 2,
      "extent_location",
    );
  if (record.dataLength !== expected.dataLength)
    throw iso9660Malformed(
      `${role} record conflicts with the ${index === 0 ? "directory's" : "parent directory's"} data length`,
      record.offset + 10,
      "data_length",
    );
  if (record.extendedAttributeLength !== expected.extendedAttributeLength)
    throw iso9660Malformed(
      `${role} record conflicts with the ${index === 0 ? "directory's" : "parent directory's"} extended attribute length`,
      record.offset + 1,
      "extended_attribute_length",
    );
};

/**
 * One bounded unit of directory work: a record, or the zero padding that ends
 * one sector. Each step examines at most one sector, so a consumer can pace
 * long runs of records or padding.
 */
export type Iso9660DirectoryStep =
  | { readonly kind: "record"; readonly record: Iso9660DirectoryRecord }
  | {
      readonly kind: "padding";
      /** Absolute image offset of the padding. */
      readonly offset: number;
      readonly length: number;
    };

/**
 * A directory extent's records and the zero padding at sector ends, one step
 * at a time. The extent must open with its `.` and `..` records, referencing
 * its own and its parent's extents; padding or the end of the extent before
 * them is a damaged directory, not an empty one.
 */
export function* parseIso9660DirectoryExtent(
  bytes: Buffer,
  base: number,
  charge: () => void,
  volume: Iso9660VolumeSetMember,
  links: Iso9660DirectoryLinks,
): Generator<Iso9660DirectoryStep> {
  let at = 0;
  let index = 0;
  while (at < bytes.length) {
    const sectorEnd = Math.min(
      bytes.length,
      (Math.floor(at / ISO9660_SECTOR_BYTES) + 1) * ISO9660_SECTOR_BYTES,
    );
    const length = bytes[at] ?? 0;
    if (length === 0) {
      if (index < ISO9660_MANDATORY_RECORDS)
        throw missingMandatoryRecord(index, base + at);
      const discrepancy = bytes
        .subarray(at, sectorEnd)
        .findIndex((byte) => byte !== 0);
      if (discrepancy !== -1)
        throw iso9660Malformed(
          "nonzero byte in directory sector padding",
          base + at + discrepancy,
          "directory_padding",
        );
      yield { kind: "padding", offset: base + at, length: sectorEnd - at };
      at = sectorEnd;
      continue;
    }
    charge();
    const record = iso9660DirectoryRecordAt(bytes, at, base, sectorEnd);
    if (
      index < ISO9660_MANDATORY_RECORDS &&
      (record.identifier.length !== 1 ||
        record.identifier[0] !== index ||
        (record.flags & ISO9660_FLAG_DIRECTORY) === 0)
    )
      throw missingMandatoryRecord(index, record.offset);
    if (index < ISO9660_MANDATORY_RECORDS)
      assertMandatoryLink(record, index, links);
    if (index >= ISO9660_MANDATORY_RECORDS && special(record.identifier))
      throw iso9660Malformed(
        `identifier 0x0${String(record.identifier[0])} is reserved for the opening . and .. records`,
        record.offset + ISO9660_DIRECTORY_RECORD_HEADER_BYTES,
        "file_identifier",
      );
    assertIso9660Volume(record, volume);
    yield { kind: "record", record };
    index += 1;
    at += length;
  }
  if (index < ISO9660_MANDATORY_RECORDS)
    throw missingMandatoryRecord(index, base + at);
}

/** The volume set a descriptor declares and the member it describes. */
export interface Iso9660VolumeSetMember {
  readonly size: number;
  readonly sequence: number;
}

/**
 * A record on this volume is readable. A number outside the declared set
 * names no member and is malformed; another member of the set is a real
 * external reference this single-image reader does not follow.
 */
export const assertIso9660Volume = (
  record: Iso9660DirectoryRecord,
  volume: Iso9660VolumeSetMember,
): void => {
  const declared = record.volumeSequenceNumber;
  if (declared === volume.sequence) return;
  const site = { offset: record.offset + 28, field: "volume_sequence_number" };
  if (declared === 0 || declared > volume.size)
    throw iso9660Malformed(
      `directory record volume sequence number ${String(declared)} is outside the volume set of ${String(volume.size)}`,
      site.offset,
      site.field,
    );
  throw unsupportedInput(
    ISO9660_FORMAT,
    `Directory record refers to volume ${String(declared)} of the set, not volume ${String(volume.sequence)}`,
    site,
  );
};

export const extentOf = (
  record: Pick<
    Iso9660DirectoryRecord,
    | "offset"
    | "extentLocation"
    | "extendedAttributeLength"
    | "dataLength"
    | "fileUnitSize"
    | "interleaveGapSize"
  >,
): Iso9660Extent => ({
  recordOffset: record.offset,
  location: record.extentLocation,
  extendedAttributeLength: record.extendedAttributeLength,
  dataLength: record.dataLength,
  dataOffset:
    (record.extentLocation +
      record.extendedAttributeLength +
      (record.extendedAttributeLength > 0 ? record.interleaveGapSize : 0)) *
    ISO9660_SECTOR_BYTES,
  fileUnitSize: record.fileUnitSize,
  interleaveGapSize: record.interleaveGapSize,
  leadingRunBytes:
    record.fileUnitSize === 0
      ? record.dataLength
      : Math.min(record.dataLength, record.fileUnitSize * ISO9660_SECTOR_BYTES),
});

/**
 * Where an extent's last byte ends in the image. Interleaved file units of
 * `fileUnitSize` blocks are separated by `interleaveGapSize` blocks, so the
 * physical span exceeds the logical length by every gap before the last unit.
 */
const physicalEnd = (extent: Iso9660Extent): number => {
  if (extent.fileUnitSize === 0 || extent.dataLength === 0)
    return extent.dataOffset + extent.dataLength;
  const unitBytes = extent.fileUnitSize * ISO9660_SECTOR_BYTES;
  const gaps = Math.ceil(extent.dataLength / unitBytes) - 1;
  return (
    extent.dataOffset +
    extent.dataLength +
    gaps * extent.interleaveGapSize * ISO9660_SECTOR_BYTES
  );
};

/** Check the physical image and declared volume boundaries. */
export const admitIso9660Extent = (
  extent: Iso9660Extent,
  fileSize: number,
  volumeBytes: number,
): Result<void, ParseFailureError> =>
  captureParseFailure(() => {
    // An empty extent with no extended attribute record stores no bytes, so
    // its location names no data; writers such as libarchive record the
    // unallocated sentinel 0xfffffff0 there.
    if (extent.dataLength === 0 && extent.extendedAttributeLength === 0) return;
    if (extent.dataOffset > volumeBytes)
      throw iso9660Malformed(
        `extent at block ${String(extent.location)} starts past the end of the declared volume`,
        extent.recordOffset + 2,
        "extent_location",
      );
    const end = physicalEnd(extent);
    if (end > volumeBytes)
      throw iso9660Malformed(
        `extent at block ${String(extent.location)} ends past the end of the declared volume`,
        extent.recordOffset + 10,
        "data_length",
      );
    if (extent.dataOffset > fileSize)
      throw truncatedInput(
        ISO9660_FORMAT,
        `ISO 9660 image is truncated before the extent at block ${String(extent.location)}`,
        { offset: extent.recordOffset + 2, field: "extent_location" },
      );
    if (end > fileSize)
      throw truncatedInput(
        ISO9660_FORMAT,
        `ISO 9660 image is truncated: the extent at block ${String(extent.location)} ends past the end of the image`,
        { offset: extent.recordOffset + 10, field: "data_length" },
      );
  });

/** Whether an interleaved directory record can be walked as one extent. */
export const iso9660DirectoryIsInterleaved = (
  record: Pick<Iso9660DirectoryRecord, "fileUnitSize" | "interleaveGapSize">,
): boolean => record.fileUnitSize !== 0 || record.interleaveGapSize !== 0;
