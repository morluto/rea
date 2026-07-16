import {
  createEvidence,
  type Evidence,
  type EvidenceObservation,
} from "../domain/evidence.js";
import type {
  JavaScriptRuntimeReconciliationResult,
  ReconcileJavaScriptRuntimeInput,
} from "../domain/javascriptRuntimeReconciliationSchemas.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { JAVASCRIPT_RUNTIME_RECONCILIATION_PROVIDER } from "./InvestigationProviders.js";

/** Create derived Evidence v2 for one exact set of static/runtime inputs. */
export const createJavaScriptRuntimeReconciliationEvidence = (
  input: ReconcileJavaScriptRuntimeInput,
  result: JavaScriptRuntimeReconciliationResult,
): Evidence =>
  createEvidence(undefined, JAVASCRIPT_RUNTIME_RECONCILIATION_PROVIDER, {
    predicateType: "rea.javascript-runtime-reconciliation/v1",
    operation: "reconcile_javascript_runtime",
    parameters: parameters(input),
    result: jsonValueSchema.parse(result),
    rawResult: null,
    confidence: "inferred",
    authority: "analyst-inference",
    environment: null,
    limitations: result.limitations,
    evidenceLinks: result.evidence_links,
  });

const parameters = (
  input: ReconcileJavaScriptRuntimeInput,
): EvidenceObservation["parameters"] => ({
  static_layers: input.static_layers.map((layer) => ({
    role: layer.role,
    evidence_id: layer.analysis.evidence_id,
    runtime_mappings: layer.runtime_mappings,
  })),
  runtime_evidence_ids: input.runtime_observations.map(
    ({ evidence_id: id }) => id,
  ),
  limits: input.limits,
});
