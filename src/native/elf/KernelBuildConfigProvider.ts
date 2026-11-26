import {
  projectStableArtifactFailure,
  closeArtifactResources,
  ArtifactReaderFailure,
  withStableArtifactHandle,
  artifactFilePrimaryFacts,
  ArtifactResourceScope,
} from "../../resources/index.js";
import type { KernelBuildConfigPort } from "../../ports/binaryDiagnostics/KernelBuildConfigPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { classifyProviderFailure } from "../../providers/classifyProviderFailure.js";
import { offlineArtifactFailureDialect } from "../../providers/offlineArtifactFailure.js";
import {
  kernelBuildConfigBudgetLimit,
  type InspectKernelBuildConfigInput,
  type KernelBuildConfig,
} from "../../domain/native/kernelBuildConfig.js";
import { parseLimitConstraint } from "../../domain/parseFailureAnalysisError.js";
import { err, ok } from "../../domain/result.js";
import { KERNEL_BUILD_CONFIG_PROVIDER } from "../../domain/investigationProviders.js";
import {
  KernelBuildConfigBudgetFailure,
  parseKernelBuildConfigFromHandle,
} from "./KernelBuildConfig.js";

const OPERATION = "inspect_kernel_build_config";
const HEADER_PREFIX_BYTES = 4096;

/** Portable parser over one bounded, identity-checked regular file. */
export class KernelBuildConfigProvider implements KernelBuildConfigPort {
  readonly identity = KERNEL_BUILD_CONFIG_PROVIDER;
  readonly #resources = new ArtifactResourceScope();

  close(): Promise<void> {
    return closeArtifactResources(
      () => this.#resources.close(),
      KERNEL_BUILD_CONFIG_PROVIDER,
      OPERATION,
    );
  }

  async inspect(
    input: InspectKernelBuildConfigInput,
    options?: ExecutionOptions,
  ) {
    let completed: KernelBuildConfig | undefined;
    let identity:
      | { readonly sha256: string; readonly bytes: number }
      | undefined;
    try {
      return await this.#resources.run(async () => {
        const report = await withStableArtifactHandle<KernelBuildConfig>(
          input.path,
          input.max_file_bytes,
          {
            signal: options?.signal,
            resourceScope: this.#resources,
            retainBytes: (size) => Math.min(size, HEADER_PREFIX_BYTES),
            onIdentity: (observed) => {
              identity = observed;
            },
            onVerifiedResult: (report) => {
              completed = report;
            },
          },
          (handle) =>
            parseKernelBuildConfigFromHandle(
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
        return ok(report);
      });
    } catch (cause) {
      return err(kernelBuildConfigFailure(cause, input, identity, completed));
    }
  }
}

const reportedBudgetContext = (input: InspectKernelBuildConfigInput) => ({
  max_file_bytes: input.max_file_bytes,
  max_entries: input.max_entries,
  max_config_bytes: input.max_config_bytes,
  max_payload_bytes: input.max_payload_bytes,
});

const kernelBuildConfigFailure = (
  cause: unknown,
  input: InspectKernelBuildConfigInput,
  identity: { readonly sha256: string; readonly bytes: number } | undefined,
  completed: KernelBuildConfig | undefined,
) => {
  const facts = artifactFilePrimaryFacts(cause);
  const primary = classifyProviderFailure(
    facts.cause,
    offlineArtifactFailureDialect(facts, {
      providerId: KERNEL_BUILD_CONFIG_PROVIDER.id,
      operation: OPERATION,
      path: input.path,
      description: "kernel image",
      fallbackMessage: "Kernel build config inspection failed.",
      recognise: (failure, origin) => {
        if (
          origin === "owned-or-classified" &&
          failure instanceof KernelBuildConfigBudgetFailure
        ) {
          const { limit } = failure.failure;
          return parseLimitConstraint(
            OPERATION,
            limit.name === "compressed_candidate_bytes" ? "memory" : "capacity",
            failure,
            {
              reportedLimitContext: {
                ...reportedBudgetContext(input),
                [limit.name]: limit.maximum,
              },
              retryable: false,
              // The compressed candidate allowance is derived from max_config_bytes.
              limit:
                limit.name === "compressed_candidate_bytes"
                  ? kernelBuildConfigBudgetLimit(
                      "max_config_bytes",
                      input.max_config_bytes,
                    )
                  : kernelBuildConfigBudgetLimit(limit.name, limit.maximum),
            },
          );
        }
        if (
          origin === "owned-or-classified" &&
          failure instanceof ArtifactReaderFailure &&
          failure.reason === "limit"
        ) {
          return new AnalysisResourceConstraintError(
            OPERATION,
            failure.boundary ?? "memory",
            failure.message,
            reportedBudgetContext(input),
            {
              cause: failure,
              ...(failure.boundary !== "capacity" &&
              failure.boundary !== "file-size"
                ? {}
                : {
                    retryable: false as const,
                    limit: kernelBuildConfigBudgetLimit(
                      "max_file_bytes",
                      input.max_file_bytes,
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
    KERNEL_BUILD_CONFIG_PROVIDER.id,
    OPERATION,
    identity,
  );
};
