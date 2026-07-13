import { describe, expect, it } from "vitest";

import { createEvidence, type Evidence } from "../src/domain/evidence.js";
import { createEvidenceBundle } from "../src/domain/evidenceBundle.js";
import {
  reconstructionVerificationResultSchema,
  verifyReconstruction,
} from "../src/domain/reconstructionVerification.js";
import type { JsonValue } from "../src/domain/jsonValue.js";
import { EMPTY_PROCESS_CAPTURE_EXAMPLE } from "../src/contracts/processCaptureExample.js";
import { ARTIFACT_COMPARISON_EXAMPLE } from "../src/contracts/artifactComparisonExample.js";
import { createResidualUnknown } from "../src/domain/residualUnknown.js";

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
          ? "rea.process-capture/v4"
          : "rea.analysis/v2",
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
  protocol: "unchanged",
  process: "unchanged",
  shim: "unchanged",
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
      predicateType: "rea.process-comparison/v3",
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
  schema_version: 1 as const,
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

const artifactResult = (partial = false): JsonValue => ({
  status: "unchanged",
  left_manifest_id: `agm_${"3".repeat(64)}`,
  right_manifest_id: `agm_${"4".repeat(64)}`,
  summary: { unchanged: 1, added: 0, removed: 0, changed: 0, unknown: 0 },
  changes: {
    items: [],
    offset: 0,
    limit: 100,
    total: partial ? 1 : 0,
    next_offset: partial ? 1 : null,
  },
  limitations: [],
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
      predicateType: "rea.artifact-comparison/v1",
      operation: "compare_artifacts",
      parameters: {
        left_evidence_ids: [left.evidence_id],
        right_evidence_ids: [right.evidence_id],
      },
      result: artifactResult(partial),
      confidence: "derived",
      authority: "analyst-inference",
      evidenceLinks: [left.evidence_id, right.evidence_id],
    },
  );

describe("reconstruction verification", () => {
  it("passes a complete authoritative claim with two-sided citations", () => {
    const left = source("1", "controlled-replay");
    const right = source("2", "controlled-replay");
    const comparison = processComparison(left, right, processResult());
    const result = verifyReconstruction(
      behavioralSpec(comparison),
      createEvidenceBundle([comparison, right, left]),
      0,
      100,
    );
    expect(reconstructionVerificationResultSchema.parse(result)).toMatchObject({
      status: "pass",
      summary: { total: 1, passed: 1, failed: 0, unknown: 0 },
      claims: { total: 1, next_offset: null },
    });
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
      0,
      100,
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
        0,
        100,
      ).status,
    ).toBe("unknown");

    const left = ARTIFACT_COMPARISON_EXAMPLE.left;
    const right = ARTIFACT_COMPARISON_EXAMPLE.right;
    const comparison = artifactComparison(left, right, true);
    const result = verifyReconstruction(
      {
        schema_version: 1,
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
      0,
      100,
    );
    expect(result.status).toBe("unknown");
    expect(result.recommended_probes[0]?.operation).toBe("inventory_artifact");
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
        0,
        100,
      ),
    ).toThrow(/closure disagrees/u);
  });

  it("pages claims deterministically and gives specification a stable digest", () => {
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
      { schema_version: 1, name: "Compatibility", claims },
      bundle,
      0,
      1,
    );
    const repeated = verifyReconstruction(
      {
        name: "Compatibility",
        claims: [...claims].reverse(),
        schema_version: 1,
      },
      bundle,
      0,
      1,
    );
    expect(first).toEqual(repeated);
    expect(first.claims.items[0]?.claim_id).toBe("terminal-output");
    expect(first.claims.next_offset).toBe(1);
  });

  it("keeps all active unknowns gating while bounding their projection", () => {
    const left = source("1", "controlled-replay");
    const right = source("2", "controlled-replay");
    const comparison = processComparison(left, right, processResult());
    const mutations = Array.from({ length: 101 }, (_, index) =>
      createEvidence(
        undefined,
        { id: "fixture", name: "Fixture", version: "1" },
        {
          predicateType: "rea.residual-unknown-mutation/v1",
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
          approved: true,
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
      0,
      100,
    );
    expect(result.status).toBe("unknown");
    expect(result.claims.items[0]?.unknown_ids).toHaveLength(100);
    expect(result.claims.items[0]?.limitations).toContain(
      "1 additional active residual unknowns affect this claim but are omitted by the 100-item display limit.",
    );
  });
});
