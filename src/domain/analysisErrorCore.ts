import type { JsonValue } from "./jsonValue.js";
import type { FixedAllowance } from "./fixedAllowanceRemediation.js";
import type { AmbiguousSelector } from "./analysisRefusal.js";
import {
  AnalysisError,
  type AnalysisErrorOptions,
} from "./analysisErrorBase.js";

/** A readable supplied artifact lies outside this operation's supported target formats. */
export class AnalysisUnsupportedTargetError extends AnalysisError {
  readonly _tag = "AnalysisUnsupportedTargetError";
  /** Refusal-specific recovery, when the producer knows an available workflow. */
  readonly remediationAction: string | undefined;
  /** The target holds the content, so unsupported does not make it inapplicable. */
  readonly undecodedContent: boolean;
  constructor(
    readonly operation: string,
    readonly path: string,
    readonly reason: string,
    options?: AnalysisErrorOptions & {
      readonly remediationAction?: string;
      readonly undecodedContent?: boolean;
    },
  ) {
    super(`Unsupported target for ${operation} at ${path}: ${reason}`, options);
    this.remediationAction = options?.remediationAction;
    this.undecodedContent = options?.undecodedContent ?? false;
  }
}

/** An analysis or transport resource failure, distinct from malformed input or unsupported coverage. */
export const ANALYSIS_RESOURCE_KINDS = [
  "memory",
  "cpu",
  "file-size",
  "transport",
  "capacity",
] as const;

/** A measured resource constraint or bounded admission refusal. */
export class AnalysisResourceConstraintError extends AnalysisError {
  readonly _tag = "AnalysisResourceConstraintError";
  /**
   * The one recovery this refusal carries. A fixed allowance and a separate
   * remediation sentence do not co-occur; retryability belongs to that same
   * object.
   */
  readonly recovery: ResourceConstraintRecovery;

  constructor(
    readonly operation: string,
    readonly resource: (typeof ANALYSIS_RESOURCE_KINDS)[number],
    readonly reason: string,
    readonly reportedLimits: Readonly<Record<string, JsonValue>> | null,
    options?: AnalysisErrorOptions & ResourceConstraintRecovery,
  ) {
    super(`Resource constraint during ${operation}: ${reason}`, options);
    this.recovery = resourceConstraintRecoveryFrom(options);
  }

  /** Projection of `recovery`. Absent when recovery names a fixed allowance. */
  get remediationAction(): string | undefined {
    return this.recovery.remediationAction;
  }

  /**
   * Projection of `recovery`. The fixed format, decoder, or capture allowance
   * that refused the request. Worker limits and host resources do not raise
   * it, so recovery derives from this allowance rather than from `resource`.
   */
  get fixedAllowance(): FixedAllowance | undefined {
    return this.recovery.fixedAllowance;
  }

  /**
   * Projection of `recovery`. Whether retrying the same request can succeed.
   * A caller-selected bound is deterministic for the same input, so it is not
   * retryable even when its resource kind would otherwise be treated as
   * admission capacity.
   */
  get retryable(): boolean | undefined {
    return this.recovery.retryable;
  }
}

const resourceConstraintRecoveryFrom = (
  options: ResourceConstraintRecovery | undefined,
): ResourceConstraintRecovery => {
  if (options?.fixedAllowance !== undefined)
    return {
      fixedAllowance: options.fixedAllowance,
      ...(options.retryable === undefined
        ? {}
        : { retryable: options.retryable }),
    };
  return {
    ...(options?.remediationAction === undefined
      ? {}
      : { remediationAction: options.remediationAction }),
    ...(options?.measuredExhaustion === undefined
      ? {}
      : { measuredExhaustion: options.measuredExhaustion }),
    ...(options?.retryable === undefined
      ? {}
      : { retryable: options.retryable }),
  };
};

/**
 * Re-attribute a resource refusal to another operation. Recovery and the
 * structured setting limit travel with it; a new error that keeps only the
 * sentence drops the setting, source, and effective value.
 */
