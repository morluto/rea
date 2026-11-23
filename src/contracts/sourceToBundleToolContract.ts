import { z } from "zod";
import {
  sourceToBundlePageViewResultSchema,
  sourceToBundleSummaryViewResultSchema,
} from "../domain/analysisView/summarySchemas/sourceToBundleSummarySchemas.js";
import { sourceToBundleComparisonResultSchema } from "../domain/javascript/sourceToBundleComparisonSchemas.js";
import { compareSourceToBundleRequestSchema } from "./javascript/applicationWorkflowInputContracts.js";
import { SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE } from "./javascript/javascriptApplicationWorkflowExamples.js";
import type { ToolContract } from "./toolContractTypes.js";
import { evidenceEffects, toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";

const sourceToBundleOutputSchema = evidenceResultOf(
  z.union([
    sourceToBundleComparisonResultSchema,
    sourceToBundleSummaryViewResultSchema,
    sourceToBundlePageViewResultSchema,
  ]),
);

/** Standalone contract for lazy CLI registration of `compare-source-to-bundle`. */
export const COMPARE_SOURCE_TO_BUNDLE_TOOL_CONTRACT = {
  name: "compare_source_to_bundle",
  cli: true,
  ...toolContractMetadata("compare_source_to_bundle", evidenceEffects),
  description:
    'Map committed historical source to an authenticated JavaScript Application Graph. Supply HistoricalSourceGraph inline or as {kind:"file",path:"/absolute/source.json"}, and graph Evidence inline or retained. Uses explicit digest, source-map and path signals to classify unchanged, modified, removed, split, merged, duplicated or unknown; incomplete coverage and ambiguous weak matches never establish absence or force pairing. Candidate signals are opt-in. Omitted view returns the full report; view {kind:"summary"} or {kind:"source-to-bundle",collection:"mappings"} retains it for later inspect_analysis_view pages. Filters intersect, empty filters select none, and page coverage never upgrades source coverage.',
  kind: "application",
  inputSchema: compareSourceToBundleRequestSchema,
  outputSchema: sourceToBundleOutputSchema,
  examples: [
    {
      title: "Compare committed historical source with a shipped bundle graph",
      input: SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE,
    },
  ],
} as const satisfies ToolContract;
