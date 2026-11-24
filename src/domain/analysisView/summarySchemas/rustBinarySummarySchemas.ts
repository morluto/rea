import { z } from "zod";
import {
  rustBinaryViewPageSchema,
  rustBinaryViewRequestSchema,
} from "../../rust/rustBinaryQuery.js";
import {
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import { nullableCollectionViewCoverageSchema } from "../analysisViewCoverage.js";
import {
  rustBinarySummarySchema,
  rustBinaryViewContextSchema,
} from "../rustBinaryView.js";

/** Compact source identity and counts, retaining the complete embedded graph. */
export const rustBinarySummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  ...rustBinaryViewContextSchema.shape,
  parent_operation: z.literal("inspect_rust_binary"),
  summary: rustBinarySummarySchema,
});

export const rustBinaryPageViewResultSchema = z.strictObject({
  ...viewResultBaseFields,
  coverage: nullableCollectionViewCoverageSchema,
  ...rustBinaryViewContextSchema.shape,
  kind: z.literal("rust"),
  parent_operation: z.literal("inspect_rust_binary"),
  view: rustBinaryViewRequestSchema,
  rust: rustBinarySummarySchema,
  page: rustBinaryViewPageSchema,
});
