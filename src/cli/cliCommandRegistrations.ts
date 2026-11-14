import {
  TOOL_FAMILY_IDS,
  type ToolFamilyId,
} from "../contracts/toolFamilyIds.js";
import { plain, withAnalysis } from "./cliCommandRegistration.js";

/** Every CLI command registrar; see `cliLoader.ts` for one-shot loading. */
export const CLI_COMMAND_REGISTRATIONS = {
  setup: plain(
    () => import("./setupCommands.js"),
    (module, context) =>
      module.registerSetupCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  coreAnalysis: withAnalysis(
    () => import("./coreAnalysisCommands.js"),
    (module, context) =>
      module.registerCoreAnalysisCommands(
        context.cli,
        context.logger,
        context.analysis.runDirectAnalysis,
        context.environment,
      ),
  ),
  reverseEngineering: plain(
    () => import("./reverseEngineeringCommands.js"),
    (module, context) =>
      module.registerReverseEngineeringCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  cutter: plain(
    () => import("./cutterCommands.js"),
    (module, context) =>
      module.registerCutterCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  utility: withAnalysis(
    () => import("./utilityCommands.js"),
    (module, context) =>
      module.registerUtilityCommands(
        context.cli,
        context.logger,
        context.environment,
        context.analysis,
      ),
  ),
  binaryDiagnostics: plain(
    () => import("./binaryDiagnosticsCommands.js"),
    (module, context) =>
      module.registerBinaryDiagnosticsCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  wasm: plain(
    () => import("./wasmCommands.js"),
    (module, context) =>
      module.registerWasmCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  apkSignature: plain(
    () => import("./apkSignatureCommands.js"),
    (module, context) =>
      module.registerApkSignatureCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  capture: plain(
    () => import("./captureCommands.js"),
    (module, context) =>
      module.registerCaptureCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  signal: plain(
    () => import("./signalCommands.js"),
    (module, context) =>
      module.registerSignalCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  evm: plain(
    () => import("./evmCommands.js"),
    (module, context) =>
      module.registerEvmCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  desktopApplication: plain(
    () => import("./desktopApplicationCommands.js"),
    (module, context) =>
      module.registerDesktopApplicationCommands(context.cli, context.logger),
  ),
  releaseExposure: plain(
    () => import("./releaseExposureCommands.js"),
    (module, context) =>
      module.registerReleaseExposureCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  go: plain(
    () => import("./goCommands.js"),
    (module, context) => module.registerGoCommands(context.cli, context.logger),
  ),
  il2cpp: plain(
    () => import("./il2cppCommands.js"),
    (module, context) =>
      module.registerIl2cppCommands(context.cli, context.logger),
  ),
  model: plain(
    () => import("./modelCommands.js"),
    (module, context) =>
      module.registerModelCommands(context.cli, context.logger),
  ),
  gpu: plain(
    () => import("./gpuCommands.js"),
    (module, context) =>
      module.registerGpuCommands(context.cli, context.logger),
  ),
  rust: plain(
    () => import("./rustCommands.js"),
    (module, context) =>
      module.registerRustCommands(context.cli, context.logger),
  ),
  pythonPyc: plain(
    () => import("./pythonPycCommands.js"),
    (module, context) =>
      module.registerPythonPycCommands(context.cli, context.logger),
  ),
  erlang: plain(
    () => import("./erlangCommands.js"),
    (module, context) =>
      module.registerErlangCommands(context.cli, context.logger),
  ),
  v8CodeCache: plain(
    () => import("./v8CodeCacheCommands.js"),
    (module, context) =>
      module.registerV8CodeCacheCommands(context.cli, context.logger),
  ),
  sqlite: plain(
    () => import("./sqliteCommands.js"),
    (module, context) =>
      module.registerSqliteCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  artifact: withAnalysis(
    () => import("./artifactCommands.js"),
    (module, context) =>
      module.registerArtifactCommands(
        context.cli,
        context.logger,
        context.analysis.runProviderAnalysis,
      ),
  ),
  managed: withAnalysis(
    () => import("./managedCommands.js"),
    (module, context) =>
      module.registerManagedCommands(
        context.cli,
        context.logger,
        context.analysis.runProviderAnalysis,
      ),
  ),
  firmware: plain(
    () => import("./firmwareCommands.js"),
    (module, context) =>
      module.registerFirmwareCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  android: plain(
    () => import("./androidCommands.js"),
    (module, context) =>
      module.registerAndroidCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  pcap: plain(
    () => import("./pcapCommands.js"),
    (module, context) =>
      module.registerPcapCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  flutter: plain(
    () => import("./flutterCommands.js"),
    (module, context) =>
      module.registerFlutterCommands(context.cli, context.logger),
  ),
  frida: plain(
    () => import("./fridaCommands.js"),
    (module, context) =>
      module.registerFridaCommands(
        context.cli,
        context.logger,
        context.fridaInstrumentation,
      ),
  ),
  apktool: plain(
    () => import("./apktoolCommands.js"),
    (module, context) =>
      module.registerApktoolCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  jeb: plain(
    () => import("./jebCommands.js"),
    (module, context) =>
      module.registerJebCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  adb: plain(
    () => import("./adbCommands.js"),
    (module, context) =>
      module.registerAdbCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  browser: plain(
    () => import("./browserCommands.js"),
    (module, context) =>
      module.registerBrowserCommands(context.cli, context.logger),
  ),
  webRuntime: plain(
    () => import("./webRuntimeCommands.js"),
    (module, context) =>
      module.registerWebRuntimeCommands(context.cli, context.logger),
  ),
  webNetworkCapture: plain(
    () => import("./webNetworkCaptureCommands.js"),
    (module, context) =>
      module.registerWebNetworkCaptureCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  advancedBrowser: plain(
    () => import("./browserAdvancedCommands.js"),
    (module, context) =>
      module.registerAdvancedBrowserCommands(context.cli, context.logger),
  ),
  browserScenario: plain(
    () => import("../cliBrowserScenarioCommands.js"),
    (module, context) =>
      module.registerBrowserScenarioCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  electron: plain(
    () => import("./electronCommands.js"),
    (module, context) =>
      module.registerElectronCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  javaScriptRuntimeObservation: plain(
    () => import("./javascriptRuntimeCommands.js"),
    (module, context) =>
      module.registerJavaScriptRuntimeObservationCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  guidance: plain(
    () => import("./guidanceCommands.js"),
    (module, context) =>
      module.registerGuidanceCommands(context.cli, context.logger),
  ),
  guidedWorkflow: plain(
    () => import("./guidedWorkflowCommands.js"),
    (module, context) =>
      module.registerGuidedWorkflowCommands(context.cli, context.logger),
  ),
  analysisView: plain(
    () => import("./analysisViewCommands.js"),
    (module, context) =>
      module.registerAnalysisViewCommands(context.cli, context.logger),
  ),
  evidence: plain(
    () => import("../cliEvidenceCommands.js"),
    (module, context) =>
      module.registerEvidenceCommands(context.cli, context.logger),
  ),
  environment: plain(
    () => import("./environmentCommands.js"),
    (module, context) =>
      module.registerEnvironmentCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  process: plain(
    () => import("./processCommands.js"),
    (module, context) =>
      module.registerProcessCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  desktopCapture: plain(
    () => import("./desktopCaptureCommands.js"),
    (module, context) =>
      module.registerDesktopCaptureCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  javaScriptRecovery: plain(
    () => import("./javascriptRecoveryCommands.js"),
    (module, context) =>
      module.registerJavaScriptRecoveryCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  webScript: plain(
    () => import("./webScriptCommands.js"),
    (module, context) =>
      module.registerWebScriptCommands(context.cli, context.logger),
  ),
  webModule: plain(
    () => import("./webModuleCommands.js"),
    (module, context) =>
      module.registerWebModuleCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  webSourceLocation: plain(
    () => import("./webSourceLocationCommands.js"),
    (module, context) =>
      module.registerWebSourceLocationCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
  application: plain(
    () => import("./applicationCommands.js"),
    (module, context) =>
      module.registerApplicationCommands(context.cli, context.logger),
  ),
  nativeFunctionMatching: plain(
    () => import("./nativeFunctionMatchingCommands.js"),
    (module, context) =>
      module.registerNativeFunctionMatchingCommands(
        context.cli,
        context.logger,
        context.environment,
      ),
  ),
};

export type CliCommandRegistrationId = keyof typeof CLI_COMMAND_REGISTRATIONS;

/** Each registrar's module, as `load` resolves it. */
export type CliCommandModules = {
  readonly [Id in CliCommandRegistrationId]: Awaited<
    ReturnType<(typeof CLI_COMMAND_REGISTRATIONS)[Id]["load"]>
  >;
};

/**
 * Registrars of setup and of each published tool family. Every family id must
 * appear, so a new family decides its CLI commands; enhanced workflows are
 * MCP tools whose CLI entry points live with core analysis.
 */
const CLI_FAMILY_REGISTRATIONS: {
  readonly [
    Family in "setup" | ToolFamilyId
  ]: readonly CliCommandRegistrationId[];
} = {
  setup: ["setup"],
  direct: ["coreAnalysis"],
  enhanced: [],
  native: ["reverseEngineering", "cutter", "utility", "binaryDiagnostics"],
  artifact: [
    "wasm",
    "apkSignature",
    "capture",
    "signal",
    "evm",
    "desktopApplication",
    "releaseExposure",
    "go",
    "il2cpp",
    "model",
    "gpu",
    "rust",
    "pythonPyc",
    "erlang",
    "v8CodeCache",
    "sqlite",
    "artifact",
  ],
  managed: ["managed"],
  firmware: ["firmware"],
  android: ["android"],
  pcap: ["pcap"],
  flutter: ["flutter"],
  frida: ["frida"],
  apktool: ["apktool"],
  jeb: ["jeb"],
  adb: ["adb"],
  browser: [
    "browser",
    "webRuntime",
    "webNetworkCapture",
    "advancedBrowser",
    "browserScenario",
  ],
  electron: ["electron"],
  "javascript-runtime": ["javaScriptRuntimeObservation"],
  application: [
    "guidance",
    "guidedWorkflow",
    "analysisView",
    "evidence",
    "environment",
    "process",
    "desktopCapture",
    "javaScriptRecovery",
    "webScript",
    "webModule",
    "webSourceLocation",
    "application",
  ],
  session: ["nativeFunctionMatching"],
};

/** Registration order: setup, then each family in catalog order. */
export const CLI_REGISTRATION_ORDER: readonly CliCommandRegistrationId[] = [
  "setup" as const,
  ...TOOL_FAMILY_IDS,
].flatMap((family) => CLI_FAMILY_REGISTRATIONS[family]);
