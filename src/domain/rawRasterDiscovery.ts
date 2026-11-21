import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
/** Bounded, format-agnostic raw raster hypotheses. Scores are not probabilities. */
export interface RawRasterDiscoveryOptions {
  widths?: number[];
  heights?: number[];
  formats?: ("gray8" | "rgb888" | "rgba8888")[];
  offsetStep?: number;
  maxHypotheses?: number;
  maxCandidates?: number;
  minScore?: number;
}
export interface RawRasterCandidate {
  status: "hypothesis";
  layout: {
    offset: number;
    length: number;
    width: number;
    height: number;
    stride: number;
    rowOrder: "top-down";
    format: "gray8" | "rgb888" | "rgba8888";
  };
  score: number;
  metrics: {
    horizontalDifference: number;
    verticalDifference: number;
    distantDifference: number;
    valueSpread: number;
    samples: number;
  };
}
export interface RawRasterDiscoveryReport {
  candidates: RawRasterCandidate[];
  coverage: {
    tested: number;
    complete: boolean;
    retained: number;
    accepted: number;
    offsetStep: number;
    widths: number[];
    heights: number[];
    formats: string[];
    maxHypotheses: number;
    nextOffset: number | null;
    minScore: number;
  };
  limitations: string[];
}
const channels = { gray8: 1, rgb888: 3, rgba8888: 4 } as const;
function integer(
  value: number,
  name: string,
  min: number,
  max: number,
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new RangeError(`${name} must be an integer in ${min}..${max}`);
  return value;
}
/** Validates all budgets before inspecting bytes; no decoding or RGBA allocation.
 * At most 256 pixel locations per hypothesis, three channels each. The selected
 * range must already be admitted by the caller. Not a complete image detector.
 */
export function discoverRawRaster(
  bytes: Uint8Array,
  options: RawRasterDiscoveryOptions = {},
  signal?: AbortSignal,
): RawRasterDiscoveryReport {
  const {
    widths,
    heights,
    formats,
    layouts,
    offsetStep,
    maxHypotheses,
    maxCandidates,
    minScore,
  } = prepareSearch(bytes.length, options);
  const candidates: RawRasterCandidate[] = [];
  let tested = 0,
    accepted = 0,
    complete = true;
  let nextOffset: number | null = null;
  signal?.throwIfAborted();
  const lastOffset = bytes.length - (layouts[0]?.length ?? bytes.length + 1);
  scan: for (let offset = 0; offset <= lastOffset; offset += offsetStep) {
    signal?.throwIfAborted();
    for (const { width, height, format, length } of layouts) {
      // Sorted spans make non-fitting layouts one bounded check per offset.
      if (length > bytes.length - offset) break;
      if (tested === maxHypotheses) {
        complete = false;
        nextOffset = offset;
        break scan;
      }
      signal?.throwIfAborted();
      tested++;
      const candidate = measureLayout(bytes, offset, { width, height, format });
      if (!candidate || candidate.score < minScore) continue;
      accepted++;
      candidates.push(candidate);
      candidates.sort(
        (a, b) =>
          b.score - a.score ||
          a.layout.offset - b.layout.offset ||
          a.layout.width - b.layout.width ||
          a.layout.height - b.layout.height ||
          compareUnicodeCodePoints(a.layout.format, b.layout.format),
      );
      if (candidates.length > maxCandidates) candidates.pop();
    }
  }
  return {
    candidates,
    coverage: {
      tested,
      complete,
      retained: candidates.length,
      accepted,
      offsetStep,
      widths,
      heights,
      formats,
      maxHypotheses,
      nextOffset,
      minScore,
    },
    limitations: [
      "Heuristic raw raster hypotheses, not verified images or calibrated probabilities; structured non-image tables can pass.",
      "Only tightly packed gray8/RGB888/RGBA8888 hypotheses are tested; channel order, alpha semantics and vertical orientation are unknown.",
      "Dimensions are sampled windows, not discovered image boundaries. Overlapping candidates and alternative geometries are retained.",
      "The default offset grid adapts to the budget; only selected offsets and dimensions are tested. Compression, indexed palettes, sub-byte, RGB565, padding and tiled layouts are not detected. Empty output never proves absence.",
      "Sampling may miss detail or produce aliases. Smooth-image bias can reject icons, text, noise and high-detail images.",
      "nextOffset is the first partially/fully untested start, not a lossless resume cursor. Coverage complete means this configured grid only; a hypothesis budget may leave the tail untested. Scores are not comparable across unrelated inputs.",
    ],
  };
}

