import { z } from "zod";

import type { ArtifactLimits } from "../artifacts/ArtifactReader.js";
import {
  JAVASCRIPT_APPLICATION_ANALYSIS_DEFAULT_LIMITS,
  javascriptApplicationAnalysisLimitsSchema,
} from "../domain/javascriptApplicationAnalysis.js";

/** Local ASAR/directory reconstruction request with explicit source-map authority. */
export const javascriptArtifactReconstructionInputSchema = z.strictObject({
  input_path: z.string().min(1).max(16_384),
  format: z.enum(["auto", "asar", "directory"]).default("auto"),
  source_map_read_approved: z.boolean().default(false),
  limits: javascriptApplicationAnalysisLimitsSchema.default(
    JAVASCRIPT_APPLICATION_ANALYSIS_DEFAULT_LIMITS,
  ),
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
