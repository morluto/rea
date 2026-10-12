import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";
import { boundedUtf8Text } from "../process/boundedUtf8Text.js";

const MAX_CAUSE_DEPTH = 3;
const MAX_CAUSE_MESSAGE_BYTES = 2 * 1024;
const MAX_CAUSE_FIELD_BYTES = 1024;
const MAX_COMPILER_STDERR_BYTES = 8 * 1024;

/** Stable failure phase for one private Ghidra headless session. */
export type GhidraSessionFailureKind =
  | "cancelled"
  | "timeout"
  | "start"
  | "process"
  | "protocol"
  | "remote"
  | "analysis_timeout";

/** Additional structured context for a Ghidra session failure. */
export interface GhidraSessionErrorOptions extends ErrorOptions {
  readonly timeoutMs?: number;
  readonly remoteCode?: string;
  readonly cleanupFailure?: AnalysisError;
}

/** Provider-owned failure with bounded, token-redacted local diagnostics. */
export class GhidraSessionError extends Error {
  readonly diagnostics: Readonly<Record<string, JsonValue>>;
  readonly timeoutMs: number | undefined;
  readonly remoteCode: string | undefined;
  readonly cleanupFailure: AnalysisError | undefined;

  constructor(
    readonly kind: GhidraSessionFailureKind,
    message: string,
    diagnostics: Readonly<Record<string, JsonValue>> = {},
    options: GhidraSessionErrorOptions = {},
  ) {
    super(message, options);
    this.name = "GhidraSessionError";
    this.diagnostics = structuredClone(diagnostics);
    this.timeoutMs = options.timeoutMs;
    this.remoteCode = options.remoteCode;
    this.cleanupFailure = options.cleanupFailure;
  }
}

/** Build a session failure while preserving bounded remote failure metadata. */
const createGhidraSessionError = (failure: {
  readonly kind: GhidraSessionFailureKind;
  readonly message: string;
  readonly diagnostics: Readonly<Record<string, JsonValue>>;
  readonly cause?: unknown;
  readonly timeoutMs?: number;
  readonly remoteCode?: string;
  readonly redact: (value: string) => string;
}): GhidraSessionError =>
  new GhidraSessionError(
    failure.kind,
    failure.message,
    {
      ...failure.diagnostics,
      failure_kind: failure.kind,
      failure_message: failure.message,
      ...(failure.remoteCode === undefined
        ? {}
        : {
            remote_code: failure.redact(failure.remoteCode),
            remote_message: failure.message,
          }),
    },
    {
      ...(failure.cause === undefined ? {} : { cause: failure.cause }),
      ...(failure.timeoutMs === undefined
        ? {}
        : { timeoutMs: failure.timeoutMs }),
      ...(failure.remoteCode === undefined
        ? {}
        : { remoteCode: failure.remoteCode }),
    },
  );

/** Bind session-failure construction to a live, token-redacted diagnostic view. */
export const bindGhidraSessionFailure =
  (
    diagnostics: () => Readonly<Record<string, JsonValue>>,
    redact: (value: string) => string = (value) => value,
  ) =>
  (
    kind: GhidraSessionFailureKind,
    message: string,
    cause?: unknown,
    options: Pick<GhidraSessionErrorOptions, "timeoutMs" | "remoteCode"> = {},
  ): GhidraSessionError =>
    createGhidraSessionError({
      kind,
      message: redact(message),
      diagnostics: {
        ...diagnostics(),
        ...(cause === undefined
          ? {}
          : { failure_cause: describeCause(cause, redact) }),
      },
      redact,
      ...(cause === undefined ? {} : { cause }),
      ...options,
    });

