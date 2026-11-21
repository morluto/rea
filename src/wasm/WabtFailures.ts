import { MAX_NODE_TIMER_DELAY_MS } from "../domain/analysisResourceLimits.js";
import { analysisSettingLimit } from "../domain/analysisSettingDefinitions.js";
import {
  ArtifactReaderFailure,
  artifactFilePrimaryFacts,
} from "../resources/index.js";
import { utf8HeadExcerpt } from "../domain/utf8HeadExcerpt.js";
import type { ProviderProcessSnapshot } from "../process/ProviderProcess.js";
import { capturedProviderOutput } from "../process/capturedProviderOutput.js";
import type {
  AnalysisCapturedOutput,
  AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
  AnalysisCapabilityUnavailableError,
} from "../domain/analysisErrorCore.js";
import { hostRangeErrorKind } from "../domain/parseFailure.js";
import type { ProviderOutcome } from "../process/ProviderOutcome.js";
import type { ProviderFailureDialect } from "../providers/classifyProviderFailure.js";
import {
  RuntimeControlUnavailableError,
  runtimeControlCapabilityError,
} from "../domain/runtimeControlUnavailableError.js";
import { WabtAdmissionError } from "./WabtAdmissionError.js";
import type { AnalysisControlLimit } from "../domain/analysisSettings.js";
import {
  DEFAULT_WASM_COMMAND_TIMEOUT_MS,
  WABT_VERSION,
  WASM_RESOURCE_DEFAULTS,
  WASM_RESOURCE_MAXIMUMS,
  type WasmResourceLimits,
} from "../domain/wasm/wasmArtifact.js";
import { WABT_ACCEPTED_RANGE, WABT_PROVIDER_IDENTITY } from "./WabtRelease.js";
import { errorMessage } from "../kernel/errorMessage.js";
const OUTPUT_LIMIT_EXCERPT_BYTES = 4096;
const OPERATION = "inspect_wasm_artifact";

const WASM_BYTE_BUDGETS = {
  max_input_bytes: "inputBytes",
  max_output_bytes: "outputBytes",
  max_tool_bytes: "toolBytes",
} as const;
type WasmByteBudget = keyof typeof WASM_BYTE_BUDGETS;

/** Recovery names the exhausted per-call byte owner, independently of deadlines. */
const byteBudgetRecovery = (
  parameter: WasmByteBudget,
  value: number,
): string => {
  const maximum = WASM_RESOURCE_MAXIMUMS[WASM_BYTE_BUDGETS[parameter]];
  return `${parameter} is ${String(value)} bytes. ${value < maximum ? `Raise ${parameter} above ${String(value)} bytes (positive integer, maximum ${String(maximum)}), then retry the same complete input after cleanup settles.` : `This is already the runtime representation maximum of ${String(maximum)} bytes; use a suitable smaller complete input or report this blocker.`} The new value applies to the next inspection without restarting REA. command_timeout_ms, other byte budgets and client delivery settings do not raise this allowance. Do not truncate required bytes. Repeating the unchanged request fails the same way.`;
};