export const reattributedResourceConstraint = (
  operation: string,
  error: AnalysisResourceConstraintError,
  options?: AnalysisErrorOptions,
): AnalysisResourceConstraintError =>
  new AnalysisResourceConstraintError(
    operation,
    error.resource,
    error.reason,
    error.reportedLimits,
    {
      ...options,
      ...resourceConstraintRecovery(error),
      ...(error.limit === undefined ? {} : { limit: error.limit }),
    },
  );

/** Carry one refusal's recovery to an error re-attributed or redacted elsewhere. */
export const resourceConstraintRecovery = (
  error: AnalysisResourceConstraintError,
  text: (value: string) => string = (value) => value,
): ResourceConstraintRecovery => {
  const recovery = error.recovery;
  return recovery.fixedAllowance !== undefined
    ? {
        fixedAllowance: {
          ...recovery.fixedAllowance,
          name: text(recovery.fixedAllowance.name),
          ...(recovery.fixedAllowance.narrowing === undefined
            ? {}
            : { narrowing: text(recovery.fixedAllowance.narrowing) }),
        },
        ...(recovery.retryable === undefined
          ? {}
          : { retryable: recovery.retryable }),
      }
    : {
        ...(recovery.remediationAction === undefined
          ? {}
          : { remediationAction: text(recovery.remediationAction) }),
        ...(recovery.measuredExhaustion === undefined
          ? {}
          : { measuredExhaustion: recovery.measuredExhaustion }),
        ...(recovery.retryable === undefined
          ? {}
          : { retryable: recovery.retryable }),
      };
};

/**
 * Producer-specific recovery, or a fixed allowance whose recovery is derived.
 * `measuredExhaustion` declares an observed runtime exhaustion or occupied
 * admission rather than a refusal, so recovery follows the resource kind.
 */
export type ResourceConstraintRecovery =
  | {
      readonly remediationAction?: string;
      readonly fixedAllowance?: never;
      readonly measuredExhaustion?: true;
      readonly retryable?: boolean;
    }
  | {
      readonly fixedAllowance: FixedAllowance;
      readonly remediationAction?: never;
      readonly retryable?: boolean;
    };

/** Provider-neutral invalid analysis input or output at an application boundary. */
export class AnalysisProtocolError extends AnalysisError {
  readonly _tag = "AnalysisProtocolError";
}

/** Caller input failed provider-neutral application parsing. */
export class AnalysisInputError extends AnalysisError {
  readonly _tag = "AnalysisInputError";
  override readonly userMessage: string | undefined;
  /** Refusal-specific correction, when the generic input-contract advice cannot fix it. */
  readonly remediationAction: string | undefined;
  /**
   * The refused values satisfy the advertised input contract; the selected
   * target lacks the requested fact for them. Re-reading the schema cannot
   * correct such a refusal, so it carries no input-contract recovery.
   */
  readonly conformsToInputContract: boolean;
  /** A schema-valid selector that matched several candidates. */
  readonly ambiguousSelector: AmbiguousSelector | undefined;

  constructor(
    readonly operation: string,
    options?: AnalysisErrorOptions & {
      readonly userMessage?: string;
      readonly remediationAction?: string;
      readonly conformsToInputContract?: boolean;
      readonly ambiguousSelector?: AmbiguousSelector;
    },
    readonly issues: readonly AnalysisInputIssue[] = [],
  ) {
    super(`Invalid analysis input for ${operation}`, options);
    this.userMessage = options?.userMessage;
    this.remediationAction = options?.remediationAction;
    this.ambiguousSelector = options?.ambiguousSelector;
    // An ambiguous selection conforms to the schema; the contract is not at fault.
    this.conformsToInputContract =
      options?.conformsToInputContract ??
      options?.ambiguousSelector !== undefined;
  }
}

/** Secret-safe correction metadata for one rejected caller argument. */
export interface AnalysisInputIssue {
  readonly path: readonly (string | number)[];
  readonly reason:
    | "unknown_argument"
    | "missing_argument"
    | "invalid_type"
    | "out_of_range"
    | "invalid_value"
    | "invalid_format";
  /** Schema-authored correction guidance for cross-field or custom checks. */
  readonly message?: string;
  readonly expected?: JsonValue;
  /** Producer-examined facts about the refused value, such as its location and shape. */
  readonly observed?: JsonValue;
  readonly minimum?: number;
  readonly maximum?: number;
}

