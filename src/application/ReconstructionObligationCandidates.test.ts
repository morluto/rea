import { javascriptApplicationAnalysisResultSchema } from "../domain/javascript/javascriptApplicationAnalysis.js";
import { JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE } from "../contracts/javascript/javascriptRuntimeReconciliationExample.js";
import {
  createJavaScriptSemanticGraph,
  createJavaScriptSemanticGraphNode,
  JavaScriptSemanticEvidenceContextRegistry,
} from "../domain/javascript/javascriptSemanticGraph.js";
import {
  build,
  deriveCandidates,
  processEvidence,
  proofEvidence,
  request,
  reviewedObligation,
} from "./ReconstructionObligationLedger.fixture.js";
import { OBLIGATION_OVERGENERATION_THRESHOLD } from "./ReconstructionObligationLedgerEvaluation.js";
import { describe, expect, it } from "vitest";

import { createEvidence } from "../domain/evidence.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import type { ApplicationNode } from "../domain/javascript/javascriptApplicationGraphSchemas.js";
import type { ReconstructionObligationLedger } from "../domain/reconstructionObligationLedgerSchemas.js";
import {
  emptyUnverifiedProcessCapture,
  FINALIZED_PROCESS_CAPTURE_EXAMPLE,
} from "../domain/process/processCapture.fixture.js";
import { PROCESS_PROVIDER } from "../domain/process/processEvidenceProvider.js";
import { parseProcessCapture } from "../domain/process/processCaptureParsing.js";
import {
  digestProcessCommitment,
  processScenarioSchema,
  processComparisonContract,
  processScenarioCommitment,
} from "../domain/process/processScenario.js";
import {
  APPLICATION_GRAPH_DIGESTS,
  artifactEvidence,
  buildSyntheticJavaScriptApplicationGraph,
  completeCoverage,
} from "../domain/javascript/javascriptApplicationGraph.fixture.js";
import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
} from "../domain/javascript/javascriptApplicationGraph.js";
import { MANAGED_WORKFLOW_PROVIDER } from "../domain/investigationProviders.js";
import { createProcessCaptureEvidence } from "./process/ProcessEvidence.js";

const applicationWithUnknowns = (
  keys: readonly string[],
  {
    kind = "unknown",
    label = "Unclassified application boundary",
  }: { kind?: ApplicationNode["kind"]; label?: string } = {},
) => {
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
      kind,
      identity: {
        strategy: "artifact-local-key",
        stability: "artifact-version",
        artifact_sha256: APPLICATION_GRAPH_DIGESTS.asar,
        namespace: "fixture",
        key,
      },
      observations: [
        {
          label,
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
    result: {
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
    },
    confidence: "inferred",
    authority: "analyst-inference",
    evidenceLinks: [source.evidence_id],
  });
  return {
    graph,
    unknownNodes,
    records: [source, application],
    generated: deriveCandidates(
      createEvidenceBundle([source, application]),
      [],
    ),
  };
};

const unknownLimitation = (graphId: string, nodeId: string): string =>
  `Application graph ${graphId} contains unresolved node ${nodeId}; reconstruction obligations remain unknown.`;

