import { Cli } from "incur";

import { createLogger, parseLogLevel } from "./logger.js";
import { PRODUCT_IDENTITY } from "./identity.js";
import { registerSetupCommands } from "./cli/setupCommands.js";
import { registerCoreAnalysisCommands } from "./cli/coreAnalysisCommands.js";
import { registerUtilityCommands } from "./cli/utilityCommands.js";
import { registerArtifactCommands } from "./cli/artifactCommands.js";
import { registerManagedCommands } from "./cli/managedCommands.js";
import { registerFirmwareCommands } from "./cli/firmwareCommands.js";
import { registerAndroidCommands } from "./cli/androidCommands.js";
import { registerEvidenceCommands } from "./cliEvidenceCommands.js";
import { registerProcessCommands } from "./cli/processCommands.js";
import { registerBrowserCommands } from "./cli/browserCommands.js";
import { registerAdvancedBrowserCommands } from "./cli/browserAdvancedCommands.js";
import { registerBrowserScenarioCommands } from "./cliBrowserScenarioCommands.js";
import { registerElectronCommands } from "./cli/electronCommands.js";
import { registerJavaScriptRuntimeObservationCommands } from "./cliJavaScriptRuntimeCommands.js";
import { registerApplicationCommands } from "./cli/applicationCommands.js";
import type { CliInstance } from "./cli/types.js";

/**
 * Build the one-shot Incur CLI without starting Hopper at import time.
 * Analysis commands acquire and close their own sessions; bare `mcp` and
 * `--mcp` are intercepted by the executable dispatcher before this module loads.
 */
export const createCli = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CliInstance => {
  const logger = createLogger(
    "cli",
    environment.REA_LOG_LEVEL === undefined
      ? "silent"
      : parseLogLevel(environment.REA_LOG_LEVEL),
  );
  const cli = Cli.create(PRODUCT_IDENTITY.cliBinary, {
    version: PRODUCT_IDENTITY.packageVersion,
    description: "Reverse engineer anything from your terminal or agent.",
    mcp: {
      command: PRODUCT_IDENTITY.mcpCommand,
      instructions:
        "Ask what software, artifact, protocol, or behavior the user wants to understand, then choose the available investigation capabilities that can produce evidence.",
    },
    sync: false,
  });

  registerSetupCommands(cli, logger);
  registerCoreAnalysisCommands(cli, logger);
  registerUtilityCommands(cli, logger, environment);
  registerArtifactCommands(cli, logger);
  registerManagedCommands(cli, logger);
  registerAndroidCommands(cli, logger, environment);
  registerFirmwareCommands(cli, logger, environment);
  registerEvidenceCommands(cli, logger);
  registerProcessCommands(cli, logger, environment);
  registerBrowserCommands(cli, logger);
  registerAdvancedBrowserCommands(cli, logger);
  registerBrowserScenarioCommands(cli, logger);
  registerElectronCommands(cli, logger);
  registerJavaScriptRuntimeObservationCommands(cli, logger);
  registerApplicationCommands(cli, logger);
  return cli;
};
