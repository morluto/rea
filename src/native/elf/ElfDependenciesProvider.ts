import {
  projectStableArtifactFailure,
  projectArtifactCloseFailure,
} from "../../artifacts/StableArtifactFailure.js";
import { isSelectedRegularFileError } from "../../filesystem/RegularFile.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  readStableArtifact,
  type StableArtifactSnapshot,
} from "../../artifacts/readStableArtifact.js";
import {
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  artifactFileCancellationCause,
} from "../../artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import type { ElfDependenciesPort } from "../../application/binaryDiagnostics/ElfDependenciesPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  MAX_INSPECT_ELF_DEPENDENCY_FILE_BYTES,
  type InspectElfDependenciesInput,
} from "../../domain/native/elfDependencies.js";
import { err, ok } from "../../domain/result.js";
import { ELF_DEPENDENCIES_PROVIDER } from "../../domain/investigationProviders.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../metadata/BinaryContainer.js";
import {
  ElfDependencyCountFailure,
  type ElfDependencyCountLimit,
  parseElfDependencies,
} from "./ElfDependencyParser.js";

const OPERATION = "inspect_elf_dependencies";

/** Portable parser over one bounded, identity-checked regular file. */
export class ElfDependenciesProvider implements ElfDependenciesPort {
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
    options?: ExecutionOptions,
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
  if (cause instanceof BinaryFormatFailure)
    return cause.kind === "unsupported"
      ? new AnalysisUnsupportedTargetError(
          OPERATION,
          input.path,
          cause.message,
          { cause },
        )
      : new AnalysisInputError(OPERATION, { cause }, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: cause.message,
          },
        ]);
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "integrity"
  )
    return new AnalysisArtifactChangedError(
      OPERATION,
      input.path,
      cause.message,
      { cause },
    );
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "cancelled"
  )
    return new AnalysisCancelledError(OPERATION, {
      cause: artifactFileCancellationCause(cause),
    });
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
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_format",
          message: cause.message,
        },
      ]);
  }
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, input.path, cause.code, {
        cause,
      });
    if (isSelectedRegularFileError(cause))
      return new AnalysisInputError(OPERATION, { cause }, [
        {
          path: ["path"],
          reason: "invalid_value",
          message: `Selected ELF image could not be read (${String(cause.code)}): ${input.path}.`,
        },
      ]);
  }
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
