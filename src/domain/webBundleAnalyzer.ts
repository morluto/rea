import type { JavaScriptSemanticPrecisionInput } from "./javascript/javascriptSemanticPrecision.js";
import { analyzeScript } from "./webBundleAnalyzerInspection.js";
import type { JsonValue } from "./jsonValue.js";
import {
  retainLiteralCandidatesWithinResultBudget,
  webBundleEndpointLiteralLimit,
  type WebBundleEndpointLiteralAdmission,
} from "./webBundleEndpointLiteralBudget.js";
import {
  createWebBundleAnalysisAccumulator,
  type IncludedScript,
} from "./webBundleAnalyzerState.js";
import {
  webBundleScriptAnalysisSchema,
  type WebBundleScriptAnalysis,
} from "./webBundleScriptAnalysis.js";

/** Analyze one selected captured script without executing its source. */
export const analyzeCapturedWebScript = (
  script: IncludedScript,
  precision?: JavaScriptSemanticPrecisionInput,
  endpointLiterals?: WebBundleEndpointLiteralAdmission,
  resultBudgetBytes?: number,
): WebBundleScriptAnalysis => {
  const accumulator = createWebBundleAnalysisAccumulator(endpointLiterals);
  const routeFacts = analyzeScript(script, accumulator, precision);
  const failed = accumulator.failedScripts.length > 0;
  const recovered = accumulator.recoveredScripts.length > 0;
  const stableFacts = {
    status: "analyzed" as const,
    script_key: script.script_key,
    parse_status: failed ? "failed" : recovered ? "recovered" : "parsed",
    visited_ast_nodes: accumulator.visitedNodes,
    widened_return_references: accumulator.widenedScripts.length > 0,
    observations: {
      edges: accumulator.edges,
      routes: accumulator.routes,
      endpoints: accumulator.endpoints,
      webmcp_declarations: accumulator.webMcp,
    },
  };
  // Route facts stay out of this measurement. The worker fits that optional
  // facet into whatever result budget remains after these facts.
  const fitted =
    resultBudgetBytes === undefined
      ? {
          inferences: accumulator.inferences,
          admittedCount: accumulator.endpointLiteralAdmitted,
          omittedCount: accumulator.endpointLiteralOmitted,
        }
      : retainLiteralCandidatesWithinResultBudget(
          stableFacts as unknown as JsonValue,
          accumulator.inferences,
          accumulator.endpointLiterals,
          accumulator.endpointLiteralAdmitted,
          accumulator.endpointLiteralOmitted,
          resultBudgetBytes,
        );
  const endpointLiteralCandidates = webBundleEndpointLiteralLimit(
    accumulator.endpointLiterals,
    fitted.admittedCount,
    fitted.omittedCount,
  );
  return webBundleScriptAnalysisSchema.parse({
    ...stableFacts,
    route_facts: routeFacts,
    inferences: fitted.inferences,
    ...(endpointLiteralCandidates === undefined
      ? {}
      : { endpoint_literal_candidates: endpointLiteralCandidates }),
  });
};
