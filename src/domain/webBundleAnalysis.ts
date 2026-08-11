import { z } from "zod";

import { inspectWebPageWithSourceInputSchema } from "./browserObservation.js";
import { webTextArtifactSchema } from "./webContentArtifact.js";

const webBundleLimitsSchema = z.object({
  max_findings: z.number().int().min(1).max(10_000).default(1_000),
  max_ast_nodes: z.number().int().min(1).max(2_000_000).default(250_000),
  max_source_maps: z.number().int().min(1).max(1_000).default(100),
  max_source_map_bytes: z
    .number()
    .int()
    .min(1)
    .max(16 * 1_024 * 1_024)
    .default(4 * 1_024 * 1_024),
  max_total_source_map_bytes: z
    .number()
    .int()
    .min(1)
    .max(64 * 1_024 * 1_024)
    .default(16 * 1_024 * 1_024),
  max_source_map_mappings: z.number().int().min(1).max(100_000).default(10_000),
  max_original_sources: z.number().int().min(1).max(20_000).default(2_000),
});

/** Capture-and-analyze input with separate source and source-map approvals. */
const analyzeWebBundleFactsSchema =
  inspectWebPageWithSourceInputSchema.safeExtend({
    analysis_limits: webBundleLimitsSchema.default({
      max_findings: 1_000,
      max_ast_nodes: 250_000,
      max_source_maps: 100,
      max_source_map_bytes: 4 * 1_024 * 1_024,
      max_total_source_map_bytes: 16 * 1_024 * 1_024,
      max_source_map_mappings: 10_000,
      max_original_sources: 2_000,
    }),
  });
export const analyzeWebBundleInputSchema = z
  .union([
    analyzeWebBundleFactsSchema.safeExtend({
      fetch_source_maps: z.literal(false).default(false),
      source_map_fetch_approved: z.literal(false).default(false),
    }),
    analyzeWebBundleFactsSchema.safeExtend({
      fetch_source_maps: z.literal(true),
      source_map_fetch_approved: z.literal(true),
    }),
  ])
  .superRefine((input, context) => {
    if (
      input.analysis_limits.max_source_map_bytes >
      input.analysis_limits.max_total_source_map_bytes
    )
      context.addIssue({
        code: "custom",
        path: ["analysis_limits", "max_source_map_bytes"],
        message:
          "Per-map source-map byte limit cannot exceed the aggregate limit",
      });
  });
export type AnalyzeWebBundleInput = z.infer<typeof analyzeWebBundleInputSchema>;

const sourceLocationSchema = z.object({
  script_key: z.string(),
  line: z.number().int().min(1).nullable(),
  column: z.number().int().min(0).nullable(),
});

const basisSchema = z.object({
  script_key: z.string(),
  artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  line: z.number().int().min(1).nullable(),
  column: z.number().int().min(0).nullable(),
  detector: z.string(),
});

const findingSchema = z.object({
  value: z.string(),
  mechanism: z.string(),
  location: sourceLocationSchema,
});

const originalSourceSchema = z.object({
  source: z.string(),
  artifact: webTextArtifactSchema.nullable(),
});
const originalModuleEdgeSchema = z.object({
  from_source: z.string(),
  kind: z.enum(["static_import", "dynamic_import", "require"]),
  specifier: z.string(),
  resolved_source: z.string().nullable(),
});
const sourceMapMappingSchema = z.object({
  generated_line: z.number().int().min(1),
  generated_column: z.number().int().min(0),
  source: z.string(),
  original_line: z.number().int().min(1),
  original_column: z.number().int().min(0),
  name: z.string().nullable(),
});
const sourceMapContextShape = {
  script_key: z.string(),
  declared_url: z.string(),
};
const parsedSourceMapShape = {
  artifact: webTextArtifactSchema,
  original_sources: z.array(originalSourceSchema),
  original_module_edges: z.array(originalModuleEdgeSchema),
  mappings: z.array(sourceMapMappingSchema),
};

const sourceMapSchema = z.union([
  z.object({
    ...sourceMapContextShape,
    ...parsedSourceMapShape,
    status: z.literal("included"),
    limitation: z.null(),
  }),
  z.object({
    ...sourceMapContextShape,
    ...parsedSourceMapShape,
    status: z.literal("truncated"),
    limitation: z.string(),
  }),
  z.object({
    ...sourceMapContextShape,
    status: z.enum(["fetch_failed", "invalid", "policy_filtered", "truncated"]),
    artifact: z.null(),
    original_sources: z.tuple([]),
    original_module_edges: z.tuple([]),
    mappings: z.tuple([]),
    limitation: z.string(),
  }),
]);

