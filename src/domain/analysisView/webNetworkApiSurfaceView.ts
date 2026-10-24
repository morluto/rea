import { z } from "zod";
import { AnalysisUnsupportedTargetError } from "../analysisErrorCore.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { err, ok, type Result } from "../result.js";
import type {
  AnalysisViewParent,
  AnalysisViewRequest,
  UnsignedAnalysisView,
} from "./analysisView.js";
import { WebNetworkApiSurfaceAccumulator } from "./WebNetworkApiSurfaceAccumulator.js";
import { admitHarCaptureParent } from "./WebNetworkProjectionAccumulator.js";
import { ROUTE_RULES } from "./webNetworkRouteTemplates.js";

export const apiSurfaceViewSchema = z.strictObject({
  kind: z.literal("api-surface"),
  offset: z.int().nonnegative().default(0),
  limit: z.int().positive().default(50),
  include_query_parameter_names: z
    .boolean()
    .optional()
    .describe(
      "Include distinct observed query parameter names and their original record ordinals; names do not establish required parameters or a complete API schema.",
    ),
  include_response_coverage: z
    .boolean()
    .optional()
    .describe(
      "Locate unavailable status and content type facts using original record ordinals in each group; coverage applies only to retained records.",
    ),
});
const ruleSchema = z.enum(ROUTE_RULES);
const groupSchema = z.strictObject({
  method: z.string(),
  origin: z.string(),
  path_template: z.string(),
  templated_segments: z.array(
    z.strictObject({
      segment_index: z.int().nonnegative(),
      rule: ruleSchema,
      basis: z.literal("inferred"),
      observed_values: z.array(z.string()),
    }),
  ),
  record_ordinals: z.array(z.int().nonnegative()),
  statuses: z.array(z.number()),
  content_types: z.array(z.string()),
  response_coverage: z
    .strictObject({
      unavailable_status_ordinals: z.array(z.number().int().nonnegative()),
      unavailable_content_type_ordinals: z.array(
        z.number().int().nonnegative(),
      ),
    })
    .optional(),
  query_parameter_names: z
    .array(
      z.strictObject({
        name: z.string(),
        record_ordinals: z.array(z.int().nonnegative()),
      }),
    )
    .optional(),
  flags: z.array(
    z.enum(["single-sample", "mixed-statuses", "mixed-content-types"]),
  ),
});
export const apiSurfaceFields = {
  records: z.strictObject({
    examined: z.int().nonnegative(),
    total: z.int().nonnegative(),
    excluded: z.int().nonnegative(),
  }),
  templated_groups: z
    .int()
    .nonnegative()
    .describe(
      "Groups across every page that carry at least one templated segment.",
    ),
  groups: z.array(groupSchema),
  excluded_records: z.array(
    z.strictObject({
      ordinal: z.int().nonnegative(),
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
  accumulator = WebNetworkApiSurfaceAccumulator.forView(view),
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (view.kind !== "api-surface")
    return err(
      new AnalysisUnsupportedTargetError(
        "inspect_analysis_view",
        parent.evidenceId,
        `View ${view.kind} is unsupported for parent operation ${parent.operation}; api-surface requires inspect_web_network_capture.`,
      ),
    );
  const admitted = admitHarCaptureParent(parent, "api-surface", accumulator);
  if (!admitted.ok) return admitted;
  const capture = admitted.value;
  const limitations = accumulator.addLimitations([
    ...parent.limitations,
    ...capture.limitations,
    "Grouping does not establish handler identity, URL-space schemas or causality.",
    ...(view.include_query_parameter_names === true
      ? [
          "Observed query parameter names do not establish required parameters, value types or a complete API schema.",
        ]
      : []),
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
