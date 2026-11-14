import { expect, it } from "vitest";
import { decodeRawRaster } from "./rawRaster.js";

const layout = {
  offset: 0,
  length: 3,
  width: 1,
  height: 1,
  stride: 3,
  format: "rgb888",
  rowOrder: "top-down",
} as const;
const budget = { maxSourceBytes: 1024, maxOutputBytes: 1024 };
it.each([
  ["gray8", [7], [7, 7, 7, 255]],
  ["rgb888", [1, 2, 3], [1, 2, 3, 255]],
  ["bgr888", [3, 2, 1], [1, 2, 3, 255]],
  ["rgba8888", [1, 2, 3, 4], [1, 2, 3, 4]],
  ["bgra8888", [3, 2, 1, 4], [1, 2, 3, 4]],
] as const)("decodes %s without mutating input", (format, input, output) => {
  const bytes = new Uint8Array(input);
  const result = decodeRawRaster(
    bytes,
    { ...layout, format, length: input.length, stride: input.length },
    budget,
  );
  expect(result.ok).toBe(true);
  if (result.ok) expect([...result.value.rgba]).toEqual(output);
  expect([...bytes]).toEqual(input);
});
it("honors byte subviews, explicit range, padding, bottom-up rows and optional last padding", () => {
  const bytes = new Uint8Array([
    99, 99, 88, 1, 2, 3, 77, 4, 5, 6, 66, 99,
  ]).subarray(2, 11);
  const result = decodeRawRaster(
    bytes,
    {
      ...layout,
      offset: 1,
      length: 7,
      height: 2,
      stride: 4,
      rowOrder: "bottom-up",
    },
    budget,
  );
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect([...result.value.rgba]).toEqual([4, 5, 6, 255, 1, 2, 3, 255]);
    expect(result.value.consumedSpan).toBe(7);
  }
});
it.each([
  { offset: -1 },
  { length: 0 },
  { width: 0 },
  { height: 1.5 },
  { stride: 2 },
  { offset: 1 },
  { length: 4 },
  { width: NaN },
  { height: Number.MAX_SAFE_INTEGER },
  { stride: Infinity },
  { format: "toString" },
  { rowOrder: "guess" },
])("rejects malformed layout %j", (patch) => {
  expect(
    decodeRawRaster(new Uint8Array([1, 2, 3]), { ...layout, ...patch }, budget)
      .ok,
  ).toBe(false);
});
it("checks both source and RGBA expansion allowances", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  expect(
    decodeRawRaster(bytes, layout, { maxSourceBytes: 2, maxOutputBytes: 4 }).ok,
  ).toBe(false);
  expect(
    decodeRawRaster(bytes, layout, { maxSourceBytes: 3, maxOutputBytes: 3 }).ok,
  ).toBe(false);
  expect(
    decodeRawRaster(bytes, layout, { maxSourceBytes: 3, maxOutputBytes: 4 }).ok,
  ).toBe(true);
});
it("rejects absent layout and invalid caller allowances", () => {
  expect(decodeRawRaster(new Uint8Array(3), null, budget).ok).toBe(false);
  expect(
    decodeRawRaster(new Uint8Array(3), layout, {
      maxSourceBytes: Infinity,
      maxOutputBytes: 4,
    }).ok,
  ).toBe(false);
});
it("includes selected trailing bytes in admission, not pixel output", () => {
  const result = decodeRawRaster(
    new Uint8Array([1, 2, 3, 99]),
    { ...layout, length: 4 },
    budget,
  );
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.value.consumedSpan).toBe(3);
});
it("steps multiple columns and top-down rows independently", () => {
  const result = decodeRawRaster(
    new Uint8Array([1, 2, 3, 4, 99, 5, 6, 7, 8]),
    { ...layout, length: 9, width: 2, height: 2, stride: 5, format: "gray8" },
    budget,
  );
  expect(result.ok).toBe(true);
  if (result.ok)
    expect([...result.value.rgba]).toEqual([
      1, 1, 1, 255, 2, 2, 2, 255, 5, 5, 5, 255, 6, 6, 6, 255,
    ]);
});
it("distinguishes malformed layout from capacity exhaustion", () => {
  const malformed = decodeRawRaster(
    new Uint8Array(3),
    { ...layout, stride: 2 },
    budget,
  );
  const capacity = decodeRawRaster(new Uint8Array(3), layout, {
    ...budget,
    maxOutputBytes: 3,
  });
  expect(malformed.ok ? undefined : malformed.error.kind).toBe("malformed");
  expect(capacity.ok ? undefined : capacity.error.kind).toBe("capacity");
});
