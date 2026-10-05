import { McpServer } from "@modelcontextprotocol/server";

import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import type { BrowserObservationPort } from "../application/BrowserObservationPort.js";
import type { BrowserScenarioCapturePort } from "../application/BrowserScenarioCapturePort.js";
import type { ElectronActiveObservationPort } from "../application/ElectronActiveObservationPort.js";
import type { ElectronObservationPort } from "../application/ElectronObservationPort.js";
import type {
  JavaScriptReplayConfiguration,
  JavaScriptReplayHost,
  JavaScriptReplayRunner,
} from "../application/JavaScriptReplayPlanning.js";
import type { ManagedRuntimeConfiguration } from "../application/ManagedRuntimeCorrelationService.js";
import type { JavaScriptRuntimeObservationPort } from "../application/JavaScriptRuntimeObservationPort.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { defaultJavaScriptReplayConfiguration } from "../config/runtimeConfiguration.js";
import { silentLogger, type Logger } from "../logger.js";
import { LinuxJavaScriptReplayRunner } from "../replay/LinuxJavaScriptReplayRunner.js";
import { SystemJavaScriptReplayHost } from "../replay/SystemJavaScriptReplayHost.js";
import { registerApplicationTools } from "./registerApplicationTools.js";
import { registerArtifactTools } from "./registerArtifactTools.js";
import { registerBrowserScenarioTool } from "./registerBrowserScenarioTool.js";
import { registerBrowserTools } from "./registerBrowserTools.js";
import { registerElectronTools } from "./registerElectronTools.js";
import { registerEnhancedTools } from "./registerEnhancedTools.js";
import { registerJavaScriptRuntimeObservationTools } from "./registerJavaScriptRuntimeObservationTools.js";
import { registerManagedTools } from "./registerManagedTools.js";
import { registerManagedWorkflowTools } from "./registerManagedWorkflowTools.js";
import { registerNativeTools } from "./registerNativeTools.js";
import { registerOfficialTools } from "./registerOfficialTools.js";
import { registerGuidedPrompts } from "./registerPrompts.js";
import { registerSessionTools } from "./registerSessionTools.js";
import type { SessionAvailability } from "./sessionAvailabilityPolicy.js";
import { sessionAvailabilityPolicy } from "./sessionAvailabilityPolicy.js";

const TARGET_FREE_INSTRUCTIONS =
  "REA provides reverse-engineering tools for local artifacts, native binaries, managed code, browser pages, and runtimes. Use the tool that directly answers the question; discover targets or inspect inventory only when needed. Tool results include inline Evidence and report their coverage and limitations.";

const ACTIVE_TARGET_INSTRUCTIONS =
  "REA analyzes the active reverse-engineering target. Use the analysis tool that answers the question directly. Search or list symbols when discovery is needed; analyze_function provides a function dossier, and focused procedure tools return individual facets.";

export interface CreateServerOptions {
  readonly logger?: Logger;
  readonly browserObservation?: BrowserObservationPort;
  readonly browserScenarioCapture?: BrowserScenarioCapturePort;
  readonly electronObservation?: ElectronObservationPort;
  readonly electronActiveObservation?: ElectronActiveObservationPort;
  readonly javascriptRuntimeObservation?: JavaScriptRuntimeObservationPort;
  readonly javascriptReplayConfiguration?: () => JavaScriptReplayConfiguration;
  readonly javascriptReplayHost?: JavaScriptReplayHost;
  readonly javascriptReplayRunner?: JavaScriptReplayRunner;
  readonly managedRuntimeConfiguration?: () => ManagedRuntimeConfiguration;
  readonly availabilityPolicy?: () => SessionAvailability;
}

