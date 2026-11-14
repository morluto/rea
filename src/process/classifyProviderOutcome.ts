import type {
  AnalysisCapturedOutput,
  AnalysisError,
  AnalysisErrorOptions,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
  type ResourceConstraintRecovery,
} from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { ProviderOutcome } from "./ProviderOutcome.js";
import type { ProviderProcessSnapshot } from "./ProviderProcess.js";
import type { RuntimeExhaustion } from "./RuntimeExhaustion.js";

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
  { readonly kind: "launch-refused" | "exited" | "protocol" }
>;

type ReportedLimits = Readonly<Record<string, JsonValue>> | null;

/** What one provider command needs to turn its outcome into a typed error. */
export interface ProviderOutcomeContext {
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
  };
  readonly outputLimit: {
    readonly limits: ReportedLimits;
    readonly recovery: ResourceConstraintRecovery;
  };
  /** The enforced process-tree memory limit, when one was requested. */
  readonly memoryLimitBytes?: number | undefined;
  /** Reported limits and recovery for an inherited CPU or file-size signal. */
  readonly resourceSignal?: (signal: "SIGXCPU" | "SIGXFSZ") => {
    readonly limits: ReportedLimits;
    readonly recovery: ResourceConstraintRecovery;
  };
  /**
   * The provider's memory setting for a runtime exhaustion report, such as
   * the JVM heap it starts. Without it, recovery follows the resource kind.
   */
  readonly runtimeExhaustion?: (exhaustion: RuntimeExhaustion) => {
    readonly limits: ReportedLimits;
    readonly recovery: ResourceConstraintRecovery;
  };
  /** Provider-specific meaning of a launch refusal, an exit, or a stream failure. */
  readonly dialect: (
    outcome: ProviderDialectOutcome,
    details: AnalysisErrorOptions,
  ) => AnalysisError;
}

/**
 * The one mapping from an owned command's physical outcome to a typed error.
 * Owner-observed facts are classified here; only the provider's dialect
 * decides what an exit or a launch refusal means for that provider.
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
    case "cancelled":
      return new AnalysisCancelledError(operation, {
        ...details,
        cause: outcome.reason,
      });
    case "timeout":
      return new AnalysisTimeoutError(operation, context.timeout.ms, {
        ...details,
        ...(context.timeout.userMessage === undefined
          ? {}
          : { userMessage: context.timeout.userMessage }),
        ...(context.timeout.remediationAction === undefined
          ? {}
          : { remediationAction: context.timeout.remediationAction }),
      });
    case "output-limit":
      return new AnalysisResourceConstraintError(
        operation,
        "memory",
        outcome.message,
        context.outputLimit.limits,
        { ...details, ...context.outputLimit.recovery },
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
        `Producer terminated with ${outcome.signal}; the signal's exact cause is not independently established.`,
        reported?.limits ?? null,
        { ...details, ...reported?.recovery },
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
          ...(area === "native-thread"
            ? {
                retryable: true,
                remediationAction:
                  "Reduce concurrent analysis processes or review the host's available thread and process capacity, then retry.",
              }
            : reported?.recovery),
        },
      );
    }
    case "launch-refused":
    case "exited":
    case "protocol":
      return context.dialect(outcome, details);
  }
};
