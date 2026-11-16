import { expect, it } from "vitest";
import {
  renderRasterResource,
  type RasterColorPolicy,
  type RasterRenderLayout,
} from "./RasterResourceRendering.js";
const policy: RasterColorPolicy = {
  kind: "record12-lut-registry",
  themeSlot: 0,
  paletteRange: { offset: 64, length: 1024 },
  precision: "byte8",
  alpha: "palette",
  sentinel: "profile",
  rgb565ColorKey: null,
};
function fixture(bits: 1 | 2 | 4 | 8, format: number) {
  const bytes = Buffer.alloc(1088);
  bytes[0] = 0b01010101;
  for (let i = 0; i < 256; i++) bytes.set([128, i, 2, 3], 64 + i * 4);
  for (let i = 0; i < 1 << bits; i++)
    if (bits !== 8) bytes.writeUInt16LE(i, 8 + i * 2);
  const layout: RasterRenderLayout = {
    width: 2,
    height: 1,
    layout: `indexed${bits}`,
    bitsPerPixel: bits,
    stride: 1,
    payloadRange: { offset: 0, length: 1 },
    lookupRange: bits === 8 ? null : { offset: 8, length: 2 << bits },
    rowOrder: "top-down",
    bitOrder: "msb-first",
    format,
  };
  if (bits === 8) {
    layout.stride = 2;
    layout.payloadRange.length = 2;
    bytes[0] = 1;
    bytes[1] = 2;
  }
  return {
    bytes,
    layout,
    options: { coverage: [{ offset: 0, length: bytes.length }] },
  };
}
it.for([
  [1, 1],
  [2, 2],
  [4, 3],
  [8, 4],
] as const)("renders declared family indexed %s", async ([bits, format]) => {
  const { bytes, layout, options } = fixture(bits, format);
  const result = await renderRasterResource(bytes, layout, policy, options);
  expect(result.status).toBe("rendered");
  if (result.status !== "rendered") throw new Error(result.reason);
  expect(Array.from(result.rgba.slice(0, 4))).toEqual([
    bits === 1 ? 0 : bits === 4 ? 5 : 1,
    2,
    3,
    128,
  ]);
});
it("preserves format1 sentinel selector asymmetry and explicit disable", async () => {
  const { bytes, layout, options } = fixture(1, 1);
  bytes.writeUInt16LE(0x8000, 8);
  bytes.writeUInt16LE(0x8000, 10);
  const result = await renderRasterResource(bytes, layout, policy, options);
  expect(result.status).toBe("rendered");
  if (result.status === "rendered")
    expect([...result.rgba]).toEqual([0, 0, 0, 0, 0, 2, 3, 128]);
  const disabled = await renderRasterResource(
    bytes,
    layout,
    { ...policy, sentinel: "disabled" },
    options,
  );
  if (disabled.status !== "rendered") throw new Error(disabled.reason);
  expect(Array.from(disabled.rgba.slice(0, 4))).toEqual([0, 2, 3, 128]);
});
it.for([
  [2, 2],
  [4, 3],
] as const)(
  "applies LUT sentinel to every selector for format %s",
  async ([bits, format]) => {
    const { bytes, layout, options } = fixture(bits, format);
    const selector = bits === 2 ? 1 : 5;
    bytes.writeUInt16LE(0x8000, 8 + selector * 2);
    const result = await renderRasterResource(bytes, layout, policy, options);
    if (result.status !== "rendered") throw new Error(result.reason);
    expect(Array.from(result.rgba.slice(0, 4))).toEqual([0, 0, 0, 0]);
  },
);
it("keeps direct index255 and precision/alpha choices explicit", async () => {
  const { bytes, layout, options } = fixture(8, 4);
  bytes[0] = 255;
  bytes.set([130, 131, 132, 133], 64 + 2 * 4);
  const result = await renderRasterResource(
    bytes,
    layout,
    { ...policy, precision: "expand-high6", alpha: "opaque" },
    options,
  );
  if (result.status !== "rendered") throw new Error(result.reason);
  expect([...result.rgba]).toEqual([0, 0, 0, 0, 130, 134, 134, 255]);
});
it("distinguishes caller selector palette from declared LUT indices", async () => {
  const { bytes, layout, options } = fixture(1, 1);
  bytes.writeUInt16LE(2, 8);
  bytes.writeUInt16LE(0, 10);
  const entries: [number, number, number, number][] = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
  ];
  const selector = await renderRasterResource(
    bytes,
    layout,
    {
      kind: "rgba-palette",
      entries,
      index_space: "selector",
      sentinel: "disabled",
    },
    options,
  );
  const lookup = await renderRasterResource(
    bytes,
    layout,
    {
      kind: "rgba-palette",
      entries,
      index_space: "lookup-low-byte",
      sentinel: "disabled",
    },
    options,
  );
  if (selector.status !== "rendered" || lookup.status !== "rendered")
    throw new Error("Expected both policies to render");
  expect(Array.from(selector.rgba.slice(0, 4))).toEqual(entries[0]);
  expect(Array.from(lookup.rgba.slice(0, 4))).toEqual(entries[2]);
});
it("renders RGB565 endpoints, transparent key only when selected, and nonzero source byteOffset", async () => {
  const backing = Buffer.alloc(20, 0xff),
    bytes = backing.subarray(3, 11);
  bytes.writeUInt16LE(0xf800, 0);
  bytes.writeUInt16LE(0x07e0, 2);
  bytes.writeUInt16LE(0x001f, 4);
  bytes.writeUInt16LE(0xa5a5, 6);
  const layout: RasterRenderLayout = {
    width: 4,
    height: 1,
    layout: "rgb565le",
    bitsPerPixel: 16,
    stride: 8,
    payloadRange: { offset: 0, length: 8 },
    format: 6,
    rowOrder: "bottom-up",
    bitOrder: "msb-first",
  };
  const options = { coverage: [{ offset: 0, length: 8 }] };
  const result = await renderRasterResource(
    bytes,
    layout,
    { ...policy, rgb565ColorKey: 0xa5a5 },
    options,
  );
  if (result.status !== "rendered") throw new Error(result.reason);
  expect([...result.rgba]).toEqual([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0,
  ]);
  const opaque = await renderRasterResource(bytes, layout, policy, options);
  if (opaque.status !== "rendered") throw new Error(opaque.reason);
  expect(opaque.rgba[15]).toBe(255);
});
it("rejects unsupported formats, unknown flags and uncovered LUT/palette", async () => {
  const { bytes, layout, options } = fixture(1, 1);
  for (const format of [0, 5])
    expect(
      (
        await renderRasterResource(
          bytes,
          { ...layout, format },
          policy,
          options,
        )
      ).status,
    ).toBe("unrenderable");
  bytes.writeUInt16LE(0x4000, 8);
  expect(
    (await renderRasterResource(bytes, layout, policy, options)).status,
  ).toBe("unrenderable");
  bytes.writeUInt16LE(0, 8);
  expect(
    (
      await renderRasterResource(bytes, layout, policy, {
        coverage: [
          { offset: 0, length: 8 },
          { offset: 12, length: 1076 },
        ],
      })
    ).status,
  ).toBe("unrenderable");
  expect(
    (
      await renderRasterResource(bytes, layout, policy, {
        coverage: [{ offset: 0, length: 100 }],
      })
    ).status,
  ).toBe("unrenderable");
});
it("supports explicit LSB-first and top-down packed selectors", async () => {
  const { bytes, layout, options } = fixture(1, 1);
  bytes[0] = 1;
  const result = await renderRasterResource(
    bytes,
    { ...layout, bitOrder: "lsb-first" },
    policy,
    options,
  );
  if (result.status !== "rendered") throw new Error(result.reason);
  expect(Array.from(result.rgba.slice(0, 4))).toEqual([1, 2, 3, 128]);
});
