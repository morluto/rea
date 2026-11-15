import { parseFailureAnalysisError } from "../../domain/parseFailureAnalysisError.js";
import {
  projectArtifactCloseFailure,
  projectOwnedArtifactIdentityFailure,
  projectSelectedArtifactFileFailure,
  projectStableArtifactFailure,
  stableArtifactInputFailure,
  ArtifactReaderFailure,
  readStableArtifact,
  type StableArtifactSnapshot,
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  ArtifactResourceScope,
} from "../../resources/index.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  MAX_INSPECT_ELF_DEPENDENCY_FILE_BYTES,
  type InspectElfDependenciesInput,
} from "../../domain/native/elfDependencies.js";
import { err, ok } from "../../domain/result.js";
import { ELF_DEPENDENCIES_PROVIDER } from "../../domain/investigationProviders.js";
import { BinaryResourceFailure } from "../../domain/binaryContainer.js";
import {
  ElfDependencyCountFailure,
  type ElfDependencyCountLimit,
  parseElfDependencies,
} from "./ElfDependencyParser.js";

const OPERATION = "inspect_elf_dependencies";

/** Portable parser over one bounded, identity-checked regular file. */
/**
 * Satisfies ElfDependenciesPort structurally; composition
 * checks the fit, so this provider does not import the application layer.
 */
export class ElfDependenciesProvider {
  readonly identity = ELF_DEPENDENCIES_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        ELF_DEPENDENCIES_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(
    input: InspectElfDependenciesInput,
    options?: { readonly signal?: AbortSignal },
  ) {
    let completed: StableArtifactSnapshot | undefined;
    try {
      return await this.#resources.run(async () => {
        const snapshot = await readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        // Only a parser failure inherits this read's identity; finalization
        // failures keep their own completion record.
        completed = snapshot;
        const report = parseElfDependencies(
          snapshot.bytes,
          {
            path: input.path,
            sha256: snapshot.sha256,
            bytes: snapshot.bytes.length,
          },
          input,
        );
        completed = undefined;
        return ok(report);
      });
    } catch (cause) {
      return err(elfDependenciesFailure(cause, input, completed));
    }
  }
}

const fileSizeRemediation = (input: InspectElfDependenciesInput): string =>
  input.max_file_bytes >= MAX_INSPECT_ELF_DEPENDENCY_FILE_BYTES
    ? `The image exceeds the ${String(MAX_INSPECT_ELF_DEPENDENCY_FILE_BYTES)}-byte input ceiling this operation accepts. This release has no runtime override, and raising max_file_bytes does not raise it; select a smaller artifact.`
    : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`;

const countLimitRemediation = (limit: ElfDependencyCountLimit): string =>
  limit.kind === "budget"
    ? `Raise ${limit.parameter} above ${String(limit.value)}, up to ${String(limit.ceiling)}, or select a smaller artifact; the limit is the caller-selected budget for ${limit.entries}.`
    : `${limit.entries} are limited to a fixed ceiling of ${String(limit.value)} entries. This release has no runtime override, and raising max_needed, max_versions, or max_imports does not raise it; select a smaller artifact.`;

const elfDependenciesFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectElfDependenciesInput,
) => {
  const { cause, origin } = facts;
  if (cause instanceof BinaryResourceFailure)
    return new AnalysisResourceConstraintError(
      OPERATION,
      "memory",
      cause.message,
      { boundary: cause.boundary, maximum_bytes: cause.maximum_bytes },
      {
        cause,
        ...fixedAllowanceOptions(
          "The ELF structural decoding allowance",
          "parser",
        ),
      },
    );
  const formatFailure = parseFailureAnalysisError(OPERATION, input.path, cause);
  if (formatFailure !== undefined) return formatFailure;
  const identityFailure = projectOwnedArtifactIdentityFailure(
    facts,
    OPERATION,
    input.path,
  );
  if (identityFailure !== undefined) return identityFailure;
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "limit") {
      const textBudget = cause.boundary === "memory";
      return new AnalysisResourceConstraintError(
        OPERATION,
        cause.boundary ?? "memory",
        cause.message,
        {
          max_file_bytes: input.max_file_bytes,
          max_needed: input.max_needed,
          max_versions: input.max_versions,
          max_imports: input.max_imports,
        },
        {
          cause,
          ...(cause.boundary === undefined
            ? {}
            : textBudget
              ? fixedAllowanceOptions(
                  "The ELF dependency text budget fixed by the admitted image length",
                  "parser",
                )
              : {
                  retryable: false as const,
                  remediationAction:
                    cause instanceof ElfDependencyCountFailure
                      ? countLimitRemediation(cause.limit)
                      : fileSizeRemediation(input),
                }),
        },
      );
    }
    if (cause.reason === "path" || cause.reason === "format")
      return stableArtifactInputFailure(cause, OPERATION);
  }
  const fileFailure = projectSelectedArtifactFileFailure(
    cause,
    OPERATION,
    input.path,
    "ELF image",
  );
  if (fileFailure !== undefined) return fileFailure;
  return new ArtifactOperationError(
    OPERATION,
    origin === "owned-or-classified" && cause instanceof ArtifactReaderFailure
      ? cause.reason
      : "io",
    undefined,
    cause instanceof Error
      ? cause.message
      : "ELF dependency inspection failed.",
    { cause },
  );
};

const elfDependenciesFailure = (
  cause: unknown,
  input: InspectElfDependenciesInput,
  completed: StableArtifactSnapshot | undefined,
) => {
  const primary = elfDependenciesFailurePrimary(
    artifactFilePrimaryFacts(cause),
    input,
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    ELF_DEPENDENCIES_PROVIDER.id,
    OPERATION,
    completed,
  );
};
