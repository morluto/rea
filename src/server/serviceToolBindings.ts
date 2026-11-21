import type { UefiAnalysisService } from "../application/uefi/UefiAnalysisService.js";
import type { MavenGradleMetadataService } from "../application/java/MavenGradleMetadataService.js";

import type { NugetNupkgService } from "../application/nuget/NugetNupkgService.js";
import type { DwarfUnitsService } from "../application/binaryDiagnostics/DwarfUnitsService.js";
import type { ElfDependenciesService } from "../application/binaryDiagnostics/ElfDependenciesService.js";
import type { AdbDeviceAnalysisService } from "../application/adb/AdbDeviceAnalysisService.js";
import type { AnalysisSettings } from "../application/AnalysisSettings.js";
import type { AnalysisSettingsReader } from "../domain/analysisSettings.js";
import type { ElectronFuseService } from "../application/electron/ElectronFuseService.js";
import type { ElectronObservationPort } from "../ports/javascript/ElectronObservationPort.js";
import type { ElectronActiveObservationPort } from "../ports/javascript/ElectronActiveObservationPort.js";
import {
  inspectElectronPage,
  listElectronTargets,
} from "../application/javascript/ElectronObservationService.js";
import { captureElectronScenario } from "../application/javascript/ElectronActiveObservationService.js";
import { analyzeJavaScriptApplicationValidated } from "../application/javascript/JavaScriptApplicationService.js";
import { reconcileJavaScriptRuntimeEvidence } from "../application/javascript/JavaScriptRuntimeReconciliationService.js";
import { javascriptSourceAnalysis } from "../composition/javascriptSourceAnalysis.js";
import { analysisSettingsConstraints } from "./analysisSettingsConstraints.js";
import type { ToolResultDelivery } from "./ToolResultDelivery.js";
import type { AndroidAnalysisService } from "../application/android/AndroidAnalysisService.js";
import { inspectAndroidJniBindings } from "../application/android/AndroidJniInspection.js";
import { inspectAndroidPackage } from "../application/android/AndroidPackageInspection.js";
import { inspectAndroidSymbol } from "../application/android/AndroidSymbolInspection.js";
import {
  inspectAnalysisView,
  projectRetainedAnalysis,
  requireAnalysisViewRetention,
  summarizeRetainedAnalysis,
  type AnalysisViewRetention,
} from "../application/analysisView/AnalysisViewService.js";
import { z } from "zod";
import { analysisViewSourceSchema } from "../domain/analysisView/analysisViewRequest.js";
import type { ApkSignatureService } from "../application/apkSignature/ApkSignatureService.js";
import type { ApktoolResourceAnalysisService } from "../application/apktool/ApktoolResourceAnalysisService.js";
import type { DesktopApplicationService } from "../application/artifacts/DesktopApplicationService.js";
import type { AppleIpsService } from "../application/binaryDiagnostics/AppleIpsService.js";
import type { BinaryHardeningService } from "../application/binaryDiagnostics/BinaryHardeningService.js";
import type { ByteEntropyService } from "../application/binaryDiagnostics/ByteEntropyService.js";
import type { DevicetreeService } from "../application/binaryDiagnostics/DevicetreeService.js";
import type { ElfDebugLinkService } from "../application/binaryDiagnostics/ElfDebugLinkService.js";
import type { ElfNotesService } from "../application/binaryDiagnostics/ElfNotesService.js";
import type { ElfUnwindRangesService } from "../application/binaryDiagnostics/ElfUnwindRangesService.js";
import type { KernelBuildConfigService } from "../application/binaryDiagnostics/KernelBuildConfigService.js";
import type { KernelModuleService } from "../application/binaryDiagnostics/KernelModuleService.js";
import type { NativeExportsService } from "../application/binaryDiagnostics/NativeExportsService.js";
import type { NativeInitializersService } from "../application/binaryDiagnostics/NativeInitializersService.js";
import type { PeCertificatesService } from "../application/binaryDiagnostics/PeCertificatesService.js";
import type { PeImportsService } from "../application/binaryDiagnostics/PeImportsService.js";
import type { PeLoadConfigService } from "../application/binaryDiagnostics/PeLoadConfigService.js";
import type { PeResourcesService } from "../application/binaryDiagnostics/PeResourcesService.js";
import type { RecordedCrashService } from "../application/binaryDiagnostics/RecordedCrashService.js";
import type { WindowsShortcutService } from "../application/binaryDiagnostics/WindowsShortcutService.js";
import type { PacketCaptureService } from "../application/captures/PacketCaptureService.js";
import type { BeamService } from "../application/erlang/BeamService.js";
import type { EvmInterfaceService } from "../application/evm/EvmInterfaceService.js";
import type { FirmwareAnalysisService } from "../application/firmware/FirmwareAnalysisService.js";
import { inspectDartAot } from "../application/flutter/DartAotInspection.js";
import type { FlutterBuildAnalysisService } from "../application/flutter/FlutterBuildAnalysisService.js";
import type { GoBinaryService } from "../application/go/GoBinaryService.js";
import type { GpuCodeObjectsService } from "../application/gpu/GpuCodeObjectsService.js";
import type { Il2cppMetadataService } from "../application/il2cpp/Il2cppMetadataService.js";
import {
  retainAnalysisResultSources,
  recordEvidenceSources,
} from "../application/investigation/recordEvidenceSources.js";
import type { JavaScriptRecoveryService } from "../application/javascript/JavaScriptRecoveryService.js";
import type { JebAnalysisService } from "../application/jeb/JebAnalysisService.js";
import type { ModelArtifactService } from "../application/model/ModelArtifactService.js";
import type { PcapAnalysisService } from "../application/pcap/PcapAnalysisService.js";
import type { PythonPycService } from "../application/python/PythonPycService.js";
import type { ReleaseExposureService } from "../application/releaseExposure/ReleaseExposureService.js";
import type { RustBinaryService } from "../application/rust/RustBinaryService.js";
import type { SignalRecordingService } from "../application/signals/SignalRecordingService.js";
import type { SqliteDatabaseService } from "../application/sqlite/SqliteDatabaseService.js";
import type { V8CodeCacheService } from "../application/v8CodeCache/V8CodeCacheService.js";
import type { WasmArtifactService } from "../application/wasm/WasmArtifactService.js";
import { compareWasmInterfaces } from "../application/wasm/WasmInterfaceComparisonService.js";
import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import {
  executeSessionFunctionAnalysis,
  executeSessionWorkflowEvidence,
  type WorkflowSession,
} from "../application/SessionWorkflowEvidence.js";
import { projectManagedApplicationGraphExecution } from "../application/managed/ManagedApplicationGraphService.js";
import { compareManagedMembersExecution } from "../application/managed/ManagedMemberComparisonService.js";
import { verifyManagedNativeBoundariesExecution } from "../application/managed/ManagedNativeVerificationService.js";
import { importManagedReconstructionExecution } from "../application/managed/ManagedReconstructionService.js";
import { compareFunctionEvidence } from "../application/investigation/FunctionComparisonEvidence.js";
import { compareProcessEvidence } from "../application/process/ProcessComparisonService.js";
import {
  buildCallPathEvidence,
  correlateStaticAndRuntimeEvidence,
  findChangedBehaviorEvidence,
  verifyReconstructionEvidence,
} from "../application/investigation/InvestigationWorkflows.js";
import {
  artifactComparisonExecution,
  resolveArtifactComparisonSources,
} from "../application/artifacts/ArtifactComparisonEvidence.js";
import {
  bundleComparisonExecution,
  readBundleComparisonSources,
} from "../application/investigation/BundleComparisonEvidence.js";
import type { WebModuleTraceService } from "../application/WebModuleTraceService.js";
import {
  compareApplicationVersionsExecution,
  compareJavaScriptExportShapesExecution,
  inspectionExecution,
  reconstructionObligationLedgerExecution,
  settledExecution,
  sourceToBundleComparisonExecution,
} from "../application/ApplicationToolExecutions.js";
import { projectAndroidApplicationEvidence } from "../application/android/AndroidApplicationService.js";
import { inspectApiContractEvidence } from "../application/apiContract/ApiContractService.js";
import { projectAppleApplicationEvidence } from "../application/apple/AppleApplicationService.js";
import { projectHarmonyApplicationEvidence } from "../application/harmony/HarmonyApplicationService.js";
import type { EvidenceWorkflowExecution } from "../application/investigation/EvidenceWorkflowExecution.js";
import type { InvestigationWorkflowExecution } from "../application/investigation/InvestigationWorkflows.js";
import { traceApplicationFeatureEvidence } from "../application/javascript/JavaScriptApplicationWorkflowService.js";
import { traceJavaScriptSemanticsEvidence } from "../application/javascript/JavaScriptSemanticTraceService.js";
import { compareStaticAndObservedEndpointsEvidence } from "../application/javascript/StaticObservedEndpointComparisonService.js";
import { inspectNtfsJournalEvidence } from "../application/ntfs/NtfsJournalService.js";
import { inspectWarcArchiveEvidence } from "../application/warcArchive/WarcArchiveService.js";
import { evaluateReconstructionCoverage } from "../application/ReconstructionCoverageService.js";
import { exportEnvironmentBundleTool } from "../application/environment/environmentBundleTool.js";
import { PlaywrightTraceService } from "../application/playwrightTrace/PlaywrightTraceService.js";
import { PlaywrightTraceDecoder } from "../browser/history/playwrightTrace/PlaywrightTraceDecoder.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { AnalysisViewRequest } from "../domain/analysisView/analysisViewRequest.js";
import type { WebSourceLocationService } from "../application/WebSourceLocationService.js";
import { toolContract } from "../contracts/toolContracts.js";
import { redactExplicitFailure } from "../domain/explicitSensitiveFailure.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../domain/result.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import {
  readGuidanceSection,
  searchGuidance,
} from "../application/GuidanceAccess.js";
import type { CutterBridgeService } from "../cutter/CutterBridgeService.js";
import { captureSensitiveValues } from "../domain/webNetworkCapture.js";
import type { WebNetworkCaptureService } from "../application/WebNetworkCaptureService.js";
import type { FridaInstrumentationService } from "../application/frida/FridaInstrumentationService.js";
import type { BrowserObservationPort } from "../ports/BrowserObservationPort.js";
import type { GdbSessionManager } from "../gdb/GdbSessionManager.js";
import type { RizinDebugSessionManager } from "../rizin/RizinDebugSessionManager.js";
import {
  resolveRizinCommandRequest,
  type ReverseEngineeringService,
} from "../application/reverse/ReverseEngineeringService.js";
import {
  GDB_SESSION_TOOLS,
  RIZIN_DEBUG_SESSION_TOOLS,
  unknownDebuggerSessionError,
} from "../domain/debuggerSessionErrors.js";
import type { ExternalMutationAdmission } from "./externalMutationAdmission.js";
import type { EvidenceCommand } from "./externalMutationToolHandler.js";
import {
  optionalProviderUnavailable,
  type OptionalProviderLoadFailure,
} from "../ports/OptionalObservationProviders.js";
import type { BinaryLayoutService } from "../application/binaryDiagnostics/BinaryLayoutService.js";
import { browserScenarioSchema } from "../domain/browserScenario.js";
import type { BrowserScenarioCapturePort } from "../ports/BrowserScenarioCapturePort.js";
import { captureBrowserScenario } from "../application/BrowserScenarioCaptureService.js";
import type { JavaScriptRuntimeObservationPort } from "../ports/javascript/JavaScriptRuntimeObservationPort.js";
import {
  listJavaScriptRuntimeTargets,
  observeJavaScriptRuntime,
} from "../application/javascript/JavaScriptRuntimeObservationService.js";
import { accessGuidedWorkflows } from "../application/GuidedWorkflowAccess.js";
import type { PromptContract } from "../contracts/promptContracts.js";
import { matchNativeFunctions } from "../application/native/NativeFunctionMatchingService.js";
import type { NativeMatchingAllowance } from "../config/nativeMatchingAllowance.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";
import {
  analyzeWebBundle,
  captureWebScreenshot,
  compareWebCaptureEvidence,
  compareWebScreenshotEvidence,
  discoverWebMcpTools,
  inspectWebPage,
  listBrowserTargets,
  observeWebSession,
} from "../application/BrowserObservationService.js";
import {
  fridaDeviceSelection,
  fridaRemoteConnection,
  instrumentWithFrida,
  loadFridaScript,
  startFridaSession,
} from "../application/frida/fridaContractRequests.js";
import type { WebRuntimeService } from "../application/WebRuntimeService.js";
import { exportWebScriptsValidated } from "../application/WebScriptExportService.js";
import type { ArtifactResourceScope } from "../resources/index.js";
import {
  CommittedValue,
  DetailedFailure,
  ForwardedValue,
  ReducibleValue,
  type ValueOutcome,
  type ValueToolRequest,
} from "./contractToolHandler.js";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ForwardedResult } from "../application/desktop/DesktopBuildComputers.js";
import { DesktopBuildSteps } from "../application/desktop/DesktopBuildSteps.js";
import type { ProgressReporter } from "../ports/ProgressReporter.js";
import {
  redactedResult,
  withHeartbeat,
  type DesktopBuildToolComputers,
} from "./desktopBuildDelivery.js";
import {
  getNavigationContext,
  inspectAddressContext,
  omitContextEvidenceForDelivery,
} from "../application/AnalysisContextQueries.js";
import { binaryTargetSummary } from "../application/binary/BinaryTargetSummary.js";
import {
  captureSessionProcessScenario,
  type ProcessSessionCaptureOptions,
} from "../application/process/ProcessSessionCapture.js";
import { openBinaryTargetSelection } from "../contracts/sessionLifecycleInputs.js";
import type { ResidualUnknown } from "../domain/residualUnknown.js";
import { cancelledBy } from "../domain/analysisErrorCore.js";
import {
  evidenceBundleExportReceipt,
  readImmutableEvidenceBundle,
  writeEvidenceBundle,
} from "../application/EvidenceBundleFiles.js";
import { inspectEvidenceBundle } from "../application/investigation/InspectEvidenceBundle.js";
import {
  contractServiceBindings,
  registerContractTools,
  type ContractToolBindings,
  type ContractToolDependencies,
} from "./contractToolBindings.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type {
  ProviderOperation,
  ProviderOperationOptions,
} from "./providerOperationToolHandler.js";
import type { ToolContract } from "../contracts/toolContractTypes.js";
import { retainedSummaryDelivery } from "./retainedSummaryDelivery.js";
import {
  CLOSE_RETRY,
  closeWithProcessResources,
  resetCleanupRetry,
  type SessionLifecycleOptions,
} from "./sessionLifecycle.js";
import {
  reportOperationEnd,
  reportOperationStart,
} from "./operationProgress.js";
import {
  readSessionStatus,
  type SessionStatusToolOptions,
} from "./sessionStatusTool.js";

