import { rasterRegistryFamilyReportSchema } from "./rasterRegistryReport.js";
import {
  rasterColorPolicyInputSchema,
  rasterRegistrySelectionInputSchema,
} from "./rasterRendering.js";
import { z } from "zod";
import {
  StructuredRasterControlError,
  validateStructuredRasterGrammar,
  validateStructuredRasterRecordLimits,
} from "../structuredRasterGrammarValidation.js";
function reportControlFailure(action: () => void, ctx: z.RefinementCtx): void {
  try {
    action();
  } catch (cause) {
    if (!(cause instanceof StructuredRasterControlError)) throw cause;
    ctx.addIssue({
      code: "custom",
      path: [...cause.fieldPath],
      message: cause.message,
    });
  }
}
import { absoluteLocalPathStringSchema } from "../localPath.js";
const offset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = offset.min(1);
const field = z.strictObject({
  offset: offset.max(255),
  byteWidth: z.union([z.literal(1), z.literal(2), z.literal(4)]),
});
export const structuredRasterGrammarSchema = z
  .strictObject({
    recordStride: positive.min(4).max(128),
    endianness: z.enum(["little", "big"]),
    scanAlignment: positive.max(128),
    fields: z.strictObject({
      format: field,
      width: field,
      height: field,
      payloadOffset: field,
      reserved: field.exactOptional(),
    }),
    requireZeroReserved: z.boolean(),
    requireMonotonicOffsets: z.boolean(),
    payloadBase: z.literal("table-end"),
    maxDimension: positive.max(4096),
    maxFormat: offset.max(65535),
  })
  .superRefine((grammar, ctx) =>
    reportControlFailure(() => validateStructuredRasterGrammar(grammar), ctx),
  );
export const rasterLogicalSegmentSchema = z.strictObject({
  logicalOffset: offset,
  fileOffset: offset,
  length: positive,
});
export const structuredRasterInputShape = z.strictObject({
  path: absoluteLocalPathStringSchema,
  offset: offset.default(0),
  length: positive.max(16 * 1024 * 1024).optional(),
  profile: z.enum(["flat", "fgs-records"]).default("flat"),
  resource_family: z
    .enum(["generic", "record12-lut-registry"])
    .default("generic"),
  family_max_work: positive.max(50000000).default(10000000),
  color_policy: rasterColorPolicyInputSchema.default({
    kind: "diagnostic-indices",
  }),
  registry_selection: rasterRegistrySelectionInputSchema.optional(),
  segments: z.array(rasterLogicalSegmentSchema).min(1).max(4096).optional(),
  grammar: structuredRasterGrammarSchema.optional(),
  min_records: positive.min(2).max(4096).default(8),
  min_consistency: z.number().min(0.5).max(1).default(0.9),
  max_work: positive.max(50000000).default(10000000),
  max_tables: positive.max(128).default(32),
  max_records: positive.max(4096).default(4096),
  bits_per_pixel: z
    .array(
      z.union([
        z.literal(1),
        z.literal(2),
        z.literal(4),
        z.literal(8),
        z.literal(16),
        z.literal(24),
        z.literal(32),
      ]),
    )
    .min(1)
    .max(7)
    .default([1, 2, 4, 8, 16, 24, 32]),
  offset_units: z
    .array(z.union([z.literal(1), z.literal(2), z.literal(4)]))
    .min(1)
    .max(3)
    .default([1, 2, 4]),
  resource_offset: offset.max(4096).default(0),
  max_resources: positive.max(512).default(128),
  max_previews: offset.max(8).default(4),
  thumbnail_side: positive.max(128).default(96),
});
export function refineStructuredControls(
  input: {
    min_records?: number | undefined;
    max_records?: number | undefined;
    profile?: "flat" | "fgs-records" | undefined;
    offset?: number | undefined;
    segments?: unknown;
    resource_family?: "generic" | "record12-lut-registry" | undefined;
    color_policy?: { kind: string } | undefined;
    registry_selection?: unknown;
  },
  ctx: z.RefinementCtx,
): void {
  reportControlFailure(
    () =>
      validateStructuredRasterRecordLimits(
        input.min_records ?? 8,
        input.max_records ?? 4096,
      ),
    ctx,
  );
  if (input.resource_family !== "record12-lut-registry") {
    if (input.color_policy?.kind === "record12-lut-registry")
      ctx.addIssue({
        code: "custom",
        path: ["color_policy"],
        message:
          "Family color policy requires resource_family=record12-lut-registry.",
      });
    if (input.registry_selection !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["registry_selection"],
        message:
          "Registry selection requires resource_family=record12-lut-registry.",
      });
  }
  if (input.profile === "fgs-records") {
    if (input.segments !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["segments"],
        message: "fgs-records does not accept explicit segments",
      });
    if ((input.offset ?? 0) !== 0)
      ctx.addIssue({
        code: "custom",
        path: ["offset"],
        message: "fgs-records requires the complete file at offset zero",
      });
  }
}
export const inspectStructuredRasterCandidatesInputSchema =
  structuredRasterInputShape.superRefine(refineStructuredControls);
