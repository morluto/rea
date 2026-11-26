import { constants as zlibConstants, gunzipSync } from "node:zlib";

import { isStrictUtf8 } from "./strictUtf8.js";

/**
 * POSIX tar headers (POSIX.1-2001 `pax` and `ustar`, IEEE Std 1003.1-2017
 * "pax" Extended Description) and the GNU tar extensions documented in the
 * GNU tar manual, "Basic Tar Format". Every header is one 512-byte block;
 * member data follows in whole blocks. Only headers are interpreted here.
 */
export const TAR_BLOCK_BYTES = 512;

/** The ustar `magic` field at offset 257: POSIX `ustar\0` or GNU `ustar ` + ` \0`. */
const TAR_MAGIC_OFFSET = 257;
const TAR_CHECKSUM_OFFSET = 148;
const TAR_CHECKSUM_BYTES = 8;

/** RFC 1952 member header: ID1, ID2 and CM 8 (deflate). */
export const hasGzipMagic = (prefix: Uint8Array): boolean =>
  prefix.length >= 3 &&
  prefix[0] === 0x1f &&
  prefix[1] === 0x8b &&
  prefix[2] === 0x08;

/** Header dialect, from the `magic` and `version` fields. */
export type TarHeaderDialect = "ustar" | "gnu";

const headerDialect = (block: Uint8Array): TarHeaderDialect | undefined => {
  const magic = Buffer.from(
    block.buffer,
    block.byteOffset + TAR_MAGIC_OFFSET,
    8,
  ).toString("latin1");
  if (magic === "ustar\u000000") return "ustar";
  // Some ustar writers leave the version field as spaces or NULs.
  if (magic.startsWith("ustar\u0000")) return "ustar";
  if (magic === "ustar  \u0000") return "gnu";
  return undefined;
};

/** Whether every byte is zero, as in the end-of-archive blocks. */
export const isZeroBlock = (block: Uint8Array): boolean =>
  block.every((byte) => byte === 0);

/**
 * Whether the header checksum agrees: the sum of all header bytes with the
 * checksum field read as spaces. Historic writers summed signed bytes, which
 * POSIX readers also accept.
 */
const checksumMatches = (block: Uint8Array): boolean => {
  const declared = parseTarNumber(
    block.subarray(
      TAR_CHECKSUM_OFFSET,
      TAR_CHECKSUM_OFFSET + TAR_CHECKSUM_BYTES,
    ),
  );
  if (declared === undefined) return false;
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < TAR_BLOCK_BYTES; index++) {
    const byte =
      index >= TAR_CHECKSUM_OFFSET &&
      index < TAR_CHECKSUM_OFFSET + TAR_CHECKSUM_BYTES
        ? 0x20
        : block[index]!;
    unsigned += byte;
    signed += byte >= 0x80 ? byte - 0x100 : byte;
  }
  return declared === BigInt(unsigned) || declared === BigInt(signed);
};

/**
 * A numeric header field: octal digits with optional leading spaces and a
 * NUL or space terminator, or the GNU base-256 form flagged by the high bit
 * of the first byte. `undefined` when the field is neither.
 */
export const parseTarNumber = (field: Uint8Array): bigint | undefined => {
  if (field.length === 0) return undefined;
  if ((field[0]! & 0x80) !== 0) {
    // GNU base-256: the remaining bits are a big-endian two's complement
    // number, so 0xff bytes encode a negative value such as a pre-1970 time.
    let value = BigInt(field[0]! & 0x7f);
    for (let index = 1; index < field.length; index++)
      value = (value << 8n) | BigInt(field[index]!);
    const bits = BigInt(field.length * 8 - 1);
    return (field[0]! & 0x40) === 0 ? value : value - (1n << bits);
  }
  let index = 0;
  while (index < field.length && field[index] === 0x20) index++;
  let value = 0n;
  let digits = 0;
  for (; index < field.length; index++) {
    const byte = field[index]!;
    if (byte >= 0x30 && byte <= 0x37) {
      value = value * 8n + BigInt(byte - 0x30);
      digits++;
      continue;
    }
    if (byte === 0 || byte === 0x20) break;
    return undefined;
  }
  for (; index < field.length; index++)
    if (field[index] !== 0 && field[index] !== 0x20) return undefined;
  return digits === 0 ? 0n : value;
};

/** Bytes of a NUL-terminated header string field. */
const fieldBytes = (block: Uint8Array, offset: number, length: number) => {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end);
};

/** One decoded tar header block, before pax or GNU long-name records apply. */
export interface TarHeaderBlock {
  readonly dialect: TarHeaderDialect;
  readonly name: Uint8Array;
  readonly mode: number;
  readonly uid: bigint;
  readonly gid: bigint;
  readonly size: bigint;
  readonly mtime: bigint;
  /** The raw `typeflag` byte; NUL is the historic regular-file flag. */
  readonly typeflag: number;
  readonly linkname: Uint8Array;
  readonly uname: Uint8Array;
  readonly gname: Uint8Array;
}

