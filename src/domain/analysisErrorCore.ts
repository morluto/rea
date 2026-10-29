import type { JsonValue } from "./jsonValue.js";
import type { FixedAllowance } from "./fixedAllowanceRemediation.js";
import {
  AnalysisError,
  type AnalysisErrorOptions,
} from "./analysisErrorBase.js";

/** A readable supplied artifact lies outside this operation's supported target formats. */
export class AnalysisUnsupportedTargetError extends AnalysisError {
  readonly _tag = "AnalysisUnsupportedTargetError";
  /** Refusal-specific recovery, when the producer knows an available workflow. */
  readonly remediationAction: string | undefined;
  constructor(
    readonly operation: string,
    readonly path: string,
    readonly reason: string,
    options?: AnalysisErrorOptions & { readonly remediationAction?: string },
  ) {
    super(`Unsupported target for ${operation} at ${path}: ${reason}`, options);
    this.remediationAction = options?.remediationAction;
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
  readonly remediationAction: string | undefined;
  /**
   * The fixed format, decoder, or capture allowance that refused the request.
   * Worker limits and host resources do not raise it, so recovery derives from
   * this allowance rather than from `resource`.
   */
  readonly fixedAllowance: FixedAllowance | undefined;
  /**
   * Whether retrying the same request can succeed. A caller-selected bound is
   * deterministic for the same input, so it is not retryable even when its
   * resource kind would otherwise be treated as admission capacity.
   */
  readonly retryable: boolean | undefined;

  constructor(
    readonly operation: string,
    readonly resource: (typeof ANALYSIS_RESOURCE_KINDS)[number],
    readonly reason: string,
    readonly reportedLimits: Readonly<Record<string, JsonValue>> | null,
    options?: AnalysisErrorOptions & ResourceConstraintRecovery,
  ) {
    super(`Resource constraint during ${operation}: ${reason}`, options);
    this.remediationAction = options?.remediationAction;
    this.fixedAllowance = options?.fixedAllowance;
    this.retryable = options?.retryable;
  }
}

/** Carry one refusal's recovery to an error re-attributed or redacted elsewhere. */
export const resourceConstraintRecovery = (
  error: AnalysisResourceConstraintError,
  text: (value: string) => string = (value) => value,
): ResourceConstraintRecovery =>
  error.fixedAllowance !== undefined
    ? {
        fixedAllowance: {
          name: text(error.fixedAllowance.name),
          kind: error.fixedAllowance.kind,
        },
        ...retryable(error),
      }
    : {
        ...(error.remediationAction === undefined
          ? {}
          : { remediationAction: text(error.remediationAction) }),
        ...retryable(error),
      };

const retryable = (
  error: AnalysisResourceConstraintError,
): { readonly retryable?: boolean } =>
  error.retryable === undefined ? {} : { retryable: error.retryable };

/** Producer-specific recovery, or a fixed allowance whose recovery is derived. */
export type ResourceConstraintRecovery =
  | {
      readonly remediationAction?: string;
      readonly fixedAllowance?: never;
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

  constructor(
    readonly operation: string,
    options?: AnalysisErrorOptions & {
      readonly userMessage?: string;
      readonly remediationAction?: string;
    },
    readonly issues: readonly AnalysisInputIssue[] = [],
  ) {
    super(`Invalid analysis input for ${operation}`, options);
    this.userMessage = options?.userMessage;
    this.remediationAction = options?.remediationAction;
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
  /** Incomplete cleanup must settle before the operation can be retried. */
  readonly retryable: boolean;

  constructor(
    readonly providerId: string,
    readonly operation: string,
    readonly reason: string,
    options?: AnalysisErrorOptions & {
      readonly userMessage?: string;
      readonly remediationAction?: string;
      readonly retryable?: boolean;
    },
  ) {
    super(
      `Provider ${providerId} cannot execute ${operation}: ${reason}`,
      options,
    );
    this.userMessage = options?.userMessage;
    this.remediationAction = options?.remediationAction;
    this.retryable = options?.retryable === true && !this.cleanupIncomplete;
  }
}

/** Caller cancellation won before provider-neutral work completed. */
export class AnalysisCancelledError extends AnalysisError {
  readonly _tag = "AnalysisCancelledError";

  constructor(
    readonly operation: string,
    options?: AnalysisErrorOptions,
  ) {
    super(`Analysis operation was cancelled: ${operation}`, options);
  }
}

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