/** The runtime settings owner and the delivery whose limits it reports. */
export interface AnalysisSettingsToolOptions {
  readonly settings: AnalysisSettings;
  readonly delivery: ToolResultDelivery;
}

/**
 * The session that admits and records derived Evidence, and the artifact
 * resource scope its comparisons of caller-named files read under.
 */
export interface SessionDerivedToolOptions {
  readonly session: BinarySessionPort;
  readonly resources: ArtifactResourceScope;
}

/**
 * A committed residual unknown, with the receipt naming its revision and
 * mutation Evidence for a response too large to deliver.
 */
const committedUnknown = (
  result: Result<ResidualUnknown, AnalysisError>,
): Result<CommittedValue, AnalysisError> =>
  result.ok
    ? ok(
        new CommittedValue(result.value, {
          committed_unknown: {
            unknown_id: result.value.unknown_id,
            revision: result.value.revision,
            mutation_evidence_ids: result.value.mutation_evidence_ids,
          },
          evidence_reference: {
            kind: "retained-evidence",
            evidence_id: result.value.mutation_evidence_ids[0]!,
          },
        }),
      )
    : result;

/** Rizin debugger sessions a manager owns and the session they may change. */
export interface RizinDebugToolOptions {
  readonly manager: Pick<
    RizinDebugSessionManager,
    "start" | "execute" | "status" | "close" | "retryCleanupFailures"
  >;
  readonly session: ExternalMutationAdmission | undefined;
}

/** objdump and Rizin commands, and the session a Rizin command may change. */
export interface ReverseEngineeringToolOptions {
  readonly service: Pick<
    ReverseEngineeringService,
    "inspectWithObjdump" | "executeRizinCommandValidated" | "retryCleanup"
  >;
  readonly session: ExternalMutationAdmission | undefined;
}

/**
 * Validate a Rizin request and settle earlier inspection cleanup before
 * external-mutation admission, so either refusal leaves the bound target open.
 */
const prepareRizinCommand =
  (service: ReverseEngineeringToolOptions["service"]) =>
  async (input: unknown): Promise<Result<EvidenceCommand, AnalysisError>> => {
    const request = resolveRizinCommandRequest(input);
    if (!request.ok) return request;
    const cleanup = await service.retryCleanup("execute_rizin_command");
    if (!cleanup.ok) return cleanup;
    return ok((signal) =>
      service.executeRizinCommandValidated(request.value, { signal }),
    );
  };

/** GDB sessions a manager owns and the session their commands may change. */
export interface GdbToolOptions {
  readonly manager: Pick<
    GdbSessionManager,
    "start" | "execute" | "status" | "close" | "retryCleanupFailures"
  >;
  readonly session: ExternalMutationAdmission | undefined;
}

/** The Cutter bridge and the session its commands may change. */
export interface CutterToolOptions {
  readonly service: Pick<
    CutterBridgeService,
    "listSessions" | "execute" | "retryCleanup"
  >;
  readonly session: ExternalMutationAdmission | undefined;
}

/** The browser observation provider, or why it failed to load. */
export interface BrowserObservationToolOptions {
  readonly browser: BrowserObservationPort | undefined;
  readonly loadFailure?: OptionalProviderLoadFailure | undefined;
}

/** Passive Electron observation is independent of active scenario capture. */
interface ElectronObservationToolOptions {
  readonly provider: ElectronObservationPort | undefined;
  readonly loadFailure?: OptionalProviderLoadFailure | undefined;
}

