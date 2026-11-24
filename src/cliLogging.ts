import { analysisCliErrorEnvelopeSchema } from "./contracts/errorSchemas.js";
import { analysisErrorProjectionSchema } from "./domain/analysisErrorProjectionSchema.js";
import { AnalysisError } from "./domain/analysisErrorBase.js";
import {
  projectAnalysisError,
  type AnalysisErrorProjection,
} from "./domain/analysisErrorProjection.js";
import type { Logger } from "pino";
import { isRecord } from "./kernel/isRecord.js";

type CliFailureIdentity = Pick<
  AnalysisErrorProjection,
  "code" | "category" | "retryable"
>;
interface CliOperationFailure {
  readonly payload: unknown;
  readonly identity?: CliFailureIdentity;
  /**
   * The command completed and returned its whole report, whose verdict is a
   * failure (an unhealthy doctor report). Output controls select from it as
   * from any result; only the exit status and full-output envelope record the
   * failure.
   */
  readonly completedReport?: true;
}
const loggedFailures = new WeakMap<object, CliOperationFailure | undefined>();

const canonicalFailure = (
  projection: AnalysisErrorProjection,
): CliOperationFailure => ({
  payload: projection,
  identity: {
    code: projection.code,
    category: projection.category,
    retryable: projection.retryable,
  },
});

/** Return the canonical failure projection owned by the CLI result boundary. */
const projectCliOperationFailure = (
  value: unknown,
): AnalysisErrorProjection | undefined => {
  if (!isRecord(value)) return undefined;
  const direct = analysisErrorProjectionSchema.safeParse(value);
  if (direct.success) return value as AnalysisErrorProjection;
  const envelope = analysisCliErrorEnvelopeSchema.safeParse(value);
  if (envelope.success) {
    const {
      error: _label,
      input_path: inputPath,
      input_reason: inputReason,
      ...projection
    } = value;
    const parsed = projection as AnalysisErrorProjection;
    if (typeof inputPath !== "string" && typeof inputReason !== "string")
      return parsed;
    return {
      ...parsed,
      details: {
        ...parsed.details,
        ...(typeof inputPath === "string" ? { input_path: inputPath } : {}),
        ...(typeof inputReason === "string"
          ? { input_reason: inputReason }
          : {}),
      },
    };
  }
  if (isRecord(value.error)) {
    const nested = analysisErrorProjectionSchema.safeParse(value.error);
    if (nested.success) return value.error as AnalysisErrorProjection;
  }
  return undefined;
};

/** Keep the classified payload and its canonical identity under one owner. */
const inferCliOperationFailure = (
  value: unknown,
): CliOperationFailure | undefined => {
  const projection = projectCliOperationFailure(value);
  if (projection !== undefined) return canonicalFailure(projection);
  if (isRecord(value) && value.healthy === false)
    return { payload: value, completedReport: true };
  return undefined;
};

export const cliOperationFailurePayload = (
  value: unknown,
): unknown | undefined => {
  if (isRecord(value) && loggedFailures.has(value))
    return loggedFailures.get(value)?.payload;
  const failure = inferCliOperationFailure(value);
  if (failure !== undefined && isRecord(value))
    loggedFailures.set(value, failure);
  return failure?.payload;
};

/** Whether a failed outcome is a completed report rather than an error payload. */
export const isCliCompletedFailureReport = (value: unknown): boolean => {
  if (cliOperationFailurePayload(value) === undefined || !isRecord(value))
    return false;
  return loggedFailures.get(value)?.completedReport === true;
};

/** Identify caller-visible CLI outcomes that mean the requested operation failed. */
export const isCliOperationFailure = (value: unknown): boolean =>
  cliOperationFailurePayload(value) !== undefined;

/** Already classified identity, without traversing payloads during recovery. */
export const cliOperationFailureIdentity = (
  value: unknown,
): CliFailureIdentity | undefined =>
  isRecord(value) ? loggedFailures.get(value)?.identity : undefined;

/** Keep failure classification and recovery identity when a CLI wrapper projects an error record. */
export const rebindLoggedCliFailure = (
  previous: unknown,
  next: unknown,
): void => {
  if (previous === next || !isRecord(previous) || !isRecord(next)) return;
  if (!loggedFailures.has(previous)) return;
  loggedFailures.set(
    next,
    inferCliOperationFailure(next) ?? loggedFailures.get(previous),
  );
};

/** Log one CLI command with duration and a stable success or failure status. */
export const logCliCommand = async <Value>(
  logger: Logger,
  command: string,
  execute: () => Promise<Value>,
  isCommandFailure?: (value: Value) => boolean,
): Promise<Value | AnalysisErrorProjection> => {
  const startedAt = performance.now();
  try {
    const value = await execute();
    const inferredFailure = inferCliOperationFailure(value);
    const failed = isCommandFailure?.(value) ?? inferredFailure !== undefined;
    if (isRecord(value))
      loggedFailures.set(
        value,
        failed ? (inferredFailure ?? { payload: value }) : undefined,
      );
    logger[failed ? "error" : "info"](
      {
        command,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        status: failed ? "error" : "ok",
      },
      failed ? "CLI command failed" : "CLI command completed",
    );
    if (failed) process.exitCode ||= 1;
    return value;
  } catch (cause: unknown) {
    process.exitCode ||= 1;
    logger.error(
      {
        command,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        status: "error",
      },
      "CLI command failed",
    );
    if (cause instanceof AnalysisError) {
      const projection = projectAnalysisError(cause);
      loggedFailures.set(projection, canonicalFailure(projection));
      return projection;
    }
    throw cause;
  }
};
