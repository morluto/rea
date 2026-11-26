import { createRequire } from "node:module";
import { crc32 } from "node:zlib";

import {
  AnalysisCancelledError,
  cancelledBy,
  isAborted,
} from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";
import { errorMessage } from "../kernel/errorMessage.js";
import { isAbortOf } from "../process/SignalAbort.js";

const OPERATION = "inspect_deb_package";
const XZ_MAGIC = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
const XZ_HEADER_SIZE = 12;
const XZ_FOOTER_SIZE = 12;
const XZ_MIN_BLOCK_SIZE = 8;
const XZ_FILTER_LZMA2 = 0x21;
const XZ_STREAM_INPUT_CHUNK_BYTES = 64 * 1024;

/**
 * Fixed XZ LZMA2 dictionary allowance: 128 MiB, matching the Zstandard window
 * ceiling. Covers standard `xz -0`..`xz -9` presets (up to 64 MiB) while
 * refusing pathological 256 MiB–4 GiB dictionary declarations before the
 * native decoder allocates working memory.
 */
export const XZ_DICTIONARY_MAX_BYTES = 128 * 1024 * 1024;

type XzApi = {
  readonly decompressStream: (
    input: ReadableStream<Uint8Array>,
  ) => ReadableStream<Buffer>;
  readonly compressSync: (input: string | Uint8Array) => Buffer;
};

export type XzBinding =
  | { readonly status: "ready"; readonly api: XzApi }
  | { readonly status: "unavailable"; readonly cause: unknown };

export type XzDecodeFailure =
  | { readonly kind: "unavailable" }
  | { readonly kind: "truncated" }
  | { readonly kind: "malformed"; readonly cause?: unknown }
  | { readonly kind: "too_large" }
  | {
      readonly kind: "dictionary_too_large";
      readonly dictionaryBytes: number;
      readonly maximum: number;
    };

let loaded: XzBinding | undefined;
let override: XzBinding | undefined;

const loadNativeXz = (): XzBinding => {
  try {
    const require = createRequire(import.meta.url);
    const api = require("@napi-rs/lzma/xz") as XzApi;
    if (
      typeof api.decompressStream !== "function" ||
      typeof api.compressSync !== "function"
    )
      throw new Error(
        "@napi-rs/lzma/xz does not export streaming xz decompression and sync compression.",
      );
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

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (isAborted(signal)) throw cancelledBy(OPERATION, signal);
};

const hasMagicAt = (bytes: Uint8Array, offset: number): boolean => {
  if (offset < 0 || offset + XZ_MAGIC.length > bytes.length) return false;
  for (let i = 0; i < XZ_MAGIC.length; i++)
    if (bytes[offset + i] !== XZ_MAGIC[i]) return false;
  return true;
};

const readU32LE = (bytes: Uint8Array, offset: number): number =>
  (bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)) >>>
  0;

const readMbInt = (
  bytes: Uint8Array,
  offset: number,
  end: number = bytes.length,
): { readonly value: number; readonly next: number } | null => {
  let value = 0;
  for (let index = 0; index < 9; index++) {
    if (offset + index >= end) return null;
    const byte = bytes[offset + index]!;
    value += (byte & 0x7f) * 128 ** index;
    if (!Number.isSafeInteger(value)) return null;
    if ((byte & 0x80) === 0) return { value, next: offset + index + 1 };
  }
  return null;
};

/** Decode an LZMA2 filter properties byte into dictionary bytes (XZ spec §5.3.1). */
export const lzma2DictionaryBytes = (props: number): number | null => {
  if (!Number.isInteger(props) || props < 0 || props > 40) return null;
  if (props === 40) return 0xffffffff;
  return (2 | (props & 1)) * 2 ** (Math.floor(props / 2) + 11);
};

