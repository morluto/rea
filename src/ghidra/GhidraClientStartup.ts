import type { JsonValue } from "../domain/jsonValue.js";
import { err, type Result } from "../domain/result.js";
import type { ProviderStartupDeadline } from "../process/ProviderDeadline.js";
import type { GhidraRequestOptions } from "./GhidraClientTypes.js";
import type {
  GhidraSessionError,
  GhidraSessionErrorOptions,
  GhidraSessionFailureKind,
} from "./GhidraSessionError.js";
import type { GhidraSessionInfo } from "./GhidraSessionValues.js";

/** Inputs needed to complete the post-connection bridge handshake. */
export interface GhidraStartupHandshakeOptions {
  readonly deadline: ProviderStartupDeadline;
  readonly request: (
    method: string,
    params: JsonValue,
    options: GhidraRequestOptions,
  ) => Promise<Result<JsonValue, GhidraSessionError>>;
  readonly parseSessionInfo: (
    value: JsonValue,
  ) => Result<GhidraSessionInfo, GhidraSessionError>;
  readonly cleanup: () => Promise<void>;
  readonly failure: (
    kind: GhidraSessionFailureKind,
    message: string,
    cause?: unknown,
    options?: Pick<GhidraSessionErrorOptions, "timeoutMs" | "remoteCode">,
  ) => GhidraSessionError;
  readonly startupTimeoutMs: number;
}

/** Ping and validate the bridge after its socket is attached. */
export async function completeGhidraStartupHandshake(
  options: GhidraStartupHandshakeOptions,
): Promise<Result<GhidraSessionInfo, GhidraSessionError>> {
  const ping = await options.request(
    "ping",
    {},
    {
      signal: options.deadline.signal,
      timeoutMs: options.deadline.remainingMs(),
    },
  );
  if (!ping.ok) {
    const failure = options.deadline.signal.aborted
      ? interruptionFailure(options)
      : ping.error;
    await options.cleanup();
    return err(failure);
  }
  const parsed = options.parseSessionInfo(ping.value);
  if (!parsed.ok || parsed.value.analysis_timed_out) {
    const failure = parsed.ok
      ? options.failure(
          "analysis_timeout",
          "Ghidra auto-analysis reached its per-file deadline",
        )
      : parsed.error;
    await options.cleanup();
    return err(failure);
  }
  return parsed;
}

const interruptionFailure = (
  options: GhidraStartupHandshakeOptions,
): GhidraSessionError =>
  options.deadline.cancelled
    ? options.failure("cancelled", "Ghidra startup was cancelled")
    : options.failure("timeout", "Ghidra startup deadline elapsed", undefined, {
        timeoutMs: options.startupTimeoutMs,
      });
