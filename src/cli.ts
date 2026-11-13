import { parseClientRegistrationCommand } from "./domain/clientRegistrationCommand.js";
import {
  serveMcpRegistration,
  closeCliMcpRegistrationResources,
} from "./cli/mcpRegistration.js";
import { registerToolFamilies } from "./contracts/toolFamilyIds.js";
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
import { registerReleaseExposureCommands } from "./cli/releaseExposureCommands.js";
import { registerGoCommands } from "./cli/goCommands.js";
import { registerModelCommands } from "./cli/modelCommands.js";
import { registerIl2cppCommands } from "./cli/il2cppCommands.js";
import { registerRustCommands } from "./cli/rustCommands.js";
import { registerPythonPycCommands } from "./cli/pythonPycCommands.js";
import { registerErlangCommands } from "./cli/erlangCommands.js";
import { registerUnrealCommands } from "./cli/unrealCommands.js";
import { registerV8CodeCacheCommands } from "./cli/v8CodeCacheCommands.js";
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
import { currentClientRegistrationCommand } from "./application/ClientRegistrationIdentity.js";
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
import { registerDesktopCaptureCommands } from "./cli/desktopCaptureCommands.js";
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
import { validateCliArguments } from "./cli/strictPositionals.js";
import {
  encodeCliArgumentErrors,
  presentCliArgumentErrors,
} from "./cli/argumentErrors.js";
import { completionHelpNote, createCliCompletions } from "./cli/completions.js";
import { reportUnknownMcpSubcommand } from "./cli/mcpBuiltinCommands.js";
import {
  closeCliGuidanceResources,
  registerGuidanceCommands,
} from "./cli/guidanceCommands.js";
import { closeCliJavaScriptResources } from "./cli/javascriptApplicationAnalysis.js";
import { registerGuidedWorkflowCommands } from "./cli/guidedWorkflowCommands.js";

/** Close every process-owned resource used by CLI commands. */
export const closeCliResources = async (): Promise<void> => {
  const results = await Promise.allSettled([
    closeCliJavaScriptResources(),
    closeCliGuidanceResources(),
    closeCliMcpRegistrationResources(),
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "CLI resource cleanup failed");
};

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
  const defaultRegistration = parseClientRegistrationCommand(
    currentClientRegistrationCommand({ environment }),
  );
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
  registerToolFamilies({
    direct: () =>
      registerCoreAnalysisCommands(
        cli,
        logger,
        analysis.runDirectAnalysis,
        environment,
      ),
    // Enhanced workflows are MCP tools. Their CLI entry points live with core analysis.
    enhanced: () => undefined,
    native: () => {
      registerReverseEngineeringCommands(cli, logger, environment);
      registerCutterCommands(cli, logger, environment);
      registerUtilityCommands(cli, logger, environment, analysis);
      registerBinaryDiagnosticsCommands(cli, logger, environment);
    },
    artifact: () => {
      registerWasmCommands(cli, logger, environment);
      registerApkSignatureCommands(cli, logger, environment);
      registerCaptureCommands(cli, logger, environment);
      registerSignalCommands(cli, logger, environment);
      registerEvmCommands(cli, logger, environment);
      registerDesktopApplicationCommands(cli, logger);
      registerReleaseExposureCommands(cli, logger, environment);
      registerGoCommands(cli, logger);
      registerIl2cppCommands(cli, logger);
      registerModelCommands(cli, logger);
      registerGpuCommands(cli, logger);
      registerRustCommands(cli, logger);
      registerPythonPycCommands(cli, logger);
      registerErlangCommands(cli, logger);
      registerUnrealCommands(cli, logger);
      registerV8CodeCacheCommands(cli, logger);
      registerSqliteCommands(cli, logger, environment);
      registerArtifactCommands(cli, logger, analysis.runProviderAnalysis);
    },
    managed: () =>
      registerManagedCommands(cli, logger, analysis.runProviderAnalysis),
    firmware: () => registerFirmwareCommands(cli, logger, environment),
    android: () => registerAndroidCommands(cli, logger, environment),
    pcap: () => registerPcapCommands(cli, logger, environment),
    flutter: () => registerFlutterCommands(cli, logger),
    frida: () => registerFridaCommands(cli, logger, fridaInstrumentation),
    apktool: () => registerApktoolCommands(cli, logger, environment),
    jeb: () => registerJebCommands(cli, logger, environment),
    adb: () => registerAdbCommands(cli, logger, environment),
    browser: () => {
      registerBrowserCommands(cli, logger);
      registerWebRuntimeCommands(cli, logger);
      registerWebNetworkCaptureCommands(cli, logger, environment);
      registerAdvancedBrowserCommands(cli, logger);
      registerBrowserScenarioCommands(cli, logger, environment);
    },
    electron: () => registerElectronCommands(cli, logger, environment),
    "javascript-runtime": () =>
      registerJavaScriptRuntimeObservationCommands(cli, logger, environment),
    application: () => {
      registerGuidanceCommands(cli, logger);
      registerGuidedWorkflowCommands(cli, logger);
      registerAnalysisViewCommands(cli, logger);
      registerEvidenceCommands(cli, logger);
      registerEnvironmentCommands(cli, logger, environment);
      registerProcessCommands(cli, logger, environment);
      registerDesktopCaptureCommands(cli, logger, environment);
      registerJavaScriptRecoveryCommands(cli, logger, environment);
      registerWebScriptCommands(cli, logger);
      registerWebModuleCommands(cli, logger, environment);
      registerWebSourceLocationCommands(cli, logger, environment);
      registerApplicationCommands(cli, logger);
    },
    session: () =>
      registerNativeFunctionMatchingCommands(cli, logger, environment),
  });
  presentOmittableDefaults(cli);
  if (resultOutput !== undefined) streamCliCommandResults(cli, resultOutput);
  const serveStrict = validateCliArguments(cli);
  presentCliArgumentErrors(cli);
  const serveDeclared = excludeDeclaredSensitiveArguments(cli);
  encodeCliArgumentErrors(cli);
  const serve = cli.serve.bind(cli);
  const complete = createCliCompletions(
    cli as unknown as Parameters<typeof createCliCompletions>[0],
    environment,
  );
  cli.serve = (arguments_ = process.argv.slice(2), options) => {
    if (complete(arguments_, options ?? {})) return Promise.resolve();
    const normalized = normalizeCliArguments(arguments_);
    const registration = serveMcpRegistration(
      normalized,
      environment,
      defaultRegistration,
      options ?? {},
    );
    if (registration !== undefined) return registration;
    const result = serveStrict(normalized, options ?? {}, (tokens, selected) =>
      serveDeclared(tokens, selected, (declared, declaredOptions) =>
        reportUnknownMcpSubcommand(cli.name, declared, declaredOptions)
          ? Promise.resolve()
          : serve(adaptCliOutputArgumentsForIncur(declared), declaredOptions),
      ),
    );
    const note = completionHelpNote(normalized);
    if (note === undefined) return result;
    return result.then(() => {
      const write =
        options?.stdout ?? ((text: string) => process.stdout.write(text));
      write(`\n${note}`);
    });
  };
  return cli;
};
