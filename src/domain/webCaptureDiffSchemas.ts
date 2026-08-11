import { z } from "zod";

import { webPageInspectionSchema } from "./browserObservation.js";
import { webMcpDiscoverySchema } from "./webMcpDiscovery.js";

/** One normalized passive page snapshot accepted by capture comparison. */
export const captureSnapshotSchema = z.object({
  inspection: webPageInspectionSchema,
  webmcp: webMcpDiscoverySchema.nullable().default(null),
});

/** Input for deterministic comparison of two normalized web captures. */
export const compareWebCapturesInputSchema = z.object({
  before: captureSnapshotSchema,
  after: captureSnapshotSchema,
  max_changes: z.number().int().min(1).max(20_000).default(2_000),
});

const changeSchema = z.object({
  identity: z.string(),
  change: z.enum(["added", "removed", "modified"]),
});
const emptyDimensionShape = {
  total_changes: z.literal(0),
  changes: z.tuple([]),
  omitted_changes: z.literal(0),
};
const dimensionSchema = z.union([
  z
    .object({
      status: z.literal("changed"),
      total_changes: z.number().int().min(1),
      changes: z.array(changeSchema),
      omitted_changes: z.number().int().min(0),
      reason: z.null(),
    })
    .superRefine((dimension, context) => {
      if (
        dimension.changes.length + dimension.omitted_changes !==
        dimension.total_changes
      )
        context.addIssue({
          code: "custom",
          message: "Retained and omitted changes must equal total changes",
          path: ["total_changes"],
        });
    }),
  z.object({
    ...emptyDimensionShape,
    status: z.literal("unchanged"),
    reason: z.null(),
  }),
  z.object({
    ...emptyDimensionShape,
    status: z.literal("unknown"),
    reason: z.string(),
  }),
]);
const legacyUnknownDimension: z.input<typeof dimensionSchema> = {
  status: "unknown",
  total_changes: 0,
  changes: [],
  omitted_changes: 0,
  reason: "Dimension was not recorded by this version 1 capture diff.",
};

/** Completeness-aware changes across stable browser evidence dimensions. */
export const webCaptureDiffSchema = z
  .object({
    schema_version: z.literal(1),
    overall_status: z.enum(["changed", "unchanged", "unknown"]),
    before_target: z.object({ target_id: z.string(), url: z.string() }),
    after_target: z.object({ target_id: z.string(), url: z.string() }),
    dimensions: z.object({
      dom_structure: dimensionSchema,
      scripts: dimensionSchema,
      resources: dimensionSchema,
      network: dimensionSchema,
      metadata: dimensionSchema,
      webmcp: dimensionSchema,
      accessibility: dimensionSchema.default(legacyUnknownDimension),
      storage: dimensionSchema.default(legacyUnknownDimension),
    }),
    limitations: z.array(z.string()),
  })
  .superRefine((comparison, context) => {
    const statuses = Object.values(comparison.dimensions).map(
      ({ status }) => status,
    );
    const expected = statuses.includes("changed")
      ? "changed"
      : statuses.includes("unknown")
        ? "unknown"
        : "unchanged";
    if (comparison.overall_status !== expected)
      context.addIssue({
        code: "custom",
        message: "Overall status must summarize dimension statuses",
        path: ["overall_status"],
      });
  });

export type CompareWebCapturesInput = z.infer<
  typeof compareWebCapturesInputSchema
>;
export type WebCaptureDiff = z.infer<typeof webCaptureDiffSchema>;
export type WebCaptureDimension =
  WebCaptureDiff["dimensions"][keyof WebCaptureDiff["dimensions"]];
export type WebCaptureChange = WebCaptureDimension["changes"][number];
