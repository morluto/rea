import type { JavaScriptSemanticPrecisionInput } from "./javascript/javascriptSemanticPrecision.js";
import { fitJavaScriptRouteSourceFacts } from "./javascript/javascriptRouteResultBudget.js";
import type { JavaScriptRouteSourceFacts } from "./javascript/javascriptRouteFacts.js";
import { jsonValueByteLength } from "./jsonValueByteLength.js";
import type { JsonValue } from "./jsonValue.js";
import { analyzeScript } from "./webBundleAnalyzerInspection.js";
import {
  retainLiteralCandidatesWithinResultBudget,
  webBundleEndpointLiteralLimit,
  type WebBundleEndpointLiteralAdmission,
} from "./webBundleEndpointLiteralBudget.js";
import { isLiteralEndpointCandidate } from "./webBundleEndpointLiterals.js";
import {
  createWebBundleAnalysisAccumulator,
  type AnalysisAccumulator,
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
  // Checked route facts are reserved before optional path/URL literals. The
  // worker still owns the final route-fact prefix; this only keeps literals
  // from spending the bytes that prefix needs.
  const literalBudget =
    resultBudgetBytes === undefined
      ? undefined
      : resultBudgetBytes -
        reservedRouteFactBytes(
          routeFacts,
          stableFacts,
          accumulator.inferences,
          accumulator.endpointLiterals,
          accumulator.endpointLiteralOmitted,
          accumulator.endpointLiteralOmittedExact,
          resultBudgetBytes,
        );
  const fitted =
    literalBudget === undefined
      ? {
          inferences: accumulator.inferences,
          admittedCount: accumulator.endpointLiteralAdmitted,
          omittedByCount: accumulator.endpointLiteralOmitted,
          omittedByCountExact: accumulator.endpointLiteralOmittedExact,
          omittedByResultBudget: 0,
        }
      : retainLiteralCandidatesWithinResultBudget(
          stableFacts as unknown as JsonValue,
          accumulator.inferences,
          accumulator.endpointLiterals,
          accumulator.endpointLiteralOmitted,
          accumulator.endpointLiteralOmittedExact,
          literalBudget,
        );
  const endpointLiteralCandidates = webBundleEndpointLiteralLimit(
    accumulator.endpointLiterals,
    fitted.admittedCount,
    fitted.omittedByCount,
    fitted.omittedByResultBudget,
    fitted.omittedByCountExact,
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

const ROUTE_FACTS_MEMBER_PREFIX = ',"route_facts":';

/**
 * Bytes the worker will need for the route-fact prefix that fits beside the
 * non-literal facts. Literal records pay for their own omission metadata.
 */
const reservedRouteFactBytes = (
  routeFacts: JavaScriptRouteSourceFacts | null,
  stableFacts: object,
  inferences: AnalysisAccumulator["inferences"],
  admission: WebBundleEndpointLiteralAdmission,
  omittedByCount: number,
  omittedByCountExact: boolean,
  resultBudgetBytes: number,
): number => {
  if (routeFacts === null) return 0;
  const countLimit = webBundleEndpointLiteralLimit(
    admission,
    0,
    omittedByCount,
    0,
    omittedByCountExact,
  );
  const base = {
    ...(stableFacts as object),
    inferences: inferences.filter((item) => !isLiteralEndpointCandidate(item)),
    ...(countLimit === undefined
      ? {}
      : { endpoint_literal_candidates: countLimit }),
  };
  const prefix = Buffer.byteLength(ROUTE_FACTS_MEMBER_PREFIX);
  const available =
    resultBudgetBytes -
    jsonValueByteLength(base as unknown as JsonValue) -
    prefix;
  const reserved = fitJavaScriptRouteSourceFacts(routeFacts, available);
  if (reserved === undefined) return 0;
  return jsonValueByteLength(reserved as unknown as JsonValue) + prefix;
};
