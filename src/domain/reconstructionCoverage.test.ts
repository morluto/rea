import { describe, expect, it } from "vitest";

import {
  completeReconstructionCoverageData,
  RECONSTRUCTION_COVERAGE_NOW,
  reconstructionCoverageEvidenceId,
} from "./reconstructionCoverage.fixture.js";
import {
  createReconstructionCoverageData,
  createReconstructionVerifierContract,
  evaluateReconstructionClosure,
} from "./reconstructionCoverage.js";

const digest = (character: string): string => character.repeat(64);

describe("reconstruction coverage closure", () => {
  it("returns ready only when ownership, verification, package, and authority closure pass", () => {
    const workspace = completeReconstructionCoverageData();

    expect(
      evaluateReconstructionClosure(
        workspace,
        "replacement.cli",
        RECONSTRUCTION_COVERAGE_NOW,
      ),
    ).toMatchObject({
      status: "ready",
      summary: { required_surfaces: 1, required_claims: 1, reasons: 0 },
      evidence_ids: [
        reconstructionCoverageEvidenceId("2"),
        reconstructionCoverageEvidenceId("3"),
        reconstructionCoverageEvidenceId("4"),
        reconstructionCoverageEvidenceId("5"),
      ].sort(),
    });
    expect(createReconstructionCoverageData(workspace)).toEqual(workspace);
  });

  it("keeps an incomplete inventory partial despite every registered verifier passing", () => {
    const workspace = completeReconstructionCoverageData();
    const semantic = workspace;
    const boundary = workspace.boundaries[0];
    if (boundary === undefined) throw new Error("Expected fixture boundary");
    const incomplete = createReconstructionCoverageData({
      ...semantic,
      boundaries: [
        {
          ...boundary,
          required_surface_ids: ["cli.help", "cli.version"],
        },
      ],
    });

    expect(
      evaluateReconstructionClosure(
        incomplete,
        "replacement.cli",
        RECONSTRUCTION_COVERAGE_NOW,
      ),
    ).toMatchObject({
      status: "partial",
      reasons: [
        expect.objectContaining({
          code: "surface-missing",
          subject_id: "cli.version",
        }),
      ],
      recommended_probes: [
        {
          operation: "update_authoritative_inventory",
          subject_id: "cli.version",
          rationale:
            "Required surface is absent from the authoritative inventory.",
        },
      ],
    });
  });

  it("returns recommendations for every missing required surface", () => {
    const workspace = completeReconstructionCoverageData();
    const boundary = workspace.boundaries[0];
    if (boundary === undefined) throw new Error("Expected fixture boundary");
    const missingSurfaces = Array.from(
      { length: 10_001 },
      (_, index) => `missing.surface.${index}`,
    );
    const incomplete = createReconstructionCoverageData({
      ...workspace,
      boundaries: [{ ...boundary, required_surface_ids: missingSurfaces }],
    });

    const result = evaluateReconstructionClosure(
      incomplete,
      boundary.boundary_id,
      RECONSTRUCTION_COVERAGE_NOW,
    );

    expect(result.reasons).toHaveLength(missingSurfaces.length);
    expect(result.recommended_probes).toHaveLength(missingSurfaces.length);
  });

  it("invalidates stale verifier contracts and detected authority routing", () => {
    const workspace = completeReconstructionCoverageData();
    const owner = workspace.owners[0];
    if (owner === undefined || owner.ownership.disposition !== "implemented")
      throw new Error("Expected implemented fixture owner");
    const semantic = workspace;
    const changed = createReconstructionCoverageData({
      ...semantic,
      owners: [
        {
          ...owner,
          ownership: {
            ...owner.ownership,
            owner_sha256: digest("9"),
            path_state: "present",
            package_state: "distributed",
            authority_route: "detected",
          },
        },
      ],
    });

    const result = evaluateReconstructionClosure(
      changed,
      "replacement.cli",
      RECONSTRUCTION_COVERAGE_NOW,
    );
    expect(result.status).toBe("failed");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "authority-routing-detected" }),
        expect.objectContaining({ code: "verifier-result-incompatible" }),
      ]),
    );
  });

  it("does not let stale verifier results satisfy current claims", () => {
    const workspace = completeReconstructionCoverageData();
    const semantic = workspace;
    const stale = createReconstructionCoverageData({
      ...semantic,
      verifier_results: workspace.verifier_results.map((result) => ({
        ...result,
        observed_at: "2026-07-01T00:00:00.000Z",
      })),
    });

    expect(
      evaluateReconstructionClosure(
        stale,
        "replacement.cli",
        RECONSTRUCTION_COVERAGE_NOW,
      ),
    ).toMatchObject({
      status: "unknown",
      reasons: [expect.objectContaining({ code: "verifier-result-stale" })],
    });
  });
});

