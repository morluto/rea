import { capturedProviderOutput } from "../../process/capturedProviderOutput.js";
import { producerLimitControl } from "../../domain/producerResourceLimits.js";
import { analysisSettingLimit } from "../../domain/analysisSettingDefinitions.js";
import {
  PWNTOOLS_LIMITS,
  resolvePwntoolsLimits,
  type PwntoolsProducerLimits,
} from "../../domain/native/pwntoolsResourceLimits.js";
import type { AnalysisCapturedOutput } from "../../domain/analysisErrorBase.js";
import type { AnalysisControlLimit } from "../../domain/analysisSettings.js";
import type { ProviderProcessSnapshot } from "../../process/ProviderProcess.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { ProviderSelectionError } from "../../domain/providerSelectionError.js";
import type { ProviderOutcomeContext } from "../../process/classifyProviderOutcome.js";
import { OwnedCommandFailure } from "../../process/OwnedCommand.js";
import type { ProviderFailureDialect } from "../../providers/classifyProviderFailure.js";
import type { PwntoolsFailureEvidence } from "./PwntoolsResourceLimits.js";
import { nativeDeadlineRecovery } from "../../domain/native/nativeDeadlines.js";
import {
  PWNTOOLS_MEMORY_FAILURE_EXIT,
  PWNTOOLS_FILE_SIZE_FAILURE_EXIT,
} from "./PwntoolsRelease.js";
import { PWNTOOLS_PROVIDER_IDENTITY } from "./PwntoolsProviderIdentity.js";
import { errorMessage } from "../../kernel/errorMessage.js";

/** Operation identity supplied by each adapter sharing the pwntools boundary. */
export interface PwntoolsFailureContext {
  readonly operation: string;
  readonly providerId: string;
  readonly precedingOutput?: AnalysisCapturedOutput;
  readonly configurationKey?: string;
  readonly timeoutMs?: number;
  readonly producerLimits?: PwntoolsProducerLimits;
  readonly inputBytesSource?:
    | "default"
    | "setting"
    | "runtime"
    | "request"
    | undefined;
}

const pwntoolsInputLimitFact = (
  bytes: number,
  source: PwntoolsFailureContext["inputBytesSource"],
): string => {
  const effective = String(bytes);
  if (source === "request")
    return `Selected producer_limits.input_bytes is ${effective} bytes.`;
  if (source === "runtime")
    return `The runtime pwntools.max_input_bytes ceiling is ${effective} bytes.`;
  if (source === "setting")
    return `REA_PWNTOOLS_MAX_INPUT_BYTES selected ${effective} bytes.`;
  return `The launch default pwntools.max_input_bytes ceiling is ${effective} bytes.`;
};

const pwntoolsInputLimitRecovery = (
  bytes: number,
  source: PwntoolsFailureContext["inputBytesSource"],
): string => {
  const effective = String(bytes);
  const shared =
    "CPU, memory, output and transport allowances remain independent.";
  if (source === "request")
    return `producer_limits.input_bytes is ${effective} bytes for this call. Raise it on the next call. ${shared}`;
  if (source === "runtime")
    return `pwntools.max_input_bytes is ${effective} bytes (source runtime) and can be changed with update_analysis_settings. The launch seed is REA_PWNTOOLS_MAX_INPUT_BYTES. producer_limits.input_bytes overrides that ceiling on the next call. ${shared}`;
  if (source === "setting")
    return `REA_PWNTOOLS_MAX_INPUT_BYTES is ${effective} bytes (source setting). Change pwntools.max_input_bytes with update_analysis_settings, or set producer_limits.input_bytes on the next call. The built-in default is ${String(PWNTOOLS_LIMITS.input_bytes)} bytes. ${shared}`;
  return `pwntools.max_input_bytes is the launch default of ${effective} bytes and can be changed with update_analysis_settings. The launch seed is REA_PWNTOOLS_MAX_INPUT_BYTES. producer_limits.input_bytes overrides that default on the next call. ${shared}`;
};

/** Recovery identifies the selected controls rather than unrelated wall deadlines. */
export const pwntoolsBudgetRecovery = (
  limits: PwntoolsProducerLimits = resolvePwntoolsLimits(),
): string =>
  `Selected producer_limits: cpu_seconds=${String(limits.cpu_seconds)} seconds, output_bytes=${String(limits.output_bytes)}, diagnostic_bytes=${String(limits.diagnostic_bytes)}, address_space_bytes=${String(limits.address_space_bytes)}, file_bytes=${String(limits.file_bytes)}, input_bytes=${String(limits.input_bytes)} bytes. Increase the exhausted producer_limits field on the next call; no REA restart is required. Tighter inherited OS limits remain enforced and are not raised by this request. pwntools_timeout_ms changes only the wall deadline.`;

