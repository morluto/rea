import { expect, it } from "vitest";
import {
  rasterThumbnailDimensions,
  rasterSampleCoordinate,
  packedRasterIndex,
  diagnosticRasterGray,
} from "./rasterSampling.js";

it("keeps nearest-neighbour thumbnail dimensions and coordinates", () => {
  expect(rasterThumbnailDimensions(7, 3, 4)).toEqual({ width: 4, height: 1 });
  expect(rasterThumbnailDimensions(1, 7, 4)).toEqual({ width: 1, height: 4 });
  expect(rasterThumbnailDimensions(3, 2, 96)).toEqual({ width: 3, height: 2 });
  expect(
    Array.from({ length: 4 }, (_, x) => rasterSampleCoordinate(x, 7, 4)),
  ).toEqual([0, 1, 3, 5]);
});

it.each([
  [1, 0b10100000, [1, 0, 1], [0, 0, 0]],
  [2, 0b00011011, [0, 1, 2, 3], [3, 2, 1, 0]],
  [4, 0x3a, [3, 10], [10, 3]],
  [8, 127, [127], [127]],
] as const)(
  "extracts %s-bit indices in either declared order",
  (bits, byte, msb, lsb) => {
    expect(
      msb.map((_, x) => packedRasterIndex(byte, x, bits, "msb-first")),
    ).toEqual(msb);
    expect(
      lsb.map((_, x) => packedRasterIndex(byte, x, bits, "lsb-first")),
    ).toEqual(lsb);
  },
);

it("maps selector indices to opaque diagnostic grayscale without palette assumptions", () => {
  expect([0, 1, 2, 3].map((index) => diagnosticRasterGray(index, 2))).toEqual([
    0, 85, 170, 255,
  ]);
  expect(diagnosticRasterGray(8, 4)).toBe(136);
});
