import {
  AnalysisError,
  type AnalysisErrorOptions,
} from "./analysisErrorBase.js";
import type {
  HopperProcessProviderState,
  ProviderFailureStage,
} from "./providerOperationHealth.js";
import {
  dialogTimeoutFromDiagnostic,
  hopperStartupFailure,
  invalidDialogTimeoutMessage,
  type HopperStartupFailureCode,
  type HopperStartupFailureDiagnostic,
} from "./hopperStartupFailure.js";

/** Base class for failures produced specifically by the Hopper provider. */
export abstract class HopperError extends AnalysisError {}

/** Observed launcher outcome; a helper exit does not establish GUI lifetime. */
export type HopperLauncherOutcome = {
  readonly exit_code: number | null;
  readonly signal: string | null;
  /** Total bytes drained from the stream; retained_bytes reports captured bytes. */
  readonly stdout: {
    readonly text: string;
    readonly bytes: number;
    readonly retained_bytes: number;
  };
  readonly stderr: {
    readonly text: string;
    readonly bytes: number;
    readonly retained_bytes: number;
  };
  readonly output_closed: boolean;
  readonly diagnostic_truncated: boolean;
};

/** Startup-timeout recovery that holds after the calling invocation has ended. */
export const HOPPER_STARTUP_TIMEOUT_REMEDIATION =
  "Review details.launcher and inspect Hopper for ongoing initial analysis or a pending loader, demo, or license dialog. For a large target, set REA_HOPPER_STARTUP_TIMEOUT_MS higher in the environment of a new REA invocation, then rerun the command; that invocation starts Hopper again. Resolve retained cleanup before rerunning.";

/** Startup-timeout recovery for a caller whose REA runtime keeps running. */
export const HOPPER_STARTUP_TIMEOUT_CONTINUING_REMEDIATION =
  "Review details.launcher and inspect Hopper for ongoing initial analysis or a pending loader, demo, or license dialog. For a large target, use update_analysis_settings with setting hopper.startup_timeout_ms and action set for the next startup attempt without restarting REA, or increase REA_HOPPER_STARTUP_TIMEOUT_MS for future REA processes. Allow at least that long in the MCP client. Resolve retained cleanup before reopening.";

/** Hopper did not respond within the configured operation deadline. */
export class HopperTimeoutError extends HopperError {
  readonly _tag = "HopperTimeoutError";

  constructor(
    readonly timeoutMs: number,
    readonly operation?: string,
    readonly requestId?: number,
    readonly providerState: "busy" | "not_started" = "not_started",
    readonly stage: ProviderFailureStage = operation === undefined
      ? "launch"
      : "analysis",
    readonly launcherOutcome?: HopperLauncherOutcome,
    options: AnalysisErrorOptions = {},
  ) {
    super(
      `Hopper ${operation === undefined ? "startup" : operation} timed out after ${String(timeoutMs)}ms`,
      operation === undefined
        ? {
            ...options,
            continuingCallerGuidance: {
              remediationAction: HOPPER_STARTUP_TIMEOUT_CONTINUING_REMEDIATION,
            },
          }
        : options,
    );
  }
}

/** The caller cancelled a Hopper operation before it completed. */
export class HopperCancelledError extends HopperError {
  readonly _tag = "HopperCancelledError";

  constructor(
    ...parameters:
      | readonly []
      | readonly [cause: unknown]
      | readonly [cause: unknown, options: Omit<AnalysisErrorOptions, "cause">]
  ) {
    const errorOptions: AnalysisErrorOptions = { ...parameters[1] };
    // Argument presence matters: an explicit undefined is the caller's reason.
    if (parameters.length > 0)
      Object.defineProperty(errorOptions, "cause", {
        configurable: true,
        enumerable: true,
        value: parameters[0],
        writable: true,
      });
    super("Hopper operation was cancelled", errorOptions);
  }
}

/**
 * Classify caller cancellation from a signal.
 *
 * An aborted signal keeps its exact reason, including undefined. A signal that
 * has not aborted does not invent a reason.
 */
export const hopperCancelledBySignal = (
  signal: AbortSignal | undefined,
): HopperCancelledError =>
  signal?.aborted === true
    ? new HopperCancelledError(signal.reason)
    : new HopperCancelledError();

/** Hopper returned bytes or JSON that do not satisfy the NDJSON RPC contract. */
export class HopperProtocolError extends HopperError {
  readonly _tag = "HopperProtocolError";
}

