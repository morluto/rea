import { Bytes, limit, malformed } from "./AxmlBytes.js";

/** A string pool declaring more strings than this is refused. */
export const MAX_STRING_POOL_STRINGS = 100_000;
/** One decoded string may not exceed this many bytes. */
const MAX_STRING_BYTES = 128 * 1024;
/** Decoded bytes over all distinct strings the reader consults. */
const MAX_DECODED_BYTES = 4 * 1024 * 1024;
const UTF8_FLAG = 0x100;

const lengthPrefix = (
  doc: Bytes,
  offset: number,
  unit: 8 | 16,
): { length: number; next: number } => {
  if (unit === 16) {
    const first = doc.u16(offset);
    if ((first & 0x8000) === 0) return { length: first, next: offset + 2 };
    return {
      length: ((first & 0x7fff) << 16) | doc.u16(offset + 2),
      next: offset + 4,
    };
  }
  const first = doc.u8(offset);
  if ((first & 0x80) === 0) return { length: first, next: offset + 1 };
  return {
    length: ((first & 0x7f) << 8) | doc.u8(offset + 1),
    next: offset + 2,
  };
};

/**
 * Lazily decoded string pool. The structure is validated up front; a string
 * is decoded only when consulted, once per distinct byte offset, and the work
 * is bounded per string and in total, so repeated offsets cannot multiply it.
 */
export class StringPool {
  readonly #cache = new Map<number, string>();
  #decodedBytes = 0;
  readonly doc: Bytes;
  readonly count: number;
  readonly utf8: boolean;
  readonly offsetsStart: number;
  readonly dataStart: number;
  readonly chunkEnd: number;

  private constructor(layout: {
    readonly doc: Bytes;
    readonly count: number;
    readonly utf8: boolean;
    readonly offsetsStart: number;
    readonly dataStart: number;
    readonly chunkEnd: number;
  }) {
    this.doc = layout.doc;
    this.count = layout.count;
    this.utf8 = layout.utf8;
    this.offsetsStart = layout.offsetsStart;
    this.dataStart = layout.dataStart;
    this.chunkEnd = layout.chunkEnd;
  }

  static read(doc: Bytes, chunkStart: number): StringPool {
    const headerSize = doc.u16(chunkStart + 2);
    const chunkSize = doc.u32(chunkStart + 4);
    const stringCount = doc.u32(chunkStart + 8);
    const styleCount = doc.u32(chunkStart + 12);
    const flags = doc.u32(chunkStart + 16);
    const stringsStart = doc.u32(chunkStart + 20);
    if (stringCount > MAX_STRING_POOL_STRINGS)
      throw limit(
        `string pool declares ${stringCount} strings, above ${MAX_STRING_POOL_STRINGS}`,
      );
    if (headerSize < 28 || headerSize > chunkSize)
      throw malformed(`string pool header size ${headerSize} is invalid`);
    const chunkEnd = chunkStart + chunkSize;
    const offsetsStart = chunkStart + headerSize;
    if (offsetsStart + (stringCount + styleCount) * 4 > chunkEnd)
      throw malformed("string pool offsets exceed their chunk");
    const dataStart = chunkStart + stringsStart;
    if (stringCount > 0 && dataStart > chunkEnd)
      throw malformed("string pool data starts beyond its chunk");
    if (
      stringCount > 0 &&
      stringsStart < headerSize + (stringCount + styleCount) * 4
    )
      throw malformed("string pool data overlaps its header or offset tables");
    return new StringPool({
      doc,
      count: stringCount,
      utf8: (flags & UTF8_FLAG) !== 0,
      offsetsStart,
      dataStart,
      chunkEnd,
    });
  }

  get(index: number): string {
    if (index >= this.count)
      throw malformed(`string index ${index} is outside the pool`);
    const at = this.dataStart + this.doc.u32(this.offsetsStart + index * 4);
    if (at >= this.chunkEnd)
      throw malformed(`string ${index} lies outside the pool`);
    const cached = this.#cache.get(at);
    if (cached !== undefined) return cached;
    const value = this.#decode(at, index);
    this.#cache.set(at, value);
    return value;
  }

  #decode(at: number, index: number): string {
    let start: number;
    let byteLength: number;
    if (this.utf8) {
      const chars = lengthPrefix(this.doc, at, 8);
      const bytes = lengthPrefix(this.doc, chars.next, 8);
      start = bytes.next;
      byteLength = bytes.length;
    } else {
      const chars = lengthPrefix(this.doc, at, 16);
      start = chars.next;
      byteLength = chars.length * 2;
    }
    if (byteLength > MAX_STRING_BYTES)
      throw limit(
        `string ${index} is ${byteLength} bytes, above ${MAX_STRING_BYTES}`,
      );
    if (start + byteLength > this.chunkEnd)
      throw malformed(`string ${index} overruns the pool`);
    this.#decodedBytes += byteLength;
    if (this.#decodedBytes > MAX_DECODED_BYTES)
      throw limit(`decoded strings exceed ${MAX_DECODED_BYTES} bytes`);
    const encoding = this.utf8 ? "utf-8" : "utf-16le";
    try {
      // Fatal decoding: invalid bytes are refused, not replaced by U+FFFD.
      return new TextDecoder(encoding, { fatal: true }).decode(
        this.doc.bytes.subarray(start, start + byteLength),
      );
    } catch {
      throw malformed(`string ${index} is not valid ${encoding} text`);
    }
  }
}