describe("reconstruction coverage verifier observations", () => {
  it("uses one contract and result for each claim covered by a shared verifier", () => {
    const workspace = completeReconstructionCoverageData();
    const contract = workspace.verifier_contracts[0];
    const result = workspace.verifier_results[0];
    const claim = workspace.claims[0];
    const boundary = workspace.boundaries[0];
    if (
      contract === undefined ||
      result === undefined ||
      claim === undefined ||
      boundary === undefined
    )
      throw new Error("Expected complete reconstruction coverage fixture");
    const secondClaimId = "claim.cli.version";
    const sharedContract = createReconstructionVerifierContract({
      verifier_id: contract.verifier_id,
      claim_ids: [...contract.claim_ids, secondClaimId],
      dimensions: contract.dimensions,
      authority: contract.authority,
      max_age_ms: contract.max_age_ms,
      minimum_repeats: contract.minimum_repeats,
      normalization_sha256: contract.normalization_sha256,
      normalization_removes_dimensions:
        contract.normalization_removes_dimensions,
    });
    const sharedResult = {
      ...result,
      contract_sha256: sharedContract.contract_sha256,
      covered_claim_ids: [...result.covered_claim_ids, secondClaimId],
    };
    const shared = createReconstructionCoverageData({
      ...workspace,
      claims: [
        ...workspace.claims,
        { ...claim, claim_id: secondClaimId, title: "Version output matches" },
      ],
      verifier_contracts: [sharedContract],
      verifier_results: [sharedResult],
      boundaries: [
        {
          ...boundary,
          required_claim_ids: [...boundary.required_claim_ids, secondClaimId],
        },
      ],
    });

    expect(
      evaluateReconstructionClosure(
        shared,
        boundary.boundary_id,
        RECONSTRUCTION_COVERAGE_NOW,
      ),
    ).toMatchObject({
      status: "ready",
      summary: { required_claims: 2, reasons: 0 },
    });
  });
});

describe("reconstruction coverage verifier selection", () => {
  it("keeps ambiguous verifier contracts and missing results actionable", () => {
    const workspace = completeReconstructionCoverageData();
    const contract = workspace.verifier_contracts[0];
    const result = workspace.verifier_results[0];
    const boundary = workspace.boundaries[0];
    if (
      contract === undefined ||
      result === undefined ||
      boundary === undefined
    )
      throw new Error("Expected complete reconstruction coverage fixture");
    const alternateContract = createReconstructionVerifierContract({
      verifier_id: "verify.cli.help.alternate",
      claim_ids: contract.claim_ids,
      dimensions: contract.dimensions,
      authority: contract.authority,
      max_age_ms: contract.max_age_ms,
      minimum_repeats: contract.minimum_repeats,
      normalization_sha256: contract.normalization_sha256,
      normalization_removes_dimensions:
        contract.normalization_removes_dimensions,
    });
    const ambiguous = createReconstructionCoverageData({
      ...workspace,
      verifier_contracts: [...workspace.verifier_contracts, alternateContract],
      verifier_results: [
        ...workspace.verifier_results,
        {
          ...result,
          verifier_id: alternateContract.verifier_id,
          contract_sha256: alternateContract.contract_sha256,
        },
      ],
    });
    expect(
      evaluateReconstructionClosure(
        ambiguous,
        boundary.boundary_id,
        RECONSTRUCTION_COVERAGE_NOW,
      ).reasons,
    ).toEqual([
      expect.objectContaining({
        code: "verifier-duplicate",
        subject_id: "claim.cli.help",
      }),
    ]);

    const missing = createReconstructionCoverageData({
      ...workspace,
      verifier_results: [],
    });
    expect(
      evaluateReconstructionClosure(
        missing,
        boundary.boundary_id,
        RECONSTRUCTION_COVERAGE_NOW,
      ).reasons,
    ).toEqual([
      expect.objectContaining({
        code: "verifier-result-missing",
        subject_id: "claim.cli.help",
      }),
    ]);
  });
});

