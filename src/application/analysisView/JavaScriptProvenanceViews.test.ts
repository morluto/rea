import { expect, it } from "vitest";
import {
  analysisViewBindJavaScriptGraphs,
  analysisViewJavaScriptAnalysisWithSource,
  analysisViewJavaScriptAnalysis,
  analysisViewJavaScriptEvidence,
} from "../../../tests/fixtures/analysisView.js";
import { SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE } from "../../contracts/javascript/javascriptApplicationWorkflowExamples.js";
import { analysisViewResultSchema } from "../../domain/analysisView/analysisViewResult.js";
import type { Evidence } from "../../domain/evidence.js";
import { jsonValueValidationIssue } from "../../domain/jsonValue.js";
import { compareSourceToBundle } from "../../domain/javascript/sourceToBundleComparison.js";
import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
} from "../../domain/javascript/javascriptApplicationGraph.js";
import {
  artifactEvidence,
  sourceMapReference,
} from "../../domain/javascript/javascriptApplicationGraph.fixture.js";
import { createHistoricalSourceGraph } from "../../domain/referenceSourceGraph.js";
import { EvidenceLedger } from "../investigation/EvidenceLedger.js";
import { createSourceToBundleComparisonEvidence } from "../javascript/JavaScriptApplicationWorkflowEvidence.js";
import { inspectAnalysisView } from "./AnalysisViewService.js";

const retainedView = async (parent: Evidence, view: unknown) => {
  const ledger = new EvidenceLedger();
  const recorded = ledger.record(parent);
  if (!recorded.ok) throw recorded.error;
  const retained = ledger.forAnalysis(parent.evidence_id);
  const before = structuredClone(retained);
  const result = await inspectAnalysisView(
    {
      source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
      view,
    },
    (id) => ledger.forAnalysis(id),
  );
  if (!result.ok) throw result.error;
  expect(ledger.forAnalysis(parent.evidence_id)).toBe(retained);
  expect(retained).toEqual(before);
  expect(result.value.normalized_result).toHaveProperty(
    "parent_evidence_id",
    parent.evidence_id,
  );
  expect(jsonValueValidationIssue(result.value)).toBeUndefined();
  return analysisViewResultSchema.parse(result.value.normalized_result);
};

it.each([
  null,
  sourceMapReference("../src/original.ts", "", "maps/renderer.js.map"),
])(
  "retains full canonical module observations in a retained Evidence item: %j",
  async (reference) => {
    const original = analysisViewJavaScriptAnalysisWithSource();
    const first = original.graph.nodes[0];
    if (first === undefined) throw new Error("Expected fixture module");
    const module = createJavaScriptApplicationNode({
      kind: first.kind,
      identity: first.identity,
      observations: first.observations.map((observation) => ({
        label: observation.label,
        properties: observation.properties,
        evidence: observation.evidence,
        source_map_reference: reference,
      })),
    });
    const analysis = analysisViewBindJavaScriptGraphs(
      original,
      createJavaScriptApplicationGraph({
        schema: "JavaScriptApplicationGraph",
        root_node_ids: [module.node_id],
        nodes: [module],
        edges: [],
        coverage: original.graph.coverage,
        limitations: original.graph.limitations,
      }),
    );
    const result = await retainedView(
      analysisViewJavaScriptEvidence(analysis),
      {
        kind: "item",
        collection: "modules",
        selector: { node_id: module.node_id },
      },
    );
    if (result.kind !== "item") throw new Error("Expected module item");
    expect(result.item).toMatchObject({ observations: module.observations });
  },
);

const comparison = () => {
  const original = analysisViewJavaScriptAnalysis();
  const source = createJavaScriptApplicationNode({
    kind: "source-module",
    identity: {
      strategy: "source-map-original",
      stability: "source-map-exact",
      source_map_sha256: "a".repeat(64),
      original_source: "src/main.ts",
      source_root: "",
      source_sha256: "2".repeat(64),
    },
    observations: [
      {
        label: "src/main.ts",
        properties: { content_available: true, content_sha256: "2".repeat(64) },
        source_map_reference: sourceMapReference(
          "src/main.ts",
          "",
          "bundle.map",
        ),
        evidence: artifactEvidence("a".repeat(64), "bundle.map"),
      },
    ],
  });
  const { root_sha256: _root, ...reference } =
    SOURCE_TO_BUNDLE_COMPARISON_EXAMPLE.reference;
  const graph = createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: [...original.graph.root_node_ids, source.node_id],
    nodes: [...original.graph.nodes, source],
    edges: original.graph.edges,
    coverage: {
      status: "complete",
      truncated: false,
      omitted_count: 0,
      limits: [],
    },
    limitations: [],
  });
  const analysis = analysisViewBindJavaScriptGraphs(original, graph);
  const application = analysisViewJavaScriptEvidence(analysis);
  return compareSourceToBundle({
    reference: createHistoricalSourceGraph({
      ...reference,
      languages: [],
      entries: reference.entries.map((entry) =>
        entry.kind === "file" ? { ...entry, language: null } : entry,
      ),
    }),
    application: {
      evidenceId: application.evidence_id,
      rootArtifactSha256: analysis.root_artifact_sha256,
      graph,
    },
  });
};

it("keeps absent optional candidate provenance omitted through retained Evidence delivery", async () => {
  const report = comparison();
  const candidate = report.items[0]?.candidates[0];
  if (candidate === undefined) throw new Error("Expected producer candidate");
  expect(candidate).not.toHaveProperty("current_file_occurrence");
  expect(candidate).not.toHaveProperty("representation_node_ids");
  const result = await retainedView(
    createSourceToBundleComparisonEvidence({}, report),
    {
      kind: "source-to-bundle",
      collection: "candidates",
      fields: ["score", "current_file_occurrence", "representation_node_ids"],
    },
  );
  if (result.kind !== "source-to-bundle")
    throw new Error("Expected comparison view");
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({
    score: candidate.score,
    current_node_id: candidate.current_node_id,
  });
  expect(result.items[0]).not.toHaveProperty("current_file_occurrence");
  expect(result.items[0]).not.toHaveProperty("representation_node_ids");
});

it("preserves an explicitly retained null and required mapping identity in selected columns", async () => {
  const report = comparison();
  expect(report.items[0]?.source_language).toBeNull();
  const result = await retainedView(
    createSourceToBundleComparisonEvidence({}, report),
    {
      kind: "source-to-bundle",
      collection: "mappings",
      fields: ["source_language"],
    },
  );
  if (result.kind !== "source-to-bundle")
    throw new Error("Expected comparison view");
  expect(result.items[0]).toEqual({
    mapping_id: report.items[0]?.mapping_id,
    source_path: "src/main.ts",
    source_index: 0,
    source_language: null,
  });
});
