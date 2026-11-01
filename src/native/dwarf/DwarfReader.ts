import { MAX_DWARF_ULEB_BYTES } from "../../domain/native/dwarfUnits.js";

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
    return this.#readInt(2);
  }

  u32(): number | null {
    return this.#readInt(4);
  }

  u64(): bigint | null {
    return this.fixed(8);
  }

  /** Read `size` bytes as an unsigned integer. Null when the cursor is short. */
  fixed(size: number): bigint | null {
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

  uleb(): LebRead {
    return this.#leb(false);
  }

  sleb(): LebRead {
    return this.#leb(true);
  }

  #readInt(size: number): number | null {
    const value = this.fixed(size);
    return value === null ? null : Number(value);
  }

  #leb(signed: boolean): LebRead {
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
