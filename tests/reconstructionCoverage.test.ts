import { rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import {
  readReconstructionCoverageWorkspace,
  writeReconstructionCoverageWorkspace,
} from "../src/application/ReconstructionCoverageWorkspaceStore.js";
import {
  commitReconstructionCoverage,
  queryReconstructionCoverage,
} from "../src/application/ReconstructionCoverageService.js";
import type { EvidenceFilePolicy } from "../src/domain/evidenceBundle.js";
import {
  createReconstructionCoverageWorkspace,
  createReconstructionVerifierContract,
  evaluateReconstructionClosure,
  parseReconstructionCoverageWorkspace,
} from "../src/domain/reconstructionCoverage.js";
import { createEvidence } from "../src/domain/evidence.js";
import { createEvidenceBundle } from "../src/domain/evidenceBundle.js";

const digest = (character: string): string => character.repeat(64);
const evidenceRecords = ["1", "2", "3", "4", "5"].map((character) =>
  createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    {
      predicateType: "rea.coverage-fixture/v1",
      operation: `fixture-${character}`,
      parameters: {},
      result: { character },
    },
  ),
);
const evidence = (character: string): string => {
  const record = evidenceRecords.find(
    ({ operation }) => operation === `fixture-${character}`,
  );
  if (record === undefined) throw new Error("Missing fixture Evidence");
  return record.evidence_id;
};
const now = Date.parse("2026-07-16T12:00:00.000Z");

const completeWorkspace = () => {
  const contract = createReconstructionVerifierContract({
    verifier_id: "verify.cli.help",
    claim_ids: ["claim.cli.help"],
    dimensions: ["output", "exit"],
    authority: "controlled-replay",
    max_age_ms: 86_400_000,
    minimum_repeats: 2,
    normalization_sha256: digest("4"),
    normalization_removes_dimensions: false,
  });
  return createReconstructionCoverageWorkspace({
    name: "fixture",
    revision: 1,
    previous_revision_sha256: null,
    evidence_bundle: createEvidenceBundle(evidenceRecords),
    artifacts: [
      {
        artifact_id: "authority.v1",
        artifact_sha256: digest("1"),
        version: "1.0.0",
        environment_sha256: digest("2"),
        evidence_ids: [evidence("1")],
      },
    ],
    surfaces: [
      {
        surface_id: "cli.help",
        family: "cli-command",
        artifact_id: "authority.v1",
        occurrence_id: "occ-help",
        location: "bin/app --help",
        authority: "observed",
        dependency_surface_ids: [],
        evidence_ids: [evidence("2")],
      },
    ],
    owners: [
      {
        surface_id: "cli.help",
        ownership: {
          disposition: "implemented",
          owner_path: "src/cli.ts",
          owner_export: "registerHelp",
          owner_sha256: digest("3"),
          path_state: "present",
          package_state: "distributed",
          authority_route: "none",
        },
      },
    ],
    claims: [
      {
        claim_id: "claim.cli.help",
        title: "Help output and exit behavior match",
        kind: "behavioral",
        surface_ids: ["cli.help"],
        required_dimensions: ["output", "exit"],
        required_authority: "controlled-replay",
      },
    ],
    verifier_contracts: [contract],
    verifier_results: [
      {
        verifier_id: contract.verifier_id,
        contract_sha256: contract.contract_sha256,
        observed_at: "2026-07-16T11:00:00.000Z",
        status: "pass",
        covered_claim_ids: ["claim.cli.help"],
        covered_dimensions: ["output", "exit"],
        artifact_sha256s: [digest("1")],
        owner_sha256s: [digest("3")],
        normalization_sha256: digest("4"),
        repeats: 2,
        evidence_ids: [evidence("3")],
      },
    ],
    residual_unknown_ids: [],
    contradictions: [],
    package_proofs: [
      {
        proof_id: "proof.clean-install",
        kind: "clean-install",
        status: "pass",
        artifact_sha256s: [digest("1")],
        evidence_ids: [evidence("4")],
      },
      {
        proof_id: "proof.authority-independence",
        kind: "authority-independence",
        status: "pass",
        artifact_sha256s: [digest("1")],
        evidence_ids: [evidence("5")],
      },
    ],
    boundaries: [
      {
        boundary_id: "replacement.cli",
        title: "CLI replacement",
        required_surface_ids: ["cli.help"],
        required_claim_ids: ["claim.cli.help"],
        required_package_proof_kinds: [
          "clean-install",
          "authority-independence",
        ],
        allowed_dispositions: [],
        allowed_unknown_ids: [],
      },
    ],
  });
};

