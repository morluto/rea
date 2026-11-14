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
import { registerV8CodeCacheCommands } from "./cli/v8CodeCacheCommands.js";
import { registerSqliteCommands } from "./cli/sqliteCommands.js";
import { registerAnalysisViewCommands } from "./cli/analysisViewCommands.js";
import { registerBinaryDiagnosticsCommands } from "./cli/binaryDiagnosticsCommands.js";
import { registerFridaCommands } from "./cli/fridaCommands.js";
import type { FridaInstrumentationPort } from "./application/frida/FridaInstrumentationPort.js";
import { estimateTokenCount } from "tokenx";
import { sliceTextByTokenWindow } from "./cli/tokenWindow.js";
import { Cli, Schema, z } from "incur";
import {
  adaptCliOutputArgumentsForIncur,
  normalizeCliArguments,
  splitIncurBuiltinArguments,
} from "./cliBuiltinArguments.js";
import {
  parseCliOutputArguments,
  renderCliDocument,
} from "./cliOutput.js";

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
import {
  jsonCommandSchemas,
  registerApplicationCommands,
} from "./cli/applicationCommands.js";
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

/** Global options schema, shared by registration and `--schema` documents. */
const cliGlobalsSchema = z.object({
  timings: z
    .boolean()
    .default(false)
    .describe("Write measured command timing to stderr."),
});

/**
 * Convert an input-document schema the way the MCP tool contracts do: a
 * field with a default is optional for the caller supplying the document.
 * Incur's own conversion uses output semantics, which would mark those
 * fields required and reject valid inputs.
 */
const toInputJsonSchema = (schema: z.ZodType): Record<string, unknown> => {
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(schema, {
    io: "input",
  });
  return jsonSchema;
};

/**
 * Answer `--schema` for JSON-input commands from their registered input
 * schemas. Incur derives `--schema` from a command's positional `args`,
 * which for these commands is only the `inputJson: string` wrapper, so
 * callers would never see the document the command actually accepts. The
 * document is JSON Schema even without `--json`: callers ask for a
 * machine-readable schema, and Incur's default TOON rendering is not one.
 * Help, version, and manifest flags keep Incur's precedence. Token controls
 * are applied by the executable's SDK-document handling when a result
 * output exists: arming it here lets it capture this write exactly like
 * Incur's own schema output. Without one (in-process use), the controls
 * are applied here with the same rules — a count wins over a window, and
 * a window only reaches this point for formats the output controls allow
 * it on (JSON, YAML, and JSONL windows are rejected before dispatch).
 */
const writeJsonCommandSchema = (
  arguments_: readonly string[],
  options:
    | { readonly stdout?: ((text: string) => void) | undefined }
    | undefined,
  resultOutput?: CliResultOutput | undefined,
): boolean => {
  const { command, flags } = splitIncurBuiltinArguments(arguments_);
  if (!flags.has("--schema")) return false;
  if (
    flags.has("--help") ||
    flags.has("-h") ||
    flags.has("--version") ||
    flags.has("--llms") ||
    flags.has("--llms-full") ||
    flags.has("--mcp") ||
    flags.has("--update")
  )
    return false;
  const builtin = command[0] === PRODUCT_IDENTITY.cliBinary ? 1 : 0;
  const name = command[builtin];
  if (name === undefined) return false;
  const entry = jsonCommandSchemas.get(name);
  if (entry === undefined) return false;
  const output = parseCliOutputArguments(arguments_);
  if (!output.validation.ok) return false;
  if (output.format === "csv" || output.format === "tsv") return false;
  const document: Record<string, unknown> = {
    args: toInputJsonSchema(entry.inputSchema),
    ...(entry.optionsSchema === undefined
      ? {}
      : { options: Schema.toJsonSchema(entry.optionsSchema) }),
    globals: Schema.toJsonSchema(cliGlobalsSchema),
  };
  const format = output.formatExplicit ? output.format : "json";
  const text = renderCliDocument(
    document,
    format,
    process.stdout.isTTY === true,
  );
  const write =
    options?.stdout ?? ((value: string) => process.stdout.write(value));
  if (output.tokenCount || output.tokenWindow) {
    if (resultOutput !== undefined) {
      resultOutput.sdkArguments(arguments_);
    } else if (output.tokenCount) {
      write(`${estimateTokenCount(text)}\n`);
      return true;
    } else if (output.tokenWindow) {
      const window = sliceTextByTokenWindow(
        text,
        output.tokenOffset ?? 0,
        output.tokenLimit,
      );
      write(
        window.truncated
          ? `${window.text}\n[truncated: showing tokens ${window.start}–${window.end} of ${window.total}]\n`
          : text,
      );
      return true;
    }
  }
  write(text.endsWith("\n") ? text : `${text}\n`);
  return true;
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
    globals: cliGlobalsSchema,
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
    if (writeJsonCommandSchema(normalized, options, resultOutput))
      return Promise.resolve();
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