const installSessionToolAvailability = (
  server: McpServer,
  session: BinarySessionPort | undefined,
  options: CreateServerOptions,
) => {
  if (session === undefined) return undefined;
  const policy = sessionAvailabilityPolicy(options.availabilityPolicy, {
    optionalFeatures: {
      browserObservationEnabled: options.browserObservation !== undefined,
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

const createMcpServer = (session: BinarySessionPort | undefined): McpServer =>
  new McpServer(
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
  );

/**
 * Construct one MCP server without acquiring subprocess resources.
 * Supplying a session adds target lifecycle tools; omitting it retains the
 * fixed-target seam used by focused tests and embedders.
 */
export const createServer = (
  analysis: AnalysisOperationPort,
  session?: BinarySessionPort,
  options: CreateServerOptions = {},
): McpServer => {
  const startedAt = new Date().toISOString();
  const logger = options.logger ?? silentLogger;
  const server = createMcpServer(session);
  const availability = installSessionToolAvailability(server, session, options);
  const toolLogger = logger.child({ layer: "server" });
  const { activeTarget, recordEvidence, recordEvidenceWithUnknown } =
    createSessionRecorders(server, session);
  const toolContext: ServerToolContext = {
    server,
    analysis,
    session,
    options,
    logger: toolLogger,
    activeTarget,
    recordEvidence,
    recordEvidenceWithUnknown,
  };
  registerBinaryAnalysisTools(toolContext);
  registerObservationTools(toolContext);
  registerGuidedPrompts(server, analysis, session);
  if (session !== undefined) {
    registerSessionTools(server, session, toolLogger, {
      ...options,
      ...(availability === undefined
        ? {}
        : { availabilityPolicy: availability.policy }),
      startedAt,
    });
  }
  return server;
};

const createSessionRecorders = (
  server: McpServer,
  session: BinarySessionPort | undefined,
) => ({
  activeTarget:
    session === undefined ? undefined : () => session.activeTarget(),
  recordEvidence:
    session === undefined
      ? undefined
      : (evidence: Parameters<typeof session.recordEvidence>[0]) => {
          const recorded = session.recordEvidence(evidence);
          return recorded;
        },
  recordEvidenceWithUnknown:
    session === undefined
      ? undefined
      : (
          evidence: Parameters<typeof session.recordEvidenceWithUnknown>[0],
          input: Parameters<typeof session.recordEvidenceWithUnknown>[1],
        ) => {
          const recorded = session.recordEvidenceWithUnknown(evidence, input);
          return recorded;
        },
});

interface ServerToolContext extends ReturnType<typeof createSessionRecorders> {
  readonly server: McpServer;
  readonly analysis: AnalysisOperationPort;
  readonly session: BinarySessionPort | undefined;
  readonly options: CreateServerOptions;
  readonly logger: Logger;
}

const registerBinaryAnalysisTools = ({
  server,
  analysis,
  session,
  options,
  logger,
  activeTarget,
  recordEvidence,
  recordEvidenceWithUnknown,
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
  };
  registerOfficialTools(server, analysis, analysisOptions);
  registerEnhancedTools(server, analysis, {
    ...analysisOptions,
    analysisProfile:
      session === undefined ? undefined : () => session.analysisProfile(),
  });
  const evidenceOptions = { logger, activeTarget, recordEvidence };
  registerNativeTools(server, analysis, evidenceOptions);
  registerArtifactTools(server, analysis, {
    ...evidenceOptions,
  });
  registerManagedTools(server, analysis, {
    ...evidenceOptions,
    session,
  });
  if (session !== undefined)
    registerManagedWorkflowTools(server, {
      logger,
      recordEvidence,
      recordEvidenceWithUnknown,
      session,
      runtime: {
        configuration:
          options.managedRuntimeConfiguration ??
          (() => ({ executablePath: undefined })),
      },
    });
};

const registerObservationTools = ({
  server,
  options,
  logger,
  recordEvidence,
  recordEvidenceWithUnknown,
}: ServerToolContext): void => {
  const common = { logger, recordEvidence };
  registerBrowserTools(server, {
    ...common,
    browser: options.browserObservation,
  });
  registerBrowserScenarioTool(server, {
    ...common,
    provider: options.browserScenarioCapture,
  });
  registerElectronTools(server, {
    ...common,
    electron: options.electronObservation,
    electronActive: options.electronActiveObservation,
  });
  registerJavaScriptRuntimeObservationTools(server, {
    ...common,
    runtime: options.javascriptRuntimeObservation,
  });
  registerApplicationTools(server, {
    logger,
    recordEvidence,
    recordEvidenceWithUnknown,
    replay: {
      configuration:
        options.javascriptReplayConfiguration ??
        defaultJavaScriptReplayConfiguration,
      host: options.javascriptReplayHost ?? new SystemJavaScriptReplayHost(),
      runner:
        options.javascriptReplayRunner ?? new LinuxJavaScriptReplayRunner(),
    },
  });
};