/** Caller-supplied controls preserve omission; resolved defaults are reported separately. */
export const structuredRasterRequestShape = structuredRasterInputShape.extend({
  color_policy: structuredRasterInputShape.shape.color_policy
    .removeDefault()
    .optional(),
  resource_family: structuredRasterInputShape.shape.resource_family
    .removeDefault()
    .optional(),
  family_max_work: structuredRasterInputShape.shape.family_max_work
    .removeDefault()
    .optional(),
  offset: structuredRasterInputShape.shape.offset.removeDefault().optional(),
  profile: structuredRasterInputShape.shape.profile.removeDefault().optional(),
  min_records: structuredRasterInputShape.shape.min_records
    .removeDefault()
    .optional(),
  min_consistency: structuredRasterInputShape.shape.min_consistency
    .removeDefault()
    .optional(),
  max_work: structuredRasterInputShape.shape.max_work
    .removeDefault()
    .optional(),
  max_tables: structuredRasterInputShape.shape.max_tables
    .removeDefault()
    .optional(),
  max_records: structuredRasterInputShape.shape.max_records
    .removeDefault()
    .optional(),
  bits_per_pixel: structuredRasterInputShape.shape.bits_per_pixel
    .removeDefault()
    .optional(),
  offset_units: structuredRasterInputShape.shape.offset_units
    .removeDefault()
    .optional(),
  resource_offset: structuredRasterInputShape.shape.resource_offset
    .removeDefault()
    .optional(),
  max_resources: structuredRasterInputShape.shape.max_resources
    .removeDefault()
    .optional(),
  max_previews: structuredRasterInputShape.shape.max_previews
    .removeDefault()
    .optional(),
  thumbnail_side: structuredRasterInputShape.shape.thumbnail_side
    .removeDefault()
    .optional(),
});
export const inspectStructuredRasterCandidatesRequestSchema =
  structuredRasterRequestShape.superRefine(refineStructuredControls);
