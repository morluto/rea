import { expect, it } from "vitest";
import { inflateSync } from "node:zlib";
import {
  renderRasterResource,
  renderRasterResourceThumbnail,
  copyRasterResourceRaw,
  prepareRasterRenderCoverage,
  type RasterRenderLayout,
  type RasterColorPolicy,
} from "./RasterResourceRendering.js";
const layout: RasterRenderLayout = {
  width: 3,
  height: 2,
  layout: "indexed2",
  bitsPerPixel: 2,
  stride: 1,
  payloadRange: { offset: 0, length: 2 },
  rowOrder: "bottom-up",
  bitOrder: "msb-first",
};
const policy: RasterColorPolicy = {
  kind: "rgba-palette",
  entries: [
    [0, 0, 0, 0],
    [10, 20, 30, 40],
    [50, 60, 70, 80],
    [90, 100, 110, 120],
  ],
  index_space: "selector",
  sentinel: "disabled",
};
const coverage = [{ offset: 0, length: 2 }];
it("renders exact packed RGBA rows and lossless padding bytes", async () => {
  const bytes = Buffer.from([0b01101111, 0b11100101]);
  const result = await renderRasterResource(bytes, layout, policy, {
    coverage,
  });
  expect(result.status).toBe("rendered");
  if (result.status !== "rendered") throw new Error(result.reason);
  expect([...result.rgba]).toEqual([
    90, 100, 110, 120, 50, 60, 70, 80, 10, 20, 30, 40, 10, 20, 30, 40, 50, 60,
    70, 80, 90, 100, 110, 120,
  ]);
  const raw = await copyRasterResourceRaw(bytes, layout, { coverage });
  expect(raw.status).toBe("copied");
  if (raw.status === "copied") expect(raw.raw.equals(bytes)).toBe(true);
  const chunks: Buffer[] = [];
  for (let at = 8; at < result.png.length;) {
    const n = result.png.readUInt32BE(at);
    if (result.png.toString("ascii", at + 4, at + 8) === "IDAT")
      chunks.push(result.png.subarray(at + 8, at + 8 + n));
    at += 12 + n;
  }
  expect([...inflateSync(Buffer.concat(chunks))]).toEqual([
    0,
    ...result.rgba.slice(0, 12),
    0,
    ...result.rgba.slice(12),
  ]);
});
it("refuses gaps and incomplete palettes without discarding valid raw", async () => {
  const bytes = Buffer.from([0xff, 0xff]);
  expect(
    (
      await renderRasterResource(bytes, layout, policy, {
        coverage: [{ offset: 0, length: 1 }],
      })
    ).status,
  ).toBe("unrenderable");
  expect(
    (
      await renderRasterResource(
        bytes,
        layout,
        { ...policy, entries: [[0, 0, 0, 0]] },
        { coverage },
      )
    ).status,
  ).toBe("unrenderable");
  expect(
    (await copyRasterResourceRaw(bytes, layout, { coverage })).status,
  ).toBe("copied");
});
it("limits full allocation while thumbnails sample without full-image decoding", async () => {
  const large = {
    ...layout,
    width: 4096,
    height: 4096,
    layout: "indexed1" as const,
    bitsPerPixel: 1 as const,
    stride: 512,
    payloadRange: { offset: 0, length: 2097152 },
  };
  const bytes = Buffer.alloc(2097152),
    coverage = [{ offset: 0, length: bytes.length }];
  expect(
    (
      await renderRasterResource(
        bytes,
        large,
        { kind: "diagnostic-indices" },
        { coverage },
      )
    ).status,
  ).toBe("limit-exceeded");
  const thumbnail = await renderRasterResourceThumbnail(
    bytes,
    large,
    { kind: "diagnostic-indices" },
    { coverage, maxSide: 16 },
  );
  expect(thumbnail).toMatchObject({
    status: "rendered",
    width: 16,
    height: 16,
  });
});
it("honors pre-cancellation before source and coverage reads", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await expect(
    renderRasterResource(Buffer.alloc(2), layout, policy, {
      coverage,
      signal: controller.signal,
    }),
  ).rejects.toThrow("stop");
});
it("prepares reusable exact coverage without admitting zero-filled holes", () => {
  const result = prepareRasterRenderCoverage(10, [
    { offset: 0, length: 3 },
    { offset: 3, length: 2 },
    { offset: 7, length: 3 },
  ]);
  expect(result.status).toBe("prepared");
  if (result.status === "prepared") {
    expect(result.coverage.covers(0, 5)).toBe(true);
    expect(result.coverage.covers(4, 4)).toBe(false);
  }
});

it("copies packed RAW without inventing a supported pixel layout", async () => {
  const result = await copyRasterResourceRaw(
    Buffer.from([1, 2, 3, 4]),
    { payloadRange: { offset: 1, length: 3 } },
    { coverage: [{ offset: 0, length: 4 }] },
  );
  expect(result.status).toBe("copied");
  if (result.status === "copied") expect([...result.raw]).toEqual([2, 3, 4]);
});

