import type { AdbDeviceAnalysisService } from "../application/adb/AdbDeviceAnalysisService.js";
import type { AnalysisSettings } from "../application/AnalysisSettings.js";
import { analysisSettingsConstraints } from "./analysisSettingsConstraints.js";
import type { ToolResultDelivery } from "./ToolResultDelivery.js";
import type { AndroidAnalysisService } from "../application/android/AndroidAnalysisService.js";
import { inspectAndroidJniBindings } from "../application/android/AndroidJniInspection.js";
import { inspectAndroidPackage } from "../application/android/AndroidPackageInspection.js";
import { inspectAndroidSymbol } from "../application/android/AndroidSymbolInspection.js";
import {
  inspectAnalysisView,
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
import { retainAnalysisResultSources } from "../application/investigation/recordEvidenceSources.js";
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
import type { WebRuntimeService } from "../application/WebRuntimeService.js";
import { exportWebScriptsValidated } from "../application/WebScriptExportService.js";
import type { ArtifactResourceScope } from "../resources/index.js";
import {
  contractServiceBindings,
  registerContractTools,
  type ContractToolBindings,
  type ContractToolDependencies,
} from "./contractToolBindings.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { retainedSummaryDelivery } from "./retainedSummaryDelivery.js";
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
  cutterSessions: ((service) => ({
    list_cutter_sessions: {
      admission: "sdk",
      value: async (_input, { signal }) => {
        const listed = await service.listSessions({ signal });
        return listed.ok
          ? ok({ ...listed.value, sessions: [...listed.value.sessions] })
          : listed;
      },
    },
  })) satisfies Bind<CutterBridgeService>,
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
  sessionStatus: ((options) => ({
    binary_session: {
      admission: "sdk",
      value: (input, { context }) => readSessionStatus(options, input, context),
    },
  })) satisfies Bind<SessionStatusToolOptions>,
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
