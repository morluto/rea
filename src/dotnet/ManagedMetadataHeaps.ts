import { createHash } from "node:crypto";

import type { ManagedMetadataLayout } from "./ManagedMetadataLayout.js";
import { managedFailure } from "./ManagedReaderFailure.js";

const requireRange = (
  bytes: Buffer,
  offset: number,
  length: number,
  scope: string,
): void => {
  if (offset < 0 || length < 0 || offset > bytes.length - length)
    throw managedFailure(
      "invalid-row",
      scope,
      `${scope} leaves the artifact byte range`,
      offset >= 0 ? offset : null,
    );
};

/** Cursor for checked fixed-width metadata row decoding. */
export class MetadataRowCursor {
  #offset: number;

  constructor(
    private readonly bytes: Buffer,
    readonly start: number,
    private readonly end: number,
    private readonly scope: string,
  ) {
    this.#offset = start;
  }

  get offset(): number {
    return this.#offset;
  }

  readUInt16(): number {
    this.require(2);
    const value = this.bytes.readUInt16LE(this.#offset);
    this.#offset += 2;
    return value;
  }

  readUInt32(): number {
    this.require(4);
    const value = this.bytes.readUInt32LE(this.#offset);
    this.#offset += 4;
    return value;
  }

  readIndex(size: 2 | 4): number {
    return size === 2 ? this.readUInt16() : this.readUInt32();
  }

  private require(length: number): void {
    if (this.#offset < this.start || this.#offset > this.end - length)
      throw managedFailure(
        "invalid-row",
        this.scope,
        `${this.scope} row ended before all declared columns`,
        this.#offset,
      );
  }
}

const compressedLength = (
  bytes: Buffer,
  offset: number,
  scope: string,
): { readonly length: number; readonly prefix: number } => {
  requireRange(bytes, offset, 1, scope);
  const first = bytes[offset] ?? 0;
  if ((first & 0x80) === 0) return { length: first, prefix: 1 };
  if ((first & 0xc0) === 0x80) {
    requireRange(bytes, offset, 2, scope);
    return {
      length: ((first & 0x3f) << 8) | (bytes[offset + 1] ?? 0),
      prefix: 2,
    };
  }
  if ((first & 0xe0) === 0xc0) {
    requireRange(bytes, offset, 4, scope);
    return {
      length:
        (first & 0x1f) * 0x01_00_00_00 +
        (bytes[offset + 1] ?? 0) * 0x01_00_00 +
        (bytes[offset + 2] ?? 0) * 0x0100 +
        (bytes[offset + 3] ?? 0),
      prefix: 4,
    };
  }
  throw managedFailure(
    "invalid-blob",
    scope,
    "Metadata blob uses a reserved compressed-length prefix",
    offset,
  );
};

/** Read one bounded UTF-8 value from #Strings. */
export const readMetadataString = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  index: number,
  maxBytes: number,
): string => {
  if (index === 0) return "";
  if (index < 0 || index >= layout.strings.size)
    throw managedFailure(
      "invalid-heap-index",
      "metadata.#Strings",
      "String heap index is outside #Strings",
      layout.strings.offset + Math.max(index, 0),
    );
  const start = layout.strings.offset + index;
  const maximum = Math.min(
    layout.strings.offset + layout.strings.size,
    start + maxBytes + 1,
  );
  let end = start;
  while (end < maximum && bytes[end] !== 0) end += 1;
  if (end === maximum)
    throw managedFailure(
      "limit-exceeded",
      "metadata.#Strings",
      `String heap item exceeds max_heap_item_bytes ${String(maxBytes)}`,
      start,
    );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(start, end),
    );
  } catch {
    throw managedFailure(
      "invalid-string",
      "metadata.#Strings",
      "String heap item is not valid UTF-8",
      start,
    );
  }
};

/** Read one bounded item from #Blob without interpreting its contents. */
export const readMetadataBlob = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  index: number,
  maxBytes: number,
): Buffer => {
  if (index === 0) return Buffer.alloc(0);
  if (index < 0 || index >= layout.blob.size)
    throw managedFailure(
      "invalid-heap-index",
      "metadata.#Blob",
      "Blob heap index is outside #Blob",
      layout.blob.offset + Math.max(index, 0),
    );
  const start = layout.blob.offset + index;
  const decoded = compressedLength(bytes, start, "metadata.#Blob");
  if (decoded.length > maxBytes)
    throw managedFailure(
      "limit-exceeded",
      "metadata.#Blob",
      `Blob heap item exceeds max_heap_item_bytes ${String(maxBytes)}`,
      start,
    );
  const content = start + decoded.prefix;
  if (content > layout.blob.offset + layout.blob.size - decoded.length)
    throw managedFailure(
      "invalid-blob",
      "metadata.#Blob",
      "Blob heap item leaves #Blob",
      start,
    );
  return bytes.subarray(content, content + decoded.length);
};

/** Read one conventional GUID value from the one-based #GUID heap. */
export const readMetadataGuid = (
  bytes: Buffer,
  layout: ManagedMetadataLayout,
  index: number,
): string | null => {
  if (index === 0) return null;
  const relative = (index - 1) * 16;
  if (relative < 0 || relative > layout.guid.size - 16)
    throw managedFailure(
      "invalid-guid",
      "metadata.#GUID",
      "GUID heap index is outside #GUID",
      layout.guid.offset + Math.max(relative, 0),
    );
  const offset = layout.guid.offset + relative;
  const part1 = bytes.readUInt32LE(offset).toString(16).padStart(8, "0");
  const part2 = bytes
    .readUInt16LE(offset + 4)
    .toString(16)
    .padStart(4, "0");
  const part3 = bytes
    .readUInt16LE(offset + 6)
    .toString(16)
    .padStart(4, "0");
  const part4 = bytes.subarray(offset + 8, offset + 10).toString("hex");
  const part5 = bytes.subarray(offset + 10, offset + 16).toString("hex");
  return `${part1}-${part2}-${part3}-${part4}-${part5}`;
};

/** Format one metadata table/row pair as an exact build-local token. */
export const metadataToken = (table: number, row: number): string =>
  `0x${(table * 0x01_00_00_00 + row).toString(16).padStart(8, "0")}`;

/** Hash bytes without exposing their contents. */
export const sha256Bytes = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Derive the conventional strong-name token from a full public key. */
export const strongNameToken = (publicKey: Buffer): string =>
  Buffer.from(createHash("sha1").update(publicKey).digest().subarray(-8))
    .reverse()
    .toString("hex");
