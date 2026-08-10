import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  commitReconstructionCoverage,
  queryReconstructionCoverage,
} from "../../../src/application/ReconstructionCoverageService.js";
import {
  readReconstructionCoverageWorkspace,
  writeReconstructionCoverageWorkspace,
} from "../../../src/application/ReconstructionCoverageWorkspaceStore.js";
import type { EvidenceFilePolicy } from "../../../src/domain/evidenceBundle.js";
import {
  completeReconstructionCoverageWorkspace,
  RECONSTRUCTION_COVERAGE_NOW,
} from "../../../src/domain/reconstructionCoverage.fixture.js";

const filePolicy = (root: string): EvidenceFilePolicy => ({
  roots: [root],
  maxBytes: 64 * 1024 * 1024,
  maxDepth: 64,
  maxStringLength: 1024 * 1024,
  maxNodes: 1_000_000,
});

describe("reconstruction coverage persistence", () => {
  it("persists owner-only revisions with CAS and digest-chain enforcement", async () => {
    const root = await createTestTempDirectory("rea-coverage-workspace-");
    const path = join(root, "coverage.json");
    const workspace = completeReconstructionCoverageWorkspace();
    const policy = filePolicy(root);

    const written = await writeReconstructionCoverageWorkspace(
      workspace,
      path,
      null,
      policy,
    );
    expect(written.ok).toBe(true);
    expect(await readReconstructionCoverageWorkspace(path, policy)).toEqual({
      ok: true,
      value: workspace,
    });
    expect(
      await writeReconstructionCoverageWorkspace(workspace, path, null, policy),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "InvestigationWorkspaceError",
        reason: "revision-conflict",
      },
    });
  });

  it("shares commit and fail-closed query behavior across adapters", async () => {
    const root = await createTestTempDirectory("rea-coverage-service-");
    const path = join(root, "coverage.json");
    const workspace = completeReconstructionCoverageWorkspace();
    const policy = filePolicy(root);

    const committed = await commitReconstructionCoverage(
      {
        approved: true,
        workspace_path: path,
        expected_revision: null,
        workspace,
      },
      policy,
    );
    expect(committed.ok && committed.value).toMatchObject({
      revision: 1,
      revision_sha256: workspace.revision_sha256,
      evidence_records: 5,
    });
    const queried = await queryReconstructionCoverage(
      { workspace_path: path, boundary_id: "replacement.cli" },
      policy,
      RECONSTRUCTION_COVERAGE_NOW,
    );
    expect(queried.ok && queried.value).toMatchObject({ status: "ready" });

    const controller = new AbortController();
    controller.abort();
    expect(
      await queryReconstructionCoverage(
        { workspace_path: path, boundary_id: "replacement.cli" },
        policy,
        RECONSTRUCTION_COVERAGE_NOW,
        { signal: controller.signal },
      ),
    ).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
  });
});
