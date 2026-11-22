import {
  readUint16At,
  readUint32At,
  readUint64At,
} from "../../domain/binaryContainer.js";
import { MAX_DWARF_ULEB_BYTES } from "../../domain/native/dwarfUnits.js";

const SHIFT_28 = 268_435_456;
const SHIFT_35 = 34_359_738_368;
const SHIFT_42 = 4_398_046_511_104;
const SHIFT_49 = 562_949_953_421_312;

export type LebRead =
  | { readonly ok: true; readonly value: bigint }
  | { readonly ok: false; readonly reason: "truncated" | "overlong" };

export type InitialLength =
  | {
      readonly ok: true;
      readonly offsetSize: 4 | 8;
      readonly payloadLength: number;
      readonly totalLength: number;
    }
  | {
      readonly ok: false;
      readonly reason: "truncated" | "reserved" | "overflow";
    };

/** Bounded cursor over one DWARF section or unit payload. */
export class DwarfCursor {
  offset = 0;

  constructor(
    readonly bytes: Buffer,
    readonly little: boolean,
  ) {}

  remaining(): number {
    return this.bytes.length - this.offset;
  }

  u8(): number | null {
    if (this.remaining() < 1) return null;
    const value = this.bytes[this.offset]!;
    this.offset += 1;
    return value;
  }

  u16(): number | null {
    const offset = this.offset;
    if (offset + 2 > this.bytes.length) return null;
    this.offset = offset + 2;
    return readUint16At(this.bytes, offset, this.little);
  }

  u24(): number | null {
    const offset = this.offset;
    if (offset + 3 > this.bytes.length) return null;
    this.offset = offset + 3;
    const bytes = this.bytes;
    return this.little
      ? bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
      : (bytes[offset]! << 16) | (bytes[offset + 1]! << 8) | bytes[offset + 2]!;
  }

  u32(): number | null {
    const offset = this.offset;
    if (offset + 4 > this.bytes.length) return null;
    this.offset = offset + 4;
    return readUint32At(this.bytes, offset, this.little);
  }

  u64(): bigint | null {
    const offset = this.offset;
    if (offset + 8 > this.bytes.length) return null;
    this.offset = offset + 8;
    return readUint64At(this.bytes, offset, this.little);
  }

  /** Read `size` bytes as an unsigned integer. Null when the cursor is short. */
  fixed(size: number): bigint | null {
    if (size === 0) return 0n;
    if (size === 1) {
      const value = this.u8();
      return value === null ? null : BigInt(value);
    }
    if (size === 2) {
      const value = this.u16();
      return value === null ? null : BigInt(value);
    }
    if (size === 4) {
      const value = this.u32();
      return value === null ? null : BigInt(value);
    }
    if (size === 8) return this.u64();
    if (size < 0 || this.remaining() < size) return null;
    let value = 0n;
    if (this.little) {
      for (let index = 0; index < size; index += 1)
        value |= BigInt(this.bytes[this.offset + index]!) << BigInt(8 * index);
    } else {
      for (let index = 0; index < size; index += 1)
        value = (value << 8n) | BigInt(this.bytes[this.offset + index]!);
    }
    this.offset += size;
    return value;
  }

  skip(size: number): boolean {
    if (size < 0 || this.remaining() < size) return false;
    this.offset += size;
    return true;
  }

  /**
   * Read an unsigned LEB128 integer as a safe JS number.
   * Returns `-1` when truncated/overlong and `-2` when exceeding `Number.MAX_SAFE_INTEGER`.
   */
  ulebSafe(): number {
    const bytes = this.bytes;
    const limit = bytes.length;
    let offset = this.offset;
    if (offset >= limit) return -1;
    const b0 = bytes[offset]!;
    if (b0 < 0x80) {
      this.offset = offset + 1;
      return b0;
    }
    let value = b0 & 0x7f;
    offset += 1;
    let shift = 7;
    for (let index = 1; index < MAX_DWARF_ULEB_BYTES; index += 1) {
      if (offset >= limit) {
        this.offset = offset;
        return -1;
      }
      const byte = bytes[offset]!;
      offset += 1;
      const payload = byte & 0x7f;
      if (shift <= 21) value |= payload << shift;
      else if (shift === 28) value += payload * SHIFT_28;
      else if (shift === 35) value += payload * SHIFT_35;
      else if (shift === 42) value += payload * SHIFT_42;
      else if (shift === 49) {
        if (payload > 0x0f) value = -2;
        else if (value >= 0) value += payload * SHIFT_49;
      } else if (payload !== 0) {
        value = -2;
      }
      if ((byte & 0x80) === 0) {
        this.offset = offset;
        return value;
      }
      shift += 7;
    }
    this.offset = offset;
    return -1;
  }

  uleb(): LebRead {
    return this.#leb(false);
  }

  sleb(): LebRead {
    return this.#leb(true);
  }

  #leb(signed: boolean): LebRead {
    const start = this.offset;
    if (start < this.bytes.length) {
      const b0 = this.bytes[start]!;
      if ((b0 & 0x80) === 0) {
        this.offset = start + 1;
        return {
          ok: true,
          value: BigInt(signed && (b0 & 0x40) !== 0 ? b0 - 128 : b0),
        };
      }
    }
    let result = 0n;
    let shift = 0n;
    let byte = 0;
    for (let index = 0; index < MAX_DWARF_ULEB_BYTES; index += 1) {
      if (this.remaining() < 1) return { ok: false, reason: "truncated" };
      byte = this.bytes[this.offset]!;
      this.offset += 1;
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
      if ((byte & 0x80) === 0) {
        if (signed && (byte & 0x40) !== 0) result |= -1n << shift;
        return { ok: true, value: result };
      }
    }
    return { ok: false, reason: "overlong" };
  }
}

const asSafeLength = (value: bigint): number | null =>
  value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);

/**
 * Read a DWARF initial length. Advances past the length field only.
 * The caller frames the payload from the returned length.
 */
export const readInitialLength = (cursor: DwarfCursor): InitialLength => {
  const first = cursor.u32();
  if (first === null) return { ok: false, reason: "truncated" };
  if (first >= 0xfffffff0 && first <= 0xfffffffe)
    return { ok: false, reason: "reserved" };
  if (first !== 0xffffffff) {
    return {
      ok: true,
      offsetSize: 4,
      payloadLength: first,
      totalLength: 4 + first,
    };
  }
  const wide = cursor.u64();
  if (wide === null) return { ok: false, reason: "truncated" };
  const payloadLength = asSafeLength(wide);
  if (payloadLength === null) return { ok: false, reason: "overflow" };
  const totalLength = asSafeLength(12n + wide);
  if (totalLength === null) return { ok: false, reason: "overflow" };
  return { ok: true, offsetSize: 8, payloadLength, totalLength };
};