export type HopperDiagnosticType =
  | "remote"
  | "authorization"
  | "invalid_request"
  | "capability_unavailable"
  | "bridge_exception";

/** Hopper's JSON-RPC endpoint returned an expected remote error response. */
export interface HopperRemoteErrorContext extends AnalysisErrorOptions {
  readonly diagnosticType?: HopperDiagnosticType | undefined;
  readonly operation?: string | undefined;
  readonly requestId?: number | undefined;
}

export class HopperRemoteError extends HopperError {
  readonly _tag = "HopperRemoteError";
  readonly diagnosticType: HopperDiagnosticType;
  readonly operation: string | undefined;
  readonly requestId: number | undefined;

  constructor(
    readonly code: number,
    readonly safeMessage: string,
    context: HopperRemoteErrorContext = {},
  ) {
    super(`Hopper request failed (${String(code)}): ${safeMessage}`, context);
    this.diagnosticType = context.diagnosticType ?? "remote";
    this.operation = context.operation;
    this.requestId = context.requestId;
  }
}

/** The owned Hopper bridge stopped before its client was closed. */
export interface HopperProcessErrorContext extends AnalysisErrorOptions {
  readonly diagnostic?: HopperStartupFailureDiagnostic | undefined;
  readonly operation?: string | undefined;
  readonly requestId?: number | undefined;
  readonly providerState?: HopperProcessProviderState | undefined;
  readonly stage?: ProviderFailureStage | undefined;
  readonly launcherFailure?: HopperLauncherOutcome | undefined;
}

export class HopperProcessError extends HopperError {
  readonly _tag = "HopperProcessError";
  readonly failureCode: HopperStartupFailureCode | undefined;
  override readonly userMessage: string | undefined;
  readonly providerState: HopperProcessProviderState;
  readonly stage: ProviderFailureStage;
  readonly diagnostic: HopperStartupFailureDiagnostic | undefined;
  readonly operation: string | undefined;
  readonly requestId: number | undefined;
  readonly launcherFailure: HopperLauncherOutcome | undefined;

  constructor(
    readonly exitCode: number | null,
    context: HopperProcessErrorContext = {},
  ) {
    super(
      `Hopper bridge stopped unexpectedly with code ${String(exitCode)}`,
      context,
    );
    this.diagnostic = context.diagnostic;
    this.operation = context.operation;
    this.requestId = context.requestId;
    this.launcherFailure = context.launcherFailure;
    const failure = hopperStartupFailure(exitCode);
    this.userMessage =
      failure?.code === "invalid_dialog_timeout"
        ? invalidDialogTimeoutMessage(
            dialogTimeoutFromDiagnostic(context.diagnostic),
          )
        : failure?.message;
    this.stage =
      context.stage ??
      (failure === undefined
        ? context.operation === undefined
          ? "connection"
          : "analysis"
        : "launch");
    this.failureCode = failure?.code;
    this.providerState =
      context.providerState ?? (exitCode === null ? "unknown" : "exited");
  }
}

/** Parsed facts about rejecting an application before execution. */
export type HopperLaunchRejection =
  | {
      /** The selected application was rejected before it was executed. */
      readonly boundary: "publisher_verification";
      /** Parsed failure reason supplied by the verification owner. */
      readonly reason: string;
    }
  | ({
      readonly boundary: "argument_encoding";
      readonly reason: "applescript_literal";
    } & (
      | { readonly source: "launcher_path" }
      | {
          readonly source: "argument";
          /** Zero-based index in the final vendor argv, excluding the executable. */
          readonly argument_index: number;
        }
    ));

/** Hopper or the repository bridge could not be started. */
export class HopperStartError extends HopperError {
  readonly _tag = "HopperStartError";
  override readonly userMessage: string | undefined;
  readonly ownerRunId: string | undefined;
  readonly launcherFailure: HopperLauncherOutcome | undefined;
  readonly launchRejection: HopperLaunchRejection | undefined;

  constructor(
    options?: AnalysisErrorOptions & {
      readonly userMessage?: string;
      readonly ownerRunId?: string;
      readonly launcherFailure?: HopperLauncherOutcome;
      readonly launchRejection?: HopperLaunchRejection;
    },
  ) {
    super("Hopper application bridge could not be started", options);
    this.userMessage = options?.userMessage;
    this.ownerRunId = options?.ownerRunId;
    this.launcherFailure = options?.launcherFailure;
    this.launchRejection = options?.launchRejection;
  }
}
