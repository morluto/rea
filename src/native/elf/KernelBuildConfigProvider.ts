import {
  projectStableArtifactFailure,
  projectArtifactCloseFailure,
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
  MAX_INSPECT_KERNEL_BUILD_CONFIG_CONFIG_BYTES,
  MAX_INSPECT_KERNEL_BUILD_CONFIG_ENTRIES,
  MAX_INSPECT_KERNEL_BUILD_CONFIG_FILE_BYTES,
  MAX_INSPECT_KERNEL_BUILD_CONFIG_PAYLOAD_BYTES,
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

  async close(): Promise<void> {
    try {
      await this.#resources.close();
    } catch (cause: unknown) {
      throw projectArtifactCloseFailure(
        cause,
        KERNEL_BUILD_CONFIG_PROVIDER.id,
        OPERATION,
      );
    }
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
        return ok(report);
      });
    } catch (cause) {
      return err(kernelBuildConfigFailure(cause, input, identity, completed));
    }
  }
}

const ceiling = (
  knob: string,
  maximum: number,
  selected: number,
  description: string,
): string =>
  selected >= maximum
    ? `The image exceeds the ${String(maximum)} ${knob} ceiling this operation accepts; select a smaller artifact.`
    : `Raise ${knob} above ${String(selected)} or select a smaller artifact; the limit is the caller-selected ${description}.`;

const fileSizeRemediation = (input: InspectKernelBuildConfigInput): string =>
  input.max_file_bytes >= MAX_INSPECT_KERNEL_BUILD_CONFIG_FILE_BYTES
    ? `The image exceeds the ${String(MAX_INSPECT_KERNEL_BUILD_CONFIG_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller artifact.`
    : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`;

const parserBudgetRemediation = ({
  name,
  maximum,
}: KernelBuildConfigBudgetFailure["failure"]["limit"]): string => {
  switch (name) {
    case "max_entries":
      return ceiling(
        name,
        MAX_INSPECT_KERNEL_BUILD_CONFIG_ENTRIES,
        maximum,
        "CONFIG_* entry budget",
      );
    case "max_config_bytes":
      return ceiling(
        name,
        MAX_INSPECT_KERNEL_BUILD_CONFIG_CONFIG_BYTES,
        maximum,
        "inflated IKCFG gzip budget",
      );
    case "compressed_candidate_bytes":
      return "Select an image with a smaller compressed IKCFG member. Increasing max_config_bytes can raise the compressed candidate allowance when the inflated-config budget is below its maximum.";
    case "max_payload_bytes":
      return ceiling(
        name,
        MAX_INSPECT_KERNEL_BUILD_CONFIG_PAYLOAD_BYTES,
        maximum,
        "inflated bzImage payload budget",
      );
  }
};

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
              remediationAction: parserBudgetRemediation(limit),
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
                    remediationAction:
                      failure.boundary === "file-size"
                        ? fileSizeRemediation(input)
                        : "Select a smaller artifact. The caller-selected kernel build config budgets refused this image.",
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
