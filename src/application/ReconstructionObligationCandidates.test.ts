import { unknownTarget } from "../domain/targetIdentity.js";
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
import {
  OBLIGATION_OVERGENERATION_THRESHOLD,
  reconstructionObligationLedgerClosureDigest,
  reconstructionObligationOvergeneration,
  reconstructionObligationOvergenerationLimitation,
} from "../domain/reconstructionObligationLedgerIntegrity.js";
import { describe, expect, it, vi } from "vitest";

import { createEvidence } from "../domain/evidence.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import type { ApplicationNode } from "../domain/javascript/javascriptApplicationGraphSchemas.js";
import {
  reconstructionObligationLedgerSchema,
  type ReconstructionObligationLedger,
} from "../domain/reconstructionObligationLedgerSchemas.js";
import {
  emptyUnverifiedProcessCapture,
  FINALIZED_PROCESS_CAPTURE_EXAMPLE,
} from "../domain/process/processCapture.fixture.js";
import { PROCESS_PROVIDER } from "../domain/process/processEvidenceProvider.js";
import {
  parseProcessCapture,
  safeParseProcessCapture,
} from "../domain/process/processCaptureParsing.js";
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
    unknownTarget("not-observed"),
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
  const root = createJavaScriptApplicationNode({
    kind: "artifact",
    identity: {
      strategy: "content-digest",
      stability: "global-exact",
      sha256: APPLICATION_GRAPH_DIGESTS.asar,
    },
    observations: [
      {
        label: "managed root",
        properties: {},
        evidence: artifactEvidence(
          APPLICATION_GRAPH_DIGESTS.asar,
          "artifact-root",
        ),
      },
    ],
  });
  const graph = createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: [root.node_id],
    nodes: [
      ...base.nodes.filter(({ node_id }) => node_id !== root.node_id),
      ...unknownNodes,
      root,
    ],
    edges: base.edges,
    coverage: completeCoverage,
    limitations: base.limitations,
  });
  const application = createEvidence(
    unknownTarget("not-observed"),
    MANAGED_WORKFLOW_PROVIDER,
    {
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
          calls: 0,
          field_accesses: 0,
        },
        graph,
        coverage: { status: "complete-within-inputs" },
        evidence_links: [source.evidence_id],
        limitations: [],
      },
      confidence: "inferred",
      authority: "analyst-inference",
      evidenceLinks: [source.evidence_id],
    },
  );
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
    const warning = generated.limitations.find((value) =>
      value.includes(evidence.evidence_id),
    );
    expect(warning).toMatch(
      /process capture.*no validated executable artifact identity.*lifecycle obligation.*not bound to an artifact/iu,
    );
  });

  it("names the first rejected capture field and the remaining issue count", () => {
    const {
      manifest: { completed_at: _completedAt, ...manifest },
      exit,
      ...rest
    } = FINALIZED_PROCESS_CAPTURE_EXAMPLE;
    const evidence = createEvidence(
      unknownTarget("not-observed"),
      PROCESS_PROVIDER,
      {
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
      },
    );
    const invalid = safeParseProcessCapture(evidence.normalized_result);
    expect(invalid.success).toBe(false);
    if (invalid.success) throw new Error("Expected invalid capture fixture");
    expect(invalid.error.issues).toHaveLength(2);
    const generated = deriveCandidates(createEvidenceBundle([evidence]), []);

    expect(generated.limitations).toHaveLength(1);
    expect(generated.limitations[0]).toContain(evidence.evidence_id);
    expect(generated.limitations[0]).toMatch(
      /Process Evidence.*could not generate candidates.*manifest\.completed_at/iu,
    );
    expect(generated.limitations[0]).toContain("(1 more issues)");
  });
});

const decoyApplication = (count: number) =>
  applicationWithUnknowns(
    Array.from({ length: count }, (_, index) => `decoy-${String(index)}`),
    { kind: "ipc-channel", label: "decoy:channel" },
  );
/** Advisory limitations, selected by their recorded kind. */
const overgeneration = (ledger: ReconstructionObligationLedger) =>
  ledger.limitations.filter(
    (_, index) =>
      ledger.limitation_kinds?.[index] === "obligation-overgeneration",
  );
/**
 * Over-generation facts derived from the obligations. The listed advisory
 * text must be exactly what the owning formatter renders for them.
 */
