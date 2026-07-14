import { McpServer } from "@modelcontextprotocol/server";

import type { AnalysisOperationPort } from "../application/AnalysisProvider.js";
import type { BinarySessionPort } from "../application/BinarySession.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { registerEnhancedTools } from "./registerEnhancedTools.js";
import { registerOfficialTools } from "./registerOfficialTools.js";
import { registerSessionTools } from "./registerSessionTools.js";
import { registerNativeTools } from "./registerNativeTools.js";
import { registerArtifactTools } from "./registerArtifactTools.js";
import { silentLogger, type Logger } from "../logger.js";
import type { ProcessExecutionPolicy } from "../domain/processCapture.js";
import type { EvidenceFilePolicy } from "../domain/evidenceBundle.js";
import { registerGuidedPrompts } from "./registerPrompts.js";
import { registerEvidenceResources } from "./registerEvidenceResources.js";
import { createServerIdentity } from "../serverIdentity.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import type { BrowserObservationPort } from "../application/BrowserObservationPort.js";
import { registerBrowserTools } from "./registerBrowserTools.js";

export interface CreateServerOptions {
  readonly logger?: Logger;
  readonly processPolicy?: ProcessExecutionPolicy;
  readonly evidenceFilePolicy?: EvidenceFilePolicy;
  readonly investigationInputRoots?: readonly string[];
  readonly analysisSnapshotFilePolicy?: EvidenceFilePolicy;
  readonly permissionAuthority?: PermissionAuthority;
  readonly browserObservation?: BrowserObservationPort;
  readonly artifactIntegrityContinueEnabled?: () => boolean;
  readonly availabilityPolicy?: () => {
    readonly processCaptureEnabled: boolean;
    readonly evidenceFileRoots: number;
    readonly browserObservationEnabled?: boolean;
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
      instructions:
        session === undefined
          ? "Reverse-engineering tools for an active analysis target. Start with binary_overview."
          : "Reverse-engineering tools for configured analysis providers. Open a target with open_binary, then start with binary_overview.",
    },
  );
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
    ...(options.permissionAuthority === undefined
      ? {}
      : { permissionAuthority: options.permissionAuthority }),
  });
  registerBrowserTools(server, {
    logger: toolLogger,
    browser: options.browserObservation,
    permissionAuthority: options.permissionAuthority,
    recordEvidence,
  });
  registerGuidedPrompts(server, analysis, session);
  if (session !== undefined) {
    registerEvidenceResources(server, session);
    registerSessionTools(server, session, toolLogger, {
      ...options,
      startedAt,
    });
  }
  return server;
};
