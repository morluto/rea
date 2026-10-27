import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import {
  artifactInventorySummaryViewResultSchema,
  sealAnalysisView,
} from "../../src/domain/analysisView/analysisView.js";
import { artifactComparisonResultSchema } from "../../src/domain/artifactComparison.js";
import { digestCanonicalValue } from "../../src/domain/canonicalDigest.js";
import {
  evidenceSemanticContent,
  parseEvidence,
  rebindEvidenceToTargetPath,
  type Evidence,
} from "../../src/domain/evidence.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const resealSummary = (
  evidence: Evidence,
  result: ReturnType<typeof artifactInventorySummaryViewResultSchema.parse>,
): Evidence => {
  const { view_digest: _digest, ...unsigned } = result;
  const revised = {
    ...evidence,
    normalized_result: artifactInventorySummaryViewResultSchema.parse(
      sealAnalysisView(unsigned),
    ),
  };
  return parseEvidence({
    ...revised,
    evidence_id: `ev_${digestCanonicalValue(evidenceSemanticContent(revised), "Evidence")}`,
  });
};

it("compares a historical alias summary through its retained complete MCP parent and rejects resealed false facts", async () => {
  const root = await createTestTempDirectory("rea-historical-summary-mcp-");
  const path = join(root, "original.plist");
  await writeFile(
    path,
    '<?xml version="1.0"?><plist version="1.0"><dict><key>label</key><string>hello</string></dict></plist>',
  );
  const { call } = await connectLocalToolsMcp();
  const opened = await call("open_binary", { path });
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  const inspected = await call("inspect_artifact", { detail: "complete" });
  expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
  const parent = parseEvidence(inspected.structuredContent);
  const originalParent = JSON.stringify(parent);
  const alias = join(root, "caller-selected-alias.plist");
  const aliasedParent = rebindEvidenceToTargetPath(parent, {
    path: alias,
    sha256: parent.subject!.digest.sha256,
    format: parent.subject!.format,
  });
  expect(aliasedParent.evidence_id).toBe(parent.evidence_id);
  const projected = await call("inspect_analysis_view", {
    source: { kind: "inline", evidence: aliasedParent },
    view: { kind: "summary" },
  });
  expect(projected.isError, JSON.stringify(projected)).not.toBe(true);
  const current = parseEvidence(projected.structuredContent);
  const result = artifactInventorySummaryViewResultSchema.parse(
    current.normalized_result,
  );
  expect(result).toMatchObject({
    parent_evidence_id: parent.evidence_id,
    artifact: { path: alias },
    summary: { source_coverage: { scope: "root", status: "complete" } },
  });

  // Exact ordinary-root projector before ce1f4b1bb: no source_coverage or
  // traversal caveat. Before b395190e4 the hash caveat was also absent; this
  // fully hashed root has no such caveat in either era.
  const { source_coverage: _coverage, ...summary } = result.summary;
  const historical = resealSummary(current, {
    ...result,
    summary,
    unknowns: result.unknowns.filter(
      (value) =>
        value !==
          "Producer traversal coverage is unknown; missing matches do not prove source absence." &&
        value !==
          "Content hashes are unknown for some recorded files; missing node IDs do not prove content absence.",
    ),
  });
  expect(historical.evidence_id).not.toBe(current.evidence_id);
  const originalHistorical = JSON.stringify(historical);
  const compared = await call("compare_artifacts", {
    left: historical,
    right: parent,
  });
  expect(compared.isError, JSON.stringify(compared)).not.toBe(true);
  const comparison = parseEvidence(compared.structuredContent);
  expect(
    artifactComparisonResultSchema.parse(comparison.normalized_result),
  ).toMatchObject({
    status: "unchanged",
    summary: { unchanged: 1, unknown: 0 },
    changes: [],
  });
  expect(comparison.evidence_links).toContain(parent.evidence_id);
  expect(comparison.evidence_links).not.toContain(historical.evidence_id);

  const historicalResult = artifactInventorySummaryViewResultSchema.parse(
    historical.normalized_result,
  );
  const forged = resealSummary(historical, {
    ...historicalResult,
    summary: {
      ...historicalResult.summary,
      available_counts: {
        ...historicalResult.summary.available_counts,
        nodes: historicalResult.summary.available_counts.nodes + 1,
      },
    },
  });
  const rejected = await call("compare_artifacts", {
    left: forged,
    right: parent,
  });
  expect(rejected.isError, JSON.stringify(rejected)).toBe(true);
  expect(parseMcpToolError(rejected)).toMatchObject({
    error: { code: "evidence_integrity_mismatch" },
  });
  expect(JSON.stringify(parent)).toBe(originalParent);
  expect(JSON.stringify(historical)).toBe(originalHistorical);

  const retained = await call("inspect_analysis_view", {
    source: { kind: "retained-evidence", evidence_id: parent.evidence_id },
    view: { kind: "summary" },
  });
  expect(retained.isError, JSON.stringify(retained)).not.toBe(true);
  expect(
    parseEvidence(retained.structuredContent).normalized_result,
  ).toMatchObject({
    parent_evidence_id: parent.evidence_id,
    artifact: { path },
    summary: { source_coverage: { scope: "root", status: "complete" } },
  });
});
