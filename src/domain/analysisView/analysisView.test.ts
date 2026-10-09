import { expect, it } from "vitest";

import { JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE } from "../../contracts/javascript/javascriptRuntimeReconciliationExample.js";
import {
  analysisViewJavaScriptAnalysis,
  analysisViewJavaScriptAnalysisWithSource,
  analysisViewLayoutEvidence,
  analysisViewLayoutFixture,
} from "../../../tests/fixtures/analysisView.js";
import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
} from "../javascript/javascriptApplicationGraph.js";
import { javascriptApplicationAnalysisResultSchema } from "../javascript/javascriptApplicationAnalysis.js";
import {
  MEASURED_PAGE_LIMIT,
  completeWithinViewCoverage,
  inspectAnalysisViewInputSchema,
  pageViewCoverage,
  projectAnalysisView,
  type AnalysisViewParent,
} from "./analysisView.js";
import { javascriptModulePath } from "./javascriptApplicationView.js";

const layoutParent = (): AnalysisViewParent => {
  const evidence = analysisViewLayoutEvidence();
  return {
    evidenceId: evidence.evidence_id,
    operation: evidence.operation,
    normalizedResult: evidence.normalized_result,
    limitations: evidence.limitations,
  };
};

const javascriptParent = (
  analysis = analysisViewJavaScriptAnalysis(),
): AnalysisViewParent => ({
  evidenceId: JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE.evidence_id,
  operation: "analyze_javascript_application",
  normalizedResult: analysis,
  limitations: JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE.limitations,
});

it("documents the measured page bound derived from the stdio budget", () => {
  expect(MEASURED_PAGE_LIMIT).toBe(319);
  expect(
    inspectAnalysisViewInputSchema.safeParse({
      source: {
        kind: "retained-evidence",
        evidence_id: `ev_${"a".repeat(64)}`,
      },
      view: {
        kind: "page",
        collection: "sections",
        offset: 0,
        limit: MEASURED_PAGE_LIMIT + 1,
      },
    }).success,
  ).toBe(false);
});

it("projects layout summary, facet, item, and stable pages", () => {
  const parent = layoutParent();
  const layout = analysisViewLayoutFixture();
  const summary = projectAnalysisView(parent, { kind: "summary" });
  if (!summary.ok) throw summary.error;
  expect(summary.value).toMatchObject({
    kind: "summary",
    parent_operation: "inspect_binary_layout",
    summary: {
      format: "elf",
      counts: { sections: 3, symbols: 3, segments: 0, relocations: 0 },
    },
    coverage: completeWithinViewCoverage(6, 6),
  });
  const mitigations = projectAnalysisView(parent, {
    kind: "facet",
    facet: "mitigations",
  });
  if (!mitigations.ok) throw mitigations.error;
  expect(mitigations.value.facet).toEqual(layout.mitigations);
  const data = projectAnalysisView(parent, {
    kind: "item",
    collection: "sections",
    selector: { name: ".data" },
  });
  if (!data.ok) throw data.error;
  expect(data.value.item).toMatchObject({
    index: 2,
    name: { display: ".data" },
  });
  const indexed = projectAnalysisView(parent, {
    kind: "item",
    collection: "sections",
    selector: { index: 0 },
  });
  if (!indexed.ok) throw indexed.error;
  expect(indexed.value.view_digest).not.toBe(data.value.view_digest);
  expect(indexed.value.view_digest).not.toBe(parent.evidenceId.slice(3));
  const page = projectAnalysisView(parent, {
    kind: "page",
    collection: "sections",
    offset: 0,
    limit: 2,
  });
  if (!page.ok) throw page.error;
  expect(page.value).toMatchObject({
    kind: "page",
    coverage: {
      status: "page",
      examined: 2,
      total: 3,
      next_offset: 2,
      exhausted: false,
    },
  });
  expect(page.value.items).toHaveLength(2);
  const exhausted = projectAnalysisView(parent, {
    kind: "page",
    collection: "symbols",
    offset: 3,
    limit: 8,
  });
  if (!exhausted.ok) throw exhausted.error;
  expect(exhausted.value).toMatchObject({
    items: [],
    coverage: pageViewCoverage(3, 0, 3),
  });
});

it("rejects ambiguous layout names with candidate indexes", () => {
  const parent = layoutParent();
  const result = projectAnalysisView(parent, {
    kind: "item",
    collection: "sections",
    selector: { name: ".text" },
  });
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisInputError",
      issues: [
        {
          path: ["view", "selector", "name"],
          expected: [{ index: 0 }, { index: 1 }],
        },
      ],
    },
  });
});

