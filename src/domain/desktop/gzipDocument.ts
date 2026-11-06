import { gunzipSync, gzipSync } from "node:zlib";

import { err, ok, type Result } from "../result.js";
import { detectStateFormat, type DesktopStateFormat } from "./stateFormats.js";
import { MAX_ZIP_ENTRY_BYTES, MAX_ZIP_RATIO } from "./zipView.js";

const MIB = 1024 * 1024;
/** RFC 1952's operating system byte for an unknown one, so a recompressed file is the same whichever host made it. */
const UNKNOWN_OS = 0xff;
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

/** Bytes gzip-compressed alike on every host: no file name, modification time 0 and the operating system unknown. */
export const gzipDeterministic = (bytes: Uint8Array): Buffer => {
  const compressed = gzipSync(bytes);
  compressed[9] = UNKNOWN_OS;
  return compressed;
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
  const inner = gunzip(
    bytes,
    Math.min(MAX_ZIP_ENTRY_BYTES, MAX_ZIP_RATIO * bytes.length),
  );
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
