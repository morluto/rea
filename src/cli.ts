import { registerGpuCommands } from "./cli/gpuCommands.js";
import { registerNativeFunctionMatchingCommands } from "./cli/nativeFunctionMatchingCommands.js";
import { registerCaptureCommands } from "./cli/captureCommands.js";
import { registerSignalCommands } from "./cli/signalCommands.js";
import { registerWasmCommands } from "./cli/wasmCommands.js";
import { registerApkSignatureCommands } from "./cli/apkSignatureCommands.js";
import { snapshotEnvironment } from "./process/snapshotEnvironment.js";
import { createDirectAnalysis } from "./composition/directAnalysis.js";
import { registerEvmCommands } from "./cli/evmCommands.js";
import { registerDesktopApplicationCommands } from "./cli/desktopApplicationCommands.js";
import { registerGoCommands } from "./cli/goCommands.js";
import { registerModelCommands } from "./cli/modelCommands.js";
import { registerIl2cppCommands } from "./cli/il2cppCommands.js";
import { registerRustCommands } from "./cli/rustCommands.js";
import { registerPythonPycCommands } from "./cli/pythonPycCommands.js";
import { registerErlangCommands } from "./cli/erlangCommands.js";
import { registerSqliteCommands } from "./cli/sqliteCommands.js";
import { registerAnalysisViewCommands } from "./cli/analysisViewCommands.js";
import { registerBinaryDiagnosticsCommands } from "./cli/binaryDiagnosticsCommands.js";
import { registerFridaCommands } from "./cli/fridaCommands.js";
import type { FridaInstrumentationPort } from "./application/frida/FridaInstrumentationPort.js";
import { Cli, z } from "incur";
import {
  adaptCliOutputArgumentsForIncur,
  normalizeCliArguments,
} from "./cliBuiltinArguments.js";

import { createLogger } from "./logger.js";
import { parseLogLevel } from "./config/processStart.js";
import { PRODUCT_IDENTITY } from "./identity.js";
import { npxRegistrationCommand } from "./application/ClientRegistrationIdentity.js";
import { registerSetupCommands } from "./cli/setupCommands.js";
import { registerCoreAnalysisCommands } from "./cli/coreAnalysisCommands.js";
import { registerUtilityCommands } from "./cli/utilityCommands.js";
import { registerArtifactCommands } from "./cli/artifactCommands.js";
import { registerManagedCommands } from "./cli/managedCommands.js";
import { registerFirmwareCommands } from "./cli/firmwareCommands.js";
import { registerAndroidCommands } from "./cli/androidCommands.js";
import { registerApktoolCommands } from "./cli/apktoolCommands.js";
import { registerPcapCommands } from "./cli/pcapCommands.js";
import { registerFlutterCommands } from "./cli/flutterCommands.js";
import { registerJebCommands } from "./cli/jebCommands.js";
import { registerAdbCommands } from "./cli/adbCommands.js";
import { registerEvidenceCommands } from "./cliEvidenceCommands.js";
import { registerEnvironmentCommands } from "./cli/environmentCommands.js";
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
import { registerJavaScriptRuntimeObservationCommands } from "./cli/javascriptRuntimeCommands.js";
import { registerApplicationCommands } from "./cli/applicationCommands.js";
import { presentOmittableDefaults } from "./cli/omittableDefaults.js";
import type { CliInstance } from "./cli/types.js";
import {
  streamCliCommandResults,
  type CliResultOutput,
} from "./cli/cliResultOutput.js";
import { registerReverseEngineeringCommands } from "./cli/reverseEngineeringCommands.js";
import { registerCutterCommands } from "./cli/cutterCommands.js";
import { excludeDeclaredSensitiveArguments } from "./cli/explicitSensitiveArguments.js";
import { rejectSurplusCliArguments } from "./cli/strictPositionals.js";
import { presentCliArgumentErrors } from "./cli/argumentErrors.js";
import { createCliCompletions } from "./cli/completions.js";
import { registerGuidedWorkflowCommands } from "./cli/guidedWorkflowCommands.js";

