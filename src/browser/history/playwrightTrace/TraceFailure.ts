import { AnalysisError } from "../../../domain/analysisErrorBase.js";
import {
  AnalysisTargetFailureError,
  AnalysisAccessDeniedError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  fixedCeilingConstraint,
} from "../../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../../domain/artifactOperationError.js";
import {
  PLAYWRIGHT_TRACE_OPERATION as operation,
  playwrightTraceLimitRecovery,
  type PlaywrightTraceLimits,
} from "../../../domain/playwrightTrace/playwrightTrace.js";
import { fixedAllowanceOptions } from "../../../domain/fixedAllowanceRemediation.js";
import {
  ArtifactReaderFailure,
  artifactFileCancellationError,
  stableArtifactInputFailure,
  readerIntegrityFailure,
  artifactOperationReason,
} from "../../../resources/index.js";
import { isSelectedRegularFileError } from "../../../filesystem/RegularFile.js";

/** Classify the archive owner's facts without interpreting opaque cancellation reasons. */
export const traceFailure = (
  cause: unknown,
  path: string,
  limits: PlaywrightTraceLimits,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "cancelled")
      return artifactFileCancellationError(operation, cause);
    if (cause.reason === "integrity")
      return readerIntegrityFailure(operation, path, cause);
    if (cause.reason === "limit") {
      if (cause.fixedAllowance !== undefined)
        return fixedCeilingConstraint(
          operation,
          cause.boundary ?? "memory",
          cause.message,
          cause.fixedAllowance,
          { cause },
        );
      // The ZIP reader's plaintext-work budget grows with the archive size;
      // this tool selects no expansion control, so it is fixed per archive.
      if (cause.readerLimit !== undefined)
        return fixedCeilingConstraint(
          operation,
          cause.boundary ?? "memory",
          cause.message,
          fixedAllowanceOptions(
            "The Playwright trace ZIP expansion allowance (derived from the archive size)",
            "parser",
            {
              limit: cause.readerLimit.effective_value,
              unit: cause.readerLimit.unit,
            },
          ).fixedAllowance,
          { cause },
        );
      // The remaining ZIP limit is the metadata read budget this tool selects.
      return new AnalysisResourceConstraintError(
        operation,
        cause.boundary ?? "memory",
        cause.message,
        { max_metadata_bytes: limits.metadata_bytes },
        { cause, ...playwrightTraceLimitRecovery("metadata_bytes", limits) },
      );
    }
    // The archive owner established malformed or truncated bytes: a target
    // refusal. Only a path-kind refusal is the caller's selection.
    if (cause.parseFailure !== undefined)
      return new AnalysisTargetFailureError(
        operation,
        path,
        cause.parseFailure,
        { cause },
      );
    if (cause.reason === "path")
      return stableArtifactInputFailure(cause, operation);
    return new ArtifactOperationError(
      operation,
      artifactOperationReason(cause),
      undefined,
      cause.message,
      { cause },
    );
  }
  if (
    cause instanceof Error &&
    "code" in cause &&
    (cause.code === "EACCES" || cause.code === "EPERM")
  )
    return new AnalysisAccessDeniedError(operation, path, cause.code, {
      cause,
    });
  if (cause instanceof Error && isSelectedRegularFileError(cause))
    return new AnalysisInputError(operation, { cause }, [
      {
        path: ["path"],
        reason: "invalid_format",
        message:
          "Expected a readable regular trace archive without a symbolic link.",
      },
    ]);
  return new ArtifactOperationError(
    operation,
    "io",
    undefined,
    "Trace archive could not be read.",
    { cause },
  );
};