it("projects JavaScript summary and module identity without graph or source text", () => {
  const analysis = analysisViewJavaScriptAnalysisWithSource();
  const parent = javascriptParent(analysis);
  const summary = projectAnalysisView(parent, { kind: "summary" });
  if (!summary.ok) throw summary.error;
  expect(summary.value.kind).toBe("summary");
  expect(summary.value.summary).toMatchObject({
    format: "directory",
    limitation_count: 0,
  });
  expect(JSON.stringify(summary.value)).not.toMatch(/"graph"/);
  expect(JSON.stringify(summary.value)).not.toMatch(/semantic_graph/);
  const item = projectAnalysisView(parent, {
    kind: "item",
    collection: "modules",
    selector: { path: "renderer.js" },
  });
  if (!item.ok) throw item.error;
  const moduleNode = analysis.graph.nodes[0];
  if (moduleNode === undefined) throw new Error("missing module");
  expect(javascriptModulePath(moduleNode)).toBe("renderer.js");
  expect(item.value.item).toMatchObject({
    path: "renderer.js",
    kind: "javascript-asset",
  });
  expect(JSON.stringify(item.value.item)).not.toMatch(/secret/);
  expect(JSON.stringify(item.value.item)).not.toMatch(/should not leak/);
  const page = projectAnalysisView(parent, {
    kind: "page",
    collection: "modules",
    offset: 0,
    limit: 8,
  });
  if (!page.ok) throw page.error;
  expect(page.value.items).toEqual([
    {
      node_id: analysis.graph.nodes[0]?.node_id,
      kind: "javascript-asset",
      path: "renderer.js",
    },
  ]);
  expect(page.value.coverage).toMatchObject({
    status: "page",
    examined: 1,
    total: 1,
    next_offset: null,
    exhausted: true,
  });
});

it("rejects ambiguous JavaScript module paths with candidate node ids", () => {
  const analysis = analysisViewJavaScriptAnalysis();
  const first = analysis.graph.nodes[0];
  if (first === undefined) throw new Error("missing module");
  const duplicate = createJavaScriptApplicationNode({
    kind: first.kind,
    identity: {
      strategy: "content-digest",
      stability: "global-exact",
      sha256: "c".repeat(64),
    },
    observations: first.observations.map((observation) => ({
      label: observation.label,
      properties: observation.properties,
      evidence: {
        ...observation.evidence,
        artifact: {
          ...observation.evidence.artifact,
          sha256: "c".repeat(64),
          artifact_id: `art_${"c".repeat(64)}`,
        },
      },
    })),
  });
  const graph = createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: [first.node_id, duplicate.node_id],
    nodes: [first, duplicate],
    edges: [],
    coverage: analysis.graph.coverage,
    limitations: analysis.graph.limitations,
  });
  const parent = javascriptParent(
    javascriptApplicationAnalysisResultSchema.parse({
      ...analysis,
      graph,
      semantic_graph: {
        ...analysis.semantic_graph,
        application_graph_id: graph.graph_id,
      },
    }),
  );
  const result = projectAnalysisView(parent, {
    kind: "item",
    collection: "modules",
    selector: { path: "renderer.js" },
  });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected ambiguous path");
  expect(result.error).toMatchObject({
    _tag: "AnalysisInputError",
    issues: [
      {
        path: ["view", "selector", "path"],
        expected: expect.arrayContaining([
          { node_id: first.node_id },
          { node_id: duplicate.node_id },
        ]),
      },
    ],
  });
});

it("rejects unsupported parent operations and incompatible collections", () => {
  const unsupported = projectAnalysisView(
    {
      evidenceId: `ev_${"d".repeat(64)}`,
      operation: "inspect_recorded_crash",
      normalizedResult: { path: "/artifacts/crash.core" },
      limitations: [],
    },
    { kind: "summary" },
  );
  expect(unsupported).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisUnsupportedTargetError" },
  });
  const modulesOnLayout = projectAnalysisView(layoutParent(), {
    kind: "page",
    collection: "modules",
    offset: 0,
    limit: 1,
  });
  expect(modulesOnLayout).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
  const sectionsOnJs = projectAnalysisView(javascriptParent(), {
    kind: "item",
    collection: "sections",
    selector: { name: ".text" },
  });
  expect(sectionsOnJs).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
});
