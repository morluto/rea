import {
  rasterThumbnailDimensions,
  rasterSampleCoordinate,
  packedRasterIndex,
  diagnosticRasterGray,
} from "../../domain/rasterSampling.js";
import { RasterCoverageIndex } from "../../domain/rasterCoverage.js";
import { setImmediate } from "node:timers/promises";
import type { z } from "zod";
import { BinaryReader } from "../../domain/binaryContainer.js";
import { MAX_RASTER_LOGICAL_SEGMENTS } from "../../domain/rasterLogicalSegments.js";
import { rasterColorPolicyInputSchema } from "../../domain/native/rasterRendering.js";
import {
  encodeRasterRgbaPng,
  rasterPngWorkingBytes,
} from "./RasterResourceRenderingPng.js";
export interface RasterRenderRange {
  offset: number;
  length: number;
}
export interface RasterRenderLayout {
  width: number;
  height: number;
  layout: "indexed1" | "indexed2" | "indexed4" | "indexed8" | "rgb565le";
  bitsPerPixel: 1 | 2 | 4 | 8 | 16;
  stride: number;
  payloadRange: RasterRenderRange;
  lookupRange?: RasterRenderRange | null;
  rowOrder: "top-down" | "bottom-up";
  bitOrder: "msb-first" | "lsb-first";
  format?: number;
  provenance?: string;
}
type InputPolicy = z.infer<typeof rasterColorPolicyInputSchema>;
export type RasterColorPolicy =
  | Exclude<InputPolicy, { kind: "record12-lut-registry" }>
  | {
      kind: "record12-lut-registry";
      themeSlot: number;
      /** Null for direct RGB565; indexed family colors require an admitted range. */
      paletteRange: RasterRenderRange | null;
      precision: "byte8" | "expand-high6";
      alpha: "palette" | "opaque";
      sentinel: "profile" | "disabled";
      rgb565ColorKey: number | null;
    };
export type RasterRenderFailure =
  | { status: "unrenderable"; reason: string }
  | {
      status: "limit-exceeded";
      reason: string;
      limit: {
        name: string;
        maximum: number;
        unit: "pixels" | "bytes" | "entries";
      };
    };
export interface RasterRenderOptions {
  coverage: readonly RasterRenderRange[] | PreparedRasterRenderCoverage;
  signal?: AbortSignal;
  maxPixels?: number;
  maxOutputBytes?: number;
}
export interface RasterRendered {
  status: "rendered";
  width: number;
  height: number;
  rgba: Uint8Array;
  png: Buffer;
  interpretation: { kind: RasterColorPolicy["kind"]; assumptions: string[] };
}
export const RASTER_RENDER_MAX_SOURCE_BYTES = 16 * 1024 * 1024;
export const RASTER_RENDER_MAX_PIXELS = 4 * 1024 * 1024;
export const RASTER_RENDER_MAX_WORKING_BYTES = 64 * 1024 * 1024;
const SOURCE_LIMIT = RASTER_RENDER_MAX_SOURCE_BYTES,
  PIXEL_LIMIT = RASTER_RENDER_MAX_PIXELS,
  WORKING_LIMIT = RASTER_RENDER_MAX_WORKING_BYTES;
const integer = (n: number, min: number, max: number) =>
  Number.isSafeInteger(n) && n >= min && n <= max;
const unavailable = (reason: string): RasterRenderFailure => ({
  status: "unrenderable",
  reason,
});
const limited = (
  name: string,
  maximum: number,
  unit: "pixels" | "bytes" | "entries",
): RasterRenderFailure => ({
  status: "limit-exceeded",
  reason: `${name} exceeds its fixed ${maximum} ${unit} allowance.`,
  limit: { name, maximum, unit },
});
/** Renderer facade preserves its admission/cancellation contract; the domain
 * index owns normalization and lookup, not presentation-specific failures.
 */
