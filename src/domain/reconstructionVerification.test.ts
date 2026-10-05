import { describe, expect, it } from "vitest";

import { createEvidence, type Evidence } from "./evidence.js";
import { createEvidenceBundle } from "./evidenceBundle.js";
import {
  reconstructionVerificationResultSchema,
  verifyReconstruction,
} from "./reconstructionVerification.js";
import type { JsonValue } from "./jsonValue.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "./processCapture.fixture.js";
import { reconstructionSpecificationSchema } from "./reconstructionVerificationSchemas.js";
import { ARTIFACT_COMPARISON_EXAMPLE } from "../contracts/artifactComparisonExample.js";
import { createResidualUnknown } from "./residualUnknown.js";

const environment = {
  id: "fixture-linux",
  platform: "linux",
  architecture: "x86_64",
  isolation: "container" as const,
};

const source = (
  digit: string,
  authority: "controlled-replay" | "shipped-artifact",
  confidence: "observed" | "derived" = "observed",
): Evidence =>
  createEvidence(
    {
      path: `/tmp/source-${digit}`,
      sha256: digit.repeat(64),
      format: "file",
    },
    { id: "fixture", name: "Fixture", version: "1" },
    {
      predicateType:
        authority === "controlled-replay"
          ? "rea.process-capture"
          : "rea.analysis",
      operation:
        authority === "controlled-replay"
          ? "capture_process_scenario"
          : "inventory_artifact",
      parameters: {},
      result:
        authority === "controlled-replay"
          ? EMPTY_PROCESS_CAPTURE_EXAMPLE
          : { digit },
      confidence,
      authority,
      environment: authority === "controlled-replay" ? environment : null,
    },
  );

const processResult = (
  terminal: "unchanged" | "changed" | "unknown" = "unchanged",
): JsonValue => ({
  status: terminal === "changed" ? "changed" : terminal,
  terminal,
  interaction: "unchanged",
  exit: "unchanged",
  filesystem: "unchanged",
  process: "unchanged",
  first_divergence:
    terminal === "changed"
      ? {
          status: "found",
          dimension: "terminal",
          index: 0,
          left_at_ms: 0,
          right_at_ms: 0,
          left: "left",
          right: "right",
        }
      : terminal === "unknown"
        ? { status: "unknown", reason: "Incomplete fixture." }
        : { status: "none" },
  limitations: [],
});

const processComparison = (
  left: Evidence,
  right: Evidence,
  result: JsonValue,
  extraLinks: readonly string[] = [],
): Evidence =>
  createEvidence(
    undefined,
    {
      id: "rea-process",
      name: "REA deterministic process harness",
      version: "3",
    },
    {
      predicateType: "rea.process-comparison",
      operation: "compare_process_captures",
      parameters: {
        left_evidence_id: left.evidence_id,
        right_evidence_id: right.evidence_id,
      },
      result,
      confidence: "derived",
      authority: "analyst-inference",
      evidenceLinks: [left.evidence_id, right.evidence_id, ...extraLinks],
    },
  );

const behavioralSpec = (comparison: Evidence) => ({
  name: "CLI compatibility",
  claims: [
    {
      kind: "behavioral" as const,
      claim_id: "terminal-output",
      title: "Terminal output remains equal",
      comparison_evidence_id: comparison.evidence_id,
      dimension: "terminal" as const,
    },
  ],
});

const artifactResult = (
  partial = false,
  evidenceLinks: readonly string[] = [],
): JsonValue => ({
  status: partial ? "truncated" : "unchanged",
  left_manifest_id: `agm_${"3".repeat(64)}`,
  right_manifest_id: `agm_${"4".repeat(64)}`,
  summary: {
    unchanged: partial ? 0 : 1,
    added: 0,
    removed: 0,
    changed: 0,
    unknown: partial ? 1 : 0,
  },
  changes: partial
    ? [
        {
          classification: "unknown",
          logical_path: "unavailable",
          dimensions: ["availability"],
          left_occurrence_id: null,
          right_occurrence_id: null,
          left_artifact_id: null,
          right_artifact_id: null,
          evidence_links: [...evidenceLinks],
        },
      ]
    : [],
  limitations: partial ? ["Inventory evidence is incomplete."] : [],
});

