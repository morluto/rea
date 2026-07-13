import type { Logger } from "./logger.js";

/** Log one CLI command with duration and a stable success or failure status. */
export const logCliCommand = async <Value>(
  logger: Logger,
  command: string,
  execute: () => Promise<Value>,
): Promise<Value> => {
  const startedAt = performance.now();
  try {
    const value = await execute();
    logger.info(
      {
        command,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        status: "ok",
      },
      "CLI command completed",
    );
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
