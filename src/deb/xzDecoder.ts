import { createRequire } from "node:module";

import { err, ok, type Result } from "../domain/result.js";
import { errorMessage } from "../kernel/errorMessage.js";

const XZ_MAGIC = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
const XZ_HEADER_SIZE = 12;
const XZ_FOOTER_SIZE = 12;

type XzApi = {
  readonly decompressSync: (input: Uint8Array) => Buffer;
  readonly compressSync: (input: string | Uint8Array) => Buffer;
};

export type XzBinding =
  | { readonly status: "ready"; readonly api: XzApi }
  | { readonly status: "unavailable"; readonly cause: unknown };

export type XzDecodeFailure =
  | { readonly kind: "unavailable" }
  | { readonly kind: "truncated" }
  | { readonly kind: "malformed"; readonly cause?: unknown }
  | { readonly kind: "too_large" };

let loaded: XzBinding | undefined;
let override: XzBinding | undefined;

const loadNativeXz = (): XzBinding => {
  try {
    const require = createRequire(import.meta.url);
    const api = require("@napi-rs/lzma/xz") as XzApi;
    if (
      typeof api.decompressSync !== "function" ||
      typeof api.compressSync !== "function"
    )
      throw new Error("@napi-rs/lzma/xz does not export sync xz codecs.");
    return { status: "ready", api };
  } catch (cause: unknown) {
    return { status: "unavailable", cause };
  }
};

export const loadXzBinding = (): XzBinding => {
  if (override !== undefined) return override;
  loaded ??= loadNativeXz();
  return loaded;
};

/** Substitute the native binding in tests; pass undefined to restore. */
export const replaceXzBindingForTests = (
  binding: XzBinding | undefined,
): void => {
  override = binding;
};

const looksLikeXz = (bytes: Uint8Array): boolean => {
  if (bytes.length < XZ_MAGIC.length) return false;
  for (let i = 0; i < XZ_MAGIC.length; i++)
    if (bytes[i] !== XZ_MAGIC[i]) return false;
  return true;
};

const readMbInt = (
  bytes: Uint8Array,
  offset: number,
): { readonly value: number; readonly next: number } | null => {
  let value = 0;
  for (let index = 0; index < 9; index++) {
    const byte = bytes[offset + index];
    if (byte === undefined) return null;
    value += (byte & 0x7f) * 128 ** index;
    if (!Number.isSafeInteger(value)) return null;
    if ((byte & 0x80) === 0) return { value, next: offset + index + 1 };
  }
  return null;
};

/**
 * End of the stream before trailing Stream Padding. The xz format allows zero
 * padding in 4-byte groups after the footer; a ragged zero tail stays in place
 * so the footer check rejects it.
 */
const xzStreamEnd = (bytes: Uint8Array): number => {
  let end = bytes.length;
  while (
    end >= XZ_HEADER_SIZE + XZ_FOOTER_SIZE + 4 &&
    bytes[end - 1] === 0 &&
    bytes[end - 2] === 0 &&
    bytes[end - 3] === 0 &&
    bytes[end - 4] === 0
  )
    end -= 4;
  return end;
};

/** Uncompressed size from a completed single xz stream index, or null when absent. */
export const xzUncompressedSize = (bytes: Uint8Array): number | null => {
  if (bytes.length < XZ_HEADER_SIZE + XZ_FOOTER_SIZE) return null;
  if (!looksLikeXz(bytes)) return null;
  const footer = xzStreamEnd(bytes) - XZ_FOOTER_SIZE;
  if (bytes[footer + 10] !== 0x59 || bytes[footer + 11] !== 0x5a) return null;
  const backwardSize =
    (bytes[footer + 4] ?? 0) |
    ((bytes[footer + 5] ?? 0) << 8) |
    ((bytes[footer + 6] ?? 0) << 16) |
    ((bytes[footer + 7] ?? 0) << 24);
  const indexSize = (backwardSize + 1) * 4;
  const indexStart = footer - indexSize;
  if (indexStart < XZ_HEADER_SIZE) return null;
  const index = bytes.subarray(indexStart, footer);
  if (index[0] !== 0) return null;
  const records = readMbInt(index, 1);
  if (records === null) return null;
  let cursor = records.next;
  let uncompressed = 0;
  for (let n = 0; n < records.value; n++) {
    const unpadded = readMbInt(index, cursor);
    if (unpadded === null) return null;
    const size = readMbInt(index, unpadded.next);
    if (size === null) return null;
    uncompressed += size.value;
    if (!Number.isSafeInteger(uncompressed)) return null;
    cursor = size.next;
  }
  return uncompressed;
};

const xzFooterPresent = (bytes: Uint8Array): boolean => {
  const end = xzStreamEnd(bytes);
  return (
    end >= XZ_HEADER_SIZE + XZ_FOOTER_SIZE &&
    looksLikeXz(bytes) &&
    bytes[end - 2] === 0x59 &&
    bytes[end - 1] === 0x5a
  );
};

const isTruncatedXzError = (cause: unknown): boolean => {
  return /failed to fill whole buffer/iu.test(errorMessage(cause));
};

export const decodeXz = (
  bytes: Uint8Array,
  limit: number,
): Result<Uint8Array, XzDecodeFailure> => {
  const binding = loadXzBinding();
  if (binding.status === "unavailable") return err({ kind: "unavailable" });
  // The sync binding takes no output bound, so only a stream whose index
  // declares its size within the limit reaches the decoder.
  const declared = xzUncompressedSize(bytes);
  if (declared === null)
    return err({ kind: xzFooterPresent(bytes) ? "malformed" : "truncated" });
  if (declared > limit) return err({ kind: "too_large" });
  try {
    const expanded = binding.api.decompressSync(bytes);
    if (expanded.length > limit) return err({ kind: "too_large" });
    return ok(expanded);
  } catch (cause: unknown) {
    if (!looksLikeXz(bytes) || bytes.length < 32 || isTruncatedXzError(cause))
      return err({ kind: "truncated" });
    return err({ kind: "malformed", cause });
  }
};

export const compressXz = (bytes: Uint8Array): Buffer => {
  const binding = loadXzBinding();
  if (binding.status !== "ready")
    throw new Error("xz compressor is unavailable on this platform.");
  return binding.api.compressSync(bytes);
};
