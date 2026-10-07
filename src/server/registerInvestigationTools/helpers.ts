import type { BinarySessionPort } from "../../application/binary/BinarySession.js";
import type { Evidence } from "../../domain/evidence.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import { type AnalysisError } from "../../domain/analysisErrorBase.js";
import { err, ok, type Result } from "../../domain/result.js";
import { recordDerivedEvidence } from "../recordDerivedEvidence.js";
import type { WorkflowUnknownInput } from "./types.js";

export const isIncomplete = (status: string): boolean =>
  status === "unknown" || status === "truncated";

export const comparisonClosure = (comparisons: readonly Evidence[]): string[] =>
  uniqueIds(
    comparisons.flatMap((evidence) => [
      evidence.evidence_id,
      ...evidence.evidence_links,
    ]),
  );

export const functionEvidenceIds = (records: readonly Evidence[]): string[] =>
  uniqueIds(records.map(({ evidence_id }) => evidence_id));

const uniqueIds = (ids: readonly string[]): string[] =>
  [...new Set(ids)].sort((left, right) => left.localeCompare(right));

export const evidenceClosure = (
  session: BinarySessionPort,
  seedIds: readonly string[],
): Result<string[], EvidenceIntegrityError> => {
  const records = new Map(
    session
      .exportEvidenceBundle()
      .records.map((evidence) => [evidence.evidence_id, evidence]),
  );
  const visited = new Set<string>();
  const pending = [...seedIds];
  while (pending.length > 0) {
    const evidenceId = pending.pop();
    if (evidenceId === undefined || visited.has(evidenceId)) continue;
    const evidence = records.get(evidenceId);
    if (evidence === undefined)
      return err(
        new EvidenceIntegrityError(
          "Investigation input has a dangling Evidence link",
        ),
      );
    visited.add(evidenceId);
    pending.push(...evidence.evidence_links);
  }
  return ok(uniqueIds([...visited]));
};

export const recordWorkflowEvidence = (
  ...[session, evidence, unresolved, input]: readonly [
    session: BinarySessionPort,
    evidence: Evidence,
    unresolved: boolean,
    input: WorkflowUnknownInput,
  ]
): Result<Evidence, AnalysisError> => {
  if (!unresolved) {
    return recordDerivedEvidence(session, evidence, undefined);
  }
  return recordDerivedEvidence(session, evidence, {
    question: input.question,
    severity: "high",
    domain: input.domain,
    supporting_evidence_ids: [evidence.evidence_id],
    contradicting_evidence_ids: [],
    required_authority: input.requiredAuthority,
    required_confidence: input.requiredConfidence,
    required_environment: null,
    recommended_probes: [...input.probes],
    relationships: [],
  });
};
