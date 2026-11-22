import type {
  AnalysisCapturedOutput,
  AnalysisError,
  AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  cancelledBy,
  carriedReason,
  type ResourceConstraintRecovery,
} from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { ProviderAdapterErrorOptions } from "../domain/providerAdapterError.js";
import {
  UnclassifiedProviderFailure,
  type ExaminedProviderOutcome,
} from "../domain/unclassifiedProviderFailure.js";
import type { AnalysisLimit } from "../domain/analysisSettings.js";
import {
  describeLaunchFailure,
  type LaunchExhaustedResource,
  type LauncherFailure,
} from "./launchFailure.js";
import type { ProviderOutcome } from "./ProviderOutcome.js";
import type { ProviderProcessSnapshot } from "./ProviderProcess.js";
import {
  runtimeExhaustionReport,
  type RuntimeExhaustion,
} from "./RuntimeExhaustion.js";

const RUNTIME_NAMES = {
  jvm: "The provider's Java virtual machine",
  v8: "The provider's JavaScript runtime",
} as const satisfies Record<RuntimeExhaustion["runtime"], string>;

const AREA_NAMES = {
  heap: "heap",
  "gc-overhead": "garbage-collection overhead limit",
  metaspace: "metaspace",
  "array-size": "array size beyond the VM limit",
  "native-thread": "unable to create a native thread",
} as const satisfies Record<NonNullable<RuntimeExhaustion["area"]>, string>;

/** Outcomes whose meaning depends on the provider's own dialect. */
export type ProviderDialectOutcome = Extract<
  ProviderOutcome,
  { readonly kind: "exited" | "protocol" }
>;

/** A launch failure that leaves the provider unavailable for this call. */
export type LaunchUnavailableFailure = Extract<
  LauncherFailure,
  { readonly kind: "missing" | "not_executable" | "failed" }
>;

const EXHAUSTED_RESOURCE_NAMES = {
  processes: "process",
  memory: "memory",
  "file-descriptors": "file-descriptor",
} as const satisfies Record<LaunchExhaustedResource, string>;

/** What one launch failure report needs beyond the launcher's facts. */
export interface LaunchFailureContext {
  readonly providerId: string;
  readonly operation: string;
  /** Options every classified error carries, such as the cause and cleanup. */
  readonly details?: AnalysisErrorOptions;
  /** The command the caller selected, when the launcher did not name it. */
  readonly command?: string;
  /** The setting that selected the command; a host constraint leaves it unchanged. */
  readonly selection?: string;
  /** Bytes of the refused argument list, when the caller measured them. */
  readonly argumentBytes?: number;
  /**
   * The command's arguments do not depend on the request, so an oversized
   * launch (E2BIG) can only be repaired by shrinking the environment REA
   * passes to it.
   */
  readonly fixedArguments?: boolean;
  /**
   * The provider's report that it cannot be started, such as a message naming
   * its configured executable. Without it the shared report names the
   * executable and the errno.
   */
  readonly unavailable?: (
    failure: LaunchUnavailableFailure,
    details: AnalysisErrorOptions,
  ) => AnalysisError;
}

/**
 * The one mapping from a launcher's failure to a typed error. Host capacity
 * (EAGAIN, ENOMEM, EMFILE, ENFILE) and an oversized argument list (E2BIG) are
 * resource constraints of this call, not provider faults; every other errno
 * leaves the provider unavailable, reported with its errno and syscall.
 */