/** Existing owned Electron scenario execution and its independent load failure. */
interface ElectronScenarioToolOptions {
  readonly provider: ElectronActiveObservationPort | undefined;
  readonly loadFailure?: OptionalProviderLoadFailure | undefined;
}

/** Static JavaScript analysis needs local artifacts, never an Electron runtime. */
interface JavaScriptApplicationToolOptions {
  readonly resources: ArtifactResourceScope;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly settings?: AnalysisSettingsReader;
}

/** The session native matching reads, and its allowance for each accepted call. */
export interface NativeFunctionMatchingToolOptions {
  readonly session: BinarySessionPort;
  readonly allowance: () => Result<NativeMatchingAllowance, ConfigurationError>;
}

/** The browser scenario provider, or why it failed to load. */
export interface BrowserScenarioToolOptions {
  readonly provider: BrowserScenarioCapturePort | undefined;
  readonly loadFailure?: OptionalProviderLoadFailure | undefined;
}

/** The JavaScript runtime observation provider, or why it failed to load. */
export interface JavaScriptRuntimeToolOptions {
  readonly runtime: JavaScriptRuntimeObservationPort | undefined;
  readonly loadFailure?: OptionalProviderLoadFailure | undefined;
}

/** One family's provider operations and how they run. */
export interface ProviderOperationToolOptions extends ProviderOperationOptions {
  readonly contracts: readonly ToolContract<ProviderOperation>[];
}

/** The tools that drive build computers. */
type DesktopBuildTool =
  | "start_build_computer"
  | "act_on_build_computer"
  | "start_build_capture"
  | "mark_build_checkpoint"
  | "stop_build_capture"
  | "export_build_environment"
  | "check_build_task"
  | "measure_build_task"
  | "record_build_consent"
  | "close_build_computer";

/** The artifact resource scope application workflows read caller-named files under. */
export interface ApplicationWorkflowToolOptions {
  readonly resources: ArtifactResourceScope;
}

/** A requested view, or the summary view a `detail: "summary"` request selects. */
const requestedView = (input: {
  readonly detail?: "complete" | "summary";
  readonly view?: AnalysisViewRequest | undefined;
}): AnalysisViewRequest | undefined =>
  input.view ?? (input.detail === "summary" ? { kind: "summary" } : undefined);

const exportEnvironmentBundleContract = toolContract(
  "export_environment_bundle",
);

/** A completed workflow that leaves no residual unknown. */
const settledResult = (
  result: Result<EvidenceWorkflowExecution, AnalysisError>,
): Result<InvestigationWorkflowExecution, AnalysisError> =>
  result.ok ? ok(settledExecution(result.value)) : result;

/** Artifact resources a selected view may read, when the server owns them. */
export interface AnalysisViewToolOptions {
  readonly resources?: ArtifactResourceScope | undefined;
}

const viewInputSourceSchema = z.looseObject({
  source: analysisViewSourceSchema,
});

/**
 * The source overflow recovery may name again. An inline record cannot be
 * repeated within the response it just overflowed, so it has none.
 */
const analysisViewOverflowSource = (input: unknown): JsonValue | undefined => {
  const parsed = viewInputSourceSchema.safeParse(input);
  return parsed.success && parsed.data.source.kind !== "inline"
    ? jsonValueSchema.parse(parsed.data.source)
    : undefined;
};

/** Deliver a workflow's typed output as the JSON value its contract declares. */
const jsonValueResult = <Error>(
  result: Result<unknown, Error>,
): Result<JsonValue, Error> =>
  result.ok ? ok(jsonValueSchema.parse(result.value)) : result;

type Bind<Service> = (
  service: Service,
  retention: AnalysisViewRetention,
) => ContractToolBindings;

/**
 * The MCP binding of every service-backed contract, keyed by the service that
 * runs it. Production composition and MCP tests both bind from this table,
 * so a test exercises the same handler kind, admission and dependencies.
 */
