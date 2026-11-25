import { z } from "zod";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
  AnalysisTimeoutError,
  cancelledBy,
  carriedReason,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { StableFileHashFailure } from "../filesystem/StableFileHash.js";
import type {
  HarmonyAbcPartialObservation,
  HarmonyAbcRequest,
} from "../domain/harmony/harmonyAbcAnalysis.js";
import type { XpandaBridge } from "./XpandaBridge.js";
import { errorMessage } from "../kernel/errorMessage.js";

interface FailureContext {
  readonly cause: unknown;
  readonly request: HarmonyAbcRequest;
  readonly timeout: AbortSignal;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
  readonly bridge: XpandaBridge | undefined;
  readonly partial?: HarmonyAbcPartialObservation;
}

type DiagnosticFailure = {
  readonly operation: string;
  readonly cause: unknown;
  readonly bridge: XpandaBridge | undefined;
} & (
  | { readonly kind: "startup"; readonly command: string }
  | { readonly kind: "execution" }
  | { readonly kind: "output"; readonly reason: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "timeout"; readonly timeoutMs: number }
);

const xpandaTimeoutGuidance = (timeoutMs: number) => ({
  userMessage: `The xpanda operation exceeded its ${String(timeoutMs)} ms analysis budget with no complete result available.`,
  remediationAction:
    "Raise the operation's analysis_timeout_ms input (whole-file decompilation of large applications is the slowest operation), or decompile a single class instead of the whole file.",
});

/** Freeze failure selection now; read diagnostics once after owned finalization. */
export const captureXpandaFailure = (
  context: FailureContext,
): (() => AnalysisError) => {
  const observed = observeXpandaFailure(context);
  const { partial } = context;
  let projected: AnalysisError | undefined;
  return () => {
    if (projected === undefined) {
      projected =
        observed instanceof AnalysisError
          ? observed
          : presentDiagnosticFailure(observed);
      if (partial !== undefined) projected.retainPartialObservation(partial);
    }
    return projected;
  };
};

const observeXpandaFailure = (
  context: FailureContext,
): AnalysisError | DiagnosticFailure => {
  const { cause, request, timeout, timeoutMs, signal, bridge } = context;
  const observed = bridge?.transport.observedFailure();
  const diagnostic = {
    operation: request.operation,
    bridge,
    cause,
  };
  const physicalFailure = (failureCause: unknown): DiagnosticFailure =>
    bridge !== undefined && !bridge.initialized()
      ? {
          ...diagnostic,
          cause: failureCause,
          kind: "startup",
          command: bridge.transport.options.command,
        }
      : { ...diagnostic, cause: failureCause, kind: "execution" };
  const interruptionFailure = (reason: unknown): DiagnosticFailure => {
    if (timeout.aborted && reason === timeout.reason)
      return { ...diagnostic, cause: reason, kind: "timeout", timeoutMs };
    if (signal?.aborted === true && reason === signal.reason)
      return { ...diagnostic, cause: reason, kind: "cancelled" };
    return physicalFailure(reason);
  };
  // Caller reasons are opaque even when they are instances of our own errors.
  // Only the owning interruption boundary can select this path; a recorded
  // physical failure keeps precedence over a later abort using the same object.
  if (observed?.kind === "interrupted" && cause === observed.reason)
    return interruptionFailure(observed.reason);
  if (cause instanceof StableFileHashFailure)
    return new ProviderAdapterError("xpanda", request.operation, {
      cause: cause.cause,
      userMessage: cause.message,
    });
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof z.ZodError)
    return {
      ...diagnostic,
      kind: "output",
      reason:
        "The xpanda response violated the producer protocol this adapter pins",
    };
  if (observed?.kind === "protocol")
    return {
      ...diagnostic,
      cause: observed.cause,
      kind: "output",
      reason: observed.cause.message,
    };
  if (observed?.kind === "process") return physicalFailure(observed.cause);
  if (observed?.kind === "exit") return physicalFailure(cause);
  if (observed?.kind === "interrupted")
    return interruptionFailure(observed.reason);
  if (signal?.aborted === true)
    return { ...diagnostic, cause: signal.reason, kind: "cancelled" };
  if (timeout.aborted)
    return { ...diagnostic, cause: timeout.reason, kind: "timeout", timeoutMs };
  return physicalFailure(cause);
};

const presentDiagnosticFailure = (
  failure: DiagnosticFailure,
): AnalysisError => {
  const output = failure.bridge?.transport.diagnostics();
  const options = {
    cause: failure.cause,
    ...(output === undefined ? {} : { capturedOutput: output }),
  };
  if (failure.kind === "cancelled")
    return cancelledBy(
      failure.operation,
      carriedReason(failure.cause),
      output === undefined ? {} : { capturedOutput: output },
    );
  if (failure.kind === "timeout")
    return new AnalysisTimeoutError(failure.operation, failure.timeoutMs, {
      ...options,
      ...xpandaTimeoutGuidance(failure.timeoutMs),
    });
  if (failure.kind === "output")
    return new AnalysisOutputError(failure.operation, failure.reason, options);
  if (failure.kind === "startup") {
    const reason = `Node could not start REA's HarmonyOS bridge using ${failure.command}: ${errorMessage(failure.cause)}. ${output === undefined || output.stderr.length === 0 ? "No launcher stderr was observed." : "Review the retained launcher diagnostics."}${output?.truncated === true ? " Diagnostics are incomplete." : ""} Review REA_XPANDA_ROOT: the checkout must have its dependencies installed and expose src/mcp/server.ts.`;
    return new AnalysisCapabilityUnavailableError(
      "xpanda",
      failure.operation,
      reason,
      {
        ...options,
        userMessage: reason,
      },
    );
  }
  return new ProviderAdapterError("xpanda", failure.operation, {
    ...options,
    diagnostics: {
      reason: errorMessage(failure.cause),
    },
  });
};

/**
 * Bind a retained cleanup failure onto an operation failure without losing
 * either; the retained resources stay owned for a later close retry.
 */
export const xpandaCleanupFailure = (
  cause: unknown,
  operation: string,
  resources: readonly string[],
): ProviderCleanupError =>
  new ProviderCleanupError(
    "xpanda",
    resources,
    {
      reason: errorMessage(cause),
    },
    { operation, cause },
  );
