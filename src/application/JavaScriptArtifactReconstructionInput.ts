import { z } from "zod";

import type { ArtifactLimits } from "../artifacts/ArtifactReader.js";

const MAX_GRAPH_NODES = 100_000;
const MAX_GRAPH_EDGES = 200_000;

const reconstructionLimitsSchema = z
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
    max_findings: z.number().int().min(1).max(200_000).default(10_000),
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
      limits.max_findings +
      limits.max_modules +
      limits.max_source_map_sources +
      1;
    if (projectedNodes > MAX_GRAPH_NODES)
      context.addIssue({
        code: "custom",
        path: ["max_entries"],
        message:
          "Combined reconstruction limits can exceed the 100000-node graph contract",
      });
    const projectedEdges =
      9 * limits.max_entries +
      5 * limits.max_findings +
      limits.max_modules +
      limits.max_source_map_sources;
    if (projectedEdges > MAX_GRAPH_EDGES)
      context.addIssue({
        code: "custom",
        path: ["max_entries"],
        message:
          "Combined reconstruction limits can exceed the 200000-edge graph contract",
      });
  });

/** Local ASAR/directory reconstruction request with explicit source-map authority. */
export const javascriptArtifactReconstructionInputSchema = z.strictObject({
  input_path: z.string().min(1).max(16_384),
  format: z.enum(["auto", "asar", "directory"]).default("auto"),
  source_map_read_approved: z.boolean().default(false),
  limits: reconstructionLimitsSchema.default({
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
    max_findings: 10_000,
    max_modules: 20_000,
    max_source_map_sources: 5_000,
    max_parse_milliseconds: 30_000,
  }),
});

/** Parsed bounded reconstruction request. */
export type JavaScriptArtifactReconstructionInput = z.infer<
  typeof javascriptArtifactReconstructionInputSchema
>;

/** Project reconstruction limits into the shared artifact traversal policy. */
export const artifactLimitsForReconstruction = (
  input: JavaScriptArtifactReconstructionInput,
): ArtifactLimits => ({
  maxEntries: input.limits.max_entries,
  maxTotalBytes: input.limits.max_total_artifact_bytes,
  maxEntryBytes: input.limits.max_artifact_entry_bytes,
  maxCompressionRatio: input.limits.max_compression_ratio,
  maxDepth: input.limits.max_depth,
  maxPathBytes: input.limits.max_path_bytes,
});
