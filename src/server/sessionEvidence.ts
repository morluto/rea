import type { BinarySessionPort } from "../application/BinarySession.js";
import {
  EvidenceIntegrityError,
  EvidenceReferenceError,
} from "../domain/errors.js";
import type { Evidence } from "../domain/evidence.js";
import { err, ok, type Result } from "../domain/result.js";

type EvidenceAuthorityResult = Result<Evidence[], EvidenceIntegrityError>;

/** Resolve bounded IDs to authoritative records with exact semantic identity. */
export const resolveSessionEvidenceIds = (
  session: BinarySessionPort,
  evidenceIds: readonly string[],
  expected: { readonly operation: string; readonly predicate: string },
): EvidenceAuthorityResult => {
  const records: Evidence[] = [];
  for (const evidenceId of evidenceIds) {
    const record = session.evidenceById(evidenceId);
    if (record === undefined)
      return err(
        new EvidenceReferenceError(
          evidenceId,
          "missing",
          expected.operation,
          null,
        ),
      );
    if (record.operation !== expected.operation)
      return err(
        new EvidenceReferenceError(
          evidenceId,
          "wrong_operation",
          expected.operation,
          record.operation,
        ),
      );
    if (record.predicate_type !== expected.predicate)
      return err(
        new EvidenceReferenceError(
          evidenceId,
          "wrong_predicate",
          expected.predicate,
          record.predicate_type,
        ),
      );
    records.push(record);
  }
  return ok(records);
};
