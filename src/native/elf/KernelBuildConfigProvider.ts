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
import type { KernelBuildConfigPort } from "../../ports/binaryDiagnostics/KernelBuildConfigPort.js";
import type { ExecutionOptions } from "../../ports/AnalysisProvider.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import {
  MAX_INSPECT_KERNEL_BUILD_CONFIG_CONFIG_BYTES,
  MAX_INSPECT_KERNEL_BUILD_CONFIG_ENTRIES,
  MAX_INSPECT_KERNEL_BUILD_CONFIG_FILE_BYTES,
  MAX_INSPECT_KERNEL_BUILD_CONFIG_PAYLOAD_BYTES,
  type InspectKernelBuildConfigInput,
} from "../../domain/native/kernelBuildConfig.js";
import { parseLimitConstraint } from "../../domain/parseFailureAnalysisError.js";
import { err, ok } from "../../domain/result.js";
import { KERNEL_BUILD_CONFIG_PROVIDER } from "../../domain/investigationProviders.js";
import {
  KernelBuildConfigBudgetFailure,
  parseKernelBuildConfig,
} from "./KernelBuildConfig.js";

const OPERATION = "inspect_kernel_build_config";

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
          await parseKernelBuildConfig(
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
      return err(kernelBuildConfigFailure(cause, input));
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

const kernelBuildConfigFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectKernelBuildConfigInput,
) => {
  const { cause, origin } = facts;
  const identityFailure = projectOwnedArtifactIdentityFailure(
    facts,
    OPERATION,
    input.path,
  );
  if (identityFailure !== undefined) return identityFailure;
  if (
    origin === "owned-or-classified" &&
    cause instanceof KernelBuildConfigBudgetFailure
  ) {
    const { limit } = cause.failure;
    return parseLimitConstraint(OPERATION, "capacity", cause, {
      reportedLimitContext: {
        ...reportedBudgetContext(input),
        [limit.name]: limit.maximum,
      },
      retryable: false,
      remediationAction: parserBudgetRemediation(limit),
    });
  }
  if (
    origin === "owned-or-classified" &&
    cause instanceof ArtifactReaderFailure
  ) {
    if (cause.reason === "limit") {
      return new AnalysisResourceConstraintError(
        OPERATION,
        cause.boundary ?? "memory",
        cause.message,
        reportedBudgetContext(input),
        {
          cause,
          ...(cause.boundary !== "capacity" && cause.boundary !== "file-size"
            ? {}
            : {
                retryable: false as const,
                remediationAction:
                  cause.boundary === "file-size"
                    ? fileSizeRemediation(input)
                    : "Select a smaller artifact. The caller-selected kernel build config budgets refused this image.",
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
    "kernel image",
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
      : "Kernel build config inspection failed.",
    { cause },
  );
};

const kernelBuildConfigFailure = (
  cause: unknown,
  input: InspectKernelBuildConfigInput,
) => {
  const primary = kernelBuildConfigFailurePrimary(
    artifactFilePrimaryFacts(cause),
    input,
  );
  return projectStableArtifactFailure(
    cause,
    primary,
    input.path,
    KERNEL_BUILD_CONFIG_PROVIDER.id,
    OPERATION,
  );
};
