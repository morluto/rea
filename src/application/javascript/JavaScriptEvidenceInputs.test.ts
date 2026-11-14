import { expect, it, vi } from "vitest";

import {
  createEvidence,
  parseEvidence,
  rebindEvidenceToTargetPath,
  type Evidence,
} from "../../domain/evidence.js";
import { ok } from "../../domain/result.js";
import { createJavaScriptApplicationGraph } from "../../domain/javascript/javascriptApplicationGraph.js";
import { createJavaScriptSemanticGraph } from "../../domain/javascript/javascriptSemanticGraph.js";
import { javascriptApplicationAnalysisResultSchema } from "../../domain/javascript/javascriptApplicationAnalysis.js";
import {
  JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
  JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
} from "../../contracts/javascript/javascriptApplicationWorkflowExamples.js";
import { JAVASCRIPT_EXPORT_SHAPE_COMPARISON_EXAMPLE } from "../../contracts/javascript/javascriptExportShapeComparisonExample.js";
import { JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE } from "../../contracts/javascript/javascriptRuntimeReconciliationExample.js";
import {
  compareApplicationVersionsEvidence,
  compareJavaScriptExportShapesEvidence,
  traceApplicationFeatureEvidence,
} from "./JavaScriptApplicationWorkflowService.js";
import { reconcileJavaScriptRuntimeEvidence } from "./JavaScriptRuntimeReconciliationService.js";
import { traceJavaScriptSemanticsEvidence } from "./JavaScriptSemanticTraceService.js";
import {
  inspectAnalysisView,
  projectRetainedAnalysis,
} from "../analysisView/AnalysisViewService.js";

const reference = ({ evidence_id }: Evidence) => ({
  kind: "retained-evidence" as const,
  evidence_id,
});

it("keeps a static trace subject unknown when legacy graph root evidence is omitted", () => {
  const original = JAVASCRIPT_FEATURE_TRACE_EXAMPLE.application;
  const result = javascriptApplicationAnalysisResultSchema.parse(
    original.normalized_result,
  );
  const { graph_id: _graphId, ...graphInput } = result.graph;
  const graph = createJavaScriptApplicationGraph({
    ...graphInput,
    nodes: graphInput.nodes.filter(({ kind }) => kind !== "artifact"),
    root_node_ids: graphInput.nodes
      .filter(({ kind }) => kind === "javascript-asset")
      .map(({ node_id }) => node_id),
    edges: [],
  });
  const { graph_id: _semanticId, ...semanticInput } = result.semantic_graph;
  const semanticGraph = createJavaScriptSemanticGraph({
    ...semanticInput,
    application_graph_id: graph.graph_id,
  });
  if (original.subject === null)
    throw new Error("Expected application subject");
  const legacy = createEvidence(
    {
      path: original.subject.local_path,
      sha256: original.subject.digest.sha256,
      format: original.subject.format,
    },
    original.provider,
    {
      operation: original.operation,
      predicateType: original.predicate_type,
      parameters: original.parameters,
      result: { ...result, graph, semantic_graph: semanticGraph },
      confidence: "derived",
      authority: "shipped-artifact",
    },
  );
  const trace = traceApplicationFeatureEvidence({
    ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
    application: legacy,
  });
  if (!trace.ok) throw trace.error;
  expect(trace.value.evidence.subject).toBeNull();
});

const native = createEvidence(
  { path: "/example/addon.node", sha256: "e".repeat(64), format: "elf" },
  { id: "fixture", name: "Native fixture", version: "1" },
  { operation: "procedure_info", parameters: {}, result: {} },
);