export const classifyLaunchFailure = (
  failure: LauncherFailure,
  context: LaunchFailureContext,
): AnalysisError => {
  const { operation } = context;
  const command = failure.executable ?? context.command;
  const subject = command ?? "the provider command";
  const launchFacts: Readonly<Record<string, JsonValue>> = {
    system_code: failure.code ?? null,
    ...(failure.syscall === undefined ? {} : { syscall: failure.syscall }),
    ...(command === undefined ? {} : { command }),
  };
  const details: AnalysisErrorOptions = {
    ...context.details,
    diagnostics: {
      ...context.details?.diagnostics,
      ...launchFacts,
      boundary:
        failure.kind === "host-exhausted" ? "host-capacity" : "provider-launch",
    },
  };
  const unchanged = `${context.selection ?? "the selected command"} does not need to change`;
  switch (failure.kind) {
    case "host-exhausted": {
      const name = EXHAUSTED_RESOURCE_NAMES[failure.resource];
      return new AnalysisResourceConstraintError(
        operation,
        "capacity",
        `The host ran out of ${name} capacity (${failure.code}) to start ${subject}.`,
        {
          spawn_error: failure.code,
          exhausted_resource: failure.resource,
          ...(command === undefined ? {} : { command }),
        },
        {
          ...details,
          retryable: true,
          remediationAction: `The host ran out of ${name} capacity (${failure.code}). Close unused processes or files, or raise the process or open-file limit of the REA process, then retry; ${unchanged}.`,
        },
      );
    }
    case "argument-list":
      return new AnalysisResourceConstraintError(
        operation,
        "transport",
        `The host rejected ${subject} because its argument list and environment exceed the process launch limit (${failure.code}).`,
        {
          spawn_error: failure.code,
          ...(context.argumentBytes === undefined
            ? {}
            : { argument_bytes: context.argumentBytes }),
        },
        {
          ...details,
          diagnostics: {
            ...details.diagnostics,
            // Fixed arguments leave the environment as the only input to shrink.
            oversized_launch_input:
              context.fixedArguments === true
                ? "environment"
                : "request_and_environment",
          },
          retryable: false,
          remediationAction:
            context.fixedArguments === true
              ? `This command's arguments do not depend on the request, so the environment REA passes to it is too large. Remove large or unneeded variables from the environment REA runs with, then retry; ${unchanged}. Retrying in the same environment fails the same way.`
              : `Select less input for one call, or pass large values through a file, then retry; ${unchanged}. An unchanged request fails the same way.`,
        },
      );
    case "missing":
    case "not_executable":
    case "failed": {
      if (context.unavailable !== undefined)
        return context.unavailable(failure, details);
      const reason =
        failure.kind === "missing"
          ? `${subject} was not found (${describeLaunchFailure(failure)}).`
          : failure.kind === "not_executable"
            ? `${subject} exists but could not be executed (${describeLaunchFailure(failure)}).`
            : `${subject} could not be launched (${describeLaunchFailure(failure)}).`;
      return new AnalysisCapabilityUnavailableError(
        context.providerId,
        operation,
        reason,
        { ...details, userMessage: reason },
      );
    }
  }
};

type ReportedLimits = Readonly<Record<string, JsonValue>> | null;

/**
 * Reports the dialect outcome being classified as unrecognised by the
 * context's provider. The report always carries the examined outcome and the
 * classifier's details; `options` add provider facts to those details.
 */
export type UnclassifiedOutcomeReport = (
  options?: ProviderAdapterErrorOptions,
) => UnclassifiedProviderFailure;

/** The facts the classifier examined for one dialect outcome. */
const examinedOutcome = (
  outcome: ProviderDialectOutcome,
): ExaminedProviderOutcome => {
  const snapshot = outcome.output?.snapshot;
  return {
    failure_kind: outcome.kind,
    reason: outcome.message,
    exit_code:
      outcome.kind === "exited"
        ? outcome.exitCode
        : (snapshot?.exitCode ?? null),
    signal:
      outcome.kind === "exited" ? outcome.signal : (snapshot?.signal ?? null),
    ...(outcome.kind === "exited"
      ? { stop_requested: outcome.stopRequested }
      : {}),
    ...(outcome.output === undefined
      ? {}
      : { output_truncated: outcome.output.truncated }),
  };
};

/** What one provider command needs to turn its outcome into a typed error. */
export interface ProviderOutcomeContext {
  readonly providerId: string;
  readonly operation: string;
  /** The provider's redacted projection of retained output. */
  readonly capturedOutput: (
    snapshot: ProviderProcessSnapshot,
  ) => AnalysisCapturedOutput;
  /** Options every classified error carries, such as retained cleanup. */
  readonly details?: AnalysisErrorOptions;
  readonly timeout: {
    readonly ms: number;
    /** Which deadline elapsed, when the generic timeout text is not enough. */
    readonly userMessage?: string;
    /** The setting or action that changes that deadline. */
    readonly remediationAction?: string;
    /** The setting, parameter or environment control that selected the deadline. */
    readonly limit?: AnalysisLimit;
  };
  readonly outputLimit: {
    /** The budget that was exceeded, when the generic report is not enough. */
    readonly reason?: string;
    readonly limits: ReportedLimits;
    readonly recovery: ResourceConstraintRecovery;
    /** The per-call control that raises this allowance, when the caller selects it. */
    readonly limit?: AnalysisLimit;
  };
  /** The enforced process-tree memory limit, when one was requested. */
  readonly memoryLimitBytes?: number | undefined;
  /** Reported limits and recovery for an inherited CPU or file-size signal. */
  readonly resourceSignal?: (signal: "SIGXCPU" | "SIGXFSZ") => {
    readonly limits: ReportedLimits;
    readonly recovery: ResourceConstraintRecovery;
    /** The per-call control that raises this allowance, when the caller selects it. */
    readonly limit?: AnalysisLimit;
    /** Provider facts appended to the shared report, such as the selected allowance. */
    readonly detail?: string;
  };
  /**
   * The provider's memory setting for a runtime exhaustion report, such as
   * the JVM heap it starts. Without it, recovery follows the resource kind.
   */
  readonly runtimeExhaustion?: (exhaustion: RuntimeExhaustion) => {
    readonly limits: ReportedLimits;
    readonly recovery: ResourceConstraintRecovery;
  };
  /**
   * The provider's report that its command cannot be started; see
   * `LaunchFailureContext.unavailable`. Host constraints are not the
   * provider's to interpret.
   */
  readonly launchUnavailable?: LaunchFailureContext["unavailable"];
  /**
   * Provider-specific meaning of an exit or a stream failure. What the
   * provider does not recognise it reports through `unclassified`, which
   * carries the examined outcome.
   */
  readonly dialect: (
    outcome: ProviderDialectOutcome,
    details: AnalysisErrorOptions,
    unclassified: UnclassifiedOutcomeReport,
  ) => AnalysisError;
}

