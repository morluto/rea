import { describe, expect, it } from "vitest";
import { readElfSymbol, readElfSymbolAt } from "./elfSymbol.js";

const formats = [
  { bits: 32, littleEndian: false },
  { bits: 32, littleEndian: true },
  { bits: 64, littleEndian: false },
  { bits: 64, littleEndian: true },
] as const;

it.each(formats)(
  "preserves raw ELF$bits symbols (littleEndian=$littleEndian)",
  ({ bits, littleEndian }) => {
    const wide = bits === 64;
    const length = wide ? 24 : 16;
    const backing = Buffer.alloc(length + 19, 0xa5);
    const bytes = backing.subarray(7, 7 + length);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const value = wide ? 0xfedcba9876543210n : 0xfedcba98n;
    const size = wide ? 0xffffffffffffffffn : 0xffffffffn;
    view.setUint32(0, 0x89abcdef, littleEndian);
    view.setUint8(wide ? 4 : 12, 0xf3);
    view.setUint8(wide ? 5 : 13, 0xee);
    view.setUint16(wide ? 6 : 14, 0xffff, littleEndian);
    if (wide) {
      view.setBigUint64(8, value, littleEndian);
      view.setBigUint64(16, size, littleEndian);
    } else {
      view.setUint32(4, Number(value), littleEndian);
      view.setUint32(8, Number(size), littleEndian);
    }
    const before = Buffer.from(backing);
    const parsed = readElfSymbol(backing.subarray(7), bits, littleEndian);
    expect(backing.equals(before)).toBe(true);
    backing.fill(0);
    expect(parsed).toEqual({
      ok: true,
      value: {
        name_offset: 0x89abcdef,
        binding: 15,
        type: 3,
        other: 0xee,
        section_index: 0xffff,
        value,
        size,
      },
    });
  },
);

it.each(formats)(
  "refuses each incomplete ELF$bits symbol (littleEndian=$littleEndian)",
  ({ bits, littleEndian }) => {
    const length = bits === 64 ? 24 : 16;
    const backing = Buffer.alloc(length + 7, 0xff);
    for (let observed = 0; observed < length; observed++)
      expect(
        readElfSymbol(backing.subarray(7, 7 + observed), bits, littleEndian),
      ).toEqual({
        ok: false,
        error: {
          kind: "malformed",
          message: expect.stringContaining("truncated"),
        },
      });
  },
);

describe("readElfSymbolAt", () => {
  it.each(formats)(
    "decodes ELF$bits symbols at non-zero offsets without slicing (littleEndian=$littleEndian)",
    ({ bits, littleEndian }) => {
      const length = bits === 64 ? 24 : 16;
      const bytes = new Uint8Array(length * 2 + 5);
      const offset = 5 + length;
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset + offset,
        length,
      );
      view.setUint32(0, 0x12345678, littleEndian);
      view.setUint8(bits === 64 ? 4 : 12, 0x2a);
      view.setUint8(bits === 64 ? 5 : 13, 0x10);
      view.setUint16(bits === 64 ? 6 : 14, 0x0003, littleEndian);
      if (bits === 64) {
        view.setBigUint64(8, 0x0102030405060708n, littleEndian);
        view.setBigUint64(16, 0x1122334455667788n, littleEndian);
      } else {
        view.setUint32(4, 0x05060708, littleEndian);
        view.setUint32(8, 0x55667788, littleEndian);
      }
      expect(readElfSymbolAt(bytes, offset, bits, littleEndian)).toEqual({
        name_offset: 0x12345678,
        binding: 2,
        type: 10,
        other: 0x10,
        section_index: 3,
        value: bits === 64 ? 0x0102030405060708n : 0x05060708n,
        size: bits === 64 ? 0x1122334455667788n : 0x55667788n,
      });
      expect(readElfSymbolAt(bytes, -1, bits, littleEndian)).toBeNull();
      expect(readElfSymbolAt(bytes, 1.5, bits, littleEndian)).toBeNull();
      expect(readElfSymbolAt(bytes, offset + 1, bits, littleEndian)).toBeNull();
    },
  );
});