it("preserves the verified application subject in both trace workflows", async () => {
  const original = JAVASCRIPT_FEATURE_TRACE_EXAMPLE.application;
  if (original.subject === null)
    throw new Error("Expected application subject");
  const application = createEvidence(
    {
      path: original.subject.local_path,
      sha256: original.subject.digest.sha256,
      format: original.subject.format,
      architecture: "x86_64",
      name: "caller-selected-name",
    },
    original.provider,
    {
      operation: original.operation,
      predicateType: original.predicate_type,
      parameters: original.parameters,
      result: original.normalized_result,
      confidence: "derived",
      authority: "shipped-artifact",
    },
  );
  const feature = traceApplicationFeatureEvidence({
    ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
    application,
  });
  const semantic = traceJavaScriptSemanticsEvidence({
    application,
    query: {
      seed: { kind: "property", name: "unobserved" },
      direction: "ownership",
    },
  });
  for (const result of [feature, semantic]) {
    if (!result.ok) throw result.error;
    expect(result.value.evidence.subject).toEqual(application.subject);
    expect(result.value.evidence.limitations).not.toContain(
      "Artifact identity is unavailable for this observation.",
    );
  }
  if (!feature.ok) throw feature.error;
  const view = await inspectAnalysisView({
    source: { kind: "inline", evidence: feature.value.evidence },
    view: { kind: "summary" },
  });
  if (!view.ok) throw view.error;
  expect(view.value.subject).toEqual(application.subject);
  const selected = parseEvidence({
    ...feature.value.evidence,
    subject: { ...feature.value.evidence.subject, name: "selected display" },
  });
  const retained = projectRetainedAnalysis(
    selected,
    {
      recordEvidence: () => ok("added"),
      evidenceById: () => feature.value.evidence,
    },
    { kind: "summary" },
  );
  if (!retained.ok) throw retained.error;
  expect(retained.value.subject?.name).toBe("selected display");
  expect(
    rebindEvidenceToTargetPath(feature.value.evidence, {
      path: application.subject!.local_path,
      sha256: "f".repeat(64),
      format: application.subject!.format,
      architecture: "x86_64",
      name: "wrong artifact",
    }),
  ).toBe(feature.value.evidence);
});

it("does not attribute a multi-source reconciliation graph to its envelope subject", () => {
  const original = JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE.right;
  const reconciliation = createEvidence(
    { path: "/other/artifact", sha256: "f".repeat(64), format: "file" },
    original.provider,
    {
      operation: original.operation,
      predicateType: original.predicate_type,
      parameters: original.parameters,
      result: original.normalized_result,
      confidence: "inferred",
      authority: "analyst-inference",
      evidenceLinks: original.evidence_links,
    },
  );
  const result = traceApplicationFeatureEvidence({
    ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
    application: reconciliation,
  });
  if (!result.ok) throw result.error;
  expect(result.value.evidence.subject).toBeNull();
  expect(result.value.evidence.limitations).toContain(
    "Artifact identity is unavailable for this observation.",
  );
});

it("resolves feature native arrays without changing source identity or unknowns", () => {
  const input = {
    ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
    native_observations: [native],
  };
  const inline = traceApplicationFeatureEvidence(input);
  const records = new Map(
    [input.application, native].map((record) => [record.evidence_id, record]),
  );
  const lookup = vi.fn((id: string) => records.get(id));
  const retained = traceApplicationFeatureEvidence(
    {
      ...input,
      application: reference(input.application),
      native_observations: [reference(native)],
    },
    lookup,
  );
  if (!inline.ok) throw inline.error;
  if (!retained.ok) throw retained.error;
  expect(retained.value.evidence.evidence_id).toBe(
    inline.value.evidence.evidence_id,
  );
  expect(retained.value.result).toEqual(inline.value.result);
  expect(retained.value.sources.map(({ evidence_id }) => evidence_id)).toEqual([
    input.application.evidence_id,
    native.evidence_id,
  ]);
  expect(lookup).toHaveBeenCalledTimes(2);
});

it("resolves per-side native observations with one lookup per repeated exact ID", async () => {
  const input = {
    ...JAVASCRIPT_APPLICATION_VERSION_COMPARISON_EXAMPLE,
    left_native_observations: [native],
    right_native_observations: [native],
  };
  const inline = await compareApplicationVersionsEvidence(input);
  const records = new Map(
    [input.left, input.right, native].map((record) => [
      record.evidence_id,
      record,
    ]),
  );
  const lookup = vi.fn((id: string) => records.get(id));
  const retained = await compareApplicationVersionsEvidence(
    {
      left: reference(input.left),
      right: reference(input.right),
      left_native_observations: [reference(native)],
      right_native_observations: [reference(native)],
    },
    lookup,
  );
  if (!inline.ok) throw inline.error;
  if (!retained.ok) throw retained.error;
  expect(retained.value.evidence.evidence_id).toBe(
    inline.value.evidence.evidence_id,
  );
  expect(retained.value.result).toEqual(inline.value.result);
  expect(lookup).toHaveBeenCalledTimes(3);
});

