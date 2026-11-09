import { gunzipSync, gzipSync, inflateRawSync, type Zlib } from "node:zlib";

import { err, ok, type Result } from "../result.js";
import { detectStateFormat, type DesktopStateFormat } from "./stateFormats.js";
import { MAX_ZIP_ENTRY_BYTES, MAX_ZIP_RATIO } from "./zipView.js";

const MIB = 1024 * 1024;
/** RFC 1952's operating system byte for an unknown one, so a recompressed file is the same whichever host made it. */
const UNKNOWN_OS = 0xff;
/** RFC 1952's header flags for a header CRC, an extra field, a file name and a comment. */
const FHCRC = 0x02;
const FEXTRA = 0x04;
const FNAME = 0x08;
const FCOMMENT = 0x10;
/** Formats inside a gzip file whose reader needs a tool or a worker. */
const NOT_READ_INSIDE: Partial<Record<DesktopStateFormat, string>> = {
  sqlite: "a SQLite database",
  dconf: "a dconf database",
};

/** What a file's record says was undone to read its document. */
export type StateCompression = "gzip";

/** Why a gzip file whose stream is damaged or cut short has no view; the exported reader words it the same. */
export const UNREADABLE_GZIP = "not a readable gzip stream";

/** Whether bytes begin a gzip member: its magic, then deflate, the one method gzip defines. */
export const isGzip = (bytes: Uint8Array): boolean =>
  bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08;

/**
 * A gzip stream's document, its members joined as zlib reads them: data after
 * a member that starts with a zero byte is padding and ends the stream.
 * Decompressing stops once the document passes `limit` bytes.
 */
export const gunzip = (
  bytes: Uint8Array,
  limit: number,
): Result<Buffer, "too_large" | "unreadable"> => {
  try {
    return ok(gunzipSync(bytes, { maxOutputLength: limit }));
  } catch (error: unknown) {
    return err(
      (error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE"
        ? "too_large"
        : "unreadable",
    );
  }
};

/** Where the header field starting at `start` ends, past its zero byte. */
const pastZero = (bytes: Uint8Array, start: number): number => {
  const zero = bytes.indexOf(0, start);
  return zero === -1 ? bytes.length : zero + 1;
};

/** Whether a member of a gzip stream that decompresses has an extra field, where BGZF and dictzip index their blocks; members before it are inflated to find where it starts. */
export const hasExtraField = (bytes: Uint8Array): boolean => {
  for (let start = 0; isGzip(bytes.subarray(start));) {
    const flags = bytes[start + 3] ?? 0;
    if ((flags & FEXTRA) !== 0) return true;
    let data = start + 10;
    if ((flags & FNAME) !== 0) data = pastZero(bytes, data);
    if ((flags & FCOMMENT) !== 0) data = pastZero(bytes, data);
    if ((flags & FHCRC) !== 0) data += 2;
    const { engine } = inflateRawSync(bytes.subarray(data), {
      info: true,
    }) as unknown as { readonly engine: Zlib };
    start = data + engine.bytesWritten + 8;
  }
  return false;
};

/** The most a gzip file of `size` bytes may expand to for its view to read it: an archive entry's size and ratio limits. */
const readLimit = (size: number): number =>
  Math.min(MAX_ZIP_ENTRY_BYTES, MAX_ZIP_RATIO * size);

/** Bytes gzip-compressed at `level` alike on every host: no file name, comment or extra field, modification time 0 and the operating system unknown. */
const gzipAt = (bytes: Uint8Array, level: number): Buffer => {
  const compressed = gzipSync(bytes, { level });
  compressed[9] = UNKNOWN_OS;
  return compressed;
};

/**
 * A document gzip-compressed alike on every host, at the fastest level, or
 * stored when deflating would make it expand past the ratio a view reads, so
 * a document within an entry's size still reads.
 */
export const gzipDeterministic = (document: Uint8Array): Buffer => {
  const deflated = gzipAt(document, 1);
  return document.length > readLimit(deflated.length) &&
    document.length <= MAX_ZIP_ENTRY_BYTES
    ? gzipAt(document, 0)
    : deflated;
};

/** A file's document, its format detected, and the compression undone to read it; or why a gzip file's is not read. */
export type StateDocument =
  | {
      readonly format: DesktopStateFormat;
      readonly bytes: Uint8Array;
      readonly compression?: StateCompression;
    }
  | {
      readonly format: DesktopStateFormat | null;
      readonly compression: StateCompression;
      readonly error: string;
    };

/** Why a gzip file whose document passes an archive entry's limits is not read. */
const tooLarge = (size: number): string =>
  MAX_ZIP_RATIO * size < MAX_ZIP_ENTRY_BYTES
    ? `expands more than ${String(MAX_ZIP_RATIO)} times, so it is not read`
    : `larger than the ${String(MAX_ZIP_ENTRY_BYTES / MIB)} MiB a compressed document's view reads`;

/**
 * The document a file's view reads: its own bytes, or a gzip file's
 * decompressed within an archive entry's size and ratio limits, its format
 * detected by the same rules under the file's own name.
 */
export const openStateDocument = (
  path: string,
  bytes: Uint8Array,
): StateDocument => {
  if (!isGzip(bytes)) return { format: detectStateFormat(path, bytes), bytes };
  const inner = gunzip(bytes, readLimit(bytes.length));
  if (!inner.ok)
    return {
      format: null,
      compression: "gzip",
      error:
        inner.error === "too_large" ? tooLarge(bytes.length) : UNREADABLE_GZIP,
    };
  const format = detectStateFormat(path, inner.value);
  const inside = NOT_READ_INSIDE[format];
  return inside === undefined
    ? { format, bytes: inner.value, compression: "gzip" }
    : {
        format,
        compression: "gzip",
        error: `${inside} inside a gzip file is not read`,
      };
};

/** A document's compression as a record's field, or none. */
export const compressionOf = (
  document: StateDocument,
): { readonly compression?: StateCompression } =>
  document.compression === undefined
    ? {}
    : { compression: document.compression };