it("enforces exact narrowed output/pixel boundaries before allocating", async () => {
  const { rasterPngWorkingBytes } =
    await import("./RasterResourceRenderingPng.js");
  const bytes = Buffer.from([0, 0]),
    bound = rasterPngWorkingBytes(3, 2);
  expect(
    (
      await renderRasterResource(bytes, layout, policy, {
        coverage,
        maxPixels: 6,
        maxOutputBytes: bound,
      })
    ).status,
  ).toBe("rendered");
  expect(
    (
      await renderRasterResource(bytes, layout, policy, {
        coverage,
        maxPixels: 5,
      })
    ).status,
  ).toBe("limit-exceeded");
  expect(
    (
      await renderRasterResource(bytes, layout, policy, {
        coverage,
        maxOutputBytes: bound - 1,
      })
    ).status,
  ).toBe("limit-exceeded");
  expect(
    (
      await copyRasterResourceRaw(bytes, layout, {
        coverage,
        maxOutputBytes: 1,
      })
    ).status,
  ).toBe("limit-exceeded");
});
it("rejects inconsistent strides, arithmetic bounds and coverage ownership", async () => {
  const bytes = Buffer.alloc(2);
  for (const changed of [
    { width: 0 },
    { width: 4097 },
    { stride: 0 },
    { stride: 0.5 },
    { payloadRange: { offset: Number.MAX_SAFE_INTEGER, length: 2 } },
    { payloadRange: { offset: -1, length: 2 } },
  ])
    expect(
      (
        await renderRasterResource(bytes, { ...layout, ...changed }, policy, {
          coverage,
        })
      ).status,
    ).toBe("unrenderable");
  const p = prepareRasterRenderCoverage(3, [{ offset: 0, length: 3 }]);
  if (p.status !== "prepared") throw new Error(p.reason);
  expect(
    (await copyRasterResourceRaw(bytes, layout, { coverage: p.coverage }))
      .status,
  ).toBe("unrenderable");
  expect(
    prepareRasterRenderCoverage(2, [{ offset: 1, length: 2 }]).status,
  ).toBe("unrenderable");
});
it("observes cancellation delivered between full-render batches", async () => {
  const controller = new AbortController();
  const source = Buffer.alloc(512 * 128),
    full: RasterRenderLayout = {
      width: 512,
      height: 128,
      layout: "indexed8",
      bitsPerPixel: 8,
      stride: 512,
      payloadRange: { offset: 0, length: source.length },
      rowOrder: "top-down",
      bitOrder: "msb-first",
    };
  setImmediate(() =>
    setImmediate(() => controller.abort(new Error("cancel during batches"))),
  );
  await expect(
    renderRasterResource(
      source,
      full,
      { kind: "diagnostic-indices" },
      {
        coverage: [{ offset: 0, length: source.length }],
        signal: controller.signal,
      },
    ),
  ).rejects.toThrow("cancel during batches");
});
it("encodes multi-block stored DEFLATE within its declared bound", async () => {
  const source = Buffer.alloc(512 * 128),
    full: RasterRenderLayout = {
      width: 512,
      height: 128,
      layout: "indexed8",
      bitsPerPixel: 8,
      stride: 512,
      payloadRange: { offset: 0, length: source.length },
      rowOrder: "top-down",
      bitOrder: "msb-first",
    };
  const result = await renderRasterResource(
    source,
    full,
    { kind: "diagnostic-indices" },
    { coverage: [{ offset: 0, length: source.length }] },
  );
  expect(result.status).toBe("rendered");
  if (result.status !== "rendered") throw new Error(result.reason);
  expect(result.rgba).toHaveLength(512 * 128 * 4);
  expect(result.png.length).toBeGreaterThan(result.rgba.length);
});

it("shares exact allocation preflight with the exporter", async () => {
  const { preflightRasterResource } =
    await import("./RasterResourceRendering.js");
  expect(preflightRasterResource(layout, { maxPixels: 6 })).toMatchObject({
    status: "ready",
    width: 3,
    height: 2,
  });
  expect(preflightRasterResource(layout, { maxPixels: 5 }).status).toBe(
    "limit-exceeded",
  );
});

it("preserves the prepared-coverage class admission and cancellation contract", async () => {
  const { PreparedRasterRenderCoverage } =
    await import("./RasterResourceRendering.js");
  const result = PreparedRasterRenderCoverage.prepare(2, [
    { offset: 0, length: 2 },
  ]);
  expect(result).toMatchObject({ status: "prepared" });
  expect(
    PreparedRasterRenderCoverage.prepare(16 * 1024 * 1024 + 1, []),
  ).toMatchObject({ status: "limit-exceeded" });
  const controller = new AbortController();
  controller.abort(new Error("stop preparation"));
  expect(() =>
    PreparedRasterRenderCoverage.prepare(2, [], controller.signal),
  ).toThrow("stop preparation");
});
