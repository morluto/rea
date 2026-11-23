import { expect, it } from "vitest";
import { readElfRelocationEntryAt } from "./elfRelocation.js";

const formats = [
  { bits: 32, littleEndian: false },
  { bits: 32, littleEndian: true },
  { bits: 64, littleEndian: false },
  { bits: 64, littleEndian: true },
] as const;

it.each(formats)(
  "preserves ELF$bits REL/RELA fields in a selected byte view (littleEndian=$littleEndian)",
  ({ bits, littleEndian }) => {
    const wordBytes = bits / 8;
    const at = 5;
    const backing = Buffer.alloc(7 + at + 3 * wordBytes + 12, 0xa5);
    const bytes = backing.subarray(7, 7 + at + 3 * wordBytes);
    const input = new Uint8Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset + at,
      3 * wordBytes,
    );
    const offset = bits === 64 ? 0xfedcba9876543210n : 0x89abcdefn;
    const symbolIndex = bits === 64 ? 0xfedcba98 : 0xabcdef;
    const type = bits === 64 ? 0x89abcdef : 0x80;
    const info =
      (BigInt(symbolIndex) << (bits === 64 ? 32n : 8n)) | BigInt(type);
    const addend = bits === 64 ? -0x8000000000000000n : -0x80000000n;
    if (bits === 64) {
      view.setBigUint64(0, offset, littleEndian);
      view.setBigUint64(8, info, littleEndian);
      view.setBigInt64(16, addend, littleEndian);
    } else {
      view.setUint32(0, Number(offset), littleEndian);
      view.setUint32(4, Number(info), littleEndian);
      view.setInt32(8, Number(addend), littleEndian);
    }

    const before = Buffer.from(backing);
    const rel = readElfRelocationEntryAt(
      bytes.subarray(0, at + 2 * wordBytes),
      at,
      bits,
      littleEndian,
      "rel",
    );
    expect(
      readElfRelocationEntryAt(input, at, bits, littleEndian, "rel"),
    ).toEqual({
      offset,
      type,
      symbolIndex,
    });
    const rela = readElfRelocationEntryAt(
      input,
      at,
      bits,
      littleEndian,
      "rela",
    );
    expect(backing.equals(before)).toBe(true);

    const maximum = bits === 64 ? 0xffffffffffffffffn : 0xffffffffn;
    const negative = bits === 64 ? -42n : -7n;
    if (bits === 64) {
      view.setBigUint64(0, maximum, littleEndian);
      view.setBigInt64(16, negative, littleEndian);
    } else {
      view.setUint32(0, Number(maximum), littleEndian);
      view.setInt32(8, Number(negative), littleEndian);
    }
    expect(
      readElfRelocationEntryAt(input, at, bits, littleEndian, "rela"),
    ).toEqual({
      offset: maximum,
      type,
      symbolIndex,
      addend: negative,
    });

    backing.fill(0);
    expect(rel).toEqual({ offset, type, symbolIndex });
    expect(rela).toEqual({ offset, type, symbolIndex, addend });
  },
);

it.each(formats)(
  "refuses incomplete ELF$bits REL/RELA rows at the selected offset (littleEndian=$littleEndian)",
  ({ bits, littleEndian }) => {
    const wordBytes = bits / 8;
    const at = 5;
    const bytes = Buffer.alloc(at + 3 * wordBytes + 7);
    expect(
      readElfRelocationEntryAt(bytes, -1, bits, littleEndian, "rel"),
    ).toBeNull();
    for (const [encoding, width] of [
      ["rel", 2 * wordBytes],
      ["rela", 3 * wordBytes],
    ] as const)
      for (let observed = 0; observed < width; observed += 1)
        expect(
          readElfRelocationEntryAt(
            bytes.subarray(0, at + observed),
            at,
            bits,
            littleEndian,
            encoding,
          ),
        ).toBeNull();
  },
);