const SERVICE_TOOL_BINDINGS = {
  byteEntropy: ((service) => ({
    inspect_byte_entropy: {
      admission: "sdk",
      summary: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<ByteEntropyService>,
  peResources: ((service) => ({
    inspect_pe_resources: {
      admission: "application",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<PeResourcesService>,
  nativeExports: ((service) => ({
    inspect_native_exports: {
      admission: "application",
      summary: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<NativeExportsService>,
  devicetree: ((service) => ({
    inspect_devicetree: {
      admission: "application",
      summary: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<DevicetreeService>,
  elfNotes: ((service) => ({
    inspect_elf_notes: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<ElfNotesService>,
  elfDebugLink: ((service) => ({
    inspect_elf_debug_link: {
      admission: "application",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<ElfDebugLinkService>,
  nativeInitializers: ((service) => ({
    inspect_native_initializers: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<NativeInitializersService>,
  elfUnwindRanges: ((service) => ({
    inspect_elf_unwind_ranges: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<ElfUnwindRangesService>,
  appleIps: ((service) => ({
    inspect_apple_ips: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<AppleIpsService>,
  kernelModule: ((service) => ({
    inspect_kernel_module: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<KernelModuleService>,
  kernelBuildConfig: ((service) => ({
    inspect_kernel_build_config: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<KernelBuildConfigService>,
  peLoadConfig: ((service) => ({
    inspect_pe_load_config: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<PeLoadConfigService>,
  releaseExposure: ((service) => ({
    audit_release_exposure: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<ReleaseExposureService>,
  binaryHardening: ((service) => ({
    inspect_binary_hardening: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<BinaryHardeningService>,
  peCertificates: ((service) => ({
    inspect_pe_certificates: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<PeCertificatesService>,
  peImports: ((service) => ({
    inspect_pe_imports: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<PeImportsService>,
  windowsShortcut: ((service) => ({
    inspect_windows_shortcut: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<WindowsShortcutService>,
  recordedCrash: ((service) => ({
    inspect_recorded_crash: {
      admission: "application",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<RecordedCrashService>,
  desktopApplication: ((service) => ({
    inspect_desktop_application: {
      admission: "application",
      summary: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<DesktopApplicationService>,
  modelArtifact: ((service, retention) => ({
    inspect_model_artifact: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options, retention),
    },
  })) satisfies Bind<ModelArtifactService>,
  gpuCodeObjects: ((service, retention) => ({
    inspect_gpu_code_objects: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options, retention),
    },
  })) satisfies Bind<GpuCodeObjectsService>,
  evmInterface: ((service) => ({
    inspect_evm_interface: {
      admission: "application",
      summary: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<EvmInterfaceService>,
  goBinary: ((service, retention) => ({
    inspect_go_binary: {
      admission: "application",
      run: (input, options) => service.inspect(input, options, retention),
    },
  })) satisfies Bind<GoBinaryService>,
  il2cppMetadata: ((service, retention) => ({
    inspect_il2cpp_metadata: {
      admission: "application",
      run: (input, options) => service.inspect(input, options, retention),
    },
  })) satisfies Bind<Il2cppMetadataService>,
  rustBinary: ((service, retention) => ({
    inspect_rust_binary: {
      admission: "application",
      run: (input, options) => service.inspect(input, options, retention),
    },
  })) satisfies Bind<RustBinaryService>,
  nugetNupkg: ((service) => ({
    inspect_nuget_nupkg: {
      admission: "application",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<NugetNupkgService>,
  pythonPyc: ((service) => ({
    inspect_python_pyc: {
      admission: "application",
      summary: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<PythonPycService>,
  erlangBeam: ((service) => ({
    inspect_erlang_beam: {
      admission: "application",
      summary: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<BeamService>,
  v8CodeCache: ((service) => ({
    inspect_v8_code_cache: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<V8CodeCacheService>,
  wasmArtifact: ((service, retention) => ({
    compare_wasm_interfaces: {
      admission: "sdk",
      run: async (rawInput, options) => {
        const result = retainAnalysisResultSources(
          "compare_wasm_interfaces",
          retention.recordEvidence,
          await compareWasmInterfaces(
            rawInput,
            options,
            retention.evidenceById,
          ),
          { sourceOwner: "caller" },
        );
        return result.ok ? ok(result.value.evidence) : result;
      },
    },
    inspect_wasm_artifact: {
      admission: "application",
      summary: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<Pick<WasmArtifactService, "inspect">>,
  apkSignature: ((service, retention) => ({
    inspect_apk_signature: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options, retention),
    },
  })) satisfies Bind<Pick<ApkSignatureService, "inspect">>,
  sqliteDatabase: ((service) => ({
    inspect_sqlite_database: {
      admission: "application",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<SqliteDatabaseService>,
  packetCapture: ((service) => ({
    inspect_packet_capture: {
      admission: "application",
      run: (input, options) => service.inspect(input, options),
    },
    inspect_packet_fields: {
      admission: "sdk",
      run: (input, options) => service.inspectFields(input, options),
    },
  })) satisfies Bind<PacketCaptureService>,
  signalRecording: ((service) => ({
    decode_signal_recording: {
      admission: "application",
      run: (input, options) => service.decode(input, options),
    },
    inspect_signal_decoders: {
      admission: "sdk",
      run: (input, options) => service.inspectDecoders(input, options),
    },
  })) satisfies Bind<SignalRecordingService>,
  firmwareAnalysis: ((service) =>
    contractServiceBindings(service, [
      "inspect_firmware_regions",
      "extract_firmware",
    ])) satisfies Bind<FirmwareAnalysisService>,
  uefiAnalysis: ((service) =>
    contractServiceBindings(service, [
      "inspect_uefi_firmware",
      "extract_uefi_firmware",
      "inspect_uefi_nvram",
    ])) satisfies Bind<UefiAnalysisService>,
  pcapAnalysis: ((service) => ({
    ...contractServiceBindings(service, ["inspect_pcap_client"]),
    inspect_pcap_capture: {
      admission: "application",
      summary: (input, options) =>
        service.execute("inspect_pcap_capture", input, options),
    },
  })) satisfies Bind<PcapAnalysisService>,
  flutterAnalysis: ((service, retention) => ({
    ...contractServiceBindings(service, ["identify_flutter_build"]),
    inspect_dart_aot: {
      admission: "sdk",
      run: (input, options) =>
        inspectDartAot(service, input, retention, options),
    },
  })) satisfies Bind<FlutterBuildAnalysisService>,
  androidAnalysis: ((service, retention) => ({
    ...contractServiceBindings(service, [
      "search_android_classes",
      "trace_android_references",
    ]),
    inspect_android_package: {
      admission: "sdk",
      run: (input, options) =>
        inspectAndroidPackage(service, input, retention, options),
    },
    inspect_android_jni_bindings: {
      admission: "sdk",
      run: (input, options) =>
        inspectAndroidJniBindings(service, input, retention, options),
    },
    inspect_android_class: {
      admission: "sdk",
      run: (input, options) =>
        inspectAndroidSymbol(
          service,
          "inspect_android_class",
          input,
          retention,
          options,
        ),
    },
    inspect_android_method: {
      admission: "sdk",
      run: (input, options) =>
        inspectAndroidSymbol(
          service,
          "inspect_android_method",
          input,
          retention,
          options,
        ),
    },
  })) satisfies Bind<AndroidAnalysisService>,
  apktoolAnalysis: ((service) =>
    contractServiceBindings(service, [
      "inspect_apktool_client",
      "decode_android_resources",
    ])) satisfies Bind<ApktoolResourceAnalysisService>,
  jebAnalysis: ((service) =>
    contractServiceBindings(service, [
      "inspect_jeb_client",
      "open_jeb_project",
      "list_jeb_units",
      "decompile_jeb_item",
    ])) satisfies Bind<JebAnalysisService>,
  adbDeviceAnalysis: ((service) =>
    contractServiceBindings(service, [
      "inspect_adb_client",
      "list_adb_devices",
      "inspect_adb_device",
      "list_adb_packages",
      "pull_adb_package",
      "read_adb_logcat",
      "inspect_adb_package",
      "pull_adb_file",
      "push_adb_file",
      "capture_adb_screen",
      "list_adb_processes",
      "list_adb_directory",
      "list_adb_features",
      "list_adb_services",
      "inspect_adb_display",
      "inspect_adb_window",
      "read_adb_setting",
      "collect_adb_bugreport",
      "resolve_adb_packages",
      "install_adb_package",
      "uninstall_adb_package",
      "start_adb_app",
      "start_adb_activity",
      "stop_adb_app",
    ])) satisfies Bind<AdbDeviceAnalysisService>,
  webModuleTrace: ((service) => ({
    trace_web_module_imports: {
      admission: "application",
      run: (input, options) => service.trace(input, options),
    },
  })) satisfies Bind<WebModuleTraceService>,
  webSourceLocation: ((service) => ({
    trace_web_source_location: {
      admission: "application",
      summary: (input, options) => service.trace(input, options),
    },
  })) satisfies Bind<WebSourceLocationService>,
  webNetworkCapture: ((service, retention) => {
    const contract = toolContract("inspect_web_network_capture");
    const delivery = retainedSummaryDelivery(contract.name, retention);
    return {
      inspect_web_network_capture: {
        // The workflow admits the raw request so caller-declared sensitivity
        // also covers invalid arguments; SDK admission would emit unprojected
        // issue paths as plain text.
        admission: "application",
        run: async (rawInput, options) => {
          const parsed = contract.inputSchema.safeParse(rawInput);
          if (!parsed.success)
            return err(
              redactExplicitFailure(
                analysisInputErrorFromIssues(
                  contract.name,
                  parsed.error.issues,
                  rawInput,
                  { cause: parsed.error },
                ),
                captureSensitiveValues(rawInput),
              ),
            );
          const { detail, ...input } = parsed.data;
          const parameters = { detail };
          const ready = delivery.preflight(parameters);
          if (!ready.ok) return ready;
          const inspected = await service.inspect(input, options);
          return inspected.ok
            ? delivery.projectEvidence(parameters, inspected.value)
            : inspected;
        },
      },
    };
  }) satisfies Bind<WebNetworkCaptureService>,
  webRuntime: ((service) => ({
    observe_web_execution: {
      admission: "sdk",
      run: (input, options) => service.observe(input, options),
    },
    inspect_web_event_listeners: {
      admission: "sdk",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<WebRuntimeService>,
  webScripts: ((resources) => ({
    export_web_scripts: {
      admission: "sdk",
      run: (input, options) =>
        exportWebScriptsValidated(input, resources, options),
    },
  })) satisfies Bind<ArtifactResourceScope>,
  javascriptRecovery: ((service) => ({
    recover_javascript_sources: {
      admission: "sdk",
      run: (input, options) => service.recover(input, options),
    },
  })) satisfies Bind<JavaScriptRecoveryService>,
  mavenGradleMetadata: ((service) => ({
    inspect_maven_gradle_metadata: {
      admission: "application",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<MavenGradleMetadataService>,
  dwarfUnits: ((service) => ({
    inspect_dwarf_units: {
      admission: "application",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<DwarfUnitsService>,
  elfDependencies: ((service) => ({
    inspect_elf_dependencies: {
      admission: "application",
      summary: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<ElfDependenciesService>,
  guidance: ((resources) => ({
    search_guidance: {
      admission: "application",
      value: async (input) =>
        jsonValueResult(await searchGuidance(input, resources)),
    },
    read_guidance_section: {
      admission: "application",
      value: async (input) =>
        jsonValueResult(await readGuidanceSection(input, resources)),
    },
  })) satisfies Bind<ArtifactResourceScope>,
  // Cutter discovery reads only; an arbitrary command may change the bound
  // artifact, so it runs under external-mutation admission.
  cutter: (({ service, session }) => ({
    list_cutter_sessions: {
      admission: "sdk",
      value: async (_input, { signal }) => {
        const listed = await service.listSessions({ signal });
        return listed.ok
          ? ok({ ...listed.value, sessions: [...listed.value.sessions] })
          : listed;
      },
    },
    cutter_command: {
      admission: "sdk",
      session,
      mutation: {
        kind: "evidence",
        retryCleanup: () => service.retryCleanup(),
        run: (input, signal) => service.execute(input, { signal }),
      },
    },
  })) satisfies Bind<CutterToolOptions>,
  // Runtime settings remain usable without an active target or healthy
  // provider, so they run outside analysis admission.
  analysisSettings: (({ settings, delivery }) => ({
    inspect_analysis_settings: {
      admission: "sdk",
      value: async (input) =>
        jsonValueResult(
          ok({
            ...settings.inspect(input),
            constraints: analysisSettingsConstraints(delivery),
          }),
        ),
    },
    update_analysis_settings: {
      admission: "application",
      value: async (input) => jsonValueResult(settings.update(input)),
    },
  })) satisfies Bind<AnalysisSettingsToolOptions>,
  // A selected view of other Evidence; its overflow recovery can name the
  // same retained source again.
  analysisView: (({ resources }, retention) => ({
    inspect_analysis_view: {
      admission: "application",
      viewSource: analysisViewOverflowSource,
      run: (input, { signal }) =>
        inspectAnalysisView(input, retention.evidenceById, {
          ...(signal === undefined ? {} : { signal }),
          ...(resources === undefined ? {} : { resources }),
        }),
    },
  })) satisfies Bind<AnalysisViewToolOptions>,
  sessionDerived: (({ session, resources }) => ({
    compare_functions: {
      admission: "sdk",
      session,
      derive: (input, evidenceForAnalysis, signal) =>
        compareFunctionEvidence(input, evidenceForAnalysis, signal),
    },
    compare_process_captures: {
      admission: "sdk",
      session,
      derive: (input, evidenceForAnalysis, signal) =>
        compareProcessEvidence(input, evidenceForAnalysis, { signal }),
    },
    // Investigation workflows validate their own raw request.
    find_changed_behavior: {
      admission: "application",
      session,
      derive: (input, evidenceForAnalysis, signal) =>
        findChangedBehaviorEvidence(input, { evidenceForAnalysis }, signal),
    },
    build_call_path: {
      admission: "application",
      session,
      derive: (input, evidenceForAnalysis, signal) =>
        buildCallPathEvidence(input, { evidenceForAnalysis }, signal),
    },
    correlate_static_and_runtime: {
      admission: "application",
      session,
      derive: (input, evidenceForAnalysis, signal) =>
        correlateStaticAndRuntimeEvidence(
          input,
          { evidenceForAnalysis },
          signal,
        ),
    },
    // Verification reads the session's immutable bundle as a whole.
    verify_reconstruction: {
      admission: "sdk",
      session,
      derive: (input) => verifyReconstructionEvidence(input, session),
    },
    // Comparisons of caller-named files read them under the server's
    // artifact resource scope before deriving.
    compare_artifacts: {
      admission: "application",
      session,
      resources,
      acquire: async (input, { evidenceForAnalysis, signal, resources }) => {
        const sources = await resolveArtifactComparisonSources(
          input,
          evidenceForAnalysis,
          { signal, resources },
        );
        return sources.ok
          ? ok(() => artifactComparisonExecution(sources.value))
          : sources;
      },
    },
    compare_bundles: {
      admission: "sdk",
      session,
      resources,
      acquire: async (input, { signal, resources }) => {
        const sources = await readBundleComparisonSources(input, {
          signal,
          resources,
        });
        return sources.ok
          ? ok(() => bundleComparisonExecution(sources.value))
          : sources;
      },
    },
  })) satisfies Bind<SessionDerivedToolOptions>,
  // Managed-code workflows derive from session-held managed and native
  // Evidence; the CLI runs the same owners without a session.
  managedWorkflows: ((session) => ({
    compare_managed_members: {
      admission: "sdk",
      session,
      derive: (input, evidenceForAnalysis, signal) =>
        compareManagedMembersExecution(input, evidenceForAnalysis, { signal }),
    },
    verify_managed_native_boundaries: {
      admission: "sdk",
      session,
      derive: (input, evidenceForAnalysis, signal) =>
        verifyManagedNativeBoundariesExecution(input, evidenceForAnalysis, {
          signal,
        }),
    },
    import_managed_reconstruction: {
      admission: "sdk",
      session,
      derive: (input, evidenceForAnalysis, signal) =>
        importManagedReconstructionExecution(input, evidenceForAnalysis, {
          signal,
        }),
    },
    project_managed_application_graph: {
      admission: "sdk",
      session,
      derive: (input, evidenceForAnalysis, signal) =>
        projectManagedApplicationGraphExecution(input, evidenceForAnalysis, {
          signal,
        }),
    },
  })) satisfies Bind<BinarySessionPort>,
  // Application workflows complete Evidence from session-held Evidence or
  // caller-named files under analysis admission; a requested view or summary
  // is staged against it.
  applicationWorkflows: (({ resources }, { evidenceById }) => {
    const playwright = new PlaywrightTraceService(
      new PlaywrightTraceDecoder(resources),
    );
    return {
      trace_application_feature: {
        admission: "sdk",
        view: ({ view }) => view,
        workflow: async ({ view: _selected, ...input }, { signal }) =>
          settledResult(
            traceApplicationFeatureEvidence(input, evidenceById, { signal }),
          ),
      },
      trace_javascript_semantics: {
        admission: "sdk",
        workflow: async (input, { signal }) =>
          settledResult(
            traceJavaScriptSemanticsEvidence(input, evidenceById, { signal }),
          ),
      },
      compare_application_versions: {
        admission: "sdk",
        workflow: async (input, { signal }) =>
          compareApplicationVersionsExecution(input, evidenceById, { signal }),
      },
      compare_static_and_observed_endpoints: {
        admission: "sdk",
        view: requestedView,
        workflow: async (input, { signal }) =>
          settledResult(
            await compareStaticAndObservedEndpointsEvidence(
              input,
              evidenceById,
              { signal },
            ),
          ),
      },
      inspect_api_contract: {
        admission: "sdk",
        view: requestedView,
        workflow: async (input, { signal }) =>
          inspectionExecution(
            await inspectApiContractEvidence(input, resources, { signal }),
          ),
      },
      inspect_ntfs_journal: {
        admission: "sdk",
        workflow: async (input, { signal }) =>
          inspectionExecution(
            await inspectNtfsJournalEvidence(input, resources, signal),
          ),
      },
      inspect_warc_archive: {
        admission: "application",
        run: async (input, options) => {
          const inspected = await inspectWarcArchiveEvidence(
            input,
            resources,
            options,
          );
          return inspected.ok ? ok(inspected.value.evidence) : inspected;
        },
      },
      inspect_playwright_trace: {
        admission: "sdk",
        view: requestedView,
        workflow: async (input, { signal }) =>
          inspectionExecution(await playwright.inspect(input, signal)),
      },
      compare_source_to_bundle: {
        admission: "sdk",
        view: ({ view }) => view,
        workflow: (input, { signal }) =>
          sourceToBundleComparisonExecution(input, evidenceById, resources, {
            signal,
          }),
      },
      compare_javascript_export_shapes: {
        admission: "sdk",
        workflow: async (input, { signal }) =>
          compareJavaScriptExportShapesExecution(input, evidenceById, {
            signal,
          }),
      },
      // The ledger refuses Evidence formats through the format owner.
      build_reconstruction_obligation_ledger: {
        admission: "application",
        workflow: async (input) =>
          reconstructionObligationLedgerExecution(input),
      },
      project_android_application_graph: {
        admission: "sdk",
        workflow: async (input, { signal }) =>
          settledResult(
            projectAndroidApplicationEvidence(input, evidenceById, { signal }),
          ),
      },
      project_apple_application_graph: {
        admission: "sdk",
        workflow: async (input, { signal }) =>
          settledResult(
            projectAppleApplicationEvidence(input, evidenceById, { signal }),
          ),
      },
      project_harmony_application_graph: {
        admission: "sdk",
        workflow: async (input, { signal }) =>
          settledResult(
            projectHarmonyApplicationEvidence(input, evidenceById, { signal }),
          ),
      },
      // Plain results under the same admission as the workflows above.
      evaluate_reconstruction_coverage: {
        admission: "application",
        admitted: true,
        value: async (input) => evaluateReconstructionCoverage(input),
      },
      // The export validates its own request so refusals name the field.
      export_environment_bundle: {
        admission: "application",
        admitted: true,
        value: async (rawInput, { signal }) => {
          const parsed =
            exportEnvironmentBundleContract.inputSchema.safeParse(rawInput);
          return parsed.success
            ? exportEnvironmentBundleTool(parsed.data, evidenceById, {
                signal,
              })
            : err(
                analysisInputErrorFromIssues(
                  exportEnvironmentBundleContract.name,
                  parsed.error.issues,
                  rawInput,
                  { cause: parsed.error },
                ),
              );
        },
      },
    };
  }) satisfies Bind<ApplicationWorkflowToolOptions>,
  // Provider-backed workflows run on the analysis admission grants and
  // complete their Evidence in the session, when the server has one.
  enhancedWorkflows: (({ session }) => ({
    trace_native_values: {
      admission: "sdk",
      analyze: (input, analysis, request) =>
        executeSessionWorkflowEvidence(
          { name: "trace_native_values", input },
          analysis,
          session,
          request,
        ),
    },
    inspect_native_dispatch_metadata: {
      admission: "sdk",
      analyze: (input, analysis, request) =>
        executeSessionWorkflowEvidence(
          { name: "inspect_native_dispatch_metadata", input },
          analysis,
          session,
          request,
        ),
    },
    get_objc_classes: {
      admission: "sdk",
      analyze: (input, analysis, request) =>
        executeSessionWorkflowEvidence(
          { name: "get_objc_classes", input },
          analysis,
          session,
          request,
        ),
    },
    get_objc_protocols: {
      admission: "sdk",
      analyze: (input, analysis, request) =>
        executeSessionWorkflowEvidence(
          { name: "get_objc_protocols", input },
          analysis,
          session,
          request,
        ),
    },
    batch_decompile: {
      admission: "sdk",
      detail: "delivery",
      analyze: (input, analysis, request) =>
        executeSessionWorkflowEvidence(
          { name: "batch_decompile", input },
          analysis,
          session,
          request,
        ),
    },
    decompile_all: {
      admission: "sdk",
      analyze: (input, analysis, request) =>
        executeSessionWorkflowEvidence(
          { name: "decompile_all", input },
          analysis,
          session,
          request,
        ),
    },
    get_call_graph: {
      admission: "sdk",
      detail: "delivery",
      analyze: (input, analysis, request) =>
        executeSessionWorkflowEvidence(
          { name: "get_call_graph", input },
          analysis,
          session,
          request,
        ),
    },
    analyze_swift_types: {
      admission: "sdk",
      analyze: (input, analysis, request) =>
        executeSessionWorkflowEvidence(
          { name: "analyze_swift_types", input },
          analysis,
          session,
          request,
        ),
    },
    find_xrefs_to_name: {
      admission: "sdk",
      analyze: (input, analysis, request) =>
        executeSessionWorkflowEvidence(
          { name: "find_xrefs_to_name", input },
          analysis,
          session,
          request,
        ),
    },
    binary_overview: {
      admission: "sdk",
      analyze: (input, analysis, request) =>
        executeSessionWorkflowEvidence(
          { name: "binary_overview", input },
          analysis,
          session,
          request,
        ),
    },
    inspect_native_api: {
      admission: "sdk",
      analyze: (input, analysis, request) =>
        executeSessionWorkflowEvidence(
          { name: "inspect_native_api", input },
          analysis,
          session,
          request,
        ),
    },
    trace_feature: {
      admission: "sdk",
      detail: "delivery",
      analyze: (input, analysis, request) =>
        executeSessionWorkflowEvidence(
          { name: "trace_feature", input },
          analysis,
          session,
          request,
        ),
    },
    trace_call_path: {
      admission: "sdk",
      analyze: (input, analysis, request) =>
        executeSessionWorkflowEvidence(
          { name: "trace_call_path", input },
          analysis,
          session,
          request,
        ),
    },
    trace_native_ui_action: {
      admission: "sdk",
      analyze: (input, analysis, request) =>
        executeSessionWorkflowEvidence(
          { name: "trace_native_ui_action", input },
          analysis,
          session,
          request,
        ),
    },
    analyze_function: {
      admission: "sdk",
      detail: "delivery",
      analyze: (input, analysis, request) =>
        executeSessionFunctionAnalysis(input, analysis, session, request),
    },
  })) satisfies Bind<{ readonly session: WorkflowSession | undefined }>,
  // The session's Evidence bundle and residual unknowns, read and written
  // under session admission.
  sessionRecords: (({ session, resources }) => ({
    export_evidence_bundle: {
      admission: "sdk",
      admitted: true,
      value: async (input, { signal }) => {
        const bundle = session.immutableEvidenceBundle();
        const written = await writeEvidenceBundle(
          bundle,
          input.path,
          input.overwrite,
          resources,
          signal,
        );
        return written.ok
          ? ok(evidenceBundleExportReceipt(bundle, written.value))
          : written;
      },
    },
    import_evidence_bundle: {
      admission: "sdk",
      admitted: true,
      value: async (input, { signal }) => {
        const loaded = await readImmutableEvidenceBundle(
          input.path,
          signal,
          resources,
          "import_evidence_bundle",
        );
        if (!loaded.ok) return loaded;
        if (signal.aborted)
          return err(cancelledBy("import_evidence_bundle", signal));
        const imported = session.importEvidenceBundle(loaded.value);
        return imported.ok
          ? ok({
              imported: imported.value.recordsAdded,
              unknowns_added: imported.value.unknownsAdded,
              total: imported.value.totalRecords,
            })
          : imported;
      },
    },
    get_evidence_bundle: {
      admission: "sdk",
      admitted: true,
      value: async (input) =>
        inspectEvidenceBundle(session.immutableEvidenceBundle(), input),
    },
    list_unknowns: {
      admission: "sdk",
      admitted: true,
      value: async (input) =>
        ok(
          session.listUnknownsPage({
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.severity === undefined
              ? {}
              : { severity: input.severity }),
            ...(input.domain === undefined ? {} : { domain: input.domain }),
            offset: input.offset,
            ...(input.limit === undefined ? {} : { limit: input.limit }),
          }),
        ),
    },
    record_unknown: {
      admission: "sdk",
      admitted: true,
      value: async (input) => committedUnknown(session.recordUnknown(input)),
    },
    update_unknown: {
      admission: "sdk",
      admitted: true,
      value: async (input) => committedUnknown(session.updateUnknown(input)),
    },
    verify_unknown_resolution: {
      admission: "sdk",
      admitted: true,
      value: async (input) => session.verifyUnknownResolution(input.unknown_id),
    },
  })) satisfies Bind<SessionDerivedToolOptions>,
  // objdump inspects under analysis admission. A Rizin command may change
  // the bound artifact, so it runs under external-mutation admission once
  // its request is valid and earlier inspection cleanup has settled; a
  // refusal before then leaves the bound target open.
  reverseEngineering: (({ service, session }, retention) => ({
    inspect_with_objdump: {
      admission: "sdk",
      run: (input, options) =>
        service.inspectWithObjdump(input, options, retention),
    },
    execute_rizin_command: {
      admission: "sdk",
      session,
      mutation: {
        kind: "evidence",
        retryCleanup: () => service.retryCleanup("execute_rizin_command"),
        prepare: prepareRizinCommand(service),
      },
    },
  })) satisfies Bind<ReverseEngineeringToolOptions>,
  // Rizin debugger sessions may change the bound artifact; each command
  // runs under external-mutation admission and keeps a failed cleanup owned.
  rizinDebug: (({ manager, session }) => {
    const retryCleanup = () => manager.retryCleanupFailures();
    return {
      start_rizin_debug_session: {
        admission: "sdk",
        session,
        mutation: {
          kind: "value",
          retryCleanup,
          run: async (input, signal) => {
            const started = await manager.start(
              {
                path: input.path,
                inferior_tty: input.inferior_tty,
                ...(input.backend === undefined
                  ? {}
                  : { backend: input.backend }),
              },
              signal,
            );
            return started.ok
              ? ok({
                  value: started.value,
                  retained: { session_id: started.value.session_id },
                })
              : started;
          },
        },
      },
      rizin_debug_command: {
        admission: "sdk",
        session,
        mutation: {
          kind: "evidence",
          retryCleanup,
          run: async (input, signal) => {
            const executed = await manager.execute(
              input.session_id,
              input.command,
              signal,
            );
            return executed.ok ? ok(executed.value.evidence) : executed;
          },
        },
      },
      rizin_debug_session_status: {
        admission: "sdk",
        value: async (input) => {
          const status = manager.status(input.session_id);
          return status === undefined
            ? err(
                unknownDebuggerSessionError(
                  RIZIN_DEBUG_SESSION_TOOLS,
                  "rizin_debug_session_status",
                ),
              )
            : ok({ ...status, recent_output: [...status.recent_output] });
        },
      },
      close_rizin_debug_session: {
        admission: "sdk",
        session,
        mutation: {
          kind: "owned-cleanup",
          resource: (input) => input.session_id,
          run: (input) => manager.close(input.session_id),
        },
      },
    };
  }) satisfies Bind<RizinDebugToolOptions>,
  // Starting GDB may load a selected file without running it, outside mutation admission; a console
  // command may change the bound artifact and runs under external-mutation
  // admission, keeping a failed cleanup owned for the next retry.
  gdb: (({ manager, session }) => ({
    start_gdb_session: {
      admission: "sdk",
      value: (input, { signal }) =>
        manager.start(signal, {
          ...(input.inferior_tty === undefined
            ? {}
            : { inferiorTty: input.inferior_tty }),
          ...(input.executable === undefined
            ? {}
            : { executable: input.executable }),
        }),
    },
    gdb_console: {
      admission: "sdk",
      session,
      mutation: {
        kind: "evidence",
        detail: "delivery",
        retryCleanup: () => manager.retryCleanupFailures(),
        run: async (input, signal) => {
          const executed = await manager.execute(
            input.session_id,
            input.command,
            signal,
          );
          return executed.ok ? ok(executed.value.evidence) : executed;
        },
      },
    },
    gdb_session_status: {
      admission: "sdk",
      value: async (input) => {
        const status = manager.status(input.session_id);
        return status === undefined
          ? err(
              unknownDebuggerSessionError(
                GDB_SESSION_TOOLS,
                "gdb_session_status",
              ),
            )
          : ok({ ...status, recent_mi_records: [...status.recent_mi_records] });
      },
    },
    close_gdb_session: {
      admission: "sdk",
      session,
      mutation: {
        kind: "owned-cleanup",
        resource: (input) => input.session_id,
        run: (input) => manager.close(input.session_id),
      },
    },
  })) satisfies Bind<GdbToolOptions>,
  // Browser observation runs through an optional provider; when it failed
  // to load, every call reports it unavailable before admission.
  browserObservation: (({ browser, loadFailure }, retention) => {
    const optional = { unavailable: loadFailure };
    return {
      list_browser_targets: {
        admission: "sdk",
        ...optional,
        run: (input, options) => listBrowserTargets(browser, input, options),
      },
      inspect_web_page: {
        admission: "sdk",
        ...optional,
        run: (input, options) => inspectWebPage(browser, input, options),
      },
      analyze_web_bundle: {
        admission: "sdk",
        ...optional,
        run: async ({ detail, view, ...request }, options) => {
          if (detail === "summary") {
            const ready = requireAnalysisViewRetention(
              "analyze_web_bundle",
              retention,
            );
            if (!ready.ok) return ready;
          }
          const analyzed = await analyzeWebBundle(browser, request, options);
          return analyzed.ok && view !== undefined
            ? projectRetainedAnalysis(analyzed.value, retention, view)
            : analyzed;
        },
      },
      observe_web_session: {
        admission: "sdk",
        ...optional,
        run: (input, options) => observeWebSession(browser, input, options),
      },
      discover_webmcp_tools: {
        admission: "sdk",
        ...optional,
        run: (input, options) => discoverWebMcpTools(browser, input, options),
      },
      compare_web_captures: {
        admission: "sdk",
        ...optional,
        run: (input) => compareWebCaptureEvidence(browser, input),
      },
      capture_web_screenshot: {
        admission: "sdk",
        ...optional,
        run: (input, options) => captureWebScreenshot(browser, input, options),
      },
      compare_web_screenshots: {
        admission: "sdk",
        ...optional,
        run: (input) => compareWebScreenshotEvidence(browser, input),
      },
    };
  }) satisfies Bind<BrowserObservationToolOptions>,
  electronFuses: ((service) => ({
    inspect_electron_fuses: {
      admission: "application",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<Pick<ElectronFuseService, "inspect">>,
  electronObservation: (({ provider, loadFailure }) => ({
    list_electron_targets: {
      admission: "sdk",
      unavailable: loadFailure,
      run: (input, options) => listElectronTargets(provider, input, options),
    },
    inspect_electron_page: {
      admission: "sdk",
      unavailable: loadFailure,
      run: (input, options) => inspectElectronPage(provider, input, options),
    },
  })) satisfies Bind<ElectronObservationToolOptions>,
  // Keep active capture separate from passive observation and static analysis.
  // Its existing service owns execution admission, effects and cleanup.
  electronScenario: (({ provider, loadFailure }) => ({
    capture_electron_scenario: {
      admission: "sdk",
      unavailable: loadFailure,
      run: (input, options) =>
        captureElectronScenario(provider, input, options),
    },
  })) satisfies Bind<ElectronScenarioToolOptions>,
  javascriptApplication: ((
    { resources, environment, settings },
    retention,
  ) => ({
    analyze_javascript_application: {
      admission: "sdk",
      run: async ({ detail, view, ...request }, options) => {
        if (detail === "summary") {
          const ready = requireAnalysisViewRetention(
            "analyze_javascript_application",
            retention,
          );
          if (!ready.ok) return ready;
        }
        const analyzed = await analyzeJavaScriptApplicationValidated(
          request,
          resources,
          {
            ...options,
            sourceAnalysis: javascriptSourceAnalysis,
            environment,
            ...(settings === undefined ? {} : { settings }),
          },
        );
        return detail === "summary" && analyzed.ok
          ? projectRetainedAnalysis(
              analyzed.value,
              retention,
              view ?? { kind: "summary" },
            )
          : analyzed;
      },
    },
    reconcile_javascript_runtime: {
      admission: "sdk",
      run: async (input, options) => {
        const result = reconcileJavaScriptRuntimeEvidence(
          input,
          retention.evidenceById,
          options,
        );
        if (!result.ok) return result;
        const recorded = recordEvidenceSources(
          retention.recordEvidence,
          result.value.sources,
          { evidence: result.value.evidence },
        );
        return recorded.ok ? ok(result.value.evidence) : recorded;
      },
    },
  })) satisfies Bind<JavaScriptApplicationToolOptions>,
  // Frida sessions instrument a live process the caller selects, not the
  // session's target; compose them without analysis admission.
  frida: ((service, retention) => ({
    list_frida_devices: {
      admission: "sdk",
      value: async (input) =>
        jsonValueResult(
          await service.listDevices(fridaRemoteConnection(input.remote)),
        ),
    },
    list_frida_processes: {
      admission: "sdk",
      value: async (input) =>
        jsonValueResult(
          await service.listProcesses(fridaDeviceSelection(input)),
        ),
    },
    start_frida_session: {
      admission: "sdk",
      value: async (input, { signal }) =>
        jsonValueResult(await startFridaSession(service, input, signal)),
    },
    load_frida_script: {
      admission: "sdk",
      run: (input, { signal }) => loadFridaScript(service, input, signal),
    },
    resume_frida_session: {
      admission: "sdk",
      value: async (input, { signal }) => {
        const resumed = await service.resumeSession(input.session_id, signal);
        return resumed.ok ? ok({ state: "running" }) : resumed;
      },
    },
    unload_frida_script: {
      admission: "sdk",
      value: async (input, { signal }) => {
        const unloaded = await service.unloadScript(
          input.session_id,
          input.script_id,
          signal,
        );
        return unloaded.ok ? ok({ unloaded: true }) : unloaded;
      },
    },
    frida_session_status: {
      admission: "sdk",
      run: async (input) => service.inspectStatus(input, retention),
    },
    close_frida_session: {
      admission: "sdk",
      value: async (input) => {
        const closed = await service.closeSession(input.session_id);
        return closed.ok ? ok({ target_state: "unknown" }) : closed;
      },
    },
    instrument_with_frida: {
      admission: "sdk",
      run: async (input, { signal }) => {
        const instrumented = await instrumentWithFrida(service, input, signal);
        return instrumented.ok ? ok(instrumented.value.evidence) : instrumented;
      },
    },
  })) satisfies Bind<FridaInstrumentationService>,
  // Opening a target orders itself in the session, so it runs outside
  // analysis admission; a failed open reports the selection at failure.
  binaryTarget: ((session) => ({
    open_binary: {
      admission: "sdk",
      value: async (input, { signal }) => {
        const snapshotPath = input.snapshot_path;
        const opened = await session.open(input.path, {
          signal,
          ...openBinaryTargetSelection(input),
          ...(input.provider_id === undefined
            ? {}
            : { providerId: input.provider_id }),
          ...(snapshotPath === undefined
            ? {}
            : {
                // Read inside the open's turn: calls issued after it must not
                // overtake a file read that precedes its place in the order.
                loadSnapshot: () =>
                  session.readAnalysisSnapshot(snapshotPath, signal),
              }),
        });
        return opened.ok
          ? ok(binaryTargetSummary(opened.value))
          : err(
              new DetailedFailure(opened.error, {
                selection_at_failure: opened.selection,
                target_at_open_completion: opened.targetAtCompletion,
                provider_id_at_open_completion: opened.providerIdAtCompletion,
              }),
            );
      },
    },
    open_bundle_resources: {
      admission: "sdk",
      value: async (input, { signal }) => {
        const opened = await session.openBundleResources(input.path, {
          signal,
        });
        return opened.ok
          ? ok({
              caller_path: opened.value.callerPath,
              canonical_path: opened.value.canonicalPath,
              info_plist_path: opened.value.infoPlistPath,
              layout: opened.value.layout,
              executable_sha256: opened.value.executableSha256,
            })
          : opened;
      },
    },
  })) satisfies Bind<BinarySessionPort>,
  // Context reads query the analysis admission grants for the call.
  analysisContext: ((_options: Readonly<Record<string, never>>) => ({
    get_navigation_context: {
      admission: "sdk",
      query: (input, analysis, { signal }) =>
        getNavigationContext(analysis, input, signal),
    },
    inspect_address_context: {
      admission: "sdk",
      query: async (input, analysis, { signal }) => {
        const inspected = await inspectAddressContext(analysis, input, signal);
        if (!inspected.ok) return inspected;
        const context = inspected.value;
        // An oversized context drops its largest Evidence facets first.
        return ok(
          new ReducibleValue(context, (failure, budgetBytes) =>
            omitContextEvidenceForDelivery(context, failure, budgetBytes),
          ),
        );
      },
    },
  })) satisfies Bind<Readonly<Record<string, never>>>,
  // Process capture runs under session admission and records its Evidence
  // and residual unknowns in the session itself.
  processCapture: ((options) => ({
    capture_process_scenario: {
      admission: "sdk",
      completionProgress: "workflow",
      analyze: (input, _analysis, request) =>
        captureSessionProcessScenario(options, input, request),
    },
  })) satisfies Bind<ProcessSessionCaptureOptions>,
  // Close and reset order themselves in the session, so they run outside
  // analysis admission; process-capture and artifact cleanup settle with them.
  sessionLifecycle: ((options) => {
    const { session } = options;
    const close = closeWithProcessResources(options);
    return {
      close_binary: {
        admission: "sdk",
        value: async (input, { progress }) => {
          const snapshotPath = input.snapshot_path;
          if (snapshotPath === undefined) {
            // Enqueue the transition before awaiting progress transport so a
            // later open request cannot overtake this close.
            const closing = close(() =>
              session.close({ progress, cleanupRetry: CLOSE_RETRY }),
            );
            await reportOperationStart(progress, "close_binary");
            const closed = await closing;
            await reportOperationEnd(progress, "close_binary", closed.ok);
            return closed;
          }
          const closing = close(
            () =>
              session.closeWithSnapshot(snapshotPath, input.overwrite, {
                progress,
                cleanupRetry: CLOSE_RETRY,
              }),
            (receipt) => receipt,
          );
          await reportOperationStart(
            progress,
            "close_binary",
            "saving snapshot; closing provider",
          );
          const closed = await closing;
          await reportOperationEnd(progress, "close_binary", closed.ok);
          return closed.ok ? ok({ ...closed.value }) : closed;
        },
      },
      // The session owns admission, checkpoint publication and completion.
      reset_investigation: {
        admission: "sdk",
        value: (input, { signal }) =>
          session.resetInvestigation({
            ...(input.save_path === undefined
              ? {}
              : { savePath: input.save_path }),
            overwrite: input.overwrite,
            signal,
            retryCleanup: resetCleanupRetry(options, "reset_investigation"),
          }),
      },
    };
  }) satisfies Bind<SessionLifecycleOptions>,
  sessionStatus: ((options) => ({
    binary_session: {
      admission: "sdk",
      value: (input, { context }) => readSessionStatus(options, input, context),
    },
  })) satisfies Bind<SessionStatusToolOptions>,
  // Native matching reads session-held Evidence and retains the sources it
  // read; a summary retains the complete match behind it.
  nativeFunctionMatching: (({ session, allowance }) => {
    const evidenceById = session.evidenceForAnalysis.bind(session);
    const recordEvidence: BinarySessionPort["recordEvidence"] = (evidence) =>
      session.recordEvidence(evidence);
    return {
      match_native_functions: {
        admission: "sdk",
        run: async (input, options) => {
          const representationAllowance = allowance();
          if (!representationAllowance.ok) return representationAllowance;
          const result = await matchNativeFunctions(
            input,
            {
              ...options,
              representationAllowance: representationAllowance.value,
            },
            evidenceById,
          );
          if (!result.ok) return result;
          const recorded = recordEvidenceSources(
            recordEvidence,
            result.value.sources,
          );
          if (!recorded.ok) return recorded;
          return result.value.detail === "summary"
            ? summarizeRetainedAnalysis(result.value.evidence, {
                evidenceById,
                recordEvidence,
              })
            : ok(result.value.evidence);
        },
      },
    };
  }) satisfies Bind<NativeFunctionMatchingToolOptions>,
  // Layout inspection validates its own request so a refusal names the
  // field, and retains the complete Evidence behind a requested summary.
  binaryLayout: ((service, retention) => {
    const contract = toolContract("inspect_binary_layout");
    const delivery = retainedSummaryDelivery(contract.name, retention);
    return {
      inspect_binary_layout: {
        admission: "application",
        run: async (rawInput, options) => {
          const parsed = contract.inputSchema.safeParse(rawInput);
          if (!parsed.success)
            return err(
              analysisInputErrorFromIssues(
                contract.name,
                parsed.error.issues,
                rawInput,
                { cause: parsed.error },
              ),
            );
          const { detail, ...input } = parsed.data;
          const parameters = { detail };
          const ready = delivery.preflight(parameters);
          if (!ready.ok) return ready;
          const inspected = await service.inspect(input, options);
          return inspected.ok
            ? delivery.projectEvidence(parameters, inspected.value)
            : inspected;
        },
      },
    };
  }) satisfies Bind<Pick<BinaryLayoutService, "inspect">>,
  // The SDK admits the advertised structure; the scenario's own parser owns
  // field-path diagnostics, shared with the CLI. A provider that failed to
  // load is reported after the request is validated.
  browserScenario: (({ provider, loadFailure }) => ({
    capture_browser_scenario: {
      admission: "sdk",
      summary: async (input, options) => {
        const scenario = browserScenarioSchema.safeParse(input);
        if (!scenario.success)
          return err(
            analysisInputErrorFromIssues(
              "capture_browser_scenario",
              scenario.error.issues,
              input,
              { cause: scenario.error },
            ),
          );
        return loadFailure === undefined
          ? captureBrowserScenario(provider, scenario.data, options)
          : err(
              optionalProviderUnavailable(
                loadFailure,
                "capture_browser_scenario",
              ),
            );
      },
    },
  })) satisfies Bind<BrowserScenarioToolOptions>,
  // Passive Inspector tools stay registered when policy keeps the provider
  // unavailable; every call then reports it before admission.
  javascriptRuntime: (({ runtime, loadFailure }) => ({
    list_javascript_runtime_targets: {
      admission: "sdk",
      unavailable: loadFailure,
      run: (input, options) =>
        listJavaScriptRuntimeTargets(runtime, input, options),
    },
    observe_javascript_runtime: {
      admission: "sdk",
      unavailable: loadFailure,
      run: (input, options) =>
        observeJavaScriptRuntime(runtime, input, options),
    },
  })) satisfies Bind<JavaScriptRuntimeToolOptions>,
  // Provider operations whose observation becomes atomic Evidence, run on
  // the analysis admission grants; each family routes its own operations.
  providerOperations: (({ contracts, ...options }): ContractToolBindings =>
    Object.fromEntries(
      contracts.map((contract) => [
        contract.name,
        {
          admission: "sdk",
          provider: { ...options, operation: contract.name },
        },
      ]),
    )) satisfies Bind<ProviderOperationToolOptions>,
  // Build computer sessions and the build steps on them. Each tool parses
  // its own request so a refusal names the field; long steps report a
  // heartbeat so a client's request timeout can reset; no response, refusals
  // included, shows a typed secret's value.
  desktopBuild: ((computers) => {
    const steps = new DesktopBuildSteps(computers);
    const presentResult = (result: CallToolResult) =>
      redactedResult(result, computers.redaction);
    const tool = <Schema extends z.ZodType>(
      contract: { readonly name: string; readonly inputSchema: Schema },
      run: (
        input: z.output<Schema>,
        request: ValueToolRequest,
      ) => Promise<ValueOutcome>,
    ) => {
      return {
        admission: "application" as const,
        presentResult,
        value: async (raw: unknown, request: ValueToolRequest) => {
          const parsed = z.safeParse(contract.inputSchema, raw);
          return parsed.success
            ? run(parsed.data, request)
            : err(
                analysisInputErrorFromIssues(
                  contract.name,
                  parsed.error.issues,
                  raw,
                  { cause: parsed.error },
                ),
              );
        },
      };
    };
    const heartbeat = <Value>(
      { progress }: ValueToolRequest,
      phase: DesktopBuildTool,
      run: (progress: ProgressReporter) => Promise<Value>,
    ) => withHeartbeat(progress, phase, computers.progressMs, run);
    // A forwarded driver answer, such as a screenshot, follows REA's JSON.
    const forwarded = (
      result: Result<ForwardedResult<JsonValue>, AnalysisError>,
    ): ValueOutcome =>
      result.ok
        ? ok(new ForwardedValue(result.value.value, result.value.content))
        : result;
    return {
      start_build_computer: tool(
        toolContract("start_build_computer"),
        async (input, { signal, progress }) =>
          forwarded(await computers.start(input, signal, progress)),
      ),
      // An action can wait for the call before it on its computer, and a
      // reset for the relaunched app, which can take minutes.
      act_on_build_computer: tool(
        toolContract("act_on_build_computer"),
        async (input, request) =>
          forwarded(
            await heartbeat(request, "act_on_build_computer", () =>
              computers.act(input, request.signal),
            ),
          ),
      ),
      start_build_capture: tool(
        toolContract("start_build_capture"),
        async (input, request) =>
          forwarded(
            await heartbeat(request, "start_build_capture", () =>
              steps.startCapture(input, request.signal),
            ),
          ),
      ),
      mark_build_checkpoint: tool(
        toolContract("mark_build_checkpoint"),
        (input, request) =>
          heartbeat(request, "mark_build_checkpoint", () =>
            steps.markCheckpoint(input, request.signal),
          ),
      ),
      stop_build_capture: tool(
        toolContract("stop_build_capture"),
        (input, request) =>
          heartbeat(request, "stop_build_capture", () =>
            steps.stopCapture(input, request.signal),
          ),
      ),
      export_build_environment: tool(
        toolContract("export_build_environment"),
        (input, request) =>
          heartbeat(request, "export_build_environment", () =>
            steps.exportEnvironment(input, request.signal),
          ),
      ),
      check_build_task: tool(
        toolContract("check_build_task"),
        (input, request) =>
          heartbeat(request, "check_build_task", (progress) =>
            steps.checkTask(input, request.signal, progress),
          ),
      ),
      // Solves run one at a time for minutes each, so progress keeps the
      // client waiting.
      measure_build_task: tool(
        toolContract("measure_build_task"),
        (input, request) =>
          heartbeat(request, "measure_build_task", (progress) =>
            computers.measure(input, request.signal, progress),
          ),
      ),
      record_build_consent: tool(
        toolContract("record_build_consent"),
        (input, { signal }) => steps.recordConsent(input, signal),
      ),
      close_build_computer: tool(
        toolContract("close_build_computer"),
        (input) => computers.close(input.computer_id),
      ),
    };
  }) satisfies Bind<DesktopBuildToolComputers>,
  // Provider-free access to the guided prompts this server advertises.
  guidedWorkflows: ((prompts) => ({
    guided_workflows: {
      admission: "application",
      value: async (input) =>
        jsonValueResult(accessGuidedWorkflows(input, prompts)),
    },
  })) satisfies Bind<readonly PromptContract[]>,
} as const;

type ServiceBindings = typeof SERVICE_TOOL_BINDINGS;

/** Services that run service-backed contracts, keyed as in SERVICE_TOOL_BINDINGS. */
export type ToolServices = {
  readonly [Key in keyof ServiceBindings]: Parameters<ServiceBindings[Key]>[0];
};

/** Bind the contracts of each supplied service from the shared table. */
export const serviceToolBindings = (
  services: Partial<ToolServices>,
  retention: AnalysisViewRetention,
): ContractToolBindings =>
  Object.assign(
    {},
    ...Object.entries(services).map(([key, service]) =>
      (SERVICE_TOOL_BINDINGS[key as keyof ServiceBindings] as Bind<unknown>)(
        service,
        retention,
      ),
    ),
  ) as ContractToolBindings;

/** Register the contracts of each supplied service through the binding loop. */
export const registerServiceTools = (
  server: EvidenceMcpServer,
  services: Partial<ToolServices>,
  dependencies: ContractToolDependencies,
): void =>
  registerContractTools(
    server,
    serviceToolBindings(services, {
      recordEvidence: dependencies.recordEvidence,
      evidenceById: dependencies.evidenceById,
    }),
    dependencies,
  );