describe("reconstruction coverage verifier result ordering", () => {
  it("preserves the first input result when verifier timestamps tie", () => {
    const workspace = completeReconstructionCoverageData();
    const result = workspace.verifier_results[0];
    const boundary = workspace.boundaries[0];
    if (result === undefined || boundary === undefined)
      throw new Error("Expected complete reconstruction coverage fixture");
    const failed = { ...result, status: "fail" as const };
    const firstPass = createReconstructionCoverageData({
      ...workspace,
      verifier_results: [result, failed],
    });
    const firstFail = createReconstructionCoverageData({
      ...workspace,
      verifier_results: [failed, result],
    });

    expect(
      evaluateReconstructionClosure(
        firstPass,
        boundary.boundary_id,
        RECONSTRUCTION_COVERAGE_NOW,
      ).status,
    ).toBe("ready");
    expect(
      evaluateReconstructionClosure(
        firstFail,
        boundary.boundary_id,
        RECONSTRUCTION_COVERAGE_NOW,
      ),
    ).toMatchObject({
      status: "failed",
      reasons: [expect.objectContaining({ code: "verifier-failed" })],
    });
  });

  it("orders offset-bearing verifier timestamps chronologically", () => {
    const workspace = completeReconstructionCoverageData();
    const result = workspace.verifier_results[0];
    if (result === undefined)
      throw new Error("Expected fixture verifier result");
    const semantic = workspace;
    const changed = createReconstructionCoverageData({
      ...semantic,
      verifier_results: [
        { ...result, observed_at: "2026-07-16T08:00:00.000Z" },
        {
          ...result,
          observed_at: "2026-07-16T04:00:00.000-05:00",
          status: "fail",
        },
      ],
    });

    expect(
      evaluateReconstructionClosure(
        changed,
        "replacement.cli",
        RECONSTRUCTION_COVERAGE_NOW,
      ),
    ).toMatchObject({
      status: "failed",
      reasons: [expect.objectContaining({ code: "verifier-failed" })],
    });
  });

  it("rejects verifier observations from the future", () => {
    const workspace = completeReconstructionCoverageData();
    const result = workspace.verifier_results[0];
    if (result === undefined)
      throw new Error("Expected fixture verifier result");
    const semantic = workspace;
    const changed = createReconstructionCoverageData({
      ...semantic,
      verifier_results: [
        { ...result, observed_at: "2026-07-17T12:00:00.000Z" },
      ],
    });

    expect(
      evaluateReconstructionClosure(
        changed,
        "replacement.cli",
        RECONSTRUCTION_COVERAGE_NOW,
      ),
    ).toMatchObject({
      status: "unknown",
      reasons: [expect.objectContaining({ code: "verifier-result-stale" })],
    });
  });

  it("rejects green results and package proofs that omit current commitments", () => {
    const workspace = completeReconstructionCoverageData();
    const semantic = workspace;
    const incomplete = createReconstructionCoverageData({
      ...semantic,
      verifier_results: workspace.verifier_results.map((result) => ({
        ...result,
        owner_sha256s: [],
      })),
      package_proofs: workspace.package_proofs.map((proof) => ({
        ...proof,
        artifact_sha256s: [digest("8")],
      })),
    });

    const result = evaluateReconstructionClosure(
      incomplete,
      "replacement.cli",
      RECONSTRUCTION_COVERAGE_NOW,
    );
    expect(result.status).toBe("unknown");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "verifier-result-incompatible" }),
        expect.objectContaining({ code: "package-proof-unknown" }),
      ]),
    );
  });
});
