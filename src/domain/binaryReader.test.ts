import { expect, it, vi } from "vitest";
import { BinaryFormatFailure, BinaryReader } from "./binaryContainer.js";

it("reads scalars without allocating temporary Buffer views", () => {
  const reader = new BinaryReader(
    Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
    true,
    "test",
  );
  const subarray = vi.spyOn(reader.bytes, "subarray");
  expect(reader.u16(0)).toBe(0x0201);
  expect(reader.u32(0)).toBe(0x04030201);
  expect(reader.word(0, 64)).toBe(0x0807060504030201n);
  expect(subarray).not.toHaveBeenCalled();
  subarray.mockRestore();
});

it("preserves scalar byte order and nonzero backing offsets", () => {
  const backing = Buffer.from([99, 98, 1, 2, 3, 4, 5, 6, 7, 8, 97]);
  const bytes = backing.subarray(2, 10);
  for (const little of [true, false]) {
    const reader = new BinaryReader(bytes, little, "test");
    expect(reader.u8(0)).toBe(1);
    expect(reader.u16(0)).toBe(little ? 0x0201 : 0x0102);
    expect(reader.u32(1)).toBe(little ? 0x05040302 : 0x02030405);
    expect(reader.word(0, 32)).toBe(little ? 0x04030201n : 0x01020304n);
    expect(reader.word(0, 64)).toBe(
      little ? 0x0807060504030201n : 0x0102030405060708n,
    );
  }
});

it("preserves exact range failure facts for scalar readers", () => {
  const reader = new BinaryReader(Buffer.alloc(8), true, "test-format");
  const cases = [
    { read: (at: number) => reader.u8(at), size: 1, label: "8-bit field" },
    { read: (at: number) => reader.u16(at), size: 2, label: "16-bit field" },
    { read: (at: number) => reader.u32(at), size: 4, label: "32-bit field" },
    {
      read: (at: number) => reader.word(at, 64),
      size: 8,
      label: "64-bit field",
    },
  ];
  for (const { read, size, label } of cases)
    for (const at of [-1, 0.5, Number.NaN, 9, 8, 9 - size]) {
      let expected: unknown;
      try {
        reader.range(at, size, label);
      } catch (cause) {
        expected = cause;
      }
      expect(expected).toBeInstanceOf(BinaryFormatFailure);
      try {
        read(at);
        throw new Error("Expected scalar failure");
      } catch (cause) {
        expect(cause).toBeInstanceOf(BinaryFormatFailure);
        expect((cause as BinaryFormatFailure).failure).toEqual(
          (expected as BinaryFormatFailure).failure,
        );
        expect((cause as Error).message).toBe((expected as Error).message);
      }
    }
});

it("keeps explicit range views shared with the original bytes", () => {
  const bytes = Buffer.from([1, 2, 3]);
  const reader = new BinaryReader(bytes, true, "test");
  reader.range(1, 1, "field")[0] = 9;
  expect(bytes[1]).toBe(9);
  expect(reader.range(3, 0, "empty")).toHaveLength(0);
});