const artifactComparison = (
  left: Evidence,
  right: Evidence,
  partial = false,
): Evidence =>
  createEvidence(
    undefined,
    {
      id: "rea-artifact-comparison",
      name: "REA artifact comparison",
      version: "1",
    },
    {
      predicateType: "rea.artifact-comparison",
      operation: "compare_artifacts",
      parameters: {
        left_evidence_ids: [left.evidence_id],
        right_evidence_ids: [right.evidence_id],
      },
      result: artifactResult(partial, [left.evidence_id, right.evidence_id]),
      confidence: "derived",
      authority: "analyst-inference",
      evidenceLinks: [left.evidence_id, right.evidence_id],
    },
  );

describe("reconstruction verification", () => {
  it("accepts real process dimensions and rejects removed protocol dimensions", () => {
    const left = source("1", "controlled-replay");
    const right = source("2", "controlled-replay");
    const result = {
      status: "changed",
      terminal: "unchanged",
      interaction: "changed",
      exit: "unchanged",
      filesystem: "unchanged",
      process: "unchanged",
      first_divergence: {
        status: "found",
        dimension: "interaction",
        index: 0,
        left_at_ms: 0,
        right_at_ms: 0,
        left: "left",
        right: "right",
      },
      limitations: [],
    } satisfies JsonValue;
    const comparison = processComparison(left, right, result);

    expect(
      verifyReconstruction(
        {
          name: "Interaction reconstruction",
          claims: [
            {
              kind: "behavioral",
              claim_id: "interaction",
              title: "Interaction remains equivalent",
              comparison_evidence_id: comparison.evidence_id,
              dimension: "interaction",
            },
            {
              kind: "behavioral",
              claim_id: "process",
              title: "Process behavior remains equivalent",
              comparison_evidence_id: comparison.evidence_id,
              dimension: "process",
            },
          ],
        },
        createEvidenceBundle([comparison, right, left]),
      ),
    ).toMatchObject({
      summary: { total: 2, passed: 1, failed: 1, unknown: 0 },
    });
    for (const dimension of ["protocol", "shim"] as const) {
      expect(
        reconstructionSpecificationSchema.safeParse({
          name: "Removed process dimension",
          claims: [
            {
              kind: "behavioral",
              claim_id: dimension,
              title: "Unsupported dimension",
              comparison_evidence_id: comparison.evidence_id,
              dimension,
            },
          ],
        }).success,
      ).toBe(false);
    }
  });

  it("passes a complete authoritative claim with two-sided citations", () => {
    const left = source("1", "controlled-replay");
    const right = source("2", "controlled-replay");
    const comparison = processComparison(left, right, processResult());
    const result = verifyReconstruction(
      behavioralSpec(comparison),
      createEvidenceBundle([comparison, right, left]),
    );
    expect(reconstructionVerificationResultSchema.parse(result)).toMatchObject({
      status: "pass",
      summary: { total: 1, passed: 1, failed: 0, unknown: 0 },
      claims: { items: expect.any(Array) },
    });
    expect(
      reconstructionVerificationResultSchema.safeParse({
        ...result,
        summary: { ...result.summary, passed: 0 },
      }).success,
    ).toBe(false);
    expect(
      reconstructionVerificationResultSchema.safeParse({
        ...result,
        status: "unknown",
      }).success,
    ).toBe(false);
    expect(result.claims.items[0]?.evidence_links).toEqual(
      expect.arrayContaining([
        comparison.evidence_id,
        left.evidence_id,
        right.evidence_id,
      ]),
    );
  });

  it("fails an authoritative observed disagreement", () => {
    const left = source("1", "controlled-replay");
    const right = source("2", "controlled-replay");
    const comparison = processComparison(left, right, processResult("changed"));
    const result = verifyReconstruction(
      behavioralSpec(comparison),
      createEvidenceBundle([left, right, comparison]),
    );
    expect(result).toMatchObject({
      status: "fail",
      summary: { failed: 1 },
      claims: { items: [{ status: "fail", observed_status: "changed" }] },
    });
  });

  it("keeps insufficient authority and partial structural evidence unknown", () => {
    const weakLeft = source("1", "controlled-replay", "derived");
    const replayRight = source("2", "controlled-replay");
    const runtime = processComparison(weakLeft, replayRight, processResult());
    expect(
      verifyReconstruction(
        behavioralSpec(runtime),
        createEvidenceBundle([weakLeft, replayRight, runtime]),
      ).status,
    ).toBe("unknown");

    const left = ARTIFACT_COMPARISON_EXAMPLE.left;
    const right = ARTIFACT_COMPARISON_EXAMPLE.right;
    const comparison = artifactComparison(left, right, true);
    const result = verifyReconstruction(
      {
        name: "Artifact structure",
        claims: [
          {
            kind: "structural-artifact",
            claim_id: "artifact-graph",
            title: "Artifact graph remains equal",
            comparison_evidence_id: comparison.evidence_id,
            dimension: "overall",
          },
        ],
      },
      createEvidenceBundle([left, comparison, right]),
    );
    expect(result.status).toBe("unknown");
    expect(result.recommended_probes[0]?.operation).toBe("inspect_artifact");
  });
});