export { closeCliJavaScriptResources } from "./cli/javascriptApplicationAnalysis.js";

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
  fridaInstrumentation?: FridaInstrumentationPort,
): CliInstance => {
  const environment = snapshotEnvironment(selectedEnvironment);
  const analysis = createDirectAnalysis(environment);
  // The executable reports an invalid level before every command except doctor.
  // Doctor keeps going so its readiness report can name REA_LOG_LEVEL.
  const level =
    environment.REA_LOG_LEVEL === undefined
      ? undefined
      : parseLogLevel(environment.REA_LOG_LEVEL);
  const logger = createLogger(
    "cli",
    level?.ok === true ? level.value : "silent",
  );
  const timedCli = Cli.create(PRODUCT_IDENTITY.cliBinary, {
    version: PRODUCT_IDENTITY.packageVersion,
    description: "Reverse engineer anything from your terminal or agent.",
    globals: z.object({
      timings: z
        .boolean()
        .default(false)
        .describe("Write measured command timing to stderr."),
    }),
    mcp: {
      command: npxRegistrationCommand().join(" "),
      instructions:
        "Ask what software, artifact, protocol, or behavior the user wants to understand, then choose the available investigation capabilities that can produce evidence.",
    },
    sync: false,
    update: {
      // Incur's update:false only suppresses notices. Reject its explicit
      // installer so ambiguous flags cannot bypass REA's verified workflow.
      install: () => {
        throw new Error(
          "Use 'rea update' to update the identified installation. The '--update' alias accepts only global output flags.",
        );
      },
    },
  });

  timedCli.use(async (context, next) => {
    if (!context.globals.timings) return next();
    const started = performance.now();
    try {
      await next();
    } finally {
      // This interval covers CLI command dispatch, including result delivery.
      // It is not a provider-only or analysis-only measurement.
      process.stderr.write(
        `${JSON.stringify({ rea_timings: { version: 1, command_ms: Math.round(performance.now() - started) } })}\n`,
      );
    }
  });
  // Command registrars do not inspect global options; preserve their existing
  // type while Incur owns parsing and the middleware owns this added flag.
  const cli = timedCli as unknown as CliInstance;

  registerSetupCommands(cli, logger, environment);
  registerGuidedWorkflowCommands(cli, logger);
  registerReverseEngineeringCommands(cli, logger, environment);
  registerCutterCommands(cli, logger, environment);
  registerCoreAnalysisCommands(
    cli,
    logger,
    analysis.runDirectAnalysis,
    environment,
  );
  registerUtilityCommands(cli, logger, environment, analysis);
  registerWasmCommands(cli, logger, environment);
  registerApkSignatureCommands(cli, logger, environment);
  registerCaptureCommands(cli, logger, environment);
  registerSignalCommands(cli, logger, environment);
  registerEvmCommands(cli, logger, environment);
  registerDesktopApplicationCommands(cli, logger);
  registerGoCommands(cli, logger);
  registerIl2cppCommands(cli, logger);
  registerModelCommands(cli, logger);
  registerGpuCommands(cli, logger);
  registerRustCommands(cli, logger);
  registerPythonPycCommands(cli, logger);
  registerErlangCommands(cli, logger);
  registerSqliteCommands(cli, logger, environment);
  registerArtifactCommands(cli, logger, analysis.runProviderAnalysis);
  registerManagedCommands(cli, logger, analysis.runProviderAnalysis);
  registerAndroidCommands(cli, logger, environment);
  registerApktoolCommands(cli, logger, environment);
  registerPcapCommands(cli, logger, environment);
  registerFlutterCommands(cli, logger);
  registerJebCommands(cli, logger, environment);
  registerAdbCommands(cli, logger, environment);
  registerFirmwareCommands(cli, logger, environment);
  registerBinaryDiagnosticsCommands(cli, logger, environment);
  registerAnalysisViewCommands(cli, logger);
  registerNativeFunctionMatchingCommands(cli, logger, environment);
  registerFridaCommands(cli, logger, fridaInstrumentation);
  registerEvidenceCommands(cli, logger);
  registerEnvironmentCommands(cli, logger, environment);
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
  registerElectronCommands(cli, logger, environment);
  registerJavaScriptRuntimeObservationCommands(cli, logger, environment);
  registerApplicationCommands(cli, logger);
  presentOmittableDefaults(cli);
  if (resultOutput !== undefined) streamCliCommandResults(cli, resultOutput);
  const serveStrict = rejectSurplusCliArguments(cli);
  presentCliArgumentErrors(cli);
  const serveDeclared = excludeDeclaredSensitiveArguments(cli);
  const serve = cli.serve.bind(cli);
  const complete = createCliCompletions(
    cli as unknown as Parameters<typeof createCliCompletions>[0],
    environment,
  );
  cli.serve = (arguments_ = process.argv.slice(2), options) =>
    complete(arguments_, options ?? {})
      ? Promise.resolve()
      : serveStrict(
          normalizeCliArguments(arguments_),
          options ?? {},
          (tokens, selected) =>
            serveDeclared(tokens, selected, (declared, declaredOptions) =>
              serve(adaptCliOutputArgumentsForIncur(declared), declaredOptions),
            ),
        );
  return cli;
};
