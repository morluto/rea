import {
  createEvidence,
  type Evidence,
  type EvidenceObservation,
} from "../domain/evidence.js";
import type {
  AnalyzeJavaScriptApplicationInput,
  JavaScriptApplicationAnalysisResult,
} from "../domain/javascriptApplicationAnalysis.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { JAVASCRIPT_APPLICATION_PROVIDER } from "./InvestigationProviders.js";

/** Create Evidence v2 for one deterministic local JavaScript application graph. */
export const createJavaScriptApplicationEvidence = (
  input: AnalyzeJavaScriptApplicationInput,
  result: JavaScriptApplicationAnalysisResult,
): Evidence =>
  createEvidence(
    {
      path: result.input_path,
      sha256: result.root_artifact_sha256,
      format: result.format,
    },
    JAVASCRIPT_APPLICATION_PROVIDER,
    {
      predicateType: "rea.javascript-application-analysis/v1",
      operation: "analyze_javascript_application",
      parameters: parameters(input),
      result: jsonValueSchema.parse(result),
      rawResult: null,
      confidence: "derived",
      authority: "shipped-artifact",
      environment: null,
      limitations: result.limitations,
      locations: [{ kind: "artifact-path", path: "artifact-root" }],
    },
  );

const parameters = (
  input: AnalyzeJavaScriptApplicationInput,
): EvidenceObservation["parameters"] => ({
  format: input.format,
  approved: input.approved,
  source_map_read_approved: input.source_map_read_approved,
  limits: input.limits,
});
