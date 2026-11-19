import {
  isParseLimit,
  parseFailureAnalysisError,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import {
  projectOwnedArtifactIdentityFailure,
  projectSelectedArtifactFileFailure,
  projectStableArtifactFailure,
  stableArtifactInputFailure,
  projectArtifactCloseFailure,
  ArtifactReaderFailure,
  readStableArtifact,
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { ElfUnwindRangesPort } from "../../ports/binaryDiagnostics/ElfUnwindRangesPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  MAX_INSPECT_ELF_UNWIND_FILE_BYTES,
  MAX_INSPECT_ELF_UNWIND_RANGES,
  type InspectElfUnwindRangesInput,
} from "../../domain/native/elfUnwindRanges.js";
import { err, ok } from "../../domain/result.js";
import { ELF_UNWIND_RANGES_PROVIDER } from "../../domain/investigationProviders.js";
import {
  BinaryResourceFailure,
  binaryResourceCeiling,
} from "../../domain/binaryContainer.js";
import {
  ELF_UNWIND_FORMAT,
  ELF_UNWIND_RECORD_LIMIT,
  parseElfUnwindRanges,
} from "./ElfUnwindTables.js";

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

const fileBudgetRemediation = (maximum: number): string =>
  maximum >= MAX_INSPECT_ELF_UNWIND_FILE_BYTES
    ? `The image exceeds the ${String(MAX_INSPECT_ELF_UNWIND_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller artifact.`
    : `Raise max_file_bytes above ${String(maximum)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`;

const recordBudgetRemediation = (maximum: number): string =>
  maximum >= MAX_INSPECT_ELF_UNWIND_RANGES
    ? `The image exceeds the ${String(MAX_INSPECT_ELF_UNWIND_RANGES)}-record unwind ceiling this operation accepts; select a smaller artifact.`
    : `Raise max_ranges above ${String(maximum)} or select a smaller artifact; the limit is the caller-selected unwind record budget.`;

const elfUnwindFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectElfUnwindRangesInput,
) => {
  const { cause, origin } = facts;
  if (isParseLimit(cause, ELF_UNWIND_FORMAT)) {
    const { detail, limit } = cause.failure;
    const records = limit.name === ELF_UNWIND_RECORD_LIMIT;
    return new AnalysisResourceConstraintError(
      OPERATION,
      "capacity",
      detail,
      records
        ? { max_file_bytes: input.max_file_bytes, max_ranges: limit.maximum }
        : { limit: input.limit, maximum_bytes: limit.maximum },
      {
        cause,
        retryable: false,
        remediationAction: records
          ? recordBudgetRemediation(limit.maximum)
          : `Request a smaller limit than ${String(input.limit)}, or page with offset; the ${String(limit.maximum)}-byte symbol-name text allowance is fixed, and max_ranges and max_file_bytes do not raise it.`,
      },
    );
  }
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
    if (cause.reason === "limit" && cause.boundary === "file-size")
      return new AnalysisResourceConstraintError(
        OPERATION,
        "file-size",
        cause.message,
        {
          max_file_bytes: input.max_file_bytes,
          max_ranges: input.max_ranges,
        },
        {
          cause,
          retryable: false,
          remediationAction: fileBudgetRemediation(input.max_file_bytes),
        },
      );
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
