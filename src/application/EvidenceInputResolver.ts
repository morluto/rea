import type { EvidenceInput } from "../contracts/evidenceInputContracts.js";
import type { Evidence } from "../domain/evidence.js";
import { EvidenceReferenceError } from "../domain/evidenceErrors.js";
import { err, ok, type Result } from "../domain/result.js";

/** Read-only lookup supplied by the current investigation's Evidence ledger. */
export type EvidenceLookup = (evidenceId: string) => Evidence | undefined;

/** Resolve an exact reference without selecting a target or running analysis. */
export const resolveEvidenceInput = (
  input: EvidenceInput,
  lookup: EvidenceLookup | undefined,
): Result<Evidence, EvidenceReferenceError> => {
  if (!("kind" in input)) return ok(input);
  const record = lookup?.(input.evidence_id);
  if (record === undefined)
    return err(
      new EvidenceReferenceError(
        input.evidence_id,
        "missing",
        "Evidence retained in this session",
        null,
      ),
    );
  if (record.evidence_id !== input.evidence_id)
    return err(
      new EvidenceReferenceError(
        input.evidence_id,
        "identity_mismatch",
        input.evidence_id,
        record.evidence_id,
      ),
    );
  return ok(record);
};

/** Resolve an application's Evidence before its existing semantic validation. */
export const resolveApplicationEvidenceRequest = <
  T extends { readonly application: EvidenceInput },
>(
  input: T,
  lookup: EvidenceLookup | undefined,
): Result<
  Omit<T, "application"> & { readonly application: Evidence },
  EvidenceReferenceError
> => {
  const application = resolveEvidenceInput(input.application, lookup);
  if (!application.ok) return application;
  return ok({ ...input, application: application.value });
};

/** Resolve explicitly paired Evidence without guessing another session's record. */
export const resolvePairedEvidenceRequest = <
  T extends { readonly left: EvidenceInput; readonly right: EvidenceInput },
>(
  input: T,
  lookup: EvidenceLookup | undefined,
): Result<
  Omit<T, "left" | "right"> & {
    readonly left: Evidence;
    readonly right: Evidence;
  },
  EvidenceReferenceError
> => {
  const left = resolveEvidenceInput(input.left, lookup);
  if (!left.ok) return left;
  const right = resolveEvidenceInput(input.right, lookup);
  if (!right.ok) return right;
  return ok({ ...input, left: left.value, right: right.value });
};
