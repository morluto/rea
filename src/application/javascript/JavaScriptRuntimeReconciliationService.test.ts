import { expect, it } from "vitest";
import {
  createEvidence,
  parseEvidence,
  type Evidence,
} from "../../domain/evidence.js";
import { JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE } from "../../contracts/javascript/javascriptRuntimeReconciliationExample.js";
import { javascriptRuntimeReconciliationResultSchema } from "../../domain/javascript/javascriptRuntimeReconciliationSchemas.js";
import { electronPageInspectionSchema } from "../../domain/javascript/electronObservation.js";
import {
  electronRuntimeEvidence,
  SOURCE,
} from "../../../tests/fixtures/javascriptRuntimeReconciliation.js";
import { reconcileJavaScriptRuntimeEvidence } from "./JavaScriptRuntimeReconciliationService.js";

const reconcile = (observations: readonly Evidence[]) => {
  const result = reconcileJavaScriptRuntimeEvidence({
    static_layers: JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE.static_layers,
    runtime_observations: observations,
  });
  if (!result.ok) throw result.error;
  const evidence = parseEvidence(result.value.evidence);
  return {
    evidence,
    sources: result.value.sources,
    result: javascriptRuntimeReconciliationResultSchema.parse(
      evidence.normalized_result,
    ),
  };
};

it("keeps equal runtime payloads at distinct selected endpoints separate through service graph Evidence", () => {
  const first = electronRuntimeEvidence("/synthetic", SOURCE);
  const second = createEvidence(undefined, first.provider, {
    predicateType: first.predicate_type,
    operation: first.operation,
    parameters: { ...first.parameters, cdp_endpoint: "http://127.0.0.1:9444" },
    confidence: first.confidence,
    authority: first.authority,
    result: first.normalized_result,
  });
  const observed = reconcile([first, second]);
  expect(observed.result.graph.coverage).toMatchObject({
    status: "complete",
    truncated: false,
    omitted_count: 0,
  });
  const runtime = observed.result.graph.nodes.filter(
    ({ identity }) => identity.strategy === "runtime-instance",
  );
  expect(runtime).toHaveLength(8);
  expect(new Set(runtime.map(({ node_id }) => node_id)).size).toBe(8);
  expect(
    new Set(
      runtime.map(({ identity }) =>
        identity.strategy === "runtime-instance" ? identity.capture_sha256 : "",
      ),
    ).size,
  ).toBe(1);
  for (const node of runtime) {
    if (node.identity.strategy !== "runtime-instance")
      throw new Error("Expected runtime instance");
    expect([first.evidence_id, second.evidence_id]).toContain(
      node.identity.capture_evidence_id,
    );
    for (const observation of node.observations)
      expect(observation.evidence.evidence_ids).toContain(
        node.identity.capture_evidence_id,
      );
  }
  expect(observed.evidence.parameters.runtime_evidence_ids).toEqual([
    first.evidence_id,
    second.evidence_id,
  ]);
  expect(observed.sources).toContainEqual(first);
  expect(observed.sources).toContainEqual(second);
});

it("preserves attach-limited frame and worker coverage through service graph Evidence", () => {
  const first = electronRuntimeEvidence("/synthetic", SOURCE);
  const inspection = electronPageInspectionSchema.parse(
    first.normalized_result,
  );
  const capture = createEvidence(undefined, first.provider, {
    predicateType: first.predicate_type,
    operation: first.operation,
    parameters: first.parameters,
    confidence: first.confidence,
    authority: first.authority,
    result: {
      ...inspection,
      completeness: {
        ...inspection.completeness,
        status: "attach_limited",
        conditions: ["attach_limited"],
        attach_limited_sections: ["frames", "workers"],
      },
    },
  });
  const { result } = reconcile([capture]);
  const runtime = result.graph.nodes.filter(
    ({ identity }) => identity.strategy === "runtime-instance",
  );
  expect(runtime).toHaveLength(4);
  for (const node of runtime) {
    const partial = node.kind === "frame" || node.kind === "worker";
    for (const observation of node.observations)
      expect(observation.evidence.coverage).toMatchObject({
        status: partial ? "partial" : "complete",
        truncated: false,
        omitted_count: partial ? null : 0,
      });
    for (const edge of result.graph.edges.filter(
      ({ target_node_id }) => target_node_id === node.node_id,
    ))
      if (edge.evidence.authority === "passive-cdp-runtime")
        expect(edge.evidence.coverage).toMatchObject({
          status: partial ? "partial" : "complete",
          truncated: false,
          omitted_count: partial ? null : 0,
        });
  }
  expect(result.graph.coverage).toMatchObject({
    status: "partial",
    truncated: false,
    omitted_count: null,
  });
});

it("preserves unresolved Inspector target location reason through service Evidence", () => {
  const evidence = createEvidence(
    undefined,
    {
      id: "rea-v8-inspector",
      name: "REA passive Node/Electron V8 Inspector provider",
      version: "1",
    },
    {
      predicateType: "rea.javascript-runtime-observation",
      operation: "observe_javascript_runtime",
      parameters: {
        inspector_endpoint: "http://127.0.0.1:9229",
        target_id: "node-main",
        observation_ms: 0,
      },
      authority: "external-service",
      confidence: "observed",
      result: {
        runtime: {
          product: "node/fixture",
          protocol_version: "1.1",
          v8_version: null,
        },
        target: {
          target_id: "node-main",
          protocol_type: "node",
          attached: null,
          location: {
            kind: "unresolved",
            reported_url: "file:///operator-selected.js",
            reason: "location-authorization-not-attempted",
          },
          runtime_kind: "unknown",
          runtime_kind_authority: "not-declared",
        },
        capture: {
          observation_ms: 0,
          events_observed: 0,
          events_retained: 0,
          events_dropped: 0,
          metadata_bytes_retained: 0,
          truncated: false,
          truncation_reasons: [],
        },
        scripts: {
          items: [],
          observed_total: 0,
          excluded: { unsupported_location: 0, invalid_protocol_value: 0 },
        },
        execution_contexts: [],
        directly_observed: [],
        unavailable_without_instrumentation: [],
        unknowns: [],
        limitations: [],
      },
    },
  );
  const projected = reconcile([evidence]);
  expect(
    projected.result.graph.nodes.find(
      ({ kind, identity }) =>
        kind === "target" && identity.strategy === "runtime-instance",
    )?.observations[0]?.properties,
  ).toMatchObject({
    reported_url: "file:///operator-selected.js",
    location_kind: "unresolved",
    location_reason: "location-authorization-not-attempted",
  });
});
