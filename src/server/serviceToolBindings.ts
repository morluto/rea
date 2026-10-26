import type {
  UefiAnalysisService,
  ApktoolResourceAnalysisService,
  FlutterBuildAnalysisService,
  JebAnalysisService,
  PcapAnalysisService,
} from "../application/ProviderOperationServices.js";
import type { AdbDeviceAnalysisService } from "../application/adb/AdbDeviceAnalysisService.js";
import type { AnalysisSettings } from "../application/AnalysisSettings.js";
import type { ElectronFuseService } from "../application/electron/ElectronFuseService.js";
import { analysisSettingsConstraints } from "./analysisSettingsConstraints.js";
import type { ToolResultDelivery } from "./ToolResultDelivery.js";
import type { AndroidAnalysisService } from "../application/android/AndroidAnalysisService.js";
import {
  androidJniInspectionInputSchema,
  androidPackageInspectionInputSchema,
  androidSymbolInspectionInputSchemas,
} from "../domain/android/androidAnalysis.js";
import { dartAotInspectionInputSchema } from "../domain/flutter/flutterBuildAnalysis.js";
import {
  executeRetainedSummaryOperation,
  inspectAnalysisView,
  summarizeRetainedAnalysis,
} from "../application/analysisView/AnalysisViewService.js";
import type { AnalysisViewRetention } from "../application/analysisView/AnalysisViewRetention.js";
import { z } from "zod";
import { analysisViewSourceSchema } from "../domain/analysisView/analysisViewRequest.js";
import type { PacketCaptureService } from "../application/captures/PacketCaptureService.js";
import type { FirmwareAnalysisService } from "../application/firmware/FirmwareAnalysisService.js";
import { recordEvidenceSources } from "../application/investigation/recordEvidenceSources.js";
import type { JavaScriptRecoveryService } from "../application/javascript/JavaScriptRecoveryService.js";
import type { SignalRecordingService } from "../application/signals/SignalRecordingService.js";
import { OFFLINE_INSPECTION_TOOL_BINDINGS } from "./offlineInspectionToolBindings.js";
import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import type { WorkflowSession } from "../application/SessionWorkflowEvidence.js";
import type { WebModuleTraceService } from "../application/WebModuleTraceService.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { WebSourceLocationService } from "../application/WebSourceLocationService.js";
import { toolContract } from "../contracts/toolContracts.js";
import { redactExplicitFailure } from "../domain/explicitSensitiveFailure.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../domain/result.js";
import { ownedJsonValueSchema, type JsonValue } from "../domain/jsonValue.js";
import {
  readGuidanceSection,
  searchGuidance,
} from "../application/GuidanceAccess.js";
import { captureSensitiveValues } from "../domain/webNetworkCapture.js";
import type { WebNetworkCaptureService } from "../application/WebNetworkCaptureService.js";
import type { FridaInstrumentationService } from "../application/frida/FridaInstrumentationService.js";
import type { UnicornEmulationService } from "../application/unicorn/UnicornEmulationService.js";
import { bindUnicornTools } from "./unicornToolBindings.js";
import {
  resolveRizinCommandRequest,
  type ReverseEngineeringService,
} from "../application/reverse/ReverseEngineeringService.js";
import type { ExternalMutationAdmission } from "./externalMutationAdmission.js";
import type { EvidenceCommand } from "./externalMutationToolHandler.js";
import {
  bindCutterTools,
  bindFridaTools,
  bindGdbTools,
  bindRizinDebugTools,
  type CutterToolOptions,
  type GdbToolOptions,
  type RizinDebugToolOptions,
} from "./debuggerToolBindings.js";
import {
  bindBrowserObservationTools,
  bindBrowserScenarioTools,
  bindElectronObservationTools,
  bindElectronScenarioTools,
  bindJavaScriptApplicationTools,
  bindJavaScriptRuntimeTools,
  type BrowserObservationToolOptions,
  type BrowserScenarioToolOptions,
  type ElectronObservationToolOptions,
  type ElectronScenarioToolOptions,
  type JavaScriptApplicationToolOptions,
  type JavaScriptRuntimeToolOptions,
} from "./browserToolBindings.js";
import {
  bindApplicationWorkflowTools,
  bindEnhancedWorkflowTools,
  bindManagedWorkflowTools,
  bindSessionDerivedTools,
  bindSessionRecordTools,
  type ApplicationWorkflowToolOptions,
  type SessionDerivedToolOptions,
} from "./sessionToolBindings.js";
import type { BinaryLayoutService } from "../application/binaryDiagnostics/BinaryLayoutService.js";
import { accessGuidedWorkflows } from "../application/GuidedWorkflowAccess.js";
import type { PromptContract } from "../contracts/promptContracts.js";
import { matchNativeFunctions } from "../application/native/NativeFunctionMatchingService.js";
import type { NativeMatchingAllowance } from "../config/nativeMatchingAllowance.js";
import type { ConfigurationError } from "../domain/configurationErrors.js";
import type { WebRuntimeService } from "../application/WebRuntimeService.js";
import { exportWebScriptsValidated } from "../application/WebScriptExportService.js";
import type { ArtifactResourceScope } from "../resources/index.js";
import { DetailedFailure, ReducibleValue } from "./contractToolHandler.js";
import type { DesktopBuildToolComputers } from "./desktopBuildDelivery.js";
import { bindDesktopBuildTools } from "./desktopBuildToolBindings.js";
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

/** The session native matching reads, and its allowance for each accepted call. */
export interface NativeFunctionMatchingToolOptions {
  readonly session: BinarySessionPort;
  readonly allowance: () => Result<NativeMatchingAllowance, ConfigurationError>;
}

