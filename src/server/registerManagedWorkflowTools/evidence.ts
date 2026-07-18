import type { BinarySessionPort } from "../../application/BinarySession.js";
import type { Evidence } from "../../domain/evidence.js";
import type { EvidenceIntegrityError } from "../../domain/errors.js";
import type { Result } from "../../domain/result.js";
import { resolveSessionEvidenceIds } from "../sessionEvidence.js";
import type { ManagedWorkflowToolRegistration } from "./types.js";

export const resolveManagedEvidence = (
  session: BinarySessionPort,
  evidenceIds: readonly string[],
): Result<Evidence[], EvidenceIntegrityError> =>
  resolveSessionEvidenceIds(session, evidenceIds, {
    operation: "inspect_managed_members",
    predicate: "rea.analysis/v2",
  });

export const resolveManagedArtifactEvidence = (
  session: BinarySessionPort,
  evidenceId: string,
): Result<Evidence[], EvidenceIntegrityError> =>
  resolveSessionEvidenceIds(session, [evidenceId], {
    operation: "inspect_managed_artifact",
    predicate: "rea.analysis/v2",
  });

export const resolveManagedBoundaryEvidence = (
  session: BinarySessionPort,
  evidenceId: string,
): Result<Evidence[], EvidenceIntegrityError> =>
  resolveSessionEvidenceIds(session, [evidenceId], {
    operation: "inspect_managed_native_boundaries",
    predicate: "rea.analysis/v2",
  });

export const resolveNativeEvidence = (
  session: BinarySessionPort,
  evidenceIds: readonly string[],
): Result<Evidence[], EvidenceIntegrityError> => {
  const records: Evidence[] = [];
  for (const evidenceId of evidenceIds) {
    const operation = session.evidenceById(evidenceId)?.operation;
    const expectedOperation =
      operation === "inspect_macho" || operation === "analyze_function"
        ? operation
        : "inspect_macho or analyze_function";
    const resolved = resolveSessionEvidenceIds(session, [evidenceId], {
      operation: expectedOperation,
      predicate: "rea.analysis/v2",
    });
    if (!resolved.ok) return resolved;
    records.push(...resolved.value);
  }
  return { ok: true, value: records };
};

export const recordManagedSources = (
  recordEvidence: ManagedWorkflowToolRegistration["recordEvidence"],
  sources: readonly Evidence[],
) => {
  for (const source of sources) {
    const recorded = recordEvidence?.(source);
    if (recorded !== undefined && !recorded.ok) return recorded;
  }
  return { ok: true as const, value: null };
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
