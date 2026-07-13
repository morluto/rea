import type { Logger } from "./logger.js";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Identify caller-visible CLI outcomes that mean the requested operation failed. */
export const isCliOperationFailure = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  if (typeof value.error === "string") return true;
  if (value.healthy === false) return true;
  return (
    value.status === "failed" ||
    value.status === "needs_confirmation" ||
    value.status === "needs_human" ||
    value.status === "planned"
  );
};

/** Log one CLI command with duration and a stable success or failure status. */
export const logCliCommand = async <Value>(
  logger: Logger,
  command: string,
  execute: () => Promise<Value>,
): Promise<Value> => {
  const startedAt = performance.now();
  try {
    const value = await execute();
    const failed = isCliOperationFailure(value);
    logger[failed ? "error" : "info"](
      {
        command,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        status: failed ? "error" : "ok",
      },
      failed ? "CLI command failed" : "CLI command completed",
    );
    if (failed) process.exitCode = 1;
    return value;
  } catch (cause: unknown) {
    logger.error(
      {
        command,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        status: "error",
      },
      "CLI command failed",
    );
    throw cause;
  }
};