/**
 * Recovery for a bridge reply larger than `producer_limits.output_bytes`: the
 * reply file's own budget, shared by the decoder and the core-only debugger.
 */
export const pwntoolsReplyOutputLimit = (
  limits: PwntoolsProducerLimits,
): {
  readonly remediationAction: string;
  readonly limit: AnalysisControlLimit;
} => ({
  remediationAction: `Increase producer_limits.output_bytes above ${String(limits.output_bytes)} bytes on the next call; no restart is required. File output follows the selected output allowance unless file_bytes is explicit. Diagnostic output, worker memory, tighter inherited limits and transport remain independent.`,
  limit: producerLimitControl(
    "output_bytes",
    limits.output_bytes,
    PWNTOOLS_LIMITS.output_bytes,
  ),
});

/** Name the file-size cap and any reported effective limit, not address space. */
const fileSizeAllowance = (
  reportedBytes: number | undefined,
  selectedBytes: number,
): string => {
  const cap = String(selectedBytes);
  const inherited =
    "A tighter inherited limit is retained. Increase producer_limits.file_bytes on the next call; no restart is required. pwntools_timeout_ms does not raise the file-size allowance.";
  return reportedBytes === undefined
    ? `The file-size cap is ${cap} bytes (producer_limits.file_bytes). The effective file_size_bytes limit was not reported. ${inherited}`
    : `The effective file-size allowance is ${String(reportedBytes)} bytes (file_size_bytes). The file-size cap is ${cap} bytes (producer_limits.file_bytes). ${inherited}`;
};

const DEFAULT_CONTEXT = {
  operation: "inspect_binary_layout",
  providerId: PWNTOOLS_PROVIDER_IDENTITY.id,
};

/** One pwntools phase, with the evidence its owned reports left. */
interface PwntoolsPhase {
  readonly phase: string;
  readonly path: string;
  readonly executablePath: string;
  readonly failureEvidence: PwntoolsFailureEvidence;
  readonly context: PwntoolsFailureContext;
}

/**
 * pwntools' failure dialect for one phase of a decoder or debugger operation;
 * `classifyProviderFailure` keeps read, engine, output and owned-lifecycle
 * failure reasons distinct.
 */
export const pwntoolsFailureDialect = (
  phase: string,
  path: string,
  executablePath = path,
  failureEvidence: PwntoolsFailureEvidence = {},
  context: PwntoolsFailureContext = DEFAULT_CONTEXT,
): ProviderFailureDialect => {
  const state: PwntoolsPhase = {
    phase,
    path,
    executablePath,
    failureEvidence,
    context,
  };
  const limits = context.producerLimits ?? resolvePwntoolsLimits();
  return {
    providerId: context.providerId,
    operation: context.operation,
    command: () => pwntoolsCommandContext(state, limits),
    // Only the configuration phase checks the selected Python by path.
    recognise: (cause) =>
      phase === "configuration" && cause instanceof Error && "code" in cause
        ? pwntoolsUnavailable(
            `Selected Python executable is unavailable (${String(cause.code)}): ${path}. Check the caller-selected path and execute access.`,
            path,
            String(cause.code),
            undefined,
            context,
          )
        : undefined,
    ...(phase === "artifact-read"
      ? {
          file: {
            path,
            description: "object",
            retainCompletedIdentity: true,
            fileSize: (limit, details) =>
              new AnalysisInputError(
                context.operation,
                {
                  ...details,
                  userMessage: `${limit.message} ${pwntoolsInputLimitFact(limits.input_bytes, context.inputBytesSource)} ${pwntoolsBudgetRecovery(limits)}`,
                  remediationAction: pwntoolsInputLimitRecovery(
                    limits.input_bytes,
                    context.inputBytesSource,
                  ),
                  limit: analysisSettingLimit(
                    "pwntools.max_input_bytes",
                    limits.input_bytes,
                    context.inputBytesSource,
                  ),
                },
                [
                  {
                    path: ["path"],
                    reason: "out_of_range",
                    message: `${limit.message} REA_PWNTOOLS_MAX_INPUT_BYTES defaults to ${String(PWNTOOLS_LIMITS.input_bytes)} bytes.`,
                  },
                ],
              ),
          },
        }
      : {}),
    observedOutput: context.precedingOutput,
    unclassified: (cause, details) =>
      new ProviderAdapterError(context.providerId, context.operation, {
        ...details,
        cause,
        diagnostics: {
          ...pwntoolsPhaseDiagnostics(state),
          reason: errorMessage(cause),
        },
      }),
  };
};

