import { parseConfig } from "../config.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { createBinarySession } from "./runtime.js";
import { silentLogger, type Logger } from "../logger.js";
import { createEvidence } from "../domain/evidence.js";

/**
 * Open one binary, execute one tool, and always release the bridge session.
 * Unlike MCP mode, every CLI invocation is intentionally isolated and does not
 * retain a target or bridge resources for a subsequent command.
 */
export const runDirectAnalysis = async (
  path: string,
  tool: "binary_overview" | "procedure_pseudo_code",
  arguments_: Readonly<Record<string, JsonValue>>,
  logger: Logger = silentLogger,
): Promise<JsonValue> => {
  const config = parseConfig(process.env);
  if (!config.ok)
    return { error: config.error._tag, message: config.error.message };
  const session = createBinarySession(config.value, logger);
  try {
    const opened = await session.open(path);
    if (!opened.ok)
      return { error: opened.error._tag, message: opened.error.message };
    const result = await session.execute(tool, arguments_);
    return result.ok
      ? createEvidence(opened.value, {
          operation: tool,
          parameters: arguments_,
          result: result.value,
        })
      : { error: result.error._tag, message: result.error.message };
  } finally {
    await session.close();
  }
};
