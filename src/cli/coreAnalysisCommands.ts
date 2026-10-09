import type { DirectAnalysis } from "../composition/directAnalysis.js";
import type { Logger } from "../logger.js";
import { registerCoreBinaryCommands } from "./coreBinaryCommands.js";
import { registerCoreNativeCommands } from "./coreNativeCommands.js";
import type { CliInstance } from "./types.js";
import type { CliResultOutput } from "./streamedJsonOutput.js";

/** Register core binary and native deep-analysis CLI commands. */
export const registerCoreAnalysisCommands = (
  cli: CliInstance,
  logger: Logger,
  runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
  resultOutput?: CliResultOutput,
): void => {
  registerCoreBinaryCommands(cli, logger, runDirectAnalysis, resultOutput);
  registerCoreNativeCommands(cli, logger, runDirectAnalysis);
};
