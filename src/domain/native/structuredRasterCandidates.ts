import { z } from "zod";
import { absoluteLocalPathStringSchema } from "../localPath.js";
const offset = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = offset.min(1);
const field = z.strictObject({
  offset: offset.max(255),
  byteWidth: z.union([z.literal(1), z.literal(2), z.literal(4)]),
});
export const structuredRasterGrammarSchema = z.strictObject({
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
});
export const rasterLogicalSegmentSchema = z.strictObject({
  logicalOffset: offset,
  fileOffset: offset,
  length: positive,
});
export const inspectStructuredRasterCandidatesInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema,
  offset: offset.default(0),
  length: positive.max(16 * 1024 * 1024).optional(),
  profile: z.enum(["flat", "fgs-records"]).default("flat"),
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
  preview: z
    .strictObject({
      kind: z.literal("index-only"),
      width: positive,
      height: positive,
      pngBase64: z.string(),
      assumptions: z.array(z.string()),
    })
    .optional(),
});
export const structuredRasterCandidatesSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string(),
    bytes: offset,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  window: range,
  grammar: structuredRasterGrammarSchema,
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
