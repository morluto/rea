import {
  projectStableArtifactFailure,
  projectArtifactCloseFailure,
} from "../../artifacts/StableArtifactFailure.js";
import { isSelectedRegularFileError } from "../../filesystem/RegularFile.js";
import {
  ArtifactReaderFailure,
  selectedPathRefusal,
} from "../../artifacts/ArtifactReader.js";
import { readStableArtifact } from "../../artifacts/readStableArtifact.js";
import {
  artifactFilePrimaryFacts,
  type ArtifactFilePrimaryFacts,
  artifactFileCancellationCause,
} from "../../artifacts/ArtifactFileOperation.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import type { KernelBuildConfigPort } from "../../application/binaryDiagnostics/KernelBuildConfigPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
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

const inputBudgetRemediation = (
  boundary: "file-size" | "capacity",
  input: InspectKernelBuildConfigInput,
  cause: ArtifactReaderFailure,
): string => {
  if (boundary === "file-size")
    return input.max_file_bytes >= MAX_INSPECT_KERNEL_BUILD_CONFIG_FILE_BYTES
      ? `The image exceeds the ${String(MAX_INSPECT_KERNEL_BUILD_CONFIG_FILE_BYTES)}-byte input ceiling this operation accepts; select a smaller artifact.`
      : `Raise max_file_bytes above ${String(input.max_file_bytes)} bytes or select a smaller artifact; the limit is the caller-selected input read budget.`;
  const knob =
    cause instanceof KernelBuildConfigBudgetFailure ? cause.knob : null;
  if (knob === "max_entries")
    return ceiling(
      knob,
      MAX_INSPECT_KERNEL_BUILD_CONFIG_ENTRIES,
      input.max_entries,
      "CONFIG_* entry budget",
    );
  if (knob === "max_config_bytes")
    return ceiling(
      knob,
      MAX_INSPECT_KERNEL_BUILD_CONFIG_CONFIG_BYTES,
      input.max_config_bytes,
      "inflated IKCFG gzip budget",
    );
  if (knob === "max_payload_bytes")
    return ceiling(
      knob,
      MAX_INSPECT_KERNEL_BUILD_CONFIG_PAYLOAD_BYTES,
      input.max_payload_bytes,
      "inflated bzImage payload budget",
    );
  return "Select a smaller artifact. The caller-selected kernel build config budgets refused this image.";
};

const kernelBuildConfigFailurePrimary = (
  facts: ArtifactFilePrimaryFacts,
  input: InspectKernelBuildConfigInput,
) => {
  const { cause, origin } = facts;
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
      return new AnalysisResourceConstraintError(
        OPERATION,
        cause.boundary ?? "memory",
        cause.message,
        {
          max_file_bytes: input.max_file_bytes,
          max_entries: input.max_entries,
          max_config_bytes: input.max_config_bytes,
          max_payload_bytes: input.max_payload_bytes,
        },
        {
          cause,
          ...(cause.boundary !== "capacity" && cause.boundary !== "file-size"
            ? {}
            : {
                retryable: false as const,
                remediationAction: inputBudgetRemediation(
                  cause.boundary,
                  input,
                  cause,
                ),
              }),
        },
      );
    }
    if (cause.reason === "path" || cause.reason === "format")
      return new AnalysisInputError(OPERATION, selectedPathRefusal(cause), [
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
          message: `Selected kernel image could not be read (${String(cause.code)}): ${input.path}.`,
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
