import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import type { AnalysisParameterLimit } from "../domain/analysisSettings.js";
import { fixedAllowanceOptions } from "../domain/fixedAllowanceRemediation.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import type { StableArtifactHandle } from "./readStableArtifact.js";
import type { ArtifactReadBudget } from "../domain/artifactReadBudget.js";

interface ReadBudgetExhaustion {
  readonly budget: ArtifactReadBudget;
  readonly requiredBytes: number;
}

const exhaustions = new WeakMap<ArtifactReaderFailure, ReadBudgetExhaustion>();

const exhausted = (
  budget: ArtifactReadBudget,
  requiredBytes: number,
  what: string,
): ArtifactReaderFailure => {
  const failure = new ArtifactReaderFailure(
    "limit",
    `${what} needs ${String(requiredBytes)} bytes of reads, above the ${String(budget.maximumBytes)}-byte ${budget.parameter} read allowance.`,
    { boundary: "capacity" },
  );
  exhaustions.set(failure, { budget, requiredBytes });
  return failure;
};

/**
 * Count the header prefix the reader parses and every positional read of
 * `handle` against `budget`, failing before the read that would exceed it.
 */
export const budgetArtifactReads = (
  handle: StableArtifactHandle,
  budget: ArtifactReadBudget,
): StableArtifactHandle => {
  let read = handle.prefix.length;
  if (read > budget.maximumBytes)
    throw exhausted(budget, read, "The header prefix");
  return {
    ...handle,
    readRange: (offset, length) => {
      const requiredBytes = read + length;
      if (requiredBytes > budget.maximumBytes)
        return Promise.reject(
          exhausted(
            budget,
            requiredBytes,
            `Reading ${String(length)} bytes at file offset ${String(offset)}`,
          ),
        );
      read = requiredBytes;
      return handle.readRange(offset, length);
    },
  };
};

/**
 * The typed refusal for an exhausted read allowance, or undefined for any
 * other cause. Its limit carries the reads the image needs, so the refusal
 * derives the value that admits the retry.
 */
export const artifactReadBudgetConstraint = (
  operation: string,
  cause: unknown,
  reportedLimits: Readonly<Record<string, number>>,
): AnalysisResourceConstraintError | undefined => {
  if (!(cause instanceof ArtifactReaderFailure)) return undefined;
  const exhaustion = exhaustions.get(cause);
  if (exhaustion === undefined) return undefined;
  const { budget, requiredBytes } = exhaustion;
  const limit: AnalysisParameterLimit = {
    control_kind: "parameter",
    parameter: budget.parameter,
    effective_value: budget.maximumBytes,
    unit: "bytes",
    minimum: budget.minimumBytes,
    maximum: budget.ceilingBytes,
    default_value: budget.defaultBytes,
    applies_at: "next_call",
    required_value: requiredBytes,
  };
  return new AnalysisResourceConstraintError(
    operation,
    "capacity",
    cause.message,
    { ...reportedLimits, required_read_bytes: requiredBytes },
    {
      cause,
      limit,
      retryable: false,
    },
  );
};

/**
 * A file larger than the identity pass admits. `max_file_bytes` does not
 * raise this ceiling; it bounds only the bytes the reader reads.
 */
export const artifactFileCeilingConstraint = (
  operation: string,
  cause: ArtifactReaderFailure,
  ceiling: { readonly name: string; readonly bytes: number },
  reportedLimits: Readonly<Record<string, number>>,
): AnalysisResourceConstraintError =>
  new AnalysisResourceConstraintError(
    operation,
    "file-size",
    cause.message,
    reportedLimits,
    {
      cause,
      ...fixedAllowanceOptions(ceiling.name, "input", {
        limit: ceiling.bytes,
        unit: "bytes",
      }),
    },
  );
