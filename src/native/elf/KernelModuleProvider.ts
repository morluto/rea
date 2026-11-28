import {
  projectStableArtifactFailure,
  closeArtifactResources,
  ArtifactReaderFailure,
  withStableArtifactHandle,
  artifactFilePrimaryFacts,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { KernelModulePort } from "../../ports/binaryDiagnostics/KernelModulePort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";
import {
  KERNEL_MODULE_READ_BUDGETS,
  type InspectKernelModuleInput,
  type KernelModule,
} from "../../domain/native/kernelModule.js";
import { elfReadBudgetLimit } from "../../domain/native/elfReadBudgets.js";
import { err, ok } from "../../domain/result.js";
import { KERNEL_MODULE_PROVIDER } from "../../domain/investigationProviders.js";
import { isNativeStructureFailure } from "../../domain/binaryContainer.js";
import { nativeStructureConstraint } from "../../domain/native/nativeStructureBudget.js";
import { parseKernelModuleFromHandle } from "./KernelModuleParser.js";

const OPERATION = "inspect_kernel_module";
const HEADER_PREFIX_BYTES = 4096;

/** Portable parser over one bounded, identity-checked regular file. */
export class KernelModuleProvider implements KernelModulePort {
  readonly identity = KERNEL_MODULE_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      KERNEL_MODULE_PROVIDER,
      OPERATION,
    );
  }

  async inspect(input: InspectKernelModuleInput, options?: ExecutionOptions) {
    let completed: KernelModule | undefined;
    let observed:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () => {
        const result = await withStableArtifactHandle<KernelModule>(
          input.path,
          input.max_file_bytes,
          {
            signal: options?.signal,
            resourceScope: this.#resources,
            retainBytes: (size) => Math.min(size, HEADER_PREFIX_BYTES),
            onIdentity: (identity) => {
              observed = identity;
            },
            onVerifiedResult: (report) => {
              completed = report;
            },
          },
          (handle) =>
            parseKernelModuleFromHandle(
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
        return ok(result);
      });
    } catch (cause) {
      return err(kernelModuleFailure(cause, input, observed, completed));
    }
  }
}

const kernelModuleFailure = (
  cause: unknown,
  input: InspectKernelModuleInput,
  observed: { readonly sha256: string; readonly bytes: number } | undefined,
  completed: KernelModule | undefined,
) => {
  const facts = artifactFilePrimaryFacts(cause);
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: KERNEL_MODULE_PROVIDER.id,
      operation: OPERATION,
      path: input.path,
      description: "kernel module",
      fallbackMessage: "Kernel module inspection failed.",
      recognise: (failure, origin) => {
        if (isNativeStructureFailure(failure))
          return nativeStructureConstraint(OPERATION, failure);
        if (
          origin === "owned-or-classified" &&
          failure instanceof ArtifactReaderFailure &&
          failure.reason === "limit"
        ) {
          // Caller-selected read and entry budgets name the bound to raise; a
          // memory limit keeps only a ceiling its reader named.
          const textBudget = failure.boundary === "memory";
          return new AnalysisResourceConstraintError(
            OPERATION,
            failure.boundary ?? "memory",
            failure.message,
            {
              max_file_bytes: input.max_file_bytes,
              max_entries: input.max_entries,
            },
            {
              cause: failure,
              ...(failure.boundary === undefined
                ? {}
                : textBudget
                  ? failure.fixedAllowance === undefined
                    ? {}
                    : {
                        retryable: false as const,
                        fixedAllowance: failure.fixedAllowance,
                      }
                  : {
                      retryable: false as const,
                      limit: elfReadBudgetLimit(
                        KERNEL_MODULE_READ_BUDGETS,
                        failure.boundary === "file-size"
                          ? "max_file_bytes"
                          : "max_entries",
                        failure.boundary === "file-size"
                          ? input.max_file_bytes
                          : input.max_entries,
                        failure.boundary === "file-size" &&
                          failure.observedBytes !== undefined &&
                          failure.observedBytes <=
                            BigInt(Number.MAX_SAFE_INTEGER)
                          ? failure.observedBytes
                          : undefined,
                      ),
                    }),
            },
          );
        }
        return undefined;
      },
    }),
  );
  if (completed !== undefined) primary.retainPartialObservation(completed);
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    KERNEL_MODULE_PROVIDER.id,
    OPERATION,
    observed,
  );
};
