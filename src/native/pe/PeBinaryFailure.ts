import type { FixedCeilingFacts } from "../../domain/fixedAllowanceRemediation.js";
import { parseLimitConstraint } from "../../domain/parseFailureAnalysisError.js";
import {
  artifactFileCeilingConstraint,
  artifactReadBudgetConstraint,
  projectStableArtifactFailure,
  artifactFilePrimaryFacts,
} from "../../resources/index.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { ResourceConstraintRecovery } from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import {
  BinaryResourceFailure,
  binaryResourceCeiling,
  binaryResourceAllowance,
} from "../../domain/binaryContainer.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";
import { errorMessage } from "../../kernel/errorMessage.js";

interface PeBinaryInput {
  readonly path: string;
  readonly max_file_bytes: number;
}
interface PeBinaryFailureOptions<Limit extends string> {
  readonly operation: string;
  readonly providerId: string;
  /** The whole-file ceiling of the identity pass; `max_file_bytes` does not raise it. */
  readonly fileCeiling: { readonly name: string; readonly bytes: number };
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
        if (failure instanceof BinaryResourceFailure) {
          const limit = binaryResourceAllowance(failure, options.limits);
          return parseLimitConstraint(operation, "capacity", failure, {
            path: input.path,
            ...options.limitRecovery(limit, binaryResourceCeiling(failure)),
          });
        }
        return undefined;
      },
      fileSize: (failure) =>
        artifactFileCeilingConstraint(operation, failure, options.fileCeiling, {
          max_file_bytes: input.max_file_bytes,
        }),
      unclassified: (failure) =>
        new ProviderAdapterError(providerId, operation, {
          cause: failure,
          diagnostics: {
            path: input.path,
            reason: errorMessage(failure),
          },
        }),
    }),
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    providerId,
    operation,
    snapshot,
  );
};
