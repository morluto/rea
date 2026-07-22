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
const EXAMPLE_EVIDENCE_ID = `ev_${"0".repeat(64)}`;
const SECOND_EXAMPLE_EVIDENCE_ID = `ev_${"1".repeat(64)}`;
const TRACE_SEED = {
  kind: "module" as const,
  value: "renderer.js",
  match: "exact" as const,
  case_sensitive: false,
};

/** Natural trace request using the Evidence ID returned by its producer. */
export const JAVASCRIPT_FEATURE_TRACE_EXAMPLE = {
  application_evidence_id: EXAMPLE_EVIDENCE_ID,
  seed: TRACE_SEED,
  direction: "both" as const,
};

/** Natural version comparison using two producer-returned Evidence IDs. */
export const JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE = {
  left_evidence_id: EXAMPLE_EVIDENCE_ID,
  right_evidence_id: SECOND_EXAMPLE_EVIDENCE_ID,
};

/** Exact static return-shape comparison using producer-returned Evidence IDs. */
export const JAVASCRIPT_EXPORT_SHAPE_COMPARISON_EXAMPLE = {
  left_evidence_id: EXAMPLE_EVIDENCE_ID,
  right_evidence_id: SECOND_EXAMPLE_EVIDENCE_ID,
  left_module_path: "parser.mjs",
  left_export_name: "default",
  right_module_path: "parser.mjs",
  right_export_name: "default",
};

/** Full-Evidence compatibility fixture used by pure domain and adapter tests. */
export const JAVASCRIPT_FEATURE_TRACE_FULL_EVIDENCE_EXAMPLE = {
  application: JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE,
  seed: TRACE_SEED,
  direction: "both" as const,
};

/** Full-Evidence compatibility comparison fixture. */
export const JAVASCRIPT_VERSION_COMPARISON_FULL_EVIDENCE_EXAMPLE = {
  left: JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE,
  right: reconciliationEvidence,
};
