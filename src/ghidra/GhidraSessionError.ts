import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";

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
): JsonValue => {
  if (cause instanceof Error) {
    const code = "code" in cause ? cause.code : undefined;
    return {
      name: redact(cause.name),
      message: redact(cause.message),
      ...(typeof code === "string"
        ? { code: redact(code) }
        : typeof code === "number" && Number.isFinite(code)
          ? { code }
          : {}),
    };
  }
  if (typeof cause === "string")
    return { type: "string", message: redact(cause) };
  if (cause === null || typeof cause === "boolean")
    return { type: cause === null ? "null" : "boolean", value: cause };
  if (typeof cause === "number" && Number.isFinite(cause))
    return { type: "number", value: cause };
  return { type: typeof cause };
};
