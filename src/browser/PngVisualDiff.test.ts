import { crc32, deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { comparePngScreenshots } from "./PngVisualDiff.js";
import {
  compareWebScreenshotsInputSchema,
  createWebScreenshotArtifact,
  webScreenshotDiffSchema,
} from "../domain/webScreenshot.js";

describe("PNG visual diff", () => {
  it("reports exact changed-pixel and channel metrics", () => {
    const before = artifact(1, 1, [0, 0, 0, 255]);
    const after = artifact(1, 1, [10, 0, 0, 255]);
    const result = comparePngScreenshots(
      compareWebScreenshotsInputSchema.parse({ before, after }),
    );

    expect(result).toMatchObject({
      status: "different",
      compared_pixels: 1,
      changed_pixels: 1,
      changed_ratio: 1,
      maximum_channel_delta: 10,
      mean_absolute_channel_delta: 2.5,
    });
  });

  it("applies a channel threshold and reports dimension mismatch", () => {
    const one = artifact(1, 1, [0, 0, 0, 255]);
    const near = artifact(1, 1, [2, 0, 0, 255]);
    expect(
      comparePngScreenshots(
        compareWebScreenshotsInputSchema.parse({
          before: one,
          after: near,
          channel_threshold: 2,
        }),
      ).status,
    ).toBe("identical");
    expect(
      comparePngScreenshots(
        compareWebScreenshotsInputSchema.parse({
          before: one,
          after: artifact(2, 1, [0, 0, 0, 255, 0, 0, 0, 255]),
        }),
      ),
    ).toMatchObject({ status: "dimension_mismatch", compared_pixels: 0 });
  });

  it("preserves RGB transparent-color samples when comparing RGBA pixels", () => {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(2, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 2;
    const transparent = Buffer.alloc(6);
    transparent.writeUInt16BE(10, 0);
    transparent.writeUInt16BE(20, 2);
    transparent.writeUInt16BE(30, 4);
    const rgb = createWebScreenshotArtifact(
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk("IHDR", header),
        chunk("tRNS", transparent),
        chunk("IDAT", deflateSync(Buffer.from([0, 10, 20, 30, 10, 20, 31]))),
        chunk("IEND", Buffer.alloc(0)),
      ]),
    );
    const rgba = artifact(2, 1, [10, 20, 30, 0, 10, 20, 31, 255]);
    expect(
      comparePngScreenshots(
        compareWebScreenshotsInputSchema.parse({ before: rgb, after: rgba }),
      ),
    ).toMatchObject({
      status: "identical",
      changed_pixels: 0,
      maximum_channel_delta: 0,
    });
  });

  it("keeps 8-bit samples opaque when a 16-bit transparency key exceeds 255", () => {
    const key = Buffer.alloc(6);
    key.writeUInt16BE(266, 0);
    key.writeUInt16BE(20, 2);
    key.writeUInt16BE(30, 4);
    const rgb = transparencyArtifact(2, key, [10, 20, 30]);
    const result = comparePngScreenshots(
      compareWebScreenshotsInputSchema.parse({
        before: rgb,
        after: artifact(1, 1, [10, 20, 30, 255]),
      }),
    );
    expect(result).toMatchObject({ status: "identical", changed_pixels: 0 });
    expect(result.limitations).toContain(
      "PNG tRNS transparency is accepted only as a six-byte RGB color key; tRNS on RGBA or with another length is rejected.",
    );
  });

  it.each([0, 5, 7])("rejects an RGB tRNS chunk of length %i", (length) => {
    const image = transparencyArtifact(2, Buffer.alloc(length), [10, 20, 30]);
    expect(() =>
      comparePngScreenshots(
        compareWebScreenshotsInputSchema.parse({ before: image, after: image }),
      ),
    ).toThrow("Unsupported PNG transparency");
  });

  it("rejects tRNS on an RGBA image instead of dropping its transparency data", () => {
    const image = transparencyArtifact(6, Buffer.alloc(6), [10, 20, 30, 255]);
    expect(() =>
      comparePngScreenshots(
        compareWebScreenshotsInputSchema.parse({ before: image, after: image }),
      ),
    ).toThrow("Unsupported PNG transparency");
  });

  it("rejects malformed PNG dimensions after validating image data", () => {
    const image = artifact(32_000_001, 1, [0, 0, 0, 255]);
    expect(() =>
      comparePngScreenshots(
        compareWebScreenshotsInputSchema.parse({
          before: image,
          after: image,
        }),
      ),
    ).toThrow("Unexpected PNG size");
  });

  it("rejects metrics that cannot represent their comparison status", () => {
    const image = artifact(1, 1, [0, 0, 0, 255]);
    const result = comparePngScreenshots(
      compareWebScreenshotsInputSchema.parse({ before: image, after: image }),
    );

    expect(
      webScreenshotDiffSchema.safeParse({
        ...result,
        status: "dimension_mismatch",
      }).success,
    ).toBe(false);
    expect(
      webScreenshotDiffSchema.safeParse({
        ...result,
        compared_pixels: 2,
      }).success,
    ).toBe(false);
  });
});

