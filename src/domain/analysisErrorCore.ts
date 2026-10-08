import type { JsonValue } from "./jsonValue.js";
import {
  AnalysisError,
  type AnalysisErrorOptions,
} from "./analysisErrorBase.js";

/** A readable supplied artifact lies outside this operation's supported target formats. */
export class AnalysisUnsupportedTargetError extends AnalysisError {
  readonly _tag = "AnalysisUnsupportedTargetError";
  constructor(
    readonly operation: string,
    readonly path: string,
    readonly reason: string,
    options?: AnalysisErrorOptions,
  ) {
    super(`Unsupported target for ${operation} at ${path}: ${reason}`, options);
  }
}

/** Provider reported a resource failure, distinct from malformed input or unsupported coverage. */
export class AnalysisResourceConstraintError extends AnalysisError {
  readonly _tag = "AnalysisResourceConstraintError";

  constructor(
    readonly operation: string,
    readonly resource: "memory" | "cpu" | "file-size",
    readonly reason: string,
    readonly reportedLimits: Readonly<Record<string, JsonValue>> | null,
    options?: AnalysisErrorOptions,
  ) {
    super(`Resource constraint during ${operation}: ${reason}`, options);
  }
}

/** Provider-neutral invalid analysis input or output at an application boundary. */
export class AnalysisProtocolError extends AnalysisError {
  readonly _tag = "AnalysisProtocolError";
}

/** Caller input failed provider-neutral application parsing. */
export class AnalysisInputError extends AnalysisError {
  readonly _tag = "AnalysisInputError";

  constructor(
    readonly operation: string,
    options?: AnalysisErrorOptions,
    readonly issues: readonly AnalysisInputIssue[] = [],
  ) {
    super(`Invalid analysis input for ${operation}`, options);
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
  readonly minimum?: number;
  readonly maximum?: number;
}

/** Provider output failed provider-neutral application parsing. */
export class AnalysisOutputError extends AnalysisError {
  readonly _tag = "AnalysisOutputError";

  constructor(
    readonly operation: string,
    readonly reason: string,
    options?: AnalysisErrorOptions,
  ) {
    super(`Invalid analysis output for ${operation}: ${reason}`, options);
  }
}

/** Selected provider cannot execute a declared analysis operation. */
export class AnalysisCapabilityUnavailableError extends AnalysisError {
  readonly _tag = "AnalysisCapabilityUnavailableError";
  override readonly userMessage: string | undefined;

  constructor(
    readonly providerId: string,
    readonly operation: string,
    readonly reason: string,
    options?: AnalysisErrorOptions & { readonly userMessage?: string },
  ) {
    super(
      `Provider ${providerId} cannot execute ${operation}: ${reason}`,
      options,
    );
    this.userMessage = options?.userMessage;
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

  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
    options?: AnalysisErrorOptions,
  ) {
    super(
      `Analysis operation timed out after ${String(timeoutMs)}ms: ${operation}`,
      options,
    );
  }
}

/** Host filesystem permissions denied the selected read; this is not malformed caller input. */
export class AnalysisAccessDeniedError extends AnalysisError {
  readonly _tag = "AnalysisAccessDeniedError";
  constructor(
    readonly operation: string,
    readonly path: string,
    readonly systemCode: "EACCES" | "EPERM",
    options?: ErrorOptions,
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
    options?: ErrorOptions,
  ) {
    super(`Selected artifact changed during acquisition: ${reason}`, options);
  }
}
