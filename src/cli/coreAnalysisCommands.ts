import type { DirectAnalysis } from "../composition/directAnalysis.js";
import type { Logger } from "pino";
import { registerCoreBinaryCommands } from "./coreBinaryCommands.js";
import { registerCoreNativeCommands } from "./coreNativeCommands.js";
import type { CliInstance } from "./types.js";

/** Register core binary and native deep-analysis CLI commands. */
export const registerCoreAnalysisCommands = (
  cli: CliInstance,
  logger: Logger,
  runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
): void => {
  registerCoreBinaryCommands(cli, logger, runDirectAnalysis);
  registerCoreNativeCommands(cli, logger, runDirectAnalysis);
};
