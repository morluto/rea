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
  withStableArtifactHandle,
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { ElfUnwindRangesPort } from "../../ports/binaryDiagnostics/ElfUnwindRangesPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
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
  parseElfUnwindRangesFromHandle,
} from "./ElfUnwindTables.js";

const OPERATION = "inspect_elf_unwind_ranges";
const HEADER_PREFIX_BYTES = 4096;

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
    const signal = options?.signal;
    let snapshot:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () => {
        const report = await withStableArtifactHandle(
          input.path,
          input.max_file_bytes,
          {
            signal,
            resourceScope: this.#resources,
            retainBytes: (size) => Math.min(size, HEADER_PREFIX_BYTES),
            onIdentity: (identity) => {
              snapshot = identity;
            },
          },
          (handle) =>
            parseElfUnwindRangesFromHandle(
              {
                size: handle.size,
                prefix: handle.prefix,
                readRange: (offset, length) => handle.readRange(offset, length),
              },
              { path: input.path, sha256: handle.sha256, bytes: handle.size },
              input,
              signal,
            ),
        );
        return ok(report);
      });
    } catch (cause) {
      return err(elfUnwindFailure(cause, input, snapshot));
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
  if (origin === "owned-or-classified" && cause instanceof AnalysisError)
    return cause;
  if (isParseLimit(cause, ELF_UNWIND_FORMAT)) {
    const { limit } = cause.failure;
    const records = limit.name === ELF_UNWIND_RECORD_LIMIT;
    return parseLimitConstraint(OPERATION, "capacity", cause, {
      legacyMaximumKey: records ? "max_ranges" : "maximum_bytes",
      reportedLimitContext: records
        ? { max_file_bytes: input.max_file_bytes }
        : { limit: input.limit },
      retryable: false,
      remediationAction: records
        ? recordBudgetRemediation(limit.maximum)
        : `Request a smaller limit than ${String(input.limit)}, or page with offset; the ${String(limit.maximum)}-byte symbol-name text allowance is fixed, and max_ranges and max_file_bytes do not raise it.`,
    });
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
  snapshot?: { readonly sha256: string; readonly bytes: number },
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
    snapshot,
  );
};
