import { expect, it } from "vitest";

import { inspectAnalysisView } from "../analysisView/AnalysisViewService.js";
import { ARTIFACT_COMPARISON_EXAMPLE } from "../../contracts/artifactComparisonExample.js";
import { artifactInventorySummaryViewResultSchema } from "../../domain/analysisView/summarySchemas/artifactInventorySummarySchema.js";
import {
  createEvidence,
  evidenceSubjectTarget,
  parseEvidence,
  type Evidence,
} from "../../domain/evidence.js";
import {
  EvidenceIntegrityError,
  EvidenceReferenceError,
} from "../../domain/evidenceErrors.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { resolveArtifactFamilyClusteringEvidence } from "./ArtifactFamilyClusteringEvidence.js";

const artifactSummary = async () => {
  const parent = ARTIFACT_COMPARISON_EXAMPLE.left;
  const summary = await inspectAnalysisView(
    {
      source: { kind: "inline", evidence: parent },
      view: { kind: "summary" },
    },
    (evidenceId) => (evidenceId === parent.evidence_id ? parent : undefined),
  );
  if (!summary.ok) throw summary.error;
  return { parent, summary: summary.value };
};

const recreateSummary = (
  summary: Evidence,
  normalizedResult: Evidence["normalized_result"],
  parameters: Evidence["parameters"] = summary.parameters,
): Evidence => {
  if (summary.subject === null)
    throw new Error("artifact summary fixture must identify its subject");
  return createEvidence(
    evidenceSubjectTarget(summary.subject)!,
    summary.provider,
    {
      predicateType: summary.predicate_type,
      operation: summary.operation,
      parameters,
      result: normalizedResult,
      ...(summary.analysis_profile === null
        ? {}
        : { analysisProfile: summary.analysis_profile }),
      rawResult: summary.raw_result,
      confidence: summary.confidence,
      authority: summary.authority,
      environment: summary.environment,
      limitations: summary.limitations,
      ...(summary.relationship_coverage === null
        ? {}
        : { relationshipCoverage: summary.relationship_coverage }),
      locations: summary.locations,
      evidenceLinks: summary.evidence_links,
    },
  );
};

it("resolves a retained Evidence ID to the retained inventory", async () => {
  const parent = ARTIFACT_COMPARISON_EXAMPLE.left;
  const resolved = await resolveArtifactFamilyClusteringEvidence(
    parent.evidence_id,
    (id) => (id === parent.evidence_id ? parent : undefined),
    "member-a",
  );
  expect(resolved).toEqual({ ok: true, value: parent });
});

it("reports a missing retained Evidence ID", async () => {
  const parent = ARTIFACT_COMPARISON_EXAMPLE.left;
  const resolved = await resolveArtifactFamilyClusteringEvidence(
    parent.evidence_id,
    undefined,
    "member-a",
  );
  expect(resolved.ok).toBe(false);
  if (!resolved.ok) {
    expect(resolved.error).toBeInstanceOf(EvidenceReferenceError);
    expect(resolved.error).toMatchObject({ reason: "missing" });
  }
});

it("reports an identity mismatch for a retained Evidence ID", async () => {
  const parent = ARTIFACT_COMPARISON_EXAMPLE.left;
  const otherParent = ARTIFACT_COMPARISON_EXAMPLE.right;
  const resolved = await resolveArtifactFamilyClusteringEvidence(
    parent.evidence_id,
    () => otherParent,
    "member-a",
  );
  expect(resolved.ok).toBe(false);
  if (!resolved.ok) {
    expect(resolved.error).toBeInstanceOf(EvidenceReferenceError);
    expect(resolved.error).toMatchObject({ reason: "identity_mismatch" });
  }
});

it("refuses a retained Evidence ID whose operation is not an artifact inventory", async () => {
  const parent = ARTIFACT_COMPARISON_EXAMPLE.left;
  const nonArtifact = createEvidence(
    evidenceSubjectTarget(parent.subject)!,
    parent.provider,
    {
      operation: "disassemble_function",
      parameters: {},
      result: { functions: [] },
      limitations: [],
    },
  );
  const resolved = await resolveArtifactFamilyClusteringEvidence(
    nonArtifact.evidence_id,
    (id) => (id === nonArtifact.evidence_id ? nonArtifact : undefined),
    "member-non-artifact",
  );
  expect(resolved.ok).toBe(false);
  if (!resolved.ok) {
    expect(resolved.error).toBeInstanceOf(AnalysisInputError);
  }
});

it("resolves an artifact summary to its exact retained parent inventory", async () => {
  const { parent, summary } = await artifactSummary();
  const resolved = await resolveArtifactFamilyClusteringEvidence(
    summary,
    (evidenceId) => (evidenceId === parent.evidence_id ? parent : undefined),
    "member-summary",
  );
  expect(resolved).toEqual({ ok: true, value: parent });
});

it("reports a missing retained parent instead of treating summary facts as inventory", async () => {
  const { summary } = await artifactSummary();
  const resolved = await resolveArtifactFamilyClusteringEvidence(
    summary,
    undefined,
  );
  expect(resolved.ok).toBe(false);
  if (!resolved.ok) {
    expect(resolved.error).toBeInstanceOf(EvidenceReferenceError);
    expect(resolved.error).toMatchObject({ reason: "missing" });
  }
});

it("uses retained Evidence resolution to reject a mismatched parent identity", async () => {
  const { summary } = await artifactSummary();
  const otherParent = ARTIFACT_COMPARISON_EXAMPLE.right;
  const resolved = await resolveArtifactFamilyClusteringEvidence(
    summary,
    () => otherParent,
  );
  expect(resolved.ok).toBe(false);
  if (!resolved.ok) {
    expect(resolved.error).toBeInstanceOf(EvidenceReferenceError);
    expect(resolved.error).toMatchObject({ reason: "identity_mismatch" });
  }
});

it("rejects summary facts that do not reproject from the complete parent", async () => {
  const { parent, summary } = await artifactSummary();
  const summaryResult = artifactInventorySummaryViewResultSchema.parse(
    summary.normalized_result,
  );
  const normalizedResult = {
    ...summaryResult,
    summary: {
      ...summaryResult.summary,
      available_counts: {
        ...summaryResult.summary.available_counts,
        nodes: summaryResult.summary.available_counts.nodes + 1,
      },
    },
  };
  const forged = recreateSummary(summary, normalizedResult);
  const resolved = await resolveArtifactFamilyClusteringEvidence(
    forged,
    (evidenceId) => (evidenceId === parent.evidence_id ? parent : undefined),
  );
  expect(resolved.ok).toBe(false);
  if (!resolved.ok)
    expect(resolved.error).toBeInstanceOf(EvidenceIntegrityError);
});

it("accepts display-only subject changes excluded from Evidence identity", async () => {
  const { parent, summary } = await artifactSummary();
  if (summary.subject === null)
    throw new Error("artifact summary fixture must identify its subject");
  const displayOnly = parseEvidence({
    ...summary,
    subject: {
      ...summary.subject,
      name: "renamed.app",
      local_path: "/display-only/renamed.app",
    },
  });
  const resolved = await resolveArtifactFamilyClusteringEvidence(
    displayOnly,
    (evidenceId) => (evidenceId === parent.evidence_id ? parent : undefined),
  );
  expect(resolved).toEqual({ ok: true, value: parent });
});
