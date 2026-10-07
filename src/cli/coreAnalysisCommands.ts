import type { Logger } from "../logger.js";
import { registerCoreBinaryCommands } from "./coreBinaryCommands.js";
import { registerCoreNativeCommands } from "./coreNativeCommands.js";
import type { CliInstance } from "./types.js";

/** Register core binary and native deep-analysis CLI commands. */
export const registerCoreAnalysisCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  registerCoreBinaryCommands(cli, logger);
  registerCoreNativeCommands(cli, logger);
};
