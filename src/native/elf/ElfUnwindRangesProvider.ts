import {
  isParseLimit,
  parseLimitConstraint,
} from "../../domain/parseFailureAnalysisError.js";
import {
  projectStableArtifactFailure,
  closeArtifactResources,
  withStableArtifactHandle,
  artifactFilePrimaryFacts,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { ElfUnwindRangesPort } from "../../ports/binaryDiagnostics/ElfUnwindRangesPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";
import {
  elfUnwindBudgetLimit,
  type ElfUnwindRanges,
  type InspectElfUnwindRangesInput,
} from "../../domain/native/elfUnwindRanges.js";
import { err, ok } from "../../domain/result.js";
import { ELF_UNWIND_RANGES_PROVIDER } from "../../domain/investigationProviders.js";
import { isNativeStructureFailure } from "../../domain/binaryContainer.js";
import { nativeStructureConstraint } from "../../domain/native/nativeStructureBudget.js";
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

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      ELF_UNWIND_RANGES_PROVIDER,
      OPERATION,
    );
  }

  async inspect(
    input: InspectElfUnwindRangesInput,
    options?: ExecutionOptions,
  ) {
    const signal = options?.signal;
    let completed: ElfUnwindRanges | undefined;
    let snapshot:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () => {
        const report = await withStableArtifactHandle<ElfUnwindRanges>(
          input.path,
          input.max_file_bytes,
          {
            signal,
            resourceScope: this.#resources,
            retainBytes: (size) => Math.min(size, HEADER_PREFIX_BYTES),
            onIdentity: (identity) => {
              snapshot = identity;
            },
            onVerifiedResult: (value) => {
              completed = value;
            },
          },
          (handle) =>
            parseElfUnwindRangesFromHandle(
              handle,
              { path: input.path, sha256: handle.sha256, bytes: handle.size },
              input,
              signal,
            ),
        );
        return ok(report);
      });
    } catch (cause) {
      return err(elfUnwindFailure(cause, input, snapshot, completed));
    }
  }
}

const elfUnwindFailure = (
  cause: unknown,
  input: InspectElfUnwindRangesInput,
  snapshot?: { readonly sha256: string; readonly bytes: number },
  completed?: ElfUnwindRanges,
) => {
  const facts = artifactFilePrimaryFacts(cause);
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: ELF_UNWIND_RANGES_PROVIDER.id,
      operation: OPERATION,
      path: input.path,
      description: "ELF image",
      fallbackMessage: "ELF unwind inspection failed.",
      recognise: (failure) => {
        if (isParseLimit(failure, ELF_UNWIND_FORMAT)) {
          const { limit } = failure.failure;
          const records = limit.name === ELF_UNWIND_RECORD_LIMIT;
          return parseLimitConstraint(OPERATION, "capacity", failure, {
            legacyMaximumKey: records ? "max_ranges" : "maximum_bytes",
            reportedLimitContext: records
              ? { max_file_bytes: input.max_file_bytes }
              : { limit: input.limit },
            ...(records
              ? {
                  retryable: false,
                  limit: elfUnwindBudgetLimit("max_ranges", limit.maximum),
                }
              : fixedAllowanceOptions(
                  "The ELF unwind symbol-name text allowance",
                  "parser",
                  {
                    limit: limit.maximum,
                    unit: "bytes",
                    narrowing: `Request a smaller limit than ${String(input.limit)}, or page with offset; max_ranges and max_file_bytes do not raise it.`,
                  },
                )),
          });
        }
        if (isNativeStructureFailure(failure))
          return nativeStructureConstraint(OPERATION, failure);
        return undefined;
      },
      fileSize: (failure) =>
        new AnalysisResourceConstraintError(
          OPERATION,
          "file-size",
          failure.message,
          {
            max_file_bytes: input.max_file_bytes,
            max_ranges: input.max_ranges,
          },
          {
            cause: failure,
            retryable: false,
            limit: elfUnwindBudgetLimit("max_file_bytes", input.max_file_bytes),
          },
        ),
    }),
  );
  if (completed !== undefined) primary.retainPartialObservation(completed);
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    ELF_UNWIND_RANGES_PROVIDER.id,
    OPERATION,
    snapshot,
  );
};
