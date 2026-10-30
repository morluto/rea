import type {
  EvidenceInput,
  EvidenceSourceInput,
} from "../domain/evidenceReference.js";
import type { Evidence } from "../domain/evidence.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { EvidenceReferenceError } from "../domain/evidenceErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  readEvidenceFileSource,
  type EvidenceFileReadOptions,
} from "./analysisView/evidenceFileSource.js";

/** Read-only lookup supplied by the current investigation's Evidence ledger. */
export type EvidenceLookup = (evidenceId: string) => Evidence | undefined;

/** Normalize each selected record using its file context and the current ledger. */
export interface EvidenceSourceResolutionOptions extends EvidenceFileReadOptions {
  readonly operation: string;
  readonly resolveEvidence?: (
    evidence: Evidence,
    lookup: EvidenceLookup | undefined,
    side: "left" | "right",
  ) => Result<Evidence, AnalysisError>;
}

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
        "Evidence available to the selected source",
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

/** Resolve paired sources like resolvePairedEvidenceRequest; Evidence files use the shared file reader. */
export const resolvePairedEvidenceSources = async <
  T extends {
    readonly left: EvidenceSourceInput;
    readonly right: EvidenceSourceInput;
  },
>(
  input: T,
  lookup: EvidenceLookup | undefined,
  options: EvidenceSourceResolutionOptions,
): Promise<
  Result<
    Omit<T, "left" | "right"> & {
      readonly left: Evidence;
      readonly right: Evidence;
    },
    AnalysisError
  >
> => {
  const left = await resolveEvidenceSource(input.left, "left", lookup, options);
  if (!left.ok) return left;
  const right = await resolveEvidenceSource(
    input.right,
    "right",
    lookup,
    options,
  );
  if (!right.ok) return right;
  return ok({ ...input, left: left.value, right: right.value });
};

const resolveEvidenceSource = async (
  input: EvidenceSourceInput,
  side: "left" | "right",
  lookup: EvidenceLookup | undefined,
  options: EvidenceSourceResolutionOptions,
): Promise<Result<Evidence, AnalysisError>> => {
  if ("kind" in input && input.kind === "evidence-file")
    return readEvidenceFileSource(input.path, options, input.evidence_id, {
      operation: options.operation,
      path: [side],
      resolveSelected: (selected, fileLookup) =>
        options.resolveEvidence?.(
          selected,
          (id) => fileLookup(id) ?? lookup?.(id),
          side,
        ) ?? ok(selected),
    });
  const selected = resolveEvidenceInput(input, lookup);
  return selected.ok
    ? (options.resolveEvidence?.(selected.value, lookup, side) ?? selected)
    : selected;
};
