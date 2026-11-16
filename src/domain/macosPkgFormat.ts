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
/** Resource policy: gzip-cpio members from one Scripts or Payload archive. */
export const MACOS_PKG_MAX_CPIO_MEMBERS = 4096;
/** Resource policy: one cpio member name, including the trailing NUL. */
export const MACOS_PKG_MAX_CPIO_NAME_BYTES = 4096;
/** Resource policy: one gzip-decoded Scripts/Payload archive. */
export const MACOS_PKG_MAX_CPIO_ARCHIVE_BYTES = 64 * 1024 * 1024;
/** Resource policy: Distribution or PackageInfo bytes decoded for metadata. */
export const MACOS_PKG_MAX_METADATA_XML_BYTES = 1 * 1024 * 1024;
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