describe("reconstruction obligation candidates", () => {
  it("preserves unresolved application nodes as deterministic limitations", () => {
    const { graph, unknownNodes, generated } = applicationWithUnknowns([
      "unclassified-first",
      "unclassified-second",
    ]);

    expect(generated.candidates.length).toBeGreaterThan(0);
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

  it("falls back to a kind-based title when an application node label is blank", () => {
    const {
      unknownNodes: [node],
      generated,
    } = applicationWithUnknowns(["blank-label"], {
      kind: "package",
      label: " ",
    });

    expect(
      generated.candidates.find(
        ({ target }) => target.application_node_id === node?.node_id,
      )?.title,
    ).toBe("package boundary");
  });

  it("does not bind an unknown process image to a packaged artifact obligation", () => {
    const scenario = processScenarioSchema.parse({
      executable: "/path/whose-launch-identity-is-unknown",
    });
    const base = emptyUnverifiedProcessCapture();
    const scenarioProjection = processScenarioCommitment(scenario);
    const comparisonContract = processComparisonContract(scenario);
    const capture = parseProcessCapture({
      ...base,
      normalization: scenario.normalization,
      manifest: {
        ...base.manifest,
        scenario: scenarioProjection,
        comparison_contract: comparisonContract,
        full_scenario_sha256: digestProcessCommitment(scenarioProjection),
        comparison_contract_sha256: digestProcessCommitment(comparisonContract),
        selected_executable_sha256: null,
        executable_sha256: null,
        executable_identity: {
          state: "unknown",
          reason: "Selected executable could not be inspected.",
        },
        normalization_sha256: digestProcessCommitment(scenario.normalization),
      },
    });
    const evidence = createProcessCaptureEvidence(scenario, capture);
    const generated = deriveCandidates(createEvidenceBundle([evidence]), []);

    expect(generated.candidates).toEqual([]);
    expect(generated.limitations).toContain(
      `Process capture ${evidence.evidence_id} has no validated executable artifact identity; packaged-process lifecycle obligation was not bound to an artifact.`,
    );
  });

  it("names the first rejected capture field and the remaining issue count", () => {
    const {
      manifest: { completed_at: _completedAt, ...manifest },
      exit,
      ...rest
    } = FINALIZED_PROCESS_CAPTURE_EXAMPLE;
    const evidence = createEvidence(undefined, PROCESS_PROVIDER, {
      predicateType: "rea.process-capture",
      operation: "capture_process_scenario",
      parameters: {},
      result: {
        ...rest,
        manifest,
        exit: {
          ...exit,
          finalization: {
            ...exit.finalization,
            signals: [
              { ...exit.finalization.signals[0], reason: "not allowed here" },
            ],
          },
        },
      },
    });
    const generated = deriveCandidates(createEvidenceBundle([evidence]), []);

    expect(generated.limitations).toEqual([
      `Process Evidence ${evidence.evidence_id} could not generate candidates: at manifest.completed_at: Invalid input: expected string, received undefined (1 more issues)`,
    ]);
  });
});

const decoyApplication = (count: number) =>
  applicationWithUnknowns(
    Array.from({ length: count }, (_, index) => `decoy-${String(index)}`),
    { kind: "ipc-channel", label: "decoy:channel" },
  );
const overgeneration = (ledger: ReconstructionObligationLedger) =>
  ledger.limitations.filter((limitation) =>
    limitation.startsWith("obligation-overgeneration:"),
  );
/** Generated, unbound claims that still need runtime authority. */
const staticUnbound = (ledger: ReconstructionObligationLedger) =>
  ledger.obligations.filter(
    ({
      origin,
      binding,
      source_state: sourceState,
      required_original_authority: originalAuthority,
    }) =>
      origin === "generated" &&
      binding === null &&
      sourceState !== "observed" &&
      originalAuthority !== "static",
  ).length;
/** Families the limitation names: static-authority families are not counted. */
const countedFamilies = (ledger: ReconstructionObligationLedger) =>
  [
    ...new Set(
      ledger.obligations
        .filter(
          ({ required_original_authority: authority }) =>
            authority !== "static",
        )
        .map(({ family }) => family),
    ),
  ]
    .sort()
    .join(", ");

describe("reconstruction obligation over-generation", () => {
  it("reports one artifact-level limitation only above the threshold and keeps every candidate", () => {
    const base = build(request(decoyApplication(0).records));
    const baseline = staticUnbound(base);
    expect(baseline).toBeGreaterThan(0);
    expect(overgeneration(base)).toEqual([]);

    const atThreshold = build(
      request(
        decoyApplication(OBLIGATION_OVERGENERATION_THRESHOLD - baseline)
          .records,
      ),
    );
    expect(staticUnbound(atThreshold)).toBe(
      OBLIGATION_OVERGENERATION_THRESHOLD,
    );
    expect(overgeneration(atThreshold)).toEqual([]);

    const flooded = decoyApplication(
      OBLIGATION_OVERGENERATION_THRESHOLD - baseline + 1,
    );
    const ledger = build(request(flooded.records));
    for (const node of flooded.unknownNodes)
      expect(
        ledger.obligations.some(
          ({ target }) => target.application_node_id === node.node_id,
        ),
      ).toBe(true);
    expect(ledger.obligations).toHaveLength(
      base.obligations.length + flooded.unknownNodes.length,
    );
    expect(overgeneration(ledger)).toEqual([
      `obligation-overgeneration: artifact ${APPLICATION_GRAPH_DIGESTS.asar} has ${String(OBLIGATION_OVERGENERATION_THRESHOLD + 1)} generated obligations with no runtime authority and no manifest binding (families: ${countedFamilies(ledger)}), above the threshold of ${String(OBLIGATION_OVERGENERATION_THRESHOLD)}; ${String(OBLIGATION_OVERGENERATION_THRESHOLD + 1)} still unreviewed, 0 retired by reviewed disposition. Stop: do not write fixtures or verifiers for these candidates; obtain runtime authority for the artifact or record a reviewed disposition for each still-unreviewed decoy first.`,
    ]);
    expect(ledger.status).toBe("unknown");
    expect(ledger.coverage.status).toBe("partial");
  });

  it("keeps the limitation when reviewed dispositions retire the surplus and reports the unreviewed count", () => {
    const flooded = decoyApplication(OBLIGATION_OVERGENERATION_THRESHOLD);
    const open = build(request(flooded.records));
    const total = staticUnbound(open);
    const surplus = total - OBLIGATION_OVERGENERATION_THRESHOLD;
    expect(surplus).toBeGreaterThan(0);
    expect(overgeneration(open)).toHaveLength(1);
    const decoys = open.obligations
      .filter(({ target }) =>
        flooded.unknownNodes.some(
          ({ node_id: nodeId }) => target.application_node_id === nodeId,
        ),
      )
      .slice(0, surplus);
    const review = flooded.records[0]!;
    const ledger = build(
      request(flooded.records, {
        reviewed_obligations: decoys.map(({ obligation_id: obligationId }) => ({
          ...reviewedObligation(obligationId, review.evidence_id),
          disposition: "not-applicable" as const,
          disposition_reason: "Decoy channel in dead code.",
        })),
      }),
    );
    // Retired decoys stay in the count: retiring cannot erase the signal.
    expect(overgeneration(ledger)).toHaveLength(1);
    expect(overgeneration(ledger)[0]).toContain(
      `has ${String(total)} generated obligations`,
    );
    expect(overgeneration(ledger)[0]).toContain(
      `; ${String(OBLIGATION_OVERGENERATION_THRESHOLD)} still unreviewed, ${String(surplus)} retired by reviewed disposition.`,
    );
    expect(ledger.status).toBe("unknown");
    expect(ledger.obligations).toHaveLength(open.obligations.length);
    for (const decoy of decoys)
      expect(
        ledger.obligations.find(
          ({ obligation_id: id }) => id === decoy.obligation_id,
        ),
      ).toMatchObject({
        origin: "generated",
        required: true,
        status: "out-of-scope",
        diagnostics: [
          {
            code: "not-applicable",
            detail:
              "Reviewed disposition marks this obligation not applicable; it remains visible. Reason: Decoy channel in dead code.",
          },
        ],
      });
    const retained = new Set(decoys.map(({ obligation_id: id }) => id));
    expect(
      ledger.obligations
        .filter(({ obligation_id: id }) => !retained.has(id))
        .map(({ status }) => status),
    ).toEqual(
      open.obligations
        .filter(({ obligation_id: id }) => !retained.has(id))
        .map(({ status }) => status),
    );
  });

  it("does not reach ready when the real bridge and every decoy bridge are retired", () => {
    const flooded = applicationWithUnknowns(
      Array.from({ length: 25 }, (_, index) => `decoyApi${String(index)}`),
      { kind: "context-bridge-api", label: "decoyApi" },
    );
    const open = build(request(flooded.records));
    const realBridge = open.obligations.find(
      ({ family, title }) =>
        family === "context-bridge" && title === "desktopApi",
    );
    if (realBridge === undefined)
      throw new Error("Expected the fixture context bridge obligation");
    const unbound = staticUnbound(open);
    expect(unbound).toBeGreaterThan(OBLIGATION_OVERGENERATION_THRESHOLD);
    const review = flooded.records[0]!;
    const ledger = build(
      request(flooded.records, {
        reviewed_obligations: open.obligations.map(
          ({ obligation_id: obligationId }) => ({
            ...reviewedObligation(obligationId, review.evidence_id),
            disposition: "out-of-scope" as const,
            disposition_reason: "Bridge retired by a decoy sweep.",
          }),
        ),
      }),
    );
    expect(ledger.obligations).toHaveLength(open.obligations.length);
    expect(
      ledger.obligations.find(
        ({ obligation_id: id }) => id === realBridge.obligation_id,
      ),
    ).toMatchObject({ required: true, status: "out-of-scope" });
    expect(ledger.summary).toMatchObject({
      required: open.obligations.length,
      required_open: open.obligations.length,
    });
    expect(ledger.status).not.toBe("ready");
    expect(ledger.status).toBe("unknown");
    expect(overgeneration(ledger)).toHaveLength(1);
    expect(overgeneration(ledger)[0]).toContain(
      `; 0 still unreviewed, ${String(unbound)} retired by reviewed disposition.`,
    );
  });
});

describe("reconstruction obligation over-generation group", () => {
  it("keeps the generated source state when a retiring review cites observed process Evidence", () => {
    const flooded = decoyApplication(OBLIGATION_OVERGENERATION_THRESHOLD);
    const capture = processEvidence();
    const open = build(request([...flooded.records, capture]));
    const decoys = open.obligations.filter(({ target }) =>
      flooded.unknownNodes.some(
        ({ node_id: nodeId }) => target.application_node_id === nodeId,
      ),
    );
    // The observed process obligation is under another artifact and never
    // counts, so this is the flooded artifact's group.
    const total = staticUnbound(open);
    const ledger = build(
      request([...flooded.records, capture], {
        reviewed_obligations: decoys.map(({ obligation_id: obligationId }) => ({
          ...reviewedObligation(obligationId, capture.evidence_id),
          disposition: "not-applicable" as const,
          disposition_reason: "Decoy channel in dead code.",
        })),
      }),
    );

    // The observed process capture is attached as review Evidence but does
    // not make the decoys look observed, so they stay in the count.
    for (const decoy of decoys) {
      const retiredDecoy = ledger.obligations.find(
        ({ obligation_id: id }) => id === decoy.obligation_id,
      );
      expect(retiredDecoy).toMatchObject({
        status: "out-of-scope",
        source_state: decoy.source_state,
      });
      expect(retiredDecoy?.source_state).not.toBe("observed");
      expect(
        retiredDecoy?.authority_references.map(({ evidence_id: id }) => id),
      ).toContain(capture.evidence_id);
    }
    expect(overgeneration(ledger)).toHaveLength(1);
    expect(overgeneration(ledger)[0]).toContain(
      `artifact ${APPLICATION_GRAPH_DIGESTS.asar} has ${String(total)} generated obligations`,
    );
    expect(overgeneration(ledger)[0]).toContain(
      `; ${String(total - decoys.length)} still unreviewed, ${String(decoys.length)} retired by reviewed disposition.`,
    );
    expect(ledger.status).toBe("unknown");
  });

  it("does not count static-authority native families as lacking runtime authority", () => {
    const flooded = applicationWithUnknowns(
      Array.from({ length: 25 }, (_, index) => `export-${String(index)}`),
      { kind: "native-export", label: "decoy:export" },
    );
    const ledger = build(request(flooded.records));
    const natives = ledger.obligations.filter(({ target }) =>
      flooded.unknownNodes.some(
        ({ node_id: nodeId }) => target.application_node_id === nodeId,
      ),
    );

    expect(natives).toHaveLength(25);
    for (const native of natives)
      expect(native).toMatchObject({
        origin: "generated",
        family: "native-export",
        binding: null,
        source_state: "candidate",
        required_original_authority: "static",
      });
    // Static-authority claims never need runtime authority, so they cannot
    // be told to obtain it: the artifact is not reported as over-generated.
    expect(natives.length + staticUnbound(ledger)).toBeGreaterThan(
      OBLIGATION_OVERGENERATION_THRESHOLD,
    );
    expect(staticUnbound(ledger)).toBeLessThanOrEqual(
      OBLIGATION_OVERGENERATION_THRESHOLD,
    );
    expect(overgeneration(ledger)).toEqual([]);
  });
});

it("keeps each semantic candidate bound to its own file and authority context", () => {
  const contexts = new JavaScriptSemanticEvidenceContextRegistry();
  const base = javascriptApplicationAnalysisResultSchema.parse(
    JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE.normalized_result,
  );
  const sourceRecords = [
    proofEvidence("first-file"),
    proofEvidence("second-file"),
  ];
  const module = createJavaScriptSemanticGraphNode(
    {
      kind: "module",
      identity: {
        artifact_sha256: base.root_artifact_sha256,
        module_path: "app.js",
        source_range: null,
        role_key: "module",
      },
      function_node_id: null,
      application_node_ids: [],
      label: "app.js",
      properties: {},
      evidence: artifactEvidence(base.root_artifact_sha256, "app.js"),
    },
    contexts,
  );
  const requests = sourceRecords.flatMap((source, fileIndex) =>
    [1, 2].map((line) => {
      const sha256 = String(fileIndex + 4).repeat(64);
      const path = `file-${String(fileIndex)}.js`;
      return createJavaScriptSemanticGraphNode(
        {
          kind: "request",
          identity: {
            artifact_sha256: sha256,
            module_path: path,
            source_range: {
              start: { line, column: 0 },
              end: { line, column: 8 },
            },
            role_key: `request-${String(line)}`,
          },
          function_node_id: null,
          application_node_ids: [],
          label: `${path}:${String(line)}`,
          properties: {},
          evidence: {
            ...artifactEvidence(sha256, path, "ast-static-analysis"),
            evidence_ids: [source.evidence_id],
          },
        },
        contexts,
      );
    }),
  );
  const { graph_id: _graphId, ...semantic } = base.semantic_graph;
  const semanticGraph = createJavaScriptSemanticGraph({
    ...semantic,
    root_node_ids: [module.node_id],
    nodes: [module, ...requests],
    evidence_contexts: contexts.contexts,
  });
  const example = JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE;
  const application = createEvidence(
    {
      path: base.input_path,
      sha256: base.root_artifact_sha256,
      format: base.format,
    },
    example.provider,
    {
      predicateType: example.predicate_type,
      operation: example.operation,
      parameters: example.parameters,
      result: { ...base, semantic_graph: semanticGraph },
      confidence: "derived",
      authority: "shipped-artifact",
      evidenceLinks: sourceRecords.map(({ evidence_id }) => evidence_id),
    },
  );
  const generated = deriveCandidates(
    createEvidenceBundle([...sourceRecords, application]),
    [],
  );
  expect(generated.limitations).toEqual([
    `Semantic graph ${semanticGraph.graph_id} coverage is unknown; omitted candidates remain unknown.`,
    `Semantic graph ${semanticGraph.graph_id}: Semantic relations are unavailable in this minimal example.`,
  ]);
  expect(generated.candidates).toHaveLength(requests.length);
  for (const [index, node] of requests.entries()) {
    const source = sourceRecords[Math.floor(index / 2)];
    expect(
      generated.candidates.find(
        ({ target }) => target.semantic_node_id === node.node_id,
      ),
    ).toMatchObject({
      title: node.label,
      family: "request",
      source_state: "candidate",
      target: {
        artifact_sha256: node.identity.artifact_sha256,
        semantic_node_id: node.node_id,
      },
      authority_references: [
        {
          evidence_id: source?.evidence_id,
          authority: "controlled-replay",
          state: "candidate",
          location: `${semanticGraph.graph_id}/node/${node.node_id}`,
        },
      ],
    });
  }
});

it("falls back to a kind-based title when a semantic node label is blank", () => {
  const contexts = new JavaScriptSemanticEvidenceContextRegistry();
  const base = javascriptApplicationAnalysisResultSchema.parse(
    JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE.normalized_result,
  );
  const source = proofEvidence("blank-label-file");
  const module = createJavaScriptSemanticGraphNode(
    {
      kind: "module",
      identity: {
        artifact_sha256: base.root_artifact_sha256,
        module_path: "app.js",
        source_range: null,
        role_key: "module",
      },
      function_node_id: null,
      application_node_ids: [],
      label: "app.js",
      properties: {},
      evidence: artifactEvidence(base.root_artifact_sha256, "app.js"),
    },
    contexts,
  );
  const sha256 = "4".repeat(64);
  const request = createJavaScriptSemanticGraphNode(
    {
      kind: "request",
      identity: {
        artifact_sha256: sha256,
        module_path: "file.js",
        source_range: {
          start: { line: 1, column: 0 },
          end: { line: 1, column: 8 },
        },
        role_key: "request-1",
      },
      function_node_id: null,
      application_node_ids: [],
      label: " ",
      properties: {},
      evidence: {
        ...artifactEvidence(sha256, "file.js", "ast-static-analysis"),
        evidence_ids: [source.evidence_id],
      },
    },
    contexts,
  );
  const { graph_id: _graphId, ...semantic } = base.semantic_graph;
  const semanticGraph = createJavaScriptSemanticGraph({
    ...semantic,
    root_node_ids: [module.node_id],
    nodes: [module, request],
    evidence_contexts: contexts.contexts,
  });
  const example = JAVASCRIPT_APPLICATION_EVIDENCE_EXAMPLE;
  const application = createEvidence(
    {
      path: base.input_path,
      sha256: base.root_artifact_sha256,
      format: base.format,
    },
    example.provider,
    {
      predicateType: example.predicate_type,
      operation: example.operation,
      parameters: example.parameters,
      result: { ...base, semantic_graph: semanticGraph },
      confidence: "derived",
      authority: "shipped-artifact",
      evidenceLinks: [source.evidence_id],
    },
  );
  const generated = deriveCandidates(
    createEvidenceBundle([source, application]),
    [],
  );

  expect(
    generated.candidates.find(
      ({ target }) => target.semantic_node_id === request.node_id,
    )?.title,
  ).toBe("request semantic boundary");
});
