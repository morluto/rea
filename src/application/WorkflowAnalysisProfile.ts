import type { AnalysisOperation } from "./AnalysisProvider.js";
import {
  createAnalysisProfile,
  type AnalysisProfileCommitment,
} from "../domain/analysisProfile.js";
import { REA_WORKFLOW_PROVIDER } from "../domain/investigationProviders.js";

/** Commit a workflow result to its upstream profile and applicable semantic revision. */
export const workflowAnalysisProfile = (
  upstream: AnalysisProfileCommitment,
  operation?: AnalysisOperation,
): AnalysisProfileCommitment =>
  createAnalysisProfile(
    REA_WORKFLOW_PROVIDER,
    workflowAnalysisProfileParameters(upstream, operation),
  );

/** The owned profile shape, with null allowed when estimating its envelope. */
export const workflowAnalysisProfileParameters = (
  upstream: AnalysisProfileCommitment | null,
  operation?: AnalysisOperation,
) => ({
  upstream_analysis_profile: upstream,
  source_limitations: "provider-operation-caveats-v1",
  ...(operation === "binary_overview"
    ? { workflow_revision: 5 }
    : operation === "batch_decompile"
      ? { workflow_revision: 4 }
      : operation === "trace_feature"
        ? { workflow_revision: 4 }
        : operation === "get_call_graph"
          ? { workflow_revision: 3 }
          : { workflow_revision: 1 }),
});
