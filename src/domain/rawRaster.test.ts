import { expect, it } from "vitest";
import { decodeRawRaster, admitRawRaster } from "./rawRaster.js";

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
  if (!result.ok) throw result.error;
  expect([...result.value.rgba]).toEqual(output);
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
  if (!result.ok) throw result.error;
  expect([...result.value.rgba]).toEqual([4, 5, 6, 255, 1, 2, 3, 255]);
  expect(result.value.consumedSpan).toBe(7);
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
  const admitted = decodeRawRaster(bytes, layout, {
    maxSourceBytes: 3,
    maxOutputBytes: 4,
  });
  if (!admitted.ok) throw admitted.error;
  expect([...admitted.value.rgba]).toEqual([1, 2, 3, 255]);
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
  if (!result.ok) throw result.error;
  expect(result.value.consumedSpan).toBe(3);
});
it("steps multiple columns and top-down rows independently", () => {
  const result = decodeRawRaster(
    new Uint8Array([1, 2, 3, 4, 99, 5, 6, 7, 8]),
    { ...layout, length: 9, width: 2, height: 2, stride: 5, format: "gray8" },
    budget,
  );
  if (!result.ok) throw result.error;
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

it("admits a bounded selection in a large file without allocating file or pixels", () => {
  const result = admitRawRaster(
    2 ** 40,
    { ...layout, offset: 2 ** 39 },
    budget,
  );
  if (!result.ok) throw result.error;
  expect(result.value).toEqual({
    layout: { ...layout, offset: 2 ** 39 },
    channelCount: 3,
    consumedSpan: 3,
  });
  expect(admitRawRaster(NaN, layout, budget).ok).toBe(false);
  expect(admitRawRaster(-1, layout, budget).ok).toBe(false);
});

const palette = Array.from({ length: 16 }, (_, i) => [
  i,
  255 - i,
  i * 10,
  i * 17,
]);
const indexed = {
  offset: 0,
  length: 8,
  width: 16,
  height: 1,
  stride: 8,
  format: "indexed4",
  rowOrder: "top-down",
  bitOrder: "msb-first",
  palette,
};
it.each(["msb-first", "lsb-first"])(
  "decodes all indexed4 entries and straight alpha (%s)",
  (bitOrder) => {
    const bytes = new Uint8Array([
      0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
    ]);
    const result = decodeRawRaster(bytes, { ...indexed, bitOrder }, budget);
    if (!result.ok) throw result.error;
    const indices = Array.from({ length: 16 }, (_, i) =>
      bitOrder === "msb-first" ? i : i ^ 1,
    );
    expect([...result.value.rgba]).toEqual(indices.flatMap((i) => palette[i]!));
    expect(result.value.layout).toEqual({ ...indexed, bitOrder });
  },
);
it("indexed4 ignores odd-width unused nibble, honors subview, stride and bottom-up", () => {
  const bytes = new Uint8Array([
    99, 88, 0x12, 0x3f, 77, 0x45, 0x6f, 66,
  ]).subarray(1);
  const result = decodeRawRaster(
    bytes,
    {
      ...indexed,
      offset: 1,
      length: 5,
      width: 3,
      height: 2,
      stride: 3,
      rowOrder: "bottom-up",
    },
    budget,
  );
  if (!result.ok) throw result.error;
  expect([...result.value.rgba]).toEqual(
    [4, 5, 6, 1, 2, 3].flatMap((i) => palette[i]!),
  );
  expect(result.value.consumedSpan).toBe(5);
});
it.each([
  { palette: undefined },
  { palette: [] },
  { palette: palette.slice(1) },
  { palette: [...palette, [0, 0, 0, 0]] },
  { palette: palette.map((p, i) => (i === 0 ? [0, 0, 0] : p)) },
  { palette: palette.map((p, i) => (i === 0 ? [0, 0, 0, 256] : p)) },
  { palette: palette.map((p, i) => (i === 0 ? [0, 0, 0, -1] : p)) },
  { palette: palette.map((p, i) => (i === 0 ? [0, 0, 0, 0.5] : p)) },
  { bitOrder: undefined },
  { bitOrder: "guess" },
  { stride: 7 },
  { length: 7 },
])("rejects malformed indexed4 layout %j", (patch) => {
  expect(
    decodeRawRaster(new Uint8Array(8), { ...indexed, ...patch }, budget).ok,
  ).toBe(false);
});
it("indexed palette is copied and indexed-only options are refused on direct formats", () => {
  const mutable = palette.map((p) => [...p]);
  const result = decodeRawRaster(
    new Uint8Array(8),
    { ...indexed, palette: mutable },
    budget,
  );
  if (!result.ok) throw result.error;
  mutable[0]![0] = 255;
  expect(result.value.layout.format).toBe("indexed4");
  if (result.value.layout.format !== "indexed4")
    throw new Error("Expected indexed4 layout");
  expect(result.value.layout.palette[0]).toEqual(palette[0]);
  expect(
    decodeRawRaster(new Uint8Array(3), { ...layout, palette }, budget).ok,
  ).toBe(false);
  expect(
    decodeRawRaster(
      new Uint8Array(3),
      { ...layout, bitOrder: "msb-first" },
      budget,
    ).ok,
  ).toBe(false);
});

it("rejects sparse palettes and sparse RGBA tuples", () => {
  const sparsePalette: unknown[] = [];
  sparsePalette.length = 16;
  const sparseComponents: number[] = [];
  sparseComponents.length = 4;
  expect(
    decodeRawRaster(
      new Uint8Array(8),
      { ...indexed, palette: sparsePalette },
      budget,
    ).ok,
  ).toBe(false);
  const sparseTuple = palette.map((p) => [...p]);
  sparseTuple[0] = sparseComponents;
  expect(
    decodeRawRaster(
      new Uint8Array(8),
      { ...indexed, palette: sparseTuple },
      budget,
    ).ok,
  ).toBe(false);
});
