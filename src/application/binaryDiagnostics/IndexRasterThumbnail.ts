import {
  rasterThumbnailDimensions,
  rasterSampleCoordinate,
  packedRasterIndex,
  diagnosticRasterGray,
} from "../../domain/rasterSampling.js";
import { deflateSync } from "node:zlib";
import { packRasterPng } from "./RasterPngContainer.js";

export interface IndexThumbnailLayout {
  width: number;
  height: number;
  payloadOffset: number;
  bitsPerPixel: number;
}
export interface IndexThumbnail {
  kind: "index-only";
  width: number;
  height: number;
  pngBase64: string;
  assumptions: string[];
}
const boundedInteger = (
  value: number,
  min: number,
  max: number,
  label: string,
) => {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${label} must be an integer in ${min}..${max}`);
  return value;
};
/** Bounded nearest-neighbour diagnostic view of packed indices, not a color
 * decoder. The caller owns segment coverage; this helper also bounds every byte
 * access and allocates only the thumbnail, never a full source-size pixel array.
 */
export function renderIndexThumbnail(
  bytes: Uint8Array,
  layout: IndexThumbnailLayout,
  maxSide = 96,
): IndexThumbnail {
  const width = boundedInteger(layout.width, 1, 4096, "width");
  const height = boundedInteger(layout.height, 1, 4096, "height");
  const offset = boundedInteger(
    layout.payloadOffset,
    0,
    bytes.length,
    "payloadOffset",
  );
  const side = boundedInteger(maxSide, 1, 128, "maxSide");
  const bits = layout.bitsPerPixel;
  if (![1, 2, 4, 8].includes(bits))
    throw new RangeError("Only packed 1/2/4/8-bit indices can be previewed");
  const stride = Math.ceil((width * bits) / 8);
  if (stride * height > bytes.length - offset)
    throw new RangeError(
      "Index payload is not fully covered by the supplied bytes",
    );
  const { width: outputWidth, height: outputHeight } =
    rasterThumbnailDimensions(width, height, side);
  const rows = Buffer.alloc((outputWidth + 1) * outputHeight);
  for (let y = 0; y < outputHeight; y++)
    for (let x = 0; x < outputWidth; x++) {
      const sourceY = rasterSampleCoordinate(y, height, outputHeight);
      const sourceX = rasterSampleCoordinate(x, width, outputWidth);
      const packed =
        bytes[offset + sourceY * stride + Math.floor((sourceX * bits) / 8)]!;
      const index = packedRasterIndex(packed, sourceX, bits, "msb-first");
      rows[y * (outputWidth + 1) + x + 1] = diagnosticRasterGray(index, bits);
    }
  const png = packRasterPng(outputWidth, outputHeight, 0, deflateSync(rows));
  return {
    kind: "index-only",
    width: outputWidth,
    height: outputHeight,
    pngBase64: png.toString("base64"),
    assumptions: [
      "Grayscale displays numeric indices, not original colors. No palette, LUT, transparency or alpha semantics were inferred.",
      "Preview assumes tightly packed rows, MSB-first bit order and top-down orientation; alternative interpretations remain possible.",
      "Nearest-neighbour thumbnail may omit fine details; source dimensions are retained in the resource hypothesis.",
    ],
  };
}
