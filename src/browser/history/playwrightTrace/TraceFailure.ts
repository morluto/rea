import { AnalysisError } from "../../../domain/analysisErrorBase.js";
import {
  AnalysisTargetFailureError,
  AnalysisAccessDeniedError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  fixedCeilingConstraint,
} from "../../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../../domain/artifactOperationError.js";
import { PLAYWRIGHT_TRACE_OPERATION as operation } from "../../../domain/playwrightTrace/playwrightTrace.js";
import {
  ArtifactReaderFailure,
  artifactFileCancellationError,
  stableArtifactInputFailure,
  readerIntegrityFailure,
  artifactOperationReason,
} from "../../../resources/index.js";
import { isSelectedRegularFileError } from "../../../filesystem/RegularFile.js";

/** Classify the archive owner's facts without interpreting opaque cancellation reasons. */
export const traceFailure = (cause: unknown, path: string): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "cancelled")
      return artifactFileCancellationError(operation, cause);
    if (cause.reason === "integrity")
      return readerIntegrityFailure(operation, path, cause);
    if (cause.reason === "limit")
      return cause.fixedAllowance === undefined
        ? new AnalysisResourceConstraintError(
            operation,
            cause.boundary ?? "memory",
            cause.message,
            null,
            {
              cause,
              remediationAction:
                "Select a smaller complete recorder chunk. Reply selection does not increase archive parsing allowances.",
            },
          )
        : fixedCeilingConstraint(
            operation,
            cause.boundary ?? "memory",
            cause.message,
            cause.fixedAllowance,
            { cause },
          );
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
