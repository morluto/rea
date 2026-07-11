import { parseConfig } from "../config.js";
import type { JsonValue } from "../hopper/protocol.js";
import { createBinarySession } from "./runtime.js";

/** Open one binary, execute one tool, and always release the target session. */
export const runDirectAnalysis = async (
  path: string,
  tool: "binary_overview" | "procedure_pseudo_code",
  arguments_: Readonly<Record<string, JsonValue>>,
): Promise<JsonValue> => {
  const config = parseConfig(process.env);
  if (!config.ok)
    return { error: config.error._tag, message: config.error.message };
  const session = createBinarySession(config.value);
  try {
    const opened = await session.open(path);
    if (!opened.ok)
      return { error: opened.error._tag, message: opened.error.message };
    const result = await session.callTool(tool, arguments_);
    return result.ok
      ? result.value
      : { error: result.error._tag, message: result.error.message };
  } finally {
    await session.close();
  }
};
