import { expect, test } from "vitest";
import { reconcileJavaScriptRuntimeEvidence } from "../../../src/application/javascript/JavaScriptRuntimeReconciliationService.js";
import { javascriptRuntimeReconciliationResultSchema } from "../../../src/domain/javascript/javascriptRuntimeReconciliationSchemas.js";
import { nodeReconciliationFixture } from "../../fixtures/nodeRuntimeReconciliation.js";

test("attributes loaded script state to the reported Node script", () => {
  const reconciled = reconcileJavaScriptRuntimeEvidence(
    nodeReconciliationFixture(true),
  );
  if (!reconciled.ok) throw reconciled.error;
  const result = javascriptRuntimeReconciliationResultSchema.parse(
    reconciled.value.evidence.normalized_result,
  );
  const asset = result.graph.nodes.find(
    ({ kind, observations }) =>
      kind === "javascript-asset" &&
      observations.some(({ properties }) => properties.path === "renderer.js"),
  );
  if (asset === undefined) throw new Error("Missing fixture renderer asset");
  const target = result.reconciliations.find(
    ({ entity_kind }) => entity_kind === "target",
  );
  const script = result.reconciliations.find(
    ({ entity_kind }) => entity_kind === "script",
  );
  expect(target).toMatchObject({
    status: "matched",
    static_node_id: asset.node_id,
  });
  expect(script).toMatchObject({
    status: "matched",
    static_node_id: asset.node_id,
  });
  expect(script?.runtime_node_id).not.toBe(target?.runtime_node_id);
  expect(
    result.static_load_states.find(
      ({ static_node_id }) => static_node_id === asset.node_id,
    ),
  ).toMatchObject({
    status: "loaded",
    reason: "runtime-script-correspondence",
    runtime_node_ids: [script?.runtime_node_id],
  });
  expect(result.summary).toMatchObject({
    runtime_scripts: 1,
    static_loaded: 1,
    static_not_observed: 0,
  });
});
