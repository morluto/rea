import type { Logger } from "../logger.js";
import { registerCoreBinaryCommands } from "./coreBinaryCommands.js";
import { registerCoreNativeCommands } from "./coreNativeCommands.js";
import type { CliInstance } from "./types.js";
import type { CliResultOutput } from "./streamedJsonOutput.js";

/** Register core binary and native deep-analysis CLI commands. */
export const registerCoreAnalysisCommands = (
  cli: CliInstance,
  logger: Logger,
  resultOutput?: CliResultOutput,
): void => {
  registerCoreBinaryCommands(cli, logger, resultOutput);
  registerCoreNativeCommands(cli, logger);
};
