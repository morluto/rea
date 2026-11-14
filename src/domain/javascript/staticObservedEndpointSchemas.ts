import { z } from "zod";
import { digestSchema, prefixedDigestSchema } from "../digests.js";
import { ROUTE_RULES } from "../analysisView/webNetworkRouteTemplates.js";

export const comparedStaticEndpointSchema = z.strictObject({
  endpoint_id: prefixedDigestSchema("static_endpoint"),
  node_id: prefixedDigestSchema("jag_node"),
  observation_id: prefixedDigestSchema("jag_observation"),
  method: z.string().nullable(),
  method_basis: z.enum(["api-definition", "callee-spelling", "unknown"]),
  origin: z.string().nullable(),
  origin_basis: z.enum(["literal-url", "caller-origin", "unknown"]),
  path: z.string().nullable(),
  status: z.enum(["matched", "not-observed-in-capture", "unknown"]),
  reason: z
    .enum([
      "candidate-endpoint",
      "unconfirmed-static-observation",
      "partial-target",
      "non-http-target",
      "unresolved-target",
      "unparseable-target",
      "normalization-required",
      "origin-required",
      "ambiguous-method",
      "capture-incomplete",
      "origin-not-exercised",
      "no-observed-match",
    ])
    .nullable(),
});

export const comparedObservedGroupSchema = z.strictObject({
  group_id: prefixedDigestSchema("observed_endpoint"),
  method: z.string(),
  origin: z.string(),
  path_template: z.string(),
  templated_segments: z.array(
    z.strictObject({
      segment_index: z.int().nonnegative(),
      rule: z.enum(ROUTE_RULES),
    }),
  ),
  record_ordinals: z.array(z.int().nonnegative()),
  status: z.enum(["matched", "unknown", "observed-without-static-match"]),
  reason: z.literal("ambiguous-static-method").nullable(),
});

export const endpointMatchSchema = z.strictObject({
  match_id: prefixedDigestSchema("endpoint_match"),
  endpoint_id: comparedStaticEndpointSchema.shape.endpoint_id,
  group_id: comparedObservedGroupSchema.shape.group_id,
  basis: z.enum(["exact", "template-compatible"]),
  supporting_record_ordinal: z.int().nonnegative(),
});

export const staticObservedEndpointComparisonSchema = z.strictObject({
  comparison_id: prefixedDigestSchema("endpoint_comparison"),
  application: z.strictObject({
    evidence_id: prefixedDigestSchema("ev"),
    graph_id: prefixedDigestSchema("jag"),
  }),
  capture: z.strictObject({
    evidence_id: prefixedDigestSchema("ev"),
    artifact: z.strictObject({
      path: z.string(),
      sha256: digestSchema.nullable(),
    }),
  }),
  declared_origin: z.string().nullable(),
  summary: z.strictObject({
    static_network_endpoint_observations: z.int().nonnegative(),
    matched: z.int().nonnegative(),
    not_observed_in_capture: z.int().nonnegative(),
    unknown: z.int().nonnegative(),
    observed_groups: z.int().nonnegative(),
    observed_without_static_match: z.int().nonnegative(),
    observed_unknown: z.int().nonnegative(),
    matches: z.int().nonnegative(),
  }),
  source_coverage: z.strictObject({
    application: z.strictObject({
      status: z.enum(["complete", "partial", "unknown", "unavailable"]),
      truncated: z.boolean(),
      omitted_count: z.int().nonnegative().nullable(),
      limit_count: z.int().nonnegative(),
      limitation_count: z.int().nonnegative(),
    }),
    capture_limitation_count: z.int().nonnegative(),
    observed_records_examined: z.int().nonnegative(),
    observed_records_total: z.int().nonnegative(),
    observed_records_excluded: z.int().nonnegative(),
  }),
  static_endpoints: z.array(comparedStaticEndpointSchema),
  observed_groups: z.array(comparedObservedGroupSchema),
  matches: z.array(endpointMatchSchema),
  evidence_links: z.array(prefixedDigestSchema("ev")),
  limitations: z.array(z.string()),
});

export type StaticObservedEndpointComparison = z.output<
  typeof staticObservedEndpointComparisonSchema
>;