/**
 * The one mapping from an owned command's physical outcome to a typed error.
 * Owner-observed facts, including launch failures, are classified here; only
 * the provider's dialect decides what an exit or a stream failure means.
 */
export const classifyProviderOutcome = (
  outcome: ProviderOutcome,
  context: ProviderOutcomeContext,
): AnalysisError => {
  const { operation } = context;
  const details: AnalysisErrorOptions = {
    ...context.details,
    cause: outcome.cause,
    ...(outcome.output === undefined
      ? {}
      : { capturedOutput: context.capturedOutput(outcome.output.snapshot) }),
  };
  switch (outcome.kind) {
    case "cancelled": {
      // The caller's abort reason is the cancellation's cause; the outcome's
      // own cause is the supervisor failure that observed it.
      const { cause: _observed, ...cancellationDetails } = details;
      return cancelledBy(
        operation,
        carriedReason(outcome.reason),
        cancellationDetails,
      );
    }
    case "timeout":
      return new AnalysisTimeoutError(operation, context.timeout.ms, {
        ...details,
        ...(context.timeout.userMessage === undefined
          ? {}
          : { userMessage: context.timeout.userMessage }),
        ...(context.timeout.remediationAction === undefined
          ? {}
          : { remediationAction: context.timeout.remediationAction }),
        ...(context.timeout.limit === undefined
          ? {}
          : { limit: context.timeout.limit }),
      });
    case "output-limit":
      return new AnalysisResourceConstraintError(
        operation,
        "memory",
        context.outputLimit.reason ?? outcome.message,
        context.outputLimit.limits,
        {
          ...details,
          ...context.outputLimit.recovery,
          ...(context.outputLimit.limit === undefined
            ? {}
            : { limit: context.outputLimit.limit }),
        },
      );
    case "memory-limit":
      return new AnalysisResourceConstraintError(
        operation,
        "memory",
        "The owned process tree reached its enforced committed-memory limit.",
        { process_memory_limit_bytes: context.memoryLimitBytes ?? null },
        details,
      );
    case "resource-signal": {
      const reported = context.resourceSignal?.(outcome.signal);
      return new AnalysisResourceConstraintError(
        operation,
        outcome.signal === "SIGXFSZ" ? "file-size" : "cpu",
        `Producer terminated with ${outcome.signal}; the signal's exact cause is not independently established.${reported?.detail === undefined ? "" : ` ${reported.detail}`}`,
        reported?.limits ?? null,
        {
          ...details,
          ...reported?.recovery,
          ...(reported?.limit === undefined ? {} : { limit: reported.limit }),
        },
      );
    }
    case "runtime-exhausted": {
      const reported = context.runtimeExhaustion?.(outcome.exhaustion);
      const { area, runtime } = outcome.exhaustion;
      return new AnalysisResourceConstraintError(
        operation,
        area === "native-thread" ? "capacity" : "memory",
        `${RUNTIME_NAMES[runtime]} reported running out of memory${area === undefined ? "" : ` (${AREA_NAMES[area]})`} before the process ended. This is reported evidence and does not prove the exact allocation failure.`,
        reported?.limits ?? null,
        {
          ...details,
          diagnostics: {
            ...details.diagnostics,
            runtime_exhaustion_report: runtimeExhaustionReport(
              outcome.exhaustion,
            ),
          },
          // The provider's recovery names the setting that governs the
          // reported area; the generic capacity advice is only a fallback.
          ...(reported?.recovery ??
            (area === "native-thread"
              ? {
                  retryable: true,
                  remediationAction:
                    "Reduce concurrent analysis processes or review the host's available thread and process capacity, then retry.",
                }
              : {})),
        },
      );
    }
    case "launch-failed":
      return classifyLaunchFailure(outcome.failure, {
        providerId: context.providerId,
        operation,
        details,
        ...(context.launchUnavailable === undefined
          ? {}
          : { unavailable: context.launchUnavailable }),
      });
    case "exited":
    case "protocol":
      return context.dialect(
        outcome,
        details,
        (options) =>
          new UnclassifiedProviderFailure(
            context.providerId,
            operation,
            examinedOutcome(outcome),
            {
              ...details,
              ...options,
              // Provider facts join the context's diagnostics; neither
              // replaces the other.
              diagnostics: { ...details.diagnostics, ...options?.diagnostics },
            },
          ),
      );
  }
};
