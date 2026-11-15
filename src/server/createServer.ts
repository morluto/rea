import {
  createCapabilityServices,
  type CapabilityServiceOptions,
} from "../composition/capabilityServices.js";
import { HOST_PLATFORM } from "../platform/HostPlatform.js";
import { registerToolFamilies } from "../contracts/toolFamilyIds.js";
import { SCOPED_NO_TARGET_RECOVERY } from "./recoveryInstructions.js";
import { AnalysisSettings } from "../application/AnalysisSettings.js";
import { parseMcpInputBudget } from "../config/mcpInputBudget.js";
import { registerAnalysisSettingsTools } from "./registerAnalysisSettingsTools.js";
import { serverInstructions } from "./serverInstructions.js";
import { registerServiceTools } from "./serviceToolBindings.js";
import { retainedDebuggerDiagnostics } from "../process/ownedDebuggerCleanupError.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { captureProviderEnvironment } from "./providerEnvironment.js";
import { createByteEntropyService } from "../composition/binaryDiagnostics.js";
import { registerDesktopBuildTools } from "./registerDesktopBuildTools.js";
import { registerAnalysisViewTool } from "./registerAnalysisViewTool.js";
import { registerBinaryDiagnosticsTools } from "./registerBinaryDiagnosticsTools.js";
import { registerFridaTools } from "./registerFridaTools.js";
import { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { catalogIdentityForToolFamilies } from "../catalogIdentity.js";
import { parseMcpToolFamilies } from "../config/mcpToolFamilies.js";
import { parseMcpToolCatalogProfile } from "../config/mcpToolCatalogProfile.js";
import { createToolResultDelivery } from "./toolResult.js";
import type { ToolResultDelivery } from "./ToolResultDelivery.js";
import { parseMcpResponseBudget } from "../config/mcpResponseBudget.js";
import {
  parseMcpOutputSchemaProfile,
  resolveMcpOutputSchemaProfile,
  type McpOutputSchemaProfile,
} from "../config/mcpOutputSchemaProfile.js";
import {
  COMPACT_INPUT_SCHEMA_PRESENTATION,
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
import { JavaScriptRecoveryService } from "../application/javascript/JavaScriptRecoveryService.js";
import { registerElectronTools } from "./registerElectronTools.js";
import { registerEnhancedTools } from "./registerEnhancedTools.js";
import { registerJavaScriptRuntimeObservationTools } from "./registerJavaScriptRuntimeObservationTools.js";
import { registerManagedTools } from "./registerManagedTools.js";
import { registerAndroidTools } from "./registerAndroidTools.js";
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
  compactPresentation: CompactInputSchemaPresentation,
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
  const environment = snapshotEnvironment(
    options.environment ?? process.env,
    HOST_PLATFORM.platform,
  );
  const analysisSettings =
    options.analysisSettings ?? new AnalysisSettings(environment);
  const compactInputPresentation =
    selectCompactInputSchemaPresentation(environment);
  const selectedOutputSchemaProfile = outputSchemaProfile(environment);
  const catalogProfile = parseMcpToolCatalogProfile(
    environment.REA_MCP_TOOL_CATALOG_PROFILE,
  );
  if (!catalogProfile.ok) throw catalogProfile.error;
  const advertisedToolFamilies = selectAdvertisedToolFamilies(environment);
  const providerEnvironment = captureProviderEnvironment(
    options.providerEnvironment,
    environment,
  );
  const baseDelivery = selectToolResultDelivery(environment, options.delivery);
  const delivery =
    session !== undefined &&
    advertisedToolFamilies !== undefined &&
    !advertisedToolFamilies.has("session")
      ? baseDelivery.withNoTargetRecovery(SCOPED_NO_TARGET_RECOVERY)
      : baseDelivery;
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
    desktopBuildComputers,
    goBinary,
    rustBinary,
    erlangBeam,
    v8CodeCache,
    modelArtifact,
    gpuCodeObjects,
    il2cppMetadata,
    peResources,
    nativeExports,
    devicetree,
    elfNotes,
    nativeInitializers,
    elfUnwindRanges,
    appleIps,
    kernelModule,
    kernelBuildConfig,
    peLoadConfig,
    binaryHardening,
    peCertificates,
    peImports,
    windowsShortcut,
    electronFuses,
    releaseExposure,
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
              const commandFailures =
                capabilities.observeCommandProviderFailures();
              const hasFailures = Object.keys(failures).length > 0;
              const hasCommandFailures =
                Object.keys(commandFailures).length > 0;
              if (!hasFailures && !hasCommandFailures) return value;
              return {
                ...value,
                ...(hasFailures
                  ? {
                      optionalProviderLoadFailures: {
                        ...value.optionalProviderLoadFailures,
                        ...failures,
                      },
                    }
                  : {}),
                ...(hasCommandFailures
                  ? {
                      commandProviderFailures: {
                        ...value.commandProviderFailures,
                        ...commandFailures,
                      },
                    }
                  : {}),
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
        {
          error: cause instanceof Error ? cause.message : String(cause),
          ...retainedDebuggerDiagnostics(cause),
        },
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
    ...(session === undefined
      ? {}
      : { admitRecovery: session.admitRecoveryObservation.bind(session) }),
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
  const contractTools = {
    logger: toolLogger,
    recordEvidence,
    withAdmittedAnalysis: analysisAdmission,
    evidenceById,
  };
  const javascriptRecoveryService = new JavaScriptRecoveryService(
    javascriptRecovery,
  );
  registerToolFamilies({
    direct: () => registerOfficialTools(server, analysisOptions),
    enhanced: () =>
      registerEnhancedTools(server, {
        ...analysisOptions,
        ...(session === undefined
          ? {}
          : { evidenceForAnalysis: session.evidenceForAnalysis.bind(session) }),
        ...(session === undefined
          ? {}
          : { admitRecovery: session.admitRecoveryObservation.bind(session) }),
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
        toolLogger,
        recordEvidence,
        evidenceById,
        analysisAdmission,
      );
      registerServiceTools(
        server,
        {
          byteEntropy: createByteEntropyService(artifactResources),
          peResources,
          nativeExports,
          devicetree,
          elfNotes,
          nativeInitializers,
          elfUnwindRanges,
          appleIps,
          kernelModule,
          kernelBuildConfig,
          peLoadConfig,
          releaseExposure,
          binaryHardening,
          peCertificates,
          peImports,
          windowsShortcut,
          recordedCrash,
        },
        contractTools,
      );
    },
    artifact: () => {
      registerArtifactTools(server, { ...evidenceOptions, evidenceById });
      registerServiceTools(
        server,
        {
          desktopApplication,
          modelArtifact,
          gpuCodeObjects,
          evmInterface,
          goBinary,
          il2cppMetadata,
          rustBinary,
          pythonPyc,
          erlangBeam,
          v8CodeCache,
          wasmArtifact,
          apkSignature,
          sqliteDatabase,
          packetCapture,
          signalRecording,
        },
        contractTools,
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
      registerServiceTools(server, { firmwareAnalysis }, contractTools),
    android: () =>
      registerAndroidTools(
        server,
        new AndroidAnalysisService(android, recordEvidence),
        toolLogger,
        recordEvidence,
        analysisAdmission,
        evidenceById,
      ),
    pcap: () => {
      registerServiceTools(
        server,
        { pcapAnalysis: new PcapAnalysisService(pcap) },
        contractTools,
      );
    },
    flutter: () => {
      registerServiceTools(
        server,
        { flutterAnalysis: new FlutterBuildAnalysisService(flutter) },
        contractTools,
      );
    },
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
      registerServiceTools(
        server,
        { apktoolAnalysis: new ApktoolResourceAnalysisService(apktool) },
        contractTools,
      ),
    jeb: () =>
      registerServiceTools(
        server,
        { jebAnalysis: new JebAnalysisService(jeb) },
        contractTools,
      ),
    adb: () =>
      registerServiceTools(
        server,
        { adbDeviceAnalysis: new AdbDeviceAnalysisService(adbDevice) },
        contractTools,
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
      registerServiceTools(
        server,
        { webRuntime, webNetworkCapture },
        contractTools,
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
      registerServiceTools(
        server,
        {
          webModuleTrace,
          webSourceLocation,
          javascriptRecovery: javascriptRecoveryService,
        },
        contractTools,
      );
      registerApplicationTools(server, {
        artifactResources,
        evidenceById,
        logger: toolLogger,
        recordEvidence,
        recordEvidenceWithUnknown,
        withAdmittedAnalysis: analysisAdmission,
      });
      registerDesktopBuildTools(server, desktopBuildComputers, toolLogger);
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
  if (catalogProfile.value === "hot-cold") server.enableProgressiveCatalog();
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
  return resolveMcpOutputSchemaProfile(configured.value);
};

/** Only `compact` remains; the setting is still parsed so a removed value fails closed. */
const selectCompactInputSchemaPresentation = (
  environment: Readonly<NodeJS.ProcessEnv>,
): CompactInputSchemaPresentation => {
  const configured = parseMcpInputSchemaProfile(
    environment.REA_MCP_INPUT_SCHEMA_PROFILE,
  );
  if (!configured.ok) throw configured.error;
  return COMPACT_INPUT_SCHEMA_PRESENTATION;
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
