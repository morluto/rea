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
import { registerEnhancedTools } from "./registerEnhancedTools.js";
import { registerOfficialTools } from "./registerOfficialTools.js";
import { registerSessionTools } from "./registerSessionTools.js";
import { registerNativeTools } from "./registerNativeTools.js";
import { registerArtifactTools } from "./registerArtifactTools.js";
import { registerManagedTools } from "./registerManagedTools.js";
import { registerManagedWorkflowTools } from "./registerManagedWorkflowTools.js";
import { silentLogger, type Logger } from "../logger.js";
import type { ProcessExecutionPolicy } from "../domain/processCapture.js";
import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import { registerGuidedPrompts } from "./registerPrompts.js";
import { registerEvidenceResources } from "./registerEvidenceResources.js";
import { createServerIdentity } from "../serverIdentity.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import type { BrowserObservationPort } from "../application/BrowserObservationPort.js";
import { registerBrowserTools } from "./registerBrowserTools.js";
import type { ElectronObservationPort } from "../application/ElectronObservationPort.js";
import { registerElectronTools } from "./registerElectronTools.js";
import { registerApplicationTools } from "./registerApplicationTools.js";
import type { SessionAvailability } from "./sessionAvailabilityPolicy.js";

const TARGET_FREE_INSTRUCTIONS =
  "REA analyzes shipped artifacts. Route: ASAR/JavaScript -> analyze_javascript_application (configured root required); archive/package -> inventory_artifact; managed PE/CLI -> inspect_managed_artifact; browser/Electron runtime -> list_browser_targets/list_electron_targets; native binary/database -> open_binary, then binary_overview. Check binary_session for policy. Start with summaries and cite Evidence IDs. Never repeat identical analysis or read full Evidence without a specific need.";

const ACTIVE_TARGET_INSTRUCTIONS =
  "REA analyzes the active reverse-engineering target. Start native analysis with binary_overview, then narrow with analyze_function, literal search, callers, callees, and xrefs. Prefer summary views, never repeat an identical call, and read full Evidence only when the task requires it.";
import type {
  JavaScriptReplayHost,
  JavaScriptReplayPolicy,
  JavaScriptReplayRunner,
} from "../application/JavaScriptReplayPlanning.js";
import type { ManagedRuntimePolicy } from "../application/ManagedRuntimeCorrelationService.js";
import { LinuxJavaScriptReplayRunner } from "../replay/LinuxJavaScriptReplayRunner.js";
import { SystemJavaScriptReplayHost } from "../replay/SystemJavaScriptReplayHost.js";
import {
  PROCESS_CAPTURE_ELICITATION_POLICY,
  type ProcessCaptureElicitationState,
} from "./ProcessCaptureElicitation.js";

export interface CreateServerOptions {
  readonly logger?: Logger;
  readonly processPolicy?: ProcessExecutionPolicy;
  readonly evidenceFilePolicy?: EvidenceFilePolicy;
  readonly investigationInputRoots?: readonly string[];
  readonly analysisSnapshotFilePolicy?: EvidenceFilePolicy;
  readonly permissionAuthority?: PermissionAuthority;
  readonly browserObservation?: BrowserObservationPort;
  readonly electronObservation?: ElectronObservationPort;
  readonly artifactIntegrityContinueEnabled?: () => boolean;
  readonly javascriptReplayPolicy?: JavaScriptReplayPolicy;
  readonly javascriptReplayHost?: JavaScriptReplayHost;
  readonly javascriptReplayRunner?: JavaScriptReplayRunner;
  readonly managedRuntimePolicy?: ManagedRuntimePolicy;
  readonly availabilityPolicy?: () => SessionAvailability;
}

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
  const server = new McpServer(
    {
      name: PRODUCT_IDENTITY.mcpServerKey,
      version: PRODUCT_IDENTITY.packageVersion,
    },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
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
  server.server.onclose = () => {
    permissionAuthority?.clearSessionGrants();
  };
  session?.onAvailabilityChanged?.(() => server.sendToolListChanged());
  registerServerIdentityResource(server, startedAt);
  const toolLogger = logger.child({ layer: "server" });
  const { activeTarget, recordEvidence, recordEvidenceWithUnknown } =
    createSessionRecorders(server, session);
  const toolContext = {
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
      ...(permissionAuthority === undefined ? {} : { permissionAuthority }),
      startedAt,
      processCaptureElicitation: {
        stateCodec: processCaptureStateCodec,
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
        consumedNonces: new Map(),
      },
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
          if (recorded.ok && recorded.value === "added")
            server.sendResourceListChanged();
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
          if (recorded.ok) server.sendResourceListChanged();
          return recorded;
        },
});

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
    (uri) => {
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
  registerOfficialTools(server, analysis, {
    logger,
    activeTarget,
    recordEvidence,
    recordUnknown,
  });
  registerEnhancedTools(server, analysis, {
    logger,
    activeTarget,
    analysisProfile:
      session === undefined ? undefined : () => session.analysisProfile(),
    recordEvidence,
    recordUnknown,
  });
  registerNativeTools(server, analysis, {
    logger,
    activeTarget,
    recordEvidence,
  });
  registerArtifactTools(server, analysis, {
    logger,
    activeTarget,
    recordEvidence,
    ...(permissionAuthority === undefined ? {} : { permissionAuthority }),
  });
  registerManagedTools(server, analysis, {
    logger,
    activeTarget,
    recordEvidence,
    session,
  });
  if (session !== undefined)
    registerManagedWorkflowTools(server, {
      logger,
      recordEvidence,
      recordEvidenceWithUnknown,
      session,
      runtime: {
        policy: options.managedRuntimePolicy ?? {
          enabled: false,
          roots: [],
          executablePath: "/usr/bin/dotnet",
        },
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
  registerBrowserTools(server, {
    logger,
    browser: options.browserObservation,
    permissionAuthority,
    recordEvidence,
  });
  registerElectronTools(server, {
    logger,
    electron: options.electronObservation,
    permissionAuthority,
    recordEvidence,
  });
  registerApplicationTools(server, {
    logger,
    recordEvidence,
    recordEvidenceWithUnknown,
    evidenceLookup:
      session === undefined
        ? undefined
        : (evidenceId) => session.evidenceById(evidenceId),
    evidenceFilePolicy: options.evidenceFilePolicy ?? {
      roots: [],
      maxBytes: 1,
      maxDepth: 1,
      maxStringLength: 1,
      maxNodes: 1,
    },
    permissionAuthority,
    retainCoverageWorkspace:
      session === undefined
        ? undefined
        : (workspace) => {
            const retained =
              session.retainReconstructionCoverageWorkspace(workspace);
            if (retained === "added") server.sendResourceListChanged();
            return retained;
          },
    replay: {
      policy: options.javascriptReplayPolicy ?? {
        enabled: false,
        roots: [],
        nodePath: process.execPath,
        bubblewrapPath: "/usr/bin/bwrap",
        systemdRunPath: "/usr/bin/systemd-run",
        systemctlPath: "/usr/bin/systemctl",
        shellPath: "/usr/bin/bash",
      },
      host: options.javascriptReplayHost ?? new SystemJavaScriptReplayHost(),
      runner:
        options.javascriptReplayRunner ?? new LinuxJavaScriptReplayRunner(),
      authority: permissionAuthority,
    },
  });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
