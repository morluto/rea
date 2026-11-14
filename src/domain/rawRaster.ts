import { err, ok } from "./result.js";
import type { Result } from "./result.js";

export type RawRasterFormat =
  | "gray8"
  | "rgb888"
  | "bgr888"
  | "rgba8888"
  | "bgra8888"
  | "indexed4";
interface RawRasterExtent {
  readonly offset: number;
  readonly length: number;
  readonly width: number;
  readonly height: number;
  readonly stride: number;
  readonly rowOrder: "top-down" | "bottom-up";
}
export type RawRasterPaletteEntry = readonly [number, number, number, number];
export type RawRasterLayout = RawRasterExtent &
  (
    | { readonly format: Exclude<RawRasterFormat, "indexed4"> }
    | {
        readonly format: "indexed4";
        readonly bitOrder: "msb-first" | "lsb-first";
        readonly palette: readonly RawRasterPaletteEntry[];
      }
  );
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
    case "indexed4":
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

const parsePalette = (
  input: unknown,
): Result<readonly RawRasterPaletteEntry[], RawRasterFailure> => {
  if (!Array.isArray(input) || input.length !== 16)
    return invalid(
      "indexed4 requires an explicit palette of exactly 16 RGBA tuples.",
    );
  const palette: RawRasterPaletteEntry[] = [];
  for (const entry of input) {
    if (!Array.isArray(entry) || entry.length !== 4)
      return invalid(
        "Each palette entry must contain exactly four RGBA bytes.",
      );
    for (const component of entry)
      if (
        typeof component !== "number" ||
        !Number.isInteger(component) ||
        component < 0 ||
        component > 255
      )
        return invalid(
          "Palette RGBA components must be integers from 0 to 255.",
        );
    // Own a snapshot of every tuple; caller mutation cannot rewrite provenance.
    palette.push([
      entry[0] as number,
      entry[1] as number,
      entry[2] as number,
      entry[3] as number,
    ]);
  }
  return ok(palette);
};

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
  const extent = { offset, length, width, height, stride, rowOrder };
  let layout: RawRasterLayout;
  if (format === "indexed4") {
    if (value.bitOrder !== "msb-first" && value.bitOrder !== "lsb-first")
      return invalid(
        "indexed4 requires explicit bitOrder: msb-first or lsb-first.",
      );
    const palette = parsePalette(value.palette);
    if (!palette.ok) return palette;
    layout = {
      ...extent,
      rowOrder,
      format,
      bitOrder: value.bitOrder,
      palette: palette.value,
    };
  } else {
    if ("palette" in value || "bitOrder" in value)
      return invalid("palette and bitOrder apply only to indexed4.");
    layout = {
      ...extent,
      rowOrder,
      format: format as Exclude<RawRasterFormat, "indexed4">,
    };
  }
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
  const rowBytes =
    layout.format === "indexed4" ? Math.ceil(width / 2) : width * channelCount;
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
      if (layout.format === "indexed4") {
        const packed = source[offset + sourceRow * stride + Math.floor(x / 2)]!;
        const highNibble = (x % 2 === 0) === (layout.bitOrder === "msb-first");
        const index = highNibble ? packed >>> 4 : packed & 0x0f;
        rgba.set(layout.palette[index]!, (y * width + x) * 4);
        continue;
      }
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