const overgenerationFacts = (ledger: ReconstructionObligationLedger) => {
  const facts = reconstructionObligationOvergeneration(ledger.obligations);
  expect(overgeneration(ledger)).toEqual(
    facts.map(reconstructionObligationOvergenerationLimitation),
  );
  return facts;
};
/** A generated, unbound claim that still needs runtime authority. */
const isStaticUnbound = ({
  origin,
  binding,
  source_state: sourceState,
  required_original_authority: originalAuthority,
}: ReconstructionObligationLedger["obligations"][number]) =>
  origin === "generated" &&
  binding === null &&
  sourceState !== "observed" &&
  originalAuthority !== "static";
const staticUnbound = (ledger: ReconstructionObligationLedger) =>
  ledger.obligations.filter(isStaticUnbound).length;
/** Families the limitation names: static-authority families are not counted. */
const countedFamilies = (ledger: ReconstructionObligationLedger) =>
  [
    ...new Set(
      ledger.obligations
        .filter(
          ({ required_original_authority: authority, target }) =>
            authority !== "static" &&
            target.artifact_sha256 === APPLICATION_GRAPH_DIGESTS.asar,
        )
        .map(({ family }) => family),
    ),
  ].sort();
/** Expected facts for the flooded root artifact. */
const rootFacts = (
  ledger: ReconstructionObligationLedger,
  total: number,
  retired: number,
) => ({
  artifactSha256: APPLICATION_GRAPH_DIGESTS.asar,
  total,
  retired,
  unreviewed: total - retired,
  families: countedFamilies(ledger),
});

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
    expect(overgenerationFacts(ledger)).toEqual([
      rootFacts(ledger, OBLIGATION_OVERGENERATION_THRESHOLD + 1, 0),
    ]);
    // The graph is complete and nothing was truncated, so the count alone is
    // advisory: coverage and closure match the ledger just below the threshold.
    expect(ledger.limitations).toEqual(overgeneration(ledger));
    expect(ledger.limitation_kinds).toEqual(["obligation-overgeneration"]);
    expect(atThreshold.limitations).toEqual([]);
    expect(ledger.coverage.status).toBe("complete");
    expect(ledger.status).toBe(atThreshold.status);
    expect(ledger.status).toBe("open");
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
    expect(overgenerationFacts(ledger)).toEqual([
      rootFacts(ledger, total, surplus),
    ]);
    expect(ledger.status).toBe("open");
    expect(ledger.obligations).toHaveLength(open.obligations.length);
    for (const decoy of decoys) {
      const retiredDecoy = ledger.obligations.find(
        ({ obligation_id: id }) => id === decoy.obligation_id,
      );
      expect(retiredDecoy).toMatchObject({
        origin: "generated",
        required: true,
        status: "out-of-scope",
      });
      expect(retiredDecoy?.diagnostics.map(({ code }) => code)).toEqual([
        "not-applicable",
      ]);
      expect(retiredDecoy?.diagnostics[0]?.detail).toContain(
        "Decoy channel in dead code.",
      );
    }
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
    // Retired claims stay required and open, so the ledger cannot reach
    // ready even though the over-generation limitation is only advisory.
    expect(ledger.status).not.toBe("ready");
    expect(ledger.status).toBe("open");
    expect(ledger.limitations).toEqual(overgeneration(ledger));
    expect(overgenerationFacts(ledger)).toEqual([
      rootFacts(ledger, unbound, unbound),
    ]);
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
    expect(overgenerationFacts(ledger)).toEqual([
      rootFacts(ledger, total, decoys.length),
    ]);
    expect(ledger.status).toBe(open.status);
    expect(ledger.status).not.toBe("ready");
  });

  it("does not improve the ledger when every claim is retired citing another artifact's observed capture", () => {
    const flooded = decoyApplication(OBLIGATION_OVERGENERATION_THRESHOLD);
    const capture = processEvidence();
    const before = build(request([...flooded.records, capture]));
    const process = before.obligations.find(
      ({ family }) => family === "packaged-process-lifecycle",
    );
    // The cited capture is observed, but it describes another artifact.
    expect(process).toMatchObject({ source_state: "observed" });
    expect(process?.target.artifact_sha256).not.toBe(
      APPLICATION_GRAPH_DIGESTS.asar,
    );
    const total = staticUnbound(before);
    const after = build(
      request([...flooded.records, capture], {
        reviewed_obligations: before.obligations.map(
          ({ obligation_id: obligationId }) => ({
            ...reviewedObligation(obligationId, capture.evidence_id),
            disposition: "out-of-scope" as const,
            disposition_reason: "Retired by a blanket sweep.",
          }),
        ),
      }),
    );

    expect(after.obligations.map(({ status }) => status)).toEqual(
      before.obligations.map(() => "out-of-scope"),
    );
    // Review provenance is not a runtime observation of the flooded artifact.
    expect(staticUnbound(after)).toBe(total);
    expect(overgenerationFacts(before)).toEqual([rootFacts(before, total, 0)]);
    expect(overgenerationFacts(after)).toEqual([
      rootFacts(after, total, total),
    ]);
    const others = (ledger: ReconstructionObligationLedger) =>
      ledger.limitations.filter(
        (_, index) => ledger.limitation_kinds?.[index] === "closure",
      );
    expect(others(after)).toEqual(others(before));
    expect(after.coverage.status).toBe(before.coverage.status);
    const rank = { failed: 0, unknown: 1, open: 2, ready: 3 } as const;
    expect(rank[after.status]).toBeLessThanOrEqual(rank[before.status]);
    expect(after.status).not.toBe("ready");
  });

  it.each([
    ["a second retiring review", "out-of-scope"],
    ["an active review", "active"],
  ] as const)(
    "keeps the generated source state when %s also cites observed process Evidence",
    (_, secondDisposition) => {
      const flooded = decoyApplication(OBLIGATION_OVERGENERATION_THRESHOLD);
      const capture = processEvidence();
      const open = build(request([...flooded.records, capture]));
      const decoys = open.obligations.filter(({ target }) =>
        flooded.unknownNodes.some(
          ({ node_id: nodeId }) => target.application_node_id === nodeId,
        ),
      );
      const total = staticUnbound(open);
      const ledger = build(
        request([...flooded.records, capture], {
          reviewed_obligations: decoys.flatMap(
            ({ obligation_id: obligationId }) => [
              {
                ...reviewedObligation(obligationId, capture.evidence_id),
                disposition: "not-applicable" as const,
                disposition_reason: "Decoy channel in dead code.",
              },
              secondDisposition === "active"
                ? reviewedObligation(obligationId, capture.evidence_id)
                : {
                    ...reviewedObligation(obligationId, capture.evidence_id),
                    disposition: secondDisposition,
                    disposition_reason: "Decoy channel reviewed again.",
                  },
            ],
          ),
        }),
      );

      // Every later review of a generated claim attaches its Evidence without
      // making the claim look observed, so the decoys stay in the count. Two
      // reviews of one claim compete, so neither retires it.
      for (const decoy of decoys) {
        const contestedDecoy = ledger.obligations.find(
          ({ obligation_id: id }) => id === decoy.obligation_id,
        );
        expect(contestedDecoy).toMatchObject({
          origin: "generated",
          status: "unknown",
          source_state: decoy.source_state,
        });
        expect(contestedDecoy?.source_state).not.toBe("observed");
        expect(contestedDecoy?.diagnostics.map(({ code }) => code)).toContain(
          "duplicate-definition",
        );
        expect(
          contestedDecoy?.authority_references.map(({ evidence_id: id }) => id),
        ).toContain(capture.evidence_id);
      }
      expect(overgenerationFacts(ledger)).toEqual([
        rootFacts(ledger, total, 0),
      ]);
      expect(ledger.status).toBe("unknown");
      expect(ledger.coverage.status).toBe(open.coverage.status);
    },
  );

  it("groups several thousand unbound candidates of one artifact into one limitation", () => {
    const count = 5000;
    const ledger = build(request(decoyApplication(count).records));
    const total = staticUnbound(ledger);

    expect(total).toBeGreaterThanOrEqual(count);
    expect(overgenerationFacts(ledger)).toEqual([rootFacts(ledger, total, 0)]);
    // Each artifact's group is stored once and updated in place: grouping
    // that copied the group per obligation would store it once per claim.
    const set = vi.spyOn(Map.prototype, "set");
    try {
      reconstructionObligationOvergeneration(ledger.obligations);
      expect(set).toHaveBeenCalledTimes(
        new Set(
          ledger.obligations
            .filter(isStaticUnbound)
            .map(({ target }) => target.artifact_sha256),
        ).size,
      );
    } finally {
      set.mockRestore();
    }
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

/** Re-commit an edited retained ledger so only the edit is under test. */
const recommit = <
  Ledger extends Omit<ReconstructionObligationLedger, "closure_digest">,
>(
  ledger: Ledger,
) => ({
  ...ledger,
  closure_digest: reconstructionObligationLedgerClosureDigest(ledger),
});

describe("reconstruction obligation limitation kinds", () => {
  /** A flooded artifact, optionally with an orphan manifest entry that bounds closure. */
  const floodedLedger = (withClosureLimitation: boolean) => {
    const flooded = decoyApplication(OBLIGATION_OVERGENERATION_THRESHOLD);
    return build(
      request(flooded.records, {
        manifest: {
          bindings: withClosureLimitation
            ? [
                {
                  obligation_id: "obl.orphan",
                  owner: {
                    module_path: "src/orphan.ts",
                    symbol: "orphan",
                    owner_sha256: "9".repeat(64),
                  },
                  parser_type: null,
                  original_cases: [],
                  fixtures: [],
                  verifier: null,
                },
              ]
            : [],
          contradictions: [],
        },
      }),
    );
  };
  const cases = [
    ["only an advisory limitation", false],
    ["an advisory and a closure limitation", true],
  ] as const;

  it.each(cases)(
    "records each kind, so a ledger with %s keeps coverage and status when every sentence is reworded",
    (_, withClosure) => {
      const ledger = floodedLedger(withClosure);
      expect(ledger.limitation_kinds).toEqual(
        expect.arrayContaining(["obligation-overgeneration"]),
      );
      expect(ledger.limitation_kinds).toHaveLength(ledger.limitations.length);
      expect(
        ledger.limitation_kinds?.filter((kind) => kind === "closure"),
      ).toHaveLength(withClosure ? 1 : 0);
      expect(ledger.coverage.status).toBe(withClosure ? "partial" : "complete");
      expect(ledger.status).toBe(withClosure ? "unknown" : "open");

      const reworded = reconstructionObligationLedgerSchema.parse(
        recommit({
          ...ledger,
          limitations: ledger.limitations.map(
            (_text, index) => `Reworded limitation ${String(index)}.`,
          ),
        }),
      );
      expect(reworded.coverage).toEqual(ledger.coverage);
      expect(reworded.status).toBe(ledger.status);
    },
  );

  it.each(cases)(
    "parses a ledger with %s retained without kinds and keeps its coverage and status",
    (_, withClosure) => {
      const {
        limitation_kinds: _kinds,
        closure_digest: _digest,
        ...retained
      } = floodedLedger(withClosure);
      const parsed = reconstructionObligationLedgerSchema.parse(
        recommit(retained),
      );

      expect(parsed.limitation_kinds).toBeUndefined();
      expect(parsed.coverage.status).toBe(withClosure ? "partial" : "complete");
      expect(parsed.status).toBe(withClosure ? "unknown" : "open");
    },
  );

  it("parses a ledger retained before advisory limitations with every limitation bounding closure", () => {
    const ledger = floodedLedger(true);
    const {
      limitation_kinds: kinds,
      closure_digest: _digest,
      ...retained
    } = ledger;
    // Written before over-generation was reported: only the closure
    // limitation is listed, although the obligations are over-generated.
    const parsed = reconstructionObligationLedgerSchema.parse(
      recommit({
        ...retained,
        limitations: retained.limitations.filter(
          (_text, index) => kinds?.[index] === "closure",
        ),
      }),
    );

    expect(
      reconstructionObligationOvergeneration(parsed.obligations),
    ).toHaveLength(1);
    expect(parsed.coverage.status).toBe("partial");
    expect(parsed.status).toBe("unknown");
  });

  it("rejects kinds that mark a closure limitation advisory", () => {
    const ledger = floodedLedger(true);
    const result = reconstructionObligationLedgerSchema.safeParse(
      recommit({
        ...ledger,
        limitation_kinds: ledger.limitations.map(
          () => "obligation-overgeneration" as const,
        ),
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues.map(({ path }) => path)).toContainEqual([
      "limitation_kinds",
    ]);
  });
});

describe("reconstruction obligation review authority", () => {
  it.each([
    ["another artifact", false],
    ["the obligation's own artifact", true],
  ] as const)(
    "grants runtime authority to a non-retiring review citing a process capture of %s only for that artifact",
    (_, ownArtifact) => {
      const flooded = decoyApplication(1);
      const capture = processEvidence();
      const executable = build(request([capture])).obligations[0]?.target
        .artifact_sha256;
      if (executable === undefined || executable === null)
        throw new Error("Expected the capture's executable artifact");
      const review = {
        ...reviewedObligation("obl.review.runtime", capture.evidence_id),
        target: {
          artifact_sha256: ownArtifact
            ? executable
            : APPLICATION_GRAPH_DIGESTS.asar,
          application_node_id: null,
          semantic_node_id: null,
          location: "/reviewed/runtime",
        },
        required_original_authority: "runtime" as const,
      };
      const before = build(request([...flooded.records, capture]));
      const decoy = before.obligations.find(
        ({ target, required_original_authority: authority }) =>
          target.application_node_id === flooded.unknownNodes[0]?.node_id &&
          authority !== "static",
      );
      if (decoy === undefined) throw new Error("Expected a decoy obligation");
      const ledger = build(
        request([...flooded.records, capture], {
          reviewed_obligations: [
            review,
            // An active review of the generated decoy cites the same capture.
            reviewedObligation(decoy.obligation_id, capture.evidence_id),
          ],
        }),
      );
      const reviewed = ledger.obligations.find(
        ({ obligation_id: id }) => id === review.obligation_id,
      );
      const reviewedDecoy = ledger.obligations.find(
        ({ obligation_id: id }) => id === decoy.obligation_id,
      );
      const captureReference = (
        obligation:
          | ReconstructionObligationLedger["obligations"][number]
          | undefined,
      ) =>
        obligation?.authority_references.find(
          ({ evidence_id: id }) => id === capture.evidence_id,
        );
      const replayCount = (current: ReconstructionObligationLedger) =>
        current.summary.by_evidence_authority.find(
          ({ key }) => key === "controlled-replay",
        )?.count;

      // The decoy names the application artifact, which the capture does
      // not observe, so the review grants it no runtime authority.
      expect(decoy.diagnostics.map(({ code }) => code)).toContain(
        "static-only",
      );
      expect(captureReference(reviewedDecoy)).toMatchObject({
        authority: "controlled-replay",
        state: "other-artifact",
      });
      expect(reviewedDecoy?.diagnostics.map(({ code }) => code)).toContain(
        "static-only",
      );
      expect(captureReference(reviewed)).toMatchObject({
        authority: "controlled-replay",
        state: ownArtifact ? "observed" : "other-artifact",
      });
      expect(
        reviewed?.diagnostics.some(({ code }) => code === "static-only"),
      ).toBe(!ownArtifact);
      // The process obligation always counts the capture; the reviewed
      // obligation counts it only for its own artifact, the decoy never.
      expect(replayCount(before)).toBe(1);
      expect(replayCount(ledger)).toBe(ownArtifact ? 2 : 1);
    },
  );

  it.each([
    ["another artifact", "c".repeat(64), false],
    ["the obligation's own artifact", APPLICATION_GRAPH_DIGESTS.asar, true],
  ] as const)(
    "counts a non-process controlled-replay record of %s cited by a review only for that artifact",
    (_, sha256, ownArtifact) => {
      const replay = createEvidence(
        { path: "/fixture/replayed", sha256, format: "mach-o" },
        { id: "fixture-replay", name: "Fixture replay", version: "1" },
        {
          operation: "replay_fixture",
          parameters: {},
          result: { replayed: true },
          confidence: "observed",
          authority: "controlled-replay",
        },
      );
      const ledger = build(
        request([replay], {
          reviewed_obligations: [
            {
              ...reviewedObligation("obl.review.replay", replay.evidence_id),
              target: {
                artifact_sha256: APPLICATION_GRAPH_DIGESTS.asar,
                application_node_id: null,
                semantic_node_id: null,
                location: "/reviewed/replay",
              },
            },
          ],
        }),
      );

      expect(ledger.obligations[0]?.authority_references).toEqual([
        expect.objectContaining({
          evidence_id: replay.evidence_id,
          authority: "controlled-replay",
          state: ownArtifact ? "reviewed" : "other-artifact",
        }),
      ]);
      expect(
        ledger.summary.by_evidence_authority.find(
          ({ key }) => key === "controlled-replay",
        )?.count,
      ).toBe(ownArtifact ? 1 : 0);
    },
  );
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
  expect(generated.limitations).toHaveLength(2);
  expect(generated.limitations).toContainEqual(
    expect.stringMatching(
      /coverage is unknown.*omitted candidates remain unknown/iu,
    ),
  );
  expect(
    generated.limitations.every((limitation) =>
      limitation.includes(semanticGraph.graph_id),
    ),
  ).toBe(true);
  expect(generated.limitations).toContainEqual(
    expect.stringContaining(
      "Semantic relations are unavailable in this minimal example.",
    ),
  );
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
