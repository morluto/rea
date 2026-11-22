import {
  imageFileSizeRemediation,
  projectSelectedArtifactFileFailure,
  projectOwnedArtifactIdentityFailure,
  projectOwnedArtifactInputFailure,
  projectStableArtifactFailure,
  projectArtifactCloseFailure,
  ArtifactReaderFailure,
  type StableArtifactSnapshot,
  readStableArtifact,
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
  parsePeResources,
  peResourceLimitBoundary,
} from "../../domain/pe/peResourceInventory.js";

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
    let snapshot: StableArtifactSnapshot | undefined;
    try {
      return await this.#resources.run(async () => {
        snapshot = await readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        const { bytes, sha256 } = snapshot;
        try {
          return ok(
            await parsePeResources(
              bytes,
              { path: input.path, sha256, bytes: bytes.length },
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
      });
    } catch (cause) {
      return err(peResourcesFailure(cause, input, snapshot));
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
  snapshot?: StableArtifactSnapshot,
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
    snapshot,
  );
};
