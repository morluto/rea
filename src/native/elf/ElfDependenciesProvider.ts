import { setImmediate as immediate } from "node:timers/promises";
import {
  isParseLimit,
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import { decodeLimit } from "../../domain/parseFailure.js";
import {
  projectArtifactCloseFailure,
  projectOwnedArtifactIdentityFailure,
  projectSelectedArtifactFileFailure,
  projectStableArtifactFailure,
  stableArtifactInputFailure,
  ArtifactReaderFailure,
  withStableArtifactHandle,
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  ArtifactResourceScope,
  assertArtifactReadActive,
  imageFileSizeRemediation,
} from "../../resources/index.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  MAX_INSPECT_ELF_DEPENDENCY_FILE_BYTES,
  MAX_INSPECT_ELF_DEPENDENCY_IMPORTS,
  MAX_INSPECT_ELF_DEPENDENCY_NEEDED,
  MAX_INSPECT_ELF_DEPENDENCY_VERSIONS,
  type InspectElfDependenciesInput,
} from "../../domain/native/elfDependencies.js";
import { err, ok } from "../../domain/result.js";
import { ELF_DEPENDENCIES_PROVIDER } from "../../domain/investigationProviders.js";
import {
  BinaryResourceFailure,
  binaryResourceCeiling,
} from "../../domain/binaryContainer.js";
import { parseElfDependenciesFromHandle } from "./ElfDependencyParser.js";

const OPERATION = "inspect_elf_dependencies";
const HEADER_PREFIX_BYTES = 4096;

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
    let completed:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () => {
        const result = await withStableArtifactHandle(
          input.path,
          input.max_file_bytes,
          {
            signal: options?.signal,
            resourceScope: this.#resources,
            retainBytes: (size) => Math.min(size, HEADER_PREFIX_BYTES),
            onIdentity: (identity) => {
              // Only a parser failure inherits this read's identity; finalization
              // failures keep their own completion record.
              completed = identity;
            },
          },
          async (handle) => {
            assertArtifactReadActive(options?.signal);
            const parsed = await parseElfDependenciesFromHandle(
              {
                size: handle.size,
                prefix: handle.prefix,
                readRange: (offset, length) => handle.readRange(offset, length),
              },
              {
                path: input.path,
                sha256: handle.sha256,
                bytes: handle.size,
              },
              input,
              async () => {
                await immediate();
                assertArtifactReadActive(options?.signal);
              },
            );
            assertArtifactReadActive(options?.signal);
            completed = undefined;
            return parsed;
          },
        );
        return ok(result);
      });
    } catch (cause) {
      return err(elfDependenciesFailure(cause, input, completed));
    }
  }
}

const COUNT_CEILINGS = {
  max_needed: MAX_INSPECT_ELF_DEPENDENCY_NEEDED,
  max_versions: MAX_INSPECT_ELF_DEPENDENCY_VERSIONS,
  max_imports: MAX_INSPECT_ELF_DEPENDENCY_IMPORTS,
} as const;

const elfDependenciesFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectElfDependenciesInput,
) => {
  const { cause, origin } = facts;
  if (cause instanceof BinaryResourceFailure)
    return parseLimitConstraint(
      OPERATION,
      "memory",
      cause,
      fixedAllowanceOptions(
        "The ELF structural decoding allowance",
        "parser",
        binaryResourceCeiling(cause),
      ),
    );
  if (isParseLimit(cause, "elf-dependencies")) {
    const limit = cause.failure.limit;
    const parameter = (
      Object.keys(COUNT_CEILINGS) as (keyof typeof COUNT_CEILINGS)[]
    ).find((name) => name === limit.name);
    if (parameter !== undefined)
      return parseLimitConstraint(OPERATION, "capacity", cause, {
        path: input.path,
        retryable: false,
        remediationAction: `Raise ${parameter} above ${String(limit.maximum)}, up to ${String(COUNT_CEILINGS[parameter])}, or select a smaller artifact.`,
      });
    const text =
      limit.name === "scanned_text_bytes" ||
      limit.name === "retained_text_bytes";
    const work = limit.name === "gnu_hash_entries";
    return parseLimitConstraint(
      OPERATION,
      text ? "memory" : work ? "cpu" : "capacity",
      cause,
      {
        path: input.path,
        ...fixedAllowanceOptions(
          text
            ? "The ELF dependency text budget fixed by the admitted image length"
            : `The ELF dependency ${limit.name} allowance`,
          text ? "parser" : work ? "work" : "count",
          { limit: limit.maximum, unit: text ? "bytes" : "entries" },
        ),
      },
    );
  }
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
      return parseLimitConstraint(
        OPERATION,
        "file-size",
        decodeLimit(
          "elf-dependencies",
          cause.message,
          { name: "max_file_bytes", maximum: input.max_file_bytes },
          { cause },
        ),
        {
          path: input.path,
          retryable: false,
          remediationAction: imageFileSizeRemediation(
            input.max_file_bytes,
            MAX_INSPECT_ELF_DEPENDENCY_FILE_BYTES,
          ),
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
  completed: { readonly sha256: string; readonly bytes: number } | undefined,
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
