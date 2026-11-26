import { analysisSettingLimit } from "../domain/analysisSettingDefinitions.js";
import {
  projectZstandardFrameAllowance,
  ZstandardFrameAllowanceError,
} from "../domain/compression/zstandardFrameAllowance.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisTargetFailureError } from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { InternalInvariantError } from "../domain/internalInvariant.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";
import {
  artifactFileCancellationCause,
  bindArtifactFileCleanup,
} from "./ArtifactFileOperation.js";

/**
 * Translate one artifact boundary failure while retaining cleanup evidence. A
 * broken internal assumption is a REA defect, not an artifact read failure, so
 * it is rethrown for the provider adapter to report.
 *
 * A format owner's refusal of the bytes becomes the target failure of `path`,
 * the target the caller selected, whichever member the reader was reading.
 */
export const translateArtifactFailure = (
  operation: string,
  path: string,
  cause: unknown,
): AnalysisError => {
  if (cause instanceof InternalInvariantError) throw cause;
  if (cause instanceof ZstandardFrameAllowanceError)
    return projectZstandardFrameAllowance(operation, cause);
  if (cause instanceof ArtifactReaderFailure) {
    const target = artifactReaderTargetFailure(operation, path, cause);
    if (target === undefined)
      return translateArtifactOperationFailure(operation, cause);
    bindArtifactFileCleanup(cause, target);
    return target;
  }
  // Keep typed Evidence and other analysis failures instead of reducing them to I/O.
  if (cause instanceof AnalysisError) return cause;
  return new ArtifactOperationError(operation, "io", undefined, undefined, {
    cause,
  });
};

/**
 * Translate a reader failure of the operation rather than of its target, such
 * as a cancellation or a cleanup failure. A format owner's refusal is a
 * target failure and needs {@link translateArtifactFailure} with its path.
 */
export const translateArtifactOperationFailure = (
  operation: string,
  cause: ArtifactReaderFailure,
): ArtifactOperationError => {
  const reason = artifactOperationReason(cause);
  const error = new ArtifactOperationError(
    operation,
    reason,
    cause.details,
    cause.message,
    {
      ...(cause.userMessage === undefined
        ? {}
        : { userMessage: cause.userMessage }),
      cause:
        cause.reason === "cancelled"
          ? artifactFileCancellationCause(cause)
          : cause,
      ...(cause.cleanup === undefined ? {} : { cleanup: cause.cleanup }),
      ...(cause.partialObservation === undefined
        ? {}
        : { partialObservation: cause.partialObservation }),
      ...(cause.admission === undefined ? {} : { admission: cause.admission }),
      ...(cause.boundary === undefined ? {} : { boundary: cause.boundary }),
      ...(cause.readerLimit === undefined
        ? {}
        : { readerLimit: cause.readerLimit }),
      ...(cause.parserLimit === undefined
        ? {}
        : { parserLimit: cause.parserLimit }),
      ...(cause.fixedAllowance === undefined
        ? {}
        : { fixedAllowance: cause.fixedAllowance }),
      ...(cause.integrityCheck === undefined
        ? {}
        : { integrityCheck: cause.integrityCheck }),
    },
  );
  if (cause.admission !== undefined)
    error.bindLimit({
      ...analysisSettingLimit(
        cause.admission.kind === "asar-header"
          ? "asar.max_header_bytes"
          : "asar.max_listing_bytes",
        cause.admission.maximumBytes,
        cause.admission.source,
      ),
      ...(cause.admission.requiredBytes === undefined
        ? {}
        : { required_value: cause.admission.requiredBytes }),
    });
  bindArtifactFileCleanup(cause, error);
  return error;
};

/**
 * The target failure a reader's format owner raised, as the refusal of
 * `path`, with the reader's cleanup and completed observation. Undefined when
 * `cause` is not a format owner's refusal.
 */
export const artifactReaderTargetFailure = (
  operation: string,
  path: string,
  cause: unknown,
): AnalysisTargetFailureError | undefined =>
  cause instanceof ArtifactReaderFailure && cause.parseFailure !== undefined
    ? new AnalysisTargetFailureError(operation, path, cause.parseFailure, {
        cause,
        ...(cause.cleanup === undefined ? {} : { cleanup: cause.cleanup }),
        ...(cause.partialObservation === undefined
          ? {}
          : { partialObservation: cause.partialObservation }),
      })
    : undefined;

/**
 * The operation reason of a reader failure that carries no target failure.
 * A target reason without the owner's facts is a reader defect.
 */
export const artifactOperationReason = (
  cause: ArtifactReaderFailure,
): ArtifactOperationError["reason"] => {
  switch (cause.reason) {
    case "malformed":
    case "truncated":
    case "unsupported":
      throw new InternalInvariantError(
        `Artifact reader raised ${cause.reason} without its format facts`,
        { cause },
      );
    default:
      return cause.reason;
  }
};
