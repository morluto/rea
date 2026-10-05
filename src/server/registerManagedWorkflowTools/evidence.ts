import type { Evidence } from "../../domain/evidence.js";
import { parseEvidence } from "../../domain/evidence.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import type { Result } from "../../domain/result.js";
import { err, ok } from "../../domain/result.js";

const parseExpectedEvidence = (
  rawEvidence: readonly Evidence[],
  expectedOperations: readonly string[],
): Result<Evidence[], EvidenceIntegrityError> => {
  try {
    const evidence = rawEvidence.map(parseEvidence);
    for (const record of evidence)
      if (
        !expectedOperations.includes(record.operation) ||
        record.predicate_type !== "rea.analysis"
      )
        throw new TypeError(
          `Expected ${expectedOperations.join(" or ")} Evidence, received ${record.operation}`,
        );
    return ok(evidence);
  } catch (cause: unknown) {
    return err(
      new EvidenceIntegrityError(
        cause instanceof Error ? cause.message : "Invalid Evidence",
      ),
    );
  }
};

export const resolveManagedEvidence = (
  evidence: Evidence,
): Result<Evidence[], EvidenceIntegrityError> =>
  parseExpectedEvidence([evidence], ["inspect_managed_members"]);

export const resolveManagedArtifactEvidence = (
  evidence: Evidence,
): Result<Evidence[], EvidenceIntegrityError> =>
  parseExpectedEvidence([evidence], ["inspect_managed_artifact"]);

export const resolveManagedBoundaryEvidence = (
  evidence: Evidence,
): Result<Evidence[], EvidenceIntegrityError> =>
  parseExpectedEvidence([evidence], ["inspect_managed_native_boundaries"]);

export const resolveNativeEvidence = (
  evidence: readonly Evidence[],
): Result<Evidence[], EvidenceIntegrityError> => {
  return parseExpectedEvidence(evidence, ["inspect_macho", "analyze_function"]);
};

export const sourceEvidence = (input: {
  readonly managed_artifact?: Evidence | undefined;
  readonly managed_members?: Evidence | undefined;
  readonly managed_native_boundaries?: Evidence | undefined;
}): Evidence[] =>
  [
    input.managed_artifact,
    input.managed_members,
    input.managed_native_boundaries,
  ].filter((evidence): evidence is Evidence => evidence !== undefined);
