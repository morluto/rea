import { expect, it } from "vitest";
import { crc32, inflateSync } from "node:zlib";
import { renderIndexThumbnail } from "./IndexRasterThumbnail.js";
function decode(base64: string) {
  const png = Buffer.from(base64, "base64");
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  let p = 8;
  const chunks: { type: string; data: Buffer }[] = [];
  while (p < png.length) {
    const n = png.readUInt32BE(p);
    expect(n).toBeLessThanOrEqual(png.length - p - 12);
    expect(crc32(png.subarray(p + 4, p + 8 + n))).toBe(
      png.readUInt32BE(p + 8 + n),
    );
    chunks.push({
      type: png.toString("ascii", p + 4, p + 8),
      data: png.subarray(p + 8, p + 8 + n),
    });
    p += n + 12;
  }
  expect(chunks.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
  expect([...chunks[0]!.data.subarray(8)]).toEqual([8, 0, 0, 0, 0]);
  return {
    width: chunks[0]!.data.readUInt32BE(0),
    height: chunks[0]!.data.readUInt32BE(4),
    pixels: inflateSync(chunks[1]!.data),
  };
}
it.each([
  [1, [0b10100000], 3, [255, 0, 255]],
  [2, [0b00011011], 4, [0, 85, 170, 255]],
  [4, [0x0f, 0x80], 3, [0, 255, 136]],
  [8, [0, 127, 255], 3, [0, 127, 255]],
] as const)(
  "renders %s-bit indices without inventing a palette",
  (bits, payload, width, expected) => {
    const result = renderIndexThumbnail(Uint8Array.from(payload), {
      width,
      height: 1,
      payloadOffset: 0,
      bitsPerPixel: bits,
    });
    const png = decode(result.pngBase64);
    expect([...png.pixels]).toEqual([0, ...expected]);
    expect(result.kind).toBe("index-only");
    expect(result.assumptions.join(" ")).toMatch(/not original colors/);
  },
);
it("honors row padding and nonzero source offset", () => {
  const r = renderIndexThumbnail(Uint8Array.from([99, 0x80, 0x40]), {
    width: 2,
    height: 2,
    payloadOffset: 1,
    bitsPerPixel: 1,
  });
  expect([...decode(r.pngBase64).pixels]).toEqual([0, 255, 0, 0, 0, 255]);
});
it("samples a bounded thumbnail, never allocates a full-size output", () => {
  const source = new Uint8Array((4096 * 4096) / 8);
  const r = renderIndexThumbnail(
    source,
    { width: 4096, height: 4096, payloadOffset: 0, bitsPerPixel: 1 },
    32,
  );
  expect(decode(r.pngBase64).width).toBe(32);
  expect(decode(r.pngBase64).height).toBe(32);
});
it("rejects malformed layouts, short payload and excessive thumbnail size", () => {
  for (const layout of [
    { width: 0, height: 1, payloadOffset: 0, bitsPerPixel: 1 },
    { width: 1, height: 1, payloadOffset: 2, bitsPerPixel: 1 },
    { width: 1, height: 1, payloadOffset: 0, bitsPerPixel: 3 },
  ])
    expect(() => renderIndexThumbnail(new Uint8Array(1), layout)).toThrow();
  expect(() =>
    renderIndexThumbnail(
      new Uint8Array(1),
      { width: 1, height: 1, payloadOffset: 0, bitsPerPixel: 1 },
      129,
    ),
  ).toThrow();
});
