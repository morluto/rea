import {
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
import type { KernelModulePort } from "../../ports/binaryDiagnostics/KernelModulePort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { fixedAllowanceOptions } from "../../domain/fixedAllowanceRemediation.js";
import {
  MAX_INSPECT_KERNEL_MODULE_ENTRIES,
  MAX_INSPECT_KERNEL_MODULE_FILE_BYTES,
  type InspectKernelModuleInput,
} from "../../domain/native/kernelModule.js";
import { err, ok } from "../../domain/result.js";
import { KERNEL_MODULE_PROVIDER } from "../../domain/investigationProviders.js";
import {
  BinaryResourceFailure,
  binaryResourceCeiling,
} from "../../domain/binaryContainer.js";
import { parseKernelModuleFromHandle } from "./KernelModuleParser.js";

const OPERATION = "inspect_kernel_module";
const HEADER_PREFIX_BYTES = 4096;

/** Portable parser over one bounded, identity-checked regular file. */
export class KernelModuleProvider implements KernelModulePort {
  readonly identity = KERNEL_MODULE_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        KERNEL_MODULE_PROVIDER.id,
        OPERATION,
      );
    }
  }

  async inspect(input: InspectKernelModuleInput, options?: ExecutionOptions) {
    let observed:
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
              observed = identity;
            },
          },
          (handle) =>
            parseKernelModuleFromHandle(
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
              options?.signal,
            ),
        );
        return ok(result);
      });
    } catch (cause) {
      return err(kernelModuleFailure(cause, input, observed));
    }
  }
}

const inputBudgetRemediation = (
  boundary: "file-size" | "capacity",
  input: InspectKernelModuleInput,
): string =>
  boundary === "file-size"
    ? input.max_file_bytes >= MAX_INSPECT_KERNEL_MODULE_FILE_BYTES
      ? `The image exceeds the ${String(MAX_INSPECT_KERNEL_MODULE_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller artifact.`
      : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`
    : input.max_entries >= MAX_INSPECT_KERNEL_MODULE_ENTRIES
      ? `The image exceeds the ${String(MAX_INSPECT_KERNEL_MODULE_ENTRIES)}-entry kernel-module ceiling this operation accepts; select a smaller artifact.`
      : `Raise max_entries above ${String(input.max_entries)} or select a smaller artifact; the limit is the caller-selected .modinfo and __versions entry budget.`;

const kernelModuleFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectKernelModuleInput,
) => {
  const { cause, origin } = facts;
  if (origin === "owned-or-classified" && cause instanceof AnalysisError)
    return cause;
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
    if (cause.reason === "limit") {
      // Caller-selected read and entry budgets name the bound to raise; a
      // memory limit keeps only a ceiling its reader named.
      const textBudget = cause.boundary === "memory";
      return new AnalysisResourceConstraintError(
        OPERATION,
        cause.boundary ?? "memory",
        cause.message,
        {
          max_file_bytes: input.max_file_bytes,
          max_entries: input.max_entries,
        },
        {
          cause,
          ...(cause.boundary === undefined
            ? {}
            : textBudget
              ? cause.fixedAllowance === undefined
                ? {}
                : {
                    retryable: false as const,
                    fixedAllowance: cause.fixedAllowance,
                  }
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
      return stableArtifactInputFailure(cause, OPERATION);
  }
  const fileFailure = projectSelectedArtifactFileFailure(
    cause,
    OPERATION,
    input.path,
    "kernel module",
  );
  if (fileFailure !== undefined) return fileFailure;
  return new ArtifactOperationError(
    OPERATION,
    origin === "owned-or-classified" && cause instanceof ArtifactReaderFailure
      ? cause.reason
      : "io",
    undefined,
    cause instanceof Error ? cause.message : "Kernel module inspection failed.",
    { cause },
  );
};

const kernelModuleFailure = (
  cause: unknown,
  input: InspectKernelModuleInput,
  observed?: { readonly sha256: string; readonly bytes: number },
) => {
  const primary = kernelModuleFailurePrimary(
    artifactFilePrimaryFacts(cause),
    input,
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    KERNEL_MODULE_PROVIDER.id,
    OPERATION,
    observed,
  );
};
