import {
  projectSelectedArtifactFileFailure,
  stableArtifactInputFailure,
  projectStableArtifactFailure,
} from "../../artifacts/StableArtifactFailure.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import type { StableArtifactSnapshot } from "../../artifacts/readStableArtifact.js";
import {
  artifactFilePrimaryFacts,
  artifactFileCancellationCause,
  type ArtifactFilePrimaryFacts,
} from "../../artifacts/ArtifactFileOperation.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
  type ResourceConstraintRecovery,
} from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../metadata/BinaryContainer.js";

interface PeBinaryInput {
  readonly path: string;
  readonly max_file_bytes: number;
}
interface PeBinaryFailureOptions<Limit extends string> {
  readonly operation: string;
  readonly providerId: string;
  readonly fileSizeRemediation: () => string;
  readonly limit: (cause: BinaryResourceFailure) => Limit | null;
  readonly limitRecovery: (limit: Limit | null) => ResourceConstraintRecovery;
}

const peBinaryFailurePrimary = <Limit extends string>(
  facts: ArtifactFilePrimaryFacts,
  input: PeBinaryInput,
  options: PeBinaryFailureOptions<Limit>,
): AnalysisError => {
  const { operation, providerId } = options;
  const { cause, origin } = facts;
  if (origin === "owned-or-classified" && cause instanceof AnalysisError)
    return cause;
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "integrity"
  )
    return new AnalysisArtifactChangedError(
      operation,
      input.path,
      cause.message,
      { cause },
    );
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "cancelled"
  )
    return new AnalysisCancelledError(operation, {
      cause: artifactFileCancellationCause(cause),
    });
  if (cause instanceof BinaryResourceFailure) {
    const limit = options.limit(cause);
    return new AnalysisResourceConstraintError(
      operation,
      "capacity",
      `Selected artifact ${input.path}: ${cause.message}`,
      { boundary: cause.boundary, maximum: cause.maximum_bytes, limit },
      { cause, ...options.limitRecovery(limit) },
    );
  }
  if (cause instanceof BinaryFormatFailure)
    return cause.kind === "unsupported"
      ? new AnalysisUnsupportedTargetError(
          operation,
          input.path,
          cause.message,
          { cause },
        )
      : new AnalysisInputError(operation, { cause }, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: `Selected artifact ${input.path}: ${cause.message}`,
          },
        ]);
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "limit")
      return new AnalysisResourceConstraintError(
        operation,
        "file-size",
        cause.message,
        { max_file_bytes: input.max_file_bytes },
        {
          cause,
          retryable: false,
          remediationAction: options.fileSizeRemediation(),
        },
      );
    if (cause.reason === "path" || cause.reason === "format")
      return stableArtifactInputFailure(cause, operation);
  }
  const fileFailure = projectSelectedArtifactFileFailure(
    cause,
    operation,
    input.path,
    "image",
  );
  if (fileFailure !== undefined) return fileFailure;
  return new ProviderAdapterError(providerId, operation, {
    cause,
    diagnostics: {
      path: input.path,
      reason: cause instanceof Error ? cause.message : String(cause),
    },
  });
};

/** Keep one PE error interpretation while preserving the provider's cleanup and partial facts. */
export const projectPeBinaryFailure = <Limit extends string>(
  cause: unknown,
  input: PeBinaryInput,
  options: PeBinaryFailureOptions<Limit>,
  snapshot?: StableArtifactSnapshot,
): AnalysisError =>
  projectStableArtifactFailure(
    cause,
    peBinaryFailurePrimary(artifactFilePrimaryFacts(cause), input, options),
    input.path,
    options.providerId,
    options.operation,
    snapshot,
  );