const describeCause = (
  cause: unknown,
  redact: (value: string) => string,
  depth = 0,
): JsonValue => {
  if (cause instanceof Error) {
    return describeErrorCause(cause, redact, depth);
  }
  if (typeof cause === "string") {
    const message = boundedUtf8Text(redact(cause), MAX_CAUSE_MESSAGE_BYTES);
    return {
      type: "string",
      message: message.text,
      ...(message.truncated ? { message_truncated: true } : {}),
    };
  }
  if (cause === null || typeof cause === "boolean")
    return { type: cause === null ? "null" : "boolean", value: cause };
  if (typeof cause === "number" && Number.isFinite(cause))
    return { type: "number", value: cause };
  return { type: typeof cause };
};

const describeErrorCause = (
  cause: Error,
  redact: (value: string) => string,
  depth: number,
): JsonValue => {
  const message = boundedUtf8Text(
    redact(cause.message),
    MAX_CAUSE_MESSAGE_BYTES,
  );
  const name = boundedUtf8Text(redact(cause.name), MAX_CAUSE_FIELD_BYTES);
  return {
    name: name.text,
    ...(name.truncated ? { name_truncated: true } : {}),
    message: message.text,
    ...(message.truncated ? { message_truncated: true } : {}),
    ...causeCode(cause, redact),
    ...causeSignal(cause, redact),
    ...causeCompilerOutcome(cause, redact),
    ...nestedErrorCause(cause, redact, depth),
  };
};

const causeCode = (
  cause: Error,
  redact: (value: string) => string,
): Record<string, JsonValue> => {
  const code = "code" in cause ? cause.code : undefined;
  if (typeof code === "string") {
    const bounded = boundedUtf8Text(redact(code), MAX_CAUSE_FIELD_BYTES);
    return {
      code: bounded.text,
      ...(bounded.truncated ? { code_truncated: true } : {}),
    };
  }
  if (typeof code === "number" && Number.isFinite(code)) return { code };
  return {};
};

const causeSignal = (
  cause: Error,
  redact: (value: string) => string,
): Record<string, JsonValue> => {
  const signal = "signal" in cause ? cause.signal : undefined;
  if (typeof signal === "string") {
    const bounded = boundedUtf8Text(redact(signal), MAX_CAUSE_FIELD_BYTES);
    return {
      signal: bounded.text,
      ...(bounded.truncated ? { signal_truncated: true } : {}),
    };
  }
  if (signal === null) return { signal: null };
  return {};
};

const causeCompilerOutcome = (
  cause: Error,
  redact: (value: string) => string,
): Record<string, JsonValue> => {
  if (!(cause instanceof DarwinProcessOwnershipInspectionError)) return {};
  const outcome = cause.compilerOutcome;
  if (outcome === undefined) return {};
  const stderr = boundedUtf8Text(
    redact(outcome.stderr),
    MAX_COMPILER_STDERR_BYTES,
  );
  const code = boundedCompilerField(outcome.code, redact);
  const signal = boundedCompilerField(outcome.signal, redact);
  return {
    compiler_outcome: {
      ...outcome,
      code: code.value,
      signal: signal.value,
      stderr: stderr.text,
      stderrTruncated: outcome.stderrTruncated || stderr.truncated,
      ...(code.truncated ? { codeTruncated: true } : {}),
      ...(signal.truncated ? { signalTruncated: true } : {}),
    },
  };
};

const boundedCompilerField = (
  value: string | number | null,
  redact: (value: string) => string,
): { readonly value: string | number | null; readonly truncated: boolean } => {
  if (typeof value !== "string") return { value, truncated: false };
  const bounded = boundedUtf8Text(redact(value), MAX_CAUSE_FIELD_BYTES);
  return { value: bounded.text, truncated: bounded.truncated };
};

const nestedErrorCause = (
  cause: Error,
  redact: (value: string) => string,
  depth: number,
): Record<string, JsonValue> => {
  if (!("cause" in cause)) return {};
  if (depth >= MAX_CAUSE_DEPTH) return { cause_truncated: true };
  return { cause: describeCause(cause.cause, redact, depth + 1) };
};
