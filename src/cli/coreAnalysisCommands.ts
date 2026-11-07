import type { DirectAnalysis } from "../composition/directAnalysis.js";
import type { Logger } from "pino";
import { registerCoreBinaryCommands } from "./coreBinaryCommands.js";
import { registerCoreNativeCommands } from "./coreNativeCommands.js";
import { registerProfileCommands } from "./profileCommands.js";
import type { CliInstance } from "./types.js";

/** Register core binary and native deep-analysis CLI commands. */
export const registerCoreAnalysisCommands = (
  cli: CliInstance,
  logger: Logger,
  runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  registerCoreBinaryCommands(cli, logger, runDirectAnalysis, environment);
  registerCoreNativeCommands(cli, logger, runDirectAnalysis);
  // Provider-free: a profile is established from the target's own header, so it
  // must still work when no analysis provider can open the target.
  registerProfileCommands(cli, logger);
};
