import { expect, it } from "vitest";

import { resolveJavaScriptSourceMapReference } from "../javascript/javascriptSourceMapPaths.js";
import { functionDossierSchema } from "../hopperValues.js";
import { ghidraFunctionDossier } from "../ghidraValues.fixture.js";
import { JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE } from "../../contracts/javascript/javascriptRuntimeReconciliationExample.js";
import {
  analysisViewBindJavaScriptGraphs,
  analysisViewJavaScriptAnalysis,
  analysisViewJavaScriptAnalysisWithSource,
  analysisViewLayoutEvidence,
  analysisViewLayoutFixture,
} from "../../../tests/fixtures/analysisView.js";
import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
  createImmutableJavaScriptApplicationGraphSteps,
} from "../javascript/javascriptApplicationGraph.js";
import {
  createJavaScriptSemanticGraph,
  createImmutableJavaScriptSemanticGraphSteps,
} from "../javascript/javascriptSemanticGraph.js";
import {
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import { javascriptModulePath } from "./javascriptApplicationView.js";

import {
  inspectAnalysisViewInputSchema,
  projectAnalysisView,
  type AnalysisViewParent,
} from "./analysisView.js";
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

const nativeParent = (
  result: unknown = ghidraFunctionDossier(),
): AnalysisViewParent => ({
  evidenceId: "ev_" + "b".repeat(64),
  operation: "analyze_function",
  normalizedResult: result,
  limitations: ["Retained provider limitation"],
  artifact: { path: "/fixtures/example.exe", sha256: "a".repeat(64) },
});

it("projects native procedure and bounded assembly and high-pcode with exact parent identity", () => {
  const parent = nativeParent();
  const procedure = projectAnalysisView(parent, {
    kind: "native",
    facet: "procedure",
    offset: 0,
    limit: 64,
  });
  if (!procedure.ok) throw procedure.error;
  expect(procedure.value).toMatchObject({
    kind: "native",
    parent_operation: "analyze_function",
    artifact: parent.artifact,
    item: { address: "0x401000" },
  });
  expect(procedure.value.view_digest).not.toBe(parent.evidenceId.slice(3));
  const assembly = projectAnalysisView(parent, {
    kind: "native",
    facet: "assembly",
    offset: 0,
    limit: 1,
  });
  if (!assembly.ok) throw assembly.error;
  expect(assembly.value).toMatchObject({
    coverage: { examined: 1, total: 2, next_offset: 1 },
    item: ["0x401000: CALL 0x401020"],
  });
  const flow = projectAnalysisView(parent, {
    kind: "native",
    facet: "value_flow_operations",
    offset: 0,
    limit: 1,
  });
  if (!flow.ok) throw flow.error;
  expect(flow.value).toMatchObject({ item: [{ opcode: "COPY" }] });
});

it("rejects invalid native parents, unsupported source operations and singleton offsets", () => {
  const view = {
    kind: "native",
    facet: "assembly",
    offset: 0,
    limit: 4,
  } as const;
  expect(projectAnalysisView(nativeParent({}), view)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
  expect(
    projectAnalysisView({ ...nativeParent(), artifact: null }, view),
  ).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
  expect(projectAnalysisView(layoutParent(), view)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
  expect(projectAnalysisView(javascriptParent(), view)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
  expect(
    projectAnalysisView(nativeParent(), {
      kind: "native",
      facet: "procedure",
      offset: 1,
      limit: 2,
    }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
});

it("preserves native API limitations and unavailable residual unknowns", () => {
  const original = functionDossierSchema.parse(ghidraFunctionDossier());
  const view = {
    kind: "native",
    facet: "procedure",
    offset: 0,
    limit: 64,
  } as const;
  const unavailable = projectAnalysisView(
    nativeParent({
      ...original,
      native_api: {
        available: false,
        reason: "No decompiler",
        residual_unknowns: ["Calling convention unresolved"],
      },
    }),
    view,
  );
  if (!unavailable.ok) throw unavailable.error;
  expect(unavailable.value.unknowns).toContain("Calling convention unresolved");
  const available = projectAnalysisView(nativeParent(), view);
  if (!available.ok) throw available.error;
  if (!original.native_api?.available) throw new Error("expected API fixture");
  expect(available.value.limitations).toEqual(
    expect.arrayContaining(original.native_api.limitations),
  );
});

it("reports the malformed native dossier field", () => {
  const result = projectAnalysisView(
    nativeParent({
      ...functionDossierSchema.parse(ghidraFunctionDossier()),
      pseudocode: 12,
    }),
    {
      kind: "native",
      facet: "pseudocode",
      offset: 0,
      limit: 64,
    },
  );
  expect(result).toMatchObject({
    ok: false,
    error: {
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: ["source", "normalized_result", "pseudocode"],
        }),
      ]),
    },
  });
});

it("native pseudocode pages do not split surrogate pairs", () => {
  const original = functionDossierSchema.parse(ghidraFunctionDossier());
  const parent = nativeParent({ ...original, pseudocode: "ab😀cd" });
  expect(
    projectAnalysisView(parent, {
      kind: "native",
      facet: "pseudocode",
      offset: 3,
      limit: 2,
    }),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
  const safe = projectAnalysisView(parent, {
    kind: "native",
    facet: "pseudocode",
    offset: 2,
    limit: 3,
  });
  if (!safe.ok) throw safe.error;
  expect(safe.value).toMatchObject({
    item: { text: "😀c", unit: "utf16-code-units" },
    coverage: { examined: 3, next_offset: 5 },
  });
});

it.each([
  { kind: "page", collection: "sections", offset: 0, limit: 500 },
  { kind: "native", facet: "assembly", offset: 0, limit: 500 },
])(
  "accepts caller-selected page sizes and rejects malformed bounds: $kind",
  (view) => {
    const input = {
      source: {
        kind: "retained-evidence",
        evidence_id: `ev_${"a".repeat(64)}`,
      },
      view,
    };
    expect(inspectAnalysisViewInputSchema.safeParse(input).success).toBe(true);
    for (const limit of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(
        inspectAnalysisViewInputSchema.safeParse({
          ...input,
          view: { ...input.view, limit },
        }).success,
      ).toBe(false);
  },
);

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
  if (mitigations.value.kind !== "facet")
    throw new Error("expected facet view");
  expect(mitigations.value.facet).toEqual(layout.mitigations);
  const data = projectAnalysisView(parent, {
    kind: "item",
    collection: "sections",
    selector: { name: ".data" },
  });
  if (!data.ok) throw data.error;
  if (data.value.kind !== "item") throw new Error("expected item view");
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
  if (page.value.kind !== "page") throw new Error("expected page view");
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

it("projects JavaScript summary and preserves selected module observations", () => {
  const analysis = analysisViewJavaScriptAnalysisWithSource();
  const parent = javascriptParent(analysis);
  const summary = projectAnalysisView(parent, { kind: "summary" });
  if (!summary.ok) throw summary.error;
  if (summary.value.kind !== "summary") throw new Error("expected summary");
  expect(summary.value.summary).toMatchObject({
    format: "directory",
    limitation_count: 0,
  });
  expect(JSON.stringify(summary.value)).not.toMatch(/"graph"/);
  expect(summary.value.summary).not.toHaveProperty("semantic_graph");
  const item = projectAnalysisView(parent, {
    kind: "item",
    collection: "modules",
    selector: { path: "renderer.js" },
  });
  if (!item.ok) throw item.error;
  const moduleNode = analysis.graph.nodes[0];
  if (moduleNode === undefined) throw new Error("missing module");
  expect(javascriptModulePath(moduleNode)).toBe("renderer.js");
  if (item.value.kind !== "item") throw new Error("expected item view");
  expect(item.value.item).toMatchObject({
    path: "renderer.js",
    kind: "javascript-asset",
  });
  expect(JSON.stringify(item.value.item)).toContain("export const secret = 1;");
  expect(JSON.stringify(item.value.item)).toContain("should not leak");
  const page = projectAnalysisView(parent, {
    kind: "page",
    collection: "modules",
    offset: 0,
    limit: 8,
  });
  if (!page.ok) throw page.error;
  if (page.value.kind !== "page") throw new Error("expected page view");
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
    analysisViewBindJavaScriptGraphs(analysis, graph),
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

it("pages actual modules, including unknown and empty paths, without unrelated roles", () => {
  const analysis = analysisViewJavaScriptAnalysis();
  const original = analysis.graph.nodes[0];
  if (original === undefined) throw new Error("missing module");
  const nodes = [
    original,
    ...(
      [
        "asar-entry",
        "electron-renderer",
        "javascript-module",
        "source-module",
      ] as const
    ).map((kind) =>
      createJavaScriptApplicationNode({
        kind,
        identity:
          kind === "source-module"
            ? {
                strategy: "source-map-original",
                source_root: null,
                stability: "source-map-exact",
                original_source: "",
                source_map_sha256: "c".repeat(64),
                source_sha256: null,
              }
            : kind === "javascript-module"
              ? {
                  strategy: "artifact-local-key",
                  stability: "artifact-version",
                  artifact_sha256: "c".repeat(64),
                  namespace: kind,
                  key: "module",
                }
              : original.identity,
        observations: original.observations.map((observation) => ({
          ...(kind === "source-module"
            ? {
                source_map_reference: resolveJavaScriptSourceMapReference(
                  "",
                  null,
                  "renderer.js",
                ),
              }
            : {}),
          label: observation.label,
          properties: {},
          evidence:
            kind === "javascript-module" || kind === "source-module"
              ? {
                  ...observation.evidence,
                  artifact: {
                    ...observation.evidence.artifact,
                    sha256: "c".repeat(64),
                    artifact_id: `art_${"c".repeat(64)}`,
                  },
                  ...(kind === "javascript-module"
                    ? {
                        state: "unknown",
                        confidence: "unknown",
                        limitations: ["Source location unavailable"],
                        location: {
                          available: false,
                          reason: "unknown",
                          detail: "Source location unavailable",
                        },
                      }
                    : {}),
                }
              : observation.evidence,
        })),
      }),
    ),
  ];
  const graph = createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: nodes.map((node) => node.node_id),
    nodes,
    edges: [],
    coverage: analysis.graph.coverage,
    limitations: [],
  });
  const parent = javascriptParent(
    analysisViewBindJavaScriptGraphs(analysis, graph),
  );
  const page = projectAnalysisView(parent, {
    kind: "page",
    collection: "modules",
    offset: 0,
    limit: 1000,
  });
  if (!page.ok) throw page.error;
  expect(page.value).toMatchObject({
    coverage: { total: 3, examined: 3, exhausted: true },
  });
  if (page.value.kind !== "page") throw new Error("expected page");
  expect(page.value.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "javascript-module", path: null }),
      expect.objectContaining({ kind: "source-module", path: "" }),
    ]),
  );
  const emptyPath = projectAnalysisView(parent, {
    kind: "item",
    collection: "modules",
    selector: { path: "" },
  });
  expect(emptyPath.ok).toBe(true);
  const role = nodes.find((node) => node.kind === "electron-renderer");
  if (role === undefined) throw new Error("missing role");
  expect(
    projectAnalysisView(parent, {
      kind: "item",
      collection: "modules",
      selector: { node_id: role.node_id },
    }).ok,
  ).toBe(false);
});

