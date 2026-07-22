import type { Evidence } from "../domain/evidence.js";
import { EvidenceReferenceError } from "../domain/errors.js";
import { err, ok, type Result } from "../domain/result.js";

/** Semantic identity admitted for one authoritative Evidence reference. */
export interface EvidenceSemanticIdentity {
  readonly operation: string;
  readonly predicate: string;
}

/** Read one Evidence record from an already-authorized authority. */
export type EvidenceLookup = (evidenceId: string) => Evidence | undefined;

/** Resolve IDs without accepting the digest-shaped identifier as proof itself. */
export const resolveEvidenceReferences = (
  lookup: EvidenceLookup | undefined,
  evidenceIds: readonly string[],
  expected?: readonly EvidenceSemanticIdentity[],
): Result<Evidence[], EvidenceReferenceError> => {
  const records: Evidence[] = [];
  for (const evidenceId of evidenceIds) {
    const record = lookup?.(evidenceId);
    if (record === undefined)
      return err(
        new EvidenceReferenceError(
          evidenceId,
          "missing",
          expectationDescription(expected),
          null,
        ),
      );
    if (expected !== undefined) {
      const operations = expected.filter(
        ({ operation }) => operation === record.operation,
      );
      if (operations.length === 0)
        return err(
          new EvidenceReferenceError(
            evidenceId,
            "wrong_operation",
            unique(expected.map(({ operation }) => operation)).join(" | "),
            record.operation,
          ),
        );
      if (
        !operations.some(({ predicate }) => predicate === record.predicate_type)
      )
        return err(
          new EvidenceReferenceError(
            evidenceId,
            "wrong_predicate",
            unique(operations.map(({ predicate }) => predicate)).join(" | "),
            record.predicate_type,
          ),
        );
    }
    records.push(record);
  }
  return ok(records);
};

const expectationDescription = (
  expected: readonly EvidenceSemanticIdentity[] | undefined,
): string =>
  expected === undefined
    ? "Evidence in the current authority"
    : expected
        .map(({ operation, predicate }) => `${operation}:${predicate}`)
        .join(" | ");

const unique = (values: readonly string[]): string[] => [...new Set(values)];
