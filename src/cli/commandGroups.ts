import type { FridaInstrumentationPort } from "../application/frida/FridaInstrumentationPort.js";
import type { DirectAnalysis } from "../composition/directAnalysis.js";
import {
  TOOL_FAMILY_IDS,
  type ToolFamilyId,
} from "../contracts/toolFamilyIds.js";
import type { Logger } from "pino";
import type { CliInstance } from "./types.js";

/** Shared registration inputs; analysis composition is created on first use. */
export interface CliCommandGroupContext {
  readonly cli: CliInstance;
  readonly logger: Logger;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly analysis: () => Promise<DirectAnalysis>;
  readonly fridaInstrumentation: FridaInstrumentationPort | undefined;
}

/** Register one loaded group's commands on the CLI. */
export type CliCommandGroupRegistration = (
  context: CliCommandGroupContext,
) => void;

/**
 * One independently loadable set of top-level commands. Loading imports the
 * group's command modules; registration stays synchronous so every selected
 * group is registered in catalog order after all imports settle.
 */
export interface CliCommandGroup {
  readonly id: string;
  readonly load: (
    context: CliCommandGroupContext,
  ) => Promise<CliCommandGroupRegistration>;
}

/** Commands outside the published tool families, registered first. */
const SETUP_GROUPS: readonly CliCommandGroup[] = [
  {
    id: "setup",
    load: async () => {
      const { registerSetupCommands } = await import("./setupCommands.js");
      return (c) => registerSetupCommands(c.cli, c.logger, c.environment);
    },
  },
];

/**
 * Command groups for each published tool family. The complete map makes a new
 * family id fail here, as it does at the MCP registration site.
 */
