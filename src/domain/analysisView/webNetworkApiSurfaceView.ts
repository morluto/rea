import { z } from "zod";
import { AnalysisUnsupportedTargetError } from "../analysisErrorCore.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { err, ok, type Result } from "../result.js";
import { webNetworkCaptureSchema } from "../webNetworkCapture.js";
import {
  analysisViewInputError,
  type AnalysisViewParent,
  type AnalysisViewRequest,
  type UnsignedAnalysisView,
} from "./analysisView.js";
import { WebNetworkApiSurfaceAccumulator } from "./WebNetworkApiSurfaceAccumulator.js";

export const apiSurfaceViewSchema = z.strictObject({
  kind: z.literal("api-surface"),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(50),
});
const ruleSchema = z.enum(["numeric", "uuid", "hex", "iso-date"]);
const groupSchema = z.strictObject({
  method: z.string(),
  origin: z.string(),
  path_template: z.string(),
  templated_segments: z.array(
    z.strictObject({
      segment_index: z.number().int().nonnegative(),
      rule: ruleSchema,
      basis: z.literal("inferred"),
      observed_values: z.array(z.string()),
    }),
  ),
  record_ordinals: z.array(z.number().int().nonnegative()),
  statuses: z.array(z.number()),
  content_types: z.array(z.string()),
  flags: z.array(
    z.enum(["single-sample", "mixed-statuses", "mixed-content-types"]),
  ),
});
export const apiSurfaceFields = {
  records: z.strictObject({
    examined: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
  }),
  templated_groups: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Groups across every page that carry at least one templated segment.",
    ),
  groups: z.array(groupSchema),
  excluded_records: z.array(
    z.strictObject({
      ordinal: z.number().int().nonnegative(),
      reason: z.enum([
        "url-redacted",
        "url-unparseable",
        "request-unavailable",
        "method-unavailable",
      ]),
    }),
  ),
};
/** Group retained HAR request lines; format matches do not establish handler identity. */
export const projectWebNetworkApiSurfaceView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
  accumulator = new WebNetworkApiSurfaceAccumulator(),
): Result<UnsignedAnalysisView, AnalysisError> => {
  const unsupported = (reason: string) =>
    err(
      new AnalysisUnsupportedTargetError(
        "inspect_analysis_view",
        parent.evidenceId,
        reason,
      ),
    );
  if (
    parent.operation !== "inspect_web_network_capture" ||
    view.kind !== "api-surface"
  )
    return unsupported(
      `View ${view.kind} is unsupported for parent operation ${parent.operation}; api-surface requires inspect_web_network_capture.`,
    );
  const admitted = accumulator.admitCaptureClone(parent.normalizedResult);
  if (!admitted.ok) return admitted;
  const parsed = webNetworkCaptureSchema.safeParse(parent.normalizedResult);
  if (!parsed.success)
    return err(
      analysisViewInputError([
        {
          path: ["source"],
          reason: "invalid_value",
          message:
            "Parent Evidence result does not match inspect_web_network_capture.",
        },
      ]),
    );
  const capture = parsed.data;
  if (capture.format !== "har")
    return unsupported(
      `api-surface does not support capture format ${capture.format}.`,
    );
  const declarations = z
    .object({ sensitive_value_count: z.number().int().nonnegative() })
    .safeParse(parent.parameters);
  if (!declarations.success || declarations.data.sensitive_value_count > 0)
    return unsupported("sensitive_values_unretained");
  const limitations = accumulator.addLimitations([
    ...parent.limitations,
    ...capture.limitations,
    "Grouping does not establish handler identity, URL-space schemas or causality.",
    ...(capture.records.length < capture.total_records
      ? [
          "Parent contains an ordinal subset; the surface covers only retained records.",
        ]
      : []),
  ]);
  if (!limitations.ok) return limitations;
  for (const record of capture.records) {
    const added = accumulator.add(record);
    if (!added.ok) return added;
  }
  const page = accumulator.page(view.offset, view.limit);
  return ok({
    kind: "api-surface",
    view,
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_web_network_capture",
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: capture.artifact.path, sha256: capture.artifact.sha256 },
    records: {
      examined: capture.records.length,
      total: capture.total_records,
      excluded: page.excluded_records.length,
    },
    ...page,
  });
};
