import {
  createAnalysisProfile,
  type AnalysisProfileCommitment,
} from "../domain/analysisProfile.js";

/** Provider identity for deterministic composed analysis workflows. */
export const REA_WORKFLOW_PROVIDER = {
  id: "rea-workflow",
  name: "REA composed investigation workflow",
  version: "1",
} as const;

/** Commit a workflow result to the exact upstream deep-analysis profile. */
export const workflowAnalysisProfile = (
  upstream: AnalysisProfileCommitment,
): AnalysisProfileCommitment =>
  createAnalysisProfile(REA_WORKFLOW_PROVIDER, 1, {
    upstream_analysis_profile: upstream,
  });

/** Provider identity for deterministic artifact inventories. */
export const ARTIFACT_GRAPH_PROVIDER = {
  id: "rea-artifact-graph",
  name: "REA safe artifact graph provider",
  version: "1",
} as const;

/** Provider identity for execution-free managed PE/CLI analysis. */
export const MANAGED_STATIC_PROVIDER = {
  id: "rea-dotnet-static",
  name: "REA managed static analysis provider",
  version: "1",
} as const;

/** Provider identity for deterministic managed-code comparison workflows. */
export const MANAGED_WORKFLOW_PROVIDER = {
  id: "rea-dotnet-workflows",
  name: "REA managed-code workflows",
  version: "1",
} as const;

/** Provider identity for deterministic Apple application projections. */
export const APPLE_APPLICATION_PROVIDER = {
  id: "rea-apple-application",
  name: "REA Apple application workflows",
  version: "1",
} as const;

/** Provider identity for deterministic Android application projections. */
export const ANDROID_APPLICATION_PROVIDER = {
  id: "rea-android-application",
  name: "REA Android application workflows",
  version: "1",
} as const;

export const RUNTIME_IDENTIFICATION_PROVIDER = {
  id: "rea-runtime-identification",
  name: "REA runtime identification",
  version: "1",
} as const;

/** Provider identity for deterministic static JavaScript application analysis. */
export const JAVASCRIPT_APPLICATION_PROVIDER = {
  id: "rea-javascript-application",
  name: "REA JavaScript application analyzer",
  version: "1",
} as const;

/** Provider identity for static/passive-runtime JavaScript reconciliation. */
export const JAVASCRIPT_RUNTIME_RECONCILIATION_PROVIDER = {
  id: "rea-javascript-runtime-reconciliation",
  name: "REA JavaScript runtime reconciliation",
  version: "1",
} as const;

/** Provider identity for graph-native feature tracing and version comparison. */
export const JAVASCRIPT_APPLICATION_WORKFLOW_PROVIDER = {
  id: "rea-javascript-application-workflows",
  name: "REA JavaScript application workflows",
  version: "1",
} as const;

/** Provider identity for deterministic cross-artifact comparisons. */
export const ARTIFACT_COMPARISON_PROVIDER = {
  id: "rea-artifact-comparison",
  name: "REA artifact comparison",
  version: "1",
} as const;

/** Provider identity for deterministic cross-function comparisons. */
export const FUNCTION_COMPARISON_PROVIDER = {
  id: "rea-function-comparison",
  name: "REA function comparison",
  version: "1",
} as const;

/** Provider identity for deterministic Evidence bundle comparisons. */
export const BUNDLE_COMPARISON_PROVIDER = {
  id: "rea-bundle-comparison",
  name: "REA Evidence bundle comparison",
  version: "1",
} as const;

/** Provider identity for comparison-Evidence behavior aggregation. */
export const CHANGED_BEHAVIOR_PROVIDER = {
  id: "rea-changed-behavior",
  name: "REA changed behavior investigation",
  version: "1",
} as const;

/** Provider identity for Evidence-backed call-path reconstruction. */
export const CALL_PATH_PROVIDER = {
  id: "rea-call-path",
  name: "REA call path reconstruction",
  version: "1",
} as const;

/** Provider identity for explicit static/runtime hypothesis correlation. */
export const STATIC_RUNTIME_PROVIDER = {
  id: "rea-static-runtime-correlation",
  name: "REA static/runtime correlation",
  version: "1",
} as const;

/** Provider identity for finite reconstruction specification verification. */
export const RECONSTRUCTION_PROVIDER = {
  id: "rea-reconstruction-verifier",
  name: "REA reconstruction verifier",
  version: "1",
} as const;