/** Refusal-specific context a producer projects with an output failure. */
export interface AnalysisOutputErrorOptions extends AnalysisErrorOptions {
  /** Caller-facing explanation for a deterministic, diagnosable refusal. */
  readonly userMessage?: string;
  readonly remediationAction?: string;
  readonly cleanupOnly?: boolean;
}

/** Provider output failed provider-neutral application parsing. */
export class AnalysisOutputError extends AnalysisError {
  readonly _tag = "AnalysisOutputError";
  override readonly userMessage: string | undefined;
  readonly remediationAction: string | undefined;
  readonly cleanupOnly: boolean;

  constructor(
    readonly operation: string,
    readonly reason: string,
    options?: AnalysisOutputErrorOptions,
  ) {
    super(`Invalid analysis output for ${operation}: ${reason}`, options);
    this.userMessage = options?.userMessage;
    this.remediationAction = options?.remediationAction;
    this.cleanupOnly = options?.cleanupOnly ?? false;
  }
}

/** Selected provider cannot execute a declared analysis operation. */
export class AnalysisCapabilityUnavailableError extends AnalysisError {
  readonly _tag = "AnalysisCapabilityUnavailableError";
  override readonly userMessage: string | undefined;
  readonly remediationAction: string | undefined;
  /** General recovery used only when a consumer has no more specific action. */
  readonly fallbackRemediationAction: string | undefined;
  readonly siblingOperations: readonly string[] | undefined;
  readonly siblingReasons: Readonly<Record<string, string>> | undefined;
  /** Incomplete cleanup must settle before the operation can be retried. */
  readonly retryable: boolean;
  /**
   * Operations the caller can run now that observe part of what this one
   * would answer; the remediation states what they do not establish.
   */
  readonly alternatives: readonly string[];

  constructor(
    readonly providerId: string,
    readonly operation: string,
    readonly reason: string,
    options?: AnalysisErrorOptions & {
      readonly userMessage?: string;
      readonly remediationAction?: string;
      readonly fallbackRemediationAction?: string;
      readonly siblingOperations?: readonly string[];
      readonly siblingReasons?: Readonly<Record<string, string>>;
      readonly retryable?: boolean;
      readonly alternatives?: readonly string[];
    },
  ) {
    super(
      `Provider ${providerId} cannot execute ${operation}: ${reason}`,
      options,
    );
    this.userMessage = options?.userMessage;
    this.remediationAction = options?.remediationAction;
    this.fallbackRemediationAction = options?.fallbackRemediationAction;
    this.siblingOperations = options?.siblingOperations;
    this.siblingReasons = options?.siblingReasons;
    this.retryable = options?.retryable === true && !this.cleanupIncomplete;
    this.alternatives = Object.freeze([...(options?.alternatives ?? [])]);
  }
}

/**
 * Cancellation, by the caller or by REA closing the work's owner, won before
 * provider-neutral work completed. Build it with `cancelledBy`, which requires
 * the reason; `cause` holds that reason.
 */
export class AnalysisCancelledError extends AnalysisError {
  readonly _tag = "AnalysisCancelledError";
  override readonly userMessage: string | undefined;

  constructor(
    readonly operation: string,
    options?: AnalysisErrorOptions & {
      readonly userMessage?: string;
    },
  ) {
    super(`Analysis operation was cancelled: ${operation}`, options);
    this.userMessage = options?.userMessage;
  }
}

/** Why REA ended work on its own authority when no caller abort exists. */
export type OwnerCancellationKind =
  /** The provider, session, or service owning the work was closed or disposed. */
  "owner-closed";

/**
 * A cancellation REA initiated itself, such as a provider closing. It stands
 * in for a caller abort reason, so it is never mistaken for one.
 */
