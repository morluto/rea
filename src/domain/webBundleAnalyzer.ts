import {
  isJavaScriptMemberMutationRefusal,
  type JavaScriptMemberMutationAllowance,
} from "./javascript/javascriptSemanticWorkAllowance.js";
import type { JavaScriptSemanticPrecisionInput } from "./javascript/javascriptSemanticPrecision.js";
import {
  analyzeScript,
  scriptTextInferences,
} from "./webBundleAnalyzerInspection.js";
import {
  createWebBundleAnalysisAccumulator,
  type IncludedScript,
} from "./webBundleAnalyzerState.js";
import {
  webBundleScriptAnalysisSchema,
  type WebBundleScriptAnalysis,
} from "./webBundleScriptAnalysis.js";
import {
  webBundleEndpointLiteralRecord,
  type WebBundleEndpointLiteralAdmission,
} from "./webBundleEndpointLiteralBudget.js";

/**
 * Analyze one selected captured script without executing its source. A script
 * whose member-mutation phase is refused keeps its parse status and text
 * inferences; the caller states the refusal and its recovery.
 */
export const analyzeCapturedWebScript = (
  script: IncludedScript,
  precision?: JavaScriptSemanticPrecisionInput,
  memberMutationAllowance?: JavaScriptMemberMutationAllowance,
  endpointLiterals?: WebBundleEndpointLiteralAdmission,
): WebBundleScriptAnalysis => {
  const accumulator = createWebBundleAnalysisAccumulator(endpointLiterals);
  let analysis: ReturnType<typeof analyzeScript>;
  try {
    analysis = analyzeScript(
      script,
      accumulator,
      precision,
      memberMutationAllowance,
    );
  } catch (cause: unknown) {
    if (!isJavaScriptMemberMutationRefusal(cause)) throw cause;
    // Findings gathered before the refusal may have read an incomplete
    // mutation index, so only facts that never read it are kept.
    return webBundleScriptAnalysisSchema.parse({
      status: "unavailable",
      script_key: script.script_key,
      reason: "resource_constraint",
      partial: {
        refused_phase: "member-mutations",
        parse_status:
          accumulator.recoveredScripts.length > 0 ? "recovered" : "parsed",
        inferences: scriptTextInferences(script),
      },
    });
  }
  const failed = accumulator.failedScripts.length > 0;
  const recovered = accumulator.recoveredScripts.length > 0;
  const literalCandidates = webBundleEndpointLiteralRecord(
    accumulator.endpointLiterals,
    accumulator.endpointLiteralAdmitted,
    {
      byCount: accumulator.endpointLiteralOmitted,
      byCountExact: accumulator.endpointLiteralOmittedExact,
    },
  );
  return webBundleScriptAnalysisSchema.parse({
    status: "analyzed",
    script_key: script.script_key,
    parse_status: failed ? "failed" : recovered ? "recovered" : "parsed",
    visited_ast_nodes: accumulator.visitedNodes,
    widened_return_references: accumulator.widenedScripts.length > 0,
    route_facts: analysis.routeFacts,
    ...(analysis.semanticLimits.length === 0
      ? {}
      : { semantic_limits: analysis.semanticLimits }),
    observations: {
      edges: accumulator.edges,
      routes: accumulator.routes,
      endpoints: accumulator.endpoints,
      webmcp_declarations: accumulator.webMcp,
      unresolved_endpoints: accumulator.unresolvedEndpoints,
    },
    inferences: accumulator.inferences,
    ...(literalCandidates === undefined
      ? {}
      : { endpoint_literal_candidates: literalCandidates }),
  });
};
