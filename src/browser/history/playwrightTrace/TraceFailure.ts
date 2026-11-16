import { AnalysisError } from "../../../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  cancelledBy,
  carriedReason,
} from "../../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../../domain/artifactOperationError.js";
import { PLAYWRIGHT_TRACE_OPERATION as operation } from "../../../domain/playwrightTrace/playwrightTrace.js";
import {
  ArtifactReaderFailure,
  artifactFileCancellationCause,
  stableArtifactInputFailure,
  readerIntegrityFailure,
} from "../../../resources/index.js";
import { isSelectedRegularFileError } from "../../../filesystem/RegularFile.js";

/** Classify the archive owner's facts without interpreting opaque cancellation reasons. */
export const traceFailure = (cause: unknown, path: string): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "cancelled")
      return cancelledBy(
        operation,
        carriedReason(artifactFileCancellationCause(cause)),
      );
    if (cause.reason === "integrity")
      return readerIntegrityFailure(operation, path, cause);
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        operation,
        cause.boundary ?? "memory",
        cause.message,
        null,
        cause.fixedAllowance === undefined
          ? {
              cause,
              remediationAction:
                "Select a smaller complete recorder chunk. Reply selection does not increase archive parsing allowances.",
            }
          : { cause, retryable: false, fixedAllowance: cause.fixedAllowance },
      );
    if (cause.reason === "format" || cause.reason === "path")
      return stableArtifactInputFailure(cause, operation);
    return new ArtifactOperationError(
      operation,
      cause.reason,
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
