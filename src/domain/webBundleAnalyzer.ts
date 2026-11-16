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

/**
 * Analyze one selected captured script without executing its source. A script
 * whose member-mutation phase is refused keeps its parse status and text
 * inferences; the caller states the refusal and its recovery.
 */
export const analyzeCapturedWebScript = (
  script: IncludedScript,
  precision?: JavaScriptSemanticPrecisionInput,
  memberMutationAllowance?: JavaScriptMemberMutationAllowance,
): WebBundleScriptAnalysis => {
  const accumulator = createWebBundleAnalysisAccumulator();
  let routeFacts: ReturnType<typeof analyzeScript>;
  try {
    routeFacts = analyzeScript(
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
  return webBundleScriptAnalysisSchema.parse({
    status: "analyzed",
    script_key: script.script_key,
    parse_status: failed ? "failed" : recovered ? "recovered" : "parsed",
    visited_ast_nodes: accumulator.visitedNodes,
    widened_return_references: accumulator.widenedScripts.length > 0,
    route_facts: routeFacts,
    observations: {
      edges: accumulator.edges,
      routes: accumulator.routes,
      endpoints: accumulator.endpoints,
      webmcp_declarations: accumulator.webMcp,
      unresolved_endpoints: accumulator.unresolvedEndpoints,
    },
    inferences: accumulator.inferences,
  });
};
