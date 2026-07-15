import { isAbsolute } from "node:path";

import { z } from "zod";

import { javascriptApplicationGraphSchema } from "./javascriptApplicationGraph.js";

const MAX_GRAPH_NODES = 100_000;
const MAX_GRAPH_EDGES = 200_000;
const countSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

/** Default hard bounds for one local JavaScript application analysis. */
export const JAVASCRIPT_APPLICATION_ANALYSIS_DEFAULT_LIMITS = {
  max_entries: 8_000,
  max_total_artifact_bytes: 512 * 1_024 * 1_024,
  max_artifact_entry_bytes: 128 * 1_024 * 1_024,
  max_compression_ratio: 1_000,
  max_depth: 64,
  max_path_bytes: 4_096,
  max_text_files: 5_000,
  max_total_text_bytes: 128 * 1_024 * 1_024,
  max_text_file_bytes: 8 * 1_024 * 1_024,
  max_ast_nodes: 2_000_000,
  max_findings: 8_000,
  max_modules: 20_000,
  max_source_map_sources: 5_000,
  max_parse_milliseconds: 30_000,
} as const;

/** Combined artifact, text, AST, and graph projection bounds. */
export const javascriptApplicationAnalysisLimitsSchema = z
  .strictObject({
    max_entries: z.number().int().min(1).max(1_000_000).default(8_000),
    max_total_artifact_bytes: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(512 * 1_024 * 1_024),
    max_artifact_entry_bytes: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(128 * 1_024 * 1_024),
    max_compression_ratio: z.number().min(1).max(100_000).default(1_000),
    max_depth: z.number().int().min(1).max(100).default(64),
    max_path_bytes: z.number().int().min(1).max(65_535).default(4_096),
    max_text_files: z.number().int().min(1).max(100_000).default(5_000),
    max_total_text_bytes: z
      .number()
      .int()
      .min(1)
      .max(512 * 1_024 * 1_024)
      .default(128 * 1_024 * 1_024),
    max_text_file_bytes: z
      .number()
      .int()
      .min(1)
      .max(64 * 1_024 * 1_024)
      .default(8 * 1_024 * 1_024),
    max_ast_nodes: z.number().int().min(1).max(20_000_000).default(2_000_000),
    max_findings: z.number().int().min(1).max(200_000).default(8_000),
    max_modules: z.number().int().min(1).max(100_000).default(20_000),
    max_source_map_sources: z.number().int().min(1).max(100_000).default(5_000),
    max_parse_milliseconds: z
      .number()
      .int()
      .min(1)
      .max(300_000)
      .default(30_000),
  })
  .superRefine((limits, context) => {
    const projectedNodes =
      7 * limits.max_entries +
      2 * limits.max_findings +
      limits.max_modules +
      limits.max_source_map_sources +
      1;
    if (projectedNodes > MAX_GRAPH_NODES)
      context.addIssue({
        code: "custom",
        path: ["max_entries"],
        message:
          "Combined application-analysis limits can exceed the 100000-node graph contract",
      });
    const projectedEdges =
      9 * limits.max_entries +
      6 * limits.max_findings +
      limits.max_modules +
      limits.max_source_map_sources;
    if (projectedEdges > MAX_GRAPH_EDGES)
      context.addIssue({
        code: "custom",
        path: ["max_entries"],
        message:
          "Combined application-analysis limits can exceed the 200000-edge graph contract",
      });
  });

/** Public target-free request for bounded static JavaScript application analysis. */
export const analyzeJavaScriptApplicationInputSchema = z.strictObject({
  input_path: z
    .string()
    .min(1)
    .max(16_384)
    .refine(isAbsolute, "JavaScript application input path must be absolute"),
  format: z.enum(["auto", "asar", "directory"]).default("auto"),
  approved: z.literal(true),
  source_map_read_approved: z.boolean().default(false),
  limits: javascriptApplicationAnalysisLimitsSchema.default(
    JAVASCRIPT_APPLICATION_ANALYSIS_DEFAULT_LIMITS,
  ),
});

/** Compact counts for the high-level Electron architecture/security surface. */
const electronBoundarySummarySchema = z.strictObject({
  browser_windows: countSchema,
  explicit_web_preferences: countSchema,
  preload_entrypoints: countSchema,
  context_bridge_apis: countSchema,
  exposed_api_members: countSchema,
  ipc: z.strictObject({
    operations: countSchema,
    literal_channels: countSchema,
    dynamic_channel_operations: countSchema,
    renderer_transmissions: countSchema,
    renderer_listeners: countSchema,
    main_handlers: countSchema,
    paired_renderer_transmissions: countSchema,
    ambiguous_renderer_transmissions: countSchema,
    unpaired_literal_renderer_transmissions: countSchema,
  }),
  sender_validation_observations: countSchema,
  utility_processes: countSchema,
  resolved_utility_entrypoints: countSchema,
  native_addon_bindings: countSchema,
  resolved_native_addon_bindings: countSchema,
});

const reconstructionStatisticsSchema = z.strictObject({
  relevant_files: countSchema,
  nested_asar_containers: countSchema,
  text_files_selected: countSchema,
  text_bytes_read: countSchema,
  omitted_text_files: countSchema,
  limit_omitted_text_files: countSchema,
  policy_filtered_text_files: countSchema,
  invalid_utf8_files: countSchema,
  parsed_javascript_files: countSchema,
  visited_ast_nodes: countSchema,
  findings: countSchema,
  modules: countSchema,
  parse_failures: countSchema,
  truncated_scopes: countSchema,
});

/** Strict high-level result returned inside Evidence v2. */
export const javascriptApplicationAnalysisResultSchema = z.strictObject({
  schema_version: z.literal(1),
  input_path: z.string().min(1).max(16_384),
  format: z.enum(["asar", "directory"]),
  root_artifact_sha256: digestSchema,
  inventory_manifest_id: z.string().regex(/^agm_[a-f0-9]{64}$/u),
  inventory_graph_sha256: digestSchema,
  graph: javascriptApplicationGraphSchema,
  summary: electronBoundarySummarySchema,
  statistics: reconstructionStatisticsSchema,
  limitations: z.array(z.string().min(1).max(4_096)).max(1_000),
});

/** Parsed public JavaScript application analysis request. */
export type AnalyzeJavaScriptApplicationInput = z.infer<
  typeof analyzeJavaScriptApplicationInputSchema
>;

/** Validated high-level JavaScript application analysis result. */
export type JavaScriptApplicationAnalysisResult = z.infer<
  typeof javascriptApplicationAnalysisResultSchema
>;

/** Validated high-level Electron boundary counts. */
export type ElectronBoundarySummary = z.infer<
  typeof electronBoundarySummarySchema
>;
