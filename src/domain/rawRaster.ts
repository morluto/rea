import { err, ok } from "./result.js";
import type { Result } from "./result.js";

export type RawRasterFormat =
  | "gray8"
  | "rgb888"
  | "bgr888"
  | "rgba8888"
  | "bgra8888";
export interface RawRasterLayout {
  readonly offset: number;
  readonly length: number;
  readonly width: number;
  readonly height: number;
  readonly stride: number;
  readonly format: RawRasterFormat;
  readonly rowOrder: "top-down" | "bottom-up";
}
/** Supplied by the operation owner; this core defines no runtime defaults. */
export interface RawRasterAllowance {
  readonly maxSourceBytes: number;
  readonly maxOutputBytes: number;
}
export interface RawRasterPixels {
  readonly rgba: Uint8Array;
  readonly layout: RawRasterLayout;
  readonly consumedSpan: number;
}
export interface RawRasterFailure {
  readonly kind: "malformed" | "capacity";
  readonly message: string;
}
const positiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const channels = (format: unknown): number | undefined => {
  switch (format) {
    case "gray8":
      return 1;
    case "rgb888":
    case "bgr888":
      return 3;
    case "rgba8888":
    case "bgra8888":
      return 4;
    default:
      return undefined;
  }
};

const invalid = (message: string): Result<never, RawRasterFailure> =>
  err({ kind: "malformed", message });

const parseLayout = (
  input: unknown,
): Result<
  { layout: RawRasterLayout; channelCount: number },
  RawRasterFailure
> => {
  if (input === null || typeof input !== "object")
    return invalid("An explicit raster layout is required.");
  const value = input as Record<string, unknown>;
  const { offset, length, width, height, stride, format, rowOrder } = value;
  if (
    typeof offset !== "number" ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !positiveInteger(length) ||
    !positiveInteger(width) ||
    !positiveInteger(height) ||
    !positiveInteger(stride)
  )
    return invalid(
      "Raster offsets and dimensions must be safe integers with positive sizes.",
    );
  const channelCount = channels(format);
  if (channelCount === undefined) return invalid("Unsupported raster format.");
  if (rowOrder !== "top-down" && rowOrder !== "bottom-up")
    return invalid("Explicit row direction is required.");
  const layout: RawRasterLayout = {
    offset,
    length,
    width,
    height,
    stride,
    format: format as RawRasterFormat,
    rowOrder,
  };
  return ok({ layout, channelCount });
};

/** Validate source and RGBA representation bounds without allocating either. */
export const admitRawRaster = (
  sourceLength: number,
  input: unknown,
  allowance: RawRasterAllowance,
): Result<
  {
    readonly layout: RawRasterLayout;
    readonly channelCount: number;
    readonly consumedSpan: number;
  },
  RawRasterFailure
> => {
  if (!Number.isSafeInteger(sourceLength) || sourceLength < 0)
    return invalid("Source byte length must be a nonnegative safe integer.");
  if (
    !positiveInteger(allowance.maxSourceBytes) ||
    !positiveInteger(allowance.maxOutputBytes)
  )
    return invalid("Raster allowances must be positive safe integers.");
  const parsed = parseLayout(input);
  if (!parsed.ok) return parsed;
  const { layout, channelCount } = parsed.value;
  const { offset, length, width, height, stride } = layout;
  if (offset > sourceLength || length > sourceLength - offset)
    return invalid("Selected range exceeds source bytes.");
  // Divide before multiplying so hostile dimensions cannot overflow admission.
  if (
    length > allowance.maxSourceBytes ||
    width > Math.floor(allowance.maxOutputBytes / 4 / height)
  )
    return err({
      kind: "capacity",
      message:
        "Selected input or RGBA output exceeds the caller's byte allowance.",
    });
  const rowBytes = width * channelCount;
  if (stride < rowBytes) return invalid("Stride is shorter than a pixel row.");
  const consumedSpan = (height - 1) * stride + rowBytes;
  if (!Number.isSafeInteger(consumedSpan) || consumedSpan > length)
    return invalid(
      "Selected range cannot contain the requested raster layout.",
    );
  return ok({ layout, channelCount, consumedSpan });
};

/** Experimental pure decoder. Selected ranges are relative to the supplied view.
 * RGBA8 has straight alpha; no premultiplication or colour-space inference.
 * The final row need not include padding. Source bytes are never modified.
 */
export const decodeRawRaster = (
  source: Uint8Array,
  input: unknown,
  allowance: RawRasterAllowance,
): Result<RawRasterPixels, RawRasterFailure> => {
  const admitted = admitRawRaster(source.byteLength, input, allowance);
  if (!admitted.ok) return admitted;
  const { layout, channelCount, consumedSpan } = admitted.value;
  const { offset, width, height, stride, format, rowOrder } = layout;
  const rgba = new Uint8Array(width * height * 4);
  const bgr = format === "bgr888" || format === "bgra8888";
  for (let y = 0; y < height; y++) {
    const sourceRow = rowOrder === "top-down" ? y : height - 1 - y;
    for (let x = 0; x < width; x++) {
      const s = offset + sourceRow * stride + x * channelCount;
      const d = (y * width + x) * 4;
      // Full source coverage was admitted above, including every component.
      rgba[d] = source[s + (bgr ? 2 : 0)]!;
      rgba[d + 1] = source[s + (channelCount === 1 ? 0 : 1)]!;
      rgba[d + 2] = source[s + (channelCount === 1 || bgr ? 0 : 2)]!;
      rgba[d + 3] = channelCount === 4 ? source[s + 3]! : 255;
    }
  }
  return ok({ rgba, layout, consumedSpan });
};