const complete = <Value>(steps: Generator<void, Value>): Value => {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
};

it("reuses authenticated graphs while rejecting malformed metadata and imported companions", () => {
  const analysis = analysisViewJavaScriptAnalysis();
  const { graph_id: _applicationId, ...application } = analysis.graph;
  const graph = complete(
    createImmutableJavaScriptApplicationGraphSteps(application),
  );
  const { graph_id: _semanticId, ...semantic } = analysis.semantic_graph;
  const semanticGraph = complete(
    createImmutableJavaScriptSemanticGraphSteps({
      ...semantic,
      application_graph_id: graph.graph_id,
    }),
  );
  const owned = { ...analysis, graph, semantic_graph: semanticGraph };
  expect(
    projectAnalysisView(javascriptParent(owned), { kind: "summary" }).ok,
  ).toBe(true);
  for (const malformed of [
    { ...owned, root_artifact_sha256: "d".repeat(64) },
    {
      ...owned,
      statistics: { ...owned.statistics, parsed_javascript_files: -1 },
    },
    {
      ...owned,
      semantic_graph: Object.freeze({
        ...semanticGraph,
        application_graph_id: "jag_" + "d".repeat(64),
      }),
    },
  ]) {
    const result = projectAnalysisView(
      { ...javascriptParent(owned), normalizedResult: malformed },
      { kind: "summary" },
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisInputError",
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: expect.arrayContaining(["source", "normalized_result"]),
          }),
        ]),
      },
    });
  }
});

