import { analysisSettingLimit } from "../domain/analysisSettingDefinitions.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { stableArtifactInputRecovery } from "../artifacts/StableArtifactFailure.js";
import {
  artifactFileCancellationCause,
  artifactFilePrimaryFacts,
  bindArtifactFileCleanup,
} from "../artifacts/ArtifactFileOperation.js";
import { utf8HeadExcerpt } from "../domain/utf8HeadExcerpt.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";
import {
  AnalysisError,
  type AnalysisCapturedOutput,
} from "../domain/analysisErrorBase.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  AnalysisCancelledError,
  AnalysisArtifactChangedError,
  AnalysisAccessDeniedError,
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  AnalysisCapabilityUnavailableError,
} from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import {
  RuntimeControlUnavailableError,
  runtimeControlCapabilityError,
} from "../process/RuntimeControlUnavailableError.js";
import { WabtAdmissionError } from "./WabtAdmissionError.js";
import {
  DEFAULT_WASM_COMMAND_TIMEOUT_MS,
  WABT_VERSION,
  MAX_WASM_COMMAND_TIMEOUT_MS,
  WASM_RESOURCE_DEFAULTS,
  WASM_RESOURCE_MAXIMUMS,
  type WasmResourceLimits,
} from "../domain/wasm/wasmArtifact.js";
import { WABT_ACCEPTED_RANGE, WABT_PROVIDER_IDENTITY } from "./WabtRelease.js";
const OUTPUT_LIMIT_EXCERPT_BYTES = 4096;

/** Recovery names the exhausted per-call byte owner, independently of deadlines. */
const byteBudgetRecovery = (
  parameter: "max_input_bytes" | "max_output_bytes" | "max_tool_bytes",
  value: number,
  maximum: number,
): string =>
  `${parameter} is ${String(value)} bytes. ${value < maximum ? `Raise ${parameter} above ${String(value)} bytes (positive integer, maximum ${String(maximum)}), or use --${parameter.replaceAll("_", "-")} on the CLI, then retry the same complete input after cleanup settles.` : `This is already the runtime representation maximum of ${String(maximum)} bytes; use a suitable smaller complete input or report this blocker.`} The new value applies to the next inspection without restarting REA. command_timeout_ms, other byte budgets and client delivery settings do not raise this allowance. Do not truncate required bytes. Repeating the unchanged request fails the same way.`;

/** Facts owned before dispatch, even when a version command does not return successfully. */
export type WabtVersionProbe = {
  readonly configuration_key: "REA_WABT_BIN_DIRECTORY";
  readonly executable_path: string;
  readonly tool: string;
  readonly expected_version: typeof WABT_VERSION;
  readonly accepted_releases: string;
};

type WabtFailureContext = {
  readonly commandTimeoutMs: number;
  readonly commandTimeoutSource?:
    | "default"
    | "setting"
    | "runtime"
    | "request"
    | undefined;
  readonly limits?: WasmResourceLimits;
  readonly versionProbe?: WabtVersionProbe;
  readonly inputField?: readonly (string | number)[];
  readonly observedOutput?: AnalysisCapturedOutput | undefined;
};