it("uses retained graphs for exact export-shape comparison", () => {
  const input = JAVASCRIPT_EXPORT_SHAPE_COMPARISON_EXAMPLE;
  const inline = compareJavaScriptExportShapesEvidence(input);
  const records = new Map(
    [input.left, input.right].map((record) => [record.evidence_id, record]),
  );
  const retained = compareJavaScriptExportShapesEvidence(
    {
      ...input,
      left: reference(input.left),
      right: reference(input.right),
    },
    (id) => records.get(id),
  );
  if (!inline.ok) throw inline.error;
  if (!retained.ok) throw retained.error;
  expect(retained.value.evidence.evidence_id).toBe(
    inline.value.evidence.evidence_id,
  );
});

it("resolves nested static layers and runtime arrays before source-owned reconciliation", () => {
  const input = JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE;
  const records = new Map(
    [
      ...input.static_layers.map(({ analysis }) => analysis),
      ...input.runtime_observations,
    ].map((record) => [record.evidence_id, record]),
  );
  const inline = reconcileJavaScriptRuntimeEvidence(input);
  const retained = reconcileJavaScriptRuntimeEvidence(
    {
      ...input,
      static_layers: input.static_layers.map((layer) => ({
        ...layer,
        analysis: reference(layer.analysis),
      })),
      runtime_observations: input.runtime_observations.map(reference),
    },
    (id) => records.get(id),
  );
  if (!inline.ok) throw inline.error;
  if (!retained.ok) throw retained.error;
  expect(retained.value.evidence.evidence_id).toBe(
    inline.value.evidence.evidence_id,
  );
  expect(
    retained.value.sources.map(({ evidence_id }) => evidence_id).sort(),
  ).toEqual([...records.keys()].sort());
});

it("preserves semantic-trace unknown coverage through retained sources", () => {
  const application = JAVASCRIPT_FEATURE_TRACE_EXAMPLE.application;
  const input = {
    application,
    query: {
      seed: { kind: "property", name: "unobserved" },
      direction: "ownership",
    },
  };
  const inline = traceJavaScriptSemanticsEvidence(input);
  const retained = traceJavaScriptSemanticsEvidence(
    { ...input, application: reference(application) },
    (id) => (id === application.evidence_id ? application : undefined),
  );
  if (!inline.ok) throw inline.error;
  if (!retained.ok) throw retained.error;
  expect(retained.value.result).toEqual(inline.value.result);
  expect(retained.value.sources).toEqual([application]);
});

it("reports missing nested references before reconciliation without guessing a source", () => {
  const layer = JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE.static_layers[0];
  if (layer === undefined) throw new Error("Expected an application layer");
  const result = reconcileJavaScriptRuntimeEvidence({
    ...JAVASCRIPT_RUNTIME_RECONCILIATION_EXAMPLE,
    static_layers: [{ ...layer, analysis: reference(layer.analysis) }],
  });
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "EvidenceIntegrityError" },
  });
});

it("honors cancellation before reading any retained graph", () => {
  const controller = new AbortController();
  const reason = { request: "cancel before source resolution" };
  controller.abort(reason);
  const application = JAVASCRIPT_FEATURE_TRACE_EXAMPLE.application;
  const lookup = vi.fn(() => application);
  const result = traceApplicationFeatureEvidence(
    {
      ...JAVASCRIPT_FEATURE_TRACE_EXAMPLE,
      application: reference(application),
    },
    lookup,
    { signal: controller.signal },
  );
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError", cause: reason },
  });
  expect(lookup).not.toHaveBeenCalled();
});