const resolvedStructuredRasterControlsSchema = structuredRasterInputShape
  .extend({
    color_policy: structuredRasterRequestShape.shape.color_policy.unwrap(),
    resource_family:
      structuredRasterRequestShape.shape.resource_family.unwrap(),
    family_max_work:
      structuredRasterRequestShape.shape.family_max_work.unwrap(),
    offset:
      inspectStructuredRasterCandidatesRequestSchema.shape.offset.unwrap(),
    profile:
      inspectStructuredRasterCandidatesRequestSchema.shape.profile.unwrap(),
    min_records:
      inspectStructuredRasterCandidatesRequestSchema.shape.min_records.unwrap(),
    min_consistency:
      inspectStructuredRasterCandidatesRequestSchema.shape.min_consistency.unwrap(),
    max_work:
      inspectStructuredRasterCandidatesRequestSchema.shape.max_work.unwrap(),
    max_tables:
      inspectStructuredRasterCandidatesRequestSchema.shape.max_tables.unwrap(),
    max_records:
      inspectStructuredRasterCandidatesRequestSchema.shape.max_records.unwrap(),
    bits_per_pixel:
      inspectStructuredRasterCandidatesRequestSchema.shape.bits_per_pixel.unwrap(),
    offset_units:
      inspectStructuredRasterCandidatesRequestSchema.shape.offset_units.unwrap(),
    resource_offset:
      inspectStructuredRasterCandidatesRequestSchema.shape.resource_offset.unwrap(),
    max_resources:
      inspectStructuredRasterCandidatesRequestSchema.shape.max_resources.unwrap(),
    max_previews:
      inspectStructuredRasterCandidatesRequestSchema.shape.max_previews.unwrap(),
    thumbnail_side:
      inspectStructuredRasterCandidatesRequestSchema.shape.thumbnail_side.unwrap(),
    length:
      inspectStructuredRasterCandidatesRequestSchema.shape.length.unwrap(),
  })
  .omit({ path: true })
  .superRefine(refineStructuredControls);
const range = z.strictObject({ offset, length: offset });
const hypothesis = z.strictObject({
  bitsPerPixel: positive,
  offsetUnit: positive,
  matches: offset,
  consistency: z.number().min(0).max(1),
});
const mapping = z.strictObject({
  ranges: z.array(range).max(256),
  complete: z.boolean(),
});
const resource = z.strictObject({
  descriptorOffset: offset,
  format: offset,
  width: positive,
  height: positive,
  payloadOffset: offset,
  status: z.enum(["unique", "ambiguous", "unresolved"]),
  hypotheses: z.array(
    hypothesis.extend({
      stride: positive,
      payloadRange: range,
      covered: z.boolean(),
      sourceMapping: mapping,
    }),
  ),
  descriptorSourceMapping: mapping,
  previewUnavailable: z.string().optional(),
  preview: z
    .strictObject({
      kind: z.enum(["index-only", "caller-rgba", "profile-declared"]),
      width: positive,
      height: positive,
      pngBase64: z.string(),
      assumptions: z.array(z.string()),
    })
    .optional(),
});
export const structuredRasterCandidatesSchema = z.strictObject({
  resolved_controls: resolvedStructuredRasterControlsSchema,
  artifact: z.strictObject({
    path: z.string(),
    bytes: offset,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  window: range,
  grammar: structuredRasterGrammarSchema,
  resourceFamily: rasterRegistryFamilyReportSchema.optional(),
  mapping: z.strictObject({
    profile: z.enum(["flat", "fgs-records", "explicit-segments"]),
    logicalBase: offset,
    logicalBytes: offset,
    segmentCount: offset,
    coveredBytes: offset,
    uncoveredBytes: offset,
    sourceMappingsTruncated: z.boolean(),
  }),
  tables: z.array(
    z.strictObject({
      offset,
      length: offset,
      recordCount: offset,
      formats: z.array(
        z.strictObject({
          format: offset,
          comparisons: offset,
          hypotheses: z.array(hypothesis),
        }),
      ),
      resources: z.array(resource),
    }),
  ),
  coverage: z.strictObject({
    complete: z.boolean(),
    work: offset,
    maxWork: offset,
    rejectedUncorroboratedTables: offset,
    testedPositions: offset,
    retainedRecords: offset,
    nextOffset: offset.nullable(),
    reason: z.enum(["work-limit", "table-limit", "record-limit"]).nullable(),
  }),
  projection: z.strictObject({
    availableResources: offset,
    returnedResources: offset,
    resourceOffset: offset,
    nextResourceOffset: offset.nullable(),
    resourcesTruncated: z.boolean(),
    previews: offset,
  }),
  limitations: z.array(z.string()),
});