export type TarHeaderParse =
  | { readonly state: "header"; readonly header: TarHeaderBlock }
  | { readonly state: "zero" }
  | { readonly state: "invalid"; readonly reason: string };

/** Decode one 512-byte header block. */
export const parseTarHeaderBlock = (block: Uint8Array): TarHeaderParse => {
  if (block.length !== TAR_BLOCK_BYTES)
    return { state: "invalid", reason: "header block is incomplete" };
  if (isZeroBlock(block)) return { state: "zero" };
  const dialect = headerDialect(block);
  if (dialect === undefined)
    return {
      state: "invalid",
      reason:
        "header has no ustar magic (pre-POSIX v7 headers are unsupported)",
    };
  if (!checksumMatches(block))
    return { state: "invalid", reason: "header checksum does not match" };
  const number = (offset: number, length: number) =>
    parseTarNumber(block.subarray(offset, offset + length));
  const mode = number(100, 8);
  const uid = number(108, 8);
  const gid = number(116, 8);
  const size = number(124, 12);
  const mtime = number(136, 12);
  // Only a modification time may be negative.
  if (
    mode === undefined ||
    uid === undefined ||
    gid === undefined ||
    size === undefined ||
    mtime === undefined ||
    mode < 0n ||
    uid < 0n ||
    gid < 0n ||
    size < 0n
  )
    return { state: "invalid", reason: "header has a malformed numeric field" };
  const name = fieldBytes(block, 0, 100);
  // The ustar prefix field joins the name with a slash. GNU headers reuse
  // those bytes for access and change times, so they never carry a prefix.
  const prefix = dialect === "ustar" ? fieldBytes(block, 345, 155) : undefined;
  return {
    state: "header",
    header: {
      dialect,
      name:
        prefix === undefined || prefix.length === 0
          ? name
          : Buffer.concat([prefix, Buffer.from("/"), name]),
      mode: Number(mode & 0o7777n),
      uid,
      gid,
      size,
      mtime,
      typeflag: block[156]!,
      linkname: fieldBytes(block, 157, 100),
      uname: fieldBytes(block, 265, 32),
      gname: fieldBytes(block, 297, 32),
    },
  };
};

/** Whether a block is a checksum-valid ustar or GNU header. */
export const hasTarHeader = (prefix: Uint8Array): boolean =>
  prefix.length >= TAR_BLOCK_BYTES &&
  parseTarHeaderBlock(prefix.subarray(0, TAR_BLOCK_BYTES)).state === "header";

/**
 * Compressed bytes the gzip-wrapped tar probe inflates. Deflate expands at
 * most about 1032:1, so the probe output stays under the cap below.
 */
const GZIP_TAR_PROBE_INPUT_BYTES = 2048;
const GZIP_TAR_PROBE_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * Bytes of an RFC 1952 member header, including FEXTRA, FNAME, FCOMMENT and
 * FHCRC, or `undefined` when the prefix ends inside it.
 */
const gzipHeaderBytes = (prefix: Uint8Array): number | undefined => {
  if (prefix.length < 10) return undefined;
  const flags = prefix[3]!;
  let at = 10;
  if ((flags & 0x4) !== 0) {
    if (prefix.length < at + 2) return undefined;
    at += 2 + (prefix[at]! | (prefix[at + 1]! << 8));
  }
  for (const flag of [0x8, 0x10]) {
    if ((flags & flag) === 0) continue;
    const end = prefix.indexOf(0, at);
    if (end === -1) return undefined;
    at = end + 1;
  }
  if ((flags & 0x2) !== 0) at += 2;
  return at <= prefix.length ? at : undefined;
};

/**
 * Whether the leading bytes are a gzip member whose first decompressed block
 * is a tar header. Only a bounded prefix is inflated; a gzip stream that is
 * not tar is not claimed.
 */
export const hasGzipTarPrefix = (prefix: Uint8Array): boolean => {
  if (!hasGzipMagic(prefix)) return false;
  try {
    // Leave out the last 8 bytes: when the prefix is the whole file they are
    // the CRC32 and ISIZE trailer, which a probe must not verify. A damaged
    // trailer is the reader's fact to report, not a reason to forget the tar.
    // The bound applies to compressed data after the header's optional
    // fields, so a long name or comment does not hide the first block.
    const header = gzipHeaderBytes(prefix);
    if (header === undefined) return false;
    const input = prefix.subarray(
      0,
      Math.min(header + GZIP_TAR_PROBE_INPUT_BYTES, prefix.length - 8),
    );
    const inflated = gunzipSync(input, {
      finishFlush: zlibConstants.Z_SYNC_FLUSH,
      maxOutputLength: GZIP_TAR_PROBE_OUTPUT_BYTES,
    });
    return hasTarHeader(inflated);
  } catch {
    // A corrupt or oversized prefix is not a claim; the bytes stay unrecognized.
    return false;
  }
};