const checkSizeForFlags = (flagsByte1: number): number | null => {
  if ((flagsByte1 & 0xf0) !== 0) return null;
  switch (flagsByte1 & 0x0f) {
    case 0x00:
      return 0;
    case 0x01:
      return 4;
    case 0x04:
      return 8;
    case 0x0a:
      return 32;
    default:
      return null;
  }
};

/**
 * Walk LZMA2 chunk headers from `start` within `[start, end)` to establish the
 * exact Compressed Data byte length (including the `0x00` end-of-payload
 * marker) and chunk-declared uncompressed byte count without decompressing.
 */
const scanLzma2Block = (
  bytes: Uint8Array,
  start: number,
  end: number,
): {
  readonly compressedSize: number;
  readonly uncompressedSize: number;
} | null => {
  let cursor = start;
  let uncompressedSize = 0;
  while (cursor < end) {
    const control = bytes[cursor]!;
    if (control === 0x00)
      return {
        compressedSize: cursor + 1 - start,
        uncompressedSize,
      };
    if (control === 0x01 || control === 0x02) {
      if (cursor + 3 > end) return null;
      const chunkUncompressed =
        ((bytes[cursor + 1]! << 8) | bytes[cursor + 2]!) + 1;
      cursor += 3 + chunkUncompressed;
      if (cursor > end) return null;
      uncompressedSize += chunkUncompressed;
      if (!Number.isSafeInteger(uncompressedSize)) return null;
      continue;
    }
    if (control < 0x80) return null;
    const headerLength = control >= 0xc0 ? 6 : 5;
    if (cursor + headerLength > end) return null;
    const chunkUncompressed =
      (((control & 0x1f) << 16) |
        (bytes[cursor + 1]! << 8) |
        bytes[cursor + 2]!) +
      1;
    const chunkCompressed =
      ((bytes[cursor + 3]! << 8) | bytes[cursor + 4]!) + 1;
    cursor += headerLength + chunkCompressed;
    if (cursor > end) return null;
    uncompressedSize += chunkUncompressed;
    if (!Number.isSafeInteger(uncompressedSize)) return null;
  }
  return null;
};

/**
 * End of the stream before trailing Stream Padding. The xz format allows zero
 * padding in 4-byte groups after the footer; a ragged zero tail stays in place
 * so the footer check rejects it.
 */
const xzStreamEnd = (
  bytes: Uint8Array,
  from: number = bytes.length,
): number => {
  let end = from;
  while (
    end >= 4 &&
    bytes[end - 1] === 0 &&
    bytes[end - 2] === 0 &&
    bytes[end - 3] === 0 &&
    bytes[end - 4] === 0
  )
    end -= 4;
  return end;
};

const xzFooterPresent = (bytes: Uint8Array): boolean => {
  const end = xzStreamEnd(bytes);
  return (
    end >= XZ_HEADER_SIZE + XZ_FOOTER_SIZE &&
    hasMagicAt(bytes, 0) &&
    bytes[end - 2] === 0x59 &&
    bytes[end - 1] === 0x5a
  );
};

interface XzPreflight {
  readonly declaredUncompressed: number;
  readonly maxDictionaryBytes: number;
}

/**
 * Validate every stream header, footer, index, and block header in an `.xz`
 * byte buffer before any bytes reach the native decoder. Verifies CRCs,
 * declared uncompressed sizes, and every LZMA2 dictionary size property byte.
 */
