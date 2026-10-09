import { snapshotEnvironment } from "./process/snapshotEnvironment.js";
import { createDirectAnalysis } from "./composition/directAnalysis.js";
import { registerEvmCommands } from "./cli/evmCommands.js";
import { registerAnalysisViewCommands } from "./cli/analysisViewCommands.js";
import { registerBinaryDiagnosticsCommands } from "./cli/binaryDiagnosticsCommands.js";
import { Cli } from "incur";

import { createLogger, parseLogLevel } from "./logger.js";
import { PRODUCT_IDENTITY } from "./identity.js";
import { npxRegistrationCommand } from "./application/ClientRegistrationIdentity.js";
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
import { registerWebScriptCommands } from "./cli/webScriptCommands.js";
import { registerWebModuleCommands } from "./cli/webModuleCommands.js";
import { registerWebSourceLocationCommands } from "./cli/webSourceLocationCommands.js";
import { registerWebRuntimeCommands } from "./cli/webRuntimeCommands.js";
import { registerWebNetworkCaptureCommands } from "./cli/webNetworkCaptureCommands.js";
import { registerJavaScriptRecoveryCommands } from "./cli/javascriptRecoveryCommands.js";
import { registerAdvancedBrowserCommands } from "./cli/browserAdvancedCommands.js";
import { registerBrowserScenarioCommands } from "./cliBrowserScenarioCommands.js";
import { registerElectronCommands } from "./cli/electronCommands.js";
import { registerJavaScriptRuntimeObservationCommands } from "./cliJavaScriptRuntimeCommands.js";
import { registerApplicationCommands } from "./cli/applicationCommands.js";
import { presentOmittableDefaults } from "./cli/omittableDefaults.js";
import type { CliInstance } from "./cli/types.js";
import type { CliResultOutput } from "./cli/streamedJsonOutput.js";
import { registerReverseEngineeringCommands } from "./cli/reverseEngineeringCommands.js";

/**
 * Build the one-shot Incur CLI without starting Hopper at import time.
 * Analysis commands acquire and close their own sessions; bare `mcp` and
 * `--mcp` are intercepted by the executable dispatcher before this module loads.
 */
export const createCli = (
  selectedEnvironment: Readonly<
    Record<string, string | undefined>
  > = process.env,
  resultOutput?: CliResultOutput,
): CliInstance => {
  const environment = snapshotEnvironment(selectedEnvironment);
  const analysis = createDirectAnalysis(environment);
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
      command: npxRegistrationCommand().join(" "),
      instructions:
        "Ask what software, artifact, protocol, or behavior the user wants to understand, then choose the available investigation capabilities that can produce evidence.",
    },
    sync: false,
  });

  registerSetupCommands(cli, logger, environment);
  registerReverseEngineeringCommands(cli, logger, environment);
  registerCoreAnalysisCommands(
    cli,
    logger,
    analysis.runDirectAnalysis,
    resultOutput,
  );
  registerUtilityCommands(cli, logger, environment, analysis);
  registerEvmCommands(cli, logger, environment);
  registerArtifactCommands(cli, logger, analysis.runProviderAnalysis);
  registerManagedCommands(cli, logger, analysis.runProviderAnalysis);
  registerAndroidCommands(cli, logger, environment);
  registerFirmwareCommands(cli, logger, environment);
  registerBinaryDiagnosticsCommands(cli, logger, environment);
  registerAnalysisViewCommands(cli, logger);
  registerEvidenceCommands(cli, logger);
  registerProcessCommands(cli, logger, environment);
  registerBrowserCommands(cli, logger);
  registerWebScriptCommands(cli, logger);
  registerWebModuleCommands(cli, logger, environment);
  registerWebSourceLocationCommands(cli, logger, environment);
  registerWebRuntimeCommands(cli, logger);
  registerWebNetworkCaptureCommands(cli, logger, environment);
  registerJavaScriptRecoveryCommands(cli, logger, environment);
  registerAdvancedBrowserCommands(cli, logger);
  registerBrowserScenarioCommands(cli, logger, environment);
  registerElectronCommands(cli, logger, environment, resultOutput);
  registerJavaScriptRuntimeObservationCommands(cli, logger);
  registerApplicationCommands(cli, logger);
  presentOmittableDefaults(cli);
  return cli;
};