/** The per-call control of an exhausted byte budget, while a larger value is selectable. */
const byteBudgetLimit = (
  parameter: WasmByteBudget,
  value: number,
): { readonly limit?: AnalysisControlLimit } => {
  const key = WASM_BYTE_BUDGETS[parameter];
  const maximum = WASM_RESOURCE_MAXIMUMS[key];
  return value < maximum
    ? {
        limit: {
          control_kind: "parameter",
          parameter,
          effective_value: value,
          unit: "bytes",
          minimum: 1,
          maximum,
          default_value: WASM_RESOURCE_DEFAULTS[key],
          applies_at: "next_call",
        },
      }
    : {};
};

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
/** The configured WABT installation cannot run this call. */
const wabtUnavailable = (
  message: string,
  cause: unknown,
  details: AnalysisErrorOptions,
): AnalysisCapabilityUnavailableError =>
  new AnalysisCapabilityUnavailableError(
    WABT_PROVIDER_IDENTITY.id,
    OPERATION,
    message,
    {
      ...details,
      userMessage: `Configured WABT could not start. Check executable/interpreter access and WABT ${WABT_VERSION} profile; inspect retained diagnostics.`,
      remediationAction: wabtConfigurationRecoveryAction(cause),
    },
  );

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
/** WABT's per-call command deadline and the setting that changes it. */
const wabtCommandTimeout = (execution: WabtFailureContext | undefined) => {
  const timeoutMs =
    execution?.commandTimeoutMs ?? DEFAULT_WASM_COMMAND_TIMEOUT_MS;
  const timeoutSource =
    execution?.commandTimeoutMs === undefined
      ? "default"
      : execution.commandTimeoutSource;
  return {
    ms: timeoutMs,
    limit: analysisSettingLimit(
      "wasm.command_timeout_ms",
      timeoutMs,
      timeoutSource,
    ),
    userMessage: `A WABT command reached its ${String(timeoutMs)} ms server/provider deadline (command_timeout_ms), not the whole-inspection or MCP client deadline.`,
    remediationAction: `${
      timeoutMs < MAX_NODE_TIMER_DELAY_MS
        ? `Increase command_timeout_ms above ${String(timeoutMs)} (integer milliseconds, maximum ${String(MAX_NODE_TIMER_DELAY_MS)}).`
        : `command_timeout_ms is already at the maximum supported ${String(MAX_NODE_TIMER_DELAY_MS)} ms; no higher command deadline is supported. Report this blocker or select another suitable complete artifact with caller approval.`
    } This is a per-call setting; no server restart is needed. Allow the MCP client deadline to cover all version/analysis commands, file checks, cleanup and delivery; increasing only that client deadline does not change this budget. max_input_bytes, max_tool_bytes and max_output_bytes are independent per-call controls; detail: summary reduces delivery size, not analysis work. Resolve any incomplete cleanup before retrying; do not repeat the unchanged failed call.`,
  };
};
/** The host refused to allocate an admitted acquisition buffer. */
const allocationRefused = (cause: unknown): boolean => {
  const physical = artifactFilePrimaryFacts(cause).cause;
  return (
    physical instanceof Error &&
    (("code" in physical &&
      [
        "ENOMEM",
        "ERR_MEMORY_ALLOCATION_FAILED",
        "ERR_BUFFER_TOO_LARGE",
      ].includes(String(physical.code))) ||
      (hostRangeErrorKind(physical) === "host-capacity" &&
        physical.message === "Array buffer allocation failed"))
  );
};

/**
 * WABT's failure dialect for one phase: lifecycle failures and diagnostic
 * bytes are preserved instead of returning partial success.
 */
