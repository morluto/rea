import {
  createCapabilityServices,
  type CapabilityServiceOptions,
} from "../composition/capabilityServices.js";
import { registerToolFamilies } from "../contracts/toolFamilyIds.js";
import { AnalysisSettings } from "../application/AnalysisSettings.js";
import { parseMcpInputBudget } from "../config/mcpInputBudget.js";
import { registerAnalysisSettingsTools } from "./registerAnalysisSettingsTools.js";
import { registerDevicetreeTool } from "./registerDevicetreeTool.js";
import { registerGpuCodeObjectsTools } from "./registerGpuCodeObjectsTools.js";
import { serverInstructions } from "./serverInstructions.js";
import { registerCaptureTools } from "./registerCaptureTools.js";
import { registerSignalTools } from "./registerSignalTools.js";
import { registerWasmTools } from "./registerWasmTools.js";
import { registerApkSignatureTools } from "./registerApkSignatureTools.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { captureProviderEnvironment } from "./providerEnvironment.js";
import { createByteEntropyService } from "../composition/binaryDiagnostics.js";
import { registerElfNotesTool } from "./registerElfNotesTool.js";
import { registerDwarfUnitsTool } from "./registerDwarfUnitsTool.js";
import { registerAppleIpsTool } from "./registerAppleIpsTool.js";
import { registerKernelModuleTool } from "./registerKernelModuleTool.js";
import { registerPeLoadConfigTool } from "./registerPeLoadConfigTool.js";
import { registerPeCertificatesTool } from "./registerPeCertificatesTool.js";
import { registerPeImportsTool } from "./registerPeImportsTool.js";
import { registerPeResourcesTool } from "./registerPeResourcesTool.js";
import { registerNativeExportsTool } from "./registerNativeExportsTool.js";
import { registerEvmTools } from "./registerEvmTools.js";
import { registerSqliteTools } from "./registerSqliteTools.js";
import { registerRecordedCrashTools } from "./registerRecordedCrashTools.js";
import { registerDesktopApplicationTool } from "./registerDesktopApplicationTool.js";
import { registerModelArtifactTools } from "./registerModelArtifactTools.js";
import { registerGoTools } from "./registerGoTools.js";
import { registerIl2cppTools } from "./registerIl2cppTools.js";
import { registerRustTools } from "./registerRustTools.js";
import { registerPythonPycTool } from "./registerPythonPycTool.js";
import { registerErlangTools } from "./registerErlangTools.js";
import { registerAnalysisViewTool } from "./registerAnalysisViewTool.js";
import { registerBinaryDiagnosticsTools } from "./registerBinaryDiagnosticsTools.js";
import { registerFridaTools } from "./registerFridaTools.js";
import { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { catalogIdentityForToolFamilies } from "../catalogIdentity.js";
import { parseMcpToolFamilies } from "../config/mcpToolFamilies.js";
import { createToolResultDelivery } from "./toolResult.js";
import type { ToolResultDelivery } from "./ToolResultDelivery.js";
import { parseMcpResponseBudget } from "../config/mcpResponseBudget.js";
import {
  parseMcpOutputSchemaProfile,
  type McpOutputSchemaProfile,
} from "../config/mcpOutputSchemaProfile.js";
import {
  compactPresentationForMcpInputSchemaProfile,
  parseMcpInputSchemaProfile,
} from "../config/mcpInputSchemaProfile.js";
import type { CompactInputSchemaPresentation } from "../contracts/compactInputSchema.js";
import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { silentLogger } from "../logger.js";
import type { Logger } from "pino";
import { registerApplicationTools } from "./registerApplicationTools.js";
import { registerArtifactTools } from "./registerArtifactTools.js";
import { registerNativeTools } from "./registerNativeTools.js";
import { registerBrowserScenarioTool } from "./registerBrowserScenarioTool.js";
import { registerBrowserTools } from "./registerBrowserTools.js";
import { registerWebScriptTool } from "./registerWebScriptTool.js";
import { registerWebModuleTool } from "./registerWebModuleTool.js";
import { registerWebSourceLocationTool } from "./registerWebSourceLocationTool.js";
import { registerWebRuntimeTools } from "./registerWebRuntimeTools.js";
import { registerWebNetworkCaptureTool } from "./registerWebNetworkCaptureTool.js";
import { registerJavaScriptRecoveryTool } from "./registerJavaScriptRecoveryTool.js";
import { JavaScriptRecoveryService } from "../application/javascript/JavaScriptRecoveryService.js";
import { registerElectronTools } from "./registerElectronTools.js";
import { registerEnhancedTools } from "./registerEnhancedTools.js";
import { registerJavaScriptRuntimeObservationTools } from "./registerJavaScriptRuntimeObservationTools.js";
import { registerManagedTools } from "./registerManagedTools.js";
import { registerFirmwareTools } from "./registerFirmwareTools.js";
import { registerAndroidTools } from "./registerAndroidTools.js";
import { registerApktoolTools } from "./registerApktoolTools.js";
import { registerPcapTools } from "./registerPcapTools.js";
import { registerFlutterTools } from "./registerFlutterTools.js";
import { registerJebTools } from "./registerJebTools.js";
import { registerAdbTools } from "./registerAdbTools.js";
import { AndroidAnalysisService } from "../application/android/AndroidAnalysisService.js";
import { JebAnalysisService } from "../application/jeb/JebAnalysisService.js";
import { PcapAnalysisService } from "../application/pcap/PcapAnalysisService.js";
import { ApktoolResourceAnalysisService } from "../application/apktool/ApktoolResourceAnalysisService.js";
import { FlutterBuildAnalysisService } from "../application/flutter/FlutterBuildAnalysisService.js";
import { AdbDeviceAnalysisService } from "../application/adb/AdbDeviceAnalysisService.js";
import { registerManagedWorkflowTools } from "./registerManagedWorkflowTools.js";
import { registerOfficialTools } from "./registerOfficialTools.js";
import { registerGuidedPrompts } from "./registerPrompts.js";
import { registerSessionTools } from "./registerSessionTools.js";
import type { AvailabilityPolicy } from "../application/CapabilityInventory.js";
import { sessionAvailabilityPolicy } from "./sessionAvailabilityPolicy.js";
import {
  withAdmittedAnalysis,
  type ServerAnalysisSource,
} from "./analysisAdmission.js";
import { registerReverseEngineeringTools } from "./registerReverseEngineeringTools.js";
import { registerCutterTools } from "./registerCutterTools.js";
import { registerGdbTools } from "./registerGdbTools.js";
import { registerRizinDebugTools } from "./registerRizinDebugTools.js";

export interface CreateServerOptions extends CapabilityServiceOptions {
  readonly analysisSettings?: AnalysisSettings;
  /** Preserve the connection's creation time when materializing its runtime. */
  readonly startedAt?: string;
  /** Existing SDK server whose deferred registrations are being materialized. */
  readonly mcpServer?: EvidenceMcpServer;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly delivery?: ToolResultDelivery;
  readonly providerEnvironment?: Readonly<NodeJS.ProcessEnv>;
  readonly logger?: Logger;
  readonly availabilityPolicy?: () => AvailabilityPolicy;
}

const createMcpServer = (
  session: BinarySessionPort | undefined,
  delivery: ToolResultDelivery,
  compactPresentation: CompactInputSchemaPresentation | undefined,
  outputSchemaProfile: McpOutputSchemaProfile,
  advertisedToolFamilies: ReadonlySet<string> | undefined,
  inputElementBudget: string | undefined,
): EvidenceMcpServer => {
  const configured = parseMcpInputBudget(inputElementBudget);
  if (!configured.ok) throw configured.error;
  return new EvidenceMcpServer(
    {
      name: PRODUCT_IDENTITY.mcpServerKey,
      version: PRODUCT_IDENTITY.packageVersion,
    },
    {
      capabilities: {},
      maxToolInputElements: configured.value,
      instructions: serverInstructions(
        session !== undefined,
        advertisedToolFamilies,
      ),
    },
    session === undefined
      ? undefined
      : (evidence) => session.recordEvidence(evidence),
    delivery,
    compactPresentation,
    outputSchemaProfile,
    catalogIdentityForToolFamilies(
      compactPresentation,
      outputSchemaProfile,
      advertisedToolFamilies,
    ),
    advertisedToolFamilies,
  );
};

/**
 * Construct one MCP server without acquiring subprocess resources.
 * Supplying a session adds target lifecycle tools; omitting it retains the
 * fixed-target seam used by focused tests and embedders.
 */
export const createServer = (
  source: ServerAnalysisSource,
  options: CreateServerOptions = {},
): EvidenceMcpServer => {
  const session = source.kind === "session" ? source.session : undefined;
  const analysis = source.kind === "session" ? source.session : source.analysis;
  const environment = snapshotEnvironment(options.environment ?? process.env);
  const analysisSettings =
    options.analysisSettings ?? new AnalysisSettings(environment);
  const compactInputPresentation =
    selectCompactInputSchemaPresentation(environment);
  const selectedOutputSchemaProfile = outputSchemaProfile(environment);
  const advertisedToolFamilies = selectAdvertisedToolFamilies(environment);
  const providerEnvironment = captureProviderEnvironment(
    options.providerEnvironment,
    environment,
  );
  const delivery = selectToolResultDelivery(environment, options.delivery);
  const capabilities = createCapabilityServices({
    environment,
    providerEnvironment,
    settings: analysisSettings.read,
    options,
    platform: process.platform,
    arch: process.arch,
  });
  const {
    evmInterface,
    sqliteDatabase,
    binaryLayout,
    recordedCrash,
    webSourceLocation,
    webModuleTrace,
    desktopApplication,
    goBinary,
    rustBinary,
    erlangBeam,
    modelArtifact,
    gpuCodeObjects,
    il2cppMetadata,
    peResources,
    nativeExports,
    devicetree,
    elfNotes,
    dwarfUnits,
    appleIps,
    kernelModule,
    peLoadConfig,
    peCertificates,
    peImports,
    electronFuses,
    pythonPyc,
    webNetworkCapture,
    javascriptRecovery,
    artifactResources,
    reverseEngineering,
    firmwareAnalysis,
    gdbSessions,
    rizinDebugSessions,
    android,
    pcap,
    flutter,
    fridaInstrumentation,
    wasmArtifact,
    apkSignature,
    packetCapture,
    signalRecording,
    webRuntime,
    apktool,
    jeb,
    adbDevice,
    cutter,
  } = capabilities.services;
  const startedAt = options.startedAt ?? new Date().toISOString();
  const logger = options.logger ?? silentLogger;
  const server =
    options.mcpServer ??
    createMcpServer(
      session,
      delivery,
      compactInputPresentation,
      selectedOutputSchemaProfile,
      advertisedToolFamilies,
      environment.REA_MCP_MAX_INPUT_ELEMENTS,
    );
  server.analysisSettings = analysisSettings;
  if (options.mcpServer !== undefined) {
    server.attachRuntime(
      session === undefined
        ? undefined
        : (evidence) => session.recordEvidence(evidence),
      delivery,
      catalogIdentityForToolFamilies(
        compactInputPresentation,
        selectedOutputSchemaProfile,
        advertisedToolFamilies,
      ),
    );
  }
  const closeProviders = capabilities.close;
  const availability =
    session === undefined
      ? undefined
      : (() => {
          const basePolicy = sessionAvailabilityPolicy(
            options.availabilityPolicy,
            {
              ...capabilities.availability,
              optionalProviderLoadFailures:
                options.optionalProviderLoadFailures,
            },
          );
          return {
            policy: (): AvailabilityPolicy => {
              const value = basePolicy();
              const failures = capabilities.observeProviderLoadFailures();
              return Object.keys(failures).length === 0
                ? value
                : {
                    ...value,
                    optionalProviderLoadFailures: {
                      ...value.optionalProviderLoadFailures,
                      ...failures,
                    },
                  };
            },
          };
        })();
  const toolLogger = logger.child({ layer: "server" });
  const {
    evidenceById,
    activeTarget,
    recordEvidence,
    recordEvidenceWithUnknown,
  } = createSessionRecorders(server, session);
  const analysisAdmission = withAdmittedAnalysis(source);
  server.withAdmittedAnalysis = analysisAdmission;
  const recordSessionEvidence =
    session === undefined
      ? undefined
      : (
          evidence: Parameters<
            NonNullable<typeof session>["recordEvidence"]
          >[0],
        ) => session.recordEvidence(evidence);
  const previousOnclose = server.server.onclose;
  server.server.onclose = () => {
    previousOnclose?.();
    void closeProviders().catch((cause: unknown) => {
      logger.error(
        { error: cause instanceof Error ? cause.message : String(cause) },
        "Provider cleanup failed during server shutdown",
      );
    });
  };
  const closeServer = server.close.bind(server);
  server.close = async () => {
    const results = await Promise.allSettled([closeServer(), closeProviders()]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
      throw new AggregateError(failures, "REA server cleanup failed");
  };
  const recordUnknown =
    session === undefined
      ? undefined
      : (input: Parameters<NonNullable<typeof session>["recordUnknown"]>[0]) =>
          session.recordUnknown(input);
  const analysisOptions = {
    logger: toolLogger,
    activeTarget,
    recordEvidence,
    recordUnknown,
    evidenceById,
    withAdmittedAnalysis: analysisAdmission,
  };
  const evidenceOptions = {
    logger: toolLogger,
    activeTarget,
    recordEvidence,
    withAdmittedAnalysis: analysisAdmission,
  };
  const common = {
    logger: toolLogger,
    recordEvidence,
    withAdmittedAnalysis: analysisAdmission,
  };
  registerToolFamilies({
    direct: () => registerOfficialTools(server, analysisOptions),
    enhanced: () =>
      registerEnhancedTools(server, {
        ...analysisOptions,
        analysisProfile:
          session === undefined
            ? undefined
            : (operation) =>
                session.analysisProfile() ?? session.analysisProfile(operation),
        allowsSnapshotReplay:
          session === undefined
            ? undefined
            : (operation) => session.allowsSnapshotReplay(operation),
        recordWorkflowSnapshot:
          session === undefined
            ? undefined
            : (input) => session.recordWorkflowSnapshot(input),
      }),
    native: () => {
      registerNativeTools(server, { ...evidenceOptions, evidenceById });
      registerReverseEngineeringTools(
        server,
        reverseEngineering,
        toolLogger,
        delivery,
        recordSessionEvidence,
        analysisAdmission,
        session === undefined
          ? undefined
          : () => session.invalidateSnapshotForExternalMutation(),
        session === undefined
          ? undefined
          : (path, signal, operation, rebindFailure) =>
              session.withAdmittedExternalMutation(
                path,
                signal,
                operation,
                rebindFailure,
              ),
        evidenceById,
      );
      registerCutterTools(
        server,
        cutter,
        toolLogger,
        delivery,
        recordSessionEvidence,
        session,
      );
      registerGdbTools(
        server,
        gdbSessions,
        toolLogger,
        delivery,
        recordSessionEvidence,
        session,
        evidenceById,
      );
      registerRizinDebugTools(
        server,
        rizinDebugSessions,
        toolLogger,
        delivery,
        recordSessionEvidence,
        session,
      );
      registerBinaryDiagnosticsTools(
        server,
        binaryLayout,
        createByteEntropyService(artifactResources),
        toolLogger,
        recordEvidence,
        evidenceById,
        analysisAdmission,
      );
      registerPeResourcesTool(
        server,
        peResources,
        toolLogger,
        recordEvidence,
        analysisAdmission,
      );
      registerNativeExportsTool(
        server,
        nativeExports,
        toolLogger,
        recordEvidence,
        evidenceById,
        analysisAdmission,
      );
      registerDevicetreeTool(
        server,
        devicetree,
        toolLogger,
        recordEvidence,
        evidenceById,
        analysisAdmission,
      );
      registerElfNotesTool(
        server,
        elfNotes,
        toolLogger,
        recordEvidence,
        analysisAdmission,
      );
      registerDwarfUnitsTool(
        server,
        dwarfUnits,
        toolLogger,
        recordEvidence,
        analysisAdmission,
      );
      registerAppleIpsTool(
        server,
        appleIps,
        toolLogger,
        recordEvidence,
        analysisAdmission,
      );
      registerKernelModuleTool(
        server,
        kernelModule,
        toolLogger,
        recordEvidence,
        analysisAdmission,
      );
      registerPeLoadConfigTool(
        server,
        peLoadConfig,
        toolLogger,
        recordEvidence,
        analysisAdmission,
      );
      registerPeCertificatesTool(
        server,
        peCertificates,
        toolLogger,
        recordEvidence,
        analysisAdmission,
      );
      registerPeImportsTool(
        server,
        peImports,
        toolLogger,
        recordEvidence,
        analysisAdmission,
      );
      registerRecordedCrashTools(
        server,
        recordedCrash,
        toolLogger,
        recordEvidence,
        analysisAdmission,
      );
    },
    artifact: () => {
      registerArtifactTools(server, { ...evidenceOptions, evidenceById });
      registerDesktopApplicationTool(
        server,
        desktopApplication,
        toolLogger,
        recordEvidence,
        analysisAdmission,
        evidenceById,
      );
      registerModelArtifactTools(
        server,
        modelArtifact,
        toolLogger,
        recordEvidence,
        analysisAdmission,
        evidenceById,
      );
      registerGpuCodeObjectsTools(
        server,
        gpuCodeObjects,
        toolLogger,
        recordEvidence,
        analysisAdmission,
        evidenceById,
      );
      registerEvmTools(
        server,
        evmInterface,
        toolLogger,
        recordEvidence,
        analysisAdmission,
        evidenceById,
      );
      registerGoTools(
        server,
        goBinary,
        toolLogger,
        recordEvidence,
        analysisAdmission,
        evidenceById,
      );
      registerIl2cppTools(
        server,
        il2cppMetadata,
        toolLogger,
        recordEvidence,
        analysisAdmission,
        evidenceById,
      );
      registerRustTools(
        server,
        rustBinary,
        toolLogger,
        recordEvidence,
        analysisAdmission,
        evidenceById,
      );
      registerPythonPycTool(
        server,
        pythonPyc,
        toolLogger,
        recordEvidence,
        analysisAdmission,
        evidenceById,
      );
      registerErlangTools(
        server,
        erlangBeam,
        toolLogger,
        recordEvidence,
        analysisAdmission,
        evidenceById,
      );
      registerWasmTools(
        server,
        wasmArtifact,
        toolLogger,
        recordEvidence,
        analysisAdmission,
        evidenceById,
      );
      registerApkSignatureTools(
        server,
        apkSignature,
        toolLogger,
        recordEvidence,
        analysisAdmission,
        evidenceById,
      );
      registerSqliteTools(
        server,
        sqliteDatabase,
        toolLogger,
        recordEvidence,
        analysisAdmission,
      );
      registerCaptureTools(
        server,
        packetCapture,
        toolLogger,
        recordEvidence,
        analysisAdmission,
      );
      registerSignalTools(
        server,
        signalRecording,
        toolLogger,
        recordEvidence,
        analysisAdmission,
      );
    },
    managed: () => {
      registerManagedTools(server, { ...evidenceOptions, evidenceById });
      if (session !== undefined)
        registerManagedWorkflowTools(server, {
          logger: toolLogger,
          recordEvidence,
          recordEvidenceWithUnknown,
          session,
          withAdmittedAnalysis: analysisAdmission,
        });
    },
    firmware: () =>
      registerFirmwareTools(
        server,
        firmwareAnalysis,
        toolLogger,
        recordEvidence,
        analysisAdmission,
      ),
    android: () =>
      registerAndroidTools(
        server,
        new AndroidAnalysisService(android, recordEvidence),
        toolLogger,
        recordEvidence,
        analysisAdmission,
        evidenceById,
      ),
    pcap: () =>
      registerPcapTools(
        server,
        new PcapAnalysisService(pcap),
        toolLogger,
        recordEvidence,
        analysisAdmission,
        evidenceById,
      ),
    flutter: () =>
      registerFlutterTools(
        server,
        new FlutterBuildAnalysisService(flutter),
        toolLogger,
        recordEvidence,
        analysisAdmission,
        evidenceById,
      ),
    frida: () =>
      registerFridaTools(
        server,
        fridaInstrumentation,
        toolLogger,
        delivery,
        recordSessionEvidence,
        evidenceById,
      ),
    apktool: () =>
      registerApktoolTools(
        server,
        new ApktoolResourceAnalysisService(apktool),
        toolLogger,
        recordEvidence,
        analysisAdmission,
      ),
    jeb: () =>
      registerJebTools(
        server,
        new JebAnalysisService(jeb),
        toolLogger,
        recordEvidence,
        analysisAdmission,
      ),
    adb: () =>
      registerAdbTools(
        server,
        new AdbDeviceAnalysisService(adbDevice),
        toolLogger,
        recordEvidence,
        analysisAdmission,
      ),
    browser: () => {
      registerBrowserTools(server, {
        ...common,
        evidenceById,
        browser: options.browserObservation,
        loadFailure: options.optionalProviderLoadFailures?.browserObservation,
      });
      registerBrowserScenarioTool(server, {
        ...common,
        evidenceById,
        provider: options.browserScenarioCapture,
        loadFailure:
          options.optionalProviderLoadFailures?.browserScenarioCapture,
      });
      registerWebRuntimeTools(
        server,
        webRuntime,
        toolLogger,
        recordEvidence,
        analysisAdmission,
      );
      registerWebNetworkCaptureTool(
        server,
        webNetworkCapture,
        toolLogger,
        recordEvidence,
        analysisAdmission,
        evidenceById,
      );
    },
    electron: () =>
      registerElectronTools(server, {
        ...common,
        artifactResources,
        environment,
        evidenceById,
        electron: options.electronObservation,
        electronActive: options.electronActiveObservation,
        electronFuses,
        observationLoadFailure:
          options.optionalProviderLoadFailures?.electronObservation,
        activeLoadFailure:
          options.optionalProviderLoadFailures?.electronActiveObservation,
      }),
    "javascript-runtime": () =>
      registerJavaScriptRuntimeObservationTools(server, {
        ...common,
        runtime: options.javascriptRuntimeObservation,
        loadFailure:
          options.optionalProviderLoadFailures?.javascriptRuntimeObservation,
      }),
    application: () => {
      registerAnalysisSettingsTools(server, analysisSettings);
      registerAnalysisViewTool(
        server,
        toolLogger,
        evidenceById,
        recordEvidence,
        analysisAdmission,
        artifactResources,
      );
      registerWebScriptTool(server, { ...common, artifactResources });
      registerWebModuleTool(
        server,
        webModuleTrace,
        toolLogger,
        recordEvidence,
        analysisAdmission,
      );
      registerWebSourceLocationTool(
        server,
        webSourceLocation,
        toolLogger,
        recordEvidence,
        analysisAdmission,
      );
      registerJavaScriptRecoveryTool(
        server,
        new JavaScriptRecoveryService(javascriptRecovery),
        toolLogger,
        recordEvidence,
        analysisAdmission,
      );
      registerApplicationTools(server, {
        artifactResources,
        evidenceById,
        logger: toolLogger,
        recordEvidence,
        recordEvidenceWithUnknown,
        withAdmittedAnalysis: analysisAdmission,
      });
    },
    session: () => {
      if (session === undefined) return;
      registerSessionTools(server, session, toolLogger, {
        environment,
        artifactResources,
        ...(availability === undefined
          ? {}
          : { availabilityPolicy: availability.policy }),
        ...capabilities.probes,
        startedAt,
      });
    },
  });
  registerGuidedPrompts(server, analysis, session);
  return server;
};

const selectToolResultDelivery = (
  environment: Readonly<NodeJS.ProcessEnv>,
  selected: ToolResultDelivery | undefined,
): ToolResultDelivery => {
  if (selected !== undefined) return selected;
  const configured = parseMcpResponseBudget(
    environment.REA_MCP_MAX_RESPONSE_BYTES,
  );
  if (!configured.ok) throw configured.error;
  return createToolResultDelivery(configured.value);
};

const outputSchemaProfile = (
  environment: Readonly<NodeJS.ProcessEnv>,
): McpOutputSchemaProfile => {
  const configured = parseMcpOutputSchemaProfile(
    environment.REA_MCP_OUTPUT_SCHEMA_PROFILE,
  );
  if (!configured.ok) throw configured.error;
  return configured.value ?? "full";
};

const selectCompactInputSchemaPresentation = (
  environment: Readonly<NodeJS.ProcessEnv>,
): CompactInputSchemaPresentation | undefined => {
  const configured = parseMcpInputSchemaProfile(
    environment.REA_MCP_INPUT_SCHEMA_PROFILE,
  );
  if (!configured.ok) throw configured.error;
  return compactPresentationForMcpInputSchemaProfile(configured.value);
};

const createSessionRecorders = (
  server: EvidenceMcpServer,
  session: BinarySessionPort | undefined,
) => ({
  evidenceById:
    session === undefined
      ? undefined
      : session.evidenceForAnalysis.bind(session),
  activeTarget:
    session === undefined ? undefined : () => session.activeTarget(),
  recordEvidence:
    session === undefined
      ? undefined
      : (evidence: Parameters<typeof session.recordEvidence>[0]) =>
          session.recordEvidence(evidence),
  recordEvidenceWithUnknown:
    session === undefined
      ? undefined
      : (
          evidence: Parameters<typeof session.recordEvidenceWithUnknown>[0],
          input: Parameters<typeof session.recordEvidenceWithUnknown>[1],
        ) => session.recordEvidenceWithUnknown(evidence, input),
});

const selectAdvertisedToolFamilies = (
  environment: Readonly<NodeJS.ProcessEnv>,
): ReadonlySet<string> | undefined => {
  const configured = parseMcpToolFamilies(environment.REA_MCP_TOOL_FAMILIES);
  if (!configured.ok) throw configured.error;
  return configured.value === undefined ? undefined : new Set(configured.value);
};
