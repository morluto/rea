import { randomBytes } from "node:crypto";

import {
  CLIENT_CAPABILITIES_META_KEY,
  createRequestStateCodec,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";

import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { silentLogger, type Logger } from "../logger.js";
import type { ProcessExecutionPolicy } from "../domain/processCapture.js";
import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import { registerGuidedPrompts } from "./registerPrompts.js";
import { registerEvidenceResources } from "./registerEvidenceResources.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import type { BrowserObservationPort } from "../application/BrowserObservationPort.js";
import type { BrowserScenarioCapturePort } from "../application/BrowserScenarioCapturePort.js";
import type { ElectronObservationPort } from "../application/ElectronObservationPort.js";
import type { ElectronActiveObservationPort } from "../application/ElectronActiveObservationPort.js";
import type { JavaScriptRuntimeObservationPort } from "../application/JavaScriptRuntimeObservationPort.js";
import { MANAGED_RUNTIME_DISABLED } from "../application/ManagedRuntimeCorrelationService.js";
import { LinuxJavaScriptReplayRunner } from "../replay/LinuxJavaScriptReplayRunner.js";
import { SystemJavaScriptReplayHost } from "../replay/SystemJavaScriptReplayHost.js";
import type { SessionAvailability } from "./sessionAvailabilityPolicy.js";
import { sessionAvailabilityPolicy } from "./sessionAvailabilityPolicy.js";
import {
  DENY_EVIDENCE_FILE_POLICY,
  DENY_PROCESS_POLICY,
} from "./sessionToolPolicies.js";
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
import { registerSessionTools } from "./registerSessionTools.js";

const TARGET_FREE_INSTRUCTIONS =
  "ASAR/JavaScript -> analyze_javascript_application; archive/package -> open_binary(path), then inspect_artifact/inventory_artifact (active target); managed PE/CLI -> inspect_managed_artifact; browser/Electron -> list_browser_targets/list_electron_targets; approved -> capture_browser_scenario/capture_electron_scenario; Node/Electron Inspector -> list_javascript_runtime_targets; native binary/database -> open_binary, then binary_overview. Start with binary_session; use tools/list; capabilities via binary_session. Use summaries, cite Evidence IDs; Never repeat identical analysis or read full Evidence.";

const ACTIVE_TARGET_INSTRUCTIONS =
  "REA analyzes the active reverse-engineering target. Start native analysis with binary_overview, then narrow with analyze_function, literal search, callers, callees, and xrefs. Prefer summary views, never repeat an identical call, and read full Evidence only when the task requires it.";
import type {
  JavaScriptReplayHost,
  JavaScriptReplayPolicy,
  JavaScriptReplayRunner,
} from "../application/JavaScriptReplayPlanning.js";
import type { ManagedRuntimePolicy } from "../application/ManagedRuntimeCorrelationService.js";
import {
  PROCESS_CAPTURE_ELICITATION_POLICY,
  type ProcessCaptureElicitationState,
} from "./ProcessCaptureElicitation.js";

export interface CreateServerOptions {
  readonly logger?: Logger;
  readonly processPolicy?: () => ProcessExecutionPolicy;
  readonly evidenceFilePolicy?: EvidenceFilePolicy;
  readonly investigationInputRoots?: readonly string[];
  readonly analysisSnapshotFilePolicy?: EvidenceFilePolicy;
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
    evidenceFilePolicy: options.evidenceFilePolicy ?? DENY_EVIDENCE_FILE_POLICY,
    investigationInputRoots: options.investigationInputRoots ?? [],
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

type ProcessCaptureElicitation = {
  readonly stateCodec: ReturnType<
    typeof createRequestStateCodec<ProcessCaptureElicitationState>
  >;
  readonly supported: (context: {
    readonly mcpReq: {
      readonly envelope?: Readonly<Record<string, unknown>>;
    };
  }) => boolean;
  readonly now: typeof Date.now;
  readonly consumedNonces: Map<string, number>;
};

const createProcessCaptureElicitation = (
  stateCodec: ProcessCaptureElicitation["stateCodec"],
): ProcessCaptureElicitation => ({
  stateCodec,
  supported: (context) => {
    const envelope = context.mcpReq.envelope;
    const version = envelope?.[PROTOCOL_VERSION_META_KEY];
    const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY];
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
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
      },
      inputRequired: {
        maxRounds: 3,
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
  registerServerIdentityResource(server, startedAt);
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
    registerEvidenceResources(server, session);
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
  session,
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
    evidenceLookup:
      session === undefined
        ? undefined
        : (evidenceId) => session.evidenceById(evidenceId),
    evidenceFilePolicy: options.evidenceFilePolicy ?? DENY_EVIDENCE_FILE_POLICY,
    permissionAuthority,
    retainCoverageWorkspace:
      session === undefined
        ? undefined
        : (workspace) =>
            session.retainReconstructionCoverageWorkspace(workspace),
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

const registerServerIdentityResource = (
  server: McpServer,
  startedAt: string,
): void => {
  server.registerResource(
    "server-identity",
    "rea://server/identity",
    {
      title: "REA server identity",
      description: "Live package, SDK, protocol, and catalog identity.",
      mimeType: "application/json",
    },
    async (uri) => {
      const { createServerIdentity } = await import("../serverIdentity.js");
      const client = server.server.getClientVersion();
      const protocolVersion = server.server.getNegotiatedProtocolVersion();
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              createServerIdentity({
                startedAt,
                ...(client === undefined ? {} : { client }),
                ...(protocolVersion === undefined ? {} : { protocolVersion }),
              }),
              null,
              2,
            ),
          },
        ],
      };
    },
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
