import type { AnalysisParameterLimit } from "../../domain/analysisSettings.js";
import { decodeLimit } from "../../domain/parseFailure.js";
import { parseLimitConstraint } from "../../domain/parseFailureAnalysisError.js";
import {
  artifactFileCeilingConstraint,
  artifactReadBudgetConstraint,
  projectStableArtifactFailure,
  artifactFilePrimaryFacts,
} from "../../resources/index.js";
import type {
  AnalysisError,
  AnalysisErrorOptions,
  AnalysisPartialObservation,
} from "../../domain/analysisErrorBase.js";
import type { ResourceConstraintRecovery } from "../../domain/analysisErrorCore.js";
import {
  BinaryResourceFailure,
  binaryResourceAllowance,
} from "../../domain/binaryContainer.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";

interface PeBinaryInput {
  readonly path: string;
  readonly max_file_bytes: number;
}
interface PeBinaryFailureOptions<Limit extends string> {
  readonly operation: string;
  readonly providerId: string;
  /**
   * The whole-file ceiling of the identity pass (`max_file_bytes` does not
   * raise it), or an adjustable `max_file_bytes` parameter limit when
   * `max_file_bytes` directly bounds the whole-file read.
   */
  readonly fileCeiling:
    | { readonly name: string; readonly bytes: number }
    | { readonly parameterLimit: AnalysisParameterLimit };
  /** The allowances the parser names in its `BinaryResourceFailure`; no other reaches these readers. */
  readonly limits?: readonly Limit[];
  /** The control or recovery of the named allowance. */
  readonly limitRecovery?: (
    limit: Limit,
    failure: BinaryResourceFailure,
  ) => ResourceConstraintRecovery & {
    readonly limit?: AnalysisErrorOptions["limit"];
  };
  /** A verified report the failure keeps, such as one completed before final cleanup failed. */
  readonly completed?: AnalysisPartialObservation;
}

/** Keep one PE error interpretation while preserving the provider's cleanup and partial facts. */
export const projectPeBinaryFailure = <Limit extends string = never>(
  cause: unknown,
  input: PeBinaryInput,
  options: PeBinaryFailureOptions<Limit>,
  snapshot?: Parameters<typeof projectStableArtifactFailure>[5],
): AnalysisError => {
  const { operation, providerId } = options;
  const facts = artifactFilePrimaryFacts(cause);
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId,
      operation,
      path: input.path,
      description: "image",
      recognise: (failure) => {
        const readBudget = artifactReadBudgetConstraint(operation, failure, {
          max_file_bytes: input.max_file_bytes,
        });
        if (readBudget !== undefined) return readBudget;
        if (
          failure instanceof BinaryResourceFailure &&
          options.limits !== undefined &&
          options.limitRecovery !== undefined
        ) {
          const limit = binaryResourceAllowance(failure, options.limits);
          if (limit === null) return undefined;
          return parseLimitConstraint(operation, "capacity", failure, {
            path: input.path,
            ...options.limitRecovery(limit, failure),
          });
        }
        return undefined;
      },
      fileSize: (failure) => {
        if (!("parameterLimit" in options.fileCeiling))
          return artifactFileCeilingConstraint(
            operation,
            failure,
            options.fileCeiling,
            {
              max_file_bytes: input.max_file_bytes,
            },
          );
        const { parameterLimit } = options.fileCeiling;
        const requiredBytes = failure.observedBytes;
        const limit: AnalysisParameterLimit =
          requiredBytes === undefined ||
          requiredBytes > BigInt(Number.MAX_SAFE_INTEGER)
            ? parameterLimit
            : { ...parameterLimit, required_value: Number(requiredBytes) };
        return parseLimitConstraint(
          operation,
          "file-size",
          decodeLimit(
            "pe",
            failure.message,
            {
              name: parameterLimit.parameter,
              maximum: parameterLimit.effective_value,
              ...(requiredBytes === undefined
                ? {}
                : { required: requiredBytes }),
            },
            { cause: failure },
          ),
          {
            retryable: false,
            limit,
          },
        );
      },
    }),
  );
  if (options.completed !== undefined)
    primary.retainPartialObservation(options.completed);
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    providerId,
    operation,
    snapshot,
  );
};