/** The owned Python bridge's dialect: its reserved exits and selected budgets. */
const pwntoolsCommandContext = (
  state: PwntoolsPhase,
  limits: PwntoolsProducerLimits,
): ProviderOutcomeContext => {
  const { executablePath, failureEvidence, context } = state;
  const limitReport = failureEvidence.limits;
  const budgetRecovery = pwntoolsBudgetRecovery(limits);
  const reportFailure =
    limitReport?.failure === null || limitReport === undefined
      ? ""
      : ` Effective limit report unavailable: ${limitReport.failure}`;
  const reportedLimits = limitReport?.limits ?? null;
  const allowance = fileSizeAllowance(
    limitReport?.limits?.file_size_bytes,
    limits.file_bytes,
  );
  const fileSizeRecovery = `Review the reported worker file-size limits and write failure. ${allowance} Repeating the unchanged request fails the same way.`;
  // An omitted file_bytes follows this call's selected output allowance.
  const fileSizeLimit = producerLimitControl(
    "file_bytes",
    limits.file_bytes,
    limits.output_bytes,
  );
  const timeoutMs = context.timeoutMs ?? PWNTOOLS_LIMITS.command_timeout_ms;
  const deadline = nativeDeadlineRecovery({
    timeoutMs,
    parameter: "pwntools_timeout_ms",
    defaultMs: PWNTOOLS_LIMITS.command_timeout_ms,
    phase: "pwntools command deadline",
    unchanged: budgetRecovery,
  });
  return {
    operation: context.operation,
    capturedOutput: (snapshot) =>
      combinedPwntoolsOutput(snapshot, context) ??
      capturedProviderOutput(snapshot),
    details: {
      // A failure before any output still reports the earlier stage's output.
      ...(context.precedingOutput === undefined
        ? {}
        : { capturedOutput: context.precedingOutput }),
      ...(failureEvidence.finalizationFailures === undefined
        ? {}
        : {
            diagnostics: {
              receipt_finalization_failures:
                failureEvidence.finalizationFailures,
            },
          }),
    },
    timeout: {
      ms: timeoutMs,
      userMessage: deadline.userMessage,
      remediationAction: deadline.remediationAction,
      limit: deadline.limit,
    },
    // The command retains stdout and stderr under one aggregate
    // diagnostic_bytes budget; output_bytes bounds the reply file, which
    // reports its own refusal. Exceeding the command budget therefore names
    // diagnostic_bytes whichever stream overflowed it.
    outputLimit: {
      reason: `Owned pwntools stdout and stderr exceeded the selected ${String(limits.diagnostic_bytes)}-byte producer_limits.diagnostic_bytes budget.`,
      limits: { diagnostic_bytes: limits.diagnostic_bytes },
      recovery: {
        remediationAction: `Increase producer_limits.diagnostic_bytes above ${String(limits.diagnostic_bytes)} bytes on the next call; no restart is required. It bounds retained process stdout and stderr only; output_bytes, file and transport limits remain independent.`,
      },
      limit: producerLimitControl(
        "diagnostic_bytes",
        limits.diagnostic_bytes,
        PWNTOOLS_LIMITS.diagnostic_bytes,
      ),
    },
    resourceSignal: (signal) =>
      signal === "SIGXFSZ"
        ? {
            limits: reportedLimits,
            detail: `${reportFailure} ${allowance}`.trim(),
            recovery: { remediationAction: fileSizeRecovery },
            limit: fileSizeLimit,
          }
        : {
            limits: reportedLimits,
            detail:
              `${reportFailure} Selected producer_limits.cpu_seconds is ${String(limits.cpu_seconds)} seconds; inherited tighter limits remain enforced.`.trim(),
            recovery: {
              remediationAction: `Review the reported worker CPU limit and observed signal; the signal alone does not establish exhaustion. Increase producer_limits.cpu_seconds above ${String(limits.cpu_seconds)} on the next call when that policy was limiting. No restart is required; a tighter inherited limit remains enforced. pwntools_timeout_ms does not raise CPU admission.`,
            },
            limit: producerLimitControl(
              "cpu_seconds",
              limits.cpu_seconds,
              PWNTOOLS_LIMITS.cpu_seconds,
            ),
          },
    dialect: (outcome, details) => {
      if (outcome.kind === "launch-refused")
        return pwntoolsUnavailable(
          `Selected Python could not launch (${outcome.refusal.code}): ${executablePath}. Check the configured executable, its interpreter and host execute access.`,
          executablePath,
          outcome.refusal.code,
          undefined,
          context,
        );
      // A reserved exit means a resource failure only when the bridge's
      // marker names that resource.
      const reservedExit =
        outcome.kind === "exited" && outcome.signal === null
          ? outcome.exitCode
          : undefined;
      const marked = failureEvidence.marker?.resource;
      if (
        marked === "file-size" &&
        reservedExit === PWNTOOLS_FILE_SIZE_FAILURE_EXIT
      )
        return new AnalysisResourceConstraintError(
          context.operation,
          "file-size",
          `The owned Python bridge reported EFBIG while writing a file; the exact write failure cause is unknown.${reportFailure} ${allowance}`,
          reportedLimits,
          {
            ...details,
            remediationAction: fileSizeRecovery,
            limit: fileSizeLimit,
          },
        );
      if (marked === "memory" && reservedExit === PWNTOOLS_MEMORY_FAILURE_EXIT)
        return new AnalysisResourceConstraintError(
          context.operation,
          "memory",
          `The owned Python bridge reported a memory allocation failure without a structured reply; the exact allocation cause is unknown.${reportFailure} The selected producer_limits.address_space_bytes allowance is ${String(limits.address_space_bytes)} bytes; tighter inherited limits remain enforced.`,
          reportedLimits,
          {
            ...details,
            remediationAction: `Review the reported worker memory limits and available host memory. ${budgetRecovery}`,
          },
        );
      // The shared owner already carries the command's output as
      // `details.capturedOutput`; diagnostics keep only the exit facts.
      const snapshot = outcome.output?.snapshot;
      return new ProviderAdapterError(context.providerId, context.operation, {
        ...details,
        diagnostics: {
          ...pwntoolsPhaseDiagnostics(state),
          reason: outcome.message,
          failure_kind:
            outcome.cause instanceof OwnedCommandFailure
              ? outcome.cause.reason
              : outcome.kind,
          exit_code: snapshot?.exitCode ?? null,
          signal: snapshot?.signal ?? null,
        },
      });
    },
  };
};

