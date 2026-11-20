import type { FixedCeilingFacts } from "../../domain/fixedAllowanceRemediation.js";
import {
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import {
  projectSelectedArtifactFileFailure,
  stableArtifactInputFailure,
  projectStableArtifactFailure,
  readerIntegrityFailure,
  ArtifactReaderFailure,
  type StableArtifactSnapshot,
  artifactFilePrimaryFacts,
  artifactFileCancellationCause,
  type ArtifactFilePrimaryFacts,
} from "../../resources/index.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisResourceConstraintError,
  type ResourceConstraintRecovery,
  cancelledBy,
  carriedReason,
} from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import {
  BinaryResourceFailure,
  binaryResourceCeiling,
  binaryResourceAllowance,
} from "../../domain/binaryContainer.js";
import { errorMessage } from "../../kernel/errorMessage.js";

interface PeBinaryInput {
  readonly path: string;
  readonly max_file_bytes: number;
}
interface PeBinaryFailureOptions<Limit extends string> {
  readonly operation: string;
  readonly providerId: string;
  readonly fileSizeRemediation: () => string;
  /** The allowances the parser names in its `BinaryResourceFailure`. */
  readonly limits: readonly Limit[];
  /** Recovery for the named allowance, or the structural allowance (`null`) at `ceiling`. */
  readonly limitRecovery: (
    limit: Limit | null,
    ceiling: FixedCeilingFacts,
  ) => ResourceConstraintRecovery;
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
    return readerIntegrityFailure(operation, input.path, cause);
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "cancelled"
  )
    return cancelledBy(
      operation,
      carriedReason(artifactFileCancellationCause(cause)),
    );
  if (cause instanceof BinaryResourceFailure) {
    const limit = binaryResourceAllowance(cause, options.limits);
    return parseLimitConstraint(operation, "capacity", cause, {
      path: input.path,
      ...options.limitRecovery(limit, binaryResourceCeiling(cause)),
    });
  }
  const formatFailure = parseFailureAnalysisError(operation, input.path, cause);
  if (formatFailure !== undefined) return formatFailure;
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
      reason: errorMessage(cause),
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
