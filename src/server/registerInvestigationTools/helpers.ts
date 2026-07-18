import type { BinarySessionPort } from "../../application/BinarySession.js";
import type { ProgressReporter } from "../../application/ProgressReporter.js";
import type { Evidence } from "../../domain/evidence.js";
import {
  EvidenceIntegrityError,
  type AnalysisError,
} from "../../domain/errors.js";
import { err, ok, type Result } from "../../domain/result.js";
import { recordDerivedEvidence } from "../recordDerivedEvidence.js";
import type { WorkflowUnknownInput } from "./types.js";
import { evaluateReconstructionClosure } from "../../domain/reconstructionCoverage.js";
import type { z } from "zod";
import type { reconstructionVerificationInputSchema } from "../../domain/reconstructionVerification.js";
import { AnalysisInputError } from "../../domain/errors.js";

/** Build the execution context passed to cross-version investigation. */
export const investigationContext = ({
  session,
  signal,
  inputRoots,
  integrityContinueEnabled,
  progress,
}: {
  readonly session: BinarySessionPort;
  readonly signal: AbortSignal;
  readonly inputRoots: readonly string[];
  readonly integrityContinueEnabled: boolean;
  readonly progress?: ProgressReporter;
}): {
  readonly session: BinarySessionPort;
  readonly signal: AbortSignal;
  readonly inputRoots: readonly string[];
  readonly integrityContinueEnabled: boolean;
  readonly progress?: ProgressReporter;
} => ({
  session,
  signal,
  inputRoots,
  integrityContinueEnabled,
  ...(progress === undefined ? {} : { progress }),
});

export const isIncomplete = (status: string): boolean =>
  status === "unknown" || status === "truncated";

export const comparisonClosure = (comparisons: readonly Evidence[]): string[] =>
  uniqueIds(
    comparisons.flatMap((evidence) => [
      evidence.evidence_id,
      ...evidence.evidence_links,
    ]),
  );

export const functionEvidenceIds = (
  groups: readonly (Evidence | readonly Evidence[])[],
): string[] =>
  uniqueIds(
    groups.flatMap((group) =>
      (Array.isArray(group) ? group : [group]).map(({ evidence_id: id }) => id),
    ),
  );

export const uniqueIds = (ids: readonly string[]): string[] =>
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

/** Verify a retained coverage boundary before reconstruction evidence is derived. */
export const verifyCoverageReadiness = (
  session: BinarySessionPort,
  coverage: z.output<typeof reconstructionVerificationInputSchema>["coverage"],
): Result<null, AnalysisError> => {
  if (coverage === undefined) return ok(null);
  const workspace = session.reconstructionCoverageWorkspace(
    coverage.workspace_id,
    coverage.revision,
  );
  if (
    workspace === undefined ||
    workspace.revision_sha256 !== coverage.revision_sha256
  )
    return err(
      new EvidenceIntegrityError(
        "The requested reconstruction coverage revision is not retained by this session",
      ),
    );
  try {
    const result = evaluateReconstructionClosure(
      workspace,
      coverage.boundary_id,
      Date.now(),
    );
    return result.status === "ready"
      ? ok(null)
      : err(
          new EvidenceIntegrityError(
            `Reconstruction coverage boundary is ${result.status}; readiness requires ready`,
          ),
        );
  } catch (cause: unknown) {
    return err(new AnalysisInputError("verify_reconstruction", { cause }));
  }
};

export const recordWorkflowEvidence = (
  ...[session, evidence, approved, unresolved, input]: readonly [
    session: BinarySessionPort,
    evidence: Evidence,
    approved: true | undefined,
    unresolved: boolean,
    input: WorkflowUnknownInput,
  ]
): Result<Evidence, AnalysisError> => {
  if (approved !== true || !unresolved) {
    return recordDerivedEvidence(session, evidence, undefined);
  }
  return recordDerivedEvidence(session, evidence, {
    approved: true,
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
