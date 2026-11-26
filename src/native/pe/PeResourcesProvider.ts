import {
  maxFileBytesReadBudget,
  PE_FILE_CEILING_BYTES,
} from "../../domain/artifactReadBudget.js";
import {
  artifactFileCeilingConstraint,
  artifactReadBudgetConstraint,
  projectStableArtifactFailure,
  closeArtifactResources,
  ArtifactReaderFailure,
  withStableArtifactHandle,
  artifactFilePrimaryFacts,
  ArtifactResourceScope,
  artifactParseFailure,
} from "../../resources/index.js";
import { fixedNativeAllowance } from "../../domain/native/nativeDeadlines.js";
import type { PeResourcesPort } from "../../ports/binaryDiagnostics/PeResourcesPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";
import {
  MAX_INSPECT_PE_DIRECTORY_ENTRIES,
  peResourceEntryLimit,
  MAX_INSPECT_PE_FILE_BYTES,
  type InspectPeResourcesInput,
} from "../../domain/native/peResources.js";
import { err, ok } from "../../domain/result.js";
import { PE_RESOURCES_PROVIDER } from "../../domain/investigationProviders.js";
import {
  isParseLimit,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import {
  parsePeResourcesFromSource,
  peResourceLimitBoundary,
} from "../../domain/pe/peResourceInventory.js";

const PE_HEADER_PREFIX_BYTES = 4096;

/** Portable parser over one bounded, identity-checked regular file. */
export class PeResourcesProvider implements PeResourcesPort {
  readonly identity = PE_RESOURCES_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      PE_RESOURCES_PROVIDER,
      "inspect_pe_resources",
    );
  }

  async inspect(input: InspectPeResourcesInput, options?: ExecutionOptions) {
    let observed:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () =>
        withStableArtifactHandle(
          input.path,
          PE_FILE_CEILING_BYTES,
          {
            readBudget: maxFileBytesReadBudget(
              input.max_file_bytes,
              MAX_INSPECT_PE_FILE_BYTES,
            ),
            retainBytes: (size) => Math.min(size, PE_HEADER_PREFIX_BYTES),
            signal: options?.signal,
            resourceScope: this.#resources,
            onIdentity: (identity) => {
              observed = identity;
            },
          },
          async (handle) => {
            try {
              return ok(
                await parsePeResourcesFromSource(
                  handle,
                  {
                    path: input.path,
                    sha256: handle.sha256,
                    bytes: handle.size,
                  },
                  input,
                  options?.signal,
                ),
              );
            } catch (cause) {
              if (
                isParseLimit(cause, "pe") &&
                !Object.is(cause, options?.signal?.reason)
              )
                throw cause;
              throw artifactParseFailure(cause, options?.signal);
            }
          },
        ),
      );
    } catch (cause) {
      return err(peResourcesFailure(cause, input, observed));
    }
  }
}

/**
 * Remediation for a caller-selected budget refusal. At the schema ceiling
 * there is no value left to raise the bound to, so the advice names the
 * ceiling instead of an impossible raise.
 */
const entryBudgetRemediation = (maximum: number): string =>
  maximum >= MAX_INSPECT_PE_DIRECTORY_ENTRIES
    ? `The image exceeds the ${String(MAX_INSPECT_PE_DIRECTORY_ENTRIES)}-entry resource-directory ceiling this operation accepts. This release has no runtime override. Select a smaller artifact.`
    : `Raise max_entries above ${String(maximum)} or select a smaller artifact; the limit is the caller-selected resource directory entry budget.`;

const peResourcesFailure = (
  cause: unknown,
  input: InspectPeResourcesInput,
  observed?: { readonly sha256: string; readonly bytes: number },
) => {
  const operation = "inspect_pe_resources";
  const facts = artifactFilePrimaryFacts(cause);
  const reportedLimitContext = {
    max_file_bytes: input.max_file_bytes,
    max_entries: input.max_entries,
  };
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: PE_RESOURCES_PROVIDER.id,
      operation,
      path: input.path,
      description: "PE image",
      fallbackMessage: "PE artifact inspection failed.",
      recognise: (failure, origin) => {
        const readBudget = artifactReadBudgetConstraint(
          operation,
          failure,
          reportedLimitContext,
        );
        if (readBudget !== undefined) return readBudget;
        if (
          origin === "owned-or-classified" &&
          failure instanceof ArtifactReaderFailure &&
          failure.reason === "limit" &&
          failure.boundary === "file-size"
        )
          return artifactFileCeilingConstraint(
            operation,
            failure,
            {
              name: "The PE whole-file ceiling (32-bit file offsets)",
              bytes: PE_FILE_CEILING_BYTES,
            },
            reportedLimitContext,
          );
        if (origin === "owned-or-classified" && isParseLimit(failure, "pe")) {
          const { limit } = failure.failure;
          const boundary = peResourceLimitBoundary(limit);
          if (boundary === "memory")
            return parseLimitConstraint(operation, boundary, failure, {
              reportedLimitContext: {
                ...reportedLimitContext,
                maximum_metadata_bytes: limit.maximum,
              },
              ...fixedNativeAllowance(
                "The PE resource metadata allowance",
                "parser",
                limit.maximum,
                "bytes",
              ),
            });
          if (boundary === "capacity")
            return parseLimitConstraint(operation, boundary, failure, {
              reportedLimitContext: {
                ...reportedLimitContext,
                max_entries: limit.maximum,
              },
              retryable: false,
              limit: peResourceEntryLimit(limit.maximum),
              remediationAction: entryBudgetRemediation(limit.maximum),
            });
        }
        if (
          origin === "owned-or-classified" &&
          failure instanceof ArtifactReaderFailure &&
          failure.reason === "limit"
        )
          return new AnalysisResourceConstraintError(
            operation,
            failure.boundary ?? "memory",
            failure.message,
            reportedLimitContext,
            // A reader limit other than the read allowance and the file
            // ceiling is an exhaustion the reader observed.
            { cause: failure, measuredExhaustion: true },
          );
        return undefined;
      },
    }),
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    PE_RESOURCES_PROVIDER.id,
    operation,
    observed,
  );
};
