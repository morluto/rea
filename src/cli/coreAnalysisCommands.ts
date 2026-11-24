import type { DirectAnalysis } from "../composition/directAnalysis.js";
import type { Logger } from "pino";
import { registerCoreBinaryCommands } from "./coreBinaryCommands.js";
import { registerCoreNativeCommands } from "./coreNativeCommands.js";
import type { CliInstance } from "./types.js";
import type { CliJavaScriptAnalysisHost } from "./javascriptApplicationAnalysis.js";

/** Register core binary and native deep-analysis CLI commands. */
export const registerCoreAnalysisCommands = (
  cli: CliInstance,
  logger: Logger,
  runDirectAnalysis: DirectAnalysis["runDirectAnalysis"],
  environment: Readonly<Record<string, string | undefined>>,
  javascriptAnalysis?: CliJavaScriptAnalysisHost,
): void => {
  registerCoreBinaryCommands(
    cli,
    logger,
    runDirectAnalysis,
    environment,
    javascriptAnalysis,
  );
  registerCoreNativeCommands(cli, logger, runDirectAnalysis);
};