const inspectXzStreams = (
  bytes: Uint8Array,
  maxUncompressed?: number,
): Result<XzPreflight, XzDecodeFailure> => {
  if (bytes.length < XZ_HEADER_SIZE + XZ_FOOTER_SIZE)
    return err({ kind: "truncated" });
  if (!hasMagicAt(bytes, 0)) return err({ kind: "malformed" });
  let streamEnd = xzStreamEnd(bytes);
  if (streamEnd < XZ_HEADER_SIZE + XZ_FOOTER_SIZE)
    return err({ kind: xzFooterPresent(bytes) ? "malformed" : "truncated" });

  let totalUncompressed = 0;
  let maxDictionaryBytes = 0;

  while (streamEnd > 0) {
    if (streamEnd < XZ_HEADER_SIZE + XZ_FOOTER_SIZE)
      return err({ kind: "malformed" });
    const footer = streamEnd - XZ_FOOTER_SIZE;
    if (bytes[footer + 10] !== 0x59 || bytes[footer + 11] !== 0x5a)
      return err({
        kind: streamEnd === xzStreamEnd(bytes) ? "truncated" : "malformed",
      });
    if (
      readU32LE(bytes, footer) !==
      crc32(bytes.subarray(footer + 4, footer + 10))
    )
      return err({ kind: "malformed" });
    const flags0 = bytes[footer + 8]!;
    const flags1 = bytes[footer + 9]!;
    const checkSize = checkSizeForFlags(flags1);
    if (flags0 !== 0x00 || checkSize === null)
      return err({ kind: "malformed" });

    const backwardSize = (readU32LE(bytes, footer + 4) + 1) * 4;
    const indexStart = footer - backwardSize;
    if (indexStart < XZ_HEADER_SIZE || backwardSize < 8)
      return err({ kind: "malformed" });

    const index = bytes.subarray(indexStart, footer);
    const indexBodyEnd = index.length - 4;
    if (index[0] !== 0x00) return err({ kind: "malformed" });
    if (
      readU32LE(index, indexBodyEnd) !== crc32(index.subarray(0, indexBodyEnd))
    )
      return err({ kind: "malformed" });

    const records = readMbInt(index, 1, indexBodyEnd);
    if (records === null) return err({ kind: "malformed" });

    // Reject impossible record counts upfront before scanning: each block
    // occupies at least XZ_MIN_BLOCK_SIZE bytes before the index and each
    // index record occupies at least 2 bytes.
    const availableBlockBytes = indexStart - XZ_HEADER_SIZE;
    const maxPossibleBlocks = Math.min(
      Math.floor(availableBlockBytes / XZ_MIN_BLOCK_SIZE),
      Math.floor((indexBodyEnd - records.next) / 2),
    );
    if (records.value > maxPossibleBlocks) return err({ kind: "malformed" });

    let cursor = records.next;
    let totalBlocksPadded = 0;

    for (let n = 0; n < records.value; n++) {
      const unpadded = readMbInt(index, cursor, indexBodyEnd);
      if (unpadded === null || unpadded.value < XZ_MIN_BLOCK_SIZE)
        return err({ kind: "malformed" });
      const size = readMbInt(index, unpadded.next, indexBodyEnd);
      if (size === null) return err({ kind: "malformed" });
      const padded = Math.ceil(unpadded.value / 4) * 4;
      totalBlocksPadded += padded;
      if (
        !Number.isSafeInteger(totalBlocksPadded) ||
        totalBlocksPadded > availableBlockBytes
      )
        return err({ kind: "malformed" });
      totalUncompressed += size.value;
      if (!Number.isSafeInteger(totalUncompressed))
        return err({ kind: "malformed" });
      if (maxUncompressed !== undefined && totalUncompressed > maxUncompressed)
        return err({ kind: "too_large" });
      cursor = size.next;
    }

    const indexPadLength = indexBodyEnd - cursor;
    if (indexPadLength < 0 || indexPadLength > 3)
      return err({ kind: "malformed" });
    for (let i = cursor; i < indexBodyEnd; i++)
      if (index[i] !== 0) return err({ kind: "malformed" });

    const streamHeaderStart = indexStart - totalBlocksPadded - XZ_HEADER_SIZE;
    if (streamHeaderStart < 0 || !hasMagicAt(bytes, streamHeaderStart))
      return err({ kind: "malformed" });
    if (
      bytes[streamHeaderStart + 6] !== flags0 ||
      bytes[streamHeaderStart + 7] !== flags1
    )
      return err({ kind: "malformed" });
    if (
      readU32LE(bytes, streamHeaderStart + 8) !==
      crc32(bytes.subarray(streamHeaderStart + 6, streamHeaderStart + 8))
    )
      return err({ kind: "malformed" });

    // Walk actual XZ blocks sequentially from the stream header by framing each
    // block's LZMA2 payload, verifying every block boundary against the index
    // so a forged index record cannot span two blocks and hide the second.
    let blockOffset = streamHeaderStart + XZ_HEADER_SIZE;
    let recordCursor = records.next;
    let scannedUncompressed = 0;
    for (let n = 0; n < records.value; n++) {
      const unpadded = readMbInt(index, recordCursor, indexBodyEnd);
      if (unpadded === null) return err({ kind: "malformed" });
      const size = readMbInt(index, unpadded.next, indexBodyEnd);
      if (size === null) return err({ kind: "malformed" });
      recordCursor = size.next;

      const encodedHeaderSize = bytes[blockOffset];
      if (encodedHeaderSize === undefined || encodedHeaderSize === 0)
        return err({ kind: "malformed" });
      const blockHeaderSize = (encodedHeaderSize + 1) * 4;
      if (blockOffset + blockHeaderSize + checkSize > indexStart)
        return err({ kind: "malformed" });
      const blockHeader = bytes.subarray(
        blockOffset,
        blockOffset + blockHeaderSize,
      );
      if (
        readU32LE(blockHeader, blockHeaderSize - 4) !==
        crc32(blockHeader.subarray(0, blockHeaderSize - 4))
      )
        return err({ kind: "malformed" });
      const blockFlags = blockHeader[1]!;
      if ((blockFlags & 0x3c) !== 0) return err({ kind: "malformed" });
      const numFilters = (blockFlags & 0x03) + 1;
      let headerCursor = 2;
      const headerBodyEnd = blockHeaderSize - 4;
      let headerCompressedSize: number | null = null;

      if ((blockFlags & 0x40) !== 0) {
        const compressedSize = readMbInt(
          blockHeader,
          headerCursor,
          headerBodyEnd,
        );
        if (compressedSize === null) return err({ kind: "malformed" });
        headerCompressedSize = compressedSize.value;
        headerCursor = compressedSize.next;
      }
      if ((blockFlags & 0x80) !== 0) {
        const uncompressedSize = readMbInt(
          blockHeader,
          headerCursor,
          headerBodyEnd,
        );
        if (uncompressedSize === null || uncompressedSize.value !== size.value)
          return err({ kind: "malformed" });
        headerCursor = uncompressedSize.next;
      }

      for (let f = 0; f < numFilters; f++) {
        const filterId = readMbInt(blockHeader, headerCursor, headerBodyEnd);
        if (filterId === null) return err({ kind: "malformed" });
        const propsSize = readMbInt(blockHeader, filterId.next, headerBodyEnd);
        if (propsSize === null) return err({ kind: "malformed" });
        headerCursor = propsSize.next;
        if (headerCursor + propsSize.value > headerBodyEnd)
          return err({ kind: "malformed" });
        const isLastFilter = f === numFilters - 1;
        if (filterId.value === XZ_FILTER_LZMA2) {
          if (!isLastFilter || propsSize.value !== 1)
            return err({ kind: "malformed" });
          const dictBytes = lzma2DictionaryBytes(blockHeader[headerCursor]!);
          if (dictBytes === null) return err({ kind: "malformed" });
          if (dictBytes > maxDictionaryBytes) maxDictionaryBytes = dictBytes;
          if (dictBytes > XZ_DICTIONARY_MAX_BYTES)
            return err({
              kind: "dictionary_too_large",
              dictionaryBytes: dictBytes,
              maximum: XZ_DICTIONARY_MAX_BYTES,
            });
        } else if (isLastFilter) {
          return err({ kind: "malformed" });
        }
        headerCursor += propsSize.value;
      }

      for (let i = headerCursor; i < headerBodyEnd; i++)
        if (blockHeader[i] !== 0) return err({ kind: "malformed" });

      const compressedStart = blockOffset + blockHeaderSize;
      const scanned = scanLzma2Block(
        bytes,
        compressedStart,
        indexStart - checkSize,
      );
      if (scanned === null) return err({ kind: "malformed" });
      if (
        headerCompressedSize !== null &&
        scanned.compressedSize !== headerCompressedSize
      )
        return err({ kind: "malformed" });

      const padStart = compressedStart + scanned.compressedSize;
      const padLength = (4 - (scanned.compressedSize % 4)) % 4;
      const blockEnd = padStart + padLength + checkSize;
      if (blockEnd > indexStart) return err({ kind: "malformed" });
      for (let i = 0; i < padLength; i++)
        if (bytes[padStart + i] !== 0) return err({ kind: "malformed" });

      const actualUnpadded =
        blockHeaderSize + scanned.compressedSize + checkSize;
      if (actualUnpadded !== unpadded.value) return err({ kind: "malformed" });

      scannedUncompressed += scanned.uncompressedSize;
      if (!Number.isSafeInteger(scannedUncompressed))
        return err({ kind: "malformed" });
      if (
        maxUncompressed !== undefined &&
        scannedUncompressed > maxUncompressed
      )
        return err({ kind: "too_large" });

      blockOffset = blockEnd;
    }

    if (blockOffset !== indexStart) return err({ kind: "malformed" });

    streamEnd = xzStreamEnd(bytes, streamHeaderStart);
  }

  return ok({
    declaredUncompressed: totalUncompressed,
    maxDictionaryBytes,
  });
};

