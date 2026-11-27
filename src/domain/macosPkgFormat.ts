import { decodeLimit, type ParseFailureError } from "./parseFailure.js";

/** XAR magic `xar!` as a big-endian u32. */
export const XAR_MAGIC = 0x78_61_72_21;
export const XAR_MAGIC_TEXT = "xar!";
/** Shortest xar header that carries the TOC lengths and checksum algorithm. */
export const XAR_HEADER_MIN_BYTES = 28;
/** Apple xar writes a 28-byte header; larger values are reserved. */
export const XAR_HEADER_MAX_BYTES = 256;
export const XAR_VERSION = 1;

/** Resource policy: compressed TOC bytes admitted before inflate. */
export const MACOS_PKG_MAX_TOC_COMPRESSED_BYTES = 16 * 1024 * 1024;
/** Resource policy: uncompressed TOC XML admitted after inflate. */
export const MACOS_PKG_MAX_TOC_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
/** Resource policy: TOC `<file>` elements, including nested component paths. */
export const MACOS_PKG_MAX_TOC_FILES = 4096;
/** Resource policy: total UTF-8 bytes of expanded logical paths across TOC `<file>` records. */
export const MACOS_PKG_MAX_TOC_PATH_BYTES = 4 * 1024 * 1024;
/** Resource policy: TOC XML nodes counted before the DOM is built, 256 per admitted file. */
export const MACOS_PKG_MAX_TOC_XML_NODES = MACOS_PKG_MAX_TOC_FILES * 256;
/** Default resource policy: total expanded cpio members retained across all Scripts and Payload archives in a package when `artifact_limits.expanded_bytes` is omitted. */
export const MACOS_PKG_MAX_CPIO_MEMBERS = 4096;
/** Resource policy: one cpio member name, including the trailing NUL. */
export const MACOS_PKG_MAX_CPIO_NAME_BYTES = 4096;
/** Default resource policy: one decoded Scripts/Payload cpio archive when `artifact_limits.expanded_bytes` is omitted. */
export const MACOS_PKG_MAX_CPIO_ARCHIVE_BYTES = 64 * 1024 * 1024;
/** Scaling ratio tying cpio member allowance to an explicit `artifact_limits.expanded_bytes` budget (64 MiB / 4,096 members). */
export const MACOS_PKG_CPIO_BYTES_PER_MEMBER = 16 * 1024;
/** Scaling ratio tying expanded cpio logical path bytes to an explicit `artifact_limits.expanded_bytes` budget (64 MiB / 4 MiB). */
export const MACOS_PKG_CPIO_BYTES_PER_PATH_BYTE = 16;

export interface MacosPkgCpioBudget {
  readonly maxArchiveBytes: number;
  readonly maxMembers: number;
  readonly maxPathBytes: number;
  readonly callerControlled: boolean;
}

/**
 * Derive Scripts/Payload cpio archive byte, member-count, and expanded path
 * byte allowances from `artifact_limits.expanded_bytes`. Omission keeps the
 * 64 MiB / 4,096-member / 4 MiB-path defaults; an explicit
 * `artifact_limits.expanded_bytes` sets the per-archive byte allowance to that
 * budget and scales the package-wide member and path-byte allowances
 * proportionally.
 */
export const macosPkgCpioBudget = (
  expandedBytes: number | undefined,
): MacosPkgCpioBudget => {
  if (expandedBytes === undefined) {
    return {
      maxArchiveBytes: MACOS_PKG_MAX_CPIO_ARCHIVE_BYTES,
      maxMembers: MACOS_PKG_MAX_CPIO_MEMBERS,
      maxPathBytes: MACOS_PKG_MAX_TOC_PATH_BYTES,
      callerControlled: false,
    };
  }
  const maxArchiveBytes = Math.max(0, Math.floor(expandedBytes));
  const scaledMembers = Math.floor(
    maxArchiveBytes / MACOS_PKG_CPIO_BYTES_PER_MEMBER,
  );
  const scaledPathBytes = Math.floor(
    maxArchiveBytes / MACOS_PKG_CPIO_BYTES_PER_PATH_BYTE,
  );
  return {
    maxArchiveBytes,
    maxMembers: Math.max(MACOS_PKG_MAX_CPIO_MEMBERS, scaledMembers),
    maxPathBytes: Math.max(MACOS_PKG_MAX_TOC_PATH_BYTES, scaledPathBytes),
    callerControlled: true,
  };
};
/** Default resource policy: Distribution or PackageInfo bytes decoded per document when `artifact_limits.expanded_bytes` is omitted. */
export const MACOS_PKG_MAX_METADATA_XML_BYTES = 1 * 1024 * 1024;
/** Default resource policy: total Distribution and PackageInfo bytes decoded across one package when `artifact_limits.expanded_bytes` is omitted. */
export const MACOS_PKG_MAX_TOTAL_METADATA_XML_BYTES = 4 * 1024 * 1024;
/** Default resource policy: total installer metadata records retained across Distribution and PackageInfo documents when `artifact_limits.expanded_bytes` is omitted. */
export const MACOS_PKG_MAX_METADATA_RECORDS = 4096;
/** Scaling ratio tying installer metadata record allowance to an explicit `artifact_limits.expanded_bytes` budget (4 MiB / 4,096 records). */
export const MACOS_PKG_METADATA_BYTES_PER_RECORD = 1024;
/** XML nodes admitted per retained metadata record before DOM construction. */
export const MACOS_PKG_METADATA_XML_NODES_PER_RECORD = 16;
/** Default resource policy: installer metadata XML nodes counted before the DOM is built, per document. */
export const MACOS_PKG_MAX_METADATA_XML_NODES =
  MACOS_PKG_MAX_METADATA_RECORDS * MACOS_PKG_METADATA_XML_NODES_PER_RECORD;

