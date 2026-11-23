import type { FixedCeilingFacts } from "../../domain/fixedAllowanceRemediation.js";
import {
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import {
  projectStableArtifactFailure,
  artifactFilePrimaryFacts,
} from "../../resources/index.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisResourceConstraintError,
  type ResourceConstraintRecovery,
} from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import {
  BinaryResourceFailure,
  binaryResourceCeiling,
  binaryResourceAllowance,
} from "../../domain/binaryContainer.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
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

/** Keep one PE error interpretation while preserving the provider's cleanup and partial facts. */
export const projectPeBinaryFailure = <Limit extends string>(
  cause: unknown,
  input: PeBinaryInput,
  options: PeBinaryFailureOptions<Limit>,
  snapshot?: Parameters<typeof projectStableArtifactFailure>[5],
): AnalysisError => {
  const { operation, providerId } = options;
  const { cause: primaryCause } = artifactFilePrimaryFacts(cause);
  const primary = classifyProviderFailure(primaryCause, {
    providerId,
    operation,
    recognise: (failure) => {
      if (failure instanceof BinaryResourceFailure) {
        const limit = binaryResourceAllowance(failure, options.limits);
        return parseLimitConstraint(operation, "capacity", failure, {
          path: input.path,
          ...options.limitRecovery(limit, binaryResourceCeiling(failure)),
        });
      }
      return parseFailureAnalysisError(operation, input.path, failure);
    },
    file: {
      path: input.path,
      description: "image",
      fileSize: (failure) =>
        new AnalysisResourceConstraintError(
          operation,
          "file-size",
          failure.message,
          { max_file_bytes: input.max_file_bytes },
          {
            cause: failure,
            retryable: false,
            remediationAction: options.fileSizeRemediation(),
          },
        ),
    },
    unclassified: (failure) =>
      new ProviderAdapterError(providerId, operation, {
        cause: failure,
        diagnostics: {
          path: input.path,
          reason: errorMessage(failure),
        },
      }),
  });
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    providerId,
    operation,
    snapshot,
  );
};