describe("PNG chunk integrity", () => {
  it.each(["IHDR", "IDAT", "IEND"])(
    "rejects a corrupt %s chunk checksum",
    (type) => {
      const bytes = png(1, 1, [0, 0, 0, 255]);
      let offset = 8;
      while (offset < bytes.length) {
        const length = bytes.readUInt32BE(offset);
        if (bytes.subarray(offset + 4, offset + 8).toString("ascii") === type) {
          bytes[offset + 8 + length] = (bytes[offset + 8 + length] ?? 0) ^ 1;
          break;
        }
        offset += length + 12;
      }
      const image = createWebScreenshotArtifact(bytes);
      expect(() =>
        comparePngScreenshots(
          compareWebScreenshotsInputSchema.parse({
            before: image,
            after: image,
          }),
        ),
      ).toThrow("Invalid PNG chunk checksum");
    },
  );

  it("rejects duplicate image headers and unknown critical chunks while preserving ancillary chunks", () => {
    const bytes = png(1, 1, [0, 0, 0, 255]);
    const duplicate = Buffer.concat([
      bytes.subarray(0, 33),
      bytes.subarray(8, 33),
      bytes.subarray(33),
    ]);
    const unknown = Buffer.concat([
      bytes.subarray(0, 33),
      chunk("ABCD", Buffer.alloc(0)),
      bytes.subarray(33),
    ]);
    for (const malformed of [duplicate, unknown]) {
      const image = createWebScreenshotArtifact(malformed);
      expect(() =>
        comparePngScreenshots(
          compareWebScreenshotsInputSchema.parse({
            before: image,
            after: image,
          }),
        ),
      ).toThrow(/Invalid PNG header order|Unsupported critical PNG chunk/u);
    }
    const ancillary = createWebScreenshotArtifact(
      Buffer.concat([
        bytes.subarray(0, 33),
        chunk("tEXt", Buffer.from("Comment\0original capture")),
        bytes.subarray(33),
      ]),
    );
    expect(
      comparePngScreenshots(
        compareWebScreenshotsInputSchema.parse({
          before: ancillary,
          after: createWebScreenshotArtifact(bytes),
        }),
      ).status,
    ).toBe("identical");
  });
});

describe("PNG chunk ordering", () => {
  it("rejects malformed palettes, interrupted data and misplaced transparency while retaining valid chunks", () => {
    const header = Buffer.from(png(1, 1, [10, 20, 30, 255]).subarray(16, 29));
    header[9] = 2;
    const ihdr = chunk("IHDR", header);
    const compressed = deflateSync(Buffer.from([0, 10, 20, 30]));
    const idat = chunk("IDAT", compressed);
    const iend = chunk("IEND", Buffer.alloc(0));
    const palette = chunk("PLTE", Buffer.from([10, 20, 30]));
    const transparency = chunk("tRNS", Buffer.from([0, 10, 0, 20, 0, 30]));
    const ancillary = chunk("tEXt", Buffer.from("Comment\0retained"));
    const image = (...chunks: readonly Buffer[]) =>
      createWebScreenshotArtifact(
        Buffer.concat([
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
          ...chunks,
        ]),
      );
    const original = image(ihdr, idat, iend);
    const cases = [
      [ihdr, chunk("PLTE", Buffer.alloc(1)), idat, iend],
      [ihdr, palette, palette, idat, iend],
      [ihdr, idat, palette, iend],
      [ihdr, transparency, palette, idat, iend],
      [ihdr, transparency, transparency, idat, iend],
      [ihdr, idat, transparency, iend],
      [
        ihdr,
        chunk("IDAT", compressed.subarray(0, 6)),
        ancillary,
        chunk("IDAT", compressed.subarray(6)),
        iend,
      ],
      [ihdr, idat, chunk("IEND", Buffer.from([1]))],
    ];
    for (const chunks of cases) {
      const malformed = image(...chunks);
      expect(() =>
        comparePngScreenshots(
          compareWebScreenshotsInputSchema.parse({
            before: malformed,
            after: original,
          }),
        ),
      ).toThrow(
        /Invalid PNG palette|Invalid PNG transparency order|Nonconsecutive PNG image data|Invalid PNG end chunk/u,
      );
    }
    for (const valid of [
      image(ihdr, palette, idat, iend),
      image(ihdr, ancillary, idat, iend),
      image(
        ihdr,
        chunk("IDAT", compressed.subarray(0, 6)),
        chunk("IDAT", compressed.subarray(6)),
        iend,
      ),
    ]) {
      expect(
        comparePngScreenshots(
          compareWebScreenshotsInputSchema.parse({
            before: valid,
            after: original,
          }),
        ).status,
      ).toBe("identical");
    }
  });
});

const artifact = (width: number, height: number, pixels: readonly number[]) =>
  createWebScreenshotArtifact(png(width, height, pixels));

const png = (
  width: number,
  height: number,
  pixels: readonly number[],
): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows: number[] = [];
  for (let row = 0; row < height; row += 1)
    rows.push(0, ...pixels.slice(row * width * 4, (row + 1) * width * 4));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

const chunk = (type: string, data: Buffer): Buffer => {
  const result = Buffer.alloc(12 + data.byteLength);
  result.writeUInt32BE(data.byteLength, 0);
  result.write(type, 4, 4, "ascii");
  data.copy(result, 8);
  result.writeUInt32BE(
    crc32(result.subarray(4, 8 + data.byteLength)),
    8 + data.byteLength,
  );
  return result;
};

const transparencyArtifact = (
  colorType: number,
  transparency: Buffer,
  pixels: readonly number[],
) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = colorType;
  return createWebScreenshotArtifact(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("tRNS", transparency),
      chunk("IDAT", deflateSync(Buffer.from([0, ...pixels]))),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
};