export interface MacosPkgMetadataBudget {
  readonly totalBytes: number;
  readonly perDocumentBytes: number;
  readonly maxRecords: number;
  readonly maxXmlNodes: number;
  readonly callerControlled: boolean;
}

/**
 * Derive installer metadata byte, record, and XML-node allowances from
 * `artifact_limits.expanded_bytes`. Omission keeps the 4 MiB / 1 MiB /
 * 4,096-record / 65,536-node defaults so aliased-heap metadata bombs stay
 * bounded; an explicit `artifact_limits.expanded_bytes` raises the byte
 * allowances to that budget and scales the record and XML-node allowances
 * proportionally.
 */
export const macosPkgMetadataBudget = (
  expandedBytes: number | undefined,
): MacosPkgMetadataBudget => {
  if (expandedBytes === undefined) {
    return {
      totalBytes: MACOS_PKG_MAX_TOTAL_METADATA_XML_BYTES,
      perDocumentBytes: MACOS_PKG_MAX_METADATA_XML_BYTES,
      maxRecords: MACOS_PKG_MAX_METADATA_RECORDS,
      maxXmlNodes: MACOS_PKG_MAX_METADATA_XML_NODES,
      callerControlled: false,
    };
  }
  const totalBytes = Math.max(0, Math.floor(expandedBytes));
  const scaledRecords = Math.floor(
    totalBytes / MACOS_PKG_METADATA_BYTES_PER_RECORD,
  );
  const maxRecords = Math.max(MACOS_PKG_MAX_METADATA_RECORDS, scaledRecords);
  const maxXmlNodes = Math.min(
    Number.MAX_SAFE_INTEGER,
    maxRecords * MACOS_PKG_METADATA_XML_NODES_PER_RECORD,
  );
  return {
    totalBytes,
    perDocumentBytes: totalBytes,
    maxRecords,
    maxXmlNodes,
    callerControlled: true,
  };
};
export const MACOS_PKG_MAX_SYMLINK_TARGET_BYTES = 4096;
export const MACOS_PKG_FORMAT = "macos-pkg";

export const XAR_CHECKSUM_ALGORITHMS: Readonly<Record<number, string>> = {
  0: "none",
  1: "sha1",
  2: "md5",
  3: "sha256",
  4: "sha512",
};

export type MacosPkgParseError =
  | ParseFailureError<"malformed">
  | ParseFailureError<"truncated">
  | ParseFailureError<"unsupported">
  | ParseFailureError<"limit">;

export interface XarHeader {
  readonly magic: typeof XAR_MAGIC;
  readonly headerSize: number;
  readonly version: number;
  readonly tocCompressedLength: number;
  readonly tocUncompressedLength: number;
  readonly checksumAlgorithmId: number;
  readonly checksumAlgorithm: string;
  readonly heapOffset: number;
}

export const hasXarMagic = (prefix: Uint8Array): boolean =>
  prefix.length >= 4 &&
  prefix[0] === 0x78 &&
  prefix[1] === 0x61 &&
  prefix[2] === 0x72 &&
  prefix[3] === 0x21;

export const macosPkgLimitFailure = (
  message: string,
  limit: {
    readonly name: string;
    readonly maximum: number;
    readonly required?: number;
  },
  field?: string,
): MacosPkgParseError =>
  decodeLimit(
    MACOS_PKG_FORMAT,
    message,
    limit,
    field === undefined ? undefined : { field },
  );