/** Plain or gzip-wrapped tar, from a file's leading bytes. */
export const recognizeTarPrefix = (
  prefix: Uint8Array,
): "none" | "gzip" | undefined =>
  hasTarHeader(prefix) ? "none" : hasGzipTarPrefix(prefix) ? "gzip" : undefined;

/**
 * Why a first block that carries the ustar or GNU magic is not a header REA
 * reads, or `undefined` when it has no such magic or is a valid header.
 */
export const tarHeaderRefusal = (prefix: Uint8Array): string | undefined => {
  if (prefix.length < TAR_BLOCK_BYTES) return undefined;
  const block = prefix.subarray(0, TAR_BLOCK_BYTES);
  if (headerDialect(block) === undefined) return undefined;
  const parsed = parseTarHeaderBlock(block);
  return parsed.state === "invalid" ? `tar first ${parsed.reason}` : undefined;
};

/** Typeflags POSIX and GNU tar define (GNU tar manual, "Basic Tar Format"). */
export const TAR_TYPEFLAGS = {
  regular: [0x30, 0x00, 0x37],
  hardLink: 0x31,
  symlink: 0x32,
  characterDevice: 0x33,
  blockDevice: 0x34,
  directory: 0x35,
  fifo: 0x36,
  paxLocal: 0x78,
  paxGlobal: 0x67,
  gnuLongName: 0x4c,
  gnuLongLink: 0x4b,
  gnuVolumeLabel: 0x56,
  gnuSparse: 0x53,
} as const;

export type TarPaxRecords = ReadonlyMap<string, string>;

/** Keywords whose values `hdrcharset=BINARY` leaves as raw bytes (POSIX pax "hdrcharset"). */
const PAX_BINARY_KEYWORDS = new Set(["path", "linkpath", "uname", "gname"]);

/**
 * Parse pax extended-header records: `"<length> <key>=<value>\n"`, where
 * `length` counts the whole record in bytes. Values are UTF-8, except that a
 * `hdrcharset=BINARY` record in the same header leaves path, linkpath, uname
 * and gname as raw bytes; those that are not UTF-8 are decoded as Latin-1 and
 * named in `latin1`.
 */
export const parsePaxRecords = (
  bytes: Uint8Array,
):
  | { readonly records: TarPaxRecords; readonly latin1: readonly string[] }
  | { readonly reason: string } => {
  const values: [string, Uint8Array][] = [];
  let offset = 0;
  while (offset < bytes.length) {
    // Trailing NUL padding ends the records.
    if (bytes[offset] === 0 && bytes.subarray(offset).every((b) => b === 0))
      break;
    const space = bytes.indexOf(0x20, offset);
    if (space === -1 || space - offset > 20)
      return { reason: "pax record has no length field" };
    const lengthText = Buffer.from(bytes.subarray(offset, space)).toString(
      "latin1",
    );
    if (!/^[1-9][0-9]*$/u.test(lengthText))
      return { reason: "pax record length is not a decimal number" };
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(end) || end > bytes.length || end <= space + 1)
      return { reason: "pax record length exceeds its extended header" };
    if (bytes[end - 1] !== 0x0a)
      return { reason: "pax record does not end with a newline" };
    const body = bytes.subarray(space + 1, end - 1);
    const equals = body.indexOf(0x3d);
    if (equals <= 0) return { reason: "pax record has no keyword" };
    values.push([
      Buffer.from(body.subarray(0, equals)).toString("utf8"),
      body.subarray(equals + 1),
    ]);
    offset = end;
  }
  const binary = values.some(
    ([key, value]) =>
      key === "hdrcharset" &&
      Buffer.from(value).toString("latin1") === "BINARY",
  );
  const records = new Map<string, string>();
  const latin1 = new Set<string>();
  for (const [key, value] of values) {
    if (isStrictUtf8(value)) {
      records.set(key, Buffer.from(value).toString("utf8"));
      latin1.delete(key);
      continue;
    }
    if (!binary || !PAX_BINARY_KEYWORDS.has(key))
      return { reason: "pax record value is not UTF-8" };
    records.set(key, Buffer.from(value).toString("latin1"));
    latin1.add(key);
  }
  return { records, latin1: [...latin1] };
};

/** Number of whole blocks that hold `size` data bytes. */
export const tarPaddedSize = (size: number): number =>
  Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