describe("reconstruction coverage closure", () => {
  it("returns ready only when ownership, verification, package, and authority closure pass", () => {
    const workspace = completeWorkspace();

    expect(
      evaluateReconstructionClosure(workspace, "replacement.cli", now),
    ).toMatchObject({
      status: "ready",
      summary: { required_surfaces: 1, required_claims: 1, reasons: 0 },
      evidence_ids: [
        evidence("2"),
        evidence("3"),
        evidence("4"),
        evidence("5"),
      ].sort(),
    });
    expect(parseReconstructionCoverageWorkspace(workspace)).toEqual(workspace);
  });

  it("keeps an incomplete inventory partial despite every registered verifier passing", () => {
    const workspace = completeWorkspace();
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
      evaluateReconstructionClosure(incomplete, "replacement.cli", now),
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
    const workspace = completeWorkspace();
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
      now,
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
    const workspace = completeWorkspace();
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
      evaluateReconstructionClosure(stale, "replacement.cli", now),
    ).toMatchObject({
      status: "unknown",
      reasons: [expect.objectContaining({ code: "verifier-result-stale" })],
    });
  });

  it("orders offset-bearing verifier timestamps chronologically", () => {
    const workspace = completeWorkspace();
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
      evaluateReconstructionClosure(changed, "replacement.cli", now),
    ).toMatchObject({
      status: "failed",
      reasons: [expect.objectContaining({ code: "verifier-failed" })],
    });
  });

  it("rejects verifier observations from the future", () => {
    const workspace = completeWorkspace();
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
      evaluateReconstructionClosure(changed, "replacement.cli", now),
    ).toMatchObject({
      status: "unknown",
      reasons: [expect.objectContaining({ code: "verifier-result-stale" })],
    });
  });

  it("rejects green results and package proofs that omit current commitments", () => {
    const workspace = completeWorkspace();
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
      now,
    );
    expect(result.status).toBe("unknown");
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "verifier-result-incompatible" }),
        expect.objectContaining({ code: "package-proof-unknown" }),
      ]),
    );
  });

  it("persists owner-only revisions with CAS and digest-chain enforcement", async () => {
    const root = await createTestTempDirectory("rea-coverage-workspace-");
    const path = join(root, "coverage.json");
    const first = completeWorkspace();
    const filePolicy: EvidenceFilePolicy = {
      roots: [root],
      maxBytes: 64 * 1024 * 1024,
      maxDepth: 64,
      maxStringLength: 1024 * 1024,
      maxNodes: 1_000_000,
    };
    try {
      const written = await writeReconstructionCoverageWorkspace(
        first,
        path,
        null,
        filePolicy,
      );
      expect(written.ok).toBe(true);
      expect(
        await readReconstructionCoverageWorkspace(path, filePolicy),
      ).toEqual({ ok: true, value: first });

      const stale = await writeReconstructionCoverageWorkspace(
        first,
        path,
        null,
        filePolicy,
      );
      expect(stale).toMatchObject({
        ok: false,
        error: {
          _tag: "InvestigationWorkspaceError",
          reason: "revision-conflict",
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shares commit and fail-closed query behavior across adapters", async () => {
    const root = await createTestTempDirectory("rea-coverage-service-");
    const path = join(root, "coverage.json");
    const workspace = completeWorkspace();
    const filePolicy: EvidenceFilePolicy = {
      roots: [root],
      maxBytes: 64 * 1024 * 1024,
      maxDepth: 64,
      maxStringLength: 1024 * 1024,
      maxNodes: 1_000_000,
    };
    try {
      const committed = await commitReconstructionCoverage(
        {
          approved: true,
          workspace_path: path,
          expected_revision: null,
          workspace,
        },
        filePolicy,
      );
      expect(committed.ok && committed.value).toMatchObject({
        revision: 1,
        revision_sha256: workspace.revision_sha256,
        evidence_records: 5,
      });
      const queried = await queryReconstructionCoverage(
        { workspace_path: path, boundary_id: "replacement.cli" },
        filePolicy,
        now,
      );
      expect(queried.ok && queried.value).toMatchObject({ status: "ready" });

      const controller = new AbortController();
      controller.abort();
      const cancelled = await queryReconstructionCoverage(
        { workspace_path: path, boundary_id: "replacement.cli" },
        filePolicy,
        now,
        { signal: controller.signal },
      );
      expect(cancelled).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisCancelledError" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
