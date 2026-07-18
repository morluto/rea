import { Cli } from "incur";
import { fileURLToPath } from "node:url";

import { createLogger, parseLogLevel } from "./logger.js";
import { PRODUCT_IDENTITY } from "./identity.js";
import { registerSetupCommands } from "./cli/setupCommands.js";
import { registerCoreAnalysisCommands } from "./cli/coreAnalysisCommands.js";
import { registerUtilityCommands } from "./cli/utilityCommands.js";
import { registerArtifactCommands } from "./cli/artifactCommands.js";
import { registerManagedCommands } from "./cli/managedCommands.js";
import { registerInvestigationCommands } from "./cliInvestigationCommands.js";
import { registerEvidenceCommands } from "./cliEvidenceCommands.js";
import { registerProcessCommands } from "./cliProcessCommands.js";
import { registerPolicyCommands } from "./cliPolicyCommands.js";
import { registerBrowserCommands } from "./cliBrowserCommands.js";
import { registerAdvancedBrowserCommands } from "./cliBrowserAdvancedCommands.js";
import { registerElectronCommands } from "./cliElectronCommands.js";
import { registerApplicationCommands } from "./cliApplicationCommands.js";
import type { CliInstance } from "./cli/types.js";

/**
 * Build the one-shot Incur CLI without starting Hopper at import time.
 * Analysis commands acquire and close their own sessions; bare `mcp` and
 * `--mcp` are intercepted by the executable dispatcher before this module loads.
 */
export const createCli = (): CliInstance => {
  const logger = createLogger(
    "cli",
    process.env.REA_LOG_LEVEL === undefined
      ? "silent"
      : parseLogLevel(process.env.REA_LOG_LEVEL),
  );
  const cli = Cli.create(PRODUCT_IDENTITY.cliBinary, {
    version: PRODUCT_IDENTITY.packageVersion,
    description: "Reverse engineer anything from your terminal or agent.",
    mcp: {
      command: PRODUCT_IDENTITY.mcpCommand,
      instructions:
        "Ask what software, artifact, protocol, or behavior the user wants to understand, then choose the available investigation capabilities that can produce evidence.",
    },
    sync: {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      include: ["skills/*"],
      suggestions: [
        "understand how a software feature works",
        "investigate an artifact or observed behavior",
        "check my REA setup",
      ],
    },
  });

  registerSetupCommands(cli, logger);
  registerCoreAnalysisCommands(cli, logger);
  registerUtilityCommands(cli, logger);
  registerArtifactCommands(cli, logger);
  registerManagedCommands(cli, logger);
  registerInvestigationCommands(cli, logger);
  registerEvidenceCommands(cli, logger);
  registerProcessCommands(cli, logger);
  registerPolicyCommands(cli, logger);
  registerBrowserCommands(cli, logger);
  registerAdvancedBrowserCommands(cli, logger);
  registerElectronCommands(cli, logger);
  registerApplicationCommands(cli, logger);
  return cli;
};