/** Configuration is captured by the server; fixing files and changing its environment are distinct repairs. */
export const wabtConfigurationRecoveryAction = (cause?: unknown): string => {
  const code =
    cause instanceof Error && "code" in cause ? cause.code : undefined;
  const action =
    code === "EACCES" || code === "EPERM"
      ? "Check this REA process has read and execute access to the reported caller-supplied tools, or select an accessible trusted copy. "
      : code === "ENOTDIR"
        ? "Select the tools' containing directory, not an individual executable. "
        : code === "ENOENT"
          ? "The reported configured tool is missing. "
          : "";
  return `${action}Set absolute REA_WABT_BIN_DIRECTORY to a directory that contains wasm-validate, wasm-objdump and wasm2wat from one WABT installation; each --version must report ${WABT_ACCEPTED_RANGE} on stdout with empty stderr. Releases in that range other than ${WABT_VERSION} are admitted and reported as the observed banner. Correct the reported tool path, access or release before retrying, not the WASM input. Set this in the shell for the next CLI call, or in the MCP server launch environment and restart that server; a shell export does not update a running MCP server. Do not repeat the unchanged call or install tools implicitly.`;
};
/** Past the output budget, retained text is a prefix of an oversized stream; keep a bounded excerpt of each. */
const outputLimitExcerpt = (snapshot: ProviderProcessSnapshot) => ({
  stdout: utf8HeadExcerpt(snapshot.stdout.text, OUTPUT_LIMIT_EXCERPT_BYTES)
    .text,
  stderr: utf8HeadExcerpt(snapshot.stderr.text, OUTPUT_LIMIT_EXCERPT_BYTES)
    .text,
  // The command reports output-limit only after retention was truncated.
  truncated: true,
  stdout_bytes: snapshot.stdout.bytes,
  stderr_bytes: snapshot.stderr.bytes,
  exit_code: snapshot.exitCode ?? null,
  signal: snapshot.signal ?? null,
});
/** Preserve lifecycle failures and diagnostic bytes instead of returning partial success. */
export const wabtFailure = (
  cause: unknown,
  phase: "configuration" | "artifact" | "producer",
  path: string,
  execution?: WabtFailureContext,
): AnalysisError => {
  const failure = classifyWabtFailure(cause, phase, path, execution);
  bindArtifactFileCleanup(cause, failure);
  return failure;
};

