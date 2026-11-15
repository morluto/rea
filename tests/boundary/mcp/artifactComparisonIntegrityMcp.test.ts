import { expect, it, onTestFinished } from "vitest";

import { ARTIFACT_COMPARISON_EXAMPLE } from "../../../src/contracts/artifactComparisonExample.js";
import { compareArtifacts } from "../../../src/domain/artifactComparison.js";
import { createEvidence } from "../../../src/domain/evidence.js";

import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

it("rejects an unchanged artifact comparison that retains a changed row", async () => {
  const left = ARTIFACT_COMPARISON_EXAMPLE.left;
  const right = ARTIFACT_COMPARISON_EXAMPLE.right;
  const comparison = createEvidence(
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
      result: {
        ...compareArtifacts(left, right),
        status: "unchanged",
      },
      confidence: "derived",
      authority: "analyst-inference",
      evidenceLinks: [left.evidence_id, right.evidence_id],
    },
  );
  const session = createTestBinarySession(() => {
    throw new Error(
      "Retained comparison verification must not launch a provider",
    );
  });
  const harness = await createApplicationMcpHarness({ session });
  onTestFinished(harness.close);
  for (const record of [left, right, comparison])
    expect(session.recordEvidence(record).ok).toBe(true);

  const response = await harness.client.callTool({
    name: "verify_reconstruction",
    arguments: {
      specification: {
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
    },
  });

  expect(response.isError).toBe(true);
  expect(parseMcpToolError(response)).toMatchObject({
    error: {
      code: "evidence_integrity_mismatch",
      category: "integrity_mismatch",
    },
  });
  expect(session.evidenceById(comparison.evidence_id)).toEqual(comparison);
});

it("does not fail a changed aggregate when source inventories are equal", async () => {
  const left = ARTIFACT_COMPARISON_EXAMPLE.left;
  const right = createEvidence(
    { path: "independent-copy", sha256: "0".repeat(64), format: "file" },
    left.provider,
    {
      operation: "inventory_artifact",
      parameters: { path: "independent-copy" },
      result: left.normalized_result,
      confidence: "observed",
      authority: "shipped-artifact",
    },
  );
  const equal = compareArtifacts(left, right);
  expect(equal.status).toBe("unchanged");
  const changed = compareArtifacts(left, ARTIFACT_COMPARISON_EXAMPLE.right);
  const comparison = createEvidence(
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
      result: {
        ...changed,
        left_manifest_id: equal.left_manifest_id,
        right_manifest_id: equal.right_manifest_id,
        changes: changed.changes.map((row) => ({
          ...row,
          evidence_links: [left.evidence_id, right.evidence_id],
        })),
      },
      confidence: "derived",
      authority: "analyst-inference",
      evidenceLinks: [left.evidence_id, right.evidence_id],
    },
  );
  const session = createTestBinarySession(() => {
    throw new Error("No provider expected");
  });
  const harness = await createApplicationMcpHarness({ session });
  onTestFinished(harness.close);
  for (const record of [left, right, comparison])
    expect(session.recordEvidence(record).ok).toBe(true);
  const response = await harness.client.callTool({
    name: "verify_reconstruction",
    arguments: {
      specification: {
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
    },
  });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  expect(response.structuredContent).toMatchObject({
    normalized_result: {
      status: "unknown",
      claims: {
        items: [
          {
            status: "unknown",
            observed_status: "changed",
            limitations: expect.arrayContaining([
              "Artifact source inventories do not corroborate the claimed comparison status.",
            ]),
          },
        ],
      },
    },
  });
});

it("does not pass an unchanged aggregate over unavailable source coverage", async () => {
  const original = ARTIFACT_COMPARISON_EXAMPLE.left;
  const left = createEvidence(
    { path: "fixture-left", sha256: "0".repeat(64), format: "file" },
    original.provider,
    {
      operation: "inventory_artifact",
      parameters: {},
      result: {
        ...(original.normalized_result as Record<string, unknown>),
        coverage: { scope: "root", status: "unknown" },
      },
      confidence: "observed",
      authority: "shipped-artifact",
    },
  );
  const right = ARTIFACT_COMPARISON_EXAMPLE.right;
  const actual = compareArtifacts(left, right);
  expect(actual.status).toBe("unknown");
  const comparison = createEvidence(
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
      result: {
        ...actual,
        status: "unchanged",
        changes: [],
        summary: {
          unchanged: 1,
          added: 0,
          removed: 0,
          changed: 0,
          unknown: 0,
          contradiction: 0,
        },
      },
      confidence: "derived",
      authority: "analyst-inference",
      evidenceLinks: [left.evidence_id, right.evidence_id],
    },
  );
  const session = createTestBinarySession(() => {
    throw new Error("No provider expected");
  });
  const harness = await createApplicationMcpHarness({ session });
  onTestFinished(harness.close);
  for (const record of [left, right, comparison])
    expect(session.recordEvidence(record).ok).toBe(true);
  const response = await harness.client.callTool({
    name: "verify_reconstruction",
    arguments: {
      specification: {
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
    },
  });
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  expect(response.structuredContent).toMatchObject({
    normalized_result: {
      status: "unknown",
      claims: {
        items: [
          {
            status: "unknown",
            observed_status: "unchanged",
            limitations: expect.arrayContaining([
              "Artifact source inventories do not corroborate the claimed comparison status.",
            ]),
          },
        ],
      },
    },
  });
  expect(session.evidenceById(comparison.evidence_id)).toEqual(comparison);
});
