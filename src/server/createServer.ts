import {
  createCapabilityServices,
  type CapabilityServiceOptions,
} from "../composition/capabilityServices.js";
import { HOST_PLATFORM, type HostPlatform } from "../platform/HostPlatform.js";
import {
  isToolFamilyAdvertised,
  registerToolFamilies,
} from "../contracts/toolFamilyIds.js";
import { toolFamilyId } from "../contracts/toolFamilies.js";
import { SCOPED_NO_TARGET_RECOVERY } from "./recoveryInstructions.js";
import { AnalysisSettings } from "../application/AnalysisSettings.js";
import { parseMcpInputBudget } from "../config/mcpInputBudget.js";
import { serverInstructions } from "./serverInstructions.js";
import { registerServiceTools } from "./serviceToolBindings.js";
import {
  artifactExecutionParameters,
  managedAnalysisForAdmission,
} from "./providerOperationFamilies.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../contracts/officialToolContracts.js";
import { NATIVE_TOOL_CONTRACTS } from "../contracts/native/nativeToolContracts.js";
import { ARTIFACT_TOOL_CONTRACTS } from "../contracts/artifactToolContracts.js";
import { MANAGED_TOOL_CONTRACTS } from "../contracts/managed/managedToolContracts.js";
import { promptsForToolFamilies } from "../contracts/promptToolFamilyScope.js";
import { retainedDebuggerDiagnostics } from "../process/ownedDebuggerCleanupError.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { captureProviderEnvironment } from "./providerEnvironment.js";
import { createByteEntropyService } from "../composition/binaryDiagnostics.js";
import { FridaInstrumentationService } from "../application/frida/FridaInstrumentationService.js";
import { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { catalogIdentityForToolFamilies } from "../contracts/catalog/catalogIdentity.js";
import { parseMcpToolFamilies } from "../config/mcpToolFamilies.js";
import { parseMcpToolCatalogProfile } from "../config/mcpToolCatalogProfile.js";
import { createToolResultDelivery } from "./toolResult.js";
import type { ToolResultDelivery } from "./ToolResultDelivery.js";
import { parseMcpResponseBudget } from "../config/mcpResponseBudget.js";
import { parseMcpOutputSchemaProfile } from "../config/mcpOutputSchemaProfile.js";
import { parseMcpInputSchemaProfile } from "../config/mcpInputSchemaProfile.js";
import type { CompactInputSchemaPresentation } from "../contracts/compactInputSchema.js";
import type {
  BinarySessionPort,
  ManagedBinarySessionPort,
} from "../application/binary/BinarySessionPort.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { silentLogger } from "../logger.js";
import type { Logger } from "pino";
import { JavaScriptRecoveryService } from "../application/javascript/JavaScriptRecoveryService.js";
import { AndroidAnalysisService } from "../application/android/AndroidAnalysisService.js";
import { JebAnalysisService } from "../application/jeb/JebAnalysisService.js";
import { PcapAnalysisService } from "../application/pcap/PcapAnalysisService.js";
import { ApktoolResourceAnalysisService } from "../application/apktool/ApktoolResourceAnalysisService.js";
import { FlutterBuildAnalysisService } from "../application/flutter/FlutterBuildAnalysisService.js";
import { AdbDeviceAnalysisService } from "../application/adb/AdbDeviceAnalysisService.js";
import { registerGuidedPrompts } from "./registerPrompts.js";
import { registerSessionTools } from "./registerSessionTools.js";
import type { AvailabilityPolicy } from "../application/CapabilityInventory.js";
import { sessionAvailabilityPolicy } from "./sessionAvailabilityPolicy.js";
import {
  withAdmittedAnalysis,
  type ServerAnalysisSource,
} from "./analysisAdmission.js";
import {
  resolveMcpOutputSchemaProfile,
  type McpOutputSchemaProfile,
  COMPACT_INPUT_SCHEMA_PRESENTATION,
} from "../contracts/mcpSchemaPresentation.js";
import { errorMessage } from "../kernel/errorMessage.js";

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
  readonly createManagedBinarySession?: () =>
    | ManagedBinarySessionPort
    | Promise<ManagedBinarySessionPort>;
  /**
   * The host the server's integrations run on: it decides environment-name
   * rules, host-restricted availability and execution checks. Defaults to the
   * running host; tests select another host here.
   */
  readonly host?: HostPlatform;
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
      instructions: serverInstructions(session !== undefined, (tool) =>
        isToolFamilyAdvertised(advertisedToolFamilies, toolFamilyId(tool)),
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
  const host = options.host ?? HOST_PLATFORM;
  const environment = snapshotEnvironment(
    options.environment ?? process.env,
    host.platform,
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
    host.platform,
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
    platform: host.platform,
    arch: host.architecture,
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
    elfDebugLink,
    nativeInitializers,
    elfUnwindRanges,
    appleIps,
    kernelModule,
    kernelBuildConfig,
    peLoadConfig,
    peOverlay,
    binaryHardening,
    peCertificates,
    peImports,
    windowsShortcut,
    electronFuses,
    releaseExposure,
    nugetNupkg,
    pythonPyc,
    mavenGradleMetadata,
    dwarfUnits,
    elfDependencies,
    webNetworkCapture,
    javascriptRecovery,
    artifactResources,
    reverseEngineering,
    uefiAnalysis,
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
            host.platform,
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
  const previousOnclose = server.server.onclose;
  server.server.onclose = () => {
    previousOnclose?.();
    void closeProviders().catch((cause: unknown) => {
      logger.error(
        {
          error: errorMessage(cause),
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
  const contractTools = {
    logger: toolLogger,
    recordEvidence,
    recordEvidenceWithUnknown,
    withAdmittedAnalysis: analysisAdmission,
    evidenceById,
  };
  const javascriptRecoveryService = new JavaScriptRecoveryService(
    javascriptRecovery,
  );
  registerToolFamilies({
    direct: () =>
      registerServiceTools(
        server,
        {
          providerOperations: {
            contracts: OFFICIAL_TOOL_CONTRACTS,
            activeTarget,
            ...(session === undefined
              ? {}
              : {
                  admitRecovery: session.admitRecoveryObservation.bind(session),
                }),
          },
        },
        contractTools,
      ),
    enhanced: () =>
      registerServiceTools(
        server,
        { enhancedWorkflows: { session } },
        contractTools,
      ),
    native: () => {
      registerServiceTools(
        server,
        {
          providerOperations: {
            contracts: NATIVE_TOOL_CONTRACTS,
            activeTarget,
          },
        },
        contractTools,
      );
      registerServiceTools(
        server,
        { reverseEngineering: { service: reverseEngineering, session } },
        contractTools,
      );
      registerServiceTools(
        server,
        {
          cutter: { service: cutter, session },
          gdb: { manager: gdbSessions, session },
          rizinDebug: { manager: rizinDebugSessions, session },
        },
        { logger: toolLogger, recordEvidence, evidenceById },
      );
      registerServiceTools(
        server,
        {
          binaryLayout,
          byteEntropy: createByteEntropyService(artifactResources),
          peResources,
          nativeExports,
          devicetree,
          elfNotes,
          elfDebugLink,
          nativeInitializers,
          elfUnwindRanges,
          appleIps,
          kernelModule,
          kernelBuildConfig,
          peLoadConfig,
          peOverlay,
          releaseExposure,
          binaryHardening,
          peCertificates,
          peImports,
          windowsShortcut,
          recordedCrash,
          dwarfUnits,
          elfDependencies,
        },
        contractTools,
      );
    },
    artifact: () => {
      registerServiceTools(
        server,
        {
          providerOperations: {
            contracts: ARTIFACT_TOOL_CONTRACTS,
            activeTarget,
            parametersForExecution: artifactExecutionParameters,
          },
        },
        contractTools,
      );
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
          nugetNupkg,
          pythonPyc,
          erlangBeam,
          v8CodeCache,
          wasmArtifact,
          apkSignature,
          sqliteDatabase,
          packetCapture,
          signalRecording,
          mavenGradleMetadata,
        },
        contractTools,
      );
    },
    managed: () => {
      registerServiceTools(
        server,
        {
          providerOperations: {
            contracts: MANAGED_TOOL_CONTRACTS,
            activeTarget,
            analysisForAdmission: managedAnalysisForAdmission(
              activeTarget,
              options.createManagedBinarySession ??
                (session === undefined
                  ? capabilities.createManagedBinarySession
                  : () =>
                      session.createManagedBinarySession?.() ??
                      capabilities.createManagedBinarySession()),
            ),
          },
        },
        contractTools,
      );
      if (session !== undefined)
        registerServiceTools(
          server,
          { managedWorkflows: session },
          contractTools,
        );
    },
    firmware: () =>
      registerServiceTools(server, { firmwareAnalysis }, contractTools),
    uefi: () => registerServiceTools(server, { uefiAnalysis }, contractTools),
    android: () =>
      registerServiceTools(
        server,
        {
          androidAnalysis: new AndroidAnalysisService(android, recordEvidence),
        },
        contractTools,
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
      // Frida instruments a live process the caller selects, outside
      // analysis admission.
      registerServiceTools(
        server,
        { frida: new FridaInstrumentationService(fridaInstrumentation) },
        { logger: toolLogger, recordEvidence, evidenceById },
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
      registerServiceTools(
        server,
        {
          browserObservation: {
            browser: options.browserObservation,
            loadFailure:
              options.optionalProviderLoadFailures?.browserObservation,
          },
        },
        contractTools,
      );
      registerServiceTools(
        server,
        {
          browserScenario: {
            provider: options.browserScenarioCapture,
            loadFailure:
              options.optionalProviderLoadFailures?.browserScenarioCapture,
          },
          webRuntime,
          webNetworkCapture,
        },
        contractTools,
      );
    },
    electron: () =>
      registerServiceTools(
        server,
        {
          electronFuses,
          electronObservation: {
            provider: options.electronObservation,
            loadFailure:
              options.optionalProviderLoadFailures?.electronObservation,
          },
          electronScenario: {
            provider: options.electronActiveObservation,
            loadFailure:
              options.optionalProviderLoadFailures?.electronActiveObservation,
          },
          javascriptApplication: {
            resources: artifactResources,
            environment,
            settings: analysisSettings.read,
          },
        },
        contractTools,
      ),
    "javascript-runtime": () =>
      registerServiceTools(
        server,
        {
          javascriptRuntime: {
            runtime: options.javascriptRuntimeObservation,
            loadFailure:
              options.optionalProviderLoadFailures
                ?.javascriptRuntimeObservation,
          },
        },
        contractTools,
      ),
    application: () => {
      registerServiceTools(
        server,
        {
          analysisSettings: {
            settings: analysisSettings,
            delivery: server.delivery,
          },
          analysisView: { resources: artifactResources },
          webScripts: artifactResources,
          guidance: artifactResources,
          webModuleTrace,
          webSourceLocation,
          javascriptRecovery: javascriptRecoveryService,
          applicationWorkflows: { resources: artifactResources },
          guidedWorkflows: promptsForToolFamilies(
            server.advertisedToolFamilies,
          ),
        },
        contractTools,
      );
      // Build tool responses are redacted as a whole; they record nothing.
      registerServiceTools(
        server,
        { desktopBuild: desktopBuildComputers },
        { logger: toolLogger },
      );
    },
    session: () => {
      if (session === undefined) return;
      registerSessionTools(server, session, toolLogger, {
        environment,
        platform: host.platform,
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