function measureLayout(
  bytes: Uint8Array,
  offset: number,
  {
    width,
    height,
    format,
  }: Pick<RawRasterCandidate["layout"], "width" | "height" | "format">,
): RawRasterCandidate | undefined {
  const channelCount = channels[format],
    stride = width * channelCount,
    length = stride * height;
  let horizontal = 0,
    vertical = 0,
    distant = 0,
    sum = 0,
    squares = 0,
    samples = 0;
  const count = Math.min((width - 1) * (height - 1), 256);
  // Evenly cover the entire candidate, avoiding row-edge pairs. Distant
  // comparisons provide an internal baseline, not a calibrated classifier.
  for (let i = 0; i < count; i++) {
    const position = Math.floor((i * (width - 1) * (height - 1)) / count);
    const y = Math.floor(position / (width - 1)),
      x = position % (width - 1);
    const distantX = (x + Math.floor(width / 2)) % width;
    const distantY = (y + Math.floor(height / 2)) % height;
    for (let c = 0; c < Math.min(channelCount, 3); c++) {
      const p = offset + y * stride + x * channelCount + c,
        v = bytes[p]!;
      horizontal += Math.abs(v - bytes[p + channelCount]!);
      vertical += Math.abs(v - bytes[p + stride]!);
      distant += Math.abs(
        v - bytes[offset + distantY * stride + distantX * channelCount + c]!,
      );
      sum += v;
      squares += v * v;
      samples++;
    }
  }
  horizontal /= samples;
  vertical /= samples;
  distant /= samples;
  const spread = Math.sqrt(
    Math.max(0, squares / samples - (sum / samples) ** 2),
  );
  const score = Math.max(
    0,
    1 - Math.max(horizontal, vertical) / Math.max(distant, 1),
  );
  if (spread < 12 || distant < 16) return undefined;
  return {
    status: "hypothesis",
    layout: {
      offset,
      length,
      width,
      height,
      stride,
      rowOrder: "top-down",
      format,
    },
    score,
    metrics: {
      horizontalDifference: horizontal,
      verticalDifference: vertical,
      distantDifference: distant,
      valueSpread: spread,
      samples,
    },
  };
}

function prepareSearch(byteLength: number, options: RawRasterDiscoveryOptions) {
  integer(byteLength, "selected bytes", 1, 16 * 1024 * 1024);
  const dimensions = (values: number[], name: string) => {
    integer(values.length, name + " count", 1, 32);
    return [...new Set(values.map((v) => integer(v, name, 8, 4096)))].sort(
      (a, b) => a - b,
    );
  };
  const minScore = options.minScore ?? 0.5;
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1)
    throw new RangeError("minScore must be finite in 0..1");
  const widths = dimensions(
    options.widths ?? [
      16, 24, 32, 48, 64, 96, 128, 160, 240, 256, 320, 480, 640,
    ],
    "width",
  );
  const heights = dimensions(options.heights ?? [16, 32, 64], "height");
  const formats = [
    ...new Set(options.formats ?? (["gray8", "rgb888", "rgba8888"] as const)),
  ];
  integer(formats.length, "format count", 1, 3);
  if (formats.some((f) => !Object.hasOwn(channels, f)))
    throw new RangeError("Unsupported discovery format");
  const maxHypotheses = integer(
    options.maxHypotheses ?? 20000,
    "maxHypotheses",
    1,
    100000,
  );
  const maxCandidates = integer(
    options.maxCandidates ?? 20,
    "maxCandidates",
    1,
    100,
  );
  const layouts = widths
    .flatMap((width) =>
      heights.flatMap((height) =>
        formats.map((format) => ({
          width,
          height,
          format,
          channelCount: channels[format],
          stride: width * channels[format],
          length: width * height * channels[format],
        })),
      ),
    )
    .filter((layout) => layout.length <= byteLength)
    .sort((a, b) => a.length - b.length);
  const offsetStep = integer(
    options.offsetStep ??
      Math.min(
        byteLength,
        Math.max(
          16,
          Math.ceil((byteLength * layouts.length) / maxHypotheses / 16) * 16,
        ),
      ),
    "offsetStep",
    1,
    16 * 1024 * 1024,
  );
  return {
    widths,
    heights,
    formats,
    layouts,
    offsetStep,
    maxHypotheses,
    maxCandidates,
    minScore,
  };
}
