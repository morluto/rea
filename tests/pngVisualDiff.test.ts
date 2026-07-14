import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { comparePngScreenshots } from "../src/browser/PngVisualDiff.js";
import {
  compareWebScreenshotsInputSchema,
  createWebScreenshotArtifact,
} from "../src/domain/webScreenshot.js";

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

  it("rejects images above the caller's decoded pixel limit", () => {
    const image = artifact(2, 1, [0, 0, 0, 255, 0, 0, 0, 255]);
    expect(() =>
      comparePngScreenshots(
        compareWebScreenshotsInputSchema.parse({
          before: image,
          after: image,
          maximum_pixels: 1,
        }),
      ),
    ).toThrow("oversized PNG");
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
  return result;
};
