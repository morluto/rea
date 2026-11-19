import type { CAPABILITY_DECLARATIONS } from "../../src/composition/capabilityDeclarations.js";

/**
 * The public-workflow conformance case for each declared provider capability.
 * A case is a CLI, MCP or acceptance test that exercises one of the
 * capability's operations; an exemption must say why no such case exists.
 * `providerCapabilityConformance.test.ts` iterates the capability
 * declarations, so a newly declared capability fails until it is listed here.
 */
export type ProviderCapabilityConformance =
  | { readonly cases: readonly [string, ...string[]] }
  | { readonly exempt: string };

export const PROVIDER_CAPABILITY_CONFORMANCE: Readonly<
  Partial<
    Record<keyof typeof CAPABILITY_DECLARATIONS, ProviderCapabilityConformance>
  >
> = {
  adbDevice: { cases: ["tests/boundary/mcp/adbDeviceProperties.test.ts"] },
  analysisView: { cases: ["tests/boundary/cli/analysisViewCli.test.ts"] },
  android: { cases: ["tests/boundary/cli/androidPackageViewCli.test.ts"] },
  androidApplicationGraph: {
    cases: ["tests/boundary/mcp/mobileApplicationGraphMcp.test.ts"],
  },
  apkSignature: {
    cases: ["tests/acceptance/apkSignatureLimitsCliMcp.test.ts"],
  },
  apktool: { cases: ["tests/boundary/cli/apktoolCli.test.ts"] },
  appleApplicationGraph: {
    cases: ["tests/boundary/mcp/mobileApplicationGraphMcp.test.ts"],
  },
  appleIps: { cases: ["tests/acceptance/appleIpsArmJoinCli.test.ts"] },
  applicationWorkflows: {
    cases: [
      "tests/acceptance/applications/applicationVersionMatchingCli.test.ts",
    ],
  },
  artifactGraph: {
    cases: ["tests/acceptance/artifactAdmittedIdentityMcp.test.ts"],
  },
  binaryHardening: { cases: ["tests/acceptance/binaryHardeningCli.test.ts"] },
  binaryLayout: { cases: ["tests/boundary/mcp/binaryDiagnosticsMcp.test.ts"] },
  browserObservation: {
    cases: ["tests/acceptance/browser/observationDurationCli.test.ts"],
  },
  browserScenarioCapture: {
    cases: ["tests/acceptance/browser/browserScenarioCancellationCli.test.ts"],
  },
  byteEntropy: {
    cases: ["tests/acceptance/byteEntropyWindowsIdentity.test.ts"],
  },
  cutter: { cases: ["tests/boundary/cli/cutterStatusAttributionCli.test.ts"] },
  desktopApplication: {
    cases: ["tests/boundary/cli/desktopApplicationCli.test.ts"],
  },
  devicetree: { cases: ["tests/acceptance/devicetreeCli.test.ts"] },
  dwarfUnits: {
    cases: [
      "tests/acceptance/dwarfUnitsCli.test.ts",
      "tests/boundary/mcp/dwarfUnitsMcp.test.ts",
    ],
  },
  electronActiveObservation: {
    cases: ["tests/acceptance/applications/electronBlankPathCli.test.ts"],
  },
  electronFuses: { cases: ["tests/acceptance/electronFusesCli.test.ts"] },
  electronObservation: { cases: ["tests/boundary/cli/electronCli.test.ts"] },
  elfDebugLink: {
    cases: [
      "tests/acceptance/elfDebugLinkCli.test.ts",
      "tests/boundary/mcp/elfDebugLinkMcp.test.ts",
    ],
  },
  elfNotes: { cases: ["tests/acceptance/elfNotesCli.test.ts"] },
  elfDependencies: {
    cases: [
      "tests/acceptance/elfDependenciesCli.test.ts",
      "tests/boundary/mcp/elfDependenciesMcp.test.ts",
    ],
  },
  elfUnwindRanges: { cases: ["tests/acceptance/elfUnwindRangesCli.test.ts"] },
  erlangBeam: { cases: ["tests/acceptance/erlangBeamCli.test.ts"] },
  evmInterface: { cases: ["tests/boundary/mcp/evmInterfaceMcp.test.ts"] },
  firmwareAnalysis: { cases: ["tests/boundary/mcp/firmwareMcp.test.ts"] },
  flutter: { cases: ["tests/boundary/cli/flutterCli.test.ts"] },
  fridaInstrumentation: { cases: ["tests/boundary/cli/fridaCli.test.ts"] },
  gdbSessions: { cases: ["tests/boundary/cli/gdbStartupCleanupCli.test.ts"] },
  ghidra: { cases: ["tests/boundary/mcp/ghidraInventoryMcp.test.ts"] },
  goBinary: { cases: ["tests/acceptance/goBinaryCli.test.ts"] },
  gpuCodeObjects: { cases: ["tests/acceptance/gpuCodeObjectsCli.test.ts"] },
  harmonyApplicationGraph: {
    cases: ["tests/boundary/mcp/mobileApplicationGraphMcp.test.ts"],
  },
  hopper: { cases: ["tests/boundary/cli/hopperLaunchFailureCli.test.ts"] },
  ida: { cases: ["tests/boundary/cli/idaStartupAttributionCli.test.ts"] },
  il2cppMetadata: { cases: ["tests/acceptance/il2cppMetadataCli.test.ts"] },
  javascriptApplication: {
    cases: [
      "tests/acceptance/applications/analyzeJavaScriptDeliveryCli.test.ts",
    ],
  },
  javascriptRecovery: {
    cases: ["tests/boundary/mcp/javascriptRecoveryMcp.test.ts"],
  },
  javascriptRuntimeObservation: {
    cases: ["tests/boundary/mcp/javascriptRuntimeObservationMcp.test.ts"],
  },
  javascriptRuntimeReconciliation: {
    cases: [
      "tests/acceptance/applications/javascriptNodeTargetReconciliationCli.test.ts",
    ],
  },
  jeb: { cases: ["tests/boundary/cli/jebCli.test.ts"] },
  kernelBuildConfig: {
    cases: ["tests/acceptance/kernelBuildConfigCli.test.ts"],
  },
  kernelModule: { cases: ["tests/acceptance/kernelModuleCli.test.ts"] },
  kuna: { cases: ["tests/boundary/mcp/kunaCloseRetryMcp.test.ts"] },
  managedStatic: { cases: ["tests/acceptance/managedCliOutput.test.ts"] },
  managedWorkflow: {
    cases: ["tests/boundary/mcp/managedWorkflowUnknownIdentityMcp.test.ts"],
  },
  mavenGradleMetadata: {
    cases: ["tests/acceptance/mavenGradleMetadataCli.test.ts"],
  },
  modelArtifact: { cases: ["tests/acceptance/modelArtifactCli.test.ts"] },
  nativeExports: {
    cases: [
      "tests/acceptance/applications/nativeExportsDynamicSegment.test.ts",
    ],
  },
  nativeInitializers: {
    cases: ["tests/acceptance/nativeInitializersCli.test.ts"],
  },
  nativeMacOS: {
    cases: ["tests/acceptance/nativeMachoParenthesizedCli.test.ts"],
  },
  packetCapture: { cases: ["tests/boundary/mcp/packetCaptureMcp.test.ts"] },
  pcap: { cases: ["tests/acceptance/pcapCredentialErrorsCliMcp.test.ts"] },
  peCertificates: { cases: ["tests/acceptance/peCertificatesCli.test.ts"] },
  peImports: { cases: ["tests/acceptance/peImportsCli.test.ts"] },
  peLoadConfig: { cases: ["tests/acceptance/peLoadConfigCli.test.ts"] },
  peResources: { cases: ["tests/acceptance/applications/peResources.test.ts"] },
  nugetNupkg: { cases: ["tests/acceptance/nugetNupkgCli.test.ts"] },
  vsixPackage: { cases: ["tests/acceptance/vsixPackageCli.test.ts"] },
  pythonPyc: { cases: ["tests/acceptance/pythonPycCli.test.ts"] },
  recordedCrash: { cases: ["tests/boundary/mcp/recordedCrashMcp.test.ts"] },
  releaseExposure: { cases: ["tests/acceptance/releaseExposureCli.test.ts"] },
  reverseEngineering: {
    cases: ["tests/boundary/mcp/reverseEngineeringEnvironmentMcp.test.ts"],
  },
  rizinDebugSessions: {
    cases: ["tests/boundary/mcp/rizinDebuggerCancellationMcp.test.ts"],
  },
  rustBinary: { cases: ["tests/acceptance/rustBinaryCli.test.ts"] },
  signalRecording: { cases: ["tests/boundary/mcp/signalRecordingMcp.test.ts"] },
  sqliteDatabase: { cases: ["tests/acceptance/sqliteDatabaseCli.test.ts"] },
  v8CodeCache: { cases: ["tests/acceptance/v8CodeCacheCli.test.ts"] },
  wasmArtifact: { cases: ["tests/boundary/mcp/wasmArtifactMcp.test.ts"] },
  webModuleTrace: { cases: ["tests/boundary/mcp/webModuleTraceMcp.test.ts"] },
  webNetworkCapture: {
    cases: ["tests/boundary/mcp/webNetworkCaptureMcp.test.ts"],
  },
  webRuntime: { cases: ["tests/acceptance/webRuntimeCli.test.ts"] },
  webScriptExport: {
    cases: ["tests/acceptance/applications/webScriptPortablePathsCli.test.ts"],
  },
  webSourceLocation: {
    cases: ["tests/acceptance/webSourceLocationCli.test.ts"],
  },
  windowsShortcut: { cases: ["tests/acceptance/windowsShortcutCli.test.ts"] },
};