/** Diagnostics every unrecognised pwntools failure reports. */
const pwntoolsPhaseDiagnostics = ({
  phase,
  path,
  failureEvidence,
  context,
}: PwntoolsPhase) => ({
  phase,
  path,
  ...(failureEvidence.finalizationFailures === undefined
    ? {}
    : { receipt_finalization_failures: failureEvidence.finalizationFailures }),
  ...(context.precedingOutput === undefined
    ? {}
    : { preceding_output: { ...context.precedingOutput } }),
  ...(failureEvidence.marker === undefined
    ? {}
    : { resource_failure_marker: { ...failureEvidence.marker } }),
});

/** The debugger's output follows the core decoder's when both ran. */
const combinedPwntoolsOutput = (
  snapshot: ProviderProcessSnapshot | null,
  context: PwntoolsFailureContext,
): AnalysisCapturedOutput | undefined => {
  const current =
    snapshot === null ? undefined : capturedProviderOutput(snapshot);
  const preceding = context.precedingOutput;
  if (preceding === undefined || current === undefined)
    return current ?? preceding;
  return {
    stdout: `[core decoder]\n${preceding.stdout}\n[debugger]\n${current.stdout}`,
    stderr: `[core decoder]\n${preceding.stderr}\n[debugger]\n${current.stderr}`,
    truncated: preceding.truncated || current.truncated,
  };
};

/** Report caller-selected engine absence with its actual configuration and host constraint. */
export const pwntoolsUnavailable = (
  reason: string,
  path: string,
  systemCode?: string,
  capturedOutput?: AnalysisCapturedOutput,
  context: PwntoolsFailureContext = DEFAULT_CONTEXT,
): ProviderSelectionError =>
  new ProviderSelectionError({
    ...(capturedOutput === undefined ? {} : { capturedOutput }),
    userMessage: reason,
    operation: context.operation,
    reason: "provider_unavailable",
    requestedProviderId: context.providerId,
    candidateIds: [context.providerId],
    rejections: [
      {
        providerId: context.providerId,
        origin: "availability",
        code: "provider_unavailable",
        reason,
        diagnostics: {
          configuration_key: context.configurationKey ?? "REA_PWNTOOLS_PYTHON",
          executable_path: path,
          ...(systemCode === undefined ? {} : { system_code: systemCode }),
        },
      },
    ],
  });
