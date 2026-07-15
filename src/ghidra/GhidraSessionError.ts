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
}

/** Provider-owned failure with bounded, token-redacted local diagnostics. */
export class GhidraSessionError extends Error {
  readonly diagnostics: Readonly<Record<string, JsonValue>>;
  readonly timeoutMs: number | undefined;

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
  }
}