const classifyWabtFailure = (
  cause: unknown,
  phase: "configuration" | "artifact" | "producer",
  path: string,
  execution: WabtFailureContext | undefined,
): AnalysisError => {
  const versionProbe = execution?.versionProbe;
  const limits = execution?.limits ?? WASM_RESOURCE_DEFAULTS;
  const outputLimitReason = `WABT output exceeded the ${String(limits.outputBytes)}-byte output budget`;
  if (cause instanceof AnalysisError) return cause;
  const artifactCleanup =
    cause instanceof ArtifactReaderFailure ? cause.cleanup : undefined;
  const artifactOptions = {
    ...(artifactCleanup === undefined ? {} : { cleanup: artifactCleanup }),
    ...(execution?.observedOutput === undefined
      ? {}
      : { capturedOutput: execution.observedOutput }),
  };
  const reason = cause instanceof Error ? cause.message : String(cause);
  const physical = artifactFilePrimaryFacts(cause).cause;
  if (
    physical instanceof Error &&
    (("code" in physical &&
      [
        "ENOMEM",
        "ERR_MEMORY_ALLOCATION_FAILED",
        "ERR_BUFFER_TOO_LARGE",
      ].includes(String(physical.code))) ||
      (physical instanceof RangeError &&
        physical.message === "Array buffer allocation failed"))
  )
    return new AnalysisResourceConstraintError(
      "inspect_wasm_artifact",
      "memory",
      "The host could not allocate the admitted WABT acquisition buffer",
      { max_input_bytes: limits.inputBytes, max_tool_bytes: limits.toolBytes },
      {
        cause,
        ...artifactOptions,
        retryable: false,
        remediationAction:
          "Byte admission does not reserve host memory. Free host memory or select a suitable process with sufficient capacity, then retry after cleanup settles. Increasing byte budgets or command_timeout_ms does not repair this allocation failure; do not replace a correctly configured WABT installation for this reason.",
      },
    );
  if (
    (cause instanceof ArtifactReaderFailure && cause.reason === "cancelled") ||
    (cause instanceof Error && cause.name === "AbortError")
  )
    return new AnalysisCancelledError("inspect_wasm_artifact", {
      cause:
        cause instanceof ArtifactReaderFailure
          ? artifactFileCancellationCause(cause)
          : cause,
      ...artifactOptions,
    });
  if (cause instanceof OwnedCommandFailure) {
    const capturedOutput =
      cause.snapshot === null
        ? undefined
        : cause.reason === "output-limit"
          ? outputLimitExcerpt(cause.snapshot)
          : {
              stdout: cause.snapshot.stdout.text,
              stderr: cause.snapshot.stderr.text,
              truncated: cause.snapshot.diagnosticTruncated ?? false,
            };
    const options = {
      cause,
      ...(capturedOutput === undefined ? {} : { capturedOutput }),
      ...(versionProbe === undefined ? {} : { diagnostics: versionProbe }),
    };
    // Classify once before cleanup takes precedence, so the primary remains actionable.
    const timeoutMs =
      execution?.commandTimeoutMs ?? DEFAULT_WASM_COMMAND_TIMEOUT_MS;
    const timeoutSource =
      execution?.commandTimeoutMs === undefined
        ? "default"
        : execution.commandTimeoutSource;
    const timeout =
      cause.reason === "timeout"
        ? new AnalysisTimeoutError("inspect_wasm_artifact", timeoutMs, {
            limit: analysisSettingLimit(
              "wasm.command_timeout_ms",
              timeoutMs,
              timeoutSource,
            ),
            ...options,
            // The cleanup wrapper retains output once; its nested primary needs only recovery facts.
            capturedOutput:
              cause.cleanupFailure === null ? capturedOutput : undefined,
            userMessage: `A WABT command reached its ${String(timeoutMs)} ms server/provider deadline (command_timeout_ms), not the whole-inspection or MCP client deadline.`,
            remediationAction: `${
              timeoutMs < MAX_WASM_COMMAND_TIMEOUT_MS
                ? `Increase command_timeout_ms above ${String(timeoutMs)} (integer milliseconds, maximum ${String(MAX_WASM_COMMAND_TIMEOUT_MS)}), or use rea inspect-wasm-artifact <path> --command-timeout-ms <milliseconds> on the CLI.`
                : `command_timeout_ms is already at the maximum supported ${String(MAX_WASM_COMMAND_TIMEOUT_MS)} ms; no higher command deadline is supported. Report this blocker or select another suitable complete artifact with caller approval.`
            } This is a per-call setting; no server restart is needed. Allow the MCP client deadline to cover all version/analysis commands, file checks, cleanup and delivery; increasing only that client deadline does not change this budget. max_input_bytes, max_tool_bytes and max_output_bytes are independent per-call controls; detail: summary reduces delivery size, not analysis work. Resolve any incomplete cleanup before retrying; do not repeat the unchanged failed call.`,
          })
        : undefined;
    if (cause.cleanupFailure !== null)
      return new ProviderCleanupError(
        WABT_PROVIDER_IDENTITY.id,
        cause.resources,
        {
          ...versionProbe,
          reason: cause.cleanupFailure,
          previous_error:
            timeout !== undefined
              ? projectAnalysisError(timeout)
              : cause.reason === "output-limit"
                ? {
                    failure_kind: "output-limit",
                    message: outputLimitReason,
                    max_output_bytes: limits.outputBytes,
                    remediation_action: byteBudgetRecovery(
                      "max_output_bytes",
                      limits.outputBytes,
                      WASM_RESOURCE_MAXIMUMS.outputBytes,
                    ),
                  }
                : reason,
          ...(capturedOutput === undefined
            ? {}
            : { captured_output: capturedOutput }),
        },
        { operation: "inspect_wasm_artifact", cause },
      );
    if (cause.reason === "cancelled")
      return new AnalysisCancelledError("inspect_wasm_artifact", {
        ...options,
        cause:
          cause.cancellation === undefined ? cause : cause.cancellation.reason,
      });
    if (timeout !== undefined) return timeout;
    if (cause.reason === "output-limit")
      return new AnalysisResourceConstraintError(
        "inspect_wasm_artifact",
        "memory",
        outputLimitReason,
        { max_output_bytes: limits.outputBytes },
        {
          ...options,
          retryable: false,
          remediationAction: byteBudgetRecovery(
            "max_output_bytes",
            limits.outputBytes,
            WASM_RESOURCE_MAXIMUMS.outputBytes,
          ),
        },
      );
    if (phase === "configuration" && cause.reason === "process")
      return new AnalysisCapabilityUnavailableError(
        WABT_PROVIDER_IDENTITY.id,
        "inspect_wasm_artifact",
        reason,
        {
          ...options,
          userMessage: `Configured WABT could not start. Check executable/interpreter access and WABT ${WABT_VERSION} profile; inspect retained diagnostics.`,
          remediationAction: wabtConfigurationRecoveryAction(cause),
        },
      );
    return new AnalysisOutputError("inspect_wasm_artifact", reason, options);
  }
  if (cause instanceof RuntimeControlUnavailableError)
    return runtimeControlCapabilityError(
      WABT_PROVIDER_IDENTITY.id,
      "inspect_wasm_artifact",
      cause,
    );
  if (
    phase === "configuration" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "limit" &&
    cause.boundary === "file-size"
  )
    return new AnalysisCapabilityUnavailableError(
      WABT_PROVIDER_IDENTITY.id,
      "inspect_wasm_artifact",
      cause.message,
      {
        cause,
        ...artifactOptions,
        userMessage: `Configured WABT tools exceed the ${String(limits.toolBytes)}-byte tool allowance (max_tool_bytes).`,
        remediationAction: byteBudgetRecovery(
          "max_tool_bytes",
          limits.toolBytes,
          WASM_RESOURCE_MAXIMUMS.toolBytes,
        ),
      },
    );
  if (phase === "configuration") {
    const admission = cause instanceof WabtAdmissionError ? cause : undefined;
    return new AnalysisCapabilityUnavailableError(
      WABT_PROVIDER_IDENTITY.id,
      "inspect_wasm_artifact",
      admission?.code ?? reason,
      {
        cause,
        ...artifactOptions,
        ...(admission === undefined
          ? {}
          : {
              diagnostics: {
                code: admission.code,
                ...admission.detail,
              },
            }),
        userMessage:
          admission === undefined
            ? reason
            : "WABT configuration cannot be used",
        remediationAction: wabtConfigurationRecoveryAction(cause),
      },
    );
  }
  if (
    phase === "artifact" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "limit" &&
    cause.boundary === "file-size"
  )
    return new AnalysisResourceConstraintError(
      "inspect_wasm_artifact",
      "file-size",
      reason,
      { maximum_input_bytes: limits.inputBytes },
      {
        cause,
        ...artifactOptions,
        retryable: false,
        remediationAction: byteBudgetRecovery(
          "max_input_bytes",
          limits.inputBytes,
          WASM_RESOURCE_MAXIMUMS.inputBytes,
        ),
      },
    );
  if (
    phase === "artifact" &&
    cause instanceof ArtifactReaderFailure &&
    cause.reason === "integrity"
  )
    return new AnalysisArtifactChangedError(
      "inspect_wasm_artifact",
      path,
      reason,
      { cause, ...artifactOptions },
    );
  if (
    phase === "artifact" &&
    cause instanceof Error &&
    "code" in cause &&
    (cause.code === "EACCES" || cause.code === "EPERM")
  )
    return new AnalysisAccessDeniedError(
      "inspect_wasm_artifact",
      path,
      cause.code,
      { cause, ...artifactOptions },
    );
  if (phase === "artifact")
    return new AnalysisInputError(
      "inspect_wasm_artifact",
      {
        cause,
        ...artifactOptions,
        ...(cause instanceof ArtifactReaderFailure
          ? stableArtifactInputRecovery(cause)
          : {}),
      },
      [
        {
          path: [...(execution?.inputField ?? ["path"])],
          reason: "invalid_value",
          message: reason,
        },
      ],
    );
  return new AnalysisOutputError("inspect_wasm_artifact", reason, {
    cause,
    ...artifactOptions,
  });
};
