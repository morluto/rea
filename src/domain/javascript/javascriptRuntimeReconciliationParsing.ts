import { digestCanonicalValue } from "../canonicalDigest.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { parseEvidence, type Evidence } from "../evidence.js";
import {
  javascriptApplicationAnalysisResultSchema,
  type JavaScriptApplicationAnalysisResult,
} from "./javascriptApplicationAnalysis.js";
import type { JavaScriptApplicationGraph } from "./javascriptApplicationGraph.js";
import type { ReconcileJavaScriptRuntimeInput } from "./javascriptRuntimeReconciliationSchemas.js";
import {
  assertEvidenceIdentity,
  invalidInput,
  parseAtPath,
} from "./javascriptRuntimeReconciliationInputValidation.js";

type StaticLayerInput =
  ReconcileJavaScriptRuntimeInput["static_layers"][number];
type RuntimeMapping = StaticLayerInput["runtime_mappings"][number];

export interface ParsedStaticLayer {
  readonly layerId: string;
  readonly role: StaticLayerInput["role"];
  readonly evidence: Evidence;
  readonly result: JavaScriptApplicationAnalysisResult;
  readonly graph: JavaScriptApplicationGraph;
  readonly runtimeMappings: readonly RuntimeMapping[];
}

/** Parse and semantically bind every static analysis Evidence layer. */
export const parseStaticLayers = (
  layers: readonly StaticLayerInput[],
  path: readonly (string | number)[] = ["static_layers"],
): ParsedStaticLayer[] =>
  layers
    .map((layer, index) =>
      parseStaticLayer(layer, [...path, index, "analysis"]),
    )
    .sort((left, right) =>
      compareUnicodeCodePoints(left.layerId, right.layerId),
    );

const parseStaticLayer = (
  layer: StaticLayerInput,
  evidencePath: readonly (string | number)[],
): ParsedStaticLayer => {
  const evidence = parseAtPath(parseEvidence, layer.analysis, evidencePath);
  const result = parseAtPath(
    (value) => javascriptApplicationAnalysisResultSchema.parse(value),
    evidence.normalized_result,
    [...evidencePath, "normalized_result"],
  );
  assertEvidenceIdentity(
    evidence,
    {
      operation: "analyze_javascript_application",
      predicate: "rea.javascript-application-analysis",
      providerId: "rea-javascript-application",
      providerName: "REA JavaScript application analyzer",
      providerVersion: "1",
      authority: "shipped-artifact",
      confidence: "derived",
    },
    evidencePath,
  );
  if (
    evidence.subject === null ||
    evidence.subject.digest.sha256 !== result.root_artifact_sha256 ||
    evidence.subject.format !== result.format ||
    evidence.subject.local_path !== result.input_path
  )
    throw invalidInput(
      [...evidencePath, "subject"],
      "JavaScript application Evidence subject disagrees with its result",
    );
  return {
    layerId: `jrl_${digestCanonicalValue(
      {
        role: layer.role,
        evidence_id: evidence.evidence_id,
        runtime_mappings: layer.runtime_mappings,
      },
      "Runtime reconciliation",
    )}`,
    role: layer.role,
    evidence,
    result,
    graph: result.graph,
    runtimeMappings: layer.runtime_mappings,
  };
};
