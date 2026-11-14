import type { FridaInstrumentationPort } from "./application/frida/FridaInstrumentationPort.js";
import {
  CLI_COMMAND_REGISTRATIONS,
  CLI_REGISTRATION_ORDER,
  type CliCommandModules,
} from "./cli/cliCommandRegistrations.js";
import type { CliResultOutput } from "./cli/cliResultOutput.js";
import { createCliShell } from "./cli/cliShell.js";
import type { CliInstance } from "./cli/types.js";
import { createDirectAnalysis } from "./composition/directAnalysis.js";
import * as setupModule from "./cli/setupCommands.js";
import * as coreAnalysisModule from "./cli/coreAnalysisCommands.js";
import * as reverseEngineeringModule from "./cli/reverseEngineeringCommands.js";
import * as cutterModule from "./cli/cutterCommands.js";
import * as utilityModule from "./cli/utilityCommands.js";
import * as binaryDiagnosticsModule from "./cli/binaryDiagnosticsCommands.js";
import * as wasmModule from "./cli/wasmCommands.js";
import * as apkSignatureModule from "./cli/apkSignatureCommands.js";
import * as captureModule from "./cli/captureCommands.js";
import * as signalModule from "./cli/signalCommands.js";
import * as evmModule from "./cli/evmCommands.js";
import * as desktopApplicationModule from "./cli/desktopApplicationCommands.js";
import * as releaseExposureModule from "./cli/releaseExposureCommands.js";
import * as goModule from "./cli/goCommands.js";
import * as il2cppModule from "./cli/il2cppCommands.js";
import * as modelModule from "./cli/modelCommands.js";
import * as gpuModule from "./cli/gpuCommands.js";
import * as rustModule from "./cli/rustCommands.js";
import * as pythonPycModule from "./cli/pythonPycCommands.js";
import * as erlangModule from "./cli/erlangCommands.js";
import * as v8CodeCacheModule from "./cli/v8CodeCacheCommands.js";
import * as sqliteModule from "./cli/sqliteCommands.js";
import * as artifactModule from "./cli/artifactCommands.js";
import * as managedModule from "./cli/managedCommands.js";
import * as firmwareModule from "./cli/firmwareCommands.js";
import * as androidModule from "./cli/androidCommands.js";
import * as pcapModule from "./cli/pcapCommands.js";
import * as flutterModule from "./cli/flutterCommands.js";
import * as fridaModule from "./cli/fridaCommands.js";
import * as apktoolModule from "./cli/apktoolCommands.js";
import * as jebModule from "./cli/jebCommands.js";
import * as adbModule from "./cli/adbCommands.js";
import * as browserModule from "./cli/browserCommands.js";
import * as webRuntimeModule from "./cli/webRuntimeCommands.js";
import * as webNetworkCaptureModule from "./cli/webNetworkCaptureCommands.js";
import * as advancedBrowserModule from "./cli/browserAdvancedCommands.js";
import * as browserScenarioModule from "./cliBrowserScenarioCommands.js";
import * as electronModule from "./cli/electronCommands.js";
import * as javaScriptRuntimeObservationModule from "./cli/javascriptRuntimeCommands.js";
import * as guidanceModule from "./cli/guidanceCommands.js";
import * as guidedWorkflowModule from "./cli/guidedWorkflowCommands.js";
import * as analysisViewModule from "./cli/analysisViewCommands.js";
import * as evidenceModule from "./cliEvidenceCommands.js";
import * as environmentModule from "./cli/environmentCommands.js";
import * as processModule from "./cli/processCommands.js";
import * as desktopCaptureModule from "./cli/desktopCaptureCommands.js";
import * as javaScriptRecoveryModule from "./cli/javascriptRecoveryCommands.js";
import * as webScriptModule from "./cli/webScriptCommands.js";
import * as webModuleModule from "./cli/webModuleCommands.js";
import * as webSourceLocationModule from "./cli/webSourceLocationCommands.js";
import * as applicationModule from "./cli/applicationCommands.js";
import * as nativeFunctionMatchingModule from "./cli/nativeFunctionMatchingCommands.js";

export { closeCliResources } from "./cli/cliResources.js";

const CLI_COMMAND_MODULES: CliCommandModules = {
  setup: setupModule,
  coreAnalysis: coreAnalysisModule,
  reverseEngineering: reverseEngineeringModule,
  cutter: cutterModule,
  utility: utilityModule,
  binaryDiagnostics: binaryDiagnosticsModule,
  wasm: wasmModule,
  apkSignature: apkSignatureModule,
  capture: captureModule,
  signal: signalModule,
  evm: evmModule,
  desktopApplication: desktopApplicationModule,
  releaseExposure: releaseExposureModule,
  go: goModule,
  il2cpp: il2cppModule,
  model: modelModule,
  gpu: gpuModule,
  rust: rustModule,
  pythonPyc: pythonPycModule,
  erlang: erlangModule,
  v8CodeCache: v8CodeCacheModule,
  sqlite: sqliteModule,
  artifact: artifactModule,
  managed: managedModule,
  firmware: firmwareModule,
  android: androidModule,
  pcap: pcapModule,
  flutter: flutterModule,
  frida: fridaModule,
  apktool: apktoolModule,
  jeb: jebModule,
  adb: adbModule,
  browser: browserModule,
  webRuntime: webRuntimeModule,
  webNetworkCapture: webNetworkCaptureModule,
  advancedBrowser: advancedBrowserModule,
  browserScenario: browserScenarioModule,
  electron: electronModule,
  javaScriptRuntimeObservation: javaScriptRuntimeObservationModule,
  guidance: guidanceModule,
  guidedWorkflow: guidedWorkflowModule,
  analysisView: analysisViewModule,
  evidence: evidenceModule,
  environment: environmentModule,
  process: processModule,
  desktopCapture: desktopCaptureModule,
  javaScriptRecovery: javaScriptRecoveryModule,
  webScript: webScriptModule,
  webModule: webModuleModule,
  webSourceLocation: webSourceLocationModule,
  application: applicationModule,
  nativeFunctionMatching: nativeFunctionMatchingModule,
};

/**
 * Build the complete one-shot Incur CLI without starting Hopper at import time.
 * Analysis commands acquire and close their own sessions; bare `mcp` and
 * `--mcp` are intercepted by the executable dispatcher before this module loads.
 * One-shot commands load only their own registrars; see `cli/cliLoader.ts`.
 */
export const createCli = (
  selectedEnvironment: Readonly<
    Record<string, string | undefined>
  > = process.env,
  resultOutput?: CliResultOutput,
  fridaInstrumentation?: FridaInstrumentationPort,
): CliInstance =>
  createCliShell({
    selectedEnvironment,
    resultOutput,
    fridaInstrumentation,
    createAnalysis: createDirectAnalysis,
    registrations: CLI_REGISTRATION_ORDER.map((id) => ({
      registration: CLI_COMMAND_REGISTRATIONS[id],
      module: CLI_COMMAND_MODULES[id],
    })),
  });
