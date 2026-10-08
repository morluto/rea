import { z } from "zod";
import { digestSchema } from "../digests.js";
import { analyzeJavaScriptApplicationInputSchema } from "./javascriptApplicationAnalysis.js";
import { localPathStringSchema } from "../localPath.js";

/** Recover derived readable modules from one explicitly selected local script. */
export const javascriptRecoveryInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute path to a UTF-8 JavaScript file; never executed",
  ),
  output_directory: localPathStringSchema.describe(
    "Absolute absent output directory; parent must exist",
  ),
  extraction_mode: z
    .enum(["structural", "heuristic", "inspection"])
    .default("structural")
    .describe(
      "Structural module boundaries, heuristic fallback, or finer inspection-only regions",
    ),
  rewrite_level: z
    .enum(["minimal", "standard", "aggressive"])
    .default("standard")
    .describe(
      "Upstream syntax recovery level; runtime equivalence remains unverified",
    ),
});

const fileSchema = z.strictObject({
  path: z.string().min(1),
  sha256: digestSchema,
  bytes: z.number().int().nonnegative(),
});

const rangeSchema = z.strictObject({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

/** Complete published artifacts and exact producer provenance for source recovery. */
export const javascriptRecoveryResultSchema = z.strictObject({
  source: fileSchema.extend({
    snapshot_path: z.string().min(1),
    published_copy: fileSchema,
  }),
  engine: z.strictObject({
    id: z.string().min(1),
    version: z.string().min(1),
    executable: fileSchema,
    audited_source_revision: z.string().min(1),
    executed_source_revision: z.string().nullable(),
  }),
  options: z.strictObject({
    extraction_mode:
      javascriptRecoveryInputSchema.shape.extraction_mode.removeDefault(),
    rewrite_level:
      javascriptRecoveryInputSchema.shape.rewrite_level.removeDefault(),
  }),
  status: z.enum(["complete", "partial"]),
  detected_formats: z.array(z.string()),
  reported_safety: z.string(),
  reported_strategy: z.string(),
  reported_format: z.string(),
  total: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  modules: z.array(
    z.strictObject({
      reported_filename: z.string().min(1),
      reported_status: z.string().min(1),
      artifact: fileSchema,
      source_map: fileSchema.nullable(),
      provenance: z.strictObject({
        reported_input: z.string(),
        original_path: z.string(),
        original_sha256: digestSchema,
        extraction: z.string(),
        byte_ranges: z.array(rangeSchema),
        context_byte_ranges: z.array(rangeSchema),
        range_semantics: z.literal("half-open-utf8-bytes"),
      }),
    }),
  ),
  warnings: z.array(
    z.strictObject({
      filename: z.string(),
      kind: z.string(),
      is_error: z.boolean(),
      message: z.string(),
    }),
  ),
  report: fileSchema,
  provenance: fileSchema,
  manifest: fileSchema,
  analysis_input: z
    .strictObject({
      input_path: analyzeJavaScriptApplicationInputSchema.shape.input_path,
      format: z.literal("directory"),
    })
    .nullable(),
  runtime_equivalence: z.literal("unknown"),
  limitations: z.array(z.string()),
});

export type JavaScriptRecoveryInput = z.output<
  typeof javascriptRecoveryInputSchema
>;
export type JavaScriptRecoveryResult = z.output<
  typeof javascriptRecoveryResultSchema
>;
