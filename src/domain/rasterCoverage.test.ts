import { expect, it } from "vitest";
import { RasterCoverageIndex } from "./rasterCoverage.js";

it("normalizes overlapping and adjacent spans without covering holes", () => {
  const result = RasterCoverageIndex.prepare(12, [
    { offset: 8, length: 4 },
    { offset: 2, length: 3 },
    { offset: 0, length: 3 },
    { offset: 5, length: 1 },
  ]);
  if (!result.ok) throw result.error;
  expect(result.value.covers(0, 6)).toBe(true);
  expect(result.value.covers(5, 4)).toBe(false);
  expect(result.value.covers(8, 4)).toBe(true);
  for (const [offset, length] of [
    [-1, 1],
    [0, 0],
    [12, 1],
    [0.5, 1],
    [0, NaN],
    [0, Number.MAX_SAFE_INTEGER],
  ])
    expect(result.value.covers(offset!, length!)).toBe(false);
});

it("retains its own immutable coverage after callers mutate the input", () => {
  const ranges = [{ offset: 1, length: 2 }];
  const result = RasterCoverageIndex.prepare(4, ranges);
  if (!result.ok) throw result.error;
  ranges[0]!.length = 3;
  ranges.push({ offset: 0, length: 1 });
  expect(result.value.covers(1, 2)).toBe(true);
  expect(result.value.covers(0, 1)).toBe(false);
  expect(result.value.covers(1, 3)).toBe(false);
});

it.each([
  [{ offset: -1, length: 1 }, "offset"],
  [{ offset: 0.5, length: 1 }, "offset"],
  [{ offset: 0, length: 0 }, "length"],
  [{ offset: 0, length: Infinity }, "length"],
  [{ offset: 3, length: 2 }, "range"],
] as const)("rejects invalid span %j with a typed field", (range, field) => {
  expect(RasterCoverageIndex.prepare(4, [range])).toEqual({
    ok: false,
    error: { field, index: 0 },
  });
});

it("permits an empty coverage set without treating bytes as observed", () => {
  const result = RasterCoverageIndex.prepare(4, []);
  if (!result.ok) throw result.error;
  expect(result.value.covers(0, 1)).toBe(false);
});
