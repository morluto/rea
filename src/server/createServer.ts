import { randomBytes } from "node:crypto";

import {
  CLIENT_CAPABILITIES_META_KEY,
  createRequestStateCodec,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";

import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import type { BrowserObservationPort } from "../application/BrowserObservationPort.js";
import type { BrowserScenarioCapturePort } from "../application/BrowserScenarioCapturePort.js";
import type { ElectronActiveObservationPort } from "../application/ElectronActiveObservationPort.js";
import type { ElectronObservationPort } from "../application/ElectronObservationPort.js";
import type {
  JavaScriptReplayHost,
  JavaScriptReplayPolicy,
  JavaScriptReplayRunner,
} from "../application/JavaScriptReplayPlanning.js";
import type { JavaScriptRuntimeObservationPort } from "../application/JavaScriptRuntimeObservationPort.js";
import type { ManagedRuntimePolicy } from "../application/ManagedRuntimeCorrelationService.js";
import { MANAGED_RUNTIME_DISABLED } from "../application/ManagedRuntimeCorrelationService.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import type { ProcessExecutionPolicy } from "../domain/processCapture.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { silentLogger, type Logger } from "../logger.js";
import { LinuxJavaScriptReplayRunner } from "../replay/LinuxJavaScriptReplayRunner.js";
import { SystemJavaScriptReplayHost } from "../replay/SystemJavaScriptReplayHost.js";
import { mcpEnvelopeValue } from "./mcpClientMetadata.js";
import {
  PROCESS_CAPTURE_ELICITATION_POLICY,
  type ProcessCaptureElicitation,
  type ProcessCaptureElicitationState,
} from "./ProcessCaptureElicitation.js";
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
import { DENY_PROCESS_POLICY } from "./sessionToolPolicies.js";

const TARGET_FREE_INSTRUCTIONS =
  "REA provides reverse-engineering tools for local artifacts, native binaries, managed code, browser pages, and runtimes. Use the tool that directly answers the question; discover targets or inspect inventory only when needed. Tool results include inline Evidence and report their coverage and limitations.";

const ACTIVE_TARGET_INSTRUCTIONS =
  "REA analyzes the active reverse-engineering target. Use the analysis tool that answers the question directly. Search or list symbols when discovery is needed; analyze_function provides a function dossier, and focused procedure tools return individual facets.";

export interface CreateServerOptions {
  readonly logger?: Logger;
  readonly processPolicy?: () => ProcessExecutionPolicy;
  readonly permissionAuthority?: PermissionAuthority;
  readonly browserObservation?: BrowserObservationPort;
  readonly browserScenarioCapture?: BrowserScenarioCapturePort;
  readonly electronObservation?: ElectronObservationPort;
  readonly electronActiveObservation?: ElectronActiveObservationPort;
  readonly javascriptRuntimeObservation?: JavaScriptRuntimeObservationPort;
  readonly artifactIntegrityContinueEnabled?: () => boolean;
  readonly javascriptReplayPolicy?: () => JavaScriptReplayPolicy;
  readonly javascriptReplayHost?: JavaScriptReplayHost;
  readonly javascriptReplayRunner?: JavaScriptReplayRunner;
  readonly managedRuntimePolicy?: () => ManagedRuntimePolicy;
  readonly availabilityPolicy?: () => SessionAvailability;
}

const installSessionToolAvailability = (
  server: McpServer,
  session: BinarySessionPort | undefined,
  options: CreateServerOptions,
) => {
  if (session === undefined) return undefined;
  const policy = sessionAvailabilityPolicy(options.availabilityPolicy, {
    processPolicy: options.processPolicy?.() ?? DENY_PROCESS_POLICY,
    optionalFeatures: {
      browserObservationEnabled: options.browserObservation !== undefined,
      browserScenarioEnabled: options.browserScenarioCapture !== undefined,
      electronObservationEnabled: options.electronObservation !== undefined,
      electronAutomationEnabled:
        options.electronActiveObservation !== undefined &&
        options.permissionAuthority !== undefined,
      v8InspectorObservationEnabled:
        options.javascriptRuntimeObservation !== undefined,
      javascriptReplayEnabled:
        options.javascriptReplayPolicy?.().status === "enabled",
      managedRuntimeEnabled:
        options.managedRuntimePolicy?.().status === "enabled",
    },
  });
  return {
    policy,
  };
};

const createProcessCaptureElicitation = (
  stateCodec: ProcessCaptureElicitation["stateCodec"],
): ProcessCaptureElicitation => ({
  stateCodec,
  supported: (context) => {
    const envelope = context.mcpReq.envelope;
    const version = mcpEnvelopeValue(envelope, PROTOCOL_VERSION_META_KEY);
    const capabilities = mcpEnvelopeValue(
      envelope,
      CLIENT_CAPABILITIES_META_KEY,
    );
    return (
      typeof version === "string" &&
      PROCESS_CAPTURE_ELICITATION_POLICY.protocolVersions.some(
        (supported) => supported === version,
      ) &&
      isRecord(capabilities) &&
      isRecord(capabilities.elicitation) &&
      capabilities.elicitation.form !== undefined
    );
  },
  now: Date.now,
  consumedNonces: new Map<string, number>(),
});

const createMcpServer = (
  processCaptureStateCodec: ProcessCaptureElicitation["stateCodec"],
  session: BinarySessionPort | undefined,
): McpServer =>
  new McpServer(
    {
      name: PRODUCT_IDENTITY.mcpServerKey,
      version: PRODUCT_IDENTITY.packageVersion,
    },
    {
      capabilities: {},
      inputRequired: {
        roundTimeoutMs: PROCESS_CAPTURE_ELICITATION_POLICY.roundTimeoutMs,
      },
      requestState: { verify: processCaptureStateCodec.verify },
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
  const permissionAuthority =
    options.permissionAuthority?.createConnectionAuthority();
  const processCaptureStateCodec =
    createRequestStateCodec<ProcessCaptureElicitationState>({
      key: randomBytes(32),
      ttlSeconds: PROCESS_CAPTURE_ELICITATION_POLICY.stateTtlSeconds,
    });
  const server = createMcpServer(processCaptureStateCodec, session);
  const availability = installSessionToolAvailability(server, session, options);
  server.server.onclose = () => {
    permissionAuthority?.clearSessionGrants();
  };
  const toolLogger = logger.child({ layer: "server" });
  const { activeTarget, recordEvidence, recordEvidenceWithUnknown } =
    createSessionRecorders(server, session);
  const processCaptureElicitation = createProcessCaptureElicitation(
    processCaptureStateCodec,
  );
  const toolContext: ServerToolContext = {
    server,
    analysis,
    session,
    options,
    logger: toolLogger,
    permissionAuthority,
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
      ...(permissionAuthority === undefined ? {} : { permissionAuthority }),
      startedAt,
      processCaptureElicitation,
    });
  }
  return server;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

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
  readonly permissionAuthority: PermissionAuthority | undefined;
}

const registerBinaryAnalysisTools = ({
  server,
  analysis,
  session,
  options,
  logger,
  permissionAuthority,
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
    ...(permissionAuthority === undefined ? {} : { permissionAuthority }),
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
        policy:
          options.managedRuntimePolicy ?? (() => MANAGED_RUNTIME_DISABLED),
        authority: permissionAuthority,
      },
    });
};

const registerObservationTools = ({
  server,
  options,
  logger,
  permissionAuthority,
  recordEvidence,
  recordEvidenceWithUnknown,
}: ServerToolContext): void => {
  const common = { logger, permissionAuthority, recordEvidence };
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
    permissionAuthority,
    replay: {
      policy:
        options.javascriptReplayPolicy ?? (() => ({ status: "disabled" })),
      host: options.javascriptReplayHost ?? new SystemJavaScriptReplayHost(),
      runner:
        options.javascriptReplayRunner ?? new LinuxJavaScriptReplayRunner(),
      authority: permissionAuthority,
    },
  });
};
