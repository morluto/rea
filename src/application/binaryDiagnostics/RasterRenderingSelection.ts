import type { z } from "zod";
import type {
  rasterColorPolicyInputSchema,
  rasterRegistrySelectionInputSchema,
} from "../../domain/native/rasterRendering.js";
import type { RasterRegistryCandidate } from "../../domain/rasterRegistryFamily.js";
import type {
  RasterColorPolicy,
  RasterRenderLayout,
} from "./RasterResourceRendering.js";
/** One admitted identity rule for export and preview; never pick the first alternative. */
export function selectRasterRegistries(
  registries: RasterRegistryCandidate[],
  logicalBase: number,
  selection?: z.infer<typeof rasterRegistrySelectionInputSchema>,
) {
  return selection
    ? registries.filter(
        (c) =>
          c.range.offset + logicalBase === selection.offset &&
          c.pointerBias - logicalBase === selection.pointer_bias,
      )
    : registries;
}
/** Indexed palettes come only from the admitted registry. Direct RGB565 has no palette dependency. */
export function resolveRasterColorPolicy(
  p: z.infer<typeof rasterColorPolicyInputSchema>,
  registry: RasterRegistryCandidate | undefined,
  layout: RasterRenderLayout | undefined,
): RasterColorPolicy | undefined {
  if (p.kind !== "record12-lut-registry") return p;
  const direct = layout?.layout === "rgb565le";
  const palette = direct
    ? undefined
    : registry?.palettes.find((c) => c.slot === p.theme_slot);
  if (!direct && !palette) return undefined;
  return {
    kind: p.kind,
    themeSlot: p.theme_slot,
    paletteRange: palette?.range ?? null,
    precision: p.precision,
    alpha: p.alpha,
    sentinel: p.sentinel,
    rgb565ColorKey: p.rgb565_color_key,
  };
}
