import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import { BinarySession } from "../src/application/BinarySession.js";
import { INVESTIGATION_EXAMPLES } from "../src/contracts/investigationExamples.js";
import { createEvidence } from "../src/domain/evidence.js";
import { createEvidenceBundle } from "../src/domain/evidenceBundle.js";
import {
  createReconstructionCoverageWorkspace,
  createReconstructionVerifierContract,
} from "../src/domain/reconstructionCoverage.js";
import { createServer } from "../src/server/createServer.js";
import { observed } from "./fixtures/analysisExecution.js";
import { permissionAuthorityForRoot } from "./fixtures/permissionAuthority.js";

const digest = (character: string): string => character.repeat(64);

describe("reconstruction coverage MCP parity", () => {
  it("commits and queries the same evidence-backed fail-closed workspace", async () => {
    const root = await createTestTempDirectory("rea-coverage-mcp-");
    const path = join(root, "coverage.json");
    const policy = {
      roots: [root],
      maxBytes: 64 * 1024 * 1024,
      maxDepth: 64,
      maxStringLength: 1024 * 1024,
      maxNodes: 1_000_000,
    };
    const authority = await permissionAuthorityForRoot(
      root,
      ["investigation_workspace_read", "investigation_workspace_write"],
      ["investigation_workspace_read", "investigation_workspace_write"],
    );
    const session = new BinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(),
    }));
    const server = createServer(session, session, {
      evidenceFilePolicy: policy,
      permissionAuthority: authority,
    });
    const client = new Client({ name: "coverage-mcp-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const workspace = fixtureWorkspace();
      const committed = await client.callTool({
        name: "commit_reconstruction_coverage",
        arguments: {
          approved: true,
          workspace_path: path,
          expected_revision: null,
          workspace,
        },
      });
      expect(committed.isError).not.toBe(true);
      expect(committed.structuredContent).toMatchObject({
        revision: 1,
        revision_sha256: workspace.revision_sha256,
      });
      const resourceUri = `rea://reconstruction-coverage/${workspace.workspace_id}/revision/1`;
      expect(committed.content).toContainEqual(
        expect.objectContaining({ type: "resource_link", uri: resourceUri }),
      );
      const resource = await client.readResource({ uri: resourceUri });
      expect(resource.contents[0]).toEqual(
        expect.objectContaining({
          text: expect.stringContaining(workspace.revision_sha256),
        }),
      );
      const queried = await client.callTool({
        name: "query_reconstruction_coverage",
        arguments: {
          workspace_path: path,
          boundary_id: "replacement.cli",
        },
      });
      expect(queried.isError).not.toBe(true);
      expect(queried.structuredContent).toMatchObject({
        status: "ready",
        summary: { reasons: 0 },
      });
      const staleVerification = await client.callTool({
        name: "verify_reconstruction",
        arguments: {
          ...INVESTIGATION_EXAMPLES.verify_reconstruction,
          coverage: {
            workspace_id: workspace.workspace_id,
            revision: workspace.revision,
            revision_sha256: digest("9"),
            boundary_id: "replacement.cli",
          },
        },
      });
      expect(staleVerification.isError).toBe(true);
      expect(staleVerification.structuredContent).toMatchObject({
        error: { code: "evidence_integrity_mismatch" },
      });
      const unknownBoundary = await client.callTool({
        name: "verify_reconstruction",
        arguments: {
          ...INVESTIGATION_EXAMPLES.verify_reconstruction,
          coverage: {
            workspace_id: workspace.workspace_id,
            revision: workspace.revision,
            revision_sha256: workspace.revision_sha256,
            boundary_id: "replacement.unknown",
          },
        },
      });
      expect(unknownBoundary.isError).toBe(true);
      expect(unknownBoundary.structuredContent).toMatchObject({
        error: { code: "invalid_request" },
      });
    } finally {
      await client.close();
      await server.close();
      await session.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

const fixtureWorkspace = () => {
  const record = createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    {
      predicateType: "rea.coverage-fixture/v1",
      operation: "verify-cli",
      parameters: {},
      result: { status: "pass" },
      authority: "controlled-replay",
      environment: {
        id: "fixture",
        platform: "linux",
        architecture: "x86_64",
        isolation: "container",
      },
    },
  );
  const contract = createReconstructionVerifierContract({
    verifier_id: "verify.cli",
    claim_ids: ["claim.cli"],
    dimensions: ["output"],
    authority: "controlled-replay",
    max_age_ms: Number.MAX_SAFE_INTEGER,
    minimum_repeats: 1,
    normalization_sha256: digest("4"),
    normalization_removes_dimensions: false,
  });
  return createReconstructionCoverageWorkspace({
    name: "mcp-fixture",
    revision: 1,
    previous_revision_sha256: null,
    evidence_bundle: createEvidenceBundle([record]),
    artifacts: [
      {
        artifact_id: "authority",
        artifact_sha256: digest("1"),
        version: "1",
        environment_sha256: digest("2"),
        evidence_ids: [record.evidence_id],
      },
    ],
    surfaces: [
      {
        surface_id: "cli.help",
        family: "cli-command",
        artifact_id: "authority",
        occurrence_id: null,
        location: "app --help",
        authority: "observed",
        dependency_surface_ids: [],
        evidence_ids: [record.evidence_id],
      },
    ],
    owners: [
      {
        surface_id: "cli.help",
        ownership: {
          disposition: "implemented",
          owner_path: "src/cli.ts",
          owner_export: null,
          owner_sha256: digest("3"),
          path_state: "present",
          package_state: "distributed",
          authority_route: "none",
        },
      },
    ],
    claims: [
      {
        claim_id: "claim.cli",
        title: "CLI help matches",
        kind: "behavioral",
        surface_ids: ["cli.help"],
        required_dimensions: ["output"],
        required_authority: "controlled-replay",
      },
    ],
    verifier_contracts: [contract],
    verifier_results: [
      {
        verifier_id: contract.verifier_id,
        contract_sha256: contract.contract_sha256,
        observed_at: "2026-07-16T00:00:00.000Z",
        status: "pass",
        covered_claim_ids: ["claim.cli"],
        covered_dimensions: ["output"],
        artifact_sha256s: [digest("1")],
        owner_sha256s: [digest("3")],
        normalization_sha256: digest("4"),
        repeats: 1,
        evidence_ids: [record.evidence_id],
      },
    ],
    residual_unknown_ids: [],
    contradictions: [],
    package_proofs: [
      {
        proof_id: "proof.install",
        kind: "clean-install",
        status: "pass",
        artifact_sha256s: [digest("1")],
        evidence_ids: [record.evidence_id],
      },
    ],
    boundaries: [
      {
        boundary_id: "replacement.cli",
        title: "CLI replacement",
        required_surface_ids: ["cli.help"],
        required_claim_ids: ["claim.cli"],
        required_package_proof_kinds: ["clean-install"],
        allowed_dispositions: [],
        allowed_unknown_ids: [],
      },
    ],
  });
};