export class OwnerCancellation extends Error {
  override readonly name = "OwnerCancellation";
  private constructor(readonly kind: OwnerCancellationKind) {
    super("REA closed the owner of this operation before it completed");
  }

  /**
   * One shared reason per kind, so repeated owner cancellations compare equal
   * the way repeated observations of one caller abort do.
   */
  static readonly ownerClosed = new OwnerCancellation("owner-closed");
}

/** A caller abort reason recovered from an earlier observation of that abort. */
export interface CarriedCancellationReason {
  readonly carried: unknown;
}

/** Mark a reason already observed from the caller's abort, such as an inner failure's recorded reason. */
export const carriedReason = (reason: unknown): CarriedCancellationReason => ({
  carried: reason,
});

/**
 * Where a cancellation's reason comes from:
 * - an aborted signal, whose `reason` is the caller's (or parent operation's) reason;
 * - an earlier `AnalysisCancelledError`, whose reason is carried unchanged;
 * - a reason carried from another earlier observation;
 * - an owner cancellation that REA initiated itself.
 */
export type CancellationReason =
  | AbortSignal
  | AnalysisCancelledError
  | CarriedCancellationReason
  | OwnerCancellation;

/** A signal observed aborted, so its `reason` is the cancellation's reason. */
export type AbortedSignal = AbortSignal & { readonly aborted: true };

/** Whether an optional signal has aborted; narrows it to pass to `cancelledBy`. */
export const isAborted = (
  signal: AbortSignal | undefined,
): signal is AbortedSignal => signal?.aborted === true;

/** Options for a cancellation; its cause is always the required reason. */
export type CancelledOptions = Omit<AnalysisErrorOptions, "cause"> & {
  readonly cause?: never;
  readonly userMessage?: string;
};

// Signals are matched structurally last: callers and tests may pass an
// AbortSignal implementation from another realm or a signal-shaped fake.
const cancellationCause = (reason: CancellationReason): unknown => {
  if (reason instanceof AnalysisCancelledError) return reason.cause;
  if (reason instanceof OwnerCancellation) return reason;
  if ("carried" in reason) return reason.carried;
  return reason.reason;
};

/** The one constructor for a cancellation: its reason is required. */
export const cancelledBy = (
  operation: string,
  reason: CancellationReason,
  options?: CancelledOptions,
): AnalysisCancelledError =>
  new AnalysisCancelledError(operation, {
    ...options,
    cause: cancellationCause(reason),
  });

/** Provider-neutral operation exceeded its declared execution deadline. */
export class AnalysisTimeoutError extends AnalysisError {
  readonly _tag = "AnalysisTimeoutError";
  override readonly userMessage: string | undefined;
  readonly remediationAction: string | undefined;

  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
    options?: AnalysisErrorOptions & {
      /** Provider-specific explanation of which deadline elapsed. */
      readonly userMessage?: string;
      /** Provider-specific setting or action that changes that deadline. */
      readonly remediationAction?: string;
    },
  ) {
    super(
      `Analysis operation timed out after ${String(timeoutMs)}ms: ${operation}`,
      options,
    );
    this.userMessage = options?.userMessage;
    this.remediationAction = options?.remediationAction;
  }
}

/** Host filesystem permissions denied the selected read; this is not malformed caller input. */
export class AnalysisAccessDeniedError extends AnalysisError {
  readonly _tag = "AnalysisAccessDeniedError";
  constructor(
    readonly operation: string,
    readonly path: string,
    readonly systemCode: "EACCES" | "EPERM",
    options?: AnalysisErrorOptions,
  ) {
    super(
      `Host filesystem read access denied (${systemCode}) for ${path} during ${operation}`,
      options,
    );
  }
}

/** Selected artifact acquisition observed a change, so no stable identity can be reported. */
export class AnalysisArtifactChangedError extends AnalysisError {
  readonly _tag = "AnalysisArtifactChangedError";
  constructor(
    readonly operation: string,
    readonly path: string,
    readonly reason: string,
    options?: AnalysisErrorOptions,
  ) {
    super(`Selected artifact changed during acquisition: ${reason}`, options);
  }
}
