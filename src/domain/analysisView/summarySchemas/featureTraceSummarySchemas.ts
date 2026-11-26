import { z } from "zod";
import {
  artifactSchema,
  summaryViewResultBase,
  viewResultBaseFields,
} from "../analysisViewBase.js";
import {
  featureTraceSummarySchema,
  featureTraceViewCollections,
  featureTraceViewContextSchema,
} from "../featureTraceView.js";

/** Compact retained feature-trace summary; pages carry the same trace context. */
export const featureTraceSummaryViewResultSchema = z.strictObject({
  ...summaryViewResultBase,
  artifact: artifactSchema.nullable(),
  parent_operation: z.literal("trace_application_feature"),
  summary: featureTraceSummarySchema,
});

const featureTracePage = <
  Collection extends keyof typeof featureTraceViewCollections,
>(
  collection: Collection,
) =>
  z.strictObject({
    ...viewResultBaseFields,
    ...featureTraceViewContextSchema.shape,
    kind: z.literal("feature-trace"),
    artifact: artifactSchema.nullable(),
    parent_operation: z.literal("trace_application_feature"),
    view: featureTraceViewCollections[collection].request,
    items: featureTraceViewCollections[collection].rows,
  });

// As with Mach-O pages, the kind tag keeps dispatch while each collection is
// advertised with exactly its own rows.
export const featureTraceViewResultSchema = z
  .object({ kind: z.literal("feature-trace") })
  .passthrough()
  .pipe(
    z.union([
      featureTracePage("paths"),
      featureTracePage("nodes"),
      featureTracePage("edges"),
      featureTracePage("seed_matches"),
      featureTracePage("native_handoffs"),
    ]),
  );
