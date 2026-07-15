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
}

/** Provider-owned failure with bounded, token-redacted local diagnostics. */
export class GhidraSessionError extends Error {
  readonly diagnostics: Readonly<Record<string, JsonValue>>;
  readonly timeoutMs: number | undefined;
  readonly remoteCode: string | undefined;

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
}): GhidraSessionError =>
  new GhidraSessionError(
    failure.kind,
    failure.message,
    failure.remoteCode === undefined
      ? failure.diagnostics
      : {
          ...failure.diagnostics,
          remote_code: failure.remoteCode,
          remote_message: failure.message,
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
  (diagnostics: () => Readonly<Record<string, JsonValue>>) =>
  (
    kind: GhidraSessionFailureKind,
    message: string,
    cause?: unknown,
    options: Pick<GhidraSessionErrorOptions, "timeoutMs" | "remoteCode"> = {},
  ): GhidraSessionError =>
    createGhidraSessionError({
      kind,
      message,
      diagnostics: diagnostics(),
      ...(cause === undefined ? {} : { cause }),
      ...options,
    });
