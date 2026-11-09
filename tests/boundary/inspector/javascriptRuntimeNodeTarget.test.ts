import { expect, test } from "vitest";
import { reconcileJavaScriptRuntimeEvidence } from "../../../src/application/javascript/JavaScriptRuntimeReconciliationService.js";
import { javascriptRuntimeReconciliationResultSchema } from "../../../src/domain/javascript/javascriptRuntimeReconciliationSchemas.js";
import { nodeReconciliationFixture } from "../../fixtures/nodeRuntimeReconciliation.js";

test.each([false, true])(
  "matches a synthetic Node entry target without inventing script presence: %s",
  (scriptObserved) => {
    const reconciled = reconcileJavaScriptRuntimeEvidence(
      nodeReconciliationFixture(scriptObserved),
    );
    if (!reconciled.ok) throw reconciled.error;
    const result = javascriptRuntimeReconciliationResultSchema.parse(
      reconciled.value.evidence.normalized_result,
    );
    const target = result.reconciliations.find(
      ({ entity_kind }) => entity_kind === "target",
    );
    expect(target).toMatchObject({
      status: "matched",
      basis: "artifact-path",
      confidence: "medium",
      reason: "unique-location-match",
      candidate_static_count: 1,
    });
    expect(
      result.graph.nodes.find(
        ({ node_id }) => node_id === target?.static_node_id,
      )?.kind,
    ).toBe("javascript-asset");
    expect(result.summary).toMatchObject({
      runtime_scripts: scriptObserved ? 1 : 0,
      static_loaded: scriptObserved ? 1 : 0,
      static_not_observed: 0,
    });
  },
);
