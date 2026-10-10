import type { WasmArtifactService } from "../application/wasm/WasmArtifactService.js";
import { createWasmArtifactService } from "../composition/wasm.js";
import { registerWasmTools } from "./registerWasmTools.js";
import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import type { EvmInterfaceService } from "../application/evm/EvmInterfaceService.js";
import { createEvmInterfaceService } from "../composition/evm.js";
import { registerEvmTools } from "./registerEvmTools.js";
import { registerRecordedCrashTools } from "./registerRecordedCrashTools.js";
import { createRecordedCrashService } from "../composition/binaryDiagnostics.js";
import type { RecordedCrashService } from "../application/binaryDiagnostics/RecordedCrashService.js";
import { registerAnalysisViewTool } from "./registerAnalysisViewTool.js";
import { registerBinaryDiagnosticsTools } from "./registerBinaryDiagnosticsTools.js";
import { createBinaryLayoutService } from "../composition/binaryDiagnostics.js";
import type { BinaryLayoutService } from "../application/binaryDiagnostics/BinaryLayoutService.js";
import { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import {
  createToolResultDelivery,
  type ToolResultDelivery,
} from "./toolResult.js";
import { parseMcpResponseBudget } from "../config/mcpResponseBudget.js";
import {
  COMPACT_INPUT_SCHEMA_BUDGET_BYTES,
  parseMcpInputSchemaProfile,
} from "../config/mcpInputSchemaProfile.js";
import type { CompactInputSchemaPresentation } from "./EvidenceMcpServer.js";
import { isAbsolute } from "node:path";

import type { BinarySessionPort } from "../application/binary/BinarySessionPort.js";
import type { BrowserObservationPort } from "../application/BrowserObservationPort.js";
import type { BrowserScenarioCapturePort } from "../application/BrowserScenarioCapturePort.js";
import type { ElectronActiveObservationPort } from "../application/javascript/ElectronActiveObservationPort.js";
import type { ElectronObservationPort } from "../application/javascript/ElectronObservationPort.js";
import type { JavaScriptRuntimeObservationPort } from "../application/javascript/JavaScriptRuntimeObservationPort.js";
import type { OptionalProviderLoadFailures } from "../application/OptionalObservationProviders.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { silentLogger } from "../logger.js";
import type { Logger } from "pino";
import { registerApplicationTools } from "./registerApplicationTools.js";
import { registerArtifactTools } from "./registerArtifactTools.js";
import { registerBrowserScenarioTool } from "./registerBrowserScenarioTool.js";
import { registerBrowserTools } from "./registerBrowserTools.js";
import { registerWebScriptTool } from "./registerWebScriptTool.js";
import { registerWebModuleTool } from "./registerWebModuleTool.js";
import type { WebModuleTraceService } from "../application/WebModuleTraceService.js";
import { createWebModuleTraceService } from "../composition/webModules.js";
import { createWebSourceLocationService } from "../composition/webSourceLocations.js";
import { registerWebSourceLocationTool } from "./registerWebSourceLocationTool.js";
import type { WebSourceLocationService } from "../application/WebSourceLocationService.js";
import type { WebRuntimeService } from "../application/WebRuntimeService.js";
import { createWebRuntimeService } from "../composition/webRuntime.js";
import { registerWebRuntimeTools } from "./registerWebRuntimeTools.js";
import type { WebNetworkCaptureService } from "../application/WebNetworkCaptureService.js";
import { createWebNetworkCaptureService } from "../composition/webNetworkCaptures.js";
import { registerWebNetworkCaptureTool } from "./registerWebNetworkCaptureTool.js";
import { registerJavaScriptRecoveryTool } from "./registerJavaScriptRecoveryTool.js";
import { JavaScriptRecoveryService } from "../application/javascript/JavaScriptRecoveryService.js";
import type { JavaScriptRecoveryPort } from "../application/javascript/JavaScriptRecoveryPort.js";
import { createJavaScriptRecoveryProvider } from "../composition/javascriptRecovery.js";
import { registerElectronTools } from "./registerElectronTools.js";
import { registerEnhancedTools } from "./registerEnhancedTools.js";
import { registerJavaScriptRuntimeObservationTools } from "./registerJavaScriptRuntimeObservationTools.js";
import { registerManagedTools } from "./registerManagedTools.js";
import { registerFirmwareTools } from "./registerFirmwareTools.js";
import { FirmwareAnalysisService } from "../application/firmware/FirmwareAnalysisService.js";
import type { FirmwareAnalysisPort } from "../application/firmware/FirmwareAnalysisPort.js";
import { createFirmwareAnalysisProvider } from "../composition/firmware.js";
import { registerAndroidTools } from "./registerAndroidTools.js";
import { AndroidAnalysisService } from "../application/android/AndroidAnalysisService.js";
import type { AndroidAnalysisPort } from "../application/android/AndroidAnalysisPort.js";
import { createAndroidAnalysisProvider } from "../composition/android.js";
import { registerManagedWorkflowTools } from "./registerManagedWorkflowTools.js";
import { NATIVE_TOOL_CONTRACTS } from "../contracts/native/nativeToolContracts.js";
import { registerEvidenceTools } from "./registerEvidenceTools.js";
import { registerOfficialTools } from "./registerOfficialTools.js";
import { registerGuidedPrompts } from "./registerPrompts.js";
import { registerSessionTools } from "./registerSessionTools.js";
import type { AvailabilityPolicy } from "../application/CapabilityInventory.js";
import { sessionAvailabilityPolicy } from "./sessionAvailabilityPolicy.js";
import {
  withAdmittedAnalysis,
  type ServerAnalysisSource,
} from "./analysisAdmission.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";

const TARGET_FREE_INSTRUCTIONS =
  "REA provides reverse-engineering tools for local artifacts, native binaries, managed code, browser pages, and runtimes. Use the tool that directly answers the question; discover targets or inspect inventory only when needed. Tool results include inline Evidence and report their coverage and limitations.";

const ACTIVE_TARGET_INSTRUCTIONS =
  "REA analyzes the active reverse-engineering target. Use the analysis tool that answers the question directly. Search or list symbols when discovery is needed; analyze_function provides a function dossier, and focused procedure tools return individual facets.";

export interface CreateServerOptions {
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly delivery?: ToolResultDelivery;
  readonly wasmArtifact?: WasmArtifactService;
  readonly evmInterface?: EvmInterfaceService;
  readonly logger?: Logger;
  readonly binaryLayout?: BinaryLayoutService;
  readonly recordedCrash?: RecordedCrashService;
  readonly firmwareAnalysis?: FirmwareAnalysisPort;
  readonly javascriptRecovery?: JavaScriptRecoveryPort;
  readonly webModuleTrace?: WebModuleTraceService;
  readonly webSourceLocation?: WebSourceLocationService;
  readonly webRuntime?: WebRuntimeService;
  readonly webNetworkCapture?: WebNetworkCaptureService;
  readonly androidAnalysis?: AndroidAnalysisPort;
  readonly browserObservation?: BrowserObservationPort;
  readonly browserScenarioCapture?: BrowserScenarioCapturePort;
  readonly electronObservation?: ElectronObservationPort;
  readonly electronActiveObservation?: ElectronActiveObservationPort;
  readonly javascriptRuntimeObservation?: JavaScriptRuntimeObservationPort;
  readonly availabilityPolicy?: () => AvailabilityPolicy;
  readonly optionalProviderLoadFailures?: OptionalProviderLoadFailures;
}

const installSessionToolAvailability = (
  session: BinarySessionPort | undefined,
  options: CreateServerOptions,
  environment: Readonly<NodeJS.ProcessEnv>,
) => {
  if (session === undefined) return undefined;
  const linux = process.platform === "linux";
  const linuxX64 = linux && process.arch === "x64";
  const pwntools =
    linuxX64 && isAbsolute(environment.REA_PWNTOOLS_PYTHON ?? "");
  const policy = sessionAvailabilityPolicy(options.availabilityPolicy, {
    optionalProviderLoadFailures: options.optionalProviderLoadFailures,
    optionalFeatures: {
      wasmArtifactEnabled:
        options.wasmArtifact !== undefined ||
        isAbsolute(environment.REA_WABT_BIN_DIRECTORY ?? ""),
      evmInterfaceEnabled: options.evmInterface !== undefined || linuxX64,
      webModuleResolutionEnabled:
        options.webModuleTrace !== undefined ||
        isAbsolute(environment.REA_BROWSER_EXECUTABLE ?? ""),
      recordedCrashEnabled: options.recordedCrash !== undefined || pwntools,
      binaryLayoutEnabled: options.binaryLayout !== undefined || pwntools,
      firmwareInspectionEnabled:
        options.firmwareAnalysis !== undefined ||
        (linux && isAbsolute(environment.REA_BINWALK_COMMAND ?? "")),
      firmwareExtractionEnabled:
        options.firmwareAnalysis !== undefined ||
        (linux && isAbsolute(environment.REA_UNBLOB_COMMAND ?? "")),
      browserObservationEnabled: options.browserObservation !== undefined,
      javascriptRecoveryEnabled:
        options.javascriptRecovery !== undefined ||
        (linuxX64 && isAbsolute(environment.REA_WAKARU_COMMAND ?? "")),
      browserScenarioEnabled: options.browserScenarioCapture !== undefined,
      electronObservationEnabled: options.electronObservation !== undefined,
      electronAutomationEnabled:
        options.electronActiveObservation !== undefined,
      v8InspectorObservationEnabled:
        options.javascriptRuntimeObservation !== undefined,
    },
  });
  return {
    policy,
  };
};

const createMcpServer = (
  session: BinarySessionPort | undefined,
  delivery: ToolResultDelivery,
  compactPresentation: CompactInputSchemaPresentation | undefined,
): EvidenceMcpServer =>
  new EvidenceMcpServer(
    {
      name: PRODUCT_IDENTITY.mcpServerKey,
      version: PRODUCT_IDENTITY.packageVersion,
    },
    {
      capabilities: {},
      instructions:
        session === undefined
          ? ACTIVE_TARGET_INSTRUCTIONS
          : TARGET_FREE_INSTRUCTIONS,
    },
    session === undefined
      ? undefined
      : (evidence) => session.recordEvidence(evidence),
    delivery,
    compactPresentation,
  );

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
  const delivery = selectToolResultDelivery(environment, options.delivery);
  const selectedOptions = { ...options, environment, delivery };
  const startedAt = new Date().toISOString();
  const logger = options.logger ?? silentLogger;
  const server = createMcpServer(
    session,
    delivery,
    selectCompactInputSchemaPresentation(environment),
  );
  const android =
    options.androidAnalysis ?? createAndroidAnalysisProvider(environment);
  const availability = installSessionToolAvailability(
    session,
    selectedOptions,
    environment,
  );
  const toolLogger = logger.child({ layer: "server" });
  const {
    evidenceById,
    activeTarget,
    recordEvidence,
    recordEvidenceWithUnknown,
  } = createSessionRecorders(server, session);
  const toolContext: ServerToolContext = {
    server,
    session,
    options: selectedOptions,
    environment,
    logger: toolLogger,
    evidenceById,
    activeTarget,
    recordEvidence,
    recordEvidenceWithUnknown,
    withAdmittedAnalysis: withAdmittedAnalysis(source),
  };
  registerBinaryAnalysisTools(toolContext);
  const previousOnclose = server.server.onclose;
  server.server.onclose = () => {
    previousOnclose?.();
    void android.close().catch((cause: unknown) => {
      logger.error(
        { error: cause instanceof Error ? cause.message : String(cause) },
        "Android provider cleanup failed",
      );
    });
  };
  const closeServer = server.close.bind(server);
  server.close = async () => {
    const results = await Promise.allSettled([closeServer(), android.close()]);
    for (const result of results)
      if (result.status === "rejected") throw result.reason;
  };
  registerConfiguredAnalysisTools(toolContext, android);
  registerObservationTools(toolContext);
  registerGuidedPrompts(server, analysis, session);
  if (session !== undefined) {
    registerSessionTools(server, session, toolLogger, {
      ...selectedOptions,
      ...(availability === undefined
        ? {}
        : { availabilityPolicy: availability.policy }),
      androidAnalysisAvailability: (signal) =>
        android.inspectAvailability(signal),
      startedAt,
    });
  }
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

const selectCompactInputSchemaPresentation = (
  environment: Readonly<NodeJS.ProcessEnv>,
): CompactInputSchemaPresentation | undefined => {
  const configured = parseMcpInputSchemaProfile(
    environment.REA_MCP_INPUT_SCHEMA_PROFILE,
  );
  if (!configured.ok) throw configured.error;
  return configured.value === "compact"
    ? { budgetBytes: COMPACT_INPUT_SCHEMA_BUDGET_BYTES }
    : undefined;
};

const registerConfiguredAnalysisTools = (
  {
    server,
    options,
    environment,
    logger: toolLogger,
    evidenceById,
    recordEvidence,
  }: ServerToolContext,
  android: AndroidAnalysisPort,
): void => {
  registerAndroidTools(
    server,
    new AndroidAnalysisService(android),
    toolLogger,
    recordEvidence,
  );
  registerBinaryDiagnosticsTools(
    server,
    options.binaryLayout ?? createBinaryLayoutService(environment),
    toolLogger,
    recordEvidence,
  );
  registerAnalysisViewTool(server, toolLogger, evidenceById, recordEvidence);
  registerWasmTools(
    server,
    options.wasmArtifact ?? createWasmArtifactService(environment),
    toolLogger,
    recordEvidence,
  );
  registerEvmTools(
    server,
    options.evmInterface ?? createEvmInterfaceService(environment),
    toolLogger,
    recordEvidence,
  );
  registerRecordedCrashTools(
    server,
    options.recordedCrash ?? createRecordedCrashService(environment),
    toolLogger,
    recordEvidence,
  );
  registerFirmwareTools(
    server,
    new FirmwareAnalysisService(
      options.firmwareAnalysis ?? createFirmwareAnalysisProvider(environment),
    ),
    toolLogger,
    recordEvidence,
  );
  registerWebModuleTool(
    server,
    options.webModuleTrace ?? createWebModuleTraceService(environment),
    toolLogger,
    recordEvidence,
  );
  registerWebSourceLocationTool(
    server,
    options.webSourceLocation ?? createWebSourceLocationService(environment),
    toolLogger,
    recordEvidence,
  );
  registerWebRuntimeTools(
    server,
    options.webRuntime ?? createWebRuntimeService(),
    toolLogger,
    recordEvidence,
  );
  registerWebNetworkCaptureTool(
    server,
    options.webNetworkCapture ?? createWebNetworkCaptureService(environment),
    toolLogger,
    recordEvidence,
  );
  registerJavaScriptRecoveryTool(
    server,
    new JavaScriptRecoveryService(
      options.javascriptRecovery ??
        createJavaScriptRecoveryProvider(environment),
    ),
    toolLogger,
    recordEvidence,
  );
};

const createSessionRecorders = (
  server: EvidenceMcpServer,
  session: BinarySessionPort | undefined,
) => ({
  evidenceById:
    session === undefined
      ? undefined
      : (evidenceId: string) =>
          session.evidenceForAnalysis?.(evidenceId) ??
          session.evidenceById(evidenceId),
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

interface ServerToolContext extends ReturnType<typeof createSessionRecorders> {
  readonly server: EvidenceMcpServer;
  readonly session: BinarySessionPort | undefined;
  readonly options: CreateServerOptions;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly logger: Logger;
  readonly withAdmittedAnalysis: WithAdmittedAnalysis;
}

const registerBinaryAnalysisTools = ({
  server,
  session,
  logger,
  activeTarget,
  recordEvidence,
  recordEvidenceWithUnknown,
  withAdmittedAnalysis,
}: ServerToolContext): void => {
  const recordUnknown =
    session === undefined
      ? undefined
      : (input: Parameters<typeof session.recordUnknown>[0]) =>
          session.recordUnknown(input);
  const analysisOptions = {
    logger,
    activeTarget,
    recordEvidence,
    recordUnknown,
    withAdmittedAnalysis,
  };
  registerOfficialTools(server, analysisOptions);
  registerEnhancedTools(server, {
    ...analysisOptions,
    analysisProfile:
      session === undefined ? undefined : () => session.analysisProfile(),
    allowsSnapshotReplay:
      session === undefined
        ? undefined
        : (operation) => session.allowsSnapshotReplay(operation),
    recordWorkflowSnapshot:
      session === undefined
        ? undefined
        : (input) => session.recordWorkflowSnapshot(input),
  });
  const evidenceOptions = {
    logger,
    activeTarget,
    recordEvidence,
    withAdmittedAnalysis,
  };
  registerEvidenceTools(server, NATIVE_TOOL_CONTRACTS, evidenceOptions);
  registerArtifactTools(server, evidenceOptions);
  registerManagedTools(server, evidenceOptions);
  if (session !== undefined)
    registerManagedWorkflowTools(server, {
      logger,
      recordEvidence,
      recordEvidenceWithUnknown,
      session,
    });
};

const registerObservationTools = ({
  evidenceById,
  server,
  options,
  logger,
  recordEvidence,
  recordEvidenceWithUnknown,
}: ServerToolContext): void => {
  const common = { logger, recordEvidence };
  registerWebScriptTool(server, common);
  registerBrowserTools(server, {
    ...common,
    browser: options.browserObservation,
    loadFailure: options.optionalProviderLoadFailures?.browserObservation,
  });
  registerBrowserScenarioTool(server, {
    ...common,
    provider: options.browserScenarioCapture,
    loadFailure: options.optionalProviderLoadFailures?.browserScenarioCapture,
  });
  registerElectronTools(server, {
    ...common,
    electron: options.electronObservation,
    electronActive: options.electronActiveObservation,
    observationLoadFailure:
      options.optionalProviderLoadFailures?.electronObservation,
    activeLoadFailure:
      options.optionalProviderLoadFailures?.electronActiveObservation,
  });
  registerJavaScriptRuntimeObservationTools(server, {
    ...common,
    runtime: options.javascriptRuntimeObservation,
    loadFailure:
      options.optionalProviderLoadFailures?.javascriptRuntimeObservation,
  });
  registerApplicationTools(server, {
    evidenceById,
    logger,
    recordEvidence,
    recordEvidenceWithUnknown,
  });
};
