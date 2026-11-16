import { expect, it } from "vitest";

import { readLeb128, SLEB64, ULEB32, ULEB64 } from "./leb128.js";

const read = (bytes: readonly number[], encoding = ULEB64) =>
  readLeb128(Uint8Array.from(bytes), 0, bytes.length, encoding);

it.each([
  [[0x00], ULEB64, 0n],
  [[0xe5, 0x8e, 0x26], ULEB64, 624_485n],
  [[0x7f], SLEB64, -1n],
  [[0xc0, 0xbb, 0x78], SLEB64, -123_456n],
  [[0xff, 0xff, 0xff, 0xff, 0x0f], ULEB32, 0xffff_ffffn],
  [
    [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01],
    ULEB64,
    0xffff_ffff_ffff_ffffn,
  ],
  [
    [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x7f],
    SLEB64,
    -(2n ** 63n),
  ],
  [
    [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00],
    SLEB64,
    2n ** 63n - 1n,
  ],
] as const)("decodes %j", (bytes, encoding, value) => {
  expect(read(bytes, encoding)).toEqual({ value, next: bytes.length });
});

it.each([
  ["a 33-bit value in 32 bits", [0xff, 0xff, 0xff, 0xff, 0x1f], ULEB32, 4],
  ["a sixth byte in 32 bits", [0x80, 0x80, 0x80, 0x80, 0x80, 0x00], ULEB32, 5],
  [
    "a 65-bit value",
    [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x02],
    ULEB64,
    9,
  ],
  [
    "a sign that does not repeat",
    [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01],
    SLEB64,
    9,
  ],
] as const)("refuses %s as overflow", (_, bytes, encoding, at) => {
  expect(read(bytes, encoding)).toEqual({ failure: "overflow", at });
});

it("refuses an encoding that runs past its end as truncated", () => {
  expect(read([0x80, 0x80])).toEqual({ failure: "truncated", at: 2 });
  expect(readLeb128(Uint8Array.from([0x80, 0x00]), 0, 1, ULEB64)).toEqual({
    failure: "truncated",
    at: 1,
  });
});

it("accepts padding only where the format allows it, and only as the sign", () => {
  const padded = [
    0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x81, 0x80, 0x00,
  ];
  expect(read(padded)).toEqual({ failure: "overflow", at: 10 });
  expect(read(padded, { ...ULEB64, padding: true })).toEqual({
    value: 0xffff_ffff_ffff_ffffn,
    next: padded.length,
  });
  expect(
    read([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x81, 0x01], {
      ...ULEB64,
      padding: true,
    }),
  ).toEqual({ failure: "overflow", at: 10 });
  expect(
    read([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f], {
      ...SLEB64,
      padding: true,
    }),
  ).toEqual({ value: -1n, next: 11 });
});
