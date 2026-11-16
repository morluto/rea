import { z } from "zod";
import { absoluteLocalPathStringSchema } from "../localPath.js";
import {
  structuredRasterInputShape,
  structuredRasterRequestShape,
  refineStructuredControls,
} from "./structuredRasterCandidates.js";
import {
  rasterColorPolicyInputSchema,
  rasterRegistrySelectionInputSchema,
} from "./rasterRendering.js";
const offset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const pagination = {
  resource_offset: true,
  max_resources: true,
  max_previews: true,
  thumbnail_side: true,
} as const;
const controls = {
  expected_sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  output_directory: absoluteLocalPathStringSchema,
  selections: z
    .array(
      z.strictObject({
        descriptor_offset: offset,
        hypothesis: z
          .strictObject({
            bits_per_pixel: z.union([
              z.literal(1),
              z.literal(2),
              z.literal(4),
              z.literal(8),
              z.literal(16),
              z.literal(24),
              z.literal(32),
            ]),
            offset_unit: z.union([z.literal(1), z.literal(2), z.literal(4)]),
          })
          .optional(),
      }),
    )
    .min(1)
    .max(4096)
    .optional(),
  ambiguity: z.enum(["skip", "all"]),
  formats: z
    .array(z.enum(["raw", "png"]))
    .min(1)
    .max(2),
  color_policy: rasterColorPolicyInputSchema,
  registry_selection: rasterRegistrySelectionInputSchema.optional(),
};
const exportRequestShape = structuredRasterRequestShape
  .omit(pagination)
  .extend({
    ...controls,
    ambiguity: controls.ambiguity.optional(),
    formats: controls.formats.optional(),
    color_policy: controls.color_policy.optional(),
  });
export const exportStructuredRasterResourcesRequestSchema =
  exportRequestShape.superRefine(refineStructuredControls);
export const exportStructuredRasterResourcesInputSchema =
  structuredRasterInputShape
    .omit(pagination)
    .extend({
      ...controls,
      ambiguity: controls.ambiguity.default("skip"),
      formats: controls.formats.default(["raw", "png"]),
      color_policy: controls.color_policy.default({
        kind: "diagnostic-indices",
      }),
    })
    .superRefine(refineStructuredControls);
/** Normalized mappings are hash-linked separately, not copied into this receipt. */
export const rasterExportResolvedControlsSchema = exportRequestShape
  .omit({
    path: true,
    output_directory: true,
    expected_sha256: true,
    segments: true,
  })
  .required({
    offset: true,
    length: true,
    profile: true,
    resource_family: true,
    family_max_work: true,
    grammar: true,
    min_records: true,
    min_consistency: true,
    max_work: true,
    max_tables: true,
    max_records: true,
    bits_per_pixel: true,
    offset_units: true,
    ambiguity: true,
    formats: true,
    color_policy: true,
  })
  .extend({
    mapping_profile: z.enum(["flat", "fgs-records", "explicit-segments"]),
    logical_base: offset,
    segment_count: offset,
  });
export const rasterExportFileSchema = z.strictObject({
  relativePath: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytesWritten: offset,
});
export const structuredRasterExportResultSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string(),
    bytes: offset,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  output_directory: z.string(),
  manifest: rasterExportFileSchema,
  segments: rasterExportFileSchema,
  resources: offset,
  exported: offset,
  skipped: offset,
  output_files: offset,
  published_bytes: offset,
  discovery_complete: z.boolean(),
  resolved_controls: rasterExportResolvedControlsSchema,
  limits: z.strictObject({
    output_bytes: offset,
    resource_outcomes: offset,
    output_files: offset,
  }),
  limitations: z.array(z.string()),
});
export type StructuredRasterExportInput = z.infer<
  typeof exportStructuredRasterResourcesInputSchema
>;
export type StructuredRasterExportResult = z.infer<
  typeof structuredRasterExportResultSchema
>;
