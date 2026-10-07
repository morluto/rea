import { describe, expect, it } from "vitest";

import { createEvidence } from "../domain/evidence.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import {
  APPLICATION_GRAPH_DIGESTS,
  artifactEvidence,
  buildSyntheticJavaScriptApplicationGraph,
  completeCoverage,
} from "../domain/javascriptApplicationGraph.fixture.js";
import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
} from "../domain/javascriptApplicationGraph.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { MANAGED_WORKFLOW_PROVIDER } from "./InvestigationProviders.js";
import { deriveReconstructionObligationCandidates } from "./ReconstructionObligationCandidates.js";

const applicationWithUnknowns = (keys: readonly string[]) => {
  const source = createEvidence(
    undefined,
    { id: "fixture-source", name: "Fixture source", version: "1" },
    {
      operation: "inspect_fixture_source",
      parameters: {},
      result: {},
      confidence: "observed",
      authority: "shipped-artifact",
    },
  );
  const base = buildSyntheticJavaScriptApplicationGraph();
  const unknownNodes = keys.map((key) =>
    createJavaScriptApplicationNode({
      kind: "unknown",
      identity: {
        strategy: "artifact-local-key",
        stability: "artifact-version",
        artifact_sha256: APPLICATION_GRAPH_DIGESTS.asar,
        namespace: "fixture",
        key,
      },
      observations: [
        {
          label: "Unclassified application boundary",
          properties: {},
          evidence: artifactEvidence(
            APPLICATION_GRAPH_DIGESTS.asar,
            "unclassified.js",
          ),
        },
      ],
    }),
  );
  const graph = createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: base.root_node_ids,
    nodes: [...base.nodes, ...unknownNodes],
    edges: base.edges,
    coverage: completeCoverage,
    limitations: base.limitations,
  });
  const application = createEvidence(undefined, MANAGED_WORKFLOW_PROVIDER, {
    predicateType: "rea.managed-application-graph",
    operation: "project_managed_application_graph",
    parameters: {},
    result: jsonValueSchema.parse({
      projection_id: `magp_${"a".repeat(64)}`,
      root_artifact_sha256: APPLICATION_GRAPH_DIGESTS.asar,
      source_evidence: {
        managed_artifact_evidence_id: source.evidence_id,
        managed_members_evidence_id: null,
        managed_native_boundaries_evidence_id: null,
      },
      summary: {
        graph_nodes: graph.nodes.length,
        graph_edges: graph.edges.length,
        assemblies: 0,
        modules: 0,
        types: 0,
        methods: 0,
        fields: 0,
        pinvoke_imports: 0,
        native_implementations: 0,
      },
      graph,
      coverage: { status: "complete-within-inputs" },
      evidence_links: [source.evidence_id],
      limitations: [],
    }),
    confidence: "inferred",
    authority: "analyst-inference",
    evidenceLinks: [source.evidence_id],
  });
  return {
    graph,
    unknownNodes,
    generated: deriveReconstructionObligationCandidates(
      createEvidenceBundle([source, application]),
      [],
    ),
  };
};

const unknownLimitation = (graphId: string, nodeId: string): string =>
  `Application graph ${graphId} contains unresolved node ${nodeId}; reconstruction obligations remain unknown.`;

describe("reconstruction obligation candidates", () => {
  it("preserves admitted unknown application nodes as limitations", () => {
    const { graph, unknownNodes, generated } = applicationWithUnknowns([
      "unclassified-boundary",
    ]);
    const unknownNode = unknownNodes[0];
    if (unknownNode === undefined) throw new Error("Expected one unknown node");

    expect(generated.candidates.length).toBeGreaterThan(0);
    expect(
      generated.candidates.some(
        ({ target }) => target.application_node_id === unknownNode.node_id,
      ),
    ).toBe(false);
    expect(generated.limitations).toEqual([
      unknownLimitation(graph.graph_id, unknownNode.node_id),
    ]);
  });

  it("emits one deterministic limitation per unknown node", () => {
    const { graph, unknownNodes, generated } = applicationWithUnknowns([
      "unclassified-first",
      "unclassified-second",
    ]);

    expect([...generated.limitations].sort()).toEqual(
      unknownNodes
        .map((node) => unknownLimitation(graph.graph_id, node.node_id))
        .sort(),
    );
    for (const node of unknownNodes)
      expect(
        generated.candidates.some(
          ({ target }) => target.application_node_id === node.node_id,
        ),
      ).toBe(false);
  });
});