const FAMILY_GROUPS: {
  readonly [Id in ToolFamilyId]: readonly CliCommandGroup[];
} = {
  direct: [
    {
      id: "core-analysis",
      load: async (context) => {
        const [{ registerCoreAnalysisCommands }, analysis] = await Promise.all([
          import("./coreAnalysisCommands.js"),
          context.analysis(),
        ]);
        return (c) =>
          registerCoreAnalysisCommands(
            c.cli,
            c.logger,
            analysis.runDirectAnalysis,
            c.environment,
          );
      },
    },
  ],
  // Enhanced workflows are MCP tools. Their CLI entry points live with core analysis.
  enhanced: [],
  native: [
    {
      id: "reverse-engineering",
      load: async () => {
        const { registerReverseEngineeringCommands } =
          await import("./reverseEngineeringCommands.js");
        return (c) =>
          registerReverseEngineeringCommands(c.cli, c.logger, c.environment);
      },
    },
    {
      id: "cutter",
      load: async () => {
        const { registerCutterCommands } = await import("./cutterCommands.js");
        return (c) => registerCutterCommands(c.cli, c.logger, c.environment);
      },
    },
    {
      id: "utility",
      load: async (context) => {
        const [{ registerUtilityCommands }, analysis] = await Promise.all([
          import("./utilityCommands.js"),
          context.analysis(),
        ]);
        return (c) =>
          registerUtilityCommands(c.cli, c.logger, c.environment, analysis);
      },
    },
    {
      id: "binary-diagnostics",
      load: async () => {
        const { registerBinaryDiagnosticsCommands } =
          await import("./binaryDiagnosticsCommands.js");
        return (c) =>
          registerBinaryDiagnosticsCommands(c.cli, c.logger, c.environment);
      },
    },
  ],
  artifact: [
    {
      id: "wasm",
      load: async () => {
        const { registerWasmCommands } = await import("./wasmCommands.js");
        return (c) => registerWasmCommands(c.cli, c.logger, c.environment);
      },
    },
    {
      id: "apk-signature",
      load: async () => {
        const { registerApkSignatureCommands } =
          await import("./apkSignatureCommands.js");
        return (c) =>
          registerApkSignatureCommands(c.cli, c.logger, c.environment);
      },
    },
    {
      id: "capture",
      load: async () => {
        const { registerCaptureCommands } =
          await import("./captureCommands.js");
        return (c) => registerCaptureCommands(c.cli, c.logger, c.environment);
      },
    },
    {
      id: "signal",
      load: async () => {
        const { registerSignalCommands } = await import("./signalCommands.js");
        return (c) => registerSignalCommands(c.cli, c.logger, c.environment);
      },
    },
    {
      id: "evm",
      load: async () => {
        const { registerEvmCommands } = await import("./evmCommands.js");
        return (c) => registerEvmCommands(c.cli, c.logger, c.environment);
      },
    },
    {
      id: "desktop-application",
      load: async () => {
        const { registerDesktopApplicationCommands } =
          await import("./desktopApplicationCommands.js");
        return (c) => registerDesktopApplicationCommands(c.cli, c.logger);
      },
    },
    {
      id: "go",
      load: async () => {
        const { registerGoCommands } = await import("./goCommands.js");
        return (c) => registerGoCommands(c.cli, c.logger);
      },
    },
    {
      id: "il2cpp",
      load: async () => {
        const { registerIl2cppCommands } = await import("./il2cppCommands.js");
        return (c) => registerIl2cppCommands(c.cli, c.logger);
      },
    },
    {
      id: "model",
      load: async () => {
        const { registerModelCommands } = await import("./modelCommands.js");
        return (c) => registerModelCommands(c.cli, c.logger);
      },
    },
    {
      id: "gpu",
      load: async () => {
        const { registerGpuCommands } = await import("./gpuCommands.js");
        return (c) => registerGpuCommands(c.cli, c.logger);
      },
    },
    {
      id: "rust",
      load: async () => {
        const { registerRustCommands } = await import("./rustCommands.js");
        return (c) => registerRustCommands(c.cli, c.logger);
      },
    },
    {
      id: "python-pyc",
      load: async () => {
        const { registerPythonPycCommands } =
          await import("./pythonPycCommands.js");
        return (c) => registerPythonPycCommands(c.cli, c.logger);
      },
    },
    {
      id: "erlang",
      load: async () => {
        const { registerErlangCommands } = await import("./erlangCommands.js");
        return (c) => registerErlangCommands(c.cli, c.logger);
      },
    },
    {
      id: "sqlite",
      load: async () => {
        const { registerSqliteCommands } = await import("./sqliteCommands.js");
        return (c) => registerSqliteCommands(c.cli, c.logger, c.environment);
      },
    },
    {
      id: "artifact",
      load: async (context) => {
        const [{ registerArtifactCommands }, analysis] = await Promise.all([
          import("./artifactCommands.js"),
          context.analysis(),
        ]);
        return (c) =>
          registerArtifactCommands(
            c.cli,
            c.logger,
            analysis.runProviderAnalysis,
          );
      },
    },
  ],
  managed: [
    {
      id: "managed",
      load: async (context) => {
        const [{ registerManagedCommands }, analysis] = await Promise.all([
          import("./managedCommands.js"),
          context.analysis(),
        ]);
        return (c) =>
          registerManagedCommands(
            c.cli,
            c.logger,
            analysis.runProviderAnalysis,
          );
      },
    },
  ],
  firmware: [
    {
      id: "firmware",
      load: async () => {
        const { registerFirmwareCommands } =
          await import("./firmwareCommands.js");
        return (c) => registerFirmwareCommands(c.cli, c.logger, c.environment);
      },
    },
  ],
  android: [
    {
      id: "android",
      load: async () => {
        const { registerAndroidCommands } =
          await import("./androidCommands.js");
        return (c) => registerAndroidCommands(c.cli, c.logger, c.environment);
      },
    },
  ],
  pcap: [
    {
      id: "pcap",
      load: async () => {
        const { registerPcapCommands } = await import("./pcapCommands.js");
        return (c) => registerPcapCommands(c.cli, c.logger, c.environment);
      },
    },
  ],
  flutter: [
    {
      id: "flutter",
      load: async () => {
        const { registerFlutterCommands } =
          await import("./flutterCommands.js");
        return (c) => registerFlutterCommands(c.cli, c.logger);
      },
    },
  ],
  frida: [
    {
      id: "frida",
      load: async () => {
        const { registerFridaCommands } = await import("./fridaCommands.js");
        return (c) =>
          registerFridaCommands(c.cli, c.logger, c.fridaInstrumentation);
      },
    },
  ],
  apktool: [
    {
      id: "apktool",
      load: async () => {
        const { registerApktoolCommands } =
          await import("./apktoolCommands.js");
        return (c) => registerApktoolCommands(c.cli, c.logger, c.environment);
      },
    },
  ],
  jeb: [
    {
      id: "jeb",
      load: async () => {
        const { registerJebCommands } = await import("./jebCommands.js");
        return (c) => registerJebCommands(c.cli, c.logger, c.environment);
      },
    },
  ],
  adb: [
    {
      id: "adb",
      load: async () => {
        const { registerAdbCommands } = await import("./adbCommands.js");
        return (c) => registerAdbCommands(c.cli, c.logger, c.environment);
      },
    },
  ],
  browser: [
    {
      id: "browser",
      load: async () => {
        const { registerBrowserCommands } =
          await import("./browserCommands.js");
        return (c) => registerBrowserCommands(c.cli, c.logger);
      },
    },
    {
      id: "web-runtime",
      load: async () => {
        const { registerWebRuntimeCommands } =
          await import("./webRuntimeCommands.js");
        return (c) => registerWebRuntimeCommands(c.cli, c.logger);
      },
    },
    {
      id: "web-network-capture",
      load: async () => {
        const { registerWebNetworkCaptureCommands } =
          await import("./webNetworkCaptureCommands.js");
        return (c) =>
          registerWebNetworkCaptureCommands(c.cli, c.logger, c.environment);
      },
    },
    {
      id: "browser-advanced",
      load: async () => {
        const { registerAdvancedBrowserCommands } =
          await import("./browserAdvancedCommands.js");
        return (c) => registerAdvancedBrowserCommands(c.cli, c.logger);
      },
    },
    {
      id: "browser-scenario",
      load: async () => {
        const { registerBrowserScenarioCommands } =
          await import("../cliBrowserScenarioCommands.js");
        return (c) =>
          registerBrowserScenarioCommands(c.cli, c.logger, c.environment);
      },
    },
  ],
  electron: [
    {
      id: "electron",
      load: async () => {
        const { registerElectronCommands } =
          await import("./electronCommands.js");
        return (c) => registerElectronCommands(c.cli, c.logger, c.environment);
      },
    },
  ],
  "javascript-runtime": [
    {
      id: "javascript-runtime",
      load: async () => {
        const { registerJavaScriptRuntimeObservationCommands } =
          await import("./javascriptRuntimeCommands.js");
        return (c) =>
          registerJavaScriptRuntimeObservationCommands(
            c.cli,
            c.logger,
            c.environment,
          );
      },
    },
  ],
  application: [
    {
      id: "guidance",
      load: async () => {
        const { registerGuidanceCommands } =
          await import("./guidanceCommands.js");
        return (c) => registerGuidanceCommands(c.cli, c.logger);
      },
    },
    {
      id: "guided-workflows",
      load: async () => {
        const { registerGuidedWorkflowCommands } =
          await import("./guidedWorkflowCommands.js");
        return (c) => registerGuidedWorkflowCommands(c.cli, c.logger);
      },
    },
    {
      id: "analysis-view",
      load: async () => {
        const { registerAnalysisViewCommands } =
          await import("./analysisViewCommands.js");
        return (c) => registerAnalysisViewCommands(c.cli, c.logger);
      },
    },
    {
      id: "evidence",
      load: async () => {
        const { registerEvidenceCommands } =
          await import("../cliEvidenceCommands.js");
        return (c) => registerEvidenceCommands(c.cli, c.logger);
      },
    },
    {
      id: "environment",
      load: async () => {
        const { registerEnvironmentCommands } =
          await import("./environmentCommands.js");
        return (c) =>
          registerEnvironmentCommands(c.cli, c.logger, c.environment);
      },
    },
    {
      id: "process",
      load: async () => {
        const { registerProcessCommands } =
          await import("./processCommands.js");
        return (c) => registerProcessCommands(c.cli, c.logger, c.environment);
      },
    },
    {
      id: "desktop-capture",
      load: async () => {
        const { registerDesktopCaptureCommands } =
          await import("./desktopCaptureCommands.js");
        return (c) =>
          registerDesktopCaptureCommands(c.cli, c.logger, c.environment);
      },
    },
    {
      id: "javascript-recovery",
      load: async () => {
        const { registerJavaScriptRecoveryCommands } =
          await import("./javascriptRecoveryCommands.js");
        return (c) =>
          registerJavaScriptRecoveryCommands(c.cli, c.logger, c.environment);
      },
    },
    {
      id: "web-script",
      load: async () => {
        const { registerWebScriptCommands } =
          await import("./webScriptCommands.js");
        return (c) => registerWebScriptCommands(c.cli, c.logger);
      },
    },
    {
      id: "web-module",
      load: async () => {
        const { registerWebModuleCommands } =
          await import("./webModuleCommands.js");
        return (c) => registerWebModuleCommands(c.cli, c.logger, c.environment);
      },
    },
    {
      id: "web-source-location",
      load: async () => {
        const { registerWebSourceLocationCommands } =
          await import("./webSourceLocationCommands.js");
        return (c) =>
          registerWebSourceLocationCommands(c.cli, c.logger, c.environment);
      },
    },
    {
      id: "application",
      load: async () => {
        const { registerApplicationCommands } =
          await import("./applicationCommands.js");
        return (c) => registerApplicationCommands(c.cli, c.logger);
      },
    },
  ],
  session: [
    {
      id: "native-function-matching",
      load: async () => {
        const { registerNativeFunctionMatchingCommands } =
          await import("./nativeFunctionMatchingCommands.js");
        return (c) =>
          registerNativeFunctionMatchingCommands(
            c.cli,
            c.logger,
            c.environment,
          );
      },
    },
  ],
};

/**
 * Every CLI command group, in registration order: setup, then each published
 * tool family in catalog order. The build records which top-level command
 * names each group registers, so the executable can import only the group
 * that owns the requested command.
 */
export const CLI_COMMAND_GROUPS: readonly CliCommandGroup[] = [
  ...SETUP_GROUPS,
  ...TOOL_FAMILY_IDS.flatMap((id) => FAMILY_GROUPS[id]),
];
