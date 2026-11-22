import { z } from "zod";
import { binaryLayoutSchema } from "../../native/binaryLayout.js";
import { summaryViewResultBase } from "../analysisViewBase.js";

const layoutSummarySchema = z.strictObject({
  bytes: binaryLayoutSchema.shape.artifact.shape.bytes,
  format: binaryLayoutSchema.shape.format,
  architecture: binaryLayoutSchema.shape.architecture,
  image_type: binaryLayoutSchema.shape.image_type,
  entry: z.strictObject({
    reported_value: z.string().min(1),
    meaning: z.enum(["linked-virtual-address", "not-applicable", "absent"]),
    execution_status: z.literal("unknown"),
  }),
  counts: z.strictObject({
    sections: z.int().nonnegative(),
    segments: z.int().nonnegative(),
    symbols: z.int().nonnegative(),
    relocations: z.int().nonnegative(),
  }),
  limitation_count: z.int().nonnegative(),
});

/** Summary `inspect_binary_layout` detail returns; no other view kind. */
export const binaryLayoutSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  summary: layoutSummarySchema,
  parent_operation: z.literal("inspect_binary_layout"),
});
