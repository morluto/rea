import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";

import type { BinarySession } from "../application/BinarySession.js";
import type { CdpBrowserProvider } from "../browser/CdpBrowserProvider.js";
import type { CdpElectronProvider } from "../browser/CdpElectronProvider.js";
import type { PermissionAuthority } from "../application/PermissionAuthority.js";
import type { Logger } from "../logger.js";
import { createServer } from "../server/createServer.js";
import type { RuntimeDependencies } from "./types.js";
import type { RuntimeState } from "./state.js";
import {
  MCP_CONNECTION_LOST,
  MCP_CONNECTION_START_FAILED,
} from "./messages.js";

type McpServerInstance = ReturnType<typeof createServer>;

interface ServerContext {
  readonly logger: Logger;
  readonly serverLogger: Logger;
  readonly browserObservation: CdpBrowserProvider;
  readonly electronObservation: CdpElectronProvider;
  readonly permissionAuthority: PermissionAuthority;
  readonly runtimeState: RuntimeState;
}

export const startMcpTransport = async (
  dependencies: RuntimeDependencies,
  session: BinarySession,
  serverContext: ServerContext,
): Promise<
  | {
      readonly ok: true;
      readonly handle: StdioServerHandle;
      readonly liveServers: Set<McpServerInstance>;
    }
  | { readonly ok: false }
> => {
  const liveServers = new Set<McpServerInstance>();
  const { serverLogger } = serverContext;
  let handle: StdioServerHandle;
  try {
    handle = dependencies.serve(
      () => {
        const server = (dependencies.createServer ?? createServer)(
          session,
          session,
          {
            logger: serverContext.logger,
            processPolicy: serverContext.runtimeState.processPolicy,
            evidenceFilePolicy: serverContext.runtimeState.evidencePolicy,
            investigationInputRoots:
              serverContext.runtimeState.investigationRoots,
            analysisSnapshotFilePolicy:
              serverContext.runtimeState.snapshotPolicy,
            permissionAuthority: serverContext.permissionAuthority,
            browserObservation: serverContext.browserObservation,
            electronObservation: serverContext.electronObservation,
            artifactIntegrityContinueEnabled: () =>
              serverContext.runtimeState.currentConfig
                .artifactIntegrityContinueEnabled,
            javascriptReplayPolicy:
              serverContext.runtimeState.javascriptReplayPolicy,
            managedRuntimePolicy:
              serverContext.runtimeState.managedRuntimePolicy,
            availabilityPolicy: () => ({
              processCaptureEnabled:
                serverContext.runtimeState.currentConfig.processExecutionPolicy
                  .enabled,
              evidenceFileRoots:
                serverContext.runtimeState.currentConfig.evidenceFilePolicy
                  .roots.length,
              investigationInputRoots:
                serverContext.runtimeState.currentConfig.investigationInputRoots
                  .length,
              browserObservationEnabled:
                serverContext.runtimeState.currentConfig
                  .browserObservationEnabled &&
                serverContext.runtimeState.currentConfig.browserCdpEndpoints
                  .length > 0 &&
                serverContext.runtimeState.currentConfig.browserAllowedOrigins
                  .length > 0,
              electronObservationEnabled:
                serverContext.runtimeState.currentConfig
                  .electronObservationEnabled &&
                serverContext.runtimeState.currentConfig.electronCdpEndpoints
                  .length > 0 &&
                serverContext.runtimeState.currentConfig.electronFileRoots
                  .length > 0,
              javascriptReplayEnabled:
                serverContext.runtimeState.currentConfig.javascriptReplayPolicy
                  .enabled,
              managedRuntimeEnabled:
                serverContext.runtimeState.currentConfig.managedRuntimePolicy
                  .enabled,
            }),
          },
        );
        liveServers.add(server);
        return server;
      },
      {
        onerror: () => {
          serverLogger.error(MCP_CONNECTION_LOST);
          dependencies.writeStderr(`${MCP_CONNECTION_LOST}\n`);
        },
      },
    );
  } catch {
    await session.close();
    serverLogger.error(MCP_CONNECTION_START_FAILED);
    dependencies.writeStderr(`${MCP_CONNECTION_START_FAILED}\n`);
    return { ok: false };
  }
  return { ok: true, handle, liveServers };
};
