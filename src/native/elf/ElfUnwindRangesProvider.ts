import {
  projectStableArtifactFailure,
  stableArtifactInputRecovery,
  projectArtifactCloseFailure,
} from "../../artifacts/StableArtifactFailure.js";
import { isSelectedRegularFileError } from "../../filesystem/RegularFile.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import {
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  artifactFileCancellationCause,
} from "../../artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import type { ElfUnwindRangesPort } from "../../application/binaryDiagnostics/ElfUnwindRangesPort.js";
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
  MAX_INSPECT_ELF_UNWIND_FILE_BYTES,
  MAX_INSPECT_ELF_UNWIND_RANGES,
  type InspectElfUnwindRangesInput,
} from "../../domain/native/elfUnwindRanges.js";
import { err, ok } from "../../domain/result.js";
import { ELF_UNWIND_RANGES_PROVIDER } from "../../domain/investigationProviders.js";
import {
  BinaryFormatFailure,
  BinaryResourceFailure,
} from "../metadata/BinaryContainer.js";
import { parseElfUnwindRanges } from "./ElfUnwindTables.js";

const OPERATION = "inspect_elf_unwind_ranges";

/** Portable parser over one bounded, identity-checked regular file. */
export class ElfUnwindRangesProvider implements ElfUnwindRangesPort {
  readonly identity = ELF_UNWIND_RANGES_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        ELF_UNWIND_RANGES_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(
    input: InspectElfUnwindRangesInput,
    options?: ExecutionOptions,
  ) {
    try {
      return await this.#resources.run(async () => {
        const snapshot = await readStableArtifact(
          input.path,
          input.max_file_bytes,
          options?.signal,
          undefined,
          this.#resources,
        );
        return ok(
          parseElfUnwindRanges(
            snapshot.bytes,
            {
              path: input.path,
              sha256: snapshot.sha256,
              bytes: snapshot.bytes.length,
            },
            input,
            options?.signal,
          ),
        );
      });
    } catch (cause) {
      return err(elfUnwindFailure(cause, input));
    }
  }
}

const inputBudgetRemediation = (
  boundary: "file-size" | "capacity",
  input: InspectElfUnwindRangesInput,
): string =>
  boundary === "file-size"
    ? input.max_file_bytes >= MAX_INSPECT_ELF_UNWIND_FILE_BYTES
      ? `The image exceeds the ${String(MAX_INSPECT_ELF_UNWIND_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller artifact.`
      : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`
    : input.max_ranges >= MAX_INSPECT_ELF_UNWIND_RANGES
      ? `The image exceeds the ${String(MAX_INSPECT_ELF_UNWIND_RANGES)}-record unwind ceiling this operation accepts; select a smaller artifact.`
      : `Raise max_ranges above ${String(input.max_ranges)} or select a smaller artifact; the limit is the caller-selected unwind record budget.`;

const elfUnwindFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectElfUnwindRangesInput,
) => {
  const { cause, origin } = facts;
  if (cause instanceof BinaryResourceFailure)
    return new AnalysisResourceConstraintError(
      OPERATION,
      "memory",
      cause.message,
      { max_file_bytes: input.max_file_bytes },
      {
        cause,
        ...fixedAllowanceOptions(
          "The 16 MiB ELF structural decoding budget",
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
      const structural = cause.boundary === "memory";
      return new AnalysisResourceConstraintError(
        OPERATION,
        cause.boundary ?? "memory",
        cause.message,
        {
          max_file_bytes: input.max_file_bytes,
          max_ranges: input.max_ranges,
        },
        {
          cause,
          ...(cause.boundary === undefined
            ? {}
            : structural
              ? fixedAllowanceOptions(
                  "The ELF unwind structural decoding budget",
                  "parser",
                )
              : {
                  retryable: false as const,
                  remediationAction: inputBudgetRemediation(
                    cause.boundary,
                    input,
                  ),
                }),
        },
      );
    }
    if (cause.reason === "path" || cause.reason === "format")
      return new AnalysisInputError(
        OPERATION,
        { cause, ...stableArtifactInputRecovery(cause) },
        [
          {
            path: ["path"],
            reason: "invalid_format",
            message: cause.message,
          },
        ],
      );
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
    cause instanceof Error ? cause.message : "ELF unwind inspection failed.",
    { cause },
  );
};

const elfUnwindFailure = (
  cause: unknown,
  input: InspectElfUnwindRangesInput,
) => {
  const primary = elfUnwindFailurePrimary(
    artifactFilePrimaryFacts(cause),
    input,
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    ELF_UNWIND_RANGES_PROVIDER.id,
    OPERATION,
  );
};
