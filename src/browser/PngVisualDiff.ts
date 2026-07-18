import { inflateSync } from "node:zlib";

import type {
  CompareWebScreenshotsInput,
  WebScreenshotArtifact,
  WebScreenshotDiff,
} from "../domain/webScreenshot.js";
import { decodeCanonicalBase64 } from "../domain/webScreenshot.js";

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly rgba: Buffer;
}

/** Compare two validated screenshots using bounded, deterministic RGBA metrics. */
export const comparePngScreenshots = (
  input: CompareWebScreenshotsInput,
): WebScreenshotDiff => {
  const before = decodePng(input.before, input.maximum_pixels);
  const after = decodePng(input.after, input.maximum_pixels);
  if (before.width !== after.width || before.height !== after.height)
    return {
      schema_version: 1,
      status: "dimension_mismatch",
      before: dimensions(before),
      after: dimensions(after),
      channel_threshold: input.channel_threshold,
      compared_pixels: 0,
      changed_pixels: null,
      changed_ratio: null,
      maximum_channel_delta: null,
      mean_absolute_channel_delta: null,
      limitations: limitations(),
    };
  let changedPixels = 0;
  let maximumDelta = 0;
  let totalDelta = 0;
  for (let offset = 0; offset < before.rgba.length; offset += 4) {
    let changed = false;
    for (let channel = 0; channel < 4; channel += 1) {
      const delta = Math.abs(
        (before.rgba[offset + channel] ?? 0) -
          (after.rgba[offset + channel] ?? 0),
      );
      totalDelta += delta;
      maximumDelta = Math.max(maximumDelta, delta);
      if (delta > input.channel_threshold) changed = true;
    }
    if (changed) changedPixels += 1;
  }
  const pixels = before.width * before.height;
  return {
    schema_version: 1,
    status: changedPixels === 0 ? "identical" : "different",
    before: dimensions(before),
    after: dimensions(after),
    channel_threshold: input.channel_threshold,
    compared_pixels: pixels,
    changed_pixels: changedPixels,
    changed_ratio: changedPixels / pixels,
    maximum_channel_delta: maximumDelta,
    mean_absolute_channel_delta: totalDelta / (pixels * 4),
    limitations: limitations(),
  };
};

const decodePng = (
  artifact: WebScreenshotArtifact,
  maximumPixels: number,
): DecodedPng => {
  const bytes = decodeCanonicalBase64(artifact.data_base64);
  if (bytes === undefined || !bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    throw new TypeError("Invalid PNG signature");
  let offset = 8;
  let header: ReturnType<typeof parseHeader> | undefined;
  const compressed: Buffer[] = [];
  let sawEnd = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new TypeError("Truncated PNG chunk");
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) throw new TypeError("Truncated PNG data");
    const data = bytes.subarray(dataStart, dataEnd);
    if (type === "IHDR") header = parseHeader(data, maximumPixels);
    else if (type === "IDAT") compressed.push(data);
    else if (type === "IEND") {
      sawEnd = true;
      break;
    }
    offset = dataEnd + 4;
  }
  if (header === undefined || !sawEnd || compressed.length === 0)
    throw new TypeError("Incomplete PNG");
  const rowBytes = header.width * header.channels;
  const expected = (rowBytes + 1) * header.height;
  const raw = inflateSync(Buffer.concat(compressed), {
    maxOutputLength: expected + 1,
  });
  if (raw.byteLength !== expected) throw new TypeError("Unexpected PNG size");
  return {
    width: header.width,
    height: header.height,
    rgba: unfilter(raw, header.width, header.height, header.channels),
  };
};

const parseHeader = (data: Buffer, maximumPixels: number) => {
  if (data.byteLength !== 13) throw new TypeError("Invalid PNG header");
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const bitDepth = data[8];
  const colorType = data[9];
  if (
    width === 0 ||
    height === 0 ||
    width * height > maximumPixels ||
    bitDepth !== 8 ||
    (colorType !== 2 && colorType !== 6) ||
    data[10] !== 0 ||
    data[11] !== 0 ||
    data[12] !== 0
  )
    throw new TypeError("Unsupported or oversized PNG");
  return { width, height, channels: colorType === 6 ? 4 : 3 };
};

const unfilter = (
  raw: Buffer,
  width: number,
  height: number,
  channels: number,
): Buffer => {
  const rowBytes = width * channels;
  const decoded = Buffer.alloc(rowBytes * height);
  for (let row = 0; row < height; row += 1) {
    const rawOffset = row * (rowBytes + 1);
    const outputOffset = row * rowBytes;
    const filter = raw[rawOffset];
    if (filter === undefined || filter > 4)
      throw new TypeError("Unsupported PNG filter");
    for (let column = 0; column < rowBytes; column += 1) {
      const source = raw[rawOffset + 1 + column] ?? 0;
      const left =
        column >= channels
          ? (decoded[outputOffset + column - channels] ?? 0)
          : 0;
      const above =
        row > 0 ? (decoded[outputOffset + column - rowBytes] ?? 0) : 0;
      const upperLeft =
        row > 0 && column >= channels
          ? (decoded[outputOffset + column - rowBytes - channels] ?? 0)
          : 0;
      decoded[outputOffset + column] = applyFilter({
        filter,
        source,
        left,
        above,
        upperLeft,
      });
    }
  }
  if (channels === 4) return decoded;
  const rgba = Buffer.alloc(width * height * 4);
  for (
    let source = 0, target = 0;
    source < decoded.length;
    source += 3, target += 4
  ) {
    rgba[target] = decoded[source] ?? 0;
    rgba[target + 1] = decoded[source + 1] ?? 0;
    rgba[target + 2] = decoded[source + 2] ?? 0;
    rgba[target + 3] = 255;
  }
  return rgba;
};

interface ApplyFilterOptions {
  readonly filter: number;
  readonly source: number;
  readonly left: number;
  readonly above: number;
  readonly upperLeft: number;
}

const applyFilter = (options: ApplyFilterOptions): number => {
  const { filter, source, left, above, upperLeft } = options;
  switch (filter) {
    case 0:
      return source;
    case 1:
      return (source + left) & 0xff;
    case 2:
      return (source + above) & 0xff;
    case 3:
      return (source + Math.floor((left + above) / 2)) & 0xff;
    case 4:
      return (source + paeth(left, above, upperLeft)) & 0xff;
    default:
      throw new TypeError("Unsupported PNG filter");
  }
};

const paeth = (left: number, above: number, upperLeft: number): number => {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance
    ? left
    : aboveDistance <= upperLeftDistance
      ? above
      : upperLeft;
};

const dimensions = ({ width, height }: DecodedPng) => ({ width, height });

const limitations = (): string[] => [
  "Pixel comparison does not perform OCR, semantic layout analysis, or perceptual color correction.",
  "Only non-interlaced 8-bit RGB and RGBA PNG screenshots are accepted.",
];

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
