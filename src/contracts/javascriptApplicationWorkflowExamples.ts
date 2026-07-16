import { createEvidence } from "../domain/evidence.js";
import { reconcileJavaScriptRuntime } from "../domain/javascriptRuntimeReconciliation.js";
import {
  JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE,
  JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE,
} from "./javascriptRuntimeReconciliationExample.js";

const reconciliation = reconcileJavaScriptRuntime(
  JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE,
);
const reconciliationEvidence = createEvidence(
  undefined,
  {
    id: "rea-javascript-runtime-reconciliation",
    name: "REA JavaScript runtime reconciliation",
    version: "1",
  },
  {
    predicateType: "rea.javascript-runtime-reconciliation/v1",
    operation: "reconcile_javascript_runtime",
    parameters: {
      static_layers:
        JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE.static_layers.map(
          ({ role, analysis }) => ({
            role,
            evidence_id: analysis.evidence_id,
            runtime_mappings: [],
          }),
        ),
      runtime_evidence_ids:
        JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE.runtime_observations.map(
          ({ evidence_id: id }) => id,
        ),
      limits: {
        max_runtime_entities: 10_000,
        max_reconciliation_items: 20_000,
        max_static_load_states: 20_000,
      },
    },
    result: reconciliation,
    confidence: "inferred",
    authority: "analyst-inference",
    limitations: reconciliation.limitations,
    evidenceLinks: reconciliation.evidence_links,
  },
);

/** Valid public trace request without proprietary artifacts. */
export const JAVASCRIPT_FEATURE_TRACE_EXAMPLE = {
  application: JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE,
  seed: {
    kind: "module" as const,
    value: "renderer.js",
    match: "exact" as const,
    case_sensitive: false,
  },
  direction: "both" as const,
};

/** Valid static/runtime graph pair demonstrating comparison authority. */
export const JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE = {
  left: JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE,
  right: reconciliationEvidence,
};
