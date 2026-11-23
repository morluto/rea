import {
  imageFileSizeRemediation,
  projectSelectedArtifactFileFailure,
  projectOwnedArtifactIdentityFailure,
  projectOwnedArtifactInputFailure,
  projectStableArtifactFailure,
  projectArtifactCloseFailure,
  ArtifactReaderFailure,
  withStableArtifactHandle,
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  ArtifactResourceScope,
  artifactParseFailure,
} from "../../resources/index.js";
import { fixedNativeAllowance } from "../../domain/native/nativeDeadlines.js";
import type { PeResourcesPort } from "../../ports/binaryDiagnostics/PeResourcesPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import {
  MAX_INSPECT_PE_DIRECTORY_ENTRIES,
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

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        PE_RESOURCES_PROVIDER.id,
        "inspect_pe_resources",
      );
    }
  }

  async inspect(input: InspectPeResourcesInput, options?: ExecutionOptions) {
    let observed:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () =>
        withStableArtifactHandle(
          input.path,
          input.max_file_bytes,
          {
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

const peResourcesFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectPeResourcesInput,
) => {
  const { cause, origin } = facts;
  const operation = "inspect_pe_resources";
  const identityFailure = projectOwnedArtifactIdentityFailure(
    facts,
    operation,
    input.path,
  );
  if (identityFailure !== undefined) return identityFailure;

  const inputFailure = projectOwnedArtifactInputFailure(
    facts,
    operation,
    input.path,
  );
  if (inputFailure !== undefined) return inputFailure;

  const reportedLimitContext = {
    max_file_bytes: input.max_file_bytes,
    max_entries: input.max_entries,
  };
  if (origin === "owned-or-classified" && isParseLimit(cause, "pe")) {
    const { limit } = cause.failure;
    const boundary = peResourceLimitBoundary(limit);
    if (boundary === "memory")
      return parseLimitConstraint(operation, boundary, cause, {
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
      return parseLimitConstraint(operation, boundary, cause, {
        reportedLimitContext: {
          ...reportedLimitContext,
          max_entries: limit.maximum,
        },
        retryable: false,
        remediationAction: entryBudgetRemediation(limit.maximum),
      });
  }

  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "limit"
  )
    return new AnalysisResourceConstraintError(
      operation,
      cause.boundary ?? "memory",
      cause.message,
      reportedLimitContext,
      {
        cause,
        ...(cause.boundary === "file-size"
          ? {
              retryable: false,
              remediationAction: imageFileSizeRemediation(
                input.max_file_bytes,
                MAX_INSPECT_PE_FILE_BYTES,
              ),
            }
          : {}),
      },
    );

  const fileFailure = projectSelectedArtifactFileFailure(
    cause,
    operation,
    input.path,
    "PE image",
  );
  if (fileFailure !== undefined) return fileFailure;

  return new ArtifactOperationError(
    operation,
    origin === "owned-or-classified" && cause instanceof ArtifactReaderFailure
      ? cause.reason
      : "io",
    undefined,
    cause instanceof Error ? cause.message : "PE artifact inspection failed.",
    { cause },
  );
};

const peResourcesFailure = (
  cause: unknown,
  input: InspectPeResourcesInput,
  observed?: { readonly sha256: string; readonly bytes: number },
) => {
  const primary = peResourcesFailurePrimary(
    artifactFilePrimaryFacts(cause),
    input,
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    PE_RESOURCES_PROVIDER.id,
    "inspect_pe_resources",
    observed,
  );
};