export const wabtFailureDialect = (
  phase: "configuration" | "artifact" | "producer",
  path: string,
  execution?: WabtFailureContext,
): ProviderFailureDialect => {
  const versionProbe = execution?.versionProbe;
  const limits = execution?.limits ?? WASM_RESOURCE_DEFAULTS;
  const outputLimitReason = `WABT output exceeded the ${String(limits.outputBytes)}-byte output budget`;
  const observed =
    execution?.observedOutput === undefined
      ? {}
      : { capturedOutput: execution.observedOutput };
  const capturedOutput =
    (kind: ProviderOutcome["kind"]) => (snapshot: ProviderProcessSnapshot) =>
      kind === "output-limit"
        ? outputLimitExcerpt(snapshot)
        : capturedProviderOutput(snapshot);
  return {
    providerId: WABT_PROVIDER_IDENTITY.id,
    operation: OPERATION,
    observedOutput: execution?.observedOutput,
    recognise: (unknownCause, details) => {
      if (allocationRefused(unknownCause))
        return new AnalysisResourceConstraintError(
          OPERATION,
          "memory",
          "The host could not allocate the admitted WABT acquisition buffer",
          {
            max_input_bytes: limits.inputBytes,
            max_tool_bytes: limits.toolBytes,
          },
          {
            ...details,
            cause: unknownCause,
            ...observed,
            retryable: false,
            remediationAction:
              "Byte admission does not reserve host memory. Free host memory or select a suitable process with sufficient capacity, then retry after cleanup settles. Increasing byte budgets or command_timeout_ms does not repair this allocation failure; do not replace a correctly configured WABT installation for this reason.",
          },
        );
      if (unknownCause instanceof RuntimeControlUnavailableError)
        return runtimeControlCapabilityError(
          WABT_PROVIDER_IDENTITY.id,
          OPERATION,
          unknownCause,
        );
      if (
        phase === "configuration" &&
        unknownCause instanceof ArtifactReaderFailure &&
        unknownCause.reason === "limit" &&
        unknownCause.boundary === "file-size"
      )
        return new AnalysisCapabilityUnavailableError(
          WABT_PROVIDER_IDENTITY.id,
          OPERATION,
          unknownCause.message,
          {
            ...details,
            cause: unknownCause,
            ...observed,
            userMessage: `Configured WABT tools exceed the ${String(limits.toolBytes)}-byte tool allowance (max_tool_bytes).`,
            remediationAction: byteBudgetRecovery(
              "max_tool_bytes",
              limits.toolBytes,
            ),
            ...byteBudgetLimit("max_tool_bytes", limits.toolBytes),
          },
        );
      return undefined;
    },
    command: (outcome) => ({
      operation: OPERATION,
      capturedOutput: capturedOutput(outcome.kind),
      details: versionProbe === undefined ? {} : { diagnostics: versionProbe },
      timeout: wabtCommandTimeout(execution),
      outputLimit: {
        reason: outputLimitReason,
        limits: { max_output_bytes: limits.outputBytes },
        ...byteBudgetLimit("max_output_bytes", limits.outputBytes),
        recovery: {
          retryable: false,
          remediationAction: byteBudgetRecovery(
            "max_output_bytes",
            limits.outputBytes,
          ),
        },
      },
      launchUnavailable: (_failure, details) =>
        wabtUnavailable(outcome.message, outcome.cause, details),
      dialect: (exit, details, unclassified) =>
        // A version probe that exits or whose output cannot be collected
        // leaves the configured installation unusable for this call.
        phase === "configuration"
          ? wabtUnavailable(exit.message, exit.cause, details)
          : unclassified(),
    }),
    ...(phase === "artifact"
      ? {
          file: {
            path,
            description: "WebAssembly input",
            field: execution?.inputField ?? ["path"],
            fileSize: (limit, details) =>
              new AnalysisResourceConstraintError(
                OPERATION,
                "file-size",
                limit.message,
                { maximum_input_bytes: limits.inputBytes },
                {
                  ...details,
                  retryable: false,
                  remediationAction: byteBudgetRecovery(
                    "max_input_bytes",
                    limits.inputBytes,
                  ),
                  ...byteBudgetLimit("max_input_bytes", limits.inputBytes),
                },
              ),
          },
        }
      : {}),
    unclassified: (unrecognised, details) => {
      const reason = errorMessage(unrecognised);
      if (phase === "configuration") {
        const admission =
          unrecognised instanceof WabtAdmissionError ? unrecognised : undefined;
        return new AnalysisCapabilityUnavailableError(
          WABT_PROVIDER_IDENTITY.id,
          OPERATION,
          admission?.code ?? reason,
          {
            ...details,
            cause: unrecognised,
            ...observed,
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
            remediationAction: wabtConfigurationRecoveryAction(unrecognised),
          },
        );
      }
      if (phase === "artifact")
        return new AnalysisInputError(
          OPERATION,
          { ...details, cause: unrecognised },
          [
            {
              path: [...(execution?.inputField ?? ["path"])],
              reason: "invalid_value",
              message: reason,
            },
          ],
        );
      return new AnalysisOutputError(OPERATION, reason, {
        ...details,
        cause: unrecognised,
        ...observed,
      });
    },
  };
};