/** Uncompressed size from a completed xz stream index, or null when absent/invalid. */
export const xzUncompressedSize = (bytes: Uint8Array): number | null => {
  const preflight = inspectXzStreams(bytes);
  return preflight.ok ? preflight.value.declaredUncompressed : null;
};

const isTruncatedXzError = (cause: unknown): boolean => {
  return /failed to fill whole buffer|unexpected eof/iu.test(
    errorMessage(cause),
  );
};

const chunkedReadableStream = (
  bytes: Uint8Array,
): ReadableStream<Uint8Array> => {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + XZ_STREAM_INPUT_CHUNK_BYTES, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
};

export const decodeXz = async (
  bytes: Uint8Array,
  limit: number,
  signal?: AbortSignal,
): Promise<Result<Uint8Array, XzDecodeFailure>> => {
  throwIfAborted(signal);
  const binding = loadXzBinding();
  if (binding.status === "unavailable") return err({ kind: "unavailable" });
  // Validate stream framing, CRCs, LZMA2 dictionary size, and index-declared
  // uncompressed size before any bytes reach the native decoder.
  const preflight = inspectXzStreams(bytes, limit);
  if (!preflight.ok) return preflight;

  // Stream-decode with a hard chunk-by-chunk output cap so a spoofed index
  // cannot cause unbounded output allocation.
  const reader = binding.api
    .decompressStream(chunkedReadableStream(bytes))
    .getReader();
  const onAbort = (): void => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      if (value.length === 0) continue;
      total += value.length;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return err({ kind: "too_large" });
      }
      chunks.push(value);
    }
    return ok(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, total));
  } catch (cause: unknown) {
    await reader.cancel().catch(() => {});
    if (cause instanceof AnalysisCancelledError) throw cause;
    if (isAbortOf(cause, signal)) throw cancelledBy(OPERATION, signal);
    if (!hasMagicAt(bytes, 0) || bytes.length < 32 || isTruncatedXzError(cause))
      return err({ kind: "truncated" });
    return err({ kind: "malformed", cause });
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
};

export const compressXz = (bytes: Uint8Array): Buffer => {
  const binding = loadXzBinding();
  if (binding.status !== "ready")
    throw new Error("xz compressor is unavailable on this platform.");
  return binding.api.compressSync(bytes);
};