it("retains semantic coverage and limitations in a summary", () => {
  const analysis = analysisViewJavaScriptAnalysis();
  const { graph_id: _graphId, ...semantic } = analysis.semantic_graph;
  const semanticGraph = createJavaScriptSemanticGraph({
    ...semantic,
    coverage: {
      ...semantic.coverage,
      status: "partial",
      truncated: true,
      omitted_nodes: null,
      omitted_relations: null,
      limits: [
        { name: "semantic_graph_node_ceiling", value: 100000, unit: "items" },
      ],
    },
    limitations: ["Some semantic nodes could not be retained."],
  });
  const result = projectAnalysisView(
    javascriptParent({ ...analysis, semantic_graph: semanticGraph }),
    { kind: "summary" },
  );
  if (!result.ok) throw result.error;
  expect(result.value).toMatchObject({
    summary: { coverage: { semantic: { status: "partial", truncated: true } } },
    limitations: ["Some semantic nodes could not be retained."],
    unknowns: expect.arrayContaining([
      "semantic_graph.coverage.status is partial",
    ]),
  });
});

it("does not match unavailable layout names using a display placeholder", () => {
  const layout = analysisViewLayoutFixture();
  const section = layout.sections[2];
  if (section === undefined) throw new Error("missing section");
  const result = projectAnalysisView(
    {
      ...layoutParent(),
      normalizedResult: {
        ...layout,
        sections: [
          ...layout.sections.slice(0, 2),
          {
            ...section,
            name: {
              ...section.name,
              display: "<unavailable>",
              unknown_reason: "Name bytes unavailable",
              bytes_base64: null,
              location: null,
            },
          },
        ],
      },
    },
    {
      kind: "item",
      collection: "sections",
      selector: { name: "<unavailable>" },
    },
  );
  expect(result.ok).toBe(false);
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