export class PreparedRasterRenderCoverage {
  private constructor(private readonly index: RasterCoverageIndex) {}
  get bytesLength(): number {
    return this.index.bytesLength;
  }
  covers(offset: number, length: number): boolean {
    return this.index.covers(offset, length);
  }
  static prepare(
    bytesLength: number,
    ranges: readonly RasterRenderRange[],
    signal?: AbortSignal,
  ):
    | { status: "prepared"; coverage: PreparedRasterRenderCoverage }
    | RasterRenderFailure {
    signal?.throwIfAborted();
    if (!integer(bytesLength, 0, SOURCE_LIMIT))
      return limited("Raster logical source", SOURCE_LIMIT, "bytes");
    if (ranges.length > MAX_RASTER_LOGICAL_SEGMENTS)
      return limited(
        "Raster coverage ranges",
        MAX_RASTER_LOGICAL_SEGMENTS,
        "entries",
      );
    const prepared = RasterCoverageIndex.prepare(bytesLength, ranges);
    return prepared.ok
      ? {
          status: "prepared",
          coverage: new PreparedRasterRenderCoverage(prepared.value),
        }
      : unavailable("Coverage lies outside the logical source.");
  }
}
export const prepareRasterRenderCoverage = PreparedRasterRenderCoverage.prepare;
function prepare(
  bytes: Uint8Array,
  layout: Pick<RasterRenderLayout, "payloadRange">,
  options: RasterRenderOptions,
):
  | {
      status: "prepared";
      reader: BinaryReader;
      coverage: PreparedRasterRenderCoverage;
    }
  | RasterRenderFailure {
  options.signal?.throwIfAborted();
  if (bytes.length > SOURCE_LIMIT)
    return limited("Raster logical source", SOURCE_LIMIT, "bytes");
  const c =
    options.coverage instanceof PreparedRasterRenderCoverage
      ? { status: "prepared" as const, coverage: options.coverage }
      : prepareRasterRenderCoverage(
          bytes.length,
          options.coverage,
          options.signal,
        );
  if (c.status !== "prepared") return c;
  if (
    c.coverage.bytesLength !== bytes.length ||
    !c.coverage.covers(layout.payloadRange.offset, layout.payloadRange.length)
  )
    return unavailable(
      "Raster payload is not fully covered by source bytes; holes are not pixels.",
    );
  return {
    status: "prepared",
    coverage: c.coverage,
    reader: new BinaryReader(
      Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      true,
      "raster-resource",
    ),
  };
}
function validatePolicy(policy: RasterColorPolicy): boolean {
  if (policy.kind !== "record12-lut-registry")
    return rasterColorPolicyInputSchema.safeParse(policy).success;
  return rasterColorPolicyInputSchema.safeParse({
    kind: policy.kind,
    theme_slot: policy.themeSlot,
    precision: policy.precision,
    alpha: policy.alpha,
    sentinel: policy.sentinel,
    rgb565_color_key: policy.rgb565ColorKey,
  }).success;
}
type Color = [number, number, number, number];
function colors(
  reader: BinaryReader,
  coverage: PreparedRasterRenderCoverage,
  layout: RasterRenderLayout,
  policy: RasterColorPolicy,
): { status: "colors"; entries: Color[] } | RasterRenderFailure {
  const count = 1 << layout.bitsPerPixel;
  if (policy.kind === "diagnostic-indices")
    return {
      status: "colors",
      entries: Array.from({ length: count }, (_, i) => {
        const v = diagnosticRasterGray(i, layout.bitsPerPixel);
        return [v, v, v, 255];
      }),
    };
  const usesLut =
    policy.kind === "record12-lut-registry" ||
    policy.index_space === "lookup-low-byte";
  const profileSentinel = policy.sentinel === "profile";
  if (
    (usesLut || profileSentinel) &&
    ![1, 2, 3, 4].includes(layout.format ?? -1)
  )
    return unavailable(
      "LUT or profile sentinel interpretation requires a supported declared family format.",
    );
  const familyBits = ({ 1: 1, 2: 2, 3: 4, 4: 8 } as Record<number, number>)[
    layout.format ?? -1
  ];
  if ((usesLut || profileSentinel) && familyBits !== layout.bitsPerPixel)
    return unavailable("Declared family format and packed layout disagree.");
  const lookup = layout.lookupRange;
  const needLookup = (usesLut || profileSentinel) && layout.format !== 4;
  if (
    needLookup &&
    (!lookup ||
      lookup.length !== count * 2 ||
      !coverage.covers(lookup.offset, lookup.length))
  )
    return unavailable(
      "LUT entries are not fully covered or have the wrong length.",
    );
  if (
    policy.kind === "record12-lut-registry" &&
    (!policy.paletteRange ||
      policy.paletteRange.length !== 1024 ||
      !coverage.covers(policy.paletteRange.offset, 1024))
  )
    return unavailable("Selected ARGB palette is not fully covered.");
  const entries: Color[] = [];
  for (let selector = 0; selector < count; selector++) {
    const lutValue = needLookup
      ? reader.u16(lookup!.offset + selector * 2)
      : selector;
    if (needLookup && lutValue > 255 && lutValue !== 0x8000)
      return unavailable(
        "Unknown LUT high-bit flags; no color interpretation was guessed.",
      );
    const sentinel =
      profileSentinel &&
      ((layout.format === 1 && selector === 0 && lutValue === 0x8000) ||
        ((layout.format === 2 || layout.format === 3) && lutValue === 0x8000) ||
        (layout.format === 4 && selector === 255));
    if (sentinel) {
      entries.push([0, 0, 0, 0]);
      continue;
    }
    const index = usesLut ? lutValue & 255 : selector;
    if (policy.kind === "rgba-palette") {
      const color = policy.entries[index];
      if (!color)
        return unavailable(
          "Caller palette does not cover every possible packed selector/LUT entry.",
        );
      entries.push([color[0], color[1], color[2], color[3]]);
    } else {
      const at = policy.paletteRange!.offset + index * 4;
      const expand = (v: number) =>
        policy.precision === "expand-high6" ? (v & 252) | (v >>> 6) : v;
      entries.push([
        expand(reader.u8(at + 1)),
        expand(reader.u8(at + 2)),
        expand(reader.u8(at + 3)),
        policy.alpha === "opaque" ? 255 : expand(reader.u8(at)),
      ]);
    }
  }
  return { status: "colors", entries };
}
export async function copyRasterResourceRaw(
  bytes: Uint8Array,
  layout: Pick<RasterRenderLayout, "payloadRange">,
  options: RasterRenderOptions,
): Promise<{ status: "copied"; raw: Buffer } | RasterRenderFailure> {
  const p = prepare(bytes, layout, options);
  if (p.status !== "prepared") return p;
  const limit = options.maxOutputBytes ?? SOURCE_LIMIT;
  if (!integer(limit, 1, WORKING_LIMIT))
    return unavailable("Invalid raster output allowance.");
  if (layout.payloadRange.length > limit)
    return limited("Packed RAW output", limit, "bytes");
  await setImmediate();
  options.signal?.throwIfAborted();
  return {
    status: "copied",
    raw: Buffer.from(
      p.reader.range(
        layout.payloadRange.offset,
        layout.payloadRange.length,
        "packed payload",
      ),
    ),
  };
}
/** Shared allocation admission. Coverage/color eligibility remains a separate check. */
export function preflightRasterResource(
  layout: RasterRenderLayout,
  options: Pick<RasterRenderOptions, "maxPixels" | "maxOutputBytes"> & {
    maxSide?: number;
  } = {},
):
  | { status: "ready"; width: number; height: number; workingBytes: number }
  | RasterRenderFailure {
  const maxSide = options.maxSide;
  const expected = {
    indexed1: 1,
    indexed2: 2,
    indexed4: 4,
    indexed8: 8,
    rgb565le: 16,
  }[layout.layout];
  if (
    expected === undefined ||
    expected !== layout.bitsPerPixel ||
    !integer(layout.width, 1, 4096) ||
    !integer(layout.height, 1, 4096) ||
    !integer(
      layout.stride,
      Math.ceil((layout.width * layout.bitsPerPixel) / 8),
      SOURCE_LIMIT,
    ) ||
    layout.payloadRange.length !== layout.stride * layout.height ||
    !["top-down", "bottom-up"].includes(layout.rowOrder) ||
    !["msb-first", "lsb-first"].includes(layout.bitOrder)
  )
    return unavailable("Invalid or unsupported raster layout.");
  if (maxSide !== undefined && !integer(maxSide, 1, 128))
    return unavailable("Thumbnail side must be in 1..128.");
  const { width, height } = rasterThumbnailDimensions(
    layout.width,
    layout.height,
    maxSide,
  );
  const pixelLimit = options.maxPixels ?? PIXEL_LIMIT,
    outputLimit = options.maxOutputBytes ?? WORKING_LIMIT;
  if (
    !integer(pixelLimit, 1, PIXEL_LIMIT) ||
    !integer(outputLimit, 1, WORKING_LIMIT)
  )
    return unavailable("Invalid raster output allowance.");
  if (width * height > pixelLimit)
    return limited("Decoded raster output pixels", pixelLimit, "pixels");
  if (rasterPngWorkingBytes(width, height) > outputLimit)
    return limited("Raster PNG working buffers", outputLimit, "bytes");
  return {
    status: "ready",
    width,
    height,
    workingBytes: rasterPngWorkingBytes(width, height),
  };
}
async function render(
  bytes: Uint8Array,
  layout: RasterRenderLayout,
  policy: RasterColorPolicy,
  options: RasterRenderOptions,
  maxSide?: number,
): Promise<RasterRendered | RasterRenderFailure> {
  options.signal?.throwIfAborted();
  const admitted = preflightRasterResource(layout, {
    ...options,
    ...(maxSide === undefined ? {} : { maxSide }),
  });
  if (admitted.status !== "ready") return admitted;
  const { width, height } = admitted;
  const p = prepare(bytes, layout, options);
  if (p.status !== "prepared") return p;
  if (!validatePolicy(policy))
    return unavailable("Invalid explicit color policy.");
  if (
    layout.layout === "rgb565le" &&
    (policy.kind !== "record12-lut-registry" || layout.format !== 6)
  )
    return unavailable(
      "RGB565 colors require the declared family and an explicit color-key policy.",
    );
  const mapped =
    layout.layout === "rgb565le"
      ? undefined
      : colors(p.reader, p.coverage, layout, policy);
  if (mapped && mapped.status !== "colors") return mapped;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    if (y % 32 === 0) {
      await setImmediate();
      options.signal?.throwIfAborted();
    }
    const sy = rasterSampleCoordinate(y, layout.height, height),
      row = layout.rowOrder === "bottom-up" ? layout.height - 1 - sy : sy;
    for (let x = 0; x < width; x++) {
      const sx = rasterSampleCoordinate(x, layout.width, width);
      let color: Color;
      if (layout.layout === "rgb565le") {
        const word = p.reader.u16(
          layout.payloadRange.offset + row * layout.stride + sx * 2,
        );
        const key =
          policy.kind === "record12-lut-registry"
            ? policy.rgb565ColorKey
            : null;
        if (key !== null && word === key) color = [0, 0, 0, 0];
        else {
          const r = word >>> 11,
            g = (word >>> 5) & 63,
            b = word & 31;
          color = [
            (r << 3) | (r >>> 2),
            (g << 2) | (g >>> 4),
            (b << 3) | (b >>> 2),
            255,
          ];
        }
      } else {
        const bit = sx * layout.bitsPerPixel,
          packed = p.reader.u8(
            layout.payloadRange.offset +
              row * layout.stride +
              Math.floor(bit / 8),
          );
        color =
          mapped!.entries[
            packedRasterIndex(packed, sx, layout.bitsPerPixel, layout.bitOrder)
          ]!;
      }
      rgba.set(color, (y * width + x) * 4);
    }
  }
  await setImmediate();
  options.signal?.throwIfAborted();
  const png = encodeRasterRgbaPng(width, height, rgba);
  await setImmediate();
  options.signal?.throwIfAborted();
  return {
    status: "rendered",
    width,
    height,
    rgba,
    png,
    interpretation: {
      kind: policy.kind,
      assumptions: [
        `Explicit ${policy.kind} policy; ${layout.layout}, ${layout.rowOrder}, ${layout.bitOrder}.`,
        ...(policy.kind === "record12-lut-registry"
          ? [
              layout.layout === "rgb565le"
                ? `Direct RGB565 bit replication; color key ${policy.rgb565ColorKey === null ? "disabled" : policy.rgb565ColorKey}; alpha255 except key transparency. No palette, theme slot, palette precision, palette alpha or indexed sentinel is used.`
                : `Theme slot ${policy.themeSlot}; precision ${policy.precision}; alpha ${policy.alpha}; sentinel ${policy.sentinel}; RGB565 color key ${policy.rgb565ColorKey === null ? "disabled" : policy.rgb565ColorKey}.`,
            ]
          : policy.kind === "rgba-palette"
            ? [
                `Caller palette index space ${policy.index_space}; sentinel ${policy.sentinel}; RGBA entries used verbatim.`,
              ]
            : []),
        policy.kind === "diagnostic-indices"
          ? "Artificial selector grayscale; no original colors, alpha, palette or LUT meaning is established."
          : "Straight RGBA under the caller-selected color interpretation; no live theme or screen compositing is established.",
        ...(maxSide === undefined
          ? []
          : [
              "Nearest-neighbour sampling may omit source detail; no full-image buffer was allocated.",
            ]),
      ],
    },
  };
}
export const renderRasterResource = (
  bytes: Uint8Array,
  layout: RasterRenderLayout,
  policy: RasterColorPolicy,
  options: RasterRenderOptions,
) => render(bytes, layout, policy, options);
export const renderRasterResourceThumbnail = (
  bytes: Uint8Array,
  layout: RasterRenderLayout,
  policy: RasterColorPolicy,
  options: RasterRenderOptions & { maxSide: number },
) => render(bytes, layout, policy, options, options.maxSide);
