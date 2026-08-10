import { describe, expect, it } from "vitest";

import {
  completeReconstructionCoverageWorkspace,
  RECONSTRUCTION_COVERAGE_NOW,
  reconstructionCoverageEvidenceId,
} from "./reconstructionCoverage.fixture.js";
import {
  createReconstructionCoverageWorkspace,
  evaluateReconstructionClosure,
  parseReconstructionCoverageWorkspace,
} from "./reconstructionCoverage.js";

const digest = (character: string): string => character.repeat(64);

describe("reconstruction coverage closure", () => {
  it("returns ready only when ownership, verification, package, and authority closure pass", () => {
    const workspace = completeReconstructionCoverageWorkspace();

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
    expect(parseReconstructionCoverageWorkspace(workspace)).toEqual(workspace);
  });

  it("keeps an incomplete inventory partial despite every registered verifier passing", () => {
    const workspace = completeReconstructionCoverageWorkspace();
    const {
      revision_sha256: _revisionSha256,
      workspace_id: _workspaceId,
      schema_version: _schemaVersion,
      ...semantic
    } = workspace;
    const boundary = workspace.boundaries[0];
    if (boundary === undefined) throw new Error("Expected fixture boundary");
    const incomplete = createReconstructionCoverageWorkspace({
      ...semantic,
      revision: 2,
      previous_revision_sha256: workspace.revision_sha256,
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

  it("invalidates stale verifier contracts and detected authority routing", () => {
    const workspace = completeReconstructionCoverageWorkspace();
    const owner = workspace.owners[0];
    if (owner === undefined || owner.ownership.disposition !== "implemented")
      throw new Error("Expected implemented fixture owner");
    const {
      revision_sha256: _revisionSha256,
      workspace_id: _workspaceId,
      schema_version: _schemaVersion,
      ...semantic
    } = workspace;
    const changed = createReconstructionCoverageWorkspace({
      ...semantic,
      revision: 2,
      previous_revision_sha256: workspace.revision_sha256,
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

  it("never lets mock-strength or stale results satisfy stronger current claims", () => {
    const workspace = completeReconstructionCoverageWorkspace();
    const {
      revision_sha256: _revisionSha256,
      workspace_id: _workspaceId,
      schema_version: _schemaVersion,
      ...semantic
    } = workspace;
    const stale = createReconstructionCoverageWorkspace({
      ...semantic,
      revision: 2,
      previous_revision_sha256: workspace.revision_sha256,
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
  it("orders offset-bearing verifier timestamps chronologically", () => {
    const workspace = completeReconstructionCoverageWorkspace();
    const result = workspace.verifier_results[0];
    if (result === undefined)
      throw new Error("Expected fixture verifier result");
    const {
      revision_sha256: _revisionSha256,
      workspace_id: _workspaceId,
      schema_version: _schemaVersion,
      ...semantic
    } = workspace;
    const changed = createReconstructionCoverageWorkspace({
      ...semantic,
      revision: 2,
      previous_revision_sha256: workspace.revision_sha256,
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
    const workspace = completeReconstructionCoverageWorkspace();
    const result = workspace.verifier_results[0];
    if (result === undefined)
      throw new Error("Expected fixture verifier result");
    const {
      revision_sha256: _revisionSha256,
      workspace_id: _workspaceId,
      schema_version: _schemaVersion,
      ...semantic
    } = workspace;
    const changed = createReconstructionCoverageWorkspace({
      ...semantic,
      revision: 2,
      previous_revision_sha256: workspace.revision_sha256,
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
    const workspace = completeReconstructionCoverageWorkspace();
    const {
      revision_sha256: _revisionSha256,
      workspace_id: _workspaceId,
      schema_version: _schemaVersion,
      ...semantic
    } = workspace;
    const incomplete = createReconstructionCoverageWorkspace({
      ...semantic,
      revision: 2,
      previous_revision_sha256: workspace.revision_sha256,
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
