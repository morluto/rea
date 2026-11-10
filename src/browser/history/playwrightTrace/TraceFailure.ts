import { AnalysisError } from "../../../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../../../domain/artifactOperationError.js";
import { PLAYWRIGHT_TRACE_OPERATION as operation } from "../../../domain/playwrightTrace/playwrightTrace.js";
import { ArtifactReaderFailure } from "../../../artifacts/ArtifactReader.js";
import { artifactFileCancellationCause } from "../../../artifacts/ArtifactFileOperation.js";
import { isSelectedRegularFileError } from "../../../filesystem/RegularFile.js";
import { stableArtifactInputRecovery } from "../../../artifacts/StableArtifactFailure.js";

/** Classify the archive owner's facts without interpreting opaque cancellation reasons. */
export const traceFailure = (cause: unknown, path: string): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof ArtifactReaderFailure) {
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError(operation, {
        cause: artifactFileCancellationCause(cause),
      });
    if (cause.reason === "integrity")
      return new AnalysisArtifactChangedError(operation, path, cause.message, {
        cause,
      });
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        operation,
        cause.boundary ?? "memory",
        cause.message,
        null,
        {
          cause,
          remediationAction:
            "Select a smaller complete recorder chunk. Reply selection does not increase archive parsing allowances.",
        },
      );
    if (cause.reason === "format" || cause.reason === "path")
      return new AnalysisInputError(
        operation,
        { cause, ...stableArtifactInputRecovery(cause) },
        [{ path: ["path"], reason: "invalid_format", message: cause.message }],
      );
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