/** One family's provider operations and how they run. */
export interface ProviderOperationToolOptions extends ProviderOperationOptions {
  readonly contracts: readonly ToolContract<ProviderOperation>[];
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
    ? ownedJsonValueSchema.parse(parsed.data.source)
    : undefined;
};

/** Deliver a workflow's typed output as the JSON value its contract declares. */
const jsonValueResult = <Error>(
  result: Result<unknown, Error>,
): Result<JsonValue, Error> =>
  result.ok ? ok(ownedJsonValueSchema.parse(result.value)) : result;

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
  ...OFFLINE_INSPECTION_TOOL_BINDINGS,
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
  uefiAnalysis: ((service) => ({
    ...contractServiceBindings(service, ["inspect_uefi_nvram"]),
    inspect_uefi_firmware: {
      admission: "application",
      summary: (input, options) =>
        service.execute("inspect_uefi_firmware", input, options),
    },
    extract_uefi_firmware: {
      admission: "application",
      summary: (input, options) =>
        service.execute("extract_uefi_firmware", input, options),
    },
  })) satisfies Bind<UefiAnalysisService>,
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
        executeRetainedSummaryOperation(
          service,
          "inspect_dart_aot",
          dartAotInspectionInputSchema,
          input,
          retention,
          options,
        ),
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
        executeRetainedSummaryOperation(
          service,
          "inspect_android_package",
          androidPackageInspectionInputSchema,
          input,
          retention,
          options,
        ),
    },
    inspect_android_jni_bindings: {
      admission: "sdk",
      run: (input, options) =>
        executeRetainedSummaryOperation(
          service,
          "inspect_android_jni_bindings",
          androidJniInspectionInputSchema,
          input,
          retention,
          options,
        ),
    },
    inspect_android_class: {
      admission: "sdk",
      run: (input, options) =>
        executeRetainedSummaryOperation(
          service,
          "inspect_android_class",
          androidSymbolInspectionInputSchemas.inspect_android_class,
          input,
          retention,
          options,
        ),
    },
    inspect_android_method: {
      admission: "sdk",
      run: (input, options) =>
        executeRetainedSummaryOperation(
          service,
          "inspect_android_method",
          androidSymbolInspectionInputSchemas.inspect_android_method,
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
  // Cutter discovery reads only; an arbitrary command may change the bound
  // artifact, so it runs under external-mutation admission.
  cutter: bindCutterTools satisfies Bind<CutterToolOptions>,
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
  sessionDerived:
    bindSessionDerivedTools satisfies Bind<SessionDerivedToolOptions>,
  // Managed-code workflows derive from session-held managed and native
  // Evidence; the CLI runs the same owners without a session.
  managedWorkflows: bindManagedWorkflowTools satisfies Bind<BinarySessionPort>,
  // Application workflows complete Evidence from session-held Evidence or
  // caller-named files under analysis admission; a requested view or summary
  // is staged against it.
  applicationWorkflows:
    bindApplicationWorkflowTools satisfies Bind<ApplicationWorkflowToolOptions>,
  // Provider-backed workflows run on the analysis admission grants and
  // complete their Evidence in the session, when the server has one.
  enhancedWorkflows: bindEnhancedWorkflowTools satisfies Bind<{
    readonly session: WorkflowSession | undefined;
  }>,
  // The session's Evidence bundle and residual unknowns, read and written
  // under session admission.
  sessionRecords:
    bindSessionRecordTools satisfies Bind<SessionDerivedToolOptions>,
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
  rizinDebug: bindRizinDebugTools satisfies Bind<RizinDebugToolOptions>,
  // Starting GDB may load a selected file without running it, outside mutation admission; a console
  // command may change the bound artifact and runs under external-mutation
  // admission, keeping a failed cleanup owned for the next retry.
  gdb: bindGdbTools satisfies Bind<GdbToolOptions>,
  // Browser observation runs through an optional provider; when it failed
  // to load, every call reports it unavailable before admission.
  browserObservation:
    bindBrowserObservationTools satisfies Bind<BrowserObservationToolOptions>,
  electronFuses: ((service) => ({
    inspect_electron_fuses: {
      admission: "application",
      run: (input, options) => service.inspect(input, options),
    },
  })) satisfies Bind<Pick<ElectronFuseService, "inspect">>,
  electronObservation:
    bindElectronObservationTools satisfies Bind<ElectronObservationToolOptions>,
  // Keep active capture separate from passive observation and static analysis.
  // Its existing service owns execution admission, effects and cleanup.
  electronScenario:
    bindElectronScenarioTools satisfies Bind<ElectronScenarioToolOptions>,
  javascriptApplication:
    bindJavaScriptApplicationTools satisfies Bind<JavaScriptApplicationToolOptions>,
  // Frida sessions instrument a live process the caller selects, not the
  // session's target; compose them without analysis admission.
  frida: bindFridaTools satisfies Bind<FridaInstrumentationService>,
  // Unicorn runs caller-supplied bytes in isolation, not the session's
  // target; compose it without analysis admission.
  unicorn: bindUnicornTools satisfies Bind<UnicornEmulationService>,
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
  browserScenario:
    bindBrowserScenarioTools satisfies Bind<BrowserScenarioToolOptions>,
  // Passive Inspector tools stay registered when policy keeps the provider
  // unavailable; every call then reports it before admission.
  javascriptRuntime:
    bindJavaScriptRuntimeTools satisfies Bind<JavaScriptRuntimeToolOptions>,
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
  desktopBuild: bindDesktopBuildTools satisfies Bind<DesktopBuildToolComputers>,
  // Provider-free access to the guided prompts this server advertises.
  guidedWorkflows: ((prompts) => ({
    guided_workflows: {
      admission: "application",
      value: async (input) =>
        jsonValueResult(accessGuidedWorkflows(input, { contracts: prompts })),
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