describe("reconstruction verification integrity", () => {
  it("accepts evidence closures larger than the former count ceilings", () => {
    const evidenceIds = Array.from(
      { length: 20_101 },
      (_, index) => `ev_${index.toString(16).padStart(64, "0")}`,
    );
    const claimLinks = evidenceIds.slice(0, 202);
    const claim = {
      claim_id: "claim",
      kind: "structural-artifact",
      dimension: "overall",
      status: "pass",
      observed_status: "unchanged",
      comparison_evidence_id: claimLinks[0],
      left_evidence_ids: [claimLinks[1]],
      right_evidence_ids: [claimLinks[2]],
      evidence_links: claimLinks,
      unknown_ids: [],
      limitations: [],
    };
    const result = {
      status: "pass",
      specification_sha256: "a".repeat(64),
      summary: {
        total: 1,
        passed: 1,
        failed: 0,
        unknown: 0,
        behavioral: 0,
        structural: 1,
      },
      claims: { items: [claim] },
      recommended_probes: [],
      evidence_links: evidenceIds,
      limitations: [],
    };

    expect(reconstructionVerificationResultSchema.parse(result)).toEqual(
      result,
    );
  });

  it("rejects dangling or extra comparison closure", () => {
    const left = source("1", "controlled-replay");
    const right = source("2", "controlled-replay");
    const extra = source("3", "controlled-replay");
    const comparison = processComparison(left, right, processResult(), [
      extra.evidence_id,
    ]);
    expect(() =>
      verifyReconstruction(
        behavioralSpec(comparison),
        createEvidenceBundle([left, right, extra, comparison]),
      ),
    ).toThrow(/closure disagrees/u);
  });

  it("returns every claim deterministically and gives specification a stable digest", () => {
    const left = source("1", "controlled-replay");
    const right = source("2", "controlled-replay");
    const comparison = processComparison(left, right, processResult());
    const claims = [
      {
        kind: "behavioral" as const,
        claim_id: "z-exit",
        title: "Exit remains equal",
        comparison_evidence_id: comparison.evidence_id,
        dimension: "exit" as const,
      },
      behavioralSpec(comparison).claims[0],
    ];
    const bundle = createEvidenceBundle([right, comparison, left]);
    const first = verifyReconstruction(
      { name: "Compatibility", claims },
      bundle,
    );
    const repeated = verifyReconstruction(
      {
        name: "Compatibility",
        claims: [...claims].reverse(),
      },
      bundle,
    );
    expect(first).toEqual(repeated);
    expect(first.claims.items.map(({ claim_id }) => claim_id)).toEqual([
      "terminal-output",
      "z-exit",
    ]);
  });

  it("returns all active unknowns while keeping them gating", () => {
    const left = source("1", "controlled-replay");
    const right = source("2", "controlled-replay");
    const comparison = processComparison(left, right, processResult());
    const mutations = Array.from({ length: 101 }, (_, index) =>
      createEvidence(
        undefined,
        { id: "fixture", name: "Fixture", version: "1" },
        {
          predicateType: "rea.residual-unknown-mutation",
          operation: "record_unknown",
          parameters: { index },
          result: { action: "record" },
          confidence: "derived",
          authority: "analyst-inference",
          evidenceLinks: [comparison.evidence_id],
        },
      ),
    );
    const unknowns = mutations.map((mutation, index) =>
      createResidualUnknown(
        {
          question: `Unresolved replay ${index}`,
          severity: "high",
          domain: "reconstruction-verification",
          supporting_evidence_ids: [comparison.evidence_id],
          contradicting_evidence_ids: [],
          required_authority: "controlled-replay",
          required_confidence: "observed",
          required_environment: null,
          recommended_probes: [],
          relationships: [],
        },
        mutation.evidence_id,
        null,
      ),
    );
    const result = verifyReconstruction(
      behavioralSpec(comparison),
      createEvidenceBundle([left, right, comparison, ...mutations], unknowns),
    );
    expect(result.status).toBe("unknown");
    expect(result.claims.items[0]?.unknown_ids).toHaveLength(101);
  });
});
