import {
  JAVASCRIPT_APPLICATION_PROVIDER,
  JAVASCRIPT_RUNTIME_RECONCILIATION_PROVIDER,
  MANAGED_WORKFLOW_PROVIDER,
} from "./InvestigationProviders.js";
import { parseEvidence, type Evidence } from "../domain/evidence.js";
import {
  analyzeJavaScriptApplicationInputSchema,
  javascriptApplicationAnalysisResultSchema,
  type JavaScriptApplicationAnalysisResult,
} from "../domain/javascriptApplicationAnalysis.js";
import type { JavaScriptApplicationGraph } from "../domain/javascriptApplicationGraph.js";
import type { JavaScriptSemanticGraph } from "../domain/javascriptSemanticGraph.js";
import { javascriptRuntimeReconciliationResultSchema } from "../domain/javascriptRuntimeReconciliationSchemas.js";
import { managedApplicationGraphResultSchema } from "../domain/managedApplicationGraph.js";

/** Supported immutable source for an application-level graph workflow. */
export interface ApplicationGraphEvidenceSource {
  readonly evidence: Evidence;
  readonly graph: JavaScriptApplicationGraph;
  readonly kind:
    | "static-application"
    | "static-runtime-reconciliation"
    | "managed-application";
  readonly rootArtifactSha256: string;
  readonly semanticGraph: JavaScriptSemanticGraph | null;
}

/** Parse and authenticate one REA-produced JavaScript Application Graph Evidence. */
export const parseApplicationGraphEvidence = (
  input: unknown,
): ApplicationGraphEvidenceSource => {
  const evidence = parseEvidence(input);
  if (
    evidence.operation === "analyze_javascript_application" &&
    [
      "rea.javascript-application-analysis/v1",
      "rea.javascript-application-analysis/v2",
    ].includes(evidence.predicate_type) &&
    providerMatches(evidence, JAVASCRIPT_APPLICATION_PROVIDER)
  )
    return staticApplicationSource(evidence);
  if (
    evidence.operation === "reconcile_javascript_runtime" &&
    evidence.predicate_type === "rea.javascript-runtime-reconciliation/v1" &&
    providerMatches(evidence, JAVASCRIPT_RUNTIME_RECONCILIATION_PROVIDER)
  )
    return staticRuntimeSource(evidence);
  if (
    evidence.operation === "project_managed_application_graph" &&
    evidence.predicate_type === "rea.managed-application-graph/v1" &&
    providerMatches(evidence, MANAGED_WORKFLOW_PROVIDER)
  )
    return managedApplicationSource(evidence);
  throw new TypeError(
    "Application workflow requires authenticated analyze_javascript_application, reconcile_javascript_runtime, or project_managed_application_graph Evidence",
  );
};

const staticApplicationSource = (
  evidence: Evidence,
): ApplicationGraphEvidenceSource => {
  if (
    evidence.authority !== "shipped-artifact" ||
    evidence.confidence !== "derived"
  )
    throw new TypeError(
      "JavaScript application Evidence authority or confidence is invalid",
    );
  const result = javascriptApplicationAnalysisResultSchema.parse(
    evidence.normalized_result,
  );
  if (
    evidence.predicate_type !==
    `rea.javascript-application-analysis/v${String(result.schema_version)}`
  )
    throw new TypeError(
      "JavaScript application Evidence predicate does not match its result schema version",
    );
  analyzeJavaScriptApplicationInputSchema.parse({
    input_path: result.input_path,
    ...evidence.parameters,
  });
  assertApplicationSubject(evidence, result);
  return {
    evidence,
    graph: result.graph,
    kind: "static-application",
    rootArtifactSha256: result.root_artifact_sha256,
    semanticGraph: result.schema_version === 2 ? result.semantic_graph : null,
  };
};

const staticRuntimeSource = (
  evidence: Evidence,
): ApplicationGraphEvidenceSource => {
  if (
    evidence.authority !== "analyst-inference" ||
    evidence.confidence !== "inferred"
  )
    throw new TypeError(
      "JavaScript runtime reconciliation Evidence authority or confidence is invalid",
    );
  const result = javascriptRuntimeReconciliationResultSchema.parse(
    evidence.normalized_result,
  );
  if (
    result.evidence_links.some(
      (evidenceId) => !evidence.evidence_links.includes(evidenceId),
    )
  )
    throw new TypeError(
      "Runtime reconciliation result references Evidence outside its envelope",
    );
  const applicationLayer = result.static_layers.find(
    ({ role }) => role === "application",
  );
  if (applicationLayer === undefined)
    throw new TypeError("Runtime reconciliation application layer is missing");
  return {
    evidence,
    graph: result.graph,
    kind: "static-runtime-reconciliation",
    rootArtifactSha256: applicationLayer.root_artifact_sha256,
    semanticGraph: null,
  };
};

const managedApplicationSource = (
  evidence: Evidence,
): ApplicationGraphEvidenceSource => {
  if (
    evidence.authority !== "analyst-inference" ||
    evidence.confidence !== "inferred"
  )
    throw new TypeError(
      "Managed application graph Evidence authority or confidence is invalid",
    );
  const result = managedApplicationGraphResultSchema.parse(
    evidence.normalized_result,
  );
  if (
    result.evidence_links.some(
      (evidenceId) => !evidence.evidence_links.includes(evidenceId),
    )
  )
    throw new TypeError(
      "Managed application graph result references Evidence outside its envelope",
    );
  return {
    evidence,
    graph: result.graph,
    kind: "managed-application",
    rootArtifactSha256: result.root_artifact_sha256,
    semanticGraph: null,
  };
};

const assertApplicationSubject = (
  evidence: Evidence,
  result: JavaScriptApplicationAnalysisResult,
): void => {
  if (
    evidence.subject === null ||
    evidence.subject.digest.sha256 !== result.root_artifact_sha256 ||
    evidence.subject.format !== result.format
  )
    throw new TypeError(
      "JavaScript application Evidence subject does not match its result",
    );
};

const providerMatches = (
  evidence: Evidence,
  provider: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
  },
): boolean =>
  evidence.provider.id === provider.id &&
  evidence.provider.name === provider.name &&
  evidence.provider.version === provider.version;

/** Parse unique, artifact-bound Evidence that may extend a native handoff. */
export const parseNativeApplicationEvidence = (
  inputs: readonly unknown[],
): Evidence[] => {
  const parsed = inputs.map((input) => parseEvidence(input));
  if (parsed.some(({ subject }) => subject === null))
    throw new TypeError("Native handoff Evidence requires an artifact subject");
  const ids = parsed.map(({ evidence_id: id }) => id);
  if (new Set(ids).size !== ids.length)
    throw new TypeError("Native handoff Evidence must be unique");
  return parsed;
};
