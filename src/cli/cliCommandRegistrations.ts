import {
  TOOL_FAMILY_IDS,
  type ToolFamilyId,
} from "../contracts/toolFamilyIds.js";
import {
  cliRegistrar,
  cliRegistrarWithEnvironment,
  plain,
  withAnalysis,
} from "./cliCommandRegistration.js";

/** Every CLI command registrar; see `cliLoader.ts` for one-shot loading. */
export const CLI_COMMAND_REGISTRATIONS = {
  setup: plain(
    () => import("./setupCommands.js"),
    (module, context) =>
      module.registerSetupCommands(
        context.cli,
        context.logger,
        context.environment,
        context.savedDefaults,
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
  reverseEngineering: cliRegistrarWithEnvironment(
    () => import("./reverseEngineeringCommands.js"),
    "registerReverseEngineeringCommands",
  ),
  cutter: cliRegistrarWithEnvironment(
    () => import("./cutterCommands.js"),
    "registerCutterCommands",
  ),
  userConfig: cliRegistrarWithEnvironment(
    () => import("./userConfigCommands.js"),
    "registerUserConfigCommands",
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
  binaryDiagnostics: cliRegistrarWithEnvironment(
    () => import("./binaryDiagnosticsCommands.js"),
    "registerBinaryDiagnosticsCommands",
  ),
  wasm: cliRegistrarWithEnvironment(
    () => import("./wasmCommands.js"),
    "registerWasmCommands",
  ),
  apkSignature: cliRegistrarWithEnvironment(
    () => import("./apkSignatureCommands.js"),
    "registerApkSignatureCommands",
  ),
  capture: cliRegistrarWithEnvironment(
    () => import("./captureCommands.js"),
    "registerCaptureCommands",
  ),
  signal: cliRegistrarWithEnvironment(
    () => import("./signalCommands.js"),
    "registerSignalCommands",
  ),
  evm: cliRegistrarWithEnvironment(
    () => import("./evmCommands.js"),
    "registerEvmCommands",
  ),
  desktopApplication: cliRegistrar(
    () => import("./desktopApplicationCommands.js"),
    "registerDesktopApplicationCommands",
  ),
  releaseExposure: cliRegistrarWithEnvironment(
    () => import("./releaseExposureCommands.js"),
    "registerReleaseExposureCommands",
  ),
  go: cliRegistrar(() => import("./goCommands.js"), "registerGoCommands"),
  il2cpp: cliRegistrar(
    () => import("./il2cppCommands.js"),
    "registerIl2cppCommands",
  ),
  model: cliRegistrar(
    () => import("./modelCommands.js"),
    "registerModelCommands",
  ),
  gpu: cliRegistrar(() => import("./gpuCommands.js"), "registerGpuCommands"),
  rust: cliRegistrar(() => import("./rustCommands.js"), "registerRustCommands"),
  pythonPyc: cliRegistrar(
    () => import("./pythonPycCommands.js"),
    "registerPythonPycCommands",
  ),
  debPackage: cliRegistrar(
    () => import("./debPackageCommands.js"),
    "registerDebPackageCommands",
  ),
  nugetNupkg: cliRegistrar(
    () => import("./nugetNupkgCommands.js"),
    "registerNugetNupkgCommands",
  ),
  vsixPackage: cliRegistrar(
    () => import("./vsixPackageCommands.js"),
    "registerVsixPackageCommands",
  ),
  ociImageLayout: cliRegistrar(
    () => import("./ociImageLayoutCommands.js"),
    "registerOciImageLayoutCommands",
  ),
  erlang: cliRegistrar(
    () => import("./erlangCommands.js"),
    "registerErlangCommands",
  ),
  v8CodeCache: cliRegistrar(
    () => import("./v8CodeCacheCommands.js"),
    "registerV8CodeCacheCommands",
  ),
  mavenGradleMetadata: cliRegistrar(
    () => import("./mavenGradleMetadataCommands.js"),
    "registerMavenGradleMetadataCommands",
  ),
  sqlite: cliRegistrarWithEnvironment(
    () => import("./sqliteCommands.js"),
    "registerSqliteCommands",
  ),
  artifact: withAnalysis(
    () => import("./artifactCommands.js"),
    (module, context) =>
      module.registerArtifactCommands(
        context.cli,
        context.logger,
        context.analysis.runProviderAnalysis,
        context.environment,
      ),
  ),
  managed: withAnalysis(
    () => import("./managedCommands.js"),
    (module, context) =>
      module.registerManagedCommands(
        context.cli,
        context.logger,
        context.analysis,
      ),
  ),
  firmware: cliRegistrarWithEnvironment(
    () => import("./firmwareCommands.js"),
    "registerFirmwareCommands",
  ),
  uefi: cliRegistrar(() => import("./uefiCommands.js"), "registerUefiCommands"),
  android: cliRegistrarWithEnvironment(
    () => import("./androidCommands.js"),
    "registerAndroidCommands",
  ),
  pcap: cliRegistrarWithEnvironment(
    () => import("./pcapCommands.js"),
    "registerPcapCommands",
  ),
  flutter: cliRegistrar(
    () => import("./flutterCommands.js"),
    "registerFlutterCommands",
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
  apktool: cliRegistrarWithEnvironment(
    () => import("./apktoolCommands.js"),
    "registerApktoolCommands",
  ),
  jeb: cliRegistrarWithEnvironment(
    () => import("./jebCommands.js"),
    "registerJebCommands",
  ),
  adb: cliRegistrarWithEnvironment(
    () => import("./adbCommands.js"),
    "registerAdbCommands",
  ),
  browser: cliRegistrarWithEnvironment(
    () => import("./browserCommands.js"),
    "registerBrowserCommands",
  ),
  webRuntime: cliRegistrar(
    () => import("./webRuntimeCommands.js"),
    "registerWebRuntimeCommands",
  ),
  webNetworkCapture: cliRegistrarWithEnvironment(
    () => import("./webNetworkCaptureCommands.js"),
    "registerWebNetworkCaptureCommands",
  ),
  advancedBrowser: cliRegistrar(
    () => import("./browserAdvancedCommands.js"),
    "registerAdvancedBrowserCommands",
  ),
  browserScenario: cliRegistrarWithEnvironment(
    () => import("./browserScenarioCommands.js"),
    "registerBrowserScenarioCommands",
  ),
  electron: cliRegistrarWithEnvironment(
    () => import("./electronCommands.js"),
    "registerElectronCommands",
  ),
  javaScriptRuntimeObservation: cliRegistrarWithEnvironment(
    () => import("./javascriptRuntimeCommands.js"),
    "registerJavaScriptRuntimeObservationCommands",
  ),
  guidance: cliRegistrar(
    () => import("./guidanceCommands.js"),
    "registerGuidanceCommands",
  ),
  guidedWorkflow: cliRegistrar(
    () => import("./guidedWorkflowCommands.js"),
    "registerGuidedWorkflowCommands",
  ),
  sourceToBundle: cliRegistrar(
    () => import("./sourceToBundleCommand.js"),
    "registerSourceToBundleCommand",
  ),
  staticObservedEndpoints: cliRegistrar(
    () => import("./staticObservedEndpointsCommand.js"),
    "registerStaticObservedEndpointsCommand",
  ),
  analysisView: cliRegistrar(
    () => import("./analysisViewCommands.js"),
    "registerAnalysisViewCommands",
  ),
  evidence: cliRegistrar(
    () => import("./evidenceCommands.js"),
    "registerEvidenceCommands",
  ),
  environment: cliRegistrarWithEnvironment(
    () => import("./environmentCommands.js"),
    "registerEnvironmentCommands",
  ),
  process: cliRegistrarWithEnvironment(
    () => import("./processCommands.js"),
    "registerProcessCommands",
  ),
  desktopCapture: cliRegistrarWithEnvironment(
    () => import("./desktopCaptureCommands.js"),
    "registerDesktopCaptureCommands",
  ),
  javaScriptRecovery: cliRegistrarWithEnvironment(
    () => import("./javascriptRecoveryCommands.js"),
    "registerJavaScriptRecoveryCommands",
  ),
  webScript: cliRegistrar(
    () => import("./webScriptCommands.js"),
    "registerWebScriptCommands",
  ),
  webModule: cliRegistrarWithEnvironment(
    () => import("./webModuleCommands.js"),
    "registerWebModuleCommands",
  ),
  webSourceLocation: cliRegistrarWithEnvironment(
    () => import("./webSourceLocationCommands.js"),
    "registerWebSourceLocationCommands",
  ),
  application: cliRegistrar(
    () => import("./applicationCommands.js"),
    "registerApplicationCommands",
  ),
  nativeFunctionMatching: cliRegistrarWithEnvironment(
    () => import("./nativeFunctionMatchingCommands.js"),
    "registerNativeFunctionMatchingCommands",
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
  setup: ["setup", "userConfig"],
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
    "debPackage",
    "nugetNupkg",
    "vsixPackage",
    "ociImageLayout",
    "erlang",
    "v8CodeCache",
    "mavenGradleMetadata",
    "sqlite",
    "artifact",
  ],
  managed: ["managed"],
  firmware: ["firmware"],
  uefi: ["uefi"],
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
    "sourceToBundle",
    "staticObservedEndpoints",
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