const webTextArtifactSummarySchema = z.object({
  uri: z.string().regex(/^rea:\/\/web-content\/sha256\/[a-f0-9]{64}$/u),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.number().int().min(0),
  media_type: z.string().min(1).max(256),
  charset: z.literal("utf-8"),
  text_available: z.literal(true),
});

export const webSourceMapsSchema = z
  .object({
    status: z.enum([
      "not_requested",
      "included",
      "partial",
      "unavailable",
      "truncated",
    ]),
    requested: z.number().int().min(0),
    processed: z.number().int().min(0),
    dropped: z.number().int().min(0),
    dropped_script_keys: z.array(z.string()),
    items: z.array(sourceMapSchema),
  })
  .superRefine((sourceMaps, context) => {
    if (
      sourceMaps.requested !== sourceMaps.processed + sourceMaps.dropped ||
      sourceMaps.processed !== sourceMaps.items.length ||
      sourceMaps.dropped !== sourceMaps.dropped_script_keys.length
    )
      context.addIssue({
        code: "custom",
        message: "Source-map coverage counts are inconsistent",
      });
    const statuses = sourceMaps.items.map(({ status }) => status);
    const included = statuses.filter((status) => status === "included").length;
    const hasTruncated = statuses.includes("truncated");
    const allowedStatuses =
      sourceMaps.dropped > 0 || hasTruncated
        ? ["truncated"]
        : sourceMaps.items.length === 0
          ? ["not_requested", "unavailable"]
          : included === sourceMaps.items.length
            ? ["included"]
            : included > 0
              ? ["partial"]
              : ["unavailable"];
    if (!allowedStatuses.includes(sourceMaps.status))
      context.addIssue({
        code: "custom",
        message: "Source-map status contradicts retained coverage",
        path: ["status"],
      });
  });

export type WebSourceMapItem = z.infer<typeof sourceMapSchema>;
export type WebSourceMaps = z.infer<typeof webSourceMapsSchema>;

/** Provider-neutral result of bounded JavaScript bundle reverse engineering. */
export const webBundleAnalysisSchema = z.object({
  schema_version: z.literal(1),
  capture: z.object({
    target_url: z.string(),
    scripts_observed: z.number().int().min(0),
    scripts_analyzed: z.number().int().min(0),
    source_artifacts: z.array(webTextArtifactSummarySchema),
  }),
  observations: z.object({
    chunks: z.object({
      nodes: z.array(
        z.object({
          script_key: z.string(),
          url: z.string(),
          artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
          bytes: z.number().int().min(0),
        }),
      ),
      edges: z.array(
        z.object({
          from_script_key: z.string(),
          kind: z.enum([
            "static_import",
            "dynamic_import",
            "require",
            "worker_import",
          ]),
          specifier: z.string(),
          resolved_url: z.string().nullable(),
          location: sourceLocationSchema,
        }),
      ),
    }),
    routes: z.array(findingSchema),
    endpoints: z.array(findingSchema),
    webmcp_declarations: z.array(
      z.object({
        name: z.string().nullable(),
        description: z.string().nullable(),
        schema_property_names: z.array(z.string()),
        trust: z.literal("page-declared-untrusted"),
        location: sourceLocationSchema,
      }),
    ),
    source_maps: webSourceMapsSchema,
  }),
  inferences: z.array(
    z.object({
      kind: z.enum(["vendor_fingerprint", "route_framework", "bundle_runtime"]),
      value: z.string(),
      confidence: z.enum(["low", "medium", "high"]),
      basis: z.array(basisSchema).min(1),
    }),
  ),
  unknowns: z.array(
    z.object({
      dimension: z.string(),
      reason: z.string(),
      affected_script_keys: z.array(z.string()),
    }),
  ),
  completeness: z.object({
    status: z.enum(["complete_within_limits", "truncated", "partial"]),
    parsed_scripts: z.number().int().min(0),
    parse_failures: z.number().int().min(0),
    visited_ast_nodes: z.number().int().min(0),
    dropped_findings: z.number().int().min(0),
  }),
  limitations: z.array(z.string()),
});
export type WebBundleAnalysis = z.infer<typeof webBundleAnalysisSchema>;
