import { randomBytes } from "node:crypto";

import {
  createRequestStateCodec,
  McpServer,
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
import type {
  JavaScriptReplayHost,
  JavaScriptReplayPolicy,
  JavaScriptReplayRunner,
} from "../application/JavaScriptReplayPlanning.js";
import type { ManagedRuntimePolicy } from "../application/ManagedRuntimeCorrelationService.js";
import { LinuxJavaScriptReplayRunner } from "../replay/LinuxJavaScriptReplayRunner.js";
import { SystemJavaScriptReplayHost } from "../replay/SystemJavaScriptReplayHost.js";
import type { ProcessCaptureElicitationState } from "./ProcessCaptureElicitation.js";

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
  readonly availabilityPolicy?: () => {
    readonly processCaptureEnabled: boolean;
    readonly evidenceFileRoots: number;
    readonly browserObservationEnabled?: boolean;
    readonly electronObservationEnabled?: boolean;
    readonly javascriptReplayEnabled?: boolean;
    readonly managedRuntimeEnabled?: boolean;
  };
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
      ttlSeconds: 600,
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
      inputRequired: { maxRounds: 3, roundTimeoutMs: 600_000 },
      requestState: { verify: processCaptureStateCodec.verify },
      instructions:
        session === undefined
          ? "Reverse-engineering tools for an active analysis target. Start with binary_overview."
          : "Reverse-engineering tools for configured analysis providers. Open a target with open_binary, then start with binary_overview.",
    },
  );
  server.server.onclose = () => {
    permissionAuthority?.clearSessionGrants();
  };
  session?.onAvailabilityChanged?.(() => server.sendToolListChanged());
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
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              createServerIdentity({
                startedAt,
                ...(client === undefined ? {} : { client }),
                ...(server.server.getNegotiatedProtocolVersion() === undefined
                  ? {}
                  : {
                      protocolVersion:
                        server.server.getNegotiatedProtocolVersion(),
                    }),
              }),
              null,
              2,
            ),
          },
        ],
      };
    },
  );
  const toolLogger = logger.child({ layer: "server" });
  const activeTarget =
    session === undefined ? undefined : () => session.activeTarget();
  const recordEvidence =
    session === undefined
      ? undefined
      : (evidence: Parameters<typeof session.recordEvidence>[0]) => {
          const recorded = session.recordEvidence(evidence);
          if (recorded.ok && recorded.value === "added")
            server.sendResourceListChanged();
          return recorded;
        };
  const recordEvidenceWithUnknown =
    session === undefined
      ? undefined
      : (
          evidence: Parameters<typeof session.recordEvidenceWithUnknown>[0],
          input: Parameters<typeof session.recordEvidenceWithUnknown>[1],
        ) => {
          const recorded = session.recordEvidenceWithUnknown(evidence, input);
          if (recorded.ok) server.sendResourceListChanged();
          return recorded;
        };
  registerOfficialTools(server, analysis, {
    logger: toolLogger,
    activeTarget,
    recordEvidence,
    recordUnknown:
      session === undefined
        ? undefined
        : (input) => session.recordUnknown(input),
  });
  registerEnhancedTools(server, analysis, {
    logger: toolLogger,
    activeTarget,
    analysisProfile:
      session === undefined ? undefined : () => session.analysisProfile(),
    recordEvidence,
    recordUnknown:
      session === undefined
        ? undefined
        : (input) => session.recordUnknown(input),
  });
  registerNativeTools(server, analysis, {
    logger: toolLogger,
    activeTarget,
    recordEvidence,
  });
  registerArtifactTools(server, analysis, {
    logger: toolLogger,
    activeTarget,
    recordEvidence,
    ...(permissionAuthority === undefined ? {} : { permissionAuthority }),
  });
  registerManagedTools(server, analysis, {
    logger: toolLogger,
    activeTarget,
    recordEvidence,
  });
  if (session !== undefined)
    registerManagedWorkflowTools(server, {
      logger: toolLogger,
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
  registerBrowserTools(server, {
    logger: toolLogger,
    browser: options.browserObservation,
    permissionAuthority,
    recordEvidence,
  });
  registerElectronTools(server, {
    logger: toolLogger,
    electron: options.electronObservation,
    permissionAuthority,
    recordEvidence,
  });
  registerApplicationTools(server, {
    logger: toolLogger,
    recordEvidence,
    recordEvidenceWithUnknown,
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
  registerGuidedPrompts(server, analysis, session);
  if (session !== undefined) {
    registerEvidenceResources(server, session);
    registerSessionTools(server, session, toolLogger, {
      ...options,
      ...(permissionAuthority === undefined ? {} : { permissionAuthority }),
      startedAt,
      processCaptureElicitation: {
        stateCodec: processCaptureStateCodec,
        supported: () =>
          server.server.getClientCapabilities()?.elicitation?.form !==
          undefined,
        modern: () =>
          server.server.getNegotiatedProtocolVersion()?.startsWith("2026-") ===
          true,
        consumedNonces: new Map(),
      },
    });
  }
  return server;
};
